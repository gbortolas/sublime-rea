/**
 * Scribe — `TaskPool`: pools de `worker_threads` (DEC-CON-2/3/4/9).
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md`.
 *
 * Topologia replicada do alvo:
 * - lane `io` — pool de **N fixo** (`io_workers`, default **2**) `CON-E9`/`REN-E26`;
 * - lane `fileRead` — **bounded on-demand (≤2)**, worker reciclado por *idle* `CON-E10`;
 * - lane `index` — **cold-start single**, sobe só quando há tarefa `CON-U6`;
 * - **teto global** = `max(1, min(setting, availableParallelism() − 1))` — nunca 0 (DEC-CON-9).
 *
 * Tarefas são **serializáveis** (nada de closure cruza a fronteira — DEC-CON-4/11); o worker
 * **não** tem o store: o texto vai por `text.register` e o resultado volta com a `generation`
 * recebida. O pool **descarta** resultado de geração vencida (`StaleGenerationError`, DEC-CON-8).
 *
 * **Escolhas nossas (não observadas no alvo):** workers sobem *lazy* até a capacidade da lane
 * (io residente; fileRead/index recicláveis); `writeFile` roda na lane `io` (só leitura usa
 * `fileRead`); o pool guarda o último texto registrado por doc para reenviar a workers novos.
 */

import { existsSync, readFileSync } from "node:fs";
import { availableParallelism as osAvailableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type * as TypeScript from "typescript";
import { CancellationError, Deferred, toError } from "../../shared";
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
  cancelled: boolean;
}

interface RunningTask {
  readonly queued: QueuedTask;
  readonly slot: WorkerSlot;
}

type WorkerLaunch =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "eval"; readonly code: string };

const LANE_PRIORITY: readonly Priority[] = ["input", "edit", "layout", "background"];

const ALL_LANES: readonly PoolLane[] = ["io", "index", "fileRead"];

/** Lanes cujo worker é reciclado por *idle* (on-demand — DEC-CON-3/9). */
const LAZY_LANES: ReadonlySet<PoolLane> = new Set<PoolLane>(["fileRead", "index"]);

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
  }
}

function compareQueued(a: QueuedTask, b: QueuedTask): number {
  const laneDiff = LANE_PRIORITY.indexOf(a.priority) - LANE_PRIORITY.indexOf(b.priority);
  return laneDiff !== 0 ? laneDiff : a.seq - b.seq;
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

let cachedTypeScript: typeof TypeScript | undefined;

function loadTypeScript(): typeof TypeScript {
  if (!cachedTypeScript) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedTypeScript = require("typescript") as typeof TypeScript;
  }
  return cachedTypeScript;
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
}

export class TaskPoolImpl implements TaskPool {
  private readonly cap: number;
  private readonly desired: Record<PoolLane, number>;
  private readonly idleTimeoutMs: number;
  private readonly counters: SharedCounters;

  private readonly slots = new Set<WorkerSlot>();
  private readonly queue: QueuedTask[] = [];
  private readonly running = new Map<number, RunningTask>();
  private readonly busyCount: Record<PoolLane, number> = { io: 0, index: 0, fileRead: 0 };
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
    };
    this.idleTimeoutMs = options.idleTimeoutMs ?? 1000;
    this.counters = createCounters(POOL_COUNTERS.length);
  }

  get busy(): Readonly<Record<PoolLane, number>> {
    return { io: this.busyCount.io, index: this.busyCount.index, fileRead: this.busyCount.fileRead };
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
      cancelled: false,
    };
    this.queue.push(queued);
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
      queued.deferred.reject(error);
    }
    this.queue.length = 0;
    for (const task of this.running.values()) task.queued.deferred.reject(error);
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

    this.shutdownPromise = Promise.all(terminations).then(() => undefined);
    return this.shutdownPromise;
  }

  // ---- interno --------------------------------------------------------------

  private cancel(id: number, reason: string | undefined): void {
    const running = this.running.get(id);
    if (running) {
      if (running.queued.cancelled) return;
      running.queued.cancelled = true;
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
      this.queue.push(queued);
    }
  }

  private assign(slot: WorkerSlot, queued: QueuedTask): void {
    slot.busy = true;
    slot.current = queued.id;
    this.clearIdle(slot);
    this.busyCount[queued.lane] += 1;
    this.running.set(queued.id, { queued, slot });
    const request: WorkerRequest = {
      id: queued.id,
      kind: queued.kind,
      payload: queued.task,
      counters: this.counters.cells,
    };
    slot.worker.postMessage(request);
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
    this.running.delete(message.id);
    this.release(slot);

    const queued = running.queued;
    if (queued.cancelled) {
      this.pump();
      return;
    }
    if (message.ok) {
      const stale = this.staleReason(message.value);
      if (stale) queued.deferred.reject(stale);
      else queued.deferred.resolve(message.value);
    } else {
      queued.deferred.reject(new Error(message.error?.message ?? `task ${queued.kind} falhou`));
    }
    this.pump();
  }

  private onWorkerError(slot: WorkerSlot, error: Error): void {
    const running = this.findRunningBySlot(slot);
    if (running) {
      this.running.delete(running.queued.id);
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
      this.busyCount[slot.lane] = Math.max(0, this.busyCount[slot.lane] - 1);
      running.queued.deferred.reject(new PoolShutdownError(`worker ${slot.name} saiu inesperadamente`));
    }
    if (this.slots.has(slot)) {
      this.clearIdle(slot);
      this.slots.delete(slot);
    }
    this.pump();
  }

  private staleReason(value: unknown): StaleGenerationError | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as { doc?: unknown; generation?: unknown };
    if (typeof record.doc !== "number" || typeof record.generation !== "number") return undefined;
    const doc = record.doc as DocumentHandle;
    const current = this.latestGeneration.get(doc);
    if (current === undefined || record.generation >= current) return undefined;
    return new StaleGenerationError(doc, record.generation, current);
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

    const tsEntry = path.join(__dirname, "worker-entry.ts");
    const source = readFileSync(tsEntry, "utf8");
    const ts = loadTypeScript();
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        isolatedModules: true,
      },
    }).outputText;
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
