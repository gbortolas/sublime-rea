/**
 * Apoio de teste do módulo `core/extension` (não é um teste; fica fora do build via `__tests__/**`).
 *
 * Provê um par de portas **em memória** compatível com `BridgePort` (entrega assíncrona por
 * microtask, como um `MessagePort` real) — os testes nunca abrem Electron.
 *
 * Também provê o **processo hospedado falso**, que reproduz o canal nativo do
 * `utilityProcess`: `postMessage`/`on("message")` são a mensageria do processo e `hostPort` é o
 * `process.parentPort` do filho (é onde a ponte do host é criada).
 */
import type { BridgePort, ExtensionEvents, ExtensionMethods } from "../../../shared";
import { createBridgeInternal, type MethodHandlers } from "../bridge";
import { OPS_HASH } from "../ops";
import type { HostProcess, HostProcessEventName, HostProcessEvents } from "../host";

export interface MemoryPortPair {
  readonly a: BridgePort;
  readonly b: BridgePort;
}

function makePort(own: Set<(value: unknown) => void>, peer: Set<(value: unknown) => void>): BridgePort {
  const port: BridgePort = {
    postMessage: (message: unknown): void => {
      for (const listener of [...peer]) queueMicrotask(() => listener(message));
    },
    on: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") own.add(listener);
      return port;
    },
    off: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") own.delete(listener);
      return port;
    },
    start: (): void => {
      /* nada: entrega já é assíncrona por microtask */
    },
    close: (): void => {
      own.clear();
    },
  };
  return port;
}

/** Par de portas ligadas: o que `a` posta chega aos listeners de `b` (e vice-versa). */
export function createMemoryPortPair(): MemoryPortPair {
  const aListeners = new Set<(value: unknown) => void>();
  const bListeners = new Set<(value: unknown) => void>();
  return {
    a: makePort(aListeners, bListeners),
    b: makePort(bListeners, aListeners),
  };
}

/**
 * Canal **de processo** em memória — a topologia do `utilityProcess`:
 * `parent` é o que o núcleo usa (`postMessage` + `on("message")`) e `child` é o que o processo
 * filho usaria (o `process.parentPort`).
 */
export interface MemoryProcessChannel {
  readonly parent: BridgePort;
  readonly child: BridgePort;
}

export function createMemoryProcessChannel(): MemoryProcessChannel {
  const pair = createMemoryPortPair();
  return { parent: pair.a, child: pair.b };
}

/** Captura tudo que chega numa porta (sem interferir no dispatch). */
export function collect(port: BridgePort): unknown[] {
  const messages: unknown[] = [];
  port.on("message", (message: unknown) => {
    messages.push(message);
  });
  return messages;
}

/** Esvazia a fila de microtasks/macrotasks (entrega de mensagens em memória). */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ── processo hospedado falso ───────────────────────────────────────────────────────────────

export interface MemoryHostOptions {
  readonly apiVersion?: string;
  readonly opsHash?: string;
  readonly hostVersion?: string;
  /** Se `true`, o host não responde o handshake (testa o timeout do núcleo). */
  readonly silent?: boolean;
  readonly handlers?: Partial<MethodHandlers<ExtensionMethods>>;
  /**
   * Canal externo a usar (default: um novo, criado em memória). Permite que o teste injete
   * a mesma ponta `core` na fábrica do canal do `ExtensionHost`.
   */
  readonly channel?: MemoryProcessChannel;
}

function isBootstrapEnvelope(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { readonly kind?: unknown }).kind === "bootstrap"
  );
}

/**
 * Processo hospedado falso: o canal é o do processo (nada de portas transferidas) e o
 * "filho" abre a ponte no `hostPort` quando recebe o bootstrap — como o entry real.
 */
export class MemoryHostProcess implements HostProcess {
  readonly pid = 4242;
  killed = false;
  /** Envelopes que o núcleo mandou ao processo (inspeção). */
  readonly sent: unknown[] = [];
  /** Mensagens que o "filho" recebeu do núcleo (inspeção). */
  readonly hostMessages: unknown[] = [];
  /** O `process.parentPort` do falso filho — onde a ponte do host é criada. */
  readonly hostPort: BridgePort;

  private readonly channel: MemoryProcessChannel;
  private readonly options: MemoryHostOptions;
  private readonly listeners = new Map<HostProcessEventName, Set<(...args: never[]) => void>>();

  constructor(options: MemoryHostOptions = {}) {
    this.options = options;
    this.channel = options.channel ?? createMemoryProcessChannel();
    this.hostPort = this.channel.child;

    this.hostPort.on("message", (message: unknown) => {
      this.hostMessages.push(message);
    });
    this.hostPort.on("message", this.onBootstrap);
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
    // Núcleo → filho: entrega no lado "criança" do canal do processo.
    this.channel.parent.postMessage(message);
  }

  on<E extends HostProcessEventName>(event: E, listener: HostProcessEvents[E]): void {
    if (event === "message") {
      // As mensagens do filho chegam pelo **canal do processo** (o lado "pai").
      this.channel.parent.on("message", listener as unknown as (message: unknown) => void);
      return;
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as unknown as (...args: never[]) => void);
  }

  off(_event: "message", listener: (message: unknown) => void): void {
    this.channel.parent.off?.("message", listener);
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

  /** O falso filho: consome o bootstrap, abre a ponte e responde o handshake. */
  private readonly onBootstrap = (message: unknown): void => {
    if (!isBootstrapEnvelope(message)) return;
    this.hostPort.off?.("message", this.onBootstrap);
    createBridgeInternal<ExtensionMethods, ExtensionEvents>(this.hostPort, {
      handlers: this.options.handlers ?? {},
      initialState: "spawned",
    });
    if (this.options.silent) return;
    queueMicrotask(() => {
      this.hostPort.postMessage({
        kind: "ready",
        hostVersion: this.options.hostVersion ?? "fake-host-0.0.1",
        apiVersion: this.options.apiVersion ?? "1.0",
        opsHash: this.options.opsHash ?? OPS_HASH,
      });
    });
  };
}
