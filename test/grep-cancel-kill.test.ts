/**
 * Scribe — **cancelamento** de uma busca no worker: a graça que **mata** o worker preso.
 *
 * O cancel do pool é **cooperativo** (o `AbortController` aborta **entre arquivos**), mas um
 * `RegExp` **ininterruptível** (o motor do JS não é interrompível — nem por `AbortSignal`)
 * **nunca** responde. Sem uma rede de proteção, o cancel deixava a lane `grep` **morta**: o
 * worker ficava em 100 % de CPU para sempre, `busy.grep` não voltava a zero e **nenhuma**
 * outra busca da lane rodava (o painel ficava "Buscando…" eternamente).
 *
 * O que se prova aqui:
 * - **worker preso**: cancelar uma busca patológica ⇒ o worker é **matado** dentro da graça
 *   ({@link CANCEL_KILL_GRACE_MS}), o `busy` volta a zero e a **próxima** task da mesma lane
 *   resolve (a lane se recuperou);
 * - **cancelamento normal**: o worker que responde a tempo **sobrevive** (a graça **não** mata
 *   o worker que já respondeu) ⇒ a próxima task roda **sem** cold start;
 * - o cancel **não** desarma o teto duro: a task cancelada é contada **uma vez** só.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CancellationError } from "../src/shared";
import { CANCEL_KILL_GRACE_MS, createTaskPool } from "../src/core/concurrency/pool";
import type { TaskPoolImpl } from "../src/core/concurrency/pool";

let dir: string;
let pools: TaskPoolImpl[] = [];

/**
 * Pool de teste: teto de 4 CPUs e **idle longo** (o worker da lane `grep` **não** é
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Aquece o worker da lane `grep` (uma busca trivial) ⇒ o cancel **não** espera o *cold
 * start* do worker.
 *
 * ⚠️ **Por que isto é necessário (achado da revisão — teste flaky):** a espera fixa
 * (`sleep(750)`) pressupunha que o worker **já** tinha entrado no `RegExp`. Num CI
 * carregado o *cold start* passava de 750 ms ⇒ o cancel chegava **na leitura** ⇒ o worker
 * respondia **cooperativo** (o abort é checado entre arquivos) ⇒ ele **não** morria ⇒ o
 * teste falhava.
 *
 * Com o **aquecimento**, o worker já está de pé quando a busca patológica começa: o
 * `RegExp` catastrófico leva **minutos** ⇒ qualquer cancel que chegue depois da leitura
 * (a leitura de 64 KiB leva **milissegundos**) pega o worker **preso** — que é o que o
 * teste quer provar.
 */
async function warmupGrepWorker(pool: TaskPoolImpl): Promise<void> {
  const file = path.join(dir, "warmup.txt");
  await writeFile(file, "needle\n");
  await pool.run({ kind: "grep", query: "needle", files: [file] }, { lane: "grep" }).done;
}

/** Espera (polling) até a condição valer — falha o teste se o prazo estourar. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timeout de ${timeoutMs} ms esperando: ${what}`);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scribe-grep-cancel-"));
});

afterEach(async () => {
  const current = pools;
  pools = [];
  // O `shutdown` **mata** o worker que ficou preso no `RegExp` (é o `terminate` que
  // encerra a thread) — sem isso o teste ficaria com o worker pendurado.
  await Promise.all(current.map((pool) => pool.shutdown()));
  await rm(dir, { recursive: true, force: true });
});

describe("cancelamento de busca no worker — a graça mata o worker preso", () => {
  it("worker preso: cancelar mata a thread, o busy volta a zero e a lane se recupera", async () => {
    const pool = makePool();
    const pesado = path.join(dir, "pesado.txt");
    // 64 KiB exatos: no modo regex o teto por arquivo é 64 KiB (maior ⇒ o arquivo é pulado).
    await writeFile(pesado, "a".repeat(64 * 1024));

    // O worker **já está de pé** (aquecimento) ⇒ o cancel não depende do *cold start*.
    await warmupGrepWorker(pool);

    // O padrão `(a*){2}b` **escapa** do detector de padrões catastróficos (o `{2}` é
    // limitado) e é **quadrático**: o `b` final nunca casa ⇒ o motor faz backtracking em
    // cada posição do texto ⇒ a thread fica presa (o abort nunca é checado: é 1 arquivo só).
    const handle = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "grep", timeoutMs: 30_000 },
    );
    expect(pool.busy.grep).toBe(1);

    // Deixa o worker **entrar** no `RegExp` (a leitura leva milissegundos; o `RegExp`
    // leva minutos ⇒ 400 ms é folga para o cancel chegar com o worker **preso**).
    await sleep(400);
    expect(pool.busy.grep).toBe(1);

    // O usuário troca a query ⇒ cancela a busca anterior.
    handle.cancel("usuário trocou a query");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);

    // O worker **não responde** (o `RegExp` é ininterruptível) ⇒ a graça mata a thread.
    const started = Date.now();
    await waitFor(() => pool.busy.grep === 0, CANCEL_KILL_GRACE_MS + 1_500, "o busy da lane voltar a zero");
    expect(Date.now() - started).toBeLessThanOrEqual(CANCEL_KILL_GRACE_MS + 1_000);
    expect(pool.busy.grep).toBe(0);
    // O worker foi **matado** (o slot sai do pool no `terminate`).
    expect(pool.workerCount("grep")).toBe(0);

    // A lane **se recupera**: a próxima task da MESMA lane sobe um worker novo e resolve.
    const leve = path.join(dir, "leve.txt");
    await writeFile(leve, "needle\n");
    const depois = await pool.run(
      { kind: "grep", query: "needle", files: [leve] },
      { lane: "grep" },
    ).done;
    expect(depois.matches).toHaveLength(1);
    expect(pool.busy.grep).toBe(0);
  });

  it("cancelamento normal: o worker que responde a tempo NÃO é morto (a graça não o mata)", async () => {
    const pool = makePool();
    const files: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const file = path.join(dir, `c${i}.txt`);
      await writeFile(file, `needle ${"x".repeat(4000)}\n`);
      files.push(file);
    }

    const handle = pool.run({ kind: "grep", query: "needle", files }, { lane: "grep" });
    expect(pool.busy.grep).toBe(1);
    handle.cancel("usuário cancelou");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);

    // A graça passa inteira sem que o worker morra ⇒ ele respondeu a tempo (abort
    // cooperativo) e continua **vivo** na lane (o `terminate` tiraria o slot do pool).
    await sleep(CANCEL_KILL_GRACE_MS + 500);
    expect(pool.workerCount("grep")).toBe(1);
    expect(pool.busy.grep).toBe(0);

    // A próxima task roda **no mesmo worker** (sem cold start).
    const leve = path.join(dir, "leve.txt");
    await writeFile(leve, "needle\n");
    const depois = await pool.run(
      { kind: "grep", query: "needle", files: [leve] },
      { lane: "grep" },
    ).done;
    expect(depois.matches).toHaveLength(1);
    expect(pool.workerCount("grep")).toBe(1);
  });

  it("o cancel não desarma o teto duro: a task cancelada é contada uma vez só", async () => {
    const pool = makePool();
    const pesado = path.join(dir, "pesado.txt");
    await writeFile(pesado, "a".repeat(64 * 1024));
    await warmupGrepWorker(pool);

    const handle = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "grep", timeoutMs: 30_000 },
    );
    // Deixa o worker **entrar** no `RegExp` (o cancel precisa chegar quando ele já está preso).
    await sleep(400);
    handle.cancel("usuário trocou a query");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);
    // O cancel já contou a task.
    expect(pool.cancelledCount).toBe(1);

    // A graça estoura (o worker não respondeu) ⇒ o worker é morto, mas a task **não** é
    // contada de novo (e o motivo entregue continua sendo o `CancellationError`).
    await waitFor(() => pool.busy.grep === 0, CANCEL_KILL_GRACE_MS + 1_500, "o busy da lane voltar a zero");
    expect(pool.cancelledCount).toBe(1);
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);
  });

  it("task SEM teto duro: a graça do cancel ainda mata o worker preso", async () => {
    const pool = makePool();
    const pesado = path.join(dir, "pesado.txt");
    await writeFile(pesado, "a".repeat(64 * 1024));
    await warmupGrepWorker(pool);

    // **Sem** `timeoutMs` (task sem teto duro): o timer do cancel **é** a graça — sem ela,
    // o worker preso ficaria em 100 % de CPU para sempre (ninguém mataria a thread).
    const handle = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "grep" },
    );
    await sleep(400);
    handle.cancel("usuário trocou a query");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);

    await waitFor(() => pool.busy.grep === 0, CANCEL_KILL_GRACE_MS + 1_500, "o busy da lane voltar a zero");
    expect(pool.busy.grep).toBe(0);
    expect(pool.workerCount("grep")).toBe(0);
  });
});
