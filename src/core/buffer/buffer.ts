/**
 * `BufferImpl` — façade **observável** do documento (DEC-BUF-2).
 *
 * **Padrão observado a que corresponde:** no alvo, `TextBuffer` (global, sem namespace) é o
 * objeto público, distinto do núcleo anônimo alocado no construtor (`BUF-E1`, `BUF-E4`), e o
 * subobjeto `observer` vive **no núcleo**, não na view (`BUF-E6`) — quem muda o texto notifica
 * listeners **do modelo**. É exatamente o desenho aqui: a façade `Buffer` é a fonte do evento
 * `onDidChange`, e os listeners recebem o **delta** (a mudança como valor, `BUF-E11`), nunca o
 * texto inteiro.
 *
 * **Escolha nossa (não observada no alvo):** `revision` é lida do `generation` do `TextStore`
 * (ambas sobem 1 por mutação), evitando dois contadores que poderiam divergir.
 * `TextStore` **não** é exportado fora do módulo `buffer` (DEC-BUF-2) — a façade é o único acesso.
 */
import type {
  Buffer,
  Disposable,
  DocumentHandle,
  EditOrigin,
  TextDelta,
  TextDeltaEvent,
} from "../../shared";
import { Emitter } from "../../shared";
import type { LocalTextStore } from "./store";

/** Erro alto: a façade foi descartada e não aceita mais mutação (DEC-TR-5). */
export class BufferDisposedError extends Error {
  readonly handle: DocumentHandle;

  constructor(handle: DocumentHandle) {
    super(`BufferDisposedError: buffer ${handle} foi descartado`);
    this.name = "BufferDisposedError";
    this.handle = handle;
  }
}

/**
 * Façade pública do documento: leitura síncrona (o documento quente), mutação por delta e
 * evento de mudança. O storage real mora atrás do `LocalTextStore`.
 */
export class BufferImpl implements Buffer {
  readonly handle: DocumentHandle;

  private readonly store: LocalTextStore;
  private readonly emitter = new Emitter<TextDeltaEvent>();
  private disposed = false;

  constructor(handle: DocumentHandle, store: LocalTextStore) {
    this.handle = handle;
    this.store = store;
  }

  /** Sobe a cada mutação; validade de resultado assíncrono (DEC-BUF-10). */
  get revision(): number {
    return this.store.generation;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Materializa o documento — O(n); não chamar em laço quente. */
  text(): string {
    return this.store.text();
  }

  lineCount(): number {
    return this.store.lineCount();
  }

  offsetAtLine(line: number): number {
    return this.store.offsetAtLine(line);
  }

  lineAt(offset: number): number {
    return this.store.lineAt(offset);
  }

  /** Aplica um delta no documento e notifica os listeners com o delta e a nova revisão. */
  apply(delta: TextDelta, origin: EditOrigin): void {
    if (this.disposed) throw new BufferDisposedError(this.handle);
    this.store.applyDelta(delta, origin);
    this.emitter.fire({ delta, revision: this.store.generation });
  }

  onDidChange(cb: (e: TextDeltaEvent) => void): Disposable {
    return this.emitter.event(cb);
  }

  /** Compacta o buffer `add` do núcleo (política do `TextStore`; usado antes de fechar). */
  flush(): void {
    this.store.flushChunk();
  }

  /** Descarta a façade (idempotente) — chamado pelo `DocumentRegistry` ao reciclar o slot. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.emitter.dispose();
  }
}
