import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CancellationError,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_PATTERN_LENGTH,
  SEARCH_MAX_TEXT_LENGTH,
  makeHandle,
  normalizeSearchQuery,
  scanText,
} from "../../shared";
import type { SearchQuery } from "../../shared";
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
