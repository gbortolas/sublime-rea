/**
 * Testes do gerenciador de servidores LSP.
 *
 * Mocka `LspClient` e `LspStdioTransport` para testar o roteamento de operações
 * de documento e pedidos de linguagem sem servidores reais.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LspServerConfig } from "../../../shared/lsp-contract";

// ── Mocks hoisted ───────────────────────────────────────────────────────────────────────────

const { mockLspClient, mockTransport } = vi.hoisted(() => {
  const mockClientConnect = vi.fn();
  const mockClientSendRequest = vi.fn();
  const mockClientSendNotification = vi.fn();
  const mockClientDisconnect = vi.fn();
  const mockClientOnDiagnostics = vi.fn();
  const mockClientDispose = vi.fn();

  const mClient = vi.fn().mockImplementation(() => ({
    connect: mockClientConnect,
    sendRequest: mockClientSendRequest,
    sendNotification: mockClientSendNotification,
    disconnect: mockClientDisconnect,
    onDiagnostics: mockClientOnDiagnostics,
    dispose: mockClientDispose,
  }));

  const mockTransportConnect = vi.fn();
  const mockTransportSend = vi.fn();
  const mockTransportDisconnect = vi.fn();
  const mockTransportOnMessage = vi.fn();
  const mockTransportDispose = vi.fn();

  const mTransport = vi.fn().mockImplementation(() => ({
    connect: mockTransportConnect,
    send: mockTransportSend,
    disconnect: mockTransportDisconnect,
    onMessage: mockTransportOnMessage,
    dispose: mockTransportDispose,
  }));

  return {
    mockLspClient: { impl: mClient, connect: mockClientConnect, sendRequest: mockClientSendRequest, sendNotification: mockClientSendNotification, disconnect: mockClientDisconnect, onDiagnostics: mockClientOnDiagnostics, dispose: mockClientDispose },
    mockTransport: { impl: mTransport, connect: mockTransportConnect, send: mockTransportSend, disconnect: mockTransportDisconnect, onMessage: mockTransportOnMessage, dispose: mockTransportDispose },
  };
});

vi.mock("../lsp-client", () => ({ LspClient: mockLspClient.impl }));
vi.mock("../lsp-transport", () => ({ LspStdioTransport: mockTransport.impl }));

// ── Import depois dos mocks ─────────────────────────────────────────────────────────────────

import { LspManager } from "../lsp-manager";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

const TS_CONFIG: LspServerConfig = {
  name: "TypeScript",
  kind: "builtin",
  languages: ["ts", "tsx"],
  languageId: "typescript",
  spawn: { command: "typescript-language-server", args: ["--stdio"] },
  enabled: true,
};

const PY_CONFIG: LspServerConfig = {
  name: "Python",
  kind: "builtin",
  languages: ["py"],
  languageId: "python",
  spawn: { command: "pyright-langserver", args: ["--stdio"] },
  enabled: true,
};

describe("LspManager", () => {
  let manager: LspManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLspClient.connect.mockResolvedValue(undefined);
    mockLspClient.onDiagnostics.mockReturnValue({ dispose: vi.fn() });

    manager = new LspManager([TS_CONFIG, PY_CONFIG]);
  });

  describe("startServer", () => {
    it("cria transporte e cliente, conecta e retorna o cliente", async () => {
      const client = await manager.startServer(TS_CONFIG);

      expect(mockTransport.impl).toHaveBeenCalledWith(
        "typescript-language-server",
        ["--stdio"],
        undefined,
      );
      expect(mockLspClient.impl).toHaveBeenCalled();
      expect(mockLspClient.connect).toHaveBeenCalledOnce();
      expect(client).toBeDefined();
    });

    it("conecta com InitializeParams corretos", async () => {
      await manager.startServer(TS_CONFIG);

      const initParams = mockLspClient.connect.mock.calls[0]?.[0];
      expect(initParams).toMatchObject({
        processId: expect.any(Number),
        // ⚠️ **não** pode ser `{}`: sem `textDocument.publishDiagnostics` o servidor
        // (typescript-language-server / pyright) **não publica diagnóstico nenhum**.
        capabilities: expect.objectContaining({
          textDocument: expect.objectContaining({
            publishDiagnostics: expect.objectContaining({ relatedInformation: true }),
          }),
          workspace: expect.objectContaining({ workspaceFolders: true }),
        }),
        clientInfo: { name: "Scribe" },
        rootUri: null,
      });
    });

    it("pede as capabilities que o servidor precisa para publicar diagnósticos", async () => {
      await manager.startServer(TS_CONFIG);

      const initParams = mockLspClient.connect.mock.calls[0]?.[0] as {
        readonly capabilities: Record<string, unknown>;
      };
      expect(initParams.capabilities).toMatchObject({
        textDocument: {
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          synchronization: { didSave: true, dynamicRegistration: false, textDocumentSync: 1 },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { linkSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
        workspace: { workspaceFolders: true, configuration: true },
      });
    });

    it("lança se servidor já foi iniciado", async () => {
      await manager.startServer(TS_CONFIG);
      await expect(manager.startServer(TS_CONFIG)).rejects.toThrow(/já iniciado/);
    });
  });

  describe("getClient", () => {
    it("retorna undefined antes de iniciar qualquer servidor", () => {
      expect(manager.getClient("ts")).toBeUndefined();
    });

    it("retorna o cliente certo pela extensão", async () => {
      const tsClient = await manager.startServer(TS_CONFIG);
      await manager.startServer(PY_CONFIG);

      expect(manager.getClient("ts")).toBe(tsClient);
      expect(manager.getClient("tsx")).toBe(tsClient);
      expect(manager.getClient("py")).not.toBe(tsClient);
      expect(manager.getClient("rs")).toBeUndefined();
    });
  });

  describe("operações de documento", () => {
    it("openDocument envia didOpen ao servidor correto", async () => {
      await manager.startServer(TS_CONFIG);
      await manager.startServer(PY_CONFIG);
      mockLspClient.sendNotification.mockClear();

      manager.openDocument("file:///test.ts", "typescript", "const x = 1;", 1);

      // Deve ter chamado sendNotification no cliente TypeScript
      const tsNotifications = mockLspClient.sendNotification.mock.calls.filter(
        (call: unknown[]) => call[0] === "textDocument/didOpen",
      );
      expect(tsNotifications).toHaveLength(1);

      const params = tsNotifications[0]?.[1] as Record<string, unknown>;
      expect(params?.textDocument).toMatchObject({
        uri: "file:///test.ts",
        languageId: "typescript",
      });
    });

    it("changeDocument envia didChange", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendNotification.mockClear();

      manager.changeDocument("file:///test.ts", "const y = 2;", 2);

      expect(mockLspClient.sendNotification).toHaveBeenCalledWith(
        "textDocument/didChange",
        expect.objectContaining({
          textDocument: { uri: "file:///test.ts", version: 2 },
        }),
      );
    });

    it("closeDocument envia didClose", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendNotification.mockClear();

      manager.closeDocument("file:///test.ts");

      expect(mockLspClient.sendNotification).toHaveBeenCalledWith(
        "textDocument/didClose",
        expect.objectContaining({
          textDocument: { uri: "file:///test.ts" },
        }),
      );
    });

    it("não envia nada se não há servidor para extensão", () => {
      manager.openDocument("file:///unknown.xyz", "unknown", "", 1);
      expect(mockLspClient.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe("requestCompletion", () => {
    it("retorna items do servidor correto", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue([
        { label: "console", kind: 6 },
      ]);

      const items = await manager.requestCompletion("file:///test.ts", 0, 0);

      expect(items).toHaveLength(1);
      expect(items[0]?.label).toBe("console");
    });

    it("retorna array vazio sem servidor para extensão", async () => {
      const items = await manager.requestCompletion("file:///f.xyz", 0, 0);
      expect(items).toEqual([]);
    });

    it("extrai items de resposta com isIncomplete", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue({
        isIncomplete: false,
        items: [{ label: "foo" }, { label: "bar" }],
      });

      const items = await manager.requestCompletion("file:///test.ts", 0, 0);
      expect(items).toHaveLength(2);
    });
  });

  describe("requestHover", () => {
    it("retorna hover do servidor correto", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue({
        contents: { kind: "markdown", value: "**type** string" },
      });

      const hover = await manager.requestHover("file:///test.ts", 0, 5);
      expect(hover).not.toBeNull();
      expect(hover?.contents).toEqual({ kind: "markdown", value: "**type** string" });
    });

    it("retorna null sem servidor para extensão", async () => {
      const hover = await manager.requestHover("file:///f.xyz", 0, 0);
      expect(hover).toBeNull();
    });
  });

  describe("requestRename", () => {
    it("retorna WorkspaceEdit do servidor correto", async () => {
      await manager.startServer(TS_CONFIG);
      const mockEdit = {
        changes: {
          "file:///test.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "bar" }],
        },
      };
      mockLspClient.sendRequest.mockResolvedValue(mockEdit);

      const result = await manager.requestRename("file:///test.ts", 0, 0, "bar");
      expect(result).toEqual(mockEdit);
      expect(mockLspClient.sendRequest).toHaveBeenCalledWith(
        "textDocument/rename",
        expect.objectContaining({ newName: "bar" }),
      );
    });

    it("retorna null sem servidor para extensão", async () => {
      const result = await manager.requestRename("file:///f.xyz", 0, 0, "x");
      expect(result).toBeNull();
    });
  });

  describe("requestReferences", () => {
    it("retorna referências do servidor correto", async () => {
      await manager.startServer(TS_CONFIG);
      const mockRefs = [
        { uri: "file:///test.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        { uri: "file:///test.ts", range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } } },
      ];
      mockLspClient.sendRequest.mockResolvedValue(mockRefs);

      const refs = await manager.requestReferences("file:///test.ts", 0, 0);
      expect(refs).toHaveLength(2);
      expect(refs[0]?.uri).toBe("file:///test.ts");
      expect(mockLspClient.sendRequest).toHaveBeenCalledWith(
        "textDocument/references",
        expect.objectContaining({
          textDocument: { uri: "file:///test.ts" },
          position: { line: 0, character: 0 },
          context: { includeDeclaration: true },
        }),
      );
    });

    it("retorna array vazio sem servidor para extensão", async () => {
      const refs = await manager.requestReferences("file:///f.xyz", 0, 0);
      expect(refs).toEqual([]);
    });

    it("passa includeDeclaration false quando solicitado", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue([]);

      await manager.requestReferences("file:///test.ts", 0, 0, false);
      expect(mockLspClient.sendRequest).toHaveBeenCalledWith(
        "textDocument/references",
        expect.objectContaining({
          context: { includeDeclaration: false },
        }),
      );
    });
  });

  describe("requestCodeActions", () => {
    it("retorna code actions do servidor correto", async () => {
      await manager.startServer(TS_CONFIG);
      const mockActions = [
        { title: "Fix error", kind: "quickfix", diagnostics: [] },
        { title: "Refactor", kind: "refactor.extract" },
      ];
      mockLspClient.sendRequest.mockResolvedValue(mockActions);

      const result = await manager.requestCodeActions("file:///test.ts", 0, 5, []);
      expect(result).toHaveLength(2);
      expect(result[0]!.title).toBe("Fix error");
      expect(result[1]!.title).toBe("Refactor");
      expect(mockLspClient.sendRequest).toHaveBeenCalledWith(
        "textDocument/codeAction",
        expect.objectContaining({
          textDocument: { uri: "file:///test.ts" },
          range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
        }),
      );
    });

    it("passa diagnostics para o servidor", async () => {
      await manager.startServer(TS_CONFIG);
      const diags = [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          message: "test error",
          severity: 1,
        },
      ];
      mockLspClient.sendRequest.mockResolvedValue([]);

      await manager.requestCodeActions("file:///test.ts", 0, 5, diags);
      expect(mockLspClient.sendRequest).toHaveBeenCalledWith(
        "textDocument/codeAction",
        expect.objectContaining({
          context: { diagnostics: diags },
        }),
      );
    });

    it("retorna array vazio sem servidor para extensão", async () => {
      const result = await manager.requestCodeActions("file:///f.xyz", 0, 0, []);
      expect(result).toEqual([]);
    });
  });

  describe("requestDocumentSymbols", () => {
    it("normaliza a forma hierárquica (DocumentSymbol)", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue([
        {
          name: "classe",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        },
      ]);

      const symbols = await manager.requestDocumentSymbols("file:///test.ts");

      expect(symbols).toHaveLength(1);
      expect(symbols[0]?.name).toBe("classe");
    });

    it("normaliza a forma plana (SymbolInformation: range em location.range)", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue([
        {
          name: "funcao",
          kind: 12,
          location: {
            uri: "file:///test.ts",
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
          },
        },
      ]);

      const symbols = await manager.requestDocumentSymbols("file:///test.ts");

      expect(symbols).toHaveLength(1);
      expect(symbols[0]?.name).toBe("funcao");
    });

    it("descarta entradas malformadas sem estourar", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue([
        null,
        "lixo",
        { kind: 12 },
        { name: "ok", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ]);

      const symbols = await manager.requestDocumentSymbols("file:///test.ts");

      expect(symbols).toHaveLength(1);
      expect(symbols[0]?.name).toBe("ok");
    });

    it("devolve lista vazia para resposta que não é array", async () => {
      await manager.startServer(TS_CONFIG);
      mockLspClient.sendRequest.mockResolvedValue({ nope: true });

      const symbols = await manager.requestDocumentSymbols("file:///test.ts");

      expect(symbols).toEqual([]);
    });
  });

  describe("disconnectAll", () => {
    it("desconecta todos os servidores", async () => {
      await manager.startServer(TS_CONFIG);
      await manager.startServer(PY_CONFIG);

      await manager.disconnectAll();

      expect(mockLspClient.disconnect).toHaveBeenCalledTimes(2);
    });
  });
});