/**
 * Scribe — testes do **painel de busca na workspace** (`src/renderer/search-panel.ts`).
 *
 * O renderer não tem DOM no ambiente de teste (`node`) ⇒ o que se testa aqui é a
 * **lógica pura** que o painel extraiu: o agrupamento por arquivo, a descrição do estado
 * (buscando / N resultados em M arquivos / nada encontrado / truncado) e os **toggles**
 * de regex/case/binários (a parte de DOM degrada sem quebrar — ela é verificada pelo smoke test).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GrepMatch, GrepResult } from "../src/core/workspace/grep";
import {
  attachSearchPanel,
  basenameOf,
  DEFAULT_SEARCH_PANEL_FLAGS,
  describeSearchStatus,
  describeToggle,
  groupMatchesByFile,
  toggleFlag,
} from "../src/renderer/search-panel";
import { FakeElement, firstByClass, installFakeDom, uninstallFakeDom } from "./helpers/fake-dom";

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

  it("vazio mas truncado (a busca foi interrompida) ⇒ 'truncated', não 'Nenhum resultado'", () => {
    const status = describeSearchStatus(resultOf([], true), false);
    expect(status.kind).toBe("truncated");
    expect(status.text).toContain("(resultado truncado)");
    expect(status.text).not.toBe("Nenhum resultado");
  });

  it("vazio e não truncado ⇒ continua 'Nenhum resultado' (regressão)", () => {
    const status = describeSearchStatus(resultOf([], false), false);
    expect(status.kind).toBe("empty");
    expect(status.text).toBe("Nenhum resultado");
  });
});

describe("o painel montado — a mensagem que o usuário vê", () => {
  beforeAll(() => {
    // O `instanceof HTMLElement` do painel — o Node não tem o global.
    const globals = globalThis as { HTMLElement?: unknown };
    globals.HTMLElement = FakeElement;
  });

  afterAll(() => {
    uninstallFakeDom();
    const globals = globalThis as { HTMLElement?: unknown };
    delete globals.HTMLElement;
  });

  /**
   * Monta o painel de verdade (contra o **DOM falso** do repo) e devolve a linha de status.
   *
   * @param result O resultado que a busca devolveu.
   */
  function mount(result: GrepResult): FakeElement {
    const doc = installFakeDom();
    const host = new FakeElement("div");
    doc.createElement = (tagName: string): FakeElement => {
      const element = new FakeElement(tagName);
      element.ownerDocument = doc;
      return element;
    };
    const panel = attachSearchPanel(host as unknown as HTMLElement, { onOpen: () => {} });
    panel.setResults(result);
    const status = firstByClass(host, "search-panel-status");
    expect(status).toBeDefined();
    return status!;
  }

  it("a busca interrompida (vazio + truncado) não mente: mostra o truncamento", () => {
    const status = mount({
      matches: [],
      truncated: true,
      filesScanned: 0,
      warnings: ["a busca foi interrompida por tempo (20 s) — o resultado está incompleto"],
    });
    expect(status.textContent).toContain("(resultado truncado)");
    expect(status.textContent).not.toBe("Nenhum resultado");
  });

  it("a busca vazia (sem truncamento) continua 'Nenhum resultado'", () => {
    const status = mount({ matches: [], truncated: false, filesScanned: 12 });
    expect(status.textContent).toBe("Nenhum resultado");
  });
});

describe("os toggles do painel — regex, case e binários", () => {
  it("o default é literal, sem case e sem binários (o default do `grep`)", () => {
    expect(DEFAULT_SEARCH_PANEL_FLAGS).toEqual({
      regex: false,
      caseSensitive: false,
      includeBinary: false,
    });
  });

  it("alterna só a flag pedida", () => {
    const regex = toggleFlag(DEFAULT_SEARCH_PANEL_FLAGS, "regex");
    expect(regex.regex).toBe(true);
    expect(regex.caseSensitive).toBe(false);
    expect(regex.includeBinary).toBe(false);

    const caseSensitive = toggleFlag(DEFAULT_SEARCH_PANEL_FLAGS, "caseSensitive");
    expect(caseSensitive.regex).toBe(false);
    expect(caseSensitive.caseSensitive).toBe(true);
    expect(caseSensitive.includeBinary).toBe(false);

    // O toggle de binários (o item de backlog que **não** tinha toggle na UI).
    const binary = toggleFlag(DEFAULT_SEARCH_PANEL_FLAGS, "includeBinary");
    expect(binary.includeBinary).toBe(true);
    expect(binary.regex).toBe(false);
    expect(binary.caseSensitive).toBe(false);
  });

  it("alterna de volta (o toggle é um interruptor)", () => {
    const once = toggleFlag(DEFAULT_SEARCH_PANEL_FLAGS, "regex");
    const twice = toggleFlag(once, "regex");
    expect(twice).toEqual(DEFAULT_SEARCH_PANEL_FLAGS);
  });

  it("não mexe no objeto original (o estado do painel é imutável)", () => {
    const flags = { ...DEFAULT_SEARCH_PANEL_FLAGS };
    toggleFlag(flags, "caseSensitive");
    toggleFlag(flags, "includeBinary");
    expect(flags).toEqual({ regex: false, caseSensitive: false, includeBinary: false });
  });

  it("descreve o toggle: o rótulo, a dica e o estado", () => {
    expect(describeToggle(DEFAULT_SEARCH_PANEL_FLAGS, "regex")).toEqual({
      id: "regex",
      label: ".*",
      title: "Expressão regular",
      pressed: false,
    });
    expect(describeToggle(DEFAULT_SEARCH_PANEL_FLAGS, "caseSensitive")).toEqual({
      id: "caseSensitive",
      label: "Aa",
      title: "Diferenciar maiúsculas de minúsculas",
      pressed: false,
    });
    expect(describeToggle(DEFAULT_SEARCH_PANEL_FLAGS, "includeBinary")).toEqual({
      id: "includeBinary",
      label: "Bin",
      title: "Incluir arquivos binários",
      pressed: false,
    });
  });

  it("o toggle ligado aparece com `pressed: true`", () => {
    const flags = toggleFlag(toggleFlag(DEFAULT_SEARCH_PANEL_FLAGS, "regex"), "caseSensitive");
    expect(describeToggle(flags, "regex").pressed).toBe(true);
    expect(describeToggle(flags, "caseSensitive").pressed).toBe(true);
    expect(describeToggle(flags, "includeBinary").pressed).toBe(false);
  });
});
