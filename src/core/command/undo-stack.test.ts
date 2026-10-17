/**
 * Testes de `UndoStack` — delta inverso + transação (DEC-TR-3), grupos, glue, soft e profundidade.
 */
import { describe, expect, it } from "vitest";
import { UndoStack } from "./undo-stack";
import { FakeTarget } from "./__tests__/fakes";

describe("UndoStack — roundtrip undo/redo", () => {
  it("desfaz e refaz transações com o inverso do delta", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    stack.record("Insert A", [{ at: 0, remove: "", insert: "a" }], {
      caretBefore: 0,
      caretAfter: 1,
    });
    stack.record("Insert B", [{ at: 1, remove: "", insert: "b" }], {
      caretBefore: 1,
      caretAfter: 2,
    });

    stack.applyTo(target);
    expect(target.text).toBe("ab");

    expect(stack.undo(target)).toBe(true);
    expect(target.text).toBe("a");
    expect(target.caret()).toBe(1);

    expect(stack.undo(target)).toBe(true);
    expect(target.text).toBe("");
    expect(target.caret()).toBe(0);

    expect(stack.undo(target)).toBe(false);

    expect(stack.redo(target)).toBe(true);
    expect(target.text).toBe("a");

    expect(stack.redo(target)).toBe(true);
    expect(target.text).toBe("ab");
    expect(stack.redo(target)).toBe(false);
  });

  it("aplica uma transação com múltiplos deltas e a inverte por inteiro", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    target.text = "hello world";
    // Substitui "world" por "there": um único delta.
    stack.record("Replace", [{ at: 6, remove: "world", insert: "there" }], {
      caretBefore: 6,
      caretAfter: 11,
    });
    stack.applyTo(target);
    expect(target.text).toBe("hello there");

    stack.undo(target);
    expect(target.text).toBe("hello world");
  });
});

describe("UndoStack — agrupamento", () => {
  it("funde entradas consecutivas do mesmo grupo num único passo", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    for (let i = 0; i < 10; i += 1) {
      stack.record("Insert Characters", [{ at: i, remove: "", insert: String(i) }], {
        groupId: "typing.42",
        caretBefore: i,
        caretAfter: i + 1,
      });
    }

    expect(stack.undoDepth).toBe(1);
    expect(stack.lastLabel).toBe("Insert Characters");

    stack.applyTo(target);
    expect(target.text).toBe("0123456789");
    stack.undo(target);
    expect(target.text).toBe("");
  });

  it("não funde grupos diferentes", () => {
    const stack = new UndoStack();
    stack.record("A", [{ at: 0, remove: "", insert: "a" }], { groupId: "g1" });
    stack.record("B", [{ at: 1, remove: "", insert: "b" }], { groupId: "g2" });
    expect(stack.undoDepth).toBe(2);
  });

  it("registrar depois de desfazer interrompe a fusão e descarta o redo", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    stack.record("A", [{ at: 0, remove: "", insert: "a" }], { groupId: "g" });
    stack.applyTo(target);
    stack.undo(target);
    expect(stack.redoDepth).toBe(1);

    stack.record("A2", [{ at: 0, remove: "", insert: "z" }], { groupId: "g" });
    expect(stack.redoDepth).toBe(0);
    // O passo desfeito foi descartado junto com o redo: resta só a nova edição.
    expect(stack.undoDepth).toBe(1);
  });
});

describe("UndoStack — glue e soft", () => {
  it("funde grupos marcados num único passo", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    stack.record("A", [{ at: 0, remove: "", insert: "a" }], { groupId: "g1" });
    stack.markForGlue();
    stack.record("B", [{ at: 1, remove: "", insert: "b" }], { groupId: "g2" });
    stack.markForGlue();

    expect(stack.undoDepth).toBe(2);
    expect(stack.glueMarkedGroups()).toBe(true);
    expect(stack.undoDepth).toBe(1);
    expect(stack.lastLabel).toBe("B");

    stack.applyTo(target);
    expect(target.text).toBe("ab");
    stack.undo(target);
    expect(target.text).toBe("");
  });

  it("glue sem nada marcado é no-op", () => {
    const stack = new UndoStack();
    stack.record("A", [{ at: 0, remove: "", insert: "a" }]);
    expect(stack.glueMarkedGroups()).toBe(false);
    expect(stack.undoDepth).toBe(1);
  });

  it("soft undo/redo movem o cursor sem alterar o texto e registram intenção", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    stack.record("Insert", [{ at: 0, remove: "", insert: "abc" }], {
      caretBefore: 0,
      caretAfter: 3,
    });
    stack.applyTo(target);
    expect(target.text).toBe("abc");
    expect(target.caret()).toBe(3);

    expect(stack.softUndo(target)).toBe(true);
    expect(target.caret()).toBe(0);
    expect(target.text).toBe("abc");
    expect(stack.softIntent).toBe("undo");

    stack.undo(target);
    expect(target.text).toBe("");
    expect(stack.softIntent).toBeUndefined();

    expect(stack.softRedo(target)).toBe(true);
    expect(target.caret()).toBe(3);
    expect(target.text).toBe("");
    expect(stack.softIntent).toBe("redo");

    expect(stack.softRedo(target)).toBe(true);
    // o passo está no redo: não há mais undo para "espiar" no cursor.
    expect(stack.softUndo(target)).toBe(false);
  });

  it("soft undo/redo sem histórico são no-op", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();
    expect(stack.softUndo(target)).toBe(false);
    expect(stack.softRedo(target)).toBe(false);
  });
});

describe("UndoStack — profundidade e higiene", () => {
  it("trunca o passo mais antigo ao exceder maxDepth", () => {
    const stack = new UndoStack({ maxDepth: 2 });
    stack.record("A", [{ at: 0, remove: "", insert: "a" }]);
    stack.record("B", [{ at: 1, remove: "", insert: "b" }]);
    stack.record("C", [{ at: 2, remove: "", insert: "c" }]);

    expect(stack.undoDepth).toBe(2);
    expect(stack.lastLabel).toBe("C");
  });

  it("maxDepth inválido é erro alto", () => {
    expect(() => new UndoStack({ maxDepth: 0 })).toThrow(RangeError);
  });

  it("transação vazia não vira passo e clear zera tudo", () => {
    const stack = new UndoStack();
    stack.record("noop", []);
    expect(stack.undoDepth).toBe(0);

    stack.record("A", [{ at: 0, remove: "", insert: "a" }]);
    stack.clear();
    expect(stack.undoDepth).toBe(0);
    expect(stack.redoDepth).toBe(0);
    expect(stack.lastLabel).toBeUndefined();
  });
});
