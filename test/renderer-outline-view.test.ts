/**
 * Scribe — testes do **Outline** (`src/renderer/outline-view.ts`).
 *
 * O vitest roda em `environment: "node"` (sem jsdom), então a parte **pura** é testada sem
 * DOM (o `OutlineModel` e as funções de achatamento/filtro/classificação) e o **DOM** é
 * testado contra o **DOM falso** compartilhado (`test/helpers/fake-dom.ts`).
 *
 * O que travamos aqui:
 * - o achatamento produz `depth` 0-based (e reconstrói os pais pela profundidade);
 * - o filtro é case-insensitive e **um pai que casa traz os filhos** (regra do VS Code);
 * - a navegação faz **wrap** (último ⇒ primeiro, primeiro ⇒ último);
 * - cada `SymbolKind` cai num grupo e num rótulo curto;
 * - o estado vazio distingue "sem símbolos", "sem LSP" e "filtro sem resultado";
 * - o painel **escondido** não redesenha (o Outline redesenha a cada edição do documento);
 * - sem DOM, nada quebra.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OutlineModel,
  describeOutlineEmpty,
  flattenOutlineSymbols,
  flatSymbolDepth,
  groupOutlineByKind,
  mountOutlineView,
  outlineSymbolGroup,
  outlineSymbolLabel,
  outlineSymbolMeta,
  type OutlineSymbolInput,
  type OutlineSymbolRange,
} from "../src/renderer/outline-view";
import type { LspDocumentSymbol } from "../src/shared";
import {
  byClass,
  FakeElement,
  firstByClass,
  installFakeDom,
  uninstallFakeDom,
} from "./helpers/fake-dom";

// `SymbolKind` do LSP (valores numéricos, como no protocolo).
const KIND = {
  file: 1,
  module: 2,
  class: 5,
  method: 6,
  property: 7,
  constructor: 9,
  enum: 10,
  interface: 11,
  function: 12,
  variable: 13,
  constant: 14,
  struct: 23,
  event: 24,
} as const;

function range(startLine: number, startCol = 0, endLine = startLine, endCol = 0): OutlineSymbolRange {
  return { startLine, startCol, endLine, endCol };
}

/** Árvore de exemplo: classe com propriedade, método (com filho) e uma constante. */
const TREE: readonly OutlineSymbolInput[] = [
  {
    name: "Pessoa",
    kind: KIND.class,
    range: range(0),
    children: [
      { name: "nome", kind: KIND.property, range: range(2, 2) },
      {
        name: "saudar",
        kind: KIND.method,
        range: range(4, 4),
        children: [{ name: "ajuda", kind: KIND.variable, range: range(5, 8) }],
      },
    ],
  },
  { name: "TOTAL", kind: KIND.constant, range: range(9) },
];

describe("flattenOutlineSymbols — achatamento com depth", () => {
  it("achata a hierarquia e numera a profundidade a partir de 0", () => {
    const nodes = flattenOutlineSymbols(TREE);
    expect(nodes.map((node) => node.name)).toEqual(["Pessoa", "nome", "saudar", "ajuda", "TOTAL"]);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 1, 2, 0]);
  });

  it("carrega a posição do símbolo (0-based) e o fim do range", () => {
    const nodes = flattenOutlineSymbols(TREE);
    const saudar = nodes.find((node) => node.name === "saudar");
    expect(saudar?.line).toBe(4);
    expect(saudar?.column).toBe(4);
    const ajuda = nodes.find((node) => node.name === "ajuda");
    expect(ajuda?.line).toBe(5);
    expect(ajuda?.column).toBe(8);
  });

  it("marca os nós que têm filhos", () => {
    const nodes = flattenOutlineSymbols(TREE);
    expect(nodes.find((node) => node.name === "Pessoa")?.hasChildren).toBe(true);
    expect(nodes.find((node) => node.name === "saudar")?.hasChildren).toBe(true);
    expect(nodes.find((node) => node.name === "TOTAL")?.hasChildren).toBe(false);
  });

  it("aceita a lista achatada (profundidade codificada no detail)", () => {
    const flat: readonly OutlineSymbolInput[] = [
      { name: "Pessoa", kind: KIND.class, range: range(0), detail: "class Pessoa" },
      { name: "nome", kind: KIND.property, range: range(2), detail: "·" },
      { name: "ajuda", kind: KIND.variable, range: range(5), detail: "··" },
    ];
    const nodes = flattenOutlineSymbols(flat);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 2]);
  });

  it("o '·' do detail achatado não vaza como detalhe do símbolo", () => {
    const flat: readonly OutlineSymbolInput[] = [
      { name: "nome", kind: KIND.property, range: range(2), detail: "·" },
    ];
    expect(flattenOutlineSymbols(flat)[0]?.detail).toBeUndefined();
  });

  it("flatSymbolDepth só conta o detail que é só '·'", () => {
    expect(flatSymbolDepth({ detail: "·" })).toBe(1);
    expect(flatSymbolDepth({ detail: "··" })).toBe(2);
    expect(flatSymbolDepth({ detail: "class Pessoa" })).toBe(0);
    expect(flatSymbolDepth({})).toBe(0);
  });

  it("na lista achatada, os pais são reconstruídos pela profundidade", () => {
    // A lista achatada do bridge: a ordem é pai→filho e a profundidade vem do `detail`.
    const flat: readonly OutlineSymbolInput[] = [
      { name: "A", kind: KIND.class, range: range(0) },
      { name: "B", kind: KIND.method, range: range(2), detail: "·" },
      { name: "C", kind: KIND.variable, range: range(3), detail: "··" },
      { name: "D", kind: KIND.property, range: range(4), detail: "·" },
    ];
    const model = new OutlineModel();
    model.setSymbols(flat);
    // Filtrar "a" (o pai) traz a subárvore inteira: "B" e "D" são filhos de "A", "C" é filho de "B".
    model.filter("a");
    expect(model.visibleNodes.map((node) => node.name)).toEqual(["A", "B", "C", "D"]);
    // Filtrar "b" traz "B" e o filho "C" — mas não o irmão "D" (que é filho de "A").
    model.filter("b");
    expect(model.visibleNodes.map((node) => node.name)).toEqual(["B", "C"]);
  });
});

describe("OutlineModel — filtro", () => {
  it("é case-insensitive sobre o nome", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.filter("PESSOA");
    expect(model.visibleNodes.map((node) => node.name)).toEqual(["Pessoa", "nome", "saudar", "ajuda"]);
  });

  it("um pai que casa traz a subárvore inteira (regra do VS Code)", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.filter("pessoa");
    expect(model.visibleNodes.map((node) => node.name)).toEqual(["Pessoa", "nome", "saudar", "ajuda"]);
  });

  it("um filho que casa aparece mesmo com o pai de fora", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.filter("saudar");
    expect(model.visibleNodes.map((node) => node.name)).toEqual(["saudar", "ajuda"]);
  });

  it("filtro vazio mostra tudo", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.filter("   ");
    expect(model.visibleNodes).toHaveLength(5);
  });

  it("o filtro é preservado quando os símbolos mudam", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.filter("total");
    model.setSymbols(TREE);
    expect(model.query).toBe("total");
    expect(model.visibleNodes.map((node) => node.name)).toEqual(["TOTAL"]);
  });
});

describe("OutlineModel — navegação", () => {
  it("seleciona o primeiro item ao carregar", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    expect(model.selected?.name).toBe("Pessoa");
    expect(model.selectedIndex).toBe(0);
  });

  it("selectNext vai até o fim e dá wrap", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.selectNext();
    expect(model.selected?.name).toBe("nome");
    model.selectNext();
    expect(model.selected?.name).toBe("saudar");
    model.selectNext();
    expect(model.selected?.name).toBe("ajuda");
    model.selectNext();
    expect(model.selected?.name).toBe("TOTAL");
    model.selectNext();
    expect(model.selected?.name).toBe("Pessoa");
  });

  it("selectPrev dá wrap (primeiro ⇒ último)", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.selectPrev();
    expect(model.selected?.name).toBe("TOTAL");
    model.selectPrev();
    expect(model.selected?.name).toBe("ajuda");
  });

  it("a navegação respeita o filtro ( só circula nos visíveis)", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.filter("ajuda");
    expect(model.visibleNodes).toHaveLength(1);
    model.selectNext();
    expect(model.selected?.name).toBe("ajuda");
  });

  it("sem símbolos, navegar não explode nem seleciona nada", () => {
    const model = new OutlineModel();
    model.setSymbols([]);
    expect(() => {
      model.selectNext();
      model.selectPrev();
      model.reveal();
    }).not.toThrow();
    expect(model.selected).toBeUndefined();
  });
});

describe("OutlineModel — reveal", () => {
  it("avisa a posição (linha/coluna) do símbolo selecionado", () => {
    const onReveal = vi.fn();
    const model = new OutlineModel({ onReveal });
    model.setSymbols(TREE);
    model.selectNext();
    model.selectNext();
    model.reveal();
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith(
      expect.objectContaining({ line: 4, column: 4, name: "saudar", kind: KIND.method, depth: 1 }),
    );
  });

  it("sem seleção, reveal não chama nada", () => {
    const onReveal = vi.fn();
    const model = new OutlineModel({ onReveal });
    model.setSymbols([]);
    model.reveal();
    expect(onReveal).not.toHaveBeenCalled();
  });
});

describe("classificação por kind", () => {
  it("mapeia os kinds do LSP para rótulo curto e grupo", () => {
    expect(outlineSymbolLabel(KIND.class)).toBe("C");
    expect(outlineSymbolLabel(KIND.function)).toBe("fn");
    expect(outlineSymbolLabel(KIND.variable)).toBe("v");
    expect(outlineSymbolGroup(KIND.class)).toBe("tipos");
    expect(outlineSymbolGroup(KIND.function)).toBe("funções");
    expect(outlineSymbolGroup(KIND.method)).toBe("funções");
    expect(outlineSymbolGroup(KIND.variable)).toBe("variáveis");
    expect(outlineSymbolGroup(KIND.property)).toBe("variáveis");
    expect(outlineSymbolGroup(KIND.module)).toBe("módulos");
    expect(outlineSymbolGroup(KIND.event)).toBe("eventos");
  });

  it("kind desconhecido cai em 'outros' (sem quebrar)", () => {
    expect(outlineSymbolMeta(999)).toEqual({
      kind: 999,
      name: "symbol",
      label: "?",
      group: "outros",
    });
  });

  it("agrupa os nós por família preservando a ordem de aparição", () => {
    const groups = groupOutlineByKind(flattenOutlineSymbols(TREE));
    expect(groups.map((group) => group.group)).toEqual(["tipos", "variáveis", "funções"]);
    expect(groups[0]?.nodes.map((node) => node.name)).toEqual(["Pessoa"]);
    // "nome" (property), "ajuda" (variable) e "TOTAL" (constant) são "variáveis".
    expect(groups[1]?.nodes.map((node) => node.name)).toEqual(["nome", "ajuda", "TOTAL"]);
    expect(groups[2]?.nodes.map((node) => node.name)).toEqual(["saudar"]);
  });
});

describe("estado vazio", () => {
  it("sem símbolos ⇒ 'no-symbols'", () => {
    const model = new OutlineModel();
    expect(model.state().emptyReason).toBe("no-symbols");
  });

  it("filtro sem resultado ⇒ 'no-match'", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.filter("inexistente");
    expect(model.state().emptyReason).toBe("no-match");
  });

  it("sem servidor LSP ⇒ 'no-lsp' (tem precedência sobre o resto)", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    model.setLspAvailable(false);
    expect(model.state().emptyReason).toBe("no-lsp");
  });

  it("com símbolos visíveis não há estado vazio", () => {
    const model = new OutlineModel();
    model.setSymbols(TREE);
    expect(model.state().emptyReason).toBeUndefined();
  });

  it("cada motivo tem um texto", () => {
    expect(describeOutlineEmpty("no-symbols")).toContain("símbolo");
    expect(describeOutlineEmpty("no-match")).toContain("filtro");
    expect(describeOutlineEmpty("no-lsp")).toContain("LSP");
  });
});

describe("compatibilidade com o bridge", () => {
  it("aceita a lista do bridge (LspDocumentSymbol) sem conversão", () => {
    // É o que `bridge.documentSymbols(handle)` entrega (`src/preload/index.ts:465`).
    const fromBridge: LspDocumentSymbol[] = [
      {
        name: "saudar",
        kind: KIND.function,
        detail: "function saudar(): void",
        range: { startLine: 3, startCol: 0, endLine: 5, endCol: 1 },
      },
    ];
    const model = new OutlineModel();
    model.setSymbols(fromBridge);
    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]?.name).toBe("saudar");
    expect(model.nodes[0]?.line).toBe(3);
    expect(model.nodes[0]?.depth).toBe(0);
  });
});

describe("degradação sem DOM", () => {
  beforeAll(() => {
    uninstallFakeDom();
  });

  afterAll(() => {
    uninstallFakeDom();
  });

  it("mountOutlineView devolve um handle no-op (não estoura)", () => {
    const handle = mountOutlineView(null);
    expect(handle).toBeDefined();
    expect(() => {
      handle.update(TREE);
      handle.setFilter("pessoa");
      handle.setLspAvailable(false);
      handle.focus();
      handle.dispose();
    }).not.toThrow();
  });

  it("sem host, o handle ainda mantém o modelo em dia", () => {
    const handle = mountOutlineView(undefined);
    handle.update(TREE);
    expect(handle.model.nodes).toHaveLength(5);
    handle.setFilter("total");
    expect(handle.model.visibleNodes.map((node) => node.name)).toEqual(["TOTAL"]);
  });

  it("o ambiente de teste não tem DOM (o handle é o caminho no-op)", () => {
    expect(typeof document).toBe("undefined");
    const fakeHost = {} as unknown as HTMLElement;
    const handle = mountOutlineView(fakeHost);
    expect(() => handle.update([])).not.toThrow();
  });
});

describe("mountOutlineView — com DOM (o DOM falso compartilhado)", () => {
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
    options: Parameters<typeof mountOutlineView>[1] = {},
  ): { root: FakeElement; handle: ReturnType<typeof mountOutlineView> } {
    const handle = mountOutlineView(host as unknown as HTMLElement, options);
    const root = host.children[0];
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("painel não montado");
    return { root, handle };
  }

  it("desenha um item por símbolo (com a profundidade e o nome)", () => {
    const { root, handle } = mount();
    handle.update(TREE);
    expect(byClass(root, "outline-item")).toHaveLength(5);
    expect(byClass(root, "outline-item")[0]?.getAttribute("data-depth")).toBe("0");
    expect(byClass(root, "outline-item")[3]?.getAttribute("data-depth")).toBe("2");
    expect(firstByClass(root, "outline-name")?.textContent).toBe("Pessoa");
    expect(firstByClass(root, "outline-count")?.textContent).toBe("5 símbolos");
  });

  it("o clique num símbolo avisa o `onReveal` (posição 0-based)", () => {
    const revelados: Array<{ line: number; name: string }> = [];
    const { root, handle } = mount({
      onReveal: (target: { line: number; name: string }) => revelados.push(target),
    });
    handle.update(TREE);
    (byClass(root, "outline-item")[1] as FakeElement).dispatch("click");
    expect(revelados).toHaveLength(1);
    expect(revelados[0]?.name).toBe("nome");
    expect(revelados[0]?.line).toBe(2);
  });

  it("o filtro do painel filtra a lista desenhada", () => {
    const { root, handle } = mount();
    handle.update(TREE);
    expect(byClass(root, "outline-item")).toHaveLength(5);

    const filtro = firstByClass(root, "outline-filter") as FakeElement;
    filtro.value = "total";
    filtro.dispatch("input");

    expect(byClass(root, "outline-item")).toHaveLength(1);
    expect(firstByClass(root, "outline-name")?.textContent).toBe("TOTAL");
  });

  it("sem símbolos o painel mostra o estado vazio", () => {
    const { root, handle } = mount();
    handle.update([]);
    expect(firstByClass(root, "outline-empty")?.hidden).toBe(false);
    expect(firstByClass(root, "outline-empty")?.textContent).toBe("Nenhum símbolo neste documento");
  });

  it("com o host escondido o painel não redesenha (e desenha quando volta)", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update(TREE);

    // Escondido ⇒ a lista não foi desenhada…
    expect(byClass(root, "outline-item")).toHaveLength(0);
    // …mas o estado está no modelo.
    expect(handle.model.nodes).toHaveLength(5);

    // O host volta a aparecer ⇒ o painel redesenha (sem precisar de outro `update`).
    host.hidden = false;
    expect(byClass(root, "outline-item")).toHaveLength(5);
  });

  it("o próximo `update` com o host visível também desenha", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update(TREE);
    expect(byClass(root, "outline-item")).toHaveLength(0);

    host.hidden = false;
    handle.update(TREE);
    expect(byClass(root, "outline-item")).toHaveLength(5);
  });
});
