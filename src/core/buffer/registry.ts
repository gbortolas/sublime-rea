/**
 * `DocumentRegistryImpl` — único mapa `handle → Buffer` (DEC-BUF-6).
 *
 * **Padrão observado a que corresponde:** do lado dos plugins, o alvo só expõe **handles opacos**
 * (ids numéricos) e delega a *liveness* ao nativo (`PY-E4`) — o Python nunca vê ponteiro nem
 * objeto. Aqui o handle é um **número brandado** (`shared/handles.ts`) com *slot* nos bits baixos
 * e *geração* nos bits altos; o estado (uri, store, revision) mora **no registry**, nunca no
 * handle (DEC-TR-1).
 *
 * **Escolha nossa (não observada no alvo, DEC-BUF-6/D6):** a geração do slot **sobe ao reciclar
 * o slot** e o handle antigo **nunca** volta a resolver — elimina a classe de bugs
 * "use-after-free lógico" (*handle* velho apontando para um buffer novo). Isso é o anti-ABA do
 * scaffold: `resolve`/`isValid` são o *guard* obrigatório de toda travessia de fronteira.
 *
 * **Port de I/O (escolha nossa):** `open` lê do disco por um `FileSystem` **injetado** — produção
 * usa `node:fs/promises` (`createNodeFileSystem`), teste usa um fake em memória. O módulo não
 * importa `node:fs` no topo (o mesmo bundle roda em renderer), só dentro da fábrica assíncrona.
 */
import type {
  Buffer,
  DocumentHandle,
  DocumentRegistry,
  DocumentState,
  Event,
} from "../../shared";
import {
  Emitter,
  handleGeneration,
  handleSlot,
  makeHandle,
  MAX_SLOT,
  nextGeneration,
  toError,
} from "../../shared";
import { BufferImpl } from "./buffer";
import { LocalTextStore } from "./store";

/** Port mínimo de I/O de arquivo exigido por `DocumentRegistry.open` (escolha nossa). */
export interface FileSystem {
  readFile(path: string): Promise<string>;
}

/** Erro alto: não se abre documento sem port de I/O injetado (DEC-TR-5). */
export class FileSystemUnavailableError extends Error {
  constructor() {
    super("FileSystemUnavailableError: nenhum FileSystem foi injetado no DocumentRegistry");
    this.name = "FileSystemUnavailableError";
  }
}

/** Erro alto de I/O de abertura, com caminho e causa preservados. */
export class DocumentIoError extends Error {
  readonly path: string;
  readonly causeError: Error;

  constructor(path: string, cause: Error) {
    super(`DocumentIoError: falha ao abrir "${path}": ${cause.message}`);
    this.name = "DocumentIoError";
    this.path = path;
    this.causeError = cause;
  }
}

/** Erro alto: operação sobre handle que não resolve (fechar documento inexistente). */
export class UnknownDocumentError extends Error {
  readonly handle: DocumentHandle;

  constructor(handle: DocumentHandle) {
    super(`UnknownDocumentError: handle não resolve para nenhum documento: ${handle}`);
    this.name = "UnknownDocumentError";
    this.handle = handle;
  }
}

/** Erro alto: slots esgotados (`MAX_SLOT` do empacotamento de handle). */
export class RegistryCapacityError extends Error {
  readonly maxSlots: number;

  constructor(maxSlots: number) {
    super(`RegistryCapacityError: limite de ${maxSlots} slots atingido`);
    this.name = "RegistryCapacityError";
    this.maxSlots = maxSlots;
  }
}

interface SlotState {
  generation: number;
  active: boolean;
}

/**
 * Registry de documentos abertos. Ciclo de vida assíncrono (`open`/`close`) + lookup quente
 * síncrono (`resolve`/`isValid`/`get`), conforme a reconciliação do scaffold.
 */
export class DocumentRegistryImpl implements DocumentRegistry {
  private readonly fileSystem: FileSystem | undefined;
  private readonly slots: SlotState[] = [];
  private readonly buffers = new Map<DocumentHandle, BufferImpl>();
  private readonly documents = new Map<DocumentHandle, DocumentState>();
  private readonly handleByPath = new Map<string, DocumentHandle>();
  private readonly emitter = new Emitter<DocumentHandle>();

  /** Emitido no `create`, no `open` e no descarte/fechamento de um documento. */
  readonly onDidChange: Event<DocumentHandle>;

  constructor(fileSystem?: FileSystem) {
    this.fileSystem = fileSystem;
    this.onDidChange = this.emitter.event;
  }

  /** Documento em memória, sem I/O (síncrono — doc `01`). */
  create(uri: string, text?: string): Buffer {
    const created = this.addDocument(uri, text ?? "");
    this.emitter.fire(created.handle);
    return created.buffer;
  }

  /** Abre do disco via o port injetado; reabrir o mesmo caminho devolve o handle existente. */
  async open(path: string): Promise<DocumentHandle> {
    const existing = this.handleByPath.get(path);
    if (existing !== undefined && this.isValid(existing)) return existing;

    const fileSystem = this.fileSystem;
    if (fileSystem === undefined) throw new FileSystemUnavailableError();

    let text: string;
    try {
      text = await fileSystem.readFile(path);
    } catch (err) {
      throw new DocumentIoError(path, toError(err));
    }

    const created = this.addDocument(path, text);
    this.handleByPath.set(path, created.handle);
    this.emitter.fire(created.handle);
    return created.handle;
  }

  /** Lookup quente, síncrono; handle obsoleto não resolve (anti-ABA, DEC-TR-1). */
  resolve(handle: DocumentHandle): Buffer | undefined {
    if (!this.isValid(handle)) return undefined;
    return this.buffers.get(handle);
  }

  /** Estado do documento (uri/store/revisão) — também gated por `isValid`. */
  get(handle: DocumentHandle): DocumentState | undefined {
    if (!this.isValid(handle)) return undefined;
    return this.documents.get(handle);
  }

  isValid(handle: DocumentHandle): boolean {
    if (!Number.isInteger(handle) || handle < 0) return false;
    const slot = this.slots[handleSlot(handle)];
    if (slot === undefined || !slot.active) return false;
    if (slot.generation !== handleGeneration(handle)) return false;
    return this.buffers.has(handle);
  }

  /**
   * Fecha o documento (erro alto se o handle não resolve). O handle deixa de valer para sempre
   * e o slot fica disponível para reciclagem com geração nova.
   */
  async close(handle: DocumentHandle): Promise<void> {
    const buffer = this.buffers.get(handle);
    if (buffer === undefined || !this.isValid(handle)) throw new UnknownDocumentError(handle);
    buffer.flush();
    buffer.dispose();
    this.release(handle);
    this.emitter.fire(handle);
  }

  /** Descarta o documento — idempotente (handle já inválido é no-op, não é erro silencioso). */
  dispose(handle: DocumentHandle): void {
    const buffer = this.buffers.get(handle);
    if (buffer === undefined) return;
    buffer.dispose();
    this.release(handle);
    this.emitter.fire(handle);
  }

  private addDocument(uri: string, text: string): { handle: DocumentHandle; buffer: BufferImpl } {
    const handle = this.allocate();
    const store = new LocalTextStore(handle, text);
    const buffer = new BufferImpl(handle, store);
    this.buffers.set(handle, buffer);
    this.documents.set(handle, {
      handle,
      generation: handleGeneration(handle),
      uri,
      store,
      dirty: false,
    });
    return { handle, buffer };
  }

  /** Aloca o primeiro slot livre (ou um novo), sempre com geração nova (anti-ABA). */
  private allocate(): DocumentHandle {
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i];
      if (slot === undefined || slot.active) continue;
      const generation = nextGeneration(slot.generation);
      slot.generation = generation;
      slot.active = true;
      return makeHandle<"DocumentHandle">(i, generation);
    }
    if (this.slots.length > MAX_SLOT) throw new RegistryCapacityError(MAX_SLOT);
    const slot = this.slots.length;
    this.slots.push({ generation: 1, active: true });
    return makeHandle<"DocumentHandle">(slot, 1);
  }

  /** Libera o slot do handle (mantendo a geração) e limpa os índices. */
  private release(handle: DocumentHandle): void {
    const slot = this.slots[handleSlot(handle)];
    if (slot === undefined || !slot.active || slot.generation !== handleGeneration(handle)) return;

    const state = this.documents.get(handle);
    if (state !== undefined && this.handleByPath.get(state.uri) === handle) {
      this.handleByPath.delete(state.uri);
    }
    slot.active = false;
    this.buffers.delete(handle);
    this.documents.delete(handle);
  }
}

/** Port de produção: `node:fs/promises`, carregado só quando chamado (main process). */
export async function createNodeFileSystem(): Promise<FileSystem> {
  const fs = await import("node:fs/promises");
  return {
    readFile: (path: string): Promise<string> => fs.readFile(path, "utf8"),
  };
}
