import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createCounters } from "./counters";
import { SchedulerDisposedError, SchedulerImpl } from "./scheduler";

/** Scheduler com flush manual e relógio injetado — determinismo total nos testes. */
function manualScheduler() {
  const flushes: Array<() => void> = [];
  const clock = { t: 0 };
  const scheduler = new SchedulerImpl({
    isUIThread: true,
    now: () => clock.t,
    scheduleFlush: (cb) => {
      flushes.push(cb);
    },
  });
  const flush = (): void => {
    const pending = flushes.splice(0);
    for (const cb of pending) cb();
  };
  return { scheduler, flushes, flush, clock };
}

describe("SchedulerImpl — coalescing e prioridade estrita", () => {
  it("coalesce N posts num único turno e drena na ordem input > edit > layout > background", async () => {
    const { scheduler, flushes, flush } = manualScheduler();
    const order: string[] = [];

    const promises = [
      scheduler.post("background", () => order.push("bg1")),
      scheduler.post("layout", () => order.push("layout")),
      scheduler.post("input", () => order.push("input1")),
      scheduler.post("edit", () => order.push("edit")),
      scheduler.post("input", () => order.push("input2")),
      scheduler.post("background", () => order.push("bg2")),
    ];

    expect(flushes.length).toBe(1); // um só turno agendado (coalescing)
    expect(order).toEqual([]); // nada roda antes do turno

    flush();

    expect(order).toEqual(["input1", "input2", "edit", "layout", "bg1", "bg2"]);
    await Promise.all(promises);
  });

  it("resolve o valor (sync e async) e FIFO dentro da mesma lane", async () => {
    const { scheduler, flush } = manualScheduler();
    const calls: number[] = [];
    const first = scheduler.post("edit", () => {
      calls.push(1);
      return 42;
    });
    const second = scheduler.post("edit", async () => {
      calls.push(2);
      return "ok";
    });
    flush();
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe("ok");
    expect(calls).toEqual([1, 2]);
  });

  it("rejeita o post quando o callback lança", async () => {
    const { scheduler, flush } = manualScheduler();
    const failing = scheduler.post("edit", () => {
      throw new Error("boom");
    });
    flush();
    await expect(failing).rejects.toThrow("boom");
  });

  it("background progride quando as lanes altas esvaziam (critério de inanição)", async () => {
    // A ordem é estritamente por prioridade: sob carga contínua de lanes altas, `background`
    // é postergado por design. O critério garantido é: esvaziando as lanes acima, ele roda.
    const { scheduler, flush } = manualScheduler();
    const order: string[] = [];
    scheduler.post("background", () => order.push("bg"));
    scheduler.post("input", () => order.push("in"));
    flush();
    expect(order).toEqual(["in", "bg"]);
  });

  it("mede busyMs e pendingCallbacks e reporta lanes do pool", async () => {
    const { scheduler, flush, clock } = manualScheduler();
    clock.t = 100;
    const p1 = scheduler.post("edit", () => {
      clock.t = 140;
      return "x";
    });
    const p2 = scheduler.post("background", () => 2);

    expect(scheduler.snapshot().pendingCallbacks).toBe(2);
    expect(scheduler.snapshot().lanes).toEqual({ io: 0, index: 0, fileRead: 0 });

    flush();
    await p1;
    await p2;

    const snap = scheduler.snapshot();
    expect(snap.pendingCallbacks).toBe(0);
    expect(snap.busyMs).toBe(40);
  });

  it("após dispose rejeita novos posts e os pendentes, e para de drenar", async () => {
    const { scheduler, flushes } = manualScheduler();
    const pending = scheduler.post("background", () => 1);
    scheduler.dispose();

    await expect(pending).rejects.toBeInstanceOf(SchedulerDisposedError);
    await expect(scheduler.post("input", () => 1)).rejects.toBeInstanceOf(SchedulerDisposedError);
    expect(scheduler.isDisposed).toBe(true);
    expect(flushes.length).toBe(1); // o turno agendado vira no-op (não roda callback)
    expect(scheduler.snapshot().pendingCallbacks).toBe(0);
  });

  it("postTo entrega pelo sink registrado e cai em microtask sem sink", async () => {
    const { scheduler } = manualScheduler();
    const seen: string[] = [];
    const subscription = scheduler.setTargetSink("renderer", (cb) => {
      seen.push("sink");
      cb();
    });
    scheduler.postTo("renderer", () => seen.push("cb"));
    expect(seen).toEqual(["sink", "cb"]);

    subscription.dispose();
    scheduler.postTo("main", () => seen.push("micro"));
    await Promise.resolve();
    expect(seen).toContain("micro");
  });
});

describe("SchedulerImpl — waitOn (Atomics.waitAsync, nunca Atomics.wait)", () => {
  it("devolve 'timedout' quando ninguém notifica", async () => {
    const counters = createCounters(1);
    const scheduler = new SchedulerImpl({ isUIThread: true });
    await expect(scheduler.waitOn(counters.cells, 0, 30)).resolves.toBe("timedout");
  });

  it("devolve 'ok' quando já difere do esperado", async () => {
    const counters = createCounters(1);
    counters.set(0, 5);
    const scheduler = new SchedulerImpl({ isUIThread: true });
    await expect(scheduler.waitOn(counters.cells, 0, 30)).resolves.toBe("ok");
  });

  it("devolve 'ok' com notificação real de OUTRO worker_thread", async () => {
    const counters = createCounters(1);
    const scheduler = new SchedulerImpl({ isUIThread: true });

    const source = `
      const { workerData } = require("node:worker_threads");
      const cell = new Int32Array(workerData.sab);
      setTimeout(() => {
        Atomics.add(cell, 0, 1);
        Atomics.notify(cell, 0);
      }, 10);
    `;
    const worker = new Worker(source, { eval: true, workerData: { sab: counters.sab } });
    try {
      await expect(scheduler.waitOn(counters.cells, 0, 2000)).resolves.toBe("ok");
      expect(counters.get(0)).toBe(1);
    } finally {
      await worker.terminate();
    }
  });
});
