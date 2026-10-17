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

import type { GlyphInstance, LineInstance, Rect, RectInstance, RGBA, TextStyle } from "../../shared";
import type { GlyphAtlas } from "./atlas";
import type { LineRange } from "./viewport";

/** Fonte de linhas — a costura que o documento real implementará depois. */
export interface LineSource {
  lineCount(): number;
  line(index: number): string;
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

/** Instâncias de um frame — entradas diretas do `RenderPipeline`. */
export interface SceneInstances {
  readonly rects: RectInstance[];
  readonly glyphs: GlyphInstance[];
  readonly lines: LineInstance[];
}

/**
 * Monta as instâncias do **range visível**. Determinístico e puro (não toca no pipeline): o mesmo
 * `(source, layout, atlas, style, range, caret)` produz sempre as mesmas instâncias.
 */
export function buildInstances(
  source: LineSource,
  layout: LineLayout,
  atlas: GlyphAtlas,
  style: TextStyle,
  range: LineRange,
  caret?: CaretPosition,
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
    let x = layout.paddingLeft;
    let column = 0;

    for (const rune of text) {
      if (rune === "\t") {
        const stop = layout.tabWidth - (column % layout.tabWidth);
        x += spaceAdvance * stop;
        column += stop;
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
          color: layout.defaultColor,
        });
      }
      x += placed.advance;
      column += 1;
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
