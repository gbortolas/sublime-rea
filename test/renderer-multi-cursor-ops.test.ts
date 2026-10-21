/**
 * Scribe — testes do **multi-cursor ao estilo VS Code** (P2#5): a matemática pura de
 * `src/renderer/multi-cursor-ops.ts`.
 *
 * O que este arquivo prova (sem DOM — o ambiente de teste é `node`):
 * - `findOccurrences` respeita os **limites de palavra** ("cat" não casa em "concatenar"),
 *   não devolve ocorrências **sobrepostas** e devolve `[]` para texto/termo vazios;
 * - `nextOccurrence` devolve a próxima ocorrência **depois** de um offset e faz **wrap**;
 * - `wordAt` devolve a palavra que **contém** o offset (inclusive com o cursor colado nela);
 * - `cursorAbove`/`cursorBelow` acrescentam um cursor na linha vizinha **preservando a
 *   coluna**, sem sair do documento (no limite, o conjunto não muda);
 * - `selectAllOccurrences` troca o conjunto pelas **todas** as ocorrências;
 * - `selectNextOccurrence` (Ctrl+D) **acrescenta** cursores e devolve `undefined` quando não
 *   há mais ocorrência.
 */
import { describe, expect, it } from "vitest";

import { DocumentLineSource } from "../src/renderer/main";
import {
  cursorAbove,
  cursorBelow,
  findOccurrences,
  nextOccurrence,
  selectAllOccurrences,
  selectNextOccurrence,
  wordAt,
} from "../src/renderer/multi-cursor-ops";
import type { SelectionSet } from "../src/shared";

describe("findOccurrences — limites de palavra", () => {
  it("acha as ocorrências isoladas e ignora as que estão dentro de outra palavra", () => {
    const text = "cat concatenar gato cat.";
    expect(findOccurrences(text, "cat")).toEqual([0, 20]);
  });

  it("não casa quando o termo é só um pedaço de uma palavra maior", () => {
    expect(findOccurrences("concatenar", "cat")).toEqual([]);
    expect(findOccurrences("catalog", "cat")).toEqual([]);
  });

  it("casa no início e no fim do texto", () => {
    expect(findOccurrences("cat", "cat")).toEqual([0]);
    expect(findOccurrences("cat", "cat")).toEqual([0]);
    const text = "cat e cat";
    expect(findOccurrences(text, "cat")).toEqual([0, 6]);
  });

  it("devolve [] para texto vazio ou termo vazio", () => {
    expect(findOccurrences("", "cat")).toEqual([]);
    expect(findOccurrences("cat", "")).toEqual([]);
  });

  it("as ocorrências não se sobrepõem", () => {
    // "aa" em "aaa": a ocorrência em 1 **se sobrepõe** à de 0 ⇒ só a de 0 vale.
    expect(findOccurrences("aaa", "aa", { wordBoundary: false })).toEqual([0]);
    // "aa" em "aaaa": as ocorrências de 0 e de 2 não se sobrepõem.
    expect(findOccurrences("aaaa", "aa", { wordBoundary: false })).toEqual([0, 2]);
  });

  it("a busca é case-sensitive por padrão (e case-insensitive sob pedido)", () => {
    expect(findOccurrences("Cat cat", "cat")).toEqual([4]);
    expect(findOccurrences("Cat cat", "cat", { caseSensitive: false })).toEqual([0, 4]);
  });
});

describe("nextOccurrence — a próxima e o wrap", () => {
  const offsets = [0, 10, 20];

  it("devolve a primeira ocorrência depois do offset", () => {
    expect(nextOccurrence(offsets, 0)).toBe(10);
    expect(nextOccurrence(offsets, 10)).toBe(20);
  });

  it("faz wrap: sem nenhuma depois, volta para a primeira", () => {
    expect(nextOccurrence(offsets, 20)).toBe(0);
    expect(nextOccurrence(offsets, 99)).toBe(0);
  });

  it("devolve undefined quando não há ocorrência nenhuma", () => {
    expect(nextOccurrence([], 0)).toBeUndefined();
  });
});

describe("wordAt — a palavra sob o cursor", () => {
  it("devolve a palavra que contém o offset", () => {
    expect(wordAt("um gato", 4)).toEqual({ start: 3, end: 7, text: "gato" });
  });

  it("com o cursor colado no fim da palavra, a palavra é a mesma", () => {
    expect(wordAt("um gato", 6)).toEqual({ start: 3, end: 7, text: "gato" });
  });

  it("sem palavra ali, devolve undefined", () => {
    // Entre dois espaços não há palavra nem antes nem depois.
    expect(wordAt("um  gato", 3)).toBeUndefined();
    expect(wordAt("", 0)).toBeUndefined();
  });
});

describe("cursorAbove/cursorBelow — o cursor vizinho", () => {
  const source = new DocumentLineSource("primeira\nsegunda\nterceira");

  it("acrescenta um cursor na linha de cima, preservando a coluna", () => {
    const selections: SelectionSet = [{ anchor: 12, active: 12 }]; // linha 1, coluna 3
    const next = cursorAbove(selections, source);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ anchor: 3, active: 3 }); // linha 0, coluna 3
    expect(next[1]).toEqual({ anchor: 12, active: 12 });
  });

  it("acrescenta um cursor na linha de baixo, preservando a coluna", () => {
    const selections: SelectionSet = [{ anchor: 3, active: 3 }]; // linha 0, coluna 3
    const next = cursorBelow(selections, source);
    expect(next[0]).toEqual({ anchor: 12, active: 12 }); // linha 1, coluna 3
  });

  it("no limite do documento o conjunto não muda", () => {
    const first: SelectionSet = [{ anchor: 0, active: 0 }];
    expect(cursorAbove(first, source)).toBe(first);
    const last: SelectionSet = [{ anchor: 20, active: 20 }];
    expect(cursorBelow(last, source)).toBe(last);
  });

  it("a coluna maior que a linha de destino é presa ao fim dela", () => {
    const short = new DocumentLineSource("abcdefgh\nxy");
    const selections: SelectionSet = [{ anchor: 5, active: 5 }]; // linha 0, coluna 5
    const next = cursorBelow(selections, short);
    // "xy" tem 2 colunas ⇒ a coluna 5 é presa ao fim da linha (offset 9 + 2).
    expect(next[0]).toEqual({ anchor: 11, active: 11 });
  });

  it("o cursor novo é o primário (entra no início do conjunto)", () => {
    const selections: SelectionSet = [{ anchor: 3, active: 3 }];
    const next = cursorBelow(selections, source);
    expect(next[0]?.active).toBe(12);
    expect(next[1]?.active).toBe(3);
  });
});

describe("selectAllOccurrences — todas as ocorrências viram seleções", () => {
  it("troca o conjunto pelas ocorrências do termo", () => {
    const text = "cat dog cat";
    const selections: SelectionSet = [{ anchor: 0, active: 0 }];
    expect(selectAllOccurrences(selections, text, "cat")).toEqual([
      { anchor: 0, active: 3 },
      { anchor: 8, active: 11 },
    ]);
  });

  it("a ocorrência que contém o cursor vira a primária", () => {
    const text = "cat dog cat";
    const selections: SelectionSet = [{ anchor: 9, active: 9 }];
    const next = selectAllOccurrences(selections, text, "cat");
    expect(next[0]).toEqual({ anchor: 8, active: 11 });
    expect(next).toHaveLength(2);
  });

  it("sem ocorrências, o conjunto não muda", () => {
    const selections: SelectionSet = [{ anchor: 0, active: 0 }];
    expect(selectAllOccurrences(selections, "gato", "cat")).toBe(selections);
  });
});

describe("selectNextOccurrence — o Ctrl+D", () => {
  it("1ª vez: a palavra sob o cursor vira a seleção primária", () => {
    const text = "cat dog cat";
    const next = selectNextOccurrence([{ anchor: 5, active: 5 }], text);
    expect(next).toEqual([{ anchor: 4, active: 7 }]);
  });

  it("vezes seguintes: a ocorrência seguinte é acrescentada e vira a primária", () => {
    const text = "cat dog cat";
    const first = selectNextOccurrence([{ anchor: 0, active: 0 }], text);
    expect(first).toEqual([{ anchor: 0, active: 3 }]);
    const second = selectNextOccurrence(first!, text);
    expect(second).toEqual([
      { anchor: 8, active: 11 },
      { anchor: 0, active: 3 },
    ]);
  });

  it("sem palavra sob o cursor, nada acontece", () => {
    // Entre dois espaços não há palavra: o Ctrl+D não tem o que acrescentar.
    expect(selectNextOccurrence([{ anchor: 4, active: 4 }], "cat  dog")).toBeUndefined();
  });

  it("os cursores extras (de um Ctrl+click) continuam vivos", () => {
    const text = "cat dog cat";
    const selections: SelectionSet = [
      { anchor: 0, active: 0 }, // primário (colapsado)
      { anchor: 9, active: 9 }, // cursor extra
    ];
    expect(selectNextOccurrence(selections, text)).toEqual([
      { anchor: 0, active: 3 }, // a palavra sob o cursor vira a seleção primária
      { anchor: 9, active: 9 }, // o extra continua
    ]);
  });

  it("sem mais ocorrências, devolve undefined (o conjunto continua como está)", () => {
    const text = "cat";
    const first = selectNextOccurrence([{ anchor: 0, active: 0 }], text);
    expect(first).toEqual([{ anchor: 0, active: 3 }]);
    expect(selectNextOccurrence(first!, text)).toBeUndefined();
  });

  it("o wrap não repete uma ocorrência já selecionada", () => {
    const text = "cat dog cat";
    // O cursor está na **última** ocorrência: o wrap volta para a primeira (ainda livre).
    const first = selectNextOccurrence([{ anchor: 9, active: 9 }], text);
    expect(first).toEqual([{ anchor: 8, active: 11 }]);
    const second = selectNextOccurrence(first!, text);
    expect(second).toEqual([
      { anchor: 0, active: 3 },
      { anchor: 8, active: 11 },
    ]);
    // Agora as duas ocorrências estão no conjunto: não há mais nada a acrescentar.
    expect(selectNextOccurrence(second!, text)).toBeUndefined();
  });
});
