/**
 * Scribe — `SoftWrapUtil`: quebra visual de linha (P3#15).
 *
 * O soft wrap **não** modifica o texto no buffer — só muda como ele é exibido.
 * Cada linha de documento pode gerar N "segmentos visuais" (wrap segments),
 * cada um cabendo dentro de `wrapWidth` px.
 *
 * Uso:
 * ```ts
 * const segments = wrapLine(text, wrapWidth, measureText);
 * for (const seg of segments) { /* desenha seg.text na posição y += seg.y * lineHeight *\/ }
 * ```
 *
 * A medição de texto é injetada — o `GlyphAtlas.resolveGlyph(rune, style).advance`
 * é quem responde, mas o soft wrap só precisa de `textWidth(text): number`.
 */


/** Um segmento de linha quebrada: sub-string + largura em px. */
export interface WrapSegment {
  /** Offset inicial no texto original (code units UTF-16). */
  readonly start: number;
  /** Offset final (exclusive). */
  readonly end: number;
  /** O texto do segmento (substring). */
  readonly text: string;
  /** Largura em px. */
  readonly width: number;
}

/* ───────────────────────────── malha visual (rows) ───────────────────────────── */

/**
 * Fonte mínima de linhas — a mesma forma de `LineSource` (do `scene.ts`), declarada aqui
 * porque o `soft-wrap` **não** pode depender do `scene` (import circular: `scene` → `soft-wrap`).
 */
export interface VisualLineSource {
  lineCount(): number;
  line(index: number): string;
}

/**
 * Um segmento de wrap **posicionado** na malha visual: a row que ele ocupa e o intervalo
 * (code units UTF-16) que ele cobre dentro do texto da linha.
 */
export interface VisualRowSegment {
  /** Row visual (índice absoluto da row, contando as rows de wrap das linhas anteriores). */
  readonly row: number;
  /** Índice do segmento dentro da linha lógica (0 = primeiro). */
  readonly segmentIndex: number;
  /** Offset (code units UTF-16) do início do segmento no texto da linha. */
  readonly start: number;
  /** Offset (code units UTF-16) do fim do segmento (exclusive). */
  readonly end: number;
  /** Texto do segmento (`line.slice(start, end)`). */
  readonly text: string;
}

/**
 * Onde um offset (coluna) cai na malha visual de uma linha lógica.
 */
export interface VisualRowInfo {
  /** Row visual do segmento que contém o offset. */
  readonly row: number;
  /** Offset (code units UTF-16) do início do segmento dentro da linha. */
  readonly segmentOffset: number;
  /** Coluna (code units UTF-16) do offset **dentro** do segmento. */
  readonly column: number;
  /** Índice do segmento dentro da linha lógica. */
  readonly segmentIndex: number;
}

/**
 * Range **dobrável** (forma estrutural) — o `FoldRange` do `scene.ts` é compatível com esta
 * forma (tem campos a mais, que são ignorados aqui).
 *
 * Vive no `soft-wrap` (e não no `scene`) para o `soft-wrap` **não** depender do `scene`
 * (import circular: `scene` → `soft-wrap`).
 */
export interface CollapsibleRange {
  /** 1ª linha do bloco dobrável (0-based) — a linha que **permanece** visível. */
  readonly startLine: number;
  /** Última linha do bloco dobrável (0-based, inclusive). */
  readonly endLine: number;
  /** `true` quando o bloco está dobrado (as linhas internas não são desenhadas). */
  readonly isCollapsed: boolean;
}

/* ─────────────────────── regra única de rows (folding × soft wrap) ─────────────────────── */

/**
 * **REGRA ÚNICA DE ROWS** (vale para a cena `scene.ts` **e** para o índice `VisualRowIndex`):
 *
 * - uma linha **colapsada** (dentro de um bloco dobrado) **não é desenhada** e **não ocupa
 *   row** — **0 rows**;
 * - uma linha **visível** ocupa `N` rows (`N` = nº de segmentos de wrap; `1` sem soft wrap);
 * - a **1ª** linha do bloco dobrado (a que fica visível, com o indicador `▸`) é uma linha
 *   visível ⇒ conta normalmente.
 *
 * Consequências (as que o bug de "folding × soft wrap" viola):
 * - `rowCount` = soma das rows das linhas **não** colapsadas;
 * - as linhas **abaixo** da dobra **sobem** `N−1` rows (N = rows que a linha dobrada ocuparia);
 * - `lineOfRow(row)` **nunca** devolve uma linha colapsada (ela não tem row).
 *
 * ⚠️ A regra tem de ser **a mesma** nos dois lados: se a cena desenhar N rows e o índice
 * contar N+1, a contagem publicada (scroll/"line count") não bate com o texto desenhado.
 *
 * ── Como saber se uma linha está colapsada (a forma **canônica**) ──────────────────────────
 *
 * `isCollapsed(line)` é a **única** forma de perguntar "esta linha está colapsada?" — é
 * barata (O(1)), idempotente e não depende do escopo (documento × faixa).
 *
 * ⚠️ **Por que importa**: `rowOfLine(linhaColapsada)` devolve a row que a linha **ocuparia**
 * (a row da **próxima** linha visível — a colapsada ocupa 0 rows, mas a API de rows é
 * numérica e não tem como devolver "nenhuma"). Um consumidor que chame `rowOfLine` sem
 * perguntar antes `isCollapsed` **cai na linha seguinte** (é o que acontecia com a âncora
 * de popup e com o ícone de diagnóstico).
 *
 * Os dois `rowOfLine` do módulo têm **escopos diferentes** (e estão documentados):
 * - o do **índice** (`VisualRowIndex.rowOfLine`) — escopo **documento**: devolve a row
 *   **absoluta**; para uma linha colapsada, a row que ela ocuparia;
 * - o da **malha da faixa** (`VisualRowMap.rowOfLine`) — escopo **faixa**: devolve
 *   `undefined` para uma linha colapsada (nela não há nada a desenhar).
 */

/**
 * Linhas **colapsadas** (folding) a partir dos ranges dobráveis.
 *
 * Uma linha colapsada **não é desenhada** e **não ocupa row** (0 rows — a regra única acima).
 * A 1ª linha do bloco dobrado **permanece visível** (é ela que recebe o indicador `▸`).
 */
export function collapsedLinesOf(folding: readonly CollapsibleRange[] | undefined): ReadonlySet<number> {
  const collapsed = new Set<number>();
  if (folding === undefined) return collapsed;
  for (const fr of folding) {
    if (!fr.isCollapsed) continue;
    // A 1ª linha do bloco permanece visível (com o indicador ▸) — as **internas** somem.
    for (let line = fr.startLine + 1; line <= fr.endLine; line++) collapsed.add(line);
  }
  return collapsed;
}

/**
 * Aplica o **folding** a um índice de rows e devolve o conjunto de linhas colapsadas.
 *
 * É o ponto de entrada do renderer: a contagem de rows (`rowCount`) só é correta **depois**
 * que o folding chegou ao índice — por isso o renderer chama isto **antes** de publicar a
 * contagem de rows (e antes de montar a cena).
 *
 * ⚠️ **Ordem**: publicar `rowCount` antes desta chamada ⇒ a contagem sai com as rows da
 * linha dobrada ainda reservadas (a divergência de N−1 rows do bug "folding × soft wrap").
 *
 * - **idempotente**: chamar com o mesmo folding não invalida nada (`setCollapsedLines`
 *   compara o conteúdo dos conjuntos);
 * - **barata**: O(nº de linhas colapsadas) — nada é re-quebrado, nada é re-medido;
 * - o único efeito observável é o estado do índice (que é justamente o objetivo).
 */
export function applyCollapsedLines(
  index: VisualRowIndexLike | undefined,
  folding: readonly CollapsibleRange[] | undefined,
): ReadonlySet<number> {
  const collapsed = collapsedLinesOf(folding);
  index?.setCollapsedLines?.(collapsed);
  return collapsed;
}

/** Opções de `buildVisualRowMap`. */
export interface VisualRowMapOptions {
  /**
   * Row visual da **primeira** linha da faixa.
   * Default: `firstLine` (ancoragem legada — a row base da primeira linha visível é o seu
   * índice lógico). Só faz sentido com soft wrap (`wrapWidth > 0`).
   */
  readonly firstRow?: number;
  /**
   * Linhas **colapsadas** (folding): não são desenhadas e **não ocupam row** (0 rows — a
   * regra única de rows do render). As linhas seguintes da faixa **sobem** na mesma quantidade
   * de rows que a linha colapsada ocuparia.
   */
  readonly collapsedLines?: ReadonlySet<number>;
}

/**
 * Malha visual de uma **faixa** de linhas lógicas: para cada linha, os segmentos de wrap com a
 * row que cada um ocupa.
 *
 * É a unidade de trabalho do render: o `buildInstances` calcula a malha **uma vez** por frame
 * (O(faixa visível)) e reusa-a para o texto, o gutter, o caret, a seleção e a busca.
 */
export interface VisualRowMap {
  /** Primeira linha lógica da faixa. */
  readonly firstLine: number;
  /** Row visual da primeira linha lógica da faixa. */
  readonly firstRow: number;
  /**
   * Segmentos **desenháveis** de uma linha da faixa.
   *
   * Vazio se a linha está **colapsada** (folding: 0 rows — a regra única) ou fora da faixa.
   */
  segmentsOf(line: number): readonly VisualRowSegment[];
  /**
   * Row (primeira) de uma linha da faixa — `undefined` se a linha está **colapsada**
   * (ela não tem row **na faixa** — não há nada a desenhar nela) ou fora da faixa.
   *
   * ⚠️ Escopo **faixa**: o `rowOfLine` do **índice** (`VisualRowIndex`) tem escopo
   * **documento** e devolve a row que a linha ocuparia (a da próxima visível) para uma
   * colapsada. A forma **canônica** de saber se a linha está colapsada é `isCollapsed`.
   */
  rowOfLine(line: number): number | undefined;
  /** Localiza um offset (coluna) dentro de uma linha da faixa. */
  locate(line: number, column: number): VisualRowInfo | undefined;
}

const EMPTY_SEGMENTS: readonly VisualRowSegment[] = [];

/** Conjunto vazio de linhas colapsadas (sentinela — nunca mutado). */
const EMPTY_COLLAPSED: ReadonlySet<number> = new Set<number>();

/** `true` se os dois conjuntos de linhas colapsadas têm o mesmo conteúdo. */
function sameCollapsedSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const line of a) if (!b.has(line)) return false;
  return true;
}

/**
 * Constrói a malha visual de uma faixa de linhas lógicas.
 *
 * ⚠️ **Custo**: O(nº de linhas da faixa) — **não** O(documento). A row visual de uma linha depende
 * de quantos segmentos as linhas *anteriores* têm; por isso a faixa começa numa row base
 * conhecida (`options.firstRow`) e o resto é acumulado a partir dali.
 *
 * @param source Fonte das linhas.
 * @param firstLine Primeira linha lógica da faixa.
 * @param count Nº de linhas da faixa.
 * @param wrapWidth Largura de wrap (px). `≤ 0` = sem wrap (1 row por linha lógica).
 * @param measure Medidor de largura (obrigatório só quando `wrapWidth > 0`).
 * @param options Row base da faixa + linhas colapsadas.
 */
export function buildVisualRowMap(
  source: VisualLineSource,
  firstLine: number,
  count: number,
  wrapWidth: number,
  measure: ((text: string) => number) | undefined,
  options?: VisualRowMapOptions,
): VisualRowMap {
  const first = Math.max(0, firstLine);
  const last = first + Math.max(0, count);
  const collapsed = options?.collapsedLines;
  const firstRow = options?.firstRow ?? first;
  // Sem wrap (ou sem medidor) cada linha ocupa exatamente 1 row.
  const wrap = wrapWidth > 0 && measure !== undefined;
  const meas: (text: string) => number = measure ?? ((): number => 0);

  const byLine = new Map<number, VisualRowSegment[]>();
  let row = firstRow;

  for (let line = first; line < last; line++) {
    // Linha **colapsada** (folding): não é desenhada e **não ocupa row** (0 rows).
    if (collapsed !== undefined && collapsed.has(line)) continue;
    const text = source.line(line);
    if (!wrap) {
      byLine.set(line, [{ row, segmentIndex: 0, start: 0, end: text.length, text }]);
      row += 1;
      continue;
    }
    const segs = wrapLine(text, wrapWidth, meas);
    const mapped: VisualRowSegment[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      mapped.push({ row: row + i, segmentIndex: i, start: seg.start, end: seg.end, text: seg.text });
    }
    byLine.set(line, mapped);
    row += mapped.length;
  }

  return {
    firstLine: first,
    firstRow,
    segmentsOf: (line: number): readonly VisualRowSegment[] => byLine.get(line) ?? EMPTY_SEGMENTS,
    rowOfLine: (line: number): number | undefined => byLine.get(line)?.[0]?.row,
    locate: (line: number, column: number): VisualRowInfo | undefined => {
      const segs = byLine.get(line);
      if (segs === undefined || segs.length === 0) return undefined;
      return locateInSegments(segs, column);
    },
  };
}

/**
 * Índice de **rows visuais** (forma mínima) — a classe `VisualRowIndex` implementa esta forma.
 *
 * A cena (`scene.ts`) usa esta forma para reusar os segmentos já quebrados (e em cache)
 * sem depender da classe concreta.
 */
export interface VisualRowIndexLike {
  /** Row visual da 1ª row da linha lógica `line`. */
  rowOfLine(line: number): number;
  /** Segmentos de uma linha (1 por row; a row de cada um é relativa à linha). */
  segmentsOf(line: number): readonly VisualRowSegment[];
  /**
   * Declara as linhas colapsadas (folding) — o índice passa a **não contar row** para cada
   * uma delas (a regra única: linha colapsada = 0 rows). Opcional: um índice que não sabe
   * de folding funciona (a cena usa a contagem dele mesmo assim).
   */
  setCollapsedLines?(lines: ReadonlySet<number> | undefined): void;
  /**
   * `true` se a linha está **colapsada** (folding) — logo, ela **não ocupa row** (0 rows).
   *
   * É a forma **canônica** de saber se uma linha está colapsada: barata (O(1)),
   * idempotente e independente do escopo (documento × faixa).
   *
   * ⚠️ **Por que existe**: `rowOfLine(linhaColapsada)` devolve a row que a linha
   * **ocuparia** (a da próxima visível) — quem só chama `rowOfLine` **cai na linha
   * seguinte**. Quem precisa saber "esta linha está colapsada?" pergunta aqui.
   *
   * Opcional na interface (como `setCollapsedLines`): um índice que não sabe de folding
   * funciona — a cena usa o próprio conjunto de colapsadas nesse caso.
   */
  isCollapsed?(line: number): boolean;
}

/**
 * Constrói a malha visual de uma faixa **reusando** os segmentos já quebrados (e em cache)
 * de um `VisualRowIndex`.
 *
 * ⚠️ **Por quê**: `buildVisualRowMap` **re-quebra** as linhas da faixa a cada frame (custo
 * O(faixa)) — mas o índice já guardou os mesmos segmentos. Reusá-los tira a quebra do
 * caminho por frame (o índice só re-quebra quando o texto ou a largura muda).
 *
 * A contagem de rows é a do **índice** (que conhece as linhas colapsadas) ⇒ a cena e o
 * índice concordam sobre onde cada linha está.
 *
 * @param index Índice de rows (a fonte da contagem).
 * @param firstLine Primeira linha lógica da faixa.
 * @param count Nº de linhas da faixa.
 * @param collapsedLines Linhas colapsadas (folding) — **0 rows**, não são desenhadas.
 */
export function buildVisualRowMapFromIndex(
  index: VisualRowIndexLike,
  firstLine: number,
  count: number,
  collapsedLines?: ReadonlySet<number>,
): VisualRowMap {
  const first = Math.max(0, firstLine);
  const last = first + Math.max(0, count);
  const byLine = new Map<number, VisualRowSegment[]>();

  for (let line = first; line < last; line++) {
    // Linha **colapsada** (folding): 0 rows, não é desenhada. O conjunto de colapsadas é a
    // **autoridade** aqui (o índice pode nem saber de folding).
    if (collapsedLines !== undefined && collapsedLines.has(line)) continue;
    const base = index.rowOfLine(line);
    const segs = index.segmentsOf(line);
    const mapped: VisualRowSegment[] = [];
    for (const seg of segs) {
      mapped.push({
        row: base + seg.segmentIndex,
        segmentIndex: seg.segmentIndex,
        start: seg.start,
        end: seg.end,
        text: seg.text,
      });
    }
    byLine.set(line, mapped);
  }

  return {
    firstLine: first,
    firstRow: index.rowOfLine(first),
    segmentsOf: (line: number): readonly VisualRowSegment[] => byLine.get(line) ?? EMPTY_SEGMENTS,
    rowOfLine: (line: number): number | undefined => byLine.get(line)?.[0]?.row,
    locate: (line: number, column: number): VisualRowInfo | undefined => {
      const segs = byLine.get(line);
      if (segs === undefined || segs.length === 0) return undefined;
      return locateInSegments(segs, column);
    },
  };
}

/**
 * Localiza um offset (coluna) dentro dos segmentos de uma linha.
 *
 * Regra: o offset cai no **último** segmento cujo início é ≤ o offset; se o offset está numa
 * lacuna (espaço pulado na quebra), ele fica no fim do segmento anterior.
 */
function locateInSegments(segs: readonly VisualRowSegment[], column: number): VisualRowInfo {
  let index = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (column < seg.start) break;
    index = i;
    if (column < seg.end) break;
  }
  const seg = segs[index]!;
  return {
    row: seg.row,
    segmentOffset: seg.start,
    column: Math.max(0, Math.min(column, seg.end) - seg.start),
    segmentIndex: seg.segmentIndex,
  };
}

/**
 * Row visual de uma linha lógica (e do offset dentro dela).
 *
 * ⚠️ **Custo**: O(linhas até `line`) — a row de uma linha depende de quantos segmentos as
 * linhas anteriores têm. **Não** chame isto por linha a cada quadro: use `buildVisualRowMap`
 * (faixa visível) ou `VisualRowIndex` (cache incremental).
 *
 * @param source Fonte das linhas.
 * @param line Linha lógica (0-based).
 * @param wrapWidth Largura de wrap (px). `≤ 0` = sem wrap.
 * @param measure Medidor de largura.
 * @param column Offset (code units UTF-16) dentro da linha. Default: `0`.
 */
export function visualRowOf(
  source: VisualLineSource,
  line: number,
  wrapWidth: number,
  measure: (text: string) => number,
  column = 0,
): VisualRowInfo {
  const total = source.lineCount();
  const target = Math.max(0, Math.min(line, Math.max(0, total - 1)));
  let row = 0;
  for (let i = 0; i < target; i++) {
    row += wrapWidth > 0 ? wrapLine(source.line(i), wrapWidth, measure).length : 1;
  }
  const segs: VisualRowSegment[] =
    wrapWidth > 0
      ? wrapLine(source.line(target), wrapWidth, measure).map((seg, i) => ({
          row: row + i,
          segmentIndex: i,
          start: seg.start,
          end: seg.end,
          text: seg.text,
        }))
      : [{ row, segmentIndex: 0, start: 0, end: source.line(target).length, text: source.line(target) }];
  return locateInSegments(segs, column);
}

/**
 * Índice **incremental** de rows visuais: cacheia a row inicial de cada linha já visitada.
 *
 * O cálculo ingênuo (`visualRowOf`) é O(documento) por chamada — inviável por quadro. Este
 * índice faz o trabalho total em O(documento) **uma vez** e responde O(1) amortizado depois
 * (a row de uma linha já visitada é um `array` lookup).
 *
 * O renderer mantém um índice por documento e o invalida quando o texto muda.
 */
export class VisualRowIndex {
  private readonly source: VisualLineSource;
  private readonly wrapWidth: number;
  private readonly measure: (text: string) => number;
  /** Row visual no início de cada linha (crescente). `rowStarts[0] = 0`. */
  private readonly rowStarts: number[] = [0];
  /** Segmentos por linha (cacheados; no máximo `segmentCacheLimit` linhas). */
  private readonly segmentCache = new Map<number, readonly VisualRowSegment[]>();
  /** Linhas colapsadas (folding) — **0 rows** (a regra única de rows). */
  private collapsedLines: ReadonlySet<number> | undefined;

  /** Nº máximo de linhas com segmentos em cache (memória × simplicity). */
  static readonly segmentCacheLimit = 512;

  constructor(
    source: VisualLineSource,
    wrapWidth: number,
    measure: (text: string) => number,
  ) {
    this.source = source;
    this.wrapWidth = wrapWidth;
    this.measure = measure;
  }

  /**
   * Declara as linhas **colapsadas** (folding) — cada uma delas passa a ocupar **0 rows**
   * (a regra única: uma linha colapsada não é desenhada e não conta).
   *
   * Sem isso, a contagem de rows do índice diverge da cena quando há dobra: o texto abaixo
   * da dobra "sobe" (ou desce) rows e a barra de rolagem deixa de bater com o texto.
   *
   * Trocar o conjunto invalida o cache a partir da **primeira linha afetada** (as rows
   * antes dela continuam válidas). Chamar com o **mesmo** conjunto é um no-op (idempotente).
   */
  setCollapsedLines(lines: ReadonlySet<number> | undefined): void {
    const next = lines ?? EMPTY_COLLAPSED;
    const prev = this.collapsedLines ?? EMPTY_COLLAPSED;
    if (sameCollapsedSet(prev, next)) return;
    let first = Number.POSITIVE_INFINITY;
    for (const line of next) if (!prev.has(line) && line < first) first = line;
    for (const line of prev) if (!next.has(line) && line < first) first = line;
    this.collapsedLines = lines === undefined ? undefined : next;
    if (Number.isFinite(first)) this.invalidate(first);
  }

  /**
   * Row visual da **primeira** row da linha lógica `line` (absolute no documento).
   *
   * ⚠️ Uma linha **colapsada** não tem row (0 rows): o valor devolvido é a row da **próxima**
   * linha visível (a colapsada ocupa a mesma row que ela) — isto é, a row que a linha
   * **ocuparia** se estivesse visível.
   *
   * Para saber se a linha está colapsada, use `isCollapsed(line)` (a forma **canônica**):
   * só `rowOfLine` não diz nada — o número devolvido é o da linha seguinte.
   */
  rowOfLine(line: number): number {
    const total = this.source.lineCount();
    const target = Math.max(0, Math.min(line, total));
    this.ensureRows(target);
    return this.rowStarts[target] ?? 0;
  }

  /**
   * Total de rows visuais do documento = soma das rows das linhas **não** colapsadas
   * (as colapsadas ocupam 0 rows — a regra única).
   */
  get rowCount(): number {
    return this.rowOfLine(this.source.lineCount());
  }

  /**
   * Linha lógica que contém a row visual `row`.
   *
   * ⚠️ Uma linha **colapsada** não tem row ⇒ ela **nunca** é devolvida: quando a busca cai
   * numa linha colapsada, ela avança até a próxima linha **visível** (que começa na mesma
   * row — a colapsada ocupa 0 rows). Com isso, `lineOfRow(rowOfLine(L)) === L` para toda
   * linha **visível** `L`.
   */
  lineOfRow(row: number): number {
    const total = this.source.lineCount();
    this.ensureRows(total);
    let lo = 0;
    let hi = total;
    // Último `i` com `rowStarts[i] <= row`.
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((this.rowStarts[mid] ?? 0) <= row) lo = mid;
      else hi = mid - 1;
    }
    // As linhas colapsadas (0 rows) compartilham a row com a linha visível seguinte ⇒ a
    // busca avança até ela (a colapsada nunca "possui" uma row).
    let line = lo;
    while (line < total && this.isCollapsed(line)) line += 1;
    if (line >= total) {
      // Row fora do documento (ou documento terminando em colapsadas): a última linha
      // **visível**.
      line = total - 1;
      while (line >= 0 && this.isCollapsed(line)) line -= 1;
      if (line < 0) line = 0;
    }
    return line;
  }

  /**
   * Segmentos (com row) de uma linha.
   *
   * Uma linha **colapsada** (folding) **não tem segmentos** (`[]`): ela não é desenhada e
   * não ocupa row — a mesma regra da cena (`scene.ts`).
   */
  segmentsOf(line: number): readonly VisualRowSegment[] {
    const cached = this.segmentCache.get(line);
    if (cached !== undefined) return cached;
    const text = this.source.line(line);
    // Linha **colapsada** (folding): 0 segmentos ⇒ 0 rows (a regra única de rows).
    const segs: VisualRowSegment[] = this.isCollapsed(line)
      ? []
      : this.wrapWidth > 0
        ? wrapLine(text, this.wrapWidth, this.measure).map((seg, i) => ({
            row: 0,
            segmentIndex: i,
            start: seg.start,
            end: seg.end,
            text: seg.text,
          }))
        : [{ row: 0, segmentIndex: 0, start: 0, end: text.length, text }];
    this.cacheSegments(line, segs);
    return segs;
  }

  /** Localiza um offset (coluna) dentro de uma linha lógica. */
  locate(line: number, column: number): VisualRowInfo | undefined {
    const total = this.source.lineCount();
    if (line < 0 || line >= total) return undefined;
    const base = this.rowOfLine(line);
    const segs = this.segmentsOf(line).map((seg) => ({ ...seg, row: base + seg.segmentIndex }));
    if (segs.length === 0) return undefined;
    return locateInSegments(segs, column);
  }

  /**
   * Invalida o cache a partir de `fromLine` (use quando o texto muda).
   * Sem argumento, invalida tudo.
   *
   * ⚠️ O **prefixo** é preservado: as linhas `0..fromLine-1` não mudaram (o texto delas é
   * o mesmo) e suas rows continuam válidas — só as linhas `>= fromLine` são descartadas.
   */
  invalidate(fromLine = 0): void {
    const keep = Math.max(0, Math.min(fromLine, this.rowStarts.length - 1));
    this.rowStarts.length = keep + 1;
    // Só as linhas `>= fromLine` podem ter segmentos obsoletos — o prefixo fica em cache.
    for (const line of [...this.segmentCache.keys()]) {
      if (line >= fromLine) this.segmentCache.delete(line);
    }
  }

  /** Garante que `rowStarts` cobre as linhas `0..upto`. */
  private ensureRows(upto: number): void {
    while (this.rowStarts.length <= upto) {
      const line = this.rowStarts.length - 1;
      const segs = this.segmentsOf(line);
      const next = (this.rowStarts[line] ?? 0) + segs.length;
      this.rowStarts.push(next);
    }
  }

  /**
   * `true` se a linha está **colapsada** (folding) — logo, **não ocupa row** (0 rows).
   *
   * É a forma **canônica** de saber se uma linha está colapsada: **barata** (O(1) — o
   * conjunto de colapsadas já está em cache), **idempotente** e sem efeito colateral
   * (não invalida nada, não re-quebra nada).
   *
   * ⚠️ Use-a **antes** de `rowOfLine`: o `rowOfLine` de uma linha colapsada devolve a row
   * que ela ocuparia (a da próxima visível) ⇒ quem só chama `rowOfLine` cai na linha
   * seguinte.
   */
  isCollapsed(line: number): boolean {
    return this.collapsedLines !== undefined && this.collapsedLines.has(line);
  }

  /** Cacheia os segmentos de uma linha (respeitando o limite de memória). */
  private cacheSegments(line: number, segs: readonly VisualRowSegment[]): void {
    if (this.segmentCache.size >= VisualRowIndex.segmentCacheLimit) this.segmentCache.clear();
    this.segmentCache.set(line, segs);
  }
}

/**
 * Quebra visual: divide o `texto` em segmentos que cabem em `maxWidth` px.
 *
 * Regras:
 * - Se um segmento couber inteiro, não quebra.
 * - A quebra é **oportunista**: tenta quebrar no último espaço antes de estourar.
 * - Sem espaço antes do estouro, quebra no caractere (glifo a glifo).
 * - Palavras mais largas que `maxWidth` **ultrapassam** (padrão Web: overflow).
 *
 * @param text Texto da linha do documento.
 * @param maxWidth Largura máxima em px (wrapWidth). `≤ 0` = sem quebra.
 * @param measureWidth Largura em px de um trecho de texto (deve bater com o atlas).
 * @returns Array de segmentos (`[]` se texto vazio, `[texto]` se maxWidth ≤ 0 ou couber).
 */
export function wrapLine(
  text: string,
  maxWidth: number,
  measureWidth: (text: string) => number,
): WrapSegment[] {
  if (text.length === 0 || maxWidth <= 0) {
    return [{ start: 0, end: text.length, text, width: measureWidth(text) }];
  }

  const segments: WrapSegment[] = [];
  let start = 0;

  while (start < text.length) {
    // Encontra o maior prefixo que cabe em maxWidth
    const rest = text.slice(start);
    const fullWidth = measureWidth(rest);
    if (fullWidth <= maxWidth) {
      // Cabe tudo
      segments.push({ start, end: text.length, text: rest, width: fullWidth });
      break;
    }

    // Busca binária: maior offset que ainda cabe
    let lo = 1;
    let hi = rest.length;
    let fit = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const w = measureWidth(rest.slice(0, mid));
      if (w <= maxWidth) {
        fit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (fit <= 0) {
      // Mesmo um caractere não cabe? overflow: pega 1 caractere (ou o espaço `maxWidth` não
      // é maior que o glifo mais largo — situação rara mas possível com fontes decorativas).
      fit = 1;
    }

    // Tenta quebrar em espaço (oportunista): volta para o último espaço em `fit`.
    // A quebra em espaço só é considerada se tiver espaço no segmento e se o espaço
    // não é o primeiro caractere.
    let breakAt = fit;
    const lastSpace = rest.lastIndexOf(" ", fit - 1);
    if (lastSpace > 0) {
      // Verifica se quebrar no espaço reduz a largura significativamente
      // (só quebra se não for a última palavra do segmento)
      if (fit - lastSpace <= 20) {
        breakAt = lastSpace; // quebra antes do espaço
      }
    }

    // Se `breakAt` for 0, avança 1 para evitar loop infinito
    if (breakAt <= 0) breakAt = 1;

    const segmentText = rest.slice(0, breakAt);
    segments.push({
      start,
      end: start + breakAt,
      text: segmentText,
      width: measureWidth(segmentText),
    });

    start += breakAt;
    // Pula espaços no início do próximo segmento (exceto se for o único conteúdo)
    while (start < text.length && text[start] === " ") {
      start += 1;
    }
  }

  return segments;
}

/**
 * Contagem total de linhas visuais para um `LineSource`.
 * Usado pelo viewport para calcular a altura de scroll correta.
 */
export function visualLineCount(
  lineCount: number,
  lineAt: (index: number) => string,
  maxWidth: number,
  measureWidth: (text: string) => number,
): number {
  if (maxWidth <= 0) return lineCount;
  let count = 0;
  for (let i = 0; i < lineCount; i++) {
    count += wrapLine(lineAt(i), maxWidth, measureWidth).length;
  }
  return count;
}

/**
 * Mapeia uma linha visual (índice absoluto entre todas as linhas visuais)
 * para a linha de documento + segmento de wrap correspondente.
 * Útil para caret navigation, scroll, gutter.
 */
export interface VisualLineRef {
  readonly docLine: number;
  readonly segmentIndex: number;
  readonly segment: WrapSegment;
  /** Offset inicial do segmento no texto original (code units UTF-16). */
  readonly startOffset: number;
}

/**
 * Encontra a linha visual `visualIndex` (0-based, absoluta) no documento.
 * Percorre as linhas de documento até acumular `visualIndex` segmentos.
 * Retorna `undefined` se o índice estiver fora do range.
 */
export function resolveVisualLine(
  visualIndex: number,
  lineCount: number,
  lineAt: (index: number) => string,
  maxWidth: number,
  measureWidth: (text: string) => number,
): VisualLineRef | undefined {
  if (visualIndex < 0) return undefined;
  let accumulated = 0;
  for (let docLine = 0; docLine < lineCount; docLine++) {
    const segments = wrapLine(lineAt(docLine), maxWidth, measureWidth);
    if (visualIndex < accumulated + segments.length) {
      const segIdx = visualIndex - accumulated;
      const seg = segments[segIdx]!;
      return { docLine, segmentIndex: segIdx, segment: seg, startOffset: seg.start };
    }
    accumulated += segments.length;
  }
  return undefined;
}