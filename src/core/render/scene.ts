/**
 * Scribe — `scene.ts`: **seam de integração** entre o documento e o render (escolha nossa).
 *
 * ⚠️ PONTO DE LIGAÇÃO FUTURO: `buildInstances` é a única costura onde o **documento real**
 * (`TextStore`/`PieceTable`, outro módulo) será traduzido em instâncias de desenho. Enquanto o
 * núcleo de buffer não estiver pronto, esta camada recebe um `LineSource` mínimo — mantido de
 * propósito **local a este diretório** para não criar import cruzado entre módulos de `src/core`.
 *
 * A virtualização é do `Viewport` (DEC-REN-4): `buildInstances` só materializa o **range visível**
 * (`range`), nunca o documento inteiro. Cada rune é resolvida pelo atlas (rasterizado uma vez) e
 * vira uma `GlyphInstance` posicionada em px lógicos.
 */

import type { GlyphInstance, LineInstance, Rect, RectInstance, RGBA, SearchMatch, TextStyle } from "../../shared";
import type { HighlightSpan, Scope, ThemeResolver } from "../../shared";
import { SelectionOps, type Selection } from "../../shared";
import type { GlyphAtlas } from "./atlas";
import type { LineRange } from "./viewport";

/** Fonte de linhas — a costura que o documento real implementará depois. */
export interface LineSource {
  lineCount(): number;
  line(index: number): string;
  /** Offset (code units UTF-16) → linha/coluna (0-based). */
  positionAt(offset: number): { line: number; column: number };
}

/**
 * Destaque por linha (a costura nova): spans por linha + resolução escopo → cor. Quem não tiver
 * gramática passa `undefined` e todo glifo cai em `layout.defaultColor` (retrocompatível).
 */
export interface SceneHighlight {
  /** Spans da linha (offsets em code units UTF-16) ou `undefined` se não houver destaque. */
  spansFor(line: number): readonly HighlightSpan[] | undefined;
  theme: ThemeResolver;
}

/** Layout do texto em px lógicos (tema + geometria do gutter). */
export interface LineLayout {
  readonly lineHeight: number;
  readonly paddingLeft: number;
  readonly paddingTop: number;
  /** Colunas por tabulação (expandida em espaços na medição). */
  readonly tabWidth: number;
  /** Offset vertical atual da viewport (px) — permite scroll sub-linear/animação. */
  readonly scrollOffsetPx: number;
  /** Retângulo da área visível (px), para o preenchimento de fundo. */
  readonly viewport: Rect;
  readonly background: RGBA;
  readonly defaultColor: RGBA;
}

/** Cursor opcional desenhado como `RectInstance`. */
export interface CaretPosition {
  readonly line: number;
  readonly column: number;
  readonly color: RGBA;
  readonly width: number;
}

/**
 * Destaque das ocorrências de busca no canvas.
 * O find bar sabe os matches; aqui só os posicionamos em px e colorimos.
 * O match "atual" ganha cor diferente do restante.
 */
export interface SearchHighlight {
  /** Ocorrências a destacar (só as do range visível, pré-filtradas ou não). */
  readonly matches: readonly SearchMatch[];
  /** Índice em `matches` do match atual (navegação), ou `-1` se sem match. */
  readonly currentIndex: number;
}

/** @internal exported only for tests. */
export const SEARCH_MATCH_COLOR: RGBA = 0xffff0044;
/** @internal exported only for tests. */
export const SEARCH_CURRENT_COLOR: RGBA = 0xff880088;

/** Cor de fundo da seleção (azul semi-transparente, como editores de texto). */
export const SELECTION_COLOR: RGBA = 0x264f78ff;

/** Instâncias de um frame — entradas diretas do `RenderPipeline`. */
export interface SceneInstances {
  readonly rects: RectInstance[];
  readonly glyphs: GlyphInstance[];
  readonly lines: LineInstance[];
}

/**
 * Monta as instâncias do **range visível**. Determinístico e puro (não toca no pipeline): o mesmo
 * `(source, layout, atlas, style, range, caret, highlight, searchHighlight, selection)` produz
 * sempre as mesmas instâncias.
 *
 * `highlight` é **opcional** (retrocompatível): quando presente, cada glifo é colorido pela cor do
 * escopo que cobre o seu offset na linha (via `ThemeResolver`); sem span/tema, cai em
 * `layout.defaultColor`.
 *
 * `searchHighlight` é **opcional**: quando presente, pinta retângulos de fundo nas posições das
 * ocorrências da busca — o match "atual" (`currentIndex`) ganha a cor `SEARCH_CURRENT_COLOR`;
 * os demais, `SEARCH_MATCH_COLOR`.
 *
 * `selection` é **opcional** (P1#1): quando presente e não colapsado, pinta retângulos de fundo
 * entre `anchor` e `active` — azul semi-transparente, como editores de texto convencionais.
 */
export function buildInstances(
  source: LineSource,
  layout: LineLayout,
  atlas: GlyphAtlas,
  style: TextStyle,
  range: LineRange,
  caret?: CaretPosition,
  highlight?: SceneHighlight,
  searchHighlight?: SearchHighlight,
  selection?: Selection,
): SceneInstances {
  const rects: RectInstance[] = [
    { rect: layout.viewport, color: layout.background },
  ];
  const glyphs: GlyphInstance[] = [];
  const lines: LineInstance[] = [];

  atlas.registerStyle(style);
  const spaceAdvance = atlas.resolveGlyph(" ", style).advance;
  const total = source.lineCount();
  const first = Math.max(0, range.first);
  const end = Math.min(total, first + Math.max(0, range.count));

  for (let index = first; index < end; index++) {
    const text = source.line(index);
    const y = layout.paddingTop + index * layout.lineHeight - layout.scrollOffsetPx;
    const spans = highlight?.spansFor(index);
    let x = layout.paddingLeft;
    let column = 0;
    let offset = 0;

    while (offset < text.length) {
      const code = text.codePointAt(offset);
      if (code === undefined) break;
      const rune = String.fromCodePoint(code);
      const size = rune.length;
      if (rune === "\t") {
        const stop = layout.tabWidth - (column % layout.tabWidth);
        x += spaceAdvance * stop;
        column += stop;
        offset += size;
        continue;
      }
      const placed = atlas.resolveGlyph(rune, style);
      if (rune !== " ") {
        glyphs.push({
          atlasX: placed.region.x,
          atlasY: placed.region.y,
          atlasW: placed.region.w,
          atlasH: placed.region.h,
          x,
          y,
          color: glyphColor(spans, highlight?.theme, offset) ?? layout.defaultColor,
        });
      }
      x += placed.advance;
      column += 1;
      offset += size;
    }
  }

  // Search highlight: pinta retângulos de fundo nas posições das ocorrências.
  if (searchHighlight) {
    for (let mi = 0; mi < searchHighlight.matches.length; mi++) {
      const match = searchHighlight.matches[mi]!;
      if (match.line < first || match.line >= end) continue;
      const text = source.line(match.line);
      const isCurrent = mi === searchHighlight.currentIndex;
      // Caminha pelo texto para achar o x do início e do fim do match.
      let mx = layout.paddingLeft;
      let mcol = 0;
      let moff = 0;
      let matchStartX = mx;
      let matchEndX = mx;
      const targetEnd = Math.min(match.index + match.length, text.length);
      while (moff < targetEnd) {
        if (moff === match.index) matchStartX = mx;
        const code = text.codePointAt(moff);
        if (code === undefined) break;
        const rune = String.fromCodePoint(code);
        const size = rune.length;
        if (rune === "\t") {
          const stop = layout.tabWidth - (mcol % layout.tabWidth);
          mx += spaceAdvance * stop;
          mcol += stop;
          moff += size;
          continue;
        }
        const placed = atlas.resolveGlyph(rune, style);
        mx += placed.advance;
        mcol += 1;
        moff += size;
      }
      matchEndX = mx;
      // Se o match está após o fim da linha (linha vazia ou truncada),
      // `matchStartX === matchEndX` e a largura será 0 — pulamos.
      if (matchEndX - matchStartX <= 0) continue;
      rects.push({
        rect: {
          x: matchStartX,
          y: layout.paddingTop + match.line * layout.lineHeight - layout.scrollOffsetPx,
          w: Math.max(matchEndX - matchStartX, 0),
          h: layout.lineHeight,
        },
        color: isCurrent ? SEARCH_CURRENT_COLOR : SEARCH_MATCH_COLOR,
      });
    }
  }

  // Seleção: pinta retângulos de fundo entre anchor e active.
  if (selection && !SelectionOps.isCollapsed(selection)) {
    const { start, end } = SelectionOps.normalized(selection);
    const startPos = source.positionAt(start);
    const endPos = source.positionAt(Math.max(0, end - 1));
    // Linhas afetadas pela seleção (dentro do range visível).
    const selFirst = Math.max(first, startPos.line);
    const selLast = Math.min(endPos.line, end - 1, source.lineCount() - 1);
    for (let line = selFirst; line <= selLast; line++) {
      const text = source.line(line);
      // Coluna inicial na linha: se a seleção começa nesta linha, usa a coluna de início;
      // senão, começa do início da linha (col 0).
      const lineStartCol = line === startPos.line ? startPos.column : 0;
      // Coluna final na linha: se a seleção termina nesta linha, usa a coluna de fim;
      // senão, vai até o fim da linha (text.length).
      const lineEndCol = line === endPos.line ? endPos.column : text.length;
      if (lineStartCol >= lineEndCol) continue;
      // Caminha pelo texto para achar o x do início e do fim na linha.
      let sx = layout.paddingLeft;
      let scol = 0;
      let soff = 0;
      let selStartX = sx;
      let selEndX = sx;
      const targetOff = Math.min(lineEndCol, text.length);
      while (soff < targetOff) {
        if (soff === lineStartCol) selStartX = sx;
        const code = text.codePointAt(soff);
        if (code === undefined) break;
        const rune = String.fromCodePoint(code);
        const size = rune.length;
        if (rune === "\t") {
          const stop = layout.tabWidth - (scol % layout.tabWidth);
          sx += spaceAdvance * stop;
          scol += stop;
          soff += size;
          continue;
        }
        const placed = atlas.resolveGlyph(rune, style);
        sx += placed.advance;
        scol += 1;
        soff += size;
      }
      selEndX = sx;
      if (selEndX - selStartX <= 0) continue;
      rects.push({
        rect: {
          x: selStartX,
          y: layout.paddingTop + line * layout.lineHeight - layout.scrollOffsetPx,
          w: Math.max(selEndX - selStartX, 0),
          h: layout.lineHeight,
        },
        color: SELECTION_COLOR,
      });
    }
  }

  if (caret && caret.line >= first && caret.line < end) {
    rects.push({
      rect: {
        x: layout.paddingLeft + caretAdvance(atlas, style, caret.column, spaceAdvance),
        y: layout.paddingTop + caret.line * layout.lineHeight - layout.scrollOffsetPx,
        w: caret.width,
        h: layout.lineHeight,
      },
      color: caret.color,
    });
  }

  return { rects, glyphs, lines };
}

function caretAdvance(atlas: GlyphAtlas, style: TextStyle, column: number, spaceAdvance: number): number {
  if (column <= 0) return 0;
  const metrics = atlas.measure(" ".repeat(column), atlas.registerStyle(style));
  return metrics.advance === 0 ? column * spaceAdvance : metrics.advance;
}

/**
 * Cor do glifo pelo escopo que cobre o offset. Os spans do tokenizador são não sobrepostos e
 * ordenados, então o primeiro que contém o offset decide; sem span ou sem regra de tema → `undefined`
 * (o chamador usa `layout.defaultColor`).
 */
function glyphColor(
  spans: readonly HighlightSpan[] | undefined,
  theme: ThemeResolver | undefined,
  offset: number,
): RGBA | undefined {
  if (spans === undefined || theme === undefined) return undefined;
  for (const span of spans) {
    if (offset < span.start) return undefined;
    if (offset < span.end) return styleColor(theme, span.scope);
  }
  return undefined;
}

function styleColor(theme: ThemeResolver, scope: Scope): RGBA | undefined {
  return theme.styleFor(scope)?.color;
}
