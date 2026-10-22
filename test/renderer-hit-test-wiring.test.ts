/**
 * Scribe — a **fiação** do hit-test do ponteiro no renderer (o bug 4).
 *
 * ## O bug
 *
 * Com **soft wrap**, o clique numa **row visual** (a 2ª linha de uma linha quebrada) caía na
 * coluna **errada**: o `y` do ponteiro virava row visual (e daí a linha lógica — certo), mas o
 * `x` era medido **desde o início da linha LÓGICA** ⇒ o clique na 2ª row apontava para a 1ª.
 *
 * ## O que este arquivo prova
 *
 * 1. **Estático** (o `main.ts` como texto — o mesmo truque da auditoria da casca): os **4 call
 *    sites** (o `mousedown` do caret, o **arrasto** da seleção, o **hover do LSP** e o **hover
 *    do DAP**) usam o `hitTestVisualRow`, e o `columnFromPointerX` (a conta antiga, sem wrap)
 *    **saiu** do renderer.
 * 2. **Comportamental**: a **composição** que o renderer faz (a `rowAtCanvasY` exportada + o
 *    `VisualRowIndex` + o `hitTestVisualRow`) dá a coluna **do segmento** — e não a da linha
 *    lógica.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VisualRowIndex } from "../src/core/render";
import { columnFromPointerX, textOriginX } from "../src/renderer/debug-inspect";
import { hitTestVisualRow } from "../src/renderer/hit-test";
import { rowAtCanvasY } from "../src/renderer/main";

const REPO_ROOT = join(__dirname, "..");
const MAIN_PATH = join(REPO_ROOT, "src", "renderer", "main.ts");

/* ── A geometria **real** do renderer (o `TEXT_STYLE`/`TEXT_PADDING_TOP_PX` do `main.ts`) ── */

/** O `sizePx` do texto do editor (`TEXT_STYLE.sizePx`). */
const SIZE_PX = 15;
/** A altura da linha (`ceil(sizePx * 1.4)`). */
const LINE_HEIGHT = Math.ceil(SIZE_PX * 1.4);
/** A largura aproximada de um caractere (`sizePx * 0.6`). */
const CHAR_WIDTH = SIZE_PX * 0.6;
/** O padding vertical acima da 1ª linha (`TEXT_PADDING_TOP_PX`). */
const PADDING_TOP = 8;
/** A largura do gutter (px). */
const GUTTER_WIDTH = 48;

/** A medição determinística (9 px por caractere — a mesma do `charWidth`). */
const measure = (text: string): number => text.length * CHAR_WIDTH;

/** A largura de wrap (px) ⇒ 20 caracteres por row. */
const WRAP_WIDTH = 20 * CHAR_WIDTH;

/**
 * Uma linha com um **espaço** no índice 18.
 *
 * ⇒ o `wrapLine` quebra **antes** do espaço e o **pula** na fronteira ⇒ a **row 1** começa na
 * coluna **19** (e não 20).
 */
const WRAPPED_LINE = `${"a".repeat(18)} ${"b".repeat(40)}`;

/** As linhas do documento de teste (a 2ª linha é curta ⇒ 1 row). */
const LINES: readonly string[] = [WRAPPED_LINE, "segunda linha"];

const source = {
  lineCount: (): number => LINES.length,
  line: (index: number): string => LINES[index] ?? "",
};

/** O índice de rows visuais (o mesmo que o renderer monta). */
const index = new VisualRowIndex(source, WRAP_WIDTH, measure);

describe("hit-test — a fiação no renderer", () => {
  it("os 4 call sites usam o `hitTestVisualRow` (o caret, o arrasto, o hover do LSP e o do DAP)", () => {
    const source_ = readFileSync(MAIN_PATH, "utf8");
    const calls = source_.match(/hitTestVisualRow\(/g) ?? [];
    // 4 call sites: o `mousedown` (o caret), o **arrasto**, o **hover do LSP** e o **hover do DAP**.
    expect(calls.length).toBe(4);
  });

  it("a conta antiga (`columnFromPointerX`) saiu do renderer", () => {
    const source_ = readFileSync(MAIN_PATH, "utf8");
    expect(source_).not.toContain("columnFromPointerX");
  });

  it("o renderer expõe a row visual e o locator (o hit-test precisa dos dois)", () => {
    const source_ = readFileSync(MAIN_PATH, "utf8");
    // A **row** (e não a linha): a coluna é medida dentro do segmento da row.
    expect(source_).toContain("rowAtCanvasY(y: number): number");
    // O **locator** (o índice de rows visuais) — `undefined` ⇒ o hit-test degrada.
    expect(source_).toContain("visualRowLocator(): VisualRowLocator | undefined");
  });

  it("a composição do renderer dá a coluna do SEGMENTO (a row quebrada)", () => {
    // O clique na **2ª row** (o centro da 2ª faixa de linha).
    const y = PADDING_TOP + LINE_HEIGHT * 1.5;
    const row = rowAtCanvasY(y, 0, LINE_HEIGHT, PADDING_TOP);
    expect(row).toBe(1);

    // 30 px dentro do texto ⇒ round(30 / 9) = 3 caracteres.
    const x = textOriginX(GUTTER_WIDTH) + 30;
    const hit = hitTestVisualRow(row, index, source, x, {
      gutterWidth: GUTTER_WIDTH,
      charWidth: CHAR_WIDTH,
    });

    // A linha lógica é a mesma (a row 1 pertence à linha 0) …
    expect(hit.line).toBe(0);
    // … mas a coluna é a **dentro do segmento da row** (19 + 3 = 22).
    expect(hit.segmentIndex).toBe(1);
    expect(hit.segmentStart).toBe(19);
    expect(hit.column).toBe(22);

    // ⚠️ O comportamento **antigo** (a coluna desde o início da linha lógica) dá 3 — a row 0.
    // É esse o bug que a fiação mata.
    expect(columnFromPointerX(x, WRAPPED_LINE.length, GUTTER_WIDTH, CHAR_WIDTH)).toBe(3);
  });
});
