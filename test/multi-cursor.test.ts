/**
 * Scribe — E2E do núcleo: **multi-cursor no undo/redo** (P2#5).
 *
 * O que este arquivo prova:
 * - `advanceSelections` (fonte única da regra de deslocamento de cursores) desloca `anchor` e
 *   `active` pela regra do contrato;
 * - um `batchInsert` com 2 entradas + 2 cursores é **1 passo** de undo: um `Ctrl+Z` desfaz as
 *   **duas** inserções **e** restaura os **2 cursores** nas posições originais;
 * - o `redo` traz as 2 inserções de volta **e** os 2 cursores de volta **avançados**.
 */
import { describe, expect, it } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { advanceSelections } from "../src/shared";
import type { SelectionSet } from "../src/shared";

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
    writeFile: async (_path: string, _data: string): Promise<void> => {
      // mock em memória
    },
  };
}

describe("advanceSelections — a regra de deslocamento dos cursores", () => {
  it("desloca o cursor que está depois do trecho editado", () => {
    const before: SelectionSet = [{ anchor: 7, active: 7 }];
    const after = advanceSelections(before, [{ at: 2, remove: "", insert: "abc" }]);
    expect(after).toEqual([{ anchor: 10, active: 10 }]);
    // O resultado é novo: a entrada não é tocada.
    expect(before).toEqual([{ anchor: 7, active: 7 }]);
  });

  it("cola o cursor no fim do texto inserido quando ele está no ponto da edição", () => {
    const before: SelectionSet = [{ anchor: 2, active: 2 }];
    const after = advanceSelections(before, [{ at: 2, remove: "", insert: "XY" }]);
    expect(after).toEqual([{ anchor: 4, active: 4 }]);
  });

  it("colapsa no fim do texto inserido a seleção que estava dentro do trecho removido", () => {
    const before: SelectionSet = [{ anchor: 2, active: 5 }];
    const after = advanceSelections(before, [{ at: 2, remove: "abc", insert: "Z" }]);
    expect(after).toEqual([{ anchor: 3, active: 3 }]);
  });

  it("aplica os edits cumulativamente, na ordem em que foram aplicados", () => {
    const before: SelectionSet = [
      { anchor: 2, active: 2 },
      { anchor: 5, active: 5 },
    ];
    const after = advanceSelections(before, [
      { at: 5, remove: "", insert: "X" },
      { at: 2, remove: "", insert: "Y" },
    ]);
    expect(after).toEqual([
      { anchor: 3, active: 3 },
      { anchor: 7, active: 7 },
    ]);
  });
});

describe("core — multi-cursor: 1 Ctrl+Z desfaz o lote inteiro e restaura os N cursores", () => {
  it("batchInsert com 2 entradas + 2 cursores: undo/redo fazem o round-trip", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc def" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      expect(core.documentText(handle)).toBe("abc def");

      // Dois cursores: um em 2, outro em 5. O lote entra em ordem **descendente** (o `at` de
      // cada entrada é absoluto no estado do buffer após as entradas anteriores).
      const cursors: SelectionSet = [
        { anchor: 2, active: 2 },
        { anchor: 5, active: 5 },
      ];
      const result = await core.batchInsert(
        handle,
        [
          { at: 5, text: "X" },
          { at: 2, text: "Y" },
        ],
        "user",
        cursors,
      );

      // As 2 inserções entraram.
      expect(core.documentText(handle)).toBe("abYc dXef");
      expect(result.canUndo).toBe(true);
      // Os cursores avançaram (o cursor de 2 ficou depois do "Y"; o de 5, depois do "X").
      expect(core.undoStateOf(handle).selections).toEqual([
        { anchor: 3, active: 3 },
        { anchor: 7, active: 7 },
      ]);

      // **1** Ctrl+Z desfaz **as duas** inserções (1 passo só) e restaura os 2 cursores.
      const undone = await core.undoDocument(handle);
      expect(core.documentText(handle)).toBe("abc def");
      expect(undone.selections).toHaveLength(2);
      expect(undone.selections).toEqual([
        { anchor: 2, active: 2 },
        { anchor: 5, active: 5 },
      ]);
      // 1 passo só: não há mais nada para desfazer.
      expect(core.undoStateOf(handle).canUndo).toBe(false);
      expect(core.undoStateOf(handle).canRedo).toBe(true);

      // O redo traz as 2 inserções de volta e os 2 cursores avançados.
      const redone = await core.redoDocument(handle);
      expect(core.documentText(handle)).toBe("abYc dXef");
      expect(redone.selections).toEqual([
        { anchor: 3, active: 3 },
        { anchor: 7, active: 7 },
      ]);
    } finally {
      core.dispose();
    }
  });

  it("insert com 1 cursor: o undo devolve o cursor à posição original e o redo o avança", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "abc" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      await core.insertText(handle, 1, "XY", "user", [{ anchor: 1, active: 1 }]);
      expect(core.documentText(handle)).toBe("aXYbc");

      const undone = await core.undoDocument(handle);
      expect(core.documentText(handle)).toBe("abc");
      expect(undone.selections).toEqual([{ anchor: 1, active: 1 }]);
      expect(undone.caret).toBe(1);

      const redone = await core.redoDocument(handle);
      expect(core.documentText(handle)).toBe("aXYbc");
      expect(redone.selections).toEqual([{ anchor: 3, active: 3 }]);
      expect(redone.caret).toBe(3);
    } finally {
      core.dispose();
    }
  });

  it("lote com 'remove' apaga em N cursores e o undo restaura o texto e os cursores", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/doc.txt": "aa bb aa" }),
      availableParallelism: 4,
    });
    try {
      const handle = await core.openDocument("/doc.txt");
      const cursors: SelectionSet = [
        { anchor: 0, active: 2 },
        { anchor: 6, active: 8 },
      ];
      await core.batchInsert(
        handle,
        [
          { at: 6, text: "", remove: "aa" },
          { at: 0, text: "", remove: "aa" },
        ],
        "user",
        cursors,
      );
      expect(core.documentText(handle)).toBe(" bb ");

      const undone = await core.undoDocument(handle);
      expect(core.documentText(handle)).toBe("aa bb aa");
      expect(undone.selections).toEqual([
        { anchor: 0, active: 2 },
        { anchor: 6, active: 8 },
      ]);
    } finally {
      core.dispose();
    }
  });
});
