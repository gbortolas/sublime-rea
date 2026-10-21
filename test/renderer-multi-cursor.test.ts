/**
 * Scribe — E2E do **renderer**: a matemática do multi-cursor (P2#5).
 *
 * O que este arquivo prova (a parte **pura** do renderer — o ambiente de teste não tem DOM):
 * - `buildTypingEdits` monta **1 edição por cursor**, em ordem **descendente** (a ordem que o
 *   `document.batchInsert` exige: o `at` de cada entrada é absoluto no buffer **após** as
 *   entradas anteriores);
 * - `applyEditsToText` (splice local) produz **o mesmo texto** que o core produziria;
 * - `advanceCursorSet` desloca os N cursores pela **mesma regra** do core
 *   (`advanceSelections`, de `src/shared`) e deixa o cursor do auto-pair **entre** os
 *   delimitadores;
 * - `buildDeleteEdits` apaga em N cursores (caractere, par vazio ou range selecionado) e
 *   omite o cursor que não tem nada a apagar;
 * - `buildKeyEdits` insere o par em todos os cursores e faz o cursor **pular** o fechamento
 *   que já existe;
 * - `clampSelections` prende o conjunto de cursores restaurados ao tamanho do texto.
 */
import { describe, expect, it } from "vitest";

import {
  advanceCursorSet,
  applyEditsToText,
  buildDeleteEdits,
  buildKeyEdits,
  buildTypingEdits,
  clampSelections,
} from "../src/renderer/main";
import { advanceSelections } from "../src/shared";
import type { SelectionSet } from "../src/shared";

const TWO_CURSORS: SelectionSet = [
  { anchor: 2, active: 2 },
  { anchor: 5, active: 5 },
];

describe("buildTypingEdits — 1 edição por cursor, ordem descendente", () => {
  it("uma edição por cursor, com o trecho selecionado como `remove`", () => {
    const edits = buildTypingEdits(TWO_CURSORS, "X", "abc def");
    expect(edits).toEqual([
      { at: 5, remove: "", insert: "X" },
      { at: 2, remove: "", insert: "X" },
    ]);
  });

  it("a ordem é descendente (o `at` de cada entrada continua válido no lote)", () => {
    const edits = buildTypingEdits(TWO_CURSORS, "X", "abc def");
    expect(edits.map((e) => e.at)).toEqual([5, 2]);
  });

  it("cursor com seleção expandida: a edição substitui o range selecionado", () => {
    const selections: SelectionSet = [
      { anchor: 0, active: 2 },
      { anchor: 5, active: 6 },
    ];
    const edits = buildTypingEdits(selections, "X", "abc def");
    expect(edits).toEqual([
      { at: 5, remove: "e", insert: "X" },
      { at: 0, remove: "ab", insert: "X" },
    ]);
  });
});

describe("applyEditsToText — o splice local bate com o lote do core", () => {
  it("2 cursores: o texto local é o mesmo que o core produz", () => {
    const source = "abc def";
    const edits = buildTypingEdits(TWO_CURSORS, "X", source);
    // O core aplica as entradas do lote na mesma ordem (descendente) — mesmo resultado.
    let core = source;
    for (const edit of edits) {
      core = core.slice(0, edit.at) + edit.insert + core.slice(edit.at + edit.remove.length);
    }
    expect(applyEditsToText(source, edits)).toBe(core);
    expect(applyEditsToText(source, edits)).toBe("abXc dXef");
  });

  it("2 keystrokes acumulados no mesmo lote: os offsets continuam válidos", () => {
    const source = "abc def";
    const first = buildTypingEdits(TWO_CURSORS, "X", source);
    const afterFirst = applyEditsToText(source, first);
    const advanced = advanceCursorSet(TWO_CURSORS, first, 0, []);
    const second = buildTypingEdits(advanced, "Y", afterFirst);
    // Lote = 1ª tecla + 2ª tecla, na ordem em que foram aplicadas localmente.
    const batch = [...first, ...second];
    let core = source;
    for (const edit of batch) {
      core = core.slice(0, edit.at) + edit.insert + core.slice(edit.at + edit.remove.length);
    }
    expect(applyEditsToText(source, batch)).toBe(core);
    expect(applyEditsToText(source, batch)).toBe("abXYc dXYef");
  });
});

describe("advanceCursorSet — os N cursores sobrevivem à edição", () => {
  it("desloca os cursores pela mesma regra do core (`advanceSelections`)", () => {
    const edits = buildTypingEdits(TWO_CURSORS, "X", "abc def");
    const advanced = advanceCursorSet(TWO_CURSORS, edits, 0, []);
    expect(advanced).toEqual(advanceSelections(TWO_CURSORS, edits));
    expect(advanced).toEqual([
      { anchor: 3, active: 3 },
      { anchor: 7, active: 7 },
    ]);
  });

  it("o cursor do auto-pair fica **entre** os delimitadores (`at + 1`)", () => {
    const source = "ab";
    const cursors: SelectionSet = [
      { anchor: 0, active: 0 },
      { anchor: 2, active: 2 },
    ];
    const { edits } = buildKeyEdits(cursors, "(", ")", source);
    const advanced = advanceCursorSet(cursors, edits, 1, []);
    expect(advanced).toEqual([
      { anchor: 1, active: 1 },
      { anchor: 5, active: 5 },
    ]);
  });

  it("cursor que pulou um fechamento existente avança 1", () => {
    const source = "()";
    const cursors: SelectionSet = [
      { anchor: 1, active: 1 },
      { anchor: 3, active: 3 },
    ];
    const { edits, skipped } = buildKeyEdits(cursors, ")", undefined, source);
    expect(edits).toEqual([{ at: 3, remove: "", insert: ")" }]);
    expect(skipped).toEqual([0]);
    const advanced = advanceCursorSet(cursors, edits, 0, skipped);
    expect(advanced).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 4, active: 4 },
    ]);
  });

  it("todos os cursores pulam: nenhum texto muda, os cursores andam 1", () => {
    const source = "()";
    const cursors: SelectionSet = [{ anchor: 1, active: 1 }];
    const { edits, skipped } = buildKeyEdits(cursors, ")", undefined, source);
    expect(edits).toEqual([]);
    expect(skipped).toEqual([0]);
    expect(advanceCursorSet(cursors, edits, 0, skipped)).toEqual([
      { anchor: 2, active: 2 },
    ]);
  });
});

describe("buildDeleteEdits — apagar em N cursores", () => {
  it("backward: apaga o caractere anterior em cada cursor", () => {
    const edits = buildDeleteEdits(TWO_CURSORS, "abc def", "backward");
    expect(edits).toEqual([
      { at: 4, remove: "d", insert: "" },
      { at: 1, remove: "b", insert: "" },
    ]);
  });

  it("backward: apaga o **par vazio** (como o caminho de 1 cursor)", () => {
    const cursors: SelectionSet = [{ anchor: 1, active: 1 }];
    const edits = buildDeleteEdits(cursors, "()", "backward");
    expect(edits).toEqual([{ at: 0, remove: "()", insert: "" }]);
  });

  it("forward: apaga o caractere seguinte em cada cursor", () => {
    const edits = buildDeleteEdits(TWO_CURSORS, "abc def", "forward");
    expect(edits).toEqual([
      { at: 5, remove: "e", insert: "" },
      { at: 2, remove: "c", insert: "" },
    ]);
  });

  it("cursor com seleção expandida: apaga o range selecionado", () => {
    const cursors: SelectionSet = [
      { anchor: 0, active: 2 },
      { anchor: 5, active: 6 },
    ];
    const edits = buildDeleteEdits(cursors, "abc def", "forward");
    expect(edits).toEqual([
      { at: 5, remove: "e", insert: "" },
      { at: 0, remove: "ab", insert: "" },
    ]);
  });

  it("cursor sem nada a apagar é omitido — o resto do conjunto continua vivo", () => {
    const cursors: SelectionSet = [
      { anchor: 0, active: 0 },
      { anchor: 3, active: 3 },
    ];
    const edits = buildDeleteEdits(cursors, "abc def", "backward");
    expect(edits).toEqual([{ at: 2, remove: "c", insert: "" }]);
  });
});

describe("clampSelections — o conjunto restaurado cabe no documento", () => {
  it("prende cada offset ao tamanho do texto", () => {
    const restored = clampSelections(
      [
        { anchor: 2, active: 2 },
        { anchor: 99, active: 120 },
      ],
      7,
    );
    expect(restored).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 7, active: 7 },
    ]);
  });

  it("conjunto ausente (preload antigo) ⇒ vazio (o renderer degrada para 1 cursor)", () => {
    expect(clampSelections(undefined, 7)).toEqual([]);
  });
});
