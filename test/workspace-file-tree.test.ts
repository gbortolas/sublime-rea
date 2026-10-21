/**
 * Scribe — testes da **árvore de arquivos da workspace** (`src/core/workspace/file-tree.ts`).
 *
 * Só funções puras (nenhum DOM, nenhum I/O): a árvore é montada a partir da lista de
 * caminhos relativos que o `indexFiles` devolve.
 */
import { describe, expect, it } from "vitest";

import {
  buildFileTree,
  collectDirectoryPaths,
  filterTree,
  findNode,
  flattenTree,
  isExpanded,
  setExpanded,
  toggleExpanded,
  type FileTreeNode,
} from "../src/core/workspace/file-tree";

/** Nomes dos nós de 1º nível (atalho de teste). */
function names(nodes: readonly FileTreeNode[]): readonly string[] {
  return nodes.map((node) => node.name);
}

/** Os nós de 1º nível que são arquivos. */
function files(nodes: readonly FileTreeNode[]): readonly FileTreeNode[] {
  return nodes.filter((node) => node.kind === "file");
}

describe("buildFileTree — a hierarquia", () => {
  it("agrupa os caminhos relativos em diretórios e arquivos", () => {
    const tree = buildFileTree([
      "src/main/index.ts",
      "src/main/other.ts",
      "src/renderer/main.ts",
      "README.md",
    ]);

    expect(names(tree)).toEqual(["src", "README.md"]);
    const src = tree[0]!;
    expect(src.kind).toBe("dir");
    expect(src.path).toBe("src");
    expect(names(src.children ?? [])).toEqual(["main", "renderer"]);
    const main = src.children?.[0];
    expect(main?.kind).toBe("dir");
    expect(names(main?.children ?? [])).toEqual(["index.ts", "other.ts"]);
    expect(main?.children?.[0]?.kind).toBe("file");
    expect(main?.children?.[0]?.path).toBe("src/main/index.ts");
  });

  it("coloca os diretórios **antes** dos arquivos", () => {
    const tree = buildFileTree(["zeta.txt", "alpha.txt", "mid/inner.txt"]);

    expect(names(tree)).toEqual(["mid", "alpha.txt", "zeta.txt"]);
    expect(tree.map((node) => node.kind)).toEqual(["dir", "file", "file"]);
  });

  it("ordena alfabeticamente, sem diferenciar maiúsculas", () => {
    const tree = buildFileTree([
      "src/banana.ts",
      "src/Apple.ts",
      "src/cherry.ts",
      "src/apple.ts",
    ]);

    expect(names(tree[0]?.children ?? [])).toEqual(["Apple.ts", "apple.ts", "banana.ts", "cherry.ts"]);
  });

  it("mantém o prefixo da raiz (multi-raiz) como 1º nível", () => {
    // `indexFiles` prefixa o basename da raiz quando há mais de uma raiz.
    const tree = buildFileTree(["projeto-a/src/main.ts", "projeto-b/src/other.ts"]);

    expect(names(tree)).toEqual(["projeto-a", "projeto-b"]);
    expect(tree[0]?.path).toBe("projeto-a");
    expect(tree[0]?.children?.[0]?.path).toBe("projeto-a/src");
  });

  it("ignora caminhos vazios (workspace sem pasta)", () => {
    expect(buildFileTree([])).toEqual([]);
    expect(buildFileTree(["", "/", "///"])).toEqual([]);
  });

  it("normaliza o separador (o path do nó usa '/')", () => {
    const tree = buildFileTree(["src\\main\\index.ts"]);

    expect(names(tree)).toEqual(["src"]);
    expect(tree[0]?.children?.[0]?.path).toBe("src/main");
  });

  it("quando o mesmo nome é arquivo e diretório, o diretório vence", () => {
    const tree = buildFileTree(["src", "src/main.ts"]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.kind).toBe("dir");
    expect(names(tree[0]?.children ?? [])).toEqual(["main.ts"]);
  });

  it("aceita um separador customizado", () => {
    const tree = buildFileTree(["src/main.ts"], { separator: "|" });

    expect(tree[0]?.children?.[0]?.path).toBe("src|main.ts");
  });
});

describe("flattenTree — a lista visível", () => {
  const tree = buildFileTree(["src/main/index.ts", "src/renderer/main.ts", "README.md"]);

  it("mostra só o 1º nível quando nada está expandido", () => {
    const entries = flattenTree(tree, new Set<string>());

    expect(entries.map((entry) => entry.node.path)).toEqual(["src", "README.md"]);
    expect(entries.map((entry) => entry.depth)).toEqual([0, 0]);
  });

  it("mostra os filhos de um diretório expandido (com a profundidade)", () => {
    const entries = flattenTree(tree, new Set(["src"]));

    expect(entries.map((entry) => entry.node.path)).toEqual([
      "src",
      "src/main",
      "src/renderer",
      "README.md",
    ]);
    expect(entries.map((entry) => entry.depth)).toEqual([0, 1, 1, 0]);
    expect(entries[0]?.expanded).toBe(true);
  });

  it("marca os diretórios como expandidos (e os arquivos, nunca)", () => {
    const entries = flattenTree(tree, new Set(["src"]));

    expect(entries[0]?.expanded).toBe(true);
    expect(entries[1]?.expanded).toBe(false);
  });

  it("uma árvore vazia produz uma lista vazia", () => {
    expect(flattenTree([], new Set(["src"]))).toEqual([]);
  });
});

describe("filterTree — o filtro incremental", () => {
  const tree = buildFileTree([
    "src/main/index.ts",
    "src/main/other.ts",
    "src/renderer/main.ts",
    "README.md",
  ]);

  it("casa pelo nome do arquivo (case-insensitive)", () => {
    const filtered = filterTree(tree, "index");

    expect(names(filtered)).toEqual(["src"]);
    const main = filtered[0]?.children?.[0];
    expect(names(main?.children ?? [])).toEqual(["index.ts"]);
  });

  it("mantém o pai quando um filho casa", () => {
    const filtered = filterTree(tree, "other");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe("dir");
    expect(filtered[0]?.path).toBe("src");
    expect(filtered[0]?.children?.[0]?.path).toBe("src/main");
    expect(filtered[0]?.children?.[0]?.children?.[0]?.path).toBe("src/main/other.ts");
  });

  it("um diretório que casa é mantido com todo o conteúdo", () => {
    const filtered = filterTree(tree, "renderer");

    // `src` não casa, mas sobrevive porque o filho `renderer` casou.
    expect(filtered).toHaveLength(1);
    expect(names(filtered[0]?.children ?? [])).toEqual(["renderer"]);
    // `renderer` casou pelo nome ⇒ vem com todo o conteúdo.
    expect(names(filtered[0]?.children?.[0]?.children ?? [])).toEqual(["main.ts"]);
  });

  it("a query vazia devolve a árvore inteira (mesma referência)", () => {
    expect(filterTree(tree, "")).toBe(tree);
    expect(filterTree(tree, "   ")).toBe(tree);
  });

  it("uma query sem casa devolve uma lista vazia", () => {
    expect(filterTree(tree, "zzz")).toEqual([]);
  });

  it("o filtro não altera a árvore original", () => {
    filterTree(tree, "index");

    expect(names(tree)).toEqual(["src", "README.md"]);
  });
});

describe("toggleExpanded — o estado de expansão", () => {
  it("expande um diretório que estava fechado", () => {
    const next = toggleExpanded(new Set<string>(), "src");

    expect(next.has("src")).toBe(true);
  });

  it("colapsa um diretório que estava expandido", () => {
    const next = toggleExpanded(new Set(["src"]), "src");

    expect(next.has("src")).toBe(false);
  });

  it("não muta o conjunto recebido", () => {
    const original = new Set(["src"]);

    toggleExpanded(original, "src");

    expect(original.has("src")).toBe(true);
  });

  it("setExpanded define o estado explicitamente", () => {
    expect(setExpanded(new Set<string>(), "src", true).has("src")).toBe(true);
    expect(setExpanded(new Set(["src"]), "src", false).has("src")).toBe(false);
    expect(isExpanded(new Set(["src"]), "src")).toBe(true);
    expect(isExpanded(new Set<string>(), "src")).toBe(false);
  });
});

describe("collectDirectoryPaths — o «expandir tudo»", () => {
  it("lista todos os diretórios da árvore", () => {
    const tree = buildFileTree(["src/main/index.ts", "README.md"]);

    expect([...collectDirectoryPaths(tree)].sort()).toEqual(["src", "src/main"]);
  });
});

describe("findNode — a busca por path", () => {
  it("acha o nó pelo caminho relativo", () => {
    const tree = buildFileTree(["src/main/index.ts"]);

    expect(findNode(tree, "src/main/index.ts")?.kind).toBe("file");
    expect(findNode(tree, "src/main")?.kind).toBe("dir");
    expect(findNode(tree, "nao/existe")).toBeUndefined();
  });
});

describe("a lista de arquivos (a lista plana do índice)", () => {
  it("o `path` do nó é o caminho relativo do índice (identidade)", () => {
    const paths = ["src/main/index.ts", "README.md"];
    const tree = buildFileTree(paths);
    const flat = flattenTree(tree, collectDirectoryPaths(tree));
    const fileNodes = flat.map((entry) => entry.node).filter((node) => node.kind === "file");

    expect(fileNodes.map((node) => node.path).sort()).toEqual([...paths].sort());
    expect(files(flat.map((entry) => entry.node))).toHaveLength(2);
  });
});
