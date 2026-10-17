/**
 * `PieceTable` — núcleo **segmentado** de texto do Scribe (DEC-BUF-1).
 *
 * **Padrão observado a que corresponde:** o alvo modela o texto como um **núcleo anônimo
 * segmentado** — múltiplos buffers de heap mais um *array de registros* que os indexa
 * (`BUF-E5`, `BUF-E7`) —, sem Gap Buffer e sem Rope nomeados (`BUF-E2`). A família
 * **piece-table/segmentado** é a leitura `[INFERIDO]` daquela evidência. A topologia exata do
 * alvo (a semântica dos 11 pares `{begin,end}`) é `[DESCONHECIDO]` (`BUF-U1`), então **não** a
 * espelhamos: usamos a forma mínima que preserva as duas propriedades que a evidência sustenta
 * — **imutabilidade dos trechos antigos** e **leitura por mapeamento de span** (`BUF-E4`).
 *
 * **Contrato implementado** (escolha nossa, shape do scaffold — não observado no alvo):
 * - `original` — string **imutável**, só-leitura por definição (equivale ao arquivo carregado).
 * - `add` — buffer **append-only**; nunca reescreve trechos já existentes.
 * - `spans` — lista de `{start,end,inAdd}`; é a **única fonte de verdade da ordem** do documento.
 *
 * **Notas de implementação (marcadas como escolha nossa onde o doc `01` é omisso):**
 * - *escolha nossa:* spans adjacentes e contíguos no **mesmo** buffer são fundidos
 *   (`coalesce`). Isso mantém a tabela pequena em digitação sequencial sem alterar o texto.
 * - *escolha nossa:* `flushChunk()` é um no-op quando **não há trechos mortos** no `add`
 *   (evita churn inútil). O doc `01` só diz "consolida o buffer `add`".
 * - *escolha nossa:* `slice`/`replace` lançam `RangeError` para offsets fora de `[0,length]`.
 *   O doc não fixa o comportamento de erro.
 *
 * Nada aqui transcreve código do alvo: só nomes, contagens e papel arquitetural.
 */

/** Span de documento: intervalo semiaberto `[start,end)` em um dos buffers monotônicos. */
interface Span {
  readonly start: number;
  readonly end: number;
  /** `true` = buffer `add`; `false` = buffer `original`. */
  readonly inAdd: boolean;
}

/** Posição de um offset dentro da tabela de spans: índice + deslocamento local. */
interface SpanLocation {
  readonly index: number;
  readonly inner: number;
}

/**
 * Funde spans adjacentes e contíguos no mesmo buffer (mesmo texto, menos entradas).
 *
 * Cria sempre objetos novos ao fundir — nunca muta um `Span` já existente (os spans vivos podem
 * ser compartilhados entre a tabela antiga e a nova).
 * *escolha nossa* (o doc `01` não prescreve política de coalescência).
 */
function coalesce(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last !== undefined && last.inAdd === span.inAdd && last.end === span.start) {
      out[out.length - 1] = { start: last.start, end: span.end, inAdd: last.inAdd };
      continue;
    }
    out.push(span);
  }
  return out;
}

/**
 * Núcleo síncrono do `TextStore` (DEC-BUF-1/2). **Não** é a fronteira de thread — quem cruza
 * thread é o `TextStore` assíncrono; esta classe é interna ao módulo `buffer` (exportada para
 * teste, como o scaffold permite para a `PieceTable`).
 */
export class PieceTable {
  private readonly original: string;
  private add = "";
  private spans: Span[] = [];
  private totalLength = 0;

  constructor(original = "") {
    this.original = original;
    this.add = "";
    if (original.length > 0) {
      this.spans = [{ start: 0, end: original.length, inAdd: false }];
      this.totalLength = original.length;
    }
  }

  /** Comprimento do documento em code units UTF-16 (DEC-BUF-9). */
  get length(): number {
    return this.totalLength;
  }

  /** Quantidade de spans vivos — só para inspeção/teste. */
  get spanCount(): number {
    return this.spans.length;
  }

  /** Bytes vivos no buffer `add` (soma dos spans `inAdd`). */
  get addLength(): number {
    return this.add.length;
  }

  /** Bytes mortos no buffer `add` (não referenciados por nenhum span). Só para política/teste. */
  get deadAddLength(): number {
    return this.add.length - this.liveAddLength();
  }

  /** Materializa o documento percorrendo os spans — O(n). Não usar em laço quente. */
  text(): string {
    return this.slice(0, this.totalLength);
  }

  /** Lê `[from,to)` sem materializar o documento inteiro. `RangeError` fora de `[0,length]`. */
  slice(from: number, to: number): string {
    this.assertRange(from, to);
    if (from === to) return "";

    let out = "";
    let cursor = 0;
    for (const span of this.spans) {
      const spanLength = span.end - span.start;
      const spanStart = cursor;
      const spanEnd = cursor + spanLength;
      cursor = spanEnd;
      if (spanEnd <= from) continue;
      if (spanStart >= to) break;
      const localFrom = Math.max(from, spanStart) - spanStart;
      const localTo = Math.min(to, spanEnd) - spanStart;
      out += this.bufferOf(span).slice(span.start + localFrom, span.start + localTo);
    }
    return out;
  }

  /**
   * Substitui `[from,to)` por `inserted` **sem recopiar o documento**: divide os spans de borda,
   * descarta os spans cobertos e apenda `inserted` no buffer `add`.
   */
  replace(from: number, to: number, inserted: string): void {
    this.assertRange(from, to);
    if (from === to && inserted.length === 0) return;

    const spans = this.spans;
    const head = this.locate(from);
    const tail = this.locate(to);
    const next: Span[] = [];

    for (let i = 0; i < head.index; i += 1) {
      const span = spans[i];
      if (span !== undefined) next.push(span);
    }

    // Parte esquerda do span de `from`: `[start, start + inner)`.
    const headSpan = spans[head.index];
    if (headSpan !== undefined && head.inner > 0) {
      next.push({ start: headSpan.start, end: headSpan.start + head.inner, inAdd: headSpan.inAdd });
    }

    if (inserted.length > 0) {
      const start = this.add.length;
      this.add += inserted;
      next.push({ start, end: start + inserted.length, inAdd: true });
    }

    // Parte direita do span de `to`: `[start + inner, end)`.
    const tailSpan = spans[tail.index];
    if (tailSpan !== undefined && tail.inner < tailSpan.end - tailSpan.start) {
      next.push({ start: tailSpan.start + tail.inner, end: tailSpan.end, inAdd: tailSpan.inAdd });
    }

    for (let i = tail.index + 1; i < spans.length; i += 1) {
      const span = spans[i];
      if (span !== undefined) next.push(span);
    }

    this.spans = coalesce(next);
    this.totalLength = this.totalLength - (to - from) + inserted.length;
  }

  /**
   * Compacta o buffer `add`, descartando trechos mortos (regiões que nenhum span referencia).
   *
   * *escolha nossa:* remapeia os spans `inAdd` vivos para o novo buffer, em **ordem de
   * documento**, e funde os que ficam contíguos. Não toca em offsets absolutos do documento —
   * logo o `LineIndex` continua válido. No-op quando não há bytes mortos.
   */
  flushChunk(): void {
    if (this.add.length === 0) return;
    if (this.liveAddLength() === this.add.length) return;

    let compacted = "";
    const next: Span[] = [];
    for (const span of this.spans) {
      if (!span.inAdd) {
        next.push(span);
        continue;
      }
      const chunk = this.add.slice(span.start, span.end);
      const start = compacted.length;
      compacted += chunk;
      const candidate: Span = { start, end: start + chunk.length, inAdd: true };
      const last = next[next.length - 1];
      if (last !== undefined && last.inAdd && last.end === candidate.start) {
        next[next.length - 1] = { start: last.start, end: candidate.end, inAdd: true };
      } else {
        next.push(candidate);
      }
    }

    this.add = compacted;
    this.spans = next;
  }

  /** Bytes vivos no buffer `add` — O(spans). */
  private liveAddLength(): number {
    let live = 0;
    for (const span of this.spans) {
      if (span.inAdd) live += span.end - span.start;
    }
    return live;
  }

  private bufferOf(span: Span): string {
    return span.inAdd ? this.add : this.original;
  }

  /** Mapeia um offset absoluto para `{índice do span, deslocamento local}`. */
  private locate(offset: number): SpanLocation {
    let cursor = 0;
    const spans = this.spans;
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      if (span === undefined) continue;
      const spanLength = span.end - span.start;
      if (offset < cursor + spanLength) return { index: i, inner: offset - cursor };
      cursor += spanLength;
    }
    return { index: spans.length, inner: 0 };
  }

  private assertRange(from: number, to: number): void {
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new RangeError(`PieceTable: offsets devem ser inteiros (from=${from}, to=${to})`);
    }
    if (from < 0 || to < 0 || from > this.totalLength || to > this.totalLength) {
      throw new RangeError(`PieceTable: faixa fora de [0,${this.totalLength}]: [${from},${to})`);
    }
    if (from > to) {
      throw new RangeError(`PieceTable: from > to (${from} > ${to})`);
    }
  }
}
