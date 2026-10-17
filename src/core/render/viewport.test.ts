/**
 * Testes do `ViewportImpl`: virtualização, dano coalescido e animação determinística (frame/relógio
 * injetados — nada de `setInterval`).
 */
import { describe, expect, it } from "vitest";
import type { DamageRects, Disposable } from "../../shared";
import { ViewportImpl } from "./viewport";

class ManualFrames {
  private pending: ((now: number) => void) | null = null;

  readonly request = (cb: (now: number) => void): Disposable => {
    this.pending = cb;
    return {
      dispose: (): void => {
        if (this.pending === cb) this.pending = null;
      },
    };
  };

  get hasPending(): boolean {
    return this.pending !== null;
  }

  run(now: number): void {
    const cb = this.pending;
    this.pending = null;
    if (cb) cb(now);
  }
}

interface SetupOverrides {
  readonly lineCount?: number;
  readonly lineHeight?: number;
  readonly viewportHeight?: number;
  readonly viewportWidth?: number;
  readonly overscan?: number;
  readonly scrollDurationMs?: number;
}

function setup(overrides: SetupOverrides = {}): {
  viewport: ViewportImpl;
  frames: ManualFrames;
  clock: { t: number };
} {
  const clock = { t: 0 };
  const frames = new ManualFrames();
  const viewport = new ViewportImpl({
    lineCount: overrides.lineCount ?? 100,
    lineHeight: overrides.lineHeight ?? 10,
    viewportHeight: overrides.viewportHeight ?? 30,
    viewportWidth: overrides.viewportWidth ?? 100,
    overscan: overrides.overscan ?? 0,
    now: (): number => clock.t,
    requestFrame: frames.request,
    scrollDurationMs: overrides.scrollDurationMs ?? 0,
  });
  return { viewport, frames, clock };
}

describe("ViewportImpl — virtualização", () => {
  it("visibleLineRange cobre só linhas visíveis", () => {
    const { viewport } = setup();
    expect(viewport.visibleLineRange()).toEqual({ first: 0, count: 3 });
  });

  it("scrollTo atualiza o range visível", () => {
    const { viewport } = setup();
    viewport.scrollTo(5);
    expect(viewport.visibleLineRange()).toEqual({ first: 5, count: 3 });
    expect(viewport.scrollOffsetPx()).toBe(50);
  });

  it("clampa o alvo ao máximo de scroll", () => {
    const { viewport } = setup();
    viewport.scrollTo(999);
    expect(viewport.scrollOffsetPx()).toBe(970); // 100*10 - 30
  });

  it("overscan amplia o range por cima e por baixo", () => {
    const { viewport } = setup({ overscan: 2 });
    viewport.scrollTo(5);
    expect(viewport.visibleLineRange()).toEqual({ first: 3, count: 7 });
  });
});

describe("ViewportImpl — dano coalescido", () => {
  it("N scrolls geram uma região por linha tocada (sem duplicar)", () => {
    const { viewport } = setup();
    viewport.takeDamage(); // descarta o dano inicial (nenhum)
    viewport.scrollTo(1);
    viewport.scrollTo(2);
    const damage = viewport.takeDamage();
    // Linhas que saíram/entraram: 0 e 3 (1º scroll) + 1 e 4 (2º scroll) — a linha 2 ficou sempre visível.
    expect(damage.map((r) => r.y)).toEqual([0, 10, 30, 40]);
    // Cada linha tocada aparece uma única vez.
    expect(new Set(damage.map((r) => r.y)).size).toBe(damage.length);
    // Segundo take limpa o acumulado.
    expect(viewport.takeDamage()).toEqual([]);
  });

  it("scroll sem mudança de linhas não gera dano", () => {
    const { viewport } = setup();
    viewport.scrollTo(5);
    viewport.takeDamage();
    viewport.scrollTo(5);
    expect(viewport.takeDamage()).toEqual([]);
  });

  it("notifica observers com o dano do passo", () => {
    const { viewport } = setup();
    const received: DamageRects[] = [];
    viewport.subscribe({ onDamage: (rects) => received.push(rects) });
    viewport.scrollTo(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.map((r) => r.y)).toEqual([0, 30]);
  });
});

describe("ViewportImpl — animação determinística", () => {
  it("usa o frame injetado e converge para o alvo", () => {
    const { viewport, frames } = setup({ scrollDurationMs: 100 });
    viewport.scrollTo(20, { animate: true });
    expect(viewport.scrollOffsetPx()).toBe(0);
    expect(frames.hasPending).toBe(true);

    frames.run(0);
    expect(viewport.scrollOffsetPx()).toBe(0);
    frames.run(50);
    const mid = viewport.scrollOffsetPx();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(200);
    frames.run(100);
    expect(viewport.scrollOffsetPx()).toBe(200);
    expect(frames.hasPending).toBe(false);
  });

  it("sem animate (ou duração 0) salta direto", () => {
    const { viewport, frames } = setup();
    viewport.scrollTo(20, { animate: true });
    expect(viewport.scrollOffsetPx()).toBe(200);
    expect(frames.hasPending).toBe(false);
  });

  it("novo scrollTo cancela a animação anterior", () => {
    const { viewport, frames } = setup({ scrollDurationMs: 100 });
    viewport.scrollTo(20, { animate: true });
    viewport.scrollTo(40, { animate: true });
    expect(frames.hasPending).toBe(true);
    frames.run(100);
    expect(viewport.scrollOffsetPx()).toBe(400);
    expect(frames.hasPending).toBe(false);
  });
});

describe("ViewportImpl — dispose", () => {
  it("para de reagir após dispose", () => {
    const { viewport } = setup();
    viewport.dispose();
    viewport.scrollTo(5);
    expect(viewport.scrollOffsetPx()).toBe(0);
    expect(viewport.takeDamage()).toEqual([]);
  });
});
