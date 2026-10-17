/**
 * Testes do `WebGPUBackend` — cobrem o caminho de **indisponibilidade** (DEC-REN-2/DEC-REN-5): sem
 * `navigator.gpu` no ambiente `node`, a criação falha com erro explícito, nunca com *fallback*
 * silencioso.
 */
import { describe, expect, it } from "vitest";
import { GlyphAtlas } from "./atlas";
import { WebGPUUnavailableError } from "./errors";
import { WebGPUBackend } from "./webgpu-backend";

const fakeCanvas = {
  width: 320,
  height: 240,
  getContext: (): null => null,
} as unknown as HTMLCanvasElement;

describe("WebGPUBackend — indisponibilidade", () => {
  it("lança WebGPUUnavailableError quando não há navigator.gpu", async () => {
    await expect(WebGPUBackend.create(fakeCanvas, new GlyphAtlas())).rejects.toBeInstanceOf(
      WebGPUUnavailableError,
    );
  });

  it("o erro carrega o código estável (o boot loga o modo efetivo)", async () => {
    await expect(WebGPUBackend.create(fakeCanvas, new GlyphAtlas())).rejects.toMatchObject({
      code: "render/webgpu-unavailable",
    });
  });
});
