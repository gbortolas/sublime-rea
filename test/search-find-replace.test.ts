/**
 * Scribe — integração **de ponta a ponta** de busca/substituição (P2.4c).
 *
 * Prova o caminho completo sem Electron e sem display: `search.find`/`search.replaceAll` via
 * `handleIpcRequest` → `EditorCore` → lane `background` do `Scheduler` → tarefa `search` na lane
 * `index` do `TaskPool` (worker_threads). Inclui a idempotência do replace-all (um só `Ctrl+Z`),
 * a recusa quando a busca é truncada, o no-op sem matches e a **coalescência** das notificações
 * (um replace-all de N matches publica **um** `document.changed`, não N).
 */
import { describe, expect, it, vi } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type { DocumentChangedEvent, ReplaceAllResult, SearchDocumentResult } from "../src/shared";

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
  };
}

function makeCore(files: Readonly<Record<string, string>>): ReturnType<typeof createEditorCore> {
  return createEditorCore({ fileSystem: memoryFs(files), availableParallelism: 4 });
}

describe("busca/substituição de ponta a ponta (IPC → core → lane background → worker)", () => {
  it("`search.find` devolve ocorrências e passa pela lane `background` do Scheduler", async () => {
    const core = makeCore({ "/a.txt": "foo bar foo" });
    const postSpy = vi.spyOn(core.scheduler, "post");
    try {
      const handle = await core.openDocument("/a.txt");
      const executedBefore = (core.pool as unknown as { executedCount: number }).executedCount;

      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 1,
        method: "search.find",
        args: [handle, { pattern: "foo" }],
      });

      expect(response.ok).toBe(true);
      if (response.ok) {
        const value = response.value as SearchDocumentResult;
        expect(value.revision).toBe(core.revisionOf(handle));
        expect(value.result.matches.map((match) => match.index)).toEqual([0, 8]);
      }
      // Prova da lane: o `Scheduler` foi usado com a prioridade `background` (não a UI thread).
      expect(postSpy.mock.calls.some(([priority]) => priority === "background")).toBe(true);
      // E a tarefa atravessou o pool (contador de execuções subiu).
      expect((core.pool as unknown as { executedCount: number }).executedCount).toBeGreaterThan(
        executedBefore,
      );
    } finally {
      core.dispose();
    }
  });

  it("`search.replaceAll` + **um** undo restaura o texto original inteiro", async () => {
    const core = makeCore({ "/b.txt": "foo bar foo baz foo" });
    try {
      const handle = await core.openDocument("/b.txt");
      const before = core.documentText(handle);

      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 2,
        method: "search.replaceAll",
        args: [handle, { pattern: "foo" }, "X"],
      });

      expect(response.ok).toBe(true);
      if (response.ok) expect((response.value as ReplaceAllResult).replaced).toBe(3);
      expect(core.documentText(handle)).toBe("X bar X baz X");

      // Um **único** `Ctrl+Z` desfaz o replace-all inteiro (um só passo de undo).
      const state = await core.undoDocument(handle);
      expect(core.documentText(handle)).toBe(before);
      expect(state.canRedo).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it("replaceAll de 1000 matches emite **um único** `document.changed` (sem fan-out O(N·n))", async () => {
    const core = makeCore({ "/f.txt": "foo ".repeat(1000) });
    const events: DocumentChangedEvent[] = [];
    const subscription = core.onDocumentChanged((event) => events.push(event));
    try {
      const handle = await core.openDocument("/f.txt");
      events.length = 0; // a abertura não é mudança de conteúdo do documento

      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 7,
        method: "search.replaceAll",
        args: [handle, { pattern: "foo" }, "X"],
      });

      expect(response.ok).toBe(true);
      if (response.ok) expect((response.value as ReplaceAllResult).replaced).toBe(1000);
      // Um **único** evento (não um por `buffer.apply`) e com a revisão **final**: o consumidor
      // refaz o texto uma vez, não 1000 (= o vetor de freeze de GB no cap default).
      expect(events).toEqual([{ handle, revision: core.revisionOf(handle) }]);
      expect(core.documentText(handle)).toBe("X ".repeat(1000));
    } finally {
      subscription.dispose();
      core.dispose();
    }
  });

  it("undo do replace-all segue o fluxo comum: um evento por delta aplicado", async () => {
    const core = makeCore({ "/g.txt": "foo bar foo baz foo" });
    try {
      const handle = await core.openDocument("/g.txt");
      const before = core.documentText(handle);
      await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 8,
        method: "search.replaceAll",
        args: [handle, { pattern: "foo" }, "X"],
      });
      expect(core.documentText(handle)).toBe("X bar X baz X");

      // O undo **não** é coalescido (é o fluxo comum): notifica como sempre notificou.
      const events: DocumentChangedEvent[] = [];
      const subscription = core.onDocumentChanged((event) => events.push(event));
      try {
        const state = await core.undoDocument(handle);
        expect(core.documentText(handle)).toBe(before);
        expect(state.canRedo).toBe(true);
        expect(events).toHaveLength(3);
        expect(events.at(-1)?.revision).toBe(core.revisionOf(handle));
      } finally {
        subscription.dispose();
      }
    } finally {
      core.dispose();
    }
  });

  it("falha no meio do escopo ainda notifica **um** evento coerente com o buffer", async () => {
    const core = makeCore({ "/h.txt": "foo foo foo" });
    const events: DocumentChangedEvent[] = [];
    const subscription = core.onDocumentChanged((event) => events.push(event));
    try {
      const handle = await core.openDocument("/h.txt");
      // Falha injetada na 2ª substituição: o estado tem de ser notificado **uma vez** e casar com o
      // buffer de verdade (não com o último delta bem-sucedido).
      const original = core.commands.run.bind(core.commands);
      let calls = 0;
      const spy: typeof core.commands.run = (name, args, opts) => {
        calls += 1;
        return calls === 2
          ? Promise.reject(new Error("falha injetada no meio do escopo"))
          : original(name, args, opts);
      };
      core.commands.run = spy;

      await expect(core.replaceAll(handle, { pattern: "foo" }, "X")).rejects.toThrow(
        "falha injetada no meio do escopo",
      );
      expect(core.documentText(handle)).toBe("X foo foo"); // só a 1ª substituição entrou
      expect(events).toEqual([{ handle, revision: core.revisionOf(handle) }]);
    } finally {
      subscription.dispose();
      core.dispose();
    }
  });

  it("recusa o replace-all quando a busca é truncada (nada de substituição parcial)", async () => {
    const core = makeCore({ "/c.txt": "foo foo foo" });
    try {
      const handle = await core.openDocument("/c.txt");
      const before = core.documentText(handle);

      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 3,
        method: "search.replaceAll",
        args: [handle, { pattern: "foo", maxMatches: 2 }, "X"],
      });

      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe("search.tooManyMatches");
      expect(core.documentText(handle)).toBe(before);
    } finally {
      core.dispose();
    }
  });

  it("replace-all com 0 matches é no-op e não cria entrada de undo", async () => {
    const core = makeCore({ "/d.txt": "foo bar" });
    try {
      const handle = await core.openDocument("/d.txt");
      const depthBefore = core.commands.undoStack.undoDepth;

      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 4,
        method: "search.replaceAll",
        args: [handle, { pattern: "zzz" }, "X"],
      });

      expect(response.ok).toBe(true);
      if (response.ok) expect((response.value as ReplaceAllResult).replaced).toBe(0);
      expect(core.commands.undoStack.undoDepth).toBe(depthBefore);
      expect(core.documentText(handle)).toBe("foo bar");
    } finally {
      core.dispose();
    }
  });

  it("devolve falha estruturada para query inválida e padrão vazio", async () => {
    const core = makeCore({ "/e.txt": "abc" });
    try {
      const handle = await core.openDocument("/e.txt");

      const wrongType = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 5,
        method: "search.find",
        args: [handle, { pattern: 5 }],
      });
      expect(wrongType.ok).toBe(false);
      if (!wrongType.ok) expect(wrongType.error.code).toBe("invalid-args");

      const empty = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 6,
        method: "search.find",
        args: [handle, { pattern: "" }],
      });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error.code).toBe("search.emptyPattern");
    } finally {
      core.dispose();
    }
  });
});
