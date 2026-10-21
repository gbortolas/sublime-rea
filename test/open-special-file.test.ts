/**
 * Scribe — `document.open` de **arquivo especial** não pode pendurar o IPC (achado MÉDIO).
 *
 * O `readFile` de um **FIFO** (ou de um device) **bloqueia para sempre** — não há escritor
 * ⇒ o `open` ficava **pendurado** e o IPC **nunca respondia** (reproduzido na auditoria: a
 * promise ficou pendente).
 *
 * A correção (no registry): `stat()` + `isFile()` **antes** de ler ⇒ o path é rejeitado
 * com um erro **tipado** (`not-a-regular-file`), em **milissegundos**.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import { createNodeFileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";

/** Espera `ms` milissegundos (para a corrida com o `open`). */
function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });
}

async function invoke(
  core: ReturnType<typeof createEditorCore>,
  method: string,
  args: readonly unknown[],
  id: number,
): Promise<IpcResponse> {
  return handleIpcRequest(core, { v: IPC_VERSION, id, method, args });
}

/** Código de erro da resposta (`undefined` se a chamada deu certo). */
function errorCodeOf(response: IpcResponse): string | undefined {
  return response.ok ? undefined : response.error.code;
}

/** Valor da resposta (`undefined` se a chamada falhou). */
function valueOf(response: IpcResponse): unknown {
  return response.ok ? response.value : undefined;
}

/** Resultado da corrida: a resposta do IPC ou o timeout (⇒ promise pendurada). */
type Race =
  | { readonly kind: "response"; readonly response: IpcResponse }
  | { readonly kind: "timeout" };

describe("main — `document.open` de arquivo especial", () => {
  it("abrir um FIFO falha **rápido** (erro tipado, sem pendurar o IPC)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-fifo-"));
    const fifo = join(dir, "canal");
    try {
      execFileSync("mkfifo", [fifo]);
      const fileSystem = await createNodeFileSystem();
      const core = createEditorCore({ fileSystem, availableParallelism: 4 });
      try {
        const raced = (await Promise.race([
          invoke(core, "document.open", [fifo], 1).then((response) => ({
            kind: "response" as const,
            response,
          })),
          delay(2000),
        ])) as Race;

        // **A asserção que trava a correção:** não pode ficar pendurado.
        expect(raced.kind).toBe("response");
        if (raced.kind !== "response") return;
        expect(raced.response.ok).toBe(false);
        expect(errorCodeOf(raced.response)).toBe("not-a-regular-file");
      } finally {
        core.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abrir um device (`/dev/null`) é rejeitado (não é arquivo regular)", async () => {
    const fileSystem = await createNodeFileSystem();
    const core = createEditorCore({ fileSystem, availableParallelism: 4 });
    try {
      const raced = (await Promise.race([
        invoke(core, "document.open", ["/dev/null"], 1).then((response) => ({
          kind: "response" as const,
          response,
        })),
        delay(2000),
      ])) as Race;

      expect(raced.kind).toBe("response");
      if (raced.kind !== "response") return;
      expect(raced.response.ok).toBe(false);
      expect(errorCodeOf(raced.response)).toBe("not-a-regular-file");
    } finally {
      core.dispose();
    }
  });

  it("um diretório é rejeitado (não é arquivo regular)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-dir-"));
    try {
      const fileSystem = await createNodeFileSystem();
      const core = createEditorCore({ fileSystem, availableParallelism: 4 });
      try {
        const opened = await invoke(core, "document.open", [dir], 1);
        expect(opened.ok).toBe(false);
        expect(errorCodeOf(opened)).toBe("not-a-regular-file");
      } finally {
        core.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("um arquivo comum continua abrindo normalmente (sem regressão)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-ok-"));
    const file = join(dir, "nota.txt");
    writeFileSync(file, "conteudo\n", "utf8");
    try {
      const fileSystem = await createNodeFileSystem();
      const core = createEditorCore({ fileSystem, availableParallelism: 4 });
      try {
        const opened = await invoke(core, "document.open", [file], 1);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const handle = opened.value as DocumentHandle;
        const text = await invoke(core, "document.text", [handle], 2);
        expect(valueOf(text)).toBe("conteudo\n");
      } finally {
        core.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
