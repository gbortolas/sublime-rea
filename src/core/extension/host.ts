/**
 * Scribe — `ExtensionHost`: gerencia os processos de host de plugins (`DEC-IPC-1/2/11`).
 *
 * Fonte: `docs/architecture/03-extensao-e-ipc.md` (`DEC-IPC-1/2/10/11/12`) e
 * `docs/architecture/06-padroes-transversais.md` §9 (handshake + ciclo de vida).
 *
 * Decisões nossas (escolha nossa; apoiadas nos docs):
 * - **O núcleo cria o par de portas e o transfere** ao processo (`DEC-IPC-2`: núcleo `create`, host
 *   só `open`). Em produção é um `MessageChannelMain`; nos testes, um par em memória injetado.
 * - **Processo por port injetável** (`HostSpawner`): produção usa
 *   `electron.utilityProcess.fork(entry, [], { env, stdio: "pipe" })`; teste usa um fake. Por isso
 *   `electron` **não** é importado estaticamente — só dinamicamente dentro das fábricas default.
 * - **Handshake valida cedo e alto** (`DEC-IPC-11`, §9): `HostToCore.ready` traz `apiVersion` e
 *   `opsHash`; versão incompatível ou hash divergente ⇒ `ProtocolError` + `kill`.
 * - **Máquina de estados** `spawned → handshaking → ready → draining → dead` (`06:364`).
 * - **Backpressure explícito** (`DEC-IPC-10`): teto de requisições pendentes na ponte ⇒ erro alto,
 *   a main nunca bloqueia.
 */
import {
  Deferred,
  Emitter,
  EXTENSION_BRIDGE_VERSION,
  makeHandle,
  ProtocolError,
  toError,
} from "../../shared";
import type {
  BridgePort,
  Event,
  ExtensionBridgeVersion,
  ExtensionEvents,
  ExtensionHost,
  ExtensionMethods,
  HostHandle,
  HostSession,
  HostState,
} from "../../shared";

import {
  createBridgeInternal,
  isCompatibleVersion,
  type BridgeInternals,
  type BridgeOptions,
  type BridgeTimer,
  type Handshake,
  type MethodHandlers,
} from "./bridge";
import { OPS_HASH } from "./ops";

// ── portas de processo (injetáveis) ────────────────────────────────────────────────────────

/** Par de portas criado **pelo núcleo**; a `host` é transferida ao processo (`DEC-IPC-2`). */
export interface PortPair {
  readonly core: BridgePort;
  readonly host: BridgePort;
}

/** Eventos que o processo hospedado pode reportar. */
export interface HostProcessEvents {
  readonly message: (message: unknown) => void;
  readonly exit: (code: number | null) => void;
  readonly error: (error: Error) => void;
}

export type HostProcessEventName = keyof HostProcessEvents;

/** Handle do processo hospedado — o mínimo que o `ExtensionHost` precisa. */
export interface HostProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on<E extends HostProcessEventName>(event: E, listener: HostProcessEvents[E]): void;
  kill(): void;
}

export interface HostSpawnOptions {
  readonly env: Record<string, string>;
  readonly name: string;
}

/** Port de spawn: produção = `utilityProcess`; teste = fake (nunca abre Electron). */
export interface HostSpawner {
  spawn(entry: string, options: HostSpawnOptions): HostProcess | Promise<HostProcess>;
}

// ── opções do host ─────────────────────────────────────────────────────────────────────────

export interface ExtensionHostOptions {
  readonly spawner?: HostSpawner;
  readonly createPortPair?: () => PortPair | Promise<PortPair>;
  /** Handlers dos métodos expostos ao host (`createMethodHandlers(deps)`). */
  readonly handlers?: Partial<MethodHandlers<ExtensionMethods>>;
  readonly apiVersion?: ExtensionBridgeVersion;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxPending?: number;
  readonly timer?: BridgeTimer;
  /** Violações de protocolo (nunca silenciosas). Default: `process.emitWarning`. */
  readonly onProtocolError?: (error: ProtocolError) => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PENDING = 1024;

/** Sink default: nunca silencioso (DEC-TR-5). */
function defaultProtocolErrorSink(error: ProtocolError): void {
  process.emitWarning(error);
}

// ── implementação ──────────────────────────────────────────────────────────────────────────

export class ExtensionHostImpl implements ExtensionHost {
  private readonly spawner: HostSpawner;
  private readonly createPortPair: () => PortPair | Promise<PortPair>;
  private readonly handlers: Partial<MethodHandlers<ExtensionMethods>> | undefined;
  private readonly apiVersion: ExtensionBridgeVersion;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxPending: number;
  private readonly timer: BridgeTimer | undefined;
  private readonly protocolErrorSink: (error: ProtocolError) => void;
  private readonly exitEmitter = new Emitter<{ readonly handle: HostHandle; readonly code: number | null }>();
  private readonly sessions = new Set<HostSession>();
  private nextSlot = 0;
  private isShutdown = false;

  constructor(opts: ExtensionHostOptions = {}) {
    this.spawner = opts.spawner ?? electronHostSpawner;
    this.createPortPair = opts.createPortPair ?? createElectronPortPair;
    this.handlers = opts.handlers;
    this.apiVersion = opts.apiVersion ?? EXTENSION_BRIDGE_VERSION;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.timer = opts.timer;
    this.protocolErrorSink = opts.onProtocolError ?? defaultProtocolErrorSink;
  }

  readonly onDidExit: Event<{ readonly handle: HostHandle; readonly code: number | null }> =
    this.exitEmitter.event;

  async spawn(opts: {
    readonly name: string;
    readonly entry: string;
    readonly env?: Record<string, string>;
  }): Promise<HostSession> {
    if (this.isShutdown) {
      throw new ProtocolError("host.shutdown", "ExtensionHost já encerrado; spawn recusado");
    }
    const { name, entry } = opts;
    const env: Record<string, string> = opts.env ? { ...opts.env } : {};
    const handle = makeHandle<"HostHandle">(this.nextSlot, 1);
    this.nextSlot += 1;

    const pair = await this.createPortPair();
    const ready = new Deferred<Handshake>();
    const exited = new Deferred<{ readonly code: number | null }>();

    const base: BridgeOptions<ExtensionMethods, ExtensionEvents> = {
      initialState: "handshaking",
      timeoutMs: this.requestTimeoutMs,
      maxPending: this.maxPending,
      onHandshake: (handshake) => {
        if (!ready.settled) ready.resolve(handshake);
      },
      onProtocolError: (error) => {
        this.protocolErrorSink(error);
        if (!ready.settled) ready.reject(error);
      },
    };
    const withTimer = this.timer !== undefined ? { ...base, timer: this.timer } : base;
    const bridgeOpts = this.handlers !== undefined ? { ...withTimer, handlers: this.handlers } : withTimer;
    const bridge: BridgeInternals<ExtensionMethods, ExtensionEvents> = createBridgeInternal<
      ExtensionMethods,
      ExtensionEvents
    >(pair.core, bridgeOpts);

    let child: HostProcess;
    try {
      child = await this.spawner.spawn(entry, { env, name });
    } catch (err) {
      await bridge.close();
      throw toError(err);
    }

    child.on("exit", (code) => {
      if (!ready.settled) {
        ready.reject(
          new ProtocolError("host.exited-before-ready", `host "${name}" saiu (code=${String(code)}) antes do ready`),
        );
      }
      if (!exited.settled) exited.resolve({ code });
      if (bridge.state !== "dead") bridge.setState("dead");
      this.exitEmitter.fire({ handle, code });
    });
    child.on("error", (error) => {
      this.protocolErrorSink(new ProtocolError("host.process-error", `host "${name}": ${error.message}`));
    });

    // Suppress ready.promise rejection if we never get to await it
    // (e.g., postMessage throws before we reach the await).
    ready.promise.catch(() => {});

    // O núcleo cria o canal e o transfere; o host só conecta (DEC-IPC-2).
    try {
      child.postMessage({ kind: "bootstrap", name, port: pair.host }, [pair.host]);
    } catch (err) {
      child.kill();
      await bridge.close();
      throw toError(err);
    }

    const timer = (this.timer ?? defaultTimer).setTimeout(() => {
      if (!ready.settled) {
        ready.reject(
          new ProtocolError(
            "host.handshake-timeout",
            `host "${name}" não ficou ready em ${this.handshakeTimeoutMs} ms`,
          ),
        );
      }
    }, this.handshakeTimeoutMs);

    let handshake: Handshake;
    try {
      handshake = await ready.promise;
    } catch (err) {
      (this.timer ?? defaultTimer).clearTimeout(timer);
      child.kill();
      await bridge.close();
      throw err instanceof Error ? err : toError(err);
    }
    (this.timer ?? defaultTimer).clearTimeout(timer);

    if (!isCompatibleVersion(handshake.apiVersion, this.apiVersion)) {
      child.kill();
      await bridge.close();
      throw new ProtocolError(
        "host.version-mismatch",
        `host "${name}": api ${handshake.apiVersion} incompatível com ${this.apiVersion}`,
      );
    }
    if (handshake.opsHash !== OPS_HASH) {
      child.kill();
      await bridge.close();
      throw new ProtocolError(
        "host.ops-hash-mismatch",
        `host "${name}": opsHash divergente (esperado ${OPS_HASH.slice(0, 12)}…)`,
      );
    }

    let disposed = false;
    const session: HostSession = {
      handle,
      name,
      get state(): HostState {
        return bridge.state;
      },
      bridge,
      get exited(): Promise<{ readonly code: number | null }> {
        return exited.promise;
      },
      dispose: async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        this.sessions.delete(session);
        bridge.setState("draining");
        await bridge.close();
        if (!exited.settled) child.kill();
        await exited.promise;
      },
    };
    this.sessions.add(session);
    return session;
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;
    const snapshot = [...this.sessions];
    await Promise.all(snapshot.map((session) => session.dispose()));
    this.exitEmitter.dispose();
  }
}

// ── fábricas default (produção) — `electron` só aqui, dinamicamente ─────────────────────────

/** Cria o par de portas do núcleo via `MessageChannelMain` (`DEC-IPC-2/3`). */
export async function createElectronPortPair(): Promise<PortPair> {
  const { MessageChannelMain } = await import("electron");
  const channel = new MessageChannelMain();
  return {
    core: channel.port1 as unknown as BridgePort,
    host: channel.port2 as unknown as BridgePort,
  };
}

/** Spawn por `utilityProcess.fork` — `stdio: "pipe"` para o host não poluir a main (`DEC-IPC-1`). */
export const electronHostSpawner: HostSpawner = {
  async spawn(entry: string, options: HostSpawnOptions): Promise<HostProcess> {
    const { utilityProcess } = await import("electron");
    const child = utilityProcess.fork(entry, [], {
      env: options.env,
      stdio: "pipe",
      serviceName: options.name,
    });
    return {
      get pid(): number | undefined {
        return child.pid;
      },
      postMessage(message: unknown, transfer?: readonly unknown[]): void {
        child.postMessage(message, transfer ? (transfer as never[]) : []);
      },
      on<E extends HostProcessEventName>(event: E, listener: HostProcessEvents[E]): void {
        if (event === "message") {
          child.on("message", (message: unknown) =>
            (listener as unknown as (m: unknown) => void)(message),
          );
        } else if (event === "exit") {
          child.on("exit", (code: number) =>
            (listener as unknown as (c: number | null) => void)(code),
          );
        } else {
          child.on("error", (type: string, location: string, report: string) =>
            (listener as unknown as (e: Error) => void)(
              new Error(`utilityProcess ${type} @ ${location}: ${report}`),
            ),
          );
        }
      },
      kill(): void {
        child.kill();
      },
    };
  },
};

const defaultTimer: BridgeTimer = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (token) => {
    clearTimeout(token);
  },
};
