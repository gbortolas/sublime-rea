/**
 * Scribe — `core/editor`: **módulo de composição** (a costura final entre os módulos de `core`).
 *
 * fonte: `docs/scaffold/00-convencoes-e-costuras.md` §1 ("a costura final é feita depois,
 * explicitamente") + `docs/architecture/02` (DEC-CON-1/2: a UI nunca bloqueia) e
 * `docs/architecture/03` (DEC-IPC-5/9: request/response por `id`, chamada longa é async).
 *
 * Este é o **único** lugar autorizado a importar cruzado entre módulos de `src/core/**`. Ele
 * monta o grafo de objetos e expõe uma API mínima e assíncrona para o processo `main`:
 *
 * - `DocumentRegistry` (buffer) — ciclo de vida de documentos + I/O por `FileSystem` injetado;
 * - `CommandBus` (command) — escritor único das mutações, com um alvo que aplica no **store do
 *   documento resolvido por handle** (o alvo é resolvido no momento da execução);
 * - `Scheduler`/`TaskPool` (concurrency) — lanes e teto **vindos do `PropertySystem`**;
 * - `PackageResolver` (packages) — raízes `os`/`app`/`user` opcionais; raiz ausente **não** falha;
 * - `PropertySystem` (properties) — defaults de fábrica (`editor.ioWorkers`, `render.backend`).
 *
 * **Escolha nossa:** as mutações são **serializadas** por uma fila interna (um único escritor)
 * para que o alvo do `CommandBus` (que a implementação resolve sem argumentos) sempre aponte
 * para o documento certo, mesmo com `insertText` concorrentes. Tudo o que é I/O é assíncrono.
 */
import type {
  Buffer,
  Command,
  Disposable,
  DocumentChangedEvent,
  DocumentHandle,
  DocumentHighlight,
  DocumentInsertResult,
  DocumentRegistry,
  DocumentUndoState,
  Edit,
  EditOrigin,
  GrammarRegistry,
  HighlightLine,
  HighlightSpan,
  MainThreadBusy,
  PropertyDefinition,
  PropertySystem,
  ResourceEntry,
  ResourceLayer,
  ReplaceAllResult,
  Scheduler,
  SearchDocumentResult,
  SearchQuery,
  SearchResult,
  Selection,
  SelectionSet,
  SyntaxGrammar,
  TaskPool,
} from "../../shared";
import {
  CancellationError,
  DEFAULT_RENDER_BACKEND,
  Emitter,
  PROPERTY_IO_WORKERS,
  RENDER_BACKEND_PROPERTY,
  SEARCH_MAX_TEXT_LENGTH,
  SearchInputError,
  SelectionOps,
  SelectionSetOps,
  parseResourceUri,
} from "../../shared";
import { availableParallelism as osAvailableParallelism } from "node:os";

import { DocumentRegistryImpl } from "../buffer";
import type { FileSystem } from "../buffer";
import { CommandBusImpl } from "../command";
import type { UndoTarget } from "../command";
import { SchedulerImpl, TaskPoolImpl } from "../concurrency";
import type { FlushScheduler, SchedulerOptions, TaskPoolOptions } from "../concurrency";
import { PackageResolverImpl } from "../packages";
import type { ResourceScanner } from "../packages";
import { PropertySystemImpl } from "../properties";
import { GrammarRegistryImpl } from "../syntax";
import {
  ExtensionHostImpl,
  createMethodHandlers,
  type HostSession,
  type MethodHandlers,
} from "../extension";
import type { ExtensionHost } from "../../shared";
import type { LspDiagnostic, LspCompletionItem, LspHoverResult, LspLocation, LspSignatureHelp, LspDocumentSymbol } from "../../shared";
import { LspManager } from "../lsp";
import type { Diagnostic, CompletionItem, Hover, Location, SignatureHelp, DocumentSymbol } from "../lsp";

/** Lane `index` (cold-start) — teto por propriedade (DEC-CON-6/9). */
export const PROPERTY_INDEX_WORKERS = "index.indexWorkers";
/** Teto global de workers de fundo (DEC-CON-9). */
export const PROPERTY_MAX_BACKGROUND_THREADS = "concurrency.maxBackgroundThreads";

/** `CommandId` canônico da inserção de texto (contrato de keymap/palette). */
export const INSERT_COMMAND_ID = "buffer.insert";

/** `CommandId` da substituição de uma ocorrência (usado pelo replace-all agrupado). */
export const REPLACE_COMMAND_ID = "search.replace";

/** Erro alto: operação sobre handle que não resolve (DEC-TR-1: guard obrigatório). */
export class InvalidDocumentHandleError extends Error {
  readonly handle: DocumentHandle;

  constructor(handle: DocumentHandle) {
    super(`InvalidDocumentHandleError: handle não resolve para nenhum documento: ${handle}`);
    this.name = "InvalidDocumentHandleError";
    this.handle = handle;
  }
}

/** Erro alto: o núcleo já foi descartado e não aceita mais operações. */
export class EditorCoreDisposedError extends Error {
  constructor(message = "o EditorCore foi descartado") {
    super(`EditorCoreDisposedError: ${message}`);
    this.name = "EditorCoreDisposedError";
  }
}

/** Erro alto de argumento inválido (comando/opção), com `code` estável. */
export class EditorArgumentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`EditorArgumentError[${code}]: ${message}`);
    this.name = "EditorArgumentError";
    this.code = code;
  }
}

/** Opções de composição. Tudo opcional — ausência de I/O deixa o core apenas em memória. */
export interface EditorCoreOptions {
  /** Port de I/O do `DocumentRegistry` (sem ele, `openDocument` lança `FileSystemUnavailableError`). */
  readonly fileSystem?: FileSystem;
  /** `true` só na thread de UI (DEC-CON-1) — default `true`. */
  readonly isUIThread?: boolean;
  /** Relógio injetável do `Scheduler` (determinismo de teste). */
  readonly now?: () => number;
  /** Agenda de flush injetável do `Scheduler` (determinismo de teste). */
  readonly scheduleFlush?: FlushScheduler;
  /** Injeção de CPU para o `TaskPool` (determinismo de teste). */
  readonly availableParallelism?: number;
  /** Teto explícito de workers de fundo (senão, a propriedade/default decide). */
  readonly maxBackgroundThreads?: number;
  /** Tempo ocioso antes de reciclar worker on-demand (default do pool: 1000 ms). */
  readonly idleTimeoutMs?: number;
  /** Raízes de recursos por camada (opcionais — diretório ausente é ignorado). */
  readonly packageRoots?: Partial<Record<ResourceLayer, readonly string[]>>;
  /** Scanner de recursos injetável (teste determinístico sem tocar o disco). */
  readonly packageScanner?: ResourceScanner;
}

/** API mínima e assíncrona que o processo `main` consome. */
export interface EditorCore {
  readonly registry: DocumentRegistry;
  readonly commands: CommandBusImpl;
  readonly scheduler: Scheduler;
  readonly pool: TaskPool;
  readonly packages: PackageResolverImpl;
  readonly properties: PropertySystem;
  /** Registro de gramáticas alimentado pelos recursos `kind:"syntax"` (DEC-PKG-8). */
  readonly grammars: GrammarRegistry;
  /** Resolve quando o índice de pacotes terminar (resolvido se não houve raízes). */
  readonly packagesReady: Promise<void>;
  /** Resolve depois de `packagesReady`, quando as gramáticas `.sublime-syntax` forem registradas. */
  readonly syntaxReady: Promise<void>;
  /** Host de extensões (criado sob demanda por `startPluginHost`). */
  readonly extensionHost: ExtensionHost | undefined;

  openDocument(path: string, signal?: AbortSignal): Promise<DocumentHandle>;
  documentText(handle: DocumentHandle): string;
  /**
   * Insere texto na posição `at` do documento, devolvendo resultado rico
   * (revisão, texto completo, estado de undo/redo) para eliminar roundtrips.
   */
  insertText(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin?: "plugin" | "user",
  ): Promise<DocumentInsertResult>;
  /**
   * Substitui `remove` caracteres a partir de `at` por `insert`.
   * Devolve resultado rico (revisão, texto completo, undo/redo).
   */
  replaceOne(handle: DocumentHandle, at: number, remove: number, insert: string): Promise<DocumentInsertResult>;
  revisionOf(handle: DocumentHandle): number;
  saveDocument(handle: DocumentHandle, signal?: AbortSignal): Promise<void>;
  isDirty(handle: DocumentHandle): boolean;
  /** Gramática resolvida para a extensão do documento; `undefined` se não houver (DEC-PKG-8). */
  grammarForDocument(handle: DocumentHandle): SyntaxGrammar | undefined;
  /** Destaque por linha do range pedido (o renderer consome isto pelo IPC `syntax.highlight`). */
  highlightDocument(handle: DocumentHandle, first: number, count: number): DocumentHighlight;
  /**
   * Busca no documento numa lane de **fundo**: registra o texto no `TaskPool` e executa
   * `TaskPool.run({kind:"search"})` dentro da lane `background` do `Scheduler` (a UI não bloqueia).
   * O custo `O(n)` de materializar o texto é pago **uma vez** por busca.
   */
  searchDocument(
    handle: DocumentHandle,
    query: SearchQuery,
    signal?: AbortSignal,
  ): Promise<SearchDocumentResult>;
  /**
   * Substitui **todas** as ocorrências (literal, sem `$1`). Faz uma busca fresca; **recusa**
   * (`search.tooManyMatches`) quando o resultado foi truncado — substituição parcial silenciosa é
   * proibida. Aplica tudo num **único** `EditScope` ⇒ um só `Ctrl+Z` desfaz o replace-all inteiro.
   */
  replaceAll(
    handle: DocumentHandle,
    query: SearchQuery,
    replacement: string,
    signal?: AbortSignal,
  ): Promise<ReplaceAllResult>;
  /** Desfaz a última transação do documento (delega ao `CommandBus`/`UndoStack`). */
  undoDocument(handle: DocumentHandle): Promise<DocumentUndoState>;
  /** Refaz a última transação desfeita do documento (par simétrico de `undoDocument`). */
  redoDocument(handle: DocumentHandle): Promise<DocumentUndoState>;
  /** Leitura barata do estado de undo/redo (para a status bar), sem mutar nada. */
  undoStateOf(handle: DocumentHandle): DocumentUndoState;
  onDocumentChanged(cb: (event: DocumentChangedEvent) => void): Disposable;
  /** `MainThreadBusy` do scheduler com as lanes do pool (DEC-CON-10). */
  snapshot(): MainThreadBusy;
  /** Lista todos os comandos registrados (para a Command Palette). */
  listCommands(): readonly Command[];
  /** Executa um comando pelo id (lança se desconhecido). */
  executeCommand(id: string): Promise<void>;
  /** Gerente LSP associado (null se não houver). */
  readonly lsp: LspManager | null;
  /** Associa um LspManager ao núcleo. */
  attachLsp(manager: LspManager): void;
  /**
   * Solicita completação LSP para a posição do documento.
   * Retorna lista vazia se não houver servidor para a extensão.
   */
  requestCompletions(
    handle: DocumentHandle,
    line: number,
    col: number,
  ): Promise<readonly LspCompletionItem[]>;
  /**
   * Solicita hover LSP para a posição do documento.
   * Retorna null se não houver servidor para a extensão.
   */
  requestHover(
    handle: DocumentHandle,
    line: number,
    col: number,
  ): Promise<LspHoverResult | null>;
  /**
   * Solicita go-to-definition LSP para a posição do documento.
   * Retorna null se não houver servidor ou definição.
   */
  requestDefinition(
    handle: DocumentHandle,
    line: number,
    col: number,
  ): Promise<LspLocation | null>;
  /**
   * Solicita signature help LSP para a posição do documento.
   * Retorna null se não houver servidor.
   */
  requestSignatureHelp(
    handle: DocumentHandle,
    line: number,
    col: number,
    triggerCharacter?: string,
  ): Promise<LspSignatureHelp | null>;
  /**
   * Lista os símbolos do documento (funções, classes, variáveis) via LSP.
   * Retorna array vazio se não houver servidor.
   */
  requestDocumentSymbols(handle: DocumentHandle): Promise<readonly LspDocumentSymbol[]>;
  /**
   * Diagnósticos LSP atuais do documento (do último `publishDiagnostics`).
   * Vazio se não houver servidor ou nenhum diagnóstico.
   */
  documentDiagnostics(handle: DocumentHandle): readonly LspDiagnostic[];
  /** Localiza o handle de um documento a partir de sua URI (file:// ou path absoluto). */
  findHandleByUri(uri: string): DocumentHandle | undefined;
  dispose(): void;
  /** Inicia o processo de host de plugins (`utilityProcess.fork`). Cria o `ExtensionHost` sob demanda. */
  startPluginHost(
    entry: string,
    opts?: { readonly name?: string; readonly env?: Record<string, string> },
  ): Promise<HostSession>;
}

interface CoreState {
  activeHandle: DocumentHandle | undefined;
  pendingHandle: DocumentHandle | undefined;
  caret: number;
  selection: Selection;
  selections: SelectionSet; // P2#5
}

/** Cache de destaque por documento: linhas, estados de entrada e spans, tudo por revisão. */
interface HighlightCacheEntry {
  revision: number;
  /**
   * Identidade da gramática que produziu os spans (`undefined` = documento sem gramática na hora).
   * Faz parte da **chave** do cache: o `highlightDocument` pode rodar **antes** de `syntaxReady`
   * resolver (grava spans vazios) e, sem isto, a mesma `revision` serviria a entrada vazia para
   * sempre. Com a identidade, a chegada da gramática (ou um re-registro, que recompila) invalida a
   * entrada e o texto é retokenizado.
   */
  grammar: SyntaxGrammar | undefined;
  lines: string[];
  states: unknown[];
  spans: (readonly HighlightSpan[])[];
}

/** Extensão do documento (minúscula, sem ponto) a partir do caminho. */
function extensionOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Nome lógico da gramática no namespace de recursos (o mesmo que `include`/`extends` usam). */
function grammarLogicalName(entry: ResourceEntry): string {
  const { packageName, path } = parseResourceUri(entry.uri);
  return `Packages/${packageName}/${path}`;
}

/**
 * Registra as gramáticas `.sublime-syntax` do índice na ordem do `PackageResolver`. Uma gramática
 * malformada é **logada e ignorada** (degradação explícita — DEC-TR-7), nunca silenciosa; o `.tmlanguage`
 * legado (plist) fica de fora (o adapter da DEC-PKG-12 não é escopo desta fatia).
 */
async function loadGrammars(
  packages: PackageResolverImpl,
  grammars: GrammarRegistryImpl,
): Promise<void> {
  for (const entry of packages.byKind("syntax")) {
    if (!entry.uri.toLowerCase().endsWith(".sublime-syntax")) continue;
    try {
      const bytes = await packages.load(entry.uri);
      grammars.register(grammarLogicalName(entry), new TextDecoder().decode(bytes));
    } catch (error) {
      console.error(`Scribe: gramática ignorada (${entry.uri})`, error);
    }
  }
}

// ── Helpers LSP ──────────────────────────────────────────────────────────────────────────────

function toFileUri(path: string): string {
  return `file://${path.startsWith("/") ? "" : "/"}${path}`;
}

function convertSeverity(severity: number | undefined): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "info";
  }
}

function convertCompletionItem(item: CompletionItem): LspCompletionItem {
  const result: Record<string, unknown> = { label: item.label };
  if (item.kind !== undefined) result.kind = String(item.kind);
  if (item.detail !== undefined) result.detail = item.detail;
  if (item.insertText !== undefined) result.insertText = item.insertText;
  return result as unknown as LspCompletionItem;
}

function convertHover(hover: Hover): LspHoverResult {
  const contents: string[] = [];
  const raw = hover.contents;
  if (typeof raw === "string") {
    contents.push(raw);
  } else if ("language" in raw && "value" in raw) {
    contents.push((raw as { language: string; value: string }).value);
  } else if ("kind" in raw && "value" in raw) {
    contents.push((raw as { kind: string; value: string }).value);
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") contents.push(item);
      else if ("language" in item && "value" in item) contents.push((item as { language: string; value: string }).value);
      else contents.push(String(item));
    }
  }
  return {
    contents,
    ...(hover.range !== undefined
      ? {
          range: {
            startLine: hover.range.start.line,
            startCol: hover.range.start.character,
            endLine: hover.range.end.line,
            endCol: hover.range.end.character,
          } as const,
        }
      : {}),
  } as LspHoverResult;
}

function convertDiagnostic(d: Diagnostic): LspDiagnostic {
  return {
    range: {
      startLine: d.range.start.line,
      startCol: d.range.start.character,
      endLine: d.range.end.line,
      endCol: d.range.end.character,
    },
    severity: convertSeverity(d.severity),
    message: d.message,
    source: d.source ?? "LSP",
  };
}

function convertLocation(loc: Location): LspLocation {
  return {
    uri: loc.uri,
    range: {
      startLine: loc.range.start.line,
      startCol: loc.range.start.character,
      endLine: loc.range.end.line,
      endCol: loc.range.end.character,
    },
  };
}

function convertSignatureHelp(help: SignatureHelp): LspSignatureHelp {
  const activeSig = help.activeSignature;
  const activeParam = help.activeParameter;
  return {
    activeSignature: activeSig,
    activeParameter: activeParam,
    signatures: help.signatures.map((sig) => ({
      label: sig.label,
      ...(typeof sig.documentation === "string"
        ? { documentation: sig.documentation }
        : typeof sig.documentation === "object" && sig.documentation !== null
          ? { documentation: (sig.documentation as { value: string }).value }
          : {}),
      ...(sig.parameters !== undefined
        ? {
            parameters: sig.parameters.map((p) => ({
              label: typeof p.label === "string" ? p.label : "…",
              ...(typeof p.documentation === "string"
                ? { documentation: p.documentation }
                : typeof p.documentation === "object" && p.documentation !== null
                  ? { documentation: (p.documentation as { value: string }).value }
                  : {}),
            })),
          }
        : {}),
    })),
  };
}

/**
 * Achata a árvore de `DocumentSymbol` numa lista plana de `LspDocumentSymbol`, na ordem
 * de profundidade (pre-order). Cada nível é indentado com prefixo `··` no `detail`.
 */
function flattenDocumentSymbols(
  symbols: readonly DocumentSymbol[],
  depth = 0,
): LspDocumentSymbol[] {
  const result: LspDocumentSymbol[] = [];
  for (const sym of symbols) {
    const entry: Record<string, unknown> = {
      name: sym.name,
      kind: sym.kind,
      range: {
        startLine: sym.selectionRange.start.line,
        startCol: sym.selectionRange.start.character,
        endLine: sym.selectionRange.end.line,
        endCol: sym.selectionRange.end.character,
      },
    };
    if (depth > 0) {
      entry.detail = "·".repeat(depth);
    } else if (sym.detail !== undefined) {
      entry.detail = sym.detail;
    }
    result.push(entry as unknown as LspDocumentSymbol);
    if (sym.children !== undefined && sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children, depth + 1));
    }
  }
  return result;
}

interface InsertArgs {
  readonly handle: DocumentHandle;
  readonly at: number;
  readonly text: string;
  readonly remove?: string;
}

function parseInsertArgs(args: unknown): InsertArgs {
  if (typeof args !== "object" || args === null) {
    throw new EditorArgumentError("invalid-args", "buffer.insert espera um objeto de argumentos");
  }
  const record = args as Record<string, unknown>;
  const handle = record["handle"];
  const at = record["at"];
  const text = record["text"];
  const remove = record["remove"];
  if (typeof handle !== "number" || !Number.isInteger(handle)) {
    throw new EditorArgumentError("invalid-args", "buffer.insert: 'handle' deve ser inteiro");
  }
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0) {
    throw new EditorArgumentError("invalid-args", `buffer.insert: 'at' inválido: ${String(at)}`);
  }
  if (typeof text !== "string") {
    throw new EditorArgumentError("invalid-args", "buffer.insert: 'text' deve ser string");
  }
  if (remove !== undefined && typeof remove !== "string") {
    throw new EditorArgumentError("invalid-args", "buffer.insert: 'remove' deve ser string");
  }
  return { handle: handle as DocumentHandle, at, text, ...(remove !== undefined ? { remove } : {}) } as InsertArgs;
}

interface ReplaceArgs {
  readonly handle: DocumentHandle;
  readonly at: number;
  readonly remove: string;
  readonly insert: string;
}

function parseReplaceArgs(args: unknown): ReplaceArgs {
  if (typeof args !== "object" || args === null) {
    throw new EditorArgumentError("invalid-args", "search.replace espera um objeto de argumentos");
  }
  const record = args as Record<string, unknown>;
  const handle = record["handle"];
  const at = record["at"];
  const remove = record["remove"];
  const insert = record["insert"];
  if (typeof handle !== "number" || !Number.isInteger(handle)) {
    throw new EditorArgumentError("invalid-args", "search.replace: 'handle' deve ser inteiro");
  }
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0) {
    throw new EditorArgumentError("invalid-args", `search.replace: 'at' inválido: ${String(at)}`);
  }
  if (typeof remove !== "string" || typeof insert !== "string") {
    throw new EditorArgumentError(
      "invalid-args",
      "search.replace: 'remove'/'insert' devem ser string",
    );
  }
  return { handle: handle as DocumentHandle, at, remove, insert };
}

/**
 * Monta o núcleo do editor. **Síncrono** (a I/O real começa no primeiro `openDocument`); o
 * `main` injeta um `FileSystem` (ex.: `createNodeFileSystem()`).
 */
export function createEditorCore(options: EditorCoreOptions = {}): EditorCore {
  const properties = new PropertySystemImpl();
  const ioWorkersDef: PropertyDefinition<number> = properties.define(PROPERTY_IO_WORKERS, 2);
  const indexWorkersDef: PropertyDefinition<number> = properties.define(PROPERTY_INDEX_WORKERS, 1);
  // Default de fábrica do render (DEC-REN-2/DEC-TR-7): só registra o valor efetivo.
  properties.define(RENDER_BACKEND_PROPERTY, DEFAULT_RENDER_BACKEND);

  const available = options.availableParallelism ?? osAvailableParallelism();
  const capacity = Math.max(1, available - 1);
  const maxThreadsDef: PropertyDefinition<number> = properties.define(
    PROPERTY_MAX_BACKGROUND_THREADS,
    options.maxBackgroundThreads ?? capacity,
  );

  const poolOptions: TaskPoolOptions = {
    ioWorkers: properties.value(ioWorkersDef),
    indexWorkers: properties.value(indexWorkersDef),
    maxBackgroundThreads: properties.value(maxThreadsDef),
    availableParallelism: available,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  };
  const pool = new TaskPoolImpl(poolOptions);

  const schedulerOptions: SchedulerOptions = {
    isUIThread: options.isUIThread ?? true,
    laneProbe: (): Readonly<Record<"io" | "index" | "fileRead", number>> => pool.busy,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.scheduleFlush !== undefined ? { scheduleFlush: options.scheduleFlush } : {}),
  };
  const scheduler = new SchedulerImpl(schedulerOptions);

  const registry = new DocumentRegistryImpl(options.fileSystem);

  const packageOptions =
    options.packageScanner !== undefined ? { scanner: options.packageScanner } : {};
  const packages = new PackageResolverImpl(packageOptions);
  const roots = options.packageRoots;
  const packagesReady: Promise<void> =
    roots !== undefined && Object.keys(roots).length > 0 ? packages.build(roots) : Promise.resolve();

  const grammars = new GrammarRegistryImpl();
  const documentExtensions = new Map<DocumentHandle, string>();
  const highlightCache = new Map<DocumentHandle, HighlightCacheEntry>();
  const syntaxReady: Promise<void> = packagesReady.then(() => loadGrammars(packages, grammars));

  // ── Host de extensões (P3#10) ─────────────────────────────────────────────────────────────
  // ── Host de extensões (P3#10) ─────────────────────────────────────────────────────────────
  let extensionHost: ExtensionHost | undefined;
  /** Sessões ativas do host de plugins (para broadcast de eventos). */
  const hostSessions = new Set<HostSession>();

  /**
   * Notifica todos os hosts de plugin sobre uma mudança de documento.
   * Falha de um host não quebra a main (DEC-TR-5).
   */
  function forwardChangedToHosts(event: DocumentChangedEvent): void {
    for (const session of hostSessions) {
      if (session.state !== "ready") continue;
      try {
        session.bridge.port?.postMessage({
          kind: "emit",
          event: "changed",
          payload: { handle: event.handle, delta: { revision: event.revision } },
        });
      } catch {
        // Ignora falha de notificação para um host — não pode quebrar a main.
      }
    }
  }

  const state: CoreState = { activeHandle: undefined, pendingHandle: undefined, caret: 0, selection: SelectionOps.collapsed(0), selections: SelectionSetOps.singular(0) };
  const emitter = new Emitter<DocumentChangedEvent>();
  const opened = new Set<DocumentHandle>();
  const subscriptions = new Map<DocumentHandle, Disposable>();
  /** Lote em andamento cujas notificações estão sendo agrupadas (ver `coalesceDocumentChanges`). */
  let coalescing: { readonly handle: DocumentHandle; changed: boolean } | undefined;

  // ── LSP ────────────────────────────────────────────────────────────────────────────────────
  let lspManager: LspManager | null = null;
  const diagnosticsCache = new Map<string, readonly Diagnostic[]>();
  const uriToHandle = new Map<string, DocumentHandle>();
  let lspDisposable: Disposable | undefined;

  function resolveTarget(): UndoTarget | undefined {
    const handle = state.pendingHandle ?? state.activeHandle;
    if (handle === undefined) return undefined;
    const buffer = registry.resolve(handle);
    if (buffer === undefined) return undefined;
    return {
      applyEdits(edits: readonly Edit[], origin: EditOrigin): void {
        for (const edit of edits) {
          buffer.apply({ from: edit.at, removed: edit.remove, inserted: edit.insert }, origin);
        }
      },
      caret(): number {
        return state.caret;
      },
      setCaret(n: number): void {
        state.caret = n;
      },
      selection(): Selection {
        return state.selection;
      },
      setSelection(s: Selection): void {
        state.selection = s;
      },
      selections(): readonly Selection[] {
        return state.selections;
      },
      setSelections(sels: readonly Selection[]): void {
        state.selections = sels as SelectionSet;
        state.selection = sels.length > 0 ? sels[0]! : SelectionOps.collapsed(0);
      },
    };
  }

  const commands = new CommandBusImpl({
    registry,
    scheduler,
    target: resolveTarget,
  });
  commands.register(INSERT_COMMAND_ID, "Insert text", (args) => {
    const parsed = parseInsertArgs(args);
    const edits: readonly Edit[] = [{ at: parsed.at, remove: parsed.remove ?? "", insert: parsed.text }];
    return edits;
  });
  // Substituição de uma ocorrência: o handler devolve o delta (o bus aplica — escritor único) e
  // registra a transação, agrupável pelo `EditScope` do replace-all.
  commands.register(REPLACE_COMMAND_ID, "Replace", (args) => {
    const parsed = parseReplaceArgs(args);
    const edits: readonly Edit[] = [{ at: parsed.at, remove: parsed.remove, insert: parsed.insert }];
    return edits;
  });

  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();

  function assertNotDisposed(): void {
    if (disposed) throw new EditorCoreDisposedError();
  }

  function resolveBuffer(handle: DocumentHandle): Buffer {
    const buffer = registry.resolve(handle);
    if (buffer === undefined) throw new InvalidDocumentHandleError(handle);
    return buffer;
  }

  function ensureSubscribed(handle: DocumentHandle): void {
    if (subscriptions.has(handle)) return;
    const buffer = registry.resolve(handle);
    if (buffer === undefined) return;
    const subscription = buffer.onDidChange((event) => {
      if (coalescing !== undefined && coalescing.handle === handle) {
        // Lote em andamento: **não** emite por delta — só o evento final sai (revisão do buffer)
        // quando o escopo fechar. Sem isto, o `replaceAll` publica 1 evento por `buffer.apply` e o
        // renderer refaz o documento **inteiro** a cada um (O(N·n) de IPC).
        coalescing.changed = true;
        return;
      }
      emitter.fire({ handle, revision: event.revision });
      forwardChangedToHosts({ handle, revision: event.revision });
    });
    subscriptions.set(handle, subscription);
  }

  /** Gramática da extensão do documento (resolve o handle antes — DEC-TR-1). */
  function grammarForDocumentOf(handle: DocumentHandle): SyntaxGrammar | undefined {
    resolveBuffer(handle);
    const extension = documentExtensions.get(handle);
    if (extension === undefined || extension.length === 0) return undefined;
    return grammars.forExtension(extension);
  }

  /**
   * Cache de destaque do documento. O estado de entrada de cada linha depende de **todas** as linhas
   * anteriores, então tokenizamos do começo até o fim do range pedido e guardamos por revisão; um
   * novo `revision` descarta o cache. (Limite conhecido: guardamos estados/spans até o range pedido,
   * não o documento inteiro.)
   *
   * A chave é o par (**revisão**, **identidade da gramática**): só a revisão não basta, porque o
   * destaque pode ser pedido antes de as gramáticas carregarem (spans vazios) e esse resultado
   * ficaria preso à mesma revisão. Mesma revisão com gramática diferente (chegou depois, ou foi
   * re-registrada e recompilou) ⇒ entrada nova, texto retokenizado.
   */
  function ensureHighlightCache(
    handle: DocumentHandle,
    revision: number,
    text: string,
    grammar: SyntaxGrammar | undefined,
  ): HighlightCacheEntry {
    const existing = highlightCache.get(handle);

    // Mesma revisão e mesma gramática → cache atual serve.
    if (existing !== undefined && existing.revision === revision && existing.grammar === grammar) {
      return existing;
    }

    // Gramática mudou → não dá pra reaproveitar nada (os spans anteriores são de outro esquema).
    if (existing !== undefined && existing.grammar !== grammar) {
      const entry: HighlightCacheEntry = {
        revision,
        grammar,
        lines: text.split("\n"),
        states: [],
        spans: [],
      };
      highlightCache.set(handle, entry);
      return entry;
    }

    if (existing !== undefined) {
      // Revisão mudou (gramática igual) → diff incremental: descobre a primeira linha diferente
      // e joga fora só o que mudou dali pra frente. O resto do cache é reutilizado.
      const newLines = text.split("\n");
      const oldLines = existing.lines;
      const minLen = Math.min(oldLines.length, newLines.length);
      let firstDiff = -1;

      for (let i = 0; i < minLen; i++) {
        if (oldLines[i] !== newLines[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff < 0 && oldLines.length !== newLines.length) {
        firstDiff = minLen;
      }

      if (firstDiff >= 0) {
        // Só descarta o que ficou obsoleto — linhas não tocadas mantêm estado + spans.
        existing.states.length = firstDiff;
        existing.spans.length = firstDiff;
      }
      // Se firstDiff < 0, o texto é exatamente o mesmo (ex.: undo que reverteu a mudança
      // exata). Mantém tudo, sem invalidar nada. Milagre? Não, bug do undo linear. 😎

      existing.revision = revision;
      existing.lines = newLines;
      return existing;
    }

    // Primeira vez que este handle é visto.
    const entry: HighlightCacheEntry = {
      revision,
      grammar,
      lines: text.split("\n"),
      states: [],
      spans: [],
    };
    highlightCache.set(handle, entry);
    return entry;
  }

  function extendHighlightCache(
    entry: HighlightCacheEntry,
    end: number,
    grammar: SyntaxGrammar | undefined,
  ): void {
    while (entry.states.length < end) {
      const index = entry.states.length;
      const previous = index === 0 ? undefined : entry.states[index - 1];
      const line = entry.lines[index] ?? "";
      if (grammar === undefined) {
        entry.spans[index] = [];
        entry.states.push(undefined);
        continue;
      }
      const tokenized = grammar.tokenizeLine(line, previous);
      entry.spans[index] = tokenized.spans;
      // Estado opaco do tokenizer: para uma linha acima do teto por linha ele volta **neutralizado**
      // (o prefixo cortado não propaga estado parcial — ver `tokenizer.ts`).
      entry.states.push(tokenized.state);
    }
  }

  /** Fila de escrita única: garante que o alvo do bus aponte ao documento certo. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(() => operation());
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Agrupa as notificações `document.changed` de `operation` num **único** evento ao final.
   *
   * O `replaceAll` aplica N deltas (um `buffer.apply` cada) e, sem isto, cada delta publicaria um
   * `document.changed` — e o renderer responde refazendo o documento **inteiro** a cada um: O(N·n)
   * de IPC (medido: 1000 substituições num doc de 10.9 KB ⇒ ~10.9 MB refetchados; no cap default,
   * 2000 ⇒ GB). Aqui as notificações são suprimidas durante o lote e **uma só** sai depois que o
   * `EditScope` commitar. A edição comum (insert/undo/redo) **não** passa por aqui e continua
   * notificando a cada mudança.
   *
   * A revisão do evento final é a **atual do buffer** (não a do último delta registrado): se a
   * operação falhar no meio do escopo, o estado notificado continua coerente com o buffer — nunca
   * um evento perdido com estado defasado.
   */
  async function coalesceDocumentChanges<T>(
    handle: DocumentHandle,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Escopo aninhado (não acontece hoje: o `replaceAll` é serializado): o externo já agrupa.
    if (coalescing !== undefined) return operation();
    const buffer = resolveBuffer(handle);
    coalescing = { handle, changed: false };
    try {
      return await operation();
    } finally {
      const pending = coalescing;
      coalescing = undefined;
      if (pending !== undefined && pending.changed) {
        // Um listener que lança não pode mascarar o erro de `operation()` (o `Emitter.fire` relança
        // dentro do `finally`) nem rejeitar o `replaceAll` com o texto **já** substituído: o lote está
        // commitado, então a falha de notificação é reportada e engolida aqui.
        try {
          emitter.fire({ handle, revision: buffer.revision });
          forwardChangedToHosts({ handle, revision: buffer.revision });
        } catch (error) {
          console.warn("[editor-core] listener de document.changed falhou:", error);
        }
      }
    }
  }

  /**
   * Busca interna: valida o handle (DEC-TR-1), materializa o texto **uma vez** (`O(n)`), registra-o
   * no pool (`generation = revision`) e executa a task `search` **dentro da lane `background`** do
   * `Scheduler` — este é o primeiro uso real da lane de fundo. O texto registrado também é devolvido
   * (o `replaceAll` precisa dele para montar os deltas sem reler).
   */
  async function runSearch(
    handle: DocumentHandle,
    query: SearchQuery,
    signal: AbortSignal | undefined,
  ): Promise<{ revision: number; text: string; result: SearchResult }> {
    const buffer = resolveBuffer(handle);
    const revision = buffer.revision;
    const text = buffer.text();
    // Checagem **aqui** (não só no worker): o teto é do contrato de busca, e descobrir que o texto
    // é grande demais só no worker custaria o clone de ≥64 MiB no `postMessage` + o reenvio a todos
    // os workers. Mesmo erro tipado do `scanText` (DEC-TR-5); o check do worker continua como
    // defesa em profundidade.
    if (text.length > SEARCH_MAX_TEXT_LENGTH) {
      throw new SearchInputError(
        "search.tooLarge",
        `o texto excede o teto de ${SEARCH_MAX_TEXT_LENGTH} code units`,
      );
    }
    pool.registerText(handle, revision, text);
    const result = await scheduler.post(
      "background",
      () =>
        pool.run(
          { kind: "search", doc: handle, generation: revision, query },
          signal !== undefined ? { lane: "index", signal } : { lane: "index" },
        ).done,
      { handle },
    );
    return { revision, text, result };
  }

  async function runInsert(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin: "plugin" | "user",
  ): Promise<DocumentInsertResult> {
    assertNotDisposed();
    const buffer = resolveBuffer(handle);
    state.pendingHandle = handle;
    let actualAt = at;
    let removeText: string | undefined;
    try {
      if (state.selections.length > 1) {
        // Multi-cursor: aplica inserção em cada seleção, da última para a primeira (preserva offsets)
        const sels = [...state.selections].sort((a, b) => b.active - a.active);
        for (const sel of sels) {
          const { start, end } = SelectionOps.normalized(sel);
          const rText = start < end ? buffer.text().slice(start, end) : undefined;
          const cmdArgs: Record<string, unknown> = { handle, at: start, text };
          if (rText !== undefined) cmdArgs["remove"] = rText;
          const result = await commands.run(
            INSERT_COMMAND_ID,
            cmdArgs,
            { origin, group: `type:${handle}` },
          );
          if (!result.handled) {
            throw new EditorArgumentError(
              "command-missing",
              `comando não registrado: ${INSERT_COMMAND_ID}`,
            );
          }
        }
      } else {
        // Seleção única ou sem cursor: usa o comportamento original (backward compat)
        if (state.selections.length === 1 && !SelectionOps.isCollapsed(state.selections[0]!)) {
          const { start, end } = SelectionOps.normalized(state.selections[0]!);
          actualAt = start;
          removeText = buffer.text().slice(start, end);
        }
        const result = await commands.run(
          INSERT_COMMAND_ID,
          { handle, at: actualAt, text, ...(removeText !== undefined ? { remove: removeText } : {}) },
          { origin, group: `type:${handle}` },
        );
        if (!result.handled) {
          throw new EditorArgumentError(
            "command-missing",
            `comando não registrado: ${INSERT_COMMAND_ID}`,
          );
        }
      }
    } finally {
      state.pendingHandle = undefined;
    }
    state.activeHandle = handle;
    // Atualiza caret e selections APÓS a inserção
    if (state.selections.length > 1) {
      const lastSel = state.selections[state.selections.length - 1]!;
      state.caret = lastSel.active;
      state.selection = SelectionOps.collapsed(lastSel.active);
      state.selections = SelectionSetOps.singular(lastSel.active);
    } else {
      state.caret = actualAt + text.length;
      state.selection = SelectionOps.collapsed(state.caret);
      state.selections = SelectionSetOps.singular(state.caret);
    }
    // BLOCKER-1 (P2.5 review): toda edição de usuário suja o documento.
    registry.setDirty(handle, true);
    // Notifica LSP sobre a mudança
    if (lspManager !== null) {
      const state = registry.get(handle);
      if (state !== undefined) {
        const uri = toFileUri(state.uri);
        lspManager.changeDocument(uri, buffer.text(), buffer.revision);
      }
    }
    return {
      revision: buffer.revision,
      text: buffer.text(),
      canUndo: commands.undoStack.undoDepth > 0,
      canRedo: commands.undoStack.redoDepth > 0,
    };
  }

  /**
   * Substitui `remove` caracteres a partir de `at` por `insert` no documento.
   * Extrai o texto removido do buffer e usa o mesmo comando `INSERT_COMMAND_ID`
   * com a opção `remove` para que a substituição seja registrada como uma única
   * transação de undo.
   */
  async function runReplaceOne(
    handle: DocumentHandle,
    at: number,
    remove: number,
    insert: string,
  ): Promise<DocumentInsertResult> {
    assertNotDisposed();
    const buffer = resolveBuffer(handle);
    state.pendingHandle = handle;
    const removeText = buffer.text().slice(at, at + remove);
    const result = await commands.run(
      INSERT_COMMAND_ID,
      { handle, at, text: insert, remove: removeText },
      { origin: "user", group: `type:${handle}` },
    );
    if (!result.handled) {
      throw new EditorArgumentError(
        "command-missing",
        `comando não registrado: ${INSERT_COMMAND_ID}`,
      );
    }
    state.caret = at + insert.length;
    state.selection = SelectionOps.collapsed(state.caret);
    state.selections = SelectionSetOps.singular(state.caret);
    registry.setDirty(handle, true);
    // Notifica LSP sobre a substituição
    if (lspManager !== null) {
      const st = registry.get(handle);
      if (st !== undefined) {
        const uri = toFileUri(st.uri);
        lspManager.changeDocument(uri, buffer.text(), buffer.revision);
      }
    }
    return {
      revision: buffer.revision,
      text: buffer.text(),
      canUndo: commands.undoStack.undoDepth > 0,
      canRedo: commands.undoStack.redoDepth > 0,
    };
  }

  /**
   * Estado de undo/redo do documento + cursor. A pilha (`UndoStack`) é do `CommandBus`; aqui só
   * lemos as profundidades (não inventamos API que o núcleo não suporta).
   */
  function undoStateOf(handle: DocumentHandle): DocumentUndoState {
    const buffer = resolveBuffer(handle);
    const stack = commands.undoStack;
    return {
      canUndo: stack.undoDepth > 0,
      canRedo: stack.redoDepth > 0,
      revision: buffer.revision,
      caret: state.caret,
      selection: state.selection,
      selections: state.selections,
    };
  }

  /**
   * Desfaz/refaz dentro do escopo do documento (espelha `runInsert`): fixa o `pendingHandle` para
   * que o alvo do `CommandBus` aponte ao documento certo, aplica o inverso pelo `UndoStack` e
   * devolve o estado observável. Serializado na mesma fila de escrita dos inserts.
   */
  async function runHistory(
    handle: DocumentHandle,
    action: "undo" | "redo",
  ): Promise<DocumentUndoState> {
    assertNotDisposed();
    resolveBuffer(handle);
    return enqueue(() => {
      state.pendingHandle = handle;
      try {
        if (action === "undo") commands.undo();
        else commands.redo();
      } finally {
        state.pendingHandle = undefined;
      }
      state.activeHandle = handle;
      // Blocker-1/P2.5: undo/redo também suja ou limpa o documento.
      // Compara a revisão atual com a salva — se undo voltou ao texto original, limpa.
      const buf = resolveBuffer(handle);
      const savedRev = registry.get(handle)?.savedRevision ?? 0;
      registry.setDirty(handle, buf.revision !== savedRev);
      // Notifica LSP sobre a mudança de undo/redo
      if (lspManager !== null) {
        const st = registry.get(handle);
        if (st !== undefined) {
          const uri = toFileUri(st.uri);
          lspManager.changeDocument(uri, buf.text(), buf.revision);
        }
      }
      return Promise.resolve(undoStateOf(handle));
    });
  }

  return {
    registry,
    commands,
    scheduler,
    pool,
    packages,
    properties,
    grammars,
    packagesReady,
    syntaxReady,

    async openDocument(path: string, signal?: AbortSignal): Promise<DocumentHandle> {
      assertNotDisposed();
      if (signal?.aborted) {
        throw new CancellationError(`abertura de "${path}" cancelada antes de começar`);
      }
      const handle = await registry.open(path);
      if (signal?.aborted) {
        // Cancelou durante o I/O: não registra a abertura e libera o documento recém-criado.
        if (!opened.has(handle)) registry.dispose(handle);
        throw new CancellationError(`abertura de "${path}" cancelada`);
      }
      opened.add(handle);
      documentExtensions.set(handle, extensionOfPath(path));
      ensureSubscribed(handle);
      state.activeHandle = handle;

      // Notifica LSP sobre a abertura do documento
      if (lspManager !== null) {
        const uri = toFileUri(path);
        uriToHandle.set(path, handle);
        const buffer = registry.resolve(handle);
        if (buffer !== undefined) {
          const ext = extensionOfPath(path);
          const languageId = ext.length > 0 ? ext : "plaintext";
          lspManager.openDocument(uri, languageId, buffer.text(), buffer.revision);
        }
      }

      return handle;
    },

    documentText(handle: DocumentHandle): string {
      return resolveBuffer(handle).text();
    },

    insertText(
      handle: DocumentHandle,
      at: number,
      text: string,
      origin: "plugin" | "user" = "user",
    ): Promise<DocumentInsertResult> {
      return enqueue(() => runInsert(handle, at, text, origin));
    },

    replaceOne(
      handle: DocumentHandle,
      at: number,
      remove: number,
      insert: string,
    ): Promise<DocumentInsertResult> {
      return enqueue(() => runReplaceOne(handle, at, remove, insert));
    },

    revisionOf(handle: DocumentHandle): number {
      return resolveBuffer(handle).revision;
    },

    isDirty(handle: DocumentHandle): boolean {
      const state = registry.get(handle);
      if (state === undefined) throw new InvalidDocumentHandleError(handle);
      return state.dirty;
    },

    grammarForDocument(handle: DocumentHandle): SyntaxGrammar | undefined {
      return grammarForDocumentOf(handle);
    },

    highlightDocument(handle: DocumentHandle, first: number, count: number): DocumentHighlight {
      const buffer = resolveBuffer(handle);
      const start = Math.max(0, Math.trunc(first));
      const take = Math.max(0, Math.trunc(count));
      const revision = buffer.revision;
      const grammar = grammarForDocumentOf(handle);
      const entry = ensureHighlightCache(handle, revision, buffer.text(), grammar);
      // Custo O(`end - firstInvalidated`): antes, toda revisão tokenizava da linha 0 (`states`
      // era sempre vazio). Agora o cache é **incremental**: `ensureHighlightCache` descobre a
      // primeira linha que mudou (diff) e só descarta estados dali pra frente. Se a edição foi
      // na linha 30 e o range visível é 0..50, só 20 linhas são re-tokenizadas em vez de 51.
      // O teto do tokenizer é **por linha** (MAX_TOKENIZE_LINE_LENGTH), não por documento —
      // e o diff é barato por ser comparação de strings planas, não tokenização.
      const end = Math.min(entry.lines.length, start + take);
      extendHighlightCache(entry, end, grammar);
      const lines: HighlightLine[] = [];
      for (let line = start; line < end; line++) {
        lines.push({ line, spans: entry.spans[line] ?? [] });
      }
      return { revision, first: start, lines };
    },

    async searchDocument(
      handle: DocumentHandle,
      query: SearchQuery,
      signal?: AbortSignal,
    ): Promise<SearchDocumentResult> {
      assertNotDisposed();
      const { revision, result } = await runSearch(handle, query, signal);
      return { revision, result };
    },

    replaceAll(
      handle: DocumentHandle,
      query: SearchQuery,
      replacement: string,
      signal?: AbortSignal,
    ): Promise<ReplaceAllResult> {
      assertNotDisposed();
      // Serializa com os outros escritores: a busca e as edições acontecem "de uma vez".
      // O lote inteiro roda sob `coalesceDocumentChanges`: **um** `document.changed` no fim.
      return enqueue(() =>
        coalesceDocumentChanges(handle, async () => {
          const { text, result } = await runSearch(handle, query, signal);
          if (result.truncated) {
            // Substituição parcial e silenciosa é proibida: recusa com erro tipado (DEC-TR-5).
            throw new SearchInputError(
              "search.tooManyMatches",
              `replace-all recusado: a busca foi truncada em ${result.matches.length} de ≥${result.matches.length + 1} ocorrências`,
            );
          }
          const buffer = resolveBuffer(handle);
          if (result.matches.length === 0) {
            // No-op: nenhuma edição ⇒ nenhuma entrada de undo (transação vazia é descartada).
            return { replaced: 0, revision: buffer.revision };
          }
          // Deltas em ordem **crescente**, cada `at` já ajustado pelo deslocamento acumulado: cada
          // `at` é válido no estado em que a edição é aplicada (é a sequência em que a pilha
          // reaplica). A ordem **reversa** também restaura o texto correto — cada `at` é válido no
          // texto *original* e o inverso do `UndoStack` é a sequência espelhada; a alegação de que
          // ela quebraria quando `replacement.length ≠ match.length` não se sustenta. Crescente é a
          // ordem que está aqui, testada e mantida.
          const edits: Edit[] = [];
          let delta = 0;
          for (const match of result.matches) {
            const at = match.index + delta;
            const remove = text.slice(match.index, match.index + match.length);
            edits.push({ at, remove, insert: replacement });
            delta += replacement.length - match.length;
          }

          // **Um** `EditScope` ⇒ todos os `run` compartilham o grupo `scope:<id>` e o `UndoStack`
          // funde as transações num único passo: um `Ctrl+Z` desfaz o replace-all inteiro.
          const scope = commands.openEditScope(`replace-all:${handle}`);
          state.pendingHandle = handle;
          try {
            for (const edit of edits) {
              await commands.run(
                REPLACE_COMMAND_ID,
                { handle, at: edit.at, remove: edit.remove, insert: edit.insert },
                { origin: "user" },
              );
            }
          } finally {
            scope.dispose();
            state.pendingHandle = undefined;
          }
          state.activeHandle = handle;
          state.caret = Math.min(state.caret, buffer.text().length);
          state.selection = SelectionOps.collapsed(state.caret);
          // Blocker-1 (P2.5 review): replaceAll também suja o documento.
          registry.setDirty(handle, true);
          // Notifica LSP após todas as substituições
          if (lspManager !== null) {
            const st = registry.get(handle);
            if (st !== undefined) {
              const uri = toFileUri(st.uri);
              lspManager.changeDocument(uri, buffer.text(), buffer.revision);
            }
          }
          return { replaced: edits.length, revision: buffer.revision };
        }),
      );
    },

    async saveDocument(handle: DocumentHandle, signal?: AbortSignal): Promise<void> {
      assertNotDisposed();
      // Risco-3 (P2.5 review): não escreve se o documento não está sujo.
      if (!this.isDirty(handle)) return;
      return enqueue(async () => {
        const buffer = resolveBuffer(handle);
        const state = this.registry.get(handle);
        if (state === undefined) throw new InvalidDocumentHandleError(handle);

        if (signal?.aborted) return;

        const text = buffer.text();
        const encoded = new TextEncoder().encode(text).buffer as ArrayBuffer;

        await pool.run(
          { kind: "writeFile" as const, path: state.uri, data: encoded },
          signal !== undefined ? { lane: "io" as const, signal } : { lane: "io" as const },
        ).done;

        // Marca como não sujo
        const reg = this.registry as DocumentRegistryImpl;
        reg.setDirty(handle, false);
        reg.setSavedRevision(handle, buffer.revision);
      });
    },

    undoDocument(handle: DocumentHandle): Promise<DocumentUndoState> {
      return runHistory(handle, "undo");
    },

    redoDocument(handle: DocumentHandle): Promise<DocumentUndoState> {
      return runHistory(handle, "redo");
    },

    undoStateOf(handle: DocumentHandle): DocumentUndoState {
      return undoStateOf(handle);
    },

    onDocumentChanged(cb: (event: DocumentChangedEvent) => void): Disposable {
      return emitter.event(cb);
    },

    snapshot(): MainThreadBusy {
      const busy = scheduler.snapshot();
      return {
        busyMs: busy.busyMs,
        pendingCallbacks: busy.pendingCallbacks,
        lanes: pool.busy,
      };
    },

    get extensionHost(): ExtensionHost | undefined {
      return extensionHost;
    },

    async startPluginHost(
      entry: string,
      opts?: { readonly name?: string; readonly env?: Record<string, string> },
    ): Promise<HostSession> {
      if (extensionHost === undefined) {
        const handlers = createMethodHandlers({ commands, documents: registry, packages });
        extensionHost = new ExtensionHostImpl({
          handlers: handlers as Partial<MethodHandlers<unknown>>,
        });
      }
      const session = await extensionHost.spawn({
        name: opts?.name ?? "plugin",
        entry,
        ...(opts?.env !== undefined ? { env: opts.env } : {}),
      });
      hostSessions.add(session);
      // Quando o host sair, remove da lista de broadcasts
      session.exited
        .then(() => hostSessions.delete(session))
        .catch(() => hostSessions.delete(session));
      return session;
    },

    listCommands(): readonly Command[] {
      return [
        { id: "file.open",      label: "Abrir arquivo",      category: "File", accelerator: "Ctrl+O" },
        { id: "file.save",      label: "Salvar",              category: "File", accelerator: "Ctrl+S" },
        { id: "edit.undo",      label: "Desfazer",            category: "Edit", accelerator: "Ctrl+Z" },
        { id: "edit.redo",      label: "Refazer",             category: "Edit", accelerator: "Ctrl+Shift+Z" },
        { id: "edit.cut",       label: "Recortar",            category: "Edit", accelerator: "Ctrl+X" },
        { id: "edit.copy",      label: "Copiar",              category: "Edit", accelerator: "Ctrl+C" },
        { id: "edit.paste",     label: "Colar",               category: "Edit", accelerator: "Ctrl+V" },
        { id: "edit.selectAll", label: "Selecionar tudo",     category: "Edit", accelerator: "Ctrl+A" },
        { id: "find.open",      label: "Buscar",              category: "Find", accelerator: "Ctrl+F" },
        { id: "view.toggleTheme", label: "Alternar tema",     category: "View", accelerator: "Ctrl+Shift+T" },
      ];
    },

    async executeCommand(id: string): Promise<void> {
      switch (id) {
        case "file.open":
          // Aberto no dispatchIpc com deps.dialog; aqui sem dialog não tem o que fazer.
          throw new EditorArgumentError("no-dialog", "file.open requer diálogo injetado");
        case "file.save": {
          if (state.activeHandle === undefined) return;
          await this.saveDocument(state.activeHandle);
          break;
        }
        case "edit.undo": {
          if (state.activeHandle === undefined) return;
          await this.undoDocument(state.activeHandle);
          break;
        }
        case "edit.redo": {
          if (state.activeHandle === undefined) return;
          await this.redoDocument(state.activeHandle);
          break;
        }
        default:
          throw new EditorArgumentError("unknown-command", `comando desconhecido: ${id}`);
      }
    },

    get lsp(): LspManager | null {
      return lspManager;
    },

    attachLsp(manager: LspManager): void {
      if (lspDisposable !== undefined) {
        lspDisposable.dispose();
        lspDisposable = undefined;
      }
      lspManager = manager;
      diagnosticsCache.clear();
      uriToHandle.clear();
      lspDisposable = manager.onDiagnostics((params) => {
        diagnosticsCache.set(params.uri, [...params.diagnostics]);
        // Broadcast via IPC acontece no main, não aqui.
      });

      // Reabre todos os documentos já abertos no novo manager
      for (const handle of opened) {
        const path = registry.get(handle)?.uri;
        if (path === undefined) continue;
        const uri = toFileUri(path);
        uriToHandle.set(path, handle);
        const buffer = registry.resolve(handle);
        if (buffer === undefined) continue;
        const ext = documentExtensions.get(handle) ?? "";
        const languageId = ext.length > 0 ? ext : "plaintext";
        manager.openDocument(uri, languageId, buffer.text(), buffer.revision);
      }
    },

    async requestCompletions(
      handle: DocumentHandle,
      line: number,
      col: number,
    ): Promise<readonly LspCompletionItem[]> {
      if (lspManager === null) return [];
      const path = registry.get(handle)?.uri;
      if (path === undefined) return [];
      const uri = toFileUri(path);
      const items = await lspManager.requestCompletion(uri, line, col);
      return items.map(convertCompletionItem);
    },

    async requestHover(
      handle: DocumentHandle,
      line: number,
      col: number,
    ): Promise<LspHoverResult | null> {
      if (lspManager === null) return null;
      const path = registry.get(handle)?.uri;
      if (path === undefined) return null;
      const uri = toFileUri(path);
      const hover = await lspManager.requestHover(uri, line, col);
      if (hover === null) return null;
      return convertHover(hover);
    },

    async requestDefinition(
      handle: DocumentHandle,
      line: number,
      col: number,
    ): Promise<LspLocation | null> {
      if (lspManager === null) return null;
      const path = registry.get(handle)?.uri;
      if (path === undefined) return null;
      const uri = toFileUri(path);
      const loc = await lspManager.requestDefinition(uri, line, col);
      if (loc === null) return null;
      return convertLocation(loc);
    },

    async requestSignatureHelp(
      handle: DocumentHandle,
      line: number,
      col: number,
      triggerCharacter?: string,
    ): Promise<LspSignatureHelp | null> {
      if (lspManager === null) return null;
      const path = registry.get(handle)?.uri;
      if (path === undefined) return null;
      const uri = toFileUri(path);
      const help = await lspManager.requestSignatureHelp(uri, line, col, triggerCharacter);
      if (help === null) return null;
      return convertSignatureHelp(help);
    },

    async requestDocumentSymbols(handle: DocumentHandle): Promise<readonly LspDocumentSymbol[]> {
      if (lspManager === null) return [];
      const path = registry.get(handle)?.uri;
      if (path === undefined) return [];
      const uri = toFileUri(path);
      const symbols = await lspManager.requestDocumentSymbols(uri);
      return flattenDocumentSymbols(symbols);
    },

    documentDiagnostics(handle: DocumentHandle): readonly LspDiagnostic[] {
      const path = registry.get(handle)?.uri;
      if (path === undefined || lspManager === null) return [];
      const uri = toFileUri(path);
      const diagnostics = diagnosticsCache.get(uri);
      if (diagnostics === undefined) return [];
      return diagnostics.map(convertDiagnostic);
    },

    findHandleByUri(uri: string): DocumentHandle | undefined {
      const path = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
      // Remove trailing null byte if present (LSP servers sometimes append it)
      const clean = path.replace(/\0+$/, "");
      const handle = uriToHandle.get(clean);
      if (handle !== undefined && registry.isValid(handle)) return handle;
      // Fallback: percorre documentos abertos
      for (const h of opened) {
        const state = registry.get(h);
        if (state !== undefined && state.uri === clean) return h;
      }
      return undefined;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      lspDisposable?.dispose();
      lspDisposable = undefined;
      void lspManager?.disconnectAll().catch(() => {});
      lspManager = null;
      diagnosticsCache.clear();
      uriToHandle.clear();
      void extensionHost?.shutdown().catch(() => {});
      for (const subscription of subscriptions.values()) subscription.dispose();
      subscriptions.clear();
      for (const handle of opened) registry.dispose(handle);
      opened.clear();
      emitter.dispose();
      scheduler.dispose();
      properties.dispose();
      packages.dispose();
      grammars.dispose();
      documentExtensions.clear();
      highlightCache.clear();
      void pool.shutdown().catch((error: unknown) => {
        console.error("Scribe: falha ao encerrar o TaskPool", error);
      });
      state.activeHandle = undefined;
      state.pendingHandle = undefined;
    },
  };
}
