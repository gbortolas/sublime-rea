/**
 * Scribe — contratos de fronteira do DAP (Debug Adapter Protocol).
 *
 * Define os tipos de **configuração** e os **resultados** que atravessam o IPC do Scribe
 * (main ↔ renderer). Os tipos do protocolo DAP em si (mensagens com `seq`/`type`,
 * `StoppedEvent`, `StackTraceResponse`, …) vivem em `src/core/dap/dap-protocol.ts` — são
 * **internos** do módulo `core/dap/` e não vazam pela ponte.
 *
 * Rótulo de origem: estes contratos são **escolha nossa** — o DAP é um padrão da indústria
 * (Microsoft), **não** observado no alvo (Sublime Text). A arquitetura de depuração do alvo
 * não faz parte do escopo desta fase.
 */

// ── Configuração de adaptador DAP ──────────────────────────────────────────────────────────

/** Origem do adaptador: instalado/embutido pelo Scribe ou customizado pelo usuário. */
export type DapServerKind = "builtin" | "user";

/** Como o adaptador é iniciado. */
export interface DapServerSpawnConfig {
  readonly command: string;
  readonly args: readonly string[];
  /** Variáveis de ambiente extra (mescladas com as do processo). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Pedido inicial de uma sessão de depuração. */
export type DapRequestKind = "launch" | "attach";

/**
 * Um adaptador DAP conhecido pelo Scribe. Mapeia extensões de arquivo-fonte a um comando
 * de spawn e ao `adapterID` enviado no `initialize`.
 */
export interface DapServerConfig {
  readonly name: string;
  readonly kind: DapServerKind;
  /** Extensões de arquivo (sem ponto) que ativam este adaptador. */
  readonly languages: readonly string[];
  /** `adapterID` enviado no `initialize` (ex.: "python", "node"). */
  readonly type: string;
  /** Pedido inicial: `launch` ou `attach`. */
  readonly request: DapRequestKind;
  /** Como iniciar o adaptador. */
  readonly spawn: DapServerSpawnConfig;
  /**
   * Opções mescladas no pedido `launch`/`attach` (ex.: `stopOnEntry`, `justMyCode`).
   * Só campos reconhecidos pelo adaptador; omissão = default do adaptador.
   */
  readonly launchOptions?: Readonly<Record<string, unknown>>;
  /** Ativado por padrão? */
  readonly enabled: boolean;
}

/** Alvo de depuração passado ao `start` (o Scribe só suporta arquivo único por sessão). */
export interface DapLaunchTarget {
  /** Caminho absoluto do arquivo-fonte a depurar. */
  readonly program: string;
  /** Diretório de trabalho (default: pasta do `program`). */
  readonly cwd?: string;
  /** Argumentos de linha de comando do programa. */
  readonly args?: readonly string[];
  /** Parar na primeira linha? (default do adaptador se omitido.) */
  readonly stopOnEntry?: boolean;
}

// ── Adaptadores embutidos ─────────────────────────────────────────────────────────────────

/**
 * Adaptadores DAP embutidos (registrados na construção do `DapManager`).
 *
 * O Python usa o **debugpy** (`python3 -m debugpy.adapter`) — presente quando
 * `pip install debugpy` foi feito. Se o binário/ módulo não estiver disponível, o adaptador
 * é ignorado com `warn`, nunca fatal.
 *
 * Expansão futura: Node via `vscode-js-debug` (o `dapDebugServer.js` não vem no `PATH`
 * por padrão, então **não** o embutimos como if estivesse disponível).
 */
export const BUILTIN_DAP_SERVERS: readonly DapServerConfig[] = [
  {
    name: "Python (debugpy)",
    kind: "builtin",
    languages: ["py", "pyw"],
    type: "python",
    request: "launch",
    spawn: { command: "python3", args: ["-m", "debugpy.adapter"] },
    launchOptions: { justMyCode: true, console: "internalConsole" },
    enabled: true,
  },
] as const;

// ── Resultados que cruzam o IPC ────────────────────────────────────────────────────────────

/** Estado de uma sessão de depuração. */
export type DapSessionState =
  | "inactive"
  | "starting"
  | "running"
  | "stopped"
  | "terminated"
  | "errored";

/** Um ponto de parada após ser (des)registrado no adaptador. */
export interface DapBreakpoint {
  readonly id?: number;
  /** `true` se o adaptador conseguiu armar o breakpoint no código real. */
  readonly verified: boolean;
  /** Linha **1‑based** (como o editor exibe). */
  readonly line: number;
  readonly message?: string;
}

/** Uma thread em execução no programa depurado. */
export interface DapThread {
  readonly id: number;
  readonly name: string;
}

/** Um frame da pilha de chamadas. */
export interface DapStackFrame {
  readonly id: number;
  readonly name: string;
  /** Caminho absoluto do arquivo-fonte (ausente para frames sem fonte). */
  readonly path?: string;
  /** Linha **1‑based**. */
  readonly line: number;
  /** Coluna **1‑based**. */
  readonly column: number;
}

/** Um escopo de variáveis de um frame (ex.: "Locals", "Globals"). */
export interface DapScope {
  readonly name: string;
  /** Referência opaca para pedir as variáveis deste escopo. */
  readonly variablesReference: number;
  /** `true` se a leitura é cara (ex.: "Globals") — o renderer pode carregar on-demand. */
  readonly expensive: boolean;
}

/** Uma variável (ou um nó expansível da árvore de variáveis). */
export interface DapVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  /** `> 0` se o valor pode ser expandido (objeto, lista, …). */
  readonly variablesReference: number;
}

/** Evento `stopped` já simplificado para o renderer. */
export interface DapStoppedEvent {
  readonly reason: string;
  readonly threadId?: number;
  readonly description?: string;
  readonly text?: string;
}

/** Evento `output` já simplificado para o renderer. */
export interface DapOutputEvent {
  /** Uma de `console` | `stdout` | `stderr` | `telemetry` | outra string do adaptador. */
  readonly category: string;
  readonly output: string;
}

// ── Configuração global ───────────────────────────────────────────────────────────────────

export interface DapSettings {
  /** Adaptadores do usuário (custom). */
  readonly servers: readonly DapServerConfig[];
  /** Habilita a integração de depuração? */
  readonly enabled: boolean;
}

export const DEFAULT_DAP_SETTINGS: DapSettings = {
  servers: [],
  enabled: true,
};