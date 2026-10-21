/**
 * Scribe — preload: a superfície exposta ao renderer (achado BAIXO da auditoria com runtime).
 *
 * **O bug:** `lsp.diagnostics` era o **único** método do contrato que o preload **não**
 * expunha ⇒ o renderer só obtinha diagnóstico pelo **evento** (que saía atrasado — ver
 * `test/main-lsp-diagnostics.test.ts`) e não conseguia **reler** o estado.
 *
 * **A correção:** o preload expõe `diagnostics(handle)` (o `IpcMethods` já tinha
 * `"lsp.diagnostics"`).
 */
import { describe, expect, it, vi } from "vitest";

const { exposed, invoke } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown): void => {
      exposed.set(key, api);
    },
  },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import type { ScribePreloadApi } from "../src/preload/index";
import type { DocumentHandle, LspDiagnostic } from "../src/shared";
// Efeito colateral: o preload se registra no `contextBridge` no import.
import "../src/preload/index";

const DIAGNOSTIC: LspDiagnostic = {
  range: { startLine: 1, startCol: 2, endLine: 3, endCol: 4 },
  severity: "error",
  message: "ERRO-1",
  source: "ts",
};

function preloadApi(): ScribePreloadApi {
  const api = exposed.get("scribe");
  if (api === undefined) throw new Error("preload não expôs `scribe`");
  return api as ScribePreloadApi;
}

describe("preload — superfície exposta", () => {
  it("expõe `diagnostics(handle)` (o método `lsp.diagnostics` do contrato)", async () => {
    const api = preloadApi();
    expect(typeof api.diagnostics).toBe("function");

    invoke.mockResolvedValueOnce({ v: "1.0", id: 1, ok: true, value: [DIAGNOSTIC] });
    const result = await api.diagnostics(1048576 as DocumentHandle);

    expect(result).toEqual([DIAGNOSTIC]);
    // O request vai no canal do contrato, com o método e o handle.
    expect(invoke).toHaveBeenCalledWith(
      "scribe:ipc:request",
      expect.objectContaining({
        method: "lsp.diagnostics",
        args: [1048576],
      }),
    );
  });

  it("propaga o erro remoto (nunca silencioso)", async () => {
    const api = preloadApi();
    invoke.mockResolvedValueOnce({
      v: "1.0",
      id: 2,
      ok: false,
      error: { code: "invalid-handle", message: "handle inválido" },
    });
    await expect(api.diagnostics(7 as DocumentHandle)).rejects.toThrow(/handle inválido/);
  });
});
