/**
 * Scribe — boot do renderer (Electron/Chromium). **Nada de nó DOM por linha** (DEC-REN-7): o corpo
 * do editor é um único `<canvas>` (`#editor-surface`, já existente em `index.html`) desenhado pelo
 * `RenderPipeline`. O DOM serve só à casca (status bar, futuros menus).
 *
 * Documento: a demo estática é o **fallback**. Quando a ponte do preload existe (`window.scribe`),
 * o renderer liga um adaptador `LineSource` ao **documento real** (`document.open/text/insert`);
 * sem a ponte (teste/ambiente sem Electron) degrada para a demo — de forma **explícita e logada**
 * na status bar (DEC-TR-7). Digitação mínima: `keydown` imprimível → `insert(handle, caret, texto)`
 * e um novo frame redesenha o damage.
 *
 * Backend: escolhido por `render.backend` (knob `RENDER_BACKEND_PROPERTY`, DEC-REN-1) — o **default
 * de fábrica é `canvas2d`** (DEC-REN-2). O **modo efetivo é logado** na status bar.
 */
import {
  DEFAULT_RENDER_BACKEND,
  RENDER_BACKEND_PROPERTY,
  SelectionOps,
  SelectionSetOps,
  advanceSelections,
  toDisposable,
  DARK_THEME,
  LIGHT_THEME,
  BUILTIN_THEMES,
  MAX_CONCURRENT_EVALUATIONS,
} from "../shared";
import type {
  CommandListResult,
  DapBreakpoint,
  DapBreakpointSpec,
  DapEvaluation,
  DapEvaluationRequestContext,
  DapOutputEvent,
  DapScope,
  DapSessionState,
  DapStackFrame,
  DapStoppedEvent,
  DapThread,
  DapVariable,
  Disposable,
  DocumentHighlight,
  DocumentInsertResult,
  EditorTheme,
  GitCommitResult,
  GitStatusResult,
  GrepResult,
  HighlightSpan,
  LspCodeAction,
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentSymbol,
  LspFoldingRange,
  LspHoverResult,
  LspInlayHint,
  LspLocation,
  LspRenameResult,
  LspSignatureHelp,
  LspTextEdit,
  PackageSnippetDefinition,
  RenderBackendKind,
  RGBA,
  ReplaceAllResult,
  RenderPipeline,
  SearchDocumentResult,
  SearchFilesOptions,
  SearchMatch,
  SearchQuery,
  Selection,
  SelectionEdit,
  SelectionSet,
  SnippetsListResult,
  TextStyle,
  Viewport,
  WorkspaceCreateFileResult,
  WorkspaceFilesResult,
} from "../shared";
import {
  FindBarError,
  FindBarModel,
  createDebounceScheduler,
} from "./find-bar";
import type { FindBarApi, FindBarState } from "./find-bar";
import { attachCommandPalette } from "./command-palette";
import type { CommandPaletteApi, CommandPaletteBinding } from "./command-palette";
import { hideQuickOpen, showQuickOpen } from "./quick-open";
import type { QuickOpenItem } from "./quick-open";
import { attachSearchPanel, DEFAULT_SEARCH_PANEL_FLAGS } from "./search-panel";
import type { SearchPanelBinding, SearchPanelFlags } from "./search-panel";
import { mountExplorerTree } from "./explorer-tree";
import type { ExplorerTreeHandle } from "./explorer-tree";
import { mountOutlineView } from "./outline-view";
import type { OutlineRevealTarget, OutlineViewHandle } from "./outline-view";
import { mountProblemsPanel, problemEntries } from "./problems-panel";
import type { ProblemCounts, ProblemEntry, ProblemsPanelHandle } from "./problems-panel";
import {
  describeSourceControlCounts,
  formatSourceControlBadge,
  mountSourceControlPanel,
} from "./source-control";
import type { SourceControlCounts, SourceControlPanelHandle } from "./source-control";
import { mountDiffView } from "./diff-view";
import type { DiffViewHandle } from "./diff-view";
import { createCompletionPopup } from "./completions";
import type { CompletionPopupBinding } from "./completions";
import { attachCodeLoupe } from "./code-loupe";
import { createHoverTooltip } from "./hover-tooltip";
import type { HoverTooltipBinding } from "./hover-tooltip";
import { createSignatureHelp } from "./signature-help";
import type { SignatureHelpBinding } from "./signature-help";
import { createDocumentSymbolsPopup } from "./document-symbols";
import type { DocumentSymbolsBinding } from "./document-symbols";
import { createReferencesPopup } from "./references-popup";
import type { ReferencesPopupBinding } from "./references-popup";
import { createDebugView } from "./debug-panel";
import type { DebugAction, DebugViewBinding } from "./debug-panel";
import {
  DebugHoverMemo,
  DebugWatchModel,
  columnFromPointerX,
  extractExpressionAt,
  isSameFilePath,
  mergeBreakpointSpecs,
  normalizeBreakpointList,
} from "./debug-inspect";
import { attachMinimap } from "./minimap";
import type { MinimapBinding } from "./minimap";
import { findSnippet, parseSnippet } from "./snippets";
import type { Snippet, SnippetVariableContext } from "./snippets";
import {
  applyEdit,
  chooseSnippetOption,
  createSnippetSession,
  currentChoice,
  currentStop,
  nextTabStop,
  previousTabStop,
  sessionRange,
} from "./snippet-session";
import type { SnippetEditRange, SnippetSession } from "./snippet-session";
import { hideSnippetChoice, showSnippetChoice } from "./snippet-choice";
import {
  cursorAbove,
  cursorBelow,
  selectAllOccurrences,
  selectNextOccurrence,
  wordAt,
} from "./multi-cursor-ops";
import {
  Canvas2DBackend,
  GlyphAtlas,
  ViewportImpl,
  VisualRowIndex,
  WebGPUBackend,
  WebGPUUnavailableError,
  type AtlasSurface,
  type BracketPos,
  type CaretPosition,
  type FoldRange,
  type GitDiffRange,
  type GlyphBitmap,
  type GlyphRasterizer,
  type GlyphTinter,
  type LineLayout,
  type LineSource,
  type RenderInlayHint,
  type SceneHighlight,
  type SearchHighlight,
  type TextMeasurer,
  type VisualRowIndexLike,
  applyCollapsedLines,
  buildInstances,
  computeStickyContext,
  stickySymbolsFromLsp,
  type StickySymbol,
} from "../core/render";
import { createSyntaxTheme } from "../core/syntax";
import { parseUnifiedDiff } from "../core/git/git-diff";

const DEMO_LINE_COUNT = 200;
const GLYPH_CHUNK = 2048;

/** Debounce da busca dos símbolos do LSP (o sticky scroll) depois de uma edição. */
const STICKY_SYMBOLS_DEBOUNCE_MS = 400;

/**
 * Backoff das **re-tentativas** da busca de símbolos (o *Outline*).
 *
 * O LSP pode ainda estar **conectando** quando o documento abre ⇒ o 1º resultado vem
 * **vazio** (e o Outline nascia vazio). As tentativas são poucas e espaçadas (sem spam de
 * IPC) e param assim que os símbolos chegam.
 */
const OUTLINE_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Contexto de *sticky scroll* (o retorno de `computeStickyContext`).
 *
 * Alias local: o *barrel* do render reexporta a **função**, não o tipo (o tipo mora em
 * `core/render/sticky-scroll.ts`, que é interno do módulo).
 */
type StickyContext = ReturnType<typeof computeStickyContext>;

/** Estado de folding: ranges por handle do documento. */
const foldingStates = new Map<number, readonly FoldRange[]>();

/**
 * Encontra o bracket correspondente ao bracket na posicao offset.
 * Devolve undefined se nao for bracket ou nao tiver par.
 */
function findMatchingBracket(text: string, offset: number): number | undefined {
  if (offset < 0 || offset >= text.length) return undefined;
  const char = text[offset];
  if (char === undefined) return undefined;

  const openers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

  const match = openers[char] ?? closers[char];
  if (match === undefined) return undefined;

  const isForward = char in openers;
  const step = isForward ? 1 : -1;
  let depth = 0;
  let pos = offset + step;

  while (pos >= 0 && pos < text.length) {
    const c = text[pos]!;
    if (c === char) depth++;
    else if (c === match) {
      if (depth === 0) return pos;
      depth--;
    }
    pos += step;
  }
  return undefined;
}

/**
 * Nº máximo de linhas varridas (de cada lado) para achar o bracket par.
 *
 * ⚠️ **Por que um limite**: o caminho legado materializava o **documento inteiro** a cada
 * frame (concat de `source.line(i)`) só para procurar o par ⇒ O(documento)/frame (200k linhas
 * ⇒ 30 FPS ocioso). O par é procurado só na **vizinhança** do caret: o custo passa a ser
 * O(janela), independente do tamanho do documento.
 */
export const BRACKET_SCAN_LINES = 200;

/**
 * Par do bracket em `offset`, procurado **só na vizinhança** da linha do caret.
 *
 * ⚠️ **Por que a janela não muda o resultado**: `findMatchingBracket` só conta o **mesmo**
 * tipo de bracket (não uma pilha de aninhamento completo) ⇒ a varredura é sempre numa direção
 * só (aberto → para a frente; fechado → para trás). A janela cobre exatamente essa direção,
 * então o par encontrado é o mesmo do scan completo — desde que ele esteja na janela.
 *
 * @param source A fonte do documento (só a janela é materializada).
 * @param offset Offset **absoluto** do bracket sob o caret.
 * @param maxLines Nº de linhas da janela (de cada lado).
 * @param position Posição **já calculada** de `offset` (evita um segundo `positionAt`).
 * @returns O offset **absoluto** do par, ou `undefined` (não é bracket / par fora da janela).
 */
export function findMatchingBracketNear(
  source: LineSource,
  offset: number,
  maxLines: number = BRACKET_SCAN_LINES,
  position?: { readonly line: number; readonly column: number },
): number | undefined {
  const lineCount = source.lineCount();
  if (lineCount === 0) return undefined;
  const pos = position ?? source.positionAt(offset);
  const line = pos.line;
  if (line < 0 || line >= lineCount) return undefined;
  const column = Math.max(0, Math.min(pos.column, source.line(line).length));
  const char = source.line(line)[column];
  if (char === undefined) return undefined;
  const isOpener = char === "(" || char === "[" || char === "{";
  const isCloser = char === ")" || char === "]" || char === "}";
  if (!isOpener && !isCloser) return undefined;

  // A janela cobre **a direção da varredura**: para a frente (aberto) ou para trás (fechado).
  const firstLine = isOpener ? line : Math.max(0, line - maxLines);
  const lastLine = isOpener ? Math.min(lineCount, line + maxLines + 1) : line + 1;
  let text = "";
  for (let i = firstLine; i < lastLine; i++) {
    if (i > firstLine) text += "\n";
    text += source.line(i);
  }

  // O offset **absoluto** do início da janela (evita um `offsetOf` O(documento)).
  let windowStart: number;
  if (isOpener) {
    windowStart = offset - column;
  } else {
    let before = 0;
    for (let i = firstLine; i < line; i++) before += source.line(i).length + 1;
    windowStart = offset - column - before;
  }

  const found = findMatchingBracket(text, offset - windowStart);
  return found === undefined ? undefined : windowStart + found;
}

const TEXT_STYLE: TextStyle = { family: "monospace", sizePx: 15, weight: 400, italic: false };

const AUTO_PAIRS: Record<string, string> = {
  "(": ")", "[": "]", "{": "}",
  "\"": "\"", "'": "'", "`": "`",
};
const CLOSING = new Set(Object.values(AUTO_PAIRS));

/** Ícones criados em JS (mesmo desenho dos do HTML; herdam `currentColor`). */
const ICON_CHEVRON_RIGHT =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/**
 * Tema ativo do editor (default: escuro), persistido em `sessionStorage`.
 *
 * A persistência guarda só `name`/`kind` e **reidrata a paleta do builtin** correspondente: assim
 * uma paleta antiga (sem as chaves novas da casca) não fica congelada entre versões do app.
 */
function loadTheme(): EditorTheme {
  try {
    const raw = sessionStorage.getItem("scribe-theme");
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<EditorTheme>;
      const match = BUILTIN_THEMES.find(
        (t) => t.name === parsed.name || t.kind === parsed.kind,
      );
      if (match !== undefined) return match;
    }
  } catch {
    /* fallback silencioso: sessionStorage indisponível ou JSON inválido */
  }
  return DARK_THEME;
}
function saveTheme(theme: EditorTheme): void {
  sessionStorage.setItem("scribe-theme", JSON.stringify({ name: theme.name, kind: theme.kind }));
}
const THEME: { current: EditorTheme } = { current: loadTheme() };

function rgbToCss(rgba: RGBA): string {
  return `#${(rgba >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`;
}

/** `rgba(...)` a partir do `RGBA` empacotado (0xRRGGBBAA) e de um alfa próprio. */
function rgbaToCss(rgba: RGBA, alpha: number): string {
  const v = rgba >>> 0;
  return `rgba(${(v >>> 24) & 0xff}, ${(v >>> 16) & 0xff}, ${(v >>> 8) & 0xff}, ${alpha})`;
}

/**
 * Espelha o `EditorTheme` ativo em custom properties CSS (e no `data-theme` do `<html>`).
 *
 * É o que faz a **casca** acompanhar o tema junto com o canvas: antes o toggle só pintava o `body`,
 * que fica escondido atrás do canvas. Os estados (hover/seleção/texto secundário) são derivados em
 * CSS a partir de `--s-fg`/`--s-accent`, então só as cores-base precisam vir daqui.
 */
function applyChromeTheme(theme: EditorTheme): void {
  const root = document.documentElement;
  const c = theme.colors;
  const vars: ReadonlyArray<readonly [string, string]> = [
    ["--s-bg", rgbToCss(c.background)],
    ["--s-fg", rgbToCss(c.foreground)],
    ["--s-accent", rgbToCss(c.accent)],
    ["--s-gutter", rgbToCss(c.gutter)],
    ["--s-gutter-fg", rgbToCss(c.gutterForeground)],
    ["--s-border", rgbToCss(c.border)],
    ["--s-activitybar", rgbToCss(c.activityBar)],
    ["--s-sidebar", rgbToCss(c.sidebar)],
    ["--s-statusbar", rgbToCss(c.statusBar)],
    ["--s-tabbar", rgbToCss(c.tabBar)],
    ["--s-tabactive", rgbToCss(c.tabActive)],
    ["--s-tabinactive", rgbToCss(c.tabInactive)],
  ];
  for (const [name, value] of vars) root.style.setProperty(name, value);
  root.dataset.theme = theme.kind;
  root.style.colorScheme = theme.kind;
}

/** Cores **semânticas** do tema (erro/warn/info) já resolvidas para valores concretos. */
interface SemanticColors {
  readonly error: string;
  readonly warning: string;
  readonly info: string;
}

/**
 * Fallback das cores semânticas por tema — mesmos valores dos tokens `--s-*` do `index.css`
 * (usados só se a folha de estilo ainda não tiver definido o token).
 */
const SEMANTIC_FALLBACK: Readonly<Record<"dark" | "light", SemanticColors>> = {
  dark: { error: "#e06c75", warning: "#e0a44a", info: "#61afef" },
  light: { error: "#c33", warning: "#a86a00", info: "#005fb8" },
};

let semanticCache: { readonly kind: string; readonly colors: SemanticColors } | undefined;

/**
 * Resolve uma cor CSS (qualquer expressão: hex, `rgb()`, `color-mix()`…) para `rgba(r,g,b,a)`.
 *
 * O canvas não entende custom property nem `color-mix()` — então a cor é pintada num canvas de
 * 1×1 e lida de volta. Expressão inválida (ou token ausente) ⇒ devolve o *fallback*, nunca uma
 * string que o canvas não entenda (o `fillStyle` ignoraria e o marcador ficaria com a cor
 * anterior).
 */
function resolveCssColor(value: string, fallback: string): string {
  const text = value.trim();
  if (text.length === 0 || typeof document === "undefined") return fallback;
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext("2d");
  if (ctx === null) return fallback;
  ctx.fillStyle = "#010203"; // sentinela: valor inválido mantém o anterior
  ctx.fillStyle = text;
  if (ctx.fillStyle === "#010203") return fallback;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  const r = data[0] ?? 0;
  const g = data[1] ?? 0;
  const b = data[2] ?? 0;
  const a = data[3] ?? 255;
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

/** Lê uma custom property do `:root` e a resolve para uma cor de canvas. */
function cssColorVar(name: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return resolveCssColor(value, fallback);
}

/**
 * Paleta semântica do tema ativo (`--s-error`/`--s-warn`/`--s-info`), com cache por tema.
 *
 * O token semântico vive no CSS (fonte única de verdade), mas o minimap pinta no **canvas** e o
 * `fillStyle` **não** resolve custom properties CSS — então a custom property é lida do DOM
 * (`getComputedStyle`) e o hex fica só como *fallback*.
 */
function semanticColors(): SemanticColors {
  const attr = document.documentElement.dataset.theme;
  const kind: "dark" | "light" =
    attr === "light" || attr === "dark" ? attr : THEME.current.kind;
  if (semanticCache?.kind === kind) return semanticCache.colors;
  const fallback = SEMANTIC_FALLBACK[kind];
  const colors: SemanticColors = {
    error: cssColorVar("--s-error", fallback.error),
    warning: cssColorVar("--s-warn", fallback.warning),
    info: cssColorVar("--s-info", fallback.info),
  };
  semanticCache = { kind, colors };
  return colors;
}

// ---- rasterização/medição no renderer (fora da main thread seria o ideal — DEC-REN-3) ----------

function fontString(style: TextStyle): string {
  return `${style.italic ? "italic " : ""}${style.weight} ${style.sizePx}px ${style.family}`;
}

function createCanvasRasterizer(): GlyphRasterizer {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível para rasterizar glifos");
  return {
    rasterize(rune: string, style: TextStyle): GlyphBitmap {
      const height = Math.max(1, Math.ceil(style.sizePx * 1.3));
      const width = Math.max(1, Math.ceil(style.sizePx * 0.8));
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.font = fontString(style);
      ctx.textBaseline = "top";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(rune, 0, 0);
      const advance = ctx.measureText(rune).width;
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const pixels = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const alpha = rgba[i * 4 + 3] ?? 0;
        // Tinta branca "reta" (não pré-multiplicada): o backend aplica a cor/alpha.
        pixels[i * 4] = 255;
        pixels[i * 4 + 1] = 255;
        pixels[i * 4 + 2] = 255;
        pixels[i * 4 + 3] = alpha;
      }
      return { width, height, bearingX: 0, bearingY: height, advance, pixels };
    },
  };
}

function createCanvasMeasurer(): TextMeasurer {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível para medir texto");
  let currentFont = "";
  return (text, style) => {
    const font = fontString(style);
    if (font !== currentFont) {
      ctx.font = font;
      currentFont = font;
    }
    const measured = ctx.measureText(text);
    return {
      advance: measured.width,
      bearingX: 0,
      bearingY: style.sizePx,
      width: measured.width,
      height: style.sizePx,
    };
  };
}

/** Superfície do atlas em `<canvas>` — o `Canvas2DBackend` faz `drawImage` a partir dela. */
function createAtlasSurface(size: number): { surface: AtlasSurface; canvas: HTMLCanvasElement } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível para a superfície do atlas");
  const surface: AtlasSurface = {
    image: canvas,
    write(region, bitmap): void {
      const data = new Uint8ClampedArray(bitmap.pixels);
      ctx.putImageData(new ImageData(data, region.w, region.h), region.x, region.y);
    },
  };
  return { surface, canvas };
}

/** Bloco de altura (px) das cópias tingidas: folga para não re-tingir a cada glifo novo. */
const TINT_BLOCK = 256;

/** Tingidor do atlas com descarte explícito (usado na troca de tema). */
interface AtlasTinter extends GlyphTinter {
  /** Descarta as cópias tingidas (ex.: as cores do tema mudaram). */
  clear(): void;
}

/**
 * Cópias tingidas do atlas para o backend `canvas2d`.
 *
 * O atlas guarda **tinta branca + alpha** (a cor é de cada instância) e o `Canvas2DBackend` só
 * aplica `globalAlpha` — sem tingir, todo texto sairia branco: legível por acidente sobre fundo
 * escuro e invisível sobre fundo claro. Aqui a tinta branca é trocada pela cor da instância com
 * um `source-in` sobre uma cópia do atlas.
 *
 * Custo: **uma cópia por RGB usado**, recortada à faixa viva do atlas (`usedHeight`, arredondada
 * para cima em blocos de `TINT_BLOCK` para não re-tingir a cada glifo novo) — a página inteira
 * (1024²) só é copiada se o atlas realmente chegar lá. Quando o atlas cresce além do bloco já
 * copiado, as cópias são descartadas: os glifos novos não estariam nelas.
 */
function createAtlasTinter(atlas: GlyphAtlas, source: HTMLCanvasElement): AtlasTinter {
  const copies = new Map<number, HTMLCanvasElement>();
  let copiedHeight = 0;
  return {
    imageFor(rgba: RGBA): CanvasImageSource | undefined {
      const used = atlas.usedHeight;
      if (used === 0) return undefined;
      const needed = Math.min(source.height, Math.ceil(used / TINT_BLOCK) * TINT_BLOCK);
      if (needed > copiedHeight) {
        copies.clear();
        copiedHeight = needed;
      }
      const rgb = rgba >>> 8;
      const hit = copies.get(rgb);
      if (hit !== undefined) return hit;
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = copiedHeight;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return undefined;
      ctx.drawImage(source, 0, 0);
      // `source-in` troca a tinta branca pela cor, preservando o alpha (cobertura) do glifo.
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = rgbToCss((rgb << 8) | 0xff);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      copies.set(rgb, canvas);
      return canvas;
    },
    clear(): void {
      copies.clear();
    },
  };
}

// ---- seleção de backend -------------------------------------------------------------------------

function resolveBackendKind(): RenderBackendKind {
  const fromQuery = new URLSearchParams(window.location.search).get("backend");
  if (fromQuery === "webgpu" || fromQuery === "canvas2d") return fromQuery;
  const config = (globalThis as { __scribeRenderConfig?: Record<string, unknown> }).__scribeRenderConfig;
  const fromConfig = config?.[RENDER_BACKEND_PROPERTY];
  if (fromConfig === "webgpu" || fromConfig === "canvas2d") return fromConfig;
  return DEFAULT_RENDER_BACKEND;
}

// ---- adaptador documento → LineSource (o seam real) ---------------------------------------------

function splitLines(text: string): string[] {
  return text.split("\n");
}

/**
 * Primeira linha cujo conteúdo mudou entre duas listas de linhas.
 *
 * `undefined` = as duas listas são equivalentes (o texto não mudou). O índice de rows
 * visuais usa isto para invalidar **a partir** da linha alterada — as rows antes dela
 * continuam válidas e não são recalculadas.
 */
export function firstChangedLine(before: readonly string[], after: readonly string[]): number | undefined {
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    if (before[i] !== after[i]) return i;
  }
  return undefined;
}

/**
 * `LineSource` ligado ao **texto do documento** (o adaptador mínimo do renderer). Guarda o texto
 * completo e o fatia por linha sob demanda — o `Viewport` só materializa o range visível, então
 * **não** há nó DOM por linha (DEC-REN-7).
 */
export class DocumentLineSource implements LineSource {
  private textValue: string;
  private lines: string[];
  private revisionValue: number;
  /** Contador de conteúdo: muda a cada texto **diferente** aplicado. */
  private contentVersionValue = 0;
  /** Primeira linha alterada na última aplicação de texto (`undefined` = texto idêntico). */
  private firstChangedLineValue: number | undefined;

  constructor(text = "", revision = 0) {
    this.textValue = text;
    this.lines = splitLines(text);
    this.revisionValue = revision;
  }

  get text(): string {
    return this.textValue;
  }

  get revision(): number {
    return this.revisionValue;
  }

  /**
   * Versão do **conteúdo**: muda a cada texto **diferente** aplicado.
   *
   * A revisão do documento não serve para isto: a edição local usa um contador próprio
   * (1, 2, 3…) e o servidor devolve a revisão real — os dois números se cruzam e a
   * "revisão" pode ficar igual depois de uma mudança de texto.
   */
  get contentVersion(): number {
    return this.contentVersionValue;
  }

  /** Primeira linha alterada na última aplicação de texto (`undefined` = texto idêntico). */
  get firstChangedLine(): number | undefined {
    return this.firstChangedLineValue;
  }

  /** Substitui o texto (vindo da ponte) e guarda a revisão associada. */
  setText(next: string, revision?: number): void {
    if (next !== this.textValue) {
      const nextLines = splitLines(next);
      this.firstChangedLineValue = firstChangedLine(this.lines, nextLines);
      this.contentVersionValue += 1;
      this.textValue = next;
      this.lines = nextLines;
    }
    if (revision !== undefined) this.revisionValue = revision;
  }

  lineCount(): number {
    return this.lines.length;
  }

  line(index: number): string {
    return this.lines[index] ?? "";
  }

  /** Offset (code units UTF-16) → linha/coluna (0-based). */
  positionAt(offset: number): { line: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this.textValue.length));
    let remaining = clamped;
    for (let index = 0; index < this.lines.length; index += 1) {
      const length = this.lines[index]?.length ?? 0;
      if (remaining <= length) return { line: index, column: remaining };
      remaining -= length + 1;
    }
    const last = Math.max(0, this.lines.length - 1);
    return { line: last, column: this.lines[last]?.length ?? 0 };
  }

  /** Linha/coluna (0-based) → offset (code units UTF-16). */
  offsetOf(line: number, column: number): number {
    const target = Math.max(0, Math.min(line, this.lines.length - 1));
    let offset = 0;
    for (let index = 0; index < target; index += 1) {
      offset += (this.lines[index]?.length ?? 0) + 1;
    }
    const length = this.lines[target]?.length ?? 0;
    return offset + Math.max(0, Math.min(column, length));
  }
}

/**
 * Fonte que expõe a **versão do conteúdo** (a `DocumentLineSource` do renderer expõe).
 *
 * O índice de rows visuais precisa saber *quando* o texto mudou (para invalidar) e *a
 * partir de qual linha* (para invalidar o mínimo). Uma `LineSource` genérica não expõe
 * nada disso — aí o índice só é reconstruído quando a **fonte** ou a **largura de wrap**
 * mudam.
 */
interface VersionedLineSource extends LineSource {
  /** Contador que muda a cada texto **diferente** aplicado. */
  readonly contentVersion: number;
  /** Primeira linha alterada na última aplicação (`undefined` = texto idêntico). */
  readonly firstChangedLine: number | undefined;
}

/** `true` se a fonte expõe a versão do conteúdo (a `DocumentLineSource` do renderer). */
function isVersionedLineSource(source: LineSource): source is LineSource & VersionedLineSource {
  return "contentVersion" in source && typeof source.contentVersion === "number";
}

/** Estado de undo/redo que a ponte devolve (espelha `DocumentUndoState` do contrato). */
interface UndoStateDto {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly revision: number;
  readonly caret: number;
  /**
   * Estado de seleção **restaurado** (P1#1) e o **conjunto** de cursores (P2#5) — é o que
   * devolve os N cursores aos pontos originais depois de um `Ctrl+Z`.
   *
   * Opcionais de propósito: um preload mais antigo que o contrato multi-cursor simplesmente
   * não os expõe — o renderer degrada para 1 cursor, sem crash (mesma política do resto da
   * ponte).
   */
  readonly selection?: Selection;
  readonly selections?: SelectionSet;
}

/** Superfície do preload consumida pelo renderer (subconjunto de `window.scribe`). */
interface ScribeBridge {
  open(path: string, signalId?: number): Promise<number>;
  openDialog(): Promise<string | null>;
  text(handle: number): Promise<string>;
  revision(handle: number): Promise<number>;
  insert(
    handle: number,
    at: number,
    text: string,
    origin?: "plugin" | "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  /**
   * Lote de inserções (multi-cursor, P2#5): cada entrada é `{at, text, remove?}` e o `at` é
   * **absoluto no estado do buffer após as entradas anteriores** ⇒ o lote multi-cursor entra em
   * ordem **descendente**. `selections` é o conjunto de cursores **antes** do lote (o que o
   * undo restaura).
   */
  batchInsert(
    handle: number,
    inserts: ReadonlyArray<{
      readonly at: number;
      readonly text: string;
      readonly remove?: string;
    }>,
    origin?: "plugin" | "user",
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  replaceOne(
    handle: number,
    at: number,
    remove: number,
    insert: string,
    selections?: SelectionSet,
  ): Promise<DocumentInsertResult>;
  undo(handle: number): Promise<UndoStateDto>;
  redo(handle: number): Promise<UndoStateDto>;
  undoState(handle: number): Promise<UndoStateDto>;
  save(handle: number): Promise<void>;
  /**
   * Destaque de sintaxe de um range (opcional de propósito): um preload **mais antigo** que o
   * contrato atual simplesmente não a expõe — o renderer degrada para a cor default, sem crash.
   */
  highlight?(handle: number, first: number, count: number): Promise<DocumentHighlight>;
  /**
   * Busca/substituição numa lane de fundo (opcionais pelo mesmo motivo de `highlight`: um preload
   * antigo simplesmente não as expõe e o renderer desliga a find bar, sem crash).
   */
  find?(handle: number, query: SearchQuery): Promise<SearchDocumentResult>;
  replaceAll?(handle: number, query: SearchQuery, replacement: string): Promise<ReplaceAllResult>;
  cancel(signalId: number): void;
  nextSignalId(): number;
  snapshot(): Promise<unknown>;
  onDocumentChanged(callback: (event: { handle: number; revision: number }) => void): () => void;
  listCommands(): Promise<CommandListResult>;
  executeCommand(commandId: string): Promise<void>;
  onMenuAction(callback: (action: string) => void): () => void;
  /** Pedido de completação LSP (opcional: preload antigo pode não expor). */
  completions?(handle: number, line: number, col: number): Promise<LspCompletionItem[]>;
  /** Pedido de hover LSP (opcional). */
  hover?(handle: number, line: number, col: number): Promise<LspHoverResult | null>;
  /** Escuta diagnósticos LSP enviados pelo processo principal (opcional). */
  onDiagnostics?(
    callback: (event: { handle: number; diagnostics: LspDiagnostic[] }) => void,
  ): () => void;
  /**
   * Os diagnósticos LSP **de um documento** (o cache do `main` — opcional).
   *
   * O `onDiagnostics` é *push* e pode perder o primeiro evento (o `open` inicial do
   * boot é assíncrono) ⇒ o documento aberto no boot usa esta chamada para **buscar**
   * o que o *push* perdeu.
   */
  diagnostics?(handle: number): Promise<LspDiagnostic[]>;
  /** Go-to-definition LSP (opcional). */
  definition?(handle: number, line: number, col: number): Promise<LspLocation | null>;
  /** Signature help LSP (opcional). */
  signatureHelp?(handle: number, line: number, col: number, triggerCharacter?: string): Promise<LspSignatureHelp | null>;
  /** Símbolos do documento LSP (opcional). */
  documentSymbols?(handle: number): Promise<LspDocumentSymbol[]>;
  /** Renomear símbolo via LSP (opcional). */
  rename?(handle: number, line: number, col: number, newName: string): Promise<LspRenameResult | null>;
  /** Find references LSP (opcional). */
  references?(handle: number, line: number, col: number): Promise<LspLocation[]>;
  /** Code actions LSP (opcional). */
  codeActions?(handle: number, line: number, col: number): Promise<readonly LspCodeAction[]>;
  /** Formata documento via LSP (Ctrl+Shift+I). */
  formatting?(handle: number, tabSize?: number, insertSpaces?: boolean): Promise<LspTextEdit[]>;
  /** Folding ranges via LSP. */
  foldingRange?(handle: number): Promise<readonly LspFoldingRange[]>;
  /** Inlay hints via LSP. */
  inlayHints?(handle: number, startLine?: number, endLine?: number): Promise<readonly LspInlayHint[]>;
  /** Git blame da linha (autor · há X dias). */
  blame?(handle: number, line: number): Promise<{ commitHash: string; author: string; timeAgo: string } | null>;
  /** Git diff do documento em relação ao HEAD (barras coloridas no gutter). */
  gitDiff?(handle: number): Promise<readonly GitDiffRange[]>;
  /** Depuração (DAP) — todos opcionais: preload antigo simplesmente não os expõe. */
  dapStart?(handle: number, stopOnEntry?: boolean): Promise<DapSessionState>;
  dapStop?(): Promise<DapSessionState>;
  dapState?(): Promise<DapSessionState>;
  dapSetBreakpoints?(handle: number, specs: readonly (number | DapBreakpointSpec)[]): Promise<readonly DapBreakpoint[]>;
  /** Breakpoints desejados de um documento (tolera preload antigo: só as linhas). */
  dapBreakpoints?(handle: number): Promise<readonly (number | DapBreakpointSpec)[]>;
  dapThreads?(): Promise<readonly DapThread[]>;
  dapStackTrace?(threadId: number): Promise<readonly DapStackFrame[]>;
  dapScopes?(frameId: number): Promise<readonly DapScope[]>;
  dapVariables?(variablesReference: number): Promise<readonly DapVariable[]>;
  dapContinue?(threadId: number): Promise<void>;
  dapPause?(threadId: number): Promise<void>;
  dapStepOver?(threadId: number): Promise<void>;
  dapStepInto?(threadId: number): Promise<void>;
  dapStepOut?(threadId: number): Promise<void>;
  /** Avalia uma expressão no programa depurado (watch/hover). */
  dapEvaluate?(expression: string, frameId: number, context?: DapEvaluationRequestContext): Promise<DapEvaluation | null>;
  onDapState?(callback: (event: { state: DapSessionState }) => void): () => void;
  onDapStopped?(callback: (event: DapStoppedEvent) => void): () => void;
  onDapOutput?(callback: (event: DapOutputEvent) => void): () => void;
  onDapBreakpoints?(callback: (event: { path: string; breakpoints: DapBreakpoint[] }) => void): () => void;
  /**
   * Snippets de pacote (`.sublime-snippet` dentro de `Packages/<Nome>/…`) — **opcional**:
   * um preload mais antigo simplesmente não expõe o método e o renderer fica só com os
   * snippets embutidos (sem crash).
   */
  snippets?(): Promise<SnippetsListResult>;
  /**
   * Índice de **arquivos da workspace** (o *Quick Open*, ⌘P) — **opcional**: um preload
   * mais antigo não expõe o método ⇒ o ⌘P mostra **só os comandos** (degradação, sem crash).
   */
  workspaceFiles?(roots?: readonly string[]): Promise<WorkspaceFilesResult>;
  /**
   * Busca em **todos os arquivos** da workspace (o "grep", `Ctrl+Shift+F`) — **opcional**:
   * um preload mais antigo não expõe o método ⇒ o painel mostra "indisponível".
   *
   * `signalId` (o `nextSignalId()` da ponte) torna a busca **cancelável**.
   */
  searchFiles?(
    query: string,
    options?: SearchFilesOptions,
    signalId?: number,
  ): Promise<GrepResult>;
  /**
   * Fecha o documento no **core** (o `didClose` do LSP) — **opcional**: um preload mais
   * antigo não expõe o método ⇒ a aba fecha só do lado do renderer.
   */
  closeDocument?(handle: number): Promise<void>;
  /**
   * Cria um arquivo **vazio** na workspace (o "criar arquivo" do ⌘P) — **opcional**: um
   * preload mais antigo não expõe o método ⇒ o item "criar" responde "indisponível".
   *
   * O `main` confina o caminho a uma das raízes da workspace e **nunca** sobrescreve um
   * arquivo existente.
   */
  createFile?(path: string): Promise<WorkspaceCreateFileResult>;
  /**
   * Status do repositório git (o painel de *Source Control*) — **opcional**: um preload mais
   * antigo não expõe o método ⇒ a seção fica vazia (degradação, sem crash).
   *
   * `root` é a raiz do repositório; sem ela, o `main` usa a raiz do documento ativo.
   */
  gitStatus?(root?: string): Promise<GitStatusResult>;
  /** Stage de um arquivo (`git add -- <path>`) — **opcional** (mesma degradação do status). */
  gitStage?(path: string, root?: string): Promise<GitStatusResult>;
  /** Unstage de um arquivo (`git restore --staged -- <path>`) — **opcional**. */
  gitUnstage?(path: string, root?: string): Promise<GitStatusResult>;
  /** Stage de tudo (`git add -A`) — **opcional**. */
  gitStageAll?(root?: string): Promise<GitStatusResult>;
  /**
   * Commit (`git commit -m <mensagem>`) — **opcional**.
   *
   * Em falha, o `main` devolve `{ ok: false, error }` (a promise **não** rejeita); o renderer
   * mostra a mensagem no painel e **mantém** a mensagem de commit.
   */
  gitCommit?(message: string, root?: string): Promise<GitCommitResult>;
  /** Diff unificado cru (`git diff HEAD`) — **opcional**: sem ele, o diff fica vazio. */
  gitDiffText?(path: string): Promise<string>;
}

function readBridge(): ScribeBridge | undefined {
  const candidate = (globalThis as { scribe?: Partial<ScribeBridge> }).scribe;
  if (candidate === undefined) return undefined;
  // `highlight` **não** entra na guarda: exigir o método quebraria um preload antigo (achado de
  // revisão da Slice D). Quem não tiver o método só não ganha destaque (ver `bootRenderer`).
  const ready =
    typeof candidate.open === "function" &&
    typeof candidate.text === "function" &&
    typeof candidate.insert === "function" &&
    typeof candidate.undo === "function" &&
    typeof candidate.redo === "function" &&
    typeof candidate.openDialog === "function" &&
    typeof candidate.onDocumentChanged === "function";
  return ready ? (candidate as ScribeBridge) : undefined;
}

interface DocumentSession {
  readonly bridge: ScribeBridge;
  readonly handle: number;
  readonly source: DocumentLineSource;
  caret: number;
  selection: Selection;
  selections: SelectionSet; // P2#5
  /**
   * Última revisão **do servidor** conhecida.
   *
   * ⚠️ Não é a `source.revision`: a edição local usa um contador próprio (1, 2, 3…) que
   * colide com a revisão do servidor — comparar as duas fazia o renderer **ignorar** uma
   * edição externa (euflorismo: o evento era "velho" e o texto nunca era reconciliado).
   */
  serverRevision: number;
  /**
   * Sessão de snippet ativa (P4#18), viva **enquanto o documento ativo** estiver dentro da
   * expansão — `undefined` = fora. Fica na sessão do documento (e não num campo do controller)
   * porque os offsets são absolutos **daquele** buffer: trocar de aba, undo/redo ou abrir outro
   * arquivo invalida o estado, e aí o campo é limpo nos respectivos pontos do controller.
   */
  snippetSession?: SnippetSession | undefined;
  dispose(): void;
}

export interface TabInfo {
  readonly handle: number;
  readonly label: string;
  readonly dirty: boolean;
  readonly active: boolean;
}

interface TabSession extends DocumentSession {
  /** Caminho completo do arquivo (breadcrumbs e título do item no painel). */
  readonly path: string;
  /** Nome do arquivo (curto, para exibir na tab). */
  readonly label: string;
  /** Offset de scroll salvo quando a sessão perde o foco. */
  savedScrollPx: number;
  dirty: boolean;
}

// ---- snippets: contexto de variáveis, âncora do dropdown e ciclo de vida ------------------------

/**
 * Índice de snippets de **pacote** por trigger (lowercased) — a busca é case-insensitive,
 * como a dos snippets embutidos.
 */
export type PackageSnippetIndex = ReadonlyMap<string, PackageSnippetDefinition>;

/**
 * Indexa as definições de snippet de pacote por trigger (lowercased).
 *
 * A **primeira** definição com o mesmo trigger vence (a precedência de camada —
 * `user > app > os` — já foi resolvida no `main`, que lê o `PackageResolver`).
 */
export function indexPackageSnippets(
  definitions: readonly PackageSnippetDefinition[],
): Map<string, PackageSnippetDefinition> {
  const index = new Map<string, PackageSnippetDefinition>();
  for (const definition of definitions) {
    const key = definition.trigger.toLowerCase();
    if (key.length === 0) continue;
    if (index.has(key)) continue;
    index.set(key, definition);
  }
  return index;
}

/**
 * Converte uma definição de pacote no formato de snippet do renderer (`template`).
 *
 * O corpo do pacote é o **template** — a expansão passa pelo mesmo `parseSnippet` dos
 * embutidos (tab stops, escolhas, espelhos e transformações funcionam igual).
 */
export function packageSnippetToSnippet(definition: PackageSnippetDefinition): Snippet {
  return {
    trigger: definition.trigger,
    template: definition.body,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
  };
}

/**
 * Acha o snippet do **trigger** digitado: os de **pacote** primeiro (o usuário pode
 * redefinir um trigger embutido), os **embutidos** como fallback.
 *
 * Índice vazio = preload antigo (sem `snippets.list`) ⇒ só os embutidos (degradação sem
 * crash).
 */
export function resolveSnippetForWord(
  word: string,
  packageSnippets: PackageSnippetIndex,
): Snippet | undefined {
  const definition = packageSnippets.get(word.toLowerCase());
  if (definition !== undefined) return packageSnippetToSnippet(definition);
  return findSnippet(word);
}

/**
 * Vista mínima do documento para montar o **contexto de variáveis TM** de um snippet.
 *
 * `DocumentLineSource` satisfaz este contrato: a função só precisa do texto, da
 * linha/coluna de um offset e do texto de uma linha.
 */
export interface SnippetDocumentView {
  readonly text: string;
  positionAt(offset: number): { readonly line: number; readonly column: number };
  line(index: number): string;
}

/** Entrada de `buildSnippetVariableContext`. */
export interface SnippetVariableInput {
  /** Documento ativo (texto + posições). */
  readonly document: SnippetDocumentView;
  /** Caminho do arquivo (`undefined` quando não há — demo sem ponte). */
  readonly path: string | undefined;
  /** Offset do caret. */
  readonly caret: number;
  /** Seleção corrente (o trecho selecionado vira `TM_SELECTED_TEXT`). */
  readonly selection: Selection;
}

/** `true` para caractere de "palavra" (mesma classe usada no trigger de snippet). */
function isSnippetWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** A palavra sob o caret (`undefined` quando não há palavra ali). */
function snippetWordAt(lineText: string, column: number): string | undefined {
  const limit = Math.max(0, Math.min(column, lineText.length));
  let start = limit;
  let end = limit;
  while (start > 0 && isSnippetWordChar(lineText[start - 1]!)) start -= 1;
  while (end < lineText.length && isSnippetWordChar(lineText[end]!)) end += 1;
  if (start === end) return undefined;
  return lineText.slice(start, end);
}

/** Último segmento de um caminho (`/a/b/c.md` → `c.md`; "" → `undefined`). */
function snippetBasename(path: string): string | undefined {
  if (path.length === 0) return undefined;
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Diretório de um caminho (`/a/b/c.md` → `/a/b`; `c.md` → `undefined`). */
function snippetDirname(path: string): string | undefined {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return undefined;
  if (idx === 0) return "/";
  return path.slice(0, idx);
}

/** Nome do arquivo sem extensão (`notes.md` → `notes`; `.gitignore` → `.gitignore`). */
function snippetStem(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

/**
 * Monta o **contexto de variáveis TM** (`SnippetVariableContext`) a partir do documento ativo.
 *
 * Derivados: nome do arquivo, nome sem extensão, diretório, texto selecionado, linha do
 * caret, palavra sob o caret e índice da linha. Tudo é **opcional** — o que não existir fica
 * `undefined` e a variável correspondente continua **literal** na expansão (regra do parser).
 */
export function buildSnippetVariableContext(input: SnippetVariableInput): SnippetVariableContext {
  const { document: doc, path, caret, selection } = input;
  const pos = doc.positionAt(caret);
  const lineText = doc.line(pos.line);
  const fileName = path !== undefined ? snippetBasename(path) : undefined;
  const range = SelectionOps.normalized(selection);
  const selectedText =
    range.start === range.end ? undefined : doc.text.slice(range.start, range.end);
  const hasPath = path !== undefined && path.length > 0;
  const filePath = hasPath ? path : undefined;
  return {
    fileName,
    fileNameBase: fileName !== undefined ? snippetStem(fileName) : undefined,
    filePath,
    directory: filePath !== undefined ? snippetDirname(filePath) : undefined,
    selectedText,
    currentLine: lineText.length > 0 ? lineText : undefined,
    currentWord: snippetWordAt(lineText, pos.column),
    lineIndex: pos.line,
  };
}

/** Entrada de `snippetChoiceAnchor` (geometria do canvas em tela). */
export interface SnippetChoiceAnchorInput {
  /** `left` do canvas na tela (px). */
  readonly canvasLeft: number;
  /** `top` do canvas na tela (px). */
  readonly canvasTop: number;
  /** Linha (0-based) do caret. */
  readonly line: number;
  /**
   * Row **visual** da linha do caret (0-based) — com soft wrap, a row de uma linha não
   * é o seu índice. `undefined` = sem wrap (a row é a própria linha).
   */
  readonly visualRow?: number;
  /** Coluna (0-based) do caret. */
  readonly column: number;
  /** Scroll vertical da viewport (px). */
  readonly scrollOffsetPx: number;
  /** Largura do gutter (px) — a mesma do desenho do texto. */
  readonly gutterWidth: number;
  /** Altura da linha (px). */
  readonly lineHeight: number;
  /** Largura média de um caractere (px). */
  readonly charWidth: number;
}

/**
 * Posição (px de tela) do dropdown de escolha: **abaixo** do caret, na sua coluna.
 *
 * A origem é a **mesma** do desenho do texto no canvas (gutter + padding à esquerda,
 * `paddingTop` no topo, scroll subtraído) — o dropdown nasce em cima da linha do caret.
 */
export function snippetChoiceAnchor(input: SnippetChoiceAnchorInput): {
  readonly x: number;
  readonly y: number;
} {
  const x =
    input.canvasLeft +
    input.gutterWidth +
    TEXT_PADDING_LEFT_PX +
    input.column * input.charWidth;
  const y =
    input.canvasTop +
    TEXT_PADDING_TOP_PX +
    (input.visualRow ?? input.line) * input.lineHeight +
    input.lineHeight -
    input.scrollOffsetPx;
  return { x, y };
}

/**
 * Encerra a **sessão de snippet** do documento: limpa o estado e colapsa a seleção no caret
 * (o mesmo que o `Esc` faz).
 */
function endSnippetSession(session: DocumentSession, renderer: ScribeRenderer): void {
  session.snippetSession = undefined;
  session.selection = SelectionOps.collapsed(session.caret);
  session.selections = SelectionSetOps.singular(session.caret);
  renderer.setSelection(session.selection);
  renderer.setSelections(session.selections);
  updateCaretStatus(session.source, session.caret);
  renderer.start();
}

/**
 * Abre o **dropdown de escolha** (`${1|a,b,c|}`) quando a parada atual da sessão é uma escolha.
 *
 * O popup é **substituído** a cada abertura (a API mantém só um — o anterior some do DOM sem
 * `onCancel`) e o **foco volta ao canvas**: o teclado do editor vive no `<canvas>`, e o popup
 * focaria o próprio elemento — sem isto, a digitação pararia enquanto o dropdown estivesse
 * aberto (as teclas do popup são consumidas em `capture` no `document`).
 */
function openSnippetChoicePopup(
  session: TabSession,
  controller: DocumentController,
  surface: HTMLCanvasElement,
  renderer: ScribeRenderer,
  viewport: ViewportImpl,
): void {
  const active = session.snippetSession;
  if (active === undefined) return;
  const choice = currentChoice(active);
  if (choice === null || choice.choices.length === 0) return;
  const pos = session.source.positionAt(choice.end);
  const rect = surface.getBoundingClientRect();
  const anchor = snippetChoiceAnchor({
    canvasLeft: rect.left,
    canvasTop: rect.top,
    line: pos.line,
    // A row **visual** da linha do caret (com soft wrap, não é o índice da linha).
    visualRow: renderer.visualRowOfLine(pos.line),
    column: pos.column,
    scrollOffsetPx: viewport.scrollOffsetPx(),
    gutterWidth: gutterWidthOf(renderer),
    lineHeight: Math.ceil(TEXT_STYLE.sizePx * 1.4),
    charWidth: TEXT_STYLE.sizePx * 0.6,
  });
  showSnippetChoice({
    choices: choice.choices,
    x: anchor.x,
    y: anchor.y,
    onPick: (index) => {
      void controller.applySnippetChoice(session, choice.index, index);
    },
    onCancel: () => {
      // Cancelar o dropdown encerra a sessão (como o `Esc`).
      endSnippetSession(session, renderer);
    },
  });
  // O popup nasce dentro do `#ui-overlay`, que tem `pointer-events: none` (a camada de UI
  // não intercepta o mouse) — sem isto, o **clique** nas opções não chegaria ao popup.
  const popup = document.getElementById("snippet-choice-popup");
  if (popup instanceof HTMLElement) popup.style.pointerEvents = "auto";
  focusEditorSurface();
}

/** Requisição de destaque em voo: o que o renderer pediu (a resposta tem de cobrir exatamente isto). */
export interface HighlightRequest {
  /** Identidade do documento do pedido (ver `HighlightDocumentKey`). */
  readonly docKey: HighlightDocumentKey;
  readonly revision: number;
  readonly first: number;
  readonly count: number;
}

/**
 * Identidade do **documento ativo** no renderer: o `handle` da sessão aberta (`handle:<n>`) ou
 * `"demo"` quando não há ponte. É `string` opaca para o `HighlightStore` (só compara igualdade).
 *
 * Por que a identidade é obrigatória (achado ALTO de revisão): `revision` **reinicia em 1 por
 * documento** (`src/core/buffer/store.ts`), então chavear o realce só por revisão fazia o 2º arquivo
 * aberto casar com os spans do 1º (`covers(1, …)` verdadeiro, `blocked(1)` verdadeiro) — cores
 * erradas até o 1º edit.
 */
export type HighlightDocumentKey = string;

/** Chave do documento sem sessão (o texto de demonstração). */
export const DEMO_DOCUMENT_KEY: HighlightDocumentKey = "demo";

/** Chave derivada de um `handle` de documento da ponte. */
export function documentHighlightKey(handle: number): HighlightDocumentKey {
  return `handle:${handle}`;
}

/**
 * Intervalo mínimo entre **retentativas** de uma revisão cuja resposta veio vazia (sem gramática
 * pronta ainda). Curto de propósito: as gramáticas costumam carregar em poucos milissegundos, e o
 * intervalo impede que "resposta vazia não é cobertura" vire uma requisição (que relê o documento
 * inteiro no `main`) **por frame**.
 */
export const EMPTY_HIGHLIGHT_RETRY_MS = 250;

/**
 * Teto de **tentativas** por documento+revisão depois de respostas vazias (achado MÉDIO de revisão).
 * "Sem nenhum span" **não** é o mesmo que "sem gramática": um range visível todo em branco (arquivo
 * sem tokens, `start >= lines.length` ⇒ `lines: []`) também devolve zero spans — e aí a retentativa
 * disparava a cada `EMPTY_HIGHLIGHT_RETRY_MS` **para sempre**, cada uma com um `text()` do documento
 * inteiro no `main`. Esgotado o teto, a revisão entra em `blocked` **definitivo** (degrada à cor
 * default, com **um** `console.warn`): custo explicitamente limitado. Um edit muda a revisão e
 * reabre a tentativa.
 */
export const EMPTY_HIGHLIGHT_MAX_ATTEMPTS = 4;

/**
 * Corte **defensivo** do backoff das retentativas (dobra por tentativa). Com
 * `EMPTY_HIGHLIGHT_MAX_ATTEMPTS = 4` este corte é **inalcançável**: a 4ª resposta vazia já chama
 * `markFailed` **antes** de agendar o retry, então o backoff efetivo é `250 → 500 → 1000` ms
 * (`backoffMs` só é chamado com `attempts` ∈ {1, 2, 3}) — ver teste de backoff efetivo. Mantido como
 * guarda para o caso de o teto de tentativas subir.
 */
export const EMPTY_HIGHLIGHT_RETRY_MAX_MS = 2_000;

/**
 * Timeout do slot de requisição **em voo** (achado BAIXO de revisão): uma promise da ponte que nunca
 * resolve deixaria aquela revisão deduplicada para sempre (realce desligado em silêncio). Passado o
 * timeout o slot é liberado e a revisão é tratada como **falha** (mesma degradação explícita acima).
 * Folgado de propósito: uma resposta lenta de verdade (tokenização de um arquivo grande no `main`)
 * não deve virar falha — ver risco aberto de teto de tokenização em `docs/BACKLOG.md` §P2.4b.
 */
export const IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS = 10_000;

/**
 * Resposta "vazia" = nenhum span em nenhuma linha. Cobre tanto `lines` com `spans: []` (o `main`
 * tokeniza antes de as gramáticas carregarem) quanto `lines: []` (range fora do documento).
 */
function isEmptyHighlight(highlight: DocumentHighlight): boolean {
  for (const line of highlight.lines) {
    if (line.spans.length > 0) return false;
  }
  return true;
}

/**
 * Cache de spans por linha no renderer (a resposta do IPC `syntax.highlight`). Guarda o realce do
 * **documento ativo** (`docKey`) **na revisão** dele e só serve o que cobriu o range pedido — quem
 * não estiver coberto cai na cor default e um novo pedido é disparado (a resposta volta e redesenha).
 *
 * Guardas (achados de revisão):
 * - **identidade do documento** (achado ALTO): todo estado é chaveado por `docKey` + `revision`.
 *   Trocar de documento (`activate` com chave nova) **descarta** spans, `failed`, `warned`, `inFlight`
 *   e o estado de retentativa — o `revision` do arquivo novo reinicia em 1 e não pode herdar nada do
 *   anterior. `spansFor` é uma leitura **pura** e devolve `undefined` para chave alheia (nem um frame
 *   do documento novo pinta com os spans do antigo);
 * - `set` só aceita a resposta que **casa com a requisição** que a originou (mesmo documento, mesma
 *   revisão e range cobrindo o pedido): resposta fora de ordem — ou de um documento já trocado — é
 *   descartada em vez de virar cobertura inválida;
 * - `markFailed` lembra a falha **daquele documento+revisão** (`blocked`) e loga **no máximo uma
 *   vez** — gramática que registra e não compila não dispara IPC + `console.warn` por frame;
 * - resposta **sem nenhum span** **não** vira cobertura (senão a tela ficaria sem realce para
 *   sempre), mas a retentativa tem **teto**: `EMPTY_HIGHLIGHT_MAX_ATTEMPTS` com backoff exponencial
 *   de `250/500/1000` ms (o corte `EMPTY_HIGHLIGHT_RETRY_MAX_MS` não chega a agir; ver a constante),
 *   e depois disso a revisão fica `blocked` de forma definitiva —
 *   "sem span" também acontece em range em branco, que nunca vai virar realce;
 * - requisição **em voo** deduplica por documento+revisão (N frames antes da 1ª resposta geram **1**
 *   IPC) com `IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS`: promise que nunca resolve não deduplica para sempre.
 */
export class HighlightStore {
  private docKey: HighlightDocumentKey | undefined;
  private revision = -1;
  private first = 0;
  private count = 0;
  private spans: (readonly HighlightSpan[] | undefined)[] = [];
  private failedRevision = -1;
  private warnedRevision = -1;
  private inFlightRevision = -1;
  private inFlightSince = 0;
  private emptyRevision = -1;
  private emptyAttempts = 0;
  private emptyRetryAt = 0;

  /** `now` é injetável para os testes de retentativa/timeout (`EMPTY_HIGHLIGHT_*`, `IN_FLIGHT_*`). */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Fixa o documento ativo em `docKey`; se a identidade mudou, **descarta todo o estado** do
   * documento anterior (spans, falha, aviso já dado, requisição em voo e retentativas).
   */
  private activate(docKey: HighlightDocumentKey): void {
    if (this.docKey === docKey) return;
    this.docKey = docKey;
    this.resetState();
  }

  /**
   * Descarta **todo** o estado e volta a "nenhum documento ativo" (a próxima resposta decide o dono:
   * `set` adota a requisição). Usado quando a `LineSource` é trocada no dev-seam: a identidade do
   * documento vem do `controller`, não da fonte anexada, então os spans do documento anterior não
   * podem pintar o texto novo.
   */
  invalidate(): void {
    this.docKey = undefined;
    this.resetState();
  }

  private resetState(): void {
    this.revision = -1;
    this.first = 0;
    this.count = 0;
    this.spans = [];
    this.failedRevision = -1;
    this.warnedRevision = -1;
    this.inFlightRevision = -1;
    this.inFlightSince = 0;
    this.emptyRevision = -1;
    this.emptyAttempts = 0;
    this.emptyRetryAt = 0;
  }

  /**
   * Armazena a resposta **se** ela casar com `request`; devolve `false` quando descarta (documento
   * já trocado, revisão diferente, resposta fora de ordem, range que não cobre o pedido ou resposta
   * sem nenhum span).
   */
  set(highlight: DocumentHighlight, request: HighlightRequest): boolean {
    // Store novo (nenhum documento ativo ainda) adota a requisição; store já ligado a **outro**
    // documento descarta — resposta atrasada do arquivo anterior não reativa o estado dele.
    if (this.docKey === undefined) this.activate(request.docKey);
    if (this.docKey !== request.docKey) return false;
    if (highlight.revision !== request.revision) return false;
    const responseEnd = highlight.first + highlight.lines.length;
    const requestEnd = request.first + request.count;
    if (highlight.first > request.first || responseEnd < requestEnd) return false;
    if (this.revision !== -1 && highlight.revision < this.revision) return false;
    if (isEmptyHighlight(highlight)) {
      // Sem gramática pronta o main devolve o range pedido com `spans` vazios: registra a janela de
      // retentativa e **não** marca cobertura, para uma resposta posterior (já com gramática) valer.
      // A contagem é **por revisão**: um edit recomeça o teto (evita bloquear a revisão nova pelo
      // histórico da antiga).
      if (this.emptyRevision !== highlight.revision) {
        this.emptyRevision = highlight.revision;
        this.emptyAttempts = 0;
      }
      this.emptyAttempts += 1;
      if (this.emptyAttempts >= EMPTY_HIGHLIGHT_MAX_ATTEMPTS) {
        // Degradação explícita e definitiva: sem span depois do teto, parar de reler o documento.
        this.markFailed(
          request.docKey,
          highlight.revision,
          `sem spans após ${this.emptyAttempts} tentativas`,
        );
        return false;
      }
      this.emptyRetryAt = this.now() + this.backoffMs(this.emptyAttempts);
      return false;
    }
    this.revision = highlight.revision;
    this.first = highlight.first;
    this.count = highlight.lines.length;
    this.spans = [];
    for (const line of highlight.lines) this.spans[line.line] = line.spans;
    // Resposta boa da mesma revisão: se ela estava marcada como falha (ex.: timeout do slot), o
    // realce voltou a funcionar — libera a revisão para pedir os ranges seguintes.
    if (this.failedRevision === highlight.revision) this.failedRevision = -1;
    this.emptyRevision = -1;
    this.emptyAttempts = 0;
    this.emptyRetryAt = 0;
    return true;
  }

  /**
   * Spans da linha **se** forem do documento `docKey` (leitura pura, sem efeito colateral: é o que o
   * desenho chama a cada frame — não pode ativar/invalidar nada).
   */
  spansFor(docKey: HighlightDocumentKey, line: number): readonly HighlightSpan[] | undefined {
    if (this.docKey !== docKey) return undefined;
    return this.spans[line];
  }

  covers(docKey: HighlightDocumentKey, revision: number, first: number, count: number): boolean {
    this.activate(docKey);
    return (
      this.revision === revision && first >= this.first && first + count <= this.first + this.count
    );
  }

  /** Já falhou nesta revisão (deste documento)? Então nem tenta de novo (nada de IPC em loop). */
  blocked(docKey: HighlightDocumentKey, revision: number): boolean {
    this.activate(docKey);
    return this.failedRevision === revision;
  }

  /**
   * Vale a pena pedir este range? `false` = bloqueado (falhou ou esgotou o teto de retentativas), já
   * coberto, com requisição **em voo** para a mesma revisão (dedupe) ou dentro da janela de
   * retentativa pós-resposta-vazia. O slot em voo vencido (`IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS`) é
   * liberado aqui e a revisão é marcada como falha.
   */
  needsRequest(
    docKey: HighlightDocumentKey,
    revision: number,
    first: number,
    count: number,
  ): boolean {
    this.activate(docKey);
    if (this.failedRevision === revision) return false;
    if (this.inFlightRevision === revision) {
      if (this.now() - this.inFlightSince < IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS) return false;
      // Promise da ponte que não resolveu: libera o slot/dedupe e degrada explicitamente.
      this.inFlightRevision = -1;
      this.inFlightSince = 0;
      this.markFailed(
        docKey,
        revision,
        `requisição em voo sem resposta após ${IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS} ms`,
      );
      return false;
    }
    if (this.covers(docKey, revision, first, count)) return false;
    if (this.emptyRevision === revision && this.now() < this.emptyRetryAt) return false;
    return true;
  }

  /** Marca a requisição da revisão como **em voo** (ver `needsRequest`). */
  beginRequest(docKey: HighlightDocumentKey, revision: number): void {
    this.activate(docKey);
    this.inFlightRevision = revision;
    this.inFlightSince = this.now();
  }

  /** Libera a requisição em voo (sucesso, falha ou resposta descartada). */
  endRequest(docKey: HighlightDocumentKey, revision: number): void {
    // Sem `activate`: a resolução atrasada do documento anterior não pode retomar o estado dele.
    if (this.docKey !== docKey) return;
    if (this.inFlightRevision === revision) {
      this.inFlightRevision = -1;
      this.inFlightSince = 0;
    }
  }

  /**
   * Marca a falha da revisão e loga **uma única vez** por documento+revisão (degradação explícita,
   * DEC-TR-7).
   */
  markFailed(docKey: HighlightDocumentKey, revision: number, error?: unknown): void {
    this.activate(docKey);
    this.failedRevision = revision;
    if (this.warnedRevision === revision) return;
    this.warnedRevision = revision;
    console.warn("Scribe: destaque de sintaxe indisponível (degradando à cor default)", error);
  }

  /**
   * Backoff exponencial das retentativas (dobra por tentativa, cortado em
   * `EMPTY_HIGHLIGHT_RETRY_MAX_MS`). Com `EMPTY_HIGHLIGHT_MAX_ATTEMPTS = 4` só `attempts` ∈ {1, 2, 3}
   * chegam aqui ⇒ backoff efetivo `250/500/1000` ms.
   */
  private backoffMs(attempts: number): number {
    return Math.min(EMPTY_HIGHLIGHT_RETRY_MS * 2 ** (attempts - 1), EMPTY_HIGHLIGHT_RETRY_MAX_MS);
  }
}

function documentPath(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get("file");
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : undefined;
}

/**
 * Controlador do documento no renderer: mantém a sessão ativa, abre arquivos (boot por `?file=`,
 * diálogo nativo) e faz undo/redo e digitação — sempre relendo o texto inteiro do documento (o
 * seam mínimo do slice). A abertura é **cancelável** por `signalId` (DEC-IPC-9): trocar de arquivo
 * (ou Esc) aborta a abertura anterior.
 */

/**
 * Busca folding ranges via LSP e atualiza o estado de folding do renderer.
 */
async function fetchFolding(
  bridge: ScribeBridge | undefined,
  renderer: ScribeRenderer,
  handle: number,
): Promise<void> {
  if (bridge?.foldingRange === undefined) return;
  try {
    const ranges = await bridge.foldingRange(handle);
    const folds: FoldRange[] = ranges.map((r) => ({
      startLine: r.startLine,
      endLine: r.endLine,
      kind: r.kind,
      isCollapsed: false,
    }));
    foldingStates.set(handle, folds);
    renderer.setFolding(folds);
  } catch {
    /* silencia */
  }
}

/**
 * Busca git diff do documento em relação ao HEAD e atualiza o renderer.
 */
async function fetchGitDiff(
  bridge: ScribeBridge | undefined,
  renderer: ScribeRenderer,
  handle: number,
): Promise<void> {
  if (bridge?.gitDiff === undefined) return;
  try {
    const diffs = await bridge.gitDiff(handle);
    renderer.setGitDiffs(diffs);
    renderer.start();
  } catch {
    /* silencia */
  }
}

/**
 * Largura do gutter (px) do documento ativo — a **mesma** do desenho do texto.
 *
 * O texto é desenhado em `gutterWidth + 8`; a coluna do mouse tem de ser medida a partir
 * da mesma origem (com uma origem fixa, o hover pega o identificador 3–4 caracteres ao lado).
 */
function gutterWidthOf(renderer: ScribeRenderer): number {
  const width = renderer.getGutterWidth?.();
  if (typeof width === "number" && Number.isFinite(width) && width > 0) return width;
  const lineCount = renderer.sourceLineCount();
  const digits = Math.max(1, Math.floor(Math.log10(Math.max(1, lineCount))) + 1);
  return digits * 9 + 16;
}

/**
 * Busca os breakpoints desejados do documento (linhas 1-based) e pinta as bolinhas no gutter.
 * A fonte da verdade vive no main (`DapManager.desiredBreakpoints`) — persiste entre sessões.
 */
async function fetchDebugBreakpoints(
  bridge: ScribeBridge | undefined,
  renderer: ScribeRenderer,
  handle: number,
): Promise<void> {
  if (bridge?.dapBreakpoints === undefined) return;
  try {
    const raw = await bridge.dapBreakpoints(handle);
    // Tolera um preload antigo (que devolvia só as linhas).
    const specs = normalizeBreakpointList(raw);
    renderer.setBreakpointLines(specs.map((spec) => spec.line));
    renderer.start();
  } catch {
    /* silencia */
  }
}

/**
 * Busca inlay hints via LSP para o range visível e atualiza o renderer.
 */
async function fetchInlayHints(
  session: TabSession,
  bridge: ScribeBridge,
  renderer: ScribeRenderer,
  viewport: ViewportImpl,
): Promise<void> {
  if (bridge.inlayHints === undefined) return;
  const lineHeight = Math.ceil(TEXT_STYLE.sizePx * 1.4);
  // A 1ª linha **visível**: com soft wrap o offset da rolagem é contado em rows visuais
  // ⇒ a linha é a que contém a 1ª row (o pedido ao LSP é em linhas).
  const firstLine = renderer.firstVisibleLine();
  const visLines = Math.ceil(renderer.viewportHeight / lineHeight) + 1;
  const lastLine = firstLine + visLines;
  try {
    const hints = await bridge.inlayHints(session.handle, firstLine, lastLine);
    const lineCount = renderer.sourceLineCount();
    const gutterDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, lineCount))) + 1);
    const gutterWidth = gutterDigits * 9 + 16;
    const paddingLeft = gutterWidth + 8;
    const paddingTop = 8;
    const tabWidth = 4;
    const rendered: RenderInlayHint[] = [];
    for (const h of hints) {
      if (h.position.line >= firstLine && h.position.line <= lastLine) {
        const lineText = session.source.line(h.position.line);
        let px = paddingLeft;
        for (let ci = 0; ci < Math.min(h.position.character, lineText.length); ci++) {
          const ch = lineText[ci] ?? " ";
          if (ch === "\t") {
            const stop = tabWidth - (ci % tabWidth);
            px += TEXT_STYLE.sizePx * 0.6 * stop;
          } else {
            px += TEXT_STYLE.sizePx * 0.6;
          }
        }
        const y =
          paddingTop +
          renderer.visualRowOfLine(h.position.line) * lineHeight -
          viewport.scrollOffsetPx();
        rendered.push({
          line: h.position.line,
          x: px,
          y,
          label: h.label,
          paddingLeft: h.paddingLeft ?? false,
          paddingRight: h.paddingRight ?? false,
        });
      }
    }
    renderer.setInlayHints(rendered);
    renderer.start();
  } catch {
    /* silencia */
  }
}

// ---- multi-cursor (P2#5) — matemática pura (testável sem DOM) ----------------------------------

/**
 * Monta **1 edição por cursor** para a digitação multi-cursor: cada edição substitui o
 * trecho selecionado pelo cursor (vazio, se colapsado) pelo texto digitado.
 *
 * As edições saem em ordem **descendente** por `at` — é a ordem que o `document.batchInsert`
 * exige (o `at` de cada entrada é absoluto no buffer **após** as entradas anteriores) e a
 * mesma que o splice local aplica (os offsets abaixo continuam válidos).
 */
export function buildTypingEdits(
  selections: SelectionSet,
  text: string,
  source: string,
): SelectionEdit[] {
  return selections
    .map((sel): SelectionEdit => {
      const { start, end } = SelectionOps.normalized(sel);
      return { at: start, remove: source.slice(start, end), insert: text };
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * Monta as edições de **apagar** (Backspace/Delete) em N cursores — uma por cursor, na ordem
 * descendente:
 *
 * - cursor com seleção expandida ⇒ apaga o range selecionado;
 * - `backward` ⇒ apaga o caractere anterior (ou o **par vazio**, como o caminho de 1 cursor);
 * - `forward` ⇒ apaga o caractere seguinte.
 *
 * Cursors sem nada a apagar (no início/fim do documento) são **omitidos** — o resto do
 * conjunto continua vivo.
 */
export function buildDeleteEdits(
  selections: SelectionSet,
  source: string,
  direction: "backward" | "forward",
): SelectionEdit[] {
  const edits: SelectionEdit[] = [];
  for (const sel of selections) {
    const { start, end } = SelectionOps.normalized(sel);
    if (start !== end) {
      edits.push({ at: start, remove: source.slice(start, end), insert: "" });
      continue;
    }
    const pos = sel.active;
    if (direction === "backward") {
      if (pos <= 0) continue;
      const prev = source[pos - 1] ?? "";
      const next = source[pos] ?? "";
      // Par vazio: o cursor está **entre** os delimitadores ⇒ apaga os dois (mesma regra do
      // caminho de 1 cursor: `replaceText(pos - 1, 2, "")`).
      const isPair = AUTO_PAIRS[prev] === next;
      const at = pos - 1;
      const end = isPair ? pos + 1 : pos;
      edits.push({ at, remove: source.slice(at, end), insert: "" });
    } else {
      if (pos >= source.length) continue;
      edits.push({ at: pos, remove: source.slice(pos, pos + 1), insert: "" });
    }
  }
  return edits.sort((a, b) => b.at - a.at);
}

/**
 * Monta as edições de uma **tecla** em N cursores.
 *
 * - `close !== undefined` ⇒ é um **par** (ex.: `(` + `)`): o par entra em todos os cursores;
 * - `close === undefined` ⇒ é uma tecla de **fechamento** (ex.: `)`): num cursor cujo próximo
 *   caractere já é a tecla, o cursor apenas **pula** (nada é inserido) — a mesma regra do
 *   caminho de 1 cursor; nos demais, a tecla é inserida.
 *
 * As edições saem em ordem **descendente** por `at`; `skipped` traz os **índices** dos
 * cursores que só pularam (eles não produzem edição, mas o cursor anda 1 à frente).
 */
export function buildKeyEdits(
  selections: SelectionSet,
  key: string,
  close: string | undefined,
  source: string,
): { readonly edits: SelectionEdit[]; readonly skipped: readonly number[] } {
  const edits: SelectionEdit[] = [];
  const skipped: number[] = [];
  selections.forEach((sel, index) => {
    const { start, end } = SelectionOps.normalized(sel);
    if (close === undefined && sel.active < source.length && source[sel.active] === key) {
      // O fechamento já está lá: o cursor só pula (nada é inserido).
      skipped.push(index);
      return;
    }
    edits.push({
      at: start,
      remove: source.slice(start, end),
      insert: close === undefined ? key : key + close,
    });
  });
  edits.sort((a, b) => b.at - a.at);
  return { edits, skipped };
}

/**
 * Aplica as edições (ordem **descendente**) no texto local — o splice de latência zero.
 *
 * Cada edição toca uma faixa **abaixo** das anteriores, então os offsets continuam válidos
 * durante a aplicação (é o mesmo raciocínio do `document.batchInsert`).
 */
export function applyEditsToText(source: string, edits: readonly SelectionEdit[]): string {
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.at) + edit.insert + out.slice(edit.at + edit.remove.length);
  }
  return out;
}

/**
 * Calcula o conjunto de cursores **depois** das edições multi-cursor.
 *
 * `advanceSelections` (fonte única da regra, em `src/shared`) desloca os cursores; `cursorBack`
 * puxa o cursor para **antes** do fim do texto inserido (o auto-pair deixa o cursor **entre**
 * os delimitadores) e os cursores que **pularam** um fechamento já existente avançam 1.
 */
export function advanceCursorSet(
  before: SelectionSet,
  edits: readonly SelectionEdit[],
  cursorBack: number,
  skipped: readonly number[],
): SelectionSet {
  const advanced = advanceSelections(before, edits);
  const skipSet = new Set(skipped);
  return advanced.map((sel, index) => {
    if (skipSet.has(index)) {
      return { anchor: sel.anchor + 1, active: sel.active + 1 };
    }
    if (cursorBack <= 0) return sel;
    return {
      anchor: Math.max(0, sel.anchor - cursorBack),
      active: Math.max(0, sel.active - cursorBack),
    };
  });
}

/** Clampa um offset ao documento (`[0, length]`). */
export function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(Math.trunc(offset), length));
}

/**
 * Clampa um conjunto de seleções ao tamanho do texto — o undo/redo devolve offsets que podem
 * estar fora do documento (o texto encolheu desde a edição).
 */
export function clampSelections(
  selections: SelectionSet | undefined,
  length: number,
): SelectionSet {
  if (selections === undefined) return [];
  return selections.map((sel) => ({
    anchor: clampOffset(sel.anchor, length),
    active: clampOffset(sel.active, length),
  }));
}

/**
 * **Delta** de texto: o trecho que sai (`remove`) e o que entra (`insert`).
 *
 * É a unidade de reconciliação do renderer: quando o documento muda **por fora** (plugin,
 * LSP, outra aba), o caret e as seleções precisam andar com a mudança — senão a próxima
 * digitação entra no lugar errado e o texto sai corrompido.
 */
export interface TextDelta {
  /** Offset do início do trecho trocado. */
  readonly at: number;
  /** Trecho removido ("" = inserção pura). */
  readonly remove: string;
  /** Texto inserido ("" = remoção pura). */
  readonly insert: string;
}

/**
 * Delta entre dois textos — diff de **prefixo/sufixo** (o mais barato que existe).
 *
 * O texto igual no começo e no fim é o contexto; o meio é a troca. É o bastante para mapear
 * o caret e as seleções através de uma edição externa.
 */
export function diffText(before: string, after: string): TextDelta {
  if (before === after) return { at: 0, remove: "", insert: "" };
  const maxCommon = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < maxCommon && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = maxCommon - prefix;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    at: prefix,
    remove: before.slice(prefix, before.length - suffix),
    insert: after.slice(prefix, after.length - suffix),
  };
}

/**
 * Aplica um **delta** ao conjunto de cursores (a regra única de deslocamento).
 *
 * Reusa `advanceSelections` (de `src/shared`): o cursor **antes** do trecho trocado não se
 * move; o **depois** desloca pelo tamanho da troca; o que está **dentro** do trecho volta
 * para o fim do texto inserido.
 */
export function applyDeltaToSelections(
  selections: SelectionSet,
  delta: TextDelta,
): SelectionSet {
  if (delta.remove.length === 0 && delta.insert.length === 0) return selections;
  return advanceSelections(selections, [
    { at: delta.at, remove: delta.remove, insert: delta.insert },
  ]);
}

/**
 * Posição do **caret** (a barra do cursor) — a mesma que a status bar mostra.
 *
 * O caret é o `active` da seleção **primária** (o 1º cursor do conjunto) — o mesmo offset
 * que a status bar exibe (`session.caret` ≡ `session.selection.active`).
 *
 * ⚠️ **Bug corrigido**: o renderer desenhava a barra na **1ª linha visível, coluna 0** (o
 * comentário dizia ser o "destaque de linha atual") ⇒ a barra ficava colada no topo-esquerdo
 * da viewport e o cursor real **nunca** chegava ao canvas. A linha do cursor é um conceito
 * **separado** (o `activeLine` do `buildInstances`).
 */
export interface CaretPlacement {
  /** Offset absoluto do caret no documento. */
  readonly offset: number;
  /** Linha (0-based) do caret. */
  readonly line: number;
  /** Coluna (0-based) do caret. */
  readonly column: number;
}

/**
 * Calcula a posição do caret a partir do conjunto de seleções (multi-cursor).
 *
 * @param source A fonte do documento (para converter o offset em linha/coluna).
 * @param selections O conjunto de cursores (o 1º é o primário).
 */
export function caretPlacement(
  source: LineSource,
  selections: SelectionSet | undefined,
): CaretPlacement {
  const offset = selections?.[0]?.active ?? 0;
  const pos = source.positionAt(offset);
  return { offset, line: pos.line, column: pos.column };
}

/**
 * Row **visual** de um Y do canvas (px) — o hit-test do clique do mouse.
 *
 * ⚠️ **Correção do off-by-one**: a âncora vertical é o **centro do texto**
 * (`paddingTop + lineHeight/2`), não `sizePx * 0.7` — com a âncora antiga, clicar nos
 * primeiros pixels da linha caía na linha **anterior** (o texto ficava ~5px abaixo da
 * âncora). Ancorar no centro faz o topo da linha pertencer à própria linha.
 *
 * @param y Y do canvas (px, relativo ao topo do viewport).
 * @param scrollOffsetPx Offset de rolagem (px).
 * @param lineHeight Altura da linha (px).
 * @param paddingTop Padding vertical acima da 1ª linha (px).
 */
export function rowAtCanvasY(
  y: number,
  scrollOffsetPx: number,
  lineHeight: number,
  paddingTop: number,
): number {
  const row = Math.round((y + scrollOffsetPx - paddingTop - lineHeight / 2) / lineHeight);
  // `Math.round(-0.5)` devolve `-0` — normaliza para `0` (mesmo valor, sem o "negative zero").
  return row === 0 ? 0 : row;
}

class DocumentController {
  private sessions: TabSession[] = [];
  private activeIndex = -1;
  private opening: { readonly signalId: number; readonly path: string } | undefined;

  /**
   * Lote de inserções pendentes — acumula keystrokes entre frames.
   *
   * Cada entrada é `{at, text, remove?}`: o `at` é **absoluto no buffer após as entradas
   * anteriores** (semântica do `document.batchInsert`) ⇒ um lote multi-cursor entra em ordem
   * **descendente**.
   */
  private pendingBatch: Array<{ at: number; text: string; remove?: string }> | null = null;
  /**
   * Snapshot do conjunto de cursores **no início do lote** — é o "before" que o undo restaura
   * (um `Ctrl+Z` devolve os N cursores às posições originais).
   */
  private pendingBatchSelections: SelectionSet | null = null;
  /** Revisão local estimada (incrementada a cada keystroke batched). */
  private batchLocalRevision = 0;
  /** Timer do rAF para flush do lote. */
  private flushTimer: number | null = null;
  /**
   * Flush do lote **em voo** (o `flushBatch` é assíncrono).
   *
   * Quem precisa do texto do servidor (a reconciliação de uma edição externa) **aguarda**
   * esta promessa: sem ela, a reconciliação leria o texto **antes** do lote ser aplicado e
   * o delta sairia ao contrário (o caret voltaria para trás).
   */
  private flushInFlight: Promise<void> | null = null;

  /**
   * Notificado quando o **documento ativo** muda (abertura, ativação ou fechamento).
   *
   * Usado pelo painel de depuração: a lista de breakpoints acompanha o documento ativo
   * (sem isto, editar a condição do arquivo A gravaria no arquivo B).
   */
  onActiveDocumentChanged: ((session: TabSession | undefined) => void) | undefined;

  constructor(
    private readonly bridge: ScribeBridge,
    private readonly viewport: ViewportImpl,
    private readonly renderer: ScribeRenderer,
  ) {}

  get current(): TabSession | undefined {
    return this.activeIndex >= 0 ? this.sessions[this.activeIndex] : undefined;
  }

  get openSessions(): readonly TabSession[] {
    return this.sessions;
  }

  currentIndex(): number {
    return this.activeIndex;
  }

  /**
   * `true` quando há **lote pendente** (digitação que ainda não foi para o core).
   *
   * Quem salva por conta própria (o DAP, antes de depurar) usa isto para **não** limpar
   * a marca de sujo: o usuário pode ter digitado durante o `await` — esse texto ainda não
   * foi salvo.
   */
  get hasPendingBatch(): boolean {
    return this.pendingBatch !== null;
  }

  private lineHeight(): number {
    return Math.ceil(TEXT_STYLE.sizePx * 1.4);
  }

  /** Aborta a abertura em curso (se houver). `true` = havia uma para cancelar. */
  cancelOpening(): boolean {
    const opening = this.opening;
    if (opening === undefined) return false;
    this.opening = undefined;
    this.bridge.cancel(opening.signalId);
    setDocStatus(`abertura cancelada: ${opening.path}`);
    return true;
  }

  /** Abre `path`, cancelando qualquer abertura anterior. `true` = documento ligado. */
  async open(path: string): Promise<boolean> {
    await this.flushBatch();
    // Snippets (P4#18): abrir outro documento encerra a sessão de snippet do ativo.
    const previous = this.current;
    if (previous !== undefined) previous.snippetSession = undefined;
    hideSnippetChoice();
    this.cancelOpening();
    const signalId = this.bridge.nextSignalId();
    this.opening = { signalId, path };
    setDocStatus(`abrindo: ${path}…`);

    let handle: number;
    try {
      handle = await this.bridge.open(path, signalId);
    } catch (error) {
      if (this.opening?.signalId === signalId) {
        this.opening = undefined;
        setDocStatus(`falha ao abrir: ${path}`);
        console.warn(`Scribe: falha ao abrir "${path}"`, error);
      }
      return false;
    }
    if (this.opening?.signalId !== signalId) return false; // cancelado ou substituído

    this.opening = undefined;
    const revision = await this.bridge.revision(handle);
    // Cria novo DocumentLineSource para esta sessão
    const source = new DocumentLineSource(await this.bridge.text(handle), revision);
    const label = path.split("/").pop() ?? path;

    const unsubscribe = this.bridge.onDocumentChanged((event) => {
      if (event.handle !== handle) return;
      const s = this.sessions.find((s) => s.handle === handle);
      if (s === undefined) return;
      // Se já temos o texto desta revisão (aplicado via insertText/replaceText com resultado
      // rico), não precisa reler — elimina roundtrip redundante do evento.
      //
      // ⚠️ A comparação é com a **revisão do servidor** (`serverRevision`), não com a
      // `source.revision`: a edição local usa um contador próprio (1, 2, 3…) que colide
      // com a revisão do servidor — a comparação antiga "envelhecia" o evento e a edição
      // externa **nunca** era reconciliada (o caret ficava no offset antigo e a próxima
      // digitação corrompia o texto).
      if (s.serverRevision >= event.revision) return;
      void this.reconcileExternalChange(s, event.revision);
    });

    const session: TabSession = {
      bridge: this.bridge,
      handle,
      source,
      path,
      label,
      caret: 0,
      selection: SelectionOps.collapsed(0),
      selections: SelectionSetOps.singular(0),
      serverRevision: revision,
      savedScrollPx: 0,
      dirty: false,
      dispose: unsubscribe,
    };

    this.sessions.push(session);
    this.activeIndex = this.sessions.length - 1;
    this.renderer.attachSource(source);
    this.renderer.setActiveHandle(handle);
    this.viewport.setMetrics({ lineCount: source.lineCount() });
    this.viewport.scrollTo(0);
    this.renderer.setSelection(session.selection);
    this.renderer.setSelections(session.selections);
    updateCaretStatus(source, 0);
    updateBlame(session, this.bridge, 0);
    setDocStatus(label);
    setBreadcrumbs(path);
    setDirtyStatus(false);
    showWelcome(false);
    await this.refreshUndoStatus();
    this.renderTabBar();
    this.renderer.start();
    // Busca folding ranges iniciais (LSP)
    void fetchFolding(this.bridge, this.renderer, handle);
    // Busca git diff iniciais
    void fetchGitDiff(this.bridge, this.renderer, handle);
    // Busca breakpoints do documento (bolinhas no gutter)
    void fetchDebugBreakpoints(this.bridge, this.renderer, handle);
    // Busca inlay hints iniciais (LSP)
    {
      const s = this.current;
      if (s !== undefined) {
        void fetchInlayHints(s, this.bridge, this.renderer, this.viewport);
      }
    }
    console.info(`Scribe: documento ligado via preload "${path}" (handle ${handle})`);
    this.onActiveDocumentChanged?.(session);
    // O teclado do editor vive no <canvas> (listener de keydown). Sem devolver o foco para
    // ele, abrir um arquivo pelo diálogo (ou duplo clique) deixa o foco no diálogo/menu e
    // **digitar não faz nada** — sintoma "não dá pra editar".
    focusEditorSurface();
    return true;
  }

  activate(index: number): void {
    if (index < 0 || index >= this.sessions.length) return;
    if (index === this.activeIndex) {
      // ⚠️ Clicar na aba **já ativa** não pode deixar o editor mudo: sem devolver o foco ao
      // <canvas>, a digitação não insere nada e o `Ctrl+Z` não desfaz (o foco ficava no
      // <button> da aba). O `focusEditorSurface()` é chamado **sempre** ao final do
      // `activate()` — inclusive neste early-return.
      focusEditorSurface();
      return;
    }
    // Flush lote pendente antes de trocar de documento
    void this.flushBatch();
    // Salva estado da sessão atual
    const old = this.sessions[this.activeIndex];
    if (old !== undefined) {
      // Em **linhas lógicas** (com soft wrap, o offset real é contado em rows visuais —
      // a restauração abaixo é por linha).
      old.savedScrollPx = this.renderer.logicalScrollOffsetPx();
      // Snippets (P4#18): trocar de documento encerra a sessão de snippet ativa.
      old.snippetSession = undefined;
      hideSnippetChoice();
    }
    // Ativa nova sessão
    this.activeIndex = index;
    const session = this.sessions[index]!;
    this.renderer.attachSource(session.source);
    this.renderer.setActiveHandle(session.handle);
    this.viewport.setMetrics({ lineCount: session.source.lineCount() });
    this.viewport.scrollTo(Math.round(session.savedScrollPx / this.lineHeight()));
    this.renderer.setSelection(session.selection);
    this.renderer.setSelections(session.selections);
    updateCaretStatus(session.source, session.caret);
    updateBlame(session, this.bridge, session.source.positionAt(session.caret).line);
    setDocStatus(session.label);
    setBreadcrumbs(session.path);
    setDirtyStatus(session.dirty ?? false);
    this.refreshUndoStatus();
    this.renderTabBar();
    // Restaura folding do documento ativado
    const folds = foldingStates.get(session.handle);
    if (folds !== undefined) {
      this.renderer.setFolding(folds);
    }
    // Busca inlay hints para o range visível
    void fetchInlayHints(session, this.bridge, this.renderer, this.viewport);
    // Busca git diff para o documento ativado
    void fetchGitDiff(this.bridge, this.renderer, session.handle);
    // Busca breakpoints do documento ativado (bolinhas no gutter)
    void fetchDebugBreakpoints(this.bridge, this.renderer, session.handle);
    this.renderer.start();
    this.onActiveDocumentChanged?.(session);
    // Trocar de aba devolve o foco ao canvas (o teclado do editor vive nele).
    focusEditorSurface();
  }

  close(index: number): void {
    if (index < 0 || index >= this.sessions.length) return;
    // Flush lote pendente antes de fechar
    void this.flushBatch();
    const session = this.sessions[index]!;
    // Snippets (P4#18): fechar o documento encerra a sessão de snippet dele.
    session.snippetSession = undefined;
    hideSnippetChoice();
    session.dispose();
    foldingStates.delete(session.handle);
    // O **core** fecha o documento: o `didClose` do LSP sai por aqui — sem isto, o servidor
    // LSP **acumula** os documentos fechados (memória + diagnósticos obsoletos).
    //
    // O preload antigo não expõe o método ⇒ a aba fecha só do lado do renderer (sem crash).
    const closeDocument = this.bridge.closeDocument;
    if (closeDocument !== undefined) {
      void closeDocument.call(this.bridge, session.handle).catch((error: unknown) => {
        console.warn("Scribe: falha ao fechar o documento no core", error);
      });
    }
    this.sessions.splice(index, 1);
    if (this.sessions.length === 0) {
      this.activeIndex = -1;
      this.renderer.setInlayHints([]);
      setDocStatus("sem documento");
      setBreadcrumbs(undefined);
      setDirtyStatus(false);
      setUndoStatus(false, false);
      showWelcome(true);
      this.onActiveDocumentChanged?.(undefined);
    } else if (index <= this.activeIndex) {
      this.activate(Math.max(0, this.activeIndex - 1));
    } else {
      this.activate(this.activeIndex);
    }
    this.renderTabBar();
    this.renderer.start();
  }

  /**
   * Redesenha a barra de abas (e a lista de "Abertos").
   *
   * É **pública** porque o caminho do DAP salva o documento **fora** do controller (o
   * `save()` engole a falha — o DAP precisa propagá-la) e ainda tem de atualizar a aba.
   */
  renderTabBar(): void {
    this.renderSidebar();
    const bar = document.getElementById("tab-bar");
    if (!bar) return;
    bar.innerHTML = "";
    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i]!;
      const tab = document.createElement("button");
      tab.className = `tab${i === this.activeIndex ? " active" : ""}${s.dirty ? " dirty" : ""}`;
      tab.role = "tab";
      tab.setAttribute("aria-selected", String(i === this.activeIndex));

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = s.label;
      tab.appendChild(label);

      const close = document.createElement("span");
      close.className = "tab-close";
      close.innerHTML = ICON_CLOSE;
      close.title = "Fechar";
      close.addEventListener("mousedown", (e: MouseEvent) => {
        e.stopPropagation();
        this.close(i);
      });
      tab.appendChild(close);

      tab.addEventListener("click", () => this.activate(i));
      tab.addEventListener("mousedown", (e: MouseEvent) => {
        // O foco do editor vive no <canvas>: sem `preventDefault`, o clique na aba move o
        // foco para o <button> e o editor fica **mudo** (digitar não insere, Ctrl+Z não
        // desfaz). O `activate()` devolve o foco ao canvas de qualquer forma.
        e.preventDefault();
        if (e.button === 1) {
          // Middle click
          this.close(i);
        }
      });

      bar.appendChild(tab);
    }
  }

  /**
   * Espelha os documentos abertos no painel lateral ("Abertos"). É chamado junto com a tab bar
   * para que as duas visões da mesma lista nunca divirjam.
   */
  private renderSidebar(): void {
    const count = document.getElementById("sidebar-count");
    if (count) count.textContent = String(this.sessions.length);
    const list = document.getElementById("sidebar-editors");
    if (!list) return;
    list.replaceChildren();
    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i]!;
      const item = document.createElement("button");
      item.type = "button";
      item.className = `sidebar-item${i === this.activeIndex ? " active" : ""}`;
      item.role = "listitem";
      item.title = s.path;

      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = s.label;
      item.appendChild(name);

      if (s.dirty) {
        const dot = document.createElement("span");
        dot.className = "item-dot";
        dot.title = "Modificado";
        item.appendChild(dot);
      }

      item.addEventListener("click", () => this.activate(i));
      list.appendChild(item);
    }
  }

  /** Abre o diálogo nativo; se o usuário escolher um arquivo, abre-o. */
  async openDialog(): Promise<boolean> {
    const path = await this.bridge.openDialog();
    if (path === null || path.length === 0) return false;
    return this.open(path);
  }

  /**
   * Pede o destaque de um range de linhas do documento atual (o main tokeniza e devolve spans).
   * `null` = sem sessão, sem suporte na ponte (preload antigo) ou falha — nesse caso o renderer
   * degrada para a cor default; o log é consolidado no `HighlightStore` (**um** por revisão).
   * Rejeita se a ponte falhar (quem chama trata e marca a revisão como falha).
   */
  async loadHighlight(first: number, count: number): Promise<DocumentHighlight | null> {
    const session = this.current;
    if (session === undefined || count <= 0) return null;
    const highlight = session.bridge.highlight;
    // Preload antigo (sem `syntax.highlight`): degrada explicitamente, sem crash (DEC-TR-7).
    if (highlight === undefined) return null;
    return highlight.call(session.bridge, session.handle, first, count);
  }

  async undo(): Promise<void> {
    await this.runHistory("undo");
  }

  async redo(): Promise<void> {
    await this.runHistory("redo");
  }

  /** Digitação mínima: aplica splice local e acumula no lote. */
  async insertText(text: string): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    try {
      const s = session.selection;
      if (session.snippetSession !== undefined) {
        // ⚠️ **Multi-cursor + snippet**: a expansão do snippet é ambígua (ela tem um
        // único cursor). O ramo do snippet vinha **primeiro** e fazia
        // `selections = singular(caret)` — destruindo o conjunto de cursores. Aqui a
        // sessão de snippet é **encerrada explicitamente** (sem colapsar a seleção) e o
        // fluxo segue pelo caminho multi-cursor, que preserva os N cursores.
        if (session.selections.length > 1) {
          session.snippetSession = undefined;
          hideSnippetChoice();
        } else {
          // Snippets (P4#18): com sessão ativa o splice local ficaria incoerente com os espelhos
          // (o lote só chega ao main no rAF, mas o espelho precisa do valor **antes** do próximo
          // roundtrip). Decisão: usa o caminho IPC imediato — 1 roundtrip por tecla, latência
          // extra **só** dentro de sessão de snippet.
          if (!SelectionOps.isCollapsed(s)) {
            await this.flushBatch();
            const { start, end } = SelectionOps.normalized(s);
            await this.replaceText(start, end - start, text);
          } else {
            await this.replaceText(session.caret, 0, text);
          }
          return;
        }
      }
      // Multi-cursor (P2#5): N cursores ⇒ N edições (uma por cursor) num **único** lote —
      // um `Ctrl+Z` desfaz as N edições e restaura os N cursores.
      if (session.selections.length > 1) {
        this.applyCursorEdits(
          session,
          buildTypingEdits(session.selections, text, session.source.text),
          [],
          0,
        );
        return;
      }
      if (!SelectionOps.isCollapsed(s)) {
        // Seleção expandida: flush + replaceText imediato
        await this.flushBatch();
        const { start, end } = SelectionOps.normalized(s);
        await this.replaceText(start, end - start, text);
        return;
      }
      // Aplica splice local (zero latência!)
      const insertAt = session.caret;
      // O "before" do lote: o conjunto de cursores **antes** desta tecla (o undo restaura ele).
      const before = session.selections;
      const oldText = session.source.text;
      const newText = oldText.slice(0, insertAt) + text + oldText.slice(insertAt);
      this.batchLocalRevision += 1;
      const localRev = this.batchLocalRevision;
      session.source.setText(newText, localRev);
      session.caret = insertAt + text.length;
      session.selection = SelectionOps.collapsed(session.caret);
      session.selections = SelectionSetOps.singular(session.caret);
      this.renderer.setSelection(session.selection);
      this.renderer.setSelections(session.selections);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      session.dirty = true;
      // Undo status fica indeterminado até o flush — mantém o anterior.
      // Acumula no lote e agenda flush
      this.pushBatch({ at: insertAt, text }, before);
      this.scheduleBatchFlush();
      this.renderer.start();
    } catch (error) {
      console.error("Scribe: falha ao inserir texto no documento", error);
    }
  }

  /**
   * Auto-pair (P2#5) com **N cursores**: a tecla entra em **todos** os cursores.
   *
   * - `close !== undefined` ⇒ é um **par** (ex.: `(` + `)`): o par entra em todos os cursores e
   *   cada cursor fica **entre** os delimitadores (`at + 1`);
   * - `close === undefined` ⇒ é uma tecla de **fechamento** (ex.: `)`): num cursor cujo próximo
   *   caractere já é a tecla, o cursor apenas **pula** (mesma regra do caminho de 1 cursor); nos
   *   demais, a tecla é inserida.
   */
  async insertKeyAtCursors(key: string, close: string | undefined): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    try {
      if (session.selections.length <= 1) {
        // 1 cursor: o caminho histórico (o teclado reposiciona o caret).
        await this.insertText(close === undefined ? key : key + close);
        return;
      }
      const { edits, skipped } = buildKeyEdits(
        session.selections,
        key,
        close,
        session.source.text,
      );
      // O par tem 2 caracteres ⇒ o cursor volta 1 (fica **entre** os delimitadores).
      this.applyCursorEdits(session, edits, skipped, close === undefined ? 0 : 1);
    } catch (error) {
      console.error("Scribe: falha ao inserir tecla em múltiplos cursores", error);
    }
  }

  /**
   * Backspace/Delete em **N cursores** (P2#5): apaga em todos os cursores — o range
   * selecionado, o caractere anterior/posterior ou o **par vazio** (como o caminho de 1
   * cursor) — e empurra **N entradas** no lote (ordem descendente).
   */
  async deleteAtCursors(direction: "backward" | "forward"): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    try {
      const edits = buildDeleteEdits(session.selections, session.source.text, direction);
      if (edits.length === 0) return;
      this.applyCursorEdits(session, edits, [], 0);
    } catch (error) {
      console.error("Scribe: falha ao apagar em múltiplos cursores", error);
    }
  }

  /**
   * Aplica um conjunto de edições multi-cursor: splice local (latência zero), avanço dos
   * cursores e **N entradas** no lote pendente (ordem descendente).
   *
   * O snapshot do lote (`pendingBatchSelections`) é o conjunto de cursores **antes** da 1ª
   * edição do lote — é o que o undo restaura.
   */
  private applyCursorEdits(
    session: TabSession,
    edits: readonly SelectionEdit[],
    skipped: readonly number[],
    cursorBack: number,
  ): void {
    if (edits.length === 0 && skipped.length === 0) return;
    const before = session.selections;
    if (edits.length > 0) {
      // Splice local (latência zero).
      const newText = applyEditsToText(session.source.text, edits);
      this.batchLocalRevision += 1;
      session.source.setText(newText, this.batchLocalRevision);
    }
    // Os cursores andam com o texto (regra única: `advanceSelections`, de `src/shared`).
    const advanced = advanceCursorSet(before, edits, cursorBack, skipped);
    session.selections = advanced;
    const primary = advanced[0];
    // O caret é o `active` da seleção **primária** — o resto continua um conjunto vivo.
    session.caret = primary !== undefined ? primary.active : session.caret;
    session.selection = primary ?? SelectionOps.collapsed(session.caret);
    this.renderer.setSelection(session.selection);
    this.renderer.setSelections(session.selections);
    this.viewport.setMetrics({ lineCount: session.source.lineCount() });
    updateCaretStatus(session.source, session.caret);
    if (edits.length > 0) {
      session.dirty = true;
      // N entradas no lote (ordem descendente) — um `Ctrl+Z` desfaz todas.
      for (const edit of edits) {
        this.pushBatch(
          { at: edit.at, text: edit.insert, remove: edit.remove },
          before,
        );
      }
      this.scheduleBatchFlush();
    }
    this.renderer.start();
  }

  /**
   * Empilha uma entrada no lote pendente.
   *
   * O **snapshot** do conjunto de cursores é guardado no **primeiro** push do lote: o undo de
   * um lote restaura o estado **antes da 1ª tecla** do lote (e não o de cada tecla) — é o que
   * o usuário espera ao dar `Ctrl+Z` num lote de teclas.
   */
  private pushBatch(
    entry: { readonly at: number; readonly text: string; readonly remove?: string },
    selections: SelectionSet,
  ): void {
    if (this.pendingBatch === null) {
      this.pendingBatch = [];
      this.pendingBatchSelections = selections;
    }
    this.pendingBatch.push(entry);
  }

  /** Agenda flush do lote no próximo rAF. */
  private scheduleBatchFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = requestAnimationFrame(() => {
      this.flushTimer = null;
      void this.flushBatch();
    });
  }

  /**
   * Envia o lote acumulado para o main e reconcilia. Chamado externamente antes de operações IPC.
   *
   * ⚠️ **Assíncrono**: quem precisa do texto do servidor (a reconciliação de uma edição
   * externa) **aguarda** esta promessa — inclusive quando o lote já foi recolhido por um
   * flush em voo (nesse caso a promessa é a do flush em voo).
   */
  async flushBatch(): Promise<void> {
    const batch = this.pendingBatch;
    const snapshot = this.pendingBatchSelections;
    if (batch === null || batch.length === 0) {
      // Nada pendente — mas pode haver um flush **em voo**: o texto do servidor só está
      // atualizado quando ele termina (a reconciliação depende disso).
      const inFlight = this.flushInFlight;
      if (inFlight !== null) await inFlight;
      return;
    }
    this.pendingBatch = null;
    this.pendingBatchSelections = null;
    this.batchLocalRevision = 0;
    const session = this.current;
    if (session === undefined) return;
    const promise = this.sendBatch(session, batch, snapshot);
    this.flushInFlight = promise;
    try {
      await promise;
    } finally {
      if (this.flushInFlight === promise) this.flushInFlight = null;
    }
  }

  /** Envia o lote ao servidor (o corpo do flush) e reconcilia o texto local. */
  private async sendBatch(
    session: TabSession,
    batch: ReadonlyArray<{ at: number; text: string; remove?: string }>,
    snapshot: SelectionSet | null,
  ): Promise<void> {
    try {
      // O snapshot vai junto: o core grava o "before" do lote e o undo devolve os N cursores.
      const result = await session.bridge.batchInsert(
        session.handle, batch, "user", snapshot ?? undefined,
      );
      // Reconcilia revisão real do servidor
      session.source.setText(result.text, result.revision);
      session.serverRevision = result.revision;
      setUndoStatus(result.canUndo, result.canRedo);
    } catch (error) {
      console.error("Scribe: falha ao enviar lote de inserções", error);
      // Fallback: lê o documento inteiro para recuperar consistência
      try {
        const text = await session.bridge.text(session.handle);
        session.source.setText(text, -1);
      } catch {
        // Silêncio — não há o que fazer sem a ponte
      }
    }
  }

  /**
   * Reconcilia uma edição **externa** (plugin/LSP/outro cliente) no documento.
   *
   * ⚠️ **Por que**: o renderer só recarregava o **texto** ⇒ o caret e as seleções ficavam
   * nos offsets **antigos** e a próxima digitação entrava no lugar errado (texto
   * corrompido: "2 cursores + insert externo + digitar" ⇒ "Zoo baZoo").
   *
   * A reconciliação é o **delta** entre o texto local e o texto do servidor, aplicado ao
   * caret e às seleções (a regra única de deslocamento, `advanceSelections`).
   */
  private async reconcileExternalChange(
    session: TabSession,
    revision: number,
  ): Promise<void> {
    // O texto local **antes** do flush: é a base do delta (com o lote já aplicado localmente).
    const localText = session.source.text;
    // ⚠️ O lote pendente usa offsets do **texto local**: se uma edição externa entra na
    // janela do rAF, a tecla cai no lugar errado. O lote sai **antes** da reconciliação —
    // e a reconciliação **aguarda** o flush (ele é assíncrono).
    await this.flushBatch();
    let next: string;
    try {
      next = await this.bridge.text(session.handle);
    } catch (error) {
      console.error("Scribe: falha ao reconciliar edição externa", error);
      return;
    }
    const delta = diffText(localText, next);
    if (delta.remove.length > 0 || delta.insert.length > 0) {
      // O caret e as seleções andam com o delta (a mesma regra de `advanceSelections`).
      const selections = applyDeltaToSelections(session.selections, delta);
      const primary = selections[0];
      session.selections = selections;
      session.selection = primary ?? SelectionOps.collapsed(session.caret);
      session.caret = primary !== undefined ? primary.active : session.caret;
    }
    session.source.setText(next, revision);
    session.serverRevision = revision;
    session.dirty = true;
    if (this.current?.handle === session.handle) {
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      this.renderer.setSelection(session.selection);
      this.renderer.setSelections(session.selections);
      updateCaretStatus(session.source, session.caret);
      setDirtyStatus(true);
      this.renderer.start();
      // Re-busca inlay hints após alteração do documento
      void fetchInlayHints(session, this.bridge, this.renderer, this.viewport);
    }
    this.renderTabBar();
  }

  /**
   * Substitui um range do documento: remove `remove` caracteres de `at` e insere `insert`.
   * Atualiza o caret, seleção, viewport e estado dirty — undo status vem no resultado rico.
   *
   * ⚠️ O conjunto de cursores **antes** da edição vai junto (`replaceOne(..., selections)`):
   * sem ele o core grava um cursor único e, ao desfazer, a **seleção não volta** (o caret
   * colapsava no início do trecho).
   */
  async replaceText(at: number, remove: number, insert: string): Promise<void> {
    // Flush antes de operação que vai direto ao main
    await this.flushBatch();
    const session = this.current;
    if (session === undefined) return;
    // O "before" do undo: o conjunto de cursores **antes** desta edição.
    const before = session.selections;
    try {
      const result = await session.bridge.replaceOne(
        session.handle,
        at,
        remove,
        insert,
        before,
      );
      session.source.setText(result.text, result.revision);
      session.serverRevision = result.revision;
      session.caret = at + insert.length;
      session.selection = SelectionOps.collapsed(session.caret);
      session.selections = SelectionSetOps.singular(session.caret);
      this.renderer.setSelection(session.selection);
      this.renderer.setSelections(session.selections);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      session.dirty = true;
      setUndoStatus(result.canUndo, result.canRedo);
      // Snippets (P4#18): rastreia a edição na sessão ativa e propaga espelhos/ancestrais
      // **antes** de agendar o frame (os offsets abaixo já valem no documento final).
      await this.propagateSnippetEdit(session, { start: at, end: at + remove }, insert);
      this.renderer.start();
    } catch (error) {
      console.error("Scribe: falha ao substituir texto no documento", error);
    }
  }

  /**
   * Snippets (P4#18): registra a edição aplicada em `replaceText` na sessão ativa e devolve os
   * espelhos/ancestrais re-renderizados.
   *
   * Cada atualização vira **1 roundtrip sequencial** de `replaceOne`; a ordem da lista é a ordem
   * de execução e cada `start/end` já é válido no documento no momento da sua aplicação (o
   * snapshot interno da sessão evolui na mesma sequência). `applyEdit` devolve `null` quando a
   * edição está fora da expansão / atravessa campos / atinge um espelho → a sessão encerra.
   * Falha da ponte durante a propagação também encerra (o snapshot divergiu do documento).
   */
  private async propagateSnippetEdit(
    session: TabSession,
    edit: SnippetEditRange,
    newText: string,
  ): Promise<void> {
    const active = session.snippetSession;
    if (active === undefined) return;
    const next = applyEdit(active, edit, newText);
    if (next === null) {
      session.snippetSession = undefined;
      hideSnippetChoice();
      return;
    }
    session.snippetSession = next;
    for (const update of next.updates) {
      try {
        const result = await session.bridge.replaceOne(
          session.handle,
          update.start,
          update.end - update.start,
          update.newText,
        );
        session.source.setText(result.text, result.revision);
        session.serverRevision = result.revision;
        const delta = update.newText.length - (update.end - update.start);
        if (update.start < session.caret) {
          // Espelho anterior ao caret desloca o caret (e a seleção colapsada) junto.
          session.caret += delta;
          session.selection = SelectionOps.collapsed(session.caret);
          session.selections = SelectionSetOps.singular(session.caret);
          this.renderer.setSelection(session.selection);
          this.renderer.setSelections(session.selections);
        }
        session.dirty = true;
        setUndoStatus(result.canUndo, result.canRedo);
      } catch (error) {
        console.error("Scribe: falha ao atualizar espelho de snippet — sessão encerrada", error);
        session.snippetSession = undefined;
        hideSnippetChoice();
        return;
      }
    }
    if (next.updates.length > 0) {
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
    }
  }

  /**
   * Snippets (P4#18): aplica a **opção escolhida** de uma tab stop com escolha
   * (`${1|a,b,c|}`).
   *
   * Sequência (a mesma de `propagateSnippetEdit`): **1º** a troca do texto da primária no
   * documento (`replaceOne`), **2º** os espelhos/ancestrais re-renderizados (`session.updates`,
   * na ordem da lista), **3º** a sessão nova (offsets já ajustados) e o caret/seleção na
   * opção escolhida. `chooseSnippetOption` devolve `null` quando a troca engoliria outro
   * campo — aí a sessão encerra.
   */
  async applySnippetChoice(
    session: TabSession,
    stopIndex: number,
    optionIndex: number,
  ): Promise<void> {
    const active = session.snippetSession;
    if (active === undefined) return;
    // A parada atual tem de ser **a** escolha do dropdown (o popup pode ter ficado velho).
    const choice = currentChoice(active);
    if (choice === null || choice.index !== stopIndex) return;
    const field = active.fields.find((f) => f.index === stopIndex && f.isPrimary);
    if (field === undefined || field.choices === undefined) return;
    const optionText = field.choices[optionIndex];
    if (optionText === undefined) return;
    const next = chooseSnippetOption(active, stopIndex, optionIndex);
    if (next === null) {
      // A troca seria inconsistente (engoliria outro campo) → sessão encerrada.
      endSnippetSession(session, this.renderer);
      hideSnippetChoice();
      return;
    }
    try {
      // 1) o texto da primária passa a ser a opção escolhida.
      const primary = await session.bridge.replaceOne(
        session.handle,
        field.start,
        field.end - field.start,
        optionText,
      );
      session.source.setText(primary.text, primary.revision);
      session.serverRevision = primary.revision;
      session.dirty = true;
      setUndoStatus(primary.canUndo, primary.canRedo);
      // 2) os espelhos/ancestrais re-renderizados, na ordem da lista.
      for (const update of next.updates) {
        const applied = await session.bridge.replaceOne(
          session.handle,
          update.start,
          update.end - update.start,
          update.newText,
        );
        session.source.setText(applied.text, applied.revision);
        session.serverRevision = applied.revision;
        session.dirty = true;
        setUndoStatus(applied.canUndo, applied.canRedo);
      }
    } catch (error) {
      console.error("Scribe: falha ao aplicar escolha de snippet — sessão encerrada", error);
      endSnippetSession(session, this.renderer);
      hideSnippetChoice();
      return;
    }
    // 3) a sessão nova (offsets já ajustados) + caret/seleção na opção escolhida.
    session.snippetSession = next;
    const chosen = next.fields.find((f) => f.index === stopIndex && f.isPrimary);
    const start = chosen?.start ?? field.start;
    const end = chosen?.end ?? start + optionText.length;
    session.caret = end;
    session.selection = { anchor: start, active: end };
    session.selections = [session.selection] as SelectionSet;
    this.renderer.setSelection(session.selection);
    this.renderer.setSelections(session.selections);
    this.viewport.setMetrics({ lineCount: session.source.lineCount() });
    updateCaretStatus(session.source, session.caret);
    this.renderer.start();
  }

  /**
   * Desfaz (ou refaz) a última ação do documento **ativo**.
   *
   * ⚠️ **Correção do vazamento de caret**: o `undoState` do core devolve o caret/seleção
   * **globais** (os do documento que estava ativo no core) — se esta aba **não** tem
   * histórico, o undo não age nela e o caret da **outra** aba vazava para cá (o cursor
   * "pula" para a posição do outro documento).
   *
   * Por isso o caret/seleção restaurados só são aplicados quando o undo **agiu de fato**
   * neste documento — o sinal é a **revisão**: o buffer muda quando o undo aplica os
   * deltas. Sem isso, o caret da sessão é preservado.
   */
  private async runHistory(action: "undo" | "redo"): Promise<void> {
    await this.flushBatch();
    const session = this.current;
    if (session === undefined) return;
    // Snippets (P4#18): undo/redo invalida a sessão — os offsets não sobrevivem ao rollback.
    session.snippetSession = undefined;
    hideSnippetChoice();
    try {
      // O estado **antes** do comando: a revisão do buffer é o sinal de "o undo agiu aqui?".
      const before = await session.bridge.undoState(session.handle);
      const state =
        action === "undo"
          ? await session.bridge.undo(session.handle)
          : await session.bridge.redo(session.handle);
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, state.revision);
      session.serverRevision = state.revision;
      // O undo só age no documento **se** o buffer mudou (a revisão subiu).
      const acted = state.revision !== before.revision;
      if (acted) {
        // O undo/redo devolve o **conjunto** de cursores (P2#5): restaura os N cursores
        // (clampados ao tamanho do texto) em vez de colapsar tudo para 1 cursor.
        const restored = clampSelections(state.selections, next.length);
        session.caret = clampOffset(state.caret, next.length);
        const primary =
          state.selection !== undefined
            ? {
                anchor: clampOffset(state.selection.anchor, next.length),
                active: clampOffset(state.selection.active, next.length),
              }
            : SelectionOps.collapsed(session.caret);
        session.selection = primary;
        session.selections = restored.length > 0 ? restored : [primary];
      }
      // Sem ação neste documento: o caret/seleção da sessão são **preservados** (o caret
      // global do core pertencia a outra aba).
      this.renderer.setSelection(session.selection);
      this.renderer.setSelections(session.selections);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      setUndoStatus(state.canUndo, state.canRedo);
      this.renderer.start();
    } catch (error) {
      console.error(`Scribe: falha ao ${action === "undo" ? "desfazer" : "refazer"}`, error);
    }
  }

  private async refreshUndoStatus(): Promise<void> {
    const session = this.current;
    if (session === undefined) {
      setUndoStatus(false, false);
      return;
    }
    try {
      const state = await session.bridge.undoState(session.handle);
      setUndoStatus(state.canUndo, state.canRedo);
    } catch {
      setUndoStatus(false, false);
    }
  }

  async save(): Promise<void> {
    await this.flushBatch();
    const session = this.current;
    if (session === undefined) return;
    try {
      await session.bridge.save(session.handle);
      session.dirty = false;
      setDirtyStatus(false);
      this.renderTabBar();
    } catch (error) {
      console.error("Scribe: falha ao salvar", error);
      setDocStatus(`erro ao salvar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---- demo (fallback sem documento) --------------------------------------------------------------

function demoText(): string {
  const lines = Array.from({ length: DEMO_LINE_COUNT }, (_, i) => {
    const n = String(i + 1).padStart(4, " ");
    if (i % 40 === 0) return `${n}  // ---- bloco ${i / 40 + 1} — Scribe (Canvas2D/WebGPU) ----`;
    if (i % 13 === 3) return `${n}  const linha = ${n}; // tela virtualizada: só o visível é desenhado`;
    return `${n}  linha de demonstração do pipeline de render (scroll: roda do mouse / setas)`;
  });
  return lines.join("\n");
}
// Referência explícita para manter a função como fallback disponível (não removida).
void demoText;

// ---- layout: largura útil, minimap e popups de contexto ----------------------------------------

/** Largura (px) da scrollbar vertical desenhada pelo renderer (mesma do `LineLayout.scrollbarWidth`). */
const SCROLLBAR_WIDTH_PX = 10;

/** Padding horizontal entre o gutter e o texto (mesma origem usada no desenho). */
const TEXT_PADDING_LEFT_PX = 8;

/** Padding vertical acima da primeira linha (mesma origem usada no desenho). */
const TEXT_PADDING_TOP_PX = 8;

/**
 * Largura padrão do minimap (px) — espelha `--s-minimap-w` do `index.css`.
 * Só entra como **fallback**: quando o DOM não expõe a largura (elemento ausente/sem layout).
 */
const MINIMAP_FALLBACK_WIDTH_PX = 72;

/** `true` enquanto o painel de depuração estiver aberto — ele disputa a faixa do minimap. */
let debugPanelOpen = false;

/**
 * Largura (px) da faixa do minimap **quando ele está visível**; `0` quando está oculto.
 *
 * Lê o valor real do DOM (o `--s-minimap-w` já resolvido pelo browser) — nada de número
 * mágico duplicado: se o CSS mudar, a largura útil do texto muda junto.
 */
function visibleMinimapWidth(): number {
  if (typeof document === "undefined") return 0;
  const mm = document.getElementById("minimap");
  if (mm === null || mm.hidden) return 0;
  if (typeof getComputedStyle === "function") {
    const parsed = Number.parseFloat(getComputedStyle(mm).width);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (mm.clientWidth > 0) return mm.clientWidth;
  return MINIMAP_FALLBACK_WIDTH_PX;
}

/**
 * Largura útil para o texto: `viewport − scrollbar − (gutter + padding) − minimap visível`.
 *
 * **Fonte única**: o soft-wrap (`renderOnce`) e a contagem de linhas visuais (`resize`)
 * passam por aqui — assim os dois nunca divergem (a rolagem acompanha o wrap).
 */
function usefulTextWidth(viewportWidth: number, gutterWidth: number): number {
  const used = SCROLLBAR_WIDTH_PX + gutterWidth + TEXT_PADDING_LEFT_PX + visibleMinimapWidth();
  return Math.max(0, viewportWidth - used);
}

/**
 * Aplica a visibilidade do minimap: ele some com a welcome screen **e** com o painel de
 * depuração — os dois ocupam a mesma faixa do canto direito.
 */
function applyMinimapVisibility(): void {
  if (typeof document === "undefined") return;
  const mm = document.getElementById("minimap");
  if (mm === null) return;
  const welcome = document.getElementById("welcome-screen");
  const welcomeVisible = welcome !== null && !welcome.hidden;
  mm.hidden = welcomeVisible || debugPanelOpen;
}

/** Alterna a exibição da tela de boas-vindas (welcome screen). */
function showWelcome(show: boolean): void {
  const el = document.getElementById("welcome-screen");
  if (el) el.hidden = !show;
  // O minimap divide a faixa com a welcome screen e com o painel de depuração.
  applyMinimapVisibility();
}

// ---- popups de contexto (mutuamente exclusivos) -------------------------------------------------

/**
 * Os popups de **contexto** do editor. São **mutuamente exclusivos**: só um pode ficar
 * visível por vez (completion, hover, signature help, references, document symbols).
 */
interface ContextPopups {
  readonly completion: CompletionPopupBinding;
  readonly hoverTooltip: HoverTooltipBinding;
  readonly signatureHelp: SignatureHelpBinding;
  readonly references: ReferencesPopupBinding;
  readonly documentSymbols: DocumentSymbolsBinding;
}

/**
 * Fecha (sem destruir) todos os popups de contexto e remove o popup de code actions.
 *
 * Idempotente: o `close`/`hide` de cada módulo já é no-op quando o popup não está aberto.
 * A command palette e a find bar são overlays de **aplicação** — não são tocados aqui.
 */
function closeContextPopups(popups: ContextPopups): void {
  popups.completion.close();
  popups.hoverTooltip.hide();
  popups.signatureHelp.close();
  popups.references.close();
  popups.documentSymbols.close();
  removeCodeActionsPopup();
}

/** `true` se algum popup de contexto (fora o hover) estiver visível. */
function hasOpenContextPopup(popups: ContextPopups): boolean {
  return (
    codeActionsPopup !== undefined ||
    popups.completion.isOpen ||
    popups.signatureHelp.isOpen ||
    popups.references.isOpen ||
    popups.documentSymbols.isOpen
  );
}

// ---- Quick Open (⌘P) e busca na workspace (grep) ---------------------------------------------

/**
 * O que o *Quick Open* sabe fazer com o item escolhido.
 *
 * O `payload` do `QuickOpenItem` é `unknown` (o módulo do popup é agnóstico): quem
 * **interpreta** é o renderer, e este tipo é a forma canônica de fazer isso sem `any`.
 */
type QuickOpenPayload =
  | { readonly kind: "command"; readonly id: string }
  | { readonly kind: "file"; readonly path: string }
  /**
   * O item **"criar arquivo"** (o `quick-open.ts` o offerte a cada tecla, quando a query
   * parece um caminho e não casa nenhum arquivo).
   *
   * - `path` — o caminho **absoluto** candidato (é o que o `main` cria);
   * - `relativePath` — o caminho **relativo** à raiz (é o que a UI mostra).
   */
  | { readonly kind: "create"; readonly path: string; readonly relativePath: string };

/** `true` quando o `payload` é um `QuickOpenPayload` válido. */
function isQuickOpenPayload(value: unknown): value is QuickOpenPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    kind?: unknown;
    id?: unknown;
    path?: unknown;
    relativePath?: unknown;
  };
  if (record.kind === "command") return typeof record.id === "string";
  if (record.kind === "file") return typeof record.path === "string";
  if (record.kind === "create") {
    // O "criar" precisa do caminho **absoluto** (o que o `main` cria) e do relativo (a UI).
    return typeof record.path === "string" && typeof record.relativePath === "string";
  }
  return false;
}

/** Último segmento de um caminho (o renderer não tem `node:path`). */
function baseNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * Um documento aberto (o mínimo que o *Quick Open* precisa).
 *
 * É um **vista estrutural** da sessão (`TabSession`): o *Quick Open* só usa o handle, o
 * rótulo e o caminho.
 */
export interface OpenDocumentInfo {
  readonly handle: number;
  readonly label: string;
  readonly path: string;
}

/**
 * Diretórios dos documentos abertos — as **raízes candidatas** da workspace.
 *
 * O `main` expande cada uma até a raiz da workspace (a pasta com `.git`); sem documento
 * aberto, ele usa a raiz do processo.
 */
function workspaceRootsOf(sessions: readonly OpenDocumentInfo[]): readonly string[] {
  const roots = new Set<string>();
  for (const session of sessions) {
    const path = session.path;
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    roots.add(cut > 0 ? path.slice(0, cut) : path);
  }
  return [...roots];
}

// ---- workbench de seções (a barra lateral no estilo VS Code) ---------------------------------

/**
 * As **seções** da barra lateral.
 *
 * A barra lateral deixou de ser "a lista de documentos abertos" e virou um *workbench*:
 * cada botão da rail abre a sua seção, e **uma** seção fica visível por vez.
 *
 * - `explorer` — a árvore de arquivos da workspace (+ a lista de "Abertos");
 * - `outline` — a estrutura (símbolos) do documento ativo;
 * - `problems` / `source-control` / `diff` — seções da **próxima** rodada (o host já
 *   existe no markup; a seção nasce vazia);
 * - `search` — o painel de busca na workspace (o "grep"), que também é uma seção.
 */
export type SidebarSection =
  | "explorer"
  | "outline"
  | "problems"
  | "source-control"
  | "diff"
  | "search";

/** O host DOM de cada seção (o renderer mostra **um** por vez). */
const SIDEBAR_SECTION_HOSTS: Readonly<Record<SidebarSection, string>> = {
  explorer: "explorer-tree-host",
  outline: "outline-view",
  problems: "problems-panel-host",
  "source-control": "source-control-host",
  diff: "diff-view-host",
  search: "search-panel-host",
};

/**
 * O botão da rail de cada seção.
 *
 * `diff` ainda **não** tem botão (a seção entra na próxima rodada) — por isso o mapa é
 * parcial: uma seção sem botão simplesmente não é marcada na rail.
 */
const SIDEBAR_SECTION_BUTTONS: Readonly<Partial<Record<SidebarSection, string>>> = {
  explorer: "activity-explorer",
  outline: "activity-outline",
  problems: "activity-problems",
  "source-control": "activity-source-control",
};

/** O rótulo acessível da sidebar por seção (o `aria-label` do `<aside>`). */
const SIDEBAR_SECTION_LABELS: Readonly<Record<SidebarSection, string>> = {
  explorer: "Explorador",
  outline: "Estrutura do documento",
  problems: "Problemas",
  "source-control": "Controle de código-fonte",
  diff: "Comparação",
  search: "Buscar em todos os arquivos",
};

/**
 * As **fontes** dos itens do *Quick Open* (o que a ponte oferece).
 *
 * É uma vista mínima da ponte (e não a ponte inteira) para que a montagem dos itens seja
 * testável sem Electron.
 */
export interface QuickOpenSources {
  /** Lista os comandos (a paleta e o *Quick Open* compartilham a mesma lista). */
  readonly listCommands: () => Promise<CommandListResult>;
  /**
   * Índice de arquivos da workspace — **opcional**: um preload mais antigo não expõe o
   * método ⇒ a lista tem só comandos e recentes (degradação, sem crash).
   */
  readonly workspaceFiles?: (roots: readonly string[]) => Promise<WorkspaceFilesResult>;
}

/**
 * Monta os itens do *Quick Open*: **recentes** (primeiro), **comandos** e **arquivos**.
 *
 * - Sem `workspaceFiles` (preload antigo) ⇒ a lista tem só comandos e recentes;
 * - Sem fontes ⇒ a lista é vazia (o popup ainda abre — degradação explícita).
 */
export async function collectQuickOpenItems(
  sources: QuickOpenSources | undefined,
  sessions: readonly OpenDocumentInfo[],
): Promise<readonly QuickOpenItem[]> {
  const items: QuickOpenItem[] = [];

  // Recentes: as abas abertas, da mais recente para a mais antiga.
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const session = sessions[i]!;
    const payload: QuickOpenPayload = { kind: "file", path: session.path };
    items.push({
      id: `recent:${session.handle}`,
      label: session.label,
      description: session.path,
      kind: "recent",
      payload,
    });
  }

  // Comandos (a mesma lista da paleta).
  if (sources !== undefined) {
    try {
      const result = await sources.listCommands();
      for (const command of result.commands) {
        const payload: QuickOpenPayload = { kind: "command", id: command.id };
        items.push({
          id: `command:${command.id}`,
          label: command.label,
          ...(command.category !== undefined ? { description: command.category } : {}),
          kind: "command",
          payload,
        });
      }
    } catch (error: unknown) {
      console.warn("Scribe: falha ao listar comandos para o Quick Open", error);
    }
  }

  // Arquivos da workspace (o preload antigo não expõe ⇒ só comandos e recentes).
  if (sources?.workspaceFiles !== undefined) {
    try {
      const result = await sources.workspaceFiles(workspaceRootsOf(sessions));
      for (const file of result.files) {
        const payload: QuickOpenPayload = { kind: "file", path: file.absolutePath };
        items.push({
          id: `file:${file.absolutePath}`,
          label: baseNameOf(file.path),
          description: file.path,
          kind: "file",
          payload,
        });
      }
      if (result.truncated) {
        console.warn("Scribe: índice da workspace truncado", result.warnings);
      }
    } catch (error: unknown) {
      console.warn("Scribe: falha ao indexar a workspace", error);
    }
  }

  return items;
}

/** Controle do painel de busca na workspace (o "grep"). */
export interface WorkspaceSearchController {
  /** Abre o painel (o foco vai para o campo de busca). */
  open(): void;
  /** Fecha o painel (o foco volta ao editor). */
  close(): void;
  /** `true` enquanto o painel está aberto. */
  isOpen(): boolean;
}

/** Dependências do painel de busca na workspace. */
interface WorkspaceSearchDeps {
  readonly bridge: ScribeBridge | undefined;
  /**
   * As **raízes** da workspace (as pastas dos documentos abertos).
   *
   * Sem elas, o `main` usa a raiz do processo (`cwd`) — por isso o painel passa as
   * raízes do documento ativo: a busca é sobre a **workspace** do usuário.
   */
  readonly roots?: () => readonly string[];
  /** Abre um arquivo na posição (o clique numa ocorrência). */
  readonly onOpen: (path: string, line: number, column: number) => void;
  /** Devolve o foco ao canvas do editor. */
  readonly focusEditor: () => void;
  /**
   * Chamado quando o painel **abre** (o workbench de seções abre a seção do grep).
   *
   * O painel é uma **seção** da barra lateral: quem manda na visibilidade dos outros
   * hosts é o workbench — por isso o gancho.
   */
  readonly onSectionOpen?: (() => void) | undefined;
  /**
   * Chamado quando o painel **fecha** (o workbench restaura a seção anterior).
   */
  readonly onSectionClose?: (() => void) | undefined;
}

/** Debounce da busca (300ms): a digitação não dispara uma varredura por tecla. */
export const WORKSPACE_SEARCH_DEBOUNCE_MS = 300;

/** Resultado vazio (o painel reflecting "nada encontrado"). */
const EMPTY_GREP_RESULT: GrepResult = { matches: [], truncated: false, filesScanned: 0 };

/** As dependências da sincronização do documento aberto no **boot**. */
export interface BootDocumentSyncDeps<T> {
  /** A sessão do documento do boot (`undefined` = nenhum documento aberto no boot). */
  readonly session: T | undefined;
  /**
   * O handler do **documento ativo** (o mesmo dos demais documentos).
   *
   * É ele que busca os símbolos (o Outline + o sticky scroll) e re-resolve o Problems.
   */
  readonly onActiveDocumentChanged: ((session: T) => void) | undefined;
  /**
   * Os diagnósticos de um documento (a **busca** — o `push` pode ter-se perdido).
   *
   * `undefined` = a ponte não expõe a busca (preload antigo) ⇒ só o handler roda.
   */
  readonly diagnostics: ((handle: number) => Promise<readonly LspDiagnostic[]>) | undefined;
  /** Publica os diagnósticos buscados (o mapa handle → diagnósticos do Problems). */
  readonly onDiagnostics: (handle: number, diagnostics: readonly LspDiagnostic[]) => void;
  /** A falha da busca (o console — a UI não quebra). */
  readonly onError?: (error: unknown) => void;
}

/**
 * Sincroniza o documento aberto no **BOOT** (o `?file=`).
 *
 * ⚠️ O `open` inicial roda **antes** do `onActiveDocumentChanged` existir ⇒ o handler
 * **nunca** foi chamado para aquele documento ⇒ o Outline dizia "Nenhum símbolo neste
 * documento" e o Problems ficava vazio (o `lsp.diagnostics` é *push* e pode ter chegado
 * **antes** do listener ⇒ o documento do boot ficava sem diagnósticos).
 *
 * O documento do boot recebe o **mesmo tratamento** dos demais:
 * - o handler é chamado (ele busca os símbolos — o `documentSymbols` é caro, mas o cache
 *   do documento do boot está **vazio** ⇒ uma busca só, sem duplicata);
 * - os diagnósticos são **buscados** (o `push` pode ter-se perdido) e publicados.
 */
export function syncBootDocument<T extends { readonly handle: number }>(
  deps: BootDocumentSyncDeps<T>,
): void {
  const session = deps.session;
  if (session === undefined) return;
  // (1) O mesmo tratamento dos demais documentos (Outline, sticky, debug, explorer).
  deps.onActiveDocumentChanged?.(session);
  // (2) Os diagnósticos do documento do boot (o *push* pode ter-se perdido).
  if (deps.diagnostics === undefined) return;
  void deps.diagnostics(session.handle).then(
    (diagnostics) => deps.onDiagnostics(session.handle, diagnostics),
    (error: unknown) => deps.onError?.(error),
  );
}

/**
 * Cria o painel de busca na workspace (o "grep" do VS Code).
 *
 * O painel é **autocontido** (`./search-panel.ts`): aqui ficam só a política (debounce,
 * cancelamento, visibilidade) e a tradução das intenções em IPC.
 */
export function createWorkspaceSearchController(
  deps: WorkspaceSearchDeps,
): WorkspaceSearchController {
  const hostElement = document.getElementById("search-panel-host");
  if (hostElement === null) {
    console.info("Scribe: busca na workspace desligada (markup ausente)");
    return { open: (): void => {}, close: (): void => {}, isOpen: (): boolean => false };
  }
  // `const` não-nulo: o TS não estreita o tipo dentro dos *closures* (o painel usa o host
  // em várias callbacks).
  const host: HTMLElement = hostElement;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let signalId: number | undefined;
  let open = false;
  let editorsHiddenBefore = false;
  /**
   * As **flags** da busca (regex / case) — o painel as publica em `onOptionsChange`.
   *
   * O default é o do `grep` do core: literal e sem case (`DEFAULT_SEARCH_PANEL_FLAGS`).
   */
  let flags: SearchPanelFlags = { ...DEFAULT_SEARCH_PANEL_FLAGS };
  /** A **query atual** (o painel não a expõe: ela vive no input dele). */
  let currentQuery = "";

  /** Escreve a mensagem do painel (o status é do módulo do painel — aqui é degradação). */
  const setPanelMessage = (text: string): void => {
    const status = host.querySelector(".search-panel-status");
    if (status !== null) status.textContent = text;
  };

  /**
   * Mostra os **avisos** da busca (o que foi desligado — **nunca** um crash).
   *
   * ⚠️ O painel do search (`./search-panel.ts`) é **autocontido** e não tem área de avisos
   * ⇒ os avisos entram na **linha de status** do painel (a que o painel escreve) — sem
   * avisos, o status fica **exatamente** como o painel deixou.
   *
   * A linha de status é reescrita pelo painel a cada render (busca → contagem) ⇒ os avisos
   * são **sempre** repostos depois do `setResults` (nunca se acumulam).
   */
  const showSearchWarnings = (warnings: readonly string[] | undefined): void => {
    if (warnings === undefined || warnings.length === 0) return;
    const status = host.querySelector(".search-panel-status");
    if (status === null) return;
    const head = status.textContent ?? "";
    const text = warnings.join(" · ");
    status.textContent = head.length === 0 ? text : `${head} · ${text}`;
  };

  /** Cancela a busca em voo (o `signalId` é o do cancelamento dedicado do IPC). */
  const cancelRunning = (): void => {
    if (signalId !== undefined) deps.bridge?.cancel(signalId);
    signalId = undefined;
  };

  const runSearch = (query: string): void => {
    const bridge = deps.bridge;
    if (bridge?.searchFiles === undefined) {
      // Ponte antiga: a busca em arquivos não existe — degradação **explícita**.
      setPanelMessage("Busca em todos os arquivos indisponível");
      return;
    }
    cancelRunning();
    const next = bridge.nextSignalId();
    signalId = next;
    panel?.setBusy(true);
    // As raízes da workspace (as pastas dos documentos abertos) — a busca é sobre a
    // workspace do usuário, não sobre a raiz do processo.
    const roots = deps.roots?.() ?? [];
    // ⚠️ As **flags** (regex / case / binários) vão **com a query**: o `grep` do core aceita
    // as três (`regex` ⇒ o padrão é uma expressão regular; `caseSensitive` ⇒ o padrão
    // distingue maiúsculas; `includeBinary` ⇒ os arquivos binários **entram** na varredura
    // — sem isto, o toggle de binários do painel **não fazia nada**).
    void bridge
      .searchFiles(
        query,
        {
          roots,
          regex: flags.regex,
          caseSensitive: flags.caseSensitive,
          includeBinary: flags.includeBinary,
        },
        next,
      )
      .then(
        (result) => {
          if (signalId !== next) return; // resposta obsoleta (a busca foi cancelada)
          signalId = undefined;
          panel?.setBusy(false);
          panel?.setResults(result);
          // Os **avisos** da busca (o que foi desligado — nunca um crash) — depois do
          // `setResults` (que reescreve a linha de status do painel).
          showSearchWarnings(result.warnings);
        },
        (error: unknown) => {
          if (signalId !== next) return;
          signalId = undefined;
          panel?.setBusy(false);
          panel?.setResults(EMPTY_GREP_RESULT);
          // ⚠️ **A falha chega à UI**: o `setResults` reescreve a linha de status do painel
          // ("Nenhum resultado") e a mensagem real ficava **só no console** ⇒ o usuário
          // não sabia por que a busca parou (ex.: o padrão regex catastrófico, que o
          // `main` recusa). A mensagem vai para a status do painel (1 linha, sem stack).
          setPanelMessage(describeSearchFailure(error));
          console.warn("Scribe: falha na busca em todos os arquivos", error);
        },
      );
  };

  const scheduleSearch = (query: string): void => {
    clearTimeout(timer);
    timer = undefined;
    if (query.trim().length === 0) {
      cancelRunning();
      panel?.setBusy(false);
      panel?.setResults(EMPTY_GREP_RESULT);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      runSearch(query);
    }, WORKSPACE_SEARCH_DEBOUNCE_MS);
  };

  function closePanel(): void {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    timer = undefined;
    cancelRunning();
    host.hidden = true;
    const list = document.getElementById("sidebar-editors");
    const header = document.getElementById("sidebar-section-toggle");
    if (list !== null) list.hidden = editorsHiddenBefore;
    if (header !== null) header.hidden = false;
    // O workbench de seções restaura a seção que estava aberta antes do grep.
    deps.onSectionClose?.();
    deps.focusEditor();
  }

  function openPanel(): void {
    if (open) {
      const input = host.querySelector(".search-panel-input");
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    open = true;
    // O grep é uma **seção** da sidebar: as outras saem de cena (o workbench manda).
    // ⚠️ O gancho vem **antes** de capturar `editorsHiddenBefore` — a lista de "Abertos"
    // é do *explorer* e o grep não pode sequestrar o estado dela.
    deps.onSectionOpen?.();
    // O painel ocupa a sidebar inteira ⇒ a lista de "Abertos" sai de cena.
    const list = document.getElementById("sidebar-editors");
    const header = document.getElementById("sidebar-section-toggle");
    editorsHiddenBefore = list?.hidden ?? false;
    if (list !== null) list.hidden = true;
    if (header !== null) header.hidden = true;
    host.hidden = false;
    if (deps.bridge?.searchFiles === undefined) {
      setPanelMessage("Busca em todos os arquivos indisponível");
    }
    const input = host.querySelector(".search-panel-input");
    if (input instanceof HTMLInputElement) input.focus();
  }

  const panel: SearchPanelBinding = attachSearchPanel(host, {
    onOpen: (path, line, column) => deps.onOpen(path, line, column),
    onQueryChange: (query) => {
      currentQuery = query;
      scheduleSearch(query);
    },
    /**
     * Um **toggle** (regex / case) mudou ⇒ a busca é **re-disparada** com a query atual.
     *
     * O debounce e o cancelamento são os mesmos da digitação (`scheduleSearch`): a busca
     * em voo é cancelada e a nova espera o debounce (o `grep` varre a workspace — um
     * toggle não pode disparar uma varredura por clique sem controle).
     */
    onOptionsChange: (next) => {
      flags = next;
      if (currentQuery.trim().length === 0) return;
      scheduleSearch(currentQuery);
    },
    onClose: () => closePanel(),
  });

  return {
    open: openPanel,
    close: closePanel,
    isOpen: (): boolean => open,
  };
}

// ---- app ------------------------------------------------------------------------------------------

/**
 * `true` se a linha está **colapsada** (dobra) — logo, ela **não é desenhada** (0 rows).
 *
 * ⚠️ É a forma **canônica** de perguntar ("o índice que sabe de folding responde"):
 * `isCollapsed` é **opcional** na interface do índice (`VisualRowIndexLike`) ⇒ um índice
 * que não sabe de folding devolve `false` (a degradação: o comportamento antigo).
 */
export function isCollapsedLine(
  index: VisualRowIndexLike | undefined,
  line: number,
): boolean {
  return index?.isCollapsed?.(line) ?? false;
}

/**
 * A linha que **ancora** a posição de `line`: a própria linha, ou — se ela está
 * **colapsada** (dobra) — a **primeira linha visível** do bloco (o cabeçalho da dobra, a
 * que mostra o `▸`).
 *
 * ⚠️ **Por que**: `rowOfLine(linhaColapsada)` devolve a row que a linha **ocuparia** (a da
 * **próxima** linha visível) ⇒ um popup ancorado nela cairia **embaixo** do bloco, longe
 * da dobra. A âncora tem de ser a linha **desenhada** do bloco.
 *
 * Sem índice (ou sem `isCollapsed`), a própria linha (a degradação: o comportamento
 * antigo).
 */
export function anchorLineOf(index: VisualRowIndexLike | undefined, line: number): number {
  if (index === undefined || index.isCollapsed === undefined) return line;
  let anchor = line;
  // Sobe até a primeira linha **visível** (a colapsada não é desenhada).
  while (anchor > 0 && index.isCollapsed(anchor)) anchor -= 1;
  return anchor;
}

class ScribeRenderer {
  private source: LineSource;
  private readonly style = TEXT_STYLE;
  private readonly dpr: number;
  private viewportWidth = 1;
  /** Altura lógica da viewport (px), atualizada no resize. */
  viewportHeight = 1;
  private rafHandle = 0;
  private running = false;
  private highlighter: SceneHighlight | undefined;
  private requestHighlight: ((first: number, count: number) => void) | undefined;
  private searchHighlightValue: SearchHighlight | undefined;
  private currentSelection: Selection | undefined;
  private currentSelections: SelectionSet | undefined; // P2#5
  /** Minimap binding ativo (opcional). */
  private minimapBinding: MinimapBinding | undefined;
  /** Dados do minimap: matches de busca para marcadores. */
  minimapSearchMatches: readonly SearchMatch[] | undefined = undefined;
  /** Índice do match atual no array de busca para o minimap. */
  minimapSearchCurrentIndex: number | undefined = undefined;
  /** Dados do minimap: diagnósticos para marcadores (linha + severidade). */
  minimapDiagnostics: readonly { line: number; severity: string }[] | undefined = undefined;
  /** Diagnósticos LSP por handle do documento. */
  private diagnosticsByHandle: Map<number, readonly LspDiagnostic[]> = new Map();
  /** Handle do documento ativo para desenhar diagnósticos. */
  private activeHandle: number | undefined;
  /** Folding ranges ativos para o documento corrente. */
  private currentFolding: readonly FoldRange[] | undefined;
  /** Inlay hints ativos para o documento corrente. */
  private currentInlayHints: readonly RenderInlayHint[] | undefined;
  /** Git diffs ativos para o documento corrente. */
  private gitDiffs: readonly GitDiffRange[] = [];
  /** Linhas (1-based) com breakpoint do documento ativo. */
  private breakpointLines: readonly number[] = [];
  /**
   * Símbolos do LSP (intervalos de linhas) do documento ativo — o **cache** do sticky scroll.
   *
   * É cacheado porque `lsp.documentSymbols` é uma chamada assíncrona: consultá-la a cada
   * frame inundaria o servidor LSP. O `main.ts` busca uma vez por documento.
   */
  private stickySymbolsValue: readonly StickySymbol[] = [];
  /** Handle do documento cujos símbolos estão no cache (`undefined` = nenhum). */
  private stickySymbolsHandle: number | undefined;
  /**
   * `true` quando o layout mudou (minimap/painel) e o wrap precisa ser recalculado.
   *
   * ⚠️ Não reintroduza um gancho **por frame** aqui: um callback chamado no laço de
   * render que marcasse o layout como sujo realimenta o próprio frame (loop de layout)
   * e trava o renderer. As mudanças de layout chegam por **evento**.
   */
  private layoutDirty = false;
  /**
   * Índice de **rows visuais** (soft wrap) do documento ativo.
   *
   * `undefined` = o índice ainda não foi construído (o 1º frame o cria). O índice é a
   * **fonte única** do total de rows (o `wrapLine` do core) e o **mapper** do viewport
   * (a rolagem é contada em rows visuais **nos dois modos** — com wrap, N rows por
   * linha; sem wrap, 1 row por linha, exceto as colapsadas, que ocupam 0).
   *
   * O cálculo caractere a caractere divergia do índice e desalinhavo a rolagem do texto
   * desenhado.
   */
  private visualRows: VisualRowIndex | undefined;
  /** Largura de wrap (px) com que o índice atual foi construído. */
  private visualRowsWidth = 0;
  /** Fonte com que o índice atual foi construído (trocar de documento ⇒ recria). */
  private visualRowsSource: LineSource | undefined;
  /** Versão do conteúdo com que o índice foi construído (edição ⇒ invalida). */
  private visualRowsVersion: number | undefined;
  /** Nº de linhas com que o índice foi construído (rede de segurança p/ fonte sem versão). */
  private visualRowsLineCount = 0;
  /** Total de rows já publicado no viewport (evita `setMetrics` por frame). */
  private publishedVisualRowCount = -1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly atlas: GlyphAtlas,
    private readonly pipeline: RenderPipeline,
    private readonly viewport: ViewportImpl,
    source: LineSource,
  ) {
    this.source = source;
    this.dpr = window.devicePixelRatio || 1;
  }

  /** Liga o destaque de sintaxe (spans por linha) e o gatilho para buscá-lo quando faltar. */
  setHighlighter(highlighter: SceneHighlight, request: (first: number, count: number) => void): void {
    this.highlighter = highlighter;
    this.requestHighlight = request;
  }

  /** Define as ocorrências de busca a destacar no canvas (P3.11). */
  setSearchMatches(highlight: SearchHighlight | undefined): void {
    this.searchHighlightValue = highlight;
  }

  /** Define os folding ranges para o documento ativo. */
  setFolding(folding: readonly FoldRange[]): void {
    this.currentFolding = folding;
  }

  /**
   * Aplica o **folding** (dobrar/desdobrar) e **reancora o scroll**.
   *
   * ⚠️ **Ordem**: o folding entra no índice **antes** de a contagem de rows ser publicada
   * (a regra única: a linha colapsada ocupa **0 rows**) e o scroll é corrigido pela
   * diferença de rows da **linha-âncora** (a 1ª linha visível) — o texto **não pode
   * saltar** ao dobrar.
   *
   * Sem isto, dobrar um bloco acima da viewport empurra o texto para cima (ou para baixo)
   * e o usuário perde o lugar.
   */
  applyFolding(folding: readonly FoldRange[]): void {
    // A âncora: a 1ª linha **visível** (a do topo da viewport) — é o que o usuário está
    // olhando. A row dela é a **mesma** unidade da rolagem (row visual).
    const anchor = this.firstVisibleLine();
    const rowBefore = this.visualRows?.rowOfLine(anchor) ?? anchor;
    this.currentFolding = folding;
    // O índice tem de conhecer a dobra **antes** de contar as rows.
    applyCollapsedLines(this.visualRows, folding);
    const rowAfter = this.visualRows?.rowOfLine(anchor) ?? anchor;
    const delta = rowAfter - rowBefore;
    // ⚠️ A rolagem é contada em **rows visuais** nos **dois** modos (o mapper está
    // sempre instalado) ⇒ a row da âncora e a unidade do scroll são a **mesma** ⇒ a
    // correção vale sempre (sem ela, dobrar um bloco acima empurra o texto).
    if (delta !== 0) this.viewport.scrollByRows(delta);
  }

  /** Define os inlay hints para o documento ativo. */
  setInlayHints(hints: readonly RenderInlayHint[]): void {
    this.currentInlayHints = hints;
  }

  /** Define os git diffs para o documento ativo. */
  setGitDiffs(diffs: readonly GitDiffRange[]): void {
    this.gitDiffs = diffs;
  }

  /** Define as linhas com breakpoint do documento ativo (bolinha no gutter). */
  setBreakpointLines(lines: readonly number[]): void {
    this.breakpointLines = lines;
  }

  /**
   * Define os **símbolos do LSP** (intervalos de linhas) usados pelo *sticky scroll*.
   *
   * O cache é do **renderer** (por handle): o `documentSymbols` do LSP é uma chamada
   * assíncrona e cara — chamá-la a cada frame inundaria o servidor. O `main.ts` busca uma
   * vez por documento (e rebusca quando o texto muda) e entrega o resultado aqui.
   *
   * Uma lista **vazia** significa "sem símbolos" ⇒ o sticky usa o *fallback* por indentação
   * (é o que o `computeStickyContext` faz quando não há símbolos).
   */
  setStickySymbols(handle: number | undefined, symbols: readonly StickySymbol[]): void {
    this.stickySymbolsHandle = handle;
    this.stickySymbolsValue = symbols;
  }

  /**
   * Contexto de *sticky scroll* do documento ativo (a "envelope" que envolve o caret).
   *
   * `undefined` = sem contexto (1ª linha do arquivo, ou o cabeçalho do próprio bloco).
   */
  private computeStickyContext(caretLine: number): StickyContext | undefined {
    // Os symbols são do **documento ativo**: se o handle não bater, o cache é velho (o
    // `main.ts` troca os symbols quando o documento muda) ⇒ sem symbols (fallback por
    // indentação) até a troca chegar.
    const symbols =
      this.stickySymbolsHandle === this.activeHandle ? this.stickySymbolsValue : [];
    return computeStickyContext({
      caretLine,
      firstVisibleLine: this.firstVisibleLine(),
      lineAt: (line: number): string => this.source.line(line),
      symbols,
    });
  }

  /** Largura atual do gutter em px. */
  getGutterWidth(): number {
    return this.gutterWidthFor(this.source.lineCount());
  }

  /**
   * Largura do gutter (px) para um dado número de linhas.
   *
   * **Fonte única**: o gutter, a largura útil do wrap e a rolagem têm de usar o **mesmo**
   * número — se divergirem, o wrap e a rolagem saem de contas diferentes.
   */
  private gutterWidthFor(lineCount: number): number {
    const gutterDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, lineCount))) + 1);
    return gutterDigits * 9 + 16;
  }

  /**
   * Mede a largura de um texto (px) com o atlas de glifos.
   *
   * É a **mesma** medição do soft wrap do core (`wrapLine`) e a que o `buildInstances`
   * recebe — o índice de rows e o texto desenhado precisam concordar no pixel.
   */
  private readonly measureText = (text: string): number => {
    let w = 0;
    for (let i = 0; i < text.length; i++) w += this.atlas.resolveGlyph(text[i] ?? " ", this.style).advance;
    return w;
  };

  /** Atualiza a seleção ativa para pintura no próximo frame. */
  setSelection(selection: Selection | undefined): void {
    this.currentSelection = selection;
  }

  /** Define as múltiplas seleções (P2#5). */
  setSelections(sels: SelectionSet | undefined): void {
    this.currentSelections = sels;
    if (sels !== undefined && sels.length > 0) {
      this.currentSelection = sels[0];
    }
  }

  attachSource(source: LineSource): void {
    this.source = source;
    // Trocar de documento invalida o índice de rows: as rows do texto anterior não valem
    // para o novo (e o mapper apontaria para um índice obsoleto).
    this.visualRows = undefined;
    this.visualRowsSource = undefined;
    this.visualRowsWidth = 0;
    this.visualRowsVersion = undefined;
    this.visualRowsLineCount = 0;
    this.publishedVisualRowCount = -1;
    this.viewport.setMetrics({ lineCount: source.lineCount() });
    this.viewport.scrollTo(0);
  }

  /**
   * Marca o layout como sujo: a faixa do minimap mudou (painel de depuração abriu/fechou)
   * e a largura útil do texto precisa ser recalculada no próximo frame.
   */
  markLayoutDirty(): void {
    this.layoutDirty = true;
  }

  /**
   * Garante que o índice de **rows visuais** está em dia com o documento e com a largura de
   * wrap. Devolve o **total de rows visuais** do documento.
   *
   * Regras:
   * - **Sem wrap** (`wrapWidth <= 0`): o índice é o de "1 row por linha lógica" — a
   *   rolagem continua 1:1 com as linhas, **exceto** pelas linhas colapsadas (a dobra
   *   tira rows: linha colapsada = 0 rows). O viewport conta a rolagem em **rows
   *   visuais** nos **dois** modos (a mesma unidade da cena);
   * - **Com wrap**: o índice é reconstruído quando a **fonte** ou a **largura de wrap**
   *   mudam; uma **edição** apenas o invalida (a partir da primeira linha alterada) — o
   *   índice é incremental, o recálculo é sob demanda.
   *
   * ⚠️ **Ordem (o bug de ordem)**: o **folding** é aplicado ao índice **antes** de ler
   * `rowCount` — a contagem publicada tem de refletir a dobra (a linha colapsada ocupa
   * **0 rows**). Publicar antes deixa a contagem com N−1 rows a mais (a barra de
   * rolagem fica longa demais e o texto "salta").
   */
  private ensureVisualRows(wrapWidth: number): number {
    const lineCount = this.source.lineCount();
    const version = isVersionedLineSource(this.source) ? this.source.contentVersion : undefined;
    const index = this.visualRows;
    // Uma fonte **sem versão** (o seam de desenvolvimento) não avisa quando o texto muda:
    // aí o índice só é reconstruído quando o nº de linhas muda.
    const staleCount = version === undefined && this.visualRowsLineCount !== lineCount;
    if (
      index === undefined ||
      this.visualRowsSource !== this.source ||
      this.visualRowsWidth !== wrapWidth ||
      staleCount
    ) {
      const created = new VisualRowIndex(this.source, wrapWidth, this.measureText);
      this.visualRows = created;
      this.visualRowsSource = this.source;
      this.visualRowsWidth = wrapWidth;
      this.visualRowsVersion = version;
      this.visualRowsLineCount = lineCount;
      // O mapper é instalado **nos dois modos** (com e sem soft wrap): a rolagem é
      // contada em **rows visuais** — a mesma unidade nos dois modos e a mesma que a
      // cena desenha.
      //
      // ⚠️ **Sem wrap, o mapper também é necessário**: o índice dá 1 row por linha
      // lógica, mas uma linha **colapsada** (folding) ocupa **0 rows** (a regra única).
      // Sem o mapper, a viewport rolava em **linhas lógicas** enquanto a contagem
      // publicada (e a cena) eram em **rows** ⇒ (a) o teto de rolagem encolhia (as
      // últimas linhas ficavam inalcançáveis) e (b) o texto deslizava N rows.
      this.viewport.setVisualRowMapper(created);
      // ⚠️ **Ordem**: o folding entra no índice **antes** de ler `rowCount`.
      applyCollapsedLines(created, this.currentFolding);
      return created.rowCount;
    }
    if (version !== undefined && version !== this.visualRowsVersion) {
      // O texto mudou: invalida a partir da primeira linha alterada (as rows anteriores
      // continuam válidas — o índice recalcula o resto sob demanda).
      const changed = isVersionedLineSource(this.source) ? this.source.firstChangedLine : undefined;
      index.invalidate(changed ?? 0);
      this.visualRowsVersion = version;
      this.visualRowsLineCount = lineCount;
    }
    // ⚠️ **Ordem**: o folding entra no índice **antes** de ler `rowCount` (a linha
    // colapsada ocupa 0 rows — a contagem publicada tem de saber disso).
    applyCollapsedLines(index, this.currentFolding);
    return index.rowCount;
  }

  /**
   * Publica o total de rows visuais no viewport (o `visualLineCount` da rolagem).
   *
   * Só chama `setMetrics` quando o valor **muda** — nada de alocar por frame.
   */
  private publishVisualRowCount(count: number): void {
    if (count === this.publishedVisualRowCount) return;
    this.publishedVisualRowCount = count;
    this.viewport.setMetrics({ visualLineCount: count });
  }

  resize(cssWidth: number, cssHeight: number): void {
    const nextWidth = Math.max(1, Math.floor(cssWidth));
    const nextHeight = Math.max(1, Math.floor(cssHeight));
    // Reatribuir `canvas.width/height` **realoca** o backing store (zera o canvas e, em
    // máquina sem GPU, pode derrubar o processo de raster). Só o faz quando o tamanho
    // **muda** de fato — métricas de layout (wrap/rolagem) podem ser recalculadas sem
    // tocar no canvas (é o caso do painel de depuração abrir/fechar: a faixa livre muda,
    // o canvas não).
    const sizeChanged = nextWidth !== this.viewportWidth || nextHeight !== this.viewportHeight;
    this.viewportWidth = nextWidth;
    this.viewportHeight = nextHeight;
    if (sizeChanged) {
      this.canvas.width = Math.floor(this.viewportWidth * this.dpr);
      this.canvas.height = Math.floor(this.viewportHeight * this.dpr);
      if (this.pipeline instanceof Canvas2DBackend) {
        this.pipeline.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      }
    }

    // Atualiza viewport com visualLineCount (soft wrap)
    const lineCount = this.source.lineCount();
    const gutterWidth = this.gutterWidthFor(lineCount);
    // Mesma largura útil do `renderOnce` — wrap e rolagem não podem divergir.
    const wrapWidth = usefulTextWidth(this.viewportWidth, gutterWidth);
    // O total de rows vem do **índice** (o `wrapLine` do core): o cálculo caractere a
    // caractere divergia dele e a rolagem não batia com o texto desenhado.
    const visualRowCount = this.ensureVisualRows(wrapWidth);
    this.publishedVisualRowCount = visualRowCount;
    this.viewport.setMetrics({
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      visualLineCount: visualRowCount,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private readonly frame = (): void => {
    if (!this.running) return;
    this.renderOnce();
    this.rafHandle = requestAnimationFrame(this.frame);
  };

  private renderOnce(): void {
    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.resize(this.viewportWidth, this.viewportHeight);
    }
    const viewportRect = { x: 0, y: 0, w: this.viewportWidth, h: this.viewportHeight };
    // Largura dinâmica do gutter: número de dígitos do total de linhas + folga.
    const lineCount = this.source.lineCount();
    const gutterWidth = this.gutterWidthFor(lineCount); // ~9px/dígito + 16px padding horizontal
    // Mesma largura útil do `resize` — wrap e rolagem não podem divergir.
    const wrapWidth = usefulTextWidth(viewportRect.w, gutterWidth);
    // O índice de rows tem que estar em dia **antes** do range visível: com o mapper ativo,
    // o viewport conta a rolagem em **rows visuais**.
    const visualRowCount = this.ensureVisualRows(wrapWidth);
    this.publishVisualRowCount(visualRowCount);
    const range = this.viewport.visibleLineRange();
    const colors = THEME.current.colors;
    const layout: LineLayout = {
      lineHeight: this.lineHeight(),
      paddingLeft: gutterWidth + TEXT_PADDING_LEFT_PX,
      paddingTop: TEXT_PADDING_TOP_PX,
      tabWidth: 4,
      scrollOffsetPx: this.viewport.scrollOffsetPx(),
      viewport: viewportRect,
      background: colors.background,
      defaultColor: colors.foreground,
      gutterWidth,
      gutterBackground: colors.gutter,
      gutterColor: colors.gutterForeground,
      scrollbarWidth: SCROLLBAR_WIDTH_PX,
      scrollbarTrack: colors.scrollbarTrack,
      scrollbarThumb: colors.scrollbarThumb,
      searchMatchColor: colors.searchMatch,
      searchCurrentColor: colors.searchCurrent,
      selectionColor: colors.selection,
      bracketMatchColor: colors.caret,
      // Soft wrap (P3#15): largura disponível para o texto = viewport - gutter - scrollbar - padding - minimap
      wrapWidth,
      // Row base da faixa visível (row **visual** absoluta) + total de rows: com o mapper
      // ativo, a rolagem é contada em rows e o texto tem de ser desenhado na mesma unidade.
      ...(this.visualRows !== undefined
        ? {
            visualRowOffset: this.visualRows.rowOfLine(range.first),
            totalVisualRows: visualRowCount,
          }
        : {}),
    };

    // O **caret** (a barra do cursor) e a **seleção** (o retângulo) são coisas diferentes.
    //
    // ⚠️ **Bug corrigido**: o `caret` enviado era a **primeira linha visível, coluna 0** (o
    // comentário dizia ser o "destaque de linha atual") ⇒ a barra do cursor ficava colada no
    // topo-esquerdo da viewport e o cursor real **nunca** chegava ao canvas. Agora o `caret`
    // é a **posição real** do cursor e a linha do cursor vai separada, no parâmetro
    // `activeLine` do `buildInstances` (o destaque de linha atual).
    const placement = caretPlacement(this.source, this.currentSelections);
    const caretOffset = placement.offset;
    const caretPos = { line: placement.line, column: placement.column };
    const primaryCaret = {
      line: caretPos.line,
      column: caretPos.column,
      color: colors.caret,
      width: 2,
    };
    let extraCarets: readonly CaretPosition[] | undefined;
    let extraSelections: readonly Selection[] | undefined;
    if (this.currentSelections !== undefined && this.currentSelections.length > 1) {
      const ec: CaretPosition[] = [];
      const es: Selection[] = [];
      // A 1ª seleção é a primária (já tratada pelo `primaryCaret`/`currentSelection`).
      for (let si = 1; si < this.currentSelections.length; si++) {
        const sel = this.currentSelections[si]!;
        if (!SelectionOps.isCollapsed(sel)) es.push(sel);
        const pos = this.source.positionAt(sel.active);
        ec.push({ line: pos.line, column: pos.column, color: colors.caret, width: 2 });
      }
      if (ec.length > 0) extraCarets = ec;
      if (es.length > 0) extraSelections = es;
    }

    // Bracket matching (P3#14): destaca o par quando cursor esta num bracket.
    //
    // ⚠️ O par é procurado **só na vizinhança** do caret (`findMatchingBracketNear`): o
    // caminho legado materializava o **documento inteiro** a cada frame ⇒ O(documento)/frame.
    let bracketMatch: readonly [BracketPos, BracketPos] | undefined;
    if (this.currentSelection && !SelectionOps.isCollapsed(this.currentSelection)) {
      // So match quando cursor nao esta selecionando
    } else {
      const matchOffset = findMatchingBracketNear(
        this.source,
        caretOffset,
        BRACKET_SCAN_LINES,
        caretPos,
      );
      if (matchOffset !== undefined) {
        const openPos = this.source.positionAt(Math.min(caretOffset, matchOffset));
        const closePos = this.source.positionAt(Math.max(caretOffset, matchOffset));
        bracketMatch = [openPos, closePos] as const;
      }
    }

    const scene = buildInstances(
      this.source,
      layout,
      this.atlas,
      this.style,
      range,
      primaryCaret,
      this.highlighter,
      this.searchHighlightValue,
      this.currentSelection,
      extraCarets,
      extraSelections,
      bracketMatch,
      // measureWidth para soft wrap (P3#15): a **mesma** medição do índice de rows — o
      // texto desenhado e a contagem de rows têm que sair do mesmo `wrapLine`.
      this.measureText,
      this.currentFolding,
      this.currentInlayHints,
      this.gitDiffs,
      this.breakpointLines,
      // A **linha ativa** (destaque de linha atual) é a linha do cursor — separada do caret.
      caretPos.line,
      // O índice de rows: a cena reusa os segmentos já quebrados (não re-quebra a faixa a
      // cada frame) e passa a contar as linhas colapsadas (folding) como o índice.
      this.visualRows,
      // **Sticky scroll**: o contexto (a "envelope" do caret) que gruda no topo. O cálculo
      // é por frame (barato: os symbols já vêm cacheados) e a cena desenha as linhas que
      // saíram da viewport no topo, grudadas.
      this.computeStickyContext(caretPos.line),
    );
    this.requestHighlight?.(range.first, range.count);

    // Damage da viewport → limpeza seletiva no beginFrame → desenho → present (DEC-REN-4).
    const damage = this.viewport.takeDamage();
    this.pipeline.invalidate(damage);
    this.pipeline.beginFrame(viewportRect);
    this.pipeline.setIndentGuides(scene.indentGuides);
    this.pipeline.pushRects(scene.rects);
    this.pipeline.pushLines(scene.lines);
    for (let i = 0; i < scene.glyphs.length; i += GLYPH_CHUNK) {
      this.pipeline.pushGlyphs(scene.glyphs.slice(i, i + GLYPH_CHUNK));
      this.pipeline.flush();
    }
    this.pipeline.present(damage);
    // Diagnósticos LSP: desenha squiggly underlines (apenas canvas2d)
    this.renderDiagnostics();
    // Atualiza minimap a cada frame
    this.minimapBinding?.update();
  }

  private lineHeight(): number {
    return Math.ceil(this.style.sizePx * 1.4);
  }

  /** Número de linhas da fonte ativa. */
  sourceLineCount(): number {
    return this.source.lineCount();
  }

  /**
   * Primeira **linha lógica** visível (a do topo da viewport).
   *
   * O offset da rolagem é contado em **rows visuais** (nos dois modos) — quem fala em
   * *linhas* (roda do mouse, PageUp/PageDown, pedido de inlay hints, minimap) precisa
   * desta conversão. Sem wrap e sem dobra, é exatamente a 1ª linha visível de sempre.
   */
  firstVisibleLine(): number {
    const firstRow = Math.floor(this.viewport.scrollOffsetPx() / this.lineHeight());
    return this.visualRows?.lineOfRow(firstRow) ?? firstRow;
  }

  /** Offset da rolagem em **linhas lógicas** (px) — para quem fala em linhas. */
  logicalScrollOffsetPx(): number {
    return this.firstVisibleLine() * this.lineHeight();
  }

  /**
   * Linha lógica de um **Y do canvas** (px) — o clique do mouse.
   *
   * O Y do canvas é uma **row visual** ⇒ a linha é a que contém a row (a conta por
   * `lineHeight` daria a row, não a linha).
   *
   * ⚠️ **Correção do off-by-one**: a âncora vertical é o **centro do texto**
   * (`paddingTop + lineHeight/2`), não `sizePx * 0.7` — com a âncora antiga, clicar nos
   * primeiros pixels da linha caía na linha **anterior** (o texto ficava ~5px abaixo da
   * âncora). Ancorar no centro faz o topo da linha pertencer à própria linha.
   */
  lineAtCanvasY(y: number): number {
    const row = rowAtCanvasY(
      y,
      this.viewport.scrollOffsetPx(),
      this.lineHeight(),
      TEXT_PADDING_TOP_PX,
    );
    return this.visualRows?.lineOfRow(row) ?? row;
  }

  /**
   * Row **visual** de uma linha lógica — a row em que a linha é desenhada.
   *
   * Com soft wrap, a row de uma linha **não** é o seu índice: as linhas anteriores podem
   * ocupar várias rows. É a âncora vertical dos popups (que nascem na linha do caret).
   *
   * ⚠️ **Linha colapsada** (folding): ela **não é desenhada** (0 rows — a regra única) ⇒ o
   * `rowOfLine` devolveria a row da **próxima** linha visível (a âncora do popup cairia
   * embaixo do bloco, longe da dobra). A âncora vai para a **primeira linha visível do
   * bloco** (a do cabeçalho da dobra, que tem o `▸`).
   *
   * Sem índice de rows (ou sem `isCollapsed`), o comportamento antigo (a row da própria
   * linha).
   */
  visualRowOfLine(line: number): number {
    const anchor = anchorLineOf(this.visualRows, line);
    return this.visualRows?.rowOfLine(anchor) ?? anchor;
  }

  /** Conecta o minimap ao renderer. */
  attachMinimap(binding: MinimapBinding): void {
    this.minimapBinding = binding;
  }

  /** Define os diagnósticos LSP para um handle de documento. */
  setDiagnostics(handle: number, diagnostics: readonly LspDiagnostic[]): void {
    this.diagnosticsByHandle.set(handle, diagnostics);
  }

  /** Define o handle do documento ativo para renderizar diagnósticos. */
  setActiveHandle(handle: number | undefined): void {
    this.activeHandle = handle;
  }

  /** Desconecta o minimap. */
  detachMinimap(): void {
    this.minimapBinding?.dispose();
    this.minimapBinding = undefined;
  }

  /**
   * Desenha squiggly underlines + ícones no gutter para diagnósticos LSP.
   * Usa a API Canvas 2D diretamente sobre o canvas (overlay após o pipeline).
   */
  private renderDiagnostics(): void {
    if (this.activeHandle === undefined) return;
    const diags = this.diagnosticsByHandle.get(this.activeHandle);
    if (diags === undefined || diags.length === 0) return;

    const lineHeight = this.lineHeight();
    const scrollPx = this.viewport.scrollOffsetPx();
    // A rolagem é contada em **rows visuais**; o diagnóstico traz **linhas lógicas**.
    // Converter nos dois sentidos evita o filtro "misturar unidades" (descartava
    // diagnósticos visíveis e/ou desenhava fora da faixa).
    const firstRow = Math.floor(scrollPx / lineHeight);
    const visibleRows = Math.ceil(this.viewportHeight / lineHeight) + 1;
    const lastRow = firstRow + visibleRows;
    const firstLine = this.visualRows?.lineOfRow(firstRow) ?? firstRow;
    const lastLine = this.visualRows?.lineOfRow(lastRow) ?? lastRow;

    // ⚠️ **Linha colapsada** (folding): ela **não tem segmentos** (0 rows — a regra única
    // de rows) ⇒ o `locate` falha e o fallback antigo (`row = linha lógica`) usava a
    // **linha lógica como row visual** ⇒ o rabisco saía numa posição arbitrária.
    // Uma linha colapsada (ou fora do documento) **não é desenhada** ⇒ o diagnóstico
    // dela é ignorado (a linha não está visível).
    //
    // ⚠️ `isCollapsed` é a forma **canônica** de saber se a linha está colapsada (O(1)):
    // o `segmentsOf` (que embrulha a linha) é o **fallback** para um índice que não sabe
    // de folding.
    const isDrawableLine = (line: number): boolean =>
      line >= 0 &&
      line < this.source.lineCount() &&
      !isCollapsedLine(this.visualRows, line) &&
      (this.visualRows === undefined || this.visualRows.segmentsOf(line).length > 0);

    // Filtra diagnósticos visíveis (em **linhas lógicas**)
    const visible = diags.filter(
      (d) =>
        d.range.startLine <= lastLine &&
        d.range.endLine >= firstLine &&
        isDrawableLine(d.range.startLine),
    );
    if (visible.length === 0) return;

    const ctx = this.canvas.getContext("2d");
    if (ctx === null) return;

    const gutterWidth = this.gutterWidthFor(this.source.lineCount());
    const paddingLeft = gutterWidth + 8;
    const paddingTop = 8;
    const charW = this.style.sizePx * 0.6;

    ctx.save();

    // ── Squiggly underlines (como antes) ──────────────────────────────────
    for (const diag of visible) {
      const color = this.diagColor(diag.severity);
      // Row **visual** do diagnóstico: com soft wrap, a linha lógica ocupa N rows e o
      // squiggly tem de ficar na row do segmento que contém o offset.
      const loc = this.visualRows?.locate(diag.range.startLine, diag.range.startCol);
      const row = loc?.row ?? diag.range.startLine;
      const startY = row * lineHeight + lineHeight - 2 - scrollPx;
      // A coluna do diagnóstico é relativa à **linha lógica**; com wrap, o X tem de ser
      // medido **dentro do segmento** (cada segmento começa na margem esquerda).
      const startCol = loc?.column ?? diag.range.startCol;
      const endCol = loc !== undefined ? loc.column + Math.max(0, diag.range.endCol - diag.range.startCol) : diag.range.endCol;
      const startX = paddingLeft + startCol * charW;
      const endX = paddingLeft + endCol * charW;
      const width = Math.max(4, endX - startX);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      const squigglyY = startY + paddingTop;
      ctx.beginPath();
      const segments = Math.max(1, Math.floor(width / 6));
      for (let i = 0; i <= segments; i++) {
        const x = startX + (width / segments) * i;
        const y = squigglyY + (i % 2 === 0 ? 0 : 3);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // ── Ícones no gutter ─────────────────────────────────────────────────
    // Agrupa por linha (usa a linha de início do range) e pega a maior severidade
    const SEVERITY_RANK: Record<string, number> = {
      error: 4,
      warning: 3,
      info: 2,
      hint: 1,
    };
    const lineMaxSeverity = new Map<number, "error" | "warning" | "info" | "hint">();
    for (const diag of visible) {
      const line = diag.range.startLine;
      const current = lineMaxSeverity.get(line);
      if (current === undefined || (SEVERITY_RANK[diag.severity] ?? 0) > (SEVERITY_RANK[current] ?? 0)) {
        lineMaxSeverity.set(line, diag.severity);
      }
    }

    const iconSize = 12;
    const iconX = Math.round((gutterWidth - iconSize) / 2);

    for (const [line, severity] of lineMaxSeverity) {
      // ⚠️ **Linha colapsada** (folding): ela **não é desenhada** (0 rows) ⇒ o ícone
      // **não é desenhado** (o `rowOfLine` devolveria a row da próxima linha visível ⇒ o
      // ícone cairia na linha errada).
      if (isCollapsedLine(this.visualRows, line)) continue;
      // O ícone fica na **primeira row** da linha (a row visual, com soft wrap).
      const row = this.visualRows?.rowOfLine(line) ?? line;
      const y = row * lineHeight + Math.round((lineHeight - iconSize) / 2) - scrollPx + paddingTop;
      if (y + iconSize < 0 || y > this.viewportHeight) continue;

      ctx.save();
      const color = this.diagColor(severity);

      switch (severity) {
        case "error": {
          // Círculo vermelho com X
          const cx = iconX + iconSize / 2;
          const cy = y + iconSize / 2;
          const r = iconSize / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          // X branco
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          const inset = r * 0.35;
          ctx.moveTo(cx - inset, cy - inset);
          ctx.lineTo(cx + inset, cy + inset);
          ctx.moveTo(cx + inset, cy - inset);
          ctx.lineTo(cx - inset, cy + inset);
          ctx.stroke();
          break;
        }
        case "warning": {
          // Triângulo amarelo com !
          const cx = iconX + iconSize / 2;
          const topY = y;
          const botY = y + iconSize;
          ctx.beginPath();
          ctx.moveTo(cx, topY);
          ctx.lineTo(iconX + iconSize, botY);
          ctx.lineTo(iconX, botY);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          // ! branco
          ctx.fillStyle = "#ffffff";
          ctx.font = `bold ${iconSize * 0.7}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("!", cx, y + iconSize * 0.55);
          break;
        }
        default: {
          // info/hint: círculo menor com "i" / bolinha
          const cx = iconX + iconSize / 2;
          const cy = y + iconSize / 2;
          const r = iconSize / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          if (severity === "info") {
            ctx.fillStyle = "#ffffff";
            ctx.font = `bold ${iconSize * 0.7}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("i", cx, cy + 1);
          }
          break;
        }
      }

      ctx.restore();
    }

    ctx.restore();
  }

  /** Retorna a cor hex para uma severidade de diagnóstico. */
  private diagColor(severity: string): string {
    switch (severity) {
      case "error": return "#f14c4c";
      case "warning": return "#cca700";
      case "info": return "#3794ff";
      case "hint": return "#6e6e6e";
      default: return "#6e6e6e";
    }
  }
}

function setStatus(text: string): void {
  const status = document.getElementById("status-backend");
  if (status) status.textContent = `backend: ${text}`;
}

function setDocStatus(text: string): void {
  const status = document.getElementById("status-doc");
  if (status) status.textContent = text;
}

function setDirtyStatus(dirty: boolean): void {
  const el = document.getElementById("status-dirty");
  if (!el) return;
  el.textContent = dirty ? "● modificado" : "";
  el.classList.toggle("dirty", dirty);
}

/**
 * O **badge de problemas** da status bar (`✖ 2  ⚠ 1`).
 *
 * Vazio quando não há diagnóstico (o item continua lá — só some o texto). As contagens
 * vêm do modelo do painel (fonte da verdade), nunca de um contador próprio.
 */
function setProblemsBadge(counts: ProblemCounts): void {
  const el = document.getElementById("status-errors");
  if (!el) return;
  const parts: string[] = [];
  if (counts.error > 0) parts.push(`✖ ${counts.error}`);
  if (counts.warning > 0) parts.push(`⚠ ${counts.warning}`);
  if (counts.info > 0) parts.push(`ℹ ${counts.info}`);
  el.textContent = parts.join("  ");
  // O `title` é o do markup ("Problemas"); a contagem vai para o nome acessível.
  el.setAttribute("aria-label", `${counts.total} problema(s)`);
}

/**
 * O **badge de git** da status bar (`⎇ main  3`).
 *
 * `branch === null` ⇒ não há repositório ⇒ o badge fica vazio (a seção mostra "sem branch").
 */
function setGitBadge(branch: string | null, counts: SourceControlCounts): void {
  const el = document.getElementById("status-git");
  if (!el) return;
  if (branch === null) {
    el.textContent = "";
    el.setAttribute("aria-label", "Controle de código");
    return;
  }
  const badge = formatSourceControlBadge(counts);
  el.textContent = badge.length > 0 ? `⎇ ${branch}  ${badge}` : `⎇ ${branch}`;
  // O `title` é o do markup ("Controle de código"); o detalhe vai para o nome acessível.
  el.setAttribute("aria-label", `${branch} — ${describeSourceControlCounts(counts)}`);
}

/**
 * Uma mensagem **amigável** para a UI: **1 linha**, sem stack e sem o prefixo do IPC.
 *
 * O preload rejeita com `Scribe IPC[<código>]: <mensagem>` ⇒ o prefixo é ruído para o
 * usuário (é removido) e só a primeira linha vai para a tela — o resto fica no console.
 */
function friendlyMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const clean = raw.replace(/^Scribe IPC\[[^\]]*\]:\s*/, "").trim();
  const first = clean.split("\n")[0]?.trim() ?? "";
  if (first.length === 0) return fallback;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/**
 * A mensagem de erro da **busca em todos os arquivos** (a que o painel mostra).
 *
 * O mesmo padrão amigável de {@link friendlyMessage} (1 linha, sem stack) **mais** a
 * limpeza do prefixo técnico do core (`SearchInputError[search.pattern]:`) ⇒ o usuário
 * lê a causa real — "padrão regex potencialmente catastrófico (quantificador aninhado) —
 * a busca foi cancelada para não travar o editor" — em vez de um "Nenhum resultado"
 * silencioso.
 */
export function describeSearchFailure(error: unknown): string {
  const message = friendlyMessage(error, "falha na busca em todos os arquivos");
  const clean = message.replace(/^SearchInputError\[[^\]]*\]:\s*/, "").trim();
  return clean.length === 0 ? message : clean;
}

/**
 * Devolve o **foco ao canvas do editor**.
 *
 * O teclado do editor é escutado no `<canvas id="editor-surface">` (`keydown`). Qualquer
 * ação que tire o foco — abrir um arquivo pelo diálogo nativo, trocar de aba, fechar a
 * find bar, clicar num painel — deixa o foco no elemento que clicou, e aí **digitar não
 * faz nada** (sintoma "não dá pra editar"). Chamar isto depois dessas ações.
 */
function focusEditorSurface(): void {
  const el = document.getElementById("editor-surface");
  if (el instanceof HTMLElement) el.focus();
}

/**
 * Sincroniza um botão-toggle: classe `.active` (visual) **e** `aria-pressed` (estado
 * acessível). Sem o `aria-pressed`, um toggle é anunciado pela leitora de tela só como
 * "botão" — o usuário não sabe se o modo está ligado.
 */
function syncToggleButton(button: HTMLElement | null, active: boolean): void {
  if (button === null) return;
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
}

function updateCaretStatus(source: DocumentLineSource, offset: number): void {
  const status = document.getElementById("status-caret");
  const position = source.positionAt(offset);
  // A posição aparece **uma** vez na UI: só na status bar (`#status-caret`). O breadcrumb
  // `#bc-position` foi removido do HTML (redundância "Ln 1, Col 1" em dois lugares) — não
  // voltamos a escrever nele.
  if (status) status.textContent = `${position.line + 1}:${position.column + 1}`;
}

function updateBlame(session: DocumentSession | undefined, bridge: ScribeBridge | undefined, line: number): void {
  const el = document.getElementById("status-blame");
  if (!el || bridge?.blame === undefined || session === undefined) {
    if (el) el.textContent = "";
    return;
  }
  void (async () => {
    try {
      const result = await bridge.blame!(session.handle, line);
      el.textContent = result ? `${result.author} · ${result.timeAgo}` : "";
    } catch {
      el.textContent = "";
    }
  })();
}

/**
 * Desenha os breadcrumbs do documento ativo: segmentos do caminho separados por chevrons.
 * O último segmento (nome do arquivo) é destacado por CSS (`.bc-seg:last-child`).
 */
function setBreadcrumbs(path: string | undefined): void {
  const host = document.getElementById("bc-path");
  if (!host) return;
  host.replaceChildren();
  if (path === undefined) return;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  segments.forEach((segment, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "bc-sep";
      separator.innerHTML = ICON_CHEVRON_RIGHT;
      host.appendChild(separator);
    }
    const element = document.createElement("span");
    element.className = "bc-seg";
    element.textContent = segment;
    host.appendChild(element);
  });
}

/** Reflete a disponibilidade de undo/redo na status bar (habilitado/desabilitado). */
function setUndoStatus(canUndo: boolean, canRedo: boolean): void {
  document.getElementById("status-undo")?.classList.toggle("disabled", !canUndo);
  document.getElementById("status-redo")?.classList.toggle("disabled", !canRedo);
}

/**
 * Boot do renderer. **Guardado**: sem `document`/canvas (ex.: ambiente `node` de teste) devolve
 * `false` **sem** lançar e **sem** agendar frame — o loop nunca sobe fora do navegador.
 */
export async function bootRenderer(): Promise<boolean> {
  if (typeof document === "undefined" || typeof HTMLCanvasElement === "undefined") return false;
  const surface = document.getElementById("editor-surface");
  if (!(surface instanceof HTMLCanvasElement)) return false;

  // ── A seção **exibida** na barra lateral ─────────────────────────────────────────────────────
  //
  // `undefined` = **nenhuma** seção está no host (o painel mostra só a lista de "Abertos") —
  // é o estado do **boot**.
  //
  // ⚠️ **Por que não começa no *explorer***: a seção *ativa* era o *explorer* desde o
  // boot, mas o host dele nascia `hidden` ⇒ o 1º clique no botão da rail caía no ramo de
  // *toggle* e **fechava** a sidebar (a árvore do Explorer só aparecia no **2º** clique).
  // Agora o *toggle* só dispara com a seção **visível** ⇒ o 1º clique **abre** a seção.
  //
  // ⚠️ Declarado **aqui** (no topo do boot): o documento abre **antes** do workbench e o
  // `applyOutlineSymbols` roda nesse meio-tempo ⇒ a variável precisa existir desde já
  // (senão: *TDZ*).
  let activeSection: SidebarSection | undefined = undefined;

  const requested = resolveBackendKind();
  const { surface: atlasSurface, canvas: atlasCanvas } = createAtlasSurface(1024);
  const atlas = new GlyphAtlas({
    size: 1024,
    rasterizer: createCanvasRasterizer(),
    measurer: createCanvasMeasurer(),
    surface: atlasSurface,
  });
  // O backend 2D não tinge glifos por conta própria: recebe as cópias tingidas do atlas.
  const atlasTinter = createAtlasTinter(atlas, atlasCanvas);

  let pipeline: RenderPipeline;
  let effective: string = DEFAULT_RENDER_BACKEND;
  if (requested === "webgpu") {
    try {
      pipeline = await WebGPUBackend.create(surface, atlas);
      effective = "webgpu";
    } catch (error) {
      if (!(error instanceof WebGPUUnavailableError)) throw error;
      // DEC-TR-7: degradação DECLARADA e logada — nunca *fallback* silencioso.
      console.warn(`Scribe: webgpu indisponível, usando canvas2d — ${error.reason}`);
      pipeline = new Canvas2DBackend(assertiveContext(surface), atlas, {
        image: atlasCanvas,
        tint: atlasTinter,
      });
      effective = "canvas2d (fallback de webgpu)";
    }
  } else {
    pipeline = new Canvas2DBackend(assertiveContext(surface), atlas, {
      image: atlasCanvas,
      tint: atlasTinter,
    });
  }

  setStatus(effective);
  console.info(`Scribe: backend efetivo = ${effective} (pedido: ${requested})`);

  // Tema: espelha a paleta ativa na casca (CSS vars) antes do primeiro frame.
  applyChromeTheme(THEME.current);

  const source = new DocumentLineSource();
  const viewport = new ViewportImpl({
    lineCount: source.lineCount(),
    lineHeight: Math.ceil(TEXT_STYLE.sizePx * 1.4),
    viewportHeight: Math.max(1, surface.clientHeight || 1),
    viewportWidth: surface.clientWidth || 1,
    overscan: 2,
    now: (): number => performance.now(),
    requestFrame: (cb): Disposable => {
      const handle = requestAnimationFrame((time) => cb(time));
      return toDisposable(() => cancelAnimationFrame(handle));
    },
    scrollDurationMs: 120,
  });

  const renderer = new ScribeRenderer(surface, atlas, pipeline, viewport, source);
  renderer.resize(surface.clientWidth || 800, surface.clientHeight || 600);

  const bridge = readBridge();
  const controller =
    bridge !== undefined
      ? new DocumentController(bridge, viewport, renderer)
      : undefined;

  // ── Snippets de pacote (`.sublime-snippet` dentro de `Packages/<Nome>/…`) ──────────────────
  //
  // A lista é **global ao app** (não é por documento): uma única busca no boot, cacheada
  // aqui — o trigger nunca vai ao IPC. Preload antigo (sem `snippets`) ⇒ o app segue só com
  // os snippets embutidos (degradação explícita, sem crash).
  const packageSnippets = new Map<string, PackageSnippetDefinition>();
  if (bridge !== undefined && bridge.snippets === undefined) {
    console.info("Scribe: ponte sem `snippets.list` — só os snippets embutidos");
  } else if (bridge?.snippets !== undefined) {
    void bridge.snippets().then(
      (result) => {
        // Guarda de runtime: a resposta cruza o IPC (o `main` devolve `{ snippets }`).
        const payload: { readonly snippets?: unknown } | undefined = result;
        const definitions: readonly PackageSnippetDefinition[] = Array.isArray(payload?.snippets)
          ? payload.snippets
          : [];
        for (const [trigger, definition] of indexPackageSnippets(definitions)) {
          packageSnippets.set(trigger, definition);
        }
        if (definitions.length > 0) {
          console.info(`Scribe: ${definitions.length} snippet(s) de pacote carregado(s)`);
        }
      },
      // Falha no IPC (ou main sem índice de pacotes): o app segue com os embutidos.
      (error: unknown) => {
        console.warn("Scribe: falha ao buscar snippets de pacote — só os embutidos", error);
      },
    );
  }

  // Destaque de sintaxe: o main resolve a gramática e tokeniza; aqui só colorimos (ThemeResolver).
  const highlightStore = new HighlightStore();
  // Tema de sintaxe acompanha o tipo do tema do editor: as cores do par escuro são claras e
  // sumiriam sobre fundo branco (e vice-versa). Reatribuído no toggle — o `scene` lê `theme`
  // a cada frame, então basta trocar a referência.
  let syntaxTheme = createSyntaxTheme(THEME.current.kind);
  // Preload antigo sem `syntax.highlight`: realce desligado de forma explícita (uma linha de log).
  const canHighlight = bridge?.highlight !== undefined;
  if (bridge !== undefined && !canHighlight) {
    console.info("Scribe: ponte sem `syntax.highlight` — realce desligado (cor default)");
  }
  /**
   * Identidade do documento ativo: o `handle` da sessão aberta (muda a cada abertura) ou a chave de
   * demo sem ponte. Sem ela o realce do arquivo anterior casaria com a revisão 1 do arquivo novo.
   */
  const activeDocumentKey = (): HighlightDocumentKey =>
    controller?.current === undefined
      ? DEMO_DOCUMENT_KEY
      : documentHighlightKey(controller.current.handle);

  /**
   * Fonte do documento **ativo** no renderer: a sessão aberta ou, sem ponte, a demo do boot.
   *
   * O realce precisa disto (e não da `source` do boot): cada documento tem a sua fonte, com a
   * revisão que o `main` devolveu, e a requisição só vale se a revisão bater com a resposta.
   */
  const activeSource = (): DocumentLineSource => controller?.current?.source ?? source;

  renderer.setHighlighter(
    { spansFor: (line) => highlightStore.spansFor(activeDocumentKey(), line), get theme() { return syntaxTheme; } },
    (first, count) => {
      if (controller === undefined || !canHighlight) return;
      const docKey = activeDocumentKey();
      const revision = activeSource().revision;
      // Falhou nesta revisão, já coberto, requisição **em voo** para a mesma revisão (dedupe), teto de
      // retentativas esgotado ou janela pós-resposta-vazia: não dispara IPC.
      if (!highlightStore.needsRequest(docKey, revision, first, count)) return;
      const request: HighlightRequest = { docKey, revision, first, count };
      highlightStore.beginRequest(docKey, revision);
      void controller.loadHighlight(first, count).then(
        (highlight) => {
          highlightStore.endRequest(docKey, revision);
          if (highlight === null || !highlightStore.set(highlight, request)) return;
          renderer.start();
        },
        // Falha (ex.: gramática que registra e não compila): marca a revisão e loga uma vez.
        (error: unknown) => {
          highlightStore.endRequest(docKey, revision);
          highlightStore.markFailed(docKey, revision, error);
        },
      );
    },
  );

  const initialPath = documentPath();
  let opened = false;
  if (controller !== undefined && initialPath !== undefined) {
    opened = await controller.open(initialPath);
  } else if (bridge !== undefined) {
    console.info("Scribe: ponte do preload presente, mas sem ?file= — renderer em modo demo");
  }
  if (!opened) {
    showWelcome(true);
    viewport.setMetrics({ lineCount: source.lineCount() });
    setBreadcrumbs(initialPath);
    if (initialPath === undefined) {
      setDocStatus(bridge === undefined ? "demo (sem preload)" : "Nenhum arquivo aberto");
    }
  }

  const globalScope = globalThis as { attachLineSource?: (source: LineSource) => void };
  globalScope.attachLineSource = (next: LineSource): void => {
    // Dev-seam: a identidade do documento ativo vem do `controller` (não da fonte anexada), então
    // trocar a fonte sem invalidar o store pintaria os spans do documento anterior no texto novo.
    highlightStore.invalidate();
    renderer.attachSource(next);
  };

  const findBar =
    bridge !== undefined && controller !== undefined
      ? attachFindBar({ bridge, controller, source, viewport, renderer, surface })
      : undefined;

  // ── Apoio ao rastreio de handle ativo para diagnósticos ─────────────────────────────────────
  const updateActiveHandle = (): void => {
    const session = controller?.current;
    renderer.setActiveHandle(session?.handle);
  };

  // ── Diagnósticos LSP ──────────────────────────────────────────────────────────────────────────
  //
  // O evento `lsp.diagnostics` chega **por handle**; o painel de problemas precisa do
  // **caminho** ⇒ a tradução handle → caminho usa as sessões abertas (o `DocumentController`).
  // O diagnóstico de um documento que **ainda não tem sessão** fica pendente no mapa (é
  // resolvido quando o documento abre — o refresh acontece na troca de documento).
  const diagnosticsByHandle = new Map<number, readonly LspDiagnostic[]>();
  /**
   * Ponte entre a assinatura do `lsp.diagnostics` (no boot) e o painel (montado depois).
   *
   * O painel só existe depois do boot ⇒ o guarda-vivo é ligado quando ele é montado.
   */
  const problemsBridge: { refresh?: () => void } = {};
  /** A raiz do repositório (a 1ª raiz do `workspace.files`; sem ela, o `main` resolve). */
  let gitRepoRoot: string | undefined;
  /** Notificado quando a seção de *Source Control* abre (recarrega o status do git). */
  const sourceControlBridge: { refresh?: () => void } = {};

  if (bridge?.onDiagnostics !== undefined) {
    void bridge.onDiagnostics((event) => {
      renderer.setDiagnostics(event.handle, event.diagnostics);
      // Problems: guarda por handle (o painel traduz handle → caminho).
      diagnosticsByHandle.set(event.handle, event.diagnostics);
      problemsBridge.refresh?.();
      if (controller?.current?.handle === event.handle) {
        // Atualiza dados do minimap para marcadores de diagnóstico
        renderer.minimapDiagnostics = event.diagnostics.map((d) => ({
          line: d.range.startLine,
          severity: d.severity,
        }));
        renderer.start();
      }
    });
    updateActiveHandle();
  }

  const commandPaletteApi: CommandPaletteApi | undefined =
    bridge !== undefined
      ? {
          listCommands: () => bridge.listCommands(),
          executeCommand: (commandId: string) => bridge.executeCommand(commandId),
        }
      : undefined;

  // ── Depuração (DAP) ────────────────────────────────────────────────────────────────────────
  /**
   * Breakpoints desejados por caminho (linhas 1-based + condição). A fonte da verdade vive no
   * main (`DapManager.desiredBreakpoints`) — persiste entre sessões de depuração; aqui só
   * espelhamos para o gutter, para o toggle de F9 e para o painel de condições.
   */
  const debugBreakpoints = new Map<string, readonly DapBreakpointSpec[]>();
  let debugThreadId: number | undefined;
  /** Frame selecionado (topo da pilha por padrão) — necessário para avaliar expressões. */
  let debugFrameId: number | undefined;
  /** Estado da sessão (o hover de valor só vale enquanto o programa está parado). */
  let debugState: DapSessionState = "inactive";
  /** Expressões de observação (watch) do usuário. */
  const debugWatch = new DebugWatchModel();
  const debugView: DebugViewBinding | undefined =
    bridge !== undefined && bridge.dapStart !== undefined && bridge.onDapState !== undefined
      ? createDebugView()
      : undefined;

  /**
   * Mantém o minimap em sintonia com o painel de depuração: os dois disputam a faixa do
   * canto direito, então com o painel aberto o minimap some (e volta quando ele fecha).
   *
   * Idempotente: só age quando o estado do painel muda.
   */
  const syncMinimapWithDebugPanel = (): void => {
    if (debugView === undefined) return;
    if (debugView.isOpen === debugPanelOpen) return;
    debugPanelOpen = debugView.isOpen;
    applyMinimapVisibility();
    // A faixa livre mudou de largura: o wrap do texto precisa ser recalculado.
    renderer.markLayoutDirty();
  };
  // O painel pode ser fechado pelo botão "×" (fora do toggle) — o **evento** de
  // visibilidade cobre esse caminho sem depender do DOM do painel.
  //
  // ⚠️ Isto **não** pode ser um gancho por frame: um gancho que marcasse o layout como
  // sujo dentro do próprio laço de render realimentava o frame (loop de layout) e
  // travava o renderer — era o crash ao fechar o painel de depuração.
  debugView?.onVisibilityChange(() => {
    syncMinimapWithDebugPanel();
  });

  /** Thread atual (do último `stopped` ou 1ª conhecida) — necessária a continue/pause/step. */
  const withCurrentThread = (action: (threadId: number) => void): void => {
    if (bridge === undefined) return;
    if (debugThreadId !== undefined) {
      action(debugThreadId);
      return;
    }
    void bridge.dapThreads?.()
      .then((threads: readonly DapThread[]) => {
        const first = threads[0]?.id;
        if (first !== undefined) {
          debugThreadId = first;
          action(first);
        }
      })
      .catch(() => {});
  };

  const handleDebugAction = (action: DebugAction): void => {
    if (bridge === undefined) return;
    switch (action) {
      case "start": {
        // F5 contextual: parado → continuar; inativo/encerrado → iniciar nova sessão.
        const session = controller?.current;
        if (session === undefined) break;
        void (async (): Promise<void> => {
          let state: DapSessionState | undefined;
          try {
            state = await bridge.dapState?.();
          } catch {
            return;
          }
          if (state === "stopped" && debugThreadId !== undefined) {
            void bridge.dapContinue?.(debugThreadId).catch(() => {});
            return;
          }
          if (state !== "inactive" && state !== "terminated" && state !== "errored") return;
          debugThreadId = undefined;
          // ⚠️ **Salvar antes de depurar**: o debuggee roda o arquivo **do disco** — com o
          // buffer sujo, o depurador pararia num código diferente do que o editor mostra.
          //
          // O **lote pendente** tem de ir ao core **antes** (o core grava o que tem em
          // mãos: sem o flush, ele salvaria um texto velho) e a falha do save **propaga**
          // — sem o arquivo salvo, não há depuração (e o erro aparece na status bar).
          try {
            await controller?.flushBatch?.();
            await session.bridge.save(session.handle);
          } catch (error: unknown) {
            console.error("Scribe: falha ao salvar antes de depurar", error);
            setDocStatus(
              `erro ao salvar: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
          // ⚠️ O `dirty` só é limpo se **não** há lote pendente: o usuário pode ter digitado
          // durante o `await` (esse texto ainda não foi para o core) ⇒ marcar como salvo
          // perderia a marca de sujo do lote pendente.
          if (controller?.hasPendingBatch !== true) {
            session.dirty = false;
            setDirtyStatus(false);
            controller?.renderTabBar();
          }
          // ⚠️ A falha do DAP **não** é engolida: o usuário via só o estado `errored`, sem
          // mensagem — e a causa (ex.: `DAP_BEFORE_LAUNCH_FAILED`, "disco cheio") sumia.
          // A mensagem vai para a status bar (**sem stack**).
          try {
            await bridge.dapStart?.(session.handle);
          } catch (error: unknown) {
            setDocStatus(
              `erro ao iniciar a depuração: ${friendlyMessage(error, "falha ao iniciar a depuração")}`,
            );
            console.warn("Scribe: falha ao iniciar a depuração", error);
          }
        })();
        break;
      }
      case "continue":
        if (debugThreadId !== undefined) {
          void bridge.dapContinue?.(debugThreadId).catch(() => {});
        }
        break;
      case "pause":
        withCurrentThread((threadId: number) => {
          void bridge.dapPause?.(threadId).catch(() => {});
        });
        break;
      case "stepOver":
        withCurrentThread((threadId: number) => {
          void bridge.dapStepOver?.(threadId).catch(() => {});
        });
        break;
      case "stepInto":
        withCurrentThread((threadId: number) => {
          void bridge.dapStepInto?.(threadId).catch(() => {});
        });
        break;
      case "stepOut":
        withCurrentThread((threadId: number) => {
          void bridge.dapStepOut?.(threadId).catch(() => {});
        });
        break;
      case "stop":
        debugThreadId = undefined;
        void bridge.dapStop?.().catch(() => {});
        break;
    }
  };

  /** Toggle de breakpoint na linha do caret (F9 / menu). */
  const toggleBreakpointAtCaret = (): void => {
    const session = controller?.current;
    if (session === undefined || bridge?.dapSetBreakpoints === undefined) return;
    const line = session.source.positionAt(session.caret).line + 1; // 1-based
    const path = session.path;
    const current = debugBreakpoints.get(path) ?? [];
    const next = current.some((spec) => spec.line === line)
      ? current.filter((spec) => spec.line !== line)
      : [...current, { line }].sort((a, b) => a.line - b.line);
    applyBreakpoints(path, next, session.handle);
  };

  /**
   * Publica o conjunto de breakpoints de um arquivo: espelha no gutter, no painel de
   * condições e envia ao main (fonte da verdade).
   *
   * O **painel** mostra sempre os breakpoints do **documento ativo** — a lista de outro
   * arquivo só entra no espelho (e na contagem), nunca no painel.
   */
  const applyBreakpoints = (
    path: string,
    specs: readonly DapBreakpointSpec[],
    handle: number,
  ): void => {
    debugBreakpoints.set(path, specs);
    const session = controller?.current;
    if (session !== undefined && session.path === path) {
      renderer.setBreakpointLines(specs.map((spec) => spec.line));
      renderer.start();
      debugView?.setBreakpointSpecs(specs, path);
    }
    debugView?.setBreakpointCount(
      [...debugBreakpoints.values()].reduce((n, list) => n + list.length, 0),
    );
    void bridge?.dapSetBreakpoints?.(handle, specs).catch((error: unknown) => {
      // Falha silenciosa aqui deixa renderer e main divergentes (a bolinha some sem aviso).
      console.warn("Scribe: falha ao publicar os breakpoints", error);
    });
  };

  /**
   * Amarra o painel de breakpoints ao **documento ativo**: publica nele a lista do
   * documento ativo (e só dela).
   *
   * Se a lista do documento ainda é desconhecida no espelho local, ela é buscada no main
   * (fonte da verdade) — trocar de aba não pode deixar o painel com a lista do arquivo
   * anterior.
   */
  const resyncDebugPanelToActiveDocument = (): void => {
    if (debugView === undefined) return;
    const session = controller?.current;
    if (session === undefined) {
      debugView.setBreakpointSpecs([]);
      return;
    }
    const path = session.path;
    const local = debugBreakpoints.get(path);
    if (local !== undefined) {
      debugView.setBreakpointSpecs(local, path);
      return;
    }
    void bridge?.dapBreakpoints?.(session.handle)
      .then((raw) => {
        const specs = normalizeBreakpointList(raw);
        debugBreakpoints.set(path, specs);
        // O documento pode ter mudado durante a busca: só publica se ainda for o ativo.
        if (controller?.current?.path !== path) return;
        debugView?.setBreakpointSpecs(specs, path);
        debugView?.setBreakpointCount(
          [...debugBreakpoints.values()].reduce((n, list) => n + list.length, 0),
        );
      })
      .catch((error: unknown) => {
        console.warn("Scribe: falha ao sincronizar os breakpoints do documento", error);
      });
  };

  /**
   * Reavalia as expressões de observação contra o frame atual e publica os valores.
   * Silencioso: sem sessão parada não há o que avaliar.
   *
   * A avaliação é **paralela** (o painel não espera a expressão mais lenta) e tem **guarda
   * de geração**: um resultado obsoleto (frame trocado no meio) é descartado.
   */
  let debugWatchGeneration = 0;
  const refreshWatchValues = (): void => {
    if (debugView === undefined || bridge?.dapEvaluate === undefined) return;
    if (debugFrameId === undefined || debugState !== "stopped") return;
    const expressions = debugWatch.list();
    if (expressions.length === 0) {
      debugView.setWatchValues(new Map());
      return;
    }
    const frameId = debugFrameId;
    const generation = ++debugWatchGeneration;
    void (async () => {
      const entries: Array<readonly [string, string]> = [];
      // Concorrência limitada: o core aceita no máximo `MAX_CONCURRENT_EVALUATIONS`
      // avaliações em voo (teto de segurança) — uma vaga fica reservada ao hover.
      const limit = Math.max(1, MAX_CONCURRENT_EVALUATIONS - 1);
      for (let i = 0; i < expressions.length; i += limit) {
        // Um refresh mais novo começou (ou a parada acabou): este é obsoleto — não segue
        // avaliando (as avaliações ocupam a cota do core).
        if (generation !== debugWatchGeneration) return;
        const chunk = expressions.slice(i, i + limit);
        const part = await Promise.all(
          chunk.map(async (expression): Promise<readonly [string, string]> => {
            try {
              const result = await bridge.dapEvaluate!(expression, frameId, "watch");
              return [expression, result === null ? "—" : result.value];
            } catch {
              return [expression, "—"];
            }
          }),
        );
        entries.push(...part);
      }
      // Resultado obsoleto (outra parada/frame no meio): descartado.
      if (generation !== debugWatchGeneration) return;
      debugView.setWatchValues(new Map(entries));
    })();
  };

  /**
   * Move o caret para a linha do frame da parada (quando o frame é do arquivo aberto).
   * Antes, a parada **não** movia o caret (limitação declarada do P4#16/DAP).
   */
  const moveCaretToFrame = (frame: DapStackFrame): void => {
    const session = controller?.current;
    if (session === undefined) return;
    // Comparação tolerante: o caminho do frame vem do adaptador (`\`, outra caixa) e o da
    // sessão é o do editor — comparação literal rejeitaria o mesmo arquivo.
    if (frame.path !== undefined && session.path !== "" && !isSameFilePath(frame.path, session.path)) {
      return;
    }
    const line = Math.max(0, frame.line - 1);
    if (line >= session.source.lineCount()) return;
    // A coluna do frame (1-based no DAP) é respeitada — o caret aponta a expressão, não
    // o começo da linha. Adaptador sem coluna ⇒ começo da linha.
    const column = Number.isFinite(frame.column) ? Math.max(0, frame.column - 1) : 0;
    const col = Math.min(column, session.source.line(line).length);
    const offset = session.source.offsetOf(line, col);
    session.caret = offset;
    session.selection = { anchor: offset, active: offset };
    session.selections = [session.selection] as SelectionSet;
    viewport.scrollTo(Math.max(0, line - 5));
    renderer.setSelection(session.selection);
    renderer.setSelections(session.selections);
    renderer.start();
  };

  /**
   * Hover de valor: durante uma parada, a expressão sob o mouse é avaliada pelo adaptador
   * e o valor aparece num tooltip (contexto `hover`).
   */
  let debugHoverTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Geração das avaliações de hover: uma resposta que chega depois de outra avaliação
   * (ou depois de a parada ter acabado) é **obsoleta** e descartada.
   */
  let debugHoverGeneration = 0;
  /**
   * Memo da expressão já avaliada: a **mesma** expressão não é reavaliada a cada
   * movimento do mouse (cada avaliação é um roundtrip IPC + uma avaliação no debuggee).
   */
  const debugHoverMemo = new DebugHoverMemo();
  /**
   * Cancela a avaliação de hover **pendente** (timer + respostas em voo de outra
   * expressão) — sem tocar no memo.
   */
  const cancelPendingHover = (): void => {
    clearTimeout(debugHoverTimer);
    debugHoverTimer = undefined;
    debugHoverGeneration++;
  };
  /** Cancela o hover pendente (timer + avaliações em voo) e limpa o memo. */
  const cancelDebugHover = (): void => {
    cancelPendingHover();
    debugHoverMemo.clear();
    debugView?.hideDebugValue();
  };
  surface.addEventListener("mousemove", (event: MouseEvent) => {
    if (debugView === undefined || bridge?.dapEvaluate === undefined) return;
    if (debugState !== "stopped" || debugFrameId === undefined) {
      cancelDebugHover();
      return;
    }
    const session = controller?.current;
    if (session === undefined) return;

    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // A linha sob o mouse: com soft wrap, o Y do canvas é uma **row** ⇒ a linha é a que
    // a contém (o renderer faz a conversão).
    const line = renderer.lineAtCanvasY(y);
    if (line < 0 || line >= session.source.lineCount()) {
      cancelDebugHover();
      return;
    }
    const text = session.source.line(line);
    const approxCharW = TEXT_STYLE.sizePx * 0.6;
    // Mesma origem do desenho do texto (gutter + padding) — senão a expressão sai ao lado.
    const col = columnFromPointerX(x, text.length, gutterWidthOf(renderer), approxCharW);
    const expression = extractExpressionAt(text, col);
    if (expression === null) {
      // Sem expressão sob o mouse: o timer pendente **precisa** morrer (o tooltip
      // obsoleto apareceria depois).
      cancelDebugHover();
      return;
    }

    const frameId = debugFrameId;
    if (!debugHoverMemo.needsEvaluation(expression, frameId)) {
      // Mesma expressão do mesmo frame: o valor já está no tooltip — cancela qualquer
      // avaliação pendente de **outra** expressão e só reposiciona o tooltip (sem novo
      // roundtrip IPC nem nova avaliação no debuggee).
      cancelPendingHover();
      const cached = debugHoverMemo.lastResult;
      if (cached !== null) {
        const suffix = cached.type !== undefined ? ` : ${cached.type}` : "";
        debugView.showDebugValue(
          `${expression} = ${cached.value}${suffix}`,
          event.clientX,
          event.clientY,
        );
      }
      return;
    }

    clearTimeout(debugHoverTimer);
    debugHoverTimer = setTimeout(() => {
      if (frameId === undefined) return;
      const generation = ++debugHoverGeneration;
      void (async () => {
        try {
          const result = await bridge.dapEvaluate!(expression, frameId, "hover");
          // Resposta obsoleta (o mouse já foi para outro lugar): descartada.
          if (generation !== debugHoverGeneration) return;
          debugHoverMemo.remember(expression, frameId, result);
          if (result === null) {
            debugView.hideDebugValue();
            return;
          }
          const suffix = result.type !== undefined ? ` : ${result.type}` : "";
          debugView.showDebugValue(
            `${expression} = ${result.value}${suffix}`,
            event.clientX,
            event.clientY,
          );
        } catch {
          if (generation !== debugHoverGeneration) return;
          debugHoverMemo.remember(expression, frameId, null);
          debugView.hideDebugValue();
        }
      })();
    }, 250);
  });

  if (debugView !== undefined && bridge !== undefined) {
    debugView.onAction(handleDebugAction);
    debugView.onFrameSelect((frame: DapStackFrame) => {
      // O frame selecionado é o contexto das expressões (watch/hover).
      debugFrameId = frame.id;
      refreshWatchValues();
    });
    debugView.onScopesRequest((frame: DapStackFrame) => {
      void bridge.dapScopes?.(frame.id)
        .then((scopes: readonly DapScope[]) => debugView.setScopes(frame.id, scopes))
        .catch(() => {});
    });
    debugView.onVariablesRequest((reference: number) => {
      void bridge.dapVariables?.(reference)
        .then((variables: readonly DapVariable[]) => debugView.setVariables(reference, variables))
        .catch(() => {});
    });

    // ── Breakpoints condicionais (P4#27) ───────────────────────────────────────────────────
    // O painel lista os breakpoints do **documento ativo** — as edições abaixo aplicam
    // sempre ao documento ativo (o painel é ressincronizado a cada troca de aba).
    //
    // ⚠️ O gancho é o de **spec**: a spec nova traz `condition`, `hitCondition` e
    // `logMessage` juntos. O gancho antigo (só `condition`) continua existindo no painel,
    // mas só dispara quando este **não** está registrado — por isso a troca é obrigatória
    // (com ele, os campos novos nunca chegariam ao main).
    debugView.onBreakpointSpecChange((line: number, spec: DapBreakpointSpec) => {
      const session = controller?.current;
      if (session === undefined) return;
      const current = debugBreakpoints.get(session.path) ?? [];
      const next = current.map((candidate): DapBreakpointSpec =>
        candidate.line === line ? spec : candidate,
      );
      applyBreakpoints(session.path, next, session.handle);
    });
    debugView.onBreakpointRemove((line: number) => {
      const session = controller?.current;
      if (session === undefined) return;
      const current = debugBreakpoints.get(session.path) ?? [];
      applyBreakpoints(
        session.path,
        current.filter((spec) => spec.line !== line),
        session.handle,
      );
    });

    // ── Expressões de observação (P4#27) ────────────────────────────────────────────────────
    debugView.setWatchExpressions(debugWatch.list());
    debugView.onWatchAdd((expression: string) => {
      if (!debugWatch.add(expression)) return;
      debugView.setWatchExpressions(debugWatch.list());
      refreshWatchValues();
    });
    debugView.onWatchRemove((expression: string) => {
      if (!debugWatch.remove(expression)) return;
      debugView.setWatchExpressions(debugWatch.list());
      refreshWatchValues();
    });
    debugView.onWatchRefresh(() => {
      refreshWatchValues();
    });

    bridge.onDapState?.((event: { state: DapSessionState }) => {
      debugState = event.state;
      debugView.setState(event.state);
      if (event.state !== "stopped") {
        debugFrameId = undefined;
        // O programa voltou a rodar: o valor em cache é **obsoleto** — o memo é limpo
        // (a próxima parada reavalia a expressão).
        cancelDebugHover();
      }
    });
    bridge.onDapStopped?.((event: DapStoppedEvent) => {
      if (event.threadId !== undefined) debugThreadId = event.threadId;
      const threadId = event.threadId ?? debugThreadId ?? 0;
      void bridge.dapStackTrace?.(threadId)
        .then((frames: readonly DapStackFrame[]) => {
          debugView.showStopped(event.threadId, frames);
          const top = frames[0];
          debugFrameId = top?.id;
          // Move o caret para a linha da parada (o frame pode estar em outro arquivo).
          if (top !== undefined) moveCaretToFrame(top);
          refreshWatchValues();
        })
        .catch(() => {});
    });
    bridge.onDapOutput?.((event: DapOutputEvent) => {
      debugView.appendOutput(event.category, event.output);
    });
    bridge.onDapBreakpoints?.((event: { path: string; breakpoints: readonly DapBreakpoint[] }) => {
      // O main confirma os breakpoints **verificados**. O espelho local guarda a lista
      // **desejada** (é ela que tem a condição): um breakpoint não verificado não pode
      // desaparecer do espelho — senão a próxima edição da lista o apagaria do main
      // (e a condição junto). `hitCondition`/`logMessage` são preservados (o evento do
      // main não os carrega).
      const current = debugBreakpoints.get(event.path) ?? [];
      const merged = mergeBreakpointSpecs(current, event.breakpoints);

      debugBreakpoints.set(event.path, merged);
      // O painel mostra **sempre** os breakpoints do documento ativo.
      const session = controller?.current;
      if (session !== undefined && session.path === event.path) {
        debugView.setBreakpointSpecs(merged, event.path);
      }
      debugView.setBreakpointCount(
        [...debugBreakpoints.values()].reduce((n, list) => n + list.length, 0),
      );
      if (session !== undefined && session.path === event.path) {
        // Só os verificados ganham a bolinha no gutter (o resto fica no painel).
        const verified = event.breakpoints
          .filter((bp: DapBreakpoint) => bp.verified)
          .map((bp: DapBreakpoint) => bp.line);
        renderer.setBreakpointLines(verified);
        renderer.start();
      }
    });
  }

  // ── Explorer: a árvore de arquivos da workspace ──────────────────────────────────────────────
  //
  // A lista vem do bridge (`workspace.files`) — **opcional**: um preload mais antigo não
  // expõe o método ⇒ a seção fica **vazia** (sem crash, degradação explícita).
  //
  // A indexação é **cara** ⇒ a carga é **preguiçosa** (na 1ª abertura da seção) e só se
  // repete quando as **raízes** mudam (um documento aberto/fechado muda a pasta).

  const explorerTree: ExplorerTreeHandle = mountExplorerTree(
    document.getElementById("explorer-tree-host"),
    {
      onOpenFile: (absolutePath: string): void => {
        // O caminho **absoluto** é o que o `controller.open` quer.
        void controller?.open(absolutePath);
      },
    },
  );

  /** `true` quando a árvore já foi alimentada (evita reindexar a cada clique). */
  let explorerLoaded = false;
  /** As raízes do último índice (o que decide se a lista ainda vale). */
  let explorerRootsKey = "";

  /**
   * Expande o **1º nível** da árvore (os diretórios de topo).
   *
   * Sem isto a árvore aparece toda fechada — e parece quebrada.
   */
  const expandFirstLevel = (): void => {
    for (const node of explorerTree.model.tree()) {
      if (node.kind !== "dir") continue;
      explorerTree.model.setExpanded(node.path, true);
    }
  };

  /**
   * Carrega (ou recarrega) o índice de arquivos da workspace.
   *
   * Só refaz o trabalho quando as **raízes** mudaram (a chave é a lista de raízes) — a
   * varredura do disco é cara.
   */
  const loadExplorerFiles = async (): Promise<void> => {
    const bridgeRef = bridge;
    if (bridgeRef === undefined || bridgeRef.workspaceFiles === undefined) {
      // Preload antigo: a seção fica vazia (e o filtro não encontra nada).
      explorerTree.update([]);
      return;
    }
    const roots = workspaceRootsOf(controller?.openSessions ?? []);
    const key = roots.join("\n");
    if (explorerLoaded && key === explorerRootsKey) return;
    explorerRootsKey = key;
    try {
      const result = await bridgeRef.workspaceFiles.call(bridgeRef, roots);
      if (result.truncated) {
        console.warn("Scribe: índice da workspace truncado", result.warnings);
      }
      // As raízes **efetivas** (o `main` expande até a pasta com `.git`) são a raiz do
      // repositório para as operações de git.
      const firstRoot = result.roots?.[0];
      if (firstRoot !== undefined) gitRepoRoot = firstRoot;
      explorerTree.update(result.files);
      explorerLoaded = true;
      expandFirstLevel();
    } catch (error: unknown) {
      console.warn("Scribe: falha ao indexar a workspace", error);
    }
  };

  /** Abre a seção do Explorer: indexa a workspace na **1ª vez** (lazy). */
  const ensureExplorerLoaded = (): void => {
    void loadExplorerFiles();
  };

  /**
   * Re-atalhe o índice quando as **raízes** mudam (abrir/fechar documento).
   *
   * Antes da 1ª abertura da seção não há índice — e não há por que pagar a varredura.
   */
  const refreshExplorerRoots = (): void => {
    if (!explorerLoaded) return;
    void loadExplorerFiles();
  };

  // (`activeSection` — a seção **exibida** — é declarada no **topo** do boot: ver a nota
  // lá em cima.)

  // ── Outline: a estrutura (símbolos) do documento ativo ──────────────────────────────────────
  //
  // Os símbolos vêm do **mesmo** `lsp.documentSymbols` que alimenta o *sticky scroll* (a
  // chamada é cara: uma por documento/versão do conteúdo, com debounce depois da edição) —
  // ver `refreshStickySymbols`, que entrega os símbolos crus aqui.

  /**
   * Move o caret para o símbolo escolhido no Outline e rola até ele.
   *
   * O mesmo caminho do popup de símbolos do documento (`Ctrl+Shift+O`).
   */
  const revealOutlineSymbol = (target: {
    readonly line: number;
    readonly column: number;
  }): void => {
    const session = controller?.current;
    if (session === undefined) return;
    const line = Math.max(0, Math.min(target.line, session.source.lineCount() - 1));
    const column = Math.max(0, Math.min(target.column, session.source.line(line).length));
    const offset = session.source.offsetOf(line, column);
    session.caret = offset;
    session.selection = SelectionOps.collapsed(offset);
    session.selections = SelectionSetOps.singular(offset);
    renderer.setSelection(session.selection);
    renderer.setSelections(session.selections);
    updateCaretStatus(session.source, offset);
    viewport.scrollTo(line);
    renderer.start();
    focusEditorSurface();
  };

  const outlineView: OutlineViewHandle = mountOutlineView(
    document.getElementById("outline-view"),
    {
      onReveal: (target: OutlineRevealTarget): void => {
        revealOutlineSymbol(target);
      },
    },
  );

  /**
   * Os **últimos** símbolos entregues ao Outline.
   *
   * Ficam **pendentes** enquanto a seção está fechada (o DOM do painel só é reescrito
   * com a seção **visível**) e são aplicados quando ela **abre**.
   */
  let pendingOutlineSymbols: readonly LspDocumentSymbol[] = [];
  /** `false` quando o documento ativo **não tem** servidor LSP (o Outline avisa). */
  let pendingOutlineLspAvailable = true;

  /**
   * Entrega os símbolos do documento ao Outline.
   *
   * `undefined` = **sem servidor LSP** para este documento (a seção mostra a mensagem
   * clara); uma lista vazia = o documento não tem símbolos.
   *
   * ⚠️ O **DOM** do painel só é reescrito com a seção **visível**: a lista chega a cada
   * evento do LSP e o Outline re-renderiza o DOM inteiro ⇒ com a seção escondida é
   * trabalho jogado fora. Com a seção escondida, o resultado fica **pendente** e é
   * aplicado quando ela abre (ver `showSidebarSection`).
   */
  const applyOutlineSymbols = (symbols: readonly LspDocumentSymbol[] | undefined): void => {
    pendingOutlineSymbols = symbols ?? [];
    pendingOutlineLspAvailable = symbols !== undefined;
    if (activeSection !== "outline") return;
    outlineView.setLspAvailable(pendingOutlineLspAvailable);
    outlineView.update(pendingOutlineSymbols);
  };

  // ── Sticky scroll: símbolos do LSP (cacheados por handle) ───────────────────────────────
  //
  // O `lsp.documentSymbols` é uma chamada **assíncrona** e cara: consultá-la a cada frame
  // inundaria o servidor. O cache é **por documento** (handle) e só éinvalidado quando o
  // **texto** muda (o `contentVersion` da fonte) — o cache do servidor (5s) no `main`
  // cuida do resto.
  //
  // ⚠️ A **mesma** resposta alimenta o *Outline* (a estrutura do documento): uma chamada
  // de IPC por documento/versão, não duas.
  const stickySymbolCache = new Map<
    number,
    {
      readonly symbols: readonly StickySymbol[];
      /** Os símbolos **crus** (o que o Outline desenha). */
      readonly raw: readonly LspDocumentSymbol[];
      readonly contentVersion: number;
    }
  >();
  let stickyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Timer da **re-tentativa** da busca de símbolos (o LSP ainda conectando). */
  let outlineRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Quantas re-tentativas já foram feitas (o orçamento é por documento). */
  let outlineRetryAttempt = 0;

  /** Aplica os símbolos ao renderer (o desenho do sticky é por frame, os dados são cacheados). */
  const applyStickySymbols = (
    handle: number | undefined,
    symbols: readonly StickySymbol[],
  ): void => {
    renderer.setStickySymbols(handle, symbols);
    renderer.start();
  };

  /**
   * Atualiza os símbolos do LSP do documento ativo (usados pelo sticky scroll **e** pelo
   * Outline).
   *
   * Com o cache válido, **não** há IPC (o `documentSymbols` só é chamado quando o texto
   * mudou ou quando o documento é aberto).
   *
   * @param force Ignora o cache (a **re-tentativa** do Outline — o LSP pode ainda estar
   *              conectando quando o documento abre).
   */
  const refreshStickySymbols = (session: TabSession | undefined, force = false): void => {
    if (session === undefined) {
      stickySymbolCache.clear();
      applyStickySymbols(undefined, []);
      // Sem documento ativo: o Outline fica vazio (o LSP existe — só não há o que listar).
      applyOutlineSymbols([]);
      return;
    }
    if (bridge?.documentSymbols === undefined) {
      // Sem LSP: o sticky usa o *fallback* por indentação e o Outline avisa que não há
      // servidor para este arquivo.
      applyStickySymbols(session.handle, []);
      applyOutlineSymbols(undefined);
      return;
    }
    const handle = session.handle;
    const cached = stickySymbolCache.get(handle);
    if (!force && cached !== undefined && cached.contentVersion === session.source.contentVersion) {
      applyStickySymbols(handle, cached.symbols);
      applyOutlineSymbols(cached.raw);
      return;
    }
    void bridge.documentSymbols(handle).then(
      (symbols) => {
        // O documento pode ter mudado enquanto a chamada estava em voo.
        if (controller?.current?.handle !== handle) return;
        const converted = stickySymbolsFromLsp(
          symbols,
          (line: number): string => session.source.line(line),
          session.source.lineCount(),
        );
        stickySymbolCache.set(handle, {
          symbols: converted,
          raw: symbols,
          contentVersion: session.source.contentVersion,
        });
        applyStickySymbols(handle, converted);
        applyOutlineSymbols(symbols);
        // ⚠️ **LSP ainda conectando**: o 1º resultado vem **vazio** (o servidor não tinha
        // ainda os símbolos do documento) ⇒ o Outline nascia vazio e só enche ao trocar
        // de arquivo. Re-tenta com backoff curto (e **só** com o resultado vazio).
        if (symbols.length === 0) {
          scheduleOutlineRetry(session);
        } else {
          outlineRetryAttempt = 0;
          clearTimeout(outlineRetryTimer);
          outlineRetryTimer = undefined;
        }
      },
      (error: unknown) => {
        console.warn("Scribe: falha ao buscar símbolos para o sticky scroll", error);
      },
    );
  };

  /**
   * Re-tenta a busca dos símbolos (o LSP pode ainda estar **conectando**).
   *
   * Backoff curto (1 s / 2 s / 4 s — no máximo 3 tentativas) e **só** quando o resultado
   * veio **vazio** e o documento continua o ativo: sem spam de IPC.
   */
  const scheduleOutlineRetry = (session: TabSession): void => {
    const attempt = outlineRetryAttempt + 1;
    if (attempt > OUTLINE_RETRY_DELAYS_MS.length) return;
    outlineRetryAttempt = attempt;
    const delay = OUTLINE_RETRY_DELAYS_MS[attempt - 1]!;
    clearTimeout(outlineRetryTimer);
    outlineRetryTimer = setTimeout(() => {
      outlineRetryTimer = undefined;
      // O documento pode ter mudado (ou saído de cena) ⇒ nada a re-tentar.
      if (controller?.current?.handle !== session.handle) return;
      refreshStickySymbols(session, true);
    }, delay);
  };

  /** Rebusca os símbolos (debounced) depois de uma edição. */
  const scheduleStickyRefresh = (): void => {
    clearTimeout(stickyRefreshTimer);
    // O texto mudou ⇒ o orçamento de re-tentativas recomeça (o LSP pode estar
    // conectando ainda).
    outlineRetryAttempt = 0;
    stickyRefreshTimer = setTimeout(() => {
      stickyRefreshTimer = undefined;
      refreshStickySymbols(controller?.current);
    }, STICKY_SYMBOLS_DEBOUNCE_MS);
  };

  // O painel de breakpoints acompanha o **documento ativo**: trocar de aba (ou abrir
  // outro arquivo) ressincroniza a lista — sem isto, editar a condição do arquivo A
  // gravaria no arquivo B.
  if (controller !== undefined) {
    controller.onActiveDocumentChanged = (session) => {
      resyncDebugPanelToActiveDocument();
      // Documento novo ⇒ o orçamento de re-tentativas do *Outline* recomeça (a pendência
      // do documento anterior não vale mais).
      outlineRetryAttempt = 0;
      clearTimeout(outlineRetryTimer);
      outlineRetryTimer = undefined;
      // O sticky scroll troca de documento ⇒ os símbolos cacheados do anterior não valem.
      // (A **mesma** busca alimenta o Outline — ver `refreshStickySymbols`.)
      refreshStickySymbols(session);
      // Abrir/fechar documento pode mudar a **raiz** da workspace ⇒ o índice do
      // Explorer (se ele já foi carregado) é re-atalhado.
      refreshExplorerRoots();
      // O documento que acabou de abrir pode ter diagnósticos **pendentes** (o LSP publicou
      // antes de a sessão existir) ⇒ o painel de problemas é re-resolvido.
      problemsBridge.refresh?.();
    };
  }

  // Uma **edição** invalida os símbolos do LSP (o envelope do bloco mudou): a busca é
  // rebuscada depois de uma pausa (o typing não gera um IPC por tecla).
  if (bridge !== undefined) {
    bridge.onDocumentChanged(() => {
      scheduleStickyRefresh();
    });
  }

  const handleMenuAction = (action: string): void => {
    switch (action) {
      case "file.open":
        if (controller !== undefined) void controller.openDialog();
        break;
      case "file.save":
        void controller?.save();
        break;
      case "edit.undo":
        void controller?.undo();
        break;
      case "edit.redo":
        void controller?.redo();
        break;
      case "edit.selectAll": {
        // Seleciona todo o texto do documento ativo
        const session = controller?.current;
        if (session !== undefined) {
          const end = session.source.offsetOf(session.source.lineCount() - 1, session.source.line(session.source.lineCount() - 1).length);
          session.selection = { anchor: 0, active: end };
          session.selections = SelectionSetOps.singular(end);
          session.caret = end;
          renderer.setSelection(session.selection);
          renderer.setSelections(session.selections);
          updateCaretStatus(session.source, end);
          renderer.start();
        }
        break;
      }
      case "edit.copy":
      case "edit.cut": {
        const session = controller?.current;
        if (session !== undefined && !SelectionOps.isCollapsed(session.selection)) {
          const sel = SelectionOps.normalized(session.selection);
          const text = session.source.text.slice(sel.start, sel.end);
          void navigator.clipboard.writeText(text).catch(() => {});
          if (action === "edit.cut") {
            void controller?.replaceText(sel.start, sel.end - sel.start, "");
          }
        }
        break;
      }
      case "edit.paste": {
        const cur = controller?.current;
        if (cur === undefined) break;
        void navigator.clipboard.readText().then((text) => {
          const pos = cur.selection;
          if (SelectionOps.isCollapsed(pos)) {
            void controller?.replaceText(pos.anchor, 0, text);
          } else {
            const sel = SelectionOps.normalized(pos);
            void controller?.replaceText(sel.start, sel.end - sel.start, text);
          }
        }).catch(() => {});
        break;
      }
      case "find.open":
        if (findBar !== undefined && !findBar.model.isOpen) {
          findBar.model.open();
          // O atalho do **menu nativo** chega aqui (o accelerator do menu precede o
          // renderer) ⇒ a busca abria **sem foco** e digitar não ia para o campo.
          const findInput = document.getElementById("find-input");
          if (findInput instanceof HTMLInputElement) findInput.focus();
        }
        break;
      case "find.next":
        findBar?.model.next();
        break;
      case "find.prev":
        findBar?.model.previous();
        break;
      case "view.toggleTheme":
        document.getElementById("theme-toggle")?.click();
        break;
      case "debug.start":
        handleDebugAction("start");
        break;
      case "debug.continue":
        handleDebugAction("continue");
        break;
      case "debug.pause":
        handleDebugAction("pause");
        break;
      case "debug.stop":
        handleDebugAction("stop");
        break;
      case "debug.stepOver":
        handleDebugAction("stepOver");
        break;
      case "debug.stepInto":
        handleDebugAction("stepInto");
        break;
      case "debug.stepOut":
        handleDebugAction("stepOut");
        break;
      case "debug.toggleBreakpoint":
        toggleBreakpointAtCaret();
        break;
      case "debug.togglePanel":
        toggleDebugPanel();
        break;
    }
  };

  /** Abre/fecha o painel de depuração (menu, paleta de comandos e atalho). */
  const toggleDebugPanel = (): void => {
    if (debugView === undefined) return;
    if (debugView.isOpen) {
      debugView.close();
      // O minimap volta a ocupar a faixa do canto direito.
      syncMinimapWithDebugPanel();
      // Fechar o painel devolve o foco ao canvas (o botão "×" ficou com o foco).
      focusEditorSurface();
      return;
    }
    debugView.open();
    // O minimap some: o painel de depuração fica com a faixa.
    syncMinimapWithDebugPanel();
    // Ao abrir, sincroniza os breakpoints do **documento ativo** (o main é a fonte da
    // verdade). Tolera um preload antigo (que devolvia só as linhas).
    const session = controller?.current;
    if (session !== undefined) {
      void bridge?.dapBreakpoints?.(session.handle)
        .then((raw) => {
          const specs = normalizeBreakpointList(raw);
          debugBreakpoints.set(session.path, specs);
          debugView?.setBreakpointSpecs(specs, session.path);
          debugView?.setBreakpointCount(
            [...debugBreakpoints.values()].reduce((n, list) => n + list.length, 0),
          );
        })
        .catch((error: unknown) => {
          console.warn("Scribe: falha ao buscar os breakpoints do documento", error);
        });
    }
  };

  /**
   * Executa um comando **pela UI** (a paleta e o *Quick Open* compartilham o caminho).
   *
   * - Some comandos são **do renderer** (a find bar, o tema, a depuração): eles rodam aqui;
   * - os demais são **do core** (`file.*`, `edit.undo/redo`): vão por IPC.
   */
  const executeCommandById = (commandId: string): void => {
    if (commandId === "find.open") {
      if (findBar !== undefined && !findBar.model.isOpen) {
        findBar.model.open();
        // O foco vai para o **input** da busca (sem isto, a digitação iria para o
        // documento — o find bar aberto sem foco é inútil).
        const findInput = document.getElementById("find-input");
        if (findInput instanceof HTMLInputElement) findInput.focus();
      }
    } else if (
      ["view.toggleTheme", "edit.cut", "edit.copy", "edit.paste", "edit.selectAll"].includes(
        commandId,
      )
    ) {
      handleMenuAction(commandId);
    } else if (commandId.startsWith("debug.")) {
      // Depuração: o core não tem UI — as ações rodam no renderer.
      handleMenuAction(commandId);
    } else {
      // Comandos de core: file.*, edit.undo/redo — executa via IPC
      void commandPaletteApi?.executeCommand(commandId).catch((error: unknown) => {
        console.error("Scribe: falha ao executar comando", commandId, error);
      });
    }
  };

  const palette =
    commandPaletteApi !== undefined
      ? attachCommandPalette({
          api: commandPaletteApi,
          onExecute: (command) => {
            // Fecha a palette antes de executar
            palette?.model.close();
            executeCommandById(command.id);
            // Foca o canvas de volta
            surface.focus();
          },
        })
      : undefined;

  // Escuta ações de menu nativo enviadas pelo processo principal
  if (bridge !== undefined && typeof bridge.onMenuAction === "function") {
    bridge.onMenuAction((action: string) => {
      handleMenuAction(action);
    });
  }

  // ── LSP UI widgets ───────────────────────────────────────────────────────────────────────────
  /**
   * Popup de completação vazio (fallback para quando o DOM não tem #completion-popup).
   */
  function createNullCompletionPopup(): CompletionPopupBinding {
    return {
      isOpen: false,
      open: () => {},
      close: () => {},
      selectNext: () => {},
      selectPrev: () => {},
      selected: undefined,
      dispose: () => {},
    };
  }
  /**
   * Tooltip vazio (fallback para quando o DOM não tem #hover-tooltip).
   */
  function createNullHoverTooltip(): HoverTooltipBinding {
    return { show: () => {}, hide: () => {}, dispose: () => {} };
  }

  let completion: CompletionPopupBinding;
  let hoverTooltip: HoverTooltipBinding;
  let signatureHelpPopup: SignatureHelpBinding;
  let documentSymbolsPopup: DocumentSymbolsBinding;
  let referencesPopup: ReferencesPopupBinding;
  try {
    completion = createCompletionPopup();
    hoverTooltip = createHoverTooltip();
    signatureHelpPopup = createSignatureHelp();
    documentSymbolsPopup = createDocumentSymbolsPopup();
    referencesPopup = createReferencesPopup();
  } catch (error) {
    console.warn("Scribe: widgets LSP indisponíveis (DOM ausente)", error);
    completion = createNullCompletionPopup();
    hoverTooltip = createNullHoverTooltip();
    signatureHelpPopup = { isOpen: false, show: () => {}, close: () => {}, dispose: () => {} };
    documentSymbolsPopup = { isOpen: false, open: () => {}, close: () => {}, dispose: () => {} };
    referencesPopup = { isOpen: false, open: () => {}, close: () => {}, dispose: () => {} };
  }

  // ── Painel de busca na workspace (o "grep", `Ctrl+Shift+F`) ─────────────────────────────
  /**
   * Põe o caret na posição `(line, column)` da sessão e mostra a linha.
   *
   * `line`/`column` são **0-based** (a convenção do core) e são **presos** ao documento
   * (nunca saem da faixa) — é o mesmo caminho do Outline (`onReveal`).
   */
  const revealPosition = (session: TabSession, line: number, column: number): void => {
    const targetLine = Math.max(0, Math.min(line, session.source.lineCount() - 1));
    const targetColumn = Math.max(0, Math.min(column, session.source.line(targetLine).length));
    const offset = session.source.offsetOf(targetLine, targetColumn);
    session.caret = offset;
    session.selection = SelectionOps.collapsed(offset);
    session.selections = SelectionSetOps.singular(offset);
    renderer.setSelection(session.selection);
    renderer.setSelections(session.selections);
    updateCaretStatus(session.source, offset);
    viewport.scrollTo(targetLine);
    renderer.start();
    focusEditorSurface();
  };

  /**
   * **O helper único** de "abrir um arquivo numa posição".
   *
   * Usado pelo *grep*, pelo painel de **problemas** e pelo **diff** — não duplica o
   * caminho de caret/foco. Se o arquivo **já está aberto**, a aba existente é apenas
   * ativada (abrir de novo criaria uma aba duplicada).
   */
  const openFileAt = async (path: string, line: number, column: number): Promise<void> => {
    if (controller === undefined) return;
    const existing = controller.openSessions.findIndex((session) => session.path === path);
    if (existing >= 0) {
      controller.activate(existing);
      const session = controller.current;
      if (session === undefined) return;
      revealPosition(session, line, column);
      return;
    }
    const opened = await controller.open(path);
    if (!opened) return;
    const session = controller.current;
    if (session === undefined) return;
    revealPosition(session, line, column);
  };

  // ── Workbench de seções: a barra lateral deixa de ser só a lista de "Abertos" ────────────────
  //
  // Uma **seção por vez**: o host da seção ativa é o único visível e a rail marca a seção
  // (`aria-pressed`). A lista de "Abertos" acompanha a seção *explorer*; o *grep* (o
  // painel de busca na workspace) é uma seção como outra.

  const sidebar = document.getElementById("sidebar");
  const resizeSurface = (): void =>
    renderer.resize(surface.clientWidth || 1, surface.clientHeight || 1);

  // (`activeSection` — a seção **exibida** — é declarada antes do *Outline*: ver a nota
  // lá em cima.)
  /** A seção que estava aberta antes do *grep* (o grep é uma seção como outra). */
  let sectionBeforeSearch: SidebarSection = "explorer";

  /** O botão da rail de uma seção (`null` = a seção ainda não tem botão). */
  const sectionButton = (section: SidebarSection): HTMLElement | null => {
    const id = SIDEBAR_SECTION_BUTTONS[section];
    if (id === undefined) return null;
    return document.getElementById(id);
  };

  /** Espelha a seção ativa na rail (`aria-pressed` + classe `active`). */
  const syncRail = (): void => {
    const visible = sidebar?.hidden === false;
    for (const section of Object.keys(SIDEBAR_SECTION_BUTTONS) as SidebarSection[]) {
      const button = sectionButton(section);
      if (button === null) continue;
      const pressed = visible && activeSection === section;
      button.setAttribute("aria-pressed", String(pressed));
      button.classList.toggle("active", pressed);
    }
    // O "grep" também é uma seção da sidebar (o botão dele não tem `aria-pressed` no
    // markup — o estado é espelhado aqui).
    const grepButton = document.getElementById("activity-grep");
    if (grepButton !== null) {
      const pressed = visible && activeSection === "search";
      grepButton.setAttribute("aria-pressed", String(pressed));
      grepButton.classList.toggle("active", pressed);
    }
  };

  const setSidebarVisible = (visible: boolean): void => {
    if (sidebar) sidebar.hidden = !visible;
    resizeSurface();
    renderer.start();
    syncRail();
  };

  /**
   * Mostra **uma** seção da barra lateral (as outras saem de cena).
   *
   * - a lista de "Abertos" (`#sidebar-editors`) acompanha a seção *explorer*;
   * - o *explorer* indexa a workspace na **1ª** abertura (a varredura é cara);
   * - a rail é sincronizada (`aria-pressed` + classe `active`).
   */
  const showSidebarSection = (section: SidebarSection): void => {
    if (section === "search" && activeSection !== "search") {
      sectionBeforeSearch = activeSection ?? "explorer";
    }
    // **Um** host por vez.
    for (const key of Object.keys(SIDEBAR_SECTION_HOSTS) as SidebarSection[]) {
      const host = document.getElementById(SIDEBAR_SECTION_HOSTS[key]);
      if (host !== null) host.hidden = key !== section;
    }
    // A lista de "Abertos" só acompanha a seção *explorer* (no *grep*, quem manda nela é o
    // próprio painel de busca — ele a esconde e a restaura).
    if (section !== "search") {
      const editors = document.getElementById("sidebar-editors");
      const header = document.getElementById("sidebar-section-toggle");
      const showEditors = section === "explorer";
      if (editors !== null) editors.hidden = !showEditors;
      if (header !== null) header.hidden = !showEditors;
    }
    sidebar?.setAttribute("aria-label", SIDEBAR_SECTION_LABELS[section]);
    activeSection = section;
    // O Explorer indexa a workspace **na 1ª abertura** (a varredura é cara).
    if (section === "explorer") ensureExplorerLoaded();
    // O *Source Control* recarrega o status do git quando a seção abre (o status é a
    // fonte da verdade — o painel nunca inventa contagem).
    if (section === "source-control") sourceControlBridge.refresh?.();
    // Os painéis de *Outline* e *Problems* só re-renderizam o DOM com a seção
    // **visível** ⇒ quem está escondido precisa ser atualizado **agora** (o que
    // chegou enquanto a seção estava fechada).
    if (section === "outline") {
      outlineView.setLspAvailable(pendingOutlineLspAvailable);
      outlineView.update(pendingOutlineSymbols);
    }
    if (section === "problems") problemsBridge.refresh?.();
    setSidebarVisible(true);
  };

  const searchController = createWorkspaceSearchController({
    bridge,
    roots: () => workspaceRootsOf(controller?.openSessions ?? []),
    onOpen: (path, line, column) => {
      void openFileAt(path, line, column);
    },
    focusEditor: focusEditorSurface,
    // O grep é uma **seção** da barra lateral: o workbench manda na visibilidade dos
    // hosts e devolve a seção anterior quando o painel fecha.
    onSectionOpen: () => {
      showSidebarSection("search");
    },
    onSectionClose: () => {
      showSidebarSection(sectionBeforeSearch);
    },
  });

  // Os abridores de overlay (o **mesmo** caminho dos atalhos): a paleta, o *Quick Open* e o
  // painel de busca focam o input e fecham os popups de contexto.
  const openers = attachInputListeners(surface, viewport, renderer, controller, findBar, palette, bridge, completion, hoverTooltip, signatureHelpPopup, documentSymbolsPopup, referencesPopup, packageSnippets, searchController, executeCommandById);

  // Minimap (P2#9): as cores vêm do tema ativo — sem isso a faixa fica preta no tema claro.
  //
  // O minimap desenha **uma linha por linha do documento** ⇒ ele precisa do offset da
  // rolagem em **linhas**. Com soft wrap, o offset real é contado em rows visuais: o
  // proxy abaixo traduz (o resto — range visível e `scrollTo` — é o do viewport real).
  //
  // ⚠️ **ACHADO 11 (pendente em `minimap.ts` — arquivo de outro agente, não editado aqui)**:
  // a faixa do minimap usa só ~10% da altura (a altura da barra é fixa em 3px ⇒ 34 barras
  // = 102px numa faixa de 712px). A correção proposta é **escalar o passo vertical** para
  // a janela preencher a faixa — dentro de `minimap.ts`, em `currentLayout()`:
  //
  // ```ts
  // const currentLayout = (): MinimapLayout => {
  //   const win = computeWindow();
  //   const height = container.clientHeight;
  //   const count = Math.max(1, win.count);
  //   // A barra escala para a janela preencher a faixa (o passo vertical acompanha).
  //   const barH = Math.max(MINIMAP_LINE_HEIGHT, Math.floor(height / count));
  //   return computeMinimapLayout({
  //     viewportHeight: height,
  //     lineCount: deps.source.lineCount(),
  //     lineHeight: barH,          // ← o novo parâmetro (o default é 3px)
  //     firstLine: win.firstLine,
  //     maxLines: win.count,
  //   });
  // };
  // ```
  //
  // O **clique continua correto sem mexer em mais nada**: `minimapLineAtY` e
  // `minimapViewportRect` já consomem o `rowPitch`/`firstLine` de `currentLayout()` — a
  // escala é a mesma para o desenho e para o hit-test (é o `rowPitch` que define a
  // linha clicada).
  const minimapViewport: Viewport & { scrollOffsetPx(): number } = {
    visibleLineRange: () => viewport.visibleLineRange(),
    subscribe: (observer) => viewport.subscribe(observer),
    scrollTo: (line, opts) => viewport.scrollTo(line, opts),
    takeDamage: () => viewport.takeDamage(),
    dispose: () => viewport.dispose(),
    scrollOffsetPx: () => renderer.logicalScrollOffsetPx(),
  };
  const minimap = attachMinimap({
    source: {
      lineCount: () => controller?.current?.source.lineCount() ?? source.lineCount(),
      line: (i: number) => controller?.current?.source.line(i) ?? source.line(i),
    },
    viewport: minimapViewport,
    lineHeight: Math.ceil(TEXT_STYLE.sizePx * 1.4),
    getViewportHeight: () => renderer.viewportHeight,
    colors: () => {
      const c = THEME.current.colors;
      // Cores semânticas vêm dos tokens do tema (`--s-error`/`--s-warn`/`--s-info`) — o hex
      // fixo ficava igual nos dois temas (erro/warn/info não seguiam a paleta).
      const semantic = semanticColors();
      return {
        background: rgbToCss(c.background),
        line: rgbToCss(c.foreground),
        viewport: rgbaToCss(c.foreground, 0.08),
        viewportBorder: rgbaToCss(c.foreground, 0.25),
        searchMatch: rgbaToCss(c.foreground, 0.35),
        searchCurrent: rgbaToCss(0xffcc00ff, 0.8),
        diagnosticError: semantic.error,
        diagnosticWarning: semantic.warning,
        diagnosticInfo: semantic.info,
      };
    },
    // NOVOS CAMPOS (P3.x): realce de sintaxe, busca e diagnóstico no minimap
    spansFor: (line: number) => highlightStore.spansFor(activeDocumentKey(), line),
    get syntaxTheme() { return syntaxTheme; },
    searchMatches: () => renderer.minimapSearchMatches,
    searchCurrentIndex: () => renderer.minimapSearchCurrentIndex,
    diagnostics: () => renderer.minimapDiagnostics,
  });
  renderer.attachMinimap(minimap);

  // Lupa de código (P2#9b): preview **ampliado** (×2.5) e **colorido** do código sob o mouse
  // sobre o minimap — a "coluna de código" com zoom que o usuário pediu.
  const minimapCanvas = minimap.container.querySelector<HTMLCanvasElement>("#minimap-surface");
  if (minimapCanvas !== null && bridge?.highlight !== undefined) {
    const loupeBinding = attachCodeLoupe({
      source: {
        lineCount: () => controller?.current?.source.lineCount() ?? source.lineCount(),
        line: (i: number) => controller?.current?.source.line(i) ?? source.line(i),
      },
      container: minimap.container,
      canvas: minimapCanvas,
      fontFamily: TEXT_STYLE.family,
      fontSize: TEXT_STYLE.sizePx,
      syntaxTheme,
      getHandle: () => controller?.current?.handle,
      requestHighlight: async (first: number, count: number) => {
        const handle = controller?.current?.handle;
        if (handle === undefined) return { revision: -1, first: 0, lines: [] };
        return bridge.highlight!(handle, first, count);
      },
      minimapFirstLine: () => minimap.firstLine() ?? 0,
      getCaretLine: () => {
        const cur = controller?.current;
        return cur === undefined ? 0 : cur.source.positionAt(cur.caret).line;
      },
    });
    // Cleanup no fechamento da janela
    window.addEventListener("beforeunload", () => loupeBinding.dispose());
  }

  // Toggle tema (Ctrl+Shift+T): casca (CSS vars) e canvas (`THEME.current`) trocam juntos.
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const next = THEME.current.kind === "dark" ? LIGHT_THEME : DARK_THEME;
    THEME.current = next;
    saveTheme(next);
    syntaxTheme = createSyntaxTheme(next.kind);
    atlasTinter.clear(); // as cores mudaram: as cópias tingidas ficariam com a paleta antiga
    applyChromeTheme(next);
    renderer.start(); // repinta canvas E minimap com a paleta nova
  });

  // ── Casca: rail de atividades, painel lateral e atalhos de layout ────────────────────────────
  //
  // O clique na rail: o botão **ativo** alterna o sidebar (abre/fecha, estilo VS Code); um
  // botão **inativo** abre o sidebar na sua seção.
  //
  // ⚠️ O *toggle* só dispara com a seção **visível** (`activeSection`): no boot nenhuma
  // seção está no host ⇒ o 1º clique no *Explorer* **abre** a seção (a árvore aparece) em
  // vez de **fechar** a sidebar (o defeito: a árvore só aparecia no 2º clique).
  const activateSection = (section: SidebarSection): void => {
    // O *grep* é uma seção da sidebar: trocar de seção fecha o painel de busca.
    const wasSearching = searchController.isOpen();
    if (wasSearching) searchController.close();
    if (!wasSearching && activeSection === section && sidebar?.hidden === false) {
      setSidebarVisible(false);
      return;
    }
    showSidebarSection(section);
  };

  document.getElementById("activity-explorer")?.addEventListener("click", () => {
    activateSection("explorer");
  });
  document.getElementById("activity-outline")?.addEventListener("click", () => {
    activateSection("outline");
  });

  document.getElementById("activity-search")?.addEventListener("click", () => {
    // ⚠️ A busca precisa **focar o input** (o botão focava o canvas ⇒ digitar inseria no
    // documento em vez do campo de busca).
    findBar?.model.open();
    const findInput = document.getElementById("find-input");
    if (findInput instanceof HTMLInputElement) findInput.focus();
  });
  document.getElementById("activity-palette")?.addEventListener("click", () => {
    // ⚠️ Pelo **mesmo** caminho do atalho `Ctrl+Shift+P`: a paleta abre **focando o input**
    // (o botão chamava `palette.model.open()` direto e o input não recebia o foco).
    openers.openPalette();
  });
  document.getElementById("activity-grep")?.addEventListener("click", () => {
    // A busca em **todos os arquivos** (o "grep") — o mesmo caminho do `Ctrl+Shift+F`.
    // (O grep é uma **seção** da sidebar: o workbench troca a seção visível — ver
    // `onSectionOpen` em `createWorkspaceSearchController`.)
    openers.openSearchPanel();
  });

  // ── Problems / Source Control / Diff: os três painéis da barra lateral ──────────────────────
  //
  // Os **módulos** (`problems-panel.ts`, `source-control.ts`, `diff-view.ts`) são
  // autocontidos: desenham o estado e emitem **intenções**. Quem **executa** a intenção é o
  // renderer (IPC → `main` → LSP/`git`) e quem **reflete** o estado é a status bar.
  //
  // ⚠️ Todo método novo da ponte é **opcional** (`bridge.gitX?.(...)`): um preload mais antigo
  // ⇒ a seção fica vazia (sem erro, sem crash).

  // ── Problems: os diagnósticos do LSP (painel + badge da status bar) ─────────────────────────
  /**
   * Traduz os diagnósticos por **handle** em entradas por **caminho** (o painel agrupa por
   * arquivo). Diagnóstico de um documento **sem sessão** fica pendente (é resolvido quando o
   * documento abre — o refresh acontece na troca de documento).
   */
  const buildProblemEntries = (): readonly ProblemEntry[] => {
    const entries: ProblemEntry[] = [];
    for (const session of controller?.openSessions ?? []) {
      const diagnostics = diagnosticsByHandle.get(session.handle);
      if (diagnostics === undefined || diagnostics.length === 0) continue;
      entries.push(...problemEntries(session.path, diagnostics));
    }
    return entries;
  };

  const problemsPanel: ProblemsPanelHandle = mountProblemsPanel(
    document.getElementById("problems-panel-host"),
    {
      // `line`/`column` são **0-based** (a convenção do core).
      onJump: (file: string, line: number, column: number): void => {
        void openFileAt(file, line, column);
      },
      onClose: (): void => {
        showSidebarSection("explorer");
      },
    },
  );

  /**
   * Repinta o painel de problemas (e o badge da status bar).
   *
   * ⚠️ O **modelo** é sempre atualizado (é ele que alimenta o badge da status bar — que é
   * visível com o painel fechado). O **DOM** do painel só é reescrito com a seção
   * **visível**: a lista chega a cada evento de diagnóstico e o painel re-renderiza o
   * DOM inteiro ⇒ com a seção escondida é trabalho jogado fora. O painel é atualizado
   * quando ele **abre** (ver `showSidebarSection`).
   */
  const refreshProblems = (): void => {
    const entries = buildProblemEntries();
    problemsPanel.model.setDiagnostics(entries);
    setProblemsBadge(problemsPanel.model.counts);
    if (activeSection !== "problems") return;
    problemsPanel.update(entries);
  };
  problemsBridge.refresh = refreshProblems;

  // ── O documento aberto no BOOT ─────────────────────────────────────────────────────────────
  //
  // ⚠️ O `open` inicial (o `?file=` do boot) roda **antes** do `onActiveDocumentChanged`
  // existir ⇒ o handler **nunca** foi chamado para aquele documento ⇒ o Outline dizia
  // "Nenhum símbolo neste documento" e o Problems ficava vazio.
  //
  // O documento do boot recebe **o mesmo tratamento** dos demais (ver `syncBootDocument`).
  const diagnosticsOf = bridge?.diagnostics;
  syncBootDocument<TabSession>({
    session: controller?.current,
    onActiveDocumentChanged:
      controller === undefined
        ? undefined
        : (session: TabSession): void => controller.onActiveDocumentChanged?.(session),
    diagnostics:
      diagnosticsOf === undefined
        ? undefined
        : (handle: number): Promise<readonly LspDiagnostic[]> => diagnosticsOf(handle),
    onDiagnostics: (handle: number, diagnostics: readonly LspDiagnostic[]): void => {
      diagnosticsByHandle.set(handle, diagnostics);
      refreshProblems();
    },
    onError: (error: unknown): void => {
      console.warn("Scribe: falha ao buscar os diagnósticos do documento do boot", error);
    },
  });
  // ── Source Control: o painel de git ─────────────────────────────────────────────────────────
  //
  // As ações são **declarações de função** (não arrows): o painel e os helpers se referenciam
  // mutuamente (o hoisting evita o *TDZ* — nenhum deles roda antes do boot terminar).

  /**
   * Mostra uma falha de git na UI — **mensagem amigável** (1 linha, sem stack).
   *
   * A mensagem também vai para a status bar (o padrão da casca: `setDocStatus`).
   */
  function showGitError(error: unknown): void {
    const message = friendlyMessage(error, "falha na operação de git");
    sourceControlPanel.setError(message);
    setDocStatus(message);
    console.warn("Scribe: falha na operação de git", error);
  }

  /** Mostra um aviso no painel (ex.: "commit indisponível" — preload antigo). */
  function showGitMessage(message: string): void {
    sourceControlPanel.setError(message);
    setDocStatus(message);
  }

  /** Aplica o status novo no painel (entradas + branch) e no badge da status bar. */
  function applyGitStatus(status: GitStatusResult): void {
    sourceControlPanel.update(status.entries);
    sourceControlPanel.setBranch(status.branch ?? "");
    setGitBadge(status.branch, sourceControlPanel.model.counts);
  }

  /**
   * Token das **requisições** de status (`git status` a solo) — descarta a resposta que
   * não for a mais recente.
   *
   * ⚠️ O `git status` é um **processo**: dois em voo podem resolver **fora de ordem** (o
   * mais lento pode ser o mais recente) ⇒ o status velho sobrescrevia o novo. O token é
   * monotônico: só a última requisição aplica o resultado (o mesmo padrão do `signalId`
   * do `searchController`).
   */
  let gitStatusToken = 0;
  /**
   * Token das **ações** de git (`stage`/`unstage`/…).
   *
   * A ação devolve o status **novo** ⇒ ela **sempre** vence um `git status` que estava em
   * voo (aquele `git status` rodou **antes** da mutação) — só outra ação mais recente
   * pode descartá-la.
   */
  let gitActionToken = 0;

  /** Recarrega o status do repositório (a fonte da verdade é o `git status`). */
  async function refreshGitStatus(): Promise<void> {
    if (bridge?.gitStatus === undefined) return;
    const token = ++gitStatusToken;
    const actionAtIssue = gitActionToken;
    try {
      const status = await bridge.gitStatus(gitRepoRoot);
      // Resposta obsoleta: outra requisição mais recente — ou uma **ação** que começou
      // depois (o status dela é mais novo).
      if (token !== gitStatusToken) return;
      if (actionAtIssue !== gitActionToken) return;
      applyGitStatus(status);
    } catch (error: unknown) {
      if (token !== gitStatusToken) return;
      if (actionAtIssue !== gitActionToken) return;
      showGitError(error);
    }
  }

  /**
   * Executa uma ação de git e **re-atalha o status** (o `git status` é a fonte da verdade).
   *
   * `undefined` no retorno ⇒ o preload não expõe o método ⇒ degrade sem crash.
   */
  async function runGitAction(
    action: (root: string | undefined) => Promise<GitStatusResult | undefined>,
    unavailableMessage: string,
  ): Promise<void> {
    // A ação devolve o status **novo** ⇒ o `refreshGitStatus` redundante sai (2 processos
    // git por clique viravam 1). O status da ação **vence** qualquer `git status` em
    // voo (aquele rodou antes da mutação) — só outra ação mais recente o descarta.
    const token = ++gitActionToken;
    let status: GitStatusResult | undefined;
    try {
      status = await action(gitRepoRoot);
    } catch (error: unknown) {
      showGitError(error);
      return;
    }
    if (status === undefined) {
      showGitMessage(unavailableMessage);
      return;
    }
    if (token !== gitActionToken) return; // outra ação começou depois
    applyGitStatus(status);
  }

  /**
   * Resolve a raiz do **repositório** (a 1ª raiz efetiva do `workspace.files`).
   *
   * O `main` expande as raízes candidatas até a pasta com `.git` ⇒ a 1ª raiz **é** a raiz do
   * repositório. Sem ela, o `main` resolve a raiz do documento ativo — mas o *renderer* precisa
   * do caminho **absoluto** do arquivo (para o "pular" do diff abrir o arquivo certo).
   */
  async function ensureGitRepoRoot(): Promise<void> {
    if (gitRepoRoot !== undefined) return;
    if (bridge?.workspaceFiles === undefined) return;
    const roots = workspaceRootsOf(controller?.openSessions ?? []);
    try {
      const result = await bridge.workspaceFiles(roots);
      const first = result.roots?.[0];
      if (first !== undefined) gitRepoRoot = first;
    } catch (error: unknown) {
      console.warn("Scribe: falha ao resolver a raiz do repositório", error);
    }
  }

  /**
   * Junta um caminho **relativo ao repositório** com a raiz do repo (vira absoluto).
   *
   * ⚠️ `undefined` = **não há raiz absoluta** (a raiz do repositório é desconhecida): o
   * caminho relativo **não** pode virar o path do diff — o "pular" abriria o arquivo
   * contra o *cwd* do processo (o arquivo **errado**). Nesse caso o `main` ainda resolve
   * o relativo (é ele que sabe a raiz do repositório do documento ativo).
   */
  function resolveRepoPath(relative: string): string | undefined {
    if (relative.startsWith("/")) return relative;
    const root = gitRepoRoot;
    if (root === undefined) return undefined;
    const separator = root.endsWith("/") ? "" : "/";
    return `${root}${separator}${relative}`;
  }

  // ── Diff: o visualizador de diferenças ─────────────────────────────────────────────────────
  /** O caminho **absoluto** do arquivo que o diff mostra (o "pular" abre este arquivo). */
  let diffFilePath: string | undefined;

  /**
   * Abre o diff de um arquivo (o clique numa linha do *Source Control*).
   *
   * Diff vazio ⇒ o painel mostra "Sem alterações" (é o estado do módulo, não um erro).
   */
  async function openDiffFor(path: string): Promise<void> {
    // A raiz do repositório é resolvida **aqui** (e não no `git status`): sem ela, o
    // caminho do "pular" não seria absoluto e o `main` abriria o arquivo errado.
    await ensureGitRepoRoot();
    const absolute = resolveRepoPath(path);
    // ⚠️ **Só** um caminho **absoluto** vira o path do diff: com a raiz desconhecida, o
    // "pular" abriria o arquivo contra o *cwd* do processo (o arquivo **errado**). O
    // diff **abre** (o `main` resolve o relativo), mas o "pular" não tem path.
    diffFilePath = absolute;
    if (absolute === undefined) {
      // Aviso **claro** na status bar (o diff abre; o "pular" não tem path absoluto).
      setDocStatus("raiz do repositório desconhecida: o diff abre, mas o “pular” não abre o arquivo");
      console.warn("Scribe: raiz do repositório desconhecida — o diff não tem path absoluto");
    }
    if (bridge?.gitDiffText === undefined) {
      showGitMessage("diff indisponível");
      diffView.update([]);
      showSidebarSection("diff");
      return;
    }
    try {
      // O `main` sabe resolver o caminho **relativo** (a raiz do repositório do documento
      // ativo) — o absoluto é preferível, mas o relativo também funciona.
      const text = await bridge.gitDiffText(absolute ?? path);
      diffView.update(parseUnifiedDiff(text));
      showSidebarSection("diff");
    } catch (error: unknown) {
      showGitError(error);
    }
  }

  const diffView: DiffViewHandle = mountDiffView(document.getElementById("diff-view-host"), {
    // A linha do diff é **1-based** (do arquivo novo) ⇒ o editor é 0-based.
    onJump: (line: number): void => {
      const path = diffFilePath;
      if (path === undefined) return;
      void openFileAt(path, line - 1, 0);
    },
    onClose: (): void => {
      showSidebarSection("source-control");
    },
  });

  const sourceControlPanel: SourceControlPanelHandle = mountSourceControlPanel(
    document.getElementById("source-control-host"),
    {
      onStage: (path: string): void => {
        void runGitAction(
          async (root) => bridge?.gitStage?.(path, root),
          "preparar arquivo indisponível",
        );
      },
      onUnstage: (path: string): void => {
        void runGitAction(
          async (root) => bridge?.gitUnstage?.(path, root),
          "desfazer a preparação indisponível",
        );
      },
      onStageAll: (): void => {
        void runGitAction(
          async (root) => bridge?.gitStageAll?.(root),
          "preparar tudo indisponível",
        );
      },
      onCommit: (message: string): void => {
        void (async (): Promise<void> => {
          const result = await bridge?.gitCommit?.(message, gitRepoRoot);
          if (result === undefined) {
            showGitMessage("commit indisponível");
            return;
          }
          if (result.ok !== true) {
            // Falha: a mensagem de commit **fica** (o usuário corrige e tenta de novo).
            const reason = friendlyMessage(result.error, "falha no commit");
            sourceControlPanel.setError(reason);
            setDocStatus(reason);
            console.warn("Scribe: commit recusado pelo git", reason);
            return;
          }
          sourceControlPanel.setError(null);
          sourceControlPanel.clearCommitMessage();
          await refreshGitStatus();
        })().catch((error: unknown) => {
          showGitError(error);
        });
      },
      onSelect: (path: string): void => {
        void openDiffFor(path);
      },
      onRefresh: (): void => {
        void refreshGitStatus();
      },
    },
  );
  sourceControlBridge.refresh = () => {
    void refreshGitStatus();
  };

  // O painel já nasce com o que o LSP publicou durante o boot.
  refreshProblems();

  // A rail: as seções *problems* e *source-control* (o mesmo contrato do *explorer*/*outline*).
  document.getElementById("activity-problems")?.addEventListener("click", () => {
    activateSection("problems");
  });
  document.getElementById("activity-source-control")?.addEventListener("click", () => {
    activateSection("source-control");
  });

  // O badge da status bar abre a seção correspondente (mesmo padrão do botão da rail).
  const statusErrors = document.getElementById("status-errors");
  if (statusErrors !== null) {
    const openProblems = (): void => {
      activateSection("problems");
    };
    statusErrors.addEventListener("click", openProblems);
    statusErrors.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openProblems();
    });
  }
  const statusGit = document.getElementById("status-git");
  if (statusGit !== null) {
    const openSourceControl = (): void => {
      activateSection("source-control");
    };
    statusGit.addEventListener("click", openSourceControl);
    statusGit.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openSourceControl();
    });
  }

  // Seção do painel: colapsa/expande a lista de documentos abertos.
  const sectionToggle = document.getElementById("sidebar-section-toggle");
  sectionToggle?.addEventListener("click", () => {
    const collapsed = sectionToggle.getAttribute("aria-expanded") === "true";
    sectionToggle.setAttribute("aria-expanded", String(!collapsed));
    const list = document.getElementById("sidebar-editors");
    if (list) list.hidden = collapsed;
  });

  // Ctrl+B: alterna o painel (convenção de editores) — a **seção** não muda.
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "b" || event.key === "B")
    ) {
      event.preventDefault();
      setSidebarVisible(sidebar?.hidden ?? true);
    }
  });

  // Undo/redo do rodapé: mesmos comandos do menu (antes eram apenas indicadores, sem handler).
  document.getElementById("status-undo")?.addEventListener("click", () => handleMenuAction("edit.undo"));
  document.getElementById("status-redo")?.addEventListener("click", () => handleMenuAction("edit.redo"));

  // Abrir/fechar o painel muda a largura do canvas SEM resize de janela: o observer cobre os dois.
  new ResizeObserver(resizeSurface).observe(surface);

  window.addEventListener("resize", resizeSurface);
  // A rail é sincronizada com o que está **exibido**: no boot nenhuma seção está no host
  // (o painel mostra só a lista de "Abertos") ⇒ nenhum botão nasce marcado — o 1º clique
  // no *Explorer* **abre** a seção.
  syncRail();
  renderer.start();
  return true;
}

function assertiveContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível no #editor-surface");
  return ctx;
}

/**
 * Ligação find bar ↔ renderer: o modelo puro + a sincronização de documento ativo (abrir um
 * arquivo troca o alvo; o modelo precisa saber para descartar respostas do documento anterior).
 */
export interface FindBarBinding {
  readonly model: FindBarModel;
  /** Re-sincroniza documento/revisão ativos (após abrir arquivo e antes de buscar). */
  syncDocument(): void;
  /**
   * Desfaz a ligação: cancela o debounce pendente, remove a assinatura de
   * `onDocumentChanged` e descarta o modelo. Chamado no teardown do renderer.
   */
  dispose(): void;
}

interface FindBarDeps {
  readonly bridge: ScribeBridge;
  readonly controller: DocumentController;
  readonly source: DocumentLineSource;
  readonly viewport: ViewportImpl;
  readonly renderer: ScribeRenderer;
  readonly surface: HTMLCanvasElement;
}

/**
 * Liga o `FindBarModel` ao DOM. Devolve `undefined` quando a ponte não expõe `find`/`replaceAll`
 * (preload antigo) ou falta markup — degradação **explícita** (um log), nunca crash (DEC-TR-7).
 * Toda a lógica (debounce injetado, navegação, descarte de resposta obsoleta) vive no modelo puro.
 */
export function attachFindBar(deps: FindBarDeps): FindBarBinding | undefined {
  const find = deps.bridge.find;
  const replaceAll = deps.bridge.replaceAll;
  const bar = document.getElementById("find-bar");
  const input = document.getElementById("find-input");
  const count = document.getElementById("find-count");
  const replaceInput = document.getElementById("find-replace-input");
  const replaceButton = document.getElementById("find-replace-all");
  const status = document.getElementById("find-status");
  const closeButton = document.getElementById("find-close");
  const caseBtn = document.getElementById("find-case");
  const regexBtn = document.getElementById("find-regex");
  const wordBtn = document.getElementById("find-word");
  if (
    find === undefined ||
    replaceAll === undefined ||
    bar === null ||
    !(input instanceof HTMLInputElement) ||
    count === null ||
    !(replaceInput instanceof HTMLInputElement) ||
    !(replaceButton instanceof HTMLButtonElement) ||
    status === null ||
    !(closeButton instanceof HTMLButtonElement)
  ) {
    console.info("Scribe: find bar desligada (ponte sem busca ou markup ausente)");
    return undefined;
  }

  const currentHandle = (): number | undefined => deps.controller.current?.handle;

  const api: FindBarApi = {
    find: (query: SearchQuery): Promise<SearchDocumentResult> => {
      const handle = currentHandle();
      if (handle === undefined) {
        // A barra mostra só o texto curto ("Nenhum arquivo aberto"); a string interna fica
        // no tooltip (`title`) e no console — nunca vaza para a tela.
        return Promise.reject(
          new FindBarError("Nenhum arquivo aberto", "Scribe: nenhum documento aberto para buscar"),
        );
      }
      return find.call(deps.bridge, handle, query);
    },
    replaceAll: (query: SearchQuery, replacement: string): Promise<ReplaceAllResult> => {
      const handle = currentHandle();
      if (handle === undefined) {
        return Promise.reject(
          new FindBarError(
            "Nenhum arquivo aberto",
            "Scribe: nenhum documento aberto para substituir",
          ),
        );
      }
      return replaceAll.call(deps.bridge, handle, query, replacement);
    },
  };

  let currentDocKey = "";
  const renderState = (state: FindBarState): void => {
    bar.hidden = !state.open;
    // Fechar a find bar devolve o foco ao canvas (o input da barra took o foco).
    if (!state.open) focusEditorSurface();
    count.textContent = `${state.current}/${state.total}${state.truncated ? "+" : ""}`;
    // A barra mostra o **texto curto** do status; o detalhe técnico fica no tooltip (`title`).
    status.textContent = state.status ?? "";
    status.title = state.statusDetail ?? "";
    // Empurra os matches pro renderer pintar no canvas (P3.11).
    if (state.open && model.allMatches.length > 0) {
      deps.renderer.setSearchMatches({
        matches: model.allMatches,
        currentIndex: model.currentMatchIndex,
      });
      // Atualiza dados do minimap para marcadores de busca
      deps.renderer.minimapSearchMatches = model.allMatches;
      deps.renderer.minimapSearchCurrentIndex = model.currentMatchIndex;
    } else {
      deps.renderer.setSearchMatches(undefined);
      deps.renderer.minimapSearchMatches = undefined;
      deps.renderer.minimapSearchCurrentIndex = undefined;
    }
    // Dispara um novo frame pra pintar os destaques.
    deps.renderer.start();
    // Botões de toggle: estado ativo dos toggles de busca. O `aria-pressed` é sincronizado
    // junto com a classe `.active` — o atributo inicial vem do HTML, mas quem manda é o
    // estado real (teclado, clique ou `Ctrl+Alt+C/R/W`).
    syncToggleButton(caseBtn, state.caseSensitive);
    syncToggleButton(regexBtn, state.regex);
    syncToggleButton(wordBtn, state.wholeWord);
  };

  // Selecionar uma ocorrência move o caret (coluna do início) e rola até a linha dela.
  const moveCaretTo = (match: SearchMatch): void => {
    const session = deps.controller.current;
    if (session === undefined) return;
    const offset = Math.min(match.index, session.source.text.length);
    session.caret = offset;
    // A seleção também anda: é dela que o renderer tira a posição do **caret** desenhado
    // (sem isto, a barra do cursor ficava no lugar antigo enquanto a status bar mostrava
    // a linha da ocorrência).
    session.selection = SelectionOps.collapsed(offset);
    session.selections = SelectionSetOps.singular(offset);
    deps.renderer.setSelection(session.selection);
    deps.renderer.setSelections(session.selections);
    updateCaretStatus(session.source, session.caret);
    deps.viewport.scrollTo(match.line);
    deps.renderer.start();
  };

  const model = new FindBarModel({
    api,
    schedule: createDebounceScheduler(),
    onChange: renderState,
    onSelect: moveCaretTo,
  });

  const syncDocument = (): void => {
    const session = deps.controller.current;
    if (session === undefined) return;
    currentDocKey = documentHighlightKey(session.handle);
    model.setDocument(currentDocKey, session.source.revision);
  };

  const openFind = (): void => {
    syncDocument();
    model.open();
    input.focus();
    input.select();
  };

  input.addEventListener("input", () => model.setPattern(input.value));
  replaceInput.addEventListener("input", () => model.setReplacement(replaceInput.value));
  replaceButton.addEventListener("click", () => void model.replaceAll());
  closeButton.addEventListener("click", () => {
    model.close();
    deps.surface.focus();
  });
  caseBtn?.addEventListener("click", () => model.toggleCaseSensitive());
  regexBtn?.addEventListener("click", () => model.toggleRegex());
  wordBtn?.addEventListener("click", () => model.toggleWholeWord());
  bar.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      model.close();
      deps.surface.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) model.previous();
      else model.next();
    }
  });
  // Ctrl/Cmd+F em qualquer lugar da janela: a barra pode estar focada, não só o canvas.
  //
  // ⚠️ `!event.shiftKey`: o **Ctrl+Shift+F** é a busca em **todos os arquivos** (o "grep") —
  // sem esta guarda, o `Ctrl+F` abriria a find bar do documento **e** o grep.
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (event.key === "f" || event.key === "F")
    ) {
      event.preventDefault();
      openFind();
      return;
    }
    // Toggle tema: Ctrl+Shift+T
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.key === "t" || event.key === "T")) {
      event.preventDefault();
      document.getElementById("theme-toggle")?.click();
      return;
    }
    // Ctrl+Alt+C/R/W alterna os toggles de busca de qualquer lugar da janela.
    if ((event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey) {
      if (event.key === "c" || event.key === "C") {
        event.preventDefault();
        model.toggleCaseSensitive();
        return;
      }
      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        model.toggleRegex();
        return;
      }
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        model.toggleWholeWord();
        return;
      }
    }
  });
  // Edição muda a revisão: o modelo descarta a resposta de revisão superada e refaz a contagem.
  const unsubscribeOnDocChanged = deps.bridge.onDocumentChanged((event) => {
    const session = deps.controller.current;
    if (session === undefined || event.handle !== session.handle) return;
    currentDocKey = documentHighlightKey(session.handle);
    model.setDocument(currentDocKey, event.revision);
  });

  syncDocument();
  renderState(model.state());
  return {
    model,
    syncDocument,
    dispose: (): void => {
      model.dispose();
      unsubscribeOnDocChanged();
    },
  };
}

/**
 * Os **abridores** de overlay do editor.
 *
 * A paleta, o *Quick Open* e o painel de busca são **mutuamente exclusivos**: só um fica
 * visível por vez (é a mesma regra dos popups de contexto).
 */
export interface EditorOpeners {
  /** Abre a paleta de comandos (`Ctrl+Shift+P`). */
  readonly openPalette: () => void;
  /** Abre o *Quick Open* (`Ctrl+P`): arquivos, comandos e recentes. */
  readonly openQuickOpen: () => void;
  /** Abre o painel de busca em todos os arquivos (`Ctrl+Shift+F`). */
  readonly openSearchPanel: () => void;
}

/**
 * Liga os listeners de entrada (teclado, mouse, roda) do editor.
 *
 * Devolve os **abridores** de overlay (a paleta, o *Quick Open* e o painel de busca): os
 * botões da rail de atividades usam o **mesmo** caminho dos atalhos — abrir por eles também
 * foca o input (e fecha os popups de contexto, que se sobrepunham ao overlay).
 */
function attachInputListeners(
  surface: HTMLCanvasElement,
  viewport: ViewportImpl,
  renderer: ScribeRenderer,
  controller: DocumentController | undefined,
  findBar: FindBarBinding | undefined,
  palette: CommandPaletteBinding | undefined,
  bridge: ScribeBridge | undefined,
  completion: CompletionPopupBinding,
  hoverTooltip: HoverTooltipBinding,
  signatureHelpPopup: SignatureHelpBinding,
  documentSymbolsPopup: DocumentSymbolsBinding,
  referencesPopup: ReferencesPopupBinding,
  /** Snippets de pacote por trigger (lowercased) — cacheados no boot (ver `bootRenderer`). */
  packageSnippets: PackageSnippetIndex,
  /** Painel de busca na workspace (o "grep"). */
  search: WorkspaceSearchController,
  /** Executa um comando pela UI (a paleta e o *Quick Open* compartilham o caminho). */
  executeCommand: (commandId: string) => void,
): EditorOpeners {
  const lineHeight = Math.ceil(TEXT_STYLE.sizePx * 1.4);

  // Os popups de contexto num lugar só — para garantir exclusividade (um por vez).
  const popups: ContextPopups = {
    completion,
    hoverTooltip,
    signatureHelp: signatureHelpPopup,
    references: referencesPopup,
    documentSymbols: documentSymbolsPopup,
  };

  surface.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      // ⚠️ A rolagem é contada em **rows visuais**, não em linhas lógicas: com soft wrap,
      // 1 tick da roda movia N rows (o texto "p pulava"). `scrollByRows` move 3 rows.
      viewport.scrollByRows(Math.sign(event.deltaY) * 3, { animate: true });
      scheduleInlayHintRefresh();
    },
    { passive: false },
  );

  let mouseDragAnchor: number | undefined;

  // Debounced refresh de inlay hints ao scrollar (P4#19).
  let inlayHintScrollTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleInlayHintRefresh = (): void => {
    if (controller === undefined) return;
    clearTimeout(inlayHintScrollTimer);
    inlayHintScrollTimer = setTimeout(() => {
      inlayHintScrollTimer = undefined;
      const s = controller.current;
      if (s !== undefined && bridge !== undefined && bridge.inlayHints !== undefined) {
        void fetchInlayHints(s, bridge, renderer, viewport);
      }
    }, 200);
  };

  // ── Overlays de aplicação (exclusivos entre si) ───────────────────────────────────────────
  //
  // A find bar, a paleta, o *Quick Open* e o painel de busca **não coexistem**: abrir um
  // fecha os outros (a mesma regra dos popups de contexto).

  /** Fecha a find bar (se estiver aberta). */
  const closeFindBar = (): void => {
    if (findBar !== undefined && findBar.model.isOpen) {
      findBar.model.close();
    }
  };

  // Command palette: Ctrl+Shift+P interceptado antes de chegar ao canvas.
  const openPalette = (): void => {
    if (palette === undefined) return;
    // Se o find bar estiver aberto, fecha ele primeiro
    closeFindBar();
    // O *Quick Open* e o painel de busca também saem de cena (exclusividade).
    hideQuickOpen();
    search.close();
    // ⚠️ Os popups de **contexto** (símbolos × paleta se sobrepunham) são fechados antes
    // de a paleta abrir — a exclusividade é a mesma dos popups entre si.
    closeContextPopups(popups);
    void palette.model.open().then(() => {
      const input = document.getElementById("palette-input");
      if (input instanceof HTMLInputElement) input.focus();
    });
  };

  /**
   * As **raízes efetivas** da workspace (as que o `main` varreu) — habilitam o item
   * "criar arquivo" do ⌘P.
   *
   * `undefined` = ainda não sabemos (o preload antigo não devolve as raízes) ⇒ o item
   * "criar" usa as pastas dos documentos abertos (`workspaceRootsOf`).
   */
  let quickOpenRoots: readonly string[] | undefined;

  /**
   * A pasta do **documento ativo** — a base do item "criar arquivo" do ⌘P.
   *
   * O VS Code cria o arquivo **ao lado** do arquivo aberto (a base é a pasta do documento
   * ativo, **não** a raiz da workspace). Sem documento ativo: `undefined` (o chamador usa
   * a 1ª raiz).
   */
  const quickOpenBaseDir = (): string | undefined => {
    const path = controller?.current?.path;
    if (path === undefined) return undefined;
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (cut < 0) return undefined;
    if (cut === 0) return path.startsWith("/") ? "/" : undefined;
    return path.slice(0, cut);
  };

  /**
   * As fontes dos itens do *Quick Open* (a ponte).
   *
   * O índice de arquivos é **opcional**: um preload mais antigo não o expõe ⇒ o *Quick
   * Open* mostra só comandos e recentes (degradação explícita, sem crash).
   */
  const quickOpenSources: QuickOpenSources | undefined = ((): QuickOpenSources | undefined => {
    if (bridge === undefined) return undefined;
    const workspaceFiles = bridge.workspaceFiles;
    return {
      listCommands: () => bridge.listCommands(),
      ...(workspaceFiles !== undefined
        ? {
            workspaceFiles: async (roots: readonly string[]): Promise<WorkspaceFilesResult> => {
              const result = await workspaceFiles.call(bridge, roots);
              // O `main` devolve as raízes **efetivas** (as que ele varreu) — elas são as
              // que confinam o "criar arquivo". Sem elas (preload antigo), valem as pastas
              // dos documentos abertos (o que o renderer pediu).
              quickOpenRoots = result.roots ?? roots;
              return result;
            },
          }
        : {}),
    };
  })();

  /**
   * Executa o item escolhido no *Quick Open* (comando ⇒ executa; arquivo ⇒ abre;
   * "criar" ⇒ **cria** o arquivo e abre).
   */
  const handleQuickOpenPick = (item: QuickOpenItem): void => {
    if (!isQuickOpenPayload(item.payload)) return;
    if (item.payload.kind === "command") {
      // O popup **já** devolveu o foco ao canvas antes do `onPick` — não refocus aqui
      // (um comando que abre um overlay — o "find.open" — precisa manter o foco dele).
      executeCommand(item.payload.id);
      return;
    }
    if (item.payload.kind === "create") {
      // "Criar arquivo": o `main` cria o arquivo (confinado à raiz da workspace; nunca
      // sobrescreve um existente) e o renderer abre o documento novo.
      if (bridge === undefined || bridge.createFile === undefined) {
        // Preload antigo: degradação **explícita** (sem crash).
        setDocStatus("criar arquivo indisponível");
        return;
      }
      const createFile = bridge.createFile;
      const path = item.payload.path;
      void createFile
        .call(bridge, path)
        .then(() => {
          void controller?.open(path);
        })
        .catch((error: unknown) => {
          console.error("Scribe: falha ao criar o arquivo", error);
          setDocStatus(
            `erro ao criar o arquivo: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return;
    }
    void controller?.open(item.payload.path);
  };

  /**
   * Pré-visualização do item selecionado (o conteúdo do arquivo).
   *
   * Só há pré-visualização para os **documentos já abertos** (a ponte não expõe a leitura de
   * um arquivo arbitrário) — o resto devolve `undefined` (o popup esconde a prévia).
   */
  const loadQuickOpenPreview = async (item: QuickOpenItem): Promise<string | undefined> => {
    const payload = item.payload;
    if (!isQuickOpenPayload(payload) || payload.kind !== "file") return undefined;
    if (bridge === undefined) return undefined;
    const session = controller?.openSessions.find((s) => s.path === payload.path);
    if (session === undefined) return undefined;
    try {
      return await bridge.text(session.handle);
    } catch (error: unknown) {
      console.warn("Scribe: falha ao carregar a pré-visualização do Quick Open", error);
      return undefined;
    }
  };

  /** Quick Open (Ctrl+P): arquivos, comandos e recentes. */
  const openQuickOpen = (): void => {
    closeFindBar();
    palette?.model.close();
    hideQuickOpen();
    search.close();
    closeContextPopups(popups);
    // Os itens chegam por IPC (comandos + índice da workspace): o popup abre assim que
    // chegam (a lista vazia também é uma resposta válida).
    void (async () => {
      const sessions = controller?.openSessions ?? [];
      // As raízes são revalidadas a cada abertura (o `main` pode ter expandido a pasta).
      quickOpenRoots = undefined;
      const items = await collectQuickOpenItems(quickOpenSources, sessions);
      const roots = quickOpenRoots ?? workspaceRootsOf(sessions);
      // A base do item "criar arquivo": a **pasta do documento ativo** (o VS Code cria ao
      // lado do arquivo aberto) — sem documento ativo, a 1ª raiz.
      const baseDir = quickOpenBaseDir() ?? roots[0];
      // ⚠️ O objeto é montado **fora** da chamada: o `baseDir` só existe no contrato novo
      // do `quick-open.ts` (`createFileCandidate(query, { roots, baseDir })`) — com o
      // módulo antigo a propriedade é simplesmente ignorada (e o TS não reclama do
      // excessivo, porque o literal não é o argumento direto).
      const options = {
        items,
        // As **raízes** habilitam o item "criar arquivo" (é o `quick-open.ts` que o
        // offerta, a cada tecla). Sem elas (preload antigo), valem as pastas dos
        // documentos abertos.
        roots,
        title: "Abrir arquivo, comando ou recente",
        onPick: (item: QuickOpenItem) => handleQuickOpenPick(item),
        onCancel: () => focusEditorSurface(),
        loadPreview: loadQuickOpenPreview,
        ...(baseDir !== undefined ? { baseDir } : {}),
      };
      showQuickOpen(options);
    })();
  };

  /** Painel de busca em todos os arquivos (Ctrl+Shift+F — o "grep"). */
  const openSearchPanel = (): void => {
    closeFindBar();
    palette?.model.close();
    hideQuickOpen();
    closeContextPopups(popups);
    search.open();
  };

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    const primary = event.ctrlKey || event.metaKey;
    if (!primary || event.altKey) return;
    // Ctrl+Shift+P — paleta de comandos.
    if (event.shiftKey && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      openPalette();
      return;
    }
    // Ctrl+Shift+F — busca em todos os arquivos (o "grep").
    if (event.shiftKey && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      openSearchPanel();
      return;
    }
    // Ctrl+P — Quick Open (arquivos, comandos e recentes).
    if (!event.shiftKey && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      openQuickOpen();
    }
  });

  // Scrollbar: mousedown no track/thumb (deve vir antes do mousedown do texto para capturar primeiro).
  surface.addEventListener("mousedown", (event: MouseEvent) => {
    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const sbx = surface.clientWidth - 10; // scrollbarWidth = 10
    if (x < sbx) return; // não é na scrollbar
    event.stopImmediatePropagation();

    const y = event.clientY - rect.top;
    const totalPx = (controller?.current?.source.lineCount() ?? 0) * lineHeight;
    const viewportH = surface.clientHeight;
    if (totalPx <= viewportH) return;

    const ratio = Math.max(0, Math.min(1, y / viewportH));
    const targetLine = Math.round(ratio * (totalPx / lineHeight));
    viewport.scrollTo(targetLine);
    scheduleInlayHintRefresh();
    renderer.start();
  });

  surface.addEventListener("mousedown", (event: MouseEvent) => {
    const session = controller?.current;
    if (session === undefined) return;
    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    // Detecta clique no gutter para folding
    const gutterW = renderer.getGutterWidth?.() ?? 48;
    if (x < gutterW) {
      const y = event.clientY - rect.top;
      const line = renderer.lineAtCanvasY(y);
      if (line >= 0 && session) {
        const folds = foldingStates.get(session.handle);
        if (folds !== undefined) {
          const fold = folds.find((f) => f.startLine === line);
          if (fold !== undefined) {
            const mutableFold = { ...fold, isCollapsed: !fold.isCollapsed };
            const newFolds = folds.map((f) => (f === fold ? mutableFold : f));
            foldingStates.set(session.handle, newFolds);
            // ⚠️ `applyFolding` (e não `setFolding`): ele **reancora o scroll** — o texto
            // não pode saltar ao dobrar/desdobrar.
            renderer.applyFolding(newFolds);
            renderer.start();
            return; // não processa como clique de texto
          }
        }
      }
    }
    const y = event.clientY - rect.top;
    // A linha sob o mouse (com soft wrap, o Y do canvas é uma **row** — o renderer
    // converte para a linha lógica).
    const line = renderer.lineAtCanvasY(y);
    if (line < 0 || line >= session.source.lineCount()) return;
    const text = session.source.line(line);
    const approxCharW = TEXT_STYLE.sizePx * 0.6;
    // Mesma origem do desenho do texto (gutter + padding).
    const col = columnFromPointerX(x, text.length, gutterWidthOf(renderer), approxCharW);
    const offset = session.source.offsetOf(line, col);
    // Snippets (P4#18): clique fora da expansão encerra a sessão ativa (dentro do range —
    // inclusive entre paradas — ela continua viva).
    const activeSnippet = session.snippetSession;
    if (activeSnippet !== undefined) {
      const span = sessionRange(activeSnippet);
      if (offset < span.start || offset > span.end) {
        session.snippetSession = undefined;
        hideSnippetChoice();
      }
    }
    mouseDragAnchor = offset;
    if (event.ctrlKey || event.metaKey) {
      // Ctrl+click: adiciona cursor extra (P2#5)
      const existing = session.selections;
      const already = existing.some((s) => s.active === offset);
      if (!already) {
        session.selections = [...existing, SelectionOps.collapsed(offset)] as SelectionSet;
      }
    } else if (event.shiftKey) {
      session.selection = { anchor: session.selection.anchor, active: offset };
      session.selections = [session.selection] as SelectionSet;
    } else {
      session.selection = SelectionOps.collapsed(offset);
      session.selections = SelectionSetOps.singular(offset);
    }
    session.caret = offset;
    renderer.setSelection(session.selection);
    renderer.setSelections(session.selections);
    updateCaretStatus(session.source, offset);
    renderer.start();
    updateBlame(session, bridge, line);
  });

  surface.addEventListener("mousemove", (event: MouseEvent) => {
    if (mouseDragAnchor === undefined || (event.buttons & 1) === 0) {
      mouseDragAnchor = undefined;
      return;
    }
    const session = controller?.current;
    if (session === undefined) return;
    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const line = renderer.lineAtCanvasY(y);
    if (line < 0) { mouseDragAnchor = undefined; return; }
    const clampedLine = Math.min(line, session.source.lineCount() - 1);
    const text = session.source.line(clampedLine);
    const approxCharW = TEXT_STYLE.sizePx * 0.6;
    // Mesma origem do desenho do texto (gutter + padding).
    const col = columnFromPointerX(x, text.length, gutterWidthOf(renderer), approxCharW);
    const offset = session.source.offsetOf(clampedLine, col);
    session.selection = { anchor: mouseDragAnchor, active: offset };
    // Drag colapsa para seleção única
    session.selections = [session.selection] as SelectionSet;
    session.caret = offset;
    renderer.setSelection(session.selection);
    renderer.setSelections(session.selections);
    updateCaretStatus(session.source, offset);
    renderer.start();
  });

  surface.addEventListener("mouseup", () => {
    mouseDragAnchor = undefined;
  });

  // ── Ctrl+click: go-to-definition ────────────────────────────────────────────────────────────
  surface.addEventListener("click", (event: MouseEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const session = controller?.current;
    if (session === undefined || bridge?.definition === undefined) return;
    const pos = session.source.positionAt(session.caret);
    void (async () => {
      try {
        const loc = await bridge.definition!(session.handle, pos.line, pos.column);
        if (loc === null) return;
        // Se for no mesmo arquivo, navega o caret
        const targetLine = loc.range.startLine;
        const targetCol = loc.range.startCol;
        if (targetLine < session.source.lineCount()) {
          const targetOffset = session.source.offsetOf(targetLine, targetCol);
          session.caret = targetOffset;
          session.selection = { anchor: targetOffset, active: targetOffset };
          session.selections = [session.selection] as SelectionSet;
          viewport.scrollTo(Math.max(0, targetLine - 5));
          renderer.setSelection(session.selection);
          renderer.setSelections(session.selections);
          renderer.start();
        }
        // Para cross-file, logs o URI (expansão futura: abrir o arquivo)
      } catch {
        // Silencia
      }
    })();
  });

  // ── Hover LSP (Ctrl+hover) ──────────────────────────────────────────────────────────────────
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  surface.addEventListener("mousemove", (event: MouseEvent) => {
    // Só dispara hover quando Ctrl/Meta está pressionado
    if (!event.ctrlKey && !event.metaKey) {
      hoverTooltip.hide();
      clearTimeout(hoverTimer);
      return;
    }
    const session = controller?.current;
    if (session === undefined || bridge?.hover === undefined) {
      hoverTooltip.hide();
      return;
    }
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const rect = surface.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const line = renderer.lineAtCanvasY(y);
      if (line < 0 || line >= session.source.lineCount()) return;
      const text = session.source.line(line);
      const approxCharW = TEXT_STYLE.sizePx * 0.6;
      // Mesma origem do desenho do texto (gutter + padding).
      const col = columnFromPointerX(x, text.length, gutterWidthOf(renderer), approxCharW);
      void (async () => {
        try {
          const result = await bridge.hover!(session.handle, line, col);
          if (result === null || result.contents.length === 0) return;
          // Exclusividade: o hover não rouba a tela de outro popup de contexto já aberto.
          if (hasOpenContextPopup(popups)) return;
          hoverTooltip.show(result.contents, event.clientX, event.clientY);
        } catch {
          // Silencia erro de hover
        }
      })();
    }, 300); // debounce de 300ms
  });

  surface.addEventListener("keydown", (event: KeyboardEvent) => {
    const primary = event.ctrlKey || event.metaKey;

    // Ctrl+Space: aciona completação LSP
    if (primary && !event.shiftKey && !event.altKey && event.key === " ") {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined || bridge?.completions === undefined) return;
      const pos = session.source.positionAt(session.caret);
      void (async () => {
        try {
          const items = await bridge.completions!(
            session.handle, pos.line, pos.column,
          );
          if (items.length === 0) return;
          // Posiciona o popup próximo ao cursor
          const lineHeightVal = Math.ceil(TEXT_STYLE.sizePx * 1.4);
          const charW = TEXT_STYLE.sizePx * 0.6;
          const scrollPx = viewport.scrollOffsetPx();
          const gutterDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, session.source.lineCount()))) + 1);
          const gutterW = gutterDigits * 9 + 16;
          const x = (gutterW + 8) + pos.column * charW;
          // Âncora vertical: a **row visual** da linha do caret (com soft wrap, a row de
          // uma linha não é o seu índice).
          const y = (renderer.visualRowOfLine(pos.line) * lineHeightVal - scrollPx + lineHeightVal) + 8;
          // Exclusividade: fecha os popups de contexto abertos (completion, hover, etc.).
          closeContextPopups(popups);
          completion.open(items, (item) => {
            const text = item.insertText ?? item.label;
            void controller?.replaceText(session.caret, 0, text);
          }, x, y);
        } catch (error) {
          console.warn("Scribe: falha ao buscar completação", error);
        }
      })();
      return;
    }

    // F12: go-to-definition
    if (event.key === "F12") {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined || bridge?.definition === undefined) return;
      const pos = session.source.positionAt(session.caret);
      void (async () => {
        try {
          const loc = await bridge.definition!(session.handle, pos.line, pos.column);
          if (loc === null) return;
          const targetLine = loc.range.startLine;
          const targetCol = loc.range.startCol;
          if (targetLine < session.source.lineCount()) {
            const targetOffset = session.source.offsetOf(targetLine, targetCol);
            session.caret = targetOffset;
            session.selection = { anchor: targetOffset, active: targetOffset };
            session.selections = [session.selection] as SelectionSet;
            viewport.scrollTo(Math.max(0, targetLine - 5));
            renderer.setSelection(session.selection);
            renderer.setSelections(session.selections);
            renderer.start();
          }
        } catch {
          // Silencia
        }
      })();
      return;
    }

    // F2 — Rename Symbol
    if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined || bridge?.rename === undefined) return;
      const pos = session.source.positionAt(session.caret);
      const newName = showRenameInput();
      if (newName === null) return;
      void (async () => {
        try {
          const result = await bridge.rename!(session.handle, pos.line, pos.column, newName);
          if (result && result.edits) {
            applyRenameEdits(result, session, controller);
          }
        } catch {
          // Silencia
        }
      })();
      return;
    }

    // Ctrl+Shift+F12 — Find References
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "F12")) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined || bridge?.references === undefined) return;
      const pos = session.source.positionAt(session.caret);
      void (async () => {
        try {
          const refs = await bridge.references!(session.handle, pos.line, pos.column);
          if (refs.length === 0) return;
          // Exclusividade: fecha os popups de contexto abertos antes de abrir este.
          closeContextPopups(popups);
          referencesPopup.open(refs, (loc) => {
            // Se for no mesmo arquivo, navega o caret
            const targetLine = loc.range.startLine;
            const targetCol = loc.range.startCol;
            if (targetLine < session.source.lineCount()) {
              const targetOffset = session.source.offsetOf(targetLine, targetCol);
              session.caret = targetOffset;
              session.selection = { anchor: targetOffset, active: targetOffset };
              session.selections = [session.selection] as SelectionSet;
              viewport.scrollTo(Math.max(0, targetLine - 5));
              renderer.setSelection(session.selection);
              renderer.setSelections(session.selections);
              renderer.start();
            }
          });
        } catch {
          // Silencia
        }
      })();
      return;
    }

    // Ctrl+Shift+I — Formatar documento
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "i" || event.key === "I")) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined || bridge?.formatting === undefined) return;
      void (async () => {
        try {
          const edits = await bridge.formatting!(session.handle);
          if (edits.length === 0) return;
          applyFormattingEdits(edits, session, controller);
        } catch {
          // Silencia
        }
      })();
      return;
    }

    // `(` dispara signature help (quando o LSP suportar)
    if (event.key === "(" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const session = controller?.current;
      if (session === undefined || bridge?.signatureHelp === undefined) return;
      setTimeout(() => {
        const pos = session.source.positionAt(session.caret);
        void (async () => {
          try {
            const help = await bridge.signatureHelp!(session.handle, pos.line, pos.column, "(");
            if (help === null || help.signatures.length === 0) return;
            const lineHeightVal = Math.ceil(TEXT_STYLE.sizePx * 1.4);
            const charW = TEXT_STYLE.sizePx * 0.6;
            const scrollPx = viewport.scrollOffsetPx();
            const gutterDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, session.source.lineCount()))) + 1);
            const gutterW = gutterDigits * 9 + 16;
            const x = (gutterW + 8) + pos.column * charW;
            // Âncora vertical: a **row visual** da linha do caret (com soft wrap, a row de
            // uma linha não é o seu índice).
            const y = (renderer.visualRowOfLine(pos.line) * lineHeightVal - scrollPx + lineHeightVal) + 8;
            // Exclusividade: fecha os popups de contexto abertos antes de abrir este.
            closeContextPopups(popups);
            signatureHelpPopup.show(help, x, y);
          } catch {
            // Silencia falha de signatureHelp
          }
        })();
      }, 0);
    }

    // Ctrl+Shift+O: símbolos do documento
    if (primary && event.shiftKey && !event.altKey && (event.key === "o" || event.key === "O")) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined || bridge?.documentSymbols === undefined) return;
      void (async () => {
        try {
          const symbols = await bridge.documentSymbols!(session.handle);
          if (symbols.length === 0) return;
          // Exclusividade: fecha os popups de contexto abertos antes de abrir este.
          closeContextPopups(popups);
          documentSymbolsPopup.open(symbols, (sym) => {
            if (sym.range.startLine < session.source.lineCount()) {
              const offset = session.source.offsetOf(sym.range.startLine, sym.range.startCol);
              session.caret = offset;
              session.selection = { anchor: offset, active: offset };
              session.selections = [session.selection] as SelectionSet;
              viewport.scrollTo(Math.max(0, sym.range.startLine - 5));
              renderer.setSelection(session.selection);
              renderer.setSelections(session.selections);
              renderer.start();
            }
          });
        } catch {
          // Silencia
        }
      })();
      return;
    }

    // Ctrl+. — Code Actions LSP
    if (primary && !event.shiftKey && !event.altKey && event.key === ".") {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined || bridge?.codeActions === undefined) return;
      const pos = session.source.positionAt(session.caret);
      void (async () => {
        try {
          const actions = await bridge.codeActions!(session.handle, pos.line, pos.column);
          if (actions.length === 0) return;
          // Exclusividade: fecha os popups de contexto abertos (e remove o code actions órfão).
          closeContextPopups(popups);
          showCodeActionsPopup(actions, session, viewport, controller, bridge, renderer);
        } catch (error) {
          console.warn("Scribe: falha ao buscar code actions", error);
        }
      })();
      return;
    }

    // Atalhos de documento: Ctrl/Cmd+O (abrir), Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y
    // (redo) e Esc durante "abrindo…" (cancela a abertura em curso).
    if (primary && !event.altKey && (event.key === "o" || event.key === "O")) {
      event.preventDefault();
      // Abrir troca o documento ativo: re-sincroniza a find bar com o novo alvo.
      if (controller !== undefined) void controller.openDialog().then(() => findBar?.syncDocument());
      return;
    }
    if (primary && !event.altKey && !event.shiftKey && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (controller !== undefined) void controller.undo();
      return;
    }
    if (
      primary &&
      !event.altKey &&
      ((event.shiftKey && (event.key === "z" || event.key === "Z")) ||
        event.key === "y" ||
        event.key === "Y")
    ) {
      event.preventDefault();
      if (controller !== undefined) void controller.redo();
      return;
    }
    if (primary && !event.altKey && !event.shiftKey && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      void controller?.save();
      return;
    }
    // Ctrl+G: ir para linha (P3#12)
    if (primary && !event.altKey && !event.shiftKey && (event.key === "g" || event.key === "G")) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined) return;
      const input = window.prompt("Ir para a linha:", "");
      if (input === null || input.trim().length === 0) return;
      const lineNum = parseInt(input.trim(), 10);
      if (isNaN(lineNum) || lineNum < 1 || lineNum > session.source.lineCount()) {
        setDocStatus(`linha inválida: ${input.trim()}`);
        return;
      }
      const targetLine = lineNum - 1; // 0-based
      const offset = session.source.offsetOf(targetLine, 0);
      session.caret = offset;
      session.selection = SelectionOps.collapsed(offset);
      session.selections = SelectionSetOps.singular(offset);
      renderer.setSelection(session.selection);
      renderer.setSelections(session.selections);
      updateCaretStatus(session.source, offset);
      viewport.scrollTo(targetLine);
      scheduleInlayHintRefresh();
      setDocStatus(`linha ${lineNum}`);
      renderer.start();
      return;
    }
    // Ctrl+D: seleciona a **próxima ocorrência** da palavra sob o cursor e **acrescenta** um
    // cursor (multi-cursor ao estilo VS Code, P2#5).
    // - 1ª vez: a palavra sob o cursor vira a seleção primária;
    // - vezes seguintes: a ocorrência seguinte é acrescentada e passa a ser a primária;
    // - sem mais ocorrências: nada acontece (sem erro, sem toast) — o conjunto continua.
    if (primary && !event.shiftKey && !event.altKey && (event.key === "d" || event.key === "D")) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined) return;
      const next = selectNextOccurrence(session.selections, session.source.text);
      if (next === undefined) return;
      session.selections = next;
      const nextPrimary = next[0];
      if (nextPrimary === undefined) return;
      session.selection = nextPrimary;
      session.caret = nextPrimary.active;
      renderer.setSelection(session.selection);
      renderer.setSelections(session.selections);
      updateCaretStatus(session.source, session.caret);
      renderer.start();
      return;
    }
    // Ctrl+Shift+L: **seleciona todas** as ocorrências do termo (da seleção atual ou da
    // palavra sob o cursor) — o conjunto de seleções é substituído pelas ocorrências.
    if (primary && event.shiftKey && !event.altKey && (event.key === "l" || event.key === "L")) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined) return;
      const text = session.source.text;
      const current = session.selections[0] ?? session.selection;
      let needle = "";
      if (!SelectionOps.isCollapsed(current)) {
        const { start, end } = SelectionOps.normalized(current);
        needle = text.slice(start, end);
      } else {
        needle = wordAt(text, current.active)?.text ?? "";
      }
      if (needle.length === 0) return;
      const next = selectAllOccurrences(session.selections, text, needle);
      if (next === session.selections) return;
      session.selections = next;
      const nextPrimary = next[0];
      if (nextPrimary === undefined) return;
      session.selection = nextPrimary;
      session.caret = nextPrimary.active;
      renderer.setSelection(session.selection);
      renderer.setSelections(session.selections);
      updateCaretStatus(session.source, session.caret);
      renderer.start();
      return;
    }
    if (event.key === "Escape") {
      // Snippets (P4#18): com sessão ativa, Esc encerra a sessão e consome o evento —
      // antes de qualquer outro destino do Escape.
      const snippetOwner = controller?.current;
      if (snippetOwner?.snippetSession !== undefined) {
        event.preventDefault();
        // O dropdown de escolha (se aberto) encerra a sessão junto (o `onCancel`).
        hideSnippetChoice();
        endSnippetSession(snippetOwner, renderer);
        return;
      }
      // Esc fecha a find bar primeiro (se aberta); só depois é que cancela uma abertura em curso.
      if (findBar !== undefined && findBar.model.isOpen) {
        event.preventDefault();
        findBar.model.close();
        return;
      }
      if (controller !== undefined && controller.cancelOpening()) {
        event.preventDefault();
        return;
      }
    }

    // Snippets (P4#18): com sessão ativa, Tab/Shift+Tab ciclam as paradas (não indentam).
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
      const session = controller?.current;
      const active = session?.snippetSession;
      if (session !== undefined && active !== undefined) {
        event.preventDefault();
        const target = event.shiftKey ? previousTabStop(active) : nextTabStop(active);
        if (target === null) {
          // Fim da sessão: passar do último encerra aqui; chegar em $0 seleciona a parada
          // final (caret no fim dela) e descarta a sessão.
          const zero = event.shiftKey
            ? undefined
            : active.fields.find((f) => f.index === 0 && f.isPrimary);
          session.snippetSession = undefined;
          hideSnippetChoice();
          if (zero !== undefined) {
            session.caret = zero.end;
            session.selection = { anchor: zero.start, active: zero.end };
          } else {
            session.selection = SelectionOps.collapsed(session.caret);
          }
          session.selections = [session.selection] as SelectionSet;
          renderer.setSelection(session.selection);
          renderer.setSelections(session.selections);
          updateCaretStatus(session.source, session.caret);
          renderer.start();
          return;
        }
        // Seleciona o range da parada atual (o renderer já pinta seleção no canvas).
        session.snippetSession = target.session;
        session.caret = target.stop.end;
        session.selection = { anchor: target.stop.start, active: target.stop.end };
        session.selections = [session.selection] as SelectionSet;
        renderer.setSelection(session.selection);
        renderer.setSelections(session.selections);
        updateCaretStatus(session.source, session.caret);
        renderer.start();
        // Parada com **escolhas** (`${1|a,b,c|}`) → abre o dropdown.
        if (controller !== undefined) {
          openSnippetChoicePopup(session, controller, surface, renderer, viewport);
        }
        return;
      }
      if (!event.shiftKey && session !== undefined && session.caret > 0) {
        const text = session.source.text;
        // Pega a palavra antes do cursor
        let wordStart = session.caret - 1;
        while (wordStart >= 0 && /[a-zA-Z0-9_]/.test(text[wordStart]!)) wordStart--;
        wordStart++; // first char of word
        const word = text.slice(wordStart, session.caret);
        // Snippets de **pacote** (`.sublime-snippet`) têm precedência sobre os embutidos: um
        // pacote do usuário pode redefinir um trigger embutido. A expansão usa o **mesmo**
        // pipeline (`parseSnippet`) — tab stops, escolhas, espelhos e transformações iguais.
        const snippet = resolveSnippetForWord(word, packageSnippets);
        if (snippet !== undefined) {
          event.preventDefault();
          // Variáveis TM: o contexto é montado **antes** da expansão (o texto selecionado,
          // a linha e a palavra são os do instante da expansão).
          const variables = buildSnippetVariableContext({
            document: session.source,
            path: session.path,
            caret: session.caret,
            selection: session.selection,
          });
          const expansion = parseSnippet(snippet.template, variables);
          void (async () => {
            // Flush lote pendente antes de operação que vai direto ao main
            await controller?.flushBatch?.();
            // Usa replaceOne para deletar o trigger + inserir o template
            const triggerLen = word.length;
            const result = await session.bridge.replaceOne(
              session.handle, wordStart, triggerLen, expansion.text,
            );
            session.source.setText(result.text, result.revision);
            viewport.setMetrics({ lineCount: session.source.lineCount() });
            session.dirty = true;
            setUndoStatus(result.canUndo, result.canRedo);
            // Snippets (P4#18): cria a sessão e **seleciona** a primeira parada.
            const snip = createSnippetSession(expansion, wordStart);
            const first = currentStop(snip);
            if (first !== null && first.index !== 0) {
              session.snippetSession = snip;
              session.caret = first.end;
              session.selection = { anchor: first.start, active: first.end };
            } else {
              // Sem parada navegável (template só com `$0` ou liso): caret no $0 ou no fim.
              session.snippetSession = undefined;
              const zero = snip.fields.find((f) => f.index === 0 && f.isPrimary);
              session.caret = zero !== undefined ? zero.start : wordStart + expansion.text.length;
              session.selection = SelectionOps.collapsed(session.caret);
            }
            session.selections = [session.selection] as SelectionSet;
            renderer.setSelection(session.selection);
            renderer.setSelections(session.selections);
            updateCaretStatus(session.source, session.caret);
            renderer.start();
            // A 1ª parada pode ser uma **escolha** (`${1|a,b,c|}`) → abre o dropdown.
            if (controller !== undefined && first !== null && first.index !== 0) {
              openSnippetChoicePopup(session, controller, surface, renderer, viewport);
            }
          })();
          return;
        }
      }
      // Fall through: Tab normal (indentação) — se nenhum snippet
      // casou, o Tab indent padrão segue aqui
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: navega entre abas
    if (event.key === "Tab" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (controller) {
        const total = controller.openSessions.length;
        if (total > 1) {
          const dir = event.shiftKey ? -1 : 1;
          const next = (controller.currentIndex() + dir + total) % total;
          controller.activate(next);
        }
      }
      return;
    }

    // ── Enter: a quebra de linha ──────────────────────────────────────────────────────────────
    //
    // ⚠️ **Sem isto, não dá para criar linhas**: o `Enter` não é uma tecla imprimível
    // (`key.length === 1`) e não havia handler ⇒ o `keydown` morria sem fazer nada.
    //
    // O caminho é o **mesmo** da digitação (`controller.insertText`): a seleção é
    // **substituída**, o multi-cursor insere N quebras (1 lote) e o auto-pair **não** é
    // quebrado (o par digitado fica em volta da quebra).
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const session = controller?.current;
      if (session === undefined) return;
      event.preventDefault();
      void controller?.insertText("\n");
      renderer.start();
      return;
    }

    // ── Ctrl/Cmd+A: seleciona tudo ───────────────────────────────────────────────────────────
    //
    // ⚠️ Não havia handler: o atalho não fazia nada (o navegador não seleciona o canvas).
    if (primary && !event.shiftKey && !event.altKey && (event.key === "a" || event.key === "A")) {
      const session = controller?.current;
      if (session === undefined) return;
      event.preventDefault();
      const end = session.source.text.length;
      session.selection = { anchor: 0, active: end };
      session.selections = [session.selection] as SelectionSet;
      session.caret = end;
      renderer.setSelection(session.selection);
      renderer.setSelections(session.selections);
      updateCaretStatus(session.source, end);
      renderer.start();
      return;
    }

    // ── Ctrl/Cmd+Home/End: o **caret** vai junto ──────────────────────────────────────────────
    //
    // ⚠️ Antes, `Home`/`End` só **rolavam** a viewport ⇒ o cursor ficava para trás
    // (o `Ctrl+End` rolava para o fim do documento, mas o caret continuava no meio).
    if (primary && !event.shiftKey && !event.altKey && (event.key === "Home" || event.key === "End")) {
      const session = controller?.current;
      if (session === undefined) return;
      event.preventDefault();
      const offset = event.key === "End" ? session.source.text.length : 0;
      const line = session.source.positionAt(offset).line;
      session.caret = offset;
      session.selection = SelectionOps.collapsed(offset);
      session.selections = SelectionSetOps.singular(offset);
      renderer.setSelection(session.selection);
      renderer.setSelections(session.selections);
      updateCaretStatus(session.source, offset);
      viewport.scrollTo(line);
      scheduleInlayHintRefresh();
      renderer.start();
      return;
    }

    const page = Math.max(1, Math.floor(surface.clientHeight / lineHeight) - 1);
    const line = viewport.visibleLineRange();

    // Backspace inteligente (P3#13): deleta seleção, par vazio ou caractere anterior
    if (event.key === "Backspace" && controller?.current) {
      event.preventDefault();
      const session = controller.current;
      // Multi-cursor (P2#5): apaga em **todos** os cursores (1 entrada por cursor no lote).
      if (session.selections.length > 1) {
        void controller.deleteAtCursors("backward");
        renderer.start();
        return;
      }
      const s = session.selection;
      if (!SelectionOps.isCollapsed(s)) {
        void controller.insertText("");
        renderer.start();
        return;
      } else {
        const text = session.source.text;
        const pos = session.caret;
        if (pos > 0 && pos < text.length) {
          const prev = text[pos - 1]!;
          const next = text[pos]!;
          if (AUTO_PAIRS[prev] === next) {
            // Deleta ambos (par vazio)
            void controller.replaceText(pos - 1, 2, "");
          } else {
            void controller.replaceText(pos - 1, 1, "");
          }
        } else if (pos > 0) {
          void controller.replaceText(pos - 1, 1, "");
        }
      }
      return;
    }

    // Delete: deleta seleção ou caractere à frente
    if (event.key === "Delete" && controller?.current) {
      event.preventDefault();
      const session = controller.current;
      // Multi-cursor (P2#5): apaga em **todos** os cursores (1 entrada por cursor no lote).
      if (session.selections.length > 1) {
        void controller.deleteAtCursors("forward");
        renderer.start();
        return;
      }
      const s = session.selection;
      if (!SelectionOps.isCollapsed(s)) {
        void controller.insertText("");
        renderer.start();
        return;
      }
      const pos = session.caret;
      if (pos < session.source.text.length) {
        void controller.replaceText(pos, 1, "");
      }
      return;
    }

    // Alt+Shift+↑/↓: **acrescenta** um cursor na linha vizinha (preservando a coluna) —
    // multi-cursor ao estilo VS Code (P2#5). No limite do documento não faz nada.
    if (
      event.altKey &&
      event.shiftKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined) return;
      const next =
        event.key === "ArrowUp"
          ? cursorAbove(session.selections, session.source)
          : cursorBelow(session.selections, session.source);
      // Limite do documento: o conjunto não mudou — nada a fazer.
      if (next.length === session.selections.length) return;
      session.selections = next;
      const nextPrimary = next[0];
      if (nextPrimary === undefined) return;
      session.selection = nextPrimary;
      session.caret = nextPrimary.active;
      renderer.setSelection(session.selection);
      renderer.setSelections(session.selections);
      updateCaretStatus(session.source, session.caret);
      const caretLine = session.source.positionAt(session.caret).line;
      const visible = viewport.visibleLineRange();
      if (caretLine < visible.first || caretLine >= visible.first + visible.count) {
        viewport.scrollTo(caretLine);
      }
      renderer.start();
      return;
    }

    // Navegação por setas e seleção (Shift+seta, P1#1)
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined) {
        // Sem sessão: scroll
        const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (delta !== 0) { viewport.scrollByRows(delta); scheduleInlayHintRefresh(); }
        return;
      }
      const source = session.source;
      const currentOffset = session.caret;
      let newOffset = currentOffset;
      const text = source.text;
      const totalLen = text.length;

      if (event.key === "ArrowLeft") {
        newOffset = Math.max(0, currentOffset - 1);
      } else if (event.key === "ArrowRight") {
        newOffset = Math.min(totalLen, currentOffset + 1);
      } else if (event.key === "ArrowUp") {
        const pos = source.positionAt(currentOffset);
        if (pos.line > 0) {
          newOffset = source.offsetOf(pos.line - 1, pos.column);
        }
      } else if (event.key === "ArrowDown") {
        const pos = source.positionAt(currentOffset);
        if (pos.line < source.lineCount() - 1) {
          newOffset = source.offsetOf(pos.line + 1, pos.column);
        }
      }

      // Multi-cursor (P2#5): com N cursores a seta mexe **só no cursor primário** — os
      // extras ficam onde estão (o conjunto **não** colapsa para 1).
      const extras = session.selections.length > 1 ? session.selections.slice(1) : [];
      if (event.shiftKey) {
        // Shift+seta: estende a seleção do cursor primário
        const primary = session.selections[0] ?? session.selection;
        session.selection = { anchor: primary.anchor, active: newOffset };
        session.selections = [session.selection, ...extras];
      } else {
        // Seta sem Shift: colapsa a seleção do cursor primário
        session.selection = SelectionOps.collapsed(newOffset);
        session.selections = [session.selection, ...extras];
      }
      session.caret = newOffset;
      renderer.setSelection(session.selection);
      renderer.setSelections(session.selections);
      updateCaretStatus(source, newOffset);
      // Scroll para a linha do cursor
      const caretLine = source.positionAt(newOffset).line;
      const visible = viewport.visibleLineRange();
      if (caretLine < visible.first || caretLine >= visible.first + visible.count) {
        viewport.scrollTo(caretLine);
      }
      renderer.start();
      updateBlame(session, bridge, caretLine);
      return;
    }

    // ⚠️ PageUp/PageDown rolam em **rows visuais** (a unidade da rolagem): com soft wrap,
    // `scrollTo(linha + page)` pulava N× a tela (a "page" é medida em linhas, mas a linha
    // lógica ocupa N rows).
    if (event.key === "PageDown") { viewport.scrollByRows(page, { animate: true }); scheduleInlayHintRefresh(); }
    else if (event.key === "PageUp") { viewport.scrollByRows(-page, { animate: true }); scheduleInlayHintRefresh(); }
    else if (event.key === "Home") { viewport.scrollTo(0, { animate: true }); scheduleInlayHintRefresh(); }
    else if (event.key === "End") { viewport.scrollTo(line.first + 1_000_000, { animate: true }); scheduleInlayHintRefresh(); }
    else if (controller !== undefined && controller.current !== undefined && isPrintable(event)) {
      event.preventDefault();
      const session = controller.current;
      const key = event.key;
      const close = AUTO_PAIRS[key];

      if (close !== undefined) {
        // Multi-cursor (P2#5): o par entra em **todos** os cursores e cada cursor fica
        // **entre** os delimitadores.
        if (session.selections.length > 1) {
          void controller.insertKeyAtCursors(key, close);
          return;
        }
        // Auto-pair: insere par e reposiciona cursor no meio
        const at = session.caret;
        void controller.insertText(key + close).then(() => {
          // Snippets (P4#18): com sessão ativa o insertText vai por replaceText, que pode
          // deslocar o caret por espelhos anteriores — deriva do caret final. Sem sessão,
          // mantém a fórmula histórica (`at + 1`).
          session.caret = session.snippetSession !== undefined ? session.caret - 1 : at + 1;
          session.selection = SelectionOps.collapsed(session.caret);
          session.selections = SelectionSetOps.singular(session.caret);
          updateCaretStatus(session.source, session.caret);
          renderer.start();
        });
      } else if (CLOSING.has(key)) {
        // Multi-cursor (P2#5): cada cursor pula o fechamento que já está à sua frente; os
        // demais insertem a tecla.
        if (session.selections.length > 1) {
          void controller.insertKeyAtCursors(key, undefined);
          return;
        }
        // Se o próximo caractere é o fechamento, só pula (não insere duplicado)
        const text = session.source.text;
        if (session.caret < text.length && text[session.caret] === key) {
          session.caret += 1;
          session.selection = SelectionOps.collapsed(session.caret);
          session.selections = SelectionSetOps.singular(session.caret);
          updateCaretStatus(session.source, session.caret);
          renderer.start();
        } else {
          void controller.insertText(key);
        }
      } else {
        // Caractere normal — controller.insertText já atualiza source + viewport
        void controller.insertText(key);
      }
      return;
    } else return;
    event.preventDefault();
    renderer.start();
  });

  // Drag & drop de arquivo (P2#7): arrastar um arquivo do SO pro canvas abre ele.
  surface.addEventListener("dragover", (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
  });

  surface.addEventListener("drop", async (event: DragEvent) => {
    event.preventDefault();
    if (controller === undefined) return;
    const files = event.dataTransfer?.files;
    if (files === undefined || files.length === 0) return;
    const path = (files[0] as { path?: string } | undefined)?.path;
    // Em Electron, `File.path` contém o caminho real do arquivo no sistema.
    if (path === undefined || path.length === 0) return;
    const opened = await controller.open(path);
    if (opened) {
      showWelcome(false);
      findBar?.syncDocument();
    }
  });

  // Os **mesmos** caminhos dos atalhos: os botões da rail abrem os overlays **focando o
  // input** (o botão chamava `palette.model.open()` direto e o input não recebia o foco).
  return { openPalette, openQuickOpen, openSearchPanel };
}

/** Tecla imprimível (um code point, sem modificadores) — a porta da digitação mínima. */
function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Mostra um prompt simples para o usuário digitar o novo nome do símbolo.
 * Retorna `null` se o usuário cancelou.
 */
function showRenameInput(): string | null {
  return window.prompt("Novo nome do símbolo:");
}

/**
 * Aplica as TextEdits de um rename no documento.
 * Para edições no arquivo ativo usa `controller.replaceText()`;
 * para cross-file (outros URIs) loga que ainda não é suportado.
 */
function applyRenameEdits(
  result: LspRenameResult,
  session: TabSession,
  controller: DocumentController | undefined,
): void {
  // Descobre a URI do documento ativo para comparar
  const activeUri = `file://${session.path.startsWith("/") ? "" : "/"}${session.path}`;

  for (const [uri, edits] of Object.entries(result.edits)) {
    if (uri === activeUri) {
      // Edições no documento ativo: aplica uma a uma, em ordem reversa para não quebrar offsets
      const sorted = [...edits].sort(
        (a, b) => (b.range.start.line - a.range.start.line) || (b.range.start.character - a.range.start.character),
      );
      // Aplica cada edição em lote via replaceText
      for (const edit of sorted) {
        const startOffset = session.source.offsetOf(edit.range.start.line, edit.range.start.character);
        const endOffset = session.source.offsetOf(edit.range.end.line, edit.range.end.character);
        void controller?.replaceText(startOffset, endOffset - startOffset, edit.newText);
      }
    } else {
      console.info(`Scribe: rename cross-file para "${uri}" ainda não é suportado no renderer`);
    }
  }
}

/**
 * Aplica uma lista de TextEdits LSP no documento, do fim para o começo
 * (para evitar deslocamento de offsets). Cada edit substitui o range por newText.
 */
function applyFormattingEdits(
  edits: readonly LspTextEdit[],
  session: DocumentSession,
  controller: DocumentController | undefined,
): void {
  if (controller === undefined) return;
  // Ordena do fim para o começo para preservar offsets
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });
  for (const edit of sorted) {
    const startOffset = session.source.offsetOf(edit.range.start.line, edit.range.start.character);
    const endOffset = session.source.offsetOf(edit.range.end.line, edit.range.end.character);
    const removeLen = endOffset - startOffset;
    controller.replaceText(startOffset, removeLen, edit.newText);
  }
}

// ── Code Actions Popup ──────────────────────────────────────────────────────────────────────────

/** Popup de code actions ativo (criado sob demanda) — some com `removeCodeActionsPopup()`. */
let codeActionsPopup: HTMLElement | undefined;

/** Handler de "clicar fora" do popup de code actions (desregistrado junto com o popup). */
let codeActionsCloseHandler: ((event: MouseEvent) => void) | undefined;

/**
 * Remove o popup de code actions da tela — **idempotente**.
 *
 * O popup é criado sob demanda e antes ficava órfão na tela: agora ele sai do DOM quando
 * é fechado (clique no item, clique fora) ou quando outro popup de contexto abre.
 */
function removeCodeActionsPopup(): void {
  if (codeActionsCloseHandler !== undefined) {
    document.removeEventListener("mousedown", codeActionsCloseHandler);
    codeActionsCloseHandler = undefined;
  }
  codeActionsPopup?.remove();
  codeActionsPopup = undefined;
}

/**
 * Mostra um popup DOM simples listando as code actions disponíveis.
 * Ao clicar em uma action, se tiver `edit`, aplica as TextEdits no documento.
 * Se tiver `command`, executa via menu handler.
 */
function showCodeActionsPopup(
  actions: readonly LspCodeAction[],
  session: DocumentSession,
  viewport: ViewportImpl,
  controller: DocumentController | undefined,
  bridge: ScribeBridge | undefined,
  renderer: ScribeRenderer,
): void {
  // Remove o popup anterior (se houver) — nunca dois code actions na tela.
  removeCodeActionsPopup();

  const popup = document.createElement("div");
  popup.id = "code-actions-popup";
  // ⚠️ Os tokens são os do **shell** (`--s-*`): os antigos (`--bg`, `--font`) não existiam
  // ⇒ no tema claro o texto ficava ilegível (o popup saía com o fundo escuro e a cor
  // errada). `--z-popup` é a camada dos popups de contexto.
  popup.style.cssText = `
    position: fixed;
    background: var(--s-sidebar);
    border: 1px solid var(--s-border);
    border-radius: 6px;
    padding: 4px 0;
    min-width: 200px;
    max-width: 400px;
    max-height: 300px;
    overflow-y: auto;
    z-index: var(--z-popup);
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    font-family: var(--s-font-ui);
    font-size: 13px;
    color: var(--s-fg);
  `;

  const rect = (document.getElementById("editor-surface") as HTMLElement | null);
  if (rect !== null) {
    const r = rect.getBoundingClientRect();
    // Posiciona ao lado do cursor aproximado
    const pos = session.source.positionAt(session.caret);
    const lineHeight = Math.ceil(TEXT_STYLE.sizePx * 1.4);
    const charW = TEXT_STYLE.sizePx * 0.6;
    const x = r.left + 12 + pos.column * charW;
    const y =
      r.top + (renderer.visualRowOfLine(pos.line) * lineHeight - viewport.scrollOffsetPx() + lineHeight) + 8;
    popup.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    popup.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
  } else {
    popup.style.left = "100px";
    popup.style.top = "100px";
  }

  for (const action of actions) {
    const item = document.createElement("div");
    item.style.cssText = `
      padding: 6px 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    item.addEventListener("mouseenter", () => {
      item.style.background = "var(--s-hover)";
    });
    item.addEventListener("mouseleave", () => {
      item.style.background = "transparent";
    });

    // Título
    const titleSpan = document.createElement("span");
    titleSpan.textContent = action.title;
    item.appendChild(titleSpan);

    // Kind tag
    if (action.kind !== undefined && action.kind.length > 0) {
      const kindSpan = document.createElement("span");
      kindSpan.style.cssText = `
        font-size: 11px;
        opacity: 0.6;
        margin-left: auto;
      `;
      kindSpan.textContent = action.kind;
      item.appendChild(kindSpan);
    }

    item.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      removeCodeActionsPopup();
      void applyCodeAction(action, session, controller, bridge);
    });

    popup.appendChild(item);
  }

  // Fechar ao clicar fora
  const closeHandler = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (target !== null && !popup.contains(target)) {
      removeCodeActionsPopup();
    }
  };
  // Delay para não fechar imediatamente pelo clique que abriu
  setTimeout(() => {
    // O popup pode ter sido fechado (outro popup abriu) antes do timeout — não registra
    // um handler para um popup que já saiu da tela.
    if (codeActionsPopup !== popup) return;
    codeActionsCloseHandler = closeHandler;
    document.addEventListener("mousedown", closeHandler);
  }, 0);

  document.body.appendChild(popup);
  codeActionsPopup = popup;
}

/**
 * Aplica uma code action: se tiver edit, aplica as TextEdits no documento.
 * Se tiver command, executa via menu handler.
 */
async function applyCodeAction(
  action: LspCodeAction,
  session: DocumentSession,
  controller: DocumentController | undefined,
  bridge: ScribeBridge | undefined,
): Promise<void> {
  if (action.edit?.changes !== undefined) {
    // Aplica edições em ordem reversa (preserva offsets)
    for (const [uri, edits] of Object.entries(action.edit.changes)) {
      if (uri !== undefined) {
        // Edita no documento ativo
        const sorted = [...edits].sort(
          (a, b) =>
            (b.range.start.line - a.range.start.line) ||
            (b.range.start.character - a.range.start.character),
        );
        for (const edit of sorted) {
          const startOffset = session.source.offsetOf(edit.range.start.line, edit.range.start.character);
          const endOffset = session.source.offsetOf(edit.range.end.line, edit.range.end.character);
          await controller?.replaceText(startOffset, endOffset - startOffset, edit.newText);
        }
      }
    }
  } else if (action.command !== undefined && bridge !== undefined) {
    // Comando LSP — executa via bridge
    try {
      await bridge.executeCommand(action.command.command);
    } catch {
      console.warn("Scribe: falha ao executar comando de code action", action.command.command);
    }
  }
}

// Autostart só no navegador: em `node`/vitest o módulo é apenas importável (sem DOM, sem throw).
if (typeof document !== "undefined") {
  void bootRenderer().catch((error: unknown) => {
    console.error("Scribe: falha no boot do renderer", error);
  });
}
