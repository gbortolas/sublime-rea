/**
 * Scribe — tipos do protocolo JSON-RPC 2.0 e LSP (subconjunto mínimo).
 *
 * Define as mensagens JSON-RPC, estruturas do Language Server Protocol e guards de tipo.
 * **Não contém** tipos de configuração ou contratos de fronteira — esses vivem em
 * `src/shared/lsp-contract.ts`.
 */

// ── Constantes de erro JSON-RPC ─────────────────────────────────────────────────────────────

export const jsonrpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

// ── Tipos base JSON-RPC 2.0 ─────────────────────────────────────────────────────────────────

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface RequestMessage {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface ResponseMessage {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface NotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcMessage = RequestMessage | ResponseMessage | NotificationMessage;

// ── Guards de tipo ──────────────────────────────────────────────────────────────────────────

export function isRequestMessage(msg: JsonRpcMessage): msg is RequestMessage {
  return "id" in msg && "method" in msg && !("result" in msg) && !("error" in msg);
}

export function isResponseMessage(msg: JsonRpcMessage): msg is ResponseMessage {
  return "id" in msg && ("result" in msg || "error" in msg);
}

export function isNotificationMessage(msg: JsonRpcMessage): msg is NotificationMessage {
  return !("id" in msg) && "method" in msg;
}

export function isJsonRpcError(err: unknown): err is JsonRpcError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    typeof (err as Record<string, unknown>).code === "number" &&
    typeof (err as Record<string, unknown>).message === "string"
  );
}

// ── Enums LSP ───────────────────────────────────────────────────────────────────────────────

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export enum CompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 4,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  File = 17,
  Reference = 18,
  Folder = 19,
  EnumMember = 20,
  Constant = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export enum DocumentHighlightKind {
  Text = 1,
  Read = 2,
  Write = 3,
}

// ── Geometria do documento ──────────────────────────────────────────────────────────────────

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

// ── Identificadores de documento ─────────────────────────────────────────────────────────────

export interface TextDocumentItem {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

export interface TextDocumentIdentifier {
  readonly uri: string;
}

export interface VersionedTextDocumentIdentifier {
  readonly uri: string;
  readonly version: number;
}

// ── Tipos de resultado LSP ───────────────────────────────────────────────────────────────────

export interface Diagnostic {
  readonly range: Range;
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export interface CompletionItem {
  readonly label: string;
  readonly kind?: number;
  readonly detail?: string;
  readonly insertText?: string;
}

export type MarkedString = string | { readonly language: string; readonly value: string };

export interface MarkupContent {
  readonly kind: "plaintext" | "markdown";
  readonly value: string;
}

export interface Hover {
  readonly contents: MarkupContent | MarkedString | readonly MarkedString[];
  readonly range?: Range;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

export interface DocumentHighlight {
  readonly range: Range;
  readonly kind?: number;
}

// ── Parâmetros de métodos LSP ────────────────────────────────────────────────────────────────

export interface DidOpenTextDocumentParams {
  readonly textDocument: TextDocumentItem;
}

export interface DidChangeTextDocumentParams {
  readonly textDocument: VersionedTextDocumentIdentifier;
  readonly contentChanges: readonly TextDocumentContentChangeEvent[];
}

/**
 * Mudança de conteúdo no `textDocument/didChange`.
 *
 * `range` **ausente** = sincronização **full** (o `text` é o documento inteiro);
 * `range` presente = sincronização **incremental** (o `text` substitui só aquele trecho).
 */
export interface TextDocumentContentChangeEvent {
  readonly range?: Range;
  readonly text: string;
}

export interface DidCloseTextDocumentParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface CompletionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
  readonly context?: { readonly triggerKind: number; readonly triggerCharacter?: string };
}

export interface HoverParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
}

// ── Go to Definition ──────────────────────────────────────────────────────────────────────────

export type DefinitionParams = HoverParams;

// ── Rename ────────────────────────────────────────────────────────────────────────────────────

export interface RenameParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
  readonly newName: string;
}

export interface PrepareRenameParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
}

export interface WorkspaceEdit {
  readonly changes?: Record<string, readonly TextEdit[]>;
}

// ── Signature Help ────────────────────────────────────────────────────────────────────────────

export interface SignatureHelpParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
  readonly context?: {
    readonly triggerKind: number;        // 1=invoked, 2=triggerCharacter, 3=contentChange
    readonly triggerCharacter?: string;
    readonly isRetrigger: boolean;
  };
}

export interface ParameterInformation {
  readonly label: string | [number, number];
  readonly documentation?: string | MarkupContent;
}

export interface SignatureInformation {
  readonly label: string;
  readonly documentation?: string | MarkupContent;
  readonly parameters?: readonly ParameterInformation[];
  readonly activeParameter?: number;
}

export interface SignatureHelp {
  readonly signatures: readonly SignatureInformation[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

// ── Document Symbols ──────────────────────────────────────────────────────────────────────────

export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

export interface DocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly tags?: readonly number[];
  /**
   * Range **completo** do símbolo. Opcional de propósito: um servidor pode devolver um
   * payload incompleto — o cliente **tolera** a ausência e ignora o símbolo em vez de
   * estourar (o popup de Document Symbols não pode quebrar por causa do servidor).
   */
  readonly range?: Range;
  /**
   * Range do **nome** do símbolo. Opcional pelo mesmo motivo (ver `range`).
   */
  readonly selectionRange?: Range;
  readonly children?: readonly DocumentSymbol[];
}

/**
 * Símbolo **plano** (`SymbolInformation`) — a forma que o servidor devolve quando o
 * cliente não declara `textDocument.documentSymbol.hierarchicalDocumentSymbolSupport`.
 * O range vive em `location.range` (e não em `selectionRange`).
 */
export interface SymbolInformation {
  readonly name: string;
  readonly kind: number;
  readonly location: Location;
  readonly containerName?: string;
  /**
   * Detalhe textual do símbolo (o LSP plano não define este campo; alguns servidores o
   * mandam mesmo assim — o cliente o usa como "detail" no popup de Document Symbols).
   */
  readonly detail?: string;
}

/** Formas aceitas na resposta de `textDocument/documentSymbol`. */
export type DocumentSymbolLike = DocumentSymbol | SymbolInformation;

export interface DocumentSymbolParams {
  readonly textDocument: TextDocumentIdentifier;
}

// ── Document diagnóstico ───────────────────────────────────────────────────────────────────────

export interface DocumentDiagnosticParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly diagnostics: readonly Diagnostic[];
}

// ── Code Action ──────────────────────────────────────────────────────────────────────────────────

export interface Command {
  readonly title: string;
  readonly command: string;
  readonly arguments?: readonly unknown[];
}

export interface WorkspaceEdit {
  readonly changes?: Record<string, readonly TextEdit[]>;
}

export interface CodeAction {
  readonly title: string;
  readonly kind?: string;
  readonly diagnostics?: readonly Diagnostic[];
  readonly isPreferred?: boolean;
  readonly edit?: WorkspaceEdit;
  readonly command?: Command;
}

export interface CodeActionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly range: Range;
  readonly context: {
    readonly diagnostics: readonly Diagnostic[];
    readonly only?: readonly string[];
    readonly triggerKind?: number;
  };
}

// ── Find References ────────────────────────────────────────────────────────────

export interface ReferenceParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
  readonly context: { readonly includeDeclaration: boolean };
}

// ── Formatting ──────────────────────────────────────────────────────────────────────────────

export interface FormattingOptions {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly trimTrailingWhitespace?: boolean;
  readonly insertFinalNewline?: boolean;
  readonly trimFinalNewlines?: boolean;
}

export interface DocumentFormattingParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly options: {
    readonly tabSize: number;
    readonly insertSpaces: boolean;
    readonly trimTrailingWhitespace?: boolean;
    readonly insertFinalNewline?: boolean;
    readonly trimFinalNewlines?: boolean;
  };
}

// ── Folding ─────────────────────────────────────────────────────────────────────────────────

export enum FoldingRangeKind {
  Comment = "comment",
  Imports = "imports",
  Region = "region",
}

export interface FoldingRangeParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface FoldingRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly kind?: string;
  readonly collapsedText?: string;
}

// ── Inlay Hints ─────────────────────────────────────────────────────────────────────────────

export enum InlayHintKind {
  Type = 1,
  Parameter = 2,
}

export interface InlayHintLabelPart {
  readonly value: string;
  readonly tooltip?: string | { readonly kind: "markdown"; readonly value: string };
  readonly location?: Location;
}

export interface InlayHintParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly range?: Range;
}

export interface InlayHint {
  readonly position: Position;
  readonly label: string | readonly InlayHintLabelPart[];
  readonly kind?: InlayHintKind;
  readonly textEdits?: readonly TextEdit[];
  readonly tooltip?: string | { readonly kind: "markdown"; readonly value: string };
  readonly paddingLeft?: boolean;
  readonly paddingRight?: boolean;
}

// ── Server capabilities ─────────────────────────────────────────────────────────────────────

/**
 * Modo de sincronização do texto (LSP `TextDocumentSyncKind`).
 *
 * `Full` = o cliente manda o documento inteiro a cada `didChange`;
 * `Incremental` = o cliente manda **só o delta** (`range` + `text`).
 */
export enum TextDocumentSyncKind {
  None = 0,
  Full = 1,
  Incremental = 2,
}

export interface ServerCapabilities {
  readonly textDocumentSync?: number | {
    readonly openClose?: boolean;
    readonly change?: number;
    readonly save?: { readonly includeText?: boolean };
  };
  readonly completionProvider?: { readonly triggerCharacters?: readonly string[] };
  readonly hoverProvider?: boolean;
  readonly definitionProvider?: boolean | { readonly dynamicRegistration?: boolean };
  readonly signatureHelpProvider?: {
    readonly triggerCharacters?: readonly string[];
    readonly retriggerCharacters?: readonly string[];
  };
  readonly documentSymbolProvider?: boolean | { readonly dynamicRegistration?: boolean };
  readonly referencesProvider?: boolean | { readonly dynamicRegistration?: boolean };
  readonly renameProvider?: boolean | { readonly prepareProvider?: boolean };
  readonly codeActionProvider?: boolean | { readonly codeActionKinds?: readonly string[] };
  readonly diagnosticProvider?: {
    readonly identifier?: string;
    readonly interFileDependencies?: boolean;
    readonly workspaceDiagnostics?: boolean;
  };
  readonly documentFormattingProvider?: boolean | { readonly dynamicRegistration?: boolean };
  readonly foldingRangeProvider?: boolean | { readonly dynamicRegistration?: boolean };
  readonly inlayHintProvider?: boolean | { readonly dynamicRegistration?: boolean };
}

// ── Initialize ──────────────────────────────────────────────────────────────────────────────

export interface WorkspaceFolder {
  readonly uri: string;
  readonly name: string;
}

// ── Client capabilities ─────────────────────────────────────────────────────────────────────

/** `textDocument.publishDiagnostics` — o que o cliente sabe consumir de um diagnóstico. */
export interface PublishDiagnosticsClientCapabilities {
  readonly relatedInformation?: boolean;
  readonly versionSupport?: boolean;
  readonly codeDescriptionSupport?: boolean;
  readonly dataSupport?: boolean;
}

/**
 * `textDocument.synchronization` — como o cliente sincroniza o texto.
 *
 * ⚠️ `textDocumentSync` **não** faz parte do LSP padrão (a sincronização é declarada pelo
 * **servidor**). É uma extensão nossa que enviamos como **pedido**: 1 = sincronização
 * **full** (o cliente manda o documento inteiro). Servidores que aceitam a dica respondem
 * `textDocumentSync.change = 1`; os que ignoram respondem com o que preferem — e o
 * cliente **respeita a resposta** (ver `LspManager`).
 */
export interface TextDocumentSyncClientCapabilities {
  readonly dynamicRegistration?: boolean;
  readonly willSave?: boolean;
  readonly willSaveWaitUntil?: boolean;
  readonly didSave?: boolean;
  /** Pedido (não-padrão) de sincronização **full**. */
  readonly textDocumentSync?: number;
}

/** `textDocument.documentSymbol` — o cliente sabe ler a forma hierárquica? */
export interface DocumentSymbolClientCapabilities {
  readonly dynamicRegistration?: boolean;
  readonly hierarchicalDocumentSymbolSupport?: boolean;
  readonly labelSupport?: boolean;
}

/** `textDocument.completion` — capacidades do completion item. */
export interface CompletionClientCapabilities {
  readonly dynamicRegistration?: boolean;
  readonly completionItem?: {
    readonly snippetSupport?: boolean;
    readonly commitCharactersSupport?: boolean;
    readonly documentationFormat?: readonly string[];
    readonly deprecatedSupport?: boolean;
    readonly preselectSupport?: boolean;
    readonly tagSupport?: { readonly valueSet?: readonly number[] };
  };
  readonly completionItemKind?: { readonly valueSet?: readonly number[] };
}

/** `textDocument.codeAction` — capacidades de code action. */
export interface CodeActionClientCapabilities {
  readonly dynamicRegistration?: boolean;
  readonly resolveSupport?: boolean | { readonly properties?: readonly string[] };
  readonly codeActionLiteralSupport?: {
    readonly codeActionKind: {
      readonly valueSet: readonly string[];
    };
  };
}

/** `textDocument.hover` — formatos de markup aceitos no hover. */
export interface HoverClientCapabilities {
  readonly dynamicRegistration?: boolean;
  readonly contentFormat?: readonly string[];
}

/** `textDocument.definition` — o link de definição é navegável? */
export interface DefinitionClientCapabilities {
  readonly dynamicRegistration?: boolean;
  readonly linkSupport?: boolean;
}

/** `textDocument.foldingRange` / `textDocument.references` — capacidades simples. */
export interface FoldingRangeClientCapabilities {
  readonly dynamicRegistration?: boolean;
  readonly lineFoldingOnly?: boolean;
}

export interface ReferencesClientCapabilities {
  readonly dynamicRegistration?: boolean;
}

/** `textDocument` — o bloco de capacidades do cliente. */
export interface TextDocumentClientCapabilities {
  readonly publishDiagnostics?: PublishDiagnosticsClientCapabilities;
  readonly synchronization?: TextDocumentSyncClientCapabilities;
  readonly documentSymbol?: DocumentSymbolClientCapabilities;
  readonly completion?: CompletionClientCapabilities;
  readonly definition?: DefinitionClientCapabilities;
  readonly codeAction?: CodeActionClientCapabilities;
  readonly hover?: HoverClientCapabilities;
  readonly foldingRange?: FoldingRangeClientCapabilities;
  readonly references?: ReferencesClientCapabilities;
}

/** `workspace` — o bloco de capacidades do cliente. */
export interface WorkspaceClientCapabilities {
  readonly workspaceFolders?: boolean;
  readonly configuration?: boolean;
  readonly didChangeConfiguration?: { readonly dynamicRegistration?: boolean };
}

/** Capacidades do cliente no `initialize` — **não** são opcionais: declarar é o ato. */
export interface ClientCapabilities {
  readonly textDocument?: TextDocumentClientCapabilities;
  readonly workspace?: WorkspaceClientCapabilities;
}

export interface InitializeParams {
  readonly processId: number | null;
  readonly clientInfo?: { readonly name: string; readonly version?: string };
  readonly capabilities: ClientCapabilities;
  readonly rootUri?: string | null;
  readonly workspaceFolders?: readonly WorkspaceFolder[] | null;
  /** Opções específicas do servidor (ex.: `tsserver.path` para TypeScript). */
  readonly initializationOptions?: unknown;
}

export interface InitializeResult {
  readonly capabilities: ServerCapabilities;
}

// ── Erro do módulo LSP ──────────────────────────────────────────────────────────────────────

export class LspError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LspError";
    this.code = code;
  }
}