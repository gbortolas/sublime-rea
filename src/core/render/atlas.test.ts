/**
 * Testes do `GlyphAtlas`: packing shelf determinístico, cache de medida e chave de estilo estável.
 */
import { describe, expect, it } from "vitest";
import type { AtlasSize, GlyphMetrics, TextStyle } from "../../shared";
import {
  AtlasFullError,
  UnknownTextStyleError,
} from "./errors";
import { GlyphAtlas, createDefaultRasterizer, textStyleKey, type GlyphBitmap, type TextMeasurer } from "./atlas";

function bitmap(w: number, h: number, alpha = 200): GlyphBitmap {
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = 255;
    pixels[i * 4 + 1] = 255;
    pixels[i * 4 + 2] = 255;
    pixels[i * 4 + 3] = alpha;
  }
  return { width: w, height: h, bearingX: 0, bearingY: h, advance: w, pixels };
}

const style: TextStyle = { family: "mono", sizePx: 16, weight: 400, italic: false };

describe("GlyphAtlas — faixa viva (usedHeight)", () => {
  it("acompanha as prateleiras alocadas e nunca passa do lado do atlas", () => {
    const atlas = new GlyphAtlas({ size: 32 as AtlasSize });
    expect(atlas.usedHeight).toBe(0);
    for (let i = 0; i < 6; i++) atlas.upload(`g${i}`, bitmap(4, 8));
    expect(atlas.usedHeight).toBe(8); // tudo na primeira prateleira
    atlas.upload("g6", bitmap(4, 8)); // estoura a prateleira → abre a linha de baixo (y = 9)
    expect(atlas.usedHeight).toBe(17);
    expect(atlas.usedHeight).toBeLessThanOrEqual(32);
  });
});

describe("GlyphAtlas — packing determinístico (shelf)", () => {
  it("empacota lado a lado na mesma prateleira com 1px de padding", () => {
    const atlas = new GlyphAtlas({ size: 1024 });
    const first = atlas.upload("a", bitmap(4, 8));
    const second = atlas.upload("b", bitmap(4, 8));
    expect(first).toEqual({ x: 0, y: 0, w: 4, h: 8 });
    expect(second).toEqual({ x: 5, y: 0, w: 4, h: 8 });
  });

  it("quebra para nova prateleira quando a linha enche", () => {
    const atlas = new GlyphAtlas({ size: 16 as AtlasSize });
    const wide = atlas.upload("w", bitmap(15, 4));
    const next = atlas.upload("n", bitmap(4, 4));
    expect(wide).toEqual({ x: 0, y: 0, w: 15, h: 4 });
    expect(next.y).toBe(5);
    expect(next.x).toBe(0);
  });

  it("upload é idempotente por chave", () => {
    const atlas = new GlyphAtlas({ size: 1024 });
    const first = atlas.upload("k", bitmap(4, 4));
    const again = atlas.upload("k", bitmap(4, 4));
    expect(again).toBe(first);
    expect(atlas.glyphCount).toBe(1);
  });

  it("copía os bytes para o buffer RGBA8 do atlas", () => {
    const atlas = new GlyphAtlas({ size: 1024 });
    atlas.upload("a", bitmap(2, 2, 137));
    expect(atlas.pixels[3]).toBe(137);
    expect(atlas.pixels[(1 * atlas.size + 1) * 4 + 3]).toBe(137);
  });

  it("estourar o atlas lança AtlasFullError", () => {
    const atlas = new GlyphAtlas({ size: 8 as AtlasSize });
    expect(() => atlas.upload("big", bitmap(9, 2))).toThrow(AtlasFullError);
  });

  it("lookup devolve undefined antes e região depois", () => {
    const atlas = new GlyphAtlas({ size: 1024 });
    expect(atlas.lookup("x")).toBeUndefined();
    const region = atlas.upload("x", bitmap(3, 3));
    expect(atlas.lookup("x")).toEqual(region);
  });

  it("resolveGlyph memoiza região e métricas (rasteriza uma vez)", () => {
    const atlas = new GlyphAtlas({ size: 1024 });
    const first = atlas.resolveGlyph("A", style);
    const second = atlas.resolveGlyph("A", style);
    expect(second.region).toBe(first.region);
    expect(second.advance).toBe(first.advance);
    expect(atlas.glyphCount).toBe(1);
  });

  it("rasterizador default é determinístico por rune", () => {
    const rasterizer = createDefaultRasterizer();
    const a1 = rasterizer.rasterize("A", style);
    const a2 = rasterizer.rasterize("A", style);
    expect([...a1.pixels]).toEqual([...a2.pixels]);
  });
});

describe("GlyphAtlas — cache de medida", () => {
  it("mede uma vez por (estilo, texto)", () => {
    let calls = 0;
    const measurer: TextMeasurer = (text, s): GlyphMetrics => {
      calls += 1;
      return { advance: text.length * s.sizePx, bearingX: 0, bearingY: 0, width: 0, height: s.sizePx };
    };
    const atlas = new GlyphAtlas({ size: 1024, measurer });
    const key = atlas.registerStyle(style);
    const first = atlas.measure("hello", key);
    const second = atlas.measure("hello", key);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first.advance).toBe(5 * 16);
  });

  it("estilo desconhecido lança UnknownTextStyleError", () => {
    const atlas = new GlyphAtlas({ size: 1024 });
    expect(() => atlas.measure("x", "deadbeef")).toThrow(UnknownTextStyleError);
  });
});

describe("textStyleKey — chave estável", () => {
  it("é determinística e distingue estilos", () => {
    expect(textStyleKey(style)).toBe(textStyleKey({ ...style }));
    expect(textStyleKey(style)).not.toBe(textStyleKey({ ...style, sizePx: 17 }));
    expect(textStyleKey(style)).not.toBe(textStyleKey({ ...style, weight: 700 }));
  });

  it("é independente da ordem de `features`", () => {
    const a = textStyleKey({ ...style, features: ["liga", "kern"] });
    const b = textStyleKey({ ...style, features: ["kern", "liga"] });
    expect(a).toBe(b);
  });
});
