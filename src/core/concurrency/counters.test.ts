import { describe, expect, it } from "vitest";
import { createCounters, notifyWaiters, POOL_COUNTERS, waitAsync } from "./counters";

describe("counters (SharedArrayBuffer + Atomics)", () => {
  it("aloca região SAB e opera atomicamente", () => {
    const counters = createCounters(3);
    expect(counters.cells).toBeInstanceOf(Int32Array);
    expect(counters.cells.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(counters.get(0)).toBe(0);

    counters.increment(0);
    counters.add(0, 4);
    expect(counters.get(0)).toBe(5);
    counters.decrement(0);
    expect(counters.get(0)).toBe(4);

    counters.set(1, 9);
    expect(counters.snapshot()).toEqual([4, 9, 0]);
  });

  it("valida tamanho e índices", () => {
    const counters = createCounters(1);
    expect(() => counters.get(1)).toThrow(RangeError);
    expect(() => counters.set(-1, 0)).toThrow(RangeError);
    expect(() => createCounters(0)).toThrow(RangeError);
  });

  it("waitAsync resolve 'not-equal' quando o valor já difere (não espera)", async () => {
    const counters = createCounters(1);
    await expect(waitAsync(counters.cells, 99)).resolves.toBe("not-equal");
  });

  it("notifyWaiters em array não compartilhado devolve 0 (sem waiter cross-thread)", () => {
    expect(notifyWaiters(new Int32Array(4), 0)).toBe(0);
  });

  it("publish publica valor visível e o layout do pool tem índice válido", () => {
    const counters = createCounters(POOL_COUNTERS.length);
    expect(POOL_COUNTERS.tasksExecuted).toBeLessThan(POOL_COUNTERS.length);
    counters.publish(POOL_COUNTERS.tasksExecuted, 7);
    expect(counters.get(POOL_COUNTERS.tasksExecuted)).toBe(7);
  });
});
