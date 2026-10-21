/**
 * Scribe — testes da sessão de snippet (P4#18): ordem de visita (asc + `$0` no fim),
 * avanço/retrocesso/fim, seleção da parada e `applyEdit` (deslocamento de offsets, espelhos
 * simples e com transform, atualização de ancestrais no aninhamento e fim da sessão).
 *
 * Módulo puro — sem DOM/IPC: a sessão devolve os `updates` e o chamador do renderer é quem
 * aplica via ponte.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSnippet } from "../src/renderer/snippets";
import {
  applyEdit,
  chooseSnippetOption,
  createSnippetSession,
  currentChoice,
  currentStop,
  nextTabStop,
  previousTabStop,
  renderTransform,
  sessionRange,
} from "../src/renderer/snippet-session";
import type { SnippetSession } from "../src/renderer/snippet-session";

/** Monta uma sessão a partir do template, com `base` absoluta (default 0). */
function session(template: string, base = 0): SnippetSession {
  return createSnippetSession(parseSnippet(template), base);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessão de snippet — criação e navegação", () => {
  it("cria a sessão com ranges absolutos, fim = base + text.length e parada atual na 0", () => {
    const s = session("${1:x} $1 $0", 100);
    expect(s.base).toBe(100);
    expect(s.text).toBe("x x ");
    expect(s.end).toBe(100 + s.text.length);
    expect(s.current).toBe(0);
    expect(s.updates).toEqual([]);
    expect(s.fields.map((f) => [f.index, f.start, f.end])).toEqual([
      [1, 100, 101],  // primária
      [1, 102, 103],  // espelho
      [0, 104, 104],  // $0 (zero-width)
    ]);
    expect(currentStop(s)).toEqual({ index: 1, start: 100, end: 101 });
    expect(sessionRange(s)).toEqual({ start: 100, end: s.end });
  });

  it("visita em ordem ascendente com $0 por último e termina a sessão ao chegar nele", () => {
    const s = session("${1:a} ${2:b} $0");
    expect(s.visitOrder).toEqual([1, 2, 0]);

    const first = nextTabStop(s);
    expect(first).not.toBeNull();
    expect(first!.stop).toEqual({ index: 2, start: 2, end: 3 });
    expect(first!.session.current).toBe(1);
    expect(currentStop(first!.session)).toEqual(first!.stop);

    // Próximo alvo é $0 → fim da sessão (retorna null); o campo $0 fica consultável.
    expect(nextTabStop(first!.session)).toBeNull();
    const zero = first!.session.fields.find((f) => f.index === 0);
    expect(zero).toMatchObject({ start: 4, end: 4 });
  });

  it("sem $0, avançar depois da última parada também encerra (null)", () => {
    const s = session("${1:a} ${2:b}");
    const second = nextTabStop(s)!;
    expect(second.stop.index).toBe(2);
    expect(nextTabStop(second.session)).toBeNull();
  });

  it("previousTabStop retrocede; na primeira parada encerra (null)", () => {
    const s = session("${1:a} ${2:b} ${3:c}");
    const second = nextTabStop(s)!;
    const back = previousTabStop(second.session);
    expect(back).not.toBeNull();
    expect(back!.stop.index).toBe(1);
    expect(back!.session.current).toBe(0);
    expect(previousTabStop(back!.session)).toBeNull();
  });

  it("sem tabstops navegáveis a sessão não tem parada atual", () => {
    const s = session("plain");
    expect(s.visitOrder).toEqual([]);
    expect(currentStop(s)).toBeNull();
    expect(nextTabStop(s)).toBeNull();
  });
});

describe("sessão de snippet — applyEdit desloca offsets", () => {
  it("edição fora da expansão encerra a sessão (antes e depois)", () => {
    const s = session("${1:x} tail");
    expect(applyEdit(s, { start: -2, end: 0 }, "y")).toBeNull();
    expect(applyEdit(s, { start: s.end + 1, end: s.end + 2 }, "y")).toBeNull();
  });

  it("inserção dentro do texto da expansão (fora dos campos) só desloca os campos seguintes", () => {
    const s = session("${1:x} tail ${2:y}");
    const next = applyEdit(s, { start: 2, end: 4 }, "ZZZ"); // dentro do texto, fora dos campos
    expect(next).not.toBeNull();
    expect(next!.text).toBe("x ZZZil y");
    expect(next!.updates).toEqual([]);
    // O campo seguinte desloca junto (+1).
    expect(next!.fields.find((f) => f.index === 2)).toMatchObject({ start: 8, end: 9 });
    expect(next!.end).toBe(9);
  });

  it("remoção dentro da primária encolhe o campo e re-renderiza o espelho", () => {
    const s = session("${1:abcdef} $1");
    const next = applyEdit(s, { start: 0, end: 2 }, "XY"); // substitui "ab"
    expect(next).not.toBeNull();
    expect(next!.text).toBe("XYcdef XYcdef");
    expect(next!.fields[0]).toMatchObject({ start: 0, end: 6 });
    expect(next!.end).toBe(13);
    // Espelho re-renderizado com o novo conteúdo da primária (offsets já deslocados).
    expect(next!.updates).toEqual([{ start: 7, end: 13, newText: "XYcdef" }]);
    expect(next!.fields[1]).toMatchObject({ start: 7, end: 13 });
  });

  it("campo zero-width aceita inserção no próprio ponto", () => {
    const s = session("$1 end");
    const next = applyEdit(s, { start: 0, end: 0 }, "hi");
    expect(next).not.toBeNull();
    expect(next!.text).toBe("hi end");
    expect(next!.fields[0]).toMatchObject({ start: 0, end: 2 });
    expect(next!.updates).toEqual([]);
  });

  it("edição que atravessa a fronteira de um campo encerra a sessão", () => {
    const s = session("${1:ab}${2:cd}");
    expect(applyEdit(s, { start: 1, end: 3 }, "X")).toBeNull();
    // ...e a que engole um campo inteiro também.
    expect(applyEdit(session("${1:ab} tail"), { start: 0, end: 4 }, "X")).toBeNull();
  });

  it("edição dentro de um espelho encerra a sessão (espelho é derivado)", () => {
    const s = session("${1:x} $1"); // espelho em [2,3]
    expect(applyEdit(s, { start: 2, end: 3 }, "z")).toBeNull();
  });
});

describe("sessão de snippet — espelhos ao vivo", () => {
  it("re-renderiza o espelho depois de editar a primária", () => {
    const s = session("${1:x} $1");
    const next = applyEdit(s, { start: 0, end: 1 }, "abc");
    expect(next).not.toBeNull();
    expect(next!.text).toBe("abc abc");
    expect(next!.updates).toEqual([{ start: 4, end: 5, newText: "abc" }]);
    expect(next!.end).toBe(7);
    // Campos já coerentes com o estado final (a ponte aplica `updates` na ordem dada).
    expect(next!.fields.map((f) => [f.start, f.end])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it("espelho com transform usa o regex/format/flags da própria ocorrência", () => {
    const s = session("${1:aa} ${1/(a+)/<$1>/}");
    expect(s.text).toBe("aa <aa>");
    const next = applyEdit(s, { start: 0, end: 2 }, "aaa");
    expect(next).not.toBeNull();
    expect(next!.updates).toEqual([{ start: 4, end: 8, newText: "<aaa>" }]);
    expect(next!.text).toBe("aaa <aaa>");
  });

  it("espelho cujo valor não mudou não gera roundtrip", () => {
    const s = session("${1:x} $1");
    const next = applyEdit(s, { start: 0, end: 1 }, "x"); // conteúdo idêntico
    expect(next).not.toBeNull();
    expect(next!.updates).toEqual([]);
  });
});

describe("sessão de snippet — aninhamento (ancestrais)", () => {
  it("edita o campo interno e atualiza os espelhos do índice interno e do ancestral", () => {
    // primária 1 = "pre in post" [0,11] contém a primária 2 "in" [4,6];
    // espelho de 1 em [14,25] e espelho de 2 em [26,28].
    const s = session("${1:pre ${2:in} post} - ${1} ${2}");
    expect(s.text).toBe("pre in post - pre in post in");

    const next = applyEdit(s, { start: 4, end: 6 }, "IN!");
    expect(next).not.toBeNull();

    // Ordem: primeiro os espelhos do índice editado (2), depois os do ancestral (1).
    expect(next!.updates).toEqual([
      { start: 27, end: 29, newText: "IN!" },
      { start: 15, end: 26, newText: "pre IN! post" },
    ]);
    // Estado final coerente: primária 1 e seus espelhos com o mesmo valor.
    expect(next!.text).toBe("pre IN! post - pre IN! post IN!");
    expect(next!.end).toBe(31);
    const prim1 = next!.fields.find((f) => f.index === 1 && f.isPrimary)!;
    expect(next!.text.slice(prim1.start, prim1.end)).toBe("pre IN! post");
  });

  it("só o ancestral do índice editado dispara atualização quando não há espelho interno", () => {
    const s = session("${1:pre ${2:in} post} - ${1}");
    const next = applyEdit(s, { start: 4, end: 5 }, "I"); // "in" → "In"
    expect(next).not.toBeNull();
    expect(next!.updates).toEqual([{ start: 14, end: 25, newText: "pre In post" }]);
    expect(next!.text).toBe("pre In post - pre In post");
  });
});

describe("sessão de snippet — escolhas (dropdown)", () => {
  it("a parada atual expõe as opções e a opção escolhida (1ª por default)", () => {
    const s = session("${1|a,b,c|}");
    expect(currentStop(s)).toMatchObject({
      index: 1,
      start: 0,
      end: 1,
      choices: ["a", "b", "c"],
      choiceIndex: 0,
    });
    expect(currentChoice(s)).toEqual({
      index: 1,
      choices: ["a", "b", "c"],
      selected: 0,
      start: 0,
      end: 1,
    });
  });

  it("parada sem escolha não tem estado de escolha", () => {
    expect(currentChoice(session("${1:x}"))).toBeNull();
    expect(currentStop(session("${1:x}"))?.choices).toBeUndefined();
  });

  it("escolher a 2ª opção troca o texto da tab stop e re-renderiza o espelho", () => {
    const s = session("${1|a,b|} $1");
    expect(s.text).toBe("a a");
    const next = chooseSnippetOption(s, 1, 1);
    expect(next).not.toBeNull();
    expect(next!.text).toBe("b b");
    // O espelho do índice 1 é re-renderizado com o texto escolhido.
    expect(next!.updates).toEqual([{ start: 2, end: 3, newText: "b" }]);
    // O campo primária continua coerente e a opção escolhida é registrada.
    expect(next!.fields[0]).toMatchObject({ start: 0, end: 1, choiceIndex: 1 });
    expect(currentChoice(next!)?.selected).toBe(1);
  });

  it("escolher uma opção mais longa desloca os offsets seguintes", () => {
    const s = session("${1|a,bbbb|} $1");
    const next = chooseSnippetOption(s, 1, 1);
    expect(next).not.toBeNull();
    expect(next!.text).toBe("bbbb bbbb");
    expect(next!.fields[0]).toMatchObject({ start: 0, end: 4 });
    expect(next!.fields[1]).toMatchObject({ start: 5, end: 9 });
    expect(next!.updates).toEqual([{ start: 5, end: 6, newText: "bbbb" }]);
    expect(next!.end).toBe(9);
  });

  it("escolher dentro de um ancestral mantém ancestrais e espelhos coerentes", () => {
    const s = session("${1:pre ${2|a,b|} post} - ${1} ${2}");
    expect(s.text).toBe("pre a post - pre a post a");
    const next = chooseSnippetOption(s, 2, 1);
    expect(next).not.toBeNull();
    // Primeiro o espelho do índice 2, depois o do ancestral (índice 1).
    expect(next!.updates).toEqual([
      { start: 24, end: 25, newText: "b" },
      { start: 13, end: 23, newText: "pre b post" },
    ]);
    expect(next!.text).toBe("pre b post - pre b post b");
    const prim1 = next!.fields.find((f) => f.index === 1 && f.isPrimary)!;
    expect(next!.text.slice(prim1.start, prim1.end)).toBe("pre b post");
  });

  it("a transformação do espelho continua valendo sobre o texto escolhido", () => {
    const s = session("${1|a,b|} ${1/(.*)/[$1]/}");
    expect(s.text).toBe("a [a]");
    const next = chooseSnippetOption(s, 1, 1);
    expect(next).not.toBeNull();
    expect(next!.updates).toEqual([{ start: 2, end: 5, newText: "[b]" }]);
    expect(next!.text).toBe("b [b]");
  });

  it("escolher em parada que não é escolha (ou índice inválido) devolve null", () => {
    const s = session("${1:x} ${2|a,b|}");
    expect(chooseSnippetOption(s, 1, 0)).toBeNull();  // parada 1 não é escolha
    expect(chooseSnippetOption(s, 2, 5)).toBeNull();  // opção inexistente
    expect(chooseSnippetOption(s, 9, 0)).toBeNull();  // índice inexistente
  });

  it("a sessão é imutável: escolher devolve uma sessão nova", () => {
    const s = session("${1|a,b|}");
    const next = chooseSnippetOption(s, 1, 1);
    expect(next).not.toBe(s);
    expect(s.text).toBe("a");
    expect(next!.text).toBe("b");
  });
});

describe("renderTransform (re-exportada pela sessão)", () => {
  it("substitui com captura ($1 / ${1}) e respeita flags", () => {
    expect(renderTransform("abc", "(.*)", "<$1>", "")).toBe("<abc>");
    expect(renderTransform("Foo", "^(.*)$", "<$1>", "i")).toBe("<Foo>");
    expect(renderTransform("abc", "b", "[$&]", "g")).toBe("a[b]c");
    expect(renderTransform("abc", "z", "[$1]", "")).toBe("abc"); // sem match → inalterado
  });

  it("grupo que não casou vira string vazia; $$ vira $", () => {
    expect(renderTransform("z", "(a)?z", "[$1]", "")).toBe("[]");
    expect(renderTransform("a", "a", "$$1", "")).toBe("$1");
  });

  it("regex inválida devolve o conteúdo bruto com 1 console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(renderTransform("raw", "(", "$1", "")).toBe("raw");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});