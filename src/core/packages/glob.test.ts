import { describe, expect, it } from "vitest";

import { compileGlob, globMatches } from "./glob";

describe("glob", () => {
  it("`*` casa dentro de um segmento, não atravessa `/`", () => {
    expect(globMatches("*.txt", "a.txt")).toBe(true);
    expect(globMatches("*.txt", "a/b.txt")).toBe(false);
    expect(globMatches("Default.sublime-keymap", "Default.sublime-keymap")).toBe(true);
  });

  it("`**/` atravessa diretórios (inclusive zero)", () => {
    expect(globMatches("**/*.sublime-syntax", "Default.sublime-syntax")).toBe(true);
    expect(globMatches("**/*.sublime-syntax", "sub/Default.sublime-syntax")).toBe(true);
    expect(globMatches("**/*.sublime-syntax", "a/b/C.sublime-syntax")).toBe(true);
    expect(globMatches("**/*.sublime-syntax", "Default.sublime-keymap")).toBe(false);
  });

  it("`?` casa um único caractere (não `/`)", () => {
    expect(globMatches("a?.txt", "ab.txt")).toBe(true);
    expect(globMatches("a?.txt", "a/b.txt")).toBe(false);
    expect(globMatches("a?.txt", "abc.txt")).toBe(false);
  });

  it("`{a,b}` é alternância", () => {
    expect(globMatches("*.{js,ts}", "x.js")).toBe(true);
    expect(globMatches("*.{js,ts}", "x.ts")).toBe(true);
    expect(globMatches("*.{js,ts}", "x.py")).toBe(false);
    expect(globMatches("*/Default.sublime-{keymap,menu}", "Pkg/Default.sublime-menu")).toBe(true);
  });

  it("é ancorado e case-sensitive", () => {
    expect(globMatches("a.txt", "aa.txt")).toBe(false);
    expect(globMatches("a.txt", "A.txt")).toBe(false);
    expect(globMatches("**", "a/b/c")).toBe(true);
  });

  it("escapa metacaracteres de regex no padrão", () => {
    expect(globMatches("a.b", "a.b")).toBe(true);
    expect(globMatches("a.b", "axb")).toBe(false);
    expect(globMatches("a+b", "a+b")).toBe(true);
  });

  it("compila com cache (mesma instância por padrão)", () => {
    expect(compileGlob("**/*.txt")).toBe(compileGlob("**/*.txt"));
  });
});
