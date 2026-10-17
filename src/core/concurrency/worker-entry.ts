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
      return { id: request.id, ok: false, error: { message: error.message, stack: error.stack } };
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
