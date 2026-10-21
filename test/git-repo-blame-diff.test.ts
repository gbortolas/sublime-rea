/**
 * Scribe — `git.blame` / `git.diff` rodam no **repositório do documento** (achado MÉDIO).
 *
 * Antes, o `git blame` era executado **sem `cwd`** ⇒ o `git` usava o diretório de trabalho
 * do **app** (o repo do Scribe) ⇒ o arquivo do documento estava "outside repository" ⇒ o
 * blame **nunca** funcionava (devolvia `null` sempre). O `git diff` tinha o mesmo problema
 * (rodava no repo do app).
 *
 * A correção: `cwd = dirname(path)` (o diretório do documento) + `maxBuffer` maior (1 KB
 * era apertado ⇒ `null` silencioso).
 *
 * O contrato **não** muda: `git.blame` devolve `{commitHash, author, timeAgo}` ou `null`;
 * `git.diff` devolve a lista de ranges.
 */
import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";
import { createTempGitRepo } from "./helpers/temp-git-repo";

/** FS em memória: o `git` lê o arquivo **do disco** (o buffer não entra no blame/diff). */
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

describe("main — blame/diff no repositório do **documento**", () => {
  it("git.blame devolve commit/autor/tempo de um arquivo commitado", async () => {
    const repo = createTempGitRepo("scribe-blame-");
    try {
      repo.write("linha 1\nlinha 2\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");

      const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
      try {
        const opened = await invoke(core, "document.open", [repo.file], 1);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const handle = opened.value as DocumentHandle;

        const blame = await invoke(core, "git.blame", [handle, 0], 2);
        expect(blame.ok).toBe(true);
        // Antes devolvia `null` (o `git` rodava no repo do app) ⇒ agora devolve dados.
        expect(valueOf(blame)).not.toBeNull();
        const info = valueOf(blame) as { commitHash: string; author: string; timeAgo: string };
        expect(info.commitHash).toMatch(/^[0-9a-f]{8}$/);
        expect(info.author).toBe("Teste Scribe");
        expect(info.timeAgo.length).toBeGreaterThan(0);
      } finally {
        core.dispose();
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("git.diff devolve os ranges das linhas alteradas no repositório do documento", async () => {
    const repo = createTempGitRepo("scribe-diff-");
    try {
      repo.write("linha 1\nlinha 2\nlinha 3\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      // Altera a 2ª linha no disco (o `git` lê o disco, não o buffer).
      repo.write("linha 1\nlinha 2 alterada\nlinha 3\n");

      const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
      try {
        const opened = await invoke(core, "document.open", [repo.file], 1);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const handle = opened.value as DocumentHandle;

        const diff = await invoke(core, "git.diff", [handle], 2);
        expect(diff.ok).toBe(true);
        const ranges = valueOf(diff) as ReadonlyArray<{ startLine: number; lineCount: number; kind: string }>;
        expect(ranges.length).toBe(1);
        expect(ranges[0]?.startLine).toBe(1);
        expect(ranges[0]?.kind).toBe("modified");
      } finally {
        core.dispose();
      }
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("git.blame/blame de arquivo fora de um repo continua devolvendo `null` (sem regressão)", async () => {
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const opened = await invoke(core, "document.open", [join("/tmp", "scribe-sem-repo.txt")], 1);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const handle = opened.value as DocumentHandle;

      const blame = await invoke(core, "git.blame", [handle, 0], 2);
      expect(blame.ok).toBe(true);
      expect(valueOf(blame)).toBeNull();

      const diff = await invoke(core, "git.diff", [handle], 3);
      expect(diff.ok).toBe(true);
      expect(valueOf(diff)).toEqual([]);
    } finally {
      core.dispose();
    }
  });
});
