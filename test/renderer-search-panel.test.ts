/**
 * Scribe — testes do **painel de busca na workspace** (`src/renderer/search-panel.ts`).
 *
 * O renderer não tem DOM no ambiente de teste (`node`) ⇒ o que se testa aqui é a
 * **lógica pura** que o painel extraiu: o agrupamento por arquivo e a descrição do estado
 * (buscando / N resultados em M arquivos / nada encontrado / truncado).
 *
 * O DOM em si (criação, foco, clique) é verificado pelo smoke test do app.
 */
import { describe, expect, it } from "vitest";

import type { GrepMatch, GrepResult } from "../src/core/workspace/grep";
import {
  basenameOf,
  describeSearchStatus,
  groupMatchesByFile,
} from "../src/renderer/search-panel";

function match(path: string, line: number, column: number, text = "a linha do arquivo"): GrepMatch {
  return { path, line, column, text };
}

function resultOf(matches: readonly GrepMatch[], truncated = false): GrepResult {
  return { matches, truncated, filesScanned: 2 };
}

describe("groupMatchesByFile — o agrupamento por arquivo", () => {
  it("agrupa as ocorrências por arquivo e conta cada um", () => {
    const groups = groupMatchesByFile([
      match("/w/a.txt", 0, 0),
      match("/w/b.txt", 3, 2),
      match("/w/a.txt", 9, 1),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.path).toBe("/w/a.txt");
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.matches).toHaveLength(2);
    expect(groups[1]?.path).toBe("/w/b.txt");
    expect(groups[1]?.count).toBe(1);
  });

  it("mantém a ordem da 1ª aparição dos arquivos", () => {
    const groups = groupMatchesByFile([
      match("/w/z.txt", 0, 0),
      match("/w/a.txt", 0, 0),
      match("/w/z.txt", 1, 0),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["/w/z.txt", "/w/a.txt"]);
  });

  it("ordena as ocorrências do grupo por (linha, coluna)", () => {
    const groups = groupMatchesByFile([
      match("/w/a.txt", 9, 1),
      match("/w/a.txt", 2, 5),
      match("/w/a.txt", 2, 0),
    ]);
    expect(groups[0]?.matches.map((m) => `${m.line}:${m.column}`)).toEqual(["2:0", "2:5", "9:1"]);
  });

  it("o nome do grupo é o basename do caminho", () => {
    const groups = groupMatchesByFile([match("/w/pasta/arquivo.ts", 0, 0)]);
    expect(groups[0]?.name).toBe("arquivo.ts");
  });

  it("sem ocorrências não há grupo nenhum", () => {
    expect(groupMatchesByFile([])).toEqual([]);
  });
});

describe("basenameOf — o nome do arquivo", () => {
  it("pega o último segmento (caminho unix e windows)", () => {
    expect(basenameOf("/w/pasta/arquivo.ts")).toBe("arquivo.ts");
    expect(basenameOf("C:\\w\\arquivo.ts")).toBe("arquivo.ts");
  });

  it("devolve o próprio caminho quando não há segmento", () => {
    expect(basenameOf("/")).toBe("/");
  });
});

describe("describeSearchStatus — o estado do painel", () => {
  it("buscando", () => {
    const status = describeSearchStatus(undefined, true);
    expect(status.kind).toBe("busy");
    expect(status.text).toBe("Buscando…");
  });

  it("ainda não buscou", () => {
    const status = describeSearchStatus(undefined, false);
    expect(status.kind).toBe("idle");
  });

  it("nada encontrado", () => {
    const status = describeSearchStatus(resultOf([]), false);
    expect(status.kind).toBe("empty");
    expect(status.text).toBe("Nenhum resultado");
  });

  it("N resultados em M arquivos", () => {
    const status = describeSearchStatus(
      resultOf([match("/w/a.txt", 0, 0), match("/w/a.txt", 1, 0), match("/w/b.txt", 0, 0)]),
      false,
    );
    expect(status.kind).toBe("results");
    expect(status.total).toBe(3);
    expect(status.files).toBe(2);
    expect(status.text).toBe("3 resultados em 2 arquivos");
  });

  it("o singular (1 resultado em 1 arquivo)", () => {
    const status = describeSearchStatus(resultOf([match("/w/a.txt", 0, 0)]), false);
    expect(status.text).toBe("1 resultado em 1 arquivo");
  });

  it("truncado", () => {
    const status = describeSearchStatus(resultOf([match("/w/a.txt", 0, 0)], true), false);
    expect(status.kind).toBe("truncated");
    expect(status.text).toBe("1 resultado em 1 arquivo (resultado truncado)");
  });
});
