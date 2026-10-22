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
  GrepResult,
  GrepTaskOptions,
  HighlightLine,
  HighlightSpan,
  MainThreadBusy,
  PoolLane,
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
  SerializedGrammar,
  SyntaxGrammar,
  TaskPool,
} from "../../shared";
import {
  CancellationError,
  DEFAULT_RENDER_BACKEND,
  Emitter,
  GREP_TASK_TIMEOUT_MS,
  PROPERTY_IO_WORKERS,
  RENDER_BACKEND_PROPERTY,
  SEARCH_MAX_TEXT_LENGTH,
  SearchInputError,
  SelectionOps,
  SelectionSetOps,
  TaskPreemptedError,
  TaskTimeoutError,
  advanceSelections,
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
import type { CompiledPattern } from "../syntax";
import {
  ExtensionHostImpl,
  createMethodHandlers,
  type HostSession,
  type MethodHandlers,
} from "../extension";
import type { ExtensionHost } from "../../shared";
import type { LspDiagnostic, LspCompletionItem, LspHoverResult, LspLocation, LspSignatureHelp, LspDocumentSymbol, LspRenameResult, LspCodeAction, LspTextEdit, LspFoldingRange, LspInlayHint } from "../../shared";
import { LspManager } from "../lsp";
import type { Diagnostic, CompletionItem, Hover, Location, SignatureHelp, DocumentSymbol, DocumentSymbolLike, Range, TextEdit, FoldingRange, InlayHint } from "../lsp";

/** Lane `index` (cold-start) — teto por propriedade (DEC-CON-6/9). */
export const PROPERTY_INDEX_WORKERS = "index.indexWorkers";
/** Teto global de workers de fundo (DEC-CON-9). */
export const PROPERTY_MAX_BACKGROUND_THREADS = "concurrency.maxBackgroundThreads";

/**
 * Teto de linhas tokenizadas **síncronas** no main thread.
 * Abaixo deste limiar, a tokenização roda inline (evita overhead de IPC no worker).
 * Acima, a task `syntaxTokens` é delegada ao TaskPool com deadline (P2.4b).
 * Valor de 50 = ~50 linhas de código comum, baratas de tokenizar.
 */
const SYNC_SYNTAX_THRESHOLD = 50;

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

/**
 * Parâmetros da **busca na workspace** (o "grep").
 *
 * ⚠️ A busca **não** roda no processo principal: ela vira a task `grep` da lane `grep` do
 * `TaskPool` (o `main` não materializa mais o conteúdo de nenhum arquivo — a leitura é feita
 * **dentro do worker**, `src/core/workspace/grep-fs.ts`).
 */
export interface GrepFilesParams {
  /** O padrão cru (o que o usuário digitou). */
  readonly query: string;
  /** Os arquivos candidatos (caminhos absolutos). */
  readonly files: readonly string[];
  /** As opções (todas opcionais — o core/worker aplica os defaults). */
  readonly options?: GrepTaskOptions;
  /** Cancela a busca (o `AbortSignal` do IPC). */
  readonly signal?: AbortSignal;
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
  /**
   * Fecha o documento: salva se estiver sujo, avisa o servidor LSP (`textDocument/didClose`)
   * e descarta o buffer.
   *
   * Sem o `didClose`, o servidor LSP continua com o documento aberto — memória e
   * diagnósticos obsoletos acumulam por arquivo aberto.
   */
  closeDocument(handle: DocumentHandle): Promise<void>;
  documentText(handle: DocumentHandle): string;
  /**
   * Insere texto na posição `at` do documento, devolvendo resultado rico
   * (revisão, texto completo, estado de undo/redo) para eliminar roundtrips.
   *
   * `selections` é o conjunto de cursores **antes** da edição (multi-cursor, P2#5) — é o
   * contexto que o undo restaura. Opcional (cliente antigo continua funcionando).
   */
  insertText(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin?: "plugin" | "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  /**
   * Substitui `remove` caracteres a partir de `at` por `insert`.
   * Devolve resultado rico (revisão, texto completo, undo/redo).
   *
   * `selections` é o conjunto de cursores **antes** da edição (o que o undo restaura).
   */
  replaceOne(
    handle: DocumentHandle,
    at: number,
    remove: number,
    insert: string,
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  /**
   * Lote de inserções atômicas: aplica cada `{at, text, remove?}` em sequência, como
   * uma única transação de undo. Retorna o resultado consolidado.
   *
   * O `at` de cada entrada é absoluto **no estado do buffer após as entradas anteriores** ⇒ um
   * lote multi-cursor deve entrar em ordem **descendente**.
   * `selections` é o conjunto de cursores **antes** do lote (o que o undo restaura).
   */
  batchInsert(
    handle: DocumentHandle,
    inserts: ReadonlyArray<{
      readonly at: number;
      readonly text: string;
      readonly remove?: string;
    }>,
    origin?: "plugin" | "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  revisionOf(handle: DocumentHandle): number;
  saveDocument(handle: DocumentHandle, signal?: AbortSignal): Promise<void>;
  isDirty(handle: DocumentHandle): boolean;
  /** Gramática resolvida para a extensão do documento; `undefined` se não houver (DEC-PKG-8). */
  grammarForDocument(handle: DocumentHandle): SyntaxGrammar | undefined;
  /** Destaque por linha do range pedido (o renderer consome isto pelo IPC `syntax.highlight`). */
  highlightDocument(handle: DocumentHandle, first: number, count: number): Promise<DocumentHighlight>;
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
   * Busca na **workspace** (o "grep") — roda **no worker** (task `grep`, lane `grep`).
   *
   * O processo principal **não** lê nenhum arquivo: a leitura e a varredura acontecem no
   * worker (`nodeGrepReadFile`), então um `RegExp` patológico **não** trava a janela/IPC/LSP.
   *
   * ⚠️ **Teto duro:** se o worker estourar o teto (`TaskTimeoutError` — o pool o **matou**),
   * o núcleo devolve um `GrepResult` **incompleto** (`truncated: true` + aviso) em vez de
   * estourar o erro cru para a UI. O cancelamento (`CancellationError`) **propaga**.
   *
   * ⚠️ **Preempção:** a busca é de **fundo** — se o realce/salvar precisar do worker, o
   * núcleo devolve um `GrepResult` **incompleto** com um aviso de "interrompida por outra
   * operação" (o `TaskPreemptedError` **não** vaza para a UI).
   */
  grepFiles(params: GrepFilesParams): Promise<GrepResult>;
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
   * Renomeia um símbolo via LSP (F2). Retorna null se não houver servidor ou
   * se o símbolo não der suporte a rename.
   */
  requestRename(
    handle: DocumentHandle,
    line: number,
    col: number,
    newName: string,
  ): Promise<LspRenameResult | null>;
  /**
   * Solicita referências (find references) via LSP para a posição do documento.
   * Retorna array vazio se não houver servidor para a extensão.
   */
  requestReferences(
    handle: DocumentHandle,
    line: number,
    col: number,
  ): Promise<readonly LspLocation[]>;
  /**
   * Solicita code actions (Ctrl+.) via LSP para a posição do documento.
   * Retorna array vazio se não houver servidor para a extensão.
   */
  requestCodeActions(
    handle: DocumentHandle,
    line: number,
    col: number,
  ): Promise<readonly LspCodeAction[]>;
  /**
   * Solicita formatação do documento inteiro via LSP (textDocument/formatting).
   * Retorna array vazio se não houver servidor para a extensão.
   */
  requestFormatting(
    handle: DocumentHandle,
    options?: { readonly tabSize?: number; readonly insertSpaces?: boolean },
  ): Promise<readonly LspTextEdit[]>;
  /**
   * Solicita folding ranges do documento via LSP (textDocument/foldingRange).
   * Retorna array vazio se não houver servidor para a extensão.
   */
  requestFoldingRange(handle: DocumentHandle): Promise<readonly LspFoldingRange[]>;
  /**
   * Solicita inlay hints do documento via LSP (textDocument/inlayHint).
   * Retorna array vazio se não houver servidor para a extensão.
   */
  requestInlayHints(
    handle: DocumentHandle,
    startLine?: number,
    endLine?: number,
  ): Promise<readonly LspInlayHint[]>;
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
  /** Offset de início de cada linha no texto completo (para extrair `text.slice()` no worker). */
  lineStarts: number[];
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
 * Achata a árvore de símbolos do documento numa lista plana de `LspDocumentSymbol`, na
 * ordem de profundidade (pre-order). Cada nível é indentado com prefixo `··` no `detail`.
 *
 * Aceita as **duas** formas do protocolo:
 * - hierárquica (`DocumentSymbol`): o range do nome está em `selectionRange`;
 * - plana (`SymbolInformation`): o range está em `location.range` (é o que o servidor
 *   devolve quando o cliente não pede `hierarchicalDocumentSymbolSupport`).
 *
 * Símbolo **sem range** (payload incompleto) é **pulado** (1 warn) — nunca estouramos:
 * o popup de Document Symbols não pode quebrar por causa do servidor.
 */
function flattenDocumentSymbols(
  symbols: readonly DocumentSymbolLike[],
  depth = 0,
): LspDocumentSymbol[] {
  const result: LspDocumentSymbol[] = [];
  let skipped = 0;
  for (const sym of symbols) {
    const range = symbolRangeOf(sym);
    if (range === undefined) {
      skipped += 1;
      continue;
    }
    const entry: LspDocumentSymbol = {
      name: sym.name,
      kind: sym.kind,
      range: {
        startLine: range.start.line,
        startCol: range.start.character,
        endLine: range.end.line,
        endCol: range.end.character,
      },
      ...(depth > 0
        ? { detail: "·".repeat(depth) }
        : sym.detail !== undefined
          ? { detail: sym.detail }
          : {}),
    };
    result.push(entry);
    if (isHierarchicalSymbol(sym) && sym.children !== undefined && sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children, depth + 1));
    }
  }
  if (skipped > 0) {
    console.warn(`[lsp] ${skipped} símbolo(s) sem range ignorado(s) em documentSymbols`);
  }
  return result;
}

/**
 * Range do símbolo, qualquer que seja a forma do servidor.
 * `undefined` = o símbolo não tem range utilizável (é pulado).
 */
function symbolRangeOf(sym: DocumentSymbolLike): Range | undefined {
  if (isHierarchicalSymbol(sym)) {
    return sym.selectionRange ?? sym.range;
  }
  return sym.location?.range;
}

/** Guard: o símbolo é da forma hierárquica (`DocumentSymbol`). */
function isHierarchicalSymbol(sym: DocumentSymbolLike): sym is DocumentSymbol {
  return !("location" in sym);
}

function convertTextEdit(edit: TextEdit): LspTextEdit {
  return {
    range: {
      start: { line: edit.range.start.line, character: edit.range.start.character },
      end: { line: edit.range.end.line, character: edit.range.end.character },
    },
    newText: edit.newText,
  };
}

function convertFoldingRange(range: FoldingRange): LspFoldingRange {
  return {
    startLine: range.startLine,
    endLine: range.endLine,
    ...(range.kind !== undefined ? { kind: range.kind } : {}),
  };
}

function convertInlayHint(hint: InlayHint): LspInlayHint {
  return {
    position: { line: hint.position.line, character: hint.position.character },
    label: typeof hint.label === "string" ? hint.label : hint.label.map((p) => p.value).join(""),
    ...(hint.kind !== undefined ? { kind: hint.kind } : {}),
    ...(hint.paddingLeft !== undefined ? { paddingLeft: hint.paddingLeft } : {}),
    ...(hint.paddingRight !== undefined ? { paddingRight: hint.paddingRight } : {}),
  };
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
    // A lane `grep` é **isolada** da lane `index` (que serve o find bar): um grep longo
    // **não** pode atrasar a busca interativa do documento aberto (DEC-CON-6/9).
    // ⚠️ `grepWorkers` = o **número de workers** da lane `grep` (default **1**). Não há
    // setting para isto (o alvo não expõe a busca em arquivos): o núcleo fixa **1** (um
    // grep por vez — a lane é de **fundo**).
    grepWorkers: 1,
    maxBackgroundThreads: properties.value(maxThreadsDef),
    availableParallelism: available,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  };
  const pool = new TaskPoolImpl(poolOptions);

  const schedulerOptions: SchedulerOptions = {
    isUIThread: options.isUIThread ?? true,
    laneProbe: (): Readonly<Record<PoolLane, number>> => pool.busy,
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
      /**
       * Escopo do documento (o handle) — é o que dá a **cada aba a sua linha do tempo**: o
       * `UndoStack` só aplica, no `undo`/`redo`, os passos do mesmo escopo. Sem isso, desfazer
       * na aba B aplicava os deltas da aba A no buffer de B (texto corrompido).
       */
      scopeId(): string {
        return String(handle);
      },
      applyEdits(edits: readonly Edit[], origin: EditOrigin): void {
        for (const edit of edits) {
          buffer.apply({ from: edit.at, removed: edit.remove, inserted: edit.insert }, origin);
        }
        // Os cursores **andam com o texto**: um delta desloca as posições (multi-cursor, P2#5).
        // É esta regra que faz o "depois" do undo/redo sair posicionado — e o `CommandBus`
        // grava justamente o estado lido aqui (antes/depois) na transação.
        state.selections = advanceSelections(state.selections, edits);
        const primary = state.selections[0];
        if (primary !== undefined) {
          state.selection = primary;
          state.caret = primary.active;
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

  /** Computa offsets de início de cada linha a partir do array `lines` (texto sem `\n`). */
  function computeLineStarts(lines: string[]): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < lines.length - 1; i++) {
      starts.push(starts[i]! + lines[i]!.length + 1);
    }
    return starts;
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
      const lines = text.split("\n");
      const entry: HighlightCacheEntry = {
        revision,
        grammar,
        lines,
        lineStarts: computeLineStarts(lines),
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
      existing.lineStarts = computeLineStarts(newLines);
      return existing;
    }

    // Primeira vez que este handle é visto.
    const lines = text.split("\n");
    const entry: HighlightCacheEntry = {
      revision,
      grammar,
      lines,
      lineStarts: computeLineStarts(lines),
      states: [],
      spans: [],
    };
    highlightCache.set(handle, entry);
    return entry;
  }

  /**
   * Tokenização síncrona de linhas no main thread (apenas quando abaixo do limiar
   * `SYNC_SYNTAX_THRESHOLD` ou quando não há gramática).
   */
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

  // ── Serialização de gramática para o worker ─────────────────────────────────────────────────

  /**
   * Converte um `CompiledPattern` na forma serializável que cruza o IPC.
   * `RegExp` vira `{match, matchFlags}`; captures são aplainadas.
   */
  function serializePattern(p: CompiledPattern): import("../../shared").SerializedPattern {
    const captures: Record<string, { readonly scope: string }> = {};
    if (p.captures.length > 0) {
      for (const cap of p.captures) {
        const key = cap.name ?? String(cap.group);
        captures[key] = { scope: cap.scope };
      }
    }
    return {
      ...(p.matcher !== null ? { match: p.matcher.source, matchFlags: p.matcher.flags } : {}),
      ...(p.scope !== null ? { scope: p.scope } : {}),
      ...(p.captures.length > 0 ? { captures } : {}),
      ...(p.push !== null ? { push: [p.push] } : {}),
      ...(p.set !== null ? { set: p.set } : {}),
      ...(p.pop ? { pop: true } : {}),
      ...(p.include !== null ? { include: p.include } : {}),
    };
  }

  /**
   * Serializa a gramática compilada para a forma plana que atravessa o IPC
   * (o worker a reconstrói com `deserializeGrammar`).
   */
  function serializeGrammar(grammar: SyntaxGrammar): SerializedGrammar {
    const compiled = (grammars as GrammarRegistryImpl).getCompiledGrammar(grammar.logicalName);
    if (compiled === undefined) {
      throw new Error(`serializeGrammar: gramática "${grammar.logicalName}" não compilada`);
    }
    const contexts: Record<string, import("../../shared").SerializedContext> = {};
    for (const [name, patterns] of compiled.contexts) {
      const metaScope = compiled.contextScopes.get(name);
      contexts[name] = {
        patterns: patterns.map(serializePattern),
        ...(metaScope !== undefined ? { metaScope } : {}),
      };
    }
    const contextScopes: Record<string, string> = {};
    for (const [name, scope] of compiled.contextScopes) {
      contextScopes[name] = scope;
    }
    return {
      contexts,
      contextScopes,
      scope: compiled.scope,
      logicalName: compiled.logicalName,
      extensions: [...compiled.fileExtensions],
    };
  }

  /**
   * Tokenização assistida pelo worker para grandes blocos de linhas.
   * Se `needLines <= SYNC_SYNTAX_THRESHOLD` ou não há gramática, cai no path síncrono
   * (evita overhead de IPC). Senão, delega ao `TaskPool` com deadline.
   * Devolve `true` se o resultado foi truncado (cache parcial — retentar no próximo frame).
   */
  async function extendHighlightCacheSmart(
    entry: HighlightCacheEntry,
    end: number,
    grammar: SyntaxGrammar | undefined,
    handle: DocumentHandle,
    revision: number,
    bufferText: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const needLines = end - entry.states.length;
    if (needLines <= 0) return false;

    // Sem gramática ou carga pequena → sync (não paga IPC para poucas linhas).
    if (grammar === undefined || needLines <= SYNC_SYNTAX_THRESHOLD) {
      extendHighlightCache(entry, end, grammar);
      return false;
    }

    // Serializa estados para o worker.
    const states: (string | null)[] = entry.states.map((s) => {
      if (s === undefined || s === null) return null;
      return (s as { stack: string[] }).stack.join(",");
    });

    const serialized = serializeGrammar(grammar);
    const result = await pool.run(
      {
        kind: "syntaxTokens",
        doc: handle,
        generation: revision,
        first: entry.states.length,
        count: needLines,
        text: bufferText,
        lineStarts: entry.lineStarts,
        states,
        grammar: serialized,
      },
      signal !== undefined ? { lane: "index" as PoolLane, signal } : { lane: "index" as PoolLane },
    ).done;

    // Aplica spans no cache.
    for (const hlLine of result.lines) {
      const spans: readonly HighlightSpan[] = hlLine.spans;
      entry.spans[hlLine.line] = spans;
    }

    // Desserializa estados.
    if (result.states) {
      for (let i = 0; i < result.states.length; i++) {
        const serial = result.states[i];
        if (serial === undefined) continue;
        entry.states.push(serial !== null ? { stack: serial.split(",") } : undefined);
      }
    }

    return result.truncated ?? false;
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

  /**
   * Busca na **workspace** (o "grep") — **no worker** (a task `grep` da lane `grep`).
   *
   * ⚠️ **Por que no worker:** a varredura é CPU-bound e a leitura é de disco — no processo
   * principal, um `RegExp` patológico travava a janela, o IPC e o LSP. No worker, o pior
   * caso é o **teto duro** (o pool mata o worker) e a lane se recupera.
   *
   * ⚠️ **Teto duro (política):** o `TaskTimeoutError` **não** vaza para a UI — o núcleo
   * devolve um `GrepResult` **incompleto** (`truncated: true` + aviso). O
   * `CancellationError` (o `signal` do IPC abortou) **propaga**: cancelar é uma ação do
   * usuário, não um resultado.
   *
   * ⚠️ **Preempção (política):** a busca é de **fundo** (`preemptible: true`) — se uma task
   * de **primeiro plano** (o **realce de sintaxe**, o **salvar**) precisar do slot, o pool
   * **mata** o worker do grep ⇒ a task é rejeitada com `TaskPreemptedError` e o núcleo
   * devolve um `GrepResult` **incompleto** com um aviso **diferente** (o usuário precisa
   * saber que **ele** não fez nada de errado — foi outra operação que precisou do worker).
   */
  async function runGrep(params: GrepFilesParams): Promise<GrepResult> {
    const { query, files, options, signal } = params;
    try {
      return await scheduler.post(
        "background",
        () =>
          pool.run(
            {
              kind: "grep",
              query,
              files,
              ...(options !== undefined ? { options } : {}),
            },
            {
              lane: "grep",
              priority: "background",
              // A busca é de **fundo**: ela pode ser **morta** para servir uma task de
              // primeiro plano (o realce de sintaxe e o salvar não podem esperar por ela).
              preemptible: true,
              // Teto **duro**: o worker é morto se estourar (o `RegExp` não é interrompível).
              timeoutMs: GREP_TASK_TIMEOUT_MS,
              ...(signal !== undefined ? { signal } : {}),
            },
          ).done,
      );
    } catch (error) {
      if (error instanceof TaskTimeoutError) {
        return {
          matches: [],
          truncated: true,
          filesScanned: 0,
          warnings: [
            `a busca foi interrompida por tempo (${error.timeoutMs} ms) — o resultado está incompleto`,
          ],
        };
      }
      if (error instanceof TaskPreemptedError) {
        // ⚠️ Aviso **diferente** do de tempo: o grep foi **matado** para o realce/salvar
        // pegar o worker — o usuário não fez nada de errado (a busca é de fundo).
        return {
          matches: [],
          truncated: true,
          filesScanned: 0,
          warnings: [
            "a busca foi interrompida por outra operação (o resultado está incompleto)",
          ],
        };
      }
      throw error;
    }
  }

  /**
   * Fixa o conjunto de cursores do núcleo — é o estado **antes** da edição, ou seja, o que o
   * undo vai restaurar. Mantém `selection`/`caret` coerentes com a seleção primária.
   */
  function applySelectionSet(sels: SelectionSet): void {
    state.selections = sels;
    const primary = sels[0];
    state.selection = primary ?? SelectionOps.collapsed(0);
    state.caret = primary?.active ?? 0;
  }

  /**
   * Conjunto de cursores "antes" para quem **não** mandou um (cliente antigo): a seleção
   * corrente do núcleo (quando é uma única faixa) ou um cursor único na posição da edição.
   */
  function legacyCursorsBefore(at: number): SelectionSet {
    const current = state.selections;
    if (current.length === 1 && !SelectionOps.isCollapsed(current[0]!)) return current;
    return SelectionSetOps.singular(at);
  }

  /**
   * Contador de sequência dos **grupos de undo únicos** (o apagamento e o insert de extensão
   * não fundem ⇒ cada operação precisa do seu próprio grupo).
   */
  let undoGroupSeq = 0;

  /**
   * **Grupo de undo** de uma edição — decide *o que* um `Ctrl+Z` desfaz.
   *
   * ⚠️ **Por que 3 grupos (e não 1)**: com um grupo único (`type:`), a **digitação**, o
   * **backspace/delete** e o **insert de extensão** fundiam no mesmo passo de undo — um
   * `Ctrl+Z` desfazia coisas diferentes do que o usuário esperava (p.ex.: digitar "abc", apagar
   * um caractere ⇒ o `Ctrl+Z` tirava o "abc" inteiro).
   *
   * Agora a coalescência (a "fusão" de passos consecutivos com o mesmo `groupId`) só acontece
   * **dentro do mesmo tipo de ação**:
   *
   * - `type:<handle>` — **digitação**: é a **única** que funde com ela mesma (as teclas
   *   consecutivas viram 1 passo de undo);
   * - `delete:<handle>:<n>` — backspace/delete: grupo **único** por operação (dois
   *   apagamentos consecutivos são 2 `Ctrl+Z`);
   * - `plugin:<handle>:<n>` — insert de extensão: grupo **único** por operação (nunca funde
   *   com a digitação nem com o apagamento).
   *
   * @param handle Documento dono da edição (o grupo é **por documento**).
   * @param origin Origem da edição (`"user"` = digitação/apagamento, `"plugin"` = extensão).
   * @param edits Os deltas da edição (o `remove` é o texto apagado, o `insert` o inserido).
   */
  function undoGroupFor(
    handle: DocumentHandle,
    origin: "plugin" | "user",
    edits: readonly { readonly insert: string; readonly remove: string }[],
  ): string {
    // Os grupos que **não** fundem precisam ser únicos ⇒ um contador de sequência.
    undoGroupSeq += 1;
    if (origin === "plugin") return `plugin:${handle}:${undoGroupSeq}`;
    // Apagamento puro (remove texto e não insere nada) — backspace/delete.
    const isDeletion =
      edits.length > 0 && edits.every((e) => e.insert.length === 0 && e.remove.length > 0);
    return isDeletion ? `delete:${handle}:${undoGroupSeq}` : `type:${handle}`;
  }

  /**
   * Insere `text` em `at` do documento.
   *
   * `selections` (opcional) é o conjunto de cursores **antes** da edição: é o "before" que o
   * undo restaura (P2#5 — multi-cursor). Sem ele, o core infere um cursor único (compatibilidade
   * com clientes antigos).
   *
   * **Por que não existe um ramo multi-cursor aqui:** a edição é **explícita** — quem manda diz
   * *o que* editar (`at`/`text`/`remove`). O core não decide "inserir em cada cursor"; ele
   * apenas carrega o conjunto de cursores para o undo. Para editar em N cursores, o cliente
   * manda um `document.batchInsert` com uma entrada por cursor (em ordem descendente).
   */
  async function runInsert(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin: "plugin" | "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult> {
    assertNotDisposed();
    const buffer = resolveBuffer(handle);
    state.pendingHandle = handle;
    // O "antes": o conjunto de cursores que o undo vai restaurar.
    const before = selections ?? legacyCursorsBefore(at);
    applySelectionSet(before);
    let actualAt = at;
    let removeText: string | undefined;
    const primary = before[0];
    if (primary !== undefined && !SelectionOps.isCollapsed(primary)) {
      // Digitação sobre uma seleção substitui o trecho selecionado (semântica de editor).
      const { start, end } = SelectionOps.normalized(primary);
      actualAt = start;
      removeText = buffer.text().slice(start, end);
    }
    try {
      const result = await commands.run(
        INSERT_COMMAND_ID,
        { handle, at: actualAt, text, ...(removeText !== undefined ? { remove: removeText } : {}) },
        { origin, group: undoGroupFor(handle, origin, [{ insert: text, remove: removeText ?? "" }]) },
      );
      if (!result.handled) {
        throw new EditorArgumentError(
          "command-missing",
          `comando não registrado: ${INSERT_COMMAND_ID}`,
        );
      }
    } finally {
      state.pendingHandle = undefined;
    }
    state.activeHandle = handle;
    // O cursor/seleções **já** saíram posicionados: o `applyEdits` do alvo desloca os cursores
    // junto com o texto (mesma regra do `advanceSelections` do renderer).
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
      canUndo: commands.undoStack.undoDepthFor(String(handle)) > 0,
      canRedo: commands.undoStack.redoDepthFor(String(handle)) > 0,
    };
  }

  /**
   * Substitui `remove` caracteres a partir de `at` por `insert` no documento.
   * Extrai o texto removido do buffer e usa o mesmo comando `INSERT_COMMAND_ID`
   * com a opção `remove` para que a substituição seja registrada como uma única
   * transação de undo.
   *
   * `selections` (opcional) é o conjunto de cursores **antes** da edição — é o "before" que o
   * undo restaura (multi-cursor, P2#5).
   */
  async function runReplaceOne(
    handle: DocumentHandle,
    at: number,
    remove: number,
    insert: string,
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult> {
    assertNotDisposed();
    const buffer = resolveBuffer(handle);
    state.pendingHandle = handle;
    // O "antes": o conjunto de cursores que o undo vai restaurar.
    applySelectionSet(selections ?? SelectionSetOps.singular(at));
    const removeText = buffer.text().slice(at, at + remove);
    try {
      const result = await commands.run(
        INSERT_COMMAND_ID,
        { handle, at, text: insert, remove: removeText },
        {
          origin: "user",
          group: undoGroupFor(handle, "user", [{ insert, remove: removeText }]),
        },
      );
      if (!result.handled) {
        throw new EditorArgumentError(
          "command-missing",
          `comando não registrado: ${INSERT_COMMAND_ID}`,
        );
      }
    } finally {
      state.pendingHandle = undefined;
    }
    state.activeHandle = handle;
    // O cursor/seleções saíram deslocados pelo próprio delta (ver `applyEdits` do alvo).
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
      canUndo: commands.undoStack.undoDepthFor(String(handle)) > 0,
      canRedo: commands.undoStack.redoDepthFor(String(handle)) > 0,
    };
  }

  /**
   * Lote de inserções atômicas: aplica cada `{at, text, remove?}` em sequência, tudo
   * dentro de um único `coalesceDocumentChanges` (1 evento `document.changed`) e num
   * **único** passo de undo (o grupo do lote funde os N comandos — `type:` na digitação,
   * `delete:` no apagamento multi-cursor, `plugin:` no insert de extensão).   *
   * O `at` de cada entrada é absoluto **no estado do buffer após as entradas anteriores** ⇒
   * um lote multi-cursor deve entrar em ordem **descendente**.
   *
   * `selections` (opcional) é o conjunto de cursores **antes** do lote — é o "before" que o
   * undo restaura (multi-cursor, P2#5). Sem ele, o core assume um cursor único no início do
   * lote (onde a digitação começou).
   */
  async function runBatchInsert(
    handle: DocumentHandle,
    inserts: ReadonlyArray<{
      readonly at: number;
      readonly text: string;
      readonly remove?: string;
    }>,
    origin: "plugin" | "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult> {
    assertNotDisposed();
    const buffer = resolveBuffer(handle);
    if (inserts.length === 0) {
      throw new EditorArgumentError("invalid-args", "batchInsert: 'inserts' não pode ser vazio");
    }
    state.pendingHandle = handle;
    // O "antes": o conjunto de cursores que o undo vai restaurar.
    applySelectionSet(selections ?? SelectionSetOps.singular(inserts[0]!.at));
    // O grupo do undo é do **lote inteiro** (as N edições são 1 passo de undo): um lote
    // misto (digitação + apagamento) cai no grupo da digitação — o que importa é que ele
    // **não** funda com o lote anterior (que pode ser de outro tipo).
    const group = undoGroupFor(
      handle,
      origin,
      inserts.map((entry) => ({ insert: entry.text, remove: entry.remove ?? "" })),
    );
    try {
      return await coalesceDocumentChanges(handle, async () => {
        for (const { at, text, remove } of inserts) {
          const result = await commands.run(
            INSERT_COMMAND_ID,
            {
              handle,
              at,
              text,
              ...(remove !== undefined && remove.length > 0 ? { remove } : {}),
            },
            { origin, group },
          );
          if (!result.handled) {
            throw new EditorArgumentError(
              "command-missing",
              `comando não registrado: ${INSERT_COMMAND_ID}`,
            );
          }
        }
        // O cursor/seleções saíram deslocados pelo próprio lote (ver `applyEdits` do alvo).
        registry.setDirty(handle, true);
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
          canUndo: commands.undoStack.undoDepthFor(String(handle)) > 0,
          canRedo: commands.undoStack.redoDepthFor(String(handle)) > 0,
        };
      });
    } finally {
      state.pendingHandle = undefined;
    }
  }

  /**
   * Estado de undo/redo do documento + cursor. A pilha (`UndoStack`) é do `CommandBus`; aqui só
   * lemos as profundidades (não inventamos API que o núcleo não suporta).
   *
   * `canUndo`/`canRedo` são do **documento** (do escopo do handle) — não o total global: a pilha
   * guarda as linhas do tempo de todos os documentos abertos, mas cada aba só vê a sua.
   *
   * `selections` é o **conjunto** de cursores corrente (multi-cursor, P2#5) — depois de um
   * `Ctrl+Z` são os N cursores restaurados às posições originais.
   */
  function undoStateOf(handle: DocumentHandle): DocumentUndoState {
    const buffer = resolveBuffer(handle);
    const stack = commands.undoStack;
    const scope = String(handle);
    return {
      canUndo: stack.undoDepthFor(scope) > 0,
      canRedo: stack.redoDepthFor(scope) > 0,
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
   *
   * O `pendingHandle` também define o **escopo** do passo (`String(handle)`) — por isso o undo
   * aqui só desfaz o que foi feito **neste** documento (cada aba tem a sua linha do tempo).
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

    async closeDocument(handle: DocumentHandle): Promise<void> {
      assertNotDisposed();
      const docState = registry.get(handle);
      if (docState === undefined) throw new InvalidDocumentHandleError(handle);
      const path = docState.uri;
      const uri = toFileUri(path);

      // 0) Documento sujo ⇒ **salva** antes de fechar (o `close` do registry descarta o
      //    buffer; sem salvar, a edição se perde).
      if (docState.dirty) {
        await this.saveDocument(handle);
      }

      // 1) LSP: `textDocument/didClose` — o servidor solta o documento (memória +
      //    diagnósticos obsoletos). É idempotente: o `LspManager` ignora URIs sem servidor.
      if (lspManager !== null) {
        lspManager.closeDocument(uri);
      }
      diagnosticsCache.delete(uri);
      uriToHandle.delete(path);

      // 2) Buffer: fecha o documento (flush + descarte) e limpa o estado do core.
      await registry.close(handle);
      opened.delete(handle);
      documentExtensions.delete(handle);
      subscriptions.get(handle)?.dispose();
      subscriptions.delete(handle);
      if (state.activeHandle === handle) state.activeHandle = undefined;
    },

    documentText(handle: DocumentHandle): string {
      return resolveBuffer(handle).text();
    },

    insertText(
      handle: DocumentHandle,
      at: number,
      text: string,
      origin: "plugin" | "user" = "user",
      selections?: SelectionSet,
    ): Promise<DocumentInsertResult> {
      return enqueue(() => runInsert(handle, at, text, origin, selections));
    },

    replaceOne(
      handle: DocumentHandle,
      at: number,
      remove: number,
      insert: string,
      selections?: SelectionSet,
    ): Promise<DocumentInsertResult> {
      return enqueue(() => runReplaceOne(handle, at, remove, insert, selections));
    },

    batchInsert(
      handle: DocumentHandle,
      inserts: ReadonlyArray<{
        readonly at: number;
        readonly text: string;
        readonly remove?: string;
      }>,
      origin: "plugin" | "user" = "user",
      selections?: SelectionSet,
    ): Promise<DocumentInsertResult> {
      return enqueue(() => runBatchInsert(handle, inserts, origin, selections));
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

    async highlightDocument(
      handle: DocumentHandle,
      first: number,
      count: number,
    ): Promise<DocumentHighlight> {
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
      // P2.4b: se houver muitas linhas a tokenizar, delega ao worker com deadline.
      const truncated = await extendHighlightCacheSmart(
        entry,
        end,
        grammar,
        handle,
        revision,
        buffer.text(),
        undefined, // signal — o highlight síncrono não usa AbortSignal
      );
      const lines: HighlightLine[] = [];
      for (let line = start; line < end; line++) {
        lines.push({ line, spans: entry.spans[line] ?? [] });
      }
      return { revision, first: start, lines, ...(truncated ? { truncated: true } : {}) };
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

    async grepFiles(params: GrepFilesParams): Promise<GrepResult> {
      assertNotDisposed();
      return runGrep(params);
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
          // O cursor acompanha o texto: o `applyEdits` do alvo desloca as seleções, e o caret é
          // o `active` da seleção primária (mesma regra do `applyEdits`).
          const primary = state.selections[0];
          state.caret = primary !== undefined ? primary.active : 0;
          state.selection = primary ?? SelectionOps.collapsed(state.caret);
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
        { id: "file.new",       label: "Novo arquivo",       category: "File", accelerator: "Ctrl+N" },
        { id: "file.save",      label: "Salvar",              category: "File", accelerator: "Ctrl+S" },
        { id: "edit.undo",      label: "Desfazer",            category: "Edit", accelerator: "Ctrl+Z" },
        { id: "edit.redo",      label: "Refazer",             category: "Edit", accelerator: "Ctrl+Shift+Z" },
        { id: "edit.cut",       label: "Recortar",            category: "Edit", accelerator: "Ctrl+X" },
        { id: "edit.copy",      label: "Copiar",              category: "Edit", accelerator: "Ctrl+C" },
        { id: "edit.paste",     label: "Colar",               category: "Edit", accelerator: "Ctrl+V" },
        { id: "edit.selectAll", label: "Selecionar tudo",     category: "Edit", accelerator: "Ctrl+A" },
        { id: "find.open",      label: "Buscar",              category: "Find", accelerator: "Ctrl+F" },
        { id: "view.toggleTheme", label: "Alternar tema",     category: "View", accelerator: "Ctrl+Shift+T" },
        // Depuração (DAP) — executadas **no renderer** (o core não tem UI); a paleta as
        // encaminha para os mesmos handlers do menu nativo.
        // F5 é **contextual** (parado → continua; inativo → inicia): o acelerador fica
        // só em "Iniciar depuração" — declarar F5 nos dois comandos é ambíguo.
        { id: "debug.start",    label: "Iniciar depuração",   category: "Debug", accelerator: "F5" },
        { id: "debug.continue", label: "Continuar (depuração)", category: "Debug" },
        { id: "debug.stop",     label: "Encerrar depuração",  category: "Debug", accelerator: "Shift+F5" },
        { id: "debug.toggleBreakpoint", label: "Alternar breakpoint", category: "Debug", accelerator: "F9" },
        { id: "debug.togglePanel", label: "Painel de depuração", category: "Debug", accelerator: "Ctrl+Shift+D" },
      ];
    },

    async executeCommand(id: string): Promise<void> {
      switch (id) {
        case "file.open":
          // Aberto no dispatchIpc com deps.dialog; aqui sem dialog não tem o que fazer.
          throw new EditorArgumentError("no-dialog", "file.open requer diálogo injetado");
        case "file.new":
          // O "novo arquivo" precisa do diálogo "salvar como" (o `main` o tem): o renderer
          // intercepta o comando **antes** do IPC (o `dispatchIpc` trata o `file.new`).
          throw new EditorArgumentError("no-dialog", "file.new requer diálogo injetado");
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

    async requestRename(
      handle: DocumentHandle,
      line: number,
      col: number,
      newName: string,
    ): Promise<LspRenameResult | null> {
      if (lspManager === null) return null;
      const path = registry.get(handle)?.uri;
      if (path === undefined) return null;
      const uri = toFileUri(path);
      const result = await lspManager.requestRename(uri, line, col, newName);
      if (!result || !result.changes) return null;
      return {
        edits: Object.fromEntries(
          Object.entries(result.changes).map(([fileUri, edits]) => [
            fileUri,
            edits.map((e) => ({
              range: {
                start: { line: e.range.start.line, character: e.range.start.character },
                end: { line: e.range.end.line, character: e.range.end.character },
              },
              newText: e.newText,
            })),
          ]),
        ),
      } satisfies LspRenameResult;
    },

    async requestReferences(
      handle: DocumentHandle,
      line: number,
      col: number,
    ): Promise<readonly LspLocation[]> {
      if (lspManager === null) return [];
      const path = registry.get(handle)?.uri;
      if (path === undefined) return [];
      const uri = toFileUri(path);
      const result = await lspManager.requestReferences(uri, line, col);
      return (result ?? []).map(convertLocation);
    },

    async requestCodeActions(
      handle: DocumentHandle,
      line: number,
      col: number,
    ): Promise<readonly LspCodeAction[]> {
      if (lspManager === null) return [];
      const path = registry.get(handle)?.uri;
      if (path === undefined) return [];
      const uri = toFileUri(path);
      const diags = diagnosticsCache.get(uri) ?? [];
      const result = await lspManager.requestCodeActions(uri, line, col, diags);
      return (result ?? []).map((ca): LspCodeAction => {
        const item: Record<string, unknown> = { title: ca.title };
        if (ca.kind !== undefined) item.kind = ca.kind;
        if (ca.diagnostics !== undefined) item.diagnostics = ca.diagnostics;
        if (ca.edit !== undefined) {
          item.edit = {
            changes: Object.fromEntries(
              Object.entries(ca.edit.changes ?? {}).map(([editUri, edits]) => [
                editUri,
                edits.map((e) => ({
                  range: {
                    start: { line: e.range.start.line, character: e.range.start.character },
                    end: { line: e.range.end.line, character: e.range.end.character },
                  },
                  newText: e.newText,
                })),
              ]),
            ),
          };
        }
        if (ca.command !== undefined) {
          const cmd: Record<string, unknown> = { command: ca.command.command };
          if (ca.command.arguments !== undefined) cmd.arguments = ca.command.arguments;
          item.command = cmd;
        }
        return item as unknown as LspCodeAction;
      });
    },

    async requestFormatting(
      handle: DocumentHandle,
      options?: { readonly tabSize?: number; readonly insertSpaces?: boolean },
    ): Promise<readonly LspTextEdit[]> {
      if (lspManager === null) return [];
      const path = registry.get(handle)?.uri;
      if (path === undefined) return [];
      const uri = toFileUri(path);
      const result = await lspManager.requestFormatting(uri, options);
      return (result ?? []).map(convertTextEdit);
    },

    async requestFoldingRange(handle: DocumentHandle): Promise<readonly LspFoldingRange[]> {
      if (lspManager === null) return [];
      const path = registry.get(handle)?.uri;
      if (path === undefined) return [];
      const uri = toFileUri(path);
      const result = await lspManager.requestFoldingRange(uri);
      return (result ?? []).map(convertFoldingRange);
    },

    async requestInlayHints(
      handle: DocumentHandle,
      startLine?: number,
      endLine?: number,
    ): Promise<readonly LspInlayHint[]> {
      if (lspManager === null) return [];
      const path = registry.get(handle)?.uri;
      if (path === undefined) return [];
      const uri = toFileUri(path);
      const range = startLine !== undefined && endLine !== undefined
        ? { startLine, startCol: 0, endLine, endCol: 0 }
        : undefined;
      const result = await lspManager.requestInlayHints(uri, range);
      return (result ?? []).map(convertInlayHint);
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
      // Fecha os documentos **no servidor LSP** antes de derrubar os servidores: sem
      // `textDocument/didClose` o servidor fica com cada documento aberto (memória +
      // diagnósticos obsoletos) até o processo morrer.
      if (lspManager !== null) {
        for (const handle of opened) {
          const path = registry.get(handle)?.uri;
          if (path === undefined) continue;
          lspManager.closeDocument(toFileUri(path));
        }
      }
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
