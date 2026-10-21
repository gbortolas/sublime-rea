/**
 * Scribe — tipos do protocolo DAP (Debug Adapter Protocol, subconjunto mínimo).
 *
 * Define as mensagens do DAP (`request`/`response`/`event`, todas com `seq`), os corpos
 * de resposta mais usados e guards de tipo. **Não contém** tipos de configuração nem
 * contratos de fronteira — esses vivem em `src/shared/dap-contract.ts`.
 *
 * Fonte do protocolo: especificação pública do Debug Adapter Protocol (Microsoft).
 * Escolha nossa implementar o subconjunto necessário à depuração de um arquivo único.
 */

// ── Mensagens base ─────────────────────────────────────────────────────────────────────────

/** Uma requisição do cliente para o adaptador. */
export interface DapRequest {
  readonly seq: number;
  readonly type: "request";
  readonly command: string;
  readonly arguments?: unknown;
}

/** A resposta do adaptador para uma requisição (correlacionada por `request_seq`). */
export interface DapResponse {
  readonly seq: number;
  readonly type: "response";
  readonly request_seq: number;
  readonly success: boolean;
  readonly command: string;
  readonly message?: string;
  readonly body?: unknown;
}

/** Um evento assíncrono emitido pelo adaptador (stopped, output, terminated, …). */
export interface DapEvent {
  readonly seq: number;
  readonly type: "event";
  readonly event: string;
  readonly body?: unknown;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

// ── Guards de tipo ─────────────────────────────────────────────────────────────────────────

export function isDapRequest(msg: DapMessage): msg is DapRequest {
  return msg.type === "request";
}

export function isDapResponse(msg: DapMessage): msg is DapResponse {
  return msg.type === "response";
}

export function isDapEvent(msg: DapMessage): msg is DapEvent {
  return msg.type === "event";
}

// ── Corpos de resposta (subconjunto) ───────────────────────────────────────────────────────

export interface DapBreakpointBody {
  readonly id?: number;
  readonly verified: boolean;
  readonly line?: number;
  readonly source?: { readonly path?: string };
  readonly message?: string;
}

export interface DapSetBreakpointsResponseBody {
  readonly breakpoints: readonly DapBreakpointBody[];
}

/**
 * `SourceBreakpoint` do DAP — o que o cliente envia em `setBreakpoints`.
 * `condition`/`hitCondition`/`logMessage` são **opcionais**: omitidos ⇒ o breakpoint é
 * incondicional (parada sempre).
 */
export interface DapSourceBreakpoint {
  readonly line: number;
  readonly condition?: string;
  readonly hitCondition?: string;
  readonly logMessage?: string;
}

/** Corpo da resposta de `evaluate` (valor + tipo). */
export interface DapEvaluateResponseBody {
  readonly result: string;
  readonly type?: string;
  readonly variablesReference?: number;
}

export interface DapThreadBody {
  readonly id: number;
  readonly name: string;
}

export interface DapThreadsResponseBody {
  readonly threads: readonly DapThreadBody[];
}

export interface DapSourceBody {
  readonly name?: string;
  readonly path?: string;
}

export interface DapStackFrameBody {
  readonly id: number;
  readonly name: string;
  readonly source?: DapSourceBody;
  /** **1‑based** (o DAP tem configuração `linesStartAt1`). */
  readonly line: number;
  readonly column: number;
}

export interface DapStackTraceResponseBody {
  readonly stackFrames: readonly DapStackFrameBody[];
  readonly totalFrames?: number;
}

export interface DapScopeBody {
  readonly name: string;
  readonly variablesReference: number;
  readonly expensive: boolean;
}

export interface DapScopesResponseBody {
  readonly scopes: readonly DapScopeBody[];
}

export interface DapVariableBody {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variablesReference?: number;
}

export interface DapVariablesResponseBody {
  readonly variables: readonly DapVariableBody[];
}

export interface DapInitializeResponseBody {
  /** `true` se o adaptador suporta `configurationDone`. */
  readonly supportsConfigurationDoneRequest?: boolean;
  readonly supportsConditionalBreakpoints?: boolean;
  readonly supportsStepBack?: boolean;
}

// ── Corpos de evento (subconjunto) ─────────────────────────────────────────────────────────

/**
 * O evento `initialized` não tem corpo — existe só para sinalizar prontidão.
 * (`type` em vez de `interface` vazia: o lint proíbe `interface` sem membros.)
 */
export type DapInitializedEventBody = Record<string, never>;

export interface DapStoppedEventBody {
  readonly reason: string;
  readonly threadId?: number;
  readonly description?: string;
  readonly text?: string;
  readonly allThreadsStopped?: boolean;
}

export interface DapOutputEventBody {
  readonly category?: string;
  readonly output: string;
}

export interface DapTerminatedEventBody {
  readonly restart?: unknown;
}

/** `initialize` — parâmetros enviados pelo Scribe. */
export interface DapInitializeParams {
  readonly adapterID: string;
  readonly clientID: string;
  readonly clientName: string;
  readonly pathFormat: "path";
  readonly linesStartAt1: boolean;
  readonly columnsStartAt1: boolean;
  readonly supportsVariableType?: boolean;
}

// ── Erro do módulo DAP ────────────────────────────────────────────────────────────────────

export class DapError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DapError";
    this.code = code;
  }
}

/** Resposta com `success: false` — o adaptador recusou a requisição. */
export class DapRequestError extends DapError {
  readonly command: string;

  constructor(command: string, message: string) {
    super("DAP_REQUEST_FAILED", `${command}: ${message}`);
    this.name = "DapRequestError";
    this.command = command;
  }
}