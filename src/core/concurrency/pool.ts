/**
 * Scribe — `TaskPool`: pools de `worker_threads` (DEC-CON-2/3/4/9).
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md`.
 *
 * Topologia replicada do alvo:
 * - lane `io` — pool de **N fixo** (`io_workers`, default **2**) `CON-E9`/`REN-E26`;
 * - lane `fileRead` — **bounded on-demand (≤2)**, worker reciclado por *idle* `CON-E10`;
 * - lane `index` — **cold-start single**, sobe só quando há tarefa `CON-U6`;
 * - lane `grep` — **cold-start single**, isolada da `index` (o grep da workspace **não**
 *   pode atrasar o find bar) — escolhemos nós (o alvo não expõe a busca em arquivos);
 * - **teto global** = `max(1, min(setting, availableParallelism() − 1))` — nunca 0 (DEC-CON-9).
 *
 * **Teto duro de execução** (`run(..., { timeoutMs })`): o relógio cobre a task **inteira** —
 * a espera na **fila** conta e a execução conta. Ao estourar, o pool **mata o worker** (o
 * `RegExp` do JS não é interrompível — nem por `AbortSignal`) e rejeita a task com
 * {@link TaskTimeoutError} (`code === "task.timeout"`); a lane **se recupera** (a próxima
 * task sobe um worker novo). Se a task ainda estava **na fila** (nunca foi atribuída a um
 * worker), **nenhum** worker é morto (não há worker rodando a task): ela sai da fila e é
 * rejeitada com o mesmo erro — senão ficaria esperando para sempre.
 *
 * **Preempção de lane** (a task de **fundo** pode ser morta por uma de **primeiro plano**):
 *
 * - **Prioridade de lane**: `io`, `index` e `fileRead` são **primeiro plano** (o **realce de
 *   sintaxe** e o **salvar** moram ali — o realce está no **caminho da digitação**); a lane
 *   `grep` é **fundo** (a busca em todos os arquivos da workspace).
 * - Task de **fundo** ⇒ pode preemptar um slot **ocioso** de qualquer lane (o custo é um
 *   *cold start* depois) — mas **nunca** mata uma task em andamento.
 * - Task de **primeiro plano** sem slot ⇒ (a) preempta um slot **ocioso**; se não houver,
 *   (b) **mata** a task de **fundo** em andamento (marcada `preemptible`) ⇒ ela é rejeitada
 *   com {@link TaskPreemptedError} (`code === "task.preempted"`) e o slot é liberado **na
 *   hora** ⇒ o primeiro plano **não espera** pelo fundo (só o instante de matar o worker).
 * - `preemptible` tem **default `false`** ⇒, por padrão, **nada** é morto por preempção
 *   (só a task de **fundo** — o `grep` — marca isto).
 *
 * **Cancelamento** (`handle.cancel()`): o cancel de uma task **em execução** é
 * **cooperativo** — o pool avisa o worker (`{ kind: "cancel" }`) e o `AbortController` da task
 * aborta **entre arquivos**. Mas um `RegExp` **ininterruptível** (o motor do JS não é
 * interrompível — nem por `AbortSignal`) **nunca** responde: o cancel não pode esperar por
 * ele, senão a **lane morre** (o worker fica em 100 % de CPU para sempre e nenhuma outra
 * busca da lane roda). Por isso o pool **não desarma o timer**: ele o **re-arma com a graça**
 * ({@link CANCEL_KILL_GRACE_MS} = 2 s) ⇒ se o worker não responder nesse prazo, ele é
 * **matado** (`terminate` encerra a thread), o `busyCount` volta a zero e a lane **se
 * recupera** (a próxima task sobe um worker novo). O `timeoutMs` do chamador **não** é
 * desarmado pelo cancel — no cancel, o relógio passa a ser a graça (a última rede de
 * proteção contra o `RegExp` patológico continua valendo).
 *
 * ⚠️ **A graça do cancel NÃO é armada para quem escreve** (`kind: writeFile`): matar o worker
 * no meio da escrita deixa um `.scribe-*` órfão e, no *fallback* sem atomicidade, um
 * **alvo truncado** ⇒ **perda de dados**. A escrita é **atômica** (tmp + `rename`) e o worker
 * checa o abort **antes** do `rename` (o ponto sem volta) ⇒ ela **termina em paz** (o alvo
 * fica **íntegro**).
 *
 * Tarefas são **serializáveis** (nada de closure cruza a fronteira — DEC-CON-4/11); o worker
 * **não** tem o store: o texto vai por `text.register` e o resultado volta com a `generation`
 * recebida. O pool **descarta** resultado de geração vencida (`StaleGenerationError`, DEC-CON-8).
 *
 * **Escolhas nossas (não observadas no alvo):** workers sobem *lazy* até a capacidade da lane
 * (io residente; fileRead/index recicláveis); `writeFile` roda na lane `io` (só leitura usa
 * `fileRead`); o pool guarda o último texto registrado por doc para reenviar a workers novos.
 */

import { existsSync } from "node:fs";
import { availableParallelism as osAvailableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  CancellationError,
  Deferred,
  TaskError,
  TaskPreemptedError,
  TaskTimeoutError,
  toError,
} from "../../shared";
import type {
  DocumentHandle,
  PoolLane,
  Priority,
  Task,
  TaskHandle,
  TaskKind,
  TaskPool,
  TaskResultMap,
  WorkerRequest,
  WorkerResponse,
} from "../../shared";
import { createCounters, POOL_COUNTERS } from "./counters";
import type { SharedCounters } from "./counters";
import type {
  CancelMessage,
  ReadyMessage,
  RegisteredText,
  TextRegisterMessage,
  WorkerOutbound,
} from "./worker-entry";

/**
 * Graça do cancelamento: quanto tempo o worker tem para **responder** ao `cancel` antes de
 * ser **matado** (ms).
 *
 * O cancel é **cooperativo** (o abort chega no worker entre arquivos), mas um `RegExp`
 * patológico é **ininterruptível** ⇒ o worker pode nunca responder. Sem esta graça, a lane
 * ficaria **morta** (worker em 100 % de CPU para sempre, nenhuma outra busca roda).
 */
export const CANCEL_KILL_GRACE_MS = 2_000;

/** Erro alto: o pool foi descartado (DEC-TR-5). */
export class PoolShutdownError extends Error {
  constructor(message = "task pool foi encerrado") {
    super(message);
    this.name = "PoolShutdownError";
  }
}

/** Resultado de uma geração de documento que já foi substituída (DEC-CON-8). */
export class StaleGenerationError extends Error {
  readonly doc: DocumentHandle;
  readonly generation: number;
  readonly current: number;

  constructor(doc: DocumentHandle, generation: number, current: number) {
    super(`resultado obsoleto: doc ${doc} geração ${generation} < atual ${current}`);
    this.name = "StaleGenerationError";
    this.doc = doc;
    this.generation = generation;
    this.current = current;
  }
}

export interface TaskPoolOptions {
  /** Setting `io_workers` (default **2**, DEC-CON-2). */
  readonly ioWorkers?: number;
  /** Setting `index_workers`; a lane sobe cold-start quando > 0 (default **1**). */
  readonly indexWorkers?: number;
  /** Teto da lane `fileRead` (default **2**, DEC-CON-3). */
  readonly fileReadWorkers?: number;
  /**
   * Teto da lane `grep` (default **1**) — o **número de workers** da lane `grep`.
   *
   * A lane `grep` é **isolada** da lane `index` (que serve o find bar): um grep longo
   * **não** pode atrasar a busca interativa do documento aberto.
   *
   * ⚠️ Não há setting para isto (o alvo não expõe a busca em arquivos): o núcleo fixa
   * **1** (um grep por vez — a lane é de **fundo** e não pode competir com o realce).
   */
  readonly grepWorkers?: number;
  /** Setting global desconhecido do alvo; default = `availableParallelism() − 1` (`CON-U6`). */
  readonly maxBackgroundThreads?: number;
  /** Injeção de CPU para determinismo de teste. */
  readonly availableParallelism?: number;
  /** Tempo ocioso antes de reciclar worker de lane on-demand (default 1000 ms; ≤0 recicla já). */
  readonly idleTimeoutMs?: number;
}

interface Settler {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

interface WorkerSlot {
  readonly lane: PoolLane;
  readonly name: string;
  readonly worker: Worker;
  busy: boolean;
  current: number | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  terminating: boolean;
}

interface QueuedTask {
  readonly id: number;
  readonly kind: TaskKind;
  readonly lane: PoolLane;
  readonly priority: Priority;
  readonly seq: number;
  readonly task: Task;
  readonly deferred: Settler;
  /**
   * Teto **duro** de execução (ms) — `undefined` = sem teto.
   *
   * O relógio cobre a task **inteira**: a espera na **fila** conta e a execução conta.
   */
  readonly timeoutMs: number | undefined;
  /** O timer do teto (vivo desde o enqueue até o fim da task). */
  timer: NodeJS.Timeout | undefined;
  cancelled: boolean;
  /**
   * A task é de **fundo** e pode ser **morta** para servir uma task de **primeiro plano**
   * (preempção — o default é `false`: por padrão **nada** é morto).
   */
  readonly preemptible: boolean;
}

interface RunningTask {
  readonly queued: QueuedTask;
  readonly slot: WorkerSlot;
}

type WorkerLaunch =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "eval"; readonly code: string };

const LANE_PRIORITY: readonly Priority[] = ["input", "edit", "layout", "background"];

const ALL_LANES: readonly PoolLane[] = ["io", "index", "fileRead", "grep"];

/**
 * Lanes cujo worker é reciclado por *idle* (on-demand — DEC-CON-3/9).
 *
 * A lane `grep` entra aqui: ela é **cold-start** (o worker só sobe quando há grep) e é
 * reciclada pelo idle — um grep de 2 s não pode deixar um worker vivo ocioso.
 */
const LAZY_LANES: ReadonlySet<PoolLane> = new Set<PoolLane>(["fileRead", "index", "grep"]);

/**
 * Lanes de **primeiro plano** — as que não podem esperar pelo fundo.
 *
 * ⚠️ `io`, `index` e `fileRead` servem o **caminho da digitação**: o **realce de sintaxe**
 * (lane `index`), o **find bar** (lane `index`) e o **salvar** (lane `io`). A lane `grep`
 * (a busca em **todos os arquivos** da workspace) é de **fundo** ⇒ ela nunca segura o slot
 * de um realce nem de um save.
 */
const FOREGROUND_LANES: ReadonlySet<PoolLane> = new Set<PoolLane>(["io", "index", "fileRead"]);

/** A lane é de **primeiro plano** (não espera pelo fundo)? */
function isForegroundLane(lane: PoolLane): boolean {
  return FOREGROUND_LANES.has(lane);
}

function defaultLane(kind: TaskKind): PoolLane {
  switch (kind) {
    case "readFile":
      return "fileRead";
    case "writeFile":
      return "io";
    case "scanLines":
      return "io";
    case "index":
      return "index";
    case "search":
      // CPU em memória (varredura linear sobre o texto já registrado): lane `index` (DEC-CON-6).
      return "index";
    case "syntaxTokens":
      // Tokenização de sintaxe: CPU-bound, varredura de texto em worker → lane `index` (DEC-CON-6).
      return "index";
    case "grep":
      // Varredura da workspace (CPU-bound + I/O de leitura): lane **própria** — o grep não
      // pode competir com o find bar (lane `index`).
      return "grep";
  }
}

/**
 * Ordem da fila: **primeiro** a prioridade de **lane** (o primeiro plano não espera pelo
 * fundo), **depois** a prioridade de *marshalling* (`input` > `edit` > `background`) e,
 * por fim, a ordem de chegada (FIFO).
 */
function compareQueued(a: QueuedTask, b: QueuedTask): number {
  const laneDiff =
    (isForegroundLane(b.lane) ? 1 : 0) - (isForegroundLane(a.lane) ? 1 : 0);
  if (laneDiff !== 0) return laneDiff;
  const priorityDiff = LANE_PRIORITY.indexOf(a.priority) - LANE_PRIORITY.indexOf(b.priority);
  return priorityDiff !== 0 ? priorityDiff : a.seq - b.seq;
}

function isReady(message: WorkerOutbound): message is ReadyMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "kind" in message &&
    (message as { kind?: unknown }).kind === "ready"
  );
}

function describeReason(reason: unknown): string {
  if (reason === undefined || reason === null) return "cancelado";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

class PoolTaskHandle<T> implements TaskHandle<T> {
  readonly id: number;
  readonly kind: TaskKind;
  readonly done: Promise<T>;

  private readonly onCancel: (reason: string | undefined) => void;
  private cancelled = false;

  constructor(id: number, kind: TaskKind, done: Promise<T>, onCancel: (reason: string | undefined) => void) {
    this.id = id;
    this.kind = kind;
    this.done = done;
    this.onCancel = onCancel;
  }

  cancel(reason?: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onCancel(reason);
  }
}

export interface TaskRunOptions {
  readonly lane?: PoolLane;
  readonly priority?: Priority;
  readonly signal?: AbortSignal;
  /**
   * Teto **duro** de execução (ms) — o pool **mata** o worker que estourou e rejeita a task
   * com {@link TaskTimeoutError} (`code === "task.timeout"`).
   *
   * O relógio cobre a task **inteira**: a espera na **fila** conta e a execução conta. Sem
   * isso, uma task poderia ficar na fila **para sempre** (a lane `io` é residente e segura o
   * teto global do pool) — e o teto do `RegExp` patológico nunca dispararia.
   *
   * ⚠️ É o **único** jeito de parar um `RegExp` patológico: o motor do JS **não** é
   * interrompível (nem por `AbortSignal`) ⇒ a única saída é matar o worker.
   */
  readonly timeoutMs?: number;
  /**
   * A task é de **fundo** e pode ser **morta** para servir uma task de **primeiro plano**.
   *
   * ⚠️ Default `false`: por padrão **nada** é morto por preempção. Só a task de **fundo**
   * (o `grep` da workspace) marca isto — assim o **realce de sintaxe** e o **salvar**
   * (caminho da digitação) **matam** o grep em vez de ficar pendurados atrás dele.
   *
   * A task preemptada é rejeitada com {@link TaskPreemptedError} (`code === "task.preempted"`).
   */
  readonly preemptible?: boolean;
}

/**
 * Normaliza o teto de execução: `undefined`, não-finito ou `<= 0` ⇒ **sem teto**
 * (a task roda até o fim — o pool não mata worker nenhum).
 */
function normalizeTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return undefined;
  return timeoutMs > 0 ? timeoutMs : undefined;
}

export class TaskPoolImpl implements TaskPool {
  private readonly cap: number;
  private readonly desired: Record<PoolLane, number>;
  private readonly idleTimeoutMs: number;
  private readonly counters: SharedCounters;

  private readonly slots = new Set<WorkerSlot>();
  private readonly queue: QueuedTask[] = [];
  private readonly running = new Map<number, RunningTask>();
  private readonly busyCount: Record<PoolLane, number> = { io: 0, index: 0, fileRead: 0, grep: 0 };
  private readonly registered = new Map<DocumentHandle, RegisteredText>();
  private readonly latestGeneration = new Map<DocumentHandle, number>();

  private nextId = 1;
  private seq = 0;
  private workerSeq = 0;
  private disposed = false;
  private shutdownPromise: Promise<void> | undefined;
  private launch: WorkerLaunch | undefined;

  constructor(options: TaskPoolOptions = {}) {
    const available = options.availableParallelism ?? osAvailableParallelism();
    const limit = Math.max(1, available - 1);
    this.cap = Math.max(1, Math.min(options.maxBackgroundThreads ?? limit, limit));
    this.desired = {
      io: Math.min(options.ioWorkers ?? 2, this.cap),
      index: Math.min(options.indexWorkers ?? 1, this.cap),
      fileRead: Math.min(options.fileReadWorkers ?? 2, this.cap),
      grep: Math.min(options.grepWorkers ?? 1, this.cap),
    };
    this.idleTimeoutMs = options.idleTimeoutMs ?? 1000;
    this.counters = createCounters(POOL_COUNTERS.length);
  }

  get busy(): Readonly<Record<PoolLane, number>> {
    return {
      io: this.busyCount.io,
      index: this.busyCount.index,
      fileRead: this.busyCount.fileRead,
      grep: this.busyCount.grep,
    };
  }

  /** Teto global efetivo (≥ 1) — observabilidade da DEC-CON-9. */
  get maxWorkers(): number {
    return this.cap;
  }

  size(lane: PoolLane): number {
    return this.desired[lane];
  }

  /** Workers materializados agora na lane (para inspeção/teste). */
  workerCount(lane: PoolLane): number {
    let count = 0;
    for (const slot of this.slots) if (slot.lane === lane) count++;
    return count;
  }

  /** Tarefas executadas com sucesso (contador `SharedArrayBuffer`, DEC-CON-11). */
  get executedCount(): number {
    return this.counters.get(POOL_COUNTERS.tasksExecuted);
  }

  /**
   * Tarefas **canceladas** (contador `SharedArrayBuffer`, DEC-CON-11).
   *
   * Cada task cancelada conta **uma vez** — nem o cancel nem a subsequentemente matada
   * (a graça do cancel) podem contar a mesma task duas vezes. Uma task **preemptada**
   * (morta para servir o primeiro plano) também conta aqui.
   *
   * ⚠️ Não é um knob de produção: é a **observabilidade** do contador compartilhado
   * (DEC-CON-11) — os testes é que o consultam para provar que a task cancelada é contada
   * **uma vez só**.
   */
  get cancelledCount(): number {
    return this.counters.get(POOL_COUNTERS.tasksCancelled);
  }

  /**
   * Registra o texto do documento para as lanes de scan/index (o worker **não** tem o store).
   * Reenvia a todos os workers vivos e guarda para os que subirem depois (DEC-CON-8/12).
   */
  registerText(doc: DocumentHandle, generation: number, text: string): void {
    this.registered.set(doc, { generation, text });
    const latest = this.latestGeneration.get(doc);
    if (latest === undefined || generation >= latest) this.latestGeneration.set(doc, generation);
    const message: TextRegisterMessage = { kind: "text.register", doc, generation, text };
    for (const slot of this.slots) slot.worker.postMessage(message);
  }

  /** Esquece o texto de um doc (chamar ao fechar o documento). */
  unregisterText(doc: DocumentHandle): void {
    this.registered.delete(doc);
    this.latestGeneration.delete(doc);
  }

  /** Overload que infere o `kind` direto do literal (o resultado sai já estreitado). */
  run<T extends Task>(task: T, opts?: TaskRunOptions): TaskHandle<TaskResultMap[T["kind"]]>;
  /** Overload compatível com `TaskPool` (fronteira congelada em `shared`). */
  run<K extends TaskKind>(task: Task<K>, opts?: TaskRunOptions): TaskHandle<TaskResultMap[K]>;
  run(task: Task, opts?: TaskRunOptions): TaskHandle<TaskResultMap[TaskKind]> {
    const kind: TaskKind = task.kind;
    const lane = opts?.lane ?? defaultLane(kind);
    const priority = opts?.priority ?? "background";
    const deferred = new Deferred<TaskResultMap[TaskKind]>();
    const id = this.nextId++;
    const handle = new PoolTaskHandle<TaskResultMap[TaskKind]>(id, kind, deferred.promise, (reason) =>
      this.cancel(id, reason),
    );

    if (this.disposed) {
      deferred.reject(new PoolShutdownError());
      return handle;
    }

    const signal = opts?.signal;
    if (signal?.aborted) {
      deferred.reject(new CancellationError(describeReason(signal.reason)));
      return handle;
    }

    const queued: QueuedTask = {
      id,
      kind,
      lane,
      priority,
      seq: this.seq++,
      task,
      deferred,
      timeoutMs: normalizeTimeout(opts?.timeoutMs),
      timer: undefined,
      cancelled: false,
      preemptible: opts?.preemptible === true,
    };
    this.queue.push(queued);
    // O relógio do teto **cobre a task inteira**: a espera na fila conta (senão uma task
    // ficaria na fila para sempre) e a execução conta. O timer é armado **no enqueue**.
    this.armTimeout(queued);
    if (signal) {
      signal.addEventListener("abort", () => this.cancel(id, describeReason(signal.reason)), {
        once: true,
      });
    }
    this.pump();
    return handle;
  }

  async resize(lane: PoolLane, n: number): Promise<void> {
    if (this.disposed) return;
    const target = Math.max(0, Math.min(n, this.cap));
    this.desired[lane] = target;

    while (this.countLane(lane) < target && this.slots.size < this.cap) this.spawn(lane);

    for (const slot of [...this.slots]) {
      if (slot.lane !== lane) continue;
      if (this.countLane(lane) <= target) break;
      if (!slot.busy) this.terminateSlot(slot);
    }

    this.pump();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;

    const error = new PoolShutdownError();
    for (const queued of this.queue) {
      queued.cancelled = true;
      this.clearTaskTimeout(queued);
      queued.deferred.reject(error);
    }
    this.queue.length = 0;
    for (const task of this.running.values()) {
      this.clearTaskTimeout(task.queued);
      task.queued.deferred.reject(error);
    }
    this.running.clear();

    const terminations: Promise<number>[] = [];
    for (const slot of [...this.slots]) {
      this.clearIdle(slot);
      slot.terminating = true;
      this.slots.delete(slot);
      terminations.push(slot.worker.terminate());
    }
    this.busyCount.io = 0;
    this.busyCount.index = 0;
    this.busyCount.fileRead = 0;
    this.busyCount.grep = 0;

    this.shutdownPromise = Promise.all(terminations).then(() => undefined);
    return this.shutdownPromise;
  }

  // ---- interno --------------------------------------------------------------

  private cancel(id: number, reason: string | undefined): void {
    const running = this.running.get(id);
    if (running) {
      if (running.queued.cancelled) return;
      running.queued.cancelled = true;
      // ⚠️ O timer **não** é desarmado: o cancel é **cooperativo** e o worker pode estar
      // preso num `RegExp` **ininterruptível** (que nunca responde). O timer é **re-armado
      // com a graça** ⇒ se o worker não responder em `CANCEL_KILL_GRACE_MS`, ele é **matado**
      // (o `onTimeout` mata o worker em execução) ⇒ a lane **se recupera** e a próxima task
      // da lane roda. Sem isto, o cancel deixaria a lane **morta** para sempre.
      //
      // ⚠️ **Exceção: quem escreve** (`kind: writeFile`) — a graça **NÃO** é armada. Matar o
      // worker no meio da escrita deixa um `.scribe-*` órfão e, no *fallback* sem
      // atomicidade, um **alvo truncado** ⇒ **perda de dados**. A escrita é **atômica**
      // (tmp + `rename`) e o worker checa o abort **antes** do `rename` (o ponto sem volta)
      // ⇒ ela **termina em paz** e o alvo fica **íntegro**. O teto do **chamador** (se
      // houver) continua valendo — ele é a escolha de quem pediu a task.
      if (running.queued.kind !== "writeFile") {
        this.clearTaskTimeout(running.queued);
        this.armTimeout(running.queued, CANCEL_KILL_GRACE_MS);
      }
      this.counters.increment(POOL_COUNTERS.tasksCancelled);
      const message: CancelMessage = { kind: "cancel", id, reason };
      running.slot.worker.postMessage(message);
      running.queued.deferred.reject(new CancellationError(describeReason(reason)));
      return;
    }
    const index = this.queue.findIndex((queued) => queued.id === id);
    if (index < 0) return;
    const [queued] = this.queue.splice(index, 1);
    if (!queued) return;
    queued.cancelled = true;
    // Task **na fila**: não há worker rodando ⇒ basta **limpar** o timer (a task sai da fila).
    this.clearTaskTimeout(queued);
    this.counters.increment(POOL_COUNTERS.tasksCancelled);
    queued.deferred.reject(new CancellationError(describeReason(reason)));
  }

  private pump(): void {
    if (this.disposed) return;
    const ordered = [...this.queue].sort(compareQueued);
    this.queue.length = 0;
    for (const queued of ordered) {
      if (queued.cancelled) continue;
      const idle = this.findIdle(queued.lane);
      if (idle) {
        this.assign(idle, queued);
        continue;
      }
      if (this.canSpawn(queued.lane)) {
        this.assign(this.spawn(queued.lane), queued);
        continue;
      }
      // Sem worker ocioso na lane e **sem espaço no teto global**: preempta um slot ocioso
      // de outra lane (senão a task ficaria na fila para sempre).
      if (this.preemptIdleSlot(queued.lane) && this.canSpawn(queued.lane)) {
        this.assign(this.spawn(queued.lane), queued);
        continue;
      }
      // Task de **primeiro plano** ainda sem slot: **mata** a task de **fundo** em andamento
      // (a marcada `preemptible`) ⇒ o slot é liberado **na hora** (o primeiro plano não
      // espera pelo fundo — só o instante de matar o worker).
      if (
        isForegroundLane(queued.lane) &&
        this.countLane(queued.lane) < this.desired[queued.lane] &&
        this.killPreemptibleTask() &&
        this.canSpawn(queued.lane)
      ) {
        this.assign(this.spawn(queued.lane), queued);
        continue;
      }
      this.queue.push(queued);
    }
  }

  /**
   * Preempta um slot **ocioso** de outra lane para abrir espaço no teto global.
   *
   * Sem isto, uma task de uma lane **sem worker** ficaria na fila **para sempre** quando
   * outra lane (a `io`, **residente**) segura o teto global do pool.
   *
   * Só preempta slot **ocioso** (nenhuma task em andamento é morta) e só quando a lane pedida
   * **pode** ter worker (`countLane(lane) < desired[lane]`) — senão o espaço aberto seria
   * perdido (o worker novo ficaria ocioso).
   *
   * @returns `true` se um slot foi preemptado (espaço aberto no teto global).
   */
  private preemptIdleSlot(lane: PoolLane): boolean {
    if (this.countLane(lane) >= this.desired[lane]) return false;
    const victim = this.findPreemptableSlot(lane);
    if (!victim) return false;
    this.terminateSlot(victim);
    return true;
  }

  /**
   * Escolhe o slot ocioso a preemptar: **prioriza as lanes lazy** (`fileRead`/`index`/`grep` —
   * o worker delas é reciclado por idle, então o custo do preempt é ~zero) e só depois a lane
   * **residente** `io` (terminá-la custa um **cold start** na próxima task `io`).
   *
   * ⚠️ Slot **ocupado** nunca é preemptado (a task em andamento não pode ser morta): sem slot
   * ocioso, a task **fica na fila** — e o `timeoutMs` (que cobre a fila) a estoura.
   */
  private findPreemptableSlot(lane: PoolLane): WorkerSlot | undefined {
    for (const candidate of LAZY_LANES) {
      if (candidate === lane) continue;
      for (const slot of this.slots) {
        if (slot.lane === candidate && !slot.busy && !slot.terminating) return slot;
      }
    }
    for (const slot of this.slots) {
      if (slot.lane === lane || slot.busy || slot.terminating) continue;
      return slot;
    }
    return undefined;
  }

  /**
   * **Mata** a task de **fundo** em andamento (a marcada `preemptible`) para liberar o slot
   * do pool para uma task de **primeiro plano**.
   *
   * A task de fundo é rejeitada com {@link TaskPreemptedError} (`code === "task.preempted"`),
   * o `busyCount` da lane volta, o contador de canceladas conta **uma vez** e o worker é
   * **matado** (`terminate` encerra a thread) ⇒ a lane **se recupera** na hora.
   *
   * ⚠️ Só mata task **marcada** `preemptible` (o default é `false` ⇒, por padrão, **nada**
   * é morto por preempção).
   *
   * @returns `true` se uma task de fundo foi morta (o slot foi liberado).
   */
  private killPreemptibleTask(): boolean {
    for (const running of this.running.values()) {
      if (!running.queued.preemptible) continue;
      const { queued, slot } = running;
      this.running.delete(queued.id);
      this.clearTaskTimeout(queued);
      queued.cancelled = true;
      this.busyCount[slot.lane] = Math.max(0, this.busyCount[slot.lane] - 1);
      this.counters.increment(POOL_COUNTERS.tasksCancelled);
      // O worker é **matado** (a task de fundo não pode segurar o slot do primeiro plano).
      this.terminateSlot(slot);
      queued.deferred.reject(new TaskPreemptedError());
      return true;
    }
    return false;
  }

  private assign(slot: WorkerSlot, queued: QueuedTask): void {
    slot.busy = true;
    slot.current = queued.id;
    this.clearIdle(slot);
    this.busyCount[queued.lane] += 1;
    this.running.set(queued.id, { queued, slot });
    // O relógio do teto já está armado (no enqueue): a fila **conta** e a execução conta.
    const request: WorkerRequest = {
      id: queued.id,
      kind: queued.kind,
      payload: queued.task,
      counters: this.counters.cells,
    };
    slot.worker.postMessage(request);
  }

  /**
   * Arma o **teto duro** de execução (o relógio começa no **enqueue** — a fila conta).
   *
   * Quando estoura, o pool **mata o worker**: o `RegExp` do JS não é interrompível (nem por
   * `AbortSignal`) ⇒ a única saída é encerrar a thread.
   *
   * @param overrideMs prazo **efetivo** do timer (ms) — usado no **cancel**, onde o prazo
   *   vira a graça ({@link CANCEL_KILL_GRACE_MS}) em vez do `timeoutMs` do chamador.
   */
  private armTimeout(queued: QueuedTask, overrideMs?: number): void {
    const timeoutMs = overrideMs ?? queued.timeoutMs;
    if (timeoutMs === undefined) return;
    const timer = setTimeout(() => {
      this.onTimeout(queued.id, timeoutMs);
    }, timeoutMs);
    // O pool não pode segurar o event loop (o timer é do pool, não da task).
    timer.unref();
    queued.timer = timer;
  }

  /** Limpa o timer do teto (task concluída, cancelada ou encerrada). */
  private clearTaskTimeout(queued: QueuedTask): void {
    if (queued.timer === undefined) return;
    clearTimeout(queued.timer);
    queued.timer = undefined;
  }

  /**
   * O teto estourou. Duas situações (o relógio cobre a task **inteira**):
   *
   * - task **em execução** ⇒ o pool **mata o worker** (o `RegExp` patológico não pode ser
   *   interrompido) e rejeita a task com {@link TaskTimeoutError}; a lane **se recupera** (a
   *   próxima task sobe um worker novo);
   * - task **ainda na fila** (nunca foi atribuída — o teto global do pool estava tomado por
   *   outra lane) ⇒ **nenhum worker é morto** (não há worker rodando a task): a task sai da
   *   fila e é rejeitada com o mesmo {@link TaskTimeoutError} — senão ficaria na fila para
   *   sempre.
   *
   * ⚠️ `deadlineMs` é o prazo **efetivo** do timer (o `timeoutMs` do chamador — ou a
   * **graça** do cancel, {@link CANCEL_KILL_GRACE_MS}). Ele **não** vem de `queued.timeoutMs`
   * porque uma task **sem** `timeoutMs` também tem timer (o da graça).
   *
   * Task **já cancelada** (`wasCancelled`): o worker não respondeu ao cancel ⇒ ele é morto
   * assim mesmo (a lane se recupera), mas o `tasksCancelled` **não** conta duas vezes e o
   * motivo já entregue ({@link CancellationError}) **não** é substituído por um
   * {@link TaskTimeoutError}.
   */
  private onTimeout(id: number, deadlineMs: number): void {
    const running = this.running.get(id);
    if (!running) {
      this.timeoutQueued(id, deadlineMs);
      return;
    }
    const { queued, slot } = running;
    const wasCancelled = queued.cancelled;
    this.running.delete(id);
    this.clearTaskTimeout(queued);
    queued.cancelled = true;
    this.busyCount[slot.lane] = Math.max(0, this.busyCount[slot.lane] - 1);
    if (!wasCancelled) {
      this.counters.increment(POOL_COUNTERS.tasksCancelled);
    }
    // O worker é **matado** (`terminating` ⇒ o `exit` dele não rejeita a task de novo).
    this.terminateSlot(slot);
    if (!wasCancelled) {
      queued.deferred.reject(new TaskTimeoutError(deadlineMs));
    }
    this.pump();
  }

  /**
   * O teto estourou com a task **ainda na fila** (nunca foi atribuída a um worker).
   *
   * Não há worker rodando a task ⇒ **nenhum worker é morto** (matar um worker ocioso seria
   * desperdício; matar um worker ocupado mataria outra task). A task só sai da fila e é
   * rejeitada — o `busyCount` **não** é tocado (ela nunca incrementou).
   */
  private timeoutQueued(id: number, deadlineMs: number): void {
    const index = this.queue.findIndex((queued) => queued.id === id);
    if (index < 0) return;
    const [queued] = this.queue.splice(index, 1);
    if (!queued) return;
    queued.cancelled = true;
    this.clearTaskTimeout(queued);
    this.counters.increment(POOL_COUNTERS.tasksCancelled);
    queued.deferred.reject(
      new TaskTimeoutError(deadlineMs, `task excedeu o teto de ${deadlineMs} ms (espera na fila)`),
    );
    this.pump();
  }

  private release(slot: WorkerSlot): void {
    slot.busy = false;
    slot.current = undefined;
    this.busyCount[slot.lane] = Math.max(0, this.busyCount[slot.lane] - 1);
    if (LAZY_LANES.has(slot.lane)) this.scheduleIdle(slot);
  }

  private scheduleIdle(slot: WorkerSlot): void {
    this.clearIdle(slot);
    if (this.idleTimeoutMs <= 0) {
      if (!this.disposed) this.terminateSlot(slot);
      return;
    }
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      if (!slot.busy && !this.disposed) this.terminateSlot(slot);
    }, this.idleTimeoutMs);
    slot.idleTimer.unref();
  }

  private clearIdle(slot: WorkerSlot): void {
    if (!slot.idleTimer) return;
    clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
  }

  private terminateSlot(slot: WorkerSlot): void {
    if (!this.slots.has(slot)) return;
    slot.terminating = true;
    this.clearIdle(slot);
    this.slots.delete(slot);
    void slot.worker.terminate();
  }

  private findIdle(lane: PoolLane): WorkerSlot | undefined {
    for (const slot of this.slots) {
      if (slot.lane === lane && !slot.busy && !slot.terminating) return slot;
    }
    return undefined;
  }

  private countLane(lane: PoolLane): number {
    return this.workerCount(lane);
  }

  private canSpawn(lane: PoolLane): boolean {
    return this.slots.size < this.cap && this.countLane(lane) < this.desired[lane];
  }

  private findRunningBySlot(slot: WorkerSlot): RunningTask | undefined {
    for (const task of this.running.values()) if (task.slot === slot) return task;
    return undefined;
  }

  private onWorkerMessage(slot: WorkerSlot, message: WorkerOutbound): void {
    if (isReady(message)) return;
    const running = this.running.get(message.id);
    if (!running || running.slot !== slot) return;
    const queued = running.queued;
    this.clearTaskTimeout(queued);
    this.running.delete(message.id);
    this.release(slot);

    if (queued.cancelled) {
      this.pump();
      return;
    }
    if (message.ok) {
      const stale = this.staleReason(queued, message.value);
      if (stale) queued.deferred.reject(stale);
      else queued.deferred.resolve(message.value);
    } else {
      queued.deferred.reject(this.workerFailure(queued, message.error));
    }
    this.pump();
  }

  /**
   * Reconstrói o erro de uma task falha. O `structured-clone` não transporta classes, então o
   * worker envia `name`/`code`; aqui o erro vira um `TaskError` com os **mesmos** `name`/`code`
   * (o `code` estável sobrevive ao IPC — DEC-TR-5).
   */
  private workerFailure(queued: QueuedTask, error: WorkerResponse["error"] | undefined): Error {
    const message = error?.message ?? `task ${queued.kind} falhou`;
    if (error === undefined || (error.name === undefined && error.code === undefined)) {
      return new Error(message);
    }
    return new TaskError(message, error.name, error.code);
  }

  private onWorkerError(slot: WorkerSlot, error: Error): void {
    const running = this.findRunningBySlot(slot);
    if (running) {
      this.running.delete(running.queued.id);
      this.clearTaskTimeout(running.queued);
      this.busyCount[slot.lane] = Math.max(0, this.busyCount[slot.lane] - 1);
      running.queued.deferred.reject(toError(error));
    }
    if (this.slots.has(slot)) {
      this.clearIdle(slot);
      slot.terminating = true;
      this.slots.delete(slot);
    }
    this.pump();
  }

  private onWorkerExit(slot: WorkerSlot): void {
    if (slot.terminating || this.disposed) return;
    const running = this.findRunningBySlot(slot);
    if (running) {
      this.running.delete(running.queued.id);
      this.clearTaskTimeout(running.queued);
      this.busyCount[slot.lane] = Math.max(0, this.busyCount[slot.lane] - 1);
      running.queued.deferred.reject(new PoolShutdownError(`worker ${slot.name} saiu inesperadamente`));
    }
    if (this.slots.has(slot)) {
      this.clearIdle(slot);
      this.slots.delete(slot);
    }
    this.pump();
  }

  /**
   * Uma task concluída está obsoleta? Duas fontes, nesta ordem:
   * 1. o **valor** devolvido — quando ele carrega `doc`/`generation` (scanLines/index);
   * 2. o **payload da task** — quando o resultado não tem geração (ex.: `search`, cujo
   *    `SearchResult` é só ocorrências). O pool sabe a geração pedida e o `latestGeneration` do
   *    doc, então a comparação vale igualmente. Em qualquer caso, geração antiga ⇒ descarte.
   */
  private staleReason(queued: QueuedTask, value: unknown): StaleGenerationError | undefined {
    const fromValue = this.staleFromValue(value);
    if (fromValue !== undefined) return fromValue;
    return this.staleFromTask(queued.task);
  }

  private staleFromValue(value: unknown): StaleGenerationError | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as { doc?: unknown; generation?: unknown };
    if (typeof record.doc !== "number" || typeof record.generation !== "number") return undefined;
    return this.staleOrUndefined(record.doc as DocumentHandle, record.generation);
  }

  private staleFromTask(task: Task): StaleGenerationError | undefined {
    const record = task as { doc?: unknown; generation?: unknown };
    if (typeof record.doc !== "number" || typeof record.generation !== "number") return undefined;
    return this.staleOrUndefined(record.doc as DocumentHandle, record.generation);
  }

  private staleOrUndefined(
    doc: DocumentHandle,
    generation: number,
  ): StaleGenerationError | undefined {
    const current = this.latestGeneration.get(doc);
    if (current === undefined || generation >= current) return undefined;
    return new StaleGenerationError(doc, generation, current);
  }

  private spawn(lane: PoolLane): WorkerSlot {
    const launch = this.resolveLaunch();
    const name = `scribe-${lane}-${this.workerSeq++}`;
    const workerData = { name, lane, counterCell: POOL_COUNTERS.tasksExecuted };
    const worker =
      launch.kind === "file"
        ? new Worker(launch.file, { workerData })
        : new Worker(launch.code, { eval: true, workerData });
    const slot: WorkerSlot = {
      lane,
      name,
      worker,
      busy: false,
      current: undefined,
      idleTimer: undefined,
      terminating: false,
    };
    worker.on("message", (message: WorkerOutbound) => this.onWorkerMessage(slot, message));
    worker.on("error", (error: Error) => this.onWorkerError(slot, error));
    worker.on("exit", () => this.onWorkerExit(slot));
    this.slots.add(slot);

    for (const [doc, reg] of this.registered) {
      const message: TextRegisterMessage = {
        kind: "text.register",
        doc,
        generation: reg.generation,
        text: reg.text,
      };
      worker.postMessage(message);
    }
    return slot;
  }

  private resolveLaunch(): WorkerLaunch {
    if (this.launch) return this.launch;
    const jsEntry = path.join(__dirname, "worker-entry.js");
    if (existsSync(jsEntry)) return (this.launch = { kind: "file", file: jsEntry });

    // Fallback: compila o worker de .ts com esbuild (apenas em dev/test).
    // Import dinâmico porque esbuild é devDependency — não disponível em produção.
    const tsEntry = path.join(__dirname, "worker-entry.ts");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildSync } = require("esbuild") as typeof import("esbuild");
    const result = buildSync({
      entryPoints: [tsEntry],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node20",
      write: false,
    });
    const code = result.outputFiles[0]?.text ?? "";
    if (!code) throw new Error("pool: esbuild não produziu output para o worker");
    return (this.launch = { kind: "eval", code });
  }
}

/** Lanes do pool (exportado para teste/observabilidade). */
export function taskPoolLanes(): readonly PoolLane[] {
  return ALL_LANES;
}

/** Fábrica de conveniência. */
export function createTaskPool(options?: TaskPoolOptions): TaskPoolImpl {
  return new TaskPoolImpl(options);
}
