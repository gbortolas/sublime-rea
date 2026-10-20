/**
 * Scribe — gerente de sessões de depuração (DAP).
 *
 * Mantém **uma** sessão ativa por vez (escopo do Scribe: depurar o arquivo-fonte aberto),
 * encapsulando o transporte + cliente e traduzindo os pedidos do IPC (threads, pilha de
 * chamadas, escopos, variáveis, controle de execução) para comandos DAP.
 *
 * O `DapManager` também guarda os breakpoints **desejados** por arquivo: eles podem ser
 * alternados antes de existir sessão e são enviados ao adaptador assim que ele sinaliza
 * `initialized`.
 */

import { Emitter, type Event } from "../../shared/events";
import { type Disposable } from "../../shared/disposable";
import type {
  DapBreakpoint,
  DapLaunchTarget,
  DapScope,
  DapServerConfig,
  DapSessionState,
  DapStackFrame,
  DapThread,
  DapVariable,
} from "../../shared/dap-contract";
import { DapClient } from "./dap-client";
import { DapStdioTransport } from "./dap-transport";
import { DapError } from "./dap-protocol";
import type {
  DapInitializeParams,
  DapScopesResponseBody,
  DapSetBreakpointsResponseBody,
  DapStackTraceResponseBody,
  DapStoppedEventBody,
  DapThreadsResponseBody,
  DapVariablesResponseBody,
} from "./dap-protocol";

const INITIALIZED_TIMEOUT_MS = 10000;
const STACK_FRAME_LIMIT = 50;

export class DapManager implements Disposable {
  private readonly configs = new Map<string, DapServerConfig>();

  private client: DapClient | null = null;
  private transport: DapStdioTransport | null = null;
  private activeConfig: DapServerConfig | null = null;
  private activeProgram: string | null = null;
  private sessionState: DapSessionState = "inactive";

  /** Breakpoints desejados por caminho absoluto de arquivo (linhas 1‑based). */
  private readonly desiredBreakpoints = new Map<string, Set<number>>();

  private readonly onStateEmitter = new Emitter<DapSessionState>();
  private readonly onStoppedEmitter = new Emitter<DapStoppedEventBody>();
  private readonly onOutputEmitter = new Emitter<{ category: string; output: string }>();
  private readonly onBreakpointsEmitter = new Emitter<{
    readonly sourcePath: string;
    readonly breakpoints: readonly DapBreakpoint[];
  }>();

  /** Transições de estado da sessão (`inactive` → `starting` → `running`/`stopped` → …). */
  readonly onState: Event<DapSessionState> = this.onStateEmitter.event;
  /** O programa pausou (breakpoint, passo, exceção). */
  readonly onStopped: Event<DapStoppedEventBody> = this.onStoppedEmitter.event;
  /** Saída do programa (stdout/stderr/console). */
  readonly onOutput: Event<{ category: string; output: string }> = this.onOutputEmitter.event;
  /** Breakpoints efetivamente armados no adaptador (verificados). */
  readonly onBreakpoints: Event<{
    readonly sourcePath: string;
    readonly breakpoints: readonly DapBreakpoint[];
  }> = this.onBreakpointsEmitter.event;

  constructor(configs: readonly DapServerConfig[]) {
    for (const config of configs) {
      this.configs.set(config.name, config);
    }
  }

  /** Estado atual da sessão. */
  get state(): DapSessionState {
    return this.sessionState;
  }

  /** Nome do adaptador da sessão ativa (ou `null`). */
  get adapterName(): string | null {
    return this.activeConfig?.name ?? null;
  }

  /** Caminho absoluto do programa da sessão ativa (ou `null`). */
  get programPath(): string | null {
    return this.activeProgram;
  }

  /** Configurações de adaptador conhecidas (na ordem de registro). */
  listConfigs(): readonly DapServerConfig[] {
    return [...this.configs.values()];
  }

  /** Escolhe a configuração de adaptador para o caminho do arquivo-fonte (por extensão). */
  findConfigFor(sourcePath: string): DapServerConfig | undefined {
    const ext = extensionOf(sourcePath);
    if (ext.length === 0) return undefined;
    for (const config of this.configs.values()) {
      if (config.enabled && config.languages.includes(ext)) return config;
    }
    return undefined;
  }

  /**
   * Inicia uma sessão de depuração: dispara o adaptador, faz o `initialize`, envia o pedido
   * inicial (`launch`/`attach`), aguarda o evento `initialized`, envia os breakpoints
   * desejados e finaliza com `configurationDone`.
   */
  async start(config: DapServerConfig, target: DapLaunchTarget): Promise<DapSessionState> {
    if (this.client !== null) {
      throw new DapError("DAP_SESSION_ACTIVE", "Já existe uma sessão de depuração ativa");
    }

    this.setState("starting");
    this.activeConfig = config;
    this.activeProgram = target.program;

    const transport = new DapStdioTransport(
      config.spawn.command,
      [...config.spawn.args],
      config.spawn.env as Record<string, string> | undefined,
    );
    const client = new DapClient(transport, 30000);
    this.transport = transport;
    this.client = client;

    // Encaminha eventos do adaptador para os eventos agregados do manager
    client.onStopped((body) => {
      this.setState("stopped");
      this.onStoppedEmitter.fire(body);
    });
    client.onEvent((envelope) => {
      if (envelope.event === "continued") this.setState("running");
    });
    client.onOutput((body) => {
      this.onOutputEmitter.fire({
        category: body.category ?? "stdout",
        output: body.output,
      });
    });
    client.onTerminated(() => {
      this.setState("terminated");
      this.teardownTransport();
    });

    try {
      await client.connect();

      // Registra o interesse em `initialized` **antes** do `initialize` para não perder o evento.
      const initialized = client.waitForEvent("initialized", INITIALIZED_TIMEOUT_MS);

      const initBody = (await client.sendRequest("initialize", {
        adapterID: config.type,
        clientID: "scribe",
        clientName: "Scribe",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
      } satisfies DapInitializeParams)) as { supportsConfigurationDoneRequest?: boolean } | undefined;

      await client.sendRequest(config.request, buildLaunchArgs(config, target));

      // O adaptador pode não emitir `initialized` (varia por implementação) — não é fatal.
      try {
        await initialized;
      } catch {
        console.warn(`[dap] adaptador "${config.name}" não emitiu o evento "initialized"`);
      }

      await this.flushBreakpoints();

      const supportsConfigurationDone = initBody?.supportsConfigurationDoneRequest !== false;
      if (supportsConfigurationDone) {
        await client.sendRequest("configurationDone");
      }

      this.setState("running");
      return this.sessionState;
    } catch (err) {
      this.setState("errored");
      this.teardownTransport();
      throw err instanceof DapError
        ? err
        : new DapError("DAP_START_FAILED", messageOf(err));
    }
  }

  /** Encerra a sessão ativa (best-effort) e volta a `inactive`. */
  async stop(): Promise<void> {
    const client = this.client;
    if (client !== null) {
      await client.disconnect(true);
      client.dispose();
    }
    this.teardownTransport();
    this.setState("inactive");
  }

  /** Registra os breakpoints desejados de um arquivo e os envia ao adaptador, se ativo. */
  async setBreakpoints(
    sourcePath: string,
    lines: readonly number[],
  ): Promise<readonly DapBreakpoint[]> {
    this.desiredBreakpoints.set(sourcePath, new Set(lines));

    const client = this.client;
    if (client === null || !isSessionReady(this.sessionState)) return [];

    return this.pushBreakpoints(client, sourcePath, lines);
  }

  /** Breakpoints desejados de um arquivo (ordem crescente de linha). */
  breakpointsFor(sourcePath: string): readonly number[] {
    const set = this.desiredBreakpoints.get(sourcePath);
    if (!set) return [];
    return [...set].sort((a, b) => a - b);
  }

  /** Threads em execução no programa depurado. */
  async threads(): Promise<readonly DapThread[]> {
    const body = (await this.requireClient().sendRequest("threads")) as
      | DapThreadsResponseBody
      | undefined;
    return (body?.threads ?? []).map((t) => ({ id: t.id, name: t.name }));
  }

  /** Pilha de chamadas de uma thread. */
  async stackTrace(threadId: number): Promise<readonly DapStackFrame[]> {
    const body = (await this.requireClient().sendRequest("stackTrace", {
      threadId,
      startFrame: 0,
      levels: STACK_FRAME_LIMIT,
    })) as DapStackTraceResponseBody | undefined;

    return (body?.stackFrames ?? []).map((frame) => ({
      id: frame.id,
      name: frame.name,
      line: frame.line,
      column: frame.column,
      ...(frame.source?.path !== undefined ? { path: frame.source.path } : {}),
    }));
  }

  /** Escopos de variáveis de um frame. */
  async scopes(frameId: number): Promise<readonly DapScope[]> {
    const body = (await this.requireClient().sendRequest("scopes", { frameId })) as
      | DapScopesResponseBody
      | undefined;
    return (body?.scopes ?? []).map((scope) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      expensive: scope.expensive,
    }));
  }

  /** Variáveis de um escopo (ou de um nó expandido). */
  async variables(variablesReference: number): Promise<readonly DapVariable[]> {
    const body = (await this.requireClient().sendRequest("variables", {
      variablesReference,
    })) as DapVariablesResponseBody | undefined;
    return (body?.variables ?? []).map((variable) => ({
      name: variable.name,
      value: variable.value,
      variablesReference: variable.variablesReference ?? 0,
      ...(variable.type !== undefined ? { type: variable.type } : {}),
    }));
  }

  /** Continua a execução de uma thread. */
  async continueExecution(threadId: number): Promise<void> {
    await this.requireClient().sendRequest("continue", { threadId });
  }

  /** Pausa a execução de uma thread. */
  async pause(threadId: number): Promise<void> {
    await this.requireClient().sendRequest("pause", { threadId });
  }

  /** Passo a passo: `next` (por cima), `stepIn` (para dentro), `stepOut` (para fora). */
  async stepOver(threadId: number): Promise<void> {
    await this.requireClient().sendRequest("next", { threadId });
  }

  async stepInto(threadId: number): Promise<void> {
    await this.requireClient().sendRequest("stepIn", { threadId });
  }

  async stepOut(threadId: number): Promise<void> {
    await this.requireClient().sendRequest("stepOut", { threadId });
  }

  /** @inheritdoc */
  dispose(): void {
    const client = this.client;
    if (client !== null) {
      void client.disconnect(true).catch(() => undefined);
      client.dispose();
    }
    this.teardownTransport();
    this.onStateEmitter.dispose();
    this.onStoppedEmitter.dispose();
    this.onOutputEmitter.dispose();
    this.onBreakpointsEmitter.dispose();
  }

  // ── Internos ──────────────────────────────────────────────────────────────────────────────

  private requireClient(): DapClient {
    if (this.client === null) {
      throw new DapError("DAP_NO_SESSION", "Nenhuma sessão de depuração ativa");
    }
    return this.client;
  }

  private setState(state: DapSessionState): void {
    if (this.sessionState === state) return;
    this.sessionState = state;
    this.onStateEmitter.fire(state);
  }

  /** Envia ao adaptador os breakpoints desejados de **todos** os arquivos. */
  private async flushBreakpoints(): Promise<void> {
    const client = this.client;
    if (client === null) return;
    for (const [sourcePath, lines] of this.desiredBreakpoints) {
      await this.pushBreakpoints(client, sourcePath, [...lines].sort((a, b) => a - b));
    }
  }

  private async pushBreakpoints(
    client: DapClient,
    sourcePath: string,
    lines: readonly number[],
  ): Promise<readonly DapBreakpoint[]> {
    const body = (await client.sendRequest("setBreakpoints", {
      source: { path: sourcePath },
      breakpoints: lines.map((line) => ({ line })),
    })) as DapSetBreakpointsResponseBody | undefined;

    const returned = body?.breakpoints ?? [];
    const breakpoints: DapBreakpoint[] = lines.map((requestedLine, index) => {
      const bp = returned[index];
      if (bp === undefined) {
        return { verified: false, line: requestedLine };
      }
      return {
        verified: bp.verified,
        line: bp.line ?? requestedLine,
        ...(bp.id !== undefined ? { id: bp.id } : {}),
        ...(bp.message !== undefined ? { message: bp.message } : {}),
      };
    });

    this.onBreakpointsEmitter.fire({ sourcePath, breakpoints });
    return breakpoints;
  }

  private teardownTransport(): void {
    const transport = this.transport;
    if (transport !== null) {
      transport.dispose();
    }
    this.transport = null;
    this.client = null;
    this.activeConfig = null;
    this.activeProgram = null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/");
  const idx = base.lastIndexOf(".");
  if (idx === -1) return "";
  return base.slice(idx + 1).toLowerCase();
}

function isSessionReady(state: DapSessionState): boolean {
  return state === "running" || state === "stopped";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Mescla as opções de configuração com o alvo, omitindo chaves indefinidas. */
function buildLaunchArgs(
  config: DapServerConfig,
  target: DapLaunchTarget,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...config.launchOptions };
  args.program = target.program;
  args.cwd = target.cwd ?? parentDirectory(target.program);
  if (target.args !== undefined) args.args = [...target.args];
  if (target.stopOnEntry !== undefined) args.stopOnEntry = target.stopOnEntry;
  return args;
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized.slice(0, Math.max(idx, 0)) || ".";
  return normalized.slice(0, idx);
}