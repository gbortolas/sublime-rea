/**
 * Scribe — testes do **painel de problemas** (`src/renderer/problems-panel.ts`).
 *
 * O renderer não tem DOM no ambiente de teste (`node`, sem jsdom) ⇒ a **lógica pura** que o
 * painel extraiu é testada sem DOM (agrupamento por arquivo, ordem, filtro, contagens) e o
 * **DOM** é testado contra o **DOM falso** compartilhado (`test/helpers/fake-dom.ts`).
 *
 * O DOM prova: a lista é desenhada, o clique num diagnóstico avisa o `onJump` e o painel
 * escondido **não** redesenha.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { LspDiagnostic } from "../src/shared";
import {
  ProblemsModel,
  countSeverities,
  formatLocation,
  groupByFile,
  matchesQuery,
  mountProblemsPanel,
  problemEntries,
  severityLabel,
  severityRank,
  toProblemItem,
} from "../src/renderer/problems-panel";
import {
  byClass,
  FakeElement,
  firstByClass,
  installFakeDom,
  uninstallFakeDom,
} from "./helpers/fake-dom";

function diag(
  severity: LspDiagnostic["severity"],
  message: string,
  line = 0,
  col = 0,
  source = "ts",
): LspDiagnostic {
  return {
    range: { startLine: line, startCol: col, endLine: line, endCol: col + 1 },
    severity,
    message,
    source,
  };
}

function entry(path: string, severity: LspDiagnostic["severity"], message: string, line = 0, col = 0) {
  return { path, diagnostic: diag(severity, message, line, col) };
}

describe("agrupamento por arquivo", () => {
  it("agrupa os diagnósticos pelo arquivo e conta cada um", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      ...problemEntries("/w/a.ts", [diag("error", "erro em a")]),
      ...problemEntries("/w/b.ts", [diag("warning", "aviso em b")]),
      ...problemEntries("/w/a.ts", [diag("info", "info em a")]),
    ]);
    const groups = model.groups;
    expect(groups).toHaveLength(2);
    expect(groups[0]?.path).toBe("/w/a.ts");
    expect(groups[0]?.name).toBe("a.ts");
    expect(groups[0]?.count).toBe(2);
    expect(groups[1]?.path).toBe("/w/b.ts");
    expect(groups[1]?.count).toBe(1);
  });

  it("o nome do grupo é o basename do caminho", () => {
    const groups = groupByFile([toProblemItem(entry("/w/pasta/arquivo.ts", "error", "x"))]);
    expect(groups[0]?.name).toBe("arquivo.ts");
  });

  it("sem diagnósticos não há grupo nenhum", () => {
    const model = new ProblemsModel();
    expect(model.groups).toEqual([]);
  });
});

describe("ordem — o erro vem antes do aviso", () => {
  it("ordena os itens por severidade, depois por arquivo/linha", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      entry("/w/a.ts", "warning", "aviso"),
      entry("/w/b.ts", "error", "erro"),
    ]);
    expect(model.items.map((item) => item.severity)).toEqual(["error", "warning"]);
    expect(model.items[0]?.path).toBe("/w/b.ts");
  });

  it("dentro do arquivo o erro vem antes e os avisos por linha", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      entry("/w/a.ts", "warning", "aviso", 10),
      entry("/w/a.ts", "error", "erro", 5),
    ]);
    const items = model.groups[0]?.items ?? [];
    expect(items.map((item) => `${item.severity}:${item.line}`)).toEqual(["error:5", "warning:10"]);
  });

  it("o grupo com erro vem antes do grupo que só tem avisos", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      entry("/w/a.ts", "warning", "aviso"),
      entry("/w/b.ts", "error", "erro"),
    ]);
    expect(model.groups.map((group) => group.path)).toEqual(["/w/b.ts", "/w/a.ts"]);
  });

  it("empatando a severidade, o grupo é ordenado pelo caminho", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([entry("/w/z.ts", "error", "z"), entry("/w/a.ts", "error", "a")]);
    expect(model.groups.map((group) => group.path)).toEqual(["/w/a.ts", "/w/z.ts"]);
  });

  it("o rank das severidades vai do mais grave ao mais leve", () => {
    expect(severityRank("error")).toBeLessThan(severityRank("warning"));
    expect(severityRank("warning")).toBeLessThan(severityRank("info"));
    expect(severityRank("info")).toBeLessThan(severityRank("hint"));
    expect(severityLabel("error")).toBe("Erro");
  });
});

describe("filtro — case-insensitive, na mensagem e no caminho", () => {
  it("casa na mensagem sem diferenciar maiúsculas", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      entry("/w/a.ts", "error", "Identifier is not defined"),
      entry("/w/a.ts", "error", "outro erro"),
    ]);
    model.setFilter("identifier");
    expect(model.visibleItems).toHaveLength(1);
    expect(model.visibleItems[0]?.message).toBe("Identifier is not defined");
  });

  it("casa no caminho sem diferenciar maiúsculas", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      entry("/w/Alpha.ts", "error", "x"),
      entry("/w/beta.ts", "error", "y"),
    ]);
    model.setFilter("alpha");
    expect(model.visibleItems).toHaveLength(1);
    expect(model.visibleItems[0]?.path).toBe("/w/Alpha.ts");
  });

  it("`filter` é puro: não muda o estado do modelo", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([entry("/w/a.ts", "error", "erro"), entry("/w/a.ts", "info", "info")]);
    const filtrado = model.filter("erro");
    expect(filtrado).toHaveLength(1);
    expect(model.visibleItems).toHaveLength(2);
    expect(model.filterQuery).toBe("");
  });

  it("o filtro também vale para o caminho completo (o diretório conta)", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([entry("/w/pasta/a.ts", "error", "x"), entry("/w/b.ts", "error", "y")]);
    model.setFilter("pasta");
    expect(model.visibleItems).toHaveLength(1);
  });

  it("filtro em branco ⇒ tudo visível", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([entry("/w/a.ts", "error", "x")]);
    model.setFilter("   ");
    expect(model.visibleItems).toHaveLength(1);
  });

  it("`matchesQuery` é a regra crua do filtro", () => {
    const item = toProblemItem(entry("/w/a.ts", "error", "Erro de tipo"));
    expect(matchesQuery(item, "erro")).toBe(true);
    expect(matchesQuery(item, "ERRO")).toBe(true);
    expect(matchesQuery(item, "/W/A")).toBe(true);
    expect(matchesQuery(item, "inexistente")).toBe(false);
  });
});

describe("contagens por severidade", () => {
  it("conta erro/aviso/info/dica e o total", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      entry("/w/a.ts", "error", "e1"),
      entry("/w/a.ts", "error", "e2"),
      entry("/w/a.ts", "warning", "w"),
      entry("/w/a.ts", "info", "i"),
      entry("/w/a.ts", "hint", "h"),
    ]);
    expect(model.counts).toEqual({ error: 2, warning: 1, info: 1, hint: 1, total: 5 });
  });

  it("`visibleCounts` é a contagem do que está visível (após o filtro)", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([
      entry("/w/a.ts", "error", "erro"),
      entry("/w/a.ts", "warning", "aviso"),
    ]);
    model.setFilter("erro");
    expect(model.counts.total).toBe(2);
    expect(model.visibleCounts).toEqual({ error: 1, warning: 0, info: 0, hint: 0, total: 1 });
  });

  it("`countSeverities` conta uma lista qualquer", () => {
    const items = [
      toProblemItem(entry("/w/a.ts", "hint", "h")),
      toProblemItem(entry("/w/a.ts", "error", "e")),
    ];
    expect(countSeverities(items)).toEqual({ error: 1, warning: 0, info: 0, hint: 1, total: 2 });
    expect(countSeverities([])).toEqual({ error: 0, warning: 0, info: 0, hint: 0, total: 0 });
  });
});

describe("estado vazio", () => {
  it("sem diagnósticos a lista visível é vazia", () => {
    const model = new ProblemsModel();
    expect(model.visibleItems).toEqual([]);
    expect(model.groups).toEqual([]);
    expect(model.counts.total).toBe(0);
  });

  it("`clear` esvazia o modelo", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([entry("/w/a.ts", "error", "x")]);
    model.clear();
    expect(model.visibleItems).toEqual([]);
    expect(model.counts.total).toBe(0);
  });

  it("um filtro que não casa deixa a lista visível vazia", () => {
    const model = new ProblemsModel();
    model.setDiagnostics([entry("/w/a.ts", "error", "x")]);
    model.setFilter("não casa");
    expect(model.visibleItems).toEqual([]);
    expect(model.groups).toEqual([]);
    expect(model.visibleCounts.total).toBe(0);
  });
});

describe("degradação — sem DOM o painel não explode", () => {
  beforeAll(() => {
    uninstallFakeDom();
  });

  afterAll(() => {
    uninstallFakeDom();
  });

  it("sem host devolve um handle inerte que não lança", () => {
    const handle = mountProblemsPanel(null, {});
    expect(() => {
      handle.update([entry("/w/a.ts", "error", "x")]);
      handle.setFilter("x");
      handle.dispose();
    }).not.toThrow();
  });

  it("sem DOM (o `document` não existe) o handle ainda guarda o estado", () => {
    const handle = mountProblemsPanel(undefined, {});
    handle.update([entry("/w/a.ts", "error", "erro"), entry("/w/a.ts", "warning", "aviso")]);
    expect(handle.model.counts.total).toBe(2);
    expect(handle.model.visibleItems).toHaveLength(2);
    handle.setFilter("erro");
    expect(handle.model.visibleItems).toHaveLength(1);
  });

  it("um host que não é um elemento do DOM também degruda", () => {
    const host = {} as unknown as HTMLElement;
    const handle = mountProblemsPanel(host, {});
    expect(() => {
      handle.update([entry("/w/a.ts", "error", "x")]);
    }).not.toThrow();
    expect(handle.model.counts.total).toBe(1);
    expect(() => {
      handle.dispose();
    }).not.toThrow();
  });
});

describe("formatação", () => {
  it("a localização é `arquivo:linha:coluna` em 1-based", () => {
    const item = toProblemItem(entry("/w/pasta/a.ts", "error", "x", 4, 2));
    expect(formatLocation(item)).toBe("a.ts:5:3");
  });

  it("o item guarda a posição 0-based (a convenção do core)", () => {
    const item = toProblemItem(entry("/w/a.ts", "error", "x", 4, 2));
    expect(item.line).toBe(4);
    expect(item.column).toBe(2);
  });
});

describe("mountProblemsPanel — com DOM (o DOM falso compartilhado)", () => {
  let host: FakeElement;

  beforeAll(() => {
    installFakeDom();
  });

  afterAll(() => {
    uninstallFakeDom();
  });

  beforeEach(() => {
    host = new FakeElement("div");
  });

  /** Monta o painel no host falso e devolve o root. */
  function mount(
    options: Parameters<typeof mountProblemsPanel>[1] = {},
  ): { root: FakeElement; handle: ReturnType<typeof mountProblemsPanel> } {
    const handle = mountProblemsPanel(host as unknown as HTMLElement, options);
    const root = host.children[0];
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("painel não montado");
    return { root, handle };
  }

  it("desenha um grupo por arquivo, com os itens e a contagem", () => {
    const { root, handle } = mount();
    handle.update([
      entry("/w/a.ts", "error", "erro em a", 2, 4),
      entry("/w/a.ts", "warning", "aviso em a", 1, 0),
    ]);
    expect(byClass(root, "problems-group")).toHaveLength(1);
    expect(byClass(root, "problems-item")).toHaveLength(2);
    expect(firstByClass(root, "problems-group-name")?.textContent).toBe("a.ts");
    expect(firstByClass(root, "problems-group-count")?.textContent).toBe("2");
    // A contagem do cabeçalho: 1 erro + 1 aviso.
    expect(byClass(root, "problems-count")).toHaveLength(2);
  });

  it("o clique num diagnóstico avisa o `onJump` (arquivo, linha e coluna 0-based)", () => {
    const saltos: Array<[string, number, number]> = [];
    const { root, handle } = mount({
      onJump: (file: string, line: number, column: number) => saltos.push([file, line, column]),
    });
    handle.update([entry("/w/a.ts", "error", "erro em a", 7, 3)]);
    (firstByClass(root, "problems-item-button") as FakeElement).dispatch("click");
    expect(saltos).toEqual([["/w/a.ts", 7, 3]]);
  });

  it("o filtro do painel esconde os itens que não casam", () => {
    const { root, handle } = mount();
    handle.update([
      entry("/w/a.ts", "error", "erro em a"),
      entry("/w/b.ts", "error", "erro em b"),
    ]);
    expect(byClass(root, "problems-item")).toHaveLength(2);

    const filtro = firstByClass(root, "problems-panel-filter") as FakeElement;
    filtro.value = "b.ts";
    filtro.dispatch("input");

    expect(byClass(root, "problems-item")).toHaveLength(1);
    expect(firstByClass(root, "problems-item-message")?.textContent).toBe("erro em b");
  });

  it("sem diagnóstico a lista mostra o estado vazio", () => {
    const { root, handle } = mount();
    handle.update([]);
    expect(firstByClass(root, "problems-panel-empty")?.textContent).toBe("Nenhum problema");
  });

  it("com o host escondido o painel não redesenha (e desenha quando volta)", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update([entry("/w/a.ts", "error", "erro em a")]);

    // Escondido ⇒ a lista não foi desenhada…
    expect(byClass(root, "problems-item")).toHaveLength(0);
    // …mas o estado está no modelo.
    expect(handle.model.counts.total).toBe(1);

    // O host volta a aparecer ⇒ o painel redesenha (sem precisar de outro `update`).
    host.hidden = false;
    expect(byClass(root, "problems-item")).toHaveLength(1);
  });

  it("o próximo `update` com o host visível também desenha", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update([entry("/w/a.ts", "error", "erro em a")]);
    expect(byClass(root, "problems-item")).toHaveLength(0);

    host.hidden = false;
    handle.update([entry("/w/a.ts", "error", "erro em a")]);
    expect(byClass(root, "problems-item")).toHaveLength(1);
  });
});
