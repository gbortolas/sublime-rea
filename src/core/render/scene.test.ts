/**
 * Testes do `scene.ts`: só linhas visíveis viram instâncias (virtualização), tabs e caret.
 */
import { describe, expect, it } from "vitest";
import type { RGBA, Scope, ScopeStyle, SearchMatch, Selection, TextStyle, ThemeResolver } from "../../shared";
import { GlyphAtlas } from "./atlas";
import {
  buildInstances,
  type CaretPosition,
  type LineLayout,
  type LineSource,
  type SceneInstances,
  type SearchHighlight,
} from "./scene";

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
    positionAt(offset: number): { line: number; column: number } {
      let remaining = offset;
      for (let i = 0; ; i++) {
        const len = this.line(i).length;
        if (remaining <= len) return { line: i, column: remaining };
        remaining -= len + 1;
      }
    },
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
    gutterWidth: 0,
    gutterBackground: 0x2b2d30ff,
    gutterColor: 0x6e6e6eff,
    scrollbarWidth: 0,
    scrollbarTrack: 0x00000000,
    scrollbarThumb: 0x00000000,
    searchMatchColor: 0xffff0044,
    searchCurrentColor: 0xff880088,
    selectionColor: 0x264f78ff,
    bracketMatchColor: 0xffffffff,
    wrapWidth: 0,
  };
}

/** Layout com soft wrap ativo (`wrapWidth > 0`). */
function wrapLayout(wrapWidth: number, scrollOffsetPx = 0): LineLayout {
  return { ...layout(scrollOffsetPx), wrapWidth };
}

/**
 * `buildInstances` com `measureWidth` injetado (13º parâmetro da assinatura).
 * A medição é determinística (10px por caractere) e independente do atlas.
 */
function buildWithMeasure(
  source: LineSource,
  lineLayout: LineLayout,
  atlas: GlyphAtlas,
  range: { first: number; count: number },
  measure: (text: string) => number,
  extras?: {
    readonly caret?: CaretPosition;
    readonly search?: SearchHighlight;
    readonly selection?: Selection;
    readonly extraCarets?: readonly CaretPosition[];
  },
): SceneInstances {
  return buildInstances(
    source,
    lineLayout,
    atlas,
    style,
    range,
    extras?.caret,
    undefined, // highlight
    extras?.search,
    extras?.selection,
    extras?.extraCarets,
    undefined, // extraSelections
    undefined, // bracketMatch
    measure,
  );
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
    expect(scene.rects).toHaveLength(3);
    expect(scene.rects[2]?.color).toBe(0xffffffff);
    expect(scene.rects[2]?.rect.h).toBe(20);
    expect(scene.rects[2]?.rect.y).toBe(24);
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
    expect(scene.rects[1]?.color).toBe(0xffff0044); // SEARCH_MATCH_COLOR
    expect(scene.rects[1]?.rect.y).toBe(4);
    expect(scene.rects[1]?.rect.x).toBeCloseTo(8, 5);
    // Match 1 (linha 0, offset 8-11): atual → magenta
    expect(scene.rects[2]?.color).toBe(0xff880088); // SEARCH_CURRENT_COLOR
    // Match 2 (linha 1, offset 2-7): amarelo
    expect(scene.rects[3]?.color).toBe(0xffff0044); // SEARCH_MATCH_COLOR
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

describe("buildInstances — soft wrap (row visual)", () => {
  const atlas = new GlyphAtlas();
  /** Medição determinística: 10px por caractere. */
  const measure = (text: string): number => text.length * 10;

  it("linha que cabe na largura não é quebrada (1 segmento, 1 row)", () => {
    const scene = buildWithMeasure(
      sourceOf(["hello world"]),
      wrapLayout(200),
      atlas,
      { first: 0, count: 1 },
      measure,
    );
    // "hello world" = 11 chars (110px) — cabe em 200px: 10 glifos, **uma** row.
    expect(scene.glyphs).toHaveLength(10);
    expect([...new Set(scene.glyphs.map((g) => g.y))]).toEqual([4]);
  });

  it("linha longa quebra em N segmentos com rows distintas e crescentes", () => {
    const scene = buildWithMeasure(
      sourceOf(["abcdefghijklmnopqrstuvwxyz"]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
    );
    // 26 chars = 260px → segmentos de 10, 10 e 6 chars → rows 0, 1, 2.
    expect(scene.glyphs).toHaveLength(26);
    expect([...new Set(scene.glyphs.map((g) => g.y))]).toEqual([4, 24, 44]);
  });

  it("linhas lógicas consecutivas não compartilham row (sem overlap)", () => {
    const scene = buildWithMeasure(
      sourceOf(["abcdefghijklmnopqrstuvwxyz", "XYZ"]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 2 },
      measure,
    );
    // Linha 0 → rows 0,1,2 · linha 1 → row 3. Cada row é exclusiva de um segmento.
    expect([...new Set(scene.glyphs.map((g) => g.y))]).toEqual([4, 24, 44, 64]);
    // Ys monótonos na ordem de desenho.
    const ys = scene.glyphs.map((g) => g.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("invariante: rows contíguas, sem buracos e sem repetição entre linhas", () => {
    const lines = [
      "short",
      "uma linha bem mais longa que precisa quebrar em varios segmentos",
      "x",
      "outra linha longa para forcar mais um wrap no meio do range",
    ];
    const scene = buildWithMeasure(
      sourceOf(lines),
      wrapLayout(120),
      atlas,
      { first: 0, count: lines.length },
      measure,
    );
    const rows = [...new Set(scene.glyphs.map((g) => g.y))].sort((a, b) => a - b);
    // Row visual r ⇒ Y = paddingTop + r * lineHeight (contíguas, sem colisão).
    rows.forEach((y, i) => {
      expect(y).toBe(4 + i * 20);
    });
    // Monótono na ordem de desenho.
    const ys = scene.glyphs.map((g) => g.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("o texto da linha quebrada é preservado (nenhum caractere perdido)", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const scene = buildWithMeasure(
      sourceOf([text]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
    );
    // 1 glifo por caractere (26) — a quebra só muda o Y, nunca o conteúdo.
    expect(scene.glyphs).toHaveLength(text.length);
    // Cada um dos 3 segmentos recomeça em x = paddingLeft.
    expect(scene.glyphs.filter((g) => g.x === 8)).toHaveLength(3);
  });

  it("visualRowOffset desloca a row base da primeira linha visível", () => {
    const scene = buildWithMeasure(
      sourceOf(["abc", "def"]),
      { ...wrapLayout(100), visualRowOffset: 10 },
      atlas,
      { first: 0, count: 2 },
      measure,
    );
    // Row base 10 → Y = paddingTop + 10 * lineHeight = 204; a linha seguinte → 224.
    expect([...new Set(scene.glyphs.map((g) => g.y))]).toEqual([204, 224]);
  });
});

describe("buildInstances — soft wrap (caret/seleção/busca na row certa)", () => {
  const atlas = new GlyphAtlas();
  /** Medição determinística: 10px por caractere (o wrap quebra a cada 10 chars). */
  const measure = (text: string): number => text.length * 10;
  /** 26 chars × 10px = 260px → 3 segmentos de 10/10/6 (rows 0, 1, 2). */
  const long = "abcdefghijklmnopqrstuvwxyz";

  it("caret na 2ª metade da linha quebrada fica na row do segmento (não na 1ª)", () => {
    const scene = buildWithMeasure(
      sourceOf([long]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
      { caret: { line: 0, column: 15, color: 0xffffffff, width: 2 } },
    );
    const caretRect = scene.rects.find((r) => r.color === 0xffffffff);
    // Row 1 (0-based) = 2ª row visual → Y = paddingTop(4) + 1 * lineHeight(20) = 24.
    expect(caretRect?.rect.y).toBe(24);
    // X = início do 2º segmento + 5 colunas dentro dele.
    expect(caretRect?.rect.x).toBeCloseTo(8 + 5 * 9.6, 5);
  });

  it("caret no início do 2º segmento fica no começo da 2ª row", () => {
    const scene = buildWithMeasure(
      sourceOf([long]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
      { caret: { line: 0, column: 10, color: 0xffffffff, width: 2 } },
    );
    const caretRect = scene.rects.find((r) => r.color === 0xffffffff);
    expect(caretRect?.rect.y).toBe(24);
    expect(caretRect?.rect.x).toBeCloseTo(8, 5);
  });

  it("seleção dentro de uma linha quebrada é desenhada no segmento certo", () => {
    const scene = buildWithMeasure(
      sourceOf([long]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
      { selection: { anchor: 12, active: 15 } },
    );
    const sel = scene.rects.find((r) => r.color === 0x264f78ff);
    // Colunas 12..14 → 2º segmento (row 1): X = paddingLeft + 2 colunas, W = 2 colunas.
    expect(sel?.rect.y).toBe(24);
    expect(sel?.rect.x).toBeCloseTo(8 + 2 * 9.6, 5);
    expect(sel?.rect.w).toBeCloseTo(2 * 9.6, 5);
  });

  it("seleção que atravessa segmentos gera um rect por segmento", () => {
    const scene = buildWithMeasure(
      sourceOf([long]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
      { selection: { anchor: 8, active: 13 } },
    );
    const sels = scene.rects.filter((r) => r.color === 0x264f78ff);
    expect(sels).toHaveLength(2);
    // 1º segmento: cols 8..10 (row 0) · 2º segmento: cols 10..12 (row 1).
    expect(sels[0]?.rect.y).toBe(4);
    expect(sels[0]?.rect.x).toBeCloseTo(8 + 8 * 9.6, 5);
    expect(sels[0]?.rect.w).toBeCloseTo(2 * 9.6, 5);
    expect(sels[1]?.rect.y).toBe(24);
    expect(sels[1]?.rect.x).toBeCloseTo(8, 5);
    expect(sels[1]?.rect.w).toBeCloseTo(2 * 9.6, 5);
  });

  it("match da busca fica na row do segmento que o contém", () => {
    const scene = buildWithMeasure(
      sourceOf([long]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
      {
        search: {
          matches: [{ index: 12, length: 3, line: 0, column: 12 }],
          currentIndex: -1,
        },
      },
    );
    const match = scene.rects.find((r) => r.color === 0xffff0044);
    expect(match?.rect.y).toBe(24);
    expect(match?.rect.x).toBeCloseTo(8 + 2 * 9.6, 5);
    expect(match?.rect.w).toBeCloseTo(3 * 9.6, 5);
  });

  it("gutter: o número da linha fica na 1ª row da linha (não na última)", () => {
    const scene = buildWithMeasure(
      sourceOf([long, "zz"]),
      { ...wrapLayout(100), gutterWidth: 30 },
      atlas,
      { first: 0, count: 2 },
      measure,
    );
    // Glifos por row: a linha 0 ocupa 3 rows (10 + 10 + 6 chars) e a linha 1 ocupa a row 3.
    // O número do gutter é o 1º glifo de cada linha ⇒ a row 0 tem 11 glifos (1 + 10) e a
    // row 3 tem 3 (1 + 2).
    const byRow = new Map<number, number>();
    for (const g of scene.glyphs) byRow.set(g.y, (byRow.get(g.y) ?? 0) + 1);
    expect([...byRow.entries()]).toEqual([
      [4, 11],
      [24, 10],
      [44, 6],
      [64, 3],
    ]);
  });

  it("destaque de linha atual acompanha a row do caret", () => {
    const scene = buildWithMeasure(
      sourceOf([long]),
      wrapLayout(100),
      atlas,
      { first: 0, count: 1 },
      measure,
      { caret: { line: 0, column: 15, color: 0xffffffff, width: 2 } },
    );
    // O fundo da "linha atual" (cor 0x264f78ff+8% de luz) fica na row do caret.
    const lineHighlight = scene.rects.find((r) => r.color === 623258111);
    expect(lineHighlight?.rect.y).toBe(24);
  });

  it("scrollbar: o thumb é proporcional ao total de rows visuais", () => {
    const base = { ...wrapLayout(100, 50), scrollbarWidth: 10 };
    const withRows = buildWithMeasure(
      sourceOf([long]),
      { ...base, totalVisualRows: 10 },
      atlas,
      { first: 0, count: 1 },
      measure,
    );
    // 10 rows × 20px = 200px de conteúdo, viewport de 100px ⇒ thumb de 50px, na metade.
    // (O track da scrollbar é o 1º rect em x = 390; o thumb é o último.)
    const thumb = withRows.rects.filter((r) => r.rect.x === 390).at(-1);
    expect(thumb?.rect.h).toBeCloseTo(50, 5);
    expect(thumb?.rect.y).toBeCloseTo(25, 5);
    // Sem `totalVisualRows` (1 row por linha lógica) o conteúdo cabe na viewport: sem thumb.
    const withoutRows = buildWithMeasure(sourceOf([long]), base, atlas, { first: 0, count: 1 }, measure);
    expect(withoutRows.rects.filter((r) => r.rect.x === 390)).toHaveLength(1); // só o track
  });
});

describe("buildInstances — regressão sem wrap (wrapWidth = 0)", () => {
  const atlas = new GlyphAtlas();
  const measure = (text: string): number => text.length * 10;

  it("caret, seleção e busca: mesmas instâncias do baseline (sem wrap)", () => {
    const scene = buildWithMeasure(
      sourceOf(["abc def", "0123456789"]),
      layout(0),
      atlas,
      { first: 0, count: 2 },
      measure,
      {
        caret: { line: 1, column: 3, color: 0xffffffff, width: 2 },
        search: {
          matches: [{ index: 0, length: 3, line: 0, column: 0 }],
          currentIndex: 0,
        },
        selection: { anchor: 1, active: 4 },
      },
    );
    // Snapshot do comportamento legado (antes da malha visual) — congelado.
    expect(scene.rects.map((r) => ({ ...r.rect, color: r.color }))).toEqual([
      { x: 0, y: 0, w: 400, h: 100, color: 0x1e1f22ff }, // fundo
      { x: 0, y: 24, w: 400, h: 20, color: 0x252629ff }, // destaque da linha atual (linha 1)
      { x: 8, y: 4, w: 28.800000000000004, h: 20, color: 0xff880088 }, // match de busca (atual)
      { x: 17.6, y: 4, w: 19.200000000000003, h: 20, color: 0x264f78ff }, // seleção (1..4)
      { x: 36.8, y: 24, w: 2, h: 20, color: 0xffffffff }, // caret
    ]);
  });

  it("tabs: o x do caret e da seleção não mudam (baseline)", () => {
    const scene = buildWithMeasure(
      sourceOf(["\tabc def"]),
      layout(0),
      atlas,
      { first: 0, count: 1 },
      measure,
      {
        caret: { line: 0, column: 3, color: 0xffffffff, width: 2 },
        selection: { anchor: 2, active: 6 },
      },
    );
    const caretRect = scene.rects.find((r) => r.color === 0xffffffff);
    const sel = scene.rects.find((r) => r.color === 0x264f78ff);
    // Baseline: caret x = paddingLeft + 3 * advanceDoEspaço; seleção x = paddingLeft + 4 * advance.
    expect(caretRect?.rect.x).toBeCloseTo(8 + 3 * 9.6, 5);
    expect(sel?.rect.x).toBeCloseTo(56, 5);
    expect(sel?.rect.w).toBeCloseTo(3 * 9.6, 5);
  });
});

describe("buildInstances — custo por frame", () => {
  it("a faixa visível não custa O(documento)", () => {
    // Documento de 10k linhas; a faixa visível (40 linhas) começa na linha 5000.
    const lines = Array.from({ length: 10_000 }, (_, i) => `linha ${i} ` + "x".repeat(60));
    const source = sourceOf(lines);
    const atlas = new GlyphAtlas();
    const measure = (text: string): number => text.length * 8;
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      buildWithMeasure(source, wrapLayout(700, 0), atlas, { first: 5000, count: 40 }, measure);
    }
    const elapsed = performance.now() - started;
    // 20 frames de uma faixa de 40 linhas: ~1.4ms/frame medido. A folga é enorme frente a
    // um custo O(documento) (que seria ~200ms/frame só para achar a row visual do caret).
    expect(elapsed).toBeLessThan(1000);
  });
});
