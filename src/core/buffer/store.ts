/**
 * `LocalTextStore` — fronteira **assíncrona** do texto (DEC-BUF-2/6/10, reconciliado pelo scaffold).
 *
 * **Padrão observado a que corresponde:** o alvo mantém um núcleo de texto anônimo atrás da
 * façade (`BUF-E4`) e assume **ordem total** nas mutações — o undo é reentrante e o contador de
 * revisão só sobe ao abrir grupo (contexto de `buffer-structure.md` §5 citado em DEC-BUF-10).
 * O `TextStore` é a projeção desse núcleo para quem cruza uma thread (worker): a fronteira é
 * **assíncrona** e todo resultado viaja carimbado com `generation` para ser descartado se
 * obsoleto (DEC-CON-8).
 *
 * **Escolha nossa (não observada no alvo):** a serialização das escritas é uma **fila interna**
 * (cadeia de `Promise`s). Dois `apply()` concorrentes entram em FIFO e cada um executa como
 * operação atômica — o corpo síncrono da mutação não tem `await`, logo não há intercalação
 * possível. `applyDelta()` é o caminho síncrono usado pela façade `Buffer` (main thread) e passa
 * pela **mesma** rotina de mutação, mantendo "um único escritor" por documento.
 */
import type {
  DocumentHandle,
  Edit,
  EditOrigin,
  TextDelta,
  TextStore,
} from "../../shared";
import { TextDeltaError, isHighSurrogate, isLowSurrogate } from "./delta";
import { LineIndex } from "./line-index";
import { PieceTable } from "./piece-table";

/** Limite de bytes mortos no buffer `add` antes de compactar automaticamente (escolha nossa). */
const FLUSH_DEAD_BYTES = 64 * 1024;

/**
 * `TextStore` de produção: `PieceTable` (núcleo síncrono, DEC-BUF-1) + `LineIndex` incremental
 * (DEC-BUF-5), com escritas serializadas e `generation` monotônica.
 */
export class LocalTextStore implements TextStore {
  readonly doc: DocumentHandle;

  private readonly table: PieceTable;
  private readonly index: LineIndex;
  private generationValue: number;
  private queue: Promise<void> = Promise.resolve();
  private lastOriginValue: EditOrigin = "external";

  constructor(doc: DocumentHandle, text = "") {
    this.doc = doc;
    this.table = new PieceTable(text);
    this.generationValue = 1;
    this.index = new LineIndex({ doc, source: this.table, generation: this.generationValue });
  }

  /** Sobe **exatamente 1** por edição aplicada; nunca regride (DEC-BUF-10). */
  get generation(): number {
    return this.generationValue;
  }

  get length(): number {
    return this.table.length;
  }

  /** Última origem aplicada — métrica/diagnóstico (não entra em decisão de lógica). */
  get lastOrigin(): EditOrigin {
    return this.lastOriginValue;
  }

  /** Lê `[start,end)` de forma síncrona (leitura quente não paga a fila). */
  slice(range: { readonly start: number; readonly end: number }): string {
    return this.table.slice(range.start, range.end);
  }

  /** Materializa o documento — O(n); não chamar em laço quente. */
  text(): string {
    return this.table.text();
  }

  /**
   * Aplica uma lista de edits em ordem, serializado com qualquer outro `apply` concorrente.
   * Rejeita com `TextDeltaError` sem aplicar nada do lote depois do primeiro edit inválido
   * (os edits anteriores do lote permanecem aplicados — a semântica é "prefixo do lote").
   */
  apply(edits: readonly Edit[], origin: EditOrigin): Promise<void> {
    const run = this.queue.then(() => {
      for (const edit of edits) {
        this.applyDeltaCore(
          { from: edit.at, removed: edit.remove, inserted: edit.insert },
          origin,
        );
      }
    });
    // A fila segue mesmo que este lote rejeite — erro alto para o chamador, não para a fila.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Caminho síncrono da façade (main thread): muta e devolve o controle já com o estado novo. */
  applyDelta(delta: TextDelta, origin: EditOrigin): void {
    this.applyDeltaCore(delta, origin);
  }

  /** Contagem de linhas até `offset` — delega ao índice (DEC-BUF-5). */
  lineCountUpTo(offset: number): Promise<number> {
    return Promise.resolve(this.index.scan(offset).lineCount);
  }

  lineCount(): number {
    return this.index.lineCount();
  }

  offsetAtLine(line: number): number {
    return this.index.offsetAtLine(line);
  }

  lineAt(offset: number): number {
    return this.index.lineAt(offset);
  }

  /** Compacta o buffer `add` sob demanda (política explícita, além do flush automático). */
  flushChunk(): void {
    this.table.flushChunk();
  }

  /**
   * Muta o núcleo. Ordem fixa: valida offsets/`removed`/fronteiras de surrogado contra o estado
   * **atual**, aplica no `PieceTable`, sobe a geração e só então ajusta o índice de linhas.
   */
  private applyDeltaCore(delta: TextDelta, origin: EditOrigin): void {
    const length = this.table.length;
    const from = delta.from;
    const to = from + delta.removed.length;

    if (!Number.isInteger(from) || from < 0 || from > length) {
      throw new TextDeltaError("out-of-range", `delta.from fora da faixa 0..${length}: ${from}`);
    }
    if (!Number.isInteger(to) || to > length) {
      throw new TextDeltaError(
        "out-of-range",
        `delta.from + removed.length fora da faixa 0..${length}: ${to}`,
      );
    }
    this.assertBoundary(from, length);
    this.assertBoundary(to, length);

    if (this.table.slice(from, to) !== delta.removed) {
      throw new TextDeltaError(
        "removed-mismatch",
        `texto removido diverge do documento em ${from} (esperado ${delta.removed.length} code units)`,
      );
    }

    this.table.replace(from, to, delta.inserted);
    this.generationValue += 1;
    this.index.applyDelta(delta, this.generationValue);
    this.lastOriginValue = origin;

    this.maybeFlush();
  }

  /** Rejeita offset que partiria um par surrogado do documento (DEC-BUF-9). */
  private assertBoundary(offset: number, length: number): void {
    if (offset <= 0 || offset >= length) return;
    const pair = this.table.slice(offset - 1, offset + 1);
    if (pair.length === 2 && isHighSurrogate(pair.charCodeAt(0)) && isLowSurrogate(pair.charCodeAt(1))) {
      throw new TextDeltaError(
        "surrogate-split",
        `offset ${offset} cai no meio de um par surrogado`,
      );
    }
  }

  /** Compacta o `add` quando os bytes mortos passam do limite (escolha nossa). */
  private maybeFlush(): void {
    if (this.table.deadAddLength >= FLUSH_DEAD_BYTES) this.table.flushChunk();
  }
}
