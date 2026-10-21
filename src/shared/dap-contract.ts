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
  /** Condição avaliada pelo adaptador (se houver). */
  readonly condition?: string;
  /** Condição de paradas (se houver) — o breakpoint só para na Nª ocorrência. */
  readonly hitCondition?: string;
  /** Mensagem de log (se houver) — logpoint: registra em vez de parar. */
  readonly logMessage?: string;
  readonly message?: string;
}

/**
 * Especificação de um breakpoint **desejado** — o que o Scribe guarda por arquivo e reenvia
 * ao adaptador como `SourceBreakpoint` do DAP.
 *
 * Aceita **números** (só a linha) ou objetos com condição — a normalização fica em
 * `src/core/dap/dap-breakpoints.ts` (`normalizeBreakpointSpecs`).
 */
export interface DapBreakpointSpec {
  /** Linha **1‑based**. */
  readonly line: number;
  /** Expressão condicional (ex.: `x > 3`); o breakpoint só para quando for verdadeira. */
  readonly condition?: string;
  /** Condição de paradas (ex.: `2` = só na 2ª vez; `>2` = a partir da 3ª). */
  readonly hitCondition?: string;
  /** Mensagem de log (logpoint) — o adaptador registra em vez de (ou além de) parar. */
  readonly logMessage?: string;
}

// ── Breakpoints: campos editáveis, tetos e a edição de um campo ─────────────────────────────

/**
 * Campo **editável** de um breakpoint.
 *
 * Os três campos são editáveis na interface (o painel de depuração) e chegam ao adaptador
 * como `SourceBreakpoint.condition` / `.hitCondition` / `.logMessage` do protocolo DAP.
 */
export type DapBreakpointField = "condition" | "hitCondition" | "logMessage";

/** Teto do tamanho da condição de um breakpoint. */
export const MAX_BREAKPOINT_CONDITION_LENGTH = 512;

/** Teto do tamanho da condição de paradas (`hitCondition`). */
export const MAX_BREAKPOINT_HIT_CONDITION_LENGTH = 64;

/** Teto do tamanho da mensagem de log (logpoint). */
export const MAX_BREAKPOINT_LOG_MESSAGE_LENGTH = 512;

/**
 * Teto de cada campo editável de um breakpoint.
 *
 * O mesmo teto vale nas três camadas (interface, normalização do core e envio ao
 * adaptador): a UI corta o que o usuário digitar, e o core corta de novo o que vier
 * pelo IPC (a UI não é a fonte da verdade).
 */
export const MAX_BREAKPOINT_FIELD_LENGTH: Readonly<Record<DapBreakpointField, number>> = {
  condition: MAX_BREAKPOINT_CONDITION_LENGTH,
  hitCondition: MAX_BREAKPOINT_HIT_CONDITION_LENGTH,
  logMessage: MAX_BREAKPOINT_LOG_MESSAGE_LENGTH,
};

/**
 * Aplica a edição de um campo a uma spec de breakpoint e devolve a spec **nova**.
 *
 * Regras (as mesmas da normalização do core — `src/core/dap/dap-breakpoints.ts`):
 * - o valor é **aparado** (`trim`) e **truncado** no teto do campo;
 * - valor vazio (ou só espaços) ⇒ o campo **some** da spec (nunca vira string vazia —
 *   o tipo é `exactOptionalPropertyTypes` e o adaptador rejeitaria campo vazio);
 * - os **outros** campos são preservados (editar a condição não apaga o logpoint).
 */
export function applyBreakpointField(
  spec: DapBreakpointSpec,
  field: DapBreakpointField,
  value: string,
): DapBreakpointSpec {
  const text = value.trim().slice(0, MAX_BREAKPOINT_FIELD_LENGTH[field]);
  const kept = text.length > 0 ? text : undefined;

  const condition = field === "condition" ? kept : spec.condition;
  const hitCondition = field === "hitCondition" ? kept : spec.hitCondition;
  const logMessage = field === "logMessage" ? kept : spec.logMessage;

  return {
    line: spec.line,
    ...(condition !== undefined ? { condition } : {}),
    ...(hitCondition !== undefined ? { hitCondition } : {}),
    ...(logMessage !== undefined ? { logMessage } : {}),
  };
}

/**
 * O breakpoint é um **logpoint** — registra a mensagem em vez de parar.
 *
 * Definição: tem `logMessage` **e** não tem `condition` (com condição, o breakpoint
 * para *e* registra — é um breakpoint condicional com log, não um logpoint puro).
 */
export function isLogpointSpec(spec: DapBreakpointSpec): boolean {
  return (
    spec.logMessage !== undefined &&
    spec.logMessage.length > 0 &&
    spec.condition === undefined
  );
}

/**
 * Aplica a edição de um campo **na lista** de specs (a linha editada) e devolve a lista
 * nova — as demais linhas são preservadas como estão.
 *
 * É o que a interface faz quando o usuário edita um campo: a lista local passa a refletir
 * a edição (a spec da linha trocada) sem tocar nas outras linhas.
 */
export function applyBreakpointFieldToList(
  specs: readonly DapBreakpointSpec[],
  line: number,
  field: DapBreakpointField,
  value: string,
): DapBreakpointSpec[] {
  return specs.map((spec) =>
    spec.line === line ? applyBreakpointField(spec, field, value) : spec,
  );
}

/** Contexto de avaliação de expressão no programa depurado (DAP `evaluate`). */
export type DapEvaluationContext = "watch" | "repl" | "hover" | "clipboard";

/**
 * Contexto de avaliação **aceito pelo IPC** (`dap.evaluate`): só `watch` e `hover`.
 *
 * `repl` executa a expressão como **statement** no debuggee (efeito colateral + mutação
 * de estado) e `clipboard` não faz parte do contrato da ponte. O tipo
 * {@link DapEvaluationContext} os contempla para um REPL futuro — a ponte, não.
 */
export type DapEvaluationRequestContext = Extract<DapEvaluationContext, "watch" | "hover">;

/**
 * Teto do tamanho de uma expressão avaliada (`dap.evaluate`).
 *
 * O mesmo teto da condição de breakpoint (`MAX_BREAKPOINT_CONDITION_LENGTH`): expressão
 * maior que isso é quase sempre erro de digitação — e o `evaluate` é pago pelo IPC.
 */
export const MAX_EVALUATION_LENGTH = 512;

/**
 * Teto de **concorrência** do `evaluate`: quantas avaliações podem estar em voo ao
 * mesmo tempo.
 *
 * O `evaluate` roda **no debuggee** (é uma avaliação real da expressão): um renderer
 * comprometido disparando avaliações em paralelo trava o programa depurado. 4 em voo
 * bastam para o hover + o watch + alguns painéis.
 *
 * A **imposição** fica no core (`DapManager.evaluate`) — o renderer só respeita o teto
 * para não brigar com ele.
 */
export const MAX_CONCURRENT_EVALUATIONS = 4;

/** Janela (ms) do teto de taxa do `evaluate`. */
export const EVAL_RATE_WINDOW_MS = 1000;

/** Teto de **taxa** do `evaluate`: avaliações aceitas por janela de {@link EVAL_RATE_WINDOW_MS}. */
export const MAX_EVALUATIONS_PER_WINDOW = 30;

/** Resultado de uma avaliação de expressão (watch, hover ou REPL). */
export interface DapEvaluation {
  /** Valor como texto (o adaptador formata). */
  readonly value: string;
  /** Tipo do valor, quando o adaptador informa. */
  readonly type?: string;
  /** `> 0` se o valor puder ser expandido (objeto, lista, …). */
  readonly variablesReference: number;
}

/**
 * Teto do tamanho do **valor** de uma avaliação (`dap.evaluate`).
 *
 * O valor vem do programa depurado (o renderer não o controla) e atravessa o IPC:
 * sem teto, uma string gigante — ou um programa hostil — enche a resposta do IPC.
 * 8 KB basta para o hover e o watch exibirem o valor.
 */
export const MAX_EVALUATION_VALUE_LENGTH = 8 * 1024;

/** Trunca um texto no teto de {@link MAX_EVALUATION_VALUE_LENGTH}. */
export function truncateEvaluationText(text: string): string {
  return text.length > MAX_EVALUATION_VALUE_LENGTH
    ? text.slice(0, MAX_EVALUATION_VALUE_LENGTH)
    : text;
}

/**
 * Trunca o valor e o tipo de uma avaliação — o que **cruza o IPC**.
 *
 * O truncamento é feito no texto (não em bytes): o limite é de caracteres, e é o
 * suficiente para conter a resposta.
 */
export function truncateEvaluation(evaluation: DapEvaluation): DapEvaluation {
  const value = truncateEvaluationText(evaluation.value);
  const type =
    evaluation.type !== undefined ? truncateEvaluationText(evaluation.type) : undefined;
  return {
    value,
    ...(type !== undefined ? { type } : {}),
    variablesReference: evaluation.variablesReference,
  };
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