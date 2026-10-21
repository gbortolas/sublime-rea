import { describe, expect, it } from "vitest";

import { ExtensionHostImpl, type HostProcess, type HostSpawner } from "./host";
import {
  MemoryHostProcess,
  createMemoryProcessChannel,
  type MemoryHostOptions,
} from "./__tests__/support";

/** Spawner falso: cada spawn devolve um processo hospedado em memória (canal nativo). */
function makeFakeSpawner(options: MemoryHostOptions = {}): {
  spawner: HostSpawner;
  processes: MemoryHostProcess[];
} {
  const processes: MemoryHostProcess[] = [];
  const spawner: HostSpawner = {
    spawn: (): HostProcess => {
      const proc = new MemoryHostProcess(options);
      processes.push(proc);
      return proc;
    },
  };
  return { spawner, processes };
}

describe("ExtensionHostImpl — handshake", () => {
  it("spawn bem-sucedido entra em `ready`, conecta a ponte e troca requests", async () => {
    const { spawner, processes } = makeFakeSpawner({ handlers: { ping: () => "pong" as const } });
    const exits: { readonly code: number | null }[] = [];
    const host = new ExtensionHostImpl({
      spawner,
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

  it("bootstrap NÃO transporta porta (envelope serializável, canal é o do processo)", async () => {
    const { spawner, processes } = makeFakeSpawner({});
    const host = new ExtensionHostImpl({ spawner, handshakeTimeoutMs: 500 });

    const session = await host.spawn({ name: "test", entry: "/x.js" });
    const proc = processes[0]!;

    // O que o núcleo manda tem de ser **clonável** (o `utilityProcess.postMessage` só clona
    // dados — portar uma porta falha com "An object could not be cloned.").
    expect(proc.sent).toHaveLength(1);
    const bootstrap = proc.sent[0] as Record<string, unknown>;
    expect(bootstrap).toEqual({ kind: "bootstrap", name: "test" });
    expect("port" in bootstrap).toBe(false);
    expect(() => structuredClone(bootstrap)).not.toThrow();

    await session.dispose();
    await host.shutdown();
  });

  it("a fábrica do canal é injetável (transporte trocável em teste)", async () => {
    const channel = createMemoryProcessChannel();
    const processes: MemoryHostProcess[] = [];
    const spawner: HostSpawner = {
      spawn: (): HostProcess => {
        const proc = new MemoryHostProcess({ channel });
        processes.push(proc);
        return proc;
      },
    };
    const host = new ExtensionHostImpl({
      spawner,
      // O núcleo fala pelo lado "pai" do mesmo canal — nada de porta transferida.
      createPortPair: () => ({ core: channel.parent, host: channel.child }),
      handshakeTimeoutMs: 500,
    });

    const session = await host.spawn({ name: "test", entry: "/x.js" });
    expect(session.state).toBe("ready");
    expect(processes[0]?.killed).toBe(false);

    await session.dispose();
    await host.shutdown();
  });

  it("versão incompatível falha alto e mata o processo", async () => {
    const { spawner, processes } = makeFakeSpawner({ apiVersion: "2.0" });
    const host = new ExtensionHostImpl({ spawner, handshakeTimeoutMs: 500 });

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.version-mismatch/);
    expect(processes[0]?.killed).toBe(true);
    await host.shutdown();
  });

  it("opsHash divergente falha alto e mata o processo", async () => {
    const { spawner, processes } = makeFakeSpawner({ opsHash: "deadbeef" });
    const host = new ExtensionHostImpl({ spawner, handshakeTimeoutMs: 500 });

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.ops-hash-mismatch/);
    expect(processes[0]?.killed).toBe(true);
    await host.shutdown();
  });

  it("host que nunca fica ready estoura por timeout e é morto", async () => {
    const { spawner, processes } = makeFakeSpawner({ silent: true });
    const host = new ExtensionHostImpl({ spawner, handshakeTimeoutMs: 20 });

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.handshake-timeout/);
    expect(processes[0]?.killed).toBe(true);
    await host.shutdown();
  });
});

describe("ExtensionHostImpl — ciclo de vida", () => {
  it("shutdown drena todos os hosts", async () => {
    const { spawner, processes } = makeFakeSpawner({});
    const host = new ExtensionHostImpl({ spawner, handshakeTimeoutMs: 500 });

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
    const host = new ExtensionHostImpl({ spawner, handshakeTimeoutMs: 500 });
    await host.shutdown();

    await expect(host.spawn({ name: "test", entry: "/x.js" })).rejects.toThrowError(/host\.shutdown/);
  });
});
