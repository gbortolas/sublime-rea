/**
 * Scribe — `Canvas2DBackend`: backend **CPU por padrão** (DEC-REN-1/2).
 *
 * Desenho **imediato** sobre o raster do Chromium (`CanvasRenderingContext2D`), espelhando o
 * `skia_render_context` do alvo (`REN-E21`, `REN-E22`) trocado pelo canvas nativo (divergência
 * D5 de `04`). Nada de nó DOM por linha (DEC-REN-7): só primitivas de raster.
 *
 * Mapeamento primitiva → chamada:
 * - `RectInstance`  → `fillRect` (ou caminho arredondado via `arcTo` quando há `radius`);
 * - `GlyphInstance` → `drawImage` do **atlas**; subpixel = 3 desenhos com offset + alpha/3;
 * - `LineInstance`  → `stroke` de traço fino.
 *
 * `setClip` é aplicado por lote com `save`/`restore` balanceados em `draw` (sem pilha solta).
 *
 * O contexto é aceito por **interface estrutural** (`Canvas2DContextLike`) para permitir um
 * contexto 2D *fake* nos testes (sem DOM/GUI) — `CanvasRenderingContext2D` real a satisfaz.
 */

import type { GlyphInstance, LineInstance, Rect, RectInstance } from "../../shared";
import { alphaOf, cssColor, type GlyphAtlas } from "./atlas";
import { RenderError } from "./errors";
import { BaseRenderPipeline, type DrawBatch } from "./pipeline";

/** Subconjunto de `CanvasRenderingContext2D` usado pelo backend (fakeável). */
export interface Canvas2DContextLike {
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  lineWidth: number;
}

export interface Canvas2DBackendOptions {
  /** Superfície do atlas (default: `atlas.image`). Sem ela, não há como desenhar glifos. */
  readonly image?: CanvasImageSource;
}

const SUBPIXEL_PASSES = 3 as const;

export class Canvas2DBackend extends BaseRenderPipeline {
  override readonly kind = "canvas2d" as const;

  private readonly ctx: Canvas2DContextLike;
  private readonly image: CanvasImageSource;

  constructor(ctx: Canvas2DContextLike, atlas: GlyphAtlas, options: Canvas2DBackendOptions = {}) {
    super(atlas);
    const image = options.image ?? atlas.image;
    if (!image) {
      throw new RenderError(
        "render/canvas2d-no-atlas-image",
        "Canvas2DBackend exige a superfície do atlas (atlas.image ou options.image) para os glifos",
      );
    }
    this.ctx = ctx;
    this.image = image;
  }

  /** Ajusta o espaço lógico (ex.: escala por *device pixel ratio*). */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ctx.setTransform(a, b, c, d, e, f);
  }

  protected override onBeginFrame(viewport: Rect, damage: readonly Rect[]): void {
    const { ctx } = this;
    if (damage.length === 0) {
      ctx.clearRect(viewport.x, viewport.y, viewport.w, viewport.h);
      return;
    }
    for (const rect of damage) ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
  }

  protected override draw(batch: DrawBatch): void {
    const { ctx } = this;
    ctx.save();
    if (batch.clip) {
      ctx.beginPath();
      ctx.rect(batch.clip.x, batch.clip.y, batch.clip.w, batch.clip.h);
      ctx.clip();
    }
    for (const rect of batch.rects) this.drawRect(rect);
    for (const line of batch.lines) this.drawLine(line);
    for (const glyph of batch.glyphs) this.drawGlyph(glyph);
    ctx.restore();
  }

  private drawRect(instance: RectInstance): void {
    const { ctx } = this;
    const { rect, color, radius } = instance;
    ctx.fillStyle = cssColor(color);
    if (radius !== undefined && radius > 0) {
      const r = Math.min(radius, rect.w / 2, rect.h / 2);
      ctx.beginPath();
      ctx.moveTo(rect.x + r, rect.y);
      ctx.lineTo(rect.x + rect.w - r, rect.y);
      ctx.arcTo(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + r, r);
      ctx.lineTo(rect.x + rect.w, rect.y + rect.h - r);
      ctx.arcTo(rect.x + rect.w, rect.y + rect.h, rect.x + rect.w - r, rect.y + rect.h, r);
      ctx.lineTo(rect.x + r, rect.y + rect.h);
      ctx.arcTo(rect.x, rect.y + rect.h, rect.x, rect.y + rect.h - r, r);
      ctx.lineTo(rect.x, rect.y + r);
      ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r);
      ctx.closePath();
      ctx.fill();
      return;
    }
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  private drawLine(instance: LineInstance): void {
    const { ctx } = this;
    ctx.strokeStyle = cssColor(instance.color);
    ctx.lineWidth = Math.max(instance.thickness, 1);
    ctx.beginPath();
    ctx.moveTo(instance.x0, instance.y0);
    ctx.lineTo(instance.x1, instance.y1);
    ctx.stroke();
  }

  private drawGlyph(instance: GlyphInstance): void {
    const { ctx } = this;
    const { atlasX, atlasY, atlasW, atlasH, x, y, color, subpixel } = instance;
    const alpha = alphaOf(color);
    if (subpixel) {
      // Two-pass horizontal (DEC-REN-8): três desenhos levemente deslocados, alpha fracionado.
      const per = alpha / SUBPIXEL_PASSES;
      for (let i = 0; i < SUBPIXEL_PASSES; i++) {
        ctx.globalAlpha = per;
        ctx.drawImage(this.image, atlasX, atlasY, atlasW, atlasH, x + (subpixel[i] ?? 0), y, atlasW, atlasH);
      }
      return;
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.image, atlasX, atlasY, atlasW, atlasH, x, y, atlasW, atlasH);
  }
}
