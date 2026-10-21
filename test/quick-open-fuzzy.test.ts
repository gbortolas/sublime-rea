/**
 * Scribe — testes do **fuzzy matching** e do **índice de arquivos da workspace**.
 *
 * Só funções puras (nenhum DOM, nenhum I/O real): o port de diretórios é um fake em memória.
 *
 * ⚠️ **A regra mudou (pontuação pelo caminho completo)**: o candidato do matching é o
 * **caminho** (relativo à raiz) e a casa é feita **por segmento de caminho** — a casa
 * **não atravessa** `/`. Consequências (documentadas de propósito, é uma mudança de UX):
 *
 * - "fb" **não** casa mais com "foo/bar.ts" (o "b" está em outro segmento) — use "f bar";
 * - o *basename* virou um **desempate leve**: a diferença de score entre "main.ts" e
 *   "src/main.ts" caiu de ~100 para **5** (o *basename* não domina mais);
 * - dois arquivos de mesmo *basename* **não empatam** mais quando a query fala da pasta
 *   ("renderer main" acha "src/renderer/main.ts" e não "src/main.ts").
 *
 * ⚠️ **A query também é splitada por `/`** (e `\`): "src/main.ts" casa "src/main.ts" — a
 * query fala o *caminho*, não uma sequência de letras soltas. Os trechos casam segmento a
 * segmento, **em ordem** (com pulo de segmento, como o VS Code).
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
  it("casa uma query multi-caractere em ordem (f bar → foo/bar.ts)", () => {
    const match = fuzzyScore("f bar", "foo/bar.ts");
    expect(match).toBeDefined();
    expect(match!.indices).toEqual([0, 4, 5, 6]);
  });

  it("a casa NÃO atravessa segmentos do caminho (fb ≠ foo/bar.ts)", () => {
    // A casa é por segmento: "f" está em "foo" e "b" em "bar" — trechos diferentes.
    expect(fuzzyScore("fb", "foo/bar.ts")).toBeUndefined();
    // Nem misturando as pastas ("srcmain" não cabe em "src" nem em "main.ts").
    expect(fuzzyScore("srcmain", "src/main.ts")).toBeUndefined();
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

describe("fuzzy — a casa é feita no caminho inteiro", () => {
  it("casa em qualquer parte do caminho (o diretório também casa)", () => {
    const match = fuzzyScore("renderer", "src/renderer/main.ts");
    expect(match).toBeDefined();
    // O "renderer" do diretório (começo de uma palavra ⇒ bônus de início de palavra).
    expect(match!.indices).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("preserva a ordem dos segmentos do caminho", () => {
    // "main" vem depois de "renderer" no caminho — a query invertida não casa.
    expect(fuzzyScore("main renderer", "src/renderer/main.ts")).toBeUndefined();
  });

  it("o prefixo da raiz (multi-root) também entra na casa", () => {
    const match = fuzzyScore("proj src", "proj/src/a.ts");
    expect(match).toBeDefined();
    expect(match!.indices).toEqual([0, 1, 2, 3, 5, 6, 7]);
    // A mesma query não casa na outra raiz.
    expect(fuzzyScore("proj src", "other/src/a.ts")).toBeUndefined();
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

describe("fuzzy — a query que fala o CAMINHO (barra)", () => {
  it("a query com '/' casa o caminho (segmento a segmento)", () => {
    // A query é splitada por '/' ⇒ cada trecho casa com **um** segmento do caminho.
    expect(fuzzyScore("src/main.ts", "src/main.ts")).toBeDefined();
    expect(fuzzyScore("src/main", "src/main.ts")).toBeDefined();
    // O mesmo arquivo, escrito com espaço, casa também.
    expect(fuzzyScore("src main", "src/main.ts")).toBeDefined();
  });

  it("os índices casados são os do caminho (o destaque aponta pro arquivo certo)", () => {
    const match = fuzzyScore("src/main.ts", "src/main.ts");
    expect(match).toBeDefined();
    expect(match!.indices).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("o trecho casa DENTRO de um segmento (a casa não atravessa a barra)", () => {
    // Um trecho só não atravessa o separador: "sm" não cabe em "src" nem em "main.ts".
    expect(fuzzyScore("sm", "src/main.ts")).toBeUndefined();
    // (a regra é a mesma do "fb" ≠ "foo/bar.ts" — o que muda é que a query **pode** usar a
    // barra para dizer "o próximo segmento é este").
  });

  it("os trechos pulam segmentos (como o VS Code) mas nunca voltam", () => {
    // "src" casa no 1º segmento e "main" no 3º — o segmento do meio é pulado.
    expect(fuzzyScore("src/main", "src/renderer/main.ts")).toBeDefined();
    // A ordem é respeitada: "main" vem **depois** de "src" no caminho.
    expect(fuzzyScore("main/src", "src/main.ts")).toBeUndefined();
  });

  it("dentro do segmento a casa é fuzzy (subsequência), como no resto do módulo", () => {
    // "sr" é uma subsequência de "src" ⇒ casa (é a mesma regra que faz "maint" casar
    // "main.ts"); o que a regra **proíbe** é o trecho atravessar a barra.
    expect(fuzzyScore("sr/main", "src/main.ts")).toBeDefined();
    expect(fuzzyScore("maint", "src/main.ts")).toBeDefined();
  });

  it("a barra invertida (Windows) também é separador", () => {
    expect(fuzzyScore("src\\main.ts", "src\\main.ts")).toBeDefined();
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

  it("o basename é um desempate LEVE (não domina mais)", () => {
    const inBasename = fuzzyScore("main", "main.ts")!;
    const inDirectory = fuzzyScore("main", "src/main.ts")!;
    // O basename ainda ganha (é o que o usuário espera), mas por pouco: a fórmula antiga
    // (12/char + 48) dava ~100 pontos de vantagem — agora a diferença é de 5.
    expect(inBasename.score).toBeGreaterThan(inDirectory.score);
    expect(inBasename.score - inDirectory.score).toBeLessThan(20);
  });

  it("o caminho desempata dois arquivos de mesmo basename (não empatam mais)", () => {
    const shallow = fuzzyScore("main", "src/main.ts")!;
    const deep = fuzzyScore("main", "src/renderer/main.ts")!;
    // Antes (o basename dominava) os dois empatavam; agora o caminho entra no score.
    expect(shallow.score).not.toBe(deep.score);
    expect(shallow.score).toBeGreaterThan(deep.score);
  });

  it("a query que fala a pasta escolhe o arquivo certo", () => {
    const hits = fuzzyFilter(
      "renderer main",
      ["src/main.ts", "src/renderer/main.ts"],
      (item) => item,
    );
    expect(hits.map((hit) => hit.item)).toEqual(["src/renderer/main.ts"]);
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

  it("a query com a pasta separa o que o basename não separa", () => {
    const hits = fuzzyFilter("src main", ["src/main.ts", "lib/main.ts"], (item) => item);
    // "lib/main.ts" nem casa com "src main" — a casa é no caminho, não no basename.
    expect(hits.map((hit) => hit.item)).toEqual(["src/main.ts"]);
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

describe("índice de arquivos — multi-root", () => {
  const multi: FakeTree = {
    "/ws": [dir("src")],
    "/ws/src": [file("a.ts")],
    "/other": [dir("src")],
    "/other/src": [file("a.ts")],
  };

  it("com mais de uma raiz, o caminho ganha o nome da raiz como prefixo", async () => {
    const index = await indexFiles(["/ws", "/other"], fakeReader(multi));
    expect(index.files).toEqual(["other/src/a.ts", "ws/src/a.ts"]);
    // O caminho absoluto continua o do arquivo (o `main` abre por ele).
    const entry = index.entries.find((item) => item.path === "other/src/a.ts");
    expect(entry?.absolutePath).toBe("/other/src/a.ts");
    expect(entry?.root).toBe("/other");
  });

  it("com uma raiz só, não há prefixo (o formato antigo)", async () => {
    const index = await indexFiles(["/ws"], fakeReader(multi));
    expect(index.files).toEqual(["src/a.ts"]);
  });

  it("o prefixo entra na pontuação (a raiz certa ganha)", async () => {
    const index = await indexFiles(["/ws", "/other"], fakeReader(multi));
    const hits = fuzzyFilter("other src", index.files, (item) => item);
    expect(hits.map((hit) => hit.item)).toEqual(["other/src/a.ts"]);
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
