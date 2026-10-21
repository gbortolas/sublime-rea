/**
 * Scribe — testes da **busca na workspace** (`src/core/workspace/grep.ts`).
 *
 * O núcleo é puro: a I/O entra por `readFile` (injetado) ⇒ o teste não toca no disco.
 * O que se prova aqui:
 * - as ocorrências saem com **linha/coluna corretas** (0-based, code units UTF-16);
 * - os **filtros** (arquivo grande, binário, ilegível) pulam o arquivo sem derrubar a busca;
 * - os **tetos** (matches/arquivos) marcam `truncated`;
 * - o **`AbortSignal`** cancela a leitura no meio;
 * - a leitura é **paralela** (concorrência > 1) e o resultado sai **ordenado**.
 */
import { describe, expect, it } from "vitest";

import { foldAccents, grepWorkspace } from "../src/core/workspace/grep";
import { CancellationError, SearchInputError } from "../src/shared";

/** `FileSystem` em memória (o teste não toca no disco). */
function fsOf(files: Readonly<Record<string, string>>): (path: string) => Promise<string> {
  return (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(text);
  };
}

describe("grepWorkspace — as ocorrências", () => {
  it("acha a ocorrência com a linha e a coluna corretas (0-based)", async () => {
    const files = { "/w/a.txt": "linha um\nlinha dois alvo\nlinha tres" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toEqual([
      { path: "/w/a.txt", line: 1, column: 11, text: "linha dois alvo" },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.filesScanned).toBe(1);
  });

  it("a coluna conta code units UTF-16 (o emoji vale 2)", async () => {
    const files = { "/w/a.txt": "😀 alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches[0]?.column).toBe(3);
    expect(result.matches[0]?.line).toBe(0);
  });

  it("acha várias ocorrências na mesma linha (colunas diferentes)", async () => {
    const files = { "/w/a.txt": "alvo e alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches.map((m) => m.column)).toEqual([0, 7]);
    expect(result.matches.every((m) => m.line === 0)).toBe(true);
  });

  it("a ocorrência traz o texto da linha inteira", async () => {
    const files = { "/w/a.txt": "primeira\n  indentada alvo\n" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches[0]?.text).toBe("  indentada alvo");
  });

  it("ordena o resultado por (path, line, column)", async () => {
    const files = {
      "/w/b.txt": "alvo\nalvo",
      "/w/a.txt": "alvo",
    };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches.map((m) => `${m.path}:${m.line}:${m.column}`)).toEqual([
      "/w/a.txt:0:0",
      "/w/b.txt:0:0",
      "/w/b.txt:1:0",
    ]);
  });

  it("o padrão é literal (o `.` não casa com qualquer coisa)", async () => {
    const files = { "/w/a.txt": "a.c e abc" };
    const result = await grepWorkspace({
      query: "a.c",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(0);
  });

  it("o case é ignorado", async () => {
    const files = { "/w/a.txt": "ALVO" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(1);
  });

  it("a query sem acento casa com o texto acentuado", async () => {
    const files = { "/w/a.txt": "ação\nreação" };
    const result = await grepWorkspace({
      query: "acao",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches.map((m) => m.line)).toEqual([0, 1]);
    expect(result.matches[0]?.column).toBe(0);
    // A coluna continua valendo no texto **original** (o "ç" ocupa 1 code unit).
    expect(result.matches[0]?.text).toBe("ação");
  });

  it("com `ignoreAccents: false` o padrão acentuado só casa o texto acentuado", async () => {
    const files = { "/w/a.txt": "ação acao" };
    const result = await grepWorkspace({
      query: "ação",
      files: Object.keys(files),
      readFile: fsOf(files),
      ignoreAccents: false,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(0);
  });
});

describe("grepWorkspace — o que é pulado", () => {
  it("pula o arquivo grande (acima de `maxFileBytes`)", async () => {
    const files = { "/w/grande.txt": "alvo ".repeat(10), "/w/ok.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      maxFileBytes: 10,
    });
    expect(result.matches.map((m) => m.path)).toEqual(["/w/ok.txt"]);
    expect(result.filesScanned).toBe(1);
  });

  it("pula o arquivo binário (contém NUL)", async () => {
    const files = { "/w/bin.dat": "alvo\u0000alvo", "/w/ok.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches.map((m) => m.path)).toEqual(["/w/ok.txt"]);
    expect(result.filesScanned).toBe(1);
  });

  it("um arquivo ilegível (diretório) é pulado e a busca continua", async () => {
    const files = { "/w/ok.txt": "alvo" };
    const errors: string[] = [];
    const result = await grepWorkspace({
      query: "alvo",
      files: ["/w/dir", "/w/ok.txt"],
      readFile: (path: string) =>
        path === "/w/dir" ? Promise.reject(new Error("EISDIR")) : fsOf(files)(path),
      onError: (path) => errors.push(path),
    });
    expect(result.matches.map((m) => m.path)).toEqual(["/w/ok.txt"]);
    expect(errors).toEqual(["/w/dir"]);
  });

  it("o padrão vazio é recusado com o erro tipado do find bar", async () => {
    await expect(
      grepWorkspace({ query: "", files: ["/w/a.txt"], readFile: fsOf({}) }),
    ).rejects.toBeInstanceOf(SearchInputError);
  });
});

describe("grepWorkspace — tetos e truncamento", () => {
  it("trunca quando passa do teto de matches", async () => {
    const files = { "/w/a.txt": "alvo ".repeat(10) };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      maxMatches: 3,
    });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("não marca `truncated` quando cabe tudo no teto", async () => {
    const files = { "/w/a.txt": "alvo ".repeat(3) };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      maxMatches: 3,
    });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("o teto de arquivos (default 2000) marca `truncated`", async () => {
    const files = Array.from({ length: 2001 }, (_, i) => `/w/f${i}.txt`);
    const result = await grepWorkspace({
      query: "alvo",
      files,
      // Nenhum match: o que para a busca aqui é o **teto de arquivos**, não o de matches.
      readFile: () => Promise.resolve("nada aqui"),
    });
    expect(result.filesScanned).toBe(2000);
    expect(result.truncated).toBe(true);
  });

  it("o teto de arquivos (explícito) limita os arquivos varridos", async () => {
    const files = ["/w/a.txt", "/w/b.txt", "/w/c.txt", "/w/d.txt"];
    const result = await grepWorkspace({
      query: "alvo",
      files,
      readFile: (path: string) => Promise.resolve(`alvo em ${path}`),
      maxFiles: 2,
    });
    expect(result.filesScanned).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe("grepWorkspace — cancelamento e paralelismo", () => {
  it("o `signal` aborta cancela a leitura no meio", async () => {
    const controller = new AbortController();
    const pending = grepWorkspace({
      query: "alvo",
      files: ["/w/a.txt"],
      readFile: () => new Promise<string>(() => undefined),
      signal: controller.signal,
    });
    controller.abort("parou");
    await expect(pending).rejects.toBeInstanceOf(CancellationError);
  });

  it("um sinal já abortado nem começa a busca", async () => {
    const controller = new AbortController();
    controller.abort("antes");
    let called = false;
    await expect(
      grepWorkspace({
        query: "alvo",
        files: ["/w/a.txt"],
        readFile: (path: string) => {
          called = true;
          return Promise.resolve(path);
        },
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancellationError);
    expect(called).toBe(false);
  });

  it("lê os arquivos em paralelo (concorrência > 1)", async () => {
    let active = 0;
    let maxActive = 0;
    const readFile = async (path: string): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `alvo em ${path}`;
    };
    const files = Array.from({ length: 8 }, (_, i) => `/w/f${i}.txt`);
    const result = await grepWorkspace({ query: "alvo", files, readFile });
    expect(result.filesScanned).toBe(8);
    expect(maxActive).toBe(8);
  });
});

describe("foldAccents — o dobramento de acento", () => {
  it("tira o acento preservando o tamanho (1 code unit ⇒ 1)", () => {
    expect(foldAccents("ação")).toBe("acao");
    expect(foldAccents("ção")).toBe("cao");
    expect(foldAccents("AÇÃO")).toBe("ACAO");
    expect("ação".length).toBe(foldAccents("ação").length);
  });

  it("preserva o que não decompõe (ø, ß) e o que já é ASCII", () => {
    expect(foldAccents("øß abc")).toBe("øß abc");
  });

  it("preserva emojis (par substituto) e o tamanho do texto", () => {
    const text = "😀 ação";
    expect(foldAccents(text)).toBe("😀 acao");
    expect(foldAccents(text).length).toBe(text.length);
  });
});
