/**
 * Scribe — `ExtensionBridge`: multiplexador request/response sobre **um** port (DEC-IPC-3/4/9/10/12).
 *
 * Fonte: `docs/architecture/03-extensao-e-ipc.md` (DEC-IPC-1..12) e
 * `docs/architecture/06-padroes-transversais.md` §5/§9. Este arquivo é a **implementação** do
 * contrato congelado em `src/shared/extension-contract.ts`; nada aqui redefine aqueles tipos.
 *
 * Decisões nossas (escolha nossa; não observadas no alvo), todas apoiadas nos docs:
 * - **Um único port multiplexado** para requisições, notificações e eventos (D4, `DEC-IPC-12`).
 * - **Correlação por `id`** explícito — nada de framing manual (`DEC-IPC-4`) nem do *escape*
 *   `data[0]==0` do alvo (`DEC-IPC-9`).
 * - **Cancelamento por `AbortSignal`** → envia `CoreToHost{kind:"cancel"}` e rejeita com
 *   `CancellationError` (`DEC-IPC-9`).
 * - **Timeout por requisição** (nada de "pendura para sempre", §9) e **backpressure** de fila
 *   limitada → erro alto, nunca bloqueia a main (`DEC-IPC-10`).
 * - **Envelope desconhecido ⇒ `ProtocolError` + estado `dead`** — nunca silencioso (`DEC-TR-5`).
 *
 * Vocabulário do wire usado por esta ponte (o port é o mesmo nas duas pontas, então a ponte é
 * simétrica):
 * - `request`  → `CoreToHost{kind:"call", id, method, args}`; resposta `{kind:"result"|"error", id}`.
 * - `cancel`   → `CoreToHost{kind:"cancel", id}` (pedido de um `request` abortado).
 * - `notify`   → `HostToCore{kind:"notify", method, args}` (fire-and-forget).
 * - eventos    ← `HostToCore{kind:"emit", event, payload}` (dispatch para `on(event)`).
 * - handshake  ← `HostToCore{kind:"ready", hostVersion, apiVersion, opsHash}`.
 * - entrada de `call`/`notify` despacha para os `handlers` de método injetados.
 */
import {
  CancellationError,
  Deferred,
  Emitter,
  EXTENSION_BRIDGE_VERSION,
  ProtocolError,
  toDisposable,
  toError,
} from "../../shared";
import type {
  ArgsOf,
  BridgePort,
  CoreToHost,
  Disposable,
  Event,
  ExtensionBridge,
  ExtensionBridgeVersion,
  ExtensionEvents,
  ExtensionMethods,
  HandlerOf,
  HostState,
  HostToCore,
  ResultOf,
  RpcError,
} from "../../shared";

/** Mapa de handlers de método — permite retorno assíncrono onde o contrato é síncrono. */
export type MethodHandlers<M> = {
  readonly [K in keyof M & string]: (...args: ArgsOf<M[K]>) => MethodResult<M[K]>;
};

type MethodResult<F> = F extends (...a: never[]) => infer R ? Awaited<R> | Promise<Awaited<R>> : never;

/** Handles opacos do timer (injeção de dependência para teste determinístico). */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface BridgeTimer {
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(token: TimerHandle): void;
}

const defaultTimer: BridgeTimer = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (token) => {
    clearTimeout(token);
  },
};

/** Handshake observado no `HostToCore.ready`. */
export interface Handshake {
  readonly hostVersion: string;
  readonly apiVersion: ExtensionBridgeVersion;
  readonly opsHash: string;
}

export interface BridgeOptions<M = ExtensionMethods, E = ExtensionEvents> {
  /** Versão da ponte anunciada localmente (default = `EXTENSION_BRIDGE_VERSION`). */
  readonly version?: ExtensionBridgeVersion;
  /** Timeout default por requisição, em ms. */
  readonly timeoutMs?: number;
  /** Teto de requisições simultâneas (backpressure). */
  readonly maxPending?: number;
  /** Handlers dos métodos recebidos via `call`/`notify`. */
  readonly handlers?: Partial<MethodHandlers<M>>;
  /** Notificado quando a ponte detecta violação de protocolo (nunca silencioso). */
  readonly onProtocolError?: (error: ProtocolError) => void;
  /** Notificado no `ready` do peer (usado pelo `ExtensionHost` para validar o handshake). */
  readonly onHandshake?: (handshake: Handshake) => void;
  /** Estado inicial (o `ExtensionHost` começa em `handshaking`). */
  readonly initialState?: HostState;
  readonly timer?: BridgeTimer;
  /** Nomes de evento aceitos; um `emit` fora da lista vira `ProtocolError`. */
  readonly knownEvents?: readonly (keyof E & string)[];
}

/** Variante interna, com membros de controle que o `ExtensionHost` precisa. */
export interface BridgeInternals<M, E> extends ExtensionBridge<M, E> {
  readonly pendingCount: number;
  readonly handshake: Handshake | null;
  readonly onStateChange: Event<HostState>;
  /** O `ExtensionHost` dirige `spawned`/`handshaking`/`draining`; a ponte cuida de `ready`/`dead`. */
  setState(state: HostState): void;
}

/** Erro tipado devolvido por um handler de método (implementa o `RpcError` do contrato). */
export class RpcCallError extends Error implements RpcError {
  readonly code: string;
  readonly data: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = "RpcCallError";
    this.code = error.code;
    this.data = error.data;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PENDING = 1024;

interface PendingEntry {
  readonly deferred: Deferred<unknown>;
  readonly timer: TimerHandle;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

type RawHandler = (...args: readonly unknown[]) => unknown;

class BridgeImpl<M, E> implements BridgeInternals<M, E> {
  private readonly portImpl: BridgePort;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly timer: BridgeTimer;
  private readonly handlers: Partial<MethodHandlers<M>>;
  private readonly onProtocolError: ((error: ProtocolError) => void) | undefined;
  private readonly onHandshake: ((handshake: Handshake) => void) | undefined;
  private readonly knownEvents: ReadonlySet<string> | undefined;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly stateEmitter = new Emitter<HostState>();
  private readonly messageListener: (value: unknown) => void;
  private nextId = 1;
  private stateFlag: HostState;
  private versionFlag: ExtensionBridgeVersion;
  private handshakeFlag: Handshake | null = null;
  private closed = false;

  constructor(port: BridgePort, opts: BridgeOptions<M, E>) {
    this.portImpl = port;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.timer = opts.timer ?? defaultTimer;
    this.handlers = opts.handlers ?? {};
    this.onProtocolError = opts.onProtocolError;
    this.onHandshake = opts.onHandshake;
    this.knownEvents = opts.knownEvents ? new Set(opts.knownEvents) : undefined;
    this.stateFlag = opts.initialState ?? "handshaking";
    this.versionFlag = opts.version ?? EXTENSION_BRIDGE_VERSION;
    this.messageListener = (value: unknown): void => this.receive(value);
    port.on("message", this.messageListener);
    port.start?.();
  }

  get port(): BridgePort | null {
    return this.closed ? null : this.portImpl;
  }

  get state(): HostState {
    return this.stateFlag;
  }

  get version(): ExtensionBridgeVersion {
    return this.versionFlag;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get handshake(): Handshake | null {
    return this.handshakeFlag;
  }

  get onStateChange(): Event<HostState> {
    return this.stateEmitter.event;
  }

  setState(state: HostState): void {
    if (this.stateFlag === state) return;
    this.stateFlag = state;
    this.stateEmitter.fire(state);
  }

  request<K extends keyof M & string>(
    method: K,
    args: ArgsOf<M[K]>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<ResultOf<M[K]>> {
    return this.send(method as string, args as readonly unknown[], opts) as Promise<ResultOf<M[K]>>;
  }

  notify(method: string, args: readonly unknown[]): void {
    if (this.closed || this.stateFlag === "dead") {
      throw new ProtocolError("bridge.closed", `ponte morta; notify "${method}" recusado`);
    }
    this.post({ kind: "notify", method, args });
  }

  on<K extends keyof E & string>(event: K, handler: HandlerOf<E[K]>): Disposable {
    let set = this.eventHandlers.get(event);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(event, set);
    }
    const fn = handler as unknown as (payload: unknown) => void;
    set.add(fn);
    return toDisposable(() => {
      const current = this.eventHandlers.get(event);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) this.eventHandlers.delete(event);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setState("dead");
    const reason = new CancellationError("ponte fechada");
    for (const [id, entry] of [...this.pending]) {
      this.finish(id, entry);
      entry.deferred.reject(reason);
    }
    this.pending.clear();
    this.portImpl.off?.("message", this.messageListener);
    this.portImpl.close?.();
    this.stateEmitter.dispose();
  }

  // ── envio ────────────────────────────────────────────────────────────────────────────────

  private send(
    method: string,
    args: readonly unknown[],
    opts?: { readonly signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed || this.stateFlag === "dead") {
      return Promise.reject(new ProtocolError("bridge.closed", `ponte morta; "${method}" recusado`));
    }
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(
        new ProtocolError(
          "bridge.backpressure",
          `fila cheia (${this.maxPending} pendentes); "${method}" recusado`,
        ),
      );
    }
    const signal = opts?.signal;
    if (signal?.aborted) {
      return Promise.reject(new CancellationError(describeReason(signal.reason)));
    }

    const id = this.nextId;
    this.nextId += 1;
    const deferred = new Deferred<unknown>();
    const timer = this.timer.setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.finish(id, entry);
      entry.deferred.reject(
        new ProtocolError("bridge.timeout", `"${method}" excedeu ${this.timeoutMs} ms (id=${id})`),
      );
    }, this.timeoutMs);
    const onAbort = signal
      ? (): void => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.finish(id, entry);
          if (!this.closed) this.post({ kind: "cancel", id });
          entry.deferred.reject(new CancellationError(describeReason(signal.reason)));
        }
      : undefined;
    if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });

    this.pending.set(id, { deferred, timer, signal, onAbort });
    this.post({ kind: "call", id, method, args });
    return deferred.promise;
  }

  private post(message: CoreToHost | HostToCore): void {
    this.portImpl.postMessage(message);
  }

  // ── recepção ─────────────────────────────────────────────────────────────────────────────

  private receive(raw: unknown): void {
    if (this.closed) return;
    const value = unwrapMessageEvent(raw);
    let message: HostToCore | CoreToHost;
    try {
      message = parseEnvelope(value);
    } catch (err) {
      this.fail(toProtocolError(err));
      return;
    }
    switch (message.kind) {
      case "ready":
        this.handleReady(message);
        break;
      case "result":
        this.settle(message.id, message.value);
        break;
      case "error":
        this.settleError(message.id, message.error);
        break;
      case "cancel":
        this.handleCancel(message.id);
        break;
      case "call":
        void this.handleCall(message.id, message.method, message.args);
        break;
      case "notify":
        void this.handleNotify(message.method, message.args);
        break;
      case "emit":
        this.handleEmit(message.event, message.payload);
        break;
    }
  }

  private handleReady(message: Extract<HostToCore, { kind: "ready" }>): void {
    const handshake: Handshake = {
      hostVersion: message.hostVersion,
      apiVersion: message.apiVersion,
      opsHash: message.opsHash,
    };
    this.handshakeFlag = handshake;
    this.versionFlag = message.apiVersion;
    this.setState("ready");
    this.onHandshake?.(handshake);
    this.emitEvent("ready", []);
  }

  private settle(id: number, value: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return; // resposta tardia de uma requisição já cancelada/estourada — ignorada
    this.finish(id, entry);
    entry.deferred.resolve(value);
  }

  private settleError(id: number, error: RpcError): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.finish(id, entry);
    entry.deferred.reject(new RpcCallError(error));
  }

  private handleCancel(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.finish(id, entry);
    entry.deferred.reject(new CancellationError("cancelado pelo par"));
  }

  private async handleCall(id: number, method: string, args: readonly unknown[]): Promise<void> {
    const handler = this.lookupHandler(method);
    if (!handler) {
      this.report(new ProtocolError("bridge.unknown-method", `método sem handler: "${method}"`));
      this.post({
        kind: "error",
        id,
        ok: false,
        error: { code: "method.unknown", message: `método sem handler: "${method}"` },
      });
      return;
    }
    try {
      const value = await handler(...args);
      this.post({ kind: "result", id, ok: true, value });
    } catch (err) {
      this.post({ kind: "error", id, ok: false, error: toRpcError(err) });
    }
  }

  private async handleNotify(method: string, args: readonly unknown[]): Promise<void> {
    const handler = this.lookupHandler(method);
    if (!handler) {
      this.report(new ProtocolError("bridge.unknown-method", `notify de método sem handler: "${method}"`));
      return;
    }
    try {
      await handler(...args);
    } catch (err) {
      this.report(
        new ProtocolError("bridge.notify-failed", `notify "${method}" falhou: ${toError(err).message}`),
      );
    }
  }

  private handleEmit(event: string, payload: unknown): void {
    if (this.knownEvents && !this.knownEvents.has(event)) {
      this.report(new ProtocolError("bridge.unknown-event", `evento não negociado: "${event}"`));
      return;
    }
    this.emitEvent(event, [payload]);
  }

  private lookupHandler(method: string): RawHandler | undefined {
    const table = this.handlers as unknown as Record<string, RawHandler | undefined>;
    const handler = table[method];
    return typeof handler === "function" ? handler : undefined;
  }

  private emitEvent(name: string, args: readonly unknown[]): void {
    const set = this.eventHandlers.get(name);
    if (!set || set.size === 0) return;
    let firstError: unknown;
    for (const handler of [...set]) {
      if (!set.has(handler)) continue;
      try {
        (handler as unknown as RawHandler)(...args);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private finish(id: number, entry: PendingEntry): void {
    this.pending.delete(id);
    this.timer.clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }

  private fail(error: ProtocolError): void {
    if (this.stateFlag === "dead") return;
    this.setState("dead");
    for (const [id, entry] of [...this.pending]) {
      this.finish(id, entry);
      entry.deferred.reject(error);
    }
    this.pending.clear();
    this.onProtocolError?.(error);
  }

  /** Violação de protocolo sem morte da ponte (ex.: método desconhecido num `notify`). */
  private report(error: ProtocolError): void {
    this.onProtocolError?.(error);
  }
}

// ── parsing do envelope ────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRpcError(value: unknown): value is RpcError {
  return (
    isRecord(value) && typeof value["code"] === "string" && typeof value["message"] === "string"
  );
}

function isBridgeVersion(value: unknown): value is ExtensionBridgeVersion {
  return typeof value === "string" && /^\d+\.\d+$/.test(value);
}

/** Valida e normaliza um envelope recebido; envelope desconhecido ⇒ `ProtocolError`. */
export function parseEnvelope(value: unknown): HostToCore | CoreToHost {
  if (!isRecord(value)) {
    throw new ProtocolError("bridge.envelope", "mensagem não é um objeto");
  }
  const kind = value["kind"];
  switch (kind) {
    case "ready": {
      if (
        typeof value["hostVersion"] !== "string" ||
        !isBridgeVersion(value["apiVersion"]) ||
        typeof value["opsHash"] !== "string"
      ) {
        throw new ProtocolError("bridge.envelope", "envelope ready malformado");
      }
      return {
        kind: "ready",
        hostVersion: value["hostVersion"],
        apiVersion: value["apiVersion"],
        opsHash: value["opsHash"],
      };
    }
    case "result": {
      if (typeof value["id"] !== "number" || value["ok"] !== true) {
        throw new ProtocolError("bridge.envelope", "envelope result malformado");
      }
      return { kind: "result", id: value["id"], ok: true, value: value["value"] };
    }
    case "error": {
      if (typeof value["id"] !== "number" || value["ok"] !== false || !isRpcError(value["error"])) {
        throw new ProtocolError("bridge.envelope", "envelope error malformado");
      }
      return { kind: "error", id: value["id"], ok: false, error: value["error"] };
    }
    case "call": {
      if (typeof value["id"] !== "number" || typeof value["method"] !== "string" || !Array.isArray(value["args"])) {
        throw new ProtocolError("bridge.envelope", "envelope call malformado");
      }
      return { kind: "call", id: value["id"], method: value["method"], args: value["args"] };
    }
    case "notify": {
      if (typeof value["method"] !== "string" || !Array.isArray(value["args"])) {
        throw new ProtocolError("bridge.envelope", "envelope notify malformado");
      }
      return { kind: "notify", method: value["method"], args: value["args"] };
    }
    case "emit": {
      if (typeof value["event"] !== "string") {
        throw new ProtocolError("bridge.envelope", "envelope emit malformado");
      }
      return { kind: "emit", event: value["event"], payload: value["payload"] };
    }
    case "cancel": {
      if (typeof value["id"] !== "number") {
        throw new ProtocolError("bridge.envelope", "envelope cancel malformado");
      }
      return { kind: "cancel", id: value["id"] };
    }
    default:
      throw new ProtocolError("bridge.unknown-envelope", `envelope desconhecido: kind=${String(kind)}`);
  }
}

/**
 * `Electron.MessagePortMain` entrega um `MessageEvent`, enquanto `worker_threads`/portas em memória
 * entregam o valor cru. Normaliza para o envelope nos dois casos.
 */
function unwrapMessageEvent(raw: unknown): unknown {
  if (isRecord(raw) && "data" in raw && !("kind" in raw)) {
    return raw["data"];
  }
  return raw;
}

function toProtocolError(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) return err;
  return new ProtocolError("bridge.protocol", toError(err).message);
}

function toRpcError(err: unknown): RpcError {
  if (err instanceof RpcCallError) {
    return err.data === undefined ? { code: err.code, message: err.message } : { code: err.code, message: err.message, data: err.data };
  }
  if (isRecord(err) && typeof err["code"] === "string" && typeof err["message"] === "string") {
    return isRpcError(err) ? err : { code: err["code"], message: err["message"] };
  }
  return { code: "method.error", message: toError(err).message };
}

function describeReason(reason: unknown): string {
  if (reason === undefined) return "cancelado";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

// ── versão da ponte ────────────────────────────────────────────────────────────────────────

export function parseBridgeVersion(version: ExtensionBridgeVersion): { major: number; minor: number } {
  const [major = "0", minor = "0"] = version.split(".");
  return { major: Number(major), minor: Number(minor) };
}

/**
 * Compatibilidade do handshake (DEC-IPC-11): mesmo *major* e *minor* do host ≤ o nosso. Um host
 * mais novo (minor maior) pode falar coisas que não entendemos; recusamos cedo e alto.
 */
export function isCompatibleVersion(
  candidate: ExtensionBridgeVersion,
  ours: ExtensionBridgeVersion = EXTENSION_BRIDGE_VERSION,
): boolean {
  const c = parseBridgeVersion(candidate);
  const o = parseBridgeVersion(ours);
  return c.major === o.major && c.minor <= o.minor;
}

// ── fábricas ───────────────────────────────────────────────────────────────────────────────

/** Ponte com o mapa padrão (`ExtensionMethods`/`ExtensionEvents`). */
export function createBridge(port: BridgePort, opts: BridgeOptions = {}): ExtensionBridge {
  return createBridgeInternal<ExtensionMethods, ExtensionEvents>(port, opts);
}

/** Variante tipada — usada pelos testes com mapas próprios e pelo `ExtensionHost`. */
export function createBridgeInternal<M, E>(
  port: BridgePort,
  opts: BridgeOptions<M, E> = {},
): BridgeInternals<M, E> {
  return new BridgeImpl<M, E>(port, opts);
}
