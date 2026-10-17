import { describe, expect, it } from "vitest";

import type { BridgePort, ExtensionEvents, ExtensionMethods } from "../../shared";

import { createBridgeInternal, type MethodHandlers } from "./bridge";
import { ExtensionHostImpl, type HostProcess, type HostProcessEventName, type HostProcessEvents, type HostSpawner, type PortPair } from "./host";
import { OPS_HASH } from "./ops";
import { createMemoryPortPair } from "./__tests__/support";

interface FakeProcessOptions {
  readonly apiVersion?: string;
  readonly opsHash?: string;
  readonly hostVersion?: string;
  readonly silent?: boolean;
  readonly handlers?: Partial<MethodHandlers<ExtensionMethods>>;
}

/** Processo hospedado falso: ao receber o bootstrap, conecta a porta e responde o handshake. */
class FakeProcess implements HostProcess {
  readonly pid = 4242;
  killed = false;
  private readonly listeners = new Map<HostProcessEventName, Set<(...args: never[]) => void>>();
  private readonly options: FakeProcessOptions;

  constructor(options: FakeProcessOptions) {
    this.options = options;
  }

  postMessage(message: unknown): void {
    const record = message as { kind?: string; port?: BridgePort };
    if (record.kind !== "bootstrap" || record.port === undefined) return;
    const port = record.port;
    if (this.options.handlers) {
      createBridgeInternal<ExtensionMethods, ExtensionEvents>(port, {
        handlers: this.options.handlers,
        initialState: "spawned",
      });
    }
    if (!this.options.silent) {
      queueMicrotask(() => {
        port.postMessage({
          kind: "ready",
          hostVersion: this.options.hostVersion ?? "fake-host-0.0.1",
          apiVersion: this.options.apiVersion ?? "1.0",
          opsHash: this.options.opsHash ?? OPS_HASH,
        });
      });
    }
  }

  on<E extends HostProcessEventName>(event: E, listener: HostProcessEvents[E]): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as unknown as (...args: never[]) => void);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.emit("exit", 0);
  }

  emit(event: HostProcessEventName, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as unknown as (...a: unknown[]) => void)(...args);
  }
}

function makeFakeSpawner(options: FakeProcessOptions = {}): {
  spawner: HostSpawner;
  processes: FakeProcess[];
} {
  const processes: FakeProcess[] = [];
  const spawner: HostSpawner = {
    spawn: (): HostProcess => {
      const proc = new FakeProcess(options);
      processes.push(proc);
      return proc;
    },
  };
  return { spawner, processes };
}

const memoryPortPair = (): PortPair => {
  const pair = createMemoryPortPair();
  return { core: pair.a, host: pair.b };
};

describe("ExtensionHostImpl — handshake", () => {
  it("spawn bem-sucedido entra em `ready`, conecta a ponte e troca requests", async () => {
    const { spawner, processes } = makeFakeSpawner({ handlers: { ping: () => "pong" as const } });
    const exits: { readonly code: number | null }[] = [];
    const host = new ExtensionHostImpl({
      spawner,
      createPortPair: memoryPortPair,
      handshakeTimeoutMs: 500,
      requestTimeoutMs: 200,
    });
    host.onDidExit((event) => exits.push({ code: event.code }));

    const session = await host.spawn({ name: "test", entry: "/x.js" });
    expect(session.state).toBe("ready");
    expect(session.bridge.version).toBe("1.0");
    await expect(session.bridge.request("ping", [])).resolves.toBe("pong");

    await session.dispose();
    expect(session.state).toBe("dead");
    expect(processes[0]?.killed).toBe(true);
    await expect(session.exited).resolves.toEqual({ code: 0 });
    expect(exits).toHaveLength(1);

    await host.shutdown();
  });

  it("versão incompatível falha alto e mata o processo", async () => {
    const { spawner, processes } = makeFakeSpawner({ apiVersion: "2.0" });
    const host = new ExtensionHostImpl({ spawner, createPortPair: memoryPortPair, handshakeTimeoutMs: 500 });

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.version-mismatch/);
    expect(processes[0]?.killed).toBe(true);
    await host.shutdown();
  });

  it("opsHash divergente falha alto e mata o processo", async () => {
    const { spawner, processes } = makeFakeSpawner({ opsHash: "deadbeef" });
    const host = new ExtensionHostImpl({ spawner, createPortPair: memoryPortPair, handshakeTimeoutMs: 500 });

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.ops-hash-mismatch/);
    expect(processes[0]?.killed).toBe(true);
    await host.shutdown();
  });

  it("host que nunca fica ready estoura por timeout e é morto", async () => {
    const { spawner, processes } = makeFakeSpawner({ silent: true });
    const host = new ExtensionHostImpl({ spawner, createPortPair: memoryPortPair, handshakeTimeoutMs: 20 });

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.handshake-timeout/);
    expect(processes[0]?.killed).toBe(true);
    await host.shutdown();
  });
});

describe("ExtensionHostImpl — ciclo de vida", () => {
  it("shutdown drena todos os hosts", async () => {
    const { spawner, processes } = makeFakeSpawner({});
    const host = new ExtensionHostImpl({ spawner, createPortPair: memoryPortPair, handshakeTimeoutMs: 500 });

    const first = await host.spawn({ name: "a", entry: "/a.js" });
    const second = await host.spawn({ name: "b", entry: "/b.js" });
    expect(first.handle).not.toBe(second.handle);

    await host.shutdown();
    expect(processes.every((proc) => proc.killed)).toBe(true);
    expect(first.state).toBe("dead");
    expect(second.state).toBe("dead");
  });

  it("recusa spawn depois do shutdown", async () => {
    const { spawner } = makeFakeSpawner({});
    const host = new ExtensionHostImpl({ spawner, createPortPair: memoryPortPair, handshakeTimeoutMs: 500 });
    await host.shutdown();

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.shutdown/);
  });
});
