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
  toDisposable,
} from "../shared";
import type { Disposable, RenderBackendKind, RGBA, RenderPipeline, TextStyle } from "../shared";
import {
  Canvas2DBackend,
  GlyphAtlas,
  ViewportImpl,
  WebGPUBackend,
  WebGPUUnavailableError,
  type AtlasSurface,
  type GlyphBitmap,
  type GlyphRasterizer,
  type LineLayout,
  type LineSource,
  type TextMeasurer,
  buildInstances,
} from "../core/render";

const DEMO_LINE_COUNT = 200;
const GLYPH_CHUNK = 2048;

const TEXT_STYLE: TextStyle = { family: "monospace", sizePx: 15, weight: 400, italic: false };
const COLORS = {
  background: 0x1e1f22ff as RGBA,
  text: 0xd4d4d4ff as RGBA,
  caret: 0x7fb3ffff as RGBA,
  gutter: 0x2b2d30ff as RGBA,
};

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
  undo(handle: number): Promise<UndoStateDto>;
  redo(handle: number): Promise<UndoStateDto>;
  undoState(handle: number): Promise<UndoStateDto>;
  cancel(signalId: number): void;
  nextSignalId(): number;
  snapshot(): Promise<unknown>;
  onDocumentChanged(callback: (event: { handle: number; revision: number }) => void): () => void;
}

function readBridge(): ScribeBridge | undefined {
  const candidate = (globalThis as { scribe?: Partial<ScribeBridge> }).scribe;
  if (candidate === undefined) return undefined;
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
  dispose(): void;
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
  private session: DocumentSession | undefined;
  private opening: { readonly signalId: number; readonly path: string } | undefined;

  constructor(
    private readonly bridge: ScribeBridge,
    private readonly source: DocumentLineSource,
    private readonly viewport: ViewportImpl,
    private readonly renderer: ScribeRenderer,
  ) {}

  get current(): DocumentSession | undefined {
    return this.session;
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
    this.detachSession();
    const revision = await this.bridge.revision(handle);
    this.source.setText(await this.bridge.text(handle), revision);
    this.viewport.setMetrics({ lineCount: this.source.lineCount() });
    const unsubscribe = this.bridge.onDocumentChanged((event) => {
      if (event.handle !== handle) return;
      void this.bridge.text(handle).then((next) => {
        this.source.setText(next, event.revision);
        this.viewport.setMetrics({ lineCount: this.source.lineCount() });
        this.renderer.start();
      });
    });
    this.session = {
      bridge: this.bridge,
      handle,
      source: this.source,
      caret: 0,
      dispose: unsubscribe,
    };
    setDocStatus(path);
    updateCaretStatus(this.source, 0);
    await this.refreshUndoStatus();
    this.renderer.start();
    console.info(`Scribe: documento ligado via preload "${path}" (handle ${handle})`);
    return true;
  }

  /** Abre o diálogo nativo; se o usuário escolher um arquivo, abre-o. */
  async openDialog(): Promise<boolean> {
    const path = await this.bridge.openDialog();
    if (path === null || path.length === 0) return false;
    return this.open(path);
  }

  async undo(): Promise<void> {
    await this.runHistory("undo");
  }

  async redo(): Promise<void> {
    await this.runHistory("redo");
  }

  /** Digitação mínima: insere no caret e relê o documento. */
  async insertText(text: string): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      const revision = await session.bridge.insert(session.handle, session.caret, text, "user");
      session.caret += text.length;
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, revision);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      await this.refreshUndoStatus();
      this.renderer.start();
    } catch (error) {
      console.error("Scribe: falha ao inserir texto no documento", error);
    }
  }

  private async runHistory(action: "undo" | "redo"): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    try {
      const state =
        action === "undo"
          ? await session.bridge.undo(session.handle)
          : await session.bridge.redo(session.handle);
      const next = await session.bridge.text(session.handle);
      session.source.setText(next, state.revision);
      session.caret = Math.min(state.caret, next.length);
      this.viewport.setMetrics({ lineCount: session.source.lineCount() });
      updateCaretStatus(session.source, session.caret);
      setUndoStatus(state.canUndo, state.canRedo);
      this.renderer.start();
    } catch (error) {
      console.error(`Scribe: falha ao ${action === "undo" ? "desfazer" : "refazer"}`, error);
    }
  }

  private async refreshUndoStatus(): Promise<void> {
    const session = this.session;
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

  private detachSession(): void {
    this.session?.dispose();
    this.session = undefined;
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

// ---- app ------------------------------------------------------------------------------------------

class ScribeRenderer {
  private source: LineSource;
  private readonly style = TEXT_STYLE;
  private readonly dpr: number;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private rafHandle = 0;
  private running = false;

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
    this.viewport.setMetrics({ viewportWidth: this.viewportWidth, viewportHeight: this.viewportHeight });
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
    const layout: LineLayout = {
      lineHeight: this.lineHeight(),
      paddingLeft: 12,
      paddingTop: 8,
      tabWidth: 4,
      scrollOffsetPx: this.viewport.scrollOffsetPx(),
      viewport: viewportRect,
      background: COLORS.background,
      defaultColor: COLORS.text,
    };
    const scene = buildInstances(this.source, layout, this.atlas, this.style, range, {
      line: Math.floor(this.viewport.scrollOffsetPx() / layout.lineHeight),
      column: 0,
      color: COLORS.caret,
      width: 2,
    });

    // Damage da viewport → limpeza seletiva no beginFrame → desenho → present (DEC-REN-4).
    const damage = this.viewport.takeDamage();
    this.pipeline.invalidate(damage);
    this.pipeline.beginFrame(viewportRect);
    this.pipeline.pushRects(scene.rects);
    this.pipeline.pushLines(scene.lines);
    for (let i = 0; i < scene.glyphs.length; i += GLYPH_CHUNK) {
      this.pipeline.pushGlyphs(scene.glyphs.slice(i, i + GLYPH_CHUNK));
      this.pipeline.flush();
    }
    this.pipeline.present(damage);
  }

  private lineHeight(): number {
    return Math.ceil(this.style.sizePx * 1.4);
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

function updateCaretStatus(source: DocumentLineSource, offset: number): void {
  const status = document.getElementById("status-caret");
  if (!status) return;
  const position = source.positionAt(offset);
  status.textContent = `${position.line + 1}:${position.column + 1}`;
}

/** Reflete a disponibilidade de undo/redo na status bar (habilitado/desabilitado). */
function setUndoStatus(canUndo: boolean, canRedo: boolean): void {
  const undo = document.getElementById("status-undo");
  if (undo) {
    undo.textContent = "↶ undo";
    undo.classList.toggle("disabled", !canUndo);
  }
  const redo = document.getElementById("status-redo");
  if (redo) {
    redo.textContent = "↷ redo";
    redo.classList.toggle("disabled", !canRedo);
  }
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
      pipeline = new Canvas2DBackend(assertiveContext(surface), atlas, { image: atlasCanvas });
      effective = "canvas2d (fallback de webgpu)";
    }
  } else {
    pipeline = new Canvas2DBackend(assertiveContext(surface), atlas, { image: atlasCanvas });
  }

  setStatus(effective);
  console.info(`Scribe: backend efetivo = ${effective} (pedido: ${requested})`);

  const source = new DocumentLineSource();
  const viewport = new ViewportImpl({
    lineCount: source.lineCount(),
    lineHeight: Math.ceil(TEXT_STYLE.sizePx * 1.4),
    viewportHeight: surface.clientHeight || 1,
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
      ? new DocumentController(bridge, source, viewport, renderer)
      : undefined;

  const initialPath = documentPath();
  let opened = false;
  if (controller !== undefined && initialPath !== undefined) {
    opened = await controller.open(initialPath);
  } else if (bridge !== undefined) {
    console.info("Scribe: ponte do preload presente, mas sem ?file= — renderer em modo demo");
  }
  if (!opened) {
    source.setText(demoText(), 0);
    viewport.setMetrics({ lineCount: source.lineCount() });
    if (initialPath === undefined) {
      setDocStatus(bridge === undefined ? "demo (sem preload)" : "demo (sem ?file=)");
    }
  }

  const globalScope = globalThis as { attachLineSource?: (source: LineSource) => void };
  globalScope.attachLineSource = (next: LineSource): void => renderer.attachSource(next);

  attachInputListeners(surface, viewport, renderer, controller);
  window.addEventListener("resize", () => renderer.resize(surface.clientWidth, surface.clientHeight));
  renderer.start();
  return true;
}

function assertiveContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Scribe: contexto 2D indisponível no #editor-surface");
  return ctx;
}

function attachInputListeners(
  surface: HTMLCanvasElement,
  viewport: ViewportImpl,
  renderer: ScribeRenderer,
  controller: DocumentController | undefined,
): void {
  const lineHeight = Math.ceil(TEXT_STYLE.sizePx * 1.4);
  const currentLine = (): number => Math.floor(viewport.scrollOffsetPx() / lineHeight);

  surface.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      viewport.scrollTo(currentLine() + Math.sign(event.deltaY) * 3);
    },
    { passive: false },
  );

  surface.addEventListener("keydown", (event: KeyboardEvent) => {
    const primary = event.ctrlKey || event.metaKey;

    // Atalhos de documento: Ctrl/Cmd+O (abrir), Ctrl/Cmd+Z (undo), Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y
    // (redo) e Esc durante "abrindo…" (cancela a abertura em curso).
    if (primary && !event.altKey && (event.key === "o" || event.key === "O")) {
      event.preventDefault();
      if (controller !== undefined) void controller.openDialog();
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
    if (event.key === "Escape") {
      if (controller !== undefined && controller.cancelOpening()) {
        event.preventDefault();
        return;
      }
    }

    const page = Math.max(1, Math.floor(surface.clientHeight / lineHeight) - 1);
    const line = viewport.visibleLineRange();
    if (event.key === "PageDown") viewport.scrollTo(currentLine() + page, { animate: true });
    else if (event.key === "PageUp") viewport.scrollTo(currentLine() - page, { animate: true });
    else if (event.key === "Home") viewport.scrollTo(0, { animate: true });
    else if (event.key === "End") viewport.scrollTo(line.first + 1_000_000, { animate: true });
    else if (controller !== undefined && controller.current !== undefined && isPrintable(event)) {
      event.preventDefault();
      void controller.insertText(event.key);
      return;
    } else return;
    event.preventDefault();
    renderer.start();
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
