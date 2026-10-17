/**
 * Scribe — `ViewportImpl`: janela virtualizada com *damage* retangular (DEC-REN-4).
 *
 * Padrão do alvo (reimplementação nossa — **escolha nossa, não observada no alvo**): *data source*
 * + *observers* + **alvo animado** (`REN-E19`), frames agendados por um *tick* injetado (o alvo usa
 * o *tick* do toolkit; nós usamos `requestAnimationFrame` — `REN-E3`).
 *
 * Critério de visibilidade (**nosso**, pois `REN-U1` ficou em aberto): range por **índice de linha**
 * `floor(offset / lineHeight) .. + ceil(viewportHeight / lineHeight)`, mais `overscan` opcional.
 *
 * Determinismo: `now()` e `requestFrame()` são **injetados** — nada de `setInterval`, nada de relógio
 * implícito. O *damage* é **coalescido** por índice de linha: N passos de scroll geram **uma** região
 * por linha tocada (em coordenadas de conteúdo: `y = linha * lineHeight`).
 */

import type { DamageRects, Rect, Viewport, ViewportObserver } from "../../shared";
import type { Disposable } from "../../shared";

/** Range de linhas (início + contagem) — metade do contrato de `visibleLineRange()`. */
export interface LineRange {
  readonly first: number;
  readonly count: number;
}

export interface ViewportMetrics {
  readonly lineCount: number;
  readonly lineHeight: number;
  /** Altura da área visível em px lógicos. */
  readonly viewportHeight: number;
  /** Largura da área visível em px lógicos (usada na largura dos retângulos de dano). */
  readonly viewportWidth: number;
  /** Linhas extras acima/abaixo (default 0 — mantém a virtualização estrita nos testes). */
  readonly overscan?: number;
}

export interface ViewportOptions extends ViewportMetrics {
  /** Relógio injetado (determinismo; em produção: `performance.now`). */
  readonly now: () => number;
  /** Agendador de frame injetado (em produção: `requestAnimationFrame`). */
  readonly requestFrame: (cb: (now: number) => void) => Disposable;
  /** Duração da animação de scroll (ms). `0`/ausente = salto imediato. */
  readonly scrollDurationMs?: number;
}

type ResolvedMetrics = Required<ViewportMetrics>;

interface AnimationState {
  readonly from: number;
  readonly to: number;
  readonly start: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class ViewportImpl implements Viewport {
  private metrics: ResolvedMetrics;
  private readonly nowFn: () => number;
  private readonly requestFrameFn: (cb: (now: number) => void) => Disposable;
  private readonly scrollDurationMs: number;

  private readonly observers = new Set<ViewportObserver>();
  private readonly damageLines = new Set<number>();
  private offsetPx = 0;
  private animation: AnimationState | null = null;
  private animationHandle: Disposable | undefined;
  private disposed = false;

  constructor(options: ViewportOptions) {
    this.metrics = {
      lineCount: options.lineCount,
      lineHeight: options.lineHeight,
      viewportHeight: options.viewportHeight,
      viewportWidth: options.viewportWidth,
      overscan: options.overscan ?? 0,
    };
    this.nowFn = options.now;
    this.requestFrameFn = options.requestFrame;
    this.scrollDurationMs = options.scrollDurationMs ?? 0;
  }

  /** Range visível (virtualização): só estas linhas geram instâncias. */
  visibleLineRange(): LineRange {
    const { lineHeight, viewportHeight, lineCount, overscan } = this.metrics;
    if (lineCount <= 0 || lineHeight <= 0 || viewportHeight <= 0) {
      return { first: 0, count: 0 };
    }
    const visible = Math.ceil(viewportHeight / lineHeight);
    const firstVisible = Math.floor(this.offsetPx / lineHeight);
    const first = Math.max(0, firstVisible - overscan);
    const end = Math.min(lineCount, firstVisible + visible + overscan);
    return { first, count: Math.max(0, end - first) };
  }

  subscribe(observer: ViewportObserver): () => void {
    if (this.disposed) return () => undefined;
    this.observers.add(observer);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      this.observers.delete(observer);
    };
  }

  scrollTo(line: number, opts?: { readonly animate?: boolean }): void {
    if (this.disposed) return;
    const { lineHeight, lineCount } = this.metrics;
    const targetLine = clamp(Math.round(line), 0, Math.max(0, lineCount - 1));
    const target = clamp(targetLine * lineHeight, 0, this.maxScrollPx());
    const animate = opts?.animate === true && this.scrollDurationMs > 0;
    this.cancelAnimation();

    if (!animate || Math.abs(target - this.offsetPx) < 0.5) {
      const touched = this.applyOffset(target);
      this.notify(touched);
      return;
    }

    const from = this.offsetPx;
    const start = this.nowFn();
    const animation: AnimationState = { from, to: target, start };
    this.animation = animation;
    const step = (now: number): void => {
      if (this.animation !== animation) return; // cancelada
      const t = clamp((now - start) / this.scrollDurationMs, 0, 1);
      const touched = this.applyOffset(from + (target - from) * easeInOutCubic(t));
      if (t >= 1) {
        this.animation = null;
        this.animationHandle = undefined;
        this.notify(touched);
        return;
      }
      this.notify(touched);
      this.animationHandle = this.requestFrameFn(step);
    };
    this.animationHandle = this.requestFrameFn(step);
  }

  /** Damage acumulado (coalescido por linha) desde o último `takeDamage()`. */
  takeDamage(): DamageRects {
    if (this.damageLines.size === 0) return [];
    const indices = [...this.damageLines].sort((a, b) => a - b);
    this.damageLines.clear();
    return indices.map((index) => this.rectForLine(index));
  }

  /** Offset de rolagem atual em px (método de conveniência; não é do contrato). */
  scrollOffsetPx(): number {
    return this.offsetPx;
  }

  /** Atualiza métricas quando o documento/canvas muda (ex.: resize, edição). */
  setMetrics(next: Partial<ViewportMetrics>): void {
    if (this.disposed) return;
    this.metrics = {
      lineCount: next.lineCount ?? this.metrics.lineCount,
      lineHeight: next.lineHeight ?? this.metrics.lineHeight,
      viewportHeight: next.viewportHeight ?? this.metrics.viewportHeight,
      viewportWidth: next.viewportWidth ?? this.metrics.viewportWidth,
      overscan: next.overscan ?? this.metrics.overscan,
    };
    const clamped = clamp(this.offsetPx, 0, this.maxScrollPx());
    if (clamped !== this.offsetPx) this.applyOffset(clamped);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAnimation();
    this.observers.clear();
    this.damageLines.clear();
  }

  private maxScrollPx(): number {
    return Math.max(0, this.metrics.lineCount * this.metrics.lineHeight - this.metrics.viewportHeight);
  }

  private cancelAnimation(): void {
    this.animation = null;
    this.animationHandle?.dispose();
    this.animationHandle = undefined;
  }

  /**
   * Aplica um novo offset e devolve as linhas **tocadas** (diferença simétrica das linhas visíveis
   * antes/depois). Linhas que apenas transladam não entram no dano — a região é reutilizada.
   */
  private applyOffset(next: number): number[] {
    const before = this.visibleLineIndices();
    this.offsetPx = clamp(next, 0, this.maxScrollPx());
    const after = this.visibleLineIndices();
    const touched: number[] = [];
    for (const index of before) {
      if (!after.has(index)) touched.push(index);
    }
    for (const index of after) {
      if (!before.has(index)) touched.push(index);
    }
    for (const index of touched) this.damageLines.add(index);
    return touched;
  }

  private visibleLineIndices(): Set<number> {
    const { first, count } = this.visibleLineRange();
    const set = new Set<number>();
    for (let i = first; i < first + count; i++) set.add(i);
    return set;
  }

  private rectForLine(index: number): Rect {
    return {
      x: 0,
      y: index * this.metrics.lineHeight,
      w: this.metrics.viewportWidth,
      h: this.metrics.lineHeight,
    };
  }

  private notify(touched: readonly number[]): void {
    if (touched.length === 0 || this.observers.size === 0) return;
    const rects: DamageRects = touched.map((index) => this.rectForLine(index));
    let firstError: unknown;
    for (const observer of [...this.observers]) {
      try {
        observer.onDamage(rects);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
