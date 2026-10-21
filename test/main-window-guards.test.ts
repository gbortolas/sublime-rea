/**
 * Scribe — guardas de janela do `main` (achados BAIXO da auditoria).
 *
 * 1. **`window.open`/navegação externa**: sem `setWindowOpenHandler`/`will-navigate`, o
 *    `window.open("https://example.com/")` do renderer abria uma page nova **dentro do
 *    app**. Agora só a casca do próprio app pode ser navegada.
 * 2. **`broadcast` para janela destruída**: `webContents.send` **lança** numa janela
 *    destruída ⇒ o evento (ex.: `document.changed`) se perdia.
 *
 * As duas regras são funções puras no `main` (testáveis **sem Electron**).
 */
import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

import { createEventBroadcaster, isOwnRendererUrl } from "../src/main/index";
import type { BroadcastWindow } from "../src/main/index";

const RENDERER_INDEX = resolve("/opt/scribe/dist/renderer/index.html");

describe("main — guardas de janela", () => {
  it("só a casca do próprio app pode ser navegada", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // A casca (com query e com hash) é permitida.
      expect(isOwnRendererUrl(pathToFileURL(RENDERER_INDEX).href, RENDERER_INDEX)).toBe(true);
      expect(
        isOwnRendererUrl(`${pathToFileURL(RENDERER_INDEX).href}?file=/tmp/a.txt`, RENDERER_INDEX),
      ).toBe(true);
      expect(isOwnRendererUrl(`${pathToFileURL(RENDERER_INDEX).href}#topo`, RENDERER_INDEX)).toBe(
        true,
      );

      // Página remota: bloqueada.
      expect(isOwnRendererUrl("https://example.com/", RENDERER_INDEX)).toBe(false);
      expect(isOwnRendererUrl("http://example.com/", RENDERER_INDEX)).toBe(false);
      expect(isOwnRendererUrl("javascript:alert(1)", RENDERER_INDEX)).toBe(false);
      expect(isOwnRendererUrl("data:text/html,<b>x</b>", RENDERER_INDEX)).toBe(false);

      // Outro arquivo local: bloqueado.
      expect(isOwnRendererUrl(pathToFileURL("/etc/passwd").href, RENDERER_INDEX)).toBe(false);
      expect(
        isOwnRendererUrl(pathToFileURL(join("/opt/scribe/dist/renderer", "outro.html")).href, RENDERER_INDEX),
      ).toBe(false);

      // URL inválida: bloqueada (sem estourar).
      expect(isOwnRendererUrl("não é uma url", RENDERER_INDEX)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("o broadcast ignora janelas destruídas (o evento não se perde)", () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const live: BroadcastWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    };
    const destroyed: BroadcastWindow = {
      isDestroyed: () => true,
      webContents: {
        isDestroyed: () => false,
        // Janela destruída ⇒ o `send` do Electron **lança** (é o bug original).
        send: () => {
          throw new Error("Object has been destroyed");
        },
      },
    };
    const deadContents: BroadcastWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        send: () => {
          throw new Error("Object has been destroyed");
        },
      },
    };

    const broadcaster = createEventBroadcaster(() => [destroyed, live, deadContents]);
    // Não pode lançar (o `throw` do `send` na janela morta era o bug).
    expect(() => broadcaster.broadcast("scribe:ipc:event", { event: "document.changed" })).not.toThrow();
    expect(sent).toEqual([{ channel: "scribe:ipc:event", payload: { event: "document.changed" } }]);
  });
});
