/**
 * Testes das invariantes de `BaseRenderPipeline` (`04:244-248`).
 */
import { describe, expect, it } from "vitest";
import { MAX_GLYPH_INSTANCES, MAX_STENCIL_QUAD_INSTANCES } from "../../shared";
import type { GlyphInstance, RectInstance } from "../../shared";
import { GlyphAtlas } from "./atlas";
import {
  BatchLimitExceededError,
  DrawOutsideFrameError,
  FrameStateError,
  RenderDisposedError,
} from "./errors";
import { BaseRenderPipeline, type DrawBatch } from "./pipeline";

class TestPipeline extends BaseRenderPipeline {
  override readonly kind = "canvas2d" as const;
  readonly batches: DrawBatch[] = [];
  readonly began: number[] = [];
  readonly presented: number[] = [];

  constructor(atlas: GlyphAtlas) {
    super(atlas);
  }

  protected override draw(batch: DrawBatch): void {
    this.batches.push(batch);
  }

  protected override onBeginFrame(): void {
    this.began.push(1);
  }

  protected override onPresent(): void {
    this.presented.push(1);
  }
}

function makePipeline(): TestPipeline {
  return new TestPipeline(new GlyphAtlas());
}

function glyph(x = 0, y = 0): GlyphInstance {
  return { atlasX: 0, atlasY: 0, atlasW: 8, atlasH: 12, x, y, color: 0xffffffff };
}

function rect(x = 0, y = 0): RectInstance {
  return { rect: { x, y, w: 10, h: 10 }, color: 0xffffffff };
}

const viewport = { x: 0, y: 0, w: 100, h: 100 };

describe("BaseRenderPipeline — invariantes de frame", () => {
  it("desenhar fora de beginFrame/present lança DrawOutsideFrameError", () => {
    const pipeline = makePipeline();
    expect(() => pipeline.pushGlyphs([glyph()])).toThrow(DrawOutsideFrameError);
    expect(() => pipeline.pushRects([rect()])).toThrow(DrawOutsideFrameError);
    expect(() =>
      pipeline.pushLines([{ x0: 0, y0: 0, x1: 1, y1: 0, thickness: 1, color: 0xffffffff }]),
    ).toThrow(DrawOutsideFrameError);
    expect(() => pipeline.setClip(null)).toThrow(DrawOutsideFrameError);
    expect(() => pipeline.flush()).toThrow(DrawOutsideFrameError);
    expect(() => pipeline.present([])).toThrow(DrawOutsideFrameError);
  });

  it("beginFrame duplo lança e present fecha o frame", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    expect(() => pipeline.beginFrame(viewport)).toThrow(FrameStateError);
    pipeline.present([]);
    expect(pipeline.isFrameOpen).toBe(false);
    // Depois de present, desenhar volta a ser erro.
    expect(() => pipeline.pushGlyphs([glyph()])).toThrow(DrawOutsideFrameError);
  });

  it("flush é idempotente: duas chamadas seguidas emitem um lote só", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    pipeline.pushGlyphs([glyph()]);
    pipeline.flush();
    pipeline.flush();
    expect(pipeline.batches).toHaveLength(1);
    expect(pipeline.batches[0]?.glyphs).toHaveLength(1);
  });

  it("flush sem instâncias novas é no-op", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    pipeline.flush();
    expect(pipeline.batches).toHaveLength(0);
  });

  it("present faz flush do que sobrou", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    pipeline.pushGlyphs([glyph(), glyph()]);
    pipeline.present([{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(pipeline.batches).toHaveLength(1);
    expect(pipeline.batches[0]?.glyphs).toHaveLength(2);
    expect(pipeline.presented).toHaveLength(1);
  });
});

describe("BaseRenderPipeline — tetos (estourar lança)", () => {
  it("acima de MAX_GLYPH_INSTANCES lança BatchLimitExceededError", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    const tooMany = Array.from({ length: MAX_GLYPH_INSTANCES + 1 }, () => glyph());
    expect(() => pipeline.pushGlyphs(tooMany)).toThrow(BatchLimitExceededError);
  });

  it("acima de MAX_STENCIL_QUAD_INSTANCES lança BatchLimitExceededError", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    const tooMany = Array.from({ length: MAX_STENCIL_QUAD_INSTANCES + 1 }, (_, i) => rect(i, 0));
    expect(() => pipeline.pushRects(tooMany)).toThrow(BatchLimitExceededError);
  });

  it("chegar exatamente no teto dispara flush automático", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    pipeline.pushGlyphs(Array.from({ length: MAX_GLYPH_INSTANCES }, () => glyph()));
    expect(pipeline.batches).toHaveLength(1);
    expect(pipeline.batches[0]?.glyphs).toHaveLength(MAX_GLYPH_INSTANCES);
  });

  it("o teto é por batch: após o flush automático cabe novo lote", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    pipeline.pushGlyphs(Array.from({ length: MAX_GLYPH_INSTANCES }, () => glyph()));
    expect(() => pipeline.pushGlyphs([glyph()])).not.toThrow();
    pipeline.flush();
    expect(pipeline.batches).toHaveLength(2);
  });
});

describe("BaseRenderPipeline — clip e dispose", () => {
  it("trocar o clip fecha o lote anterior com o clip antigo", () => {
    const pipeline = makePipeline();
    pipeline.beginFrame(viewport);
    pipeline.pushRects([rect()]);
    pipeline.setClip({ x: 1, y: 2, w: 3, h: 4 });
    pipeline.pushGlyphs([glyph()]);
    pipeline.flush();
    expect(pipeline.batches).toHaveLength(2);
    expect(pipeline.batches[0]?.clip).toBeNull();
    expect(pipeline.batches[1]?.clip).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("após dispose() qualquer operação lança RenderDisposedError", () => {
    const pipeline = makePipeline();
    pipeline.dispose();
    pipeline.dispose(); // idempotente
    expect(() => pipeline.beginFrame(viewport)).toThrow(RenderDisposedError);
    expect(() => pipeline.flush()).toThrow(RenderDisposedError);
  });

  it("measure delega ao atlas (estilo registrado)", () => {
    const atlas = new GlyphAtlas();
    const pipeline = new TestPipeline(atlas);
    const key = atlas.registerStyle({ family: "mono", sizePx: 16, weight: 400, italic: false });
    // O atlas cacheia a métrica → mesmo objeto devolvido pelo pipeline.
    expect(pipeline.measure("abc", key)).toBe(atlas.measure("abc", key));
  });
});
