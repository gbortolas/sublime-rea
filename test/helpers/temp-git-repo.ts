/**
 * Scribe — utilitário de teste: **repositório git temporário**.
 *
 * Os testes de `git.blame`/`git.diff` precisam de um repo real (o `git` do sistema), com
 * um arquivo commitado e — para o teste de RCE — um `.git/config` "hostil".
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempGitRepo {
  /** Diretório do repositório (o `.git` mora aqui). */
  readonly dir: string;
  /** Caminho absoluto do arquivo versionado. */
  readonly file: string;
  /** Roda um comando `git` **no repositório** e devolve a stdout. */
  git(...args: readonly string[]): string;
  /** Escreve (ou reescreve) o arquivo versionado. */
  write(content: string): void;
}

/** Cria um repo git temporário com um arquivo commitado (autor "Teste Scribe"). */
export function createTempGitRepo(prefix: string, fileName = "nota.txt"): TempGitRepo {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(root, "repo");
  mkdirSync(dir);
  const run = (...args: readonly string[]): string =>
    execFileSync("git", [...args], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("init", "-q", ".");
  run("config", "user.email", "teste@scribe.local");
  run("config", "user.name", "Teste Scribe");
  run("config", "commit.gpgsign", "false");
  const file = join(dir, fileName);
  return {
    dir,
    file,
    git: run,
    write: (content: string): void => {
      writeFileSync(file, content);
    },
  };
}
