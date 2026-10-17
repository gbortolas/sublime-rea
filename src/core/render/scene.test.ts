/**
 * Testes do `scene.ts`: só linhas visíveis viram instâncias (virtualização), tabs e caret.
 */
import { describe, expect, it } from "vitest";
import type { TextStyle } from "../../shared";
import { GlyphAtlas } from "./atlas";
import { buildInstances, type LineLayout, type LineSource } from "./scene";

const style: TextStyle = { family: "mono", sizePx: 16, weight: 400, italic: false };

function sourceOf(lines: readonly string[]): LineSource {
  return {
    lineCount: (): number => lines.length,
    line: (index: number): string => lines[index] ?? "",
  };
}

function layout(scrollOffsetPx = 0): LineLayout {
  return {
    lineHeight: 20,
    paddingLeft: 8,
    paddingTop: 4,
    tabWidth: 4,
    scrollOffsetPx,
    viewport: { x: 0, y: 0, w: 400, h: 100 },
    background: 0x1e1f22ff,
    defaultColor: 0xd4d4d4ff,
  };
}

describe("buildInstances — virtualização", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
  const atlas = new GlyphAtlas();

  it("só gera glifos das linhas do range visível", () => {
    const scene = buildInstances(sourceOf(lines), layout(200), atlas, style, { first: 10, count: 3 });
    // "L10L11L12" = 9 caracteres não-espaço.
    expect(scene.glyphs).toHaveLength(9);
    const ys = [...new Set(scene.glyphs.map((g) => g.y))].sort((a, b) => a - b);
    expect(ys).toEqual([4, 24, 44]);
  });

  it("range vazio não gera glifos, mas mantém o fundo", () => {
    const scene = buildInstances(sourceOf(lines), layout(0), atlas, style, { first: 0, count: 0 });
    expect(scene.glyphs).toHaveLength(0);
    expect(scene.rects).toHaveLength(1);
    expect(scene.rects[0]?.rect).toEqual({ x: 0, y: 0, w: 400, h: 100 });
  });

  it("é determinístico para a mesma entrada", () => {
    const a = buildInstances(sourceOf(lines), layout(40), atlas, style, { first: 2, count: 4 });
    const b = buildInstances(sourceOf(lines), layout(40), atlas, style, { first: 2, count: 4 });
    expect(b).toEqual(a);
  });

  it("espaços não geram glifos", () => {
    const scene = buildInstances(sourceOf(["a b c"]), layout(0), atlas, style, { first: 0, count: 1 });
    expect(scene.glyphs).toHaveLength(3);
  });

  it("tab avança até o próximo stop sem gerar glifo", () => {
    const scene = buildInstances(sourceOf(["\ta"]), layout(0), atlas, style, { first: 0, count: 1 });
    expect(scene.glyphs).toHaveLength(1);
    const spaceAdvance = atlas.resolveGlyph(" ", style).advance;
    expect(scene.glyphs[0]?.x).toBeCloseTo(8 + 4 * spaceAdvance, 5);
  });
});

describe("buildInstances — caret", () => {
  it("desenha o caret como RectInstance quando dentro do range", () => {
    const atlas = new GlyphAtlas();
    const scene = buildInstances(sourceOf(["hello", "world"]), layout(0), atlas, style, { first: 0, count: 2 }, {
      line: 1,
      column: 3,
      color: 0xffffffff,
      width: 2,
    });
    expect(scene.rects).toHaveLength(2);
    expect(scene.rects[1]?.color).toBe(0xffffffff);
    expect(scene.rects[1]?.rect.h).toBe(20);
    expect(scene.rects[1]?.rect.y).toBe(24);
  });

  it("ignora o caret fora do range", () => {
    const atlas = new GlyphAtlas();
    const scene = buildInstances(sourceOf(["a", "b", "c"]), layout(0), atlas, style, { first: 0, count: 1 }, {
      line: 5,
      column: 0,
      color: 0xffffffff,
      width: 2,
    });
    expect(scene.rects).toHaveLength(1);
  });
});
