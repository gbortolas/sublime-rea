/**
 * Scribe — Minimap: visão geral do documento (P2#9) + Hover Preview (P2#9b).
 *
 * Canvas secundário sobreposto ao editor. Renderiza cada linha como uma barra
 * colorida de 1–2px e destaca a viewport atual. Suporte a clique/arrasto para
 * navegar.
 *
 * O Hover Preview exibe um tooltip com o código-fonte real (syntax highlighted)
 * ao passar o mouse sobre o minimap — tipo "lupa" do VS Code.
 */

import type { Viewport, DocumentHighlight, HighlightSpan, ThemeResolver, RGBA, SearchMatch } from "../shared";

const MINIMAP_WIDTH = 72;
const BAR_MIN_HEIGHT = 1;
const LINE_EMPTY_ALPHA = 0.1;
const LINE_CONTENT_ALPHA = 0.45;
const HOVER_PREVIEW_LINES = 7;
const HOVER_DEBOUNCE_MS = 100;

// ---------------------------------------------------------------------------
// Minimap base (pintura do canvas)
// ---------------------------------------------------------------------------

/**
 * Converte o RGBA empacotado (0xRRGGBBAA) para string CSS. Se `alpha` for
 * fornecido, sobrepõe o alpha do próprio RGBA.
 */
function rgbaToCss(rgba: RGBA, alpha?: number): string {
  const r = (rgba >>> 24) & 0xff;
  const g = (rgba >>> 16) & 0xff;
  const b = (rgba >>> 8) & 0xff;
  const a = alpha ?? ((rgba & 0xff) / 255);
  return a === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

/**
 * Paleta do minimap, resolvida a cada `paint()`. O minimap desenha o seu próprio canvas, então
 * precisa receber a paleta do tema ativo — sem isso vira uma tarja escura sobre o tema claro.
 */
export interface MinimapColors {
  /** Fundo da faixa (a cor do editor). */
  readonly background: string;
  /** Cor das barras que representam as linhas. */
  readonly line: string;
  /** Realce da viewport atual. */
  readonly viewport: string;
  /** Borda do realce da viewport. */
  readonly viewportBorder: string;
  /** Cor dos marcadores de busca. */
  readonly searchMatch: string;
  /** Cor do match atual da busca. */
  readonly searchCurrent: string;
  /** Cor do marcador de diagnóstico do tipo error. */
  readonly diagnosticError: string;
  /** Cor do marcador de diagnóstico do tipo warning. */
  readonly diagnosticWarning: string;
  /** Cor do marcador de diagnóstico do tipo info. */
  readonly diagnosticInfo: string;
}

export interface MinimapSource {
  /** Número total de linhas no documento. */
  lineCount(): number;
  /** Conteúdo textual da linha `i`. */
  line(i: number): string;
}

export interface MinimapDeps {
  source: MinimapSource;
  viewport: Viewport & { scrollOffsetPx(): number };
  lineHeight: number;
  /** Função que retorna a altura atual da viewport em px (pode mudar com resize). */
  getViewportHeight: () => number;
  /** Paleta corrente (consultada a cada desenho, então acompanha a troca de tema). */
  colors: () => MinimapColors;
  /** OPCIONAL: devolve os HighlightSpan de uma linha (do HighlightStore). */
  spansFor?: (line: number) => readonly HighlightSpan[] | undefined;
  /** OPCIONAL: resolvedor de escopo → cor (para resolver spans). */
  syntaxTheme?: ThemeResolver;
  /** OPCIONAL: matches de busca para desenhar marcadores (getter lazy). */
  searchMatches?: () => readonly SearchMatch[] | undefined;
  /** OPCIONAL: índice do match atual (getter lazy). */
  searchCurrentIndex?: () => number | undefined;
  /** OPCIONAL: diagnósticos LSP para desenhar marcadores (getter lazy). */
  diagnostics?: () => readonly { line: number; severity: string }[] | undefined;
}

/** Resultado do `attachMinimap`: para desligar. */
export interface MinimapBinding {
  readonly container: HTMLElement;
  /** Atualiza o desenho (chame a cada frame ou quando o documento mudar). */
  update(): void;
  dispose(): void;
}

export function attachMinimap(deps: MinimapDeps): MinimapBinding {
  const container = document.getElementById("minimap");
  if (!container) throw new Error("Minimap container #minimap não encontrado no HTML");

  const canvas = container.querySelector<HTMLCanvasElement>("#minimap-surface");
  if (!canvas) throw new Error("Minimap canvas #minimap-surface não encontrado");

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas2D não disponível para o minimap");

  let dragging = false;

  const paint = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth || MINIMAP_WIDTH;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;

    canvas.width = Math.ceil(w * dpr);
    canvas.height = Math.ceil(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { source, viewport, lineHeight, getViewportHeight } = deps;
    const viewportHeight = getViewportHeight();
    const lineCount = source.lineCount();

    const colors = deps.colors();

    // Fundo
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, w, h);

    if (lineCount === 0) return;

    // Altura de cada linha no minimap (pelo menos 1px)
    const lineH = Math.max(BAR_MIN_HEIGHT, h / lineCount);

    // Desenha cada linha como uma barra horizontal
    const barW = Math.max(2, w - 4);
    const { spansFor, syntaxTheme } = deps;
    for (let i = 0; i < lineCount; i++) {
      const y = i * lineH;
      const text = source.line(i);
      const hasContent = text.trim().length > 0;

      // ── Syntax colorida (se disponível) ────────────────────────────────
      const spans = spansFor?.(i);
      if (spans !== undefined && spans.length > 0 && hasContent) {
        let x = 2;
        for (const span of spans) {
          const segLen = span.end - span.start;
          const ratio = segLen / text.length;
          const segW = Math.max(1, barW * ratio);
          const style = syntaxTheme?.styleFor(span.scope);
          const color = style?.color;
          ctx.globalAlpha = LINE_CONTENT_ALPHA;
          ctx.fillStyle = color !== undefined ? rgbaToCss(color) : colors.line;
          ctx.fillRect(x, y, segW, Math.max(1, Math.ceil(lineH)));
          x += segW;
        }
      } else {
        // Linha sem spans ou vazia: cor default (como antes)
        ctx.globalAlpha = hasContent ? LINE_CONTENT_ALPHA : LINE_EMPTY_ALPHA;
        ctx.fillStyle = colors.line;
        ctx.fillRect(2, y, barW, Math.max(1, Math.ceil(lineH)));
      }
    }
    ctx.globalAlpha = 1;

    // ── Marcadores de diagnóstico (P3.x) ──────────────────────────────────
    // Desenha finos marcadores na borda direita (à esquerda dos de busca)
    const diagnostics = deps.diagnostics?.();
    if (diagnostics !== undefined && diagnostics.length > 0) {
      for (const diag of diagnostics) {
        const y = diag.line * lineH;
        let color: string;
        switch (diag.severity) {
          case "error":
            color = colors.diagnosticError;
            break;
          case "warning":
            color = colors.diagnosticWarning;
            break;
          case "info":
          default:
            color = colors.diagnosticInfo;
            break;
        }
        ctx.globalAlpha = LINE_CONTENT_ALPHA;
        ctx.fillStyle = color;
        ctx.fillRect(w - 16, y, 7, Math.max(1, Math.ceil(lineH)));
      }
    }

    // ── Marcadores de busca (P3.x) ───────────────────────────────────────
    // Desenha finos marcadores na borda direita (à direita dos de diagnóstico)
    const searchMatches = deps.searchMatches?.();
    const searchCurrentIndex = deps.searchCurrentIndex?.();
    if (searchMatches !== undefined && searchMatches.length > 0) {
      for (let m = 0; m < searchMatches.length; m++) {
        const match = searchMatches[m]!;
        const y = match.line * lineH;
        ctx.globalAlpha = 1;
        ctx.fillStyle = m === searchCurrentIndex ? colors.searchCurrent : colors.searchMatch;
        ctx.fillRect(w - 8, y, 6, Math.max(1, Math.ceil(lineH)));
      }
    }

    // ── Fim dos marcadores ───────────────────────────────────────────────
    ctx.globalAlpha = 1;

    // Viewport highlight
    const scrollLine = viewport.scrollOffsetPx() / lineHeight;
    const visibleLines = Math.ceil(viewportHeight / lineHeight);
    const vpY = scrollLine * lineH;
    const vpH = Math.min(visibleLines * lineH, h - vpY);

    ctx.fillStyle = colors.viewport;
    ctx.fillRect(0, vpY, w, vpH);
    ctx.strokeStyle = colors.viewportBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, vpY, w - 1, vpH);
  };

  const scrollToPageY = (pageY: number): void => {
    const { source, viewport } = deps;
    const h = container.clientHeight;
    if (h <= 0 || source.lineCount() <= 0) return;

    const rect = container.getBoundingClientRect();
    const localY = pageY - rect.top;
    const ratio = localY / h;
    const targetLine = Math.round(ratio * source.lineCount());
    viewport.scrollTo(targetLine);
  };

  const onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    dragging = true;
    scrollToPageY(e.pageY);
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    e.preventDefault();
    scrollToPageY(e.pageY);
  };

  const onMouseUp = (): void => {
    dragging = false;
  };

  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  return {
    container,
    update: paint,
    dispose: () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Minimap Hover Preview — "lupa" com código real e syntax highlighting
// ---------------------------------------------------------------------------

export interface MinimapHoverDeps {
  source: MinimapSource;
  /** Container do minimap (para eventos de mouse). */
  container: HTMLElement;
  /** Canvas do minimap (para eventos de mouse). */
  canvas: HTMLCanvasElement;
  /** Família da fonte monospace do editor (ex: "JetBrains Mono", "Consolas"). */
  fontFamily: string;
  /** Tamanho da fonte em px para o tooltip. */
  fontSize: number;
  /** Resolvedor de escopo → cor (syntaxTheme). */
  syntaxTheme: ThemeResolver;
  /** Função para pedir realce de um range (usa o bridge.highlight internamente). */
  requestHighlight: (first: number, count: number) => Promise<DocumentHighlight>;
  /** Handle do documento ativo, ou undefined sem documento. */
  getHandle: () => number | undefined;
}

/** Resultado do `attachMinimapHover`: para desligar. */
export interface MinimapHoverBinding {
  dispose(): void;
}

export function attachMinimapHover(deps: MinimapHoverDeps): MinimapHoverBinding {
  let tooltipEl: HTMLElement | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFirstLine = -1;
  let lastCount = 0;
  let cachedContent: string | null = null;

  const removeTooltip = (): void => {
    if (tooltipEl !== null) {
      tooltipEl.remove();
      tooltipEl = null;
    }
    lastFirstLine = -1;
    lastCount = 0;
    cachedContent = null;
  };

  const lineAtY = (pageY: number): number | undefined => {
    const rect = deps.container.getBoundingClientRect();
    const h = rect.height;
    if (h <= 0) return undefined;
    const localY = pageY - rect.top;
    const ratio = localY / h;
    const line = Math.round(ratio * deps.source.lineCount());
    if (line < 0 || line >= deps.source.lineCount()) return undefined;
    return line;
  };

  const rgbaToHex = (rgba: RGBA): string => {
    const v = rgba >>> 0;
    const r = ((v >>> 24) & 0xff).toString(16).padStart(2, "0");
    const g = ((v >>> 16) & 0xff).toString(16).padStart(2, "0");
    const b = ((v >>> 8) & 0xff).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  };

  const escapeHtml = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const buildContent = (firstLine: number, count: number): string => {
    let html = "";
    for (let i = 0; i < count; i++) {
      const line = firstLine + i;
      const text = deps.source.line(line);
      if (text === undefined || text === null) {
        html += "<div class=\"mm-hover-line\">&nbsp;</div>\n";
        continue;
      }
      html += "<div class=\"mm-hover-line\">";
      // Tentar aplicar syntax highlighting via ThemeResolver
      // Sem acesso direto aos spans do HighlightStore, usamos o ThemeResolver
      // com uma heurística simples: se o `requestHighlight` já retornou dados,
      // eles foram cacheados — mas como não temos o HighlightStore aqui,
      // renderizamos o texto puro com cor default.
      // OBS: futuramente podemos passar um callback `spansFor(line)` para colorir.
      html += escapeHtml(text);
      html += "</div>\n";
    }
    return html;
  };

  const buildColoredContent = (
    firstLine: number,
    highlight: DocumentHighlight,
  ): string => {
    let html = "";
    const lineMap = new Map<number, readonly HighlightSpan[]>();
    for (const hl of highlight.lines) {
      lineMap.set(hl.line, hl.spans);
    }
    for (let i = 0; i < highlight.lines.length; i++) {
      const line = firstLine + i;
      const text = deps.source.line(line);
      const spans = lineMap.get(line) ?? [];
      html += "<div class=\"mm-hover-line\">";
      if (spans.length > 0) {
        let pos = 0;
        for (const span of spans) {
          if (span.start > pos) {
            html += escapeHtml(text.slice(pos, span.start));
          }
          const scopeText = text.slice(span.start, span.end);
          const style = deps.syntaxTheme.styleFor(span.scope);
          const color = style?.color;
          if (color !== undefined) {
            html += `<span style="color:${rgbaToHex(color)}">${escapeHtml(scopeText)}</span>`;
          } else {
            html += escapeHtml(scopeText);
          }
          pos = span.end;
        }
        if (pos < text.length) {
          html += escapeHtml(text.slice(pos));
        }
      } else {
        html += escapeHtml(text);
      }
      html += "</div>\n";
    }
    return html;
  };

  const showTooltip = (content: string, pageY: number): void => {
    const rect = deps.container.getBoundingClientRect();
    if (tooltipEl === null) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "minimap-hover-tooltip";
      document.body.appendChild(tooltipEl);
    }
    tooltipEl.innerHTML = content;
    // Só o font-size precisa vir de JS (vem da config do editor)
    tooltipEl.style.fontSize = `${deps.fontSize}px`;
    tooltipEl.style.fontFamily = deps.fontFamily;
    // Posicionamento inteligente: à esquerda por padrão, à direita se não couber
    const tooltipW = tooltipEl.offsetWidth || 200;
    const tooltipH = tooltipEl.offsetHeight || 200;
    const gap = 8;
    // Tenta esquerda primeiro
    const leftSpace = rect.left - gap;
    let tooltipX: number;
    if (leftSpace >= tooltipW) {
      tooltipX = rect.left - gap;
    } else {
      // Não coube à esquerda → mostra à direita
      tooltipX = rect.right + gap;
    }
    let tooltipY = pageY - tooltipH / 2;
    tooltipY = Math.max(8, Math.min(tooltipY, window.innerHeight - tooltipH - 8));
    tooltipEl.style.left = `${tooltipX}px`;
    tooltipEl.style.top = `${tooltipY}px`;
  };

  const updateTooltip = (pageY: number): void => {
    // Atualiza posição vertical em tempo real (tooltip segue o mouse)
    if (tooltipEl !== null && cachedContent !== null) {
      const rect = deps.container.getBoundingClientRect();
      const tooltipH = tooltipEl.offsetHeight || 200;
      const gap = 8;
      const leftSpace = rect.left - gap;
      const tooltipW = tooltipEl.offsetWidth || 200;
      if (leftSpace >= tooltipW) {
        tooltipEl.style.left = `${rect.left - gap}px`;
      } else {
        tooltipEl.style.left = `${rect.right + gap}px`;
      }
      let tooltipY = pageY - tooltipH / 2;
      tooltipY = Math.max(8, Math.min(tooltipY, window.innerHeight - tooltipH - 8));
      tooltipEl.style.top = `${tooltipY}px`;
    }

    const line = lineAtY(pageY);
    if (line === undefined) {
      removeTooltip();
      return;
    }
    const half = Math.floor(HOVER_PREVIEW_LINES / 2);
    const firstLine = Math.max(0, line - half);
    const count = Math.min(HOVER_PREVIEW_LINES, deps.source.lineCount() - firstLine);
    if (count <= 0) {
      removeTooltip();
      return;
    }

    // Se já temos o mesmo range em cache, mostra imediatamente
    if (firstLine === lastFirstLine && count === lastCount && cachedContent !== null) {
      showTooltip(cachedContent, pageY);
      return;
    }

    // Mostra preview sem realce enquanto carrega
    const plainContent = buildContent(firstLine, count);
    showTooltip(plainContent, pageY);
    lastFirstLine = firstLine;
    lastCount = count;

    // Agenda requisição de realce
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      const handle = deps.getHandle();
      if (handle === undefined) return;
      deps.requestHighlight(firstLine, count)
        .then((highlight) => {
          if (highlight.revision < 0) return; // resposta inválida
          const colored = buildColoredContent(firstLine, highlight);
          cachedContent = colored;
          // Se o tooltip ainda está visível, atualiza com as cores
          if (tooltipEl !== null) {
            showTooltip(colored, pageY);
          }
        })
        .catch(() => {
          // Fallback: mantém o preview sem cores
        });
    }, HOVER_DEBOUNCE_MS);
  };

  deps.canvas.addEventListener("mousemove", (e: MouseEvent) => {
    updateTooltip(e.pageY);
  });

  deps.canvas.addEventListener("mouseleave", () => {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    removeTooltip();
  });

  return {
    dispose: (): void => {
      if (hoverTimer !== null) clearTimeout(hoverTimer);
      if (tooltipEl !== null) tooltipEl.remove();
    },
  };
}