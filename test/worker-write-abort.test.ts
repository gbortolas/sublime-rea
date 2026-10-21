/**
 * Scribe — o **cancelamento de uma escrita**: o `rename` é o ponto sem volta.
 *
 * ⚠️ **Achado (security):** a graça do cancel do pool mata o worker que não responde. Se
 * esse worker estivesse **escrevendo**, o `terminate` derrubaria a thread **no meio da
 * escrita** ⇒ (a) um `.scribe-<pid>-<hex>` **órfão** e (b) no *fallback* sem atomicidade, o
 * **alvo truncado** ⇒ **perda de dados**.
 *
 * A defesa é dupla:
 * - **no pool**: a graça do cancel **não** é armada para `kind: writeFile` ⇒ a escrita
 *   **termina em paz** (o worker não é morto);
 * - **no worker**: o `signal.aborted` é checado **antes** do `rename` ⇒ se o cancel chegou,
 *   o **tmp** é removido e a escrita é abortada ⇒ o **alvo fica intacto** (nunca truncado).
 *
 * O teste roda o runtime do worker **no processo** (sem `worker_threads`): o abort é
 * **síncrono** ⇒ ele sempre chega **antes** do `rename` ⇒ o teste é **determinístico**.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkerRuntime } from "../src/core/concurrency/worker-entry";
import type { WorkerOutbound } from "../src/core/concurrency/worker-entry";
import type { WorkerRequest } from "../src/shared";

/** Cria um diretório temporário e o limpa no fim. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "scribe-write-abort-"));
}

/** Os arquivos `.scribe-*` (o temporário da escrita atômica) que sobraram no diretório. */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".scribe-"));
}

describe("worker — escrita cancelada: o destino fica intacto", () => {
  it("o abort antes do `rename` remove o tmp e NÃO toca o destino", async () => {
    const dir = tempDir();
    const target = join(dir, "alvo.txt");
    writeFileSync(target, "original\n", "utf8");
    try {
      const replies: WorkerOutbound[] = [];
      const runtime = createWorkerRuntime((message) => replies.push(message), 0);
      const data = new TextEncoder().encode("conteúdo novo\n").buffer as ArrayBuffer;
      const request: WorkerRequest = {
        id: 42,
        kind: "writeFile",
        payload: { kind: "writeFile", path: target, data },
        counters: undefined,
      };

      // A escrita começa (o `writeFile` do tmp é **assíncrono** ⇒ o cancel chega **no meio**).
      const running = runtime.handleMessage(request);
      // O cancel aborta a task **em andamento** — o abort é **síncrono** ⇒ ele vale antes
      // do `rename` (o ponto sem volta).
      await runtime.handleMessage({ kind: "cancel", id: 42, reason: "usuário cancelou" });
      await running;

      const response = replies[0];
      expect(response).toBeDefined();
      expect(response && "ok" in response ? response.ok : true).toBe(false);
      // O **destino ficou intacto** (o conteúdo original) e **não** sobrou tmp órfão.
      expect(readFileSync(target, "utf8")).toBe("original\n");
      expect(leftovers(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancel ANTES do start: a task responde 'cancelada' e não escreve nada", async () => {
    const dir = tempDir();
    const target = join(dir, "alvo.txt");
    try {
      const replies: WorkerOutbound[] = [];
      const runtime = createWorkerRuntime((message) => replies.push(message), 0);
      const data = new TextEncoder().encode("conteúdo novo\n").buffer as ArrayBuffer;

      // O cancel chega **antes** do request ⇒ a task tem de responder "cancelada".
      await runtime.handleMessage({ kind: "cancel", id: 7, reason: "cancelado antes de começar" });
      await runtime.handleMessage({
        id: 7,
        kind: "writeFile",
        payload: { kind: "writeFile", path: target, data },
        counters: undefined,
      } satisfies WorkerRequest);

      const response = replies[0];
      expect(response && "ok" in response ? response.ok : true).toBe(false);
      expect(response && "error" in response ? response.error?.message : "").toMatch(/cancelado/i);
      // A task **não** executou ⇒ o arquivo nem existe.
      expect(existsSync(target)).toBe(false);
      expect(leftovers(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancel TARDIO (a task já respondeu) não envenena o id (o `cancelled` não vaza)", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "ok\n", "utf8");
    try {
      const replies: WorkerOutbound[] = [];
      const runtime = createWorkerRuntime((message) => replies.push(message), 0);
      const request: WorkerRequest = {
        id: 7,
        kind: "readFile",
        payload: { kind: "readFile", path: file },
        counters: undefined,
      };

      // 1ª task: responde normalmente.
      await runtime.handleMessage(request);
      expect(replies[0]).toMatchObject({ ok: true, value: "ok\n" });

      // Cancel **tardio** (a task já respondeu) ⇒ é ignorado (sem vazar entrada no
      // `cancelled` do worker).
      await runtime.handleMessage({ kind: "cancel", id: 7, reason: "tardio" });

      // 2ª task com o **mesmo id**: ela **roda** (o `cancelled` não vazou).
      replies.length = 0;
      await runtime.handleMessage(request);
      expect(replies[0]).toMatchObject({ ok: true, value: "ok\n" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancel tardio DEPOIS de um cancel antes do start também não envenena o id", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "ok\n", "utf8");
    try {
      const replies: WorkerOutbound[] = [];
      const runtime = createWorkerRuntime((message) => replies.push(message), 0);
      const request: WorkerRequest = {
        id: 9,
        kind: "readFile",
        payload: { kind: "readFile", path: file },
        counters: undefined,
      };

      // Cancel **antes** do start ⇒ a task responde "cancelada" (e não executa).
      await runtime.handleMessage({ kind: "cancel", id: 9, reason: "antes de começar" });
      await runtime.handleMessage(request);
      expect(replies[0]).toMatchObject({ ok: false });

      // Cancel **tardio** (a task já respondeu) ⇒ ignorado (sem vazar entrada no `cancelled`).
      await runtime.handleMessage({ kind: "cancel", id: 9, reason: "tardio" });

      // Um request com o **mesmo id** agora **roda** (o `cancelled` não vazou).
      replies.length = 0;
      await runtime.handleMessage(request);
      expect(replies[0]).toMatchObject({ ok: true, value: "ok\n" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
