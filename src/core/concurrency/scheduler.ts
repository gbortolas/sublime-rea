/**
 * Scribe — `Scheduler`: o "px_main_thread_scheduler" do nosso lado.
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md`
 * (DEC-CON-1/5/8; `CON-E15`, `CON-E16`, `CON-U5`).
 *
 * O scheduler é o **veículo do retorno à thread de UI** no alvo (handoff via wakeup de fd +
 * idle callbacks). Aqui ele enfileira callbacks por **lane de prioridade** e os drena num
 * **único turno coalescido** (`setImmediate` por padrão; `queueMicrotask` como alternativa
 * no renderer). Regras duras preservadas:
 *
 * - a UI **nunca** bloqueia: nada de `Atomics.wait`; espera só por `Atomics.waitAsync` (DEC-CON-1/7);
 * - `isUIThread` é **explícito** — nunca deduzido de `Atomics` (`CON-U1`);
 * - ordem **estrita** por prioridade `input > edit > layout > background`.
 *
 * **Inanição — critério documentado e testado (escolha nossa):** a ordem é estritamente
 * por prioridade. Sob carga **contínua** de lanes altas, a lane `background` pode ser
 * postergada indefinidamente (`CON-U5` não fecha o coalescing do alvo). Não introduzimos
 * *aging*: preferimos que input/edição/layout nunca fiquem atrás de trabalho de fundo. O
 * critério testado é: (a) com fila estática, a drenagem respeita a ordem e é FIFO dentro da
 * lane; (b) `background` progride sempre que as lanes acima esvaziam.
 */

import { Deferred, toDisposable } from "../../shared";
import type {
  Disposable,
  DocumentHandle,
  MainThreadBusy,
  PoolLane,
  Priority,
  Scheduler,
  SchedulerTarget,
} from "../../shared";
import { waitAsync } from "./counters";

/** Erro alto: nenhum callback é aceito depois de `dispose()` (DEC-TR-5). */
export class SchedulerDisposedError extends Error {
  constructor(message = "scheduler já foi descartado") {
    super(message);
    this.name = "SchedulerDisposedError";
  }
}

/** Ordem estrita das lanes (DEC-CON-5). */
export const PRIORITY_ORDER: readonly Priority[] = ["input", "edit", "layout", "background"];

const POOL_LANES: readonly PoolLane[] = ["io", "index", "fileRead"];

/** Agenda de flush injetável (determinismo de teste). Default: `setImmediate`. */
export type FlushScheduler = (cb: () => void) => void;

/** Sink para `postTo`: como entregar um callback a **outro** alvo (Electron main ↔ renderer). */
export type SchedulerTargetSink = (cb: () => void) => void;

export interface SchedulerOptions {
  /** Explícito — nunca inferido de `Atomics` (`CON-U1`). */
  readonly isUIThread: boolean;
  /** Relógio injetável (mede `busyMs`). Default: `Date.now`. */
  readonly now?: () => number;
  /** Como coalescer o turno. Default: `setImmediate`. */
  readonly scheduleFlush?: FlushScheduler;
  /** Lane de workers ativos por lane do pool (para `snapshot().lanes`). Default: zeros. */
  readonly laneProbe?: () => Readonly<Record<PoolLane, number>>;
}

interface PostEntry {
  readonly priority: Priority;
  readonly seq: number;
  readonly handle: DocumentHandle | undefined;
  run(): void;
  fail(error: unknown): void;
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function compareEntries(a: PostEntry, b: PostEntry): number {
  const laneDiff = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
  return laneDiff !== 0 ? laneDiff : a.seq - b.seq;
}

export class SchedulerImpl implements Scheduler {
  readonly isUIThread: boolean;

  private readonly now: () => number;
  private readonly schedule: FlushScheduler;
  private readonly laneProbe: (() => Readonly<Record<PoolLane, number>>) | undefined;
  private readonly sinks = new Map<SchedulerTarget, SchedulerTargetSink>();

  private entries: PostEntry[] = [];
  private seq = 0;
  private scheduled = false;
  private disposed = false;
  private busyMs = 0;

  constructor(options: SchedulerOptions) {
    this.isUIThread = options.isUIThread;
    this.now = options.now ?? Date.now;
    this.schedule = options.scheduleFlush ?? ((cb) => void setImmediate(cb));
    this.laneProbe = options.laneProbe;
  }

  get pendingCallbacks(): number {
    return this.entries.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  post<T>(
    priority: Priority,
    cb: () => T | Promise<T>,
    opts?: { readonly handle?: DocumentHandle },
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new SchedulerDisposedError("post após dispose()"));
    }
    const deferred = new Deferred<T>();
    const entry: PostEntry = {
      priority,
      seq: this.seq++,
      handle: opts?.handle,
      run: (): void => {
        const started = this.now();
        try {
          const output = cb();
          if (isThenable(output)) {
            output.then(
              (value) => deferred.resolve(value),
              (error: unknown) => deferred.reject(error),
            );
          } else {
            deferred.resolve(output);
          }
        } catch (error) {
          deferred.reject(error);
        } finally {
          this.busyMs += this.now() - started;
        }
      },
      fail: (error: unknown): void => deferred.reject(error),
    };
    this.entries.push(entry);
    this.scheduleFlush();
    return deferred.promise;
  }

  /**
   * Entrega `cb` ao alvo. Com um sink registrado para o alvo, encaminha (é o seam do
   * Electron: main ↔ renderer). Sem sink, cai como microtask local — suficiente em Node e
   * inofensivo quando o alvo já é esta thread.
   */
  postTo(target: SchedulerTarget, cb: () => void): void {
    if (this.disposed) return;
    const sink = this.sinks.get(target);
    if (sink) {
      sink(cb);
      return;
    }
    queueMicrotask(cb);
  }

  /** Registra como encaminhar para `target` (ex.: `postMessage` da página do renderer). */
  setTargetSink(target: SchedulerTarget, sink: SchedulerTargetSink): Disposable {
    this.sinks.set(target, sink);
    return toDisposable(() => {
      if (this.sinks.get(target) === sink) this.sinks.delete(target);
    });
  }

  /** Espera **assíncrona** por um contador compartilhado (nunca bloqueia a UI — DEC-CON-1/7). */
  async waitOn(cell: Int32Array, expected: number, timeoutMs?: number): Promise<"ok" | "timedout"> {
    const outcome = timeoutMs === undefined ? await waitAsync(cell, expected) : await waitAsync(cell, expected, timeoutMs);
    // "not-equal" = a célula já não valia `expected` → a condição de espera terminou.
    return outcome === "timed-out" ? "timedout" : "ok";
  }

  /** Observabilidade (DEC-CON-10). `lanes` vem do pool via `laneProbe` quando plugado. */
  snapshot(): MainThreadBusy {
    const lanes = this.laneProbe
      ? this.laneProbe()
      : ((): Readonly<Record<PoolLane, number>> => {
          const zero = { io: 0, index: 0, fileRead: 0 };
          return zero;
        })();
    return {
      busyMs: this.busyMs,
      pendingCallbacks: this.entries.length,
      lanes,
    };
  }

  /** Rejeita o que sobrou e para de aceitar callbacks (DEC-TR-2). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.entries;
    this.entries = [];
    const error = new SchedulerDisposedError("scheduler descartado com callbacks pendentes");
    for (const entry of pending) entry.fail(error);
  }

  private scheduleFlush(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    this.schedule(this.flush);
  }

  private readonly flush = (): void => {
    this.scheduled = false;
    if (this.disposed) return;
    const batch = this.entries;
    this.entries = [];
    batch.sort(compareEntries);
    for (const entry of batch) {
      if (this.disposed) {
        entry.fail(new SchedulerDisposedError("scheduler descartado durante o flush"));
        continue;
      }
      entry.run();
    }
    // Callbacks postados durante o flush já agendaram um novo turno (coalescing por turno).
  };
}

/** Fábrica de conveniência (bootstrap do main/renderer). */
export function createScheduler(options: SchedulerOptions): SchedulerImpl {
  return new SchedulerImpl(options);
}

/** Nomes das lanes de prioridade (útil em log/teste). */
export function priorityLanes(): readonly Priority[] {
  return PRIORITY_ORDER;
}

/** Lanes do pool (o `lanes` de `MainThreadBusy`). */
export function poolLanes(): readonly PoolLane[] {
  return POOL_LANES;
}
