/**
 * Testes do motor de tokenização (`tokenizer.ts`) — spans da gramática de brinquedo do Scribe,
 * determinismo e o estado que atravessa linhas (strings multi-linha).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { GrammarDefinition, HighlightSpan, SyntaxGrammar } from "../../shared";
import { compileGrammar, normalizeGrammarDocument, type GrammarDefinitionResolver } from "./grammar";
import { parseYamlSubset } from "./yaml";
import { MAX_TOKENIZE_LINE_LENGTH, TOKENIZE_LIMIT_SCOPE } from "./tokenizer";

const FIXTURE = resolve(process.cwd(), "assets/grammars/scribe-demo.sublime-syntax");
const NO_INCLUDES: GrammarDefinitionResolver = { resolveDefinition: () => undefined };

function grammarOf(
  source: string,
  logicalName: string,
  resolver: GrammarDefinitionResolver = NO_INCLUDES,
): SyntaxGrammar {
  return compileGrammar(normalizeGrammarDocument(parseYamlSubset(source, logicalName), logicalName), resolver);
}

function demoGrammar(): SyntaxGrammar {
  const source = readFileSync(FIXTURE, "utf8");
  const definition = normalizeGrammarDocument(parseYamlSubset(source, "scribe-demo"), "scribe-demo");
  return compileGrammar(definition, NO_INCLUDES);
}

function spansOf(grammar: SyntaxGrammar, line: string): readonly HighlightSpan[] {
  return grammar.tokenizeLine(line, undefined).spans;
}

describe("tokenizer — gramática Scribe Demo", () => {
  const grammar = demoGrammar();

  it("casa comentário de linha, palavra-chave e número", () => {
    expect(spansOf(grammar, "const x = 1;")).toEqual([
      { start: 0, end: 5, scope: "keyword.control.demo" },
      { start: 5, end: 6, scope: "source.demo" },
      { start: 6, end: 7, scope: "variable.other.assignment.demo" },
      { start: 7, end: 8, scope: "meta.assignment.demo" },
      { start: 8, end: 9, scope: "keyword.operator.assignment.demo" },
      { start: 9, end: 10, scope: "source.demo" },
      { start: 10, end: 11, scope: "constant.numeric.demo" },
      { start: 11, end: 12, scope: "source.demo" },
    ]);
  });

  it("marca o comentário inteiro, inclusive o texto depois de //", () => {
    const spans = spansOf(grammar, "x // nada aqui");
    expect(spans[spans.length - 1]).toEqual({ start: 2, end: 14, scope: "comment.line.double-slash.demo" });
  });

  it("aplica escopo de string e de escapes dentro das aspas", () => {
    expect(spansOf(grammar, '"a\\nb"')).toEqual([
      { start: 0, end: 1, scope: "punctuation.definition.string.begin.demo" },
      { start: 1, end: 2, scope: "string.quoted.double.demo" },
      { start: 2, end: 4, scope: "constant.character.escape.demo" },
      { start: 4, end: 5, scope: "string.quoted.double.demo" },
      { start: 5, end: 6, scope: "punctuation.definition.string.end.demo" },
    ]);
  });

  it("preserva o estado entre linhas (string aberta continua na linha seguinte)", () => {
    const first = grammar.tokenizeLine('const s = "começo', undefined);
    expect(first.spans[first.spans.length - 1]).toEqual({
      start: 11,
      end: 17,
      scope: "string.quoted.double.demo",
    });
    const second = grammar.tokenizeLine('fim";', first.state);
    expect(second.spans).toEqual([
      { start: 0, end: 3, scope: "string.quoted.double.demo" },
      { start: 3, end: 4, scope: "punctuation.definition.string.end.demo" },
      { start: 4, end: 5, scope: "source.demo" },
    ]);
    const third = grammar.tokenizeLine("const y = 2;", second.state);
    expect(third.spans[0]).toEqual({ start: 0, end: 5, scope: "keyword.control.demo" });
  });

  it("respeita a ordem: comentário antes de string", () => {
    expect(spansOf(grammar, "// \"não é string\"")).toEqual([
      { start: 0, end: 17, scope: "comment.line.double-slash.demo" },
    ]);
  });

  it("cobre a linha inteira com spans não sobrepostos e ordenados", () => {
    const spans = spansOf(grammar, 'let nome = "valor"; // fim');
    let cursor = 0;
    for (const span of spans) {
      expect(span.start).toBe(cursor);
      expect(span.end).toBeGreaterThan(span.start);
      cursor = span.end;
    }
    expect(cursor).toBe('let nome = "valor"; // fim'.length);
  });

  it("é determinístico para a mesma entrada", () => {
    const line = 'if x = "y" { }';
    expect(grammar.tokenizeLine(line, undefined)).toEqual(grammar.tokenizeLine(line, undefined));
  });
});

describe("tokenizer — regras de segurança", () => {
  it("ignora casamento de comprimento zero (evita laço infinito)", () => {
    const definition = normalizeGrammarDocument(
      parseYamlSubset(
        [
          "name: Zero",
          "scope: source.zero",
          "contexts:",
          "  main:",
          "    - match: 'a*'",
          "      scope: keyword.zero",
          "",
        ].join("\n"),
        "Zero",
      ),
      "Zero",
    );
    const grammar = compileGrammar(definition, NO_INCLUDES);
    expect(spansOf(grammar, "b")).toEqual([{ start: 0, end: 1, scope: "source.zero" }]);
    expect(spansOf(grammar, "aa")).toEqual([{ start: 0, end: 2, scope: "keyword.zero" }]);
  });

  it("estado de tokenização inválido lança erro tipado", () => {
    const grammar = demoGrammar();
    expect(() => grammar.tokenizeLine("x", { stack: [1] })).toThrow(/estado de tokenização inválido/);
  });
});

describe("tokenizer — teto de insumo da linha", () => {
  /** Gramática própria por teste: o aviso do teto é **único por instância** de gramática. */
  function capGrammar(name: string): SyntaxGrammar {
    return grammarOf(
      ["name: Cap", "scope: source.cap", "contexts:", "  main:", "    - match: 'const'", "      scope: keyword.cap", ""].join("\n"),
      name,
    );
  }

  it("tokeniza só o prefixo e marca a cauda com o escopo de limite (explícito, sem buraco)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const grammar = capGrammar("CapPrefix");
      const line = `const ${"a".repeat(MAX_TOKENIZE_LINE_LENGTH)}`;
      const { spans } = grammar.tokenizeLine(line, undefined);

      expect(spans[0]).toEqual({ start: 0, end: 5, scope: "keyword.cap" });
      let cursor = 0;
      for (const span of spans) {
        expect(span.start).toBe(cursor);
        cursor = span.end;
      }
      expect(cursor).toBe(line.length);
      const last = spans[spans.length - 1];
      expect(last).toEqual({
        start: MAX_TOKENIZE_LINE_LENGTH,
        end: line.length,
        scope: TOKENIZE_LIMIT_SCOPE,
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("linha no teto exato não degrada", () => {
    const grammar = capGrammar("CapExact");
    const line = "a".repeat(MAX_TOKENIZE_LINE_LENGTH);
    expect(spansOf(grammar, line)).toEqual([
      { start: 0, end: MAX_TOKENIZE_LINE_LENGTH, scope: "source.cap" },
    ]);
  });

  it("avisa uma vez por gramática, não a cada linha acima do teto", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const grammar = capGrammar("CapOnce");
      const line = "b".repeat(MAX_TOKENIZE_LINE_LENGTH + 1);
      grammar.tokenizeLine(line, undefined);
      grammar.tokenizeLine(line, undefined);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("o aviso é por instância: outra gramática com o mesmo nome lógico volta a avisar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const line = "c".repeat(MAX_TOKENIZE_LINE_LENGTH + 1);
      capGrammar("CapShared").tokenizeLine(line, undefined);
      capGrammar("CapShared").tokenizeLine(line, undefined);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("linha truncada neutraliza o estado: a linha seguinte não herda o construto cortado", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const grammar = demoGrammar();
      // A `"` abre string e a linha é cortada no teto com a string ainda aberta.
      const truncated = `const s = "${"a".repeat(MAX_TOKENIZE_LINE_LENGTH)}`;
      const first = grammar.tokenizeLine(truncated, undefined);
      expect(first.spans[first.spans.length - 1]?.scope).toBe(TOKENIZE_LIMIT_SCOPE);

      // Estado neutralizado: a linha seguinte é tokenizada do contexto inicial, **não** como se
      // estivesse dentro da string cortada (era o que coloria o resto do documento errado).
      expect(grammar.tokenizeLine("fim", first.state).spans).toEqual([
        { start: 0, end: 3, scope: "source.demo" },
      ]);
      // Controle: sem truncamento o estado da string **é** propagado.
      const open = grammar.tokenizeLine('const s = "começo', undefined);
      expect(grammar.tokenizeLine("fim", open.state).spans).toEqual([
        { start: 0, end: 3, scope: "string.quoted.double.demo" },
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("tokenizer — ciclos de include e escopo do contexto do topo", () => {
  it("include visitado por um ramo não suprime o ramo seguinte (diamante + ciclo)", () => {
    const grammar = grammarOf(
      [
        "name: Diamond",
        "scope: source.diamond",
        "contexts:",
        "  main:",
        "    - include: left",
        "    - include: right",
        "  left:",
        "    - include: shared",
        "  right:",
        "    - include: shared",
        "  shared:",
        "    - include: left",
        "    - match: 'z'",
        "      scope: keyword.shared",
        "",
      ].join("\n"),
      "Diamond",
    );
    // `shared` é alcançado por dois ramos e fecha ciclo com `left`: o corte é por **ramo**, e o
    // casamento de `z` (dentro de `shared`) continua valendo em todos os caminhos.
    expect(spansOf(grammar, "z")).toEqual([{ start: 0, end: 1, scope: "keyword.shared" }]);
    expect(spansOf(grammar, "zz")).toEqual([{ start: 0, end: 2, scope: "keyword.shared" }]);
  });

  it("trecho sem regra usa o escopo da gramática dona do contexto do topo", () => {
    const child = [
      "name: B",
      "scope: source.b",
      "contexts:",
      "  main:",
      "    - match: 'x'",
      "      scope: keyword.b",
      "  bctx:",
      "    - match: 'y'",
      "      scope: keyword.b",
      "",
    ].join("\n");
    const parsed = new Map<string, GrammarDefinition>([
      ["Packages/B/B.sublime-syntax", normalizeGrammarDocument(parseYamlSubset(child, "Packages/B/B.sublime-syntax"), "Packages/B/B.sublime-syntax")],
    ]);
    const resolver: GrammarDefinitionResolver = { resolveDefinition: (name) => parsed.get(name) };
    const grammar = grammarOf(
      [
        "name: A",
        "scope: source.a",
        "contexts:",
        "  main:",
        "    - include: Packages/B/B.sublime-syntax#bctx",
        "    - match: '\"'",
        "      scope: meta.a.start",
        "      push: bctx",
        "",
      ].join("\n"),
      "Packages/A/A.sublime-syntax",
      resolver,
    );
    // Depois do push, o topo da pilha é `bctx`, contexto da gramática B: o `z` sem regra herda
    // `source.b` (dono do contexto), não `source.a` (gramática-raiz).
    expect(spansOf(grammar, '"yz')).toEqual([
      { start: 0, end: 1, scope: "meta.a.start" },
      { start: 1, end: 2, scope: "keyword.b" },
      { start: 2, end: 3, scope: "source.b" },
    ]);
  });
});
