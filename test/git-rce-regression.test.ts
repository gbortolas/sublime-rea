/**
 * Scribe — regressão de **RCE via `git diff`** (achado ALTO da auditoria de segurança).
 *
 * O `main` roda o `git diff` **dentro do repositório do documento** (o `cwd` é o diretório
 * do arquivo aberto). O `.git/config` desse repositório é **controlado por quem tem o
 * arquivo** — e `diff.external` faz o `git` **executar um comando arbitrário**:
 *
 * ```ini
 * [diff]
 *     external = sh -c 'touch /tmp/PWNED' _
 * ```
 *
 * Bastava **abrir** o arquivo para o comando rodar (RCE). Reproduzido na auditoria.
 *
 * A correção (no `main`): `--no-ext-diff --no-textconv` + `-c core.pager=cat` + ambiente
 * sanitizado (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_COUNT=0`
 * ⇒ nem o config do **usuário** é lido).
 *
 * **Este teste trava a correção:** com o código antigo o marcador **existe** depois do
 * `git.diff`; com o código novo ele **não** existe — e o diff **continua** devolvendo os
 * ranges (comportamento observável preservado).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";
import { createTempGitRepo } from "./helpers/temp-git-repo";

/** FS em memória: o `git` lê o arquivo **do disco**, o conteúdo do buffer é irrelevante. */
function memoryFs(): FileSystem {
  return {
    readFile: (): Promise<string> => Promise.resolve("conteudo\n"),
    writeFile: async (): Promise<void> => undefined,
  };
}

async function invoke(
  core: ReturnType<typeof createEditorCore>,
  method: string,
  args: readonly unknown[],
  id: number,
): Promise<IpcResponse> {
  return handleIpcRequest(core, { v: IPC_VERSION, id, method, args });
}

/** Valor da resposta (`undefined` se a chamada falhou). */
function valueOf(response: IpcResponse): unknown {
  return response.ok ? response.value : undefined;
}

describe("main — `git diff` não executa o `diff.external` do repo do documento (RCE)", () => {
  it("o marcador do `diff.external` NÃO é criado ao abrir o arquivo e pedir o diff", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "scribe-rce-"));
    const marker = join(scratch, "PWNED");
    const repo = createTempGitRepo("scribe-rce-repo-");
    try {
      // O `.git/config` do repo **do documento** manda um comando arbitrário ao `git diff`.
      repo.git("config", "diff.external", `sh -c 'touch ${marker}' _`);
      repo.write("linha 1\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      // O arquivo **difere** do HEAD (senão o `git diff` não produz nada e nem chama o
      // driver externo).
      repo.write("linha 1\nlinha 2\n");

      const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
      try {
        const opened = await invoke(core, "document.open", [repo.file], 1);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const handle = opened.value as DocumentHandle;

        const diff = await invoke(core, "git.diff", [handle], 2);
        expect(diff.ok).toBe(true);

        // **A asserção que trava a correção:** o comando do `.git/config` NÃO rodou.
        expect(existsSync(marker)).toBe(false);

        // O comportamento observável **não** mudou: o diff continua devolvendo os ranges.
        // ("linha 1\n" → "linha 1\nlinha 2\n" ⇒ a linha 2 (índice 1) foi inserida.)
        const ranges = valueOf(diff) as ReadonlyArray<{ startLine: number; lineCount: number; kind: string }>;
        expect(Array.isArray(ranges)).toBe(true);
        expect(ranges.length).toBeGreaterThan(0);
        expect(ranges[0]?.startLine).toBe(1);
        expect(ranges[0]?.kind).toBe("modified");
      } finally {
        core.dispose();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("o `diff.external` do **config global do usuário** também é ignorado", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "scribe-rce-home-"));
    const marker = join(scratch, "PWNED");
    const fakeHome = join(scratch, "home");
    const repo = createTempGitRepo("scribe-rce-global-");
    const previousHome = process.env["HOME"];
    try {
      // `~/.gitconfig` do usuário com um driver externo hostil.
      mkdirSync(fakeHome, { recursive: true });
      writeFileSync(
        join(fakeHome, ".gitconfig"),
        `[diff]\n\texternal = sh -c 'touch ${marker}' _\n`,
        { flag: "w" },
      );
      repo.write("linha 1\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      repo.write("linha 1\nlinha 2\n");

      process.env["HOME"] = fakeHome;
      const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
      try {
        const opened = await invoke(core, "document.open", [repo.file], 1);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const handle = opened.value as DocumentHandle;

        const diff = await invoke(core, "git.diff", [handle], 2);
        expect(diff.ok).toBe(true);
        expect(existsSync(marker)).toBe(false);
      } finally {
        core.dispose();
      }
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      rmSync(scratch, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
