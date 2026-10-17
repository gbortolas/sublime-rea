/**
 * Testes do leitor de **subconjunto** YAML (`yaml.ts`): o que suporta e o que falha alto.
 */
import { describe, expect, it } from "vitest";

import { GrammarParseError } from "../../shared";
import { parseYamlSubset } from "./yaml";

const NAME = "Test.sublime-syntax";

describe("parseYamlSubset — mapas, listas e escalares", () => {
  it("parseia mapa de topo com escalares", () => {
    const value = parseYamlSubset("name: Demo\nscope: source.demo\nversion: 1\n", NAME);
    expect(value).toEqual({ name: "Demo", scope: "source.demo", version: 1 });
  });

  it("parseia listas de bloco com escalares e mapas na mesma linha", () => {
    const text = [
      "contexts:",
      "  main:",
      "    - match: '//.*$'",
      "      scope: comment.line.demo",
      "    - include: numbers",
      "  numbers:",
      "    - match: '\\d+'",
      "      scope: constant.numeric.demo",
      "",
    ].join("\n");
    const value = parseYamlSubset(text, NAME) as {
      contexts: Record<string, unknown[]>;
    };
    expect(value.contexts["main"]).toEqual([
      { match: "//.*$", scope: "comment.line.demo" },
      { include: "numbers" },
    ]);
    expect(value.contexts["numbers"]).toEqual([{ match: "\\d+", scope: "constant.numeric.demo" }]);
  });

  it("suporta aspas simples (com '' escapado) e duplas (com escapes)", () => {
    const value = parseYamlSubset(
      "a: 'it''s'\nb: \"line\\nnext\"\n",
      NAME,
    ) as { a: string; b: string };
    expect(value.a).toBe("it's");
    expect(value.b).toBe("line\nnext");
  });

  it("preserva barras invertidas em escalar com aspas simples", () => {
    const value = parseYamlSubset("match: '\\bfoo\\b'\n", NAME) as { match: string };
    expect(value.match).toBe("\\bfoo\\b");
  });

  it("suporta lista de fluxo de escalares", () => {
    const value = parseYamlSubset("file_extensions: [demo, txt]\n", NAME) as {
      file_extensions: string[];
    };
    expect(value.file_extensions).toEqual(["demo", "txt"]);
  });

  it("ignora comentários fora de aspas e diretivas/marcadores de documento", () => {
    const text = [
      "%YAML 1.2",
      "---",
      "name: Demo # comentário de topo",
      "scope: 'source.#demo'",
      "match: '#nao-comentario'",
      "...",
      "",
    ].join("\n");
    const value = parseYamlSubset(text, NAME) as {
      name: string;
      scope: string;
      match: string;
    };
    expect(value).toEqual({ name: "Demo", scope: "source.#demo", match: "#nao-comentario" });
  });

  it("delega JSON quando o texto começa com chave", () => {
    const value = parseYamlSubset('{"name": "J", "file_extensions": ["j"]}', NAME);
    expect(value).toEqual({ name: "J", file_extensions: ["j"] });
  });

  it("trata null/vazio e booleanos", () => {
    const value = parseYamlSubset("hidden: true\nempty:\nother: ~\n", NAME) as {
      hidden: boolean;
      empty: unknown;
      other: unknown;
    };
    expect(value.hidden).toBe(true);
    expect(value.empty).toBeNull();
    expect(value.other).toBeNull();
  });
});

describe("parseYamlSubset — erros tipados", () => {
  it("rejeita indentação com tab", () => {
    expect(() => parseYamlSubset("a:\n\tb: 1\n", NAME)).toThrow(GrammarParseError);
  });

  it("rejeita aspas não fechadas", () => {
    expect(() => parseYamlSubset("name: 'sem fim\n", NAME)).toThrow(GrammarParseError);
  });

  it("rejeita mapa em fluxo (não suportado)", () => {
    expect(() => parseYamlSubset("a: {b: 1}\n", NAME)).toThrow(GrammarParseError);
  });

  it("rejeita conteúdo com indentação inesperada", () => {
    expect(() => parseYamlSubset("a: 1\n   b: 2\n", NAME)).toThrow(GrammarParseError);
  });

  it("a mensagem carrega o nome lógico e a linha", () => {
    try {
      parseYamlSubset("a:\n\tb: 1\n", "Foo.sublime-syntax");
      expect.unreachable("deveria lançar");
    } catch (error) {
      expect(error).toBeInstanceOf(GrammarParseError);
      if (error instanceof GrammarParseError) {
        expect(error.logicalName).toBe("Foo.sublime-syntax");
        expect(error.line).toBe(2);
      }
    }
  });
});
