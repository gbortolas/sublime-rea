/**
 * Scribe — contadores compartilhados entre threads (`SharedArrayBuffer` + `Atomics`).
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md`
 * (DEC-CON-4/9/10/11; `CON-E11`, `CON-U1`). **Escolha nossa (não observada no alvo):**
 * o alvo compartilha `.bss`; nós só podemos compartilhar **números/flags** por
 * `SharedArrayBuffer` — strings e objetos **nunca** atravessam aqui (DEC-CON-11).
 *
 * Este módulo também concentra a única primitiva de espera permitida fora de worker:
 * `Atomics.waitAsync` (DEC-CON-1/7). `Atomics.wait` **não** é exposto — quem quiser
 * bloquear de verdade está do lado errado da fronteira de UI.
 */

/** Erro alto: runtime sem a primitiva assíncrona exigida (Node < 16). */
export class UnsupportedRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRuntimeError";
  }
}

/** Resultado cru de `Atomics.waitAsync` (ES2024; `lib` do projeto é ES2022, então tipamos à parte). */
export type SharedWaitOutcome = "ok" | "not-equal" | "timed-out";

type WaitAsyncResult =
  | { readonly async: false; readonly value: "not-equal" }
  | { readonly async: true; readonly value: Promise<"ok" | "timed-out"> };

interface AtomicsWithWaitAsync {
  waitAsync(view: Int32Array, index: number, value: number, timeout?: number): WaitAsyncResult;
}

/**
 * Espera **assíncrona** numa célula `Int32Array` sobre `SharedArrayBuffer`.
 *
 * - resolve `"ok"` quando a célula **deixa** de valer `expected` (notificada ou já diferente);
 * - resolve `"not-equal"` se o valor já era diferente de `expected` (não espera);
 * - resolve `"timed-out"` quando `timeoutMs` estoura.
 *
 * Nunca bloqueia a thread: a variante síncrona (`Atomics.wait`) é **proibida** (DEC-CON-1).
 */
export function waitAsync(
  cell: Int32Array,
  expected: number,
  timeoutMs?: number,
): Promise<SharedWaitOutcome> {
  const withWait = Atomics as unknown as Partial<AtomicsWithWaitAsync>;
  const wait = withWait.waitAsync;
  if (typeof wait !== "function") {
    return Promise.reject(
      new UnsupportedRuntimeError("Atomics.waitAsync indisponível neste runtime (requer Node >= 16)"),
    );
  }
  let result: WaitAsyncResult;
  try {
    result = timeoutMs === undefined
      ? wait.call(Atomics, cell, 0, expected)
      : wait.call(Atomics, cell, 0, expected, timeoutMs);
  } catch (err) {
    return Promise.reject(err);
  }
  if (!result.async) return Promise.resolve("not-equal");
  return result.value;
}

/**
 * Acorda até `count` esperas na célula `(cells, index)`. Guarda contra array **não**
 * compartilhado (aí não há *waiter* cross-thread e `Atomics.notify` lançaria `TypeError`).
 */
export function notifyWaiters(cells: Int32Array, index: number, count = 1): number {
  if (!(cells.buffer instanceof SharedArrayBuffer)) return 0;
  if (index < 0 || index >= cells.length) return 0;
  return Atomics.notify(cells, index, count);
}

/** Fachada tipada sobre uma região `SharedArrayBuffer` de inteiros de 32 bits. */
export interface SharedCounters {
  readonly sab: SharedArrayBuffer;
  readonly cells: Int32Array;
  readonly length: number;
  get(index: number): number;
  set(index: number, value: number): void;
  add(index: number, delta: number): number;
  increment(index: number): number;
  decrement(index: number): number;
  /** `set` + `Atomics.notify` (para publicar um valor a quem espera em `waitOn`). */
  publish(index: number, value: number, waiters?: number): number;
  snapshot(): number[];
}

/** Cria `length` células atômicas compartilháveis (só números — DEC-CON-11). */
export function createCounters(length: number): SharedCounters {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`createCounters: length deve ser inteiro > 0: ${length}`);
  }
  const sab = new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT);
  const cells = new Int32Array(sab);
  const check = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= length) {
      throw new RangeError(`SharedCounters: índice fora da faixa 0..${length - 1}: ${index}`);
    }
  };
  return {
    sab,
    cells,
    length,
    get(index: number): number {
      check(index);
      return Atomics.load(cells, index);
    },
    set(index: number, value: number): void {
      check(index);
      Atomics.store(cells, index, value);
    },
    add(index: number, delta: number): number {
      check(index);
      return Atomics.add(cells, index, delta);
    },
    increment(index: number): number {
      return Atomics.add(cells, index, 1);
    },
    decrement(index: number): number {
      return Atomics.sub(cells, index, 1);
    },
    publish(index: number, value: number, waiters = 1): number {
      check(index);
      Atomics.store(cells, index, value);
      return notifyWaiters(cells, index, waiters);
    },
    snapshot(): number[] {
      const out = new Array<number>(length);
      for (let i = 0; i < length; i++) out[i] = Atomics.load(cells, i);
      return out;
    },
  };
}

/**
 * Layout de contadores do `TaskPool` (índices fixos na região compartilhada entregue ao
 * worker em `WorkerRequest.counters`). O worker incrementa `tasksExecuted` ao terminar.
 */
export const POOL_COUNTERS = {
  tasksExecuted: 0,
  tasksCancelled: 1,
  length: 2,
} as const;
