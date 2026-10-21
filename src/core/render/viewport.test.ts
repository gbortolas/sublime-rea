/**
 * Testes do `ViewportImpl`: virtualização, dano coalescido e animação determinística (frame/relógio
 * injetados — nada de `setInterval`).
 */
import { describe, expect, it } from "vitest";
import type { DamageRects, Disposable } from "../../shared";
import { ViewportImpl, type VisualRowMapper } from "./viewport";

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
  readonly visualLineCount?: number;
  readonly visualRowMapper?: VisualRowMapper;
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
    ...(overrides.visualLineCount !== undefined ? { visualLineCount: overrides.visualLineCount } : {}),
    ...(overrides.visualRowMapper !== undefined ? { visualRowMapper: overrides.visualRowMapper } : {}),
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

/* ─────────────────────── modo soft wrap (rows visuais) ─────────────────────── */

describe("ViewportImpl — modo soft wrap (rows visuais)", () => {
  /**
   * Mapa de exemplo: a linha 0 ocupa 3 rows (0, 1, 2), a linha 1 ocupa 2 rows (3, 4) e a
   * linha 2 ocupa 1 row (5).
   */
  const rowStarts = [0, 3, 5, 6];
  const mapper: VisualRowMapper = {
    rowOfLine: (line: number): number => rowStarts[Math.min(Math.max(line, 0), rowStarts.length - 1)] ?? 0,
    lineOfRow: (row: number): number => {
      let line = 0;
      for (let i = 0; i < rowStarts.length; i++) {
        if ((rowStarts[i] ?? 0) <= row) line = i;
      }
      return line;
    },
  };

  /** Viewport de 3 linhas, 2 rows visíveis, 8 rows no total. */
  function wrapSetup(withMapper: boolean): { viewport: ViewportImpl } {
    const { viewport } = setup({
      lineCount: 3,
      lineHeight: 10,
      viewportHeight: 20,
      visualLineCount: 8,
      ...(withMapper ? { visualRowMapper: mapper } : {}),
    });
    return { viewport };
  }

  it("sem o mapper, o viewport conta em linhas lógicas (comportamento legado)", () => {
    const { viewport } = wrapSetup(false);
    viewport.scrollTo(2);
    expect(viewport.scrollOffsetPx()).toBe(20);
    expect(viewport.visibleLineRange()).toEqual({ first: 2, count: 1 });
  });

  it("com o mapper, a rolagem é contada em rows visuais", () => {
    const { viewport } = wrapSetup(true);
    // A linha 2 começa na row 5 → 5 * lineHeight.
    viewport.scrollTo(2);
    expect(viewport.scrollOffsetPx()).toBe(50);
  });

  it("visibleLineRange devolve as linhas lógicas que cobrem as rows visíveis", () => {
    const { viewport } = wrapSetup(true);
    // Row 0 → linha 0; a faixa visível (2 rows) cobre as rows 0..1 → linha 0.
    expect(viewport.visibleLineRange()).toEqual({ first: 0, count: 1 });
    viewport.scrollTo(1); // row 3 → linha 1
    expect(viewport.visibleLineRange()).toEqual({ first: 1, count: 1 });
  });

  it("o dano cobre todas as rows da linha tocada", () => {
    const { viewport } = wrapSetup(true);
    viewport.scrollTo(1); // linha 1 (row 3)
    const damage = viewport.takeDamage();
    // A linha 0 (rows 0..2) saiu da faixa; a linha 1 (rows 3..4) entrou.
    expect(damage.map((r) => ({ y: r.y, h: r.h }))).toEqual([
      { y: 0, h: 30 },
      { y: 30, h: 20 },
    ]);
  });

  it("setVisualRowMapper alterna o modo em tempo de execução", () => {
    const { viewport } = wrapSetup(false);
    viewport.setVisualRowMapper(mapper);
    viewport.scrollTo(2);
    expect(viewport.scrollOffsetPx()).toBe(50);
    viewport.setVisualRowMapper(undefined);
    viewport.scrollTo(2);
    expect(viewport.scrollOffsetPx()).toBe(20);
  });
});

describe("ViewportImpl — rolagem em rows (roda do mouse / PageUp-PageDown)", () => {
  /**
   * Mapa de exemplo: a linha 0 ocupa 3 rows (0, 1, 2), a linha 1 ocupa 2 rows (3, 4) e a
   * linha 2 ocupa 1 row (5).
   */
  const rowStarts = [0, 3, 5, 6];
  const mapper: VisualRowMapper = {
    rowOfLine: (line: number): number => rowStarts[Math.min(Math.max(line, 0), rowStarts.length - 1)] ?? 0,
    lineOfRow: (row: number): number => {
      let line = 0;
      for (let i = 0; i < rowStarts.length; i++) {
        if ((rowStarts[i] ?? 0) <= row) line = i;
      }
      return line;
    },
  };

  function wrapSetup(withMapper: boolean): { viewport: ViewportImpl } {
    const { viewport } = setup({
      lineCount: 3,
      lineHeight: 10,
      viewportHeight: 20,
      visualLineCount: 8,
      ...(withMapper ? { visualRowMapper: mapper } : {}),
    });
    return { viewport };
  }

  it("scrollByRows move N rows (não N linhas lógicas) com o mapper ativo", () => {
    const { viewport } = wrapSetup(true);
    viewport.scrollByRows(2);
    expect(viewport.scrollOffsetPx()).toBe(20); // 2 rows × 10px
    viewport.scrollByRows(-1);
    expect(viewport.scrollOffsetPx()).toBe(10); // 1 row × 10px
  });

  it("scrollByRows clampa no fim do documento (em rows)", () => {
    const { viewport } = wrapSetup(true);
    // 8 rows no total, viewport de 2 rows ⇒ o offset máximo é a row 6 (60px).
    viewport.scrollByRows(100);
    expect(viewport.scrollOffsetPx()).toBe(60);
  });

  it("sem o mapper, scrollByRows move linhas lógicas (1 row = 1 linha)", () => {
    const { viewport } = wrapSetup(false);
    viewport.scrollByRows(3);
    expect(viewport.scrollOffsetPx()).toBe(30);
  });

  it("visibleRowRange devolve as rows visíveis (1 tela)", () => {
    const { viewport } = wrapSetup(true);
    expect(viewport.visibleRowRange()).toEqual({ first: 0, count: 2 });
    viewport.scrollByRows(3);
    expect(viewport.visibleRowRange()).toEqual({ first: 3, count: 2 });
  });

  it("scrollByRows gera o dano das linhas tocadas", () => {
    const { viewport } = wrapSetup(true);
    viewport.scrollByRows(3);
    const damage = viewport.takeDamage();
    // Saiu a linha 0 (rows 0..2) e entrou a linha 1 (rows 3..4).
    expect(damage.map((r) => ({ y: r.y, h: r.h }))).toEqual([
      { y: 0, h: 30 },
      { y: 30, h: 20 },
    ]);
  });
});
