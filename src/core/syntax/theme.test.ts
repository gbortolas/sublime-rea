/**
 * Testes do `ThemeResolverImpl`: casamento por prefixo de escopo, especificidade e desempate.
 */
import { describe, expect, it } from "vitest";

import type { RGBA } from "../../shared";
import { createDefaultTheme, ThemeResolverImpl } from "./theme";

const RED = 0xff0000ff as RGBA;
const GREEN = 0x00ff00ff as RGBA;
const BLUE = 0x0000ffff as RGBA;

describe("ThemeResolverImpl", () => {
  it("casa por prefixo de escopo (componentes separados por ponto)", () => {
    const theme = new ThemeResolverImpl();
    theme.add("string", { color: RED });
    expect(theme.styleFor("string.quoted.double.demo")?.color).toBe(RED);
    expect(theme.styleFor("string")?.color).toBe(RED);
  });

  it("não casa quando o escopo é mais curto ou diverge", () => {
    const theme = new ThemeResolverImpl();
    theme.add("string.quoted", { color: RED });
    expect(theme.styleFor("string")).toBeUndefined();
    expect(theme.styleFor("string.block")).toBeUndefined();
  });

  it("vence o selector com mais componentes", () => {
    const theme = new ThemeResolverImpl();
    theme.add("string", { color: RED });
    theme.add("string.quoted", { color: GREEN });
    expect(theme.styleFor("string.quoted.double")?.color).toBe(GREEN);
    expect(theme.styleFor("string.plain")?.color).toBe(RED);
  });

  it("no empate de especificidade vence a última regra carregada", () => {
    const theme = new ThemeResolverImpl();
    theme.add("keyword", { color: RED });
    theme.add("keyword", { color: BLUE });
    expect(theme.styleFor("keyword.control")?.color).toBe(BLUE);
  });

  it("preserva traços (bold/italic)", () => {
    const theme = new ThemeResolverImpl();
    theme.add("comment", { color: GREEN, italic: true });
    expect(theme.styleFor("comment.line")?.italic).toBe(true);
  });

  it("o tema default distingue palavra-chave de string e deixa o escopo-base sem regra", () => {
    const theme = createDefaultTheme();
    const keyword = theme.styleFor("keyword.control.demo");
    const string = theme.styleFor("string.quoted.double.demo");
    expect(keyword).toBeDefined();
    expect(string).toBeDefined();
    expect(keyword?.color).not.toBe(string?.color);
    expect(theme.styleFor("source.demo")).toBeUndefined();
  });
});
