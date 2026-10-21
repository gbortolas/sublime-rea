/**
 * Scribe — Minimap: visão geral do documento (P2#9), colorido + "lupa" (P2#9b).
 *
 * Canvas secundário sobreposto ao editor. Cada linha vira uma barra horizontal **fina**
 * (altura **fixa**, 3px por padrão) cuja **largura é proporcional ao comprimento da linha**
 * — como no minimap do VS Code. A viewport atual é destacada e há clique/arrasto para navegar.
 *
 * **Política de corte (documento maior do que a faixa):** a altura da linha é fixa, então um
 * documento longo não cabe. Nesse caso o minimap **corta** e desenha só a janela de linhas
 * visíveis. Cortar é mais honesto do que encolher a barra até ela virar um bloco ilegível (o bug
 * antigo: `h/lineCount` fazia 60 linhas virarem faixas de 11px).
 *
 * **Janela = range visível (padrão):** por default a janela desenhada é o **mesmo range que o
 * editor mostra** (`viewport.visibleLineRange()`) — e é exatamente esse range que o
 * `HighlightStore` cobre, então as barras saem **coloridas** (a cor de cada token). Com
 * `followScroll: false` a janela volta ao topo do documento (comportamento legado explícito);
 * nesse caso não há spans e as barras caem no tom discreto.
 *
 * A **lupa** (preview ampliado e colorido do código sob o mouse, que segue o arrasto) vive em
 * `./code-loupe.ts`.
 */

import type { Viewport, HighlightSpan, ThemeResolver, RGBA, SearchMatch } from "../shared";

const MINIMAP_WIDTH = 72;
/** Altura **fixa** da barra de uma linha no minimap (px). Não escala com o documento. */
export const MINIMAP_LINE_HEIGHT = 3;
/** Altura mínima de uma barra (px). */
const BAR_MIN_HEIGHT = 1;
/** Largura mínima de uma barra não-vazia (px). */
export const MINIMAP_BAR_MIN_WIDTH = 2;
/** Padding interno à esquerda das barras (px). */
const BAR_LEFT_PAD = 2;
/** Padding interno à direita das barras (px). */
const BAR_RIGHT_PAD = 2;
/** Faixa reservada à direita para os marcadores de busca/diagnóstico (px). */
const MARKER_STRIP = 16;
/** Alpha das barras de conteúdo (discreto — não pode virar faixa sólida). */
const LINE_CONTENT_ALPHA = 0.55;

// ---------------------------------------------------------------------------
// Matemática do minimap — funções puras (sem DOM), testáveis
// ---------------------------------------------------------------------------

/** Geometria da faixa do minimap para um dado documento/janela. */
export interface MinimapLayout {
  /** Altura da barra de uma linha (px) — **fixa**, não depende do nº de linhas. */
  readonly lineH: number;
  /** Avanço vertical entre duas linhas (px): `lineH`, ou `lineH + 1` quando `lineH === 1` (gap). */
  readonly rowPitch: number;
  /** Quantas linhas do documento cabem na faixa (janela de corte). */
  readonly visibleLines: number;
  /** Primeira linha do documento desenhada (início da janela de corte). */
  readonly firstLine: number;
  /** `true` quando o documento não cabe inteiro na faixa. */
  readonly truncated: boolean;
}

/** Opções de {@link computeMinimapLayout}. */
export interface MinimapLayoutOptions {
  /** Altura da faixa do minimap (px). */
  readonly viewportHeight: number;
  /** Total de linhas do documento. */
  readonly lineCount: number;
  /** Altura da barra de uma linha (px). Default: {@link MINIMAP_LINE_HEIGHT}. */
  readonly lineHeight?: number;
  /** Início da janela de corte (linha do documento). Default: 0 (topo). */
  readonly firstLine?: number;
  /**
   * Teto de linhas da janela (a faixa pode não caber). Default: sem teto (capacity).
   * É o que corta a janela no **range visível** do editor.
   */
  readonly maxLines?: number;
  /**
   * Preenche a **faixa inteira** com a janela desenhada (o passo vertical cresce para
   * ocupar a altura disponível).
   *
   * Sem isso, a janela (que é o **range visível** do editor, ~30-40 linhas) ocupava
   * só ~13% da faixa de 700px — o minimap virava um "espelho" curto no topo, com o
   * resto vazio. Com `fill`, a faixa vira um **overview ampliado** do que se está vendo
   * (o passo é o mesmo do clique ⇒ navegar continua exato).
   */
  readonly fill?: boolean;
}

/**
 * Calcula a geometria da faixa: altura **fixa** por linha + janela de corte.
 *
 * Garante que: (a) a altura da barra nunca escala com o tamanho do documento (nada de
 * "faixas" grossas); (b) quando o documento não cabe, só as `visibleLines` linhas da
 * janela são desenhadas; (c) `truncated` sinaliza o corte.
 */
export function computeMinimapLayout(options: MinimapLayoutOptions): MinimapLayout {
  const { viewportHeight, lineCount } = options;
  const lineH = Math.max(BAR_MIN_HEIGHT, options.lineHeight ?? MINIMAP_LINE_HEIGHT);
  // Com 1px de altura a barra precisa de um gap de 1px, senão as linhas viram uma faixa só.
  const gap = lineH >= 2 ? 0 : 1;
  const rowPitch = lineH + gap;
  const capacity = viewportHeight > 0 ? Math.floor(viewportHeight / rowPitch) : 0;
  const maxFirst = Math.max(0, lineCount - 1);
  const firstLine = Math.max(0, Math.min(options.firstLine ?? 0, maxFirst));
  const ceiling = options.maxLines ?? Number.POSITIVE_INFINITY;
  const windowLines = Math.max(0, Math.min(ceiling, Math.max(0, lineCount - firstLine)));
  if (options.fill === true && windowLines > 0 && viewportHeight > 0) {
    // A janela é menor que a faixa ⇒ **amplia** o passo para ocupar a altura toda.
    const filled = Math.max(rowPitch, Math.floor(viewportHeight / windowLines));
    return {
      lineH: Math.max(BAR_MIN_HEIGHT, filled - gap),
      rowPitch: filled,
      visibleLines: windowLines,
      firstLine,
      truncated: lineCount > firstLine + windowLines,
    };
  }
  const visibleLines = Math.max(0, Math.min(capacity, windowLines));
  return {
    lineH,
    rowPitch,
    visibleLines,
    firstLine,
    truncated: lineCount > firstLine + visibleLines,
  };
}

/** Janela de linhas desenhada no minimap. */
export interface MinimapWindow {
  /** Primeira linha do documento desenhada. */
  readonly firstLine: number;
  /** Quantidade de linhas desenhadas. */
  readonly count: number;
}

/** Opções de {@link computeMinimapWindow}. */
export interface MinimapWindowOptions {
  /** Primeira linha visível no editor. */
  readonly scrollLine: number;
  /** Quantas linhas o editor está mostrando. */
  readonly visibleLineCount: number;
  /** Total de linhas do documento. */
  readonly lineCount: number;
}

/**
 * Janela desenhada = **range visível do editor** (recortado ao documento).
 *
 * É o mesmo range que o `HighlightStore` cobre (`requestHighlight(range.first, range.count)`),
 * então toda linha desenhada tem spans ⇒ as barras saem **coloridas**.
 */
export function computeMinimapWindow(options: MinimapWindowOptions): MinimapWindow {
  const { lineCount } = options;
  if (lineCount <= 0) return { firstLine: 0, count: 0 };
  const firstLine = Math.max(0, Math.min(options.scrollLine, lineCount - 1));
  const count = Math.max(0, Math.min(options.visibleLineCount, lineCount - firstLine));
  return { firstLine, count };
}

/** Opções de {@link minimapBarWidth}. */
export interface MinimapBarWidthOptions {
  /** Comprimento (em caracteres) da linha desenhada. */
  readonly lineLength: number;
  /** Comprimento da linha mais longa visível (referência da proporção). */
  readonly maxLineLength: number;
  /** Largura disponível para as barras (px). */
  readonly availableWidth: number;
  /** Largura mínima de uma barra não-vazia (px). Default: {@link MINIMAP_BAR_MIN_WIDTH}. */
  readonly minWidth?: number;
}

/**
 * Largura da barra de uma linha: **proporcional** ao seu comprimento, relativa à linha mais
 * longa visível, com piso de `minWidth` e teto de `availableWidth`.
 *
 * Linha vazia ⇒ largura 0 (nada é desenhado, como no VS Code).
 */
export function minimapBarWidth(options: MinimapBarWidthOptions): number {
  const { lineLength, maxLineLength, availableWidth } = options;
  const minWidth = options.minWidth ?? MINIMAP_BAR_MIN_WIDTH;
  if (availableWidth <= 0 || lineLength <= 0) return 0;
  const ratio = Math.min(1, lineLength / Math.max(1, maxLineLength));
  const width = Math.round(availableWidth * ratio);
  return Math.min(availableWidth, Math.max(minWidth, width));
}

/** Opções de {@link minimapLineAtY}. */
export interface MinimapLineAtYOptions {
  /** Y local dentro da faixa do minimap (px, relativo ao topo). */
  readonly y: number;
  /** Avanço vertical entre linhas (px) — {@link MinimapLayout.rowPitch}. */
  readonly rowPitch: number;
  /** Primeira linha da janela de corte. */
  readonly firstLine: number;
  /** Total de linhas do documento. */
  readonly lineCount: number;
}

/**
 * Converte um Y local da faixa na linha do documento correspondente (clique/hover).
 * Clampado ao documento; documento vazio ⇒ 0.
 */
export function minimapLineAtY(options: MinimapLineAtYOptions): number {
  const { y, rowPitch, firstLine, lineCount } = options;
  if (lineCount <= 0 || rowPitch <= 0) return 0;
  const offset = Math.floor(Math.max(0, y) / rowPitch);
  const line = firstLine + offset;
  return Math.min(Math.max(0, line), lineCount - 1);
}

/** Opções de {@link minimapViewportRect}. */
export interface MinimapViewportRectOptions {
  /** Primeira linha visível no editor (índice do documento). */
  readonly scrollLine: number;
  /** Quantas linhas o editor está mostrando. */
  readonly visibleLineCount: number;
  /** Avanço vertical entre linhas no minimap (px). */
  readonly rowPitch: number;
  /** Primeira linha da janela de corte do minimap. */
  readonly firstLine: number;
  /** Quantas linhas do documento cabem na faixa. */
  readonly visibleLines: number;
  /** Altura da faixa (px). */
  readonly height: number;
}

/** Retângulo do realce da viewport, já recortado à janela/faixa visível. */
export interface MinimapViewportRect {
  readonly y: number;
  readonly height: number;
}

/**
 * Retângulo (y, height) do realce da viewport dentro da faixa.
 * Altura 0 quando a viewport está fora da janela desenhada.
 */
export function minimapViewportRect(options: MinimapViewportRectOptions): MinimapViewportRect {
  const { scrollLine, visibleLineCount, rowPitch, firstLine, visibleLines, height } = options;
  if (visibleLineCount <= 0 || visibleLines <= 0 || height <= 0 || rowPitch <= 0) {
    return { y: 0, height: 0 };
  }
  const top = (scrollLine - firstLine) * rowPitch;
  const bottom = top + visibleLineCount * rowPitch;
  const y = Math.max(0, top);
  const clipped = Math.min(height, bottom, visibleLines * rowPitch);
  return { y, height: Math.max(0, clipped - y) };
}

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
  /**
   * Faz a janela de corte ser o **range visível do editor** (o mesmo que o `HighlightStore`
   * cobre ⇒ barras coloridas). Default `true`.
   *
   * Com `false` a janela volta ao **topo do documento** (legado): aí não há spans e as barras
   * usam o tom discreto.
   */
  followScroll?: boolean;
}

/** Resultado do `attachMinimap`: para desligar. */
export interface MinimapBinding {
  readonly container: HTMLElement;
  /** Atualiza o desenho (chame a cada frame ou quando o documento mudar). */
  update(): void;
  /**
   * Primeira linha da janela desenhada — a mesma matemática usada na pintura (e no clique).
   * Serve para a **lupa** (`./code-loupe.ts`) mapear o mouse na mesma janela.
   */
  firstLine(): number;
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
  /** Âncora do arrasto: alvo de scroll fixado no mousedown + y do ponteiro. */
  let dragAnchor: { target: number; y: number } | null = null;

  /**
   * Janela de linhas desenhada no minimap.
   *
   * Por padrão (`followScroll` !== false) é o **range visível do editor** — o mesmo range que o
   * `HighlightStore` cobre, então as barras saem **coloridas**. Com `followScroll: false` a
   * janela é o topo do documento (legado) e, sem spans, as barras usam o tom discreto.
   */
  const computeWindow = (): MinimapWindow => {
    const { source, viewport } = deps;
    const lineCount = source.lineCount();
    if (lineCount <= 0) return { firstLine: 0, count: 0 };
    if (deps.followScroll === false) {
      return { firstLine: 0, count: lineCount };
    }
    const range = viewport.visibleLineRange();
    return computeMinimapWindow({
      scrollLine: range.first,
      visibleLineCount: range.count,
      lineCount,
    });
  };

  /** Geometria da faixa para a janela atual (mesma matemática do clique). */
  const currentLayout = (): MinimapLayout => {
    const win = computeWindow();
    return computeMinimapLayout({
      viewportHeight: container.clientHeight,
      lineCount: deps.source.lineCount(),
      firstLine: win.firstLine,
      maxLines: win.count,
      // A janela é o range **visível** (poucas linhas): sem `fill` ela ocuparia só
      // ~13% da faixa. Com `fill`, a faixa é um overview ampliado do que se vê.
      fill: true,
    });
  };

  const paint = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth || MINIMAP_WIDTH;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;

    // Reatribuir `canvas.width/height` **realoca** o backing store (zera o canvas). Só o
    // faz quando o tamanho muda de fato — realocar a cada quadro é caro e, em máquina sem
    // GPU, derruba o processo de raster do renderer.
    const targetW = Math.ceil(w * dpr);
    const targetH = Math.ceil(h * dpr);
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { source, viewport, lineHeight, getViewportHeight } = deps;
    const viewportHeight = getViewportHeight();
    const lineCount = source.lineCount();

    const colors = deps.colors();

    // Fundo
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, w, h);

    if (lineCount === 0) return;

    // Marcadores (busca/diagnóstico) são coletados antes: eles reservam a faixa à direita.
    const diagnostics = deps.diagnostics?.();
    const searchMatches = deps.searchMatches?.();
    const searchCurrentIndex = deps.searchCurrentIndex?.();
    const hasMarkers =
      (diagnostics !== undefined && diagnostics.length > 0) ||
      (searchMatches !== undefined && searchMatches.length > 0);

    // Geometria: altura FIXA por linha + janela de corte (o documento pode não caber).
    const layout = currentLayout();
    const { lineH, rowPitch, visibleLines, firstLine } = layout;

    // Largura disponível para as barras (descontando padding e a faixa dos marcadores).
    const availableWidth = Math.max(
      0,
      w - BAR_LEFT_PAD - BAR_RIGHT_PAD - (hasMarkers ? MARKER_STRIP : 0),
    );

    // 1ª passada: linha mais longa da janela visível (referência da proporção).
    let maxLineLength = 0;
    for (let i = 0; i < visibleLines; i++) {
      const len = source.line(firstLine + i).trim().length;
      if (len > maxLineLength) maxLineLength = len;
    }

    // Desenha cada linha como uma barra horizontal proporcional ao seu comprimento.
    const { spansFor, syntaxTheme } = deps;
    for (let i = 0; i < visibleLines; i++) {
      const line = firstLine + i;
      const text = source.line(line);
      const trimmed = text.trim();
      // Linha vazia não vira barra (evita o "cinza de largura total" do fallback antigo).
      if (trimmed.length === 0) continue;

      const y = i * rowPitch;
      const barW = minimapBarWidth({
        lineLength: trimmed.length,
        maxLineLength,
        availableWidth,
      });
      if (barW <= 0) continue;

      // ── Syntax colorida (se disponível) ────────────────────────────────
      const spans = spansFor?.(line);
      if (spans !== undefined && spans.length > 0) {
        const total = Math.max(1, text.length);
        // Bordas acumuladas arredondadas ⇒ sem fresta entre segmentos vizinhos.
        let x = BAR_LEFT_PAD;
        let acc = 0;
        for (const span of spans) {
          const segLen = Math.max(0, span.end - span.start);
          const nextX = BAR_LEFT_PAD + Math.round((barW * (acc + segLen)) / total);
          const segW = nextX - x;
          acc += segLen;
          if (segW > 0) {
            const style = syntaxTheme?.styleFor(span.scope);
            const color = style?.color;
            ctx.globalAlpha = LINE_CONTENT_ALPHA;
            ctx.fillStyle = color !== undefined ? rgbaToCss(color) : colors.line;
            ctx.fillRect(x, y, segW, lineH);
          }
          x = nextX;
        }
      } else {
        // Sem spans: mesma barra proporcional, numa cor discreta (foreground com alpha baixa).
        ctx.globalAlpha = LINE_CONTENT_ALPHA;
        ctx.fillStyle = colors.line;
        ctx.fillRect(BAR_LEFT_PAD, y, barW, lineH);
      }
    }
    ctx.globalAlpha = 1;

    // ── Marcadores de diagnóstico (P3.x) ──────────────────────────────────
    // Desenha finos marcadores na borda direita (à esquerda dos de busca)
    if (diagnostics !== undefined && diagnostics.length > 0) {
      for (const diag of diagnostics) {
        const idx = diag.line - firstLine;
        if (idx < 0 || idx >= visibleLines) continue;
        const y = idx * rowPitch;
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
        ctx.fillRect(w - 16, y, 7, lineH);
      }
    }

    // ── Marcadores de busca (P3.x) ───────────────────────────────────────
    // Desenha finos marcadores na borda direita (à direita dos de diagnóstico)
    if (searchMatches !== undefined && searchMatches.length > 0) {
      for (let m = 0; m < searchMatches.length; m++) {
        const match = searchMatches[m]!;
        const idx = match.line - firstLine;
        if (idx < 0 || idx >= visibleLines) continue;
        const y = idx * rowPitch;
        ctx.globalAlpha = 1;
        ctx.fillStyle = m === searchCurrentIndex ? colors.searchCurrent : colors.searchMatch;
        ctx.fillRect(w - 8, y, 6, lineH);
      }
    }

    // ── Fim dos marcadores ───────────────────────────────────────────────
    ctx.globalAlpha = 1;

    // Viewport highlight (recortado à janela desenhada).
    const scrollLine = Math.floor(viewport.scrollOffsetPx() / Math.max(1, lineHeight));
    const visibleEditorLines = Math.ceil(viewportHeight / Math.max(1, lineHeight));
    const vp = minimapViewportRect({
      scrollLine,
      visibleLineCount: visibleEditorLines,
      rowPitch,
      firstLine,
      visibleLines,
      height: h,
    });

    if (vp.height > 0) {
      ctx.fillStyle = colors.viewport;
      ctx.fillRect(0, vp.y, w, vp.height);
      ctx.strokeStyle = colors.viewportBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, vp.y, w - 1, vp.height);
    }
  };

  /**
   * Linha de scroll para a qual a coluna deve ir quando o ponteiro está em `clientY`.
   *
   * A linha clicada vai para o **centro** do editor (é o que o usuário espera ao clicar na
   * coluna). O arrasto é **ancorado** no mousedown (ver `dragAnchor`): o alvo é o alvo do clique
   * mais o deslocamento do ponteiro — assim o conteúdo não "foge" do cursor quando a janela
   * desenhada acompanha a rolagem.
   */
  const scrollTargetFor = (clientY: number): number => {
    const { source, lineHeight } = deps;
    const lineCount = source.lineCount();
    if (container.clientHeight <= 0 || lineCount <= 0) return 0;
    const rect = container.getBoundingClientRect();
    const layout = currentLayout();
    const clicked = minimapLineAtY({
      y: clientY - rect.top,
      rowPitch: layout.rowPitch,
      firstLine: layout.firstLine,
      lineCount,
    });
    const visibleEditorLines = Math.ceil(deps.getViewportHeight() / Math.max(1, lineHeight));
    const target = clicked - Math.floor(visibleEditorLines / 2);
    return Math.max(0, Math.min(target, lineCount - 1));
  };

  const onMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    dragging = true;
    const target = scrollTargetFor(e.clientY);
    dragAnchor = { target, y: e.clientY };
    deps.viewport.scrollTo(target);
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging || dragAnchor === null) return;
    e.preventDefault();
    const lineCount = deps.source.lineCount();
    if (lineCount <= 0) return;
    const layout = currentLayout();
    const delta = Math.round((e.clientY - dragAnchor.y) / layout.rowPitch);
    const target = Math.max(0, Math.min(dragAnchor.target + delta, lineCount - 1));
    deps.viewport.scrollTo(target);
  };

  const onMouseUp = (): void => {
    dragging = false;
    dragAnchor = null;
  };

  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  return {
    container,
    update: paint,
    firstLine: (): number => computeWindow().firstLine,
    dispose: () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// A "lupa" (preview ampliado e colorido do código sob o mouse) vive em
// `./code-loupe.ts` — ela substitui o antigo tooltip de hover deste arquivo.
// ---------------------------------------------------------------------------
