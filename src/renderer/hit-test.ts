/**
 * Scribe — **hit-test do ponteiro** → (linha, coluna) na malha visual (soft wrap).
 *
 * ⚠️ **O bug que este módulo resolve**: com soft wrap, o clique numa **row visual**
 * (a 2ª linha de uma linha quebrada) caía na coluna **errada**. O `y` do ponteiro virava
 * row visual (e daí a linha lógica — certo), mas o `x` era medido **desde o início da
 * linha LÓGICA** ⇒ o clique na 2ª row apontava para a 1ª (`col = 4` quando o certo era
 * `23`).
 *
 * A fonte da verdade é o **render** (`src/core/render/scene.ts`):
 * - cada segmento é desenhado em `x = layout.paddingLeft` (a **mesma** origem x em toda
 *   row — o wrap **não** recua a indentação);
 * - o caret usa a coluna **dentro do segmento** (`scene.ts:691-695`);
 * - a seleção usa `from - seg.start` (`scene.ts:1027-1046`).
 *
 * ⇒ O inverso correto é:
 *
 * ```ts
 * column = seg.start + columnFromPointerX(x, seg.text.length, gutterWidth, charWidth);
 * ```
 *
 * ⚠️ O **clamp** é pela largura do **segmento** (`seg.text.length`), não pela da linha
 * lógica: o clique à direita da row dá o **fim do segmento** (não o fim da linha).
 *
 * Este módulo é **puro** (sem DOM, sem canvas, sem I/O): só geometria e aritmética ⇒
 * testável em `environment: "node"`.
 */

import type { VisualRowSegment } from "../core/render";
import { columnFromPointerX } from "./debug-inspect";

/* ───────────────────────────── geometria ───────────────────────────── */

/**
 * Geometria do texto (a mesma do desenho no canvas).
 *
 * - `gutterWidth`: a largura do gutter (números de linha) — a origem do texto é
 *   `gutterWidth + 8` (a mesma do `scene.ts`: `paddingLeft = gutter + 8`);
 * - `charWidth`: a largura **aproximada** de um caractere (px) — a mesma aproximação
 *   do hit-test antigo (`sizePx * 0.6`).
 */
export interface HitTestGeometry {
  /** Largura do gutter (px). */
  readonly gutterWidth: number;
  /** Largura aproximada de um caractere (px). */
  readonly charWidth: number;
}

/**
 * Fonte mínima de linhas (a mesma forma de `LineSource` do `scene.ts`).
 *
 * Só o texto é preciso — o hit-test não mexe no documento.
 */
export interface HitTestLineSource {
  /** Texto da linha lógica `line` (code units UTF-16). */
  line(index: number): string;
}

/**
 * Índice de rows visuais — a **forma mínima** que o hit-test consome.
 *
 * A classe `VisualRowIndex` (`src/core/render/soft-wrap.ts`) satisfaz esta interface
 * estruturalmente (nada a mudar nela).
 */
export interface VisualRowLocator {
  /** Linha lógica que **contém** a row visual `row` (nunca uma linha colapsada). */
  lineOfRow(row: number): number;
  /** Row visual da **1ª** row da linha lógica `line`. */
  rowOfLine(line: number): number;
  /** Segmentos (1 por row) da linha lógica `line`. */
  segmentsOf(line: number): readonly VisualRowSegment[];
}

/* ───────────────────────────── resultado ───────────────────────────── */

/** Onde o ponteiro caiu (em coordenadas de **linha lógica**). */
export interface PointerHit {
  /** Linha **lógica** (0-based) — a linha que contém a row clicada. */
  readonly line: number;
  /** Coluna **lógica** (code units UTF-16, dentro da linha). */
  readonly column: number;
  /** Índice do segmento de wrap dentro da linha (0 = 1º). */
  readonly segmentIndex: number;
  /** Offset (na linha) do início do segmento da row clicada. */
  readonly segmentStart: number;
}

/* ───────────────────────────── o hit-test ───────────────────────────── */

/**
 * Coluna **dentro de um segmento** (a mesma conta que o render usa).
 *
 * O `x` é a posição do ponteiro **relativa ao canvas** (o mesmo `x` do `mousedown`).
 */
export function columnWithinSegment(
  x: number,
  segment: VisualRowSegment,
  geometry: HitTestGeometry,
): number {
  const within = columnFromPointerX(
    x,
    segment.text.length,
    geometry.gutterWidth,
    geometry.charWidth,
  );
  return segment.start + within;
}

/**
 * **O hit-test**: a row visual + o `x` do ponteiro → (linha, coluna) **lógicos**.
 *
 * @param row Row **visual** (a row do canvas — a mesma que o `rowAtCanvasY` devolve).
 * @param locator Índice de rows visuais (`undefined` ⇒ fallback, ver abaixo).
 * @param source Fonte das linhas (só o texto é usado).
 * @param x X do ponteiro relativo ao canvas (px).
 * @param geometry Gutter + largura de caractere.
 *
 * ⚠️ **Fallback** (sem índice de rows — ainda não renderizou): o comportamento antigo —
 * a **row é a linha** e a coluna é medida **desde o início da linha**. Nada quebra.
 *
 * ⚠️ **Row fora dos segmentos da linha** (clique acima/depois do texto): a row é
 * **apertada** para a 1ª/última row da linha e a coluna é medida dentro dela — o caret
 * nunca sai da linha clicada.
 */
export function hitTestVisualRow(
  row: number,
  locator: VisualRowLocator | undefined,
  source: HitTestLineSource,
  x: number,
  geometry: HitTestGeometry,
): PointerHit {
  const { gutterWidth, charWidth } = geometry;

  // ── Fallback: sem índice de rows (o 1º render ainda não aconteceu) ──
  if (locator === undefined) {
    const line = row;
    const text = lineText(source, line);
    return {
      line,
      column: columnFromPointerX(x, text.length, gutterWidth, charWidth),
      segmentIndex: 0,
      segmentStart: 0,
    };
  }

  const line = locator.lineOfRow(row);
  const segments = locator.segmentsOf(line);
  if (segments.length === 0) {
    // Linha sem segmentos (colapsada pelo folding — não é desenhada): a coluna é medida
    // desde o início da linha (o comportamento antigo).
    const text = lineText(source, line);
    return {
      line,
      column: columnFromPointerX(x, text.length, gutterWidth, charWidth),
      segmentIndex: 0,
      segmentStart: 0,
    };
  }

  const segmentIndex = row - locator.rowOfLine(line);
  // Row acima/abaixo do texto da linha ⇒ aperta para a 1ª/última row da linha.
  const segment =
    segmentIndex < 0
      ? segments[0]
      : segmentIndex >= segments.length
        ? segments[segments.length - 1]
        : segmentAt(segments, segmentIndex);

  if (segment === undefined) {
    const text = lineText(source, line);
    return {
      line,
      column: columnFromPointerX(x, text.length, gutterWidth, charWidth),
      segmentIndex: 0,
      segmentStart: 0,
    };
  }

  return {
    line,
    column: columnWithinSegment(x, segment, geometry),
    segmentIndex: segment.segmentIndex,
    segmentStart: segment.start,
  };
}

/**
 * O segmento de wrap **n-ésimo** da linha (`undefined` se não existir).
 *
 * O índice do array **e** o `segmentIndex` do segmento são conferidos: o
 * `VisualRowIndex.segmentsOf` devolve o `row` **relativo** (0) — o que vale é o
 * `segmentIndex`.
 */
function segmentAt(
  segments: readonly VisualRowSegment[],
  segmentIndex: number,
): VisualRowSegment | undefined {
  const byIndex = segments[segmentIndex];
  if (byIndex !== undefined && byIndex.segmentIndex === segmentIndex) return byIndex;
  return segments.find((segment) => segment.segmentIndex === segmentIndex);
}

/**
 * Texto da linha (defensivo): uma linha fora do documento não pode derrubar o clique.
 */
function lineText(source: HitTestLineSource, line: number): string {
  try {
    return source.line(line) ?? "";
  } catch {
    return "";
  }
}
