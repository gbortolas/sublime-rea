/**
 * Scribe — regressão de **injeção de shell** no `git.blame` / `git.diff`.
 *
 * O caminho do documento vem do **renderer** (`document.open`) e, no `main`, era
 * interpolado numa string de shell:
 *
 * ```sh
 * git blame -L 1,1 --porcelain "<caminho>"
 * ```
 *
 * Dentro de aspas duplas, `$(...)` e backticks **expandem** ⇒ abrir um arquivo com
 * nome `$(id).txt` executava código no processo principal (o renderer é não
 * confiável). Agora o caminho vai como **argumento** (`execFileSync("git", [...])`),
 * sem shell.
 *
 * O teste abre um documento cujo nome **é** um comando e prova que nada foi executado.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";

/** FS em memória: devolve texto para qualquer caminho (o `document.open` só precisa do handle). */
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

describe("main — o caminho do documento nunca vira comando de shell", () => {
  it("git.blame/git.diff com path de injeção não executam nada", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-shell-"));
    const marker = join(dir, "PWNED");
    // O **nome do arquivo** é o comando: se o path entrar num shell, ele executa.
    const maliciousPath = join(dir, `$(touch ${marker}).txt`);
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const opened = await invoke(core, "document.open", [maliciousPath], 1);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const handle = opened.value as DocumentHandle;

      const blame = await invoke(core, "git.blame", [handle, 0], 2);
      const diff = await invoke(core, "git.diff", [handle], 3);
      // A chamada falha (o path não é de um repositório) — o que importa é o **efeito**.
      expect(blame.ok).toBe(true);
      expect(diff.ok).toBe(true);

      // Nada foi executado: o marcador não existe.
      expect(existsSync(marker)).toBe(false);
    } finally {
      core.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o caminho é repassado ao git como argumento (sem interpolação)", async () => {
    // O path malicioso **chega** ao git — como argumento, não como comando.
    const dir = mkdtempSync(join(tmpdir(), "scribe-shell-"));
    const marker = join(dir, "PWNED");
    const maliciousPath = join(dir, `$(touch ${marker}).txt`);
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const opened = await invoke(core, "document.open", [maliciousPath], 1);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const handle = opened.value as DocumentHandle;

      await invoke(core, "git.blame", [handle, 0], 2);
      await invoke(core, "git.diff", [handle], 3);
      await invoke(core, "git.blame", [handle, 0], 4);

      expect(existsSync(marker)).toBe(false);
      expect(existsSync(`${marker}.txt`)).toBe(false);
    } finally {
      core.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
