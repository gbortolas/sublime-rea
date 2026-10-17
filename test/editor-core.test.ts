/**
 * Scribe — testes de integração do módulo de composição `core/editor` (costura final).
 *
 * Sem rede, sem GUI, sem workers de verdade: o `FileSystem` é em memória e a CPU é injetada
 * (`availableParallelism`) para o dimensionamento do pool ser determinístico.
 */
import { describe, expect, it } from "vitest";

import {
  createEditorCore,
  EditorCoreDisposedError,
  InvalidDocumentHandleError,
} from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import type { DocumentChangedEvent, DocumentHandle } from "../src/shared";

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

describe("createEditorCore (integração)", () => {
  it("abre um documento e devolve o texto (I/O assíncrono)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "hello\nworld" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      expect(core.documentText(handle)).toBe("hello\nworld");
      expect(core.revisionOf(handle)).toBe(1);
    } finally {
      core.dispose();
    }
  });

  it("insertText altera o texto, incrementa a revisão e emite onDocumentChanged", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "hello\nworld" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      const events: DocumentChangedEvent[] = [];
      core.onDocumentChanged((event) => events.push(event));

      const before = core.revisionOf(handle);
      const after = await core.insertText(handle, 5, "!", "user");

      expect(core.documentText(handle)).toBe("hello!\nworld");
      expect(after).toBe(before + 1);
      expect(core.revisionOf(handle)).toBe(after);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ handle, revision: after });
    } finally {
      core.dispose();
    }
  });

  it("aceita origem 'plugin' e mantém a revisão monotônica", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      const r1 = await core.insertText(handle, 0, "X", "plugin");
      const r2 = await core.insertText(handle, 1, "Y", "plugin");
      expect(core.documentText(handle)).toBe("XYabc");
      expect(r2).toBeGreaterThan(r1);
    } finally {
      core.dispose();
    }
  });

  it("rejeita handle inválido com erro alto", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    try {
      await core.openDocument("/doc.txt");
      const bad = 7 as DocumentHandle;
      expect(() => core.documentText(bad)).toThrow(InvalidDocumentHandleError);
      expect(() => core.revisionOf(bad)).toThrow(InvalidDocumentHandleError);
      await expect(core.insertText(bad, 0, "x")).rejects.toThrow(InvalidDocumentHandleError);
    } finally {
      core.dispose();
    }
  });

  it("snapshot() reflete as lanes do pool e os defaults de fábrica", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({}),
      availableParallelism: 4,
    });
    try {
      const snapshot = core.snapshot();
      expect(snapshot.lanes).toEqual({ io: 0, index: 0, fileRead: 0 });
      expect(snapshot.pendingCallbacks).toBe(0);
      expect(core.pool.size("io")).toBe(2);
      expect(core.pool.size("fileRead")).toBe(2);
      expect(core.pool.size("index")).toBe(1);
      expect(core.properties.resolved("editor.ioWorkers")).toBe(2);
      expect(core.properties.resolved("render.backend")).toBe("canvas2d");
    } finally {
      core.dispose();
    }
  });

  it("recusa operações depois de dispose()", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    core.dispose();
    await expect(core.openDocument("/doc.txt")).rejects.toThrow(EditorCoreDisposedError);
  });

  it("undoDocument desfaz a última transação e redoDocument refaz", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      expect(core.undoStateOf(handle)).toMatchObject({ canUndo: false, canRedo: false, revision: 1 });

      await core.insertText(handle, 3, "d", "user");
      expect(core.documentText(handle)).toBe("abcd");
      expect(core.undoStateOf(handle).canUndo).toBe(true);

      const undone = await core.undoDocument(handle);
      expect(core.documentText(handle)).toBe("abc");
      expect(undone.canUndo).toBe(false);
      expect(undone.canRedo).toBe(true);
      expect(undone.revision).toBe(core.revisionOf(handle));
      expect(Number.isInteger(undone.caret)).toBe(true);

      const redone = await core.redoDocument(handle);
      expect(core.documentText(handle)).toBe("abcd");
      expect(redone.canUndo).toBe(true);
      expect(redone.canRedo).toBe(false);
    } finally {
      core.dispose();
    }
  });

  it("undo/redo com handle inválido lança erro alto", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    try {
      await core.openDocument("/doc.txt");
      const bad = 7 as DocumentHandle;
      await expect(core.undoDocument(bad)).rejects.toThrow(InvalidDocumentHandleError);
      await expect(core.redoDocument(bad)).rejects.toThrow(InvalidDocumentHandleError);
      expect(() => core.undoStateOf(bad)).toThrow(InvalidDocumentHandleError);
    } finally {
      core.dispose();
    }
  });

  it("openDocument com signal já abortado lança CancellationError sem abrir", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    try {
      const controller = new AbortController();
      controller.abort("teste");
      await expect(core.openDocument("/doc.txt", controller.signal)).rejects.toThrow(
        "cancelada",
      );
    } finally {
      core.dispose();
    }
  });
});
