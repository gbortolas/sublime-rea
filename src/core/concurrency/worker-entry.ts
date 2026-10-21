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
 * Este arquivo é bundleado (esbuild) e executado por `worker_threads`. Importa valor do shared
 * porque o bundler resolve tudo numa única saída CJS.
 */
import { open, readFile, writeFile, rename, rm, stat, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type {
  DocumentHandle,
  DocumentHighlight,
  HighlightLine,
  HighlightSpan,
  IndexResult,
  LineScanResult,
  SerializedGrammar,
  Task,
  TaskResultMap,
  TaskKind,
  WorkerRequest,
  WorkerResponse,
} from "../../shared";
import { normalizeSearchQuery, scanText } from "../../shared/search-contract";
import { tokenizeCompiledLine } from "../syntax/tokenizer";
import type { CompiledGrammar, CompiledPattern, CompiledCapture } from "../syntax/tokenizer";

// ── SerializedGrammar → CompiledGrammar (deserialização no worker) ───────────────────────────

function deserializePattern(p: import("../../shared").SerializedPattern): CompiledPattern {
  const matcher = p.match !== undefined && p.matchFlags !== undefined
    ? new RegExp(p.match, p.matchFlags)
    : null;
  const scope = p.scope ?? null;
  const captures = deserializeCaptures(p.captures);
  const include = p.include ?? null;
  const push = p.push !== undefined && p.push.length > 0 ? p.push[0]! : null;
  const set = p.set ?? null;
  const pop = p.pop ?? false;
  return { matcher, scope, captures, include, push, set, pop };
}

function deserializeCaptures(
  captures: Record<string, { readonly scope?: string }> | undefined,
): CompiledCapture[] {
  if (captures === undefined) return [];
  const result: CompiledCapture[] = [];
  for (const [key, { scope }] of Object.entries(captures)) {
    if (scope === undefined) continue;
    if (/^\d+$/.test(key)) {
      result.push({ group: Number.parseInt(key, 10), name: null, scope });
    } else {
      result.push({ group: -1, name: key, scope });
    }
  }
  return result;
}

function deserializeGrammar(serialized: SerializedGrammar): CompiledGrammar {
  const contexts = new Map<string, readonly CompiledPattern[]>();
  for (const [name, ctx] of Object.entries(serialized.contexts)) {
    contexts.set(name, ctx.patterns.map(deserializePattern));
  }
  const contextScopes = new Map(Object.entries(serialized.contextScopes));
  return {
    logicalName: serialized.logicalName,
    name: serialized.logicalName,
    scope: serialized.scope,
    fileExtensions: [...serialized.extensions],
    contexts,
    contextScopes,
  };
}

// ── Tokenização de sintaxe no worker ─────────────────────────────────────────────────────────

/**
 * Tokeniza `count` linhas a partir de `first` no worker. Aplica deadline a cada 50 linhas:
 * checa o contador compartilhado; se > 0, retorna com `truncated: true` (o chamador retenta
 * no próximo frame).
 */
function tokenizeSyntaxTask(
  payload: Task<"syntaxTokens">,
  texts: Map<DocumentHandle, RegisteredText>,
  counters: Int32Array | undefined,
): DocumentHighlight {
  // Valida a geração do texto registrado (defesa em profundidade — DEC-CON-8).
  lookupText(payload.doc, payload.generation, texts);
  const grammar = deserializeGrammar(payload.grammar);
  const { first, count, lineStarts, text } = payload;

  const lines: HighlightLine[] = [];
  const resultStates: (string | null)[] = [];
  const deadlineIndex = 0; // POOL_COUNTERS.tasksExecuted — ver `counters.ts`.

  // Estado inicial: se `first > 0`, o estado da linha anterior veio serializado.
  let previousState: unknown;
  if (first > 0) {
    const prevIdx = first - 1;
    const prevState = prevIdx < payload.states.length ? payload.states[prevIdx] : null;
    previousState = prevState !== undefined && prevState !== null ? { stack: prevState.split(",") } : undefined;
  }

  for (let i = 0; i < count; i++) {
    const lineIndex = first + i;
    const start = lineStarts[lineIndex];
    // Se não for a última linha, o `-1` remove o `\n` do final. Última linha não tem `\n`.
    const endOffset = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1]! - 1 : text.length;
    const lineText = text.slice(start, endOffset);

    const tokenized = tokenizeCompiledLine(grammar, lineText, previousState);

    const spans: HighlightSpan[] = tokenized.spans.map((s) => ({
      start: s.start,
      end: s.end,
      scope: s.scope,
    }));
    lines.push({ line: lineIndex, spans });

    const stateObj = tokenized.state as { stack: string[] } | undefined;
    const serializedState = stateObj !== undefined ? stateObj.stack.join(",") : null;
    resultStates.push(serializedState);

    // Atualiza previousState para a próxima linha
    previousState = tokenized.state;

    // Deadline: a cada 50 linhas, checa se o contador foi incrementado (sinal de cancelamento).
    if ((i + 1) % 50 === 0 && counters !== undefined) {
      if (Atomics.load(counters, deadlineIndex) > 0) {
        return {
          revision: payload.generation,
          first: payload.first,
          lines,
          truncated: true,
          states: resultStates,
        };
      }
    }
  }

  return {
    revision: payload.generation,
    first: payload.first,
    lines,
    truncated: false,
    states: resultStates,
  };
}
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

/**
 * Rejeita **arquivos especiais** (FIFO, device, socket, diretório).
 *
 * Ler um FIFO **bloqueia para sempre** (sem escritor) ⇒ o worker fica preso e a task
 * nunca resolve ⇒ a leitura pelo IPC **nunca responde** (achado MÉDIO).
 */
async function assertRegularFile(path: string): Promise<void> {
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new Error(`task: "${path}" não é um arquivo regular (FIFO/device/diretório)`);
  }
}

/** Modo (permissões) do arquivo existente — `undefined` se ele ainda não existe. */
async function fileMode(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path);
    return stats.mode & 0o777;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Ainda não existe (primeiro save) ⇒ o modo default do SO vale.
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

async function executeTask(
  request: WorkerRequest,
  texts: Map<DocumentHandle, RegisteredText>,
): Promise<TaskResultMap[TaskKind]> {
  const payload = request.payload;
  switch (payload.kind) {
    case "readFile": {
      const range = payload.range;
      await assertRegularFile(payload.path);
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
      // Escrita atômica: tmp + `rename` **no mesmo diretório do destino**.
      //
      // **Achado ALTO (EXDEV):** o tmp vivia em `os.tmpdir()` ⇒ o `rename` cruzava
      // filesystems (`/tmp` → `$HOME`) ⇒ `EXDEV` ⇒ **o arquivo não era salvo** (o
      // `document.save` devolvia `Scribe IPC[EXDEV]: cross-device link not permitted`).
      // Com o tmp no diretório do destino, o `rename` é **local** (mesmo device) e a
      // escrita continua atômica.
      const data = new Uint8Array(payload.data);
      const target = payload.path;
      const dir = dirname(target);
      const tmpPath = join(dir, `.${basename(target)}.scribe-${process.pid}-${randomBytes(4).toString("hex")}`);
      try {
        const mode = await fileMode(target);
        await writeFile(tmpPath, data, mode !== undefined ? { mode } : {});
        if (mode !== undefined) {
          // O `mode` do `writeFile` é **mascarado pelo umask** ⇒ `chmod` para o modo exato
          // (um script executável continua executável depois do save).
          await chmod(tmpPath, mode);
        }
        await rename(tmpPath, target);
      } catch (error) {
        // Ainda assim deu EXDEV (ou o tmp não pôde ser criado) ⇒ grava **direto** no
        // destino: perde a atomicidade, mas **salva o arquivo**.
        console.warn("Scribe: escrita atômica falhou, gravando direto no destino:", error);
        await rm(tmpPath, { force: true }).catch((rmError: unknown) => {
          console.warn("Scribe: não foi possível remover o tmp de escrita:", rmError);
        });
        await writeFile(target, data);
      }
      return undefined;
    }
    case "scanLines":
      return scanLines(payload.doc, payload.generation, payload.upto, texts);
    case "index":
      return indexDocument(payload.doc, payload.generation, texts);
    case "search": {
      const text = lookupText(payload.doc, payload.generation, texts);
      return scanText(text, normalizeSearchQuery(payload.query));
    }
    case "syntaxTokens":
      return tokenizeSyntaxTask(payload, texts, request.counters);
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
