/**
 * Scribe — E2E do undo **por documento**.
 *
 * A pilha de undo é global, mas **cada documento tem a sua própria linha do tempo**: desfazer na
 * aba B só desfaz o que foi feito na B. Antes do escopo por documento, o undo na aba B aplicava os
 * deltas da aba A **no buffer de B** (texto corrompido) — e o `canUndo`/`canRedo` de cada aba
 * refletia o total global, não o documento.
 */
import { describe, expect, it } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
    writeFile: async (_path: string, _data: string): Promise<void> => {
      // mock em memória — o teste só edita em memória.
    },
  };
}

const DOC_A = "/a.txt";
const DOC_B = "/b.txt";

describe("undo por documento (E2E do core)", () => {
  it("desfazer na aba B não toca a aba A (e vice-versa)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ [DOC_A]: "AAA", [DOC_B]: "BBB" }),
      availableParallelism: 4,
    });
    try {
      const a = await core.openDocument(DOC_A);
      const b = await core.openDocument(DOC_B);

      await core.insertText(a, 3, "-a", "user");
      await core.insertText(b, 3, "-b", "user");

      expect(core.documentText(a)).toBe("AAA-a");
      expect(core.documentText(b)).toBe("BBB-b");

      // Cada aba tem o **seu** passo de undo.
      expect(core.undoStateOf(a).canUndo).toBe(true);
      expect(core.undoStateOf(b).canUndo).toBe(true);
      expect(core.undoStateOf(a).canRedo).toBe(false);
      expect(core.undoStateOf(b).canRedo).toBe(false);

      // Desfazer na B: só o texto de B volta; o de A fica **intacto**.
      const afterUndoB = await core.undoDocument(b);
      expect(core.documentText(b)).toBe("BBB");
      expect(core.documentText(a)).toBe("AAA-a");
      // O buffer de B **não** recebeu os deltas de A (e vice-versa).
      expect(core.documentText(b)).not.toContain("-a");

      // `canUndo`/`canRedo` são do **documento**, não o total global.
      expect(afterUndoB.canUndo).toBe(false);
      expect(afterUndoB.canRedo).toBe(true);
      expect(core.undoStateOf(a).canUndo).toBe(true);
      expect(core.undoStateOf(a).canRedo).toBe(false);

      // Desfazer na A: agora sim, só a edição de A.
      const afterUndoA = await core.undoDocument(a);
      expect(core.documentText(a)).toBe("AAA");
      expect(core.documentText(b)).toBe("BBB");
      expect(afterUndoA.canUndo).toBe(false);
      expect(afterUndoA.canRedo).toBe(true);

      // Refazer na B refaz **a** edição de B (e não mexe em A).
      await core.redoDocument(b);
      expect(core.documentText(b)).toBe("BBB-b");
      expect(core.documentText(a)).toBe("AAA");
    } finally {
      core.dispose();
    }
  });

  it("desfazer na aba A não aplica os deltas da aba B no buffer de A", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ [DOC_A]: "AAA", [DOC_B]: "BBB" }),
      availableParallelism: 4,
    });
    try {
      const a = await core.openDocument(DOC_A);
      const b = await core.openDocument(DOC_B);

      await core.insertText(a, 3, "-a", "user");
      await core.insertText(b, 3, "-b", "user");

      // O topo da pilha **global** é o passo de B — mas o alvo é o documento A ⇒ o passo de B
      // é pulado (não aplicado, não consumido).
      await core.undoDocument(a);
      expect(core.documentText(a)).toBe("AAA");
      expect(core.documentText(b)).toBe("BBB-b");

      // O passo de B continua na pilha: a aba B ainda tem o que desfazer.
      expect(core.undoStateOf(b).canUndo).toBe(true);
      expect(core.undoStateOf(a).canUndo).toBe(false);
    } finally {
      core.dispose();
    }
  });

  it("o resultado do insert já traz o canUndo/canRedo do documento", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ [DOC_A]: "AAA", [DOC_B]: "BBB" }),
      availableParallelism: 4,
    });
    try {
      const a = await core.openDocument(DOC_A);
      const b = await core.openDocument(DOC_B);

      const first = await core.insertText(a, 3, "-a", "user");
      expect(first.canUndo).toBe(true);
      expect(first.canRedo).toBe(false);

      // O documento B ainda não tem passo nenhum — o total global não pode "vazar" para ele.
      const second = await core.insertText(b, 3, "-b", "user");
      expect(second.canUndo).toBe(true);
      expect(second.canRedo).toBe(false);

      await core.undoDocument(b);
      expect(core.undoStateOf(b).canUndo).toBe(false);
      expect(core.undoStateOf(b).canRedo).toBe(true);
      // A ainda tem o seu passo (o undo de B não o consumiu).
      expect(core.undoStateOf(a).canUndo).toBe(true);
      expect(core.undoStateOf(a).canRedo).toBe(false);
    } finally {
      core.dispose();
    }
  });
});
