/**
 * Scribe — `ExtensionHost`: gerencia os processos de host de plugins (`DEC-IPC-1/2/11`).
 *
 * Fonte: `docs/architecture/03-extensao-e-ipc.md` (`DEC-IPC-1/2/10/11/12`) e
 * `docs/architecture/06-padroes-transversais.md` §9 (handshake + ciclo de vida).
 *
 * Decisões nossas (escolha nossa; apoiadas nos docs):
 * - **O canal é o nativo do `utilityProcess`** (⚠️ revisão de 2026-10): o desenho original
 *   (`DEC-IPC-2/3`) previa o núcleo criar um `MessageChannelMain` e **transferir** uma das
 *   portas ao processo. Isso é **inviável no Electron 38**: `utilityProcess.postMessage` não
 *   clona `MessagePortMain` (nem ports de `worker_threads`) — falha com
 *   *"An object could not be cloned."*. Hoje o canal **é** a mensageria do processo: o núcleo
 *   encapsula o filho como `BridgePort` (`postMessage` → `child.postMessage`,
 *   `on("message")` → `child.on("message")`) e o filho encapsula o `process.parentPort`.
 *   O par de portas transferidas (DEC-IPC-2/3) fica, portanto, **só no papel**.
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

/**
 * Par de portas do canal núcleo↔host.
 *
 * ⚠️ O par **transferido** (`DEC-IPC-2/3`) não existe mais: nenhuma porta pode ser
 * transferida via `utilityProcess.postMessage` (Electron 38 clona só dados). O canal é o
 * **nativo do processo** — o núcleo cria a ponta `core` (adaptador sobre o processo filho)
 * e o **filho** cria a ponta `host` (o `process.parentPort`).
 */
export interface PortPair {
  /** Lado do núcleo — o `ExtensionHost` fala por aqui. */
  readonly core: BridgePort;
  /**
   * Lado do host — só existe **dentro do processo filho** (é o `process.parentPort`);
   * no núcleo é `undefined` (o canal do processo é 1:1).
   */
  readonly host?: BridgePort;
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
  /**
   * Envia uma mensagem ao processo. **Sem transferência de portas** — o canal nativo do
   * `utilityProcess` só clona dados (portas ⇒ *"An object could not be cloned."*).
   */
  postMessage(message: unknown): void;
  on<E extends HostProcessEventName>(event: E, listener: HostProcessEvents[E]): void;
  /** Remove um listener de `"message"` (a ponte desliga o canal no `close()`). */
  off(event: "message", listener: (message: unknown) => void): void;
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
  /**
   * Fábrica do canal núcleo↔host. Recebe o processo hospedado — o canal padrão **depende**
   * dele (é a própria mensageria do processo), então a fábrica só pode rodar **depois**
   * do spawn. Default: {@link createElectronPortPair}.
   */
  readonly createPortPair?: (child: HostProcess) => PortPair | Promise<PortPair>;
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

/**
 * Ambiente do processo hospedado: herda o do processo atual (é o default do
 * `utilityProcess.fork`) e aplica os overrides do caller.
 */
function buildEnv(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(overrides ?? {}) };
}

// ── implementação ──────────────────────────────────────────────────────────────────────────

export class ExtensionHostImpl implements ExtensionHost {
  private readonly spawner: HostSpawner;
  private readonly createPortPair: (child: HostProcess) => PortPair | Promise<PortPair>;
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
    // O filho herda o ambiente do processo (default do `utilityProcess`) + overrides.
    const env: Record<string, string> = buildEnv(opts.env);
    const handle = makeHandle<"HostHandle">(this.nextSlot, 1);
    this.nextSlot += 1;

    const ready = new Deferred<Handshake>();
    const exited = new Deferred<{ readonly code: number | null }>();

    // 1) **O processo primeiro**: o canal padrão é a própria mensageria dele (DEC-IPC-1).
    let child: HostProcess;
    try {
      child = await this.spawner.spawn(entry, { env, name });
    } catch (err) {
      throw toError(err);
    }

    // 2) O canal (ponta `core`) + a ponte — ambos dependem do processo vivo.
    let pair: PortPair;
    try {
      pair = await this.createPortPair(child);
    } catch (err) {
      child.kill();
      throw toError(err);
    }

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

    // 3) Listeners de "exit"/"error" — o filho pode morrer antes (ou logo depois) do ready.
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

    // 4) Bootstrap: **só dados** — o canal é o do processo, nenhuma porta é transferida.
    try {
      child.postMessage({ kind: "bootstrap", name });
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
      // O `HostProcess` do Electron (`utilityProcess`) tem `pid`; o fake de teste não ⇒ opcional.
      pid: "pid" in child && typeof child.pid === "number" ? child.pid : undefined,
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

/**
 * Adapta o **canal nativo** de um processo hospedado à interface `BridgePort`:
 * `postMessage` → `child.postMessage`; `on("message")` → `child.on("message")`.
 *
 * É o substituto do `MessageChannelMain` transferido (DEC-IPC-2/3): nenhuma porta pode ser
 * transferida via `utilityProcess.postMessage` (Electron 38 ⇒ *"An object could not be
 * cloned."*), então o par de pontas **é** o canal do processo — uma ponta aqui (núcleo) e a
 * outra no filho (o `process.parentPort`).
 */
export function createProcessPort(child: HostProcess): BridgePort {
  const port: BridgePort = {
    postMessage: (message: unknown): void => {
      child.postMessage(message);
    },
    on: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") child.on("message", listener);
      return port;
    },
    off: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") child.off("message", listener);
      return port;
    },
    start: (): void => {
      /* a mensageria do processo já está ativa */
    },
    close: (): void => {
      /* o processo é encerrado pelo `ExtensionHost` (`child.kill()`) */
    },
  };
  return port;
}

/**
 * Canal do processo hospedado: a ponta `core` (lado do núcleo) é o adaptador sobre a
 * mensageria do `utilityProcess`; a ponta `host` é criada **no filho** (o
 * `process.parentPort`) — por isso não existe no núcleo.
 */
export function createElectronPortPair(child: HostProcess): PortPair {
  return { core: createProcessPort(child) };
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
    /**
     * **wrapper** registrado no processo ↔ listener original pedido pelo cliente.
     *
     * ⚠️ O `on` do processo registra um *wrapper* (o `utilityProcess` entrega mensagens
     * tipadas), mas o `off` recebia o listener **original** ⇒ `removeListener` não
     * encontrava nada e o wrapper **nunca saía** (vazamento + mensagem pós-`close`).
     * O mapa guarda o par para remover o wrapper certo.
     */
    const messageWrappers = new Map<
      (message: unknown) => void,
      ((message: unknown) => void)[]
    >();
    return {
      get pid(): number | undefined {
        return child.pid;
      },
      postMessage(message: unknown): void {
        // **Sem `transfer`**: o Electron 38 não clona `MessagePortMain` no
        // `utilityProcess.postMessage` (*"An object could not be cloned."*).
        child.postMessage(message);
      },
      on<E extends HostProcessEventName>(event: E, listener: HostProcessEvents[E]): void {
        if (event === "message") {
          const original = listener as unknown as (message: unknown) => void;
          const wrapper = (message: unknown): void => {
            original(message);
          };
          const registered = messageWrappers.get(original);
          if (registered === undefined) {
            messageWrappers.set(original, [wrapper]);
          } else {
            registered.push(wrapper);
          }
          child.on("message", wrapper);
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
      off(_event: "message", listener: (message: unknown) => void): void {
        const registered = messageWrappers.get(listener);
        const wrapper = registered?.pop();
        if (wrapper !== undefined) {
          child.removeListener("message", wrapper);
          if (registered !== undefined && registered.length === 0) {
            messageWrappers.delete(listener);
          }
          return;
        }
        child.removeListener("message", listener);
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
