/**
 * Scribe — contrato de IPC **main ↔ renderer** (a costura entre os dois "mains" do Electron).
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md` (DEC-CON-1/2: a UI nunca bloqueia;
 * main do Node e renderer são **dois mains**, fronteira por IPC) e
 * `docs/architecture/03-extensao-e-ipc.md` (DEC-IPC-4/5/9: request/response por `id` explícito,
 * dispatch por **nome tipado**, chamada longa é `async` + `AbortSignal`).
 *
 * Reconciliação: este é o irmão do `ExtensionBridge` (`extension-contract.ts`) — mesma forma de
 * mapa tipado de métodos (`IpcMethods`) + `ArgsOf`/`ResultOf`, mas para o par main ↔ renderer do
 * Electron (o `ExtensionBridge` é núcleo ↔ host de plugins). O transporte é
 * `ipcMain.handle`/`ipcRenderer.invoke` (um canal de request) + `webContents.send` (canal de
 * eventos), não `MessagePort`.
 *
 * Invariantes que os tipos **não** expressam (mas o teste prova):
 * - envelope malformado é **erro alto** (`parseIpc*` lança `IpcProtocolError`), nunca silencioso;
 * - **método/evento desconhecido** é rejeitado (nunca *fallthrough*);
 * - o contrato é **versionado** (`IPC_VERSION`): o major precisa bater para negociar.
 *
 * Rótulo de origem: tudo aqui é **escolha nossa** (não observado no alvo) — costura do Scribe.
 */
import type { ArgsOf, ResultOf } from "./extension-contract";
import type { DocumentHandle } from "./handles";
import type { DocumentHighlight } from "./syntax-contract";
import type { MainThreadBusy } from "./concurrency-contract";
import type { CommandListResult } from "./command-contract";
import type { ReplaceAllResult, SearchDocumentResult, SearchQuery } from "./search-contract";
import type { Selection, SelectionSet } from "./selection-contract";
import type { LspCompletionItem, LspDiagnostic, LspHoverResult, LspLocation, LspRenameResult, LspSignatureHelp, LspDocumentSymbol, LspCodeAction, LspTextEdit, LspFoldingRange, LspInlayHint } from "./lsp-contract";

/** Versão do contrato do canal — `"<major>.<minor>"` (DEC-IPC-11: handshake negocia). */
export type IpcVersion = `${number}.${number}`;

/** Versão que **este** scaffold implementa. */
export const IPC_VERSION: IpcVersion = "1.0";

/** Nomes de canal do wire (constantes — o preload as duplica para respeitar `sandbox: true`). */
export const IPC_CHANNEL = {
  /** Request/response: `ipcRenderer.invoke` ↔ `ipcMain.handle`. */
  request: "scribe:ipc:request",
  /** Push núcleo → renderer: `webContents.send` ↔ `ipcRenderer.on`. */
  event: "scribe:ipc:event",
} as const;

export type IpcChannel = (typeof IPC_CHANNEL)[keyof typeof IPC_CHANNEL];

/**
 * Evento de mudança de documento, **cross-boundary** (é o shape que viaja no IPC e o que o
 * `EditorCore.onDocumentChanged` publica). Definido aqui para que main, renderer e core usem o
 * mesmo shape sem import cruzado.
 * `origin` permite que o renderer ignore seus próprios eventos (evita bridge.text() redundante
 * quando o insertText já aplicou o texto localmente).
 */
export interface DocumentChangedEvent {
  readonly handle: DocumentHandle;
  readonly revision: number;
  readonly origin?: "plugin" | "user";
}

/**
 * Resultado rico de `document.insert` e `document.replaceOne`.
 * Antes: cada insert fazia 3 IPC roundtrips (insert → text → undoState).
 * Agora: 1 roundtrip devolve tudo que o renderer precisa.
 */
export interface DocumentInsertResult {
  readonly revision: number;
  readonly text: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/**
 * Estado observável de undo/redo de um documento — é o payload que o renderer usa para atualizar
 * a status bar (DEC-TR-3). `revision` é a revisão do buffer após a operação; `caret` é a posição
 * que o `UndoStack` restaurou (o cursor do documento, em code units UTF-16); `selection` é o
 * estado de seleção (colapsado = só cursor) que o `UndoStack` restaurou (P1#1).
 */
export interface DocumentUndoState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly revision: number;
  readonly caret: number;
  readonly selection: Selection;
  readonly selections: SelectionSet;
}

/**
 * Mapa de métodos expostos pelo **main** ao **renderer**. O resultado é o valor da resposta
 * (o transporte é assíncrono: `invoke` devolve `Promise`). A ordem de declaração não é wire.
 */
export interface IpcMethods {
  "document.open"(path: string): DocumentHandle;
  "document.openDialog"(): string | null;
  "document.text"(handle: DocumentHandle): string;
  "document.revision"(handle: DocumentHandle): number;
  "document.save"(handle: DocumentHandle): void;
  "document.isDirty"(handle: DocumentHandle): boolean;
  "document.insert"(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin: "plugin" | "user",
  ): DocumentInsertResult;
  /**
   * Lote de inserções: aplica múltiplos `{at, text}` como uma transação única.
   * Cada `at` é absoluto (considera inserts anteriores do lote).
   * Retorna o resultado consolidado (revisão final, texto final, undo/redo).
   */
  "document.batchInsert"(
    handle: DocumentHandle,
    inserts: ReadonlyArray<{ readonly at: number; readonly text: string }>,
    origin: "plugin" | "user",
  ): DocumentInsertResult;
  "document.replaceOne"(handle: DocumentHandle, at: number, remove: number, insert: string): DocumentInsertResult;
  "editor.undo"(handle: DocumentHandle): DocumentUndoState;
  "editor.redo"(handle: DocumentHandle): DocumentUndoState;
  "editor.undoState"(handle: DocumentHandle): DocumentUndoState;
  "editor.snapshot"(): MainThreadBusy;
  /**
   * Destaque de sintaxe de um range de linhas — o main resolve a gramática pelo `PackageResolver`
   * e tokeniza (DEC-PKG-8); o renderer só colore com o `ThemeResolver`. `first`/`count` são o range
   * de linhas absolutas (a virtualização do `Viewport` já manda só o visível).
   */
  "syntax.highlight"(handle: DocumentHandle, first: number, count: number): DocumentHighlight;
  /**
   * Busca no documento numa lane de fundo (o main registra o texto no `TaskPool` e roda a task
   * `search` na lane `background` do `Scheduler`). Devolve as ocorrências + a revisão do documento.
   */
  "search.find"(handle: DocumentHandle, query: SearchQuery): SearchDocumentResult;
  /**
   * Substitui **todas** as ocorrências (literal, sem `$1`). Num único passo de undo; recusa com
   * `search.tooManyMatches` se a busca for truncada (nada de substituição parcial silenciosa).
   */
  "search.replaceAll"(handle: DocumentHandle, query: SearchQuery, replacement: string): ReplaceAllResult;
  "command.list"(): CommandListResult;
  "command.execute"(commandId: string): void;
  "lsp.completions"(handle: DocumentHandle, line: number, col: number): LspCompletionItem[];
  "lsp.hover"(handle: DocumentHandle, line: number, col: number): LspHoverResult | null;
  "lsp.diagnostics"(handle: DocumentHandle): LspDiagnostic[];
  "lsp.definition"(handle: DocumentHandle, line: number, col: number): LspLocation | null;
  "lsp.signatureHelp"(handle: DocumentHandle, line: number, col: number, triggerCharacter?: string): LspSignatureHelp | null;
  "lsp.documentSymbols"(handle: DocumentHandle): LspDocumentSymbol[];
  "lsp.rename"(handle: DocumentHandle, line: number, col: number, newName: string): Promise<LspRenameResult | null>;
  "lsp.references"(handle: DocumentHandle, line: number, col: number): readonly LspLocation[];
  "lsp.codeActions"(handle: DocumentHandle, line: number, col: number): readonly LspCodeAction[];
  "lsp.formatting"(handle: DocumentHandle, tabSize?: number, insertSpaces?: boolean): readonly LspTextEdit[];
  "lsp.foldingRange"(handle: DocumentHandle): readonly LspFoldingRange[];
  "lsp.inlayHints"(handle: DocumentHandle, startLine?: number, endLine?: number): readonly LspInlayHint[];
  "git.blame"(handle: DocumentHandle, line: number): { commitHash: string; author: string; timeAgo: string } | null;
  "git.diff"(handle: DocumentHandle): readonly { startLine: number; lineCount: number; kind: string }[];
}

export type IpcMethodName = keyof IpcMethods & string;

/** Eventos emitidos pelo main para o renderer (mapa de handlers — o wire é array de args). */
export interface IpcEvents {
  "document.changed"(event: DocumentChangedEvent): void;
  "lsp.diagnostics"(event: { handle: DocumentHandle; diagnostics: LspDiagnostic[] }): void;
}

export type IpcEventName = keyof IpcEvents & string;

/** Argumentos/resposta tipados de um método — no estilo de `ExtensionMethods`/`ArgsOf`. */
export type IpcArgs<M extends IpcMethodName> = ArgsOf<IpcMethods[M]>;
export type IpcResult<M extends IpcMethodName> = ResultOf<IpcMethods[M]>;

/** Nomes válidos em tempo de execução (o mapa é só de tipos; isto valida o wire). */
export const IPC_METHODS = [
  "document.open",
  "document.openDialog",
  "document.text",
  "document.revision",
  "document.save",
  "document.isDirty",
  "document.insert",
  "document.batchInsert",
  "document.replaceOne",
  "editor.undo",
  "editor.redo",
  "editor.undoState",
  "editor.snapshot",
  "syntax.highlight",
  "search.find",
  "search.replaceAll",
  "command.list",
  "command.execute",
  "lsp.completions",
  "lsp.hover",
  "lsp.diagnostics",
  "lsp.definition",
  "lsp.signatureHelp",
  "lsp.documentSymbols",
  "lsp.rename",
  "lsp.references",
  "lsp.codeActions",
  "lsp.formatting",
  "lsp.foldingRange",
  "lsp.inlayHints",
  "git.blame",
  "git.diff",
] as const satisfies readonly IpcMethodName[];

export const IPC_EVENT_NAMES = ["document.changed", "lsp.diagnostics"] as const satisfies readonly IpcEventName[];

export interface IpcErrorPayload {
  readonly code: string;
  readonly message: string;
}

/** Erro do protocolo — envelope inválido/desconhecido (DEC-TR-5: nunca engolido). */
export class IpcProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`IpcProtocolError[${code}]: ${message}`);
    this.name = "IpcProtocolError";
    this.code = code;
  }
}

/** Requisição renderer → main (envelope único, multiplexado por `method`). */
export interface IpcRequest<M extends IpcMethodName = IpcMethodName> {
  readonly v: IpcVersion;
  /** `id` explícito de correlação (DEC-IPC-4/5). */
  readonly id: number;
  readonly method: M;
  readonly args: readonly unknown[];
  /** Cancelamento dedicado (DEC-IPC-9): `AbortSignal` do lado do chamador vira um `signalId`. */
  readonly signalId?: number;
}

export interface IpcSuccess {
  readonly v: IpcVersion;
  readonly id: number;
  readonly ok: true;
  readonly value: unknown;
}

export interface IpcFailure {
  readonly v: IpcVersion;
  readonly id: number;
  readonly ok: false;
  readonly error: IpcErrorPayload;
}

export type IpcResponse = IpcSuccess | IpcFailure;

/** Evento main → renderer (mesmo envelope de versão, com nome de evento + args). */
export interface IpcEventEnvelope<E extends IpcEventName = IpcEventName> {
  readonly v: IpcVersion;
  readonly event: E;
  readonly args: readonly unknown[];
}

/** Cancelamento dedicado (DEC-IPC-9) — nunca um opcode reservado. */
export interface IpcCancel {
  readonly v: IpcVersion;
  readonly kind: "cancel";
  readonly signalId: number;
}

export type IpcPush = IpcEventEnvelope | IpcCancel;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function majorOf(version: string): string {
  const dot = version.indexOf(".");
  return dot < 0 ? version : version.slice(0, dot);
}

/** `true` quando o major da versão bate com o implementado (minor é compatível). */
export function isIpcVersionCompatible(value: unknown): value is IpcVersion {
  return (
    typeof value === "string" &&
    /^\d+\.\d+$/.test(value) &&
    majorOf(value) === majorOf(IPC_VERSION)
  );
}

export function isIpcMethodName(value: unknown): value is IpcMethodName {
  return typeof value === "string" && (IPC_METHODS as readonly string[]).includes(value);
}

export function isIpcEventName(value: unknown): value is IpcEventName {
  return typeof value === "string" && (IPC_EVENT_NAMES as readonly string[]).includes(value);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new IpcProtocolError("invalid-envelope", `${what} não é um objeto`);
  }
  return value;
}

function requireId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new IpcProtocolError("invalid-id", `'id' deve ser inteiro: ${String(value)}`);
  }
  return value;
}

function requireArgs(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new IpcProtocolError("invalid-args", "'args' deve ser um array");
  }
  return value;
}

/** Valida um envelope de **requisição**. Envelope/tipo desconhecido ⇒ `IpcProtocolError`. */
export function parseIpcRequest(value: unknown): IpcRequest {
  const record = requireRecord(value, "requisição");
  if (!isIpcVersionCompatible(record["v"])) {
    throw new IpcProtocolError(
      "version-mismatch",
      `versão incompatível: ${String(record["v"])} (esperado ${IPC_VERSION})`,
    );
  }
  const id = requireId(record["id"]);
  const method = record["method"];
  if (!isIpcMethodName(method)) {
    throw new IpcProtocolError("unknown-method", `método desconhecido: ${String(method)}`);
  }
  const args = requireArgs(record["args"]);
  const signalId = record["signalId"];
  if (signalId === undefined) {
    return { v: record["v"], id, method, args };
  }
  if (typeof signalId !== "number" || !Number.isInteger(signalId)) {
    throw new IpcProtocolError("invalid-signal", `'signalId' deve ser inteiro: ${String(signalId)}`);
  }
  return { v: record["v"], id, method, args, signalId };
}

/** Valida um envelope de **resposta**. */
export function parseIpcResponse(value: unknown): IpcResponse {
  const record = requireRecord(value, "resposta");
  if (!isIpcVersionCompatible(record["v"])) {
    throw new IpcProtocolError("version-mismatch", `versão incompatível: ${String(record["v"])}`);
  }
  const id = requireId(record["id"]);
  if (record["ok"] === true) {
    return { v: record["v"], id, ok: true, value: record["value"] };
  }
  if (record["ok"] === false) {
    const rawError = record["error"];
    if (!isRecord(rawError) || typeof rawError["code"] !== "string" || typeof rawError["message"] !== "string") {
      throw new IpcProtocolError("invalid-error", "resposta de erro sem 'code'/'message' string");
    }
    return {
      v: record["v"],
      id,
      ok: false,
      error: { code: rawError["code"], message: rawError["message"] },
    };
  }
  throw new IpcProtocolError("invalid-envelope", "resposta sem campo 'ok' booleano");
}

/** Valida um envelope de **evento** main → renderer. */
export function parseIpcEvent(value: unknown): IpcEventEnvelope {
  const record = requireRecord(value, "evento");
  if (!isIpcVersionCompatible(record["v"])) {
    throw new IpcProtocolError("version-mismatch", `versão incompatível: ${String(record["v"])}`);
  }
  const event = record["event"];
  if (!isIpcEventName(event)) {
    throw new IpcProtocolError("unknown-event", `evento desconhecido: ${String(event)}`);
  }
  return { v: record["v"], event, args: requireArgs(record["args"]) };
}

/** Valida um envelope de **cancelamento**. */
export function parseIpcCancel(value: unknown): IpcCancel {
  const record = requireRecord(value, "cancelamento");
  if (!isIpcVersionCompatible(record["v"])) {
    throw new IpcProtocolError("version-mismatch", `versão incompatível: ${String(record["v"])}`);
  }
  if (record["kind"] !== "cancel") {
    throw new IpcProtocolError("invalid-envelope", "cancelamento sem 'kind: \"cancel\"'");
  }
  const signalId = record["signalId"];
  if (typeof signalId !== "number" || !Number.isInteger(signalId)) {
    throw new IpcProtocolError("invalid-signal", `'signalId' deve ser inteiro: ${String(signalId)}`);
  }
  return { v: record["v"], kind: "cancel", signalId };
}
