/**
 * Testes do cliente LSP.
 *
 * Usa um mock do transporte para simular envio/recebimento de mensagens sem
 * depender de um processo real.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Disposable } from "../../../shared/disposable";

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

function createMockTransport() {
  let messageListener: ((raw: string) => void) | undefined;

  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn(),
    get connected(): boolean { return true; },

    onMessage: vi.fn((listener: (raw: string) => void): Disposable => {
      messageListener = listener;
      return { dispose: vi.fn() };
    }),

    /** Dispara o listener capturado como se o servidor tivesse enviado `raw`. */
    receive(raw: string): void {
      messageListener?.(raw);
    },
  };
}

type MockTransport = ReturnType<typeof createMockTransport>;

// ── Import depois do setup ──────────────────────────────────────────────────────────────────

import { LspClient } from "../lsp-client";
import { LspError } from "../lsp-protocol";

/** Aguarda a fila de microtasks para que `await` dentro de funções mockadas prossiga. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("LspClient", () => {
  let transport: MockTransport;
  let client: LspClient;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    transport = createMockTransport();
    client = new LspClient(transport as unknown as never, 5000);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Descarta o cliente de forma segura, suprimindo rejeições de deffereds pendentes
    try {
      client.dispose();
    } catch {
      // ignora
    }
  });

  describe("connect", () => {
    it("conecta transporte, envia initialize e recebe resposta", async () => {
      const connectPromise = client.connect({
        processId: 123,
        capabilities: {},
        rootUri: null,
      });

      // Aguarda microtask para o `await transport.connect()` prosseguir
      await flushMicrotasks();

      // Deve ter chamado transport.connect() e enviado o request
      expect(transport.connect).toHaveBeenCalledOnce();
      expect(transport.send).toHaveBeenCalledTimes(1);

      const sent = transport.send.mock.calls[0]?.[0] ?? "";
      const parsed = JSON.parse(sent);
      expect(parsed.method).toBe("initialize");
      expect(parsed.id).toBe(1);

      // Simula resposta do servidor
      transport.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { capabilities: { hoverProvider: true } },
        }),
      );

      const result = await connectPromise;
      expect(result.capabilities.hoverProvider).toBe(true);
      expect(client.initialized).toBe(true);

      // Deve ter enviado "initialized" (notificação) após o initialize
      const allSends = transport.send.mock.calls.map((c) => JSON.parse(c[0] ?? "{}"));
      const initialized = allSends.find((s) => s.method === "initialized");
      expect(initialized).toBeDefined();
      expect(initialized?.id).toBeUndefined(); // notificação não tem id
    });

    it("rejeita se já inicializado", async () => {
      // Inicializa com sucesso
      const connect1 = client.connect({ processId: 1, capabilities: {} });
      await flushMicrotasks();
      transport.receive(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
      );
      await connect1;

      await expect(
        client.connect({ processId: 2, capabilities: {} }),
      ).rejects.toThrow(/já inicializado/);
    });
  });

  describe("sendRequest", () => {
    it("envia request e resolve com a resposta", async () => {
      await initClient(client, transport);

      const promise = client.sendRequest("textDocument/completion", {
        textDocument: { uri: "file:///test.ts" },
        position: { line: 0, character: 0 },
      });

      const sent = transport.send.mock.lastCall?.[0] ?? "";
      const parsed = JSON.parse(sent);
      expect(parsed.method).toBe("textDocument/completion");
      expect(parsed.id).toBe(2);

      transport.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: [{ label: "foo" }],
        }),
      );

      const result = await promise;
      expect(result).toEqual([{ label: "foo" }]);
    });

    it("rejeita com LspError se a resposta tem error", async () => {
      await initClient(client, transport);

      const promise = client.sendRequest("someMethod");
      const sent = transport.send.mock.lastCall?.[0] ?? "";
      const parsed = JSON.parse(sent);

      transport.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );

      await expect(promise).rejects.toThrow(LspError);
      await expect(promise).rejects.toThrow(/Method not found/);
    });

    it("rejeita com timeout se não há resposta", async () => {
      await initClient(client, transport);

      const promise = client.sendRequest("slowMethod");

      vi.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow(LspError);
      await expect(promise).rejects.toThrow(/timed out/);
    });
  });

  describe("sendNotification", () => {
    it("envia notificação sem id", () => {
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri: "file:///test.ts", languageId: "ts", version: 1, text: "" },
      });

      const sent = transport.send.mock.lastCall?.[0] ?? "";
      const parsed = JSON.parse(sent);
      expect(parsed.method).toBe("textDocument/didOpen");
      expect(parsed.id).toBeUndefined();
    });
  });

  describe("onNotification", () => {
    it("dispara handler registrado para notificação específica", async () => {
      await initClient(client, transport);

      const handler = vi.fn();
      client.onNotification("textDocument/publishDiagnostics", handler);

      const params = {
        uri: "file:///test.ts",
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: "err",
          },
        ],
      };

      transport.receive(
        JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params }),
      );

      expect(handler).toHaveBeenCalledWith(params);
    });

    it("disposable remove o handler", async () => {
      await initClient(client, transport);

      const handler = vi.fn();
      const disposable = client.onNotification("some/notification", handler);
      disposable.dispose();

      transport.receive(
        JSON.stringify({ jsonrpc: "2.0", method: "some/notification", params: {} }),
      );
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("onDiagnostics", () => {
    it("emite evento ao receber publishDiagnostics", async () => {
      await initClient(client, transport);

      const diagHandler = vi.fn();
      client.onDiagnostics(diagHandler);

      const params = {
        uri: "file:///test.ts",
        diagnostics: [],
      };

      transport.receive(
        JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params }),
      );

      expect(diagHandler).toHaveBeenCalledWith(params);
    });
  });

  describe("disconnect", () => {
    it("envia shutdown e exit e depois desconecta transporte", async () => {
      await initClient(client, transport);

      transport.send.mockClear();

      // disconnect() chama sendRequest("shutdown") que tem timeout de 5000ms.
      // Precisamos avançar os timers para que o timeout dispare e o catch o engula.
      const disconnectPromise = client.disconnect();
      vi.advanceTimersByTime(5000);
      await disconnectPromise;

      // Verifica que shutdown foi enviado (request) e exit (notificação)
      const calls = transport.send.mock.calls.map((c) => JSON.parse(c[0] ?? "{}"));
      const shutdown = calls.find((c) => c.method === "shutdown");
      const exit = calls.find((c) => c.method === "exit");

      expect(shutdown).toBeDefined();
      expect(shutdown?.id).toBeDefined();
      expect(exit).toBeDefined();
      expect(exit?.id).toBeUndefined();

      expect(transport.disconnect).toHaveBeenCalled();
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

async function initClient(client: LspClient, transport: MockTransport): Promise<void> {
  const promise = client.connect({ processId: 1, capabilities: {} });
  await flushMicrotasks();
  transport.receive(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
  );
  await promise;
}