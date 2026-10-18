/**
 * Testes do `Canvas2DBackend` com um contexto 2D **fake** que grava as chamadas — sem DOM/GUI.
 */
import { describe, expect, it } from "vitest";
import type { GlyphInstance, LineInstance, RectInstance, SubpixelOffsets } from "../../shared";
import { GlyphAtlas } from "./atlas";
import { Canvas2DBackend, type Canvas2DContextLike } from "./canvas2d-backend";

class FakeContext implements Canvas2DContextLike {
  readonly calls: string[] = [];
  readonly alphas: number[] = [];
  /** Superfície usada em cada `drawImage` (prova qual cópia do atlas foi desenhada). */
  readonly images: unknown[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  globalAlpha = 1;
  lineWidth = 1;

  save(): void {
    this.calls.push("save");
  }
  restore(): void {
    this.calls.push("restore");
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(`clearRect(${x},${y},${w},${h})`);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(`fillRect(${x},${y},${w},${h})`);
  }
  beginPath(): void {
    this.calls.push("beginPath");
  }
  closePath(): void {
    this.calls.push("closePath");
  }
  moveTo(x: number, y: number): void {
    this.calls.push(`moveTo(${x},${y})`);
  }
  lineTo(x: number, y: number): void {
    this.calls.push(`lineTo(${x},${y})`);
  }
  arcTo(x1: number, y1: number, _x2: number, _y2: number, radius: number): void {
    this.calls.push(`arcTo(${x1},${y1},${radius})`);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.calls.push(`rect(${x},${y},${w},${h})`);
  }
  fill(): void {
    this.calls.push("fill");
  }
  stroke(): void {
    this.calls.push("stroke");
  }
  clip(): void {
    this.calls.push("clip");
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.calls.push(`setTransform(${a},${b},${c},${d},${e},${f})`);
  }
  drawImage(
    _image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    this.calls.push(`drawImage(${sx},${sy},${sw},${sh}->${dx},${dy},${dw},${dh})`);
    this.alphas.push(this.globalAlpha);
    this.images.push(_image);
  }
}

const image = {} as unknown as CanvasImageSource;
const viewport = { x: 0, y: 0, w: 100, h: 100 };

function makeBackend(): { backend: Canvas2DBackend; ctx: FakeContext } {
  const ctx = new FakeContext();
  const backend = new Canvas2DBackend(ctx, new GlyphAtlas(), { image });
  return { backend, ctx };
}

function plainRect(): RectInstance {
  return { rect: { x: 10, y: 20, w: 30, h: 40 }, color: 0xff0000ff };
}

function roundedRect(radius: number): RectInstance {
  return { rect: { x: 10, y: 20, w: 30, h: 40 }, color: 0xff0000ff, radius };
}

function glyph(): GlyphInstance {
  return { atlasX: 1, atlasY: 2, atlasW: 8, atlasH: 12, x: 5, y: 6, color: 0xffffff80 };
}

function subpixelGlyph(offsets: SubpixelOffsets): GlyphInstance {
  return { atlasX: 1, atlasY: 2, atlasW: 8, atlasH: 12, x: 5, y: 6, color: 0xffffff80, subpixel: offsets };
}

function lineInstance(): LineInstance {
  return { x0: 0, y0: 10, x1: 40, y1: 10, thickness: 1, color: 0xffffffff };
}

describe("Canvas2DBackend — retângulos", () => {
  it("desenha retângulo simples com fillRect", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.pushRects([plainRect()]);
    backend.present([]);
    expect(ctx.calls).toContain("fillRect(10,20,30,40)");
  });

  it("raio vira caminho arredondado (arcTo + fill), não fillRect", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.pushRects([roundedRect(4)]);
    backend.present([]);
    expect(ctx.calls).toContain("fill");
    expect(ctx.calls.filter((c) => c.startsWith("arcTo("))).toHaveLength(4);
    expect(ctx.calls).not.toContain("fillRect(10,20,30,40)");
  });
});

describe("Canvas2DBackend — glifos (atlas via drawImage)", () => {
  it("desenha o glifo uma vez sem subpixel, com alpha da cor", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.pushGlyphs([glyph()]);
    backend.present([]);
    const draws = ctx.calls.filter((c) => c.startsWith("drawImage("));
    expect(draws).toEqual(["drawImage(1,2,8,12->5,6,8,12)"]);
    expect(ctx.alphas[0]).toBeCloseTo(0x80 / 255, 5);
  });

  it("subpixel faz 3 desenhos deslocados com alpha/3", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.pushGlyphs([subpixelGlyph([0, 0.3, 0.6])]);
    backend.present([]);
    const draws = ctx.calls.filter((c) => c.startsWith("drawImage("));
    expect(draws).toHaveLength(3);
    expect(draws[0]).toBe("drawImage(1,2,8,12->5,6,8,12)");
    expect(draws[1]).toBe("drawImage(1,2,8,12->5.3,6,8,12)");
    expect(draws[2]).toBe("drawImage(1,2,8,12->5.6,6,8,12)");
    for (const alpha of ctx.alphas) expect(alpha).toBeCloseTo(0x80 / 255 / 3, 5);
  });
});

describe("Canvas2DBackend — tingimento dos glifos por cor", () => {
  it("sem tinter, desenha a tinta do atlas (branca)", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.pushGlyphs([glyph()]);
    backend.present([]);
    expect(ctx.images).toEqual([image]);
  });

  it("com tinter, desenha a cópia tingida e passa a cor da instância", () => {
    const tinted = {} as unknown as CanvasImageSource;
    const seen: number[] = [];
    const ctx = new FakeContext();
    const backend = new Canvas2DBackend(ctx, new GlyphAtlas(), {
      image,
      tint: {
        imageFor: (rgba) => {
          seen.push(rgba);
          return tinted;
        },
      },
    });
    backend.beginFrame(viewport);
    backend.pushGlyphs([glyph()]);
    backend.present([]);
    expect(seen).toEqual([0xffffff80]);
    expect(ctx.images).toEqual([tinted]);
  });

  it("tinter que não responde cai na tinta do atlas (nunca deixa de desenhar)", () => {
    const ctx = new FakeContext();
    const backend = new Canvas2DBackend(ctx, new GlyphAtlas(), {
      image,
      tint: { imageFor: () => undefined },
    });
    backend.beginFrame(viewport);
    backend.pushGlyphs([glyph()]);
    backend.present([]);
    expect(ctx.images).toEqual([image]);
  });

  it("subpixel também usa a cópia tingida nos 3 desenhos", () => {
    const tinted = {} as unknown as CanvasImageSource;
    const ctx = new FakeContext();
    const backend = new Canvas2DBackend(ctx, new GlyphAtlas(), { image, tint: { imageFor: () => tinted } });
    backend.beginFrame(viewport);
    backend.pushGlyphs([subpixelGlyph([0, 0.3, 0.6])]);
    backend.present([]);
    expect(ctx.images).toEqual([tinted, tinted, tinted]);
  });
});

describe("Canvas2DBackend — linhas e clip", () => {
  it("linha vira stroke com espessura", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.pushLines([lineInstance()]);
    backend.present([]);
    expect(ctx.calls).toContain("stroke");
    expect(ctx.lineWidth).toBe(1);
  });

  it("clip abre com save/clip e fecha com restore (balanceado)", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.setClip({ x: 1, y: 2, w: 3, h: 4 });
    backend.pushRects([plainRect()]);
    backend.present([]);
    expect(ctx.calls).toContain("rect(1,2,3,4)");
    expect(ctx.calls).toContain("clip");
    const save = ctx.calls.filter((c) => c === "save").length;
    const restore = ctx.calls.filter((c) => c === "restore").length;
    expect(save).toBe(restore);
  });
});

describe("Canvas2DBackend — frame/clear", () => {
  it("beginFrame sem damage limpa a viewport inteira", () => {
    const { backend, ctx } = makeBackend();
    backend.beginFrame(viewport);
    backend.present([]);
    expect(ctx.calls).toContain("clearRect(0,0,100,100)");
  });

  it("beginFrame com damage limpa só as regiões danificadas", () => {
    const { backend, ctx } = makeBackend();
    backend.invalidate([{ x: 5, y: 6, w: 7, h: 8 }]);
    backend.beginFrame(viewport);
    backend.present([]);
    expect(ctx.calls).toContain("clearRect(5,6,7,8)");
    expect(ctx.calls).not.toContain("clearRect(0,0,100,100)");
  });
});
