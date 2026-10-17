/**
 * Scribe — `BaseRenderPipeline`: base abstrata do desenho (padrão do alvo, reimplementação nossa).
 *
 * Fonte: `docs/architecture/04-render-e-ui.md` §4/§5 (DEC-REN-1..8) e as **invariantes** de
 * `04:244-248`, que este arquivo faz cumprir:
 *
 *  1. o backend **não** conhece a árvore de controles — só recebe *instâncias*;
 *  2. `flush()` é **idempotente** e dispara no teto (`MAX_GLYPH_INSTANCES` /
 *     `MAX_STENCIL_QUAD_INSTANCES`) ou no fim de camada;
 *  3. desenhar fora de `beginFrame`/`present` é **erro tipado** (`DrawOutsideFrameError`);
 *  4. o atlas é a única troca de textura de texto (fica a cargo do backend).
 *
 * Fluxo de frame: `Viewport` publica *damage* → `invalidate(damage)` → `beginFrame(viewport)` →
 * `setClip`/`push*` (acumula instâncias por família) → `flush()` → `present(damage)`.
 *
 * Tetos: o estouro **lança** (`BatchLimitExceededError`) — degradar em silêncio é proibido. O teto
 * vale para o *batch* acumulado (o `flush` zera o batch); chegar **exatamente** no teto dispara um
 * `flush` automático.
 */

import type {
  DamageRects,
  GlyphInstance,
  GlyphMetrics,
  LineInstance,
  Rect,
  RectInstance,
  RenderPipeline,
  TextStyleKey,
} from "../../shared";
import { MAX_GLYPH_INSTANCES, MAX_STENCIL_QUAD_INSTANCES } from "../../shared";
import type { GlyphAtlas } from "./atlas";
import { BatchLimitExceededError, DrawOutsideFrameError, FrameStateError, RenderDisposedError } from "./errors";

/** Lote pronto para o backend: instâncias de um mesmo `clip` retangular. */
export interface DrawBatch {
  readonly clip: Rect | null;
  readonly rects: readonly RectInstance[];
  readonly lines: readonly LineInstance[];
  readonly glyphs: readonly GlyphInstance[];
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Base comum dos backends. Concreta o *acúmulo* de instâncias, as invariantes de frame e os tetos;
 * as subclasses só implementam `draw(batch)` (+ hooks opcionais).
 */
export abstract class BaseRenderPipeline implements RenderPipeline {
  abstract readonly kind: "webgpu" | "canvas2d";

  protected readonly atlas: GlyphAtlas;

  private frameOpen = false;
  private disposed = false;
  private dirty = false;
  private clip: Rect | null = null;
  private rects: RectInstance[] = [];
  private lines: LineInstance[] = [];
  private glyphs: GlyphInstance[] = [];
  private pendingDamage: Rect[] = [];

  protected constructor(atlas: GlyphAtlas) {
    this.atlas = atlas;
  }

  get isFrameOpen(): boolean {
    return this.frameOpen;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  beginFrame(viewport: Rect): void {
    this.assertAlive();
    if (this.frameOpen) throw new FrameStateError("beginFrame chamado com um frame já aberto");
    if (this.dirty) throw new FrameStateError("frame anterior não foi apresentado antes de beginFrame");
    this.frameOpen = true;
    this.clip = null;
    const damage = this.pendingDamage;
    this.pendingDamage = [];
    this.onBeginFrame(viewport, damage);
  }

  setClip(region: Rect | null): void {
    this.assertFrame("setClip");
    if (sameRect(this.clip, region)) return;
    // O batch corrente pertence ao clip anterior — fecha-o antes de trocar.
    if (this.dirty) this.flush();
    this.clip = region;
  }

  pushRects(batch: readonly RectInstance[]): void {
    this.assertFrame("pushRects");
    if (batch.length === 0) return;
    const next = this.rects.length + batch.length;
    if (next > MAX_STENCIL_QUAD_INSTANCES) {
      throw new BatchLimitExceededError("rect-quad", MAX_STENCIL_QUAD_INSTANCES, next);
    }
    for (const item of batch) this.rects.push(item);
    this.dirty = true;
    if (this.rects.length === MAX_STENCIL_QUAD_INSTANCES) this.flush();
  }

  pushLines(batch: readonly LineInstance[]): void {
    this.assertFrame("pushLines");
    if (batch.length === 0) return;
    for (const item of batch) this.lines.push(item);
    this.dirty = true;
  }

  pushGlyphs(batch: readonly GlyphInstance[]): void {
    this.assertFrame("pushGlyphs");
    if (batch.length === 0) return;
    const next = this.glyphs.length + batch.length;
    if (next > MAX_GLYPH_INSTANCES) {
      throw new BatchLimitExceededError("glyph", MAX_GLYPH_INSTANCES, next);
    }
    for (const item of batch) this.glyphs.push(item);
    this.dirty = true;
    if (this.glyphs.length === MAX_GLYPH_INSTANCES) this.flush();
  }

  /** **Idempotente**: sem instâncias novas acumuladas, não emite nada. */
  flush(): void {
    this.assertFrame("flush");
    if (!this.dirty) return;
    const batch: DrawBatch = {
      clip: this.clip,
      rects: this.rects,
      lines: this.lines,
      glyphs: this.glyphs,
    };
    this.rects = [];
    this.lines = [];
    this.glyphs = [];
    this.dirty = false;
    this.draw(batch);
  }

  invalidate(damage: DamageRects): void {
    this.assertAlive();
    for (const rect of damage) this.pendingDamage.push(rect);
    this.onInvalidate(damage);
  }

  measure(text: string, style: TextStyleKey): GlyphMetrics {
    this.assertAlive();
    return this.atlas.measure(text, style);
  }

  present(damage: DamageRects): void {
    this.assertFrame("present");
    if (this.dirty) this.flush();
    this.frameOpen = false;
    this.clip = null;
    this.onPresent(damage);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameOpen = false;
    this.rects = [];
    this.lines = [];
    this.glyphs = [];
    this.pendingDamage = [];
    this.onDispose();
  }

  /** Implementado pelo backend: desenha um lote já acumulado (clip, rects, linhas, glifos). */
  protected abstract draw(batch: DrawBatch): void;

  protected onBeginFrame(_viewport: Rect, _damage: DamageRects): void {
    /* opcional */
  }

  protected onInvalidate(_damage: DamageRects): void {
    /* opcional */
  }

  protected onPresent(_damage: DamageRects): void {
    /* opcional */
  }

  protected onDispose(): void {
    /* opcional */
  }

  private assertFrame(operation: string): void {
    this.assertAlive();
    if (!this.frameOpen) throw new DrawOutsideFrameError(operation);
  }

  private assertAlive(): void {
    if (this.disposed) throw new RenderDisposedError();
  }
}
