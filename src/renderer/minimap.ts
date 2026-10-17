/**
 * Scribe — Minimap: visão geral do documento (P2#9).
 *
 * Canvas secundário sobreposto ao editor. Renderiza cada linha como uma barra
 * colorida de 1–2px e destaca a viewport atual. Suporte a clique/arrasto para
 * navegar.
 */

import type { Viewport } from "../shared";

const MINIMAP_WIDTH = 72;
const BAR_MIN_HEIGHT = 1;
const LINE_EMPTY_ALPHA = 0.1;
const LINE_CONTENT_ALPHA = 0.45;
const VIEWPORT_BG = "rgba(255,255,255,0.08)";
const VIEWPORT_BORDER = "rgba(255,255,255,0.25)";

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

    // Fundo
    ctx.fillStyle = "#1a1a1e";
    ctx.fillRect(0, 0, w, h);

    if (lineCount === 0) return;

    // Altura de cada linha no minimap (pelo menos 1px)
    const lineH = Math.max(BAR_MIN_HEIGHT, h / lineCount);

    // Desenha cada linha como uma barra horizontal
    const barW = Math.max(2, w - 4);
    for (let i = 0; i < lineCount; i++) {
      const y = i * lineH;
      const text = source.line(i);
      const alpha = text.trim().length > 0 ? LINE_CONTENT_ALPHA : LINE_EMPTY_ALPHA;
      ctx.fillStyle = `rgba(200,200,200,${alpha})`;
      ctx.fillRect(2, y, barW, Math.max(1, Math.ceil(lineH)));
    }

    // Viewport highlight
    const scrollLine = viewport.scrollOffsetPx() / lineHeight;
    const visibleLines = Math.ceil(viewportHeight / lineHeight);
    const vpY = scrollLine * lineH;
    const vpH = Math.min(visibleLines * lineH, h - vpY);

    ctx.fillStyle = VIEWPORT_BG;
    ctx.fillRect(0, vpY, w, vpH);
    ctx.strokeStyle = VIEWPORT_BORDER;
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