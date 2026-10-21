/**
 * Testes do `sticky-scroll.ts`: a matemática do **contexto** que gruda no topo (pura, sem DOM).
 */
import { describe, expect, it } from "vitest";
import { computeStickyContext, stickySymbolsFromLsp, type StickySymbol } from "./sticky-scroll";

/** Fonte de linhas por array (o `lineAt` das opções). */
function lineAtOf(lines: readonly string[]): (line: number) => string {
  return (line: number): string => lines[line] ?? "";
}

describe("computeStickyContext — symbols do LSP", () => {
  const symbols: readonly StickySymbol[] = [
    { startLine: 10, endLine: 20 },
    { startLine: 15, endLine: 18 },
  ];

  it("o símbolo que envolve a linha do caret define a envelope", () => {
    const ctx = computeStickyContext({
      caretLine: 16,
      firstVisibleLine: 12,
      maxLines: 5,
      lineAt: lineAtOf([]),
      symbols: [{ startLine: 10, endLine: 20 }],
    });
    // A envelope começa na linha do símbolo (10); as linhas que grudam são as que já
    // saíram da viewport (10 e 11) ⇒ 2 linhas.
    expect(ctx).toEqual({ startLine: 10, count: 2 });
  });

  it("a cadeia de símbolos aninhados: vale o mais externo (o topo da cadeia)", () => {
    const ctx = computeStickyContext({
      caretLine: 16,
      firstVisibleLine: 12,
      maxLines: 5,
      lineAt: lineAtOf([]),
      symbols,
    });
    // O símbolo externo (10..20) e o interno (15..18) envolvem a linha 16 ⇒ a envelope é
    // a **cadeia** (topo = 10).
    expect(ctx?.startLine).toBe(10);
  });

  it("um símbolo que não envolve a linha do caret é ignorado", () => {
    const ctx = computeStickyContext({
      caretLine: 16,
      firstVisibleLine: 12,
      lineAt: lineAtOf([]),
      symbols: [{ startLine: 0, endLine: 5 }],
    });
    expect(ctx).toBeUndefined();
  });

  it("o bloco é a própria linha do caret ⇒ sem contexto", () => {
    const ctx = computeStickyContext({
      caretLine: 16,
      firstVisibleLine: 12,
      lineAt: lineAtOf([]),
      symbols: [{ startLine: 16, endLine: 20 }],
    });
    expect(ctx).toBeUndefined();
  });

  it("o contexto só aparece quando o topo do bloco saiu da viewport", () => {
    const base = {
      caretLine: 16,
      lineAt: lineAtOf([]),
      symbols: [{ startLine: 10, endLine: 20 }] as readonly StickySymbol[],
    };
    // A linha 10 ainda está visível ⇒ nada a grudar.
    expect(computeStickyContext({ ...base, firstVisibleLine: 10 })).toBeUndefined();
    // A linha 10 saiu ⇒ a linha 10 gruda.
    expect(computeStickyContext({ ...base, firstVisibleLine: 11 })).toEqual({
      startLine: 10,
      count: 1,
    });
  });
});

describe("computeStickyContext — fallback por indentação", () => {
  const lines = [
    "function foo() {",
    "  const a = 1;",
    "  if (x) {",
    "    doThing();",
    "  }",
    "}",
  ];

  it("a envelope é o bloco de indentação menor (a linha de abertura)", () => {
    const ctx = computeStickyContext({
      caretLine: 3,
      firstVisibleLine: 3,
      maxLines: 5,
      lineAt: lineAtOf(lines),
    });
    // A linha 3 tem indentação 4; a linha 2 ("  if (x) {") tem 2 (< 4) ⇒ envelope = 2.
    // Só a linha 2 saiu da viewport (a 1ª visível é a 3) ⇒ 1 linha gruda.
    expect(ctx).toEqual({ startLine: 2, count: 1 });
  });

  it("linhas em branco não viram a envelope (elas não abrem bloco)", () => {
    const withBlank = ["function foo() {", "", "  const a = 1;", "  const b = 2;"];
    const ctx = computeStickyContext({
      caretLine: 3,
      firstVisibleLine: 3,
      lineAt: lineAtOf(withBlank),
    });
    // A linha 1 está em branco (indentação 0) — sem o pulo, ela seria a "envelope".
    expect(ctx?.startLine).toBe(0);
  });

  it("no nível do topo (sem bloco acima) não há contexto", () => {
    const ctx = computeStickyContext({
      caretLine: 2,
      firstVisibleLine: 2,
      lineAt: lineAtOf(["x = 1", "y = 2", "z = 3"]),
    });
    expect(ctx).toBeUndefined();
  });

  it("a tabulação conta como indentação", () => {
    const tabs = ["\tif (x) {", "\t\ty();", "\t}"];
    const ctx = computeStickyContext({
      caretLine: 1,
      firstVisibleLine: 1,
      lineAt: lineAtOf(tabs),
    });
    // A linha 1 tem indentação 8 (2 tabs); a linha 0 tem 4 (< 8) ⇒ envelope = 0.
    expect(ctx).toEqual({ startLine: 0, count: 1 });
  });
});

describe("computeStickyContext — limites e casos-limite", () => {  const lines = [
    "function f() {",
    "  a",
    "  b",
    "  c",
    "  d",
    "  e",
    "  f",
    "}",
  ];

  it("maxLines limita quantas linhas grudam", () => {
    const ctx = computeStickyContext({
      caretLine: 6,
      firstVisibleLine: 5,
      maxLines: 2,
      lineAt: lineAtOf(lines),
    });
    // A envelope é a linha 0 (indentação 0 < 2); das 5 linhas que saíram, só 2 grudam.
    expect(ctx).toEqual({ startLine: 0, count: 2 });
  });

  it("sem maxLines, o default é 5 linhas", () => {
    const ctx = computeStickyContext({
      caretLine: 6,
      firstVisibleLine: 5,
      lineAt: lineAtOf(lines),
    });
    expect(ctx).toEqual({ startLine: 0, count: 5 });
  });

  it("a primeira linha do arquivo não tem contexto", () => {
    const ctx = computeStickyContext({
      caretLine: 0,
      firstVisibleLine: 0,
      lineAt: lineAtOf(lines),
    });
    expect(ctx).toBeUndefined();
  });

  it("maxLines = 0 desliga o sticky scroll", () => {
    const ctx = computeStickyContext({
      caretLine: 6,
      firstVisibleLine: 5,
      maxLines: 0,
      lineAt: lineAtOf(lines),
    });
    expect(ctx).toBeUndefined();
  });

  it("é determinístico (a mesma entrada ⇒ o mesmo contexto)", () => {
    const options = {
      caretLine: 3,
      firstVisibleLine: 3,
      maxLines: 5,
      lineAt: lineAtOf(lines),
    };
    expect(computeStickyContext(options)).toEqual(computeStickyContext(options));
  });
});

describe("stickySymbolsFromLsp — do bridge para o intervalo de linhas", () => {
  const lines = [
    "def outer():",
    "    def inner():",
    "        x = 1",
    "    y = 2",
    "z = 3",
  ];

  it("expande o selection range (1 linha) pelo fim do bloco (indentação)", () => {
    // O bridge entrega o *selection range* (o nome do símbolo, 1 linha).
    const symbols = stickySymbolsFromLsp(
      [{ range: { startLine: 0, endLine: 0 } }],
      lineAtOf(lines),
      lines.length,
    );
    // O bloco de "def outer():" vai até a linha 3 (a 4ª desindenta).
    expect(symbols).toEqual([{ startLine: 0, endLine: 3 }]);
  });

  it("o bloco de um símbolo aninhado termina na desindentação dele", () => {
    const symbols = stickySymbolsFromLsp(
      [{ range: { startLine: 1, endLine: 1 } }],
      lineAtOf(lines),
      lines.length,
    );
    // "def inner():" (indentação 4) fecha na linha 3 ("    y = 2", indentação 4).
    expect(symbols).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  it("um símbolo que já vem com extensão é respeitado", () => {
    const symbols = stickySymbolsFromLsp(
      [{ range: { startLine: 1, endLine: 3 } }],
      lineAtOf(lines),
      lines.length,
    );
    expect(symbols).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it("o contexto com os símbolos expandidos cobre a linha do caret", () => {
    const symbols = stickySymbolsFromLsp(
      [{ range: { startLine: 0, endLine: 0 } }],
      lineAtOf(lines),
      lines.length,
    );
    const ctx = computeStickyContext({
      caretLine: 2,
      firstVisibleLine: 2,
      lineAt: lineAtOf(lines),
      symbols,
    });
    // As linhas 0 e 1 (as declarações) já saíram da viewport ⇒ elas grudam.
    expect(ctx).toEqual({ startLine: 0, count: 2 });
  });
});
