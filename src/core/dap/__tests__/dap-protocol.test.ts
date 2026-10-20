/**
 * Testes dos tipos e guards do protocolo DAP.
 */
import { describe, expect, it } from "vitest";

import {
  DapError,
  DapRequestError,
  isDapEvent,
  isDapRequest,
  isDapResponse,
  type DapEvent,
  type DapRequest,
  type DapResponse,
} from "../dap-protocol";

describe("guards de tipo", () => {
  const request: DapRequest = { seq: 1, type: "request", command: "threads" };
  const response: DapResponse = {
    seq: 2,
    type: "response",
    request_seq: 1,
    success: true,
    command: "threads",
  };
  const event: DapEvent = { seq: 3, type: "event", event: "stopped" };

  it("isDapRequest reconhece requisições", () => {
    expect(isDapRequest(request)).toBe(true);
    expect(isDapRequest(response)).toBe(false);
    expect(isDapRequest(event)).toBe(false);
  });

  it("isDapResponse reconhece respostas", () => {
    expect(isDapResponse(response)).toBe(true);
    expect(isDapResponse(request)).toBe(false);
    expect(isDapResponse(event)).toBe(false);
  });

  it("isDapEvent reconhece eventos", () => {
    expect(isDapEvent(event)).toBe(true);
    expect(isDapEvent(request)).toBe(false);
    expect(isDapEvent(response)).toBe(false);
  });
});

describe("erros do módulo DAP", () => {
  it("DapError carrega código e nome", () => {
    const err = new DapError("DAP_TIMEOUT", "estourou");
    expect(err.code).toBe("DAP_TIMEOUT");
    expect(err.name).toBe("DapError");
    expect(err.message).toBe("estourou");
    expect(err instanceof Error).toBe(true);
  });

  it("DapRequestError prefixa o comando e usa código fixo", () => {
    const err = new DapRequestError("stackTrace", "thread inexistente");
    expect(err.code).toBe("DAP_REQUEST_FAILED");
    expect(err.name).toBe("DapRequestError");
    expect(err.command).toBe("stackTrace");
    expect(err.message).toBe("stackTrace: thread inexistente");
    expect(err instanceof DapError).toBe(true);
  });
});
