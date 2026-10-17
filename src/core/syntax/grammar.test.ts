/**
 * Testes do compilador (`grammar.ts`): normalização, `main` obrigatório, `prototype`, `include`,
 * `extends`, `variables` e erros tipados.
 */
import { describe, expect, it } from "vitest";

import { GrammarIncludeError, GrammarParseError } from "../../shared";
import type { GrammarDefinition } from "../../shared";
import {
  compileGrammar,
  normalizeGrammarDocument,
  type GrammarDefinitionResolver,
} from "./grammar";
import { parseYamlSubset } from "./yaml";

function definition(source: string, logicalName = "Packages/Test/Test.sublime-syntax"): GrammarDefinition {
  return normalizeGrammarDocument(parseYamlSubset(source, logicalName), logicalName);
}

/** Resolvedor stub: mapa de nome lógico → definição. */
function stubResolver(entries: Readonly<Record<string, string>>): GrammarDefinitionResolver {
  const parsed = new Map<string, GrammarDefinition>();
  for (const [name, source] of Object.entries(entries)) parsed.set(name, definition(source, name));
  return { resolveDefinition: (name) => parsed.get(name) };
}

const EMPTY_RESOLVER: GrammarDefinitionResolver = { resolveDefinition: () => undefined };

describe("normalizeGrammarDocument", () => {
  it("normaliza nome, escopo, extensões, contextos e variáveis", () => {
    const def = definition(
      [
        "name: Demo",
        "scope: source.demo",
        "version: 2",
        "file_extensions: [demo]",
        "variables:",
        "  ident: '[a-z]+'",
        "contexts:",
        "  main:",
        "    - match: 'x'",
        "      scope: keyword.demo",
        "",
      ].join("\n"),
    );
    expect(def.name).toBe("Demo");
    expect(def.scope).toBe("source.demo");
    expect(def.version).toBe("2");
    expect(def.fileExtensions).toEqual(["demo"]);
    expect(def.variables["ident"]).toBe("[a-z]+");
    expect(def.contexts).toHaveLength(1);
    expect(def.contexts[0]?.name).toBe("main");
  });

  it("rejeita documento que não é mapa", () => {
    expect(() => normalizeGrammarDocument([], "X")).toThrow(GrammarParseError);
  });

  it("rejeita contexto que não é lista", () => {
    expect(() => normalizeGrammarDocument({ name: "N", contexts: { main: "x" } }, "X")).toThrow(
      GrammarParseError,
    );
  });

  it("ignora pattern sem match/include (ex.: meta_scope isolado)", () => {
    const def = definition(
      ["name: N", "scope: source.n", "contexts:", "  main:", "    - meta_scope: comment.n", ""].join("\n"),
    );
    expect(def.contexts[0]?.patterns).toHaveLength(1);
    expect(def.contexts[0]?.patterns[0]?.match).toBeUndefined();
    expect(def.contexts[0]?.patterns[0]?.include).toBeUndefined();
  });
});

describe("compileGrammar — regras estruturais", () => {
  it("exige o contexto inicial `main`", () => {
    const def = definition(
      ["name: N", "scope: source.n", "contexts:", "  other:", "    - match: 'x'", ""].join("\n"),
    );
    expect(() => compileGrammar(def, EMPTY_RESOLVER)).toThrow(GrammarParseError);
  });

  it("anexa o contexto implícito `prototype` a todos os contextos (menos a si mesmo)", () => {
    const def = definition(
      [
        "name: N",
        "scope: source.n",
        "contexts:",
        "  prototype:",
        "    - match: '!'",
        "      scope: punctuation.prototype.n",
        "  main:",
        "    - match: 'a'",
        "      scope: keyword.a.n",
        "",
      ].join("\n"),
    );
    const grammar = compileGrammar(def, EMPTY_RESOLVER);
    const line = grammar.tokenizeLine("!a", undefined);
    expect(line.spans).toEqual([
      { start: 0, end: 1, scope: "punctuation.prototype.n" },
      { start: 1, end: 2, scope: "keyword.a.n" },
    ]);
  });

  it("expande variáveis em match, scope e include", () => {
    const ok = definition(
      [
        "name: N",
        "scope: source.n",
        "variables:",
        "  kw: 'if|else'",
        "  target: extra",
        "contexts:",
        "  main:",
        "    - include: '{{target}}'",
        "  extra:",
        "    - match: '\\b({{kw}})\\b'",
        "      scope: keyword.control.n",
        "",
      ].join("\n"),
    );
    const grammar = compileGrammar(ok, EMPTY_RESOLVER);
    expect(grammar.tokenizeLine("if", undefined).spans[0]?.scope).toBe("keyword.control.n");
  });

  it("include que expande para contexto inexistente é erro tipado", () => {
    const bad = definition(
      [
        "name: N",
        "scope: source.n",
        "variables:",
        "  kw: 'if|else'",
        "contexts:",
        "  main:",
        "    - include: '{{kw}}'",
        "",
      ].join("\n"),
    );
    expect(() => compileGrammar(bad, EMPTY_RESOLVER)).toThrow(GrammarIncludeError);
  });

  it("resolve `include` local e detecta include desconhecido", () => {
    const local = definition(
      [
        "name: N",
        "scope: source.n",
        "contexts:",
        "  main:",
        "    - include: numbers",
        "  numbers:",
        "    - match: '\\d+'",
        "      scope: constant.numeric.n",
        "",
      ].join("\n"),
    );
    expect(compileGrammar(local, EMPTY_RESOLVER).tokenizeLine("42", undefined).spans[0]?.scope).toBe(
      "constant.numeric.n",
    );

    const broken = definition(
      ["name: N", "scope: source.n", "contexts:", "  main:", "    - include: missing", ""].join("\n"),
    );
    expect(() => compileGrammar(broken, EMPTY_RESOLVER)).toThrow(GrammarIncludeError);
  });

  it("rejeita include por selector de escopo", () => {
    const def = definition(
      [
        "name: N",
        "scope: source.n",
        "contexts:",
        "  main:",
        "    - include: 'scope:source.other'",
        "",
      ].join("\n"),
    );
    expect(() => compileGrammar(def, EMPTY_RESOLVER)).toThrow(GrammarIncludeError);
  });

  it("resolve `extends` pelo resolvedor injetado (filho vence)", () => {
    const base = [
      "name: Base",
      "scope: source.base",
      "contexts:",
      "  shared:",
      "    - match: 's'",
      "      scope: keyword.shared",
      "  main:",
      "    - include: shared",
      "",
    ].join("\n");
    const child = definition(
      [
        "name: Child",
        "scope: source.child",
        "extends: Packages/Base/Base.sublime-syntax",
        "contexts:",
        "  main:",
        "    - match: 'child'",
        "      scope: keyword.child",
        "    - include: shared",
        "",
      ].join("\n"),
    );
    const resolver = stubResolver({ "Packages/Base/Base.sublime-syntax": base });
    const grammar = compileGrammar(child, resolver);
    expect(grammar.tokenizeLine("child", undefined).spans[0]?.scope).toBe("keyword.child");
    expect(grammar.tokenizeLine("s", undefined).spans[0]?.scope).toBe("keyword.shared");
  });

  it("herda o `main` do pai quando o filho não o redefine", () => {
    const base = [
      "name: Base",
      "scope: source.base",
      "contexts:",
      "  shared:",
      "    - match: 's'",
      "      scope: keyword.shared",
      "  main:",
      "    - include: shared",
      "",
    ].join("\n");
    const child = definition(
      ["name: Child", "scope: source.child", "extends: Packages/Base/Base.sublime-syntax", ""].join("\n"),
    );
    const grammar = compileGrammar(child, stubResolver({ "Packages/Base/Base.sublime-syntax": base }));
    expect(grammar.tokenizeLine("s", undefined).spans[0]?.scope).toBe("keyword.shared");
  });

  it("`extends` desconhecido é erro de include", () => {
    const def = definition(
      ["name: N", "scope: source.n", "extends: Packages/Gone/Gone.sublime-syntax", "contexts:", "  main: []", ""].join("\n"),
    );
    expect(() => compileGrammar(def, EMPTY_RESOLVER)).toThrow(GrammarIncludeError);
  });

  it("regex inválida vira GrammarParseError", () => {
    const def = definition(
      ["name: N", "scope: source.n", "contexts:", "  main:", "    - match: '(['", ""].join("\n"),
    );
    expect(() => compileGrammar(def, EMPTY_RESOLVER)).toThrow(GrammarParseError);
  });

  it("`push`/`set` para contexto inexistente é erro de include", () => {
    const def = definition(
      [
        "name: N",
        "scope: source.n",
        "contexts:",
        "  main:",
        "    - match: 'a'",
        "      push: nowhere",
        "",
      ].join("\n"),
    );
    expect(() => compileGrammar(def, EMPTY_RESOLVER)).toThrow(GrammarIncludeError);
  });
});
