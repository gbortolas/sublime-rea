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

  it("dispose esvazia o registro", () => {
    const registry = new GrammarRegistryImpl();
    registry.register("Packages/Demo/scribe-demo.sublime-syntax", FIXTURE);
    expect(registry.forExtension("demo")).toBeDefined();
    registry.dispose();
    expect(registry.forExtension("demo")).toBeUndefined();
    expect(() => registry.register("X", "name: X")).toThrow(GrammarParseError);
  });
});
