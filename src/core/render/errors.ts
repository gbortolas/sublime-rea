/**
 * Scribe — erros tipados do módulo de render (DEC-TR-5: erro alto, nunca `catch {}` mudo).
 *
 * Fonte: `docs/architecture/04-render-e-ui.md` (invariantes de `04:244-248`), `DEC-REN-5`
 * (falha de WebGPU = erro explícito) e `DEC-TR-7` (fallback **declarado**, nunca silencioso).
 *
 * Todos os erros carregam um `code` estável e legível por máquina; o `name` espelha a classe
 * para que logs e diálogos possam distinguir a causa sem parsear a mensagem.
 */

export type RenderErrorCode =
  | "render/draw-outside-frame"
  | "render/frame-state"
  | "render/batch-limit-exceeded"
  | "render/webgpu-unavailable"
  | "render/canvas2d-no-atlas-image"
  | "render/atlas-full"
  | "render/atlas-bitmap"
  | "render/unknown-text-style"
  | "render/disposed";

/** Base de todos os erros do módulo. */
export class RenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode, message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    // `target: ES2022` preserva o protótipo, mas mantemos a cadeia explícita para clareza.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Desenho (`setClip`/`push*`/`flush`/`present`) fora de `beginFrame`/`present` — erro de
 * programação (invariante 3 de `04:247`).
 */
export class DrawOutsideFrameError extends RenderError {
  readonly operation: string;

  constructor(operation: string) {
    super(
      "render/draw-outside-frame",
      `operação de desenho "${operation}" fora do frame (beginFrame/present)`,
    );
    this.name = "DrawOutsideFrameError";
    this.operation = operation;
  }
}

/** Transição de estado inválida do frame (ex.: `beginFrame` com um frame já aberto). */
export class FrameStateError extends RenderError {
  constructor(message: string) {
    super("render/frame-state", message);
    this.name = "FrameStateError";
  }
}

/** Família de instâncias cujo teto por *batch* foi estourado (invariante 2 de `04:246`). */
export type InstanceFamily = "glyph" | "rect-quad";

export class BatchLimitExceededError extends RenderError {
  readonly family: InstanceFamily;
  readonly limit: number;
  readonly requested: number;

  constructor(family: InstanceFamily, limit: number, requested: number) {
    super(
      "render/batch-limit-exceeded",
      `teto de "${family}" estourado: ${requested} > ${limit} (DEC-REN-2 — estourar é erro, não degradação silenciosa)`,
    );
    this.name = "BatchLimitExceededError";
    this.family = family;
    this.limit = limit;
    this.requested = requested;
  }
}

/**
 * `navigator.gpu`/adapter/device ausentes — falha **explícita** do backend hardware
 * (DEC-REN-2/DEC-REN-5). Quem escolhe o backend é o boot, que **loga** o modo efetivo.
 */
export class WebGPUUnavailableError extends RenderError {
  readonly reason: string;

  constructor(reason: string) {
    super("render/webgpu-unavailable", `WebGPU indisponível: ${reason}`);
    this.name = "WebGPUUnavailableError";
    this.reason = reason;
  }
}

/** Atlas lotado — o *eviction* por geração ainda não existe no MVP (DEC-REN-3). */
export class AtlasFullError extends RenderError {
  readonly neededWidth: number;
  readonly neededHeight: number;
  readonly size: number;

  constructor(neededWidth: number, neededHeight: number, size: number) {
    super(
      "render/atlas-full",
      `atlas ${size}x${size} sem espaço para bitmap ${neededWidth}x${neededHeight}`,
    );
    this.name = "AtlasFullError";
    this.neededWidth = neededWidth;
    this.neededHeight = neededHeight;
    this.size = size;
  }
}

/** Bitmap de glifo inconsistente (dimensões ≠ tamanho do buffer RGBA8). */
export class AtlasBitmapError extends RenderError {
  constructor(width: number, height: number, bytes: number) {
    super(
      "render/atlas-bitmap",
      `bitmap ${width}x${height} requer ${width * height * 4} bytes RGBA8, recebeu ${bytes}`,
    );
    this.name = "AtlasBitmapError";
  }
}

/** `measure(text, styleKey)` para um `TextStyleKey` que nunca foi registrado. */
export class UnknownTextStyleError extends RenderError {
  readonly styleKey: string;

  constructor(styleKey: string) {
    super(
      "render/unknown-text-style",
      `TextStyleKey "${styleKey}" não registrado no atlas; chame registerStyle(style) antes`,
    );
    this.name = "UnknownTextStyleError";
    this.styleKey = styleKey;
  }
}

/** Uso após `dispose()`. */
export class RenderDisposedError extends RenderError {
  constructor() {
    super("render/disposed", "pipeline já descartado");
    this.name = "RenderDisposedError";
  }
}
