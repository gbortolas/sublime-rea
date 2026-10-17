/**
 * `LineIndex` — índice de linhas com **cache incremental por revisão** (DEC-BUF-5, `BUF-U4`).
 *
 * **Padrão observado a que corresponde:** o alvo **não tem** classe de índice de linhas
 * (`BUF-E2`); a contagem/posição é obtida por **varredura com cache** marcado por sentinelas
 * `-1` gravadas no próprio buffer (`buffer-structure.md` §4, citado pelo doc `01`). A
 * granularidade do cache e o custo assintótico são `[DESCONHECIDO]` (`BUF-U4`), e `DEC-BUF-5`
 * marca a v1 como **provisória** (revisitar por benchmark). Seguimos o modelo simples observável.
 *
 * **Escolha nossa (não observada no alvo):** em vez de sentinela no buffer, mantemos um array
 * `lineStarts` em memória (mesma informação, sem poluir o texto) e o **ajustamos
 * incrementalmente** a cada delta: preserva o prefixo já varrido, desloca o sufixo pelo
 * `shift` do delta e insere os inícios criados pelos `\n` do texto inserido. Um delta que
 * cruza a fronteira do que já foi varrido apenas trunca o cache para o offset da edição —
 * nunca dispara um recálculo do documento inteiro.
 *
 * **Convenção de linhas (escolha nossa):** `lineStarts[0]` é sempre `0` (um documento vazio tem
 * **1** linha) e, para cada `\n` em `i`, registramos `i + 1` (mesmo quando `i + 1 === length`,
 * de modo que um texto terminado em `\n` tem uma última linha vazia).
 */
import type { DocumentHandle, LineScanResult, TextDelta } from "../../shared";

/** Fonte de texto que o índice sabe varrer (o `PieceTable` satisfaz estruturalmente). */
export interface LineSource {
  readonly length: number;
  slice(from: number, to: number): string;
}

export interface LineIndexInit {
  readonly doc: DocumentHandle;
  readonly source: LineSource;
  /** Revisão/geração inicial só para carimbar `LineScanResult`. Default 1. */
  readonly generation?: number;
}

/** Granularidade da varredura em chunks (evita materializar o documento inteiro de uma vez). */
const SCAN_CHUNK = 64 * 1024;

/**
 * Índice de linhas de um documento. **Não** é thread-safe: pertence ao núcleo síncrono do
 * `TextStore`; quem quiser o resultado num worker usa `scan()` (que devolve `LineScanResult`
 * transferível, sem strings).
 */
export class LineIndex {
  private readonly docHandle: DocumentHandle;
  private readonly source: LineSource;
  private starts: number[] = [0];
  private computedUpTo = 0;
  private complete = false;
  private generationValue: number;

  constructor(init: LineIndexInit) {
    this.docHandle = init.doc;
    this.source = init.source;
    this.generationValue = init.generation ?? 1;
    this.complete = this.source.length === 0;
  }

  get doc(): DocumentHandle {
    return this.docHandle;
  }

  get generation(): number {
    return this.generationValue;
  }

  /** Offset conhecido mais alto do cache (offsets `[0, computedUpTo)` estão varridos). */
  get cachedUpTo(): number {
    return this.computedUpTo;
  }

  /** `true` quando o documento inteiro já está varrido e o cache não é parcial. */
  get isComplete(): boolean {
    return this.complete;
  }

  /** Número total de linhas — pode forçar uma varredura completa (cacheada). */
  lineCount(): number {
    this.ensureComputed(this.source.length);
    return this.starts.length;
  }

  /** Offset de início da linha `line`. `RangeError` se `line` não existe. */
  offsetAtLine(line: number): number {
    if (!Number.isInteger(line) || line < 0) {
      throw new RangeError(`LineIndex: linha inválida: ${line}`);
    }
    this.ensureComputed(this.source.length);
    const start = this.starts[line];
    if (start === undefined) {
      throw new RangeError(`LineIndex: linha fora do documento (0..${this.starts.length - 1}): ${line}`);
    }
    return start;
  }

  /** Linha que contém `offset` (0-based). `RangeError` se `offset` está fora do documento. */
  lineAt(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.source.length) {
      throw new RangeError(`LineIndex: offset fora do documento (0..${this.source.length}): ${offset}`);
    }
    this.ensureComputed(offset + 1);
    let low = 0;
    let high = this.starts.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const value = this.starts[mid];
      if (value !== undefined && value <= offset) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /**
   * Varre até `upto` (clampado ao documento) e devolve os inícios de linha encontrados.
   *
   * *escolha nossa:* `LineScanResult.lineCount` é o número de linhas **até o ponto varrido**
   * (igual a `lineStarts.length`); com `upto >= length` é a contagem total. Carimba a geração
   * corrente para que o consumidor descarte resultado obsoleto (DEC-CON-8).
   */
  scan(upto: number): LineScanResult {
    const limit = Math.min(Math.max(Math.trunc(upto), 0), this.source.length);
    this.ensureComputed(limit);
    const count = this.countUpTo(limit);
    const lineStarts = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) {
      lineStarts[i] = this.starts[i] ?? 0;
    }
    return {
      doc: this.docHandle,
      generation: this.generationValue,
      lineCount: count,
      lineStarts,
    };
  }

  /**
   * Ajusta o cache para um delta já aplicado à fonte. **Deve** ser chamado com os offsets
   * **antigos** do delta (`delta.from`, `delta.removed`) — o `source` já está mutado.
   */
  applyDelta(delta: TextDelta, generation: number): void {
    this.generationValue = generation;

    const from = delta.from;
    const removedLength = delta.removed.length;
    const to = from + removedLength;
    const shift = delta.inserted.length - removedLength;

    if (to <= this.computedUpTo) {
      this.spliceCache(from, to, delta.inserted, shift);
      this.computedUpTo += shift;
      return;
    }
    if (from >= this.computedUpTo) {
      // A edição começa depois do que já foi varrido: o prefixo permanece válido.
      return;
    }
    // A edição atravessa a fronteira do cache: só o que está antes de `from` continua confiável.
    this.truncateTo(from);
  }

  /** Descarta o cache e recomeça do zero (usado quando o conteúdo é trocado em bloco). */
  invalidate(): void {
    this.starts = [0];
    this.computedUpTo = 0;
    this.complete = this.source.length === 0;
  }

  /**
   * Recalcula a cauda do cache para uma edição contida na região já varrida:
   * mantém `starts <= from`, injeta os `\n` do texto inserido e desloca `starts > to` por `shift`.
   */
  private spliceCache(from: number, to: number, inserted: string, shift: number): void {
    const next: number[] = [];
    const starts = this.starts;
    let i = 0;
    while (i < starts.length) {
      const value = starts[i];
      if (value === undefined || value > from) break;
      next.push(value);
      i += 1;
    }
    let newlineAt = inserted.indexOf("\n");
    while (newlineAt !== -1) {
      next.push(from + newlineAt + 1);
      newlineAt = inserted.indexOf("\n", newlineAt + 1);
    }
    while (i < starts.length) {
      const value = starts[i];
      i += 1;
      if (value === undefined || value <= to) continue;
      next.push(value + shift);
    }
    this.starts = next;
  }

  /** Mantém apenas `starts <= from` e marca a região varrida como terminando em `from`. */
  private truncateTo(from: number): void {
    const next: number[] = [];
    for (const value of this.starts) {
      if (value > from) break;
      next.push(value);
    }
    this.starts = next;
    this.computedUpTo = from;
    this.complete = false;
  }

  /** Varre (em chunks) até `target`, sem nunca reprocessar o que já está cacheado. */
  private ensureComputed(target: number): void {
    const clamped = Math.min(Math.max(target, 0), this.source.length);
    if (this.complete || this.computedUpTo >= clamped) return;

    let cursor = this.computedUpTo;
    while (cursor < clamped) {
      const chunkEnd = Math.min(cursor + SCAN_CHUNK, this.source.length);
      const chunk = this.source.slice(cursor, chunkEnd);
      let newlineAt = chunk.indexOf("\n");
      while (newlineAt !== -1) {
        this.starts.push(cursor + newlineAt + 1);
        newlineAt = chunk.indexOf("\n", newlineAt + 1);
      }
      cursor = chunkEnd;
    }
    this.computedUpTo = cursor;
    if (this.computedUpTo >= this.source.length) this.complete = true;
  }

  /** Quantos inícios de linha são `<= limit` (busca binária; `starts` está ordenado). */
  private countUpTo(limit: number): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const value = this.starts[mid];
      if (value !== undefined && value <= limit) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }
}
