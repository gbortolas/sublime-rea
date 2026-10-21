/**
 * Scribe — testes de fumaça do pipeline IPC ponta-a-ponta.
 *
 * Validam o ciclo completo keydown → IPC → main → texto de volta,
 * sem Electron (usam `handleIpcRequest` diretamente). Usam
 * `node:fs/promises` real para I/O de disco (arquivos temporários).
 *
 * O teste crítico é o #2: se "digitar não relê texto" (bug do AppImage)
 * voltar, ele falha porque insere por IPC e confirma que o texto lido
 * contém o que foi inserido.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { createIpcSignalRegistry, handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type {
  DocumentHandle,
  DocumentUndoState,
  SearchDocumentResult,
  ReplaceAllResult,
} from "../src/shared";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Filesystem real delegando a `node:fs/promises`. */
const nodeFs: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
};

/** Promise resolvida de fora (para segurar I/O em voo). */
function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

const TMP_ROOT = "/tmp/opencode/scribe-smoke";
let tmpDir: string;

function tmpPath(name: string): string {
  return join(tmpDir, name);
}

// ── testes ───────────────────────────────────────────────────────────────────

describe("fumaça — pipeline IPC (keydown → main → texto)", () => {
  let core: ReturnType<typeof createEditorCore>;

  beforeAll(async () => {
    await mkdir(TMP_ROOT, { recursive: true });
    tmpDir = mkdtempSync(join(TMP_ROOT, "smoke-"));
  });

  afterAll(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    core = createEditorCore({ fileSystem: nodeFs, availableParallelism: 4 });
  });

  afterEach(() => {
    core.dispose();
  });

  // ── 1. document.open + document.text ─────────────────────────────────────

  it("document.open → document.text: pipeline de leitura", async () => {
    const path = tmpPath("open-test.txt");
    await writeFile(path, "Scribe smoke test");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const text = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.text", args: [handle],
    });
    expect(text.ok).toBe(true);
    expect((text.ok ? text.value : "")).toBe("Scribe smoke test");
  });

  // ── 2. document.insert + document.text (o teste crítico) ────────────────

  it("insert → text: falharia se 'digitar não relê' voltar", async () => {
    const path = tmpPath("insert-roundtrip.txt");
    await writeFile(path, "");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const insert = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.insert",
      args: [handle, 0, "Scribe editor funcionando!", "user"],
    });
    expect(insert.ok).toBe(true);

    const text = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.text", args: [handle],
    });
    expect(text.ok).toBe(true);
    expect((text.ok ? text.value : "")).toContain("Scribe editor funcionando!");
  });

  // ── 3. document.replaceOne — backspace simulado ─────────────────────────

  it("replaceOne simula backspace: 'abc' → replaceOne(1,1,'') → 'ac'", async () => {
    const path = tmpPath("backspace.txt");
    await writeFile(path, "abc");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const repl = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.replaceOne",
      args: [handle, 1, 1, ""],
    });
    expect(repl.ok).toBe(true);

    const text = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.text", args: [handle],
    });
    expect((text.ok ? text.value : "")).toBe("ac");
  });

  // ── 4. document.replaceOne — delete simulado ────────────────────────────

  it("replaceOne simula delete: 'abc' → replaceOne(0,1,'') → 'bc'", async () => {
    const path = tmpPath("delete.txt");
    await writeFile(path, "abc");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const repl = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.replaceOne",
      args: [handle, 0, 1, ""],
    });
    expect(repl.ok).toBe(true);

    const text = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.text", args: [handle],
    });
    expect((text.ok ? text.value : "")).toBe("bc");
  });

  // ── 5. Par vazio — replaceOne(0,2,'') em '()' → '' ─────────────────────

  it("replaceOne remove par vazio '()' → ''", async () => {
    const path = tmpPath("pair.txt");
    await writeFile(path, "()");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const repl = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.replaceOne",
      args: [handle, 0, 2, ""],
    });
    expect(repl.ok).toBe(true);

    const text = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.text", args: [handle],
    });
    expect((text.ok ? text.value : "")).toBe("");
  });

  // ── 6. document.undo / document.redo ────────────────────────────────────

  it("digita → undo → redo pelo IPC", async () => {
    const path = tmpPath("undo-test.txt");
    await writeFile(path, "xyz");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.insert",
      args: [handle, 3, "123", "user"],
    });

    const afterInsert = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.text", args: [handle],
    });
    expect((afterInsert.ok ? afterInsert.value : "")).toBe("xyz123");

    // undo
    const undo = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 4, method: "editor.undo", args: [handle],
    });
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      const state = undo.value as DocumentUndoState;
      expect(state.canUndo).toBe(false);
      expect(state.canRedo).toBe(true);
    }

    const afterUndo = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 5, method: "document.text", args: [handle],
    });
    expect((afterUndo.ok ? afterUndo.value : "")).toBe("xyz");

    // redo
    const redo = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 6, method: "editor.redo", args: [handle],
    });
    expect(redo.ok).toBe(true);
    if (redo.ok) {
      const state = redo.value as DocumentUndoState;
      expect(state.canUndo).toBe(true);
      expect(state.canRedo).toBe(false);
    }

    const afterRedo = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 7, method: "document.text", args: [handle],
    });
    expect((afterRedo.ok ? afterRedo.value : "")).toBe("xyz123");
  });

  // ── 7. document.save ───────────────────────────────────────────────────

  it("document.save persiste alteração no arquivo real", async () => {
    const path = tmpPath("save-test.txt");
    await writeFile(path, "antes");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.insert",
      args: [handle, 0, ">>> ", "user"],
    });

    const save = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.save", args: [handle],
    });
    expect(save.ok).toBe(true);

    const disk = await readFile(path, "utf8");
    expect(disk).toBe(">>> antes");
  });

  // ── 8. document.isDirty ────────────────────────────────────────────────

  it("document.isDirty reflete estado de sujeira", async () => {
    const path = tmpPath("dirty-test.txt");
    await writeFile(path, "limpo");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const notDirty = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.isDirty", args: [handle],
    });
    expect((notDirty.ok ? notDirty.value : undefined)).toBe(false);

    await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.insert",
      args: [handle, 5, " sujo", "user"],
    });

    const dirty = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 4, method: "document.isDirty", args: [handle],
    });
    expect((dirty.ok ? dirty.value : undefined)).toBe(true);
  });

  // ── 9. search.find / search.replaceAll ──────────────────────────────────

  it("search.find e search.replaceAll funcionam pelo IPC", async () => {
    const path = tmpPath("search-test.txt");
    await writeFile(path, "um dois tres um dois");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const findResp = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "search.find",
      args: [handle, { pattern: "dois" }],
    });
    expect(findResp.ok).toBe(true);
    if (findResp.ok) {
      const result = findResp.value as SearchDocumentResult;
      expect(result.result.matches.length).toBe(2);
    }

    const replaceResp = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "search.replaceAll",
      args: [handle, { pattern: "dois" }, "DOIS"],
    });
    expect(replaceResp.ok).toBe(true);
    if (replaceResp.ok) {
      const rr = replaceResp.value as ReplaceAllResult;
      expect(rr.replaced).toBe(2);
    }

    const textResp = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 4, method: "document.text", args: [handle],
    });
    expect((textResp.ok ? textResp.value : "")).toBe("um DOIS tres um DOIS");
  });

  // ── 10. Cancelamento ─────────────────────────────────────────────────────

  it("cancela document.open em voo via signalId", async () => {
    const gate = deferred<string>();
    const slowFs: FileSystem = {
      readFile: () => gate.promise,
      writeFile: async () => {},
    };
    const coreSlow = createEditorCore({ fileSystem: slowFs, availableParallelism: 4 });
    const signals = createIpcSignalRegistry();
    try {
      const pending = handleIpcRequest(coreSlow, {
        v: IPC_VERSION, id: 1, method: "document.open",
        args: ["/adiado.txt"], signalId: 42,
      }, { signals });

      expect(signals.pending).toBe(1);
      signals.abort(42);
      gate.resolve("conteudo");

      const resp = await pending;
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.code).toBe("cancelled");
        expect(resp.error.message).not.toContain("\n");
      }
      expect(signals.pending).toBe(0);
    } finally {
      coreSlow.dispose();
    }
  });

  // ── 11. command.list / command.execute ──────────────────────────────────

  it("command.list retorna comandos e command.execute executa", async () => {
    const listResp = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "command.list", args: [],
    });
    expect(listResp.ok).toBe(true);
    if (listResp.ok) {
      // O contrato é `{ commands: [...] }` (CommandListResult) — o array puro quebrava a
      // paleta (achado no E2E do P4#27).
      const result = listResp.value as { readonly commands: ReadonlyArray<{ readonly id: string }> };
      const ids = result.commands.map((c) => c.id);
      expect(ids).toContain("edit.undo");
      expect(ids).toContain("file.save");
      expect(ids).toContain("edit.redo");
      expect(ids).toContain("debug.toggleBreakpoint");
    }

    // command.execute("edit.undo") com documento aberto
    const path = tmpPath("cmd-exec.txt");
    await writeFile(path, "alpha");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.insert",
      args: [handle, 5, " beta", "user"],
    });

    // executa edit.undo (usa activeHandle do core)
    const execResp = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 4, method: "command.execute", args: ["edit.undo"],
    });
    expect(execResp.ok).toBe(true);

    const textResp = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 5, method: "document.text", args: [handle],
    });
    expect((textResp.ok ? textResp.value : "")).toBe("alpha");
  });

  // ── 12. document.revision ────────────────────────────────────────────────

  it("document.revision incrementa a cada insert", async () => {
    const path = tmpPath("revision-test.txt");
    await writeFile(path, "a");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const rev1 = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "document.revision", args: [handle],
    });
    expect((rev1.ok ? rev1.value : 0)).toBe(1);

    await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.insert",
      args: [handle, 1, "b", "user"],
    });

    const rev2 = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 4, method: "document.revision", args: [handle],
    });
    expect((rev2.ok ? rev2.value : 0)).toBe(2);
  });

  // ── 13. editor.undoState ─────────────────────────────────────────────────

  it("editor.undoState reflete estado após inserção", async () => {
    const path = tmpPath("undostate-test.txt");
    await writeFile(path, "inicio");

    const open = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 1, method: "document.open", args: [path],
    });
    expect(open.ok).toBe(true);
    const handle = (open.ok ? open.value : 0) as DocumentHandle;

    const stateBefore = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 2, method: "editor.undoState", args: [handle],
    });
    expect(stateBefore.ok).toBe(true);
    if (stateBefore.ok) {
      const s = stateBefore.value as DocumentUndoState;
      expect(s.canUndo).toBe(false);
      expect(s.canRedo).toBe(false);
    }

    await handleIpcRequest(core, {
      v: IPC_VERSION, id: 3, method: "document.insert",
      args: [handle, 6, " meio", "user"],
    });

    const stateAfter = await handleIpcRequest(core, {
      v: IPC_VERSION, id: 4, method: "editor.undoState", args: [handle],
    });
    expect(stateAfter.ok).toBe(true);
    if (stateAfter.ok) {
      const s = stateAfter.value as DocumentUndoState;
      expect(s.canUndo).toBe(true);
      expect(s.canRedo).toBe(false);
      expect(typeof s.caret).toBe("number");
    }
  });
});
