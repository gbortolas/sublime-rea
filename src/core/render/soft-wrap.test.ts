/**
 * Scribe — testes do `SoftWrapUtil` (P3#15).
 */
import { describe, expect, it } from "vitest";
import {
  applyCollapsedLines,
  buildVisualRowMap,
  buildVisualRowMapFromIndex,
  collapsedLinesOf,
  visualRowOf,
  VisualRowIndex,
  wrapLine,
  visualLineCount,
  resolveVisualLine,
  type VisualLineSource,
} from "./soft-wrap";

/** Mede largura: cada caractere = 10px, espaço = 5px. */
function measure(text: string): number {
  let w = 0;
  for (const ch of text) w += ch === " " ? 5 : 10;
  return w;
}

/** Fonte de linhas mínima (mesma forma de `LineSource`). */
function sourceOf(lines: readonly string[]): VisualLineSource {
  return {
    lineCount: (): number => lines.length,
    line: (index: number): string => lines[index] ?? "",
  };
}

describe("wrapLine", () => {
  it("texto vazio retorna segmento único vazio", () => {
    const segs = wrapLine("", 100, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("");
  });

  it("maxWidth <= 0 retorna a linha inteira como segmento único", () => {
    const segs = wrapLine("hello world", 0, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hello world");
  });

  it("linha curta que cabe não quebra", () => {
    const segs = wrapLine("hi", 100, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hi");
  });

  it("linha com espaço que cabe não é quebrada no espaço (early-exit)", () => {
    // "hello world" = 105px, maxWidth=200 → cabe inteira: **1** segmento.
    // (O render depende disso: sem o early-exit, linhas que cabem seriam quebradas
    //  no último espaço e desenhariam rows duplicadas.)
    const segs = wrapLine("hello world", 200, measure);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hello world");
    expect(segs[0]!.start).toBe(0);
    expect(segs[0]!.end).toBe("hello world".length);
  });

  it("linha longa quebra por caractere quando não tem espaço", () => {
    // "abcdef" = 60px, maxWidth=25: quebra em "ab" (20px), "cd" (20px), "ef" (20px)
    const segs = wrapLine("abcdef", 25, measure);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    expect(segs[0]!.text.length).toBeLessThanOrEqual(3);
    const reconstructed = segs.map((s) => s.text).join("");
    expect(reconstructed).toBe("abcdef");
  });

  it("quebra em espaço quando possível", () => {
    // "hello world foo" = 50 + 5 + 50 + 5 + 30 = 140px, maxWidth=60
    // "hello" = 50 <= 60, "hello " = 55 <= 60, "hello w" = 65 > 60 → quebra no espaço
    const segs = wrapLine("hello world foo", 60, measure);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0]!.text).toBe("hello");
    // O segundo segmento não começa com espaço (os espaços são pulados)
    expect(segs[1]!.text.startsWith(" ")).toBe(false);
  });

  it("palavra maior que maxWidth ultrapassa (overflow)", () => {
    // "superlongword" = 130px, maxWidth=50 → quebra em 5 chars (50px) cada
    const segs = wrapLine("superlongword", 50, measure);
    expect(segs.length).toBe(3);
    expect(segs[0]!.text).toBe("super");
    expect(segs[1]!.text).toBe("longw");
    expect(segs[2]!.text).toBe("ord");
  });

  it("segmentos preservam o texto (espaços na fronteira são perdidos por design)", () => {
    // Espaços entre palavras na fronteira da quebra são pulados — é o comportamento esperado
    // para soft wrap (o espaço vira "invisível" no início da linha seguinte).
    const text = "the quick brown fox jumps over the lazy dog";
    const segs = wrapLine(text, 80, measure);
    const reconstructed = segs.map((s) => s.text).join("");
    // Espaços na fronteira entre "the" e "quick" são perdidos durante a quebra
    expect(reconstructed.replace(/^ +/, "").length).toBeGreaterThan(0);
    expect(reconstructed.includes("quick")).toBe(true);
  });
});

describe("visualLineCount", () => {
  const lines = ["short", "a very long line that should wrap quite a bit", "tiny"];

  it("sem wrap retorna lineCount", () => {
    expect(visualLineCount(3, (i) => lines[i] ?? "", 0, measure)).toBe(3);
  });

  it("com wrap retorna total de segmentos visuais", () => {
    const count = visualLineCount(3, (i: number) => lines[i] ?? "", 50, measure);
    // "short" = 50px, cabe (1)
    // "a very long line that should wrap quite a bit" = muito longa, várias quebras
    // "tiny" = 40px, cabe (1)
    expect(count).toBeGreaterThan(3);
  });
});

describe("resolveVisualLine", () => {
  const lines = ["abc", "def ghij klm"];

  it("retorna undefined para índice negativo", () => {
    expect(resolveVisualLine(-1, 2, (i: number) => lines[i] ?? "", 100, measure)).toBeUndefined();
  });

  it("retorna undefined para índice fora do range", () => {
    expect(resolveVisualLine(99, 2, (i: number) => lines[i] ?? "", 100, measure)).toBeUndefined();
  });

  it("resolve primeira linha visual", () => {
    const ref = resolveVisualLine(0, 2, (i: number) => lines[i] ?? "", 100, measure);
    expect(ref).toBeDefined();
    expect(ref!.docLine).toBe(0);
    expect(ref!.segment.text).toBe("abc");
  });
});

/* ─────────────────────────── malha visual (rows) ─────────────────────────── */

describe("buildVisualRowMap", () => {
  const lines = ["short", "abcdefghijklmnopqrstuvwxyz", "x"];

  it("sem wrap: 1 segmento por linha e a row é o índice lógico", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 0, measure);
    expect(map.segmentsOf(0)).toHaveLength(1);
    expect(map.segmentsOf(0)[0]?.row).toBe(0);
    expect(map.segmentsOf(1)[0]?.row).toBe(1);
    expect(map.segmentsOf(2)[0]?.row).toBe(2);
  });

  it("com wrap: 1 row por segmento", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure);
    const segs = map.segmentsOf(1);
    // 26 chars × 10px = 260px → 3 segmentos (10, 10, 6).
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.row)).toEqual([1, 2, 3]);
    expect(segs.map((s) => s.text)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
    expect(segs.map((s) => s.start)).toEqual([0, 10, 20]);
  });

  it("a row de uma linha é a soma dos segmentos das linhas anteriores", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure);
    const segs0 = map.segmentsOf(0);
    const segs1 = map.segmentsOf(1);
    const segs2 = map.segmentsOf(2);
    expect(segs0).toHaveLength(1);
    expect(segs1[0]?.row).toBe(segs0.length);
    expect(segs2[0]?.row).toBe(segs0.length + segs1.length);
  });

  it("firstRow desloca a base da faixa (rolagem em rows visuais)", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure, { firstRow: 10 });
    expect(map.firstRow).toBe(10);
    expect(map.segmentsOf(0)[0]?.row).toBe(10);
    expect(map.segmentsOf(1)[0]?.row).toBe(11);
  });

  it("locate devolve a row do segmento e a coluna dentro dele", () => {
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure);
    // Coluna 15 → 2º segmento (rows 1..2), 5 colunas dentro dele.
    const loc = map.locate(1, 15);
    expect(loc?.row).toBe(2);
    expect(loc?.segmentOffset).toBe(10);
    expect(loc?.column).toBe(5);
    // Coluna 0 → 1º segmento.
    expect(map.locate(1, 0)?.row).toBe(1);
    expect(map.locate(1, 0)?.column).toBe(0);
  });

  it("linha colapsada: 0 rows, não é desenhada e não tem nada a pintar", () => {
    const collapsed = new Set([1]);
    const map = buildVisualRowMap(sourceOf(lines), 0, lines.length, 100, measure, { collapsedLines: collapsed });
    // A linha colapsada não é desenhada…
    expect(map.segmentsOf(1)).toHaveLength(0);
    // … e não tem row (a regra única: linha colapsada = 0 rows).
    expect(map.rowOfLine(1)).toBeUndefined();
    // A linha seguinte **sobe** (a colapsada ocuparia 3 rows).
    expect(map.segmentsOf(2)[0]?.row).toBe(1);
    // Caret/seleção/busca também não têm onde desenhar na linha colapsada.
    expect(map.segmentsOf(1)).toHaveLength(0);
  });

  it("linha fora da faixa não tem segmentos", () => {
    const map = buildVisualRowMap(sourceOf(lines), 1, 1, 100, measure);
    expect(map.segmentsOf(0)).toHaveLength(0);
    expect(map.locate(0, 0)).toBeUndefined();
  });
});

describe("visualRowOf", () => {
  const lines = ["short", "abcdefghijklmnopqrstuvwxyz", "x"];

  it("a row de uma linha = soma dos segmentos das linhas anteriores", () => {
    // Linha 0 → 1 row (50px cabe) · linha 1 → 3 rows (260px) ⇒ a linha 2 começa na row 4.
    expect(visualRowOf(sourceOf(lines), 1, 100, measure).row).toBe(1);
    expect(visualRowOf(sourceOf(lines), 2, 100, measure).row).toBe(4);
  });

  it("devolve o deslocamento dentro do segmento", () => {
    const loc = visualRowOf(sourceOf(lines), 1, 100, measure, 15);
    expect(loc.row).toBe(2);
    expect(loc.segmentOffset).toBe(10);
    expect(loc.column).toBe(5);
  });

  it("sem wrap: a row é o índice lógico e o segmento é a linha inteira", () => {
    const loc = visualRowOf(sourceOf(lines), 2, 0, measure, 1);
    expect(loc.row).toBe(2);
    expect(loc.segmentOffset).toBe(0);
    expect(loc.column).toBe(1);
  });
});

describe("VisualRowIndex", () => {
  const lines = ["short", "abcdefghijklmnopqrstuvwxyz", "x"];

  it("rowOfLine/lineOfRow são inversos", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.rowOfLine(0)).toBe(0);
    expect(index.rowOfLine(1)).toBe(1);
    expect(index.rowOfLine(2)).toBe(4);
    expect(index.rowCount).toBe(5);
    expect(index.lineOfRow(0)).toBe(0);
    expect(index.lineOfRow(1)).toBe(1);
    expect(index.lineOfRow(2)).toBe(1);
    expect(index.lineOfRow(3)).toBe(1);
    expect(index.lineOfRow(4)).toBe(2);
  });

  it("locate devolve a row e a coluna dentro do segmento", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    const loc = index.locate(1, 15);
    expect(loc?.row).toBe(2);
    expect(loc?.column).toBe(5);
  });

  it("invalidate descarta o cache a partir de uma linha", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.rowOfLine(2)).toBe(4);
    index.invalidate(1);
    expect(index.rowOfLine(2)).toBe(4);
  });

  it("invalidate preserva o prefixo (as linhas anteriores ficam em cache)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    const segs0 = index.segmentsOf(0);
    const segs1 = index.segmentsOf(1);
    index.invalidate(1);
    // A linha 0 (o prefixo) continua em cache — a mesma instância (não foi descartada).
    expect(index.segmentsOf(0)).toBe(segs0);
    // A linha 1 foi invalidada (o texto dela pode ter mudado) — outra instância.
    expect(index.segmentsOf(1)).not.toBe(segs1);
  });

  it("linha inexistente não localiza nada", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.locate(99, 0)).toBeUndefined();
  });
});

/* ─────────────────────────── folding (linhas colapsadas) ─────────────────────────── */

describe("collapsedLinesOf", () => {
  it("sem folding: nenhuma linha colapsada", () => {
    expect(collapsedLinesOf(undefined).size).toBe(0);
    expect(collapsedLinesOf([]).size).toBe(0);
  });

  it("as linhas internas do bloco dobrado colapsam (a 1ª permanece visível)", () => {
    const collapsed = collapsedLinesOf([
      { startLine: 3, endLine: 5, isCollapsed: true },
      { startLine: 8, endLine: 9, isCollapsed: false },
    ]);
    expect([...collapsed].sort((a, b) => a - b)).toEqual([4, 5]);
  });
});

describe("VisualRowIndex — linhas colapsadas (folding)", () => {
  /** A linha 1 quebra em 3 rows (26 chars × 10px = 260px). */
  const lines = ["a", "b".repeat(26), "c"];

  it("a linha colapsada ocupa 0 rows (a regra única)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1]));
    // Linha 0 → row 0 · linha 1 (colapsada) → **0 rows** · linha 2 → row 1.
    expect(index.rowOfLine(2)).toBe(1);
    expect(index.segmentsOf(1)).toHaveLength(0);
    expect(index.rowCount).toBe(2);
  });

  it("sem as colapsadas, a linha quebrada ocupa N rows", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.rowOfLine(1)).toBe(1);
    expect(index.rowOfLine(2)).toBe(4);
    expect(index.rowCount).toBe(5);
  });

  it("trocar o conjunto de colapsadas invalida a partir da 1ª linha afetada", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.rowOfLine(2)).toBe(4);
    index.setCollapsedLines(new Set([1]));
    expect(index.rowOfLine(2)).toBe(1);
    // Idempotente: o mesmo conjunto não invalida nada.
    index.setCollapsedLines(new Set([1]));
    expect(index.rowOfLine(2)).toBe(1);
    // Voltar a colapsar nada devolve a contagem original.
    index.setCollapsedLines(undefined);
    expect(index.rowOfLine(2)).toBe(4);
  });

  it("lineOfRow nunca devolve uma linha colapsada", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1]));
    // As rows do documento: linha 0 → row 0, linha 2 → row 1.
    expect(index.rowCount).toBe(2);
    expect(index.lineOfRow(0)).toBe(0);
    expect(index.lineOfRow(1)).toBe(2); // a row 1 é a da linha 2 (a colapsada não tem row)
  });

  it("round-trip: lineOfRow(rowOfLine(L)) === L para as linhas visíveis", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1]));
    expect(index.lineOfRow(index.rowOfLine(0))).toBe(0);
    expect(index.lineOfRow(index.rowOfLine(2))).toBe(2);
  });

  it("regressão: sem folding, tudo como antes", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.rowOfLine(0)).toBe(0);
    expect(index.rowOfLine(1)).toBe(1);
    expect(index.rowOfLine(2)).toBe(4);
    expect(index.rowCount).toBe(5);
    expect(index.lineOfRow(4)).toBe(2);
  });
});

describe("VisualRowIndex — isCollapsed (a forma canônica de saber se a linha colapsou)", () => {
  const lines = ["a", "b".repeat(26), "c"];

  it("diz se a linha está colapsada (e só ela)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.isCollapsed(0)).toBe(false);
    expect(index.isCollapsed(1)).toBe(false);
    index.setCollapsedLines(new Set([1]));
    expect(index.isCollapsed(1)).toBe(true);
    expect(index.isCollapsed(0)).toBe(false);
    expect(index.isCollapsed(2)).toBe(false);
  });

  it("sem folding: nenhuma linha está colapsada", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    expect(index.isCollapsed(0)).toBe(false);
    expect(index.isCollapsed(1)).toBe(false);
    // Nem depois de um `setCollapsedLines(undefined)`.
    index.setCollapsedLines(new Set([1]));
    index.setCollapsedLines(undefined);
    expect(index.isCollapsed(1)).toBe(false);
  });

  it("é idempotente e barato (não invalida nem re-quebra nada)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1]));
    const before = index.rowCount;
    const segs = index.segmentsOf(2);
    expect(index.isCollapsed(1)).toBe(true);
    expect(index.isCollapsed(1)).toBe(true);
    expect(index.rowCount).toBe(before);
    expect(index.segmentsOf(2)).toBe(segs);
  });

  it("a regra unificada: rowOfLine(colapsada) = a row que ela ocuparia (a próxima visível)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1]));
    // A linha 1 está colapsada ⇒ `rowOfLine` devolve a row que ela ocuparia — a da
    // próxima linha visível (a 2, que está na row 1). Quem não perguntar `isCollapsed`
    // **cai na linha seguinte**.
    expect(index.isCollapsed(1)).toBe(true);
    expect(index.rowOfLine(1)).toBe(index.rowOfLine(2));
    expect(index.rowOfLine(1)).toBe(1);
  });
});

describe("VisualRowIndex — dobra no fim do documento", () => {
  /** A dobra pega as duas últimas linhas (3 e 4): a 2 é a última **visível**. */
  const lines = ["a", "b", "c", "d", "e"];
  const collapsed = new Set([3, 4]);

  it("as linhas colapsadas do fim não contam row", () => {
    const index = new VisualRowIndex(sourceOf(lines), 0, measure);
    index.setCollapsedLines(collapsed);
    // As linhas 0, 1 e 2 são visíveis ⇒ 3 rows.
    expect(index.rowCount).toBe(3);
    expect(index.rowOfLine(2)).toBe(2);
  });

  it("rowOfLine de uma colapsada do fim = a row que ela ocuparia (a última row)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 0, measure);
    index.setCollapsedLines(collapsed);
    // A linha 3 ocuparia a row 3 e a 4 também (0 rows cada uma) — a row 3 é a **última**
    // row do documento colapsado (rowCount = 3 ⇒ as rows válidas são 0..2).
    expect(index.rowOfLine(3)).toBe(3);
    expect(index.rowOfLine(4)).toBe(3);
    expect(index.isCollapsed(3)).toBe(true);
    expect(index.isCollapsed(4)).toBe(true);
  });

  it("lineOfRow devolve a última linha visível (nunca uma colapsada)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 0, measure);
    index.setCollapsedLines(collapsed);
    expect(index.lineOfRow(0)).toBe(0);
    expect(index.lineOfRow(1)).toBe(1);
    expect(index.lineOfRow(2)).toBe(2);
    // Row além do documento (ou a row que as colapsadas ocupariam): a última visível.
    expect(index.lineOfRow(3)).toBe(2);
    expect(index.lineOfRow(99)).toBe(2);
    expect(index.isCollapsed(index.lineOfRow(3))).toBe(false);
  });

  it("round-trip: lineOfRow(rowOfLine(L)) === L para as linhas visíveis", () => {
    const index = new VisualRowIndex(sourceOf(lines), 0, measure);
    index.setCollapsedLines(collapsed);
    for (const line of [0, 1, 2]) {
      expect(index.lineOfRow(index.rowOfLine(line))).toBe(line);
    }
  });
});

describe("VisualRowIndex — várias dobras", () => {
  /**
   * 6 linhas: a 1 e a 4 quebram em 3 rows (26 chars × 10px) e estão **colapsadas**
   * (as dobras 0..1 e 3..4) ⇒ sobram 4 rows visíveis (as linhas 0, 2, 3 e 5).
   */
  const lines = ["a", "b".repeat(26), "c", "d", "e".repeat(26), "f"];

  it("a contagem soma só as linhas visíveis", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1, 4]));
    expect(index.rowCount).toBe(4);
  });

  it("rowOfLine: as colapsadas devolvem a row que ocupariam", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1, 4]));
    // Linhas visíveis: 0 → row 0 · 2 → row 1 · 3 → row 2 · 5 → row 3.
    expect(index.rowOfLine(0)).toBe(0);
    expect(index.rowOfLine(2)).toBe(1);
    expect(index.rowOfLine(3)).toBe(2);
    expect(index.rowOfLine(5)).toBe(3);
    // As colapsadas (1 e 4) devolvem a row da próxima visível.
    expect(index.rowOfLine(1)).toBe(index.rowOfLine(2));
    expect(index.rowOfLine(4)).toBe(index.rowOfLine(5));
    expect(index.isCollapsed(1)).toBe(true);
    expect(index.isCollapsed(4)).toBe(true);
  });

  it("lineOfRow: cada row pertence a uma linha visível (nunca a uma colapsada)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1, 4]));
    expect(index.lineOfRow(0)).toBe(0);
    expect(index.lineOfRow(1)).toBe(2);
    expect(index.lineOfRow(2)).toBe(3);
    expect(index.lineOfRow(3)).toBe(5);
    // Nenhuma delas é colapsada.
    for (const row of [0, 1, 2, 3]) {
      expect(index.isCollapsed(index.lineOfRow(row))).toBe(false);
    }
  });

  it("round-trip nas linhas visíveis (com várias dobras)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1, 4]));
    for (const line of [0, 2, 3, 5]) {
      expect(index.lineOfRow(index.rowOfLine(line))).toBe(line);
    }
  });
});

describe("applyCollapsedLines (a ordem: folding **antes** de publicar a contagem)", () => {
  /** A linha 1 quebra em 3 rows (26 chars × 10px = 260px) e está dentro da dobra. */
  const lines = ["a", "b".repeat(26), "c"];
  const folding = [{ startLine: 0, endLine: 1, isCollapsed: true }];

  it("aplica o folding ao índice e devolve as linhas colapsadas", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    const collapsed = applyCollapsedLines(index, folding);
    expect([...collapsed]).toEqual([1]);
    expect(index.rowCount).toBe(2);
  });

  it("a contagem publicada só bate com o desenhado **depois** do helper", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    // ⚠️ Sem o helper, a contagem ainda não conhece a dobra (o bug de ordem: a linha dobrada
    // de 3 rows ainda reservaria 3 rows ⇒ a contagem bate em N, mas o desenho ocupa N−1).
    expect(index.rowCount).toBe(5);
    // O helper (o que o renderer chama **antes** de publicar) alinha os dois.
    applyCollapsedLines(index, folding);
    expect(index.rowCount).toBe(2);
  });

  it("é idempotente (o mesmo folding não invalida nada)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    applyCollapsedLines(index, folding);
    const before = index.rowOfLine(2);
    applyCollapsedLines(index, folding);
    applyCollapsedLines(index, folding);
    expect(index.rowOfLine(2)).toBe(before);
    expect(index.rowCount).toBe(2);
  });

  it("sem folding: o helper não muda nada", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    const collapsed = applyCollapsedLines(index, undefined);
    expect(collapsed.size).toBe(0);
    expect(index.rowCount).toBe(5);
  });

  it("funciona sem índice (devolve só o conjunto de colapsadas)", () => {
    const collapsed = applyCollapsedLines(undefined, folding);
    expect([...collapsed]).toEqual([1]);
  });
});

describe("buildVisualRowMapFromIndex", () => {
  const lines = ["short", "abcdefghijklmnopqrstuvwxyz", "x"];

  it("reusa os segmentos do índice (a row é a do índice)", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    const map = buildVisualRowMapFromIndex(index, 0, lines.length);
    expect(map.segmentsOf(1)).toHaveLength(3);
    expect(map.segmentsOf(1).map((s) => s.row)).toEqual([1, 2, 3]);
    expect(map.locate(1, 15)?.row).toBe(2);
    expect(map.locate(1, 15)?.column).toBe(5);
  });

  it("a linha colapsada não é desenhada e não ocupa row", () => {
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    index.setCollapsedLines(new Set([1]));
    const map = buildVisualRowMapFromIndex(index, 0, lines.length, new Set([1]));
    expect(map.segmentsOf(1)).toHaveLength(0);
    // A linha colapsada não tem row (a regra única).
    expect(map.rowOfLine(1)).toBeUndefined();
    // A linha seguinte **sobe** (a colapsada ocuparia 3 rows).
    expect(map.segmentsOf(2)[0]?.row).toBe(1);
  });

  it("o conjunto de colapsadas é a autoridade (mesmo sem o índice sabê-las)", () => {
    // Um índice que **não** sabe de folding (sem `setCollapsedLines`) ainda não desenha a
    // linha colapsada: a cena decide com o próprio conjunto.
    const index = new VisualRowIndex(sourceOf(lines), 100, measure);
    const map = buildVisualRowMapFromIndex(index, 0, lines.length, new Set([1]));
    expect(map.segmentsOf(1)).toHaveLength(0);
  });
});