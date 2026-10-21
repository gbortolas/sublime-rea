/**
 * Scribe — testes do **Explorer** (`src/renderer/explorer-tree.ts`).
 *
 * O ambiente de teste é `node` (**sem DOM**) ⇒ o **modelo** (estado de expansão, filtro e
 * seleção) é testado sem DOM e o **DOM** é testado contra o **DOM falso** compartilhado
 * (`test/helpers/fake-dom.ts`).
 *
 * O DOM prova: a árvore é desenhada, o clique num arquivo abre o **caminho absoluto** e o
 * painel escondido **não** redesenha.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExplorerTreeModel,
  mountExplorerTree,
  type ExplorerFile,
} from "../src/renderer/explorer-tree";
import {
  byClass,
  FakeElement,
  firstByClass,
  installFakeDom,
  uninstallFakeDom,
} from "./helpers/fake-dom";

const FILES: readonly ExplorerFile[] = [
  { path: "src/main/index.ts", absolutePath: "/w/src/main/index.ts" },
  { path: "src/main/other.ts", absolutePath: "/w/src/main/other.ts" },
  { path: "src/renderer/main.ts", absolutePath: "/w/src/renderer/main.ts" },
  { path: "README.md", absolutePath: "/w/README.md" },
];

describe("ExplorerTreeModel — o estado", () => {
  it("monta a árvore a partir da lista de arquivos", () => {
    const model = new ExplorerTreeModel();
    model.setFiles(FILES);

    expect(model.tree().map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(model.state().visibleCount).toBe(2);
  });

  it("expande e colapsa um diretório (a lista visível muda)", () => {
    const model = new ExplorerTreeModel();
    model.setFiles(FILES);

    model.toggle("src");
    expect(model.expanded.has("src")).toBe(true);
    expect(model.visibleEntries().map((entry) => entry.node.path)).toEqual([
      "src",
      "src/main",
      "src/renderer",
      "README.md",
    ]);

    model.toggle("src");
    expect(model.expanded.has("src")).toBe(false);
    expect(model.visibleEntries().map((entry) => entry.node.path)).toEqual(["src", "README.md"]);
  });

  it("o filtro incremental esconde o que não casa (em tempo real)", () => {
    const model = new ExplorerTreeModel();
    model.setFiles(FILES);

    model.setQuery("other");
    expect(model.visibleEntries().map((entry) => entry.node.path)).toEqual([
      "src",
      "src/main",
      "src/main/other.ts",
    ]);

    model.setQuery("");
    expect(model.visibleEntries().map((entry) => entry.node.path)).toEqual(["src", "README.md"]);
  });

  it("com filtro ativo, o caminho do arquivo que casou aparece expandido", () => {
    const model = new ExplorerTreeModel();
    model.setFiles(FILES);

    model.setQuery("index");

    expect(model.visibleEntries().map((entry) => entry.node.path)).toEqual([
      "src",
      "src/main",
      "src/main/index.ts",
    ]);
  });

  it("seleciona um item", () => {
    const model = new ExplorerTreeModel();
    model.setFiles(FILES);

    model.select("README.md");

    expect(model.selected).toBe("README.md");
    expect(model.state().selected).toBe("README.md");
  });

  it("abre um arquivo com o caminho **absoluto**", () => {
    const onOpenFile = vi.fn();
    const model = new ExplorerTreeModel({ onOpenFile });
    model.setFiles(FILES);

    model.open("src/main/index.ts");

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("/w/src/main/index.ts");
    expect(model.selected).toBe("src/main/index.ts");
  });

  it("abrir um arquivo que não existe não notifica ninguém", () => {
    const onOpenFile = vi.fn();
    const model = new ExplorerTreeModel({ onOpenFile });
    model.setFiles(FILES);

    model.open("nao/existe.ts");

    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("recarregar os arquivos preserva a expansão e limpa a seleção inválida", () => {
    const model = new ExplorerTreeModel();
    model.setFiles(FILES);
    model.toggle("src");
    model.select("README.md");

    model.setFiles([{ path: "src/main/index.ts", absolutePath: "/w/src/main/index.ts" }]);

    expect(model.expanded.has("src")).toBe(true);
    expect(model.selected).toBeUndefined();
  });

  it("expande e colapsa tudo", () => {
    const model = new ExplorerTreeModel();
    model.setFiles(FILES);

    model.expandAll();
    expect([...model.expanded].sort()).toEqual(["src", "src/main", "src/renderer"]);

    model.collapseAll();
    expect([...model.expanded]).toEqual([]);
  });

  it("notifica os assinantes a cada mudança", () => {
    const onChange = vi.fn();
    const model = new ExplorerTreeModel({ onChange });
    model.setFiles(FILES);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ query: "", visibleCount: 2 });
  });

  it("o estado vazio (nenhum arquivo) não quebra", () => {
    const model = new ExplorerTreeModel();
    model.setFiles([]);

    expect(model.tree()).toEqual([]);
    expect(model.visibleEntries()).toEqual([]);
    expect(model.state().visibleCount).toBe(0);
  });
});

describe("mountExplorerTree — a degradação sem DOM", () => {
  beforeAll(() => {
    uninstallFakeDom();
  });

  afterAll(() => {
    uninstallFakeDom();
  });

  it("sem host devolve um handle no-op (sem crash)", () => {
    const handle = mountExplorerTree(null);

    expect(handle).toBeDefined();
    expect(() => handle.update(FILES)).not.toThrow();
    expect(() => handle.setFilter("index")).not.toThrow();
    expect(() => handle.expandAll()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("sem DOM, o handle é no-op mas o modelo continua funcionando", () => {
    const handle = mountExplorerTree(null);

    handle.update(FILES);

    expect(handle.model.tree().map((node) => node.name)).toEqual(["src", "README.md"]);
  });

  it("aceita um modelo pronto (o chamador monta e consulta)", () => {
    const model = new ExplorerTreeModel();
    const handle = mountExplorerTree(null, { model });

    expect(handle.model).toBe(model);
  });

  it("aceita o formato do IPC (`WorkspaceFile`: path + absolutePath)", () => {
    // ⚠️ A forma do `WorkspaceFile` (`src/shared/ipc-contract.ts`) — replicada aqui para
    // **não** acoplar o teste a um arquivo que outro agente está editando.
    interface IpcWorkspaceFile {
      readonly path: string;
      readonly absolutePath: string;
    }
    const ipcFiles: readonly IpcWorkspaceFile[] = [
      { path: "src/main.ts", absolutePath: "/w/src/main.ts" },
    ];

    const handle = mountExplorerTree(null);
    handle.update(ipcFiles);

    expect(handle.model.tree().map((node) => node.path)).toEqual(["src"]);
    expect(handle.model.absolutePathOf("src/main.ts")).toBe("/w/src/main.ts");
  });
});

describe("mountExplorerTree — com DOM (o DOM falso compartilhado)", () => {
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
    options: Parameters<typeof mountExplorerTree>[1] = {},
  ): { root: FakeElement; handle: ReturnType<typeof mountExplorerTree> } {
    const handle = mountExplorerTree(host as unknown as HTMLElement, options);
    const root = host.children[0];
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("painel não montado");
    return { root, handle };
  }

  it("desenha a árvore (a pasta e o arquivo, colapsados)", () => {
    const { root, handle } = mount();
    handle.update(FILES);
    const itens = byClass(root, "explorer-tree-item");
    expect(itens).toHaveLength(2);
    expect(itens[0]?.getAttribute("data-path")).toBe("src");
    expect(itens[1]?.getAttribute("data-path")).toBe("README.md");
    expect(firstByClass(root, "explorer-tree-label")?.textContent).toBe("src");
  });

  it("o clique num diretório expande (e redesenha a lista)", () => {
    const { root, handle } = mount();
    handle.update(FILES);
    (byClass(root, "explorer-tree-item")[0] as FakeElement).dispatch("click");
    expect(handle.model.expanded.has("src")).toBe(true);
    expect(byClass(root, "explorer-tree-item")).toHaveLength(4);
  });

  it("o clique num arquivo abre o caminho **absoluto**", () => {
    const abertos: string[] = [];
    const { root, handle } = mount({ onOpenFile: (path: string) => abertos.push(path) });
    handle.update(FILES);
    handle.expandAll();
    const arquivo = byClass(root, "explorer-tree-file")[0];
    (arquivo as FakeElement).dispatch("click");
    expect(abertos).toEqual(["/w/src/main/index.ts"]);
  });

  it("o filtro incremental do painel filtra a lista desenhada", () => {
    const { root, handle } = mount();
    handle.update(FILES);
    const filtro = firstByClass(root, "explorer-tree-filter") as FakeElement;
    filtro.value = "other";
    filtro.dispatch("input");
    const caminhos = byClass(root, "explorer-tree-item").map((item) =>
      item.getAttribute("data-path"),
    );
    expect(caminhos).toEqual(["src", "src/main", "src/main/other.ts"]);
  });

  it("com o host escondido o painel não redesenha (e desenha quando volta)", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update(FILES);

    // Escondido ⇒ a lista não foi desenhada…
    expect(byClass(root, "explorer-tree-item")).toHaveLength(0);
    // …mas o estado está no modelo.
    expect(handle.model.tree()).toHaveLength(2);

    // O host volta a aparecer ⇒ o painel redesenha (sem precisar de outro `update`).
    host.hidden = false;
    expect(byClass(root, "explorer-tree-item")).toHaveLength(2);
  });

  it("o próximo `update` com o host visível também desenha", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update(FILES);
    expect(byClass(root, "explorer-tree-item")).toHaveLength(0);

    host.hidden = false;
    handle.update(FILES);
    expect(byClass(root, "explorer-tree-item")).toHaveLength(2);
  });
});
