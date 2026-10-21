/**
 * Scribe — **salvar em outro filesystem** não pode falhar com `EXDEV` (achado ALTO).
 *
 * A escrita atômica criava o arquivo temporário em `os.tmpdir()` e fazia `rename()` para o
 * destino. `rename()` **não** atravessa filesystems ⇒ salvar em `$HOME` (o tmp em `/tmp`)
 * falhava com `EXDEV: cross-device link not permitted` ⇒ **o arquivo não era salvo**
 * (reproduzido na auditoria: `Scribe IPC[EXDEV]`).
 *
 * A correção (no worker): o temporário é criado **no diretório do destino** (o `rename`
 * passa a ser local) e, se ainda assim der `EXDEV`, a escrita cai para `writeFile` direto.
 *
 * O teste é **real**: ele salva num diretório em `$HOME` (device diferente do `/tmp` nesta
 * máquina) e exige que o conteúdo esteja no disco e o documento **não** esteja sujo.
 * Se `HOME` e `/tmp` estiverem no mesmo device (máquina de CI), o teste é **pulado** — a
 * cobertura determinística do caso está em `test/worker-atomic-write.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import { createNodeFileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";

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

/** Código de erro da resposta (`undefined` se a chamada deu certo). */
function errorCodeOf(response: IpcResponse): string | undefined {
  return response.ok ? undefined : response.error.code;
}

/** `true` quando o tmp do SO e o `HOME` estão **no mesmo** device (sem EXDEV possível). */
const sameDevice = statSync(tmpdir()).dev === statSync(homedir()).dev;

describe("main — salvar em outro filesystem (EXDEV)", () => {
  it.skipIf(sameDevice)("salva em `$HOME` (device ≠ `/tmp`) sem `EXDEV`", async () => {
    const dir = mkdtempSync(join(homedir(), ".scribe-save-"));
    const target = join(dir, "nota.txt");
    writeFileSync(target, "conteudo original\n", "utf8");
    const fileSystem = await createNodeFileSystem();
    const core = createEditorCore({ fileSystem, availableParallelism: 4 });
    try {
      const opened = await invoke(core, "document.open", [target], 1);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const handle = opened.value as DocumentHandle;

      const inserted = await invoke(core, "document.insert", [handle, 0, "conteudo novo\n", "user"], 2);
      expect(inserted.ok).toBe(true);

      const dirtyBefore = await invoke(core, "document.isDirty", [handle], 3);
      expect(valueOf(dirtyBefore)).toBe(true);

      // Antes: `ok: false` com `Scribe IPC[EXDEV]` e o arquivo **não** era salvo.
      const saved = await invoke(core, "document.save", [handle], 4);
      expect(saved.ok).toBe(true);
      expect(errorCodeOf(saved)).toBeUndefined();

      // O conteúdo foi **gravado** no disco.
      expect(readFileSync(target, "utf8")).toBe("conteudo novo\nconteudo original\n");

      // E o documento não está mais sujo.
      const dirtyAfter = await invoke(core, "document.isDirty", [handle], 5);
      expect(valueOf(dirtyAfter)).toBe(false);
    } finally {
      core.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("salvar no mesmo device continua funcionando (sem regressão)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-save-local-"));
    const target = join(dir, "nota.txt");
    writeFileSync(target, "conteudo original\n", "utf8");
    const fileSystem = await createNodeFileSystem();
    const core = createEditorCore({ fileSystem, availableParallelism: 4 });
    try {
      const opened = await invoke(core, "document.open", [target], 1);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const handle = opened.value as DocumentHandle;

      await invoke(core, "document.insert", [handle, 0, "conteudo novo\n", "user"], 2);
      const saved = await invoke(core, "document.save", [handle], 3);
      expect(saved.ok).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("conteudo novo\nconteudo original\n");
      const dirty = await invoke(core, "document.isDirty", [handle], 4);
      expect(valueOf(dirty)).toBe(false);

      // Nenhum temporário sobrou no diretório do destino.
      expect(readdirSync(dir)).toEqual(["nota.txt"]);
    } finally {
      core.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
