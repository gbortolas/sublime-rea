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
import { buildVisualRowMap, type VisualRowMap } from "./soft-wrap";
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
  /** Largura do gutter (faixa de números de linha) em px. */
  readonly gutterWidth: number;
  /** Cor de fundo do gutter. */
  readonly gutterBackground: RGBA;
  /** Cor dos números de linha no gutter. */
  readonly gutterColor: RGBA;
  /** Largura da scrollbar vertical (0 = sem scrollbar). */
  readonly scrollbarWidth: number;
  /** Cor do track da scrollbar. */
  readonly scrollbarTrack: RGBA;
  /** Cor do thumb da scrollbar. */
  readonly scrollbarThumb: RGBA;
  /** Cor das ocorrências de busca (não atuais). */
  readonly searchMatchColor: RGBA;
  /** Cor da ocorrência atual da busca. */
  readonly searchCurrentColor: RGBA;
  /** Cor de fundo da seleção de texto. */
  readonly selectionColor: RGBA;
  /** Cor do highlight do bracket correspondente (P3#14). */
  readonly bracketMatchColor: RGBA;
  /**
   * Largura máxima de texto em px antes de quebrar (soft wrap).
   * `0` = sem quebra (comportamento atual).
   * Normalmente: `viewport.w - gutterWidth - scrollbarWidth - paddingLeft`.
   */
  readonly wrapWidth: number;
  /**
   * Row visual (índice da linha visual no documento inteiro, contando as linhas de wrap)
   * da **primeira** linha do range visível.
   *
   * Só tem efeito com soft wrap (`wrapWidth > 0`).
   *
   * `undefined` (default) = comportamento atual: a row base da primeira linha visível é o
   * seu índice de linha **lógica** (`range.first`) — a ancoragem no `first` visível é
   * preservada e o `scrollOffsetPx` continua contado em linhas lógicas (a *deriva*).
   *
   * Quando informado, o renderizador passa a contar a rolagem em **linhas visuais**: nesse
   * caso `scrollOffsetPx` deve estar na mesma unidade (row visual), senão o texto quebrado
   * fica desalinhado em relação à barra de rolagem. O par completo é:
   * `visualRowOffset` = row visual da 1ª linha visível + `scrollOffsetPx` em rows visuais
   * (o `ViewportImpl` faz isso quando recebe um `VisualRowMapper` — ver `viewport.ts`).
   */
  readonly visualRowOffset?: number;
  /**
   * Total de **rows visuais** do documento (com soft wrap) — usado para a proporção do
   * thumb da scrollbar. `undefined` (default) = `source.lineCount()` (1 row por linha lógica).
   */
  readonly totalVisualRows?: number;
}

/** Cursor opcional desenhado como `RectInstance`. */
export interface CaretPosition {
  readonly line: number;
  readonly column: number;
  readonly color: RGBA;
  readonly width: number;
}

/** Posição de um bracket (linha/coluna, 0-based). */
export interface BracketPos {
  readonly line: number;
  readonly column: number;
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

/** Guia de indentação — linha vertical semi-transparente. */
export interface IndentGuide {
  readonly x: number;       // posição X em px
  readonly top: number;     // Y inicial
  readonly bottom: number;  // Y final
}

/** Um range de folding (bloco dobrável). */
export interface FoldRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string | undefined;
  readonly isCollapsed: boolean;
}

/** Estado de folding: lista de ranges (foldable) + quais estão colapsados. */
export type FoldingState = readonly FoldRange[];

/** Um inlay hint pronto para renderizar, com posição em px. */
export interface RenderInlayHint {
  readonly line: number;
  /** Posição X em px (calculada pelo layout). */
  readonly x: number;
  /** Posição Y em px (linha * lineHeight - scrollOffset). */
  readonly y: number;
  readonly label: string;
  readonly paddingLeft: boolean;
  readonly paddingRight: boolean;
}

/** Faixa de linhas com tipo de diff (git). */
export interface GitDiffRange {
  readonly startLine: number;
  readonly lineCount: number;
  readonly kind: "added" | "modified" | "deleted";
}

/** @internal exported only for tests. */

/** Instâncias de um frame — entradas diretas do `RenderPipeline`. */
export interface SceneInstances {
  readonly rects: RectInstance[];
  readonly glyphs: GlyphInstance[];
  readonly lines: LineInstance[];
  readonly indentGuides?: IndentGuide[];
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
  /** Cuidados extras para múltiplos cursores (P2#5). */
  extraCarets?: readonly CaretPosition[],
  /** Seleções extras para múltiplos cursores (P2#5). */
  extraSelections?: readonly Selection[],
  /** Par de brackets a destacar (P3#14). */
  bracketMatch?: readonly [BracketPos, BracketPos] | undefined,
  /** `wrapWidth > 0` ativa soft wrap (P3#15) — injeta o `measureWidth` do atlas. */
  measureWidth?: (text: string) => number,
  /** Estado de folding: ranges colapsáveis e seu estado (P3#16). */
  folding?: FoldingState,
  /** Inlay hints renderizados com posições em px (P4#19). */
  inlayHints?: readonly RenderInlayHint[],
  /** Git diff ranges para barras coloridas no gutter. */
  gitDiffs?: readonly GitDiffRange[],
  /** Linhas com breakpoint (1-based) — bolinha vermelha à esquerda do número. */
  breakpointLines?: readonly number[],
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

  // ── Soft wrap: malha visual da faixa visível ───────────────────────────────────────────────
  // 1 row por segmento de wrap. A malha é calculada **uma vez** por frame (O(faixa visível),
  // nunca O(documento)) e reusada pelo texto, o gutter, o caret, a seleção e a busca.
  const mw = measureWidth;
  const wrap = layout.wrapWidth > 0 && mw !== undefined;

  // Preenche linhas colapsadas
  const collapsedLines = new Set<number>();
  if (folding !== undefined) {
    for (const fr of folding) {
      if (fr.isCollapsed) {
        for (let l = fr.startLine + 1; l <= fr.endLine; l++) {
          collapsedLines.add(l);
        }
      }
    }
  }

  // `wrapLine` (soft-wrap.ts) é a implementação canônica da quebra: tem o early-exit "cabe
  // tudo" — linhas que cabem na largura **não** são quebradas.
  //
  // Row base da faixa: por padrão o índice da linha **lógica** (`first`) — preserva a
  // ancoragem atual (o scroll continua em linhas lógicas). `layout.visualRowOffset` permite
  // ao renderizador informar a row visual absoluta (quando a rolagem passa a ser contada em
  // rows visuais).
  const rowMap = buildVisualRowMap(source, first, end - first, layout.wrapWidth, mw, {
    ...(wrap && layout.visualRowOffset !== undefined ? { firstRow: layout.visualRowOffset } : {}),
    ...(collapsedLines.size > 0 ? { collapsedLines } : {}),
  });

  // Row visual do caret: é ela que ancora o caret, a seleção, a busca e o destaque de linha
  // atual. Sem wrap, a row visual de uma linha é o seu índice lógico (comportamento atual).
  const caretVisible = caret !== undefined && caret.line >= first && caret.line < end;
  const caretLoc = caretVisible ? rowMap.locate(caret.line, caret.column) : undefined;
  const caretRow = caretVisible ? (caretLoc?.row ?? rowMap.rowOfLine(caret.line)) : undefined;

  // Gutter: fundo + linha atual destacada + separador.
  if (layout.gutterWidth > 0) {
    rects.push({
      rect: { x: 0, y: 0, w: layout.gutterWidth, h: layout.viewport.h },
      color: layout.gutterBackground,
    });
    // Highlight da linha atual no gutter (se o caret estiver no range visível).
    if (caretRow !== undefined) {
      rects.push({
        rect: {
          x: 0,
          y: layout.paddingTop + caretRow * layout.lineHeight - layout.scrollOffsetPx,
          w: layout.gutterWidth,
          h: layout.lineHeight,
        },
        color: lighten(layout.gutterBackground, 0.08),
      });
    }
    // Separador vertical entre gutter e text area.
    lines.push({
      x0: layout.gutterWidth,
      y0: 0,
      x1: layout.gutterWidth,
      y1: layout.viewport.h,
      thickness: 1,
      color: lighten(layout.gutterBackground, 0.15),
    });
  }

  // Scrollbar: track + thumb à direita.
  if (layout.scrollbarWidth > 0) {
    const sbx = layout.viewport.w - layout.scrollbarWidth;
    // Track: fundo
    rects.push({
      rect: { x: sbx, y: 0, w: layout.scrollbarWidth, h: layout.viewport.h },
      color: layout.scrollbarTrack,
    });
    // Thumb: proporcional ao conteúdo (rows visuais quando o soft wrap está ativo).
    const totalRows = layout.totalVisualRows ?? source.lineCount();
    const totalPx = totalRows * layout.lineHeight;
    if (totalPx > 0 && layout.viewport.h < totalPx) {
      const thumbH = Math.max(20, layout.viewport.h * (layout.viewport.h / totalPx));
      const maxScroll = totalPx - layout.viewport.h;
      const ratio = maxScroll > 0 ? layout.scrollOffsetPx / maxScroll : 0;
      const thumbY = ratio * (layout.viewport.h - thumbH);
      rects.push({
        rect: { x: sbx, y: thumbY, w: layout.scrollbarWidth, h: thumbH },
        color: layout.scrollbarThumb,
      });
    }
  }

  // Cursor line highlight (P1#1): fundo sutil na linha do cursor no text area.
  if (caretRow !== undefined) {
    rects.push({
      rect: {
        x: layout.gutterWidth,
        y: layout.paddingTop + caretRow * layout.lineHeight - layout.scrollOffsetPx,
        w: layout.viewport.w - layout.gutterWidth - layout.scrollbarWidth,
        h: layout.lineHeight,
      },
      color: lighten(layout.background, 0.03),
    });
  }

  for (let line = first; line < end; line++) {
    const segments = rowMap.segmentsOf(line);
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si]!;
      const index = line;
      const text = seg.text;
      // Y = row visual (acumulada: 1 row por segmento de wrap) — nunca colide com a
      // linha lógica seguinte, porque a row avança pelo nº de segmentos da linha anterior.
      const y = layout.paddingTop + seg.row * layout.lineHeight - layout.scrollOffsetPx;
      const spans = highlight?.spansFor(index);

      // Gutter: número da linha (1-based), direita-alinhado no gutter.
      // Só aparece no primeiro segmento visual de cada linha de documento.
      if (layout.gutterWidth > 0 && seg.segmentIndex === 0) {
        // Git diff indicators (barras coloridas na borda esquerda do gutter)
        if (gitDiffs !== undefined) {
          for (const diff of gitDiffs) {
            if (index >= diff.startLine && index < diff.startLine + diff.lineCount) {
              const diffColor: RGBA = diff.kind === "added"
                ? 0x2EA04399  // verde (r=46, g=160, b=67, a=0.6)
                : diff.kind === "modified"
                  ? 0x3794FF99  // azul (r=55, g=148, b=255, a=0.6)
                  : 0xF0474799; // vermelho (r=240, g=71, b=71, a=0.6)
              rects.push({
                rect: { x: 0, y, w: 3, h: layout.lineHeight },
                color: diffColor,
              });
              break;
            }
          }
        }

        const lineNumber = String(index + 1);
        // Mede a largura total do número para posicionar à direita.
        let numWidth = 0;
        for (let ci = 0; ci < lineNumber.length; ci++) {
          const g = atlas.resolveGlyph(lineNumber[ci] ?? " ", style);
          numWidth += g.advance;
        }
        let nx = layout.gutterWidth - 8 - numWidth; // 8px padding direito
        for (let ci = 0; ci < lineNumber.length; ci++) {
          const g = atlas.resolveGlyph(lineNumber[ci] ?? " ", style);
          glyphs.push({
            atlasX: g.region.x,
            atlasY: g.region.y,
            atlasW: g.region.w,
            atlasH: g.region.h,
            x: nx,
            y,
            color: layout.gutterColor,
          });
          nx += g.advance;
        }

        // Indicador de folding no gutter
        if (folding !== undefined) {
          const thisFold = folding.find((fr) => fr.startLine === index);
          if (thisFold !== undefined) {
            const indicator = thisFold.isCollapsed ? "▸" : "▾";
            const indG = atlas.resolveGlyph(indicator, style);
            const indX = layout.gutterWidth - 8 - numWidth - indG.advance - 4;
            glyphs.push({
              atlasX: indG.region.x,
              atlasY: indG.region.y,
              atlasW: indG.region.w,
              atlasH: indG.region.h,
              x: indX,
              y,
              color: layout.gutterColor,
            });
          }
        }

        // Bolinha de breakpoint no gutter (vermelha, à esquerda dos números)
        if (breakpointLines !== undefined && breakpointLines.includes(index + 1)) {
          const dotG = atlas.resolveGlyph("●", style);
          glyphs.push({
            atlasX: dotG.region.x,
            atlasY: dotG.region.y,
            atlasW: dotG.region.w,
            atlasH: dotG.region.h,
            x: 5,
            y,
            color: 0xE51400FF, // vermelho VS Code para breakpoint
          });
        }
      }

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
            color: glyphColor(spans, highlight?.theme, offset + seg.start) ?? layout.defaultColor,
          });
        }
        x += placed.advance;
        column += 1;
        offset += size;
      }

      // Bracket matching (P3#14): destaca o par com um retângulo fino (underline-like).
      // Com wrap, o bracket só é desenhado no **segmento** que o contém.
      if (bracketMatch && layout.bracketMatchColor) {
        const [open, close] = bracketMatch;
        for (const bp of [open, close]) {
          if (bp.line !== index) continue;
          if (bp.column < seg.start || bp.column > seg.end) continue;
          // Coluna do bracket **dentro** do segmento.
          const colInSeg = Math.min(bp.column, seg.end) - seg.start;
          const bx = advanceWithin(
            atlas,
            style,
            text,
            colInSeg,
            layout.paddingLeft,
            spaceAdvance,
            layout.tabWidth,
          );
          const bracketChar = text[colInSeg] ?? "";
          const charW = atlas.resolveGlyph(bracketChar, style).advance;
          rects.push({
            rect: { x: bx, y: y + layout.lineHeight - 3, w: Math.max(charW, 4), h: 2 },
            color: layout.bracketMatchColor,
          });
        }
      }

      // Inlay hints (P4#19): desenha label após a posição calculada, em cor mais clara.
      // Com wrap, o hint é desenhado **uma vez** (no 1º segmento da linha) — senão o label
      // apareceria repetido em cada row da linha quebrada.
      if (inlayHints !== undefined && seg.segmentIndex === 0) {
        for (const ih of inlayHints) {
          if (ih.line === index) {
            let hx = ih.x;
            // Se paddingLeft, adiciona um espaço extra antes do hint
            if (ih.paddingLeft) hx += spaceAdvance;

            // 60% de opacidade da cor padrão
            const base = layout.defaultColor;
            const hintAlpha = Math.round((base & 0xff) * 0.6);
            const hintColor = ((base & 0xffffff00) | hintAlpha) >>> 0;

            for (let ci = 0; ci < ih.label.length; ci++) {
              const g = atlas.resolveGlyph(ih.label[ci] ?? " ", style);
              if (ih.label[ci] !== " ") {
                glyphs.push({
                  atlasX: g.region.x,
                  atlasY: g.region.y,
                  atlasW: g.region.w,
                  atlasH: g.region.h,
                  x: hx,
                  y,
                  color: hintColor,
                });
              }
              hx += g.advance;
            }
          }
        }
      }
    }
  }

  // Search highlight: pinta retângulos de fundo nas posições das ocorrências.
  // Com wrap, um match que atravessa segmentos é pintado **um rect por segmento**.
  if (searchHighlight) {
    for (let mi = 0; mi < searchHighlight.matches.length; mi++) {
      const match = searchHighlight.matches[mi]!;
      if (match.line < first || match.line >= end) continue;
      const isCurrent = mi === searchHighlight.currentIndex;
      // ⚠️ `SearchMatch.index` é o offset **absoluto** no documento (contrato de busca); a
      // posição **relativa à linha** é `match.column` — é ela que posiciona o destaque
      // (e que permite saber em qual segmento de wrap o match cai).
      const from = match.column;
      const to = match.column + match.length;
      for (const seg of rowMap.paintSegmentsOf(match.line)) {
        // Interseção do match com o segmento (offsets da linha).
        const s = Math.max(from, seg.start);
        const e = Math.min(to, seg.end);
        if (e <= s) continue;
        const matchStartX = advanceWithin(
          atlas,
          style,
          seg.text,
          s - seg.start,
          layout.paddingLeft,
          spaceAdvance,
          layout.tabWidth,
        );
        const matchEndX = advanceWithin(
          atlas,
          style,
          seg.text,
          e - seg.start,
          layout.paddingLeft,
          spaceAdvance,
          layout.tabWidth,
        );
        if (matchEndX - matchStartX <= 0) continue;
        rects.push({
          rect: {
            x: matchStartX,
            y: layout.paddingTop + seg.row * layout.lineHeight - layout.scrollOffsetPx,
            w: matchEndX - matchStartX,
            h: layout.lineHeight,
          },
          color: isCurrent ? layout.searchCurrentColor : layout.searchMatchColor,
        });
      }
    }
  }

  // Seleção: pinta retângulos de fundo entre anchor e active.
  if (selection && !SelectionOps.isCollapsed(selection)) {
    pushSelectionRects(rects, source, layout, atlas, style, rowMap, selection, first, end, spaceAdvance);
  }

  if (caret && caret.line >= first && caret.line < end) {
    const loc = rowMap.locate(caret.line, caret.column);
    const row = loc !== undefined ? loc.row : rowMap.rowOfLine(caret.line);
    if (row !== undefined) {
      // Com wrap, o caret vive no **segmento** que contém a coluna: o x é medido dentro do
      // segmento (a row do segmento, não a da linha lógica).
      const seg = loc !== undefined ? rowMap.segmentsOf(caret.line)[loc.segmentIndex] : undefined;
      const x =
        loc !== undefined && seg !== undefined && wrap
          ? advanceWithin(atlas, style, seg.text, loc.column, layout.paddingLeft, spaceAdvance, layout.tabWidth)
          : layout.paddingLeft + caretAdvance(atlas, style, caret.column, spaceAdvance);
      rects.push({
        rect: {
          x,
          y: layout.paddingTop + row * layout.lineHeight - layout.scrollOffsetPx,
          w: caret.width,
          h: layout.lineHeight,
        },
        color: caret.color,
      });
    }
  }

  // Cuidados extras para múltiplos cursores (P2#5)
  if (extraCarets) {
    for (const ec of extraCarets) {
      if (ec.line >= first && ec.line < end) {
        const loc = rowMap.locate(ec.line, ec.column);
        const row = loc !== undefined ? loc.row : rowMap.rowOfLine(ec.line);
        if (row === undefined) continue;
        const seg = loc !== undefined ? rowMap.segmentsOf(ec.line)[loc.segmentIndex] : undefined;
        const x =
          loc !== undefined && seg !== undefined && wrap
            ? advanceWithin(atlas, style, seg.text, loc.column, layout.paddingLeft, spaceAdvance, layout.tabWidth)
            : layout.paddingLeft + caretAdvance(atlas, style, ec.column, spaceAdvance);
        rects.push({
          rect: {
            x,
            y: layout.paddingTop + row * layout.lineHeight - layout.scrollOffsetPx,
            w: ec.width,
            h: layout.lineHeight,
          },
          color: ec.color,
        });
      }
    }
  }

  // Seleções extras para múltiplos cursores (P2#5)
  if (extraSelections) {
    for (const extraSel of extraSelections) {
      if (SelectionOps.isCollapsed(extraSel)) continue;
      pushSelectionRects(rects, source, layout, atlas, style, rowMap, extraSel, first, end, spaceAdvance);
    }
  }

  // Indentation guides (P3.15)
  const indentGuides = calcIndentGuides(source, layout, range);

  return { rects, glyphs, lines, ...(indentGuides !== undefined ? { indentGuides } : {}) };
}

function caretAdvance(atlas: GlyphAtlas, style: TextStyle, column: number, spaceAdvance: number): number {
  if (column <= 0) return 0;
  const metrics = atlas.measure(" ".repeat(column), atlas.registerStyle(style));
  return metrics.advance === 0 ? column * spaceAdvance : metrics.advance;
}

/**
 * Avança `x` (px) ao longo de `text` (code units UTF-16) até a posição `at`, devolvendo o x
 * final (o x **da** posição `at`).
 *
 * Tabs são expandidos até o próximo stop; a coluna do tab é **relativa ao início de `text`** —
 * num segmento de wrap o texto recomeça (cada row visual tem sua própria contagem de colunas,
 * como no desenho dos glifos).
 */
function advanceWithin(
  atlas: GlyphAtlas,
  style: TextStyle,
  text: string,
  at: number,
  startX: number,
  spaceAdvance: number,
  tabWidth: number,
): number {
  let x = startX;
  let column = 0;
  let off = 0;
  const limit = Math.max(0, Math.min(at, text.length));
  while (off < limit) {
    const code = text.codePointAt(off);
    if (code === undefined) break;
    const rune = String.fromCodePoint(code);
    const size = rune.length;
    if (rune === "\t") {
      const stop = tabWidth - (column % tabWidth);
      x += spaceAdvance * stop;
      column += stop;
      off += size;
      continue;
    }
    const placed = atlas.resolveGlyph(rune, style);
    x += placed.advance;
    column += 1;
    off += size;
  }
  return x;
}

/**
 * Pinta a seleção (rects de fundo) entre `anchor` e `active` — **um rect por segmento** de wrap
 * atravessado (sem wrap: um rect por linha, como sempre).
 *
 * As linhas colapsadas (folding) não têm segmentos desenháveis: usa-se a row reservada e o
 * traçado da linha inteira (compatível com o caminho sem wrap).
 */
function pushSelectionRects(
  rects: RectInstance[],
  source: LineSource,
  layout: LineLayout,
  atlas: GlyphAtlas,
  style: TextStyle,
  rowMap: VisualRowMap,
  selection: Selection,
  first: number,
  end: number,
  spaceAdvance: number,
): void {
  const { start, end: selEnd } = SelectionOps.normalized(selection);
  const startPos = source.positionAt(start);
  const endPos = source.positionAt(Math.max(0, selEnd - 1));
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
    for (const seg of rowMap.paintSegmentsOf(line)) {
      // Interseção da seleção com o segmento (offsets da linha).
      const from = Math.max(lineStartCol, seg.start);
      const to = Math.min(lineEndCol, seg.end);
      if (to <= from) continue;
      const selStartX = advanceWithin(
        atlas,
        style,
        seg.text,
        from - seg.start,
        layout.paddingLeft,
        spaceAdvance,
        layout.tabWidth,
      );
      const selEndX = advanceWithin(
        atlas,
        style,
        seg.text,
        to - seg.start,
        layout.paddingLeft,
        spaceAdvance,
        layout.tabWidth,
      );
      if (selEndX - selStartX <= 0) continue;
      rects.push({
        rect: {
          x: selStartX,
          y: layout.paddingTop + seg.row * layout.lineHeight - layout.scrollOffsetPx,
          w: selEndX - selStartX,
          h: layout.lineHeight,
        },
        color: layout.selectionColor,
      });
    }
  }
}

/**
 * Calcula as guias de indentação (linhas verticais semi-transparentes) para o range visível.
 * Cada nível de indentação ganha uma linha vertical contínua enquanto o código permanece
 * naquele nível. V1 usa espaçamento monospace fixo (~8px por nível).
 */
function calcIndentGuides(
  source: LineSource,
  layout: LineLayout,
  range: { first: number; count: number },
): IndentGuide[] | undefined {
  if (range.count <= 0) return undefined;

  const guides: IndentGuide[] = [];
  const visited = new Map<number, number>(); // indentLevel -> startLine
  const tabSize = layout.tabWidth;
  const { paddingLeft, lineHeight, paddingTop, scrollOffsetPx } = layout;

  for (let i = range.first; i < range.first + range.count && i < source.lineCount(); i++) {
    const text = source.line(i);
    const indent = leadingSpaces(text) / tabSize; // indent level
    const trimmed = text.trim();

    // Linha vazia? continua guias existentes (não fecha nem abre)
    if (trimmed.length === 0) continue;

    // Guarda o nível de indentação atual e quando começou
    for (let level = 1; level <= indent; level++) {
      if (!visited.has(level)) {
        visited.set(level, i);
      }
    }

    // Fecha guias que não se estendem até esta linha
    for (const [level, startLine] of visited) {
      if (level > indent) {
        const x = paddingLeft + level * tabSize * 8; // ~8px por indent (monospace)
        guides.push({
          x,
          top: paddingTop + (startLine - range.first) * lineHeight - scrollOffsetPx,
          bottom: paddingTop + (i - range.first) * lineHeight - scrollOffsetPx - 2,
        });
        visited.delete(level);
      }
    }
  }

  // Fecha guias pendentes no fim do range
  for (const [level, startLine] of visited) {
    const x = paddingLeft + level * tabSize * 8;
    guides.push({
      x,
      top: paddingTop + (startLine - range.first) * lineHeight - scrollOffsetPx,
      bottom: paddingTop + range.count * lineHeight - scrollOffsetPx - 2,
    });
  }

  return guides.length > 0 ? guides : undefined;
}

/** Conta espaços iniciais (não tabs). */
function leadingSpaces(s: string): number {
  let i = 0;
  while (i < s.length && s[i] === " ") i++;
  return i;
}

/**
 * Clareia uma cor RGBA por um fator (0 = sem mudança, 1 = branco). Cada canal é interpolado
 * linearmente: `result = color + (255 - color) * factor`. Alpha não é alterado.
 */
function lighten(color: RGBA, factor: number): RGBA {
  const r = Math.min(255, Math.round(((color >>> 24) & 0xff) + (255 - ((color >>> 24) & 0xff)) * factor));
  const g = Math.min(255, Math.round(((color >>> 16) & 0xff) + (255 - ((color >>> 16) & 0xff)) * factor));
  const b = Math.min(255, Math.round(((color >>> 8) & 0xff) + (255 - ((color >>> 8) & 0xff)) * factor));
  const a = color & 0xff;
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
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
