/**
 * Scribe — `GlyphAtlas`: cache de glifos `RGBA8` com empacotamento *shelf* determinístico.
 *
 * Fonte: `docs/architecture/04-render-e-ui.md` §3 e DEC-REN-3/DEC-REN-5.
 *
 * Papel (padrão do alvo, reimplementação nossa — **escolha nossa, não observada no alvo**):
 * - o *shaping* e o raster estão **fora daqui** (worker, DEC-REN-3); o atlas é só a **fronteira**:
 *   recebe bitmaps + métricas e devolve regiões;
 * - um glifo nunca é rasterizado duas vezes: `resolveGlyph` faz *upload* sob demanda e memoiza;
 * - `measure` é cacheado por `(TextStyleKey, texto)` — a chave do estilo é o **hash estável** do
 *   `TextStyle` (`textStyleKey`), nunca a string do texto;
 * - `NEAREST`/`CLAMP_TO_EDGE` são responsabilidade do backend; aqui garantimos 1 px de *padding*
 *   entre glifos para evitar *bleeding* com amostragem por ponto.
 *
 * Formato do buffer: **RGBA8, row-major, alpha reto** (tinta branca: `R=G=B=255`, `A` = cobertura),
 * lado `ATLAS_SIZES` (1024/4096).
 */

import type { AtlasSize, GlyphMetrics, RGBA, TextStyle, TextStyleKey } from "../../shared";
import { ATLAS_SIZES } from "../../shared";
import { AtlasBitmapError, AtlasFullError, UnknownTextStyleError } from "./errors";

/** Região retangular dentro do atlas (canto superior-esquerdo + tamanho). */
export interface AtlasRegion {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Bitmap rasterizado na CPU pronto para subir no atlas. */
export interface GlyphBitmap {
  readonly width: number;
  readonly height: number;
  readonly bearingX: number;
  readonly bearingY: number;
  readonly advance: number;
  /** RGBA8, `width * height * 4` bytes, row-major, alpha reto (tinta branca). */
  readonly pixels: Uint8Array;
}

/** Camada de shaping/raster (worker, DEC-REN-3) reduzida ao contrato mínimo do atlas. */
export interface GlyphRasterizer {
  rasterize(rune: string, style: TextStyle): GlyphBitmap;
}

/** Medição de texto sem desenhar (alimenta layout/`Viewport`). */
export type TextMeasurer = (text: string, style: TextStyle) => GlyphMetrics;

/**
 * Superfície de desenho opcional acoplada ao atlas (ex.: `OffscreenCanvas` no renderer).
 * O atlas escreve os bytes nele para que o `Canvas2DBackend` possa `drawImage` do atlas.
 */
export interface AtlasSurface {
  readonly image: CanvasImageSource;
  write(region: AtlasRegion, bitmap: GlyphBitmap): void;
}

export interface GlyphAtlasOptions {
  readonly size?: AtlasSize;
  readonly rasterizer?: GlyphRasterizer;
  readonly measurer?: TextMeasurer;
  readonly surface?: AtlasSurface;
}

/** Glifo resolvido: onde está no atlas + métricas de posicionamento. */
export interface PlacedGlyph {
  readonly region: AtlasRegion;
  readonly advance: number;
  readonly bearingX: number;
  readonly bearingY: number;
}

const PADDING = 1 as const;

/** Hash FNV-1a de 32 bits (estável entre execuções, independente de `JSON.stringify`). */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Chave estável de estilo — **escolha nossa**: normaliza os campos do `TextStyle` numa string
 * canônica e aplica FNV-1a. Determinística e independente da ordem de `features`.
 */
export function textStyleKey(style: TextStyle): TextStyleKey {
  const features = style.features ? [...style.features].sort().join(",") : "";
  return fnv1a(`${style.family}|${style.sizePx}|${style.weight}|${style.italic ? 1 : 0}|${features}`);
}

/** Medidor determinístico de fallback (sem DOM/GUI): largura ~0.6em por caractere. */
export const defaultTextMeasurer: TextMeasurer = (text, style) => {
  const perChar = style.sizePx * 0.6;
  return {
    advance: text.length * perChar,
    bearingX: 0,
    bearingY: style.sizePx * 0.75,
    width: text.length * perChar,
    height: style.sizePx,
  };
};

/**
 * Rasterizador sintético determinístico (sem GUI) — **escolha nossa**: desenha um "glifo"
 * caixa+diagonal derivado do code point, só para testes e ambientes headless. O renderer real
 * injeta um rasterizador baseado em `OffscreenCanvas`.
 */
export function createDefaultRasterizer(): GlyphRasterizer {
  return {
    rasterize(rune: string, style: TextStyle): GlyphBitmap {
      const h = Math.max(1, Math.round(style.sizePx));
      const w = Math.max(1, Math.round(style.sizePx * 0.5));
      const pixels = new Uint8Array(w * h * 4);
      const seed = rune.codePointAt(0) ?? 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
          const diagonal = Math.abs(x / w - y / h) < 0.2;
          const speckle = (seed + x * 3 + y * 7) % 5 === 0;
          if (border || diagonal || speckle) {
            const i = (y * w + x) * 4;
            pixels[i] = 255;
            pixels[i + 1] = 255;
            pixels[i + 2] = 255;
            pixels[i + 3] = 220;
          }
        }
      }
      return {
        width: w,
        height: h,
        bearingX: 0,
        bearingY: h,
        advance: style.sizePx * 0.6,
        pixels,
      };
    },
  };
}

/**
 * Atlas de glifos. Estado puro (buffer de bytes + índices), sem dependência de DOM — o backend
 * decide como subir os bytes para a superfície de desenho.
 */
export class GlyphAtlas {
  readonly size: AtlasSize;
  /** Bytes `RGBA8` do atlas completo (`size * size * 4`). */
  readonly pixels: Uint8Array;

  private readonly rasterizer: GlyphRasterizer;
  private readonly measurer: TextMeasurer;
  private readonly surface: AtlasSurface | undefined;
  private readonly regions = new Map<string, AtlasRegion>();
  private readonly bitmaps = new Map<string, GlyphBitmap>();
  private readonly styles = new Map<TextStyleKey, TextStyle>();
  private readonly measureCache = new Map<string, GlyphMetrics>();

  private shelfX = 0;
  private shelfY = 0;
  private shelfHeight = 0;

  constructor(options: GlyphAtlasOptions = {}) {
    this.size = options.size ?? ATLAS_SIZES[0];
    this.pixels = new Uint8Array(this.size * this.size * 4);
    this.rasterizer = options.rasterizer ?? createDefaultRasterizer();
    this.measurer = options.measurer ?? defaultTextMeasurer;
    this.surface = options.surface;
  }

  /** Nº de glifos distintos já empacotados (métrica de ocupação). */
  get glyphCount(): number {
    return this.regions.size;
  }

  /** Superfície de desenho acoplada (se houver) — o `Canvas2DBackend` desenha a partir dela. */
  get image(): CanvasImageSource | undefined {
    return this.surface?.image;
  }

  /** Hash estável do estilo (não registra nada — use `registerStyle` antes de `measure`). */
  textStyleKey(style: TextStyle): TextStyleKey {
    return textStyleKey(style);
  }

  /** Registra o estilo e devolve a chave usada por `measure`. Idempotente. */
  registerStyle(style: TextStyle): TextStyleKey {
    const key = textStyleKey(style);
    if (!this.styles.has(key)) this.styles.set(key, style);
    return key;
  }

  /** Métrica de `text` no estilo `styleKey`, cacheada por `(styleKey, text)`. */
  measure(text: string, styleKey: TextStyleKey): GlyphMetrics {
    const style = this.styles.get(styleKey);
    if (!style) throw new UnknownTextStyleError(styleKey);
    const cacheKey = `${styleKey}\u0000${text}`;
    const hit = this.measureCache.get(cacheKey);
    if (hit) return hit;
    const metrics = this.measurer(text, style);
    this.measureCache.set(cacheKey, metrics);
    return metrics;
  }

  /** Região já empacotada para a chave, se existir. */
  lookup(key: string): AtlasRegion | undefined {
    return this.regions.get(key);
  }

  /** Empacota e copia um bitmap (idempotente por chave); devolve a região. */
  upload(key: string, bitmap: GlyphBitmap): AtlasRegion {
    const existing = this.regions.get(key);
    if (existing) return existing;
    const expected = bitmap.width * bitmap.height * 4;
    if (bitmap.pixels.length !== expected) {
      throw new AtlasBitmapError(bitmap.width, bitmap.height, bitmap.pixels.length);
    }
    const region = this.alloc(bitmap.width, bitmap.height);
    this.blit(region, bitmap);
    this.regions.set(key, region);
    this.bitmaps.set(key, bitmap);
    this.surface?.write(region, bitmap);
    return region;
  }

  /**
   * Resolve um glifo (caractere + estilo) para uma região do atlas, rasterizando e subindo sob
   * demanda. É o caminho quente do `scene`: memoiza bitmap, região e métricas por chave.
   */
  resolveGlyph(rune: string, style: TextStyle): PlacedGlyph {
    const styleKey = this.registerStyle(style);
    const key = glyphKey(styleKey, rune);
    const region = this.regions.get(key) ?? this.upload(key, this.rasterizer.rasterize(rune, style));
    const bitmap = this.bitmaps.get(key);
    if (!bitmap) {
      // Inalcançável: toda região empacotada tem bitmap associado.
      throw new AtlasBitmapError(region.w, region.h, 0);
    }
    return { region, advance: bitmap.advance, bearingX: bitmap.bearingX, bearingY: bitmap.bearingY };
  }

  private alloc(width: number, height: number): AtlasRegion {
    if (width + PADDING > this.size || height + PADDING > this.size) {
      throw new AtlasFullError(width, height, this.size);
    }
    if (this.shelfX + width + PADDING > this.size) {
      this.shelfY += this.shelfHeight + PADDING;
      this.shelfX = 0;
      this.shelfHeight = 0;
    }
    if (this.shelfY + height + PADDING > this.size) {
      throw new AtlasFullError(width, height, this.size);
    }
    const region: AtlasRegion = { x: this.shelfX, y: this.shelfY, w: width, h: height };
    this.shelfX += width + PADDING;
    this.shelfHeight = Math.max(this.shelfHeight, height);
    return region;
  }

  private blit(region: AtlasRegion, bitmap: GlyphBitmap): void {
    const stride = this.size * 4;
    const rowBytes = region.w * 4;
    for (let y = 0; y < region.h; y++) {
      const src = y * rowBytes;
      const dst = (region.y + y) * stride + region.x * 4;
      this.pixels.set(bitmap.pixels.subarray(src, src + rowBytes), dst);
    }
  }
}

/** Chave de glifo = estilo + rune (sem subpixel: o branch subpixel é aplicado no backend). */
export function glyphKey(styleKey: TextStyleKey, rune: string, subpixelIndex = 0): string {
  return `${styleKey}\u0000${rune}\u0000${subpixelIndex}`;
}

/** Cor sRGB `0xRRGGBBAA` → `rgba(r, g, b, a)` do CSS (compartilhado pelos backends). */
export function cssColor(rgba: RGBA): string {
  const r = (rgba >>> 24) & 0xff;
  const g = (rgba >>> 16) & 0xff;
  const b = (rgba >>> 8) & 0xff;
  const a = (rgba & 0xff) / 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Componente alpha (0..1) de uma cor sRGB `0xRRGGBBAA`. */
export function alphaOf(rgba: RGBA): number {
  return (rgba & 0xff) / 255;
}
