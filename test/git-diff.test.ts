/**
 * Scribe — testes do **parser de diff unificado** (`src/core/git/git-diff.ts`).
 *
 * O parser é **puro** (entra o texto do `git diff`, sai a estrutura) ⇒ os testes são
 * só de parsing: nenhum `git` é executado aqui.
 *
 * Os casos "tricky" cobertos: path com **espaço**, path com **timestamp** (formato
 * `diff -u`), arquivo **novo** (`--- /dev/null`), arquivo **removido** (`+++ /dev/null`),
 * `\ No newline at end of file`, linha removida cujo conteúdo começa com `--` (parece
 * cabeçalho de arquivo) e diff **vazio**.
 */
import { describe, expect, it } from "vitest";

import {
  countHunkChanges,
  isNullPath,
  parseDiffHeaderPath,
  parseUnifiedDiff,
  parseUnifiedDiffFiles,
  summarizeDiff,
} from "../src/core/git/git-diff";

const DIFF_ONE_HUNK = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@ função()",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "",
].join("\n");

const DIFF_TWO_HUNKS = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+TWO",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+eleven",
  " twelve",
  "",
].join("\n");

const DIFF_NEW_FILE = [
  "diff --git a/novo.txt b/novo.txt",
  "new file mode 100644",
  "index 0000000..e69de29",
  "--- /dev/null",
  "+++ b/novo.txt",
  "@@ -0,0 +1,2 @@",
  "+linha 1",
  "+linha 2",
  "",
].join("\n");

const DIFF_DELETED_FILE = [
  "diff --git a/velho.txt b/velho.txt",
  "deleted file mode 100644",
  "index e69de29..0000000",
  "--- a/velho.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-linha 1",
  "-linha 2",
  "",
].join("\n");

const DIFF_PATH_WITH_SPACE = [
  "diff --git a/meu arquivo.txt b/meu arquivo.txt",
  "index 1111111..2222222 100644",
  "--- a/meu arquivo.txt",
  "+++ b/meu arquivo.txt",
  "@@ -1 +1 @@",
  "-antigo",
  "+novo",
  "",
].join("\n");

describe("parseUnifiedDiff — um arquivo, um hunk", () => {
  it("lê o cabeçalho do hunk", () => {
    const hunks = parseUnifiedDiff(DIFF_ONE_HUNK);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0];
    expect(hunk?.header).toBe("@@ -1,3 +1,4 @@ função()");
    expect(hunk?.section).toBe("função()");
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.oldLines).toBe(3);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.newLines).toBe(4);
  });

  it("lê os caminhos do arquivo (sem o prefixo a/ b/)", () => {
    const hunk = parseUnifiedDiff(DIFF_ONE_HUNK)[0];
    expect(hunk?.oldPath).toBe("src/foo.ts");
    expect(hunk?.newPath).toBe("src/foo.ts");
  });

  it("classifica as linhas e numera o arquivo novo e o antigo", () => {
    const hunk = parseUnifiedDiff(DIFF_ONE_HUNK)[0];
    const lines = hunk?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["ctx", "del", "add", "add", "ctx"]);
    expect(lines[0]?.oldLine).toBe(1);
    expect(lines[0]?.newLine).toBe(1);
    expect(lines[1]?.oldLine).toBe(2);
    expect(lines[1]?.newLine).toBeUndefined();
    expect(lines[2]?.newLine).toBe(2);
    expect(lines[2]?.oldLine).toBeUndefined();
    expect(lines[3]?.newLine).toBe(3);
    expect(lines[4]?.oldLine).toBe(3);
    expect(lines[4]?.newLine).toBe(4);
  });

  it("tira o prefixo do conteúdo (o texto é a linha sem + - ou espaço)", () => {
    const lines = parseUnifiedDiff(DIFF_ONE_HUNK)[0]?.lines ?? [];
    expect(lines[1]?.text).toBe("const b = 2;");
    expect(lines[2]?.text).toBe("const b = 3;");
    expect(lines[0]?.text).toBe("const a = 1;");
  });
});

describe("parseUnifiedDiff — vários hunks", () => {
  it("devolve um hunk por bloco @@", () => {
    const hunks = parseUnifiedDiff(DIFF_TWO_HUNKS);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toBe("@@ -1,2 +1,2 @@");
    expect(hunks[1]?.header).toBe("@@ -10,2 +10,3 @@");
    expect(hunks[1]?.oldStart).toBe(10);
    expect(hunks[1]?.newStart).toBe(10);
  });

  it("numera cada hunk a partir do seu próprio início", () => {
    const hunks = parseUnifiedDiff(DIFF_TWO_HUNKS);
    const second = hunks[1]?.lines ?? [];
    expect(second.map((line) => line.kind)).toEqual(["ctx", "add", "ctx"]);
    expect(second[0]?.oldLine).toBe(10);
    expect(second[1]?.newLine).toBe(11);
    expect(second[2]?.oldLine).toBe(11);
    expect(second[2]?.newLine).toBe(12);
  });
});

describe("parseUnifiedDiff — arquivo novo (--- /dev/null)", () => {
  it("o lado antigo é /dev/null e o hunk começa em 0", () => {
    const hunk = parseUnifiedDiff(DIFF_NEW_FILE)[0];
    expect(hunk?.oldPath).toBe("/dev/null");
    expect(isNullPath(hunk?.oldPath ?? "")).toBe(true);
    expect(hunk?.newPath).toBe("novo.txt");
    expect(hunk?.oldStart).toBe(0);
    expect(hunk?.oldLines).toBe(0);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.newLines).toBe(2);
  });

  it("todas as linhas são adições", () => {
    const lines = parseUnifiedDiff(DIFF_NEW_FILE)[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["add", "add"]);
    expect(lines[0]?.newLine).toBe(1);
    expect(lines[1]?.newLine).toBe(2);
  });
});

describe("parseUnifiedDiff — arquivo removido (+++ /dev/null)", () => {
  it("o lado novo é /dev/null e o hunk termina em 0", () => {
    const hunk = parseUnifiedDiff(DIFF_DELETED_FILE)[0];
    expect(hunk?.oldPath).toBe("velho.txt");
    expect(hunk?.newPath).toBe("/dev/null");
    expect(isNullPath(hunk?.newPath ?? "")).toBe(true);
    expect(hunk?.newStart).toBe(0);
    expect(hunk?.newLines).toBe(0);
  });

  it("todas as linhas são remoções (com o número do arquivo antigo)", () => {
    const lines = parseUnifiedDiff(DIFF_DELETED_FILE)[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["del", "del"]);
    expect(lines[0]?.oldLine).toBe(1);
    expect(lines[1]?.oldLine).toBe(2);
    expect(lines[0]?.newLine).toBeUndefined();
  });
});

describe("parseUnifiedDiff — path com espaço", () => {
  it("o caminho é tudo depois do prefixo a/ b/", () => {
    const hunk = parseUnifiedDiff(DIFF_PATH_WITH_SPACE)[0];
    expect(hunk?.oldPath).toBe("meu arquivo.txt");
    expect(hunk?.newPath).toBe("meu arquivo.txt");
  });

  it("o cabeçalho @@ sem contagem vale 1 linha", () => {
    const hunk = parseUnifiedDiff(DIFF_PATH_WITH_SPACE)[0];
    expect(hunk?.oldLines).toBe(1);
    expect(hunk?.newLines).toBe(1);
  });

  it("o timestamp (separado por TAB) é cortado", () => {
    const path = parseDiffHeaderPath("a/com data.txt\t2024-01-01 10:00:00.000000000 +0000");
    expect(path).toBe("com data.txt");
  });

  it("um path entre aspas (quoting do git) é des-quoted", () => {
    const path = parseDiffHeaderPath('"a/tab\\tAqui.txt"');
    expect(path).toBe("tab\tAqui.txt");
  });
});

describe("parseUnifiedDiff — \\ No newline at end of file", () => {
  it("no fim do hunk vira uma linha meta (não conta para as contagens)", () => {
    const diff = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,1 +1,1 @@",
      "-antigo",
      "\\ No newline at end of file",
      "+novo",
      "",
    ].join("\n");
    const lines = parseUnifiedDiff(diff)[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["del", "meta", "add"]);
    expect(lines[1]?.text).toContain("No newline at end of file");
  });

  it("depois da última linha do hunk também vira meta", () => {
    const diff = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,1 +1,1 @@",
      "-antigo",
      "+novo",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const lines = parseUnifiedDiff(diff)[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["del", "add", "meta"]);
  });
});

describe("parseUnifiedDiff — diff vazio", () => {
  it("não devolve hunk nenhum", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("\n")).toEqual([]);
  });

  it("não devolve arquivo nenhum", () => {
    expect(parseUnifiedDiffFiles("")).toEqual([]);
  });
});

describe("parseUnifiedDiffFiles — agrupamento por arquivo", () => {
  const diff = [
    "diff --git a/um.txt b/um.txt",
    "index 1111111..2222222 100644",
    "--- a/um.txt",
    "+++ b/um.txt",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "diff --git a/dois.txt b/dois.txt",
    "index 3333333..4444444 100644",
    "--- a/dois.txt",
    "+++ b/dois.txt",
    "@@ -1,1 +1,1 @@",
    "-c",
    "+d",
    "",
  ].join("\n");

  it("separa os arquivos", () => {
    const files = parseUnifiedDiffFiles(diff);
    expect(files).toHaveLength(2);
    expect(files[0]?.newPath).toBe("um.txt");
    expect(files[1]?.newPath).toBe("dois.txt");
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[1]?.hunks).toHaveLength(1);
  });

  it("guarda o cabeçalho do arquivo como meta", () => {
    const files = parseUnifiedDiffFiles(diff);
    const kinds = files[0]?.meta.map((line) => line.kind) ?? [];
    expect(kinds.every((kind) => kind === "meta")).toBe(true);
    expect(files[0]?.meta[0]?.text).toBe("diff --git a/um.txt b/um.txt");
  });

  it("a lista plana de hunks traz os dois arquivos", () => {
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.newPath).toBe("um.txt");
    expect(hunks[1]?.newPath).toBe("dois.txt");
  });
});

describe("parseUnifiedDiffFiles — casos de borda", () => {
  it("uma linha removida que começa com -- não vira cabeçalho de arquivo", () => {
    const diff = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,1 @@",
      "--- x",
      " keep",
      "",
    ].join("\n");
    const lines = parseUnifiedDiff(diff)[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["del", "ctx"]);
    expect(lines[0]?.text).toBe("-- x");
  });

  it("arquivo binário: cabeçalho meta e nenhum hunk", () => {
    const diff = [
      "diff --git a/img.png b/img.png",
      "index aaaaaaa..bbbbbbb 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiffFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.hunks).toHaveLength(0);
    expect(files[0]?.newPath).toBe("img.png");
  });

  it("rename sem alteração: os caminhos vêm de rename from/rename to", () => {
    const diff = [
      "diff --git a/velho nome.txt b/novo nome.txt",
      "similarity index 100%",
      "rename from velho nome.txt",
      "rename to novo nome.txt",
      "",
    ].join("\n");
    const files = parseUnifiedDiffFiles(diff);
    expect(files[0]?.oldPath).toBe("velho nome.txt");
    expect(files[0]?.newPath).toBe("novo nome.txt");
    expect(files[0]?.hunks).toHaveLength(0);
  });

  it("aceita CRLF: o cabeçalho perde o \\r, o **conteúdo** guarda", () => {
    // ⚠️ Num arquivo **CRLF** o `\r` é parte da linha do arquivo ⇒ o conteúdo do diff
    // precisa dele. Só as linhas de **cabeçalho** (`diff --git`, `---`, `+++`, `@@`) têm o
    // `\r` removido.
    const diff = "diff --git a/x.txt b/x.txt\r\n--- a/x.txt\r\n+++ b/x.txt\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n";
    const hunk = parseUnifiedDiff(diff)[0];
    const lines = hunk?.lines ?? [];
    expect(lines[0]?.text).toBe("a\r");
    expect(lines[1]?.text).toBe("b\r");
    // O cabeçalho do hunk é limpo.
    expect(hunk?.header).toBe("@@ -1,1 +1,1 @@");
    expect(hunk?.oldPath).toBe("x.txt");
    expect(hunk?.newPath).toBe("x.txt");
  });

  it("o cabeçalho do arquivo também perde o \\r (o path fica limpo)", () => {
    const diff = "diff --git a/x.txt b/x.txt\r\n--- a/x.txt\r\n+++ b/x.txt\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n";
    const files = parseUnifiedDiffFiles(diff);
    expect(files[0]?.meta.map((line) => line.text)).toEqual([
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
    ]);
  });

  it("um contexto vazio num arquivo CRLF é uma linha só com \\r", () => {
    const diff = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,2 @@",
      " a\r",
      " \r",
      "",
    ].join("\n");
    const lines = parseUnifiedDiff(diff)[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["ctx", "ctx"]);
    expect(lines[0]?.text).toBe("a\r");
    expect(lines[1]?.text).toBe("\r");
  });
});

describe("contagem de mudanças", () => {
  it("countHunkChanges conta +/- do hunk", () => {
    const hunk = parseUnifiedDiff(DIFF_ONE_HUNK)[0];
    expect(hunk === undefined ? undefined : countHunkChanges(hunk)).toEqual({ added: 2, removed: 1 });
  });

  it("summarizeDiff soma os hunks", () => {
    expect(summarizeDiff(parseUnifiedDiff(DIFF_TWO_HUNKS))).toEqual({ hunks: 2, added: 2, removed: 1 });
  });

  it("diff vazio ⇒ tudo zero", () => {
    expect(summarizeDiff(parseUnifiedDiff(""))).toEqual({ hunks: 0, added: 0, removed: 0 });
  });
});
