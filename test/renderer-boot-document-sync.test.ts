/**
 * Scribe — testes da **sincronização do documento aberto no BOOT** (o `?file=`).
 *
 * ⚠️ **O bug**: o `open` inicial do boot roda **antes** do `onActiveDocumentChanged`
 * existir ⇒ o handler **nunca** era chamado para aquele documento ⇒ o Outline dizia
 * "Nenhum símbolo neste documento" e o Problems ficava vazio (o `lsp.diagnostics` é
 * *push* e pode ter chegado **antes** do listener ⇒ se perdido, o documento do boot
 * ficava sem diagnósticos).
 *
 * A lógica é **pura** (`syncBootDocument` — as dependências entram como parâmetros) ⇒
 * o teste roda em Node, sem DOM e sem Electron.
 */
import { describe, expect, it, vi } from "vitest";

import type { LspDiagnostic } from "../src/shared";
import { syncBootDocument } from "../src/renderer/main";

/** Uma sessão mínima (o que a sincronização usa: o `handle`). */
interface FakeSession {
  readonly handle: number;
  readonly path: string;
}

function diag(message: string): LspDiagnostic {
  return {
    range: { startLine: 0, startCol: 0, endLine: 0, endCol: 1 },
    severity: "error",
    message,
    source: "ts",
  };
}

describe("syncBootDocument — o documento do boot recebe o mesmo tratamento", () => {
  it("o handler do documento ativo é chamado (o Outline/sticky são buscados)", () => {
    const session: FakeSession = { handle: 7, path: "/w/a.ts" };
    const onActiveDocumentChanged = vi.fn();
    syncBootDocument<FakeSession>({
      session,
      onActiveDocumentChanged,
      diagnostics: undefined,
      onDiagnostics: () => {},
    });
    expect(onActiveDocumentChanged).toHaveBeenCalledTimes(1);
    expect(onActiveDocumentChanged).toHaveBeenCalledWith(session);
  });

  it("os diagnósticos do documento do boot são **buscados** e publicados", async () => {
    const session: FakeSession = { handle: 7, path: "/w/a.ts" };
    const diagnostics = [diag("erro em a")];
    const onDiagnostics = vi.fn();
    const onActiveDocumentChanged = vi.fn();
    syncBootDocument<FakeSession>({
      session,
      onActiveDocumentChanged,
      diagnostics: async (handle) => {
        expect(handle).toBe(7);
        return diagnostics;
      },
      onDiagnostics,
    });
    // A publicação é assíncrona (a busca é um IPC).
    await Promise.resolve();
    await Promise.resolve();
    expect(onDiagnostics).toHaveBeenCalledWith(7, diagnostics);
  });

  it("sem documento no boot, nada acontece (nem handler, nem busca)", () => {
    const onActiveDocumentChanged = vi.fn();
    const diagnostics = vi.fn(async () => []);
    syncBootDocument<FakeSession>({
      session: undefined,
      onActiveDocumentChanged,
      diagnostics,
      onDiagnostics: () => {},
    });
    expect(onActiveDocumentChanged).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("a falha da busca dos diagnósticos não derruba o boot (vai para o `onError`)", async () => {
    const onError = vi.fn();
    const onDiagnostics = vi.fn();
    syncBootDocument<FakeSession>({
      session: { handle: 7, path: "/w/a.ts" },
      onActiveDocumentChanged: () => {},
      diagnostics: async () => {
        throw new Error("ponte morta");
      },
      onDiagnostics,
      onError,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalled();
    expect(onDiagnostics).not.toHaveBeenCalled();
  });

  it("preload antigo (sem a busca de diagnósticos) ⇒ só o handler", () => {
    const onActiveDocumentChanged = vi.fn();
    syncBootDocument<FakeSession>({
      session: { handle: 7, path: "/w/a.ts" },
      onActiveDocumentChanged,
      diagnostics: undefined,
      onDiagnostics: () => {},
    });
    expect(onActiveDocumentChanged).toHaveBeenCalledTimes(1);
  });
});
