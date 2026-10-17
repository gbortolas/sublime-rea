/**
 * Scribe — contratos de fronteira: render, viewport e instâncias de desenho.
 *
 * Fonte: `docs/architecture/04-render-e-ui.md` (DEC-REN-1..8) + invariantes de `06`.
 *
 * Reconciliação: `RenderPipeline` aparecia com **dois** shapes — `02:292` (subset:
 * `invalidate`/`measure`) e `04:216` (completo). Canônico = **`04`**, absorvendo os dois métodos
 * de `02` (o `02` só precisava da view de invalidação). O `RenderBackend` de `06:287` é **o
 * mesmo conceito** → alias, não um segundo tipo.
 *
 * Invariantes (o teste tem que provar — `04:244-248`):
 * - o backend **não** conhece a árvore de controles (quem monta instâncias é a `Viewport`);
 * - `flush()` é idempotente; tetos de glifo/quad valem para **um** frame;
 * - desenhar fora de `beginFrame`/`present` é **erro**;
 * - a troca de textura do atlas é a **única** (`NEAREST`/`CLAMP_TO_EDGE`);
 * - o default de fábrica é **CPU** (`canvas2d`), e falha de WebGPU é **erro explícito**, nunca
 *   fallback silencioso (DEC-REN-2).
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type DamageRects = readonly Rect[];

/** Cor empacotada em sRGB `0xRRGGBBAA` (o alvo usa RGBA8 em todo lugar — REN-E5/E17). */
export type RGBA = number;

/** Deslocamento subpixel horizontal em três amostras (two-pass, DEC-REN-8). */
export type SubpixelOffsets = readonly [number, number, number];

/** Instância de glifo: posicionamento vem da CPU, o atlas já está rasterizado (DEC-REN-5). */
export interface GlyphInstance {
  readonly atlasX: number;
  readonly atlasY: number;
  readonly atlasW: number;
  readonly atlasH: number;
  readonly x: number;
  readonly y: number;
  readonly color: RGBA;
  readonly subpixel?: SubpixelOffsets;
}

export interface RectInstance {
  readonly rect: Rect;
  readonly color: RGBA;
  readonly radius?: number;
}

/**
 * Instância de traço/underline (o doc `04` referencia sem definir) — escolha nossa.
 * Modo estrito de reta: o backend decide o espessamento.
 */
export interface LineInstance {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly thickness: number;
  readonly color: RGBA;
}

export interface GlyphMetrics {
  readonly advance: number;
  readonly bearingX: number;
  readonly bearingY: number;
  readonly width: number;
  readonly height: number;
}

/** Descrição de estilo (entrada do cache de shaping). */
export interface TextStyle {
  readonly family: string;
  readonly sizePx: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly features?: readonly string[];
}

/** Chave estável de estilo (hash da descrição) — a face do cache de glifos (DEC-REN-5). */
export type TextStyleKey = string;

/**
 * Backend de desenho. A árvore de controles fala **só** com isto (DEC-REN-1).
 * `kind` é observável porque o boot loga o backend efetivo (DEC-TR-7).
 */
export interface RenderPipeline {
  readonly kind: "webgpu" | "canvas2d";
  beginFrame(viewport: Rect): void;
  setClip(region: Rect | null): void;
  pushRects(batch: readonly RectInstance[]): void;
  pushLines(batch: readonly LineInstance[]): void;
  pushGlyphs(batch: readonly GlyphInstance[]): void;
  /** Damage vindo da `Viewport` (DEC-REN-3): coalescido no frame do `Scheduler`. */
  invalidate(damage: DamageRects): void;
  /** Métrica de texto sem desenhar — usado por layout (vem do `02`). */
  measure(text: string, style: TextStyleKey): GlyphMetrics;
  /** **Idempotente**: envia os batches acumulados. */
  flush(): void;
  present(damage: DamageRects): void;
  dispose(): void;
  /** Guias de indentação a desenhar no próximo lote (v1). */
  setIndentGuides(
    guides: readonly { readonly x: number; readonly top: number; readonly bottom: number }[] | undefined,
  ): void;
}

/** Nome alternativo usado em `06` — mesmo contrato. */
export type RenderBackend = RenderPipeline;

/** Observador de damage da viewport (DEC-REN-3). */
export interface ViewportObserver {
  onDamage(rects: DamageRects): void;
}

/**
 * Janela virtualizada: só a região visível existe como instâncias (DEC-REN-7 — proibido nó
 * DOM por linha). `scrollTo` animado passa por estado intermediário, não por layout reflow.
 */
export interface Viewport {
  visibleLineRange(): { readonly first: number; readonly count: number };
  subscribe(observer: ViewportObserver): () => void;
  scrollTo(line: number, opts?: { readonly animate?: boolean }): void;
  /** Damage acumulado desde o último `take()`. */
  takeDamage(): DamageRects;
  dispose(): void;
}

/** Teto de instâncias por frame (DEC-REN-4) — estourar é erro, não degradação silenciosa. */
export const MAX_GLYPH_INSTANCES = 8192;
export const MAX_STENCIL_QUAD_INSTANCES = 128;

/** Tamanhos de atlas suportados (REN-E17): `RGBA8`, potência de dois. */
export const ATLAS_SIZES = [1024, 4096] as const;
export type AtlasSize = (typeof ATLAS_SIZES)[number];

/** Backend default de fábrica = CPU (DEC-REN-2). */
export const DEFAULT_RENDER_BACKEND = "canvas2d" as const;
export type RenderBackendKind = "canvas2d" | "webgpu";

/** Controles expostos pela `PropertySystem` que governam o boot do render. */
export const RENDER_BACKEND_PROPERTY = "render.backend";
