/**
 * Scribe — Lupa de código ("code loupe"): o **zoom colorido** da coluna de código.
 *
 * Ao passar o mouse sobre o minimap, um painel flutuante aparece **à esquerda** da coluna
 * (nunca sobre ela) mostrando ~14 linhas de código **ampliadas** (fonte do editor ×
 * {@link LOUPE_ZOOM}) e **coloridas por token** — o realce vem do `bridge.highlight` do processo
 * principal, então a lupa funciona em qualquer linha do documento (não só nas já realçadas).
 * A linha sob o cursor é destacada e a linha do caret leva um marcador lateral.
 *
 * Ao **arrastar**, a lupa acompanha o mouse; o `attachMinimap` (mesma coluna) rola o documento
 * até a linha sob o cursor. Ao sair do minimap, a lupa some com um *fade* curto (sem piscar).
 *
 * **Degradação:** sem documento ⇒ nada aparece; sem spans de sintaxe ⇒ mostra o texto puro
 * (mesma fonte/zoom), sem quebrar.
 *
 * A geometria vive em funções **puras** (sem DOM) — `computeLoupeWindow`,
 * `computeLoupePanelSize`, `computeLoupePosition`, `loupeLineOffset`,
 * `computeLoupeContentOffset` e `tokenizeLoupeLine` — testadas em `./code-loupe.test.ts`.
 */

import type { DocumentHighlight, HighlightSpan, RGBA, ThemeResolver } from "../shared";
import { computeMinimapLayout, minimapLineAtY } from "./minimap";
import type { MinimapSource } from "./minimap";

// ---------------------------------------------------------------------------
// Constantes da lupa
// ---------------------------------------------------------------------------

/**
 * Multiplicador de zoom do preview (fonte do editor × 1.8).
 *
 * Era 2.5 (fonte 15px ⇒ 38px): a lupa ficava enorme e o texto era cortado na borda. Com 1.8
 * (15px ⇒ 27px) o preview continua legível e cabe na largura do painel.
 */
export const LOUPE_ZOOM = 1.8;
/** Largura alvo do painel da lupa (px) — 320px cabem na janela sem estourar. */
export const LOUPE_WIDTH_PX = 320;
/** Largura mínima do painel (px) — abaixo disso não há espaço à esquerda do minimap. */
export const LOUPE_MIN_WIDTH_PX = 160;
/** Quantidade de linhas exibidas no preview. */
export const LOUPE_LINE_COUNT = 14;
/** Debounce antes de mostrar a lupa (ms) — evita abrir com o mouse "passando". */
export const LOUPE_DEBOUNCE_MS = 120;
/** Folga entre o painel e o minimap (px). */
export const LOUPE_GAP_PX = 8;
/** Margem mínima do painel na borda da janela (px). */
export const LOUPE_MARGIN_PX = 8;
/** Duração do fade-out (ms). */
export const LOUPE_FADE_MS = 140;
/** Fator de entrelinha do preview (× a fonte ampliada). */
export const LOUPE_LINE_SPACING = 1.25;

// ---------------------------------------------------------------------------
// Geometria — funções puras (sem DOM), testáveis
// ---------------------------------------------------------------------------

/** Janela de linhas exibida no preview da lupa. */
export interface LoupeWindow {
  /** Primeira linha do documento exibida. */
  readonly firstLine: number;
  /** Última linha exibida (**inclusiva**); `-1` quando não há nada. */
  readonly lastLine: number;
  /** Quantidade de linhas exibidas. */
  readonly count: number;
}

/** Opções de {@link computeLoupeWindow}. */
export interface LoupeWindowOptions {
  /** Linha sob o cursor (o centro da janela). */
  readonly line: number;
  /** Total de linhas do documento. */
  readonly lineCount: number;
  /** Linhas desejadas no preview. Default: {@link LOUPE_LINE_COUNT}. */
  readonly lines?: number;
}

/**
 * Janela de linhas do preview: **centrada** na linha sob o cursor e recortada nas bordas do
 * documento (nunca inventa linhas fora do arquivo).
 */
export function computeLoupeWindow(options: LoupeWindowOptions): LoupeWindow {
  const { lineCount } = options;
  if (lineCount <= 0) return { firstLine: 0, lastLine: -1, count: 0 };
  const wanted = Math.max(1, options.lines ?? LOUPE_LINE_COUNT);
  const lines = Math.min(wanted, lineCount);
  const half = Math.floor(lines / 2);
  const firstLine = Math.max(0, Math.min(options.line - half, lineCount - lines));
  const count = Math.min(lines, lineCount - firstLine);
  return { firstLine, lastLine: firstLine + count - 1, count };
}

/** Tamanho do painel da lupa. */
export interface LoupePanelSize {
  /** Largura do painel (px). */
  readonly width: number;
  /** Altura do painel sem recorte (px) — `lines × lineHeight`. */
  readonly height: number;
  /** Tamanho da fonte ampliada (px). */
  readonly fontSize: number;
  /** Altura de uma linha do preview (px). */
  readonly lineHeight: number;
  /** Quantidade de linhas do preview. */
  readonly lines: number;
}

/** Opções de {@link computeLoupePanelSize}. */
export interface LoupePanelSizeOptions {
  /** Tamanho da fonte do editor (px) — é multiplicado pelo zoom. */
  readonly fontSize: number;
  /** Linhas do preview. Default: {@link LOUPE_LINE_COUNT}. */
  readonly lines?: number;
  /** Multiplicador de zoom. Default: {@link LOUPE_ZOOM}. */
  readonly zoom?: number;
  /** Largura desejada (px). Default: {@link LOUPE_WIDTH_PX}. */
  readonly width?: number;
  /** Largura **disponível** (px) — o painel nunca é maior que o espaço livre. */
  readonly availableWidth?: number;
}

/**
 * Tamanho do painel: a fonte do editor **ampliada** (`fontSize × zoom`), com entrelinha fixa.
 * A largura é limitada pelo espaço disponível à esquerda do minimap — assim a lupa **nunca**
 * invade a coluna.
 */
export function computeLoupePanelSize(options: LoupePanelSizeOptions): LoupePanelSize {
  const zoom = options.zoom ?? LOUPE_ZOOM;
  const lines = Math.max(1, options.lines ?? LOUPE_LINE_COUNT);
  const fontSize = Math.max(1, Math.round(options.fontSize * zoom));
  const lineHeight = Math.max(1, Math.round(fontSize * LOUPE_LINE_SPACING));
  const wanted = Math.max(1, options.width ?? LOUPE_WIDTH_PX);
  const available = options.availableWidth ?? Number.POSITIVE_INFINITY;
  const width = Math.max(1, Math.min(wanted, available));
  return { width, height: lines * lineHeight, fontSize, lineHeight, lines };
}

/** Posição do painel da lupa (coordenadas de viewport). */
export interface LoupePosition {
  readonly left: number;
  readonly top: number;
}

/** Opções de {@link computeLoupePosition}. */
export interface LoupePositionOptions {
  /** Borda esquerda do minimap (px, coordenadas de viewport). */
  readonly minimapLeft: number;
  /** Y do cursor (px, coordenadas de viewport). */
  readonly pointerY: number;
  /** Largura do painel (px). */
  readonly panelWidth: number;
  /** Altura do painel (px). */
  readonly panelHeight: number;
  /** Largura da janela (px). */
  readonly viewportWidth: number;
  /** Altura da janela (px). */
  readonly viewportHeight: number;
  /** Folga até o minimap (px). Default: {@link LOUPE_GAP_PX}. */
  readonly gap?: number;
  /** Margem da borda da janela (px). Default: {@link LOUPE_MARGIN_PX}. */
  readonly margin?: number;
}

/**
 * Posiciona o painel **à esquerda** do minimap (nunca sobre ele) e **centrado** no cursor,
 * com o painel inteiro dentro da janela.
 */
export function computeLoupePosition(options: LoupePositionOptions): LoupePosition {
  const gap = options.gap ?? LOUPE_GAP_PX;
  const margin = options.margin ?? LOUPE_MARGIN_PX;
  const maxLeft = Math.max(margin, options.viewportWidth - options.panelWidth - margin);
  const left = Math.max(margin, Math.min(options.minimapLeft - gap - options.panelWidth, maxLeft));
  const maxTop = Math.max(margin, options.viewportHeight - options.panelHeight - margin);
  const top = Math.max(margin, Math.min(options.pointerY - options.panelHeight / 2, maxTop));
  return { left, top };
}

/** Opções de {@link loupeLineOffset}. */
export interface LoupeLineOffsetOptions {
  /** Linha sob o cursor. */
  readonly line: number;
  /** Primeira linha da janela do preview. */
  readonly firstLine: number;
  /** Altura de uma linha do preview (px). */
  readonly lineHeight: number;
}

/** Offset (px) da linha sob o cursor **dentro do conteúdo** do preview. */
export function loupeLineOffset(options: LoupeLineOffsetOptions): number {
  return Math.max(0, (options.line - options.firstLine) * options.lineHeight);
}

/** Opções de {@link computeLoupeContentOffset}. */
export interface LoupeContentOffsetOptions {
  /** Offset da linha sob o cursor dentro do conteúdo (px). */
  readonly hoverOffset: number;
  /** Altura de uma linha do preview (px). */
  readonly lineHeight: number;
  /** Altura total do conteúdo (px). */
  readonly contentHeight: number;
  /** Altura visível do painel (px). */
  readonly panelHeight: number;
}

/**
 * Deslocamento vertical do conteúdo dentro do painel: centraliza a linha sob o cursor, sem
 * deixar "buraco" no topo nem rolar além do conteúdo.
 */
export function computeLoupeContentOffset(options: LoupeContentOffsetOptions): number {
  const maxScroll = Math.max(0, options.contentHeight - options.panelHeight);
  const desired = options.panelHeight / 2 - options.lineHeight / 2 - options.hoverOffset;
  const clamped = Math.max(-maxScroll, Math.min(0, desired));
  return clamped === 0 ? 0 : clamped; // normaliza -0 (evita surpresa em asserções)
}

/** Trecho de texto do preview, com a cor resolvida (quando houver). */
export interface LoupeToken {
  readonly text: string;
  /** Cor em `#rrggbb` ou `undefined` (sem regra de tema ⇒ cor herdada). */
  readonly color: string | undefined;
}

/** Converte o RGBA empacotado (0xRRGGBBAA) em `#rrggbb`. */
function rgbaToHex(rgba: RGBA): string {
  const v = rgba >>> 0;
  const r = ((v >>> 24) & 0xff).toString(16).padStart(2, "0");
  const g = ((v >>> 16) & 0xff).toString(16).padStart(2, "0");
  const b = ((v >>> 8) & 0xff).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

/**
 * Fatia a linha do documento em trechos coloridos pelos spans de sintaxe.
 *
 * Trechos sem span (ou sem regra de tema) ficam **sem cor** (herdam a cor do painel) — é a
 * degradação para arquivo sem gramática. Spans fora do texto são recortados (nunca inventa
 * caracteres).
 */
export function tokenizeLoupeLine(
  text: string,
  spans: readonly HighlightSpan[] | undefined,
  theme: ThemeResolver | undefined,
): LoupeToken[] {
  if (text.length === 0) return [];
  if (spans === undefined || spans.length === 0) return [{ text, color: undefined }];
  const tokens: LoupeToken[] = [];
  let pos = 0;
  for (const span of spans) {
    const start = Math.max(pos, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > pos) tokens.push({ text: text.slice(pos, start), color: undefined });
    if (end > start) {
      const style = theme?.styleFor(span.scope);
      const color = style?.color;
      tokens.push({
        text: text.slice(start, end),
        color: color !== undefined ? rgbaToHex(color) : undefined,
      });
    }
    pos = end;
  }
  if (pos < text.length) tokens.push({ text: text.slice(pos), color: undefined });
  return tokens;
}

// ---------------------------------------------------------------------------
// A lupa — DOM
// ---------------------------------------------------------------------------

/** Dependências da lupa (o `main.ts` monta). */
export interface CodeLoupeDeps {
  /** Container do minimap (#minimap) — o mouse é escutado aqui. */
  container: HTMLElement;
  /** Canvas do minimap. */
  canvas: HTMLCanvasElement;
  /** Fonte de linhas do documento (mesmo tipo usado pelo minimap). */
  source: MinimapSource;
  /** Família monoespaçada do editor (ex.: "monospace"). */
  fontFamily: string;
  /** Tamanho da fonte do editor em px (a lupa multiplica por `zoom`). */
  fontSize: number;
  /** Resolvedor de escopo → cor (syntaxTheme). */
  syntaxTheme: ThemeResolver;
  /** Pede o realce de um range de linhas (bridge.highlight). */
  requestHighlight: (first: number, count: number) => Promise<DocumentHighlight>;
  /** Handle do documento ativo (para invalidar o cache). */
  getHandle: () => number | undefined;
  /** Primeira linha da janela do minimap (mesma matemática da pintura). */
  minimapFirstLine?: () => number;
  /** Linha do caret (para marcar no preview). */
  getCaretLine?: () => number;
}

/** Resultado do `attachCodeLoupe`: para desligar. */
export interface CodeLoupeBinding {
  dispose(): void;
}

/** Cache do último realce recebido (a lupa mostra uma janela por vez). */
interface LoupeCache {
  readonly handle: number;
  readonly first: number;
  readonly count: number;
  readonly spans: Map<number, readonly HighlightSpan[]>;
}
/** O que foi renderizado por último (para não redesenhar o DOM à toa). */
interface LoupeRenderState {
  readonly first: number;
  readonly count: number;
  readonly hover: number;
  readonly caret: number | undefined;
}

export function attachCodeLoupe(deps: CodeLoupeDeps): CodeLoupeBinding {
  let panel: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  let dragging = false;
  let currentLine: number | undefined;
  let cache: LoupeCache | null = null;
  let inflight: { handle: number; first: number; count: number } | null = null;
  /** Revisão do último realce recebido (mudou ⇒ o cache tem cores velhas). */
  let lastRevision: number | undefined;
  let rendered: LoupeRenderState | null = null;
  /** Altura de uma linha do preview (recalculada a cada render). */
  let currentLineHeight = Math.max(1, Math.round(Math.round(deps.fontSize * LOUPE_ZOOM) * LOUPE_LINE_SPACING));

  /**
   * Linha do documento sob o cursor — **a mesma matemática da pintura do minimap**
   * (janela de corte + passo vertical fixo).
   */
  const lineAtY = (clientY: number): number | undefined => {
    const lineCount = deps.source.lineCount();
    if (lineCount <= 0) return undefined;
    const rect = deps.container.getBoundingClientRect();
    if (rect.height <= 0) return undefined;
    const layout = computeMinimapLayout({
      viewportHeight: rect.height,
      lineCount,
      firstLine: deps.minimapFirstLine?.() ?? 0,
    });
    const line = minimapLineAtY({
      y: clientY - rect.top,
      rowPitch: layout.rowPitch,
      firstLine: layout.firstLine,
      lineCount,
    });
    if (line < 0 || line >= lineCount) return undefined;
    return line;
  };

  const ensurePanel = (): { panel: HTMLElement; content: HTMLElement } | null => {
    if (panel !== null && content !== null) return { panel, content };
    const el = document.createElement("div");
    el.className = "code-loupe";
    el.setAttribute("aria-hidden", "true");
    const lines = document.createElement("div");
    lines.className = "code-loupe-lines";
    el.appendChild(lines);
    document.body.appendChild(el);
    panel = el;
    content = lines;
    return { panel: el, content: lines };
  };

  /**
   * Aplica ao painel só o que é **dinâmico** (posição e métricas do preview).
   *
   * Tudo o que é **design** (z-index, fundo, borda, raio, sombra, transição) vive na classe
   * `.code-loupe` do `index.css` — antes o popup "vazava" do sistema com um `z-index` numérico
   * solto (10001, fora da escala `--z-*`), sombra e raio próprios, e um `opacity` inline que
   * anulava o estado de fade (`is-hiding`).
   */
  const stylePanel = (el: HTMLElement, size: LoupePanelSize, panelHeight: number): void => {
    el.style.width = `${size.width}px`;
    el.style.height = `${panelHeight}px`;
    el.style.fontFamily = deps.fontFamily;
    el.style.fontSize = `${size.fontSize}px`;
    el.style.lineHeight = `${size.lineHeight}px`;
  };

  /** Desenha as linhas do preview (texto + cor por token). */
  const renderContent = (
    host: HTMLElement,
    win: LoupeWindow,
    hoverLine: number,
    caretLine: number | undefined,
    spans: Map<number, readonly HighlightSpan[]> | null,
    lineHeight: number,
  ): void => {
    host.textContent = "";
    for (let line = win.firstLine; line <= win.lastLine; line++) {
      const el = document.createElement("div");
      el.className = "code-loupe-line";
      if (line === hoverLine) {
        el.classList.add("is-hover");
      }
      if (caretLine !== undefined && line === caretLine) {
        el.classList.add("is-caret");
        const marker = document.createElement("span");
        marker.className = "code-loupe-caret";
        // Só a ALTURA é dinâmica (a linha do preview); o resto do marcador é CSS.
        marker.style.height = `${lineHeight}px`;
        el.appendChild(marker);
      }
      const text = deps.source.line(line) ?? "";
      for (const token of tokenizeLoupeLine(text, spans?.get(line), deps.syntaxTheme)) {
        const span = document.createElement("span");
        span.textContent = token.text;
        if (token.color !== undefined) span.style.color = token.color;
        el.appendChild(span);
      }
      host.appendChild(el);
    }
  };

  /** Some com a lupa (com fade, sem piscar). */
  const hide = (immediate = false): void => {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    currentLine = undefined;
    rendered = null;
    if (panel === null) return;
    const el = panel;
    panel = null;
    content = null;
    if (immediate) {
      el.remove();
      return;
    }
    el.classList.add("is-hiding");
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      el.remove();
    }, LOUPE_FADE_MS);
  };

  /** Pede o realce da janela e re-renderiza quando a resposta chega. */
  const requestSpans = (handle: number, win: LoupeWindow): void => {
    if (cache !== null && cache.handle === handle && cache.first === win.firstLine && cache.count === win.count) {
      return;
    }
    if (inflight !== null && inflight.handle === handle && inflight.first === win.firstLine && inflight.count === win.count) {
      return;
    }
    const request = { handle, first: win.firstLine, count: win.count };
    inflight = request;
    deps
      .requestHighlight(win.firstLine, win.count)
      .then((highlight) => {
        if (highlight.revision < 0) return; // resposta inválida (sem documento/handle)
        // O documento mudou (revisão nova) ⇒ o cache antigo tem cores velhas: descarta.
        if (lastRevision !== undefined && highlight.revision !== lastRevision) {
          cache = null;
        }
        lastRevision = highlight.revision;
        const spans = new Map<number, readonly HighlightSpan[]>();
        for (const hl of highlight.lines) spans.set(hl.line, hl.spans);
        cache = { handle, first: win.firstLine, count: win.count, spans };
        if (inflight !== null && inflight.first === request.first && inflight.count === request.count) {
          inflight = null;
        }
        // Só re-renderiza se a janela atual ainda é a mesma.
        if (rendered !== null && rendered.first === win.firstLine && rendered.count === win.count) {
          const host = content;
          if (host !== null) {
            const caretLine = deps.getCaretLine?.();
            renderContent(host, win, rendered.hover, caretLine, cache.spans, currentLineHeight);
            applyContentOffset(host, win, rendered.hover);
          }
        }
      })
      .catch((error: unknown) => {
        if (inflight !== null && inflight.first === request.first && inflight.count === request.count) {
          inflight = null;
        }
        console.warn("Scribe: lupa sem realce de sintaxe", error);
      });
  };

  /** Altura visível do painel: o conteúdo, ou o que cabe na janela (com o mínimo de 1 linha). */
  const panelHeightFor = (contentHeight: number, lineHeight: number): number =>
    Math.min(contentHeight, Math.max(lineHeight, window.innerHeight - 2 * LOUPE_MARGIN_PX));

  const applyContentOffset = (host: HTMLElement, win: LoupeWindow, hoverLine: number): void => {
    const contentHeight = win.count * currentLineHeight;
    const panelHeight = panelHeightFor(contentHeight, currentLineHeight);
    const offset = computeLoupeContentOffset({
      hoverOffset: loupeLineOffset({ line: hoverLine, firstLine: win.firstLine, lineHeight: currentLineHeight }),
      lineHeight: currentLineHeight,
      contentHeight,
      panelHeight,
    });
    host.style.transform = `translateY(${offset}px)`;
  };

  /** Desenha (ou reposiciona) a lupa na linha sob o cursor. */
  const render = (line: number, clientY: number): void => {
    const handle = deps.getHandle();
    if (handle === undefined) {
      hide(true);
      return;
    }
    const lineCount = deps.source.lineCount();
    const win = computeLoupeWindow({ line, lineCount });
    if (win.count <= 0) {
      hide(true);
      return;
    }
    const rect = deps.container.getBoundingClientRect();
    const available = Math.max(0, rect.left - LOUPE_GAP_PX - LOUPE_MARGIN_PX);
    const size = computeLoupePanelSize({
      fontSize: deps.fontSize,
      lines: win.count,
      availableWidth: available,
    });
    if (size.width < LOUPE_MIN_WIDTH_PX) {
      hide(true); // não há espaço à esquerda do minimap
      return;
    }
    currentLineHeight = size.lineHeight;

    const contentHeight = win.count * size.lineHeight;
    const panelHeight = panelHeightFor(contentHeight, size.lineHeight);
    const pos = computeLoupePosition({
      minimapLeft: rect.left,
      pointerY: clientY,
      panelWidth: size.width,
      panelHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });

    const created = ensurePanel();
    if (created === null) return;
    const el = created.panel;
    const host = created.content;
    el.classList.remove("is-hiding");
    stylePanel(el, size, panelHeight);
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;

    const caretLine = deps.getCaretLine?.();
    const sameWindow =
      rendered !== null &&
      rendered.first === win.firstLine &&
      rendered.count === win.count &&
      rendered.hover === line &&
      rendered.caret === caretLine;
    if (!sameWindow) {
      const spans = cache !== null && cache.handle === handle && cache.first === win.firstLine && cache.count === win.count ? cache.spans : null;
      renderContent(host, win, line, caretLine, spans, size.lineHeight);
      rendered = { first: win.firstLine, count: win.count, hover: line, caret: caretLine };
      applyContentOffset(host, win, line);
    }
    requestSpans(handle, win);
  };

  /** Agenda a abertura da lupa (debounce curto). */
  const scheduleRender = (line: number, clientY: number): void => {
    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      render(line, clientY);
    }, LOUPE_DEBOUNCE_MS);
  };

  const onMouseMove = (e: MouseEvent): void => {
    const line = lineAtY(e.clientY);
    if (line === undefined) {
      hide();
      return;
    }
    const moved = line !== currentLine;
    currentLine = line;
    if (dragging || panel !== null) {
      render(line, e.clientY); // acompanha o mouse (inclusive durante o arrasto)
    } else if (moved) {
      scheduleRender(line, e.clientY);
    }
  };

  const onMouseDown = (e: MouseEvent): void => {
    dragging = true;
    const line = lineAtY(e.clientY);
    if (line === undefined) return;
    currentLine = line;
    render(line, e.clientY); // no arrasto a lupa aparece na hora
  };

  const onMouseUp = (): void => {
    dragging = false;
  };

  const onMouseLeave = (): void => {
    if (dragging) return; // durante o arrasto a lupa continua junto
    hide();
  };

  const onWindowMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const line = lineAtY(e.clientY);
    if (line === undefined) return;
    currentLine = line;
    render(line, e.clientY);
  };

  deps.container.addEventListener("mousemove", onMouseMove);
  deps.container.addEventListener("mouseleave", onMouseLeave);
  deps.canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  return {
    dispose: (): void => {
      if (showTimer !== null) clearTimeout(showTimer);
      if (fadeTimer !== null) clearTimeout(fadeTimer);
      showTimer = null;
      fadeTimer = null;
      deps.container.removeEventListener("mousemove", onMouseMove);
      deps.container.removeEventListener("mouseleave", onMouseLeave);
      deps.canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (panel !== null) {
        panel.remove();
        panel = null;
        content = null;
      }
    },
  };
}
