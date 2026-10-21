/**
 * Scribe — testes do **parser do `git status --porcelain=v1 -z`**.
 *
 * O `-z` é o formato "de máquina": cada campo é terminado por **NUL** e o caminho vai
 * **literal** (sem aspas) ⇒ é o único formato em que espaço/acento/unicode não exigem um
 * interpretador de C-quoting.
 *
 * O teste final roda o **git de verdade** num repo temporário (o helper `createTempGitRepo`)
 * ⇒ prova que o parser entende a saída real, não só a que o teste "acha" que o git dá.
 */
import { describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GitStatusEntry } from "../src/core/git/git-status";
import {
  gitChangeKind,
  gitStatusBadge,
  gitStatusDisplayPath,
  gitStatusLabel,
  isConflictStatus,
  parseGitStatusBranch,
  parseGitStatusPorcelain,
} from "../src/core/git/git-status";
import { createTempGitRepo } from "./helpers/temp-git-repo";

/** Entrada esperada (atalho dos asserts). */
function expectEntry(entry: GitStatusEntry | undefined, path: string): GitStatusEntry {
  expect(entry).toBeDefined();
  if (entry === undefined) throw new Error("entrada ausente");
  expect(entry.path).toBe(path);
  return entry;
}

describe("parseGitStatusPorcelain — o formato `-z`", () => {
  it("arquivo modificado **não** indexado (` M`) ⇒ unstaged", () => {
    const entries = parseGitStatusPorcelain(" M src/a.txt\0");
    expect(entries).toHaveLength(1);
    const entry = expectEntry(entries[0], "src/a.txt");
    expect(entry.xy).toBe(" M");
    expect(entry.staged).toBe(false);
    expect(entry.unstaged).toBe(true);
    expect(entry.untracked).toBe(false);
    expect(entry.conflicted).toBe(false);
  });

  it("arquivo modificado **indexado** (`M `) ⇒ staged", () => {
    const entries = parseGitStatusPorcelain("M  src/a.txt\0");
    const entry = expectEntry(entries[0], "src/a.txt");
    expect(entry.xy).toBe("M ");
    expect(entry.staged).toBe(true);
    expect(entry.unstaged).toBe(false);
  });

  it("modificado nos dois (`MM`) ⇒ staged **e** unstaged", () => {
    const entry = expectEntry(parseGitStatusPorcelain("MM src/a.txt\0")[0], "src/a.txt");
    expect(entry.staged).toBe(true);
    expect(entry.unstaged).toBe(true);
  });

  it("adicionado (`A `) e deletado (` D`)", () => {
    const added = expectEntry(parseGitStatusPorcelain("A  novo.txt\0")[0], "novo.txt");
    expect(added.staged).toBe(true);
    expect(gitChangeKind(added)).toBe("added");
    const deleted = expectEntry(parseGitStatusPorcelain(" D velho.txt\0")[0], "velho.txt");
    expect(deleted.staged).toBe(false);
    expect(deleted.unstaged).toBe(true);
    expect(gitChangeKind(deleted)).toBe("deleted");
  });

  it("não rastreado (`??`) ⇒ untracked, sem staged/unstaged", () => {
    const entry = expectEntry(parseGitStatusPorcelain("?? novo.txt\0")[0], "novo.txt");
    expect(entry.untracked).toBe(true);
    expect(entry.staged).toBe(false);
    expect(entry.unstaged).toBe(false);
    expect(entry.ignored).toBe(false);
    expect(gitChangeKind(entry)).toBe("untracked");
  });

  it("ignorado (`!!`) ⇒ ignored (só sai com `--ignored`)", () => {
    const entry = expectEntry(parseGitStatusPorcelain("!! build/x.txt\0")[0], "build/x.txt");
    expect(entry.ignored).toBe(true);
    expect(entry.staged).toBe(false);
    expect(entry.unstaged).toBe(false);
    expect(gitChangeKind(entry)).toBe("ignored");
  });

  it("conflito (`UU`) ⇒ conflicted", () => {
    const entry = expectEntry(parseGitStatusPorcelain("UU src/a.txt\0")[0], "src/a.txt");
    expect(entry.conflicted).toBe(true);
    expect(gitChangeKind(entry)).toBe("conflicted");
    expect(gitStatusBadge(entry)).toBe("!");
  });

  it("todas as combinações unmerged do porcelain v1 são conflito", () => {
    for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
      expect(isConflictStatus(xy)).toBe(true);
    }
    expect(isConflictStatus("MM")).toBe(false);
    expect(isConflictStatus("??")).toBe(false);
  });

  it("**renomeação**: 2 campos ⇒ o 1º é o novo, o 2º é o original", () => {
    const entries = parseGitStatusPorcelain("R  novo.txt\0antigo.txt\0");
    expect(entries).toHaveLength(1);
    const entry = expectEntry(entries[0], "novo.txt");
    expect(entry.oldPath).toBe("antigo.txt");
    expect(entry.staged).toBe(true);
    expect(gitChangeKind(entry)).toBe("renamed");
    expect(gitStatusBadge(entry)).toBe("R");
    expect(gitStatusDisplayPath(entry)).toBe("antigo.txt → novo.txt");
  });

  it("**cópia**: 2 campos, como a renomeação", () => {
    const entry = expectEntry(parseGitStatusPorcelain("C  copia.txt\0orig.txt\0")[0], "copia.txt");
    expect(entry.oldPath).toBe("orig.txt");
    expect(gitChangeKind(entry)).toBe("copied");
  });

  it("path com **espaço** (o `-z` não cita)", () => {
    const entry = expectEntry(
      parseGitStatusPorcelain("?? meu arquivo.txt\0")[0],
      "meu arquivo.txt",
    );
    expect(entry.path).toBe("meu arquivo.txt");
    expect(entry.untracked).toBe(true);
  });

  it("path com **acento/unicode** (o `-z` não escapa)", () => {
    const nome = "acentuação-ção — café 🎉.txt";
    const entry = expectEntry(parseGitStatusPorcelain(`?? ${nome}\0`)[0], nome);
    expect(entry.path).toBe(nome);
  });

  it("várias entradas numa saída só", () => {
    const output = "M  a.txt\0 M b.txt\0?? c.txt\0";
    const entries = parseGitStatusPorcelain(output);
    expect(entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("saída vazia ⇒ nenhuma entrada", () => {
    expect(parseGitStatusPorcelain("")).toEqual([]);
  });

  it("campo malformado é ignorado (o painel não quebra)", () => {
    const entries = parseGitStatusPorcelain("X\0?? ok.txt\0");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("ok.txt");
  });

  it("renomeação sem o campo original não quebra", () => {
    const entry = expectEntry(parseGitStatusPorcelain("R  novo.txt\0")[0], "novo.txt");
    expect(entry.oldPath).toBeUndefined();
  });

  it("o cabeçalho de branch (`--branch`) **não** vira uma entrada", () => {
    const output = "## main...origin/main [ahead 1]\0 M src/a.txt\0";
    const entries = parseGitStatusPorcelain(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("src/a.txt");
  });
});

describe("parseGitStatusBranch — o branch do mesmo comando", () => {
  it("lê o cabeçalho `## branch...upstream [ahead N]`", () => {
    expect(parseGitStatusBranch("## main...origin/main [ahead 1]\0")).toBe("main");
    expect(parseGitStatusBranch("## feature/x...origin/feature/x\0")).toBe("feature/x");
    expect(parseGitStatusBranch("## main\0")).toBe("main");
  });

  it("detached HEAD ⇒ `HEAD`", () => {
    expect(parseGitStatusBranch("## HEAD (no branch)\0")).toBe("HEAD");
  });

  it("formato antigo (`# branch.head`) ⇒ o nome do branch", () => {
    expect(parseGitStatusBranch("# branch.head main\0")).toBe("main");
  });

  it("repo **sem commit** (`## No commits yet on main`) ⇒ só o branch", () => {
    expect(parseGitStatusBranch("## No commits yet on main\0")).toBe("main");
    expect(parseGitStatusBranch("## No commits yet on feature/x\0")).toBe("feature/x");
    // Com upstream: o `git` acrescenta o `...origin/main`.
    expect(parseGitStatusBranch("## No commits yet on main...origin/main\0")).toBe("main");
  });

  it("sem cabeçalho ⇒ `null`", () => {
    expect(parseGitStatusBranch("")).toBeNull();
    expect(parseGitStatusBranch(" M a.txt\0")).toBeNull();
  });
});

describe("gitChangeKind / badge / rótulo", () => {
  it("mapeia os kinds do porcelain", () => {
    const kindOf = (xy: string): string => {
      const entry = expectEntry(parseGitStatusPorcelain(`${xy} x.txt\0`)[0], "x.txt");
      return gitChangeKind(entry);
    };
    expect(kindOf("A ")).toBe("added");
    expect(kindOf(" M")).toBe("modified");
    expect(kindOf("MM")).toBe("modified");
    expect(kindOf(" D")).toBe("deleted");
    expect(kindOf("R ")).toBe("renamed");
    expect(kindOf("T ")).toBe("typechanged");
    expect(kindOf("??")).toBe("untracked");
    expect(kindOf("!!")).toBe("ignored");
    expect(kindOf("UU")).toBe("conflicted");
  });

  it("badge e rótulo legível", () => {
    const entry = expectEntry(parseGitStatusPorcelain("M  x.txt\0")[0], "x.txt");
    expect(gitStatusBadge(entry)).toBe("M");
    expect(gitStatusLabel(entry)).toBe("Modificado");
  });
});

describe("parseGitStatusPorcelain — a saída real do `git`", () => {
  it("lê o status de um repo de verdade (staged+unstaged, rename, untracked com acento)", () => {
    const repo = createTempGitRepo("scribe-scm-");
    try {
      repo.write("linha 1\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      writeFileSync(join(repo.dir, "outro.txt"), "b\n");
      repo.git("add", "outro.txt");
      repo.git("commit", "-qm", "segundo");

      // staged **e** unstaged no mesmo arquivo ⇒ "MM"
      repo.write("linha 1\nlinha 2\n");
      repo.git("add", "nota.txt");
      repo.write("linha 1\nlinha 2\nlinha 3\n");

      // renomeação (o git detecta ⇒ "R  novo\0antigo\0")
      repo.git("mv", "outro.txt", "renomeado.txt");

      // não rastreados com espaço e com acento
      writeFileSync(join(repo.dir, "arquivo com espaço.txt"), "x\n");
      writeFileSync(join(repo.dir, "acentuação-ção.txt"), "y\n");

      const output = repo.git("status", "--porcelain=v1", "-z", "--branch");
      const entries = parseGitStatusPorcelain(output);
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));

      // O branch sai do **mesmo** comando (o cabeçalho `## ...`).
      expect(parseGitStatusBranch(output)).toBe(repo.git("rev-parse", "--abbrev-ref", "HEAD").trim());

      const modified = byPath.get("nota.txt");
      expect(modified).toBeDefined();
      expect(modified?.staged).toBe(true);
      expect(modified?.unstaged).toBe(true);

      const renamed = byPath.get("renomeado.txt");
      expect(renamed?.oldPath).toBe("outro.txt");
      expect(renamed?.staged).toBe(true);

      const withSpace = byPath.get("arquivo com espaço.txt");
      expect(withSpace?.untracked).toBe(true);

      const withAccent = byPath.get("acentuação-ção.txt");
      expect(withAccent?.untracked).toBe(true);

      expect(entries).toHaveLength(4);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("repo **sem commit**: o branch sai do cabeçalho `## No commits yet on …`", () => {
    const repo = createTempGitRepo("scribe-unborn-");
    try {
      // Repo sem nenhum commit ⇒ o `git` escreve "## No commits yet on <branch>".
      const output = repo.git("status", "--porcelain=v1", "-z", "--branch");
      expect(output.startsWith("## No commits yet on ")).toBe(true);
      // O parser devolve **só** o nome do branch (o prefixo é do `git`).
      // (`rev-parse HEAD` não funciona num repo sem commit ⇒ `symbolic-ref`.)
      const esperado = repo.git("symbolic-ref", "--short", "HEAD").trim();
      expect(esperado.length).toBeGreaterThan(0);
      expect(parseGitStatusBranch(output)).toBe(esperado);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
