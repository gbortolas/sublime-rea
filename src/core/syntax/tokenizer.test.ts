/**
 * Testes do motor de tokenização (`tokenizer.ts`) — spans da gramática de brinquedo do Scribe,
 * determinismo e o estado que atravessa linhas (strings multi-linha).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { HighlightSpan, SyntaxGrammar } from "../../shared";
import { compileGrammar, normalizeGrammarDocument, type GrammarDefinitionResolver } from "./grammar";
import { parseYamlSubset } from "./yaml";

const FIXTURE = resolve(process.cwd(), "assets/grammars/scribe-demo.sublime-syntax");
const NO_INCLUDES: GrammarDefinitionResolver = { resolveDefinition: () => undefined };

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
