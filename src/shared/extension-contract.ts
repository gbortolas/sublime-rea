/**
 * Scribe — contratos de fronteira: host de extensões, ponte e API tipada.
 *
 * Fonte: `docs/architecture/03-extensao-e-ipc.md` (DEC-IPC-1..12) e
 * `docs/architecture/06-padroes-transversais.md` (`OPS`/`HostState`/handshake).
 *
 * Reconciliações:
 * - `ExtensionBridge` aparece em `02:285` (`port`/`request`/`subscribe`) e em `03:279`
 *   (`request` tipado por método / `notify` / `on` / `close`). Canônico = **`03`** (doc dono do
 *   módulo IPC), absorvendo `port`. `subscribe(topic, ArrayBuffer)` de `02` não é uma segunda
 *   API: eventos entram por `on()` com payload tipado.
 * - `port: MessagePort` (`03:280`) → **`BridgePort` estrutural**: DOM `MessagePort`,
 *   `worker_threads.MessagePort` e `Electron.MessagePortMain` **satisfazem** sem import de
 *   runtime (clean-room: um só contrato para os três transportes).
 * - **Nome do método ≠ opcode**: a superfície tipada usa `"buffer.insert"`; a tabela `OPS`
 *   (`06:211`) associa cada nome a um **número denso** (a ordem é o contrato de wire) e o
 *   handshake carrega `opsHash` dessa tabela.
 *
 * Invariantes (DEC-IPC-1/2/5/10): o host é **processo separado**; o **núcleo cria o canal** e o
 * host só conecta; request/response por `id` explícito (nunca framing manual); chamada longa é
 * sempre `async` + `AbortSignal`; a main **nunca** é bloqueada (backpressure explícito);
 * opcode desconhecido **nunca** é silencioso.
 */
import type { Disposable } from "./disposable";
import type { Event } from "./events";
import type { DocumentHandle, HostHandle, ViewHandle } from "./handles";
import type { CommandBus } from "./buffer-contract";
import type { DocumentRegistry } from "./buffer-contract";
import type { PackageResolver } from "./packages-contract";

/** Versão do contrato da ponte — `"<major>.<minor>"` (DEC-IPC-11: handshake negocia). */
export type ExtensionBridgeVersion = `${number}.${number}`;

/** Versão que **este** scaffold implementa. */
export const EXTENSION_BRIDGE_VERSION: ExtensionBridgeVersion = "1.0";

export interface RpcError {
  code: string;
  message: string;
  data?: unknown;
}

/** Envelopes do host → núcleo (DEC-IPC-4). */
export type HostToCore =
  | { kind: "ready"; hostVersion: string; apiVersion: ExtensionBridgeVersion; opsHash: string }
  | { kind: "call"; id: number; method: string; args: readonly unknown[] }
  | { kind: "notify"; method: string; args: readonly unknown[] }
  | { kind: "emit"; event: string; payload: unknown };

/** Envelopes do núcleo → host. */
export type CoreToHost =
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "error"; id: number; ok: false; error: RpcError }
  | { kind: "call"; id: number; method: string; args: readonly unknown[] }
  | { kind: "cancel"; id: number };

/** Ciclo de vida do host (06:364). */
export type HostState = "spawned" | "handshaking" | "ready" | "draining" | "dead";

/**
 * Transporte mínimo aceito pela ponte: DOM `MessagePort`, `worker_threads` e
 * `Electron.MessagePortMain` são estruturalmente compatíveis.
 */
export interface BridgePort {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: "message", listener: (value: unknown) => void): this | unknown;
  off?(event: "message", listener: (value: unknown) => void): this | unknown;
  start?(): void;
  close?(): void;
}

/** Mapa de métodos expostos pelo núcleo ao host (contrato **gerado** — ordem = wire). */
export interface ExtensionMethods {
  ping(): "pong";
  "buffer.insert"(doc: DocumentHandle, at: number, text: string): number;
  "buffer.erase"(doc: DocumentHandle, at: number, length: number): number;
  "view.scroll"(view: ViewHandle, line: number): void;
  "documents.open"(path: string): DocumentHandle;
  "packages.resolve"(uri: string): { readonly uri: string; readonly size: number } | undefined;
}

/**
 * Eventos emitidos pelo núcleo para o host.
 *
 * Reconciliação: `03:268` escreve `ExtensionEvents` como **tuplas de argumentos**
 * (`ready: []`, `changed: [doc, …]`). Aqui vira **mapa de handlers** (`ready(): void`), que
 * tipa `on(...)` exatamente sem rest-param condicional. O wire continua sendo um **array de
 * argumentos** — a ponte converte nas duas pontas.
 */
export interface ExtensionEvents {
  ready(): void;
  changed(doc: DocumentHandle, delta: { readonly revision: number }): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export type ExtensionMethodName = keyof ExtensionMethods & string;
export type ExtensionEventName = keyof ExtensionEvents & string;

/** Argumentos de um método do mapa (vazio se não for função). */
export type ArgsOf<F> = F extends (...a: infer A extends readonly unknown[]) => unknown ? A : readonly unknown[];
/** Resultado **aguardado** de um método do mapa. */
export type ResultOf<F> = F extends (...a: never[]) => infer R ? Awaited<R> : unknown;
/** Tipo do handler de um evento (vazio se não for função). */
export type HandlerOf<F> = F extends (...a: never[]) => unknown ? F : never;

/** Tabela densa de opcodes (`06:211`): nome do método → número (1-based). A **ordem** é o contrato. */
export type OpsTable = Readonly<Record<ExtensionMethodName, number>>;

/**
 * Ponte núcleo ↔ host. Um único port multiplexado (DEC-IPC-12), com dispatch por **nome**
 * (DEC-IPC-6) e cancelamento por `id` (DEC-IPC-9).
 */
export interface ExtensionBridge<Methods = ExtensionMethods, Events = ExtensionEvents> {
  readonly port: BridgePort | null;
  readonly state: HostState;
  readonly version: ExtensionBridgeVersion;
  request<M extends keyof Methods & string>(
    method: M,
    args: ArgsOf<Methods[M]>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<ResultOf<Methods[M]>>;
  /** Sem resposta — mas erro de despacho ainda é alto em dev (DEC-TR-5). */
  notify(method: string, args: readonly unknown[]): void;
  on<E extends keyof Events & string>(event: E, handler: HandlerOf<Events[E]>): Disposable;
  close(): Promise<void>;
}

/** Sessão viva de um host de plugins. */
export interface HostSession {
  readonly handle: HostHandle;
  readonly name: string;
  readonly state: HostState;
  readonly bridge: ExtensionBridge;
  /** Resolve quando o processo termina (código `null` = sinal). */
  readonly exited: Promise<{ readonly code: number | null }>;
  dispose(): Promise<void>;
}

/** Gerente dos processos de host (`utilityProcess` — DEC-IPC-1). */
export interface ExtensionHost {
  spawn(opts: {
    readonly name: string;
    readonly entry: string;
    readonly env?: Record<string, string>;
  }): Promise<HostSession>;
  readonly onDidExit: Event<{ readonly handle: HostHandle; readonly code: number | null }>;
  shutdown(): Promise<void>;
}

/** Façade fina exposta ao código de plugin (DEC-IPC-7: sem estado próprio). */
export interface ExtensionAPI {
  readonly version: ExtensionBridgeVersion;
  readonly documents: DocumentRegistry;
  readonly commands: CommandBus;
  readonly packages: PackageResolver;
  on<E extends ExtensionEventName>(event: E, handler: HandlerOf<ExtensionEvents[E]>): Disposable;
}

/** Erro de protocolo — nunca engolido (DEC-TR-5). */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`ProtocolError[${code}]: ${message}`);
    this.name = "ProtocolError";
    this.code = code;
  }
}
