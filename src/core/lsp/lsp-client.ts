/**
 * Scribe — cliente JSON-RPC para LSP.
 *
 * Encapsula o transporte stdio e oferece uma API assíncrona tipada para enviar requests,
 * notificações e registrar handlers de notificação. Mantém correlação request/response
 * com timeout e expõe `onDiagnostics` como evento canônico.
 */

import { Emitter, type Event } from "../../shared/events";
import { Deferred } from "../../shared/async";
import { type Disposable, DisposableStore } from "../../shared/disposable";
import type { LspStdioTransport } from "./lsp-transport";
import {
  isResponseMessage,
  isNotificationMessage,
  LspError,
} from "./lsp-protocol";
import type {
  InitializeParams,
  InitializeResult,
  PublishDiagnosticsParams,
  JsonRpcMessage,
  RequestMessage,
  ResponseMessage,
  NotificationMessage,
} from "./lsp-protocol";

// ── Tipos internos ──────────────────────────────────────────────────────────────────────────

interface PendingRequest {
  readonly deferred: Deferred<unknown>;
  readonly timer: ReturnType<typeof setTimeout>;
}

// ── Cliente ──────────────────────────────────────────────────────────────────────────────────

export class LspClient implements Disposable {
  private nextId = 1;
  private initializedFlag = false;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly store = new DisposableStore();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly onDiagnosticsEmitter = new Emitter<PublishDiagnosticsParams>();
  private readonly onNotificationEmitter = new Emitter<{
    readonly method: string;
    readonly params: unknown;
  }>();

  /** Evento disparado ao receber `textDocument/publishDiagnostics`. */
  readonly onDiagnostics: Event<PublishDiagnosticsParams> = this.onDiagnosticsEmitter.event;

  /**
   * Evento genérico disparado para **toda** notificação recebida.
   * Útil para debug ou integrações que não têm handler específico registrado.
   */
  readonly onRawNotification: Event<{
    readonly method: string;
    readonly params: unknown;
  }> = this.onNotificationEmitter.event;

  constructor(
    private readonly transport: LspStdioTransport,
    private readonly requestTimeoutMs: number = 15000,
  ) {
    this.store.add(transport.onMessage((raw) => this.handleMessage(raw)));
  }

  /** `true` após o handshake `initialize`/`initialized` ser concluído. */
  get initialized(): boolean {
    return this.initializedFlag;
  }

  /**
   * Conecta o transporte, executa o handshake LSP (`initialize` → `initialized`)
   * e retorna as `ServerCapabilities` do servidor.
   */
  async connect(initializeParams: InitializeParams): Promise<InitializeResult> {
    if (this.initializedFlag) {
      throw new LspError("LSP_ALREADY_INITIALIZED", "Cliente já inicializado");
    }

    await this.transport.connect();

    const result = (await this.sendRequest(
      "initialize",
      initializeParams,
    )) as InitializeResult;
    this.sendNotification("initialized");
    this.initializedFlag = true;
    return result;
  }

  /**
   * Envia um request JSON-RPC e aguarda a resposta correspondente.
   * Lança `LspError` em caso de timeout, erro de transporte ou resposta com `error`.
   */
  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.transport.connected) {
      throw new LspError("LSP_NOT_CONNECTED", "Transport não conectado");
    }

    const id = this.nextId++;
    const deferred = new Deferred<unknown>();

    const timer = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(
        new LspError(
          "LSP_TIMEOUT",
          `Request ${method} (#${id}) timed out after ${this.requestTimeoutMs}ms`,
        ),
      );
    }, this.requestTimeoutMs);

    this.pending.set(id, { deferred, timer });

    const msg: RequestMessage = params !== undefined
      ? { jsonrpc: "2.0", id, method, params }
      : { jsonrpc: "2.0", id, method };
    this.transport.send(JSON.stringify(msg));

    return deferred.promise;
  }

  /** Envia uma notificação JSON-RPC (fire-and-forget). */
  sendNotification(method: string, params?: unknown): void {
    if (!this.transport.connected) {
      throw new LspError("LSP_NOT_CONNECTED", "Transport não conectado");
    }
    const msg: NotificationMessage = params !== undefined
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", method };
    this.transport.send(JSON.stringify(msg));
  }

  /**
   * Registra um handler para uma notificação específica (pelo `method`).
   * Retorna um `Disposable` que remove o handler quando descartado.
   */
  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return {
      dispose: (): void => {
        const set = this.notificationHandlers.get(method);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) {
          this.notificationHandlers.delete(method);
        }
      },
    };
  }

  /**
   * Envia `shutdown` + `exit` e depois fecha o transporte.
   * Erros durante o shutdown são engolidos (o servidor pode já ter morrido).
   */
  async disconnect(): Promise<void> {
    if (this.initializedFlag) {
      try {
        await this.sendRequest("shutdown");
      } catch {
        // servidor pode já ter encerrado — ignora
      }
      // `exit` é notificação, não espera resposta
      this.sendNotification("exit");
    }
    this.transport.disconnect();
    this.initializedFlag = false;
  }

  /** @inheritdoc */
  dispose(): void {
    this.store.dispose();
    this.onDiagnosticsEmitter.dispose();
    this.onNotificationEmitter.dispose();
    for (const { deferred, timer } of this.pending.values()) {
      clearTimeout(timer);
      deferred.reject(new LspError("LSP_CLOSED", "Cliente descartado"));
    }
    this.pending.clear();
    this.initializedFlag = false;
  }

  // ── Internos ──────────────────────────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return; // ignora JSON inválido
    }

    if (isResponseMessage(parsed)) {
      this.handleResponse(parsed);
    } else if (isNotificationMessage(parsed)) {
      this.handleNotification(parsed);
    }
    // Requests vindos do servidor são ignorados (não implementamos
    // envio de requests do cliente para o servidor além do initialize).
  }

  private handleResponse(msg: ResponseMessage): void {
    const id = msg.id;
    if (id === null) return; // resposta sem id é inválida
    const pending = this.pending.get(id);
    if (!pending) return; // resposta órfã (timeout ou id desconhecido)
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.deferred.reject(
        new LspError(`LSP_${msg.error.code}`, msg.error.message),
      );
    } else {
      pending.deferred.resolve(msg.result);
    }
  }

  private handleNotification(msg: NotificationMessage): void {
    this.onNotificationEmitter.fire({ method: msg.method, params: msg.params });

    if (msg.method === "textDocument/publishDiagnostics") {
      this.onDiagnosticsEmitter.fire(msg.params as PublishDiagnosticsParams);
    }

    const handlers = this.notificationHandlers.get(msg.method);
    if (handlers) {
      for (const handler of handlers) {
        handler(msg.params);
      }
    }
  }
}