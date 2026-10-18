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
import type { JsonRpcMessage } from "../lsp-protocol";

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