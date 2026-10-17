/**
 * Scribe — `WebGPUBackend`: backend **hardware** (DEC-REN-1/2), opt-in.
 *
 * Implementação real de WebGPU: **instanciação de quads** com as instâncias num *storage buffer*
 * (`array<Instance>`), lido no vertex shader por `instance_index`; os glifos amostram o **atlas
 * RGBA8** (`textureLoad`, equivalente a `NEAREST`; coordenadas presas à borda ≈ `CLAMP_TO_EDGE`).
 * Divergência deliberada D2 de `04`: o alvo usa *texture buffer* GLSL + `texelFetch`; nós usamos
 * *storage buffer* + instancing, o idioma do Chromium — **mesmo padrão, outro mecanismo**.
 *
 * DEC-REN-2/DEC-REN-5: se `navigator.gpu`/adapter/device/contexto não existirem, lançamos
 * `WebGPUUnavailableError` **explícito** — a falha nunca vira *fallback* silencioso. Quem escolhe e
 * loga o backend é o boot do renderer (DEC-TR-7: *fallback* declarado, se houver).
 *
 * Limite de honestidade: este código **não** é exercitado nos testes (ambiente `node` sem GPU); o
 * teste cobre só o caminho de indisponibilidade. O WGSL é curto porém real.
 */

import type { GlyphInstance, LineInstance, Rect, RectInstance, RGBA } from "../../shared";
import { MAX_GLYPH_INSTANCES, MAX_STENCIL_QUAD_INSTANCES } from "../../shared";
import { alphaOf, type GlyphAtlas } from "./atlas";
import { BatchLimitExceededError, WebGPUUnavailableError } from "./errors";
import { BaseRenderPipeline, type DrawBatch } from "./pipeline";

const RECT_STRIDE_FLOATS = 12;
const GLYPH_STRIDE_FLOATS = 12;
const UNIFORM_BYTES = 64;
/** `minStorageBufferOffsetAlignment` da WebGPU é 256 por padrão. */
const STORAGE_ALIGN = 256;
const VERTEX_COUNT = 6;

const RECT_WGSL = /* wgsl */ `
struct Uniforms { viewport: vec2f, _pad: vec2f };
struct RectInst { pos: vec4f, color: vec4f, params: vec4f };

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> rects: array<RectInst>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) local: vec2f,
  @location(2) size: vec2f,
  @location(3) radius: f32,
};

fn toNdc(p: vec2f) -> vec2f {
  return vec2f((p.x / u.viewport.x) * 2.0 - 1.0, 1.0 - (p.y / u.viewport.y) * 2.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let inst = rects[ii];
  let c = corners[vi];
  let px = inst.pos.xy + c * inst.pos.zw;
  var out: VSOut;
  out.pos = vec4f(toNdc(px), 0.0, 1.0);
  out.color = inst.color;
  out.local = c;
  out.size = inst.pos.zw;
  out.radius = inst.params.x;
  return out;
}

fn sdRoundBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let half = in.size * 0.5;
  let p = (in.local - vec2f(0.5)) * in.size;
  let d = sdRoundBox(p, half, in.radius);
  let aa = 1.0 - smoothstep(-0.5, 0.5, d);
  return vec4f(in.color.rgb, in.color.a * aa);
}
`;

const GLYPH_WGSL = /* wgsl */ `
struct Uniforms { viewport: vec2f, _pad: vec2f };
struct GlyphInst { dst: vec4f, src: vec4f, color: vec4f };

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> glyphs: array<GlyphInst>;
@group(0) @binding(2) var atlasTex: texture_2d<f32>;
@group(0) @binding(3) var atlasSampler: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) src: vec2f,
  @location(2) srcSize: vec2f,
  @location(3) local: vec2f,
};

fn toNdc(p: vec2f) -> vec2f {
  return vec2f((p.x / u.viewport.x) * 2.0 - 1.0, 1.0 - (p.y / u.viewport.y) * 2.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let inst = glyphs[ii];
  let c = corners[vi];
  let px = inst.dst.xy + c * inst.dst.zw;
  var out: VSOut;
  out.pos = vec4f(toNdc(px), 0.0, 1.0);
  out.color = inst.color;
  out.src = inst.src.xy;
  out.srcSize = inst.src.zw;
  out.local = c;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(atlasTex, 0));
  // textureLoad: fetch inteiro (NEAREST por construção); clamp explícito ≈ CLAMP_TO_EDGE.
  let uv = in.src + vec2f(0.5) + in.local * (in.srcSize - vec2f(1.0));
  let clamped = clamp(uv, vec2f(0.0), dims - vec2f(1.0));
  let texel = textureLoad(atlasTex, vec2i(clamped), 0);
  return vec4f(in.color.rgb, in.color.a * texel.a);
}
`;

export interface WebGPUBackendOptions {
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly clearColor?: GPUColor;
}

function getGpu(): GPU | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.gpu;
}

function colorFloats(rgba: RGBA): [number, number, number, number] {
  return [((rgba >>> 24) & 0xff) / 255, ((rgba >>> 16) & 0xff) / 255, ((rgba >>> 8) & 0xff) / 255, alphaOf(rgba)];
}

function alignUp(bytes: number, alignment: number): number {
  return Math.ceil(bytes / alignment) * alignment;
}

export class WebGPUBackend extends BaseRenderPipeline {
  override readonly kind = "webgpu" as const;

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly clearColor: GPUColor;
  private readonly canvasWidth: number;
  private readonly canvasHeight: number;

  private readonly uniformBuffer: GPUBuffer;
  private readonly rectBuffer: GPUBuffer;
  private readonly glyphBuffer: GPUBuffer;
  private readonly atlasTexture: GPUTexture;
  private readonly atlasSampler: GPUSampler;

  private readonly rectLayout: GPUBindGroupLayout;
  private readonly glyphLayout: GPUBindGroupLayout;
  private readonly rectPipeline: GPURenderPipeline;
  private readonly glyphPipeline: GPURenderPipeline;

  private encoder: GPUCommandEncoder | null = null;
  private pass: GPURenderPassEncoder | null = null;
  private rectCursor = 0;
  private glyphCursor = 0;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    atlas: GlyphAtlas,
    format: GPUTextureFormat,
    clearColor: GPUColor,
    canvasWidth: number,
    canvasHeight: number,
  ) {
    super(atlas);
    this.device = device;
    this.context = context;
    this.clearColor = clearColor;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;

    this.uniformBuffer = device.createBuffer({
      label: "scribe.uniforms",
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.rectBuffer = device.createBuffer({
      label: "scribe.rects",
      size: MAX_STENCIL_QUAD_INSTANCES * RECT_STRIDE_FLOATS * 4 + STORAGE_ALIGN,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.glyphBuffer = device.createBuffer({
      label: "scribe.glyphs",
      size: MAX_GLYPH_INSTANCES * GLYPH_STRIDE_FLOATS * 4 + STORAGE_ALIGN,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.atlasTexture = device.createTexture({
      label: "scribe.atlas",
      size: [atlas.size, atlas.size, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.atlasTexture },
      atlas.pixels,
      { bytesPerRow: atlas.size * 4, rowsPerImage: atlas.size },
      [atlas.size, atlas.size, 1],
    );
    this.atlasSampler = device.createSampler({
      label: "scribe.atlas-sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.rectLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.glyphLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
      ],
    });

    const blend: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const rectModule = device.createShaderModule({ label: "scribe.rect", code: RECT_WGSL });
    const glyphModule = device.createShaderModule({ label: "scribe.glyph", code: GLYPH_WGSL });
    this.rectPipeline = device.createRenderPipeline({
      label: "scribe.rect",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.rectLayout] }),
      vertex: { module: rectModule, entryPoint: "vs" },
      fragment: { module: rectModule, entryPoint: "fs", targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });
    this.glyphPipeline = device.createRenderPipeline({
      label: "scribe.glyph",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.glyphLayout] }),
      vertex: { module: glyphModule, entryPoint: "vs" },
      fragment: { module: glyphModule, entryPoint: "fs", targets: [{ format, blend }] },
      primitive: { topology: "triangle-list" },
    });
  }

  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    atlas: GlyphAtlas,
    options: WebGPUBackendOptions = {},
  ): Promise<WebGPUBackend> {
    const gpu = getGpu();
    if (!gpu) {
      throw new WebGPUUnavailableError("navigator.gpu ausente (ambiente sem WebGPU)");
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      throw new WebGPUUnavailableError("nenhum GPUAdapter disponível");
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new WebGPUUnavailableError("contexto 'webgpu' indisponível no canvas");
    }
    const format = options.format ?? gpu.getPreferredCanvasFormat();
    const alphaMode = options.alphaMode ?? "opaque";
    context.configure({ device, format, alphaMode });
    const clearColor = options.clearColor ?? { r: 0.12, g: 0.12, b: 0.13, a: 1 };
    return new WebGPUBackend(device, context, atlas, format, clearColor, canvas.width, canvas.height);
  }

  private viewportWidthLogical = 1;

  /** Escala lógica→device px (o *viewport* chega em px lógicos). */
  private get pixelScale(): number {
    return this.viewportWidthLogical > 0 ? this.canvasWidth / this.viewportWidthLogical : 1;
  }

  private uploadedGlyphCount = 0;

  protected override onBeginFrame(viewport: Rect, _damage: readonly Rect[]): void {
    this.rectCursor = 0;
    this.glyphCursor = 0;
    this.viewportWidthLogical = viewport.w > 0 ? viewport.w : 1;
    // O atlas cresce sob demanda; republica a textura só quando novos glifos entraram.
    if (this.atlas.glyphCount !== this.uploadedGlyphCount) {
      this.device.queue.writeTexture(
        { texture: this.atlasTexture },
        this.atlas.pixels,
        { bytesPerRow: this.atlas.size * 4, rowsPerImage: this.atlas.size },
        [this.atlas.size, this.atlas.size, 1],
      );
      this.uploadedGlyphCount = this.atlas.glyphCount;
    }
    const uniforms = new Float32Array([viewport.w, viewport.h, 0, 0, 0, 0, 0, 0]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
    this.encoder = this.device.createCommandEncoder();
    this.pass = this.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: this.clearColor,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    this.applyScissor(null);
  }

  protected override draw(batch: DrawBatch): void {
    const pass = this.pass;
    if (!pass) return;
    this.applyScissor(batch.clip);

    const rects = [...batch.rects, ...linesToRects(batch.lines)];
    if (rects.length > 0) {
      const offset = alignUp(this.rectCursor, STORAGE_ALIGN);
      const data = this.encodeRects(rects);
      this.ensureCapacity(this.rectBuffer, offset, data.byteLength, "rect-quad");
      this.device.queue.writeBuffer(this.rectBuffer, offset, data);
      this.rectCursor = offset + data.byteLength;
      pass.setPipeline(this.rectPipeline);
      pass.setBindGroup(0, this.createRectBindGroup(offset, data.byteLength));
      pass.draw(VERTEX_COUNT, rects.length);
    }

    if (batch.glyphs.length > 0) {
      const offset = alignUp(this.glyphCursor, STORAGE_ALIGN);
      const data = this.encodeGlyphs(batch.glyphs);
      this.ensureCapacity(this.glyphBuffer, offset, data.byteLength, "glyph");
      this.device.queue.writeBuffer(this.glyphBuffer, offset, data);
      this.glyphCursor = offset + data.byteLength;
      pass.setPipeline(this.glyphPipeline);
      pass.setBindGroup(0, this.createGlyphBindGroup(offset, data.byteLength));
      pass.draw(VERTEX_COUNT, batch.glyphs.length);
    }
  }

  protected override onPresent(_damage: readonly Rect[]): void {
    const encoder = this.encoder;
    const pass = this.pass;
    this.encoder = null;
    this.pass = null;
    if (!encoder || !pass) return;
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  protected override onDispose(): void {
    this.uniformBuffer.destroy();
    this.rectBuffer.destroy();
    this.glyphBuffer.destroy();
    this.atlasTexture.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }

  private applyScissor(clip: Rect | null): void {
    const pass = this.pass;
    if (!pass) return;
    if (!clip) {
      pass.setScissorRect(0, 0, this.canvasWidth, this.canvasHeight);
      return;
    }
    const scale = this.pixelScale;
    const x = Math.max(0, Math.floor(clip.x * scale));
    const y = Math.max(0, Math.floor(clip.y * scale));
    const w = Math.max(1, Math.min(this.canvasWidth - x, Math.ceil(clip.w * scale)));
    const h = Math.max(1, Math.min(this.canvasHeight - y, Math.ceil(clip.h * scale)));
    pass.setScissorRect(x, y, w, h);
  }

  private ensureCapacity(buffer: GPUBuffer, offset: number, bytes: number, family: "rect-quad" | "glyph"): void {
    if (offset + bytes > buffer.size) {
      throw new BatchLimitExceededError(family, buffer.size, offset + bytes);
    }
  }

  private createRectBindGroup(offset: number, size: number): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.rectLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.rectBuffer, offset, size } },
      ],
    });
  }

  private createGlyphBindGroup(offset: number, size: number): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.glyphLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.glyphBuffer, offset, size } },
        { binding: 2, resource: this.atlasTexture.createView() },
        { binding: 3, resource: this.atlasSampler },
      ],
    });
  }

  private encodeRects(rects: readonly RectInstance[]): Float32Array {
    const data = new Float32Array(rects.length * RECT_STRIDE_FLOATS);
    rects.forEach((instance, index) => {
      const base = index * RECT_STRIDE_FLOATS;
      const [r, g, b, a] = colorFloats(instance.color);
      data[base] = instance.rect.x;
      data[base + 1] = instance.rect.y;
      data[base + 2] = instance.rect.w;
      data[base + 3] = instance.rect.h;
      data[base + 4] = r;
      data[base + 5] = g;
      data[base + 6] = b;
      data[base + 7] = a;
      data[base + 8] = instance.radius ?? 0;
    });
    return data;
  }

  private encodeGlyphs(glyphs: readonly GlyphInstance[]): Float32Array {
    const data = new Float32Array(glyphs.length * GLYPH_STRIDE_FLOATS);
    glyphs.forEach((instance, index) => {
      const base = index * GLYPH_STRIDE_FLOATS;
      const [r, g, b, a] = colorFloats(instance.color);
      data[base] = instance.x;
      data[base + 1] = instance.y;
      data[base + 2] = instance.atlasW;
      data[base + 3] = instance.atlasH;
      data[base + 4] = instance.atlasX;
      data[base + 5] = instance.atlasY;
      data[base + 6] = instance.atlasW;
      data[base + 7] = instance.atlasH;
      data[base + 8] = r;
      data[base + 9] = g;
      data[base + 10] = b;
      data[base + 11] = a;
    });
    return data;
  }
}

/**
 * Linhas → quads. O backend hardware do enunciado cobre **rects + glifos**; traços de UI (réguas,
 * sublinhados) são horizontal/vertical no nosso caso, então viramos quads exatos. Segmentos
 * diagonais caem no retângulo-limite (aproximação documentada — o alvo tem programa próprio).
 */
function linesToRects(lines: readonly LineInstance[]): RectInstance[] {
  const result: RectInstance[] = [];
  for (const line of lines) {
    const thickness = Math.max(line.thickness, 1);
    if (line.y0 === line.y1) {
      result.push({
        rect: { x: Math.min(line.x0, line.x1), y: line.y0 - thickness / 2, w: Math.abs(line.x1 - line.x0), h: thickness },
        color: line.color,
      });
      continue;
    }
    if (line.x0 === line.x1) {
      result.push({
        rect: { x: line.x0 - thickness / 2, y: Math.min(line.y0, line.y1), w: thickness, h: Math.abs(line.y1 - line.y0) },
        color: line.color,
      });
      continue;
    }
    result.push({
      rect: {
        x: Math.min(line.x0, line.x1),
        y: Math.min(line.y0, line.y1),
        w: Math.abs(line.x1 - line.x0),
        h: Math.abs(line.y1 - line.y0),
      },
      color: line.color,
    });
  }
  return result;
}
