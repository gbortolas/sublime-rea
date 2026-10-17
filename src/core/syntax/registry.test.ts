/**
 * Testes do `GrammarRegistryImpl`: registro por extensão, compilação sob demanda e erros tipados.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { GrammarParseError } from "../../shared";
import { GrammarRegistryImpl } from "./registry";

const FIXTURE = readFileSync(resolve(process.cwd(), "assets/grammars/scribe-demo.sublime-syntax"), "utf8");

describe("GrammarRegistryImpl", () => {
  it("compila a gramática de brinquedo e casa por extensão (com e sem ponto, case-insensitive)", () => {
    const registry = new GrammarRegistryImpl();
    registry.register("Packages/Demo/scribe-demo.sublime-syntax", FIXTURE);

    const grammar = registry.forExtension("demo");
    expect(grammar?.name).toBe("Scribe Demo");
    expect(grammar?.fileExtensions).toEqual(["demo"]);
    expect(registry.forExtension(".DEMO")).toBe(grammar);
    expect(grammar?.tokenizeLine("const x = 1", undefined).spans[0]?.scope).toBe("keyword.control.demo");
  });

  it("devolve undefined para extensão sem gramática", () => {
    const registry = new GrammarRegistryImpl();
    registry.register("Packages/Demo/scribe-demo.sublime-syntax", FIXTURE);
    expect(registry.forExtension("rs")).toBeUndefined();
  });

  it("register devolve a definição normalizada e lança em gramática malformada", () => {
    const registry = new GrammarRegistryImpl();
    const definition = registry.register("Packages/Demo/scribe-demo.sublime-syntax", FIXTURE);
    expect(definition.name).toBe("Scribe Demo");
    expect(() => registry.register("Bad", "name: [1, 2")).toThrow(GrammarParseError);
  });

  it("compila sob demanda: erro de include só aparece na consulta por extensão", () => {
    const registry = new GrammarRegistryImpl();
    registry.register(
      "Packages/Broken/Broken.sublime-syntax",
      ["name: Broken", "scope: source.broken", "file_extensions: [brk]", "contexts:", "  main:", "    - include: missing", ""].join("\n"),
    );
    expect(() => registry.forExtension("brk")).toThrow(/missing/);
  });

  it("re-registro não deixa extensão obsoleta apontando para a gramática", () => {
    const registry = new GrammarRegistryImpl();
    registry.register("Packages/Demo/scribe-demo.sublime-syntax", FIXTURE);
    expect(registry.forExtension("demo")).toBeDefined();

    // Mesma gramática, sem `demo`: a extensão antiga precisa ser solta (não sobra índice obsoleto).
    registry.register(
      "Packages/Demo/scribe-demo.sublime-syntax",
      ["name: Scribe Demo", "scope: source.demo", "file_extensions: [demo2]", "contexts:", "  main:", "    - match: 'const'", "      scope: keyword.control.demo", ""].join("\n"),
    );
    expect(registry.forExtension("demo")).toBeUndefined();
    expect(registry.forExtension("demo2")?.name).toBe("Scribe Demo");
  });

  it("re-registro devolve a extensão suprimida ao nome que a declarava depois", () => {
    const registry = new GrammarRegistryImpl();
    // A registra primeiro e vence em `dup`; B declara `dup` mas fica suprimido ("a primeira vence").
    registry.register(
      "Packages/A/A.sublime-syntax",
      ["name: A", "scope: source.a", "file_extensions: [dup, only_a]", "contexts:", "  main:", "    - match: 'a'", "      scope: keyword.a", ""].join("\n"),
    );
    registry.register(
      "Packages/B/B.sublime-syntax",
      ["name: B", "scope: source.b", "file_extensions: [dup]", "contexts:", "  main:", "    - match: 'b'", "      scope: keyword.b", ""].join("\n"),
    );
    expect(registry.forExtension("dup")?.name).toBe("A");

    // A re-registra sem `dup`: a extensão não pode ficar órfã — B passa a casar.
    registry.register(
      "Packages/A/A.sublime-syntax",
      ["name: A", "scope: source.a", "file_extensions: [only_a]", "contexts:", "  main:", "    - match: 'a'", "      scope: keyword.a", ""].join("\n"),
    );
    expect(registry.forExtension("dup")?.name).toBe("B");
    expect(registry.forExtension("only_a")?.name).toBe("A");
  });

  it("dispose esvazia o registro", () => {
    const registry = new GrammarRegistryImpl();
    registry.register("Packages/Demo/scribe-demo.sublime-syntax", FIXTURE);
    expect(registry.forExtension("demo")).toBeDefined();
    registry.dispose();
    expect(registry.forExtension("demo")).toBeUndefined();
    expect(() => registry.register("X", "name: X")).toThrow(GrammarParseError);
  });
});
