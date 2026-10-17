/**
 * Scribe — testes do contrato de IPC (`src/shared/ipc-contract.ts`).
 *
 * O envelope é validado **alto**: malformado/método desconhecido ⇒ `IpcProtocolError` (nunca
 * silencioso). Determinístico e sem I/O.
 */
import { describe, expect, it } from "vitest";

import {
  IPC_CHANNEL,
  IPC_VERSION,
  IpcProtocolError,
  isIpcMethodName,
  parseIpcCancel,
  parseIpcEvent,
  parseIpcRequest,
  parseIpcResponse,
} from "../src/shared";

describe("ipc-contract", () => {
  it("expõe canais e versão constantes", () => {
    expect(IPC_VERSION).toBe("1.0");
    expect(IPC_CHANNEL.request).toBe("scribe:ipc:request");
    expect(IPC_CHANNEL.event).toBe("scribe:ipc:event");
  });

  it("aceita um envelope de requisição válido", () => {
    const request = parseIpcRequest({
      v: IPC_VERSION,
      id: 1,
      method: "document.text",
      args: [1048576],
    });
    expect(request.method).toBe("document.text");
    expect(request.args).toEqual([1048576]);
    expect(request.id).toBe(1);
  });

  it("rejeita método desconhecido", () => {
    expect(() =>
      parseIpcRequest({ v: IPC_VERSION, id: 1, method: "document.nope", args: [] }),
    ).toThrow(IpcProtocolError);
    expect(isIpcMethodName("document.open")).toBe(true);
    expect(isIpcMethodName("editor.nope")).toBe(false);
  });

  it("rejeita envelope malformado ou versão incompatível", () => {
    expect(() => parseIpcRequest(null)).toThrow(/invalid-envelope/);
    expect(() => parseIpcRequest({ v: IPC_VERSION, id: 1, args: [] })).toThrow(/unknown-method/);
    expect(() =>
      parseIpcRequest({ v: "2.0", id: 1, method: "document.text", args: [] }),
    ).toThrow(/version-mismatch/);
    expect(() =>
      parseIpcRequest({ v: IPC_VERSION, id: 1, method: "document.text", args: "x" }),
    ).toThrow(/invalid-args/);
    expect(() =>
      parseIpcRequest({ v: IPC_VERSION, id: 1.5, method: "document.text", args: [] }),
    ).toThrow(/invalid-id/);
  });

  it("valida envelope de resposta", () => {
    expect(parseIpcResponse({ v: IPC_VERSION, id: 3, ok: true, value: "x" })).toEqual({
      v: IPC_VERSION,
      id: 3,
      ok: true,
      value: "x",
    });
    expect(() => parseIpcResponse({ v: IPC_VERSION, id: 3 })).toThrow(/invalid-envelope/);
  });

  it("valida envelope de evento", () => {
    const event = parseIpcEvent({
      v: IPC_VERSION,
      event: "document.changed",
      args: [{ handle: 1048576, revision: 2 }],
    });
    expect(event.event).toBe("document.changed");
    expect(() => parseIpcEvent({ v: IPC_VERSION, event: "nope", args: [] })).toThrow(
      /unknown-event/,
    );
  });

  it("valida envelope de cancelamento", () => {
    expect(parseIpcCancel({ v: IPC_VERSION, kind: "cancel", signalId: 9 })).toEqual({
      v: IPC_VERSION,
      kind: "cancel",
      signalId: 9,
    });
    expect(() => parseIpcCancel({ v: IPC_VERSION, kind: "nope", signalId: 9 })).toThrow(
      IpcProtocolError,
    );
  });
});
