/**
 * Scribe — integração do despacho de IPC do `main` **sem Electron**.
 *
 * Prova que `registerIpcHandlers`/`handleIpcRequest` funcionam por injeção (host/broadcaster
 * fakes), que o evento `document.changed` é publicado e que envelope inválido/método
 * desconhecido viram `ok: false` (nunca silencioso).
 */
import { describe, expect, it, vi } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import type { DapManager } from "../src/core/dap/dap-manager";
import { handleIpcRequest, registerIpcHandlers } from "../src/main/index";
import type { IpcEventBroadcaster, MainIpcHost } from "../src/main/index";
import { IPC_CHANNEL, IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";
import { MAX_EVALUATION_LENGTH } from "../src/shared/dap-contract";
import {
  MAX_EVALUATION_VALUE_LENGTH,
  type DapEvaluation,
} from "../src/shared/dap-contract";

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

  it("command.list devolve o envelope { commands } (a palette lê result.commands)", async () => {
    // Regressão (achada no E2E do P4#27): o main devolvia o array puro e a palette recebia
    // `undefined` em `result.commands` ⇒ abria **vazia**.
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    try {
      const listed = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 90,
        method: "command.list",
        args: [],
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const value = listed.value as { commands?: { id: string }[] };
      expect(Array.isArray(value.commands)).toBe(true);
      expect(value.commands?.length).toBeGreaterThan(0);
      expect(value.commands?.some((c) => c.id === "debug.toggleBreakpoint")).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it("dap.evaluate recusa expressão acima do teto e devolve null (1 warn)", async () => {
    // Regressão (achado na revisão do P4#27): a expressão ia sem limite para o adaptador.
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const evaluate = vi.fn(async () => ({ value: "42", variablesReference: 0 }));
    const dap = { evaluate } as unknown as DapManager;
    try {
      const tooLong = await handleIpcRequest(
        core,
        {
          v: IPC_VERSION,
          id: 92,
          method: "dap.evaluate",
          args: ["x".repeat(MAX_EVALUATION_LENGTH + 1), 1, "hover"],
        },
        { dap },
      );
      expect(tooLong.ok).toBe(true);
      if (tooLong.ok) expect(tooLong.value).toBeNull();
      expect(evaluate).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);

      // Dentro do teto: a avaliação acontece.
      const withinLimit = await handleIpcRequest(
        core,
        { v: IPC_VERSION, id: 93, method: "dap.evaluate", args: ["x", 1, "hover"] },
        { dap },
      );
      expect(withinLimit.ok).toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      core.dispose();
    }
  });

  it("dap.evaluate normaliza o contexto: só 'watch' e 'hover' (o resto cai para 'watch')", async () => {
    // Regressão (achado de segurança do P4#27): o IPC aceitava `repl`/`clipboard` — o
    // `repl` executa a expressão como **statement** no debuggee (efeito colateral).
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    const contexts: unknown[] = [];
    const evaluate = vi.fn(
      async (_expression: string, _frameId: number, context?: unknown) => {
        contexts.push(context);
        return { value: "42", variablesReference: 0 };
      },
    );
    const dap = { evaluate } as unknown as DapManager;
    try {
      for (const context of ["repl", "clipboard", "lixo", undefined]) {
        const response = await handleIpcRequest(
          core,
          { v: IPC_VERSION, id: 100, method: "dap.evaluate", args: ["x", 1, context] },
          { dap },
        );
        expect(response.ok).toBe(true);
      }
      expect(contexts).toEqual(["watch", "watch", "watch", "watch"]);

      // `hover` é respeitado.
      await handleIpcRequest(
        core,
        { v: IPC_VERSION, id: 101, method: "dap.evaluate", args: ["x", 1, "hover"] },
        { dap },
      );
      expect(contexts[4]).toBe("hover");
    } finally {
      core.dispose();
    }
  });

  it("dap.evaluate recusa 'frameId' que não é inteiro positivo", async () => {
    // Regressão (achado de segurança do P4#27): qualquer número finito era aceito como
    // frame (inclusive `NaN`, `0`, `-1` ou `1.5`).
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    const evaluate = vi.fn(async () => ({ value: "42", variablesReference: 0 }));
    const dap = { evaluate } as unknown as DapManager;
    try {
      for (const frameId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
        const response = await handleIpcRequest(
          core,
          { v: IPC_VERSION, id: 110, method: "dap.evaluate", args: ["x", frameId, "hover"] },
          { dap },
        );
        expect(response.ok).toBe(false);
        if (!response.ok) expect(response.error.code).toBe("invalid-args");
      }
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      core.dispose();
    }
  });

  it("dap.evaluate trunca o valor e o tipo em 8 KB", async () => {
    // O valor vem do programa depurado (que o renderer não controla) e cruza o IPC.
    const core = createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 4 });
    const evaluate = vi.fn(async () => ({
      value: "x".repeat(MAX_EVALUATION_VALUE_LENGTH * 2),
      type: "y".repeat(MAX_EVALUATION_VALUE_LENGTH * 2),
      variablesReference: 0,
    }));
    const dap = { evaluate } as unknown as DapManager;
    try {
      const response = await handleIpcRequest(
        core,
        { v: IPC_VERSION, id: 120, method: "dap.evaluate", args: ["x", 1, "hover"] },
        { dap },
      );
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const value = response.value as DapEvaluation;
      expect(value.value.length).toBe(MAX_EVALUATION_VALUE_LENGTH);
      expect(value.type?.length).toBe(MAX_EVALUATION_VALUE_LENGTH);
    } finally {
      core.dispose();
    }
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
