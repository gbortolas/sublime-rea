/**
 * Scribe — integração do despacho de IPC do `main` **sem Electron**.
 *
 * Prova que `registerIpcHandlers`/`handleIpcRequest` funcionam por injeção (host/broadcaster
 * fakes), que o evento `document.changed` é publicado e que envelope inválido/método
 * desconhecido viram `ok: false` (nunca silencioso).
 */
import { describe, expect, it } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest, registerIpcHandlers } from "../src/main/index";
import type { IpcEventBroadcaster, MainIpcHost } from "../src/main/index";
import { IPC_CHANNEL, IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
    writeFile: async (_path: string, _data: string): Promise<void> => {
      // mock em memória
    },
  };
}

class FakeIpcHost implements MainIpcHost {
  readonly handlers = new Map<string, (event: unknown, ...args: readonly unknown[]) => unknown>();

  handle(
    channel: string,
    listener: (event: unknown, ...args: readonly unknown[]) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  invoke(channel: string, raw: unknown): Promise<IpcResponse> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) return Promise.reject(new Error(`sem handler: ${channel}`));
    return Promise.resolve(handler(undefined, raw)) as Promise<IpcResponse>;
  }
}

describe("main — despacho de IPC sem Electron", () => {
  it("cria, lê, edita e publica mudanças pelo contrato", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/a.txt": "hi" }),
      availableParallelism: 4,
    });
    const ipc = new FakeIpcHost();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const events: IpcEventBroadcaster = {
      broadcast: (channel, payload) => sent.push({ channel, payload }),
    };
    const registration = registerIpcHandlers(core, ipc, events);

    try {
      const opened = await ipc.invoke(IPC_CHANNEL.request, {
        v: IPC_VERSION,
        id: 1,
        method: "document.open",
        args: ["/a.txt"],
      });
      expect(opened.ok).toBe(true);
      const handle = (opened.ok ? opened.value : 0) as DocumentHandle;

      const text = await ipc.invoke(IPC_CHANNEL.request, {
        v: IPC_VERSION,
        id: 2,
        method: "document.text",
        args: [handle],
      });
      expect(text).toEqual({ v: IPC_VERSION, id: 2, ok: true, value: "hi" });

      const inserted = await ipc.invoke(IPC_CHANNEL.request, {
        v: IPC_VERSION,
        id: 3,
        method: "document.insert",
        args: [handle, 0, "> ", "user"],
      });
      expect(inserted.ok).toBe(true);
      expect(core.documentText(handle)).toBe("> hi");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.channel).toBe(IPC_CHANNEL.event);

      const snapshot = await ipc.invoke(IPC_CHANNEL.request, {
        v: IPC_VERSION,
        id: 4,
        method: "editor.snapshot",
        args: [],
      });
      expect(snapshot.ok).toBe(true);
    } finally {
      registration.dispose();
      core.dispose();
    }

    expect(ipc.handlers.has(IPC_CHANNEL.request)).toBe(false);
  });

  it("devolve falha estruturada para método desconhecido e envelope inválido", async () => {
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    try {
      const unknown = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 5,
        method: "document.nope",
        args: [],
      });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.error.code).toBe("unknown-method");
      expect(unknown.id).toBe(5);

      const invalid = await handleIpcRequest(core, null);
      expect(invalid.ok).toBe(false);
      expect(invalid.id).toBe(0);
      if (!invalid.ok) expect(invalid.error.code).toBe("invalid-envelope");
    } finally {
      core.dispose();
    }
  });
});
