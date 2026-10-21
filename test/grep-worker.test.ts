/**
 * Scribe — testes da **task `grep`** (lane `grep` do `TaskPool`).
 *
 * O grep da workspace roda **no worker** (a varredura é CPU-bound e um `RegExp` patológico
 * **não pode** travar o processo principal). O que se prova aqui:
 * - **paridade**: o grep no worker devolve **exatamente** as mesmas ocorrências do
 *   `grepWorkspace` em processo (mesmo port de leitura: `nodeGrepReadFile`);
 * - o **erro tipado** atravessa o port (`SearchInputError` ⇒ `code === "search.pattern"`);
 * - o **cancelamento** é **cooperativo**: o `cancel` do pool aborta a task **no meio da
 *   varredura** (o worker **não** é morto — ele continua servindo a lane);
 * - o **teto duro** (`timeoutMs`): quando o `RegExp` não termina, o pool **mata o worker**,
 *   rejeita com `TaskTimeoutError` (`code === "task.timeout"`) e a **lane se recupera**
 *   (a task seguinte sobe um worker novo e resolve);
 * - a lane `grep` existe, tem 1 worker e é reportada em `busy`/`poolLanes`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CancellationError, TaskTimeoutError } from "../src/shared";
import { createTaskPool, taskPoolLanes } from "../src/core/concurrency/pool";
import type { TaskPoolImpl } from "../src/core/concurrency/pool";
import { poolLanes } from "../src/core/concurrency/scheduler";
import { grepWorkspace, isCatastrophicPattern } from "../src/core/workspace/grep";
import { nodeGrepReadFile } from "../src/core/workspace/grep-fs";

let dir: string;
let pools: TaskPoolImpl[] = [];

/**
 * Pool de teste: 4 CPUs de teto e **idle longo** (o worker da lane `grep` **não** é
 * reciclado durante o teste ⇒ as asserções sobre `workerCount` são determinísticas).
 */
function makePool(): TaskPoolImpl {
  const pool = createTaskPool({
    availableParallelism: 4,
    maxBackgroundThreads: 4,
    idleTimeoutMs: 30_000,
  });
  pools.push(pool);
  return pool;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scribe-grep-worker-"));
});

afterEach(async () => {
  const current = pools;
  pools = [];
  // O `shutdown` **mata** o worker que ficou preso no `RegExp` (é o `terminate` que
  // encerra a thread) — sem isso o teste ficaria com o worker pendurado.
  await Promise.all(current.map((pool) => pool.shutdown()));
  await rm(dir, { recursive: true, force: true });
});

describe("task `grep` (lane `grep` do TaskPool)", () => {
  it("paridade: o grep no worker devolve as mesmas ocorrências do grepWorkspace em processo", async () => {
    const pool = makePool();
    const fileA = path.join(dir, "a.txt");
    const fileB = path.join(dir, "b.txt");
    const fileC = path.join(dir, "c.txt");
    const files = [fileA, fileB, fileC];
    await writeFile(fileA, "primeira linha\nneedle no meio\noutra needle\n");
    await writeFile(fileB, "sem needle aqui\nmas NEEDLE sim (case-insensitive)\n");
    await writeFile(fileC, "acentuacao: acao\nmais needle\n");

    const esperado = await grepWorkspace({ query: "needle", files, readFile: nodeGrepReadFile });
    const doWorker = await pool.run({ kind: "grep", query: "needle", files }, { lane: "grep" }).done;

    expect(doWorker).toEqual(esperado);
    expect(doWorker.matches.length).toBeGreaterThan(0);
    expect(doWorker.filesScanned).toBe(3);
  });

  it("erro tipado atravessa o port: padrão catastrófico ⇒ code search.pattern", async () => {
    const pool = makePool();
    const file = path.join(dir, "catastrophic.txt");
    await writeFile(file, "a".repeat(1024));

    const handle = pool.run(
      { kind: "grep", query: "(a+)+", files: [file], options: { regex: true } },
      { lane: "grep" },
    );
    await expect(handle.done).rejects.toMatchObject({
      name: "SearchInputError",
      code: "search.pattern",
    });
  });

  it("cancelamento: rejeita com CancellationError, o worker sobrevive e a lane segue", async () => {
    const pool = makePool();
    const files: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const file = path.join(dir, `c${i}.txt`);
      await writeFile(file, `needle ${"x".repeat(4000)}\n`);
      files.push(file);
    }
    const first = files[0] as string;

    const handle = pool.run({ kind: "grep", query: "needle", files }, { lane: "grep" });
    expect(pool.busy.grep).toBe(1);
    handle.cancel("usuário cancelou");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);

    // Cancelamento **cooperativo**: o worker NÃO foi morto (o abort chegou no meio da
    // varredura) — ele continua vivo na lane.
    expect(pool.workerCount("grep")).toBe(1);

    // A task seguinte na mesma lane roda (o worker não ficou poisoned).
    const depois = await pool.run(
      { kind: "grep", query: "needle", files: [first] },
      { lane: "grep" },
    ).done;
    expect(depois.matches).toHaveLength(1);
  });

  it("teto duro: mata o worker, rejeita com TaskTimeoutError e a lane se recupera", async () => {
    const pool = makePool();
    const pesado = path.join(dir, "pesado.txt");
    await writeFile(pesado, "a".repeat(64 * 1024));

    // O padrão **escapa** do detector de padrões catastróficos (o `{2}` é **limitado** ⇒
    // o detector não vê quantificador aninhado) e é **quadrático**: o `b` final nunca casa
    // ⇒ o motor faz backtracking em cada posição do texto.
    expect(isCatastrophicPattern("(a*){2}b")).toBe(false);

    const started = Date.now();
    const handle = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "grep", timeoutMs: 300 },
    );

    await expect(handle.done).rejects.toBeInstanceOf(TaskTimeoutError);
    await expect(handle.done).rejects.toMatchObject({ code: "task.timeout" });
    // O worker foi morto no teto ⇒ a rejeição é rápida (o `RegExp` não é interrompível,
    // mas o `terminate` da thread encerra a execução).
    expect(Date.now() - started).toBeLessThan(2000);

    // A lane **se recupera**: a task seguinte sobe um worker novo e resolve.
    const leve = path.join(dir, "leve.txt");
    await writeFile(leve, "needle\n");
    const depois = await pool.run(
      { kind: "grep", query: "needle", files: [leve] },
      { lane: "grep" },
    ).done;
    expect(depois.matches).toHaveLength(1);
  });

  it("a lane `grep` existe (1 worker) e é reportada em `busy` e nas lanes", async () => {
    const pool = makePool();
    expect(pool.size("grep")).toBe(1);
    expect(taskPoolLanes()).toContain("grep");
    expect(poolLanes()).toContain("grep");

    const file = path.join(dir, "lane.txt");
    await writeFile(file, "needle\n");
    const handle = pool.run({ kind: "grep", query: "needle", files: [file] }, { lane: "grep" });
    expect(pool.busy.grep).toBe(1);
    await handle.done;
    expect(pool.busy.grep).toBe(0);
  });
});
