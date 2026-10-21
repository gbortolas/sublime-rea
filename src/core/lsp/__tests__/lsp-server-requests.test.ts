/**
 * Testes dos **requests servidor→cliente** (o bug ALTO do `pyright` travado).
 *
 * Diagnóstico do bug: o `pyright` **envia** `workspace/configuration` (server→client) e
 * **fica bloqueado** esperando a resposta. Como o cliente ignorava todo request do
 * servidor, o servidor inteiro travava ⇒ em `.py` não havia símbolos, nem diagnóstico,
 * nem hover ⇒ as features novas (Outline e Problems) ficavam vazias.
 *
 * A regra que estes testes travam: **o cliente nunca pode deixar o servidor esperando**.
 * Todo request server→client recebe resposta — inclusive método desconhecido (erro
 * `-32601`), porque *silêncio* = servidor travado.
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

/** Todas as mensagens enviadas pelo cliente (já parseadas). */
function sentMessages(transport: MockTransport): Record<string, unknown>[] {
  return transport.send.mock.calls.map((c) => JSON.parse(c[0] ?? "{}") as Record<string, unknown>);
}

/** A última resposta enviada pelo cliente (a que casa com o `id` do request do servidor). */
function responseTo(transport: MockTransport, id: string | number): Record<string, unknown> | undefined {
  return sentMessages(transport).find((m) => m["id"] === id && ("result" in m || "error" in m));
}

async function initClient(client: LspClient, transport: MockTransport): Promise<void> {
  const promise = client.connect({ processId: 1, capabilities: {} });
  await new Promise((resolve) => setImmediate(resolve));
  transport.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
  await promise;
}

describe("LspClient — requests servidor→cliente", () => {
  let transport: MockTransport;
  let client: LspClient;

  beforeEach(() => {
    transport = createMockTransport();
    client = new LspClient(transport as unknown as never, 5000);
  });

  afterEach(() => {
    try {
      client.dispose();
    } catch {
      // ignora
    }
  });

  it("responde workspace/configuration com um array do tamanho de params.items", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "cfg-1",
        method: "workspace/configuration",
        params: { items: [{ section: "python" }, { section: "python.analysis" }] },
      }),
    );

    const response = responseTo(transport, "cfg-1");
    expect(response).toBeDefined();
    const result = response?.["result"] as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    // Sem configuração ⇒ `null` em cada entrada (o servidor usa o default dele).
    expect(result).toEqual([null, null]);
  });

  it("responde null a client/registerCapability e registra a capability dinâmica", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "client/registerCapability",
        params: {
          registrations: [
            { id: "reg-1", method: "textDocument/completion", registerOptions: { triggerCharacters: ["."] } },
          ],
        },
      }),
    );

    const response = responseTo(transport, 10);
    expect(response).toBeDefined();
    expect(response?.["result"]).toBeNull();
    expect(response?.["error"]).toBeUndefined();

    const registered = client.registrations.get("textDocument/completion");
    expect(registered?.get("reg-1")).toMatchObject({ id: "reg-1", method: "textDocument/completion" });
  });

  it("responde null a client/unregisterCapability e remove a capability", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "client/registerCapability",
        params: { registrations: [{ id: "reg-2", method: "textDocument/completion" }] },
      }),
    );
    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "client/unregisterCapability",
        params: { registrations: [{ id: "reg-2", method: "textDocument/completion" }] },
      }),
    );

    expect(responseTo(transport, 12)?.["result"]).toBeNull();
    expect(client.registrations.get("textDocument/completion")?.has("reg-2")).toBe(false);
  });

  it("responde null a window/workDoneProgress/create", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "window/workDoneProgress/create",
        params: { token: "tok-1" },
      }),
    );

    const response = responseTo(transport, 20);
    expect(response).toBeDefined();
    expect(response?.["result"]).toBeNull();
  });

  it("responde null aos requests de refresh (semanticTokens/codeLens/inlayHint/diagnostic)", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    const methods = [
      "workspace/semanticTokens/refresh",
      "workspace/codeLens/refresh",
      "workspace/inlayHint/refresh",
      "workspace/diagnostic/refresh",
    ];
    methods.forEach((method, index) => {
      transport.receive(JSON.stringify({ jsonrpc: "2.0", id: 30 + index, method }));
    });

    methods.forEach((_method, index) => {
      const response = responseTo(transport, 30 + index);
      expect(response, `sem resposta para ${_method}`).toBeDefined();
      expect(response?.["result"]).toBeNull();
      expect(response?.["error"]).toBeUndefined();
    });
  });

  it("responde ERRO -32601 a um método desconhecido (nunca silêncio)", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(
      JSON.stringify({ jsonrpc: "2.0", id: 99, method: "server/naoExiste", params: {} }),
    );

    const response = responseTo(transport, 99);
    expect(response).toBeDefined();
    expect(response?.["result"]).toBeUndefined();
    const error = response?.["error"] as { code: number; message: string } | undefined;
    expect(error?.code).toBe(-32601);
    expect(error?.message).toMatch(/server\/naoExiste/);
  });

  it("workspace/applyEdit ⇒ { applied: false } (nada é aplicado)", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "edit-1",
        method: "workspace/applyEdit",
        params: {
          edit: {
            changes: {
              "file:///test.py": [
                { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" },
              ],
            },
          },
        },
      }),
    );

    const response = responseTo(transport, "edit-1");
    expect(response).toBeDefined();
    expect(response?.["result"]).toEqual({ applied: false });
    // Nenhum outro mecanismo de aplicação de edit é acionado.
    expect(sentMessages(transport).filter((m) => m["method"] !== undefined)).toHaveLength(0);
  });

  it("workspace/workspaceFolders ⇒ null por padrão (sem pastas conhecidas)", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(JSON.stringify({ jsonrpc: "2.0", id: "folders-1", method: "workspace/workspaceFolders" }));

    const response = responseTo(transport, "folders-1");
    expect(response).toBeDefined();
    expect(response?.["result"]).toBeNull();
  });

  it("o handler do gerente sobrescreve o default (workspace/workspaceFolders)", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    client.setRequestHandler("workspace/workspaceFolders", () => [
      { uri: "file:///proj", name: "proj" },
    ]);

    transport.receive(JSON.stringify({ jsonrpc: "2.0", id: "folders-2", method: "workspace/workspaceFolders" }));

    expect(responseTo(transport, "folders-2")?.["result"]).toEqual([
      { uri: "file:///proj", name: "proj" },
    ]);
  });

  it("dispose do handler restaura o default", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    const disposable = client.setRequestHandler("workspace/workspaceFolders", () => [
      { uri: "file:///proj", name: "proj" },
    ]);
    disposable.dispose();

    transport.receive(JSON.stringify({ jsonrpc: "2.0", id: "folders-3", method: "workspace/workspaceFolders" }));

    expect(responseTo(transport, "folders-3")?.["result"]).toBeNull();
  });

  // ── Regressão: notificação ≠ resposta ≠ request ──────────────────────────────────────────

  it("regressão: publishDiagnostics continua sendo notificação (não vira request)", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    const handler = vi.fn();
    client.onNotification("textDocument/publishDiagnostics", handler);
    const diagnostics = vi.fn();
    client.onDiagnostics(diagnostics);

    const params = { uri: "file:///test.py", diagnostics: [] };
    transport.receive(
      JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params }),
    );

    expect(handler).toHaveBeenCalledWith(params);
    expect(diagnostics).toHaveBeenCalledWith(params);
    // Notificação **não** gera resposta.
    expect(sentMessages(transport)).toHaveLength(0);
  });

  it("regressão: request do servidor não resolve nem rejeita o pending do cliente", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    // Request do cliente em voo (id 2).
    const pending = client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: "file:///test.py" },
    });

    // O servidor manda um request **com o mesmo id** (o pyright usa ids próprios).
    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "workspace/configuration",
        params: { items: [{ section: "python" }] },
      }),
    );

    // A resposta do servidor ao request do cliente continua funcionando.
    transport.receive(
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: [{ name: "símbolo", kind: 12 }] }),
    );

    await expect(pending).resolves.toEqual([{ name: "símbolo", kind: 12 }]);
  });

  it("responde a TODOS os requests (o pyright pergunta uma seção por vez)", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    // O pyright pergunta a configuração **em cascata**: responde à primeira, pergunta a
    // segunda, e só destrava depois de todas. Responder só a primeira ⇒ servidor travado.
    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "workspace/configuration",
        params: { items: [{ section: "python" }] },
      }),
    );
    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "workspace/configuration",
        params: { items: [{ section: "pyright" }] },
      }),
    );

    expect(responseTo(transport, 0)?.["result"]).toEqual([null]);
    expect(responseTo(transport, 1)?.["result"]).toEqual([null]);
  });

  it("handler assíncrono ⇒ a resposta sai quando a promise resolve", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    client.setRequestHandler(
      "workspace/configuration",
      async () => [{ typeCheckingMode: "strict" }],
    );

    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "cfg-async",
        method: "workspace/configuration",
        params: { items: [{ section: "python" }] },
      }),
    );

    // A promise ainda não resolveu ⇒ nada foi enviado (e o servidor não foi deixado sem resposta).
    expect(responseTo(transport, "cfg-async")).toBeUndefined();

    await new Promise((resolve) => setImmediate(resolve));

    expect(responseTo(transport, "cfg-async")?.["result"]).toEqual([
      { typeCheckingMode: "strict" },
    ]);
  });

  it("não-travamento: request do servidor não deixa o cliente pendurado nem dá timeout falso", async () => {
    await initClient(client, transport);
    transport.send.mockClear();

    transport.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "cfg-9",
        method: "workspace/configuration",
        params: { items: [{ section: "python" }] },
      }),
    );

    // O request seguinte do cliente continua funcionando normalmente.
    const pending = client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: "file:///test.py" },
    });
    const sent = sentMessages(transport).find((m) => m["method"] === "textDocument/documentSymbol");
    transport.receive(
      JSON.stringify({ jsonrpc: "2.0", id: sent?.["id"], result: [] }),
    );

    await expect(pending).resolves.toEqual([]);
    // Nenhum request do servidor entrou no mapa de pendentes (o cliente não "trava").
    expect((client as unknown as { pending: Map<unknown, unknown> }).pending.size).toBe(0);
  });
});
