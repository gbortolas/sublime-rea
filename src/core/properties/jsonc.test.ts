import { describe, expect, it } from "vitest";

import { JsonParseError, parseJsonc } from "./jsonc";

describe("parseJsonc", () => {
  it("remove comentários de linha em vários contextos", () => {
    const text = `{
      // antes de chave
      "a": 1, // depois de valor
      "b": [
        1, // em array
        2
      ]
      // antes de fechar
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2] });
  });

  it("remove comentários de bloco, inclusive multilinha", () => {
    const text = `/* cabeçalho */
{ /* inline */ "a": /* meio */ true }`;
    expect(parseJsonc(text)).toEqual({ a: true });
  });

  it("aceita vírgula final em objetos e arrays", () => {
    expect(parseJsonc('{ "a": [1, 2, 3,], "b": { "c": 1, }, }')).toEqual({ a: [1, 2, 3], b: { c: 1 } });
  });

  it("preserva `//` e `/* */` dentro de strings", () => {
    const text = '{ "url": "https://exemplo/x//y", "pat": "a/*b*/c", "esc": "aspas \\" e barra \\\\" }';
    expect(parseJsonc(text)).toEqual({
      url: "https://exemplo/x//y",
      pat: "a/*b*/c",
      esc: 'aspas " e barra \\',
    });
  });

  it("lança JsonParseError com linha/coluna em JSON inválido", () => {
    const text = '{\n  "a": 1\n  "b": 2\n}';
    let caught: unknown;
    try {
      parseJsonc(text);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonParseError);
    const error = caught as JsonParseError;
    expect(error.line).toBe(3);
    expect(error.column).toBe(3);
  });

  it("parseia JSON estrito sem comentários normalmente", () => {
    expect(parseJsonc<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });
});
