/**
 * Scribe — cliente DAP (Debug Adapter Protocol).
 *
 * Encapsula o transporte stdio e oferece uma API assíncrona tipada: envia requisições
 * (correlacionadas por `request_seq`), registra handlers de evento e expõe os eventos
 * canônicos (`stopped`, `output`, `terminated`, `initialized`).
 *
 * Diferença estrutural do LSP: o DAP é **assimétrico** — o cliente abre a conversa, mas o
 * adaptador também pode emitir requisições reversas (`runInTerminal`, …). Como o Scribe não
 * implementa essas capacidades, respondemos `success: false` para que o adaptador não fique
 * esperando para sempre.
 */

import { Emitter, type Event } from "../../shared/events";
import { Deferred } from "../../shared/async";
import { type Disposable, DisposableStore } from "../../shared/disposable";
import type { DapStdioTransport } from "./dap-transport";
import {
  DapError,
  DapRequestError,
  isDapEvent,
  isDapRequest,
  isDapResponse,
} from "./dap-protocol";
import type {
  DapMessage,
  DapRequest,
  DapResponse,
  DapEvent,
  DapInitializedEventBody,
  DapOutputEventBody,
  DapStoppedEventBody,
  DapTerminatedEventBody,
} from "./dap-protocol";

// ── Tipos internos ──────────────────────────────────────────────────────────────────────────

interface PendingRequest {
  readonly command: string;
  readonly deferred: Deferred<unknown>;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface DapEventEnvelope {
  readonly event: string;
  readonly body: unknown;
}

// ── Cliente ──────────────────────────────────────────────────────────────────────────────────

export class DapClient implements Disposable {
  private nextSeq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly store = new DisposableStore();
  private readonly eventHandlers = new Map<string, Set<(body: unknown) => void>>();

  /**
   * Histórico curto dos últimos eventos — permite `waitForEvent` não perder um evento que
   * chegou **antes** de o interesse ser registrado (ex.: `initialized` chega logo após o
   * `initialize`).
   */
  private readonly recentEvents: { readonly event: string; readonly body: unknown }[] = [];
  private readonly recentEventWaiters = new Map<
    string,
    Set<(body: unknown) => void>
  >();

  private readonly onEventEmitter = new Emitter<DapEventEnvelope>();
  private readonly onStoppedEmitter = new Emitter<DapStoppedEventBody>();
  private readonly onOutputEmitter = new Emitter<DapOutputEventBody>();
  private readonly onTerminatedEmitter = new Emitter<DapTerminatedEventBody>();
  private readonly onInitializedEmitter = new Emitter<DapInitializedEventBody>();
  private readonly onBreakpointEmitter = new Emitter<{
    readonly reason: string;
    readonly breakpoint: unknown;
  }>();

  /** Toda mensagem de evento recebida (`method` + corpo). */
  readonly onEvent: Event<DapEventEnvelope> = this.onEventEmitter.event;
  /** Evento `stopped` (o programa pausou). */
  readonly onStopped: Event<DapStoppedEventBody> = this.onStoppedEmitter.event;
  /** Evento `output` (stdout/stderr/console do programa). */
  readonly onOutput: Event<DapOutputEventBody> = this.onOutputEmitter.event;
  /** Evento `terminated` (a sessão terminou). */
  readonly onTerminated: Event<DapTerminatedEventBody> = this.onTerminatedEmitter.event;
  /** Evento `initialized` (o adaptador está pronto para receber breakpoints/configurationDone). */
  readonly onInitialized: Event<DapInitializedEventBody> = this.onInitializedEmitter.event;
  /** Evento `breakpoint` (um breakpoint mudou de estado). */
  readonly onBreakpoint: Event<{ readonly reason: string; readonly breakpoint: unknown }> =
    this.onBreakpointEmitter.event;

  constructor(
    private readonly transport: DapStdioTransport,
    private readonly requestTimeoutMs: number = 15000,
  ) {
    // `Event<T>` devolve um `Disposable` — o store chama `.dispose()` nos itens.
    this.store.add(transport.onMessage((raw) => this.handleMessage(raw)));
  }

  /** Conecta o transporte (dispara o processo do adaptador). */
  async connect(): Promise<void> {
    if (this.transport.connected) {
      throw new DapError("DAP_ALREADY_CONNECTED", "Cliente já conectado");
    }
    await this.transport.connect();
  }

  /**
   * Envia uma requisição DAP e aguarda a resposta correspondente.
   * Lança `DapError` em timeout/transporte e `DapRequestError` se `success: false`.
   */
  async sendRequest(command: string, args?: unknown): Promise<unknown> {
    if (!this.transport.connected) {
      throw new DapError("DAP_NOT_CONNECTED", "Transport não conectado");
    }

    const seq = this.nextSeq++;
    const deferred = new Deferred<unknown>();

    const timer = setTimeout(() => {
      this.pending.delete(seq);
      deferred.reject(
        new DapError(
          "DAP_TIMEOUT",
          `Requisição ${command} (#${seq}) não respondeu em ${this.requestTimeoutMs}ms`,
        ),
      );
    }, this.requestTimeoutMs);

    this.pending.set(seq, { command, deferred, timer });

    const msg: DapRequest = args !== undefined
      ? { seq, type: "request", command, arguments: args }
      : { seq, type: "request", command };
    this.transport.send(JSON.stringify(msg));

    return deferred.promise;
  }

  /**
   * Registra um handler para um evento específico (pelo nome).
   * Retorna um `Disposable` que remove o handler quando descartado.
   */
  onNotification(event: string, handler: (body: unknown) => void): Disposable {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return {
      dispose: (): void => {
        const set = this.eventHandlers.get(event);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) this.eventHandlers.delete(event);
      },
    };
  }

  /**
   * Aguarda o próximo evento com o nome dado. Resolve imediatamente se o evento já chegou
   * recentemente (histórico curto), e rejeita por `DapError("DAP_TIMEOUT")` após `timeoutMs`.
   */
  waitForEvent(event: string, timeoutMs: number = 5000): Promise<unknown> {
    const recent = this.recentEvents.find((e) => e.event === event);
    if (recent) return Promise.resolve(recent.body);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const set = this.recentEventWaiters.get(event);
        set?.delete(onEvent);
        if (set !== undefined && set.size === 0) this.recentEventWaiters.delete(event);
        reject(
          new DapError(
            "DAP_TIMEOUT",
            `Evento "${event}" não chegou em ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const onEvent = (body: unknown): void => {
        clearTimeout(timer);
        resolve(body);
      };

      let waiters = this.recentEventWaiters.get(event);
      if (!waiters) {
        waiters = new Set();
        this.recentEventWaiters.set(event, waiters);
      }
      waiters.add(onEvent);
    });
  }

  /** Encerra a sessão: envia `disconnect` (best-effort) e fecha o transporte. */
  async disconnect(terminateDebuggee = true): Promise<void> {
    if (this.transport.connected) {
      try {
        await this.sendRequest("disconnect", { terminateDebuggee });
      } catch {
        // o adaptador pode já ter encerrado — ignora
      }
    }
    this.transport.disconnect();
  }

  /** @inheritdoc */
  dispose(): void {
    this.store.dispose();
    this.onEventEmitter.dispose();
    this.onStoppedEmitter.dispose();
    this.onOutputEmitter.dispose();
    this.onTerminatedEmitter.dispose();
    this.onInitializedEmitter.dispose();
    this.onBreakpointEmitter.dispose();
    for (const { deferred, timer } of this.pending.values()) {
      clearTimeout(timer);
      deferred.reject(new DapError("DAP_CLOSED", "Cliente descartado"));
    }
    this.pending.clear();
  }

  // ── Internos ──────────────────────────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let parsed: DapMessage;
    try {
      parsed = JSON.parse(raw) as DapMessage;
    } catch {
      return; // ignora JSON inválido
    }

    if (isDapResponse(parsed)) {
      this.handleResponse(parsed);
    } else if (isDapEvent(parsed)) {
      this.handleEvent(parsed);
    } else if (isDapRequest(parsed)) {
      this.handleReverseRequest(parsed);
    }
  }

  private handleResponse(msg: DapResponse): void {
    const pending = this.pending.get(msg.request_seq);
    if (!pending) return; // resposta órfã (timeout/descartado)
    this.pending.delete(msg.request_seq);
    clearTimeout(pending.timer);

    if (!msg.success) {
      pending.deferred.reject(
        new DapRequestError(msg.command, msg.message ?? "sem mensagem"),
      );
      return;
    }
    pending.deferred.resolve(msg.body);
  }

  private handleEvent(msg: DapEvent): void {
    this.recentEvents.push({ event: msg.event, body: msg.body });
    if (this.recentEvents.length > 16) this.recentEvents.shift();

    const waiters = this.recentEventWaiters.get(msg.event);
    if (waiters !== undefined) {
      for (const waiter of waiters) waiter(msg.body);
      this.recentEventWaiters.delete(msg.event);
    }

    this.onEventEmitter.fire({ event: msg.event, body: msg.body });

    const handlers = this.eventHandlers.get(msg.event);
    if (handlers) {
      for (const handler of handlers) handler(msg.body);
    }

    switch (msg.event) {
      case "stopped":
        this.onStoppedEmitter.fire(msg.body as DapStoppedEventBody);
        break;
      case "output":
        this.onOutputEmitter.fire(msg.body as DapOutputEventBody);
        break;
      case "terminated":
        this.onTerminatedEmitter.fire((msg.body ?? {}) as DapTerminatedEventBody);
        break;
      case "initialized":
        this.onInitializedEmitter.fire((msg.body ?? {}) as DapInitializedEventBody);
        break;
      case "breakpoint": {
        const body = (msg.body ?? {}) as { reason?: string; breakpoint?: unknown };
        this.onBreakpointEmitter.fire({
          reason: body.reason ?? "changed",
          breakpoint: body.breakpoint,
        });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Requisições **reversas** (adaptador → cliente). O Scribe não implementa nenhuma
   * (`runInTerminal`, `startDebugging`, …) e responde `success: false` explicitamente para
   * que o adaptador não fique esperando indefinidamente.
   */
  private handleReverseRequest(msg: DapRequest): void {
    const response: DapResponse = {
      seq: this.nextSeq++,
      type: "response",
      request_seq: msg.seq,
      success: false,
      command: msg.command,
      message: `Comando reverso "${msg.command}" não suportado pelo Scribe`,
    };
    if (this.transport.connected) {
      this.transport.send(JSON.stringify(response));
    }
  }
}