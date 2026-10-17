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
  Disposable,
  DocumentChangedEvent,
  DocumentHandle,
  DocumentHighlight,
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
  Scheduler,
  SyntaxGrammar,
  TaskPool,
} from "../../shared";
import {
  CancellationError,
  DEFAULT_RENDER_BACKEND,
  Emitter,
  PROPERTY_IO_WORKERS,
  RENDER_BACKEND_PROPERTY,
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

/** Lane `index` (cold-start) — teto por propriedade (DEC-CON-6/9). */
export const PROPERTY_INDEX_WORKERS = "index.indexWorkers";
/** Teto global de workers de fundo (DEC-CON-9). */
export const PROPERTY_MAX_BACKGROUND_THREADS = "concurrency.maxBackgroundThreads";

/** `CommandId` canônico da inserção de texto (contrato de keymap/palette). */
export const INSERT_COMMAND_ID = "buffer.insert";

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

  openDocument(path: string, signal?: AbortSignal): Promise<DocumentHandle>;
  documentText(handle: DocumentHandle): string;
  insertText(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin?: "plugin" | "user",
  ): Promise<number>;
  revisionOf(handle: DocumentHandle): number;
  /** Gramática resolvida para a extensão do documento; `undefined` se não houver (DEC-PKG-8). */
  grammarForDocument(handle: DocumentHandle): SyntaxGrammar | undefined;
  /** Destaque por linha do range pedido (o renderer consome isto pelo IPC `syntax.highlight`). */
  highlightDocument(handle: DocumentHandle, first: number, count: number): DocumentHighlight;
  /** Desfaz a última transação do documento (delega ao `CommandBus`/`UndoStack`). */
  undoDocument(handle: DocumentHandle): Promise<DocumentUndoState>;
  /** Refaz a última transação desfeita do documento (par simétrico de `undoDocument`). */
  redoDocument(handle: DocumentHandle): Promise<DocumentUndoState>;
  /** Leitura barata do estado de undo/redo (para a status bar), sem mutar nada. */
  undoStateOf(handle: DocumentHandle): DocumentUndoState;
  onDocumentChanged(cb: (event: DocumentChangedEvent) => void): Disposable;
  /** `MainThreadBusy` do scheduler com as lanes do pool (DEC-CON-10). */
  snapshot(): MainThreadBusy;
  dispose(): void;
}

interface CoreState {
  activeHandle: DocumentHandle | undefined;
  pendingHandle: DocumentHandle | undefined;
  caret: number;
}

/** Cache de destaque por documento: linhas, estados de entrada e spans, tudo por revisão. */
interface HighlightCacheEntry {
  revision: number;
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

interface InsertArgs {
  readonly handle: DocumentHandle;
  readonly at: number;
  readonly text: string;
}

function parseInsertArgs(args: unknown): InsertArgs {
  if (typeof args !== "object" || args === null) {
    throw new EditorArgumentError("invalid-args", "buffer.insert espera um objeto de argumentos");
  }
  const record = args as Record<string, unknown>;
  const handle = record["handle"];
  const at = record["at"];
  const text = record["text"];
  if (typeof handle !== "number" || !Number.isInteger(handle)) {
    throw new EditorArgumentError("invalid-args", "buffer.insert: 'handle' deve ser inteiro");
  }
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0) {
    throw new EditorArgumentError("invalid-args", `buffer.insert: 'at' inválido: ${String(at)}`);
  }
  if (typeof text !== "string") {
    throw new EditorArgumentError("invalid-args", "buffer.insert: 'text' deve ser string");
  }
  return { handle: handle as DocumentHandle, at, text };
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

  const state: CoreState = { activeHandle: undefined, pendingHandle: undefined, caret: 0 };
  const emitter = new Emitter<DocumentChangedEvent>();
  const opened = new Set<DocumentHandle>();
  const subscriptions = new Map<DocumentHandle, Disposable>();

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
    };
  }

  const commands = new CommandBusImpl({
    registry,
    scheduler,
    target: resolveTarget,
  });
  commands.register(INSERT_COMMAND_ID, "Insert text", (args) => {
    const parsed = parseInsertArgs(args);
    const edits: readonly Edit[] = [{ at: parsed.at, remove: "", insert: parsed.text }];
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
      emitter.fire({ handle, revision: event.revision });
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
   */
  function ensureHighlightCache(
    handle: DocumentHandle,
    revision: number,
    text: string,
  ): HighlightCacheEntry {
    const existing = highlightCache.get(handle);
    if (existing !== undefined && existing.revision === revision) return existing;
    const entry: HighlightCacheEntry = { revision, lines: text.split("\n"), states: [], spans: [] };
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

  async function runInsert(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin: "plugin" | "user",
  ): Promise<number> {
    assertNotDisposed();
    const buffer = resolveBuffer(handle);
    state.pendingHandle = handle;
    try {
      const result = await commands.run(
        INSERT_COMMAND_ID,
        { handle, at, text },
        { origin, group: `type:${handle}` },
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
    state.caret = at + text.length;
    return buffer.revision;
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
    ): Promise<number> {
      return enqueue(() => runInsert(handle, at, text, origin));
    },

    revisionOf(handle: DocumentHandle): number {
      return resolveBuffer(handle).revision;
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
      const entry = ensureHighlightCache(handle, revision, buffer.text());
      const end = Math.min(entry.lines.length, start + take);
      extendHighlightCache(entry, end, grammar);
      const lines: HighlightLine[] = [];
      for (let line = start; line < end; line++) {
        lines.push({ line, spans: entry.spans[line] ?? [] });
      }
      return { revision, first: start, lines };
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

    dispose(): void {
      if (disposed) return;
      disposed = true;
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
