/**
 * Testes do `scene.ts`: só linhas visíveis viram instâncias (virtualização), tabs e caret.
 */
import { describe, expect, it } from "vitest";
import type { RGBA, Scope, ScopeStyle, SearchMatch, Selection, TextStyle, ThemeResolver } from "../../shared";
import { GlyphAtlas } from "./atlas";
import {
  buildInstances,
  type CaretPosition,
  type FoldingState,
  type LineLayout,
  type LineSource,
  type SceneInstances,
  type SearchHighlight,
  type VisualRowIndexLike,
} from "./scene";
import { applyCollapsedLines, collapsedLinesOf, VisualRowIndex } from "./soft-wrap";
import type { StickyContext } from "./sticky-scroll";

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
    readonly activeLine?: number;
    readonly folding?: FoldingState;
    readonly rowIndex?: VisualRowIndexLike;
    /** Contexto de sticky scroll (as linhas que grudam no topo). */
    readonly sticky?: StickyContext;
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
    extras?.folding,
    undefined, // inlayHints
    undefined, // gitDiffs
    undefined, // breakpointLines
    extras?.activeLine,
    extras?.rowIndex,
    extras?.sticky,
  );
}

/**
 * Linhas **desenhadas** pela cena, lidas do **gutter** (é o número da linha que está lá).
 *
 * Devolve `{ line, y }` por linha desenhada: o número da linha como no gutter (1-based) e a
 * row em px (o `y` do glifo). Usado para comparar a cena **com** índice e a cena **sem**
 * índice: as duas têm de desenar as **mesmas linhas**, nas **mesmas rows**.
 *
 * ⚠️ As linhas do teste não podem ter dígitos no texto (o gutter é lido pelos glifos dos
 * dígitos) — use linhas com letras.
 */
function drawnLines(scene: SceneInstances, atlas: GlyphAtlas): { line: number; y: number }[] {
  const digitOfRegion = new Map<string, string>();
  for (const digit of "0123456789") {
    const g = atlas.resolveGlyph(digit, style);
    digitOfRegion.set(`${g.region.x}:${g.region.y}`, digit);
  }
  const byRow = new Map<number, { x: number; digit: string }[]>();
  for (const g of scene.glyphs) {
    const digit = digitOfRegion.get(`${g.atlasX}:${g.atlasY}`);
    if (digit === undefined) continue;
    const list = byRow.get(g.y) ?? [];
    list.push({ x: g.x, digit });
    byRow.set(g.y, list);
  }
  const out: { line: number; y: number }[] = [];
  for (const [y, digits] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    // O número é desenhado **direita-alinhado** no gutter ⇒ o último dígito é o da direita.
    const text = digits.sort((a, b) => b.x - a.x).map((d) => d.digit).join("");
    out.push({ line: Number(text), y });
  }
  return out;
}

/** Rows visuais (0-based) desenhadas pela cena, a partir do `y` dos glifos. */
function rowsOf(scene: SceneInstances): number[] {
  // `y = paddingTop + row * lineHeight − scrollOffsetPx` — o layout do teste tem
  // paddingTop = 4, lineHeight = 20 e scrollOffsetPx = 0.
  return [...new Set(scene.glyphs.map((g) => g.y))].sort((a, b) => a - b).map((y) => (y - 4) / 20);
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
    // Colunas 12..15 (3 caracteres) → 2º segmento (row 1): X = paddingLeft + 2 colunas,
    // W = 3 colunas (o fim da seleção é **após** o último caractere).
    expect(sel?.rect.y).toBe(24);
    expect(sel?.rect.x).toBeCloseTo(8 + 2 * 9.6, 5);
    expect(sel?.rect.w).toBeCloseTo(3 * 9.6, 5);
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
    // 1º segmento: cols 8..10 (row 0) · 2º segmento: cols 10..13 (row 1).
    expect(sels[0]?.rect.y).toBe(4);
    expect(sels[0]?.rect.x).toBeCloseTo(8 + 8 * 9.6, 5);
    expect(sels[0]?.rect.w).toBeCloseTo(2 * 9.6, 5);
    expect(sels[1]?.rect.y).toBe(24);
    expect(sels[1]?.rect.x).toBeCloseTo(8, 5);
    expect(sels[1]?.rect.w).toBeCloseTo(3 * 9.6, 5);
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
    //
    // ⚠️ **1 mudança deliberada** (achado #5): a seleção agora termina **após** o último
    // caractere selecionado (antes parava 1 caractere antes) ⇒ a largura da faixa
    // selecionada é 3 colunas (28.8px) em vez de 2 (19.2px). O resto é idêntico.
    expect(scene.rects.map((r) => ({ ...r.rect, color: r.color }))).toEqual([
      { x: 0, y: 0, w: 400, h: 100, color: 0x1e1f22ff }, // fundo
      { x: 0, y: 24, w: 400, h: 20, color: 0x252629ff }, // destaque da linha atual (linha 1)
      { x: 8, y: 4, w: 28.800000000000004, h: 20, color: 0xff880088 }, // match de busca (atual)
      { x: 17.6, y: 4, w: 28.800000000000004, h: 20, color: 0x264f78ff }, // seleção (1..4) — 3 chars
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
    // A seleção cobre 4 colunas (2..6) — o fim é **após** o último caractere (achado #5).
    expect(sel?.rect.w).toBeCloseTo(4 * 9.6, 5);
  });
});

describe("buildInstances — caret real × linha ativa", () => {
  const atlas = new GlyphAtlas();

  it("o caret é desenhado na posição do cursor (não na 1ª linha visível)", () => {
    const scene = buildInstances(
      sourceOf(["aaa", "bbb", "ccc"]),
      layout(0),
      atlas,
      style,
      { first: 0, count: 3 },
      { line: 2, column: 1, color: 0xffffffff, width: 2 },
    );
    const caretRect = scene.rects.find((r) => r.color === 0xffffffff);
    // Linha 2 → row 2 → Y = paddingTop(4) + 2 * lineHeight(20) = 44.
    expect(caretRect?.rect.y).toBe(44);
    // X = paddingLeft(8) + 1 coluna.
    expect(caretRect?.rect.x).toBeCloseTo(8 + 9.6, 5);
    expect(caretRect?.rect.h).toBe(20);
  });

  it("a linha ativa (activeLine) desenha o destaque separado do caret", () => {
    const scene = buildWithMeasure(
      sourceOf(["aaa", "bbb", "ccc"]),
      layout(0),
      atlas,
      { first: 0, count: 3 },
      (text: string): number => text.length * 10,
      {
        caret: { line: 2, column: 1, color: 0xffffffff, width: 2 },
        activeLine: 1,
      },
    );
    // O destaque de linha atual (fundo 0x252629ff) fica na **linha ativa** (row 1 → Y = 24).
    const highlight = scene.rects.find((r) => r.color === 0x252629ff);
    expect(highlight?.rect.y).toBe(24);
    // E o caret continua na posição real do cursor (linha 2 → Y = 44).
    const caretRect = scene.rects.find((r) => r.color === 0xffffffff);
    expect(caretRect?.rect.y).toBe(44);
  });

  it("sem activeLine, o destaque de linha atual acompanha a linha do caret", () => {
    const scene = buildWithMeasure(
      sourceOf(["aaa", "bbb", "ccc"]),
      layout(0),
      atlas,
      { first: 0, count: 3 },
      (text: string): number => text.length * 10,
      { caret: { line: 2, column: 1, color: 0xffffffff, width: 2 } },
    );
    const highlight = scene.rects.find((r) => r.color === 0x252629ff);
    expect(highlight?.rect.y).toBe(44);
  });

  it("a linha ativa é desenhada mesmo sem caret no range", () => {
    const scene = buildWithMeasure(
      sourceOf(["aaa", "bbb", "ccc"]),
      layout(0),
      atlas,
      { first: 0, count: 3 },
      (text: string): number => text.length * 10,
      { activeLine: 2 },
    );
    const highlight = scene.rects.find((r) => r.color === 0x252629ff);
    expect(highlight?.rect.y).toBe(44);
    // Sem caret não há barra de cursor.
    expect(scene.rects.find((r) => r.color === 0xffffffff)).toBeUndefined();
  });
});

describe("buildInstances — seleção (fim da faixa)", () => {
  const atlas = new GlyphAtlas();
  const measure = (text: string): number => text.length * 10;

  it("a seleção termina na coluna certa (cobre o último caractere)", () => {
    const scene = buildWithMeasure(
      sourceOf(["abc def"]),
      layout(0),
      atlas,
      { first: 0, count: 1 },
      measure,
      { selection: { anchor: 1, active: 4 } },
    );
    const sel = scene.rects.find((r) => r.color === 0x264f78ff);
    // Colunas 1..4 → 3 caracteres ("bcd"). Antes parava em 3 (1 caractere curto).
    expect(sel?.rect.x).toBeCloseTo(8 + 1 * 9.6, 5);
    expect(sel?.rect.w).toBeCloseTo(3 * 9.6, 5);
  });

  it("a seleção que termina no fim da linha cobre a linha inteira", () => {
    const scene = buildWithMeasure(
      sourceOf(["abc def", "ghi"]),
      layout(0),
      atlas,
      { first: 0, count: 2 },
      measure,
      { selection: { anchor: 0, active: 7 } },
    );
    const sel = scene.rects.find((r) => r.color === 0x264f78ff);
    // 7 caracteres da linha 0 (o fim da linha é a coluna 7).
    expect(sel?.rect.x).toBeCloseTo(8, 5);
    expect(sel?.rect.w).toBeCloseTo(7 * 9.6, 5);
    expect(sel?.rect.y).toBe(4);
  });

  it("a seleção que termina no fim da linha seguinte não pinta a linha seguinte", () => {
    const scene = buildWithMeasure(
      sourceOf(["abc", "def"]),
      layout(0),
      atlas,
      { first: 0, count: 2 },
      measure,
      // Seleciona "abc" + o `\n` (offset 4 = início da linha 1).
      { selection: { anchor: 0, active: 4 } },
    );
    const sels = scene.rects.filter((r) => r.color === 0x264f78ff);
    // Só a linha 0 é pintada (3 caracteres) — a linha 1 está vazia na seleção.
    expect(sels).toHaveLength(1);
    expect(sels[0]?.rect.w).toBeCloseTo(3 * 9.6, 5);
  });
});

describe("buildInstances — guias de indentação (row visual)", () => {
  const atlas = new GlyphAtlas();
  const measure = (text: string): number => text.length * 10;

  it("com wrap, a guia usa a row visual (não sobe N rows)", () => {
    // A linha 0 é indentada e quebra em várias rows; a linha 1 também; a linha 2 não é
    // indentada (fecha a guia).
    const lines = [`    ${"a".repeat(26)}`, "    b", "c"];
    const scene = buildWithMeasure(
      sourceOf(lines),
      wrapLayout(100),
      atlas,
      { first: 0, count: 3 },
      measure,
    );
    const guides = scene.indentGuides;
    expect(guides).toBeDefined();
    // Topo = row 0 da linha 0 (Y = paddingTop).
    expect(guides?.[0]?.top).toBe(4);
    // A guia termina na **row visual** da linha 2 (a que fecha o nível 1) — a mesma row do
    // texto desenhado (o último glifo).
    const lastGlyphY = Math.max(...scene.glyphs.map((g) => g.y));
    expect(guides?.[0]?.bottom).toBe(lastGlyphY - 2);
    // E ela atravessa as rows da linha quebrada (com o índice lógico, subia N rows e
    // terminava dentro do texto).
    expect((guides?.[0]?.bottom ?? 0) - (guides?.[0]?.top ?? 0)).toBeGreaterThanOrEqual(3 * 20);
  });

  it("sem wrap, a guia acompanha a linha lógica", () => {
    const lines = ["    a", "    b", "c"];
    const scene = buildWithMeasure(
      sourceOf(lines),
      layout(0),
      atlas,
      { first: 0, count: 3 },
      measure,
    );
    const guides = scene.indentGuides;
    expect(guides?.[0]?.top).toBe(4);
    expect(guides?.[0]?.bottom).toBe(4 + 2 * 20 - 2);
  });
});

describe("buildInstances — folding × wrap (cena × índice)", () => {
  const atlas = new GlyphAtlas();
  const measure = (text: string): number => text.length * 10;

  it("a linha colapsada ocupa 0 rows: a contagem bate com o desenhado", () => {
    // A linha 1 (dentro da dobra) quebra em 3 rows — colapsada, ocupa **0**.
    const lines = ["a", "b".repeat(26), "c"];
    const source = sourceOf(lines);
    const index = new VisualRowIndex(source, 100, measure);
    const folding = [{ startLine: 0, endLine: 1, kind: undefined, isCollapsed: true }];
    index.setCollapsedLines(collapsedLinesOf(folding));
    // A linha 2 está na row 1 (a colapsada não ocupou row nenhuma).
    expect(index.rowOfLine(2)).toBe(1);
    expect(index.rowCount).toBe(2);

    const scene = buildWithMeasure(
      source,
      { ...wrapLayout(100), visualRowOffset: index.rowOfLine(2) },
      atlas,
      { first: 2, count: 1 },
      measure,
      { folding, rowIndex: index },
    );
    // O texto da linha 2 é desenhado na row 1 (Y = paddingTop + 1 * lineHeight = 24).
    expect(scene.glyphs.filter((g) => g.y === 24)).toHaveLength(1);
    expect(scene.glyphs.every((g) => g.y === 24)).toBe(true);
  });

  it("as rows desenhadas são exatamente as rows contadas pelo índice", () => {
    const lines = ["a", "b".repeat(26), "c"];
    const source = sourceOf(lines);
    const index = new VisualRowIndex(source, 100, measure);
    const folding = [{ startLine: 0, endLine: 1, kind: undefined, isCollapsed: true }];
    applyCollapsedLines(index, folding);
    const scene = buildWithMeasure(
      source,
      wrapLayout(100),
      atlas,
      { first: 0, count: 3 },
      measure,
      { folding, rowIndex: index },
    );
    // Row 0 (linha 0) e row 1 (linha 2) — a linha dobrada (que ocuparia 3 rows) não ocupa
    // row nenhuma: o texto abaixo da dobra **sobe**.
    expect([...new Set(scene.glyphs.map((g) => g.y))].sort((a, b) => a - b)).toEqual([4, 24]);
    // E a contagem publicada (a do índice) é a mesma ⇒ scroll e "line count" batem.
    expect(index.rowCount).toBe(2);
  });

  it("as linhas colapsadas não são desenhadas e o indicador de dobra continua", () => {
    const lines = ["a", "b".repeat(26), "c"];
    const source = sourceOf(lines);
    const index = new VisualRowIndex(source, 100, measure);
    const folding = [{ startLine: 0, endLine: 1, kind: undefined, isCollapsed: true }];
    const scene = buildWithMeasure(
      source,
      { ...wrapLayout(100), gutterWidth: 30 },
      atlas,
      { first: 0, count: 3 },
      measure,
      { folding, rowIndex: index },
    );
    // Row 0 (linha 0): o número "1", o texto "a" e o indicador de dobra "▸".
    expect(scene.glyphs.filter((g) => g.y === 4)).toHaveLength(3);
    // Row 1 (linha 2): o número "3" e o texto "c" — a linha colapsada (1) não tem glyphs.
    expect(scene.glyphs.filter((g) => g.y === 24)).toHaveLength(2);
    expect(scene.glyphs).toHaveLength(5);
    // O indicador de dobra (▸) está no gutter da 1ª linha do bloco.
    const marker = atlas.resolveGlyph("▸", style);
    expect(
      scene.glyphs.some((g) => g.atlasX === marker.region.x && g.atlasY === marker.region.y),
    ).toBe(true);
  });

  it("regressão: sem folding, as rows da cena são as mesmas de sempre", () => {
    const lines = ["a", "b".repeat(26), "c"];
    const source = sourceOf(lines);
    const index = new VisualRowIndex(source, 100, measure);
    const scene = buildWithMeasure(
      source,
      wrapLayout(100),
      atlas,
      { first: 0, count: 3 },
      measure,
      { rowIndex: index },
    );
    // Linha 0 → row 0 · linha 1 (26 chars) → 3 rows (1, 2, 3) · linha 2 → row 4.
    expect([...new Set(scene.glyphs.map((g) => g.y))].sort((a, b) => a - b)).toEqual([4, 24, 44, 64, 84]);
    expect(index.rowCount).toBe(5);
  });

  it("sem soft wrap: a linha colapsada também não reserva row (os dois modos alinhados)", () => {
    const lines = ["a", "b", "c"];
    const source = sourceOf(lines);
    const folding = [{ startLine: 0, endLine: 1, kind: undefined, isCollapsed: true }];
    const scene = buildWithMeasure(source, layout(0), atlas, { first: 2, count: 1 }, measure, { folding });
    // A linha 1 está colapsada (0 rows) ⇒ a linha 2 é a row 1 (Y = paddingTop + 1 * 20 = 24).
    expect(scene.glyphs).toHaveLength(1);
    expect(scene.glyphs.every((g) => g.y === 24)).toBe(true);
  });

  it("cena sem índice: a linha colapsada que quebraria não é desenhada e não conta row", () => {
    // A linha 1 quebra em 3 rows (26 chars × 10px = 260px) — colapsada, ocupa **0**.
    const lines = ["a", "b".repeat(26), "c"];
    const source = sourceOf(lines);
    const folding = [{ startLine: 0, endLine: 1, kind: undefined, isCollapsed: true }];
    // **Sem** índice: a faixa é re-quebrada no frame (o caminho legado).
    const scene = buildWithMeasure(source, wrapLayout(100), atlas, { first: 0, count: 3 }, measure, {
      folding,
    });
    // Só as linhas 0 e 2 são desenhadas — a colapsada (que ocuparia 3 rows) não é desenhada…
    expect(rowsOf(scene)).toEqual([0, 1]);
    // … e não conta row: a linha 2 fica na row 1 (não na row 4).
    expect(scene.glyphs.filter((g) => g.y === 4)).toHaveLength(1);
    expect(scene.glyphs.filter((g) => g.y === 24)).toHaveLength(1);
  });

  it("com wrap, as duas cenas concordam na row **relativa à faixa**", () => {
    // A row **absoluta** de uma linha depende das rows das linhas anteriores (O(documento))
    // ⇒ só o índice a sabe. O que os dois caminhos **tem** de concordar é a row relativa à
    // faixa (`row − firstRow`): sem isso, a mesma linha era desenhada em rows diferentes.
    const lines = ["b".repeat(26), "c", "d"];
    const source = sourceOf(lines);
    const index = new VisualRowIndex(source, 100, measure);
    const range = { first: 1, count: 2 };
    const comIndice = buildWithMeasure(source, wrapLayout(100), atlas, range, measure, { rowIndex: index });
    const semIndice = buildWithMeasure(source, wrapLayout(100), atlas, range, measure, {});
    // A base do índice é a row **absoluta** da 1ª linha da faixa; a do caminho sem índice é
    // **relativa à faixa** (0) — as rows relativas é que têm de bater.
    const relativa = (scene: SceneInstances, firstRow: number): number[] =>
      rowsOf(scene).map((r) => r - firstRow);
    expect(relativa(comIndice, index.rowOfLine(range.first))).toEqual(relativa(semIndice, 0));
  });
});

describe("buildInstances — paridade cena×índice (sem soft wrap)", () => {
  const atlas = new GlyphAtlas();
  const measure = (text: string): number => text.length * 10;
  const lines = ["a", "b", "c", "d", "e"];
  /** A dobra pega a linha 2 — a 1ª do bloco (a 2ª linha) continua visível (indicador ▸). */
  const folding = [{ startLine: 1, endLine: 2, kind: undefined, isCollapsed: true }];

  it("as duas cenas desenham as mesmas linhas, nas mesmas rows", () => {
    const source = sourceOf(lines);
    const index = new VisualRowIndex(source, 0, measure);
    const range = { first: 0, count: lines.length };
    const comIndice = buildWithMeasure(
      source,
      { ...layout(0), gutterWidth: 30 },
      atlas,
      range,
      measure,
      { folding, rowIndex: index },
    );
    const semIndice = buildWithMeasure(
      source,
      { ...layout(0), gutterWidth: 30 },
      atlas,
      range,
      measure,
      { folding },
    );
    // O **conjunto** de linhas desenhadas é o mesmo (a colapsada — a 3ª — não é desenhada).
    expect(drawnLines(comIndice, atlas)).toEqual(drawnLines(semIndice, atlas));
    // Os números do gutter são 1-based: as linhas 0, 1, 3 e 4 (a 2 — colapsada — some).
    expect(drawnLines(comIndice, atlas).map((l) => l.line)).toEqual([1, 2, 4, 5]);
    // E as **rows** são as mesmas: a colapsada não reservou row (a linha 3 ficou na row 2).
    expect(drawnLines(comIndice, atlas).map((l) => l.y)).toEqual([4, 24, 44, 64]);
    expect(index.rowCount).toBe(4);
  });

  it("a paridade vale também para uma faixa que começa no meio do documento", () => {
    const source = sourceOf(lines);
    const index = new VisualRowIndex(source, 0, measure);
    const range = { first: 2, count: 3 };
    const comIndice = buildWithMeasure(
      source,
      { ...layout(0), gutterWidth: 30 },
      atlas,
      range,
      measure,
      { folding, rowIndex: index },
    );
    const semIndice = buildWithMeasure(
      source,
      { ...layout(0), gutterWidth: 30 },
      atlas,
      range,
      measure,
      { folding },
    );
    expect(drawnLines(comIndice, atlas)).toEqual(drawnLines(semIndice, atlas));
    // A linha colapsada (a 3ª) não é desenhada; as linhas 4 e 5 ocupam as rows 2 e 3.
    expect(drawnLines(comIndice, atlas).map((l) => l.line)).toEqual([4, 5]);
    expect(drawnLines(comIndice, atlas).map((l) => l.y)).toEqual([44, 64]);
  });
});

describe("buildInstances — sticky scroll", () => {
  const atlas = new GlyphAtlas();
  const measure = (text: string): number => text.length * 10;

  it("as linhas de contexto são desenhadas grudadas no topo (sem scroll)", () => {
    const lines = ["head", "x", "y", "z"];
    const scene = buildWithMeasure(
      sourceOf(lines),
      layout(0),
      atlas,
      { first: 1, count: 3 },
      measure,
      { sticky: { startLine: 0, count: 1 } },
    );
    // "head" = 4 glifos na row grudada (Y = paddingTop = 4).
    expect(scene.glyphs.filter((g) => g.y === 4)).toHaveLength(4);
    // A faixa visível (linhas 1, 2, 3) continua nas rows normais.
    expect([...new Set(scene.glyphs.map((g) => g.y))].sort((a, b) => a - b)).toEqual([4, 24, 44, 64]);
  });

  it("o bloco grudado não se move com o scroll", () => {
    const lines = ["head", "x", "y", "z"];
    const scene = buildWithMeasure(
      sourceOf(lines),
      layout(40),
      atlas,
      { first: 1, count: 3 },
      measure,
      { sticky: { startLine: 0, count: 1 } },
    );
    // Com 40px de scroll o texto normal sobe (Y = 4 + row*20 - 40 = -16, 4, 24). A linha
    // coberta pelo bloco grudado (a row do topo da viewport) **não** é desenhada — o bloco a
    // substitui (o pipeline desenha os fundos antes dos glifos ⇒ ela apareceria por cima).
    expect(scene.glyphs.slice(0, 2).map((g) => g.y)).toEqual([-16, 24]);
    // … mas o bloco grudado continua no topo (Y = paddingTop), sem scroll.
    expect(scene.glyphs.slice(2).map((g) => g.y)).toEqual([4, 4, 4, 4]);
  });

  it("as linhas do contexto que já estão visíveis não são duplicadas", () => {
    const scene = buildWithMeasure(
      sourceOf(["a", "b", "c", "d"]),
      layout(0),
      atlas,
      { first: 0, count: 4 },
      measure,
      { sticky: { startLine: 1, count: 2 } },
    );
    // O contexto (1..2) está dentro da faixa visível ⇒ nada gruda (a row 0 tem só a linha 0).
    expect(scene.glyphs.filter((g) => g.y === 4)).toHaveLength(1);
    // E o total de glifos é o do texto normal (nada foi repetido).
    expect(scene.glyphs).toHaveLength(4);
  });

  it("a linha de contexto é desenhada uma vez só (grudada, não na posição original)", () => {
    const lines = ["head", "x"];
    const scene = buildWithMeasure(
      sourceOf(lines),
      layout(0),
      atlas,
      { first: 1, count: 1 },
      measure,
      { sticky: { startLine: 0, count: 1 } },
    );
    // 4 glifos de "head" (grudados) + 1 de "x" (visível) — "head" não aparece 2×.
    expect(scene.glyphs).toHaveLength(5);
    expect(scene.glyphs.filter((g) => g.y === 4)).toHaveLength(4);
  });

  it("o bloco grudado tem um realce sutil de fundo", () => {
    const scene = buildWithMeasure(
      sourceOf(["head", "x"]),
      layout(0),
      atlas,
      { first: 1, count: 1 },
      measure,
      { sticky: { startLine: 0, count: 1 } },
    );
    // lighten(background 0x1e1f22ff, 0.05) = 0x292a2dff — na row do topo.
    const stickyBg = scene.rects.find((r) => r.color === 0x292a2dff);
    expect(stickyBg?.rect.y).toBe(4);
    expect(stickyBg?.rect.h).toBe(20);
  });

  it("sem o contexto, a cena é idêntica (o sticky é opt-in)", () => {
    const lines = ["head", "x", "y"];
    const range = { first: 1, count: 2 };
    const comSticky = buildWithMeasure(sourceOf(lines), layout(0), atlas, range, measure, {});
    // A cena legada (sem o parâmetro novo) é **byte-a-byte** a mesma.
    const legado = buildInstances(sourceOf(lines), layout(0), atlas, style, range);
    expect(comSticky).toEqual(legado);
  });

  it("com wrap, a linha grudada é quebrada nos segmentos do wrap", () => {
    const long = "a".repeat(26);
    const scene = buildWithMeasure(
      sourceOf([long, "x"]),
      wrapLayout(100),
      atlas,
      { first: 1, count: 1 },
      measure,
      { sticky: { startLine: 0, count: 1 } },
    );
    // 26 glifos da linha grudada (3 segmentos de 10/10/6). A linha visível ("x") fica na row
    // 0 da viewport, **coberta** pelo bloco grudado ⇒ ela não é desenhada (o bloco a substitui).
    expect(scene.glyphs).toHaveLength(26);
    // A linha grudada ocupa as rows 4, 24 e 44 (o topo da viewport, sem scroll).
    const grudados = scene.glyphs;
    expect([...new Set(grudados.map((g) => g.y))]).toEqual([4, 24, 44]);
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
