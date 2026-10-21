/**
 * Scribe — testes da **busca na workspace** (`src/core/workspace/grep.ts`).
 *
 * O núcleo é puro: a I/O entra por `readFile` (injetado) ⇒ o teste não toca no disco.
 * O que se prova aqui:
 * - as ocorrências saem com **linha/coluna corretas** (0-based, code units UTF-16);
 * - o padrão é **literal** por default e **regex** quando pedido (`regex: true`);
 * - o **case** é ignorado por default e respeitado com `caseSensitive: true`;
 * - o acento é **insensível** (inclusive em NFD) e o dobramento é **1:1**;
 * - os **filtros** (arquivo grande, binário, ilegível) pulam o arquivo sem derrubar a busca;
 * - os **tetos** (matches/arquivos) marcam `truncated`;
 * - o **orçamento de tempo** (soft) corta a varredura **entre arquivos** e devolve o
 *   resultado parcial (com aviso);
 * - o **`AbortSignal`** cancela a leitura no meio;
 * - a leitura é **paralela** (concorrência > 1) e o resultado sai **ordenado**.
 *
 * Os textos acentuados são escritos com **escape** (`\u00e1`) de propósito: assim a
 * diferença entre a forma **pré-composta** (NFC) e a **decomposta** (NFD) fica explícita
 * (e não depende de como o arquivo foi salvo no editor).
 */
import { describe, expect, it } from "vitest";

import {
  foldAccents,
  grepWorkspace,
  GREP_DEFAULT_MAX_FILE_LENGTH,
  GREP_FILE_TOO_LARGE,
  GREP_REGEX_MAX_FILE_LENGTH,
  isCatastrophicPattern,
  stripGroupPrefixes,
} from "../src/core/workspace/grep";
import { ACCENT_FOLD_SENTINEL, hasNonAscii } from "../src/core/workspace/grep-accents";
import { CancellationError, SearchInputError } from "../src/shared";

/** "ação" pré-composto (NFC): a + ç + ã + o com o "á" em U+00E1. */
const ACAO_NFC = "\u00e1\u00e7\u00e3o";
/** "ação" decomposto (NFD): o "á" vira "a" + U+0301. */
const ACAO_NFD = "a\u0301\u00e7\u00e3o";

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
    const files = { "/w/a.txt": "\u{1F600} alvo" };
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
});

describe("grepWorkspace — o padrão regex", () => {
  it("com `regex: true` o padrão é uma expressão regular", async () => {
    const files = { "/w/a.txt": "a.c e abc" };
    const result = await grepWorkspace({
      query: "a.c",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
    });
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((m) => m.column)).toEqual([0, 6]);
  });

  it("com `regex: true` a alternância e o grupo funcionam", async () => {
    const files = { "/w/a.txt": "um dois tres" };
    const result = await grepWorkspace({
      query: "(um|tres)",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
    });
    expect(result.matches.map((m) => m.column)).toEqual([0, 8]);
  });

  it("com `regex: true` a âncora de linha casa o início do texto", async () => {
    // O `RegExp` do shared é compilado com as flags `g`/`gi` (sem `m`) ⇒ o `^` é o início
    // do texto, não o início de cada linha.
    const files = { "/w/a.txt": "alvo\nnao alvo\nalvo de novo" };
    const result = await grepWorkspace({
      query: "^alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
    });
    expect(result.matches.map((m) => m.line)).toEqual([0]);
  });

  it("com `regex: true` a dobra de acentos fica **desligada** (o texto mantém o acento)", async () => {
    // O texto é "ação" (NFC). Dobrado, ele viraria "acao" e a classe casaria 4 letras;
    // sem a dobra, só o "o" é uma letra ascii ⇒ 1 ocorrência.
    const files = { "/w/a.txt": ACAO_NFC };
    const result = await grepWorkspace({
      query: "[a-z]",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(3);
  });

  it("sem `regex` o padrão continua literal (o `|` não alterna)", async () => {
    const files = { "/w/a.txt": "um (dois) tres" };
    const result = await grepWorkspace({
      query: "(dois)",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(1);
  });

  it("uma regex inválida é recusada com o erro tipado do find bar", async () => {
    await expect(
      grepWorkspace({
        query: "(aberto",
        files: ["/w/a.txt"],
        readFile: fsOf({}),
        regex: true,
      }),
    ).rejects.toBeInstanceOf(SearchInputError);
  });
});

describe("grepWorkspace — o case", () => {
  it("por padrão o case é ignorado", async () => {
    const files = { "/w/a.txt": "ALVO alvo Alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(3);
  });

  it("com `caseSensitive: true` o case é respeitado", async () => {
    const files = { "/w/a.txt": "ALVO alvo Alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      caseSensitive: true,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(5);
  });

  it("com `caseSensitive: true` e regex o case também é respeitado", async () => {
    const files = { "/w/a.txt": "ALVO alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
      caseSensitive: true,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(5);
  });
});

describe("grepWorkspace — os acentos", () => {
  it("a query sem acento casa com o texto acentuado (pré-composto)", async () => {
    const files = { "/w/a.txt": `${ACAO_NFC}\nrea\u00e7\u00e3o` };
    const result = await grepWorkspace({
      query: "acao",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches.map((m) => m.line)).toEqual([0, 1]);
    expect(result.matches[0]?.column).toBe(0);
    // A coluna continua valendo no texto **original** (o "ç" ocupa 1 code unit).
    expect(result.matches[0]?.text).toBe(ACAO_NFC);
  });

  it("a query sem acento casa com o texto **decomposto** (NFD)", async () => {
    const files = { "/w/a.txt": `${ACAO_NFD}\noutra` };
    const result = await grepWorkspace({
      query: "acao",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.line).toBe(0);
    expect(result.matches[0]?.column).toBe(0);
    // O texto reportado é o **original** (com a marca combinante).
    expect(result.matches[0]?.text).toBe(ACAO_NFD);
  });

  it("a query em NFD casa com o texto em NFD", async () => {
    const files = { "/w/a.txt": ACAO_NFD };
    const result = await grepWorkspace({
      query: ACAO_NFD,
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(0);
  });

  it("a coluna do texto em NFD vale no texto original (a marca ocupa 1 code unit)", async () => {
    const files = { "/w/a.txt": `xx ${ACAO_NFD}` };
    const result = await grepWorkspace({
      query: "acao",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches[0]?.column).toBe(3);
  });

  it("a query sem acento casa com a base não-ASCII (tabela 1:1)", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["s\u00f8len", "solen"], // ø → o
      ["c\u0142ow", "clow"], // ł → l
      ["stra\u00dfe", "strase"], // ß → s
      ["n\u0111e", "nde"], // đ → d
      ["i\u00fe", "it"], // þ → t
      ["i\u00f0", "id"], // ð → d
      ["s\u0259l", "sel"], // ə → e
      ["b\u0138", "bk"], // ĸ → k
    ];
    for (const [text, query] of cases) {
      const result = await grepWorkspace({
        query,
        files: ["/w/a.txt"],
        readFile: fsOf({ "/w/a.txt": text }),
      });
      expect(result.matches, `texto: ${JSON.stringify(text)}`).toHaveLength(1);
      expect(result.matches[0]?.column).toBe(0);
    }
  });

  it("o `ß` dobra para `s` (e não para `ss` — a dobra é 1:1)", async () => {
    const files = { "/w/a.txt": "stra\u00dfe" };
    const result = await grepWorkspace({
      query: "strasse",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(0);
  });

  it("as escritas não-latinas ficam como estão (cirílico e grego)", async () => {
    const files = { "/w/a.txt": "\u043f\u0440\u0438\u0432\u0435\u0442 \u03b1\u03b2\u03b3" };
    const result = await grepWorkspace({
      query: "\u043f\u0440\u0438\u0432\u0435\u0442",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(0);
  });

  it("o cirílico não vira ascii (a dobra é só do que decompõe em base ASCII)", async () => {
    const files = { "/w/a.txt": "\u043f\u0440\u0438\u0432\u0435\u0442" };
    const result = await grepWorkspace({
      query: "privet",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(0);
  });

  it("com `ignoreAccents: false` o padrão acentuado só casa o texto acentuado", async () => {
    const files = { "/w/a.txt": `${ACAO_NFC} acao` };
    const result = await grepWorkspace({
      query: ACAO_NFC,
      files: Object.keys(files),
      readFile: fsOf(files),
      ignoreAccents: false,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(0);
  });

  it("com `ignoreAccents: false` o texto em NFD casa o padrão em NFD (byte a byte)", async () => {
    const files = { "/w/a.txt": `${ACAO_NFD} acao` };
    const result = await grepWorkspace({
      query: ACAO_NFD,
      files: Object.keys(files),
      readFile: fsOf(files),
      ignoreAccents: false,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.column).toBe(0);
  });
});

describe("grepWorkspace — o que é pulado", () => {
  it("pula o arquivo grande (acima de `maxFileLength`)", async () => {
    const files = { "/w/grande.txt": "alvo ".repeat(10), "/w/ok.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      maxFileLength: 10,
    });
    expect(result.matches.map((m) => m.path)).toEqual(["/w/ok.txt"]);
    expect(result.filesScanned).toBe(1);
  });

  it("o `maxFileBytes` (apelido antigo) ainda vale", async () => {
    const files = { "/w/grande.txt": "alvo ".repeat(10), "/w/ok.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      maxFileBytes: 10,
    });
    expect(result.matches.map((m) => m.path)).toEqual(["/w/ok.txt"]);
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

  it("com `includeBinary: true` o arquivo binário entra na varredura", async () => {
    const files = { "/w/bin.dat": "alvo\u0000alvo", "/w/ok.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      includeBinary: true,
    });
    expect(result.matches.map((m) => m.path)).toEqual(["/w/bin.dat", "/w/bin.dat", "/w/ok.txt"]);
    expect(result.filesScanned).toBe(2);
  });

  it("com `includeBinary: true` o binário também respeita o teto de tamanho", async () => {
    const files = { "/w/bin.dat": "alvo\u0000alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      includeBinary: true,
      maxFileLength: 4,
    });
    expect(result.matches).toHaveLength(0);
    expect(result.filesScanned).toBe(0);
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

describe("grepWorkspace — o padrão catastrófico (não trava o app)", () => {
  it("um quantificador aninhado é recusado ANTES de varrer", async () => {
    // `(a+)+` faz o `RegExp` do JS (backtracking) explorar 2^n caminhos ⇒ a busca não
    // terminaria — e, como o `grep` roda no `main`, travaria o app inteiro.
    const pending = grepWorkspace({
      query: "(a+)+$",
      files: ["/w/a.txt"],
      readFile: fsOf({ "/w/a.txt": "a".repeat(200) }),
      regex: true,
    });
    await expect(pending).rejects.toBeInstanceOf(SearchInputError);
    // O erro é **tipado** e diz o que aconteceu (o código `search.pattern`).
    await expect(pending).rejects.toMatchObject({ code: "search.pattern" });
  }, 2_000);

  it("uma alternância ambígua é recusada também", async () => {
    await expect(
      grepWorkspace({
        query: "(a|aa)+",
        files: ["/w/a.txt"],
        readFile: fsOf({ "/w/a.txt": "a".repeat(200) }),
        regex: true,
      }),
    ).rejects.toBeInstanceOf(SearchInputError);
  }, 2_000);

  it("uma alternância ambígua ANINHADA é recusada ANTES de varrer", async () => {
    // `^((a|aa))+b$` é exponencial (medido: 295 ms com n=36, dobra a cada +4 chars):
    // o `|` está **dentro** do grupo aninhado ⇒ o corpo do grupo externo não tem
    // alternância de topo (o detector antigo não via ⇒ o padrão passava).
    const lidos: string[] = [];
    const pending = grepWorkspace({
      query: "^((a|aa))+b$",
      files: ["/w/a.txt"],
      readFile: (path: string): Promise<string> => {
        lidos.push(path);
        return Promise.resolve("a".repeat(200));
      },
      regex: true,
    });
    await expect(pending).rejects.toBeInstanceOf(SearchInputError);
    await expect(pending).rejects.toMatchObject({ code: "search.pattern" });
    // O padrão é recusado **antes** da varredura (nenhum arquivo foi lido).
    expect(lidos).toEqual([]);
  }, 2_000);

  it("o prefixo de grupo (`?:`) NÃO escapa da recusa (o backtracking é o mesmo)", async () => {
    // `^((?:a|aa))+b$` tem o **mesmo** backtracking de `^((a|aa))+b$` (medido: 10,7 s em
    // 40 chars, nos dois casos) — o prefixo `?:` (grupo **não-capturante**) é **sintaxe**,
    // não conteúdo ⇒ ele não pode entrar na comparação das alternativas (o detector
    // antigo comparava "?:a" com "aa" ⇒ nenhuma era prefixo da outra ⇒ o padrão passava).
    const lidos: string[] = [];
    const pending = grepWorkspace({
      query: "^((?:a|aa))+b$",
      files: ["/w/a.txt"],
      readFile: (path: string): Promise<string> => {
        lidos.push(path);
        return Promise.resolve("a".repeat(200));
      },
      regex: true,
    });
    await expect(pending).rejects.toBeInstanceOf(SearchInputError);
    await expect(pending).rejects.toMatchObject({ code: "search.pattern" });
    // O padrão é recusado **antes** da varredura (nenhum arquivo foi lido).
    expect(lidos).toEqual([]);
  }, 2_000);


  it("uma regex normal NÃO é recusida (a detecção é conservadora)", async () => {
    const files = { "/w/a.txt": "um dois tres" };
    const result = await grepWorkspace({
      query: "(um|tres)",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
    });
    expect(result.matches).toHaveLength(2);
    // "a+b" (quantificador simples) e "[a-z]+" (classe) também passam.
    const simples = await grepWorkspace({
      query: "a+b",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
    });
    expect(simples.matches).toHaveLength(0);
  });

  it("o padrão literal nunca é catastrófico (o `(` é escapado)", async () => {
    const files = { "/w/a.txt": "(a+)+" };
    const result = await grepWorkspace({
      query: "(a+)+",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.matches).toHaveLength(1);
  });
});

describe("grepWorkspace — o port de leitura respeita o teto", () => {
  it("o port recebe o teto do arquivo", async () => {
    const limits: number[] = [];
    await grepWorkspace({
      query: "alvo",
      files: ["/w/a.txt"],
      readFile: (_path: string, maxLength: number): Promise<string> => {
        limits.push(maxLength);
        return Promise.resolve("alvo");
      },
    });
    expect(limits).toEqual([GREP_DEFAULT_MAX_FILE_LENGTH]);
  });

  it("o port que sinaliza 'grande demais' ⇒ o arquivo é pulado com aviso", async () => {
    const errors: string[] = [];
    const result = await grepWorkspace({
      query: "alvo",
      files: ["/w/grande.txt"],
      readFile: (): Promise<string> =>
        Promise.reject(
          Object.assign(new Error("arquivo grande demais"), { code: GREP_FILE_TOO_LARGE }),
        ),
      onError: (path, error) => errors.push(`${path}: ${error.message}`),
    });
    expect(result.matches).toHaveLength(0);
    expect(result.filesScanned).toBe(0);
    // A mensagem diz o teto (o usuário precisa saber por que o arquivo sumiu).
    expect(errors.join("\n")).toContain(String(GREP_DEFAULT_MAX_FILE_LENGTH));
  });

  it("o port que ignora o teto ⇒ o arquivo grande é pulado (com aviso)", async () => {
    const errors: string[] = [];
    const result = await grepWorkspace({
      query: "alvo",
      files: ["/w/grande.txt"],
      readFile: (): Promise<string> => Promise.resolve("alvo ".repeat(100)),
      maxFileLength: 10,
      onError: (path, error) => errors.push(`${path}: ${error.message}`),
    });
    expect(result.matches).toHaveLength(0);
    expect(errors.join("\n")).toContain("10");
  });
});

describe("grepWorkspace — o teto do modo regex é mais estrito", () => {
  it("no modo regex, o teto efetivo é o de 64 KiB", async () => {
    const grande = "alvo ".repeat(20_000); // ~100 KiB
    const literal = await grepWorkspace({
      query: "alvo",
      files: ["/w/a.txt"],
      readFile: fsOf({ "/w/a.txt": grande }),
    });
    expect(literal.filesScanned).toBe(1);
    const regex = await grepWorkspace({
      query: "alvo",
      files: ["/w/a.txt"],
      readFile: fsOf({ "/w/a.txt": grande }),
      regex: true,
    });
    expect(regex.filesScanned).toBe(0);
    expect(GREP_REGEX_MAX_FILE_LENGTH).toBe(64 * 1024);
  });
});

describe("grepWorkspace — os avisos (nunca um crash)", () => {
  it("no modo regex, o descarte do acento-insensitivo é explícito", async () => {
    const files = { "/w/a.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
    });
    expect(result.warnings ?? []).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("acento");
  });

  it("com `ignoreAccents: false` no modo regex, não há aviso", async () => {
    const files = { "/w/a.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      regex: true,
      ignoreAccents: false,
    });
    expect(result.warnings ?? []).toHaveLength(0);
  });

  it("no modo literal, não há aviso", async () => {
    const files = { "/w/a.txt": "alvo" };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
    });
    expect(result.warnings ?? []).toHaveLength(0);
  });
});

describe("grepWorkspace — o orçamento de tempo (soft)", () => {
  it("estoura o orçamento ⇒ resultado incompleto, com aviso, e preserva o que já achou", async () => {
    const files = {
      "/w/a.txt": "alvo um",
      "/w/b.txt": "alvo dois",
      "/w/c.txt": "alvo três",
    };
    // Um relógio que "anda": 1 s por chamada. O orçamento (1,5 s) estoura no **segundo**
    // arquivo ⇒ o primeiro já varrido é preservado, o terceiro nunca é lido.
    let tick = 0;
    const now = (): number => {
      tick += 1000;
      return tick;
    };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      concurrency: 1,
      budgetMs: 1500,
      now,
    });
    expect(result.truncated).toBe(true);
    // O aviso do orçamento está lá (texto exato).
    expect(result.warnings ?? []).toContain(
      "a busca foi interrompida por tempo (1500 ms) — o resultado está incompleto",
    );
    // O que já foi encontrado é **preservado** (resultado parcial honesto).
    expect(result.matches.map((m) => m.path)).toEqual(["/w/a.txt"]);
    expect(result.filesScanned).toBe(1);
  });

  it("o orçamento não estourado ⇒ `truncated: false` e nenhum aviso", async () => {
    const files = { "/w/a.txt": "alvo", "/w/b.txt": "alvo" };
    // Um relógio que **não** anda: o orçamento nunca estoura.
    const now = (): number => 1000;
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      budgetMs: 1500,
      now,
    });
    expect(result.truncated).toBe(false);
    expect(result.warnings ?? []).toHaveLength(0);
    expect(result.matches).toHaveLength(2);
    expect(result.filesScanned).toBe(2);
  });

  it("`budgetMs <= 0` ⇒ sem orçamento (a busca nunca é cortada por tempo)", async () => {
    const files = { "/w/a.txt": "alvo", "/w/b.txt": "alvo" };
    // O relógio "anda" sem parar — mas, sem orçamento, a varredura vai até o fim.
    let tick = 0;
    const now = (): number => {
      tick += 1000;
      return tick;
    };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      budgetMs: 0,
      now,
    });
    expect(result.truncated).toBe(false);
    expect(result.warnings ?? []).toHaveLength(0);
    expect(result.matches).toHaveLength(2);
    expect(result.filesScanned).toBe(2);
  });

  it("a varredura que COMPLETOU não é truncada (o relógio estourou na volta)", async () => {
    const files = { "/w/a.txt": "alvo" };
    // Um relógio que "anda" 1 s por chamada: a checagem do orçamento vem **depois** do
    // guard de "não há mais candidatos" ⇒ o estouro na **volta** (depois do único arquivo)
    // **não** marca a varredura como truncada — o resultado está **completo**.
    let tick = 0;
    const now = (): number => {
      tick += 1000;
      return tick;
    };
    const result = await grepWorkspace({
      query: "alvo",
      files: Object.keys(files),
      readFile: fsOf(files),
      concurrency: 1,
      budgetMs: 1500,
      now,
    });
    expect(result.truncated).toBe(false);
    expect(result.warnings ?? []).toHaveLength(0);
    expect(result.filesScanned).toBe(1);
    expect(result.matches).toHaveLength(1);
  });
});

describe("hasNonAscii — o teste rápido do dobramento", () => {
  it("diz se o texto tem algum caractere não-ASCII", () => {
    expect(hasNonAscii("ascii simples")).toBe(false);
    expect(hasNonAscii("")).toBe(false);
    expect(hasNonAscii(ACAO_NFC)).toBe(true);
    expect(hasNonAscii(ACAO_NFD)).toBe(true);
    expect(hasNonAscii("\u043f\u0440\u0438\u0432\u0435\u0442")).toBe(true);
    expect(hasNonAscii("\u{1F600}")).toBe(true);
  });
});

describe("isCatastrophicPattern — o detector de padrão catastrófico", () => {
  it("acusa o quantificador aninhado", () => {
    expect(isCatastrophicPattern("(a+)+")).toBe(true);
    expect(isCatastrophicPattern("(a+)+$")).toBe(true);
    expect(isCatastrophicPattern("(a*)*")).toBe(true);
    expect(isCatastrophicPattern("(?:ab+)+")).toBe(true);
    expect(isCatastrophicPattern("((a+))+")).toBe(true);
  });

  it("acusa a alternância ambígua", () => {
    expect(isCatastrophicPattern("(a|aa)+")).toBe(true);
    expect(isCatastrophicPattern("(a|a)*")).toBe(true);
    expect(isCatastrophicPattern("(a*|b)+")).toBe(true);
  });

  it("acusa a alternância ambígua ANINHADA (o `|` dentro do grupo aninhado)", () => {
    // O `|` do grupo **aninhado** não é uma alternativa de topo do corpo do grupo
    // externo ⇒ o detector antigo (que só olhava o topo) deixava passar.
    expect(isCatastrophicPattern("^((a|aa))+b$")).toBe(true);
    expect(isCatastrophicPattern("((a|aa))+")).toBe(true);
    expect(isCatastrophicPattern("(x(y|yy))+")).toBe(true);
    expect(isCatastrophicPattern("((a|ab))+")).toBe(true);
  });

  it("NÃO acusa as regex normais (a detecção é conservadora)", () => {
    expect(isCatastrophicPattern("(um|tres)")).toBe(false);
    expect(isCatastrophicPattern("(foo|far)+")).toBe(false);
    expect(isCatastrophicPattern("a+b")).toBe(false);
    expect(isCatastrophicPattern("[a-z]+")).toBe(false);
    expect(isCatastrophicPattern("(ab|ac)+")).toBe(false);
    expect(isCatastrophicPattern("https?://")).toBe(false);
    expect(isCatastrophicPattern("")).toBe(false);
    // As alternativas **distintas** (nenhuma é prefixo da outra) não se sobrepõem.
    expect(isCatastrophicPattern("(foo|bar)+")).toBe(false);
    expect(isCatastrophicPattern("(a|b|c)+")).toBe(false);
    // Quantificadores **limitados** e classes não são catastróficos.
    expect(isCatastrophicPattern("\\d{2,4}")).toBe(false);
    expect(isCatastrophicPattern("(\\w+)")).toBe(false);
    // Um grupo aninhado **sem** alternância não é ambíguo.
    expect(isCatastrophicPattern("((ab|cd))+")).toBe(false);
  });

  it("acusa a alternância ambígua com PREFIXO de grupo (`(?:…|…)`)", () => {
    // O prefixo `?:` (grupo não-capturante) é **sintaxe**, não conteúdo ⇒ ele não pode
    // entrar na comparação das alternativas (o detector antigo comparava "?:a" com "aa" ⇒
    // nenhuma era prefixo da outra ⇒ o padrão **exponencial** escapava da detecção).
    expect(isCatastrophicPattern("^((?:a|aa))+b$")).toBe(true);
    expect(isCatastrophicPattern("(?:a|aa)+")).toBe(true);
    // O **mesmo** backtracking do padrão sem prefixo ⇒ a recusa tem de ser a mesma.
    expect(isCatastrophicPattern("^((a|aa))+b$")).toBe(true);
    // O prefixo não **cria** ambiguidade: as alternativas distintas continuam permitidas.
    expect(isCatastrophicPattern("(?:foo|bar)+")).toBe(false);
    expect(isCatastrophicPattern("(?:a|b|c)+")).toBe(false);
  });

  it("o teto de profundidade cobre o aninhamento real (33/40/60 níveis)", () => {
    // Medido: o padrão real (40 níveis) faz 5,5 s de backtracking em 34 chars (cresce
    // exponencialmente) — o teto antigo (32) **deixava passar** 33/40/60 níveis.
    for (const levels of [33, 40, 60]) {
      const pattern = `${"(".repeat(levels)}(a|aa)${")".repeat(levels)}+`;
      expect(isCatastrophicPattern(pattern), `nível ${levels}`).toBe(true);
    }
  });

  it("200+ níveis não estouram a pilha (o aninhamento do usuário cabe)", () => {
    // O teto de profundidade é 256 ⇒ 200 níveis são **analisados por inteiro** (sem
    // `RangeError`) — e o padrão **inofensivo** no mesmo aninhamento continua permitido
    // (a detecção não vira "recusa tudo que é fundo").
    const profundo = `${"(".repeat(200)}(a|aa)${")".repeat(200)}+`;
    expect(() => isCatastrophicPattern(profundo)).not.toThrow();
    expect(isCatastrophicPattern(profundo)).toBe(true);
    const inofensivo = `${"(".repeat(200)}a${")".repeat(200)}+`;
    expect(isCatastrophicPattern(inofensivo)).toBe(false);
  });


  it("a recursão não estoura a pilha (padrão muito aninhado)", () => {
    // 30 levels de parênteses: a análise recursiva tem teto de profundidade ⇒ devolve
    // (true ou false) — nunca um `RangeError` (o app não pode cair por um padrão).
    const profundo = `${"(".repeat(30)}(a|aa)${")".repeat(30)}+`;
    expect(() => isCatastrophicPattern(profundo)).not.toThrow();
    // O padrão sem alternância no fundo: nada de catastrófico.
    const inofensivo = `${"(".repeat(30)}a${")".repeat(30)}+`;
    expect(isCatastrophicPattern(inofensivo)).toBe(false);
  });
});

describe("stripGroupPrefixes — o prefixo de grupo é sintaxe, não conteúdo", () => {
  it("remove o prefixo do começo e logo depois de um `(`", () => {
    expect(stripGroupPrefixes("?:a|aa")).toBe("a|aa");
    expect(stripGroupPrefixes("(?:a|aa)")).toBe("(a|aa)");
    expect(stripGroupPrefixes("(?=a)b")).toBe("(a)b");
    expect(stripGroupPrefixes("(?!a)b")).toBe("(a)b");
    expect(stripGroupPrefixes("(?<nome>a)")).toBe("(a)");
    expect(stripGroupPrefixes("(?<=a)b")).toBe("(a)b");
    expect(stripGroupPrefixes("(?<!a)b")).toBe("(a)b");
  });

  it("preserva um `?` que NÃO é prefixo (o quantificador e o marcador *lazy*)", () => {
    expect(stripGroupPrefixes("a?b")).toBe("a?b");
    expect(stripGroupPrefixes("a?:b")).toBe("a?:b");
    expect(stripGroupPrefixes("*?a")).toBe("*?a");
    expect(stripGroupPrefixes("(a)?")).toBe("(a)?");
  });
});


describe("foldAccents — o dobramento de acento", () => {
  it("tira o acento preservando o tamanho (1 code unit ⇒ 1)", () => {
    expect(foldAccents(ACAO_NFC)).toBe("acao");
    expect(foldAccents("\u00e7\u00e3o")).toBe("cao");
    expect(foldAccents("A\u00c7\u00c3O")).toBe("ACAO");
    expect(ACAO_NFC.length).toBe(foldAccents(ACAO_NFC).length);
  });

  it("a marca combinante (NFD) vira **1** code unit que não casa com nada", () => {
    const folded = foldAccents("a\u0301cao");
    expect(folded).toBe(`a${ACCENT_FOLD_SENTINEL}cao`);
    expect(folded.length).toBe("a\u0301cao".length);
    // O sentinela não é uma letra: o padrão "acao" não casa com ele.
    expect(folded).not.toContain("acao");
  });

  it("dobra as bases não-ASCII (tabela 1:1)", () => {
    expect(foldAccents("\u00f8")).toBe("o");
    expect(foldAccents("\u00d8")).toBe("O");
    expect(foldAccents("\u0142")).toBe("l");
    expect(foldAccents("\u0141")).toBe("L");
    expect(foldAccents("\u0111")).toBe("d");
    expect(foldAccents("\u00fe")).toBe("t");
    expect(foldAccents("\u00f0")).toBe("d");
    expect(foldAccents("\u00df")).toBe("s");
    expect(foldAccents("\u0259")).toBe("e");
    expect(foldAccents("\u0138")).toBe("k");
  });

  it("preserva as escritas não-latinas", () => {
    expect(foldAccents("\u043f\u0440\u0438\u0432\u0435\u0442")).toBe("\u043f\u0440\u0438\u0432\u0435\u0442");
    expect(foldAccents("\u03b1\u03b2\u03b3")).toBe("\u03b1\u03b2\u03b3");
    expect(foldAccents("\u0439")).toBe("\u0439");
  });

  it("preserva emojis (par substituto) e o tamanho do texto", () => {
    const text = "\u{1F600} a\u00e7\u00e3o";
    expect(foldAccents(text)).toBe("\u{1F600} acao");
    expect(foldAccents(text).length).toBe(text.length);
  });

  it("PROPRIEDADE: o dobramento é 1:1 numa amostra de textos", () => {
    for (const text of sampleTexts()) {
      const folded = foldAccents(text);
      expect(folded.length, `dobrou: ${JSON.stringify(text)}`).toBe(text.length);
    }
  });
});

/** Uma amostra determinística de textos (ASCII, acentos, NFD, não-latinas, emoji). */
function sampleTexts(): string[] {
  const fixed = [
    "",
    "ascii simples",
    ACAO_NFC,
    ACAO_NFD,
    "A\u00c7\u00c3O",
    "\u00f8\u00df \u0138\u0142 \u0111 \u00fe \u00f0",
    "\u{1F600} a\u00e7\u00e3o",
    "\u043f\u0440\u0438\u0432\u0435\u0442 \u03b1\u03b2\u03b3",
    "\u00e1\u00ea\u00ee\u00f5\u00fc \u00e7",
    "\u00c5ngstr\u00f6m",
    "Ma'am",
    "tab\tlinha\nnova",
  ];
  const pool =
    "abc\u00e1\u00e0\u00e2\u00e3\u00e4\u00e5\u00e7\u0107\u010d\u0111\u00e8\u00e9\u00ea\u00eb" +
    "\u0113\u0142\u0144\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f8\u0159\u015b\u0159\u0161" +
    "\u015f\u0165\u00f9\u00fa\u00fb\u00fc\u00fd\u017e\u017a\u00df\u00d0\u00de\u0131" +
    "\u0391\u0392\u0393\u0430\u0431\u0432\u{1F600}\u0300\u0301\u0308";
  // LCG determinístico (o `Math.random` quebraria a reprodutibilidade do teste).
  let seed = 42;
  const next = (): number => {
    seed = (seed * 48271) % 2147483647;
    return seed;
  };
  const random: string[] = [];
  for (let i = 0; i < 200; i++) {
    const length = next() % 12;
    let text = "";
    for (let j = 0; j < length; j++) text += pool[next() % pool.length];
    random.push(text);
  }
  return [...fixed, ...random];
}
