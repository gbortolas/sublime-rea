/**
 * Scribe — guardas de I/O do **worker** (achados ALTO/MÉDIO da auditoria).
 *
 * 1. **Escrita atômica no mesmo diretório** do destino: o `rename()` **não** atravessa
 *    filesystems — com o temporário em `os.tmpdir()`, salvar em `$HOME` falhava com
 *    `EXDEV` e **o arquivo não era salvo**.
 * 2. **Leitura de arquivo especial**: o `readFile` de um FIFO **bloqueia para sempre** ⇒ a
 *    task nunca resolvia (o IPC ficava pendurado).
 *
 * O `node:fs/promises` é mockado (delegando ao real) para **observar** os paths e para
 * **simular** o `EXDEV`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createWorkerRuntime } from "../src/core/concurrency/worker-entry";
import type { WorkerOutbound } from "../src/core/concurrency/worker-entry";
import type { WorkerRequest, WorkerResponse } from "../src/shared";

type FsPromises = typeof import("node:fs/promises");

const spy = vi.hoisted(() => ({
  writes: [] as string[],
  renames: [] as Array<{ from: string; to: string }>,
  renameError: null as Error | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<FsPromises>();
  return {
    ...actual,
    writeFile: (async (
      path: Parameters<FsPromises["writeFile"]>[0],
      data: Parameters<FsPromises["writeFile"]>[1],
      options?: Parameters<FsPromises["writeFile"]>[2],
    ) => {
      spy.writes.push(String(path));
      return actual.writeFile(path, data, options);
    }) as unknown as FsPromises["writeFile"],
    rename: (async (from: Parameters<FsPromises["rename"]>[0], to: Parameters<FsPromises["rename"]>[1]) => {
      spy.renames.push({ from: String(from), to: String(to) });
      if (spy.renameError !== null) throw spy.renameError;
      return actual.rename(from, to);
    }) as unknown as FsPromises["rename"],
  };
});

/** Executa a task `writeFile` **no processo** (o runtime do worker, sem worker thread). */
async function runWriteFile(path: string, content: string): Promise<WorkerOutbound[]> {
  const replies: WorkerOutbound[] = [];
  const runtime = createWorkerRuntime((message) => replies.push(message), 0);
  const data = new TextEncoder().encode(content).buffer as ArrayBuffer;
  const request: WorkerRequest = {
    id: 1,
    kind: "writeFile",
    payload: { kind: "writeFile", path, data },
    counters: undefined,
  };
  await runtime.handleMessage(request);
  return replies;
}

/** A primeira resposta do runtime (a `ReadyMessage` do handshake não vem por aqui). */
function responseOf(replies: readonly WorkerOutbound[]): WorkerResponse | undefined {
  const first = replies[0];
  if (first === undefined || !("ok" in first)) return undefined;
  return first;
}

describe("worker — escrita atômica no diretório do destino", () => {
  beforeEach(() => {
    spy.writes = [];
    spy.renames = [];
    spy.renameError = null;
  });

  it("cria o temporário NO diretório do destino (o `rename` não cruza device)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-atomic-"));
    const target = join(dir, "nota.txt");
    try {
      const replies = await runWriteFile(target, "conteudo\n");
      expect(responseOf(replies)?.ok).toBe(true);

      // O temporário **não** está no `tmpdir()` do SO: está **no diretório do destino**.
      const tmpWrites = spy.writes.filter((path) => path !== target);
      expect(tmpWrites.length).toBe(1);
      expect(dirname(tmpWrites[0]!)).toBe(dir);

      // E o `rename` vai do temporário para o destino (mesmo device ⇒ sem `EXDEV`).
      expect(spy.renames.length).toBe(1);
      expect(spy.renames[0]?.from).toBe(tmpWrites[0]);
      expect(spy.renames[0]?.to).toBe(target);

      expect(readFileSync(target, "utf8")).toBe("conteudo\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("se o `rename` falhar (EXDEV), grava direto no destino (o arquivo é salvo)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-exdev-"));
    const target = join(dir, "nota.txt");
    const exdev = Object.assign(new Error("EXDEV: cross-device link not permitted"), {
      code: "EXDEV",
    });
    spy.renameError = exdev;
    // O fallback **avisa** no log (o `console.warn` do worker) — calado aqui.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const replies = await runWriteFile(target, "conteudo\n");
      // A task **não** pode falhar: o fallback grava direto.
      expect(responseOf(replies)?.ok).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("conteudo\n");
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserva o modo (permissões) do arquivo existente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-mode-"));
    const target = join(dir, "nota.sh");
    writeFileSync(target, "antigo\n", "utf8");
    chmodSync(target, 0o755);
    try {
      await runWriteFile(target, "novo\n");
      expect(readFileSync(target, "utf8")).toBe("novo\n");
      expect(statSync(target).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker — leitura de arquivo especial", () => {
  beforeEach(() => {
    spy.writes = [];
    spy.renames = [];
    spy.renameError = null;
  });

  it("a leitura de um FIFO **falha** (a task não trava esperando um escritor)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribe-worker-fifo-"));
    const fifo = join(dir, "canal");
    try {
      execFileSync("mkfifo", [fifo]);
      const replies: WorkerOutbound[] = [];
      const runtime = createWorkerRuntime((message) => replies.push(message), 0);
      const request: WorkerRequest = {
        id: 1,
        kind: "readFile",
        payload: { kind: "readFile", path: fifo },
        counters: undefined,
      };
      await runtime.handleMessage(request);

      const response = responseOf(replies);
      expect(response?.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
