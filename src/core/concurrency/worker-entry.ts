/**
 * Scribe — runtime do worker de tarefas (`worker_threads.parentPort`).
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md` (DEC-CON-2/3/4/8/11/12).
 *
 * **Escolha nossa (não observada no alvo):** o alvo compartilhava o mesmo espaço de
 * endereço (`.bss`), então o worker enxergava o buffer compartilhado direto. Aqui **não**
 * existe memória de objeto compartilhada (DEC-CON-11): o worker **não** tem o store; o pool
 * entrega o texto por mensagem de controle `{ kind: "text.register", doc, generation, text }`
 * e o worker devolve `LineScanResult`/`IndexResult` **carregando a `generation` recebida** —
 * o chamador descarta resultado de geração vencida (DEC-CON-8).
 *
 * Este arquivo é transpilado isolado e executado por `worker_threads` (`eval`/arquivo). Por
 * isso ele **só** importa `node:*` em runtime e usa `import type` para os contratos de
 * `../../shared` (apagados na transpilação). Não adicione import de valor do projeto aqui.
 */
import { open, readFile, writeFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import type {
  DocumentHandle,
  IndexResult,
  LineScanResult,
  SearchQuery,
  SearchResult,
  TaskResultMap,
  TaskKind,
  WorkerRequest,
  WorkerResponse,
} from "../../shared";

/** Registro de texto por documento — a "cópia" que substitui o buffer compartilhado do alvo. */
export interface TextRegisterMessage {
  readonly kind: "text.register";
  readonly doc: DocumentHandle;
  readonly generation: number;
  readonly text: string;
}

/** Cancelamento cooperativo (DEC-CON-4): o worker marca o `id` e não responde OK. */
export interface CancelMessage {
  readonly kind: "cancel";
  readonly id: number;
  readonly reason: string | undefined;
}

/** Mensagens que o pool envia ao worker (união discriminada por `kind`). */
export type WorkerInbound = WorkerRequest | TextRegisterMessage | CancelMessage;

/** Handshake: o worker anuncia que subiu (nome vem de `workerData` — DEC-CON-10). */
export interface ReadyMessage {
  readonly kind: "ready";
  readonly name: string;
  readonly lane: string;
}

/** Mensagens que o worker devolve ao pool. */
export type WorkerOutbound = WorkerResponse | ReadyMessage;

/** Texto registrado no worker para um handle (o worker **não** tem o registry). */
export interface RegisteredText {
  readonly generation: number;
  readonly text: string;
}

/** Estado interno do worker; texto por handle (o worker **não** tem o registry). */
export interface WorkerRuntime {
  handleMessage(message: WorkerInbound): Promise<void>;
}

function toErrorLocal(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}

function cancelledResponse(id: number, reason: string | undefined): WorkerResponse {
  return {
    id,
    ok: false,
    error: { message: `cancelado${reason ? `: ${reason}` : ""}`, stack: undefined },
  };
}

/**
 * Cria o runtime. `reply` publica a resposta no port; `counterCell` é o índice do contador
 * compartilhado que o worker incrementa ao concluir (`POOL_COUNTERS.tasksExecuted`).
 */
export function createWorkerRuntime(
  reply: (message: WorkerOutbound) => void,
  counterCell: number,
): WorkerRuntime {
  const texts = new Map<DocumentHandle, RegisteredText>();
  const cancelled = new Set<number>();

  const runRequest = async (request: WorkerRequest): Promise<WorkerResponse> => {
    try {
      const value = await executeTask(request, texts);
      const counters = request.counters;
      if (counters) {
        Atomics.add(counters, counterCell, 1);
        Atomics.notify(counters, counterCell);
      }
      return { id: request.id, ok: true, value };
    } catch (err) {
      const error = toErrorLocal(err);
      // O structured-clone não transporta classes: mandamos `name`/`code` para o pool reidratar
      // um erro tipado (ex.: `SearchInputError`) — ver `TaskError` em `concurrency-contract.ts`.
      const rawCode = (err as { code?: unknown }).code;
      const wire: WorkerResponse["error"] =
        typeof rawCode === "string"
          ? { message: error.message, stack: error.stack, name: error.name, code: rawCode }
          : { message: error.message, stack: error.stack, name: error.name };
      return { id: request.id, ok: false, error: wire };
    }
  };

  return {
    async handleMessage(message: WorkerInbound): Promise<void> {
      if (message.kind === "text.register") {
        texts.set(message.doc, { generation: message.generation, text: message.text });
        return;
      }
      if (message.kind === "cancel") {
        cancelled.add(message.id);
        return;
      }
      if (cancelled.has(message.id)) {
        cancelled.delete(message.id);
        reply(cancelledResponse(message.id, undefined));
        return;
      }
      const response = await runRequest(message);
      if (cancelled.has(message.id)) {
        cancelled.delete(message.id);
        reply(cancelledResponse(message.id, "cancelado durante a execução"));
        return;
      }
      reply(response);
    },
  };
}

async function executeTask(
  request: WorkerRequest,
  texts: Map<DocumentHandle, RegisteredText>,
): Promise<TaskResultMap[TaskKind]> {
  const payload = request.payload;
  switch (payload.kind) {
    case "readFile": {
      const range = payload.range;
      if (range) {
        const handle = await open(payload.path, "r");
        try {
          const buffer = Buffer.alloc(range.length);
          await handle.read(buffer, 0, range.length, range.offset);
          return buffer.toString("utf8");
        } finally {
          await handle.close();
        }
      }
      return await readFile(payload.path, "utf8");
    }
    case "writeFile": {
      await writeFile(payload.path, new Uint8Array(payload.data));
      return undefined;
    }
    case "scanLines":
      return scanLines(payload.doc, payload.generation, payload.upto, texts);
    case "index":
      return indexDocument(payload.doc, payload.generation, texts);
    case "search":
      return searchDocument(payload.doc, payload.generation, payload.query, texts);
  }
}

function lookupText(
  doc: DocumentHandle,
  generation: number,
  texts: Map<DocumentHandle, RegisteredText>,
): string {
  const registered = texts.get(doc);
  if (!registered) {
    throw new Error(`task: nenhum texto registrado para doc ${doc} (envie "text.register")`);
  }
  if (registered.generation !== generation) {
    throw new Error(
      `task: geração divergente (registrada ${registered.generation}, pedida ${generation})`,
    );
  }
  return registered.text;
}

function scanLines(
  doc: DocumentHandle,
  generation: number,
  upto: number,
  texts: Map<DocumentHandle, RegisteredText>,
): LineScanResult {
  const text = lookupText(doc, generation, texts);
  const limit = upto > 0 ? Math.min(upto, text.length) : text.length;
  const starts: number[] = [0];
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return {
    doc,
    generation,
    lineCount: starts.length,
    lineStarts: Uint32Array.from(starts),
  };
}

function indexDocument(
  doc: DocumentHandle,
  generation: number,
  texts: Map<DocumentHandle, RegisteredText>,
): IndexResult {
  const text = lookupText(doc, generation, texts);
  const started = performance.now();
  let symbolCount = 0;
  const identifiers = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  while (identifiers.exec(text) !== null) symbolCount++;
  return { doc, generation, symbolCount, durationMs: performance.now() - started };
}

// ---- busca/substituição (self-contained) ---------------------------------------------------
//
// **Duplicação deliberada e temporária.** O worker roda por `eval`/arquivo e o `require` do
// caminho `eval` tem base no cwd: importar **valores** de `../../shared` não resolve ali (só
// `import type` cruza a fronteira), então a varredura é replicada localmente. Isto é o **caminho de
// produção**, não uma cópia de teste. A paridade com `src/shared/search-contract.ts` (a
// implementação canônica, testada em `search-contract.test.ts`) é travada pela **tabela
// discriminante** em `src/core/concurrency/pool.test.ts:422` (describe "paridade worker <-> shared
// (tabela discriminante, worker real)"), que roda contra este worker de verdade.
//
// **Correção definitiva (follow-up, registrado no BACKLOG):** bundlear este worker no build (como
// `renderer`/`preload`) e importar o contrato do shared — aí a duplicata some. Até lá, qualquer
// mudança de semântica em `normalizeSearchQuery`/`scanText` **tem de** ser espelhada aqui.
//
// Espelha `normalizeSearchQuery` + `scanText` — mesma semântica de unidades: UTF-16 code units,
// `line`/`column` 0-based.

const SEARCH_DEFAULT_MAX_MATCHES = 2000;
const SEARCH_MAX_MATCHES = 20000;
const SEARCH_MAX_PATTERN_LENGTH = 512;
const SEARCH_MAX_TEXT_LENGTH = 64 * 1024 * 1024;

/** Erro de entrada da busca com o **mesmo** `name`/`code` do `SearchInputError` compartilhado. */
class LocalSearchInputError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`SearchInputError[${code}]: ${detail}`);
    this.name = "SearchInputError";
    this.code = code;
  }
}

interface LocalNormalized {
  readonly regex: RegExp;
  readonly maxMatches: number;
}

function escapeRegExpLocal(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSearchQueryLocal(query: SearchQuery): LocalNormalized {
  const pattern = query.pattern;
  if (pattern.length === 0) {
    throw new LocalSearchInputError("search.emptyPattern", "o padrão de busca não pode ser vazio");
  }
  if (pattern.length > SEARCH_MAX_PATTERN_LENGTH) {
    throw new LocalSearchInputError(
      "search.pattern",
      `o padrão excede o teto de ${SEARCH_MAX_PATTERN_LENGTH} code units`,
    );
  }
  const body = query.regex === true ? pattern : escapeRegExpLocal(pattern);
  const source = query.wholeWord === true ? `\\b(?:${body})\\b` : body;
  const flags = query.caseSensitive === true ? "g" : "gi";
  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LocalSearchInputError("search.pattern", `expressão regular inválida: ${detail}`);
  }
  const requested = query.maxMatches ?? SEARCH_DEFAULT_MAX_MATCHES;
  // Espelha `normalizeSearchQuery` do shared: não-finito (`NaN`/`Infinity`) cai no default — com
  // `Math.floor(NaN)` o cap viraria `NaN` e o truncamento nunca dispararia. `0` vira 1.
  const finite = Number.isFinite(requested) ? requested : SEARCH_DEFAULT_MAX_MATCHES;
  const maxMatches = Math.max(1, Math.min(SEARCH_MAX_MATCHES, Math.floor(finite)));
  return { regex, maxMatches };
}

function scanTextLocal(text: string, normalized: LocalNormalized): SearchResult {
  if (text.length > SEARCH_MAX_TEXT_LENGTH) {
    throw new LocalSearchInputError(
      "search.tooLarge",
      `o texto excede o teto de ${SEARCH_MAX_TEXT_LENGTH} code units`,
    );
  }
  const { regex, maxMatches } = normalized;
  regex.lastIndex = 0;

  const collected: { index: number; length: number; line: number; column: number }[] = [];
  let truncated = false;
  let scannedLength = text.length;
  let newlineScan = 0;
  let line = 0;
  let lineStart = 0;

  for (;;) {
    const match = regex.exec(text);
    if (match === null) break;
    const length = match[0].length;
    if (length === 0) {
      if (regex.lastIndex <= match.index) regex.lastIndex = match.index + 1;
      continue;
    }
    if (collected.length >= maxMatches) {
      truncated = true;
      scannedLength = match.index;
      break;
    }
    while (newlineScan < match.index) {
      if (text.charCodeAt(newlineScan) === 10) {
        line += 1;
        lineStart = newlineScan + 1;
      }
      newlineScan += 1;
    }
    collected.push({ index: match.index, length, line, column: match.index - lineStart });
  }

  return { matches: collected, truncated, scannedLength };
}

function searchDocument(
  doc: DocumentHandle,
  generation: number,
  query: SearchQuery,
  texts: Map<DocumentHandle, RegisteredText>,
): SearchResult {
  const text = lookupText(doc, generation, texts);
  return scanTextLocal(text, normalizeSearchQueryLocal(query));
}

interface WorkerDataShape {
  readonly name: string;
  readonly lane: string;
  readonly counterCell: number;
}

function readWorkerData(): WorkerDataShape {
  const data = workerData as Partial<WorkerDataShape> | undefined;
  return {
    name: typeof data?.name === "string" ? data.name : "scribe-worker",
    lane: typeof data?.lane === "string" ? data.lane : "io",
    counterCell:
      typeof data?.counterCell === "number" && Number.isInteger(data.counterCell) && data.counterCell >= 0
        ? data.counterCell
        : 0,
  };
}

/** Liga o runtime ao `parentPort` (no-op quando importado fora de um worker — ex.: testes). */
export function attachWorkerRuntime(): void {
  const port = parentPort;
  if (!port) return;
  const meta = readWorkerData();
  const runtime = createWorkerRuntime((message) => port.postMessage(message), meta.counterCell);
  port.on("message", (message: unknown) => {
    void runtime.handleMessage(message as WorkerInbound);
  });
  port.postMessage({ kind: "ready", name: meta.name, lane: meta.lane } satisfies ReadyMessage);
}

attachWorkerRuntime();
