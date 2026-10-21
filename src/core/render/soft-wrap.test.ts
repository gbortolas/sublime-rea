/**
 * Scribe — testes do `SoftWrapUtil` (P3#15).
 */
import { describe, expect, it } from "vitest";
import {
  buildVisualRowMap,
  visualRowOf,
  VisualRowIndex,
  wrapLine,
  visualLineCount,
  resolveVisualLine,
  type VisualLineSource,
} from "./soft-wrap";

/** Mede largura: cada caractere = 10px, espaço = 5px. */
function measure(text: string): number {
  let w = 0;
  for (const ch of text) w += ch === " " ? 5 : 10;
  return w;
}

/** Fonte de linhas mínima (mesma forma de `LineSource`). */
function sourceOf(lines: readonly string[]): VisualLineSource {
  return {
    lineCount: (): number => lines.length,
    line: (index: number): string => lines[index] ?? "",
  };
}

describe("wrapLine", () => {
  it("texto vazio retorna segmento único vazio", () => {
    const segs = wrapLine("", 100, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("");
  });

  it("maxWidth <= 0 retorna a linha inteira como segmento único", () => {
    const segs = wrapLine("hello world", 0, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hello world");
  });

  it("linha curta que cabe não quebra", () => {
    const segs = wrapLine("hi", 100, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hi");
  });

  it("linha com espaço que cabe não é quebrada no espaço (early-exit)", () => {
    // "hello world" = 105px, maxWidth=200 → cabe inteira: **1** segmento.
    // (O render depende disso: sem o early-exit, linhas que cabem seriam quebradas
    //  no último espaço e desenhariam rows duplicadas.)
    const segs = wrapLine("hello world", 200, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hello world");
    expect(segs[0]!.start).toBe(0);
    expect(segs[0]!.end).toBe("hello world".length);
  });

  it("linha longa quebra por caractere quando não tem espaço", () => {
    // "abcdef" = 60px, maxWidth=25: quebra em "ab" (20px), "cd" (20px), "ef" (20px)
    const segs = wrapLine("abcdef", 25, measure);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    expect(segs[0]!.text.length).toBeLessThanOrEqual(3);
    const reconstructed = segs.map((s) => s.text).join("");
    expect(reconstructed).toBe("abcdef");
  });

  it("quebra em espaço quando possível", () => {
    // "hello world foo" = 50 + 5 + 50 + 5 + 30 = 140px, maxWidth=60
    // "hello" = 50 <= 60, "hello " = 55 <= 60, "hello w" = 65 > 60 → quebra no espaço
    const segs = wrapLine("hello world foo", 60, measure);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0]!.text).toBe("hello");
    // O segundo segmento não começa com espaço (os espaços são pulados)
    expect(segs[1]!.text.startsWith(" ")).toBe(false);
  });

  it("palavra maior que maxWidth ultrapassa (overflow)", () => {
    // "superlongword" = 130px, maxWidth=50 → quebra em 5 chars (50px) cada
    const segs = wrapLine("superlongword", 50, measure);
    expect(segs.length).toBe(3);
    expect(segs[0]!.text).toBe("super");
    expect(segs[1]!.text).toBe("longw");
    expect(segs[2]!.text).toBe("ord");
  });

  it("segmentos preservam o texto (espaços na fronteira são perdidos por design)", () => {
    // Espaços entre palavras na fronteira da quebra são pulados — é o comportamento esperado
    // para soft wrap (o espaço vira "invisível" no início da linha seguinte).
    const text = "the quick brown fox jumps over the lazy dog";
    const segs = wrapLine(text, 80, measure);
    const reconstructed = segs.map((s) => s.text).join("");
    // Espaços na fronteira entre "the" e "quick" são perdidos durante a quebra
    expect(reconstructed.replace(/^ +/, "").length).toBeGreaterThan(0);
    expect(reconstructed.includes("quick")).toBe(true);
  });
});

describe("visualLineCount", () => {
  const lines = ["short", "a very long line that should wrap quite a bit", "tiny"];

  it("sem wrap retorna lineCount", () => {
    expect(visualLineCount(3, (i) => lines[i] ?? "", 0, measure)).toBe(3);
  });

  it("com wrap retorna total de segmentos visuais", () => {
    const count = visualLineCount(3, (i: number) => lines[i] ?? "", 50, measure);
    // "short" = 50px, cabe (1)
    // "a very long line that should wrap quite a bit" = muito longa, várias quebras
    // "tiny" = 40px, cabe (1)
    expect(count).toBeGreaterThan(3);
  });
});

describe("resolveVisualLine", () => {
  const lines = ["abc", "def ghij klm"];

  it("retorna undefined para índice negativo", () => {
    expect(resolveVisualLine(-1, 2, (i: number) => lines[i] ?? "", 100, measure)).toBeUndefined();
  });

  it("retorna undefined para índice fora do range", () => {
    expect(resolveVisualLine(99, 2, (i: number) => lines[i] ?? "", 100, measure)).toBeUndefined();
  });

  it("resolve primeira linha visual", () => {
    const ref = resolveVisualLine(0, 2, (i: number) => lines[i] ?? "", 100, measure);
    expect(ref).toBeDefined();
    expect(ref!.docLine).toBe(0);
    expect(ref!.segment.text).toBe("abc");
  });
});

/* ─────────────────────────── malha visual (rows) ─────────────────────────── */

describe("buildVisualRowMap", () => {
  const lines = ["short", "abcdefghijklmnopqrstuvwxyz", "x"];

  it("sem wrap: 1 segmento por linha e a row é o índice lógico", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 0, measure);
    expect(map.segmentsOf(0)).toHaveLength(1);
    expect(map.segmentsOf(0)[0]?.row).toBe(0);
    expect(map.segmentsOf(1)[0]?.row).toBe(1);
    expect(map.segmentsOf(2)[0]?.row).toBe(2);
  });

  it("com wrap: 1 row por segmento", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure);
    const segs = map.segmentsOf(1);
    // 26 chars × 10px = 260px → 3 segmentos (10, 10, 6).
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.row)).toEqual([1, 2, 3]);
    expect(segs.map((s) => s.text)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    expect(segs.map((s) => s.start)).toEqual([0, 10, 20]);
  });

  it("a row de uma linha é a soma dos segmentos das linhas anteriores", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure);
    const segs0 = map.segmentsOf(0);
    const segs1 = map.segmentsOf(1);
    const segs2 = map.segmentsOf(2);
    expect(segs0).toHaveLength(1);
    expect(segs1[0]?.row).toBe(segs0.length);
    expect(segs2[0]?.row).toBe(segs0.length + segs1.length);
  });

  it("firstRow desloca a base da faixa (rolagem em rows visuais)", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure, { firstRow: 10 });
    expect(map.firstRow).toBe(10);
    expect(map.segmentsOf(0)[0]?.row).toBe(10);
    expect(map.segmentsOf(1)[0]?.row).toBe(11);
  });

  it("locate devolve a row do segmento e a coluna dentro dele", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure);
    // Coluna 15 → 2º segmento (rows 1..2), 5 colunas dentro dele.
    const loc = map.locate(1, 15);
    expect(loc?.row).toBe(2);
    expect(loc?.segmentOffset).toBe(10);
    expect(loc?.column).toBe(5);
    // Coluna 0 → 1º segmento.
    expect(map.locate(1, 0)?.row).toBe(1);
    expect(map.locate(1, 0)?.column).toBe(0);
  });

  it("linha colapsada: reserva 1 row, não é desenhada, mas ainda recebe destaque", () => {
    const collapsed = new Set([1]);
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure, { collapsedLines: collapsed });
    expect(map.segmentsOf(1)).toHaveLength(0);
    // A row reservada da linha colapsada é a mesma que ela ocuparia (1 row).
    expect(map.rowOfLine(1)).toBe(1);
    // A linha seguinte pula a row reservada.
    expect(map.segmentsOf(2)[0]?.row).toBe(2);
    // Mas o "paint" (caret/seleção/busca) ainda tem onde desenhar.
    expect(map.paintSegmentsOf(1)).toHaveLength(1);
    expect(map.paintSegmentsOf(1)[0]?.row).toBe(1);
  });

  it("linha fora da faixa não tem segmentos", () => {
    const map = buildVisualRowMap(sourceOf(lines), 1, 1, 100, measure);
    expect(map.segmentsOf(0)).toHaveLength(0);
    expect(map.locate(0, 0)).toBeUndefined();
  });
});

describe("visualRowOf", () => {
  const lines = ["short", "abcdefghijklmnopqrstuvwxyz", "x"];

  it("a row de uma linha = soma dos segmentos das linhas anteriores", () => {
    // Linha 0 → 1 row (50px cabe) · linha 1 → 3 rows (260px) ⇒ a linha 2 começa na row 4.
    expect(visualRowOf(sourceOf(lines), 1, 100, measure).row).toBe(1);
    expect(visualRowOf(sourceOf(lines), 2, 100, measure).row).toBe(4);
  });

  it("devolve o deslocamento dentro do segmento", () => {
    const loc = visualRowOf(sourceOf(lines), 1, 100, measure, 15);
    expect(loc.row).toBe(2);
    expect(loc.segmentOffset).toBe(10);
    expect(loc.column).toBe(5);
  });

  it("sem wrap: a row é o índice lógico e o segmento é a linha inteira", () => {
    const loc = visualRowOf(sourceOf(lines), 2, 0, measure, 1);
    expect(loc.row).toBe(2);
    expect(loc.segmentOffset).toBe(0);
    expect(loc.column).toBe(1);
  });
});

describe("VisualRowIndex", () => {
  const lines = ["short", "abcdefghijklmnopqrstuvwxyz", "x"];

  it("rowOfLine/lineOfRow são inversos", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.rowOfLine(0)).toBe(0);
    expect(index.rowOfLine(1)).toBe(1);
    expect(index.rowOfLine(2)).toBe(4);
    expect(index.rowCount).toBe(5);
    expect(index.lineOfRow(0)).toBe(0);
    expect(index.lineOfRow(1)).toBe(1);
    expect(index.lineOfRow(2)).toBe(1);
    expect(index.lineOfRow(3)).toBe(1);
    expect(index.lineOfRow(4)).toBe(2);
  });

  it("locate devolve a row e a coluna dentro do segmento", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    const loc = index.locate(1, 15);
    expect(loc?.row).toBe(2);
    expect(loc?.column).toBe(5);
  });

  it("invalidate descarta o cache a partir de uma linha", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.rowOfLine(2)).toBe(4);
    index.invalidate(1);
    expect(index.rowOfLine(2)).toBe(4);
  });

  it("linha inexistente não localiza nada", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.locate(99, 0)).toBeUndefined();
  });
});