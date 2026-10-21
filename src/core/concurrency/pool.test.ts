import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CancellationError,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_PATTERN_LENGTH,
  SEARCH_MAX_TEXT_LENGTH,
  TaskTimeoutError,
  makeHandle,
  normalizeSearchQuery,
  scanText,
  type DocumentHighlight,
  type SerializedGrammar,
} from "../../shared";
import type { SearchQuery } from "../../shared";
import { PoolShutdownError, StaleGenerationError, TaskPoolImpl } from "./pool";
import type { TaskPoolOptions } from "./pool";
import { tokenizeCompiledLine } from "../syntax/tokenizer";
import type { CompiledGrammar, CompiledPattern } from "../syntax/tokenizer";

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
    expect(pool.busy).toEqual({ io: 0, index: 0, fileRead: 0, grep: 0 });

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

// ── Starvation de lane: preempção + teto cobrindo a FILA ──────────────────────────────────────
//
// O `cap` global do pool (min(setting, cpus − 1)) é **compartilhado** por todas as lanes. A
// lane `io` é **residente** (o worker não é reciclado por idle) ⇒ ela segura o teto global
// sozinha. Sem preempção, uma task de outra lane (`grep`) ficava na fila **para sempre** (e o
// `timeoutMs` **não** disparava, porque o relógio só era armado na atribuição).
//
// O contrato (em `src/shared/concurrency-contract.ts`) é: o `timeoutMs` cobre a task
// **INTEIRA** — a espera na fila conta. Logo: ou a task **roda** (preempção) ou ela **estoura**
// (teto) — nunca fica pendurada.

describe("TaskPoolImpl — preempção de lane e teto cobrindo a fila", () => {
  const LANES = ["io", "index", "fileRead", "grep"] as const;

  /** Total de workers vivos (todas as lanes) — para aferir o teto global. */
  function totalWorkers(pool: TaskPoolImpl): number {
    return LANES.reduce((sum, lane) => sum + pool.workerCount(lane), 0);
  }

  /** Pool com **teto global = 1** (2 CPUs ⇒ min(setting, cpus − 1) = 1) e idle longo. */
  function makeCapOnePool(): TaskPoolImpl {
    return makePool({ availableParallelism: 2, maxBackgroundThreads: 1, idleTimeoutMs: 30_000 });
  }

  it("preempta o worker ocioso de outra lane (a task não fica na fila para sempre)", async () => {
    const pool = makeCapOnePool();
    expect(pool.maxWorkers).toBe(1);

    const io = await tempFile("preempt-io.txt", "conteúdo");
    const alvo = await tempFile("preempt-alvo.txt", "needle\n");

    // A lane `io` é **residente**: o worker fica vivo (ocioso) depois da task.
    await pool.run({ kind: "readFile", path: io }, { lane: "io" }).done;
    expect(pool.workerCount("io")).toBe(1);

    // A lane `grep` não tem worker e o teto global está tomado ⇒ **preempção** do worker `io`.
    const resultado = await pool.run(
      { kind: "grep", query: "needle", files: [alvo] },
      { lane: "grep" },
    ).done;

    expect(resultado.matches).toHaveLength(1);
    expect(pool.workerCount("grep")).toBe(1);
    expect(pool.workerCount("io")).toBe(0); // o worker `io` foi preemptado
    // O teto global continua respeitado (nunca mais de `cap` workers vivos).
    expect(totalWorkers(pool)).toBeLessThanOrEqual(pool.maxWorkers);
  });

  it("preempta quando a task da outra lane termina (a fila drena)", async () => {
    const pool = makeCapOnePool();
    const io = await tempFile("drain-io.txt", "conteúdo");
    const alvo = await tempFile("drain-alvo.txt", "needle\n");

    // A task `io` está **em andamento** (o worker ocupado não pode ser preemptado).
    const ioTask = pool.run({ kind: "readFile", path: io }, { lane: "io" });
    expect(pool.busy.io).toBe(1);

    // A task `grep` não tem worker na lane e o teto global está tomado ⇒ **fica na fila**.
    const grepTask = pool.run({ kind: "grep", query: "needle", files: [alvo] }, { lane: "grep" });
    expect(pool.busy.grep).toBe(0);

    // Quando a task `io` termina, o worker `io` fica ocioso e é preemptado ⇒ o grep roda.
    const [resultado] = await Promise.all([grepTask.done, ioTask.done]);
    expect(resultado.matches).toHaveLength(1);
    expect(totalWorkers(pool)).toBeLessThanOrEqual(pool.maxWorkers);
  });

  it("teto na fila: a task que nunca é atribuída estoura com TaskTimeoutError", async () => {
    const pool = makeCapOnePool();
    // 64 KiB exatos: no modo regex o teto por arquivo é 64 KiB (maior ⇒ o arquivo é pulado).
    const pesado = await tempFile("pesado.txt", "a".repeat(64 * 1024));

    // A task `io` fica **ocupada** para sempre: o `RegExp` quadrático `(a*){2}b` nunca
    // termina (o detector de padrões catastróficos **não** vê o `{2}`, que é limitado).
    const ocupante = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "io" },
    );
    ocupante.done.catch(() => undefined); // o ocupante só morre no `shutdown`
    expect(pool.busy.io).toBe(1);

    // A task da lane `grep` não tem worker e o teto global está tomado por uma task
    // **ocupada** (que não pode ser preemptada) ⇒ ela **fica na fila** e o teto estoura.
    const started = Date.now();
    const handle = pool.run(
      { kind: "grep", query: "needle", files: [pesado] },
      { lane: "grep", timeoutMs: 300 },
    );
    await expect(handle.done).rejects.toBeInstanceOf(TaskTimeoutError);
    await expect(handle.done).rejects.toMatchObject({ code: "task.timeout" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5000);
    // A task **nunca rodou** ⇒ nenhum worker foi morto (o `io` segue vivo).
    expect(pool.workerCount("io")).toBe(1);
  });

  it("teto na fila: a 2ª task da MESMA lane estoura enquanto a 1ª roda", async () => {
    const pool = makeCapOnePool();
    const pesado = await tempFile("mesma-lane.txt", "a".repeat(64 * 1024));

    const ocupante = pool.run(
      { kind: "grep", query: "(a*){2}b", files: [pesado], options: { regex: true } },
      { lane: "io" },
    );
    ocupante.done.catch(() => undefined);
    expect(pool.busy.io).toBe(1);

    // A 2ª task da **mesma** lane espera o worker (que está ocupado) ⇒ o relógio, que cobre a
    // **fila**, estoura em ~300 ms (e não em 30 s, e não para sempre).
    const started = Date.now();
    const handle = pool.run(
      { kind: "readFile", path: pesado },
      { lane: "io", timeoutMs: 300 },
    );
    await expect(handle.done).rejects.toBeInstanceOf(TaskTimeoutError);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5000);
    // A task que estourou **na fila** nunca ocupou o worker ⇒ o `busy` da lane segue 1.
    expect(pool.busy.io).toBe(1);
  });
});

describe("TaskPoolImpl — kind `search` (lane `index`, CPU em memória)", () => {
  it("registerText + run devolve as ocorrências com line/column", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(20, 1);
    pool.registerText(doc, 1, "foo bar foo");

    const result = await pool.run({ kind: "search", doc, generation: 1, query: { pattern: "foo" } }).done;
    expect(result.matches).toEqual([
      { index: 0, length: 3, line: 0, column: 0 },
      { index: 8, length: 3, line: 0, column: 8 },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("marca truncated ao bater o teto de ocorrências", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(21, 1);
    pool.registerText(doc, 1, "aaaaa");

    const result = await pool
      .run({ kind: "search", doc, generation: 1, query: { pattern: "a", maxMatches: 2 } })
      .done;
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("descarta resultado de geração vencida (StaleGenerationError)", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(22, 1);
    pool.registerText(doc, 1, "foo");

    const stale = pool.run({ kind: "search", doc, generation: 1, query: { pattern: "foo" } });
    pool.registerText(doc, 2, "foo foo"); // doc avançou para a geração 2 antes do resultado voltar

    await expect(stale.done).rejects.toBeInstanceOf(StaleGenerationError);
  });

  it("cancelamento cooperativo rejeita com CancellationError", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(23, 1);
    pool.registerText(doc, 1, "abc abc");

    const controller = new AbortController();
    const handle = pool.run(
      { kind: "search", doc, generation: 1, query: { pattern: "abc" } },
      { signal: controller.signal },
    );
    controller.abort("usuário cancelou");
    await expect(handle.done).rejects.toBeInstanceOf(CancellationError);
  });

  it("propaga erro tipado de padrão inválido (name/code do wire sobrevivem)", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(24, 1);
    pool.registerText(doc, 1, "abc");

    const handle = pool.run({ kind: "search", doc, generation: 1, query: { pattern: "" } });
    await expect(handle.done).rejects.toMatchObject({
      name: "SearchInputError",
      code: "search.emptyPattern",
    });
  });

  it("paridade worker ↔ shared: a varredura do worker bate com scanText", async () => {
    const pool = makePool();
    const doc = makeHandle<"DocumentHandle">(25, 1);
    const text = "Foo foo\nbar foo\r\nfoo";
    pool.registerText(doc, 1, text);

    // Smoke do caminho básico (a tabela discriminante vive no describe abaixo).
    const queries: SearchQuery[] = [
      { pattern: "foo" },
      { pattern: "foo", caseSensitive: true },
      { pattern: "f.o", regex: true },
      { pattern: "foo", wholeWord: true },
      { pattern: "o+", regex: true, maxMatches: 3 },
    ];
    for (const query of queries) {
      const worker = await pool.run({ kind: "search", doc, generation: 1, query }).done;
      expect(worker).toEqual(scanText(text, normalizeSearchQuery(query)));
    }
  });
});

// ---- paridade worker <-> shared: tabela discriminante ---------------------------------------------
//
// `worker-entry.ts` **replica** `src/shared/search-contract.ts` — o `eval` do vitest não resolve o
// import de valor `../../shared` no caminho transpilado (ver o comentário no próprio worker) — e a
// duplicata é o **caminho de produção**: divergir aqui é divergir no editor. Estes casos rodam
// contra o **worker real** (via `TaskPool`, em `worker_threads`) e comparam com o shared
// (`toEqual`): literal com metacaracteres, `caseSensitive`, `wholeWord` não-trivial, `regex` (incl.
// casamento vazio), `\r\n`/EOF sem newline, teto de matches (truncamento/clamp) e erros tipados.
// Cada caso é escolhido para **discriminar**: mutar `wholeWord`, quebrar o escape do literal ou
// mudar o default de `maxMatches` **no worker** faz este teste falhar (as três mutações foram
// verificadas à mão — não é teste de fumaça).

/** Forma comparável de um erro: `name`/`code`/`message` (a classe não cruza a fronteira do worker). */
function errorShape(error: unknown): { name: string; code: unknown; message: string } {
  const record = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof record.name === "string" ? record.name : "",
    code: record.code,
    message: typeof record.message === "string" ? record.message : "",
  };
}

/** Roda o thunk e devolve o erro em forma comparável (falha se nada for lançado). */
async function errorOf(thunk: () => Promise<unknown>): Promise<ReturnType<typeof errorShape>> {
  try {
    await thunk();
  } catch (error) {
    return errorShape(error);
  }
  throw new Error("paridade: esperava um erro tipado, mas nada foi lançado");
}

const PARITY_CASES: readonly { name: string; text: string; query: SearchQuery }[] = [
  // (a) literal **com metacaracteres**: se o escape quebrar, `a.b` casa `aXb` e o resultado diverge.
  {
    name: "(a) literal 'a.b' não casa 'aXb'",
    text: "a.b aXb (x) axx [y] a$^b \\d \\d",
    query: { pattern: "a.b" },
  },
  { name: "(a) literal '(x)' (parênteses escapados)", text: "z(x) zxx [y] z_q", query: { pattern: "z(x)" } },
  { name: "(a) literal '[y]' (colchetes escapados)", text: "[y] y x[y]x", query: { pattern: "[y]" } },
  { name: "(a) literal '\\d' (barra + d, não dígito)", text: "1 \\d 2 \\d3", query: { pattern: "\\d" } },
  { name: "(a) literal '$^' (âncoras escapadas)", text: "ab$^cd $^", query: { pattern: "$^" } },
  { name: "(a) literal com parêntese sem fechar não explode", text: "(( x) (x", query: { pattern: "(x" } },
  // (b) caseSensitive=false (default) com maiúsculas/minúsculas mistas.
  { name: "(b) caseSensitive=false com casos mistos", text: "Foo fOO foo FOO", query: { pattern: "foo" } },
  {
    name: "(b) caseSensitive=true só casa a caixa exata",
    text: "Foo foo FOO",
    query: { pattern: "Foo", caseSensitive: true },
  },
  {
    name: "(b) caseSensitive=false com classe e quantificador",
    text: "AbCd abcd ABCD",
    query: { pattern: "a[bc]+d", regex: true },
  },
  // (c) wholeWord não-trivial: início/fim da string, pontuação, underscore e número adjacente.
  {
    name: "(c) wholeWord: início/fim, pontuação, underline e número adjacente",
    text: "foo foo_bar foo7 7foo (foo) .foo. foo\nfoo",
    query: { pattern: "foo", wholeWord: true },
  },
  {
    name: "(c) wholeWord com padrão regex",
    text: "eed e foo bar baz",
    query: { pattern: "\\w+", regex: true, wholeWord: true },
  },
  { name: "(c) wholeWord numa string de exatamente uma palavra", text: "foo", query: { pattern: "foo", wholeWord: true } },
  {
    name: "(c) wholeWord com número colado (foo1 vs foo)",
    text: "foo1 1foo foo foo. foo_",
    query: { pattern: "foo", wholeWord: true },
  },
  // (d) regex=true, incluindo padrões que casam vazio (ignorados: nem travam nem contam).
  { name: "(d) regex '^' (comprimento zero ignorado)", text: "abc\ndef", query: { pattern: "^", regex: true } },
  { name: "(d) regex 'o*' (quase tudo vazio)", text: "foo bar boo", query: { pattern: "o*", regex: true } },
  { name: "(d) regex '\\b' (zero-width puro)", text: "one two", query: { pattern: "\\b", regex: true } },
  { name: "(d) regex com alternância e grupo", text: "cat dog bird", query: { pattern: "(cat|dog)", regex: true } },
  // (e) `\r\n` e fim-de-arquivo sem newline (linha/coluna).
  { name: "(e) \\r\\n misturado com \\n e EOF sem newline", text: "foo\r\nbar\r\nfoo\nfoo", query: { pattern: "foo" } },
  { name: "(e) \\r isolado não abre linha nova", text: "a\rb\r\nfoo", query: { pattern: "foo" } },
  { name: "(e) doc de uma linha terminando sem newline", text: "needle", query: { pattern: "needle" } },
  // (f) teto de matches: truncamento e clamp (explícito, default e degenerado).
  {
    name: "(f) maxMatches explícito bate o teto (truncated: true)",
    text: "a".repeat(10),
    query: { pattern: "a", maxMatches: 3 },
  },
  {
    name: "(f) default (2000) bate o teto em 2500 ocorrências",
    text: "a".repeat(2500),
    query: { pattern: "a" },
  },
  {
    name: "(f) maxMatches acima do teto absoluto é clampado",
    text: "a".repeat(SEARCH_MAX_MATCHES + 5),
    query: { pattern: "a", maxMatches: SEARCH_MAX_MATCHES * 2 },
  },
  { name: "(f) maxMatches=0 é clampado em 1", text: "aaaa", query: { pattern: "a", maxMatches: 0 } },
  {
    name: "(f) maxMatches não-finito (NaN) cai no default, não em cap NaN",
    text: "a".repeat(2500),
    query: { pattern: "a", maxMatches: Number.NaN },
  },
];

describe("paridade worker <-> shared (tabela discriminante, worker real)", () => {
  let parityPool: TaskPoolImpl;
  let paritySeq = 0;

  beforeAll(() => {
    parityPool = new TaskPoolImpl({ availableParallelism: 4, maxBackgroundThreads: 2 });
  });

  afterAll(async () => {
    await parityPool.shutdown();
  });

  it.each(PARITY_CASES)("$name", async ({ text, query }) => {
    paritySeq += 1;
    const doc = makeHandle<"DocumentHandle">(500, paritySeq);
    parityPool.registerText(doc, paritySeq, text);
    const fromWorker = await parityPool.run({
      kind: "search",
      doc,
      generation: paritySeq,
      query,
    }).done;
    expect(fromWorker).toEqual(scanText(text, normalizeSearchQuery(query)));
  });

  it("erro tipado idêntico dos dois lados (vazio, teto do padrão, regex inválida)", async () => {
    const doc = makeHandle<"DocumentHandle">(590, 1);
    parityPool.registerText(doc, 1, "abc");
    const queries: SearchQuery[] = [
      { pattern: "" },
      { pattern: "a".repeat(SEARCH_MAX_PATTERN_LENGTH + 1) },
      { pattern: "(", regex: true },
      { pattern: "a".repeat(SEARCH_MAX_PATTERN_LENGTH + 1), regex: true },
    ];
    for (const query of queries) {
      const fromWorker = await errorOf(
        () => parityPool.run({ kind: "search", doc, generation: 1, query }).done,
      );
      const fromShared = await errorOf(() => {
        scanText("abc", normalizeSearchQuery(query));
        return Promise.resolve();
      });
      expect(fromWorker).toEqual(fromShared);
      expect(fromWorker.name).toBe("SearchInputError");
    }
  });

  it("texto acima de SEARCH_MAX_TEXT_LENGTH ⇒ search.tooLarge dos dois lados", async () => {
    const doc = makeHandle<"DocumentHandle">(591, 1);
    const huge = "a".repeat(SEARCH_MAX_TEXT_LENGTH + 1);
    parityPool.registerText(doc, 1, huge);
    const query: SearchQuery = { pattern: "a" };

    const fromWorker = await errorOf(
      () => parityPool.run({ kind: "search", doc, generation: 1, query }).done,
    );
    const fromShared = await errorOf(() => {
      scanText(huge, normalizeSearchQuery(query));
      return Promise.resolve();
    });

    expect(fromWorker).toEqual(fromShared);
    expect(fromWorker).toEqual({
      name: "SearchInputError",
      code: "search.tooLarge",
      message: `SearchInputError[search.tooLarge]: o texto excede o teto de ${SEARCH_MAX_TEXT_LENGTH} code units`,
    });
  });
});

// ── Paridade worker <-> sync: tokenização de sintaxe ───────────────────────────────────────────

/**
 * Gramática serializada mínima para teste de paridade: tokens `keyword`, `number` e `comment`
 * com os mesmos padrões de `scribe-demo.sublime-syntax`.
 */
const PARITY_GRAMMAR: SerializedGrammar = {
  logicalName: "test-parity",
  scope: "text.test",
  extensions: ["test"],
  contextScopes: { main: "text.test", "prototype": "text.test" },
  contexts: {
    main: {
      patterns: [
        { match: "\\bconst\\b", matchFlags: "dy", scope: "keyword.control.test" },
        { match: "\\bif\\b", matchFlags: "dy", scope: "keyword.control.test" },
        { match: "\\breturn\\b", matchFlags: "dy", scope: "keyword.control.test" },
        { match: "\\btrue\\b", matchFlags: "dy", scope: "constant.language.test" },
        { match: "\\bfalse\\b", matchFlags: "dy", scope: "constant.language.test" },
        { match: "\\bnull\\b", matchFlags: "dy", scope: "constant.language.test" },
        { match: "\\d+\\.?\\d*", matchFlags: "dy", scope: "constant.numeric.test" },
        { match: "//[^\\n]*", matchFlags: "dy", scope: "comment.line.double-slash.test" },
      ],
    },
    prototype: {
      patterns: [],
    },
  },
};

/** Constrói a mesma gramática em forma compilada para tokenização síncrona. */
function buildReferenceGrammar(): CompiledGrammar {
  const patterns: CompiledPattern[] = [
    { matcher: /\bconst\b/dy, scope: "keyword.control.test", captures: [], include: null, push: null, set: null, pop: false },
    { matcher: /\bif\b/dy, scope: "keyword.control.test", captures: [], include: null, push: null, set: null, pop: false },
    { matcher: /\breturn\b/dy, scope: "keyword.control.test", captures: [], include: null, push: null, set: null, pop: false },
    { matcher: /\btrue\b/dy, scope: "constant.language.test", captures: [], include: null, push: null, set: null, pop: false },
    { matcher: /\bfalse\b/dy, scope: "constant.language.test", captures: [], include: null, push: null, set: null, pop: false },
    { matcher: /\bnull\b/dy, scope: "constant.language.test", captures: [], include: null, push: null, set: null, pop: false },
    { matcher: /\d+\.?\d*/dy, scope: "constant.numeric.test", captures: [], include: null, push: null, set: null, pop: false },
    { matcher: /\/\/[^\n]*/dy, scope: "comment.line.double-slash.test", captures: [], include: null, push: null, set: null, pop: false },
  ];
  return {
    logicalName: "test-parity",
    name: "test-parity",
    scope: "text.test",
    fileExtensions: ["test"],
    contexts: new Map([["main", patterns], ["prototype", []]]),
    contextScopes: new Map([["main", "text.test"], ["prototype", "text.test"]]),
  };
}

/** Extrai `lineStarts` do array de linhas (texto completo sem `\n`). */
function lineStartsOf(lines: string[]): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    starts.push(starts[i]! + lines[i]!.length + 1);
  }
  return starts;
}

describe("paridade worker <-> sync: tokenização de sintaxe (syntaxTokens)", () => {
  let pool: TaskPoolImpl;
  let seq = 0;
  const reference = buildReferenceGrammar();

  beforeAll(() => {
    pool = new TaskPoolImpl({ availableParallelism: 4, maxBackgroundThreads: 2 });
  });

  afterAll(async () => {
    await pool.shutdown();
  });

  /** Roda tokenização síncrona (referência) e via worker e compara. */
  async function assertParity(
    text: string,
    first: number,
    count: number,
  ): Promise<void> {
    seq += 1;
    const doc = makeHandle<"DocumentHandle">(600, seq);
    const lines = text.split("\n");
    const starts = lineStartsOf(lines);

    // Tokenização síncrona de referência
    const refLines: { line: number; spans: readonly import("../../shared").HighlightSpan[] }[] = [];
    let refState: unknown = undefined;
    for (let i = first; i < first + count; i++) {
      const line = lines[i] ?? "";
      const tokenized = tokenizeCompiledLine(reference, line, refState);
      refLines.push({ line: i, spans: tokenized.spans });
      refState = tokenized.state;
    }

    // Tokenização via worker
    pool.registerText(doc, seq, text);
    const fromWorker: DocumentHighlight = await pool.run({
      kind: "syntaxTokens",
      doc,
      generation: seq,
      first,
      count,
      text,
      lineStarts: starts,
      states: [],
      grammar: PARITY_GRAMMAR,
    }).done;

    expect(fromWorker.revision).toBe(seq);
    expect(fromWorker.first).toBe(first);
    expect(fromWorker.lines.map((l) => ({ line: l.line, spans: l.spans }))).toEqual(refLines);
    expect(fromWorker.truncated).toBe(false);
  }

  it("tokeniza palavra-chave (keyword) em worker idêntico ao sync", async () => {
    await assertParity("const x = 1;\n", 0, 1);
  });

  it("tokeniza múltiplas linhas com estado incremental", async () => {
    await assertParity("const x = 1;\n// comentário\nreturn true;\n", 0, 3);
  });

  it("tokeniza a partir de um offset (first>0) com estado inicial", async () => {
    await assertParity("a\nb\nconst x = 42;\n// fim\n", 2, 2);
  });

  it("tokeniza range no meio do documento", async () => {
    await assertParity("linha0\nlinha1\nconst z = false;\n// fim\n", 1, 2);
  });

  it("documento sem matches devolve spans vazios", async () => {
    await assertParity("abc def\n123\nxyz\n", 0, 2);
  });
});
