/**
 * Testes do **hit-test do ponteiro** (soft wrap) — a reprodução medida do bug
 * "a 2ª row visual de uma linha quebrada não dá pra clicar/editar".
 *
 * O cenário é o **medido** (não um palpite):
 * - medidor: **8 px/char**;
 * - `wrapWidth = 160` ⇒ **20 chars/row**;
 * - linha de **159 chars** ⇒ 8 rows visuais;
 * - clique na **row 1** a **30 px** da origem do texto ⇒
 *   - **antes** (coluna medida desde o início da linha LÓGICA): `col = 4` — a row 0!;
 *   - **depois** (coluna medida dentro do segmento da row): `seg.start (19) + 4 = 23`.
 *
 * ⚠️ O módulo é **puro** (sem DOM/canvas) ⇒ roda em `environment: "node"`.
 */
import { describe, expect, it } from "vitest";

import { VisualRowIndex } from "../src/core/render";
import { columnFromPointerX, textOriginX } from "../src/renderer/debug-inspect";
import { hitTestVisualRow } from "../src/renderer/hit-test";

/** Medição determinística: 8 px por caractere (o wrap quebra a cada 20 chars). */
const measure = (text: string): number => text.length * 8;

/** Largura de wrap (px) ⇒ 20 chars por row. */
const WRAP_WIDTH = 160;

/** Largura aproximada de um caractere (px) — a mesma do `sizePx * 0.6` do renderer. */
const CHAR_WIDTH = 8;

/** Largura do gutter (px). */
const GUTTER_WIDTH = 48;

/**
 * Linha de 159 chars com um espaço no índice 18.
 *
 * ⇒ `wrapLine` quebra **antes** do espaço (`breakAt = 18`) e **pula** o espaço na
 * fronteira ⇒ a **row 1** começa na coluna **19** (e não 20).
 */
const WRAPPED_LINE = `${"a".repeat(18)} ${"b".repeat(140)}`;

/** Linhas do documento de teste (a 2ª linha é curta ⇒ 1 row). */
const LINES: readonly string[] = [WRAPPED_LINE, "segunda linha"];

const source = {
  lineCount: (): number => LINES.length,
  line: (index: number): string => LINES[index] ?? "",
};

const geometry = { gutterWidth: GUTTER_WIDTH, charWidth: CHAR_WIDTH };

/** Índice de rows visuais (o mesmo que o renderer monta). */
const index = new VisualRowIndex(source, WRAP_WIDTH, measure);

describe("hit-test do ponteiro — soft wrap", () => {
  it("a 2ª row visual: a coluna é a do SEGMENTO (não a da linha lógica)", () => {
    // 30 px ⇒ 4 caracteres (round(30 / 8) = 4).
    const x = textOriginX(GUTTER_WIDTH) + 30;

    const hit = hitTestVisualRow(1, index, source, x, geometry);

    // A linha lógica é a mesma (a row 1 pertence à linha 0) …
    expect(hit.line).toBe(0);
    // … mas a coluna é a **dentro do segmento da row** (19 + 4 = 23).
    expect(hit.segmentIndex).toBe(1);
    expect(hit.segmentStart).toBe(19);
    expect(hit.column).toBe(23);

    // ⚠️ O comportamento **antigo** (coluna desde o início da linha lógica) dava 4 — a
    // row 0. É esse o bug.
    expect(columnFromPointerX(x, WRAPPED_LINE.length, GUTTER_WIDTH, CHAR_WIDTH)).toBe(4);
  });

  it("a 1ª row: a coluna é medida desde o início da linha", () => {
    const x = textOriginX(GUTTER_WIDTH) + 30;

    const hit = hitTestVisualRow(0, index, source, x, geometry);

    expect(hit.line).toBe(0);
    expect(hit.segmentIndex).toBe(0);
    expect(hit.segmentStart).toBe(0);
    expect(hit.column).toBe(4);
  });

  it("à direita da row: o fim do SEGMENTO (não o fim da linha)", () => {
    const x = textOriginX(GUTTER_WIDTH) + 1000;

    const hit = hitTestVisualRow(1, index, source, x, geometry);

    // O segmento da row 1 tem 20 chars ⇒ o fim dele é 19 + 20 = 39 (a linha tem 159!).
    expect(hit.column).toBe(39);
    expect(hit.column).toBeLessThan(WRAPPED_LINE.length);
  });

  it("a última row: o fim da linha", () => {
    const x = textOriginX(GUTTER_WIDTH) + 1000;

    // A linha 0 ocupa 8 rows (0..7) ⇒ a row 7 é a última.
    const hit = hitTestVisualRow(7, index, source, x, geometry);

    expect(hit.line).toBe(0);
    expect(hit.segmentStart).toBe(139);
    expect(hit.column).toBe(WRAPPED_LINE.length);
  });

  it("a row da 2ª linha lógica: a coluna é medida desde o início dela", () => {
    const x = textOriginX(GUTTER_WIDTH) + 30;

    // A linha 0 ocupa 8 rows ⇒ a row 8 é a 1ª row da linha 1.
    const hit = hitTestVisualRow(8, index, source, x, geometry);

    expect(hit.line).toBe(1);
    expect(hit.segmentIndex).toBe(0);
    expect(hit.segmentStart).toBe(0);
    expect(hit.column).toBe(4);
  });

  it("sem índice de rows: o comportamento antigo (a row É a linha)", () => {
    const x = textOriginX(GUTTER_WIDTH) + 30;

    // Sem `VisualRowIndex` (o 1º render ainda não aconteceu) ⇒ a row é a linha e a
    // coluna é medida desde o início da linha — nada quebra.
    const hit = hitTestVisualRow(1, undefined, source, x, geometry);

    expect(hit.line).toBe(1);
    expect(hit.segmentIndex).toBe(0);
    expect(hit.segmentStart).toBe(0);
    expect(hit.column).toBe(columnFromPointerX(x, source.line(1).length, GUTTER_WIDTH, CHAR_WIDTH));
    expect(hit.column).toBe(4);
  });
});

describe("hit-test do ponteiro — o gap dos espaços pulados na quebra", () => {
  it("a coluna do espaço pulado na fronteira fica inacessível (como no render)", () => {
    // 2 espaços na fronteira ⇒ `wrapLine` quebra no 1º (breakAt = 19) e pula os dois
    // ⇒ a row 1 começa na coluna **20** e a coluna **19** (o 2º espaço) é um gap.
    const gapped = `${"a".repeat(18)}  ${"b".repeat(138)}`;
    const lines = [gapped];
    const gappedSource = {
      lineCount: (): number => lines.length,
      line: (i: number): string => lines[i] ?? "",
    };
    const gappedIndex = new VisualRowIndex(gappedSource, WRAP_WIDTH, measure);

    const farRight = textOriginX(GUTTER_WIDTH) + 1000;
    const last = hitTestVisualRow(0, gappedIndex, gappedSource, farRight, geometry);
    const next = hitTestVisualRow(1, gappedIndex, gappedSource, textOriginX(GUTTER_WIDTH), geometry);

    expect(last.column).toBe(19); // fim do segmento 0
    expect(next.column).toBe(20); // início do segmento 1
    // A coluna 19 (o espaço pulado) não é alcançável por nenhum dos dois lados.
    expect(last.column).not.toBe(20);
  });
});
