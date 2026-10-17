/**
 * Scribe — testes da costura de busca (`src/shared/search-contract.ts`).
 *
 * Cobre a semântica que **precisa** ser idêntica no main, no worker e nos testes: literal vs
 * regex, case/wholeWord, teto + `truncated`, ocorrências de comprimento zero, `line`/`column`
 * (incl. `\r\n`) e os erros tipados de entrada.
 */
import { describe, expect, it } from "vitest";

import {
  SEARCH_DEFAULT_MAX_MATCHES,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_PATTERN_LENGTH,
  SEARCH_MAX_TEXT_LENGTH,
  SearchInputError,
  findMatches,
  normalizeSearchQuery,
  scanText,
} from "./search-contract";
import type { SearchErrorCode } from "./search-contract";

function expectSearchError(fn: () => unknown, code: SearchErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SearchInputError);
  if (!(thrown instanceof SearchInputError)) throw new Error("esperado SearchInputError");
  expect(thrown.code).toBe(code);
}

describe("normalizeSearchQuery / scanText — literal vs regex", () => {
  it("trata o padrão como literal por default (metacaracteres não casam)", () => {
    const literal = findMatches("a.b axb", { pattern: "a.b" });
    expect(literal.matches.map((m) => m.index)).toEqual([0]);

    const asRegex = findMatches("a.b axb", { pattern: "a.b", regex: true });
    expect(asRegex.matches.map((m) => m.index)).toEqual([0, 4]);
  });

  it("escapa metacaracteres quando regex=false", () => {
    const result = findMatches("1+1", { pattern: "1+1" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ index: 0, length: 3 });
  });
});

describe("normalizeSearchQuery / scanText — flags", () => {
  it("case-insensitive por default; caseSensitive liga a distinção", () => {
    expect(findMatches("Foo foo", { pattern: "foo" }).matches).toHaveLength(2);
    expect(findMatches("Foo foo", { pattern: "foo", caseSensitive: true }).matches).toHaveLength(1);
  });

  it("wholeWord casa só a palavra inteira (bordas \\b)", () => {
    const loose = findMatches("cat concatenate cat_", { pattern: "cat" });
    expect(loose.matches).toHaveLength(3);
    const whole = findMatches("cat concatenate cat_", { pattern: "cat", wholeWord: true });
    expect(whole.matches.map((m) => m.index)).toEqual([0]);
  });

  it("wholeWord sobre regex mantém as bordas", () => {
    const result = findMatches("aa ab aa", { pattern: "a+", regex: true, wholeWord: true });
    expect(result.matches.map((m) => m.index)).toEqual([0, 6]);
  });
});

describe("scanText — teto e truncamento", () => {
  it("para em maxMatches e marca truncated", () => {
    const result = findMatches("aaaaa", { pattern: "a", maxMatches: 3 });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.scannedLength).toBeLessThan("aaaaa".length);
  });

  it("sem excesso, truncated=false e scannedLength é o texto todo", () => {
    const result = findMatches("aaaaa", { pattern: "a", maxMatches: 5 });
    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(result.scannedLength).toBe(5);
  });

  it("clampa maxMatches no teto global (nunca acima de SEARCH_MAX_MATCHES)", () => {
    const normalized = normalizeSearchQuery({ pattern: "a", maxMatches: Number.MAX_SAFE_INTEGER });
    expect(normalized.maxMatches).toBe(SEARCH_MAX_MATCHES);
  });

  it("valor não-finito cai no default (o cap nunca vira NaN ⇒ truncamento sempre dispara)", () => {
    for (const maxMatches of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const normalized = normalizeSearchQuery({ pattern: "a", maxMatches });
      expect(normalized.maxMatches).toBe(SEARCH_DEFAULT_MAX_MATCHES);
    }
    // E o truncamento realmente dispara com esse cap (o bug era `Math.floor(NaN)` = NaN).
    const result = findMatches("a".repeat(SEARCH_DEFAULT_MAX_MATCHES + 1), { pattern: "a", maxMatches: Number.NaN });
    expect(result.matches).toHaveLength(SEARCH_DEFAULT_MAX_MATCHES);
    expect(result.truncated).toBe(true);
  });

  it("maxMatches=0 é clampado em 1 (não existe cap zero)", () => {
    expect(normalizeSearchQuery({ pattern: "a", maxMatches: 0 }).maxMatches).toBe(1);
    expect(findMatches("aaa", { pattern: "a", maxMatches: 0 })).toEqual({
      matches: [{ index: 0, length: 1, line: 0, column: 0 }],
      truncated: true,
      scannedLength: 1,
    });
  });
});

describe("scanText — ocorrências de comprimento zero", () => {
  it("ignora match vazio (`^`) e não trava", () => {
    const result = findMatches("abc", { pattern: "^", regex: true });
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("ignora match vazio em regex mista e ainda acha as demais", () => {
    const result = findMatches("ab", { pattern: "a*", regex: true });
    expect(result.matches.map((m) => m.index)).toEqual([0]);
    expect(result.matches[0]?.length).toBe(1);
  });
});

describe("scanText — line/column", () => {
  it("conta linhas com \\n", () => {
    const result = findMatches("foo\nbar\nfoo", { pattern: "foo" });
    expect(result.matches).toEqual([
      { index: 0, length: 3, line: 0, column: 0 },
      { index: 8, length: 3, line: 2, column: 0 },
    ]);
  });

  it("trata \\r\\n (a coluna do \\r continua na linha anterior)", () => {
    const text = "a\r\nb"; // a=0, \r=1, \n=2, b=3
    const result = findMatches(text, { pattern: "b" });
    expect(result.matches).toEqual([{ index: 3, length: 1, line: 1, column: 0 }]);

    const cr = findMatches(text, { pattern: "a", regex: true });
    expect(cr.matches[0]).toMatchObject({ line: 0, column: 0 });
  });

  it("colunas no meio da linha", () => {
    const result = findMatches("xx\n  needle", { pattern: "needle" });
    expect(result.matches[0]).toMatchObject({ line: 1, column: 2 });
  });
});

describe("scanText / normalizeSearchQuery — erros tipados", () => {
  it("padrão vazio ⇒ search.emptyPattern", () => {
    expectSearchError(() => normalizeSearchQuery({ pattern: "" }), "search.emptyPattern");
  });

  it("padrão acima do teto ⇒ search.pattern", () => {
    const long = "a".repeat(SEARCH_MAX_PATTERN_LENGTH + 1);
    expectSearchError(() => normalizeSearchQuery({ pattern: long }), "search.pattern");
  });

  it("regex inválida ⇒ search.pattern", () => {
    expectSearchError(
      () => normalizeSearchQuery({ pattern: "(", regex: true }),
      "search.pattern",
    );
  });

  it("texto acima do teto ⇒ search.tooLarge", () => {
    const normalized = normalizeSearchQuery({ pattern: "a" });
    const huge = "a".repeat(SEARCH_MAX_TEXT_LENGTH + 1);
    expectSearchError(() => scanText(huge, normalized), "search.tooLarge");
  });
});
