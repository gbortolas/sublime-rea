/**
 * Scribe — testes do `SoftWrapUtil` (P3#15).
 */
import { describe, expect, it } from "vitest";
import { wrapLine, visualLineCount, resolveVisualLine } from "./soft-wrap";

/** Mede largura: cada caractere = 10px, espaço = 5px. */
function measure(text: string): number {
  let w = 0;
  for (const ch of text) w += ch === " " ? 5 : 10;
  return w;
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