import { afterEach, describe, expect, it, vi } from "vitest";

import { CancellationError, ProtocolError } from "../../shared";

import { createBridgeInternal, type MethodHandlers } from "./bridge";
import { collect, createMemoryPortPair, settle } from "./__tests__/support";

interface TestMethods {
  ping(): "pong";
  echo(value: number): number;
  slow(value: number): number;
}

interface TestEvents {
  hello(payload: string): void;
}

function makeHandlers(slowMs = 5): Partial<MethodHandlers<TestMethods>> {
  return {
    ping: () => "pong" as const,
    echo: (value: number) => value,
    slow: async (value: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, slowMs));
      return value * 10;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createBridge — request/response e dispatch", () => {
  it("correlaciona request/response por id", async () => {
    const pair = createMemoryPortPair();
    const responder = createBridgeInternal<TestMethods, TestEvents>(pair.b, { handlers: makeHandlers() });
    const caller = createBridgeInternal<TestMethods, TestEvents>(pair.a, {});

    await expect(caller.request("ping", [])).resolves.toBe("pong");
    await expect(caller.request("echo", [21])).resolves.toBe(21);

    await caller.close();
    await responder.close();
  });

  it("não cruza dois requests concorrentes (respostas fora de ordem)", async () => {
    const pair = createMemoryPortPair();
    const responder = createBridgeInternal<TestMethods, TestEvents>(pair.b, { handlers: makeHandlers(5) });
    const caller = createBridgeInternal<TestMethods, TestEvents>(pair.a, {});

    const slow = caller.request("slow", [3]);
    const fast = caller.request("echo", [7]);
    await expect(fast).resolves.toBe(7);
    await expect(slow).resolves.toBe(30);

    await caller.close();
    await responder.close();
  });

  it("dispatcha nota e ignore notificação de método desconhecido (sem silêncio)", async () => {
    const pair = createMemoryPortPair();
    const errors: ProtocolError[] = [];
    const responder = createBridgeInternal<TestMethods, TestEvents>(pair.b, {
      handlers: makeHandlers(),
      onProtocolError: (error) => errors.push(error),
    });
    const caller = createBridgeInternal<TestMethods, TestEvents>(pair.a, {});

    caller.notify("nao-existe", []);
    await settle();
    expect(errors.map((error) => error.code)).toContain("bridge.unknown-method");

    await caller.close();
    await responder.close();
  });

  it("entrega eventos ao handler registrado por `on`", async () => {
    const pair = createMemoryPortPair();
    const bridge = createBridgeInternal<TestMethods, TestEvents>(pair.a, {});
    const received: string[] = [];
    bridge.on("hello", (payload: string) => received.push(payload));

    pair.b.postMessage({ kind: "emit", event: "hello", payload: "mundo" });
    await settle();
    expect(received).toEqual(["mundo"]);

    await bridge.close();
  });
});

describe("createBridge — cancelamento, timeout e backpressure", () => {
  it("AbortSignal envia `cancel` correlacionado e rejeita com CancellationError", async () => {
    const pair = createMemoryPortPair();
    const seen = collect(pair.b);
    const caller = createBridgeInternal<TestMethods, TestEvents>(pair.a, { timeoutMs: 1000 });

    const controller = new AbortController();
    const pending = caller.request("echo", [7], { signal: controller.signal });
    pending.catch(() => undefined);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(CancellationError);
    await settle();

    const kinds = seen.map((message) => (message as { kind?: string }).kind);
    expect(kinds).toEqual(["call", "cancel"]);
    const call = seen[0] as { id: number };
    const cancel = seen[1] as { id: number };
    expect(cancel.id).toBe(call.id);

    await caller.close();
  });

  it("estoura por timeout quando o par não responde", async () => {
    vi.useFakeTimers();
    const pair = createMemoryPortPair();
    const caller = createBridgeInternal<TestMethods, TestEvents>(pair.a, { timeoutMs: 100 });

    const pending = caller.request("echo", [1]);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).rejects.toMatchObject({ code: "bridge.timeout" });
    await caller.close();
  });

  it("aplica backpressure: fila cheia recusa alto, sem bloquear", async () => {
    const pair = createMemoryPortPair();
    const caller = createBridgeInternal<TestMethods, TestEvents>(pair.a, { maxPending: 1 });

    const first = caller.request("echo", [1]);
    first.catch(() => undefined);
    await expect(caller.request("echo", [2])).rejects.toMatchObject({ code: "bridge.backpressure" });

    await caller.close();
    await expect(first).rejects.toBeInstanceOf(CancellationError);
  });
});

describe("createBridge — protocolo e ciclo de vida", () => {
  it("envelope desconhecido → ProtocolError, estado `dead` e pendentes rejeitadas", async () => {
    const pair = createMemoryPortPair();
    const errors: ProtocolError[] = [];
    const bridge = createBridgeInternal<TestMethods, TestEvents>(pair.a, {
      timeoutMs: 1000,
      onProtocolError: (error) => errors.push(error),
    });
    const pending = bridge.request("echo", [1]);
    pending.catch(() => undefined);

    pair.b.postMessage({ kind: "bogus" });
    await settle();

    expect(bridge.state).toBe("dead");
    expect(errors[0]?.code).toBe("bridge.unknown-envelope");
    await expect(pending).rejects.toBeInstanceOf(ProtocolError);
  });

  it("envelope malformado também mata a ponte", async () => {
    const pair = createMemoryPortPair();
    const bridge = createBridgeInternal<TestMethods, TestEvents>(pair.a, { onProtocolError: () => undefined });
    pair.b.postMessage({ kind: "emit" }); // falta `event`
    await settle();
    expect(bridge.state).toBe("dead");
  });

  it("close() é idempotente e libera o port", async () => {
    const pair = createMemoryPortPair();
    const bridge = createBridgeInternal<TestMethods, TestEvents>(pair.a, {});
    await bridge.close();
    await bridge.close();
    expect(bridge.state).toBe("dead");
    expect(bridge.port).toBeNull();
  });

  it("recusa request/notify depois de fechada", async () => {
    const pair = createMemoryPortPair();
    const bridge = createBridgeInternal<TestMethods, TestEvents>(pair.a, {});
    await bridge.close();
    await expect(bridge.request("ping", [])).rejects.toMatchObject({ code: "bridge.closed" });
    expect(() => bridge.notify("ping", [])).toThrowError(ProtocolError);
  });
});
