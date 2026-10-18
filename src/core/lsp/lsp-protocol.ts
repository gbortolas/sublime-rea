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
  readonly contentChanges: readonly { readonly text: string }[];
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
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[];
}

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

// ── Server capabilities ─────────────────────────────────────────────────────────────────────

export interface ServerCapabilities {
  readonly textDocumentSync?: number | { readonly openClose?: boolean; readonly change?: number };
  readonly completionProvider?: { readonly triggerCharacters?: readonly string[] };
  readonly hoverProvider?: boolean;
  readonly definitionProvider?: boolean | { readonly dynamicRegistration?: boolean };
  readonly signatureHelpProvider?: {
    readonly triggerCharacters?: readonly string[];
    readonly retriggerCharacters?: readonly string[];
  };
  readonly documentSymbolProvider?: boolean | { readonly dynamicRegistration?: boolean };
  readonly diagnosticProvider?: {
    readonly identifier?: string;
    readonly interFileDependencies?: boolean;
    readonly workspaceDiagnostics?: boolean;
  };
}

// ── Initialize ──────────────────────────────────────────────────────────────────────────────

export interface InitializeParams {
  readonly processId: number | null;
  readonly clientInfo?: { readonly name: string; readonly version?: string };
  readonly capabilities: unknown;
  readonly rootUri?: string | null;
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