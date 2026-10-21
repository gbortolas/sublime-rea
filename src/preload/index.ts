/**
 * Scribe — preload (ponte tipada via `contextBridge`).
 *
 * Requisitos (ver `docs/scaffold/00-convencoes-e-costuras.md` e `04-render-e-ui.md`):
 * - `sandbox: true` ⇒ o preload **não** pode `require` módulos locais: só `electron` em runtime.
 *   Por isso os nomes de canal/versão do contrato (`src/shared/ipc-contract.ts`) são **duplicados**
 *   aqui (strings constantes), e os tipos vêm por `import type` (apagado na compilação).
 * - `contextIsolation: true` ⇒ **nunca** expor `ipcRenderer` cru; só a superfície mínima abaixo.
 *
 * Superfície exposta: `window.scribe`.
 * - `scribe.open/text/revision/insert/snapshot` → request/response por `id` (DEC-IPC-4/5).
 * - `scribe.onDocumentChanged(cb)` → cancela a inscrição (evento `document.changed`).
 * - `scribe.host.ping/onReady` → liveness legada do host de extensões.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  CommandListResult,
  DocumentChangedEvent,
  DocumentHandle,
  DocumentHighlight,
  DocumentInsertResult,
  DocumentUndoState,
  GitCommitResult,
  GitStatusResult,
  GrepResult,
  LspCodeAction,
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHoverResult,
  LspLocation,
  LspRenameResult,
  LspSignatureHelp,
  LspTextEdit,
  LspFoldingRange,
  LspInlayHint,
  MainThreadBusy,
  ReplaceAllResult,
  SearchDocumentResult,
  SearchFilesOptions,
  SearchQuery,
  SelectionSet,
  SnippetsListResult,
  WorkspaceCreateFileResult,
  WorkspaceFilesResult,
  DapBreakpoint,
  DapBreakpointSpec,
  DapEvaluation,
  DapEvaluationRequestContext,
  DapOutputEvent,
  DapScope,
  DapSessionState,
  DapStackFrame,
  DapStoppedEvent,
  DapThread,
  DapVariable,
} from "../shared";

export interface HostReadyInfo {
  readonly apiVersion: string;
  readonly hostVersion: string;
}

/** Origem da edição aceita pelo contrato de `document.insert`. */
export type InsertOrigin = "plugin" | "user";

export interface ScribePreloadApi {
  readonly host: {
    ping(): Promise<"pong">;
    onReady(callback: (info: HostReadyInfo) => void): () => void;
  };
  open(path: string, signalId?: number): Promise<DocumentHandle>;
  openDialog(): Promise<string | null>;
  /**
   * Fecha o documento no core (o `didClose` do LSP sai por aqui).
   *
   * Documento sujo ⇒ o core **salva** antes de fechar (a semântica é do core).
   */
  closeDocument(handle: DocumentHandle): Promise<void>;
  /**
   * Índice de **arquivos da workspace** (o *Quick Open*, ⌘P).
   *
   * `roots` são as raízes candidatas (o renderer manda o diretório dos documentos
   * abertos); o main expande até a raiz da workspace e varre a árvore.
   */
  workspaceFiles(roots?: readonly string[]): Promise<WorkspaceFilesResult>;
  /**
   * Cria um arquivo **vazio** dentro da workspace (o "criar arquivo" do ⌘P).
   *
   * O `main` confina o path a uma das raízes da workspace (fora ⇒ `invalid-args`), **não
   * aceita symlink no caminho** e **nunca** sobrescreve um arquivo existente
   * (`created: false`).
   */
  createFile(path: string): Promise<WorkspaceCreateFileResult>;
  /**
   * Status do repositório git (o painel de *Source Control*).
   *
   * `root` é a raiz do repositório; sem ele, o `main` usa a raiz do documento ativo.
   *
   * ⚠️ O `root` **não** é fonte de verdade: o `main` só aceita uma raiz **dentro** da
   * workspace (a raiz dos documentos abertos) — fora ⇒ `invalid-args` ("root-outside-
   * workspace"). O mesmo vale para `gitStage`/`gitUnstage`/`gitStageAll`/`gitCommit`.
   */
  gitStatus(root?: string): Promise<GitStatusResult>;
  /** Stage de um arquivo (`git add -- <path>`). */
  gitStage(path: string, root?: string): Promise<GitStatusResult>;
  /** Unstage de um arquivo (`git restore --staged -- <path>`). */
  gitUnstage(path: string, root?: string): Promise<GitStatusResult>;
  /** Stage de tudo (`git add -A`). */
  gitStageAll(root?: string): Promise<GitStatusResult>;
  /** Commit (`git commit -m <mensagem>`) — em falha, `{ ok: false, error }` (nunca rejeita). */
  gitCommit(message: string, root?: string): Promise<GitCommitResult>;
  /**
   * Diff unificado cru (`git diff HEAD`) — o renderer faz o parse.
   *
   * O `path` tem de estar **dentro** da workspace — fora ⇒ `invalid-args`
   * ("path-outside-workspace").
   */
  gitDiffText(path: string): Promise<string>;
  /**
   * Busca o padrão em **todos os arquivos** da workspace (o "grep", `Ctrl+Shift+F`).
   *
   * `signalId` torna a busca **cancelável** — o renderer aborta a busca anterior quando
   * o usuário digita outro termo.
   */
  searchFiles(
    query: string,
    options?: SearchFilesOptions,
    signalId?: number,
  ): Promise<GrepResult>;
  text(handle: DocumentHandle): Promise<string>;
  revision(handle: DocumentHandle): Promise<number>;
  save(handle: DocumentHandle): Promise<void>;
  isDirty(handle: DocumentHandle): Promise<boolean>;
  /**
   * Insere `text` em `at`. `selections` é o conjunto de cursores **antes** da edição
   * (multi-cursor) — é o contexto que o undo restaura. Opcional (compatibilidade).
   */
  insert(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin?: InsertOrigin,
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  /**
   * Lote de inserções: aplica tudo como transação única (um `Ctrl+Z` desfaz o lote inteiro).
   *
   * O `at` de cada entrada é absoluto **no estado do buffer após as entradas anteriores** ⇒ um
   * lote multi-cursor deve entrar em ordem **descendente**. `remove` (padrão `""`) apaga em `at`.
   */
  batchInsert(
    handle: DocumentHandle,
    inserts: ReadonlyArray<{
      readonly at: number;
      readonly text: string;
      readonly remove?: string;
    }>,
    origin?: InsertOrigin,
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  /**
   * Substitui `remove` caracteres em `at` por `insert`. `selections` é o conjunto de cursores
   * **antes** da edição (o que o undo restaura). Opcional (compatibilidade).
   */
  replaceOne(
    handle: DocumentHandle,
    at: number,
    remove: number,
    insert: string,
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  undo(handle: DocumentHandle): Promise<DocumentUndoState>;
  redo(handle: DocumentHandle): Promise<DocumentUndoState>;
  undoState(handle: DocumentHandle): Promise<DocumentUndoState>;
  /** Destaque de sintaxe de um range de linhas (o main resolve a gramática e tokeniza). */
  highlight(handle: DocumentHandle, first: number, count: number): Promise<DocumentHighlight>;
  /** Busca numa lane de fundo (o main usa o `TaskPool` + `Scheduler`). */
  find(handle: DocumentHandle, query: SearchQuery): Promise<SearchDocumentResult>;
  /** Substitui todas as ocorrências (um só passo de undo). */
  replaceAll(
    handle: DocumentHandle,
    query: SearchQuery,
    replacement: string,
  ): Promise<ReplaceAllResult>;
  /** Cancela a operação em voo identificada por `signalId` (envelope `IpcCancel`). */
  cancel(signalId: number): void;
  /** Gera um `signalId` novo para uma operação cancelável (evita colisão com outros chamadores). */
  nextSignalId(): number;
  snapshot(): Promise<MainThreadBusy>;
  onDocumentChanged(callback: (event: DocumentChangedEvent) => void): () => void;
  /** Lista todos os comandos registrados (para a Command Palette). */
  listCommands(): Promise<CommandListResult>;
  /** Executa um comando pelo id. */
  executeCommand(commandId: string): Promise<void>;
  /** Escuta ações de menu enviadas pelo processo principal (menu nativo). */
  onMenuAction(callback: (action: string) => void): () => void;
  /** Pedido de completação LSP (main → servidor → resposta). */
  completions(handle: DocumentHandle, line: number, col: number): Promise<LspCompletionItem[]>;
  /** Pedido de hover LSP. */
  hover(handle: DocumentHandle, line: number, col: number): Promise<LspHoverResult | null>;
  /** Escuta diagnósticos LSP enviados pelo processo principal. */
  onDiagnostics(
    callback: (event: { handle: DocumentHandle; diagnostics: LspDiagnostic[] }) => void,
  ): () => void;
  /**
   * Diagnósticos LSP **atuais** do documento (relê o estado do core).
   *
   * O `onDiagnostics` é *push* (e pode perder o primeiro evento — o servidor publica uma vez
   * só); este método é o *pull*: o renderer relê o estado quando precisa (ex.: ao abrir um
   * arquivo já com diagnóstico).
   */
  diagnostics(handle: DocumentHandle): Promise<LspDiagnostic[]>;
  /** Go-to-definition LSP. */
  definition(handle: DocumentHandle, line: number, col: number): Promise<LspLocation | null>;
  /** Signature help LSP. */
  signatureHelp(handle: DocumentHandle, line: number, col: number, triggerCharacter?: string): Promise<LspSignatureHelp | null>;
  /** Lista símbolos do documento via LSP. */
  documentSymbols(handle: DocumentHandle): Promise<LspDocumentSymbol[]>;
  /** Renomeia um símbolo via LSP (F2). */
  rename(handle: DocumentHandle, line: number, col: number, newName: string): Promise<LspRenameResult | null>;
  /** Find references LSP (Ctrl+Shift+F12). */
  references(handle: DocumentHandle, line: number, col: number): Promise<LspLocation[]>;
  /** Code actions LSP (Ctrl+.). */
  codeActions(handle: DocumentHandle, line: number, col: number): Promise<readonly LspCodeAction[]>;
  /** Formata documento via LSP (Ctrl+Shift+I). */
  formatting(handle: DocumentHandle, tabSize?: number, insertSpaces?: boolean): Promise<LspTextEdit[]>;
  /** Folding ranges via LSP. */
  foldingRange(handle: DocumentHandle): Promise<LspFoldingRange[]>;
  /** Inlay hints via LSP (range opcional). */
  inlayHints(handle: DocumentHandle, startLine?: number, endLine?: number): Promise<LspInlayHint[]>;
  /** Git blame da linha (autor · há X dias). */
  blame(handle: DocumentHandle, line: number): Promise<{ commitHash: string; author: string; timeAgo: string } | null>;
  /** Git diff do documento em relação ao HEAD (barras coloridas no gutter). */
  gitDiff(handle: DocumentHandle): Promise<readonly { startLine: number; lineCount: number; kind: string }[]>;
  /** Inicia uma sessão de depuração (DAP) para o documento. */
  dapStart(handle: DocumentHandle, stopOnEntry?: boolean): Promise<DapSessionState>;
  /** Encerra a sessão de depuração ativa. */
  dapStop(): Promise<DapSessionState>;
  /** Estado atual da sessão de depuração. */
  dapState(): Promise<DapSessionState>;
  /** Define os breakpoints de um documento (só a linha, ou spec com condição). */
  dapSetBreakpoints(handle: DocumentHandle, specs: readonly (number | DapBreakpointSpec)[]): Promise<readonly DapBreakpoint[]>;
  /** Breakpoints desejados de um documento (com condição, se houver). */
  dapBreakpoints(handle: DocumentHandle): Promise<readonly DapBreakpointSpec[]>;
  /** Threads do programa depurado. */
  dapThreads(): Promise<readonly DapThread[]>;
  /** Pilha de chamadas de uma thread. */
  dapStackTrace(threadId: number): Promise<readonly DapStackFrame[]>;
  /** Escopos de variáveis de um frame. */
  dapScopes(frameId: number): Promise<readonly DapScope[]>;
  /** Variáveis de um escopo (ou nó expandido). */
  dapVariables(variablesReference: number): Promise<readonly DapVariable[]>;
  /** Continua a execução de uma thread. */
  dapContinue(threadId: number): Promise<void>;
  /** Pausa a execução de uma thread. */
  dapPause(threadId: number): Promise<void>;
  /** Passo por cima. */
  dapStepOver(threadId: number): Promise<void>;
  /** Passo para dentro. */
  dapStepInto(threadId: number): Promise<void>;
  /** Passo para fora. */
  dapStepOut(threadId: number): Promise<void>;
  /** Avalia uma expressão no programa depurado (watch/hover). */
  dapEvaluate(expression: string, frameId: number, context?: DapEvaluationRequestContext): Promise<DapEvaluation | null>;
  /** Escuta mudanças de estado da sessão de depuração. */
  onDapState(callback: (event: { state: DapSessionState }) => void): () => void;
  /** Escuta o evento de parada (breakpoint/passo/exceção). */
  onDapStopped(callback: (event: DapStoppedEvent) => void): () => void;
  /** Escuta a saída do programa depurado. */
  onDapOutput(callback: (event: DapOutputEvent) => void): () => void;
  /** Escuta a confirmação de breakpoints (verificados) de um arquivo. */
  onDapBreakpoints(callback: (event: { path: string; breakpoints: DapBreakpoint[] }) => void): () => void;
  /**
   * Snippets de pacote (`.sublime-snippet` dentro de `Packages/<Nome>/…`).
   *
   * É **global ao app** (não tem handle). Um preload mais antigo simplesmente não expõe o
   * método — o renderer degrada para os snippets embutidos, sem crash.
   */
  snippets(): Promise<SnippetsListResult>;
}

// Duplicado de propósito: o preload não importa `src/shared` em runtime (sandbox).
const CHANNEL_REQUEST = "scribe:ipc:request";
const CHANNEL_EVENT = "scribe:ipc:event";
const IPC_VERSION = "1.0";
const CHANNEL_PING = "scribe:host:ping";
const CHANNEL_READY = "scribe:host:ready";
const CHANNEL_MENU_ACTION = "scribe:menu:action";

interface RequestEnvelope {
  readonly v: string;
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
  readonly signalId?: number;
}

/** Push de cancelamento (mesmo canal; sem `id`/`method` — o main despacha pelo `kind`). */
interface CancelEnvelope {
  readonly v: string;
  readonly kind: "cancel";
  readonly signalId: number;
}

interface ResponseEnvelope {
  readonly v: string;
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface EventEnvelope {
  readonly v: string;
  readonly event: string;
  readonly args: readonly unknown[];
}

let requestSeq = 0;
let signalSeq = 0;

/** Envia um request e desembrulha a resposta; erro remoto vira exceção tipada (nunca silencioso). */
function call<T>(method: string, args: readonly unknown[], signalId?: number): Promise<T> {
  requestSeq += 1;
  const id = requestSeq;
  const envelope: RequestEnvelope =
    signalId === undefined ? { v: IPC_VERSION, id, method, args } : { v: IPC_VERSION, id, method, args, signalId };
  return ipcRenderer.invoke(CHANNEL_REQUEST, envelope).then((raw: unknown) => unwrap<T>(raw, id));
}

function unwrap<T>(raw: unknown, id: number): T {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Scribe IPC: resposta inválida (id ${id})`);
  }
  const response = raw as ResponseEnvelope;
  if (response.ok === true) return response.value as T;
  const code = response.error?.code ?? "unknown";
  const message = response.error?.message ?? "erro remoto sem mensagem";
  throw new Error(`Scribe IPC[${code}]: ${message}`);
}

const api: ScribePreloadApi = {
  host: {
    ping: (): Promise<"pong"> => ipcRenderer.invoke(CHANNEL_PING) as Promise<"pong">,
    onReady: (callback: (info: HostReadyInfo) => void): (() => void) => {
      const listener = (_event: unknown, info: HostReadyInfo): void => callback(info);
      ipcRenderer.on(CHANNEL_READY, listener);
      return () => {
        ipcRenderer.removeListener(CHANNEL_READY, listener);
      };
    },
  },
  open: (path: string, signalId?: number): Promise<DocumentHandle> => {
    // Validação **no preload**: o path vem do renderer (não confiável). Path vazio ou com
    // NUL faria o `fs` do main lançar uma exceção opaca; aqui o erro é tipado e local.
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      return Promise.reject(new Error("Scribe: path de documento inválido"));
    }
    return call<DocumentHandle>("document.open", [path], signalId);
  },
  openDialog: (): Promise<string | null> => call<string | null>("document.openDialog", []),
  closeDocument: (handle: DocumentHandle): Promise<void> =>
    call<void>("document.close", [handle]),
  workspaceFiles: (roots?: readonly string[]): Promise<WorkspaceFilesResult> =>
    call<WorkspaceFilesResult>("workspace.files", roots === undefined ? [] : [roots]),
  createFile: (path: string): Promise<WorkspaceCreateFileResult> =>
    call<WorkspaceCreateFileResult>("workspace.createFile", [path]),
  gitStatus: (root?: string): Promise<GitStatusResult> =>
    call<GitStatusResult>("git.status", root === undefined ? [] : [root]),
  gitStage: (path: string, root?: string): Promise<GitStatusResult> =>
    call<GitStatusResult>("git.stage", root === undefined ? [path] : [path, root]),
  gitUnstage: (path: string, root?: string): Promise<GitStatusResult> =>
    call<GitStatusResult>("git.unstage", root === undefined ? [path] : [path, root]),
  gitStageAll: (root?: string): Promise<GitStatusResult> =>
    call<GitStatusResult>("git.stageAll", root === undefined ? [] : [root]),
  gitCommit: (message: string, root?: string): Promise<GitCommitResult> =>
    call<GitCommitResult>("git.commit", root === undefined ? [message] : [message, root]),
  gitDiffText: (path: string): Promise<string> => {
    // Validação **no preload** (como o `open`): path vazio ou com NUL faria o `fs` do main
    // lançar uma exceção opaca — aqui o erro é tipado e local.
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      return Promise.reject(new Error("Scribe: path de arquivo inválido"));
    }
    return call<string>("git.diffText", [path]);
  },
  searchFiles: (
    query: string,
    options?: SearchFilesOptions,
    signalId?: number,
  ): Promise<GrepResult> =>
    call<GrepResult>(
      "search.files",
      options === undefined ? [query] : [query, options],
      signalId,
    ),
  text: (handle: DocumentHandle): Promise<string> => call<string>("document.text", [handle]),
  revision: (handle: DocumentHandle): Promise<number> =>
    call<number>("document.revision", [handle]),
  save: (handle: DocumentHandle): Promise<void> =>
    call<void>("document.save", [handle]),
  isDirty: (handle: DocumentHandle): Promise<boolean> =>
    call<boolean>("document.isDirty", [handle]),
  // `selections` só entra no wire quando existe — assim um cliente antigo (ou uma chamada sem
  // o parâmetro) continua mandando exatamente os mesmos argumentos de antes.
  insert: (
    handle: DocumentHandle,
    at: number,
    text: string,
    origin: InsertOrigin = "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult> =>
    call<DocumentInsertResult>(
      "document.insert",
      selections === undefined ? [handle, at, text, origin] : [handle, at, text, origin, selections],
    ),
  replaceOne: (
    handle: DocumentHandle,
    at: number,
    remove: number,
    insert: string,
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult> =>
    call<DocumentInsertResult>(
      "document.replaceOne",
      selections === undefined
        ? [handle, at, remove, insert]
        : [handle, at, remove, insert, selections],
    ),
  batchInsert: (
    handle: DocumentHandle,
    inserts: ReadonlyArray<{
      readonly at: number;
      readonly text: string;
      readonly remove?: string;
    }>,
    origin: InsertOrigin = "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult> =>
    call<DocumentInsertResult>(
      "document.batchInsert",
      selections === undefined ? [handle, inserts, origin] : [handle, inserts, origin, selections],
    ),
  undo: (handle: DocumentHandle): Promise<DocumentUndoState> =>
    call<DocumentUndoState>("editor.undo", [handle]),
  redo: (handle: DocumentHandle): Promise<DocumentUndoState> =>
    call<DocumentUndoState>("editor.redo", [handle]),
  undoState: (handle: DocumentHandle): Promise<DocumentUndoState> =>
    call<DocumentUndoState>("editor.undoState", [handle]),
  highlight: (handle: DocumentHandle, first: number, count: number): Promise<DocumentHighlight> =>
    call<DocumentHighlight>("syntax.highlight", [handle, first, count]),
  find: (handle: DocumentHandle, query: SearchQuery): Promise<SearchDocumentResult> =>
    call<SearchDocumentResult>("search.find", [handle, query]),
  replaceAll: (
    handle: DocumentHandle,
    query: SearchQuery,
    replacement: string,
  ): Promise<ReplaceAllResult> =>
    call<ReplaceAllResult>("search.replaceAll", [handle, query, replacement]),
  cancel: (signalId: number): void => {
    const envelope: CancelEnvelope = { v: IPC_VERSION, kind: "cancel", signalId };
    // Push: sem resposta correlacionada; engolir a rejeição da ponte é intencional.
    void ipcRenderer.invoke(CHANNEL_REQUEST, envelope).catch(() => undefined);
  },
  nextSignalId: (): number => {
    signalSeq += 1;
    return signalSeq;
  },
  snapshot: (): Promise<MainThreadBusy> => call<MainThreadBusy>("editor.snapshot", []),
  onDocumentChanged: (callback: (event: DocumentChangedEvent) => void): (() => void) => {
    const listener = (_event: unknown, raw: unknown): void => {
      if (typeof raw !== "object" || raw === null) return;
      const envelope = raw as EventEnvelope;
      if (envelope.event !== "document.changed") return;
      const argument = envelope.args[0];
      if (typeof argument === "object" && argument !== null) {
        callback(argument as DocumentChangedEvent);
      }
    };
    ipcRenderer.on(CHANNEL_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CHANNEL_EVENT, listener);
    };
  },
  listCommands: (): Promise<CommandListResult> =>
    call<CommandListResult>("command.list", []),
  executeCommand: (commandId: string): Promise<void> =>
    call<void>("command.execute", [commandId]),
  onMenuAction: (callback: (action: string) => void): (() => void) => {
    const listener = (_event: unknown, action: string): void => { callback(action); };
    ipcRenderer.on(CHANNEL_MENU_ACTION, listener);
    return () => { ipcRenderer.removeListener(CHANNEL_MENU_ACTION, listener); };
  },
  completions: (handle: DocumentHandle, line: number, col: number): Promise<LspCompletionItem[]> =>
    call<LspCompletionItem[]>("lsp.completions", [handle, line, col]),
  hover: (handle: DocumentHandle, line: number, col: number): Promise<LspHoverResult | null> =>
    call<LspHoverResult | null>("lsp.hover", [handle, line, col]),
  onDiagnostics: (
    callback: (event: { handle: DocumentHandle; diagnostics: LspDiagnostic[] }) => void,
  ): (() => void) => {
    const listener = (_event: unknown, raw: unknown): void => {
      if (typeof raw !== "object" || raw === null) return;
      const envelope = raw as EventEnvelope;
      if (envelope.event !== "lsp.diagnostics") return;
      const argument = envelope.args[0];
      if (typeof argument === "object" && argument !== null) {
        callback(argument as { handle: DocumentHandle; diagnostics: LspDiagnostic[] });
      }
    };
    ipcRenderer.on(CHANNEL_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CHANNEL_EVENT, listener);
    };
  },
  diagnostics: (handle: DocumentHandle): Promise<LspDiagnostic[]> =>
    call<LspDiagnostic[]>("lsp.diagnostics", [handle]),
  definition: (handle: DocumentHandle, line: number, col: number): Promise<LspLocation | null> =>
    call<LspLocation | null>("lsp.definition", [handle, line, col]),
  signatureHelp: (handle: DocumentHandle, line: number, col: number, triggerCharacter?: string): Promise<LspSignatureHelp | null> =>
    call<LspSignatureHelp | null>("lsp.signatureHelp", [handle, line, col, triggerCharacter]),
  documentSymbols: (handle: DocumentHandle): Promise<LspDocumentSymbol[]> =>
    call<LspDocumentSymbol[]>("lsp.documentSymbols", [handle]),
  rename: (handle: DocumentHandle, line: number, col: number, newName: string): Promise<LspRenameResult | null> =>
    call<LspRenameResult | null>("lsp.rename", [handle, line, col, newName]),
  references: (handle: DocumentHandle, line: number, col: number): Promise<LspLocation[]> =>
    call<LspLocation[]>("lsp.references", [handle, line, col]),
  codeActions: (handle: DocumentHandle, line: number, col: number): Promise<readonly LspCodeAction[]> =>
    call<readonly LspCodeAction[]>("lsp.codeActions", [handle, line, col]),
  formatting: (handle: DocumentHandle, tabSize?: number, insertSpaces?: boolean): Promise<LspTextEdit[]> =>
    call<LspTextEdit[]>("lsp.formatting", [handle, tabSize, insertSpaces]),
  foldingRange: (handle: DocumentHandle): Promise<LspFoldingRange[]> =>
    call<LspFoldingRange[]>("lsp.foldingRange", [handle]),
  inlayHints: (handle: DocumentHandle, startLine?: number, endLine?: number): Promise<LspInlayHint[]> =>
    call<LspInlayHint[]>("lsp.inlayHints", [handle, startLine, endLine]),
  blame: (handle: DocumentHandle, line: number): Promise<{ commitHash: string; author: string; timeAgo: string } | null> =>
    call<{ commitHash: string; author: string; timeAgo: string } | null>("git.blame", [handle, line]),
  gitDiff: (handle: DocumentHandle): Promise<readonly { startLine: number; lineCount: number; kind: string }[]> =>
    call<readonly { startLine: number; lineCount: number; kind: string }[]>("git.diff", [handle]),
  dapStart: (handle: DocumentHandle, stopOnEntry?: boolean): Promise<DapSessionState> =>
    call<DapSessionState>("dap.start", [handle, stopOnEntry]),
  dapStop: (): Promise<DapSessionState> => call<DapSessionState>("dap.stop", []),
  dapState: (): Promise<DapSessionState> => call<DapSessionState>("dap.state", []),
  dapSetBreakpoints: (handle: DocumentHandle, specs: readonly (number | DapBreakpointSpec)[]): Promise<readonly DapBreakpoint[]> =>
    call<readonly DapBreakpoint[]>("dap.setBreakpoints", [handle, specs]),
  dapBreakpoints: (handle: DocumentHandle): Promise<readonly DapBreakpointSpec[]> =>
    call<readonly DapBreakpointSpec[]>("dap.breakpoints", [handle]),
  dapThreads: (): Promise<readonly DapThread[]> => call<readonly DapThread[]>("dap.threads", []),
  dapStackTrace: (threadId: number): Promise<readonly DapStackFrame[]> =>
    call<readonly DapStackFrame[]>("dap.stackTrace", [threadId]),
  dapScopes: (frameId: number): Promise<readonly DapScope[]> =>
    call<readonly DapScope[]>("dap.scopes", [frameId]),
  dapVariables: (variablesReference: number): Promise<readonly DapVariable[]> =>
    call<readonly DapVariable[]>("dap.variables", [variablesReference]),
  dapContinue: (threadId: number): Promise<void> => call<void>("dap.continue", [threadId]),
  dapPause: (threadId: number): Promise<void> => call<void>("dap.pause", [threadId]),
  dapStepOver: (threadId: number): Promise<void> => call<void>("dap.stepOver", [threadId]),
  dapStepInto: (threadId: number): Promise<void> => call<void>("dap.stepInto", [threadId]),
  dapStepOut: (threadId: number): Promise<void> => call<void>("dap.stepOut", [threadId]),
  dapEvaluate: (expression: string, frameId: number, context?: DapEvaluationRequestContext): Promise<DapEvaluation | null> =>
    call<DapEvaluation | null>("dap.evaluate", [expression, frameId, context]),
  onDapState: (callback: (event: { state: DapSessionState }) => void): (() => void) =>
    subscribeDap("dap.state", callback as (payload: unknown) => void),
  onDapStopped: (callback: (event: DapStoppedEvent) => void): (() => void) =>
    subscribeDap("dap.stopped", callback as (payload: unknown) => void),
  onDapOutput: (callback: (event: DapOutputEvent) => void): (() => void) =>
    subscribeDap("dap.output", callback as (payload: unknown) => void),
  onDapBreakpoints: (
    callback: (event: { path: string; breakpoints: DapBreakpoint[] }) => void,
  ): (() => void) => subscribeDap("dap.breakpoints", callback as (payload: unknown) => void),
  snippets: (): Promise<SnippetsListResult> => call<SnippetsListResult>("snippets.list", []),
};

/**
 * Assina um evento do canal `scribe:ipc:event` filtrando pelo nome; devolve o *unsubscribe*.
 */
function subscribeDap(event: string, callback: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    const envelope = raw as EventEnvelope;
    if (envelope.event !== event) return;
    const argument = envelope.args[0];
    if (typeof argument === "object" && argument !== null) callback(argument);
  };
  ipcRenderer.on(CHANNEL_EVENT, listener);
  return () => {
    ipcRenderer.removeListener(CHANNEL_EVENT, listener);
  };
}

contextBridge.exposeInMainWorld("scribe", api);

declare global {
  interface Window {
    readonly scribe: ScribePreloadApi;
  }
}
