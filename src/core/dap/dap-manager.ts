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
import {
  EVAL_RATE_WINDOW_MS,
  MAX_CONCURRENT_EVALUATIONS,
  MAX_EVALUATIONS_PER_WINDOW,
  MAX_EVALUATION_LENGTH,
  truncateEvaluation,
  type DapBeforeLaunch,
  type DapBreakpoint,
  type DapBreakpointSpec,
  type DapEvaluation,
  type DapEvaluationContext,
  type DapLaunchTarget,
  type DapScope,
  type DapServerConfig,
  type DapSessionState,
  type DapStackFrame,
  type DapThread,
  type DapVariable,
} from "../../shared/dap-contract";

/**
 * Tetos do `evaluate` (definidos no contrato compartilhado — o renderer precisa do
 * número para não exceder a cota) e **impostos aqui**, no core.
 */
export {
  EVAL_RATE_WINDOW_MS,
  MAX_CONCURRENT_EVALUATIONS,
  MAX_EVALUATIONS_PER_WINDOW,
} from "../../shared/dap-contract";
/** O gancho de pré-launch (contrato compartilhado) — re-exportado para quem implementa. */
export type { DapBeforeLaunch } from "../../shared/dap-contract";
import { DapClient } from "./dap-client";
import { DapStdioTransport } from "./dap-transport";
import { DapError } from "./dap-protocol";
import { normalizeBreakpointSpecs, toSourceBreakpoints } from "./dap-breakpoints";
import type {
  DapEvaluateResponseBody,
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

/**
 * Janela de tolerância para a resposta do `launch`/`attach`.
 *
 * O debugpy responde ao `launch` **depois** do `configurationDone` (o debuggee só sobe
 * nessa hora) — esperar a resposta antes de mandar o `configurationDone` trava a sessão.
 * Então a resposta é esperada por um instante curto: se ela já chegou (adaptadores
 * rápidos), o erro aparece; se não, a sessão segue e a resposta tardia é apenas
 * registrada.
 */
const LAUNCH_RESPONSE_GRACE_MS = 2000;

export class DapManager implements Disposable {
  private readonly configs = new Map<string, DapServerConfig>();

  /**
   * Gancho de pré-launch (opcional) — executado **antes** de qualquer pedido ao
   * adaptador. Ver {@link DapBeforeLaunch}.
   */
  private beforeLaunch: DapBeforeLaunch | null;

  private client: DapClient | null = null;
  private transport: DapStdioTransport | null = null;
  private activeConfig: DapServerConfig | null = null;
  private activeProgram: string | null = null;
  private sessionState: DapSessionState = "inactive";

  /**
   * Breakpoints desejados por caminho absoluto de arquivo.
   * Chave: linha **1‑based**; valor: spec completa (condição, hit condition, log message).
   */
  private readonly desiredBreakpoints = new Map<string, Map<number, DapBreakpointSpec>>();

  /** Avaliações de expressão **em voo** (teto de concorrência — {@link MAX_CONCURRENT_EVALUATIONS}). */
  private inFlightEvaluations = 0;

  /**
   * Instantes (ms) das avaliações aceitadas na janela corrente (teto de taxa —
   * {@link MAX_EVALUATIONS_PER_WINDOW} por {@link EVAL_RATE_WINDOW_MS}).
   */
  private evaluationTimestamps: number[] = [];

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

  /**
   * @param configs Adaptadores conhecidos (roteados por extensão).
   * @param beforeLaunch Gancho de pré-launch **opcional** — ver {@link DapBeforeLaunch}.
   *   Também pode ser definido depois com {@link DapManager.setBeforeLaunch} (necessário
   *   quando o `EditorCore` só existe **depois** do manager — a ordem do `main`).
   */
  constructor(configs: readonly DapServerConfig[], beforeLaunch?: DapBeforeLaunch) {
    for (const config of configs) {
      this.configs.set(config.name, config);
    }
    this.beforeLaunch = beforeLaunch ?? null;
  }

  /**
   * Define (ou remove, com `null`) o gancho de pré-launch.
   *
   * O gancho é **idempotente por responsabilidade de quem o implementa**: o
   * `saveDocument` do `EditorCore` já é no-op quando o documento não está sujo.
   */
  setBeforeLaunch(hook: DapBeforeLaunch | null): void {
    this.beforeLaunch = hook;
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
   * Inicia uma sessão de depuração: **executa o gancho de pré-launch** (salvar o
   * documento — ver {@link DapBeforeLaunch}), dispara o adaptador, faz o `initialize`,
   * envia o pedido inicial (`launch`/`attach`), aguarda o evento `initialized`, envia os
   * breakpoints desejados e finaliza com `configurationDone`.
   *
   * O gancho roda **antes** de qualquer pedido ao adaptador: se ele falhar, **nenhum**
   * `launch` é enviado, a sessão vai a `errored` e o erro é propagado.
   */
  async start(config: DapServerConfig, target: DapLaunchTarget): Promise<DapSessionState> {
    if (this.client !== null) {
      throw new DapError("DAP_SESSION_ACTIVE", "Já existe uma sessão de depuração ativa");
    }

    this.setState("starting");
    this.activeConfig = config;
    this.activeProgram = target.program;

    // ── Pré-launch: o documento é salvo ANTES de o debuggee subir ──────────────────────────
    // O debuggee roda o **arquivo do disco**: com o buffer não salvo, o depurador pararia
    // em um código diferente do que o editor mostra. O gancho (injetado pelo `main`) faz
    // essa gravação.
    //
    // A falha aqui é **limpa**: o gancho roda *antes* de qualquer coisa ser spawnada, então
    // não há adaptador vivo, não há pedido `launch` enviado e não há sessão zumbi — o
    // `start` apenas propaga o erro e a sessão vai a `errored`.
    //
    // ⚠️ **Sem** gancho não há `await` algum aqui: o fluxo de `start` fica **idêntico** ao
    // de sempre (nenhum microtask extra) — quem já usa o manager não sente nada.
    if (this.beforeLaunch !== null) {
      try {
        await this.runBeforeLaunch(target);
      } catch (err) {
        this.setState("errored");
        this.teardownTransport();
        throw err instanceof DapError
          ? err
          : new DapError("DAP_BEFORE_LAUNCH_FAILED", messageOf(err));
      }
    }

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

      // O pedido inicial (`launch`/`attach`) **não é aguardado** antes do `configurationDone`:
      // o debugpy responde ao `launch` só *depois* que o debuggee sobe (o debuggee sobe no
      // `configurationDone`) — esperar aqui trava a sessão inteira (observado no E2E real).
      const launchRequest = client.sendRequest(
        config.request,
        buildLaunchArgs(config, target),
      );
      // Anexa um handler imediato: se o `launch` falhar antes do `race`, a rejeição não vira
      // "unhandled rejection" (o `race` abaixo é quem decide o que fazer com ela).
      launchRequest.catch(() => undefined);

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

      // Se o `launch` já respondeu (adaptadores que respondem na hora), o erro aparece aqui.
      // Se ainda não respondeu, segue — a resposta chega depois e é apenas registrado.
      const launchOutcome = await raceWithTimeout(launchRequest, LAUNCH_RESPONSE_GRACE_MS);
      if (launchOutcome.status === "rejected") throw launchOutcome.error;
      if (launchOutcome.status === "timeout") {
        // A resposta do `launch` chegou **depois** da janela de tolerância: se for uma
        // falha, ela é registrada (1 `warn`) — engolir em silêncio seria degradação
        // invisível (a sessão segue rodando, mas o `launch` nunca funcionou).
        void launchRequest.then(
          () => undefined,
          (error: unknown) => {
            console.warn(
              `[dap] "launch" falhou depois da janela de tolerância: ${messageOf(error)}`,
            );
          },
        );
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

  /**
   * Registra os breakpoints desejados de um arquivo e os envia ao adaptador, se ativo.
   *
   * Aceita números (só a linha) ou specs completas (condição, hit condition, log message) —
   * a normalização é feita por `normalizeBreakpointSpecs` (descarta entradas inválidas).
   */
  async setBreakpoints(
    sourcePath: string,
    specs: readonly (number | DapBreakpointSpec)[],
  ): Promise<readonly DapBreakpoint[]> {
    const normalized = normalizeBreakpointSpecs(specs);
    this.desiredBreakpoints.set(
      sourcePath,
      new Map(normalized.map((spec) => [spec.line, spec])),
    );

    const client = this.client;
    if (client === null || !isSessionReady(this.sessionState)) return [];

    return this.pushBreakpoints(client, sourcePath, normalized);
  }

  /** Breakpoints desejados de um arquivo (ordem crescente de linha). */
  breakpointsFor(sourcePath: string): readonly number[] {
    const specs = this.breakpointSpecsFor(sourcePath);
    return specs.map((spec) => spec.line);
  }

  /** Breakpoints desejados de um arquivo **com** condição (o que o painel de depuração edita). */
  breakpointSpecsFor(sourcePath: string): readonly DapBreakpointSpec[] {
    const byLine = this.desiredBreakpoints.get(sourcePath);
    if (!byLine) return [];
    return [...byLine.values()].sort((a, b) => a.line - b.line);
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

  /**
   * Avalia uma expressão no programa depurado (watch ou hover).
   *
   * O contexto pedido é tentado primeiro; se o adaptador recusar (`success: false`), há
   * **fallback** para `watch` — nem todo adaptador implementa todos os contextos. O erro
   * original é preservado quando **todas** as tentativas falham.
   *
   * Tetos aplicados **no core** (o IPC é apenas uma das bordas): o tamanho da expressão
   * ({@link MAX_EVALUATION_LENGTH}), a taxa e a concorrência das avaliações. Exceder a
   * taxa/concorrência falha com `DAP_EVAL_RATE_LIMITED` — um renderer comprometido não
   * consegue congelar o debuggee.
   */
  async evaluate(
    expression: string,
    frameId: number,
    context: DapEvaluationContext = "watch",
  ): Promise<DapEvaluation> {
    const client = this.requireClient();
    const trimmed = expression.trim();
    if (trimmed.length === 0) {
      throw new DapError("DAP_EMPTY_EXPRESSION", "Expressão vazia");
    }
    if (trimmed.length > MAX_EVALUATION_LENGTH) {
      throw new DapError(
        "DAP_EXPRESSION_TOO_LONG",
        `Expressão acima de ${MAX_EVALUATION_LENGTH} caracteres`,
      );
    }

    this.reserveEvaluationSlot();
    try {
      const chain = contextChain(context);
      let firstError: unknown;
      for (const ctx of chain) {
        try {
          const body = (await client.sendRequest("evaluate", {
            expression: trimmed,
            frameId,
            context: ctx,
          })) as DapEvaluateResponseBody | undefined;
          return truncateEvaluation({
            value: body?.result ?? "",
            ...(body?.type !== undefined ? { type: body.type } : {}),
            variablesReference: body?.variablesReference ?? 0,
          });
        } catch (err) {
          if (firstError === undefined) firstError = err;
        }
      }
      throw firstError instanceof Error
        ? firstError
        : new DapError("DAP_EVALUATE_FAILED", "Falha ao avaliar a expressão");
    } finally {
      this.releaseEvaluationSlot();
    }
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

  /**
   * Executa o gancho de pré-launch (se houver) — **antes** de qualquer pedido ao adaptador.
   *
   * Só roda quando o alvo tem `program` (alvo sem programa não tem arquivo a salvar).
   * O caminho é repassado **verbatim** (um caminho pode ter espaços nas pontas).
   */
  private async runBeforeLaunch(target: DapLaunchTarget): Promise<void> {
    const hook = this.beforeLaunch;
    if (hook === null) return;
    if (target.program.trim().length === 0) return;
    await hook(target.program);
  }

  private requireClient(): DapClient {
    if (this.client === null) {
      throw new DapError("DAP_NO_SESSION", "Nenhuma sessão de depuração ativa");
    }
    return this.client;
  }

  /**
   * Reserva uma vaga de avaliação (teto de concorrência + teto de taxa).
   *
   * Lança `DapError("DAP_EVAL_RATE_LIMITED")` quando um dos tetos é excedido — o
   * chamador decide a degradação (o IPC devolve `null`).
   */
  private reserveEvaluationSlot(): void {
    if (this.inFlightEvaluations >= MAX_CONCURRENT_EVALUATIONS) {
      throw new DapError(
        "DAP_EVAL_RATE_LIMITED",
        `Já há ${MAX_CONCURRENT_EVALUATIONS} avaliações em voo`,
      );
    }
    const now = Date.now();
    const windowStart = now - EVAL_RATE_WINDOW_MS;
    // Descarta as marcas que saíram da janela corrente.
    while (
      this.evaluationTimestamps.length > 0 &&
      this.evaluationTimestamps[0]! <= windowStart
    ) {
      this.evaluationTimestamps.shift();
    }
    if (this.evaluationTimestamps.length >= MAX_EVALUATIONS_PER_WINDOW) {
      throw new DapError(
        "DAP_EVAL_RATE_LIMITED",
        `Teto de ${MAX_EVALUATIONS_PER_WINDOW} avaliações por ${EVAL_RATE_WINDOW_MS} ms excedido`,
      );
    }
    this.evaluationTimestamps.push(now);
    this.inFlightEvaluations++;
  }

  /** Devolve a vaga de avaliação reservada. */
  private releaseEvaluationSlot(): void {
    if (this.inFlightEvaluations > 0) this.inFlightEvaluations--;
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
    for (const sourcePath of this.desiredBreakpoints.keys()) {
      await this.pushBreakpoints(client, sourcePath, this.breakpointSpecsFor(sourcePath));
    }
  }

  private async pushBreakpoints(
    client: DapClient,
    sourcePath: string,
    specs: readonly DapBreakpointSpec[],
  ): Promise<readonly DapBreakpoint[]> {
    const body = (await client.sendRequest("setBreakpoints", {
      source: { path: sourcePath },
      breakpoints: toSourceBreakpoints(specs),
    })) as DapSetBreakpointsResponseBody | undefined;

    const returned = body?.breakpoints ?? [];
    const breakpoints: DapBreakpoint[] = specs.map((spec, index) => {
      const bp = returned[index];
      if (bp === undefined) {
        return { verified: false, line: spec.line };
      }
      return {
        verified: bp.verified,
        line: bp.line ?? spec.line,
        ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
        ...(spec.hitCondition !== undefined ? { hitCondition: spec.hitCondition } : {}),
        ...(spec.logMessage !== undefined ? { logMessage: spec.logMessage } : {}),
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

/** Resultado da corrida entre uma promise e um prazo. */
type RaceOutcome<T> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timeout" };

/**
 * Espera a promise por até `timeoutMs`. Rejeição **não** é engolida: ela é devolvida
 * (`rejected`) para que o chamador decida — a falha do `launch` precisa derrubar a sessão.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<RaceOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    const settled = await Promise.race([
      promise.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      timeout,
    ]);
    if (settled.status === "timeout") return { status: "timeout" };
    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Cadeia de contextos tentados pelo `evaluate`: o contexto pedido e `watch`.
 *
 * Só `watch` e `hover` são pedidos ao adaptador: `repl` executa a expressão como
 * **statement** no debuggee (efeito colateral + mutação de estado) e `clipboard` não
 * faz parte do contrato do IPC. Duplicatas são removidas (o contexto pedido pode já
 * ser `watch`).
 */
function contextChain(context: DapEvaluationContext): DapEvaluationContext[] {
  const requested: DapEvaluationContext = context === "hover" ? "hover" : "watch";
  const chain: DapEvaluationContext[] = [requested];
  if (requested !== "watch") chain.push("watch");
  return chain;
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