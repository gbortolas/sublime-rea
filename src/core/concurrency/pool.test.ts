import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CancellationError, makeHandle } from "../../shared";
import { PoolShutdownError, StaleGenerationError, TaskPoolImpl } from "./pool";
import type { TaskPoolOptions } from "./pool";

let dir: string;
let pools: TaskPoolImpl[] = [];

function makePool(options: TaskPoolOptions = {}): TaskPoolImpl {
  const pool = new TaskPoolImpl({
    availableParallelism: 4,
    maxBackgroundThreads: 4,
    ...options,
  });
  pools.push(pool);
  return pool;
}

async function tempFile(name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content);
  return file;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scribe-pool-"));
});

afterEach(async () => {
  const current = pools;
  pools = [];
  await Promise.all(current.map((pool) => pool.shutdown()));
  await rm(dir, { recursive: true, force: true });
});

describe("TaskPoolImpl — I/O em worker_threads", () => {
  it("readFile e writeFile num diretório temporário", async () => {
    const pool = makePool();
    const file = path.join(dir, "greeting.txt");
    const data = new TextEncoder().encode("olá scribe").buffer as ArrayBuffer;

    await pool.run({ kind: "writeFile", path: file, data }).done;
    expect(await readFile(file, "utf8")).toBe("olá scribe");
    await expect(pool.run({ kind: "readFile", path: file }).done).resolves.toBe("olá scribe");
  });

  it("readFile com range lê só a fatia pedida", async () => {
    const pool = makePool();
    const file = await tempFile("range.txt", "0123456789");
    const handle = pool.run({ kind: "readFile", path: file, range: { offset: 2, length: 4 } });
    await expect(handle.done).resolves.toBe("2345");
  });

  it("incrementa o contador compartilhado ao concluir (DEC-CON-11)", async () => {
    const pool = makePool();
    const file = await tempFile("counter.txt", "abc");
    await pool.run({ kind: "readFile", path: file }).done;
    expect(pool.executedCount).toBeGreaterThanOrEqual(1);
  });
});

describe("TaskPoolImpl — scanLines e index (texto por mensagem)", () => {
  it("scanLines devolve LineScanResult carregando a generation recebida", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(1, 1);
    pool.registerText(doc, 1, "a\nbb\nccc");

    const result = await pool.run({ kind: "scanLines", doc, generation: 1, upto: 0 }).done;
    expect(result.doc).toBe(doc);
    expect(result.generation).toBe(1);
    expect(result.lineCount).toBe(3);
    expect(Array.from(result.lineStarts)).toEqual([0, 2, 5]);
  });

  it("scanLines respeita `upto` (offset limite)", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(2, 1);
    pool.registerText(doc, 1, "a\nb\nc");

    const result = await pool.run({ kind: "scanLines", doc, generation: 1, upto: 3 }).done;
    expect(result.lineCount).toBe(2);
    expect(Array.from(result.lineStarts)).toEqual([0, 2]);
  });

  it("index devolve IndexResult com generation e duração medida", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(3, 1);
    pool.registerText(doc, 1, "let alpha = beta + gamma;");

    const result = await pool.run({ kind: "index", doc, generation: 1 }).done;
    expect(result.generation).toBe(1);
    expect(result.symbolCount).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("descarta resultado de geração vencida (StaleGenerationError)", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(4, 1);
    pool.registerText(doc, 1, "x\ny");

    const stale = pool.run({ kind: "scanLines", doc, generation: 1, upto: 0 });
    pool.registerText(doc, 2, "x\ny\nz"); // doc avançou para a geração 2 antes do resultado voltar

    await expect(stale.done).rejects.toBeInstanceOf(StaleGenerationError);
  });

  it("rejeita scanLines quando não há texto registrado", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(5, 1);
    await expect(pool.run({ kind: "scanLines", doc, generation: 1, upto: 0 }).done).rejects.toThrow(
      /texto registrado/i,
    );
  });
});

describe("TaskPoolImpl — fila, cancelamento, resize e shutdown", () => {
  it("cancelar tarefa na fila a descarta sem spawnar worker", async () => {
    const pool = makePool({ ioWorkers: 1, availableParallelism: 2, maxBackgroundThreads: 1 });
    const file = await tempFile("cancel.txt", "one");

    const first = pool.run({ kind: "readFile", path: file });
    expect(pool.workerCount("fileRead")).toBe(1);

    const queued = pool.run({ kind: "readFile", path: file });
    queued.cancel("não preciso mais");
    await expect(queued.done).rejects.toBeInstanceOf(CancellationError);
    expect(pool.workerCount("fileRead")).toBe(1); // o cancelado nunca materializou worker

    await expect(first.done).resolves.toBe("one");
  });

  it("enfileira mais tarefas do que o tamanho do pool e completa todas", async () => {
    const pool = makePool({ ioWorkers: 1, availableParallelism: 2, maxBackgroundThreads: 1 });
    const files = await Promise.all(
      ["a", "b", "c", "d"].map((name, index) => tempFile(`${name}.txt`, `conteudo-${index}`)),
    );

    const handles = files.map((file) => pool.run({ kind: "readFile", path: file }));
    const results = await Promise.all(handles.map((handle) => handle.done));
    expect(results).toEqual(["conteudo-0", "conteudo-1", "conteudo-2", "conteudo-3"]);
  });

  it("respeita a prioridade da fila (input > edit > background) com um worker só", async () => {
    const pool = makePool({ ioWorkers: 1, availableParallelism: 2, maxBackgroundThreads: 1 });
    const [occupy, bg, input, edit] = await Promise.all([
      tempFile("occupy.txt", "occupy"),
      tempFile("bg.txt", "bg"),
      tempFile("input.txt", "input"),
      tempFile("edit.txt", "edit"),
    ]);

    const order: string[] = [];
    const blocking = pool.run({ kind: "readFile", path: occupy });
    blocking.done.then(() => order.push("occupy"), () => order.push("occupy-err"));

    const enqueue = (file: string, tag: string, priority: "input" | "edit" | "background"): Promise<string> => {
      const handle = pool.run({ kind: "readFile", path: file }, { priority });
      handle.done.then(() => order.push(tag), () => order.push(`${tag}-err`));
      return handle.done;
    };

    const all = Promise.all([
      blocking.done,
      enqueue(bg, "bg", "background"),
      enqueue(input, "input", "input"),
      enqueue(edit, "edit", "edit"),
    ]);
    await all;

    expect(order).toEqual(["occupy", "input", "edit", "bg"]);
  });

  it("cancelamento cooperativo de tarefa em execução rejeita com CancellationError", async () => {
    const pool = makePool();
    const file = await tempFile("abort.txt", "abort");
    const controller = new AbortController();
    const handle = pool.run({ kind: "readFile", path: file }, { signal: controller.signal });
    controller.abort("usuário cancelou");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);
  });

  it("resize sobe e desce a lane respeitando o teto global", async () => {
    const pool = makePool({ ioWorkers: 1, availableParallelism: 8, maxBackgroundThreads: 8 });
    expect(pool.size("io")).toBe(1);
    expect(pool.workerCount("io")).toBe(0);

    await pool.resize("io", 3);
    expect(pool.size("io")).toBe(3);
    expect(pool.workerCount("io")).toBe(3);

    await pool.resize("io", 1);
    expect(pool.size("io")).toBe(1);
    expect(pool.workerCount("io")).toBe(1);
  });

  it("shutdown encerra os workers, rejeita novas tarefas e é idempotente", async () => {
    const pool = makePool();
    const file = await tempFile("shutdown.txt", "bye");
    await pool.run({ kind: "readFile", path: file }).done;
    expect(pool.workerCount("fileRead")).toBe(1);

    await pool.shutdown();
    expect(pool.workerCount("fileRead")).toBe(0);
    expect(pool.workerCount("io")).toBe(0);
    expect(pool.busy).toEqual({ io: 0, index: 0, fileRead: 0 });

    await expect(pool.run({ kind: "readFile", path: file }).done).rejects.toBeInstanceOf(PoolShutdownError);
    await pool.shutdown(); // idempotente
  });

  it("teto global nunca é 0 (min(setting, cpus-1) com piso 1)", () => {
    const pool = makePool({ availableParallelism: 1, maxBackgroundThreads: 0, ioWorkers: 8 });
    expect(pool.maxWorkers).toBe(1);
    expect(pool.size("io")).toBe(1);
    expect(pool.size("index")).toBe(1);
    expect(pool.size("fileRead")).toBe(1);
  });
});
