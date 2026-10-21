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

import { findSnippet, parseSnippet, resolveSnippetVariables } from "../src/renderer/snippets";
import type { SnippetOccurrence, SnippetVariableContext } from "../src/renderer/snippets";

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

  it("escolha ${1|a,b,c|} carrega a lista de opções (3 opções, default = 1ª)", () => {
    const expansion = parseSnippet("go ${1|a,b,c|}");
    const stop = primary(expansion.occurrences, 1);
    expect(stop.choices).toEqual(["a", "b", "c"]);
    expect(stop.choiceIndex).toBe(0);
    // O texto inserido continua sendo a 1ª opção (compatibilidade).
    expect(expansion.text).toBe("go a");
    expect(stop.defaultValue).toBe("a");
  });

  it("o | interno escapa: ${1|a\\|b,c|} ⇒ 2 opções (a|b e c)", () => {
    const expansion = parseSnippet("${1|a\\|b,c|}");
    expect(primary(expansion.occurrences, 1).choices).toEqual(["a|b", "c"]);
    expect(expansion.text).toBe("a|b");
  });

  it("escolha com escape de vírgula: ${1|a\\,b,c|} ⇒ 2 opções", () => {
    const expansion = parseSnippet("${1|a\\,b,c|}");
    expect(primary(expansion.occurrences, 1).choices).toEqual(["a,b", "c"]);
  });

  it("escolha aninhada em default: ${1:pre ${2|a,b|} pos}", () => {
    const expansion = parseSnippet("${1:pre ${2|a,b|} pos}");
    expect(expansion.text).toBe("pre a pos");
    expect(primary(expansion.occurrences, 2).choices).toEqual(["a", "b"]);
    expect(primary(expansion.occurrences, 2).parentId).toBe(primary(expansion.occurrences, 1).id);
  });

  it("transform de uma escolha continua valendo sobre o texto escolhido", () => {
    const expansion = parseSnippet("${1|a,b|} ${1/(.*)/[$1]/}");
    expect(expansion.text).toBe("a [a]");
    const mirror = mirrors(expansion.occurrences, 1)[0]!;
    expect(mirror.transform).toMatchObject({ regex: "(.*)", format: "[$1]" });
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

describe("parseSnippet — variáveis TM", () => {
  const ctx: SnippetVariableContext = {
    fileName: "notes.md",
    fileNameBase: "notes",
    filePath: "/caminho/notas.md",
    directory: "/caminho",
    selectedText: "selecionado",
    currentLine: "linha atual",
    currentWord: "palavra",
    lineIndex: 42,
  };

  it("variável TM com contexto é resolvida ($NOME e ${NOME})", () => {
    expect(parseSnippet("$TM_FILENAME", ctx).text).toBe("notes.md");
    expect(parseSnippet("${TM_FILENAME}", ctx).text).toBe("notes.md");
    expect(parseSnippet("$TM_FILENAME_BASE", ctx).text).toBe("notes");
    expect(parseSnippet("$TM_DIRECTORY", ctx).text).toBe("/caminho");
    expect(parseSnippet("$TM_SELECTED_TEXT", ctx).text).toBe("selecionado");
    expect(parseSnippet("$TM_CURRENT_LINE", ctx).text).toBe("linha atual");
    expect(parseSnippet("$TM_CURRENT_WORD", ctx).text).toBe("palavra");
    expect(parseSnippet("$TM_LINE_INDEX", ctx).text).toBe("42");
  });

  it("variável TM sem contexto fica literal (não vira string vazia)", () => {
    expect(parseSnippet("$TM_FILENAME").text).toBe("$TM_FILENAME");
    expect(parseSnippet("${TM_FILENAME}").text).toBe("${TM_FILENAME}");
    expect(parseSnippet("$TM_SELECTED_TEXT").text).toBe("$TM_SELECTED_TEXT");
    expect(parseSnippet("$TM_LINE_INDEX").text).toBe("$TM_LINE_INDEX");
    // Contexto vazio = sem contexto.
    expect(parseSnippet("$TM_FILENAME", {}).text).toBe("$TM_FILENAME");
    // Seleção vazia conta como ausente.
    expect(parseSnippet("$TM_SELECTED_TEXT", { ...ctx, selectedText: "" }).text)
      .toBe("$TM_SELECTED_TEXT");
  });

  it("variável TM desconhecida fica literal", () => {
    expect(parseSnippet("$TM_DESCONHECIDA", ctx).text).toBe("$TM_DESCONHECIDA");
    expect(parseSnippet("${TM_DESCONHECIDA}", ctx).text).toBe("${TM_DESCONHECIDA}");
    expect(parseSnippet("${FOO}", ctx).text).toBe("${FOO}");
    expect(parseSnippet("$FOO", ctx).text).toBe("$FOO");
  });

  it("${TM_FILENAME:default} usa o valor; sem valor, usa o default", () => {
    expect(parseSnippet("${TM_FILENAME:default}", ctx).text).toBe("notes.md");
    expect(parseSnippet("${TM_FILENAME:default}").text).toBe("default");
    expect(parseSnippet("${TM_SELECTED_TEXT:x}", {}).text).toBe("x");
  });

  it("variável TM dentro do default de uma tab stop", () => {
    const expansion = parseSnippet("${1:arquivo $TM_FILENAME}", ctx);
    expect(expansion.text).toBe("arquivo notes.md");
    expect(expansion.tabStops[0]).toMatchObject({ start: 0, end: 16, defaultValue: "arquivo notes.md" });
  });

  it("variável resolvida não quebra os offsets das tab stops", () => {
    const expansion = parseSnippet("$TM_FILENAME: ${1:x}", ctx);
    expect(expansion.text).toBe("notes.md: x");
    expect(expansion.tabStops[0]).toMatchObject({ index: 1, start: 10, end: 11 });
  });

  it("filePath deriva fileName/directory quando não vêm explícitos", () => {
    const expansion = parseSnippet("$TM_FILENAME $TM_FILENAME_BASE $TM_DIRECTORY", {
      filePath: "/caminho/notas.md",
    });
    expect(expansion.text).toBe("notas.md notas /caminho");
  });

  it("$$ protege a variável seguinte (fica literal)", () => {
    expect(parseSnippet("$$TM_FILENAME", ctx).text).toBe("$TM_FILENAME");
  });
});

describe("resolveSnippetVariables (texto puro)", () => {
  const ctx: SnippetVariableContext = { fileName: "notes.md", lineIndex: 7 };

  it("substitui as formas $NOME, ${NOME} e ${NOME:default}", () => {
    expect(resolveSnippetVariables("a $TM_FILENAME b", ctx)).toBe("a notes.md b");
    expect(resolveSnippetVariables("a ${TM_FILENAME} b", ctx)).toBe("a notes.md b");
    expect(resolveSnippetVariables("a ${TM_FILENAME:def} b", ctx)).toBe("a notes.md b");
    expect(resolveSnippetVariables("a ${TM_LINE_INDEX:0} b", ctx)).toBe("a 7 b");
  });

  it("variável desconhecida ou sem valor fica literal", () => {
    expect(resolveSnippetVariables("$TM_X", ctx)).toBe("$TM_X");
    expect(resolveSnippetVariables("${TM_X}", ctx)).toBe("${TM_X}");
    expect(resolveSnippetVariables("$TM_SELECTED_TEXT", ctx)).toBe("$TM_SELECTED_TEXT");
  });

  it("não mexe em $N (tab stop) nem em texto comum", () => {
    expect(resolveSnippetVariables("$1 e $2", ctx)).toBe("$1 e $2");
    expect(resolveSnippetVariables("nada aqui", ctx)).toBe("nada aqui");
  });
});