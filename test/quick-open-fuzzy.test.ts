/**
 * Scribe — testes do **fuzzy matching** e do **índice de arquivos da workspace**.
 *
 * Só funções puras (nenhum DOM, nenhum I/O real): o port de diretórios é um fake em memória.
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILES,
  findFile,
  fuzzyFilter,
  fuzzyScore,
  indexFiles,
  type DirEntry,
  type DirectoryReader,
} from "../src/core/workspace/file-index";

/** Árvore de diretórios do fake: caminho → entradas. */
type FakeTree = Record<string, readonly DirEntry[]>;

function dir(name: string): DirEntry {
  return { name, isDirectory: true };
}

function file(name: string): DirEntry {
  return { name, isDirectory: false, isFile: true };
}

/** Cria um port de diretórios em memória (e, opcionalmente, arquivos de texto). */
function fakeReader(tree: FakeTree, files: Record<string, string> = {}): DirectoryReader {
  return {
    readDir: (path: string): Promise<readonly DirEntry[]> => Promise.resolve(tree[path] ?? []),
    readFile: (path: string): Promise<string> => {
      const content = files[path];
      if (content === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }));
      }
      return Promise.resolve(content);
    },
  };
}

describe("fuzzy — casar e não casar", () => {
  it("casa uma query multi-caractere em ordem (fb → foo/bar.ts)", () => {
    const match = fuzzyScore("fb", "foo/bar.ts");
    expect(match).toBeDefined();
    expect(match!.indices).toEqual([0, 4]);
  });

  it("casa uma query que é substring do candidato", () => {
    expect(fuzzyScore("bar", "foo/bar.ts")).toBeDefined();
    expect(fuzzyScore("oo", "foo")).toBeDefined();
    expect(fuzzyScore("main.ts", "src/main.ts")).toBeDefined();
  });

  it("devolve undefined quando a query não casa", () => {
    expect(fuzzyScore("zzz", "foo.ts")).toBeUndefined();
    expect(fuzzyScore("bar", "foo.ts")).toBeUndefined();
  });

  it("é case-insensitive", () => {
    expect(fuzzyScore("FOO", "foo.ts")).toBeDefined();
    expect(fuzzyScore("foo", "FOO.TS")).toBeDefined();
  });

  it("a query vazia casa com tudo (score 0, sem índices)", () => {
    const match = fuzzyScore("", "qualquer.ts");
    expect(match).toEqual({ score: 0, indices: [] });
    expect(fuzzyScore("   ", "qualquer.ts")).toEqual({ score: 0, indices: [] });
  });
});

describe("fuzzy — a regra do espaço (segmento / \\b)", () => {
  it("com espaço, casa por segmento: 'fo bar' casa 'foo/bar.ts'", () => {
    const match = fuzzyScore("fo bar", "foo/bar.ts");
    expect(match).toBeDefined();
    // "fo" em 0..1 e "bar" em 4..6 (o 'b' começa uma palavra, depois da '/')
    expect(match!.indices).toEqual([0, 1, 4, 5, 6]);
  });

  it("com espaço, NÃO casa quando não há limite de palavra", () => {
    expect(fuzzyScore("fo bar", "foobar.ts")).toBeUndefined();
  });

  it("o 1º segmento pode começar em qualquer posição (os seguintes, não)", () => {
    // "oo" casa em 1..2 (o 'o' não começa palavra) e "bar" começa no 4 (depois da '/').
    const match = fuzzyScore("oo bar", "foo/bar.ts");
    expect(match).toBeDefined();
    expect(match!.indices).toEqual([1, 2, 4, 5, 6]);
  });
});

describe("fuzzy — pontuação", () => {
  it("a consecutividade vale mais que o espaçamento", () => {
    const consecutive = fuzzyScore("ab", "ab")!;
    const spaced = fuzzyScore("ab", "aXb")!;
    expect(consecutive.score).toBeGreaterThan(spaced.score);
  });

  it("o início de palavra dá bônus", () => {
    const atStart = fuzzyScore("src", "src/main.ts")!;
    const inTheMiddle = fuzzyScore("src", "xsrc/main.ts")!;
    expect(atStart.score).toBeGreaterThan(inTheMiddle.score);
  });

  it("casar no basename vale mais que casar no diretório", () => {
    const inBasename = fuzzyScore("main", "main.ts")!;
    const inDirectory = fuzzyScore("main", "src/main.ts")!;
    expect(inBasename.score).toBeGreaterThan(inDirectory.score);
  });
});

describe("fuzzyFilter — filtro e ordenação", () => {
  const items = ["src/main.ts", "src/renderer/main.ts", "docs/readme.md", "zzz.ts"];

  it("a query vazia devolve todos os itens na ordem original", () => {
    const hits = fuzzyFilter("", items, (item) => item);
    expect(hits.map((hit) => hit.item)).toEqual(items);
    expect(hits.every((hit) => hit.match.score === 0)).toBe(true);
  });

  it("filtra o que não casa", () => {
    const hits = fuzzyFilter("readme", items, (item) => item);
    expect(hits.map((hit) => hit.item)).toEqual(["docs/readme.md"]);
  });

  it("ordena por score decrescente", () => {
    const hits = fuzzyFilter("main", items, (item) => item);
    expect(hits[0]!.item).toBe("src/main.ts");
    expect(hits.map((hit) => hit.item)).toContain("src/renderer/main.ts");
    // O score é decrescente.
    const scores = hits.map((hit) => hit.match.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("empate de score mantém a ordem original", () => {
    const equal = ["a.ts", "b.ts"];
    const hits = fuzzyFilter("t", equal, (item) => item);
    expect(hits.map((hit) => hit.item)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("índice de arquivos — o que entra e o que fica de fora", () => {
  const tree: FakeTree = {
    "/ws": [dir("src"), dir("node_modules"), dir(".git"), file("README.md")],
    "/ws/src": [file("main.ts"), dir("deep")],
    "/ws/src/deep": [file("a.ts")],
    "/ws/node_modules": [file("pkg.js")],
    "/ws/.git": [file("HEAD")],
  };

  it("ignora os diretórios ruidosos (node_modules, .git)", async () => {
    const index = await indexFiles(["/ws"], fakeReader(tree));
    expect(index.files).toEqual(["README.md", "src/deep/a.ts", "src/main.ts"]);
    expect(index.files).not.toContain("node_modules/pkg.js");
    expect(index.files).not.toContain(".git/HEAD");
  });

  it("devolve os caminhos relativos ordenados", async () => {
    const index = await indexFiles(["/ws"], fakeReader(tree));
    expect([...index.files]).toEqual([...index.files].sort());
    expect(index.entries[0]!.absolutePath).toBe("/ws/README.md");
    expect(index.entries[0]!.root).toBe("/ws");
  });

  it("respeita o .gitignore da raiz (padrões simples)", async () => {
    const withIgnore: FakeTree = {
      "/ws": [file("debug.log"), file("main.ts"), dir("build")],
      "/ws/build": [file("out.js")],
    };
    const reader = fakeReader(withIgnore, { "/ws/.gitignore": "*.log\nbuild/\n" });
    const index = await indexFiles(["/ws"], reader);
    expect(index.files).toEqual(["main.ts"]);
  });

  it("o .gitignore em si não entra no índice", async () => {
    const withIgnore: FakeTree = { "/ws": [file(".gitignore"), file("main.ts")] };
    const reader = fakeReader(withIgnore, { "/ws/.gitignore": "*.log\n" });
    const index = await indexFiles(["/ws"], reader);
    expect(index.files).toEqual(["main.ts"]);
  });
});

describe("índice de arquivos — tetos", () => {
  const many: FakeTree = {
    "/ws": [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")],
  };

  it("o teto de arquivos trunca o índice e avisa", async () => {
    const warn = vi.fn();
    const index = await indexFiles(["/ws"], fakeReader(many), { maxFiles: 2, warn });
    expect(index.files).toHaveLength(2);
    expect(index.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(index.warnings.length).toBeGreaterThan(0);
  });

  it("o teto de profundidade trunca a árvore e avisa", async () => {
    const tree: FakeTree = {
      "/ws": [dir("a")],
      "/ws/a": [dir("b")],
      "/ws/a/b": [file("c.ts")],
    };
    const warn = vi.fn();
    const index = await indexFiles(["/ws"], fakeReader(tree), { maxDepth: 1, warn });
    expect(index.files).toEqual([]);
    expect(index.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("sem teto, a profundidade default (5) é respeitada", async () => {
    const tree: FakeTree = {
      "/ws": [dir("a")],
      "/ws/a": [dir("b")],
      "/ws/a/b": [dir("c")],
      "/ws/a/b/c": [dir("d")],
      "/ws/a/b/c/d": [dir("e")],
      "/ws/a/b/c/d/e": [file("f.ts")],
    };
    const index = await indexFiles(["/ws"], fakeReader(tree));
    expect(index.files).toEqual(["a/b/c/d/e/f.ts"]);
    expect(index.truncated).toBe(false);
  });

  it("os defaults são 20.000 arquivos e 5 níveis", () => {
    expect(DEFAULT_MAX_FILES).toBe(20_000);
    expect(DEFAULT_MAX_DEPTH).toBe(5);
  });
});

describe("índice de arquivos — busca no índice", () => {
  const tree: FakeTree = {
    "/ws": [dir("src"), file("README.md")],
    "/ws/src": [file("main.ts")],
  };

  it("findFile acha o melhor casamento", async () => {
    const index = await indexFiles(["/ws"], fakeReader(tree));
    expect(findFile(index, "readme")?.path).toBe("README.md");
    expect(findFile(index, "maint")?.path).toBe("src/main.ts");
  });

  it("findFile devolve undefined quando nada casa", async () => {
    const index = await indexFiles(["/ws"], fakeReader(tree));
    expect(findFile(index, "zzzqqq")).toBeUndefined();
  });
});
