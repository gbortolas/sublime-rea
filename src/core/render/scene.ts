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
import { wrapLine } from "./soft-wrap";
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
   * preservada e o `scrollOffsetPx` continua contado em linhas lógicas.
   *
   * Quando informado, o renderizador passa a contar a rolagem em **linhas visuais**: nesse
   * caso `scrollOffsetPx` deve estar na mesma unidade (row visual), senão o texto quebrado
   * fica desalinhado em relação à barra de rolagem.
   */
  readonly visualRowOffset?: number;
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

  // Gutter: fundo + linha atual destacada + separador.
  if (layout.gutterWidth > 0) {
    rects.push({
      rect: { x: 0, y: 0, w: layout.gutterWidth, h: layout.viewport.h },
      color: layout.gutterBackground,
    });
    // Highlight da linha atual no gutter (se o caret estiver no range visível).
    if (caret && caret.line >= first && caret.line < end) {
      rects.push({
        rect: {
          x: 0,
          y: layout.paddingTop + caret.line * layout.lineHeight - layout.scrollOffsetPx,
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
    // Thumb: proporcional ao conteúdo
    const totalPx = source.lineCount() * layout.lineHeight;
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
  if (caret && caret.line >= first && caret.line < end) {
    rects.push({
      rect: {
        x: layout.gutterWidth,
        y: layout.paddingTop + caret.line * layout.lineHeight - layout.scrollOffsetPx,
        w: layout.viewport.w - layout.gutterWidth - layout.scrollbarWidth,
        h: layout.lineHeight,
      },
      color: lighten(layout.background, 0.03),
    });
  }

  // ── Soft wrap: resolve linhas visuais ───────────────────────────────────────────────────────
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

  interface VisualLine {
    readonly docLine: number;
    readonly row: number;          // row visual (base do Y) — 1 row por segmento de wrap
    readonly segmentOffset: number;  // offset do segmento no texto original (code units)
    readonly segmentText: string;    // texto do segmento (substring)
  }
  const visualLines: VisualLine[] = [];
  if (wrap) {
    // Row base da primeira linha do range: por padrão o índice da linha **lógica**
    // (`first`) — preserva a ancoragem atual (o scroll continua em linhas lógicas).
    // `layout.visualRowOffset` permite ao renderizador informar a row visual absoluta
    // (quando a rolagem passa a ser contada em linhas visuais).
    let row = layout.visualRowOffset ?? first;
    for (let di = first; di < end; di++) {
      if (collapsedLines.has(di)) {
        // Linha colapsada: não desenha, mas continua ocupando 1 row (compatível com
        // o caminho sem wrap, onde a row de uma linha é o seu índice lógico).
        row += 1;
        continue;
      }
      // `wrapLine` (soft-wrap.ts) é a implementação canônica: tem o early-exit
      // "cabe tudo" — linhas que cabem na largura **não** são quebradas.
      const segs = wrapLine(source.line(di), layout.wrapWidth, mw);
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si]!;
        visualLines.push({
          docLine: di,
          row: row + si,
          segmentOffset: seg.start,
          segmentText: seg.text,
        });
      }
      // A próxima linha lógica começa **depois** das rows ocupadas por esta.
      row += segs.length;
    }
  } else {
    for (let di = first; di < end; di++) {
      if (!collapsedLines.has(di)) {
        // Sem wrap: 1 row por linha de documento — a row é o índice lógico (comportamento atual).
        visualLines.push({ docLine: di, row: di, segmentOffset: 0, segmentText: source.line(di) });
      }
    }
  }
  const visualEnd = visualLines.length;

  for (let vi = 0; vi < visualEnd; vi++) {
    const vl = visualLines[vi]!;
    const index = vl.docLine;
    const text = vl.segmentText;
    // Y = row visual (acumulada: 1 row por segmento de wrap) — nunca colide com a
    // linha lógica seguinte, porque a row avança pelo nº de segmentos da linha anterior.
    const y = layout.paddingTop + vl.row * layout.lineHeight - layout.scrollOffsetPx;
    const spans = highlight?.spansFor(index);

    // Gutter: número da linha (1-based), direita-alinhado no gutter.
    // Só aparece no primeiro segmento visual de cada linha de documento.
    if (layout.gutterWidth > 0 && vl.segmentOffset === 0) {
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
          color: glyphColor(spans, highlight?.theme, offset + vl.segmentOffset) ?? layout.defaultColor,
        });
      }
      x += placed.advance;
      column += 1;
      offset += size;
    }

    // Bracket matching (P3#14): destaca o par com um retângulo fino (underline-like).
    if (bracketMatch && layout.bracketMatchColor) {
      const [open, close] = bracketMatch;
      for (const bp of [open, close]) {
        if (bp.line === index) {
          let bx = layout.paddingLeft;
          let bcol = 0;
          let boff = 0;
          const targetCol = Math.min(bp.column, text.length);
          while (boff < targetCol) {
            const code = text.codePointAt(boff);
            if (code === undefined) break;
            const rune = String.fromCodePoint(code);
            const size = rune.length;
            if (rune === "\t") {
              const stop = layout.tabWidth - (bcol % layout.tabWidth);
              bx += spaceAdvance * stop;
              bcol += stop;
            } else {
              const placed = atlas.resolveGlyph(rune, style);
              bx += placed.advance;
              bcol += 1;
            }
            boff += size;
          }
          const bracketChar = text[bp.column] ?? "";
          const charW = atlas.resolveGlyph(bracketChar, style).advance;
          rects.push({
            rect: { x: bx, y: y + layout.lineHeight - 3, w: Math.max(charW, 4), h: 2 },
            color: layout.bracketMatchColor,
          });
        }
      }
    }

    // Inlay hints (P4#19): desenha label após a posição calculada, em cor mais clara.
    if (inlayHints !== undefined) {
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
        color: isCurrent ? layout.searchCurrentColor : layout.searchMatchColor,
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
        color: layout.selectionColor,
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

  // Cuidados extras para múltiplos cursores (P2#5)
  if (extraCarets) {
    for (const ec of extraCarets) {
      if (ec.line >= first && ec.line < end) {
        rects.push({
          rect: {
            x: layout.paddingLeft + caretAdvance(atlas, style, ec.column, spaceAdvance),
            y: layout.paddingTop + ec.line * layout.lineHeight - layout.scrollOffsetPx,
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
      const { start, end } = SelectionOps.normalized(extraSel);
      const startPos = source.positionAt(start);
      const endPos = source.positionAt(Math.max(0, end - 1));
      const selFirst = Math.max(first, startPos.line);
      const selLast = Math.min(endPos.line, end - 1, source.lineCount() - 1);
      for (let line = selFirst; line <= selLast; line++) {
        const text = source.line(line);
        const lineStartCol = line === startPos.line ? startPos.column : 0;
        const lineEndCol = line === endPos.line ? endPos.column : text.length;
        if (lineStartCol >= lineEndCol) continue;
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
          color: layout.selectionColor,
        });
      }
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
