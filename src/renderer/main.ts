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
  toDisposable,
  DARK_THEME,
  LIGHT_THEME,
  BUILTIN_THEMES,
} from "../shared";
import type {
  CommandListResult,
  Disposable,
  DocumentHighlight,
  EditorTheme,
  HighlightSpan,
  LspCompletionItem,
  LspDiagnostic,
  LspHoverResult,
  RenderBackendKind,
  RGBA,
  ReplaceAllResult,
  RenderPipeline,
  SearchDocumentResult,
  SearchMatch,
  SearchQuery,
  Selection,
  SelectionSet,
  TextStyle,
} from "../shared";
import {
  FindBarModel,
  createDebounceScheduler,
} from "./find-bar";
import type { FindBarApi, FindBarState } from "./find-bar";
import { attachCommandPalette } from "./command-palette";
import type { CommandPaletteApi, CommandPaletteBinding } from "./command-palette";
import { createCompletionPopup } from "./completions";
import type { CompletionPopupBinding } from "./completions";
import { createHoverTooltip } from "./hover-tooltip";
import type { HoverTooltipBinding } from "./hover-tooltip";
import { attachMinimap } from "./minimap";
import type { MinimapBinding } from "./minimap";
import { findSnippet, parseSnippet } from "./snippets";
import {
  Canvas2DBackend,
  GlyphAtlas,
  ViewportImpl,
  WebGPUBackend,
  WebGPUUnavailableError,
  type AtlasSurface,
  type BracketPos,
  type CaretPosition,
  type GlyphBitmap,
  type GlyphRasterizer,
  type GlyphTinter,
  type LineLayout,
  type LineSource,
  type SceneHighlight,
  type SearchHighlight,
  type TextMeasurer,
  buildInstances,
} from "../core/render";
import { createSyntaxTheme } from "../core/syntax";

const DEMO_LINE_COUNT = 200;
const GLYPH_CHUNK = 2048;

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
 * `LineSource` ligado ao **texto do documento** (o adaptador mínimo do renderer). Guarda o texto
 * completo e o fatia por linha sob demanda — o `Viewport` só materializa o range visível, então
 * **não** há nó DOM por linha (DEC-REN-7).
 */
export class DocumentLineSource implements LineSource {
  private textValue: string;
  private lines: string[];
  private revisionValue: number;

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

  /** Substitui o texto (vindo da ponte) e guarda a revisão associada. */
  setText(next: string, revision?: number): void {
    this.textValue = next;
    this.lines = splitLines(next);
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

/** Estado de undo/redo que a ponte devolve (espelha `DocumentUndoState` do contrato). */
interface UndoStateDto {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly revision: number;
  readonly caret: number;
}

/** Superfície do preload consumida pelo renderer (subconjunto de `window.scribe`). */
interface ScribeBridge {
  open(path: string, signalId?: number): Promise<number>;
  openDialog(): Promise<string | null>;
  text(handle: number): Promise<string>;
  revision(handle: number): Promise<number>;
  insert(handle: number, at: number, text: string, origin?: "plugin" | "user"): Promise<number>;
  replaceOne(handle: number, at: number, remove: number, insert: string): Promise<number>;
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
class DocumentController {
  private sessions: TabSession[] = [];
  private activeIndex = -1;
  private opening: { readonly signalId: number; readonly path: string } | undefined;

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
      void this.bridge.text(handle).then((next) => {
        source.setText(next, event.revision);
        // Atualiza estado dirty da sessão
        const s = this.sessions.find((s) => s.handle === handle);
        if (s) s.dirty = true;
        if (this.current?.handle === handle) {
          this.viewport.setMetrics({ lineCount: source.lineCount() });
          setDirtyStatus(true);
          this.renderer.start();
        }
        this.renderTabBar();
      });
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
    setDocStatus(label);
    setBreadcrumbs(path);
    setDirtyStatus(false);
    showWelcome(false);
    await this.refreshUndoStatus();
    this.renderTabBar();
    this.renderer.start();
    console.info(`Scribe: documento ligado via preload "${path}" (handle ${handle})`);
    return true;
  }

  activate(index: number): void {
    if (index === this.activeIndex || index < 0 || index >= this.sessions.length) return;
    // Salva estado da sessão atual
    const old = this.sessions[this.activeIndex];
    if (old !== undefined) {
      old.savedScrollPx = this.viewport.scrollOffsetPx();
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
    setDocStatus(session.label);
    setBreadcrumbs(session.path);
    setDirtyStatus(session.dirty ?? false);
    this.refreshUndoStatus();
    this.renderTabBar();
    this.renderer.start();
  }

  close(index: number): void {
    if (index < 0 || index >= this.sessions.length) return;
    const session = this.sessions[index]!;
    session.dispose();
    this.sessions.splice(index, 1);
    if (this.sessions.length === 0) {
      this.activeIndex = -1;
      setDocStatus("sem documento");
      setBreadcrumbs(undefined);
      setDirtyStatus(false);
      setUndoStatus(false, false);
      showWelcome(true);
    } else if (index <= this.activeIndex) {
      this.activate(Math.max(0, this.activeIndex - 1));
    } else {
      this.activate(this.activeIndex);
    }
    this.renderTabBar();
    this.renderer.start();
  }

  private renderTabBar(): void {
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
        if (e.button === 1) {
          // Middle click
          e.preventDefault();
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

  /** Digitação mínima: insere no caret e relê o documento. */
  async insertText(text: string): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    try {
      const s = session.selection;
      if (!SelectionOps.isCollapsed(s)) {
        const { start, end } = SelectionOps.normalized(s);
        await this.replaceText(start, end - start, text);
        return;
      }
      // Seleção colapsada: insere normalmente
      const insertAt = session.caret;
      const revision = await session.bridge.insert(session.handle, insertAt, text, "user");
      session.caret = insertAt + text.length;
      session.selection = SelectionOps.collapsed(session.caret);
      session.selections = SelectionSetOps.singular(session.caret);
      this.renderer.setSelection(session.selection);
      this.renderer.setSelections(session.selections);
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, revision);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      session.dirty = true;
      await this.refreshUndoStatus();
      this.renderer.start();
    } catch (error) {
      console.error("Scribe: falha ao inserir texto no documento", error);
    }
  }

  /**
   * Substitui um range do documento: remove `remove` caracteres de `at` e insere `insert`.
   * Atualiza o caret, seleção, viewport e estado dirty — sem refreshUndoStatus (útil para
   * operações internas como snippet expansion).
   */
  async replaceText(at: number, remove: number, insert: string): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    try {
      const revision = await session.bridge.replaceOne(session.handle, at, remove, insert);
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, revision);
      session.caret = at + insert.length;
      session.selection = SelectionOps.collapsed(session.caret);
      session.selections = SelectionSetOps.singular(session.caret);
      this.renderer.setSelection(session.selection);
      this.renderer.setSelections(session.selections);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      session.dirty = true;
      this.renderer.start();
    } catch (error) {
      console.error("Scribe: falha ao substituir texto no documento", error);
    }
  }

  private async runHistory(action: "undo" | "redo"): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    try {
      const state =
        action === "undo"
          ? await session.bridge.undo(session.handle)
          : await session.bridge.redo(session.handle);
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, state.revision);
      session.caret = Math.min(state.caret, next.length);
      session.selection = SelectionOps.collapsed(session.caret);
      session.selections = SelectionSetOps.singular(session.caret);
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

/** Alterna a exibição da tela de boas-vindas (welcome screen). */
function showWelcome(show: boolean): void {
  const el = document.getElementById("welcome-screen");
  if (el) el.hidden = !show;
  // Esconde o minimap junto com a welcome screen (ambos têm z-index 10)
  const mm = document.getElementById("minimap");
  if (mm) mm.hidden = show;
}

// ---- app ------------------------------------------------------------------------------------------

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
  /** Diagnósticos LSP por handle do documento. */
  private diagnosticsByHandle: Map<number, readonly LspDiagnostic[]> = new Map();
  /** Handle do documento ativo para desenhar diagnósticos. */
  private activeHandle: number | undefined;

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
    this.viewport.setMetrics({ lineCount: source.lineCount() });
    this.viewport.scrollTo(0);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.viewportWidth = Math.max(1, Math.floor(cssWidth));
    this.viewportHeight = Math.max(1, Math.floor(cssHeight));
    this.canvas.width = Math.floor(this.viewportWidth * this.dpr);
    this.canvas.height = Math.floor(this.viewportHeight * this.dpr);
    if (this.pipeline instanceof Canvas2DBackend) {
      this.pipeline.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    // Atualiza viewport com visualLineCount (soft wrap)
    const lineCount = this.source.lineCount();
    const gutterDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, lineCount))) + 1);
    const gutterWidth = gutterDigits * 9 + 16;
    const wrapWidth = Math.max(0, this.viewportWidth - 10 - (gutterWidth + 8));
    let vizCount = lineCount;
    if (wrapWidth > 0) {
      vizCount = 0;
      for (let i = 0; i < lineCount; i++) {
        const text = this.source.line(i);
        if (text.length === 0) { vizCount += 1; continue; }
        // Mede caractere a caractere
        let w = 0;
        let segs = 1;
        for (let ci = 0; ci < text.length; ci++) {
          const advance = this.atlas.resolveGlyph(text[ci] ?? " ", this.style).advance;
          if (w + advance > wrapWidth) { segs++; w = 0; }
          if (text[ci] !== " ") w += advance;
        }
        vizCount += segs;
      }
    }
    this.viewport.setMetrics({
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      visualLineCount: vizCount,
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
    const viewportRect = { x: 0, y: 0, w: this.viewportWidth, h: this.viewportHeight };
    const range = this.viewport.visibleLineRange();
    // Largura dinâmica do gutter: número de dígitos do total de linhas + folga.
    const lineCount = this.source.lineCount();
    const gutterDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, lineCount))) + 1);
    const gutterWidth = gutterDigits * 9 + 16; // ~9px/dígito + 16px padding horizontal
    const colors = THEME.current.colors;
    const layout: LineLayout = {
      lineHeight: this.lineHeight(),
      paddingLeft: gutterWidth + 8,
      paddingTop: 8,
      tabWidth: 4,
      scrollOffsetPx: this.viewport.scrollOffsetPx(),
      viewport: viewportRect,
      background: colors.background,
      defaultColor: colors.foreground,
      gutterWidth,
      gutterBackground: colors.gutter,
      gutterColor: colors.gutterForeground,
      scrollbarWidth: 10,
      scrollbarTrack: colors.scrollbarTrack,
      scrollbarThumb: colors.scrollbarThumb,
      searchMatchColor: colors.searchMatch,
      searchCurrentColor: colors.searchCurrent,
      selectionColor: colors.selection,
      bracketMatchColor: colors.caret,
      // Soft wrap (P3#15): largura disponível para o texto = viewport - gutter - scrollbar - padding
      wrapWidth: Math.max(0, viewportRect.w - 10 - (gutterWidth + 8)),
    };

    // Computa carets e seleções extras para multi-cursor (P2#5)
    const primaryCaret = {
      line: Math.floor(this.viewport.scrollOffsetPx() / layout.lineHeight),
      column: 0,
      color: colors.caret,
      width: 2,
    };
    let extraCarets: readonly CaretPosition[] | undefined;
    let extraSelections: readonly Selection[] | undefined;
    if (this.currentSelections !== undefined && this.currentSelections.length > 1) {
      const ec: CaretPosition[] = [];
      const es: Selection[] = [];
      // Primeira seleção é a primária (já tratada pelo primaryCaret/currentSelection)
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
    let bracketMatch: readonly [BracketPos, BracketPos] | undefined;
    if (this.currentSelection && !SelectionOps.isCollapsed(this.currentSelection)) {
      // So match quando cursor nao esta selecionando
    } else {
      const primaryOffset = this.currentSelection?.active ?? 0;
      if (this.source.lineCount() > 0) {
        // Materializa o texto completo da source para o scan
        let fullText = "";
        for (let i = 0; i < this.source.lineCount(); i++) {
          if (i > 0) fullText += "\n";
          fullText += this.source.line(i);
        }
        const matchOffset = findMatchingBracket(fullText, primaryOffset);
        if (matchOffset !== undefined) {
          const openPos = this.source.positionAt(Math.min(primaryOffset, matchOffset));
          const closePos = this.source.positionAt(Math.max(primaryOffset, matchOffset));
          bracketMatch = [openPos, closePos] as const;
        }
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
      // measureWidth para soft wrap (P3#15): mede texto usando o atlas
      (text: string): number => {
        let w = 0;
        for (let i = 0; i < text.length; i++) w += this.atlas.resolveGlyph(text[i] ?? " ", this.style).advance;
        return w;
      },
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
    const firstLine = Math.floor(scrollPx / lineHeight);
    const visibleLines = Math.ceil(this.viewportHeight / lineHeight) + 1;
    const lastLine = firstLine + visibleLines;

    // Filtra diagnósticos visíveis
    const visible = diags.filter(
      (d) => d.range.startLine <= lastLine && d.range.endLine >= firstLine,
    );
    if (visible.length === 0) return;

    const ctx = this.canvas.getContext("2d");
    if (ctx === null) return;

    const gutterDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, this.source.lineCount()))) + 1);
    const gutterWidth = gutterDigits * 9 + 16;
    const paddingLeft = gutterWidth + 8;
    const paddingTop = 8;
    const charW = this.style.sizePx * 0.6;

    ctx.save();

    // ── Squiggly underlines (como antes) ──────────────────────────────────
    for (const diag of visible) {
      const color = this.diagColor(diag.severity);
      const startY = diag.range.startLine * lineHeight + lineHeight - 2 - scrollPx;
      const startX = paddingLeft + diag.range.startCol * charW;
      const endX = paddingLeft + diag.range.endCol * charW;
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
      const y = line * lineHeight + Math.round((lineHeight - iconSize) / 2) - scrollPx + paddingTop;
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

function updateCaretStatus(source: DocumentLineSource, offset: number): void {
  const status = document.getElementById("status-caret");
  const position = source.positionAt(offset);
  if (status) status.textContent = `${position.line + 1}:${position.column + 1}`;
  const breadcrumb = document.getElementById("bc-position");
  if (breadcrumb) breadcrumb.textContent = `Ln ${position.line + 1}, Col ${position.column + 1}`;
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
  if (bridge?.onDiagnostics !== undefined) {
    void bridge.onDiagnostics((event) => {
      renderer.setDiagnostics(event.handle, event.diagnostics);
      if (controller?.current?.handle === event.handle) {
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
    }
  };

  const palette =
    commandPaletteApi !== undefined
      ? attachCommandPalette({
          api: commandPaletteApi,
          onExecute: (command) => {
            // Fecha a palette antes de executar
            palette?.model.close();
            // UI actions tratadas localmente no renderer
            if (command.id === "find.open") {
              if (findBar !== undefined && !findBar.model.isOpen) {
                findBar.model.open();
              }
            } else if (["view.toggleTheme", "edit.cut", "edit.copy", "edit.paste", "edit.selectAll"].includes(command.id)) {
              handleMenuAction(command.id);
            } else {
              // Comandos de core: file.*, edit.undo/redo — executa via IPC
              void commandPaletteApi.executeCommand(command.id).catch((error: unknown) => {
                console.error("Scribe: falha ao executar comando", command.id, error);
              });
            }
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
  try {
    completion = createCompletionPopup();
    hoverTooltip = createHoverTooltip();
  } catch (error) {
    console.warn("Scribe: widgets LSP indisponíveis (DOM ausente)", error);
    // Fallback: stubs que não fazem nada
    completion = createNullCompletionPopup();
    hoverTooltip = createNullHoverTooltip();
  }

  attachInputListeners(surface, viewport, renderer, controller, findBar, palette, bridge, completion, hoverTooltip);

  // Minimap (P2#9): as cores vêm do tema ativo — sem isso a faixa fica preta no tema claro.
  const minimap = attachMinimap({
    source: {
      lineCount: () => controller?.current?.source.lineCount() ?? source.lineCount(),
      line: (i: number) => controller?.current?.source.line(i) ?? source.line(i),
    },
    viewport,
    lineHeight: Math.ceil(TEXT_STYLE.sizePx * 1.4),
    getViewportHeight: () => renderer.viewportHeight,
    colors: () => {
      const c = THEME.current.colors;
      return {
        background: rgbToCss(c.background),
        line: rgbToCss(c.foreground),
        viewport: rgbaToCss(c.foreground, 0.08),
        viewportBorder: rgbaToCss(c.foreground, 0.25),
      };
    },
  });
  renderer.attachMinimap(minimap);

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
  const sidebar = document.getElementById("sidebar");
  const explorerBtn = document.getElementById("activity-explorer");
  const resizeSurface = (): void =>
    renderer.resize(surface.clientWidth || 1, surface.clientHeight || 1);
  const setSidebarVisible = (visible: boolean): void => {
    if (sidebar) sidebar.hidden = !visible;
    explorerBtn?.setAttribute("aria-pressed", String(visible));
    explorerBtn?.classList.toggle("active", visible);
    resizeSurface();
    renderer.start();
  };
  explorerBtn?.addEventListener("click", () => setSidebarVisible(sidebar?.hidden ?? true));

  document.getElementById("activity-search")?.addEventListener("click", () => {
    findBar?.model.open();
    surface.focus();
  });
  document.getElementById("activity-palette")?.addEventListener("click", () => {
    void palette?.model.open();
  });

  // Seção do painel: colapsa/expande a lista de documentos abertos.
  const sectionToggle = document.getElementById("sidebar-section-toggle");
  sectionToggle?.addEventListener("click", () => {
    const collapsed = sectionToggle.getAttribute("aria-expanded") === "true";
    sectionToggle.setAttribute("aria-expanded", String(!collapsed));
    const list = document.getElementById("sidebar-editors");
    if (list) list.hidden = collapsed;
  });

  // Ctrl+B: alterna o painel (convenção de editores).
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
        return Promise.reject(new Error("Scribe: nenhum documento aberto para buscar"));
      }
      return find.call(deps.bridge, handle, query);
    },
    replaceAll: (query: SearchQuery, replacement: string): Promise<ReplaceAllResult> => {
      const handle = currentHandle();
      if (handle === undefined) {
        return Promise.reject(new Error("Scribe: nenhum documento aberto para substituir"));
      }
      return replaceAll.call(deps.bridge, handle, query, replacement);
    },
  };

  let currentDocKey = "";
  const renderState = (state: FindBarState): void => {
    bar.hidden = !state.open;
    count.textContent = `${state.current}/${state.total}${state.truncated ? "+" : ""}`;
    status.textContent = state.status ?? "";
    // Empurra os matches pro renderer pintar no canvas (P3.11).
    if (state.open && model.allMatches.length > 0) {
      deps.renderer.setSearchMatches({
        matches: model.allMatches,
        currentIndex: model.currentMatchIndex,
      });
    } else {
      deps.renderer.setSearchMatches(undefined);
    }
    // Dispara um novo frame pra pintar os destaques.
    deps.renderer.start();
    // Botões de toggle: estado ativo dos toggles de busca.
    caseBtn?.classList.toggle("active", state.caseSensitive);
    regexBtn?.classList.toggle("active", state.regex);
    wordBtn?.classList.toggle("active", state.wholeWord);
  };

  // Selecionar uma ocorrência move o caret (coluna do início) e rola até a linha dela.
  const moveCaretTo = (match: SearchMatch): void => {
    const session = deps.controller.current;
    if (session === undefined) return;
    session.caret = Math.min(match.index, session.source.text.length);
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
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "f" || event.key === "F")) {
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
): void {
  const lineHeight = Math.ceil(TEXT_STYLE.sizePx * 1.4);
  const currentLine = (): number => Math.floor(viewport.scrollOffsetPx() / lineHeight);

  surface.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      viewport.scrollTo(currentLine() + Math.sign(event.deltaY) * 3, { animate: true });
    },
    { passive: false },
  );

  let mouseDragAnchor: number | undefined;

  // Command palette: Ctrl+Shift+P interceptado antes de chegar ao canvas.
  const openPalette = (): void => {
    if (palette === undefined) return;
    // Se o find bar estiver aberto, fecha ele primeiro
    if (findBar !== undefined && findBar.model.isOpen) {
      findBar.model.close();
    }
    void palette.model.open().then(() => {
      const input = document.getElementById("palette-input");
      if (input instanceof HTMLInputElement) input.focus();
    });
  };
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.key === "p" || event.key === "P")) {
      event.preventDefault();
      openPalette();
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
    renderer.start();
  });

  surface.addEventListener("mousedown", (event: MouseEvent) => {
    const session = controller?.current;
    if (session === undefined) return;
    const rect = surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const line = Math.floor((y + viewport.scrollOffsetPx() - TEXT_STYLE.sizePx * 0.7) / lineHeight);
    if (line < 0 || line >= session.source.lineCount()) return;
    const text = session.source.line(line);
    const approxCharW = TEXT_STYLE.sizePx * 0.6;
    let col = Math.round((x - 12) / approxCharW);
    col = Math.max(0, Math.min(col, text.length));
    const offset = session.source.offsetOf(line, col);
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
    const line = Math.floor((y + viewport.scrollOffsetPx() - TEXT_STYLE.sizePx * 0.7) / lineHeight);
    if (line < 0) { mouseDragAnchor = undefined; return; }
    const clampedLine = Math.min(line, session.source.lineCount() - 1);
    const text = session.source.line(clampedLine);
    const approxCharW = TEXT_STYLE.sizePx * 0.6;
    let col = Math.round((x - 12) / approxCharW);
    col = Math.max(0, Math.min(col, text.length));
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
      const line = Math.floor((y + viewport.scrollOffsetPx() - TEXT_STYLE.sizePx * 0.7) / lineHeight);
      if (line < 0 || line >= session.source.lineCount()) return;
      const text = session.source.line(line);
      const approxCharW = TEXT_STYLE.sizePx * 0.6;
      let col = Math.round((x - 12) / approxCharW);
      col = Math.max(0, Math.min(col, text.length));
      void (async () => {
        try {
          const result = await bridge.hover!(session.handle, line, col);
          if (result === null || result.contents.length === 0) return;
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
          const y = (pos.line * lineHeightVal - scrollPx + lineHeightVal) + 8;
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
      setDocStatus(`linha ${lineNum}`);
      renderer.start();
      return;
    }
    if (event.key === "Escape") {
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

    // Snippet expansion (P4#18): Tab sem modificador → dispara snippet se
    // o cursor estiver no fim de um trigger.
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key === "Tab") {
      const session = controller?.current;
      if (session !== undefined && session.caret > 0) {
        const text = session.source.text;
        // Pega a palavra antes do cursor
        let wordStart = session.caret - 1;
        while (wordStart >= 0 && /[a-zA-Z0-9_]/.test(text[wordStart]!)) wordStart--;
        wordStart++; // first char of word
        const word = text.slice(wordStart, session.caret);
        const snippet = findSnippet(word);
        if (snippet !== undefined) {
          event.preventDefault();
          const expansion = parseSnippet(snippet.template);
          void (async () => {
            // Usa replaceOne para deletar o trigger + inserir o template
            const triggerLen = word.length;
            const revision = await session.bridge.replaceOne(
              session.handle, wordStart, triggerLen, expansion.text,
            );
            const next = await session.bridge.text(session.handle);
            session.source.setText(next, revision);
            viewport.setMetrics({ lineCount: session.source.lineCount() });
            session.dirty = true;
            setDirtyStatus(true);
            // Posiciona cursor no primeiro tabstop (se houver)
            if (expansion.tabStops.length > 0) {
              const first = expansion.tabStops[0]!.start;
              session.caret = wordStart + first;
            } else {
              session.caret = wordStart + expansion.text.length;
            }
            session.selection = SelectionOps.collapsed(session.caret);
            session.selections = SelectionSetOps.singular(session.caret);
            renderer.setSelection(session.selection);
            renderer.setSelections(session.selections);
            updateCaretStatus(session.source, session.caret);
            renderer.start();
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

    const page = Math.max(1, Math.floor(surface.clientHeight / lineHeight) - 1);
    const line = viewport.visibleLineRange();

    // Backspace inteligente (P3#13): deleta seleção, par vazio ou caractere anterior
    if (event.key === "Backspace" && controller?.current) {
      event.preventDefault();
      const session = controller.current;
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

    // Navegação por setas e seleção (Shift+seta, P1#1)
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const session = controller?.current;
      if (session === undefined) {
        // Sem sessão: scroll
        const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (delta !== 0) viewport.scrollTo(currentLine() + delta);
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

      if (event.shiftKey) {
        // Shift+seta: estende a seleção
        session.selection = { anchor: session.selection.anchor, active: newOffset };
        session.selections = [session.selection] as SelectionSet;
      } else {
        // Seta sem Shift: colapsa a seleção
        session.selection = SelectionOps.collapsed(newOffset);
        session.selections = SelectionSetOps.singular(newOffset);
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
      return;
    }

    if (event.key === "PageDown") viewport.scrollTo(currentLine() + page, { animate: true });
    else if (event.key === "PageUp") viewport.scrollTo(currentLine() - page, { animate: true });
    else if (event.key === "Home") viewport.scrollTo(0, { animate: true });
    else if (event.key === "End") viewport.scrollTo(line.first + 1_000_000, { animate: true });
    else if (controller !== undefined && controller.current !== undefined && isPrintable(event)) {
      event.preventDefault();
      const session = controller.current;
      const key = event.key;
      const close = AUTO_PAIRS[key];

      if (close !== undefined) {
        // Auto-pair: insere par e reposiciona cursor no meio
        const at = session.caret;
        void controller.insertText(key + close).then(() => {
          session.caret = at + 1;
          session.selection = SelectionOps.collapsed(session.caret);
          session.selections = SelectionSetOps.singular(session.caret);
          updateCaretStatus(session.source, session.caret);
          renderer.start();
        });
      } else if (CLOSING.has(key)) {
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
}

/** Tecla imprimível (um code point, sem modificadores) — a porta da digitação mínima. */
function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

// Autostart só no navegador: em `node`/vitest o módulo é apenas importável (sem DOM, sem throw).
if (typeof document !== "undefined") {
  void bootRenderer().catch((error: unknown) => {
    console.error("Scribe: falha no boot do renderer", error);
  });
}
