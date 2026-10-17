/**
 * Scribe — cancelamento end-to-end do IPC (AbortSignal ↔ IpcCancel) e métodos de undo/redo no
 * despacho do `main`. **Sem Electron, sem rede, sem display**: `handleIpcRequest` é puro, o
 * `FileSystem` é em memória e o diálogo é injetado.
 */
import { describe, expect, it } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import {
  createIpcSignalRegistry,
  handleIpcRequest,
  registerIpcHandlers,
} from "../src/main/index";
import type {
  FileDialogPort,
  IpcEventBroadcaster,
  IpcHandlerDeps,
  IpcSignalRegistry,
  MainIpcHost,
} from "../src/main/index";
import { IPC_CHANNEL, IPC_VERSION } from "../src/shared";
import type { DocumentHandle, DocumentUndoState, IpcResponse } from "../src/shared";

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
  };
}

/** Promise resolvida de fora — deixa o teste segurar o I/O de abertura em voo. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
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

const silentEvents: IpcEventBroadcaster = { broadcast: (): void => undefined };

describe("IpcSignalRegistry", () => {
  it("cria, aborta e libera controllers por signalId", () => {
    const signals = createIpcSignalRegistry();
    const signal = signals.create(1);
    expect(signal.aborted).toBe(false);
    expect(signals.pending).toBe(1);

    signals.abort(1);
    expect(signal.aborted).toBe(true);

    signals.release(1);
    expect(signals.pending).toBe(0);

    // Abortar um signalId desconhecido é no-op (não lança).
    expect(() => signals.abort(99)).not.toThrow();
  });
});

describe("cancelamento de document.open em voo", () => {
  it("aborta o I/O e devolve erro tipado 'cancelled' (sem stack)", async () => {
    const gate = deferred<string>();
    const fs: FileSystem = { readFile: (): Promise<string> => gate.promise };
    const core = createEditorCore({ fileSystem: fs, availableParallelism: 4 });
    const signals = createIpcSignalRegistry();
    try {
      const pending = handleIpcRequest(
        core,
        { v: IPC_VERSION, id: 1, method: "document.open", args: ["/big.txt"], signalId: 42 },
        { signals },
      );
      // O `readFile` está pendente → a operação está em voo e registrada.
      expect(signals.pending).toBe(1);

      signals.abort(42);
      gate.resolve("conteúdo enorme");

      const response = await pending;
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error.code).toBe("cancelled");
        expect(response.error.message).not.toContain("\n");
      }
      expect(signals.pending).toBe(0);
    } finally {
      core.dispose();
    }
  });

  it("trata o envelope IpcCancel no mesmo canal do request (sem resposta)", async () => {
    const gate = deferred<string>();
    const fs: FileSystem = { readFile: (): Promise<string> => gate.promise };
    const core = createEditorCore({ fileSystem: fs, availableParallelism: 4 });
    const signals: IpcSignalRegistry = createIpcSignalRegistry();
    const ipc = new FakeIpcHost();
    const registration = registerIpcHandlers(core, ipc, silentEvents, { signals });
    try {
      const handler = ipc.handlers.get(IPC_CHANNEL.request);
      expect(handler).toBeDefined();
      if (handler === undefined) return;

      const pending = handler(undefined, {
        v: IPC_VERSION,
        id: 1,
        method: "document.open",
        args: ["/big.txt"],
        signalId: 7,
      }) as Promise<IpcResponse>;
      expect(signals.pending).toBe(1);

      const cancelResult = handler(undefined, { v: IPC_VERSION, kind: "cancel", signalId: 7 });
      expect(cancelResult).toBeUndefined();

      gate.resolve("texto");
      const response = await pending;
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe("cancelled");
    } finally {
      registration.dispose();
      core.dispose();
    }
  });
});

describe("despacho de undo/redo/openDialog", () => {
  it("executa editor.undo, editor.redo e editor.undoState pelo contrato", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      await core.insertText(handle, 3, "d", "user");

      const undone = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 1,
        method: "editor.undo",
        args: [handle],
      });
      expect(undone.ok).toBe(true);
      if (undone.ok) {
        const state = undone.value as DocumentUndoState;
        expect(state.canUndo).toBe(false);
        expect(state.canRedo).toBe(true);
      }
      expect(core.documentText(handle)).toBe("abc");

      const redone = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 2,
        method: "editor.redo",
        args: [handle],
      });
      expect(redone.ok).toBe(true);
      expect(core.documentText(handle)).toBe("abcd");

      const state = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 3,
        method: "editor.undoState",
        args: [handle],
      });
      expect(state.ok).toBe(true);
      if (state.ok) expect((state.value as DocumentUndoState).canUndo).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it("document.openDialog usa o diálogo injetado e falha alto sem ele", async () => {
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    try {
      const chosen = "/tmp/escolhido.txt";
      const dialog: FileDialogPort = { showOpenDialog: (): Promise<string> => Promise.resolve(chosen) };
      const deps: IpcHandlerDeps = { dialog };
      const ok = await handleIpcRequest(
        core,
        { v: IPC_VERSION, id: 1, method: "document.openDialog", args: [] },
        deps,
      );
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.value).toBe(chosen);

      const missing = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 2,
        method: "document.openDialog",
        args: [],
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("dialog-unavailable");
    } finally {
      core.dispose();
    }
  });

  it("devolve falha tipada para handle inválido em editor.undo", async () => {
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    try {
      const bad = 999 as DocumentHandle;
      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 1,
        method: "editor.undo",
        args: [bad],
      });
      expect(response.ok).toBe(false);
    } finally {
      core.dispose();
    }
  });
});
