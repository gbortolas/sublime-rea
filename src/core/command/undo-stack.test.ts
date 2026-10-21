/**
 * Testes de `UndoStack` — delta inverso + transação (DEC-TR-3), grupos, glue, soft e profundidade.
 */
import { describe, expect, it } from "vitest";
import { UndoStack } from "./undo-stack";
import { FakeTarget } from "./__tests__/fakes";

/**
 * Alvo **com escopo** — cada instância é um "documento" diferente. O `FakeTarget` não sabe seu
 * documento (escopo `undefined`); este sabe (o `scopeId` que o `EditorCore` expõe).
 */
class ScopedTarget extends FakeTarget {
  constructor(private readonly scope: string) {
    super();
  }

  scopeId(): string {
    return this.scope;
  }
}

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

describe("UndoStack — multi-cursor (conjunto de seleções)", () => {
  it("undo/redo restauram o conjunto de seleções, não só o caret", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    const before = [
      { anchor: 2, active: 2 },
      { anchor: 5, active: 5 },
    ];
    const after = [
      { anchor: 3, active: 3 },
      { anchor: 7, active: 7 },
    ];

    stack.record("Insert", [{ at: 5, remove: "", insert: "x" }], {
      caretBefore: 5,
      caretAfter: 7,
      selectionBefore: before[0]!,
      selectionAfter: after[0]!,
      selectionsBefore: before,
      selectionsAfter: after,
    });

    // O undo devolve os N cursores às posições originais (não colapsa para 1 cursor).
    target.setSelections(after);
    expect(stack.undo(target)).toBe(true);
    expect(target.selections()).toEqual(before);
    expect(target.caret()).toBe(5);

    // O redo devolve os N cursores avançados.
    expect(stack.redo(target)).toBe(true);
    expect(target.selections()).toEqual(after);
    expect(target.caret()).toBe(7);
  });

  it("sem 'selections' explícitas o passo assume o cursor único da seleção", () => {
    const stack = new UndoStack();
    const target = new FakeTarget();

    stack.record("Insert", [{ at: 0, remove: "", insert: "a" }], {
      caretBefore: 0,
      caretAfter: 1,
      selectionBefore: { anchor: 0, active: 0 },
      selectionAfter: { anchor: 1, active: 1 },
    });

    expect(stack.undo(target)).toBe(true);
    expect(target.selections()).toEqual([{ anchor: 0, active: 0 }]);
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

describe("UndoStack — escopo por documento (linha do tempo de cada aba)", () => {
  it("undo no escopo B desfaz o passo de B e preserva o de A", () => {
    const stack = new UndoStack();
    const a = new ScopedTarget("A");
    const b = new ScopedTarget("B");

    stack.record("Edit A", [{ at: 0, remove: "", insert: "aaa" }], { scopeId: "A" });
    stack.record("Edit B", [{ at: 0, remove: "", insert: "bbb" }], { scopeId: "B" });
    a.text = "aaa";
    b.text = "bbb";

    // A profundidade **por escopo** conta só o que é do documento.
    expect(stack.undoDepthFor("A")).toBe(1);
    expect(stack.undoDepthFor("B")).toBe(1);
    expect(stack.undoDepth).toBe(2); // global: os dois documentos

    expect(stack.undo(b)).toBe(true);
    expect(b.text).toBe("");
    expect(a.text).toBe("aaa"); // o buffer de A não foi tocado

    // O passo de A continua na pilha (não foi consumido pelo undo de B).
    expect(stack.undoDepthFor("A")).toBe(1);
    expect(stack.undoDepthFor("B")).toBe(0);
    expect(stack.undoDepth).toBe(1);
  });

  it("undo no escopo A pula o passo de B (não aplica os deltas de B no buffer de A)", () => {
    const stack = new UndoStack();
    const a = new ScopedTarget("A");
    const b = new ScopedTarget("B");

    stack.record("Edit A", [{ at: 0, remove: "", insert: "aaa" }], { scopeId: "A" });
    stack.record("Edit B", [{ at: 0, remove: "", insert: "bbb" }], { scopeId: "B" });
    a.text = "aaa";
    b.text = "bbb";

    // O topo global é o passo de B — mas o alvo é de A ⇒ o passo de B é **pulado**.
    expect(stack.undo(a)).toBe(true);
    expect(a.text).toBe(""); // ← só o inverso do passo de A foi aplicado
    expect(b.text).toBe("bbb");
    expect(stack.undoDepthFor("B")).toBe(1); // o passo de B ficou na pilha
  });

  it("redo refaz só o passo do escopo do alvo", () => {
    const stack = new UndoStack();
    const a = new ScopedTarget("A");
    const b = new ScopedTarget("B");

    stack.record("Edit A", [{ at: 0, remove: "", insert: "aaa" }], { scopeId: "A" });
    stack.record("Edit B", [{ at: 0, remove: "", insert: "bbb" }], { scopeId: "B" });
    a.text = "aaa";
    b.text = "bbb";

    stack.undo(a);
    stack.undo(b);
    expect(a.text).toBe("");
    expect(b.text).toBe("");
    expect(stack.redoDepthFor("A")).toBe(1);
    expect(stack.redoDepthFor("B")).toBe(1);

    expect(stack.redo(b)).toBe(true);
    expect(b.text).toBe("bbb");
    expect(a.text).toBe(""); // o redo de A não foi aplicado

    expect(stack.redo(a)).toBe(true);
    expect(a.text).toBe("aaa");
    expect(stack.redoDepthFor("A")).toBe(0);
    expect(stack.redoDepthFor("B")).toBe(0);
  });

  it("passos de escopos diferentes não fundem (nem no glue)", () => {
    const stack = new UndoStack();
    stack.record("A", [{ at: 0, remove: "", insert: "a" }], { groupId: "g", scopeId: "A" });
    stack.record("B", [{ at: 0, remove: "", insert: "b" }], { groupId: "g", scopeId: "B" });
    expect(stack.undoDepth).toBe(2);

    stack.markForGlueFor("A");
    stack.markForGlueFor("B");
    // Passos de escopos diferentes não se fundem (o passo fundido carregaria os deltas dos dois).
    expect(stack.glueMarkedGroups()).toBe(false);
    expect(stack.undoDepth).toBe(2);
  });

  it("o rótulo e a intenção de soft são lidos por escopo", () => {
    const stack = new UndoStack();
    const a = new ScopedTarget("A");

    stack.record("Edit A", [{ at: 0, remove: "", insert: "aaa" }], { scopeId: "A" });
    stack.record("Edit B", [{ at: 0, remove: "", insert: "bbb" }], { scopeId: "B" });

    expect(stack.lastLabelFor("A")).toBe("Edit A");
    expect(stack.lastLabelFor("B")).toBe("Edit B");
    expect(stack.lastLabel).toBe("Edit B"); // global: o topo da pilha

    expect(stack.softUndo(a)).toBe(true);
    expect(stack.softIntentFor("A")).toBe("undo");
    expect(stack.softIntentFor("B")).toBeUndefined();
    expect(stack.softIntent).toBe("undo"); // global: última intenção
  });

  it("um alvo sem escopo (undefined) só casa com passos sem escopo", () => {
    const stack = new UndoStack();
    const plain = new FakeTarget();

    stack.record("Edit A", [{ at: 0, remove: "", insert: "aaa" }], { scopeId: "A" });
    expect(stack.undo(plain)).toBe(false); // o passo é de A — o alvo sem escopo não o toca
    expect(stack.undoDepthFor("A")).toBe(1);

    stack.record("Sem escopo", [{ at: 0, remove: "", insert: "x" }]);
    expect(stack.undo(plain)).toBe(true);
    expect(stack.undoDepthFor("A")).toBe(1);
  });

  it("clearScope limpa um documento e preserva o outro", () => {
    const stack = new UndoStack();
    stack.record("Edit A", [{ at: 0, remove: "", insert: "a" }], { scopeId: "A" });
    stack.record("Edit B", [{ at: 0, remove: "", insert: "b" }], { scopeId: "B" });

    stack.clearScope("A");
    expect(stack.undoDepthFor("A")).toBe(0);
    expect(stack.undoDepthFor("B")).toBe(1);
  });
});
