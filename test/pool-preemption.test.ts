/**
 * Scribe — **prioridade de lane** no `TaskPool`: o primeiro plano **não espera** pelo fundo.
 *
 * A lane `grep` (a busca em **todos os arquivos** da workspace) é de **fundo**; o realce de
 * sintaxe e o find bar (lane `index`) e o salvar (lane `io`) são de **primeiro plano** — o
 * realce está no **caminho da digitação**.
 *
 * ⚠️ **O bug que este arquivo trava:** a preempção (matar um slot **ocioso** de outra lane)
 * **invertia** a prioridade — o grep tomava o slot e segurava por até 30 s ⇒ o realce e o
 * salvar ficavam **pendurados** atrás do fundo.
 *
 * O que se prova aqui:
 * - com `cap = 1`, uma task de **primeiro plano** que chega enquanto a lane de **fundo** está
 *   **ocupada** ⇒ ela **resolve rápido** e a task de fundo é rejeitada com
 *   {@link TaskPreemptedError} (`code === "task.preempted"`) — o worker da frente **sobe**;
 * - `preemptible` tem **default `false`** ⇒ por padrão **nada** é morto (a task de primeiro
 *   plano espera, e a de fundo continua viva);
 * - a task de fundo **na fila** (nunca chegou a rodar) **não** é morta: ela sai da fila
 *   normalmente (quando o slot libera);
 * - **cancelar uma `writeFile`**: a graça do cancel **não** é armada para quem escreve ⇒ o
 *   worker **não** é morto, o **destino fica íntegro** e **não** sobra `.scribe-*` órfão.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CancellationError, TaskPreemptedError, makeHandle } from "../src/shared";
import { CANCEL_KILL_GRACE_MS, createTaskPool } from "../src/core/concurrency/pool";
import type { TaskPoolImpl } from "../src/core/concurrency/pool";

let dir: string;
let pools: TaskPoolImpl[] = [];

/** Pool com **teto global = 1** (2 CPUs ⇒ min(setting, cpus − 1) = 1) e idle longo. */
function makeCapOnePool(): TaskPoolImpl {
  const pool = createTaskPool({
    availableParallelism: 2,
    maxBackgroundThreads: 1,
    idleTimeoutMs: 30_000,
  });
  pools.push(pool);
  return pool;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Arquivo **catastrófico**: o padrão `(a*){2}b` **escapa** do detector de padrões
 * catastróficos (o `{2}` é limitado) e é **quadrático** ⇒ o `RegExp` **nunca** termina
 * (leva minutos) ⇒ o worker fica **preso**.
 *
 * 64 KiB exatos: no modo regex o teto por arquivo é 64 KiB (maior ⇒ o arquivo é pulado).
 */
async function catastrophicFile(name: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, "a".repeat(64 * 1024));
  return file;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scribe-pool-preempt-"));
});

afterEach(async () => {
  const current = pools;
  pools = [];
  // O `shutdown` **mata** o worker que ficou preso no `RegExp` (é o `terminate` que
  // encerra a thread) — sem isso o teste ficaria com o worker pendurado.
  await Promise.all(current.map((pool) => pool.shutdown()));
  await rm(dir, { recursive: true, force: true });
});

describe("TaskPool — o primeiro plano não espera pelo fundo", () => {
  it("task de primeiro plano resolve rápido e a de fundo é preemptada (TaskPreemptedError)", async () => {
    const pool = makeCapOnePool();
    const pesado = await catastrophicFile("pesado.txt");

    // A task de **fundo** (o grep) toma o único slot e **fica presa** no `RegExp`.
    const fundo = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "grep", preemptible: true },
    );
    // O `catch` evita a rejeição "não tratada" (a task é preemptada lá adiante).
    fundo.done.catch(() => undefined);
    expect(pool.busy.grep).toBe(1);

    // O **realce de sintaxe**/find bar (lane `index`) chega agora: o primeiro plano **não
    // espera** pelo fundo ⇒ o pool mata a task de fundo e sobe o worker na hora.
    const doc = makeHandle<"DocumentHandle">(1, 1);
    pool.registerText(doc, 1, "needle\n");
    const started = Date.now();
    const primeiro = await pool.run({
      kind: "search",
      doc,
      generation: 1,
      query: { pattern: "needle" },
    }).done;

    expect(Date.now() - started).toBeLessThan(2000);
    expect(primeiro.matches).toHaveLength(1);

    // A task de fundo foi **preemptada** (não "estourou" nem foi cancelada pelo usuário).
    await expect(fundo.done).rejects.toBeInstanceOf(TaskPreemptedError);
    await expect(fundo.done).rejects.toMatchObject({ code: "task.preempted" });
    // O `busy` da lane de fundo voltou a zero (o slot foi liberado).
    expect(pool.busy.grep).toBe(0);
    // E o worker da frente está vivo, servindo o primeiro plano.
    expect(pool.workerCount("index")).toBe(1);
  });

  it("por padrão (`preemptible: false`) NADA é morto: o fundo continua vivo", async () => {
    const pool = makeCapOnePool();
    const pesado = await catastrophicFile("pesado.txt");

    // Mesma task de fundo, **sem** `preemptible` ⇒ ela **não** pode ser morta.
    const fundo = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "grep" },
    );
    fundo.done.catch(() => undefined);
    expect(pool.busy.grep).toBe(1);

    const doc = makeHandle<"DocumentHandle">(2, 1);
    pool.registerText(doc, 1, "needle\n");
    const primeiro = pool.run({
      kind: "search",
      doc,
      generation: 1,
      query: { pattern: "needle" },
    });
    let settled = false;
    void primeiro.done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // O primeiro plano **espera** (o slot está tomado por quem **não** é preemptível) e o
    // fundo **não** foi morto.
    await sleep(500);
    expect(settled).toBe(false);
    expect(pool.busy.grep).toBe(1);

    primeiro.cancel("fim do teste");
    await expect(primeiro.done).rejects.toBeInstanceOf(CancellationError);
  });

  it("a task de fundo NA FILA não é preemptada: ela sai da fila quando o slot libera", async () => {
    const pool = makeCapOnePool();
    const pesado = await catastrophicFile("pesado.txt");
    const leve = path.join(dir, "leve.txt");
    await writeFile(leve, "needle\n");

    // O slot é tomado por uma task **não** preemptível que **estoura** (teto duro) ⇒ o
    // worker dela morre e o slot é liberado.
    const ocupante = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "io", timeoutMs: 300 },
    );
    ocupante.done.catch(() => undefined);
    expect(pool.busy.io).toBe(1);

    // A task de fundo (preemptible) **na fila** — o teto global está tomado.
    const fundo = pool.run(
      { kind: "grep", query: "needle", files: [leve] },
      { lane: "grep", preemptible: true },
    );
    expect(pool.busy.grep).toBe(0);

    // O ocupante estoura ⇒ o slot libera ⇒ a task de fundo **roda** (ela nunca chegou a
    // rodar ⇒ não há o que matar: ela sai da fila normalmente).
    const resultado = await fundo.done;
    expect(resultado.matches).toHaveLength(1);
    expect(pool.busy.grep).toBe(0);
  });
});

describe("TaskPool — cancelar uma escrita não mata o worker (sem perda de dados)", () => {
  it("o destino fica íntegro, não sobra tmp órfão e o worker NÃO é morto", async () => {
    const pool = makeCapOnePool();
    const target = path.join(dir, "alvo.txt");
    await writeFile(target, "original\n");

    // Payload grande: a escrita **fica em andamento** quando o cancel chega (o abort cai
    // **antes** do `rename` — o ponto sem volta). O `cancel` é publicado logo depois do
    // `run` ⇒ ele chega ao worker **durante** a escrita.
    const data = new TextEncoder().encode("x".repeat(32 * 1024 * 1024)).buffer as ArrayBuffer;
    const handle = pool.run({ kind: "writeFile", path: target, data }, { lane: "io" });
    handle.cancel("usuário cancelou");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);

    // A **graça** do cancel (que mata o worker) **não** foi armada para quem escreve ⇒
    // o worker sobrevive (a escrita termina em paz).
    await sleep(CANCEL_KILL_GRACE_MS + 500);
    expect(pool.workerCount("io")).toBe(1);

    // O **destino ficou íntegro** (conteúdo original) e **não** sobrou `.scribe-*` órfão.
    expect(await readFile(target, "utf8")).toBe("original\n");
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".scribe-"));
    expect(leftovers).toEqual([]);
  });
});
