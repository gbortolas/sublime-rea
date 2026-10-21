/**
 * Scribe — testes do parser de snippets (P4#18): sintaxe estilo TextMate implementada de
 * forma clean-room.
 *
 * Cobrem aninhamento com `}` balanceado, escape `\}`, escolhas, transformações com capturas,
 * `$$`, `$0`, identificador desconhecido como literal, espelhos **renderizados na expansão
 * inicial** (o comportamento antigo deixava vazio) e a degradação com 1 `console.warn` quando a
 * regex da transformação é inválida. Puro, sem DOM.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { findSnippet, parseSnippet } from "../src/renderer/snippets";
import type { SnippetOccurrence } from "../src/renderer/snippets";

/** Primária de um índice (a região editável). */
function primary(occurrences: readonly SnippetOccurrence[], index: number): SnippetOccurrence {
  const found = occurrences.find((o) => o.index === index && o.isPrimary);
  if (found === undefined) throw new Error(`sem primária para o índice ${index}`);
  return found;
}

/** Espelhos de um índice (ocorrências derivadas), na ordem do documento. */
function mirrors(occurrences: readonly SnippetOccurrence[], index: number): SnippetOccurrence[] {
  return occurrences.filter((o) => o.index === index && !o.isPrimary);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseSnippet — sintaxe básica", () => {
  it("$$ vira $ literal e $1 solto vira tabstop sem conteúdo", () => {
    const { text, tabStops } = parseSnippet("$$ e $1");
    expect(text).toBe("$ e ");
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]).toMatchObject({ index: 1, start: 4, end: 4, defaultValue: "" });
  });

  it("aceita ${N} e índices multi-dígito ($10 / ${10:x})", () => {
    const expansion = parseSnippet("$10 ${10:x} ${12}");
    expect(expansion.text).toBe("x x ");
    expect(expansion.visitOrder).toEqual([10, 12]);
    // A primária do 10 é a ocorrência COM default (a segunda); a primeira fica como espelho.
    expect(primary(expansion.occurrences, 10)).toMatchObject({ start: 2, end: 3, defaultValue: "x" });
    expect(mirrors(expansion.occurrences, 10)).toHaveLength(1);
  });

  it("${N:default} coloca o default no texto e no tabstop", () => {
    const { text, tabStops } = parseSnippet("if (${1:condition})");
    expect(text).toBe("if (condition)");
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]).toMatchObject({ index: 1, start: 4, end: 13, defaultValue: "condition" });
  });

  it("$0 entra na ordem de visita, por último", () => {
    const { visitOrder, tabStops } = parseSnippet("console.log($1);$0");
    expect(visitOrder).toEqual([1, 0]);
    expect(tabStops[tabStops.length - 1]!.index).toBe(0);
  });

  it("${foo} e $foo são texto literal (sem variáveis TM)", () => {
    expect(parseSnippet("${foo} $foo ${foo:bar}").text).toBe("${foo} $foo ${foo:bar}");
  });

  it("chaves literais dentro do default não fecham o placeholder", () => {
    expect(parseSnippet("${1:if { x } y}").text).toBe("if { x } y");
  });
});

describe("parseSnippet — aninhamento e escapes", () => {
  it("balanceia } de placeholder aninhado (${1:aaa ${2:bbb} ccc})", () => {
    const expansion = parseSnippet("${1:aaa ${2:bbb} ccc}");
    expect(expansion.text).toBe("aaa bbb ccc");
    expect(expansion.visitOrder).toEqual([1, 2]);
    expect(primary(expansion.occurrences, 1)).toMatchObject({ start: 0, end: 11 });
    expect(primary(expansion.occurrences, 2)).toMatchObject({ start: 4, end: 7 });
    // A primária 2 é estruturalmente filha da primária 1 (aninhamento real, não sobreposição).
    expect(primary(expansion.occurrences, 2).parentId).toBe(primary(expansion.occurrences, 1).id);
  });

  it("\\} dentro do placeholder escapa o fechamento", () => {
    const expansion = parseSnippet("${1:a\\} b}");
    expect(expansion.text).toBe("a} b");
    expect(expansion.tabStops[0]).toMatchObject({ start: 0, end: 4, defaultValue: "a} b" });
  });

  it("$$ dentro de default vira $ literal", () => {
    expect(parseSnippet("${1:a$$b}").text).toBe("a$b");
  });

  it("sem } de fechamento o $ é literal", () => {
    expect(parseSnippet("x ${1 y").text).toBe("x ${1 y");
  });
});

describe("parseSnippet — escolhas e transformações", () => {
  it("escolha ${1|a,b,c|} usa a primeira opção como default", () => {
    const expansion = parseSnippet("go ${1|a,b,c|}");
    expect(expansion.text).toBe("go a");
    expect(expansion.tabStops[0]).toMatchObject({ index: 1, start: 3, end: 4, defaultValue: "a" });
  });

  it("transform com captura ${1/(.*)/$1/} espelha o valor da primária", () => {
    const expansion = parseSnippet("${1:abc} ${1/(.*)/$1/}");
    expect(expansion.text).toBe("abc abc");
    const mirror = mirrors(expansion.occurrences, 1)[0];
    expect(mirror).toBeDefined();
    expect(mirror!.transform).toMatchObject({ regex: "(.*)", format: "$1", flags: "" });
  });

  it("transform com formato e flags: ${1:Foo} ${1/^(.*)$/<$1>/i}", () => {
    const expansion = parseSnippet("${1:Foo} ${1/^(.*)$/<$1>/i}");
    expect(expansion.text).toBe("Foo <Foo>");
    expect(mirrors(expansion.occurrences, 1)[0]!.transform).toMatchObject({ flags: "i" });
  });

  it("separa regex/format/flags nos primeiros dois / não-escapados (\\/ não delimita)", () => {
    const expansion = parseSnippet("${1:a/b} ${1/(a\\/b)/[$1]/}");
    expect(expansion.text).toBe("a/b [a/b]");
    expect(mirrors(expansion.occurrences, 1)[0]!.transform).toMatchObject({ regex: "(a/b)" });
  });

  it("regex inválida degrada para ocorrência simples com exatamente 1 console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const expansion = parseSnippet("${1:abc} ${1/(unclosed/$1/}");
    expect(warn).toHaveBeenCalledTimes(1);
    // Degrada para espelho simples (sem transform): renderiza o valor da primária.
    expect(expansion.text).toBe("abc abc");
    const mirror = mirrors(expansion.occurrences, 1)[0];
    expect(mirror?.transform).toBeUndefined();
  });

  it("transform malformada (menos de 2 barras) também degrada com 1 aviso", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const expansion = parseSnippet("${1:abc} ${1/foo}");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(expansion.text).toBe("abc abc");
  });
});

describe("parseSnippet — espelhos e ordem de visita", () => {
  it("renderiza os espelhos na expansão inicial (antes saíam vazios)", () => {
    const snippet = findSnippet("for");
    expect(snippet).toBeDefined();
    const expansion = parseSnippet(snippet!.template);
    expect(expansion.text).toBe("for (let i = 0; i < ; i++) {\n  \n}");
    expect(expansion.visitOrder).toEqual([1, 2, 0]);
    // 3 ocorrências do índice 1 (1 primária + 2 espelhos) + 1 do 2 + 1 do 0.
    expect(expansion.occurrences.filter((o) => o.index === 1)).toHaveLength(3);
    expect(mirrors(expansion.occurrences, 1).map((o) => o.defaultValue)).toEqual(["i", "i"]);
  });

  it("tabStops contém só as primárias, na ordem de visita (asc, $0 no fim)", () => {
    const expansion = parseSnippet("${2:b} $1 ${1:x} $0 ${2:c}");
    // Primária do 1 é a ocorrência com default; do 2, a primeira (nenhuma tem default).
    expect(expansion.tabStops.map((t) => t.index)).toEqual([1, 2, 0]);
    expect(expansion.tabStops.map((t) => t.defaultValue)).toEqual(["x", "b", ""]);
    expect(expansion.occurrences.filter((o) => !o.isPrimary).map((o) => o.index)).toEqual([1, 2]);
  });

  it("primeira ocorrência com default é a primária; sem default, a primeira ocorrência", () => {
    const expansion = parseSnippet("$1 ${1:x}");
    // text: o $1 solto (antes da primária) já sai renderizado com o valor dela.
    expect(expansion.text).toBe("x x");
    const [first, second] = expansion.occurrences.filter((o) => o.index === 1);
    expect(first!.isPrimary).toBe(false);
    expect(first).toMatchObject({ start: 0, end: 1, defaultValue: "x" });
    expect(second!.isPrimary).toBe(true);
    expect(second).toMatchObject({ start: 2, end: 3, defaultValue: "x" });
    expect(expansion.tabStops[0]).toBe(second);
  });

  it("template sem nenhum tabstop devolve texto liso e listas vazias", () => {
    const expansion = parseSnippet("plain text");
    expect(expansion).toMatchObject({ text: "plain text", visitOrder: [] });
    expect(expansion.occurrences).toHaveLength(0);
    expect(expansion.tabStops).toHaveLength(0);
  });
});