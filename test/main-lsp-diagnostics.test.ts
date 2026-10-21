/**
 * Scribe — broadcast dos diagnósticos LSP (achado BAIXO da auditoria com runtime).
 *
 * **O bug:** o `main` lia o cache do core (`documentDiagnostics`) dentro do `onDiagnostics`.
 * O core assina o `onDiagnostics` do `LspManager` **depois** (no `attachLsp`, assíncrono) ⇒ o
 * `Emitter.fire` (Set ⇒ ordem de inserção) chamava o `main` **primeiro**, com o cache ainda
 * da publicação **anterior** ⇒ o evento `lsp.diagnostics` saía **atrasado em um evento**
 * (publish#1 ⇒ `[]`; publish#2 ⇒ `["ERRO-1"]`). Se o servidor publicasse **uma vez só**, o
 * renderer **nunca** mostraria o diagnóstico.
 *
 * **A correção:** o `main` usa os `params.diagnostics` **do próprio evento**.
 */
import { describe, expect, it } from "vitest";

import { broadcastLspDiagnostics, toLspDiagnostic } from "../src/main/index";
import type { IpcEventBroadcaster } from "../src/main/index";
import { Emitter } from "../src/shared/events";
import { IPC_CHANNEL, IPC_VERSION } from "../src/shared";
import type { DocumentHandle, LspDiagnostic } from "../src/shared";
import type { Diagnostic } from "../src/core/lsp/lsp-protocol";

const HANDLE = 1048576 as DocumentHandle;
const URI = "file:///tmp/a.ts";

function raw(
  message: string,
  severity?: number,
  source?: string,
): Diagnostic {
  return {
    range: {
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
    },
    ...(severity !== undefined ? { severity } : {}),
    ...(source !== undefined ? { source } : {}),
    message,
  };
}

describe("main — broadcast dos diagnósticos LSP", () => {
  it("usa os dados do EVENTO (o cache do core, sempre atrasado, é ignorado)", () => {
    const emitter = new Emitter<{
      readonly uri: string;
      readonly diagnostics: readonly Diagnostic[];
    }>();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const events: IpcEventBroadcaster = {
      broadcast: (channel, payload) => sent.push({ channel, payload }),
    };

    // O cache do core: SEMPRE um evento atrasado (é o que o `main` lia antes).
    const staleCache: LspDiagnostic[] = [];
    const core = {
      findHandleByUri: (uri: string): DocumentHandle | undefined =>
        uri === URI ? HANDLE : undefined,
      documentDiagnostics: (): LspDiagnostic[] => staleCache,
    };

    const subscription = broadcastLspDiagnostics({ onDiagnostics: emitter.event }, core, events);
    try {
      // Publicação #1.
      emitter.fire({ uri: URI, diagnostics: [raw("ERRO-1", 1, "ts")] });
      // Publicação #2 (o core só atualizaria o cache **depois** do nosso listener).
      emitter.fire({ uri: URI, diagnostics: [raw("ERRO-2", 2), raw("AVISO-3", 3)] });
    } finally {
      subscription.dispose();
    }

    expect(sent).toHaveLength(2);
    expect(sent.every((entry) => entry.channel === IPC_CHANNEL.event)).toBe(true);

    const first = sent[0]?.payload as {
      v: string;
      event: string;
      args: Array<{ handle: DocumentHandle; diagnostics: LspDiagnostic[] }>;
    };
    const second = sent[1]?.payload as typeof first;

    expect(first.v).toBe(IPC_VERSION);
    expect(first.event).toBe("lsp.diagnostics");
    // **O dado da publicação #1** — não `[]` (o cache atrasado).
    expect(first.args[0]?.handle).toBe(HANDLE);
    expect(first.args[0]?.diagnostics).toEqual([
      {
        range: { startLine: 1, startCol: 2, endLine: 3, endCol: 4 },
        severity: "error",
        message: "ERRO-1",
        source: "ts",
      },
    ]);

    // **O dado da publicação #2** — e não o da #1.
    expect(second.args[0]?.diagnostics).toEqual([
      {
        range: { startLine: 1, startCol: 2, endLine: 3, endCol: 4 },
        severity: "warning",
        message: "ERRO-2",
        source: "LSP",
      },
      {
        range: { startLine: 1, startCol: 2, endLine: 3, endCol: 4 },
        severity: "info",
        message: "AVISO-3",
        source: "LSP",
      },
    ]);
  });

  it("ignora documento que não está aberto no core", () => {
    const emitter = new Emitter<{
      readonly uri: string;
      readonly diagnostics: readonly Diagnostic[];
    }>();
    const sent: unknown[] = [];
    const events: IpcEventBroadcaster = {
      broadcast: (_channel, payload) => sent.push(payload),
    };
    const core = {
      findHandleByUri: (): DocumentHandle | undefined => undefined,
    };
    const subscription = broadcastLspDiagnostics({ onDiagnostics: emitter.event }, core, events);
    try {
      emitter.fire({ uri: URI, diagnostics: [raw("ERRO-1", 1)] });
    } finally {
      subscription.dispose();
    }
    expect(sent).toHaveLength(0);
  });

  it("mapeia a severidade do LSP e o `source` ausente", () => {
    expect(toLspDiagnostic(raw("x", 1)).severity).toBe("error");
    expect(toLspDiagnostic(raw("x", 2)).severity).toBe("warning");
    expect(toLspDiagnostic(raw("x", 3)).severity).toBe("info");
    expect(toLspDiagnostic(raw("x", 4)).severity).toBe("hint");
    // Severidade ausente ⇒ "info" (mesmo critério do `core`).
    expect(toLspDiagnostic(raw("x")).severity).toBe("info");
    expect(toLspDiagnostic(raw("x")).source).toBe("LSP");
  });
});
