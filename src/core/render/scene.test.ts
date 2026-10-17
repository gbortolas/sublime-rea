/**
 * Testes do `scene.ts`: só linhas visíveis viram instâncias (virtualização), tabs e caret.
 */
import { describe, expect, it } from "vitest";
import type { RGBA, Scope, ScopeStyle, SearchMatch, TextStyle, ThemeResolver } from "../../shared";
import { GlyphAtlas } from "./atlas";
import { buildInstances, type LineLayout, type LineSource, SEARCH_MATCH_COLOR, SEARCH_CURRENT_COLOR } from "./scene";

/** Resolvedor de tema mínimo local ao teste (evita import cruzado entre módulos de `core`). */
function prefixTheme(rules: Readonly<Record<string, RGBA>>): ThemeResolver {
  return {
    styleFor(scope: Scope): ScopeStyle | undefined {
      for (const [selector, color] of Object.entries(rules)) {
        if (scope === selector || scope.startsWith(`${selector}.`)) return { color };
      }
      return undefined;
    },
  };
}

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

describe("buildInstances — destaque por escopo", () => {
  const theme = prefixTheme({ keyword: 0xff0000ff as RGBA, string: 0x00ff00ff as RGBA });

  const spans = [
    { start: 0, end: 3, scope: "keyword.control" },
    { start: 3, end: 4, scope: "source.demo" },
    { start: 4, end: 7, scope: "string.quoted" },
  ];

  it("colore cada glifo pela cor do escopo e cai no default quando não há regra", () => {
    const atlas = new GlyphAtlas();
    const scene = buildInstances(
      sourceOf(["abc def"]),
      layout(0),
      atlas,
      style,
      { first: 0, count: 1 },
      undefined,
      { spansFor: (): typeof spans => spans, theme },
    );
    // "abc" (keyword) + "def" (string); o espaço em [3,4) não gera glifo.
    const colors = scene.glyphs.map((glyph) => glyph.color);
    expect(colors.slice(0, 3)).toEqual([0xff0000ff, 0xff0000ff, 0xff0000ff]);
    expect(colors.slice(3)).toEqual([0x00ff00ff, 0x00ff00ff, 0x00ff00ff]);
    expect(colors).not.toContain(layout(0).defaultColor);
  });

  it("sem highlighter, todos os glifos usam a cor default (retrocompatível)", () => {
    const atlas = new GlyphAtlas();
    const scene = buildInstances(sourceOf(["abc"]), layout(0), atlas, style, { first: 0, count: 1 });
    expect(scene.glyphs.every((glyph) => glyph.color === layout(0).defaultColor)).toBe(true);
  });

  it("um escopo sem regra de tema cai na cor default", () => {
    const atlas = new GlyphAtlas();
    const scene = buildInstances(
      sourceOf(["abc"]),
      layout(0),
      atlas,
      style,
      { first: 0, count: 1 },
      undefined,
      { spansFor: () => [{ start: 0, end: 3, scope: "text.plain" }], theme },
    );
    expect(scene.glyphs.every((glyph) => glyph.color === layout(0).defaultColor)).toBe(true);
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

describe("buildInstances — destaque de busca (P3.11)", () => {
  const atlas = new GlyphAtlas();
  const spaceAdvance = atlas.resolveGlyph(" ", style).advance;

  it("pinta rects nas posições dos matches e destaca o atual", () => {
    const matches: SearchMatch[] = [
      { index: 0, length: 3, line: 0, column: 0 },
      { index: 8, length: 3, line: 0, column: 8 },
      { index: 2, length: 5, line: 1, column: 2 },
    ];
    const scene = buildInstances(
      sourceOf(["abc def ghi", "0123456789"]),
      layout(0),
      atlas,
      style,
      { first: 0, count: 2 },
      undefined,
      undefined,
      { matches, currentIndex: 1 },
    );
    // Fundo (1) + 2 matches na linha 0 + 1 match na linha 1 = 4 rects
    expect(scene.rects).toHaveLength(4);
    // Match 0 (linha 0, offset 0-3): amarelo
    expect(scene.rects[1]?.color).toBe(SEARCH_MATCH_COLOR);
    expect(scene.rects[1]?.rect.y).toBe(4);
    expect(scene.rects[1]?.rect.x).toBeCloseTo(8, 5);
    // Match 1 (linha 0, offset 8-11): atual → magenta
    expect(scene.rects[2]?.color).toBe(SEARCH_CURRENT_COLOR);
    // Match 2 (linha 1, offset 2-7): amarelo
    expect(scene.rects[3]?.color).toBe(SEARCH_MATCH_COLOR);
    expect(scene.rects[3]?.rect.y).toBe(24);
  });

  it("ignora matches fora do range visível", () => {
    const matches: SearchMatch[] = [
      { index: 0, length: 1, line: 0, column: 0 },
      { index: 0, length: 1, line: 50, column: 0 },
    ];
    const scene = buildInstances(
      sourceOf(Array.from({ length: 100 }, (_, i) => `L${i}`)),
      layout(0),
      atlas,
      style,
      { first: 10, count: 3 },
      undefined,
      undefined,
      { matches, currentIndex: 0 },
    );
    // Fundo (1) + 0 matches visíveis (linha 0 e 50 estão fora do range [10,13))
    expect(scene.rects).toHaveLength(1);
  });

  it("posiciona match em linha com tab corretamente", () => {
    const matches: SearchMatch[] = [
      { index: 1, length: 1, line: 0, column: 1 },
    ];
    const scene = buildInstances(
      sourceOf(["\ta"]),
      layout(0),
      atlas,
      style,
      { first: 0, count: 1 },
      undefined,
      undefined,
      { matches, currentIndex: -1 },
    );
    // Tab expandido: paddingLeft(8) + 4 * spaceAdvance(4 tabs)
    const expectedX = 8 + 4 * spaceAdvance;
    expect(scene.rects).toHaveLength(2); // fundo + match
    expect(scene.rects[1]?.rect.x).toBeCloseTo(expectedX, 5);
    expect(scene.rects[1]?.rect.w).toBeCloseTo(atlas.resolveGlyph("a", style).advance, 5);
  });

  it("sem searchHighlight é retrocompatível (rects só com fundo)", () => {
    const scene = buildInstances(
      sourceOf(["abc"]),
      layout(0),
      atlas,
      style,
      { first: 0, count: 1 },
    );
    expect(scene.rects).toHaveLength(1);
    expect(scene.rects[0]?.color).toBe(0x1e1f22ff);
  });
});
