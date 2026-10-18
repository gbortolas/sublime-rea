/**
 * Testes dos guards de tipo do protocolo JSON-RPC / LSP.
 */
import { describe, expect, it } from "vitest";

import {
  isRequestMessage,
  isResponseMessage,
  isNotificationMessage,
  isJsonRpcError,
} from "../lsp-protocol";
import type { JsonRpcMessage, ReferenceParams } from "../lsp-protocol";

describe("isRequestMessage", () => {
  it("identifica um RequestMessage válido", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: {} };
    expect(isRequestMessage(msg as unknown as JsonRpcMessage)).toBe(true);
  });

  it("retorna false para ResponseMessage (tem result)", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, result: {} };
    expect(isRequestMessage(msg as unknown as JsonRpcMessage)).toBe(false);
  });

  it("retorna false para NotificationMessage (sem id)", () => {
    const msg = { jsonrpc: "2.0" as const, method: "exit" };
    expect(isRequestMessage(msg as unknown as JsonRpcMessage)).toBe(false);
  });

  it("retorna false para objeto vazio", () => {
    expect(isRequestMessage({} as unknown as JsonRpcMessage)).toBe(false);
  });
});

describe("isResponseMessage", () => {
  it("identifica ResponseMessage com result", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, result: { capabilities: {} } };
    expect(isResponseMessage(msg as unknown as JsonRpcMessage)).toBe(true);
  });

  it("identifica ResponseMessage com error", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, error: { code: -32601, message: "not found" } };
    expect(isResponseMessage(msg as unknown as JsonRpcMessage)).toBe(true);
  });

  it("retorna false para RequestMessage", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "initialize" };
    expect(isResponseMessage(msg as unknown as JsonRpcMessage)).toBe(false);
  });

  it("retorna false para NotificationMessage", () => {
    const msg = { jsonrpc: "2.0" as const, method: "exit" };
    expect(isResponseMessage(msg as unknown as JsonRpcMessage)).toBe(false);
  });
});

describe("isNotificationMessage", () => {
  it("identifica NotificationMessage válida", () => {
    const msg = { jsonrpc: "2.0" as const, method: "textDocument/publishDiagnostics", params: {} };
    expect(isNotificationMessage(msg as unknown as JsonRpcMessage)).toBe(true);
  });

  it("retorna false para RequestMessage (tem id)", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "initialize" };
    expect(isNotificationMessage(msg as unknown as JsonRpcMessage)).toBe(false);
  });

  it("retorna false para ResponseMessage", () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, result: {} };
    expect(isNotificationMessage(msg as unknown as JsonRpcMessage)).toBe(false);
  });
});

describe("isJsonRpcError", () => {
  it("identifica um erro JSON-RPC válido", () => {
    expect(isJsonRpcError({ code: -32700, message: "Parse error" })).toBe(true);
  });

  it("retorna false se code não é número", () => {
    expect(isJsonRpcError({ code: "abc", message: "err" })).toBe(false);
  });

  it("retorna false se message não é string", () => {
    expect(isJsonRpcError({ code: 1, message: 42 })).toBe(false);
  });

  it("retorna false para null", () => {
    expect(isJsonRpcError(null)).toBe(false);
  });

  it("retorna false para undefined", () => {
    expect(isJsonRpcError(undefined)).toBe(false);
  });
});

describe("ReferenceParams", () => {
  it("pode ser construído com includeDeclaration", () => {
    const params: ReferenceParams = {
      textDocument: { uri: "file:///test.ts" },
      position: { line: 0, character: 5 },
      context: { includeDeclaration: true },
    };
    expect(params.textDocument.uri).toBe("file:///test.ts");
    expect(params.position).toEqual({ line: 0, character: 5 });
    expect(params.context.includeDeclaration).toBe(true);
  });

  it("pode ser construído com includeDeclaration false", () => {
    const params: ReferenceParams = {
      textDocument: { uri: "file:///test.ts" },
      position: { line: 10, character: 3 },
      context: { includeDeclaration: false },
    };
    expect(params.context.includeDeclaration).toBe(false);
  });
});

describe("RenameParams", () => {
  it("satisfaz a estrutura esperada", () => {
    const params: import("../lsp-protocol").RenameParams = {
      textDocument: { uri: "file:///test.ts" },
      position: { line: 0, character: 5 },
      newName: "novoNome",
    };
    expect(params.textDocument.uri).toBe("file:///test.ts");
    expect(params.position.line).toBe(0);
    expect(params.position.character).toBe(5);
    expect(params.newName).toBe("novoNome");
  });
});

describe("PrepareRenameParams", () => {
  it("satisfaz a estrutura esperada", () => {
    const params: import("../lsp-protocol").PrepareRenameParams = {
      textDocument: { uri: "file:///test.ts" },
      position: { line: 1, character: 10 },
    };
    expect(params.textDocument.uri).toBe("file:///test.ts");
    expect(params.position.line).toBe(1);
    expect(params.position.character).toBe(10);
  });
});

describe("CodeActionParams", () => {
  it("satisfaz a estrutura esperada", () => {
    const params: import("../lsp-protocol").CodeActionParams = {
      textDocument: { uri: "file:///test.ts" },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: {
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: "test error",
            severity: 1,
          },
        ],
      },
    };
    expect(params.textDocument.uri).toBe("file:///test.ts");
    expect(params.context.diagnostics).toHaveLength(1);
    expect(params.context.diagnostics[0]!.message).toBe("test error");
  });

  it("aceita campos opcionais only e triggerKind", () => {
    const params: import("../lsp-protocol").CodeActionParams = {
      textDocument: { uri: "file:///test.ts" },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: {
        diagnostics: [],
        only: ["quickfix", "refactor"],
        triggerKind: 2,
      },
    };
    expect(params.context.only).toEqual(["quickfix", "refactor"]);
    expect(params.context.triggerKind).toBe(2);
  });
});

describe("CodeAction", () => {
  it("satisfaz a estrutura mínima", () => {
    const action: import("../lsp-protocol").CodeAction = {
      title: "Fix typo",
    };
    expect(action.title).toBe("Fix typo");
  });

  it("satisfaz a estrutura completa com edit e command", () => {
    const action: import("../lsp-protocol").CodeAction = {
      title: "Extract function",
      kind: "refactor.extract.function",
      isPreferred: true,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          message: "test",
        },
      ],
      edit: {
        changes: {
          "file:///test.ts": [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "bar" },
          ],
        },
      },
      command: {
        title: "Apply Refactor",
        command: "editor.action.refactor",
        arguments: ["arg1"],
      },
    };
    expect(action.title).toBe("Extract function");
    expect(action.kind).toBe("refactor.extract.function");
    expect(action.edit!.changes!["file:///test.ts"]).toHaveLength(1);
    expect(action.command!.command).toBe("editor.action.refactor");
  });
});

describe("WorkspaceEdit", () => {
  it("satisfaz a estrutura com mudanças em múltiplos arquivos", () => {
    const edit: import("../lsp-protocol").WorkspaceEdit = {
      changes: {
        "file:///test.ts": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "foo" },
        ],
        "file:///other.ts": [
          { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: "bar" },
        ],
      },
    };
    expect(Object.keys(edit.changes!)).toHaveLength(2);
    expect(edit.changes!["file:///test.ts"]![0]!.newText).toBe("foo");
    expect(edit.changes!["file:///other.ts"]![0]!.newText).toBe("bar");
  });

  it("aceita changes opcional", () => {
    const edit: import("../lsp-protocol").WorkspaceEdit = {};
    expect(edit.changes).toBeUndefined();
  });
});