/**
 * Scribe — cliente JSON-RPC para LSP.
 *
 * Encapsula o transporte stdio e oferece uma API assíncrona tipada para enviar requests,
 * notificações e registrar handlers de notificação. Mantém correlação request/response
 * com timeout e expõe `onDiagnostics` como evento canônico.
 *
 * ⚠️ **Requests servidor→cliente**: o LSP é bidirecional — o servidor também pede coisas
 * ao cliente (`workspace/configuration`, `workspace/applyEdit`, `client/registerCapability`…).
 * O `pyright`, por exemplo, **envia** `workspace/configuration` e **fica bloqueado**
 * esperando a resposta; se o cliente fica em silêncio, o servidor inteiro trava (não há
 * símbolo, nem diagnóstico, nem hover). Por isso **todo** request do servidor recebe
 * resposta — método desconhecido inclusive (erro `-32601`, nunca silêncio).
 */

import { Emitter, type Event } from "../../shared/events";
import { Deferred } from "../../shared/async";
import { type Disposable, DisposableStore } from "../../shared/disposable";
import type { LspStdioTransport } from "./lsp-transport";
import {
  isResponseMessage,
  isNotificationMessage,
  isRequestMessage,
  jsonrpcErrorCodes,
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
  ClientRequestHandler,
  Registration,
} from "./lsp-protocol";
import { readConfigurationItems, readRegistrations } from "./lsp-protocol";

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
  /** Handlers dos requests **servidor→cliente** (por `method`). */
  private readonly requestHandlers = new Map<string, ClientRequestHandler>();
  /** Capabilities registradas dinamicamente pelo servidor (`method` → `id` → registro). */
  private readonly dynamicRegistrations = new Map<string, Map<string, Registration>>();
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
    this.installDefaultRequestHandlers();
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
   * Registra (ou **sobrescreve**) o handler de um request **servidor→cliente**.
   *
   * É o gancho usado pelo `LspManager` para responder com o estado do editor (pastas de
   * workspace, configuração por seção). O handler devolve o `result` da resposta; se
   * lançar, o cliente responde com um erro JSON-RPC (o servidor nunca fica esperando).
   * Um handler **assíncrono** também vale — a resposta é enviada quando a promise resolve.
   *
   * Devolve um `Disposable` que **restaura** o handler anterior (ou o default).
   */
  setRequestHandler(method: string, handler: ClientRequestHandler): Disposable {
    const previous = this.requestHandlers.get(method);
    this.requestHandlers.set(method, handler);
    return {
      dispose: (): void => {
        if (previous === undefined) {
          this.requestHandlers.delete(method);
        } else {
          this.requestHandlers.set(method, previous);
        }
      },
    };
  }

  /**
   * Capabilities registradas dinamicamente pelo servidor (`client/registerCapability`).
   *
   * O Scribe **não** usa registro dinâmico (todas as capabilities são declaradas no
   * `initialize`), mas o registro é guardado para diagnóstico — e o servidor recebe
   * sempre a resposta `null` (nada de travar esperando).
   */
  get registrations(): ReadonlyMap<string, ReadonlyMap<string, Registration>> {
    return this.dynamicRegistrations;
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
    this.requestHandlers.clear();
    this.dynamicRegistrations.clear();
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
    } else if (isRequestMessage(parsed)) {
      // Request **servidor→cliente**: tem `id` **e** `method`.
      this.handleServerRequest(parsed);
    }
  }

  /**
   * Responde a um request **servidor→cliente**.
   *
   * Regra de ouro: **nunca** deixar o servidor esperando. Sem handler para o método ⇒
   * erro `-32601` (`MethodNotFound`) — silêncio travaria o servidor inteiro (o `pyright`
   * bloqueia no `workspace/configuration` e não responde mais a nada).
   */
  private handleServerRequest(msg: RequestMessage): void {
    const rawId: unknown = (msg as { readonly id?: unknown }).id;
    if (typeof rawId !== "number" && typeof rawId !== "string") {
      // Sem `id` não há correlação possível — responde com `id: null` (o servidor ignora).
      this.sendErrorResponse(
        null,
        jsonrpcErrorCodes.InvalidRequest,
        `Request sem id válido: ${msg.method}`,
      );
      return;
    }
    const id = rawId;
    const handler = this.requestHandlers.get(msg.method);

    if (handler === undefined) {
      this.sendErrorResponse(
        id,
        jsonrpcErrorCodes.MethodNotFound,
        `Método não suportado pelo cliente: ${msg.method}`,
      );
      return;
    }

    let result: unknown;
    try {
      result = handler(msg.params);
    } catch (err) {
      this.sendErrorResponse(
        id,
        jsonrpcErrorCodes.InternalError,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // Handler assíncrono: a resposta só pode ser enviada quando o `result` resolver
    // (serializar a promise daria `{}` — resposta errada que também trava o servidor).
    if (isThenable(result)) {
      result.then(
        (value: unknown) => this.sendResultResponse(id, value),
        (err: unknown) =>
          this.sendErrorResponse(
            id,
            jsonrpcErrorCodes.InternalError,
            err instanceof Error ? err.message : String(err),
          ),
      );
      return;
    }

    this.sendResultResponse(id, result);
  }

  /** Envia o `result` de um request do servidor (`undefined` ⇒ `null`, o "void" do LSP). */
  private sendResultResponse(id: number | string | null, result: unknown): void {
    this.sendRaw({
      jsonrpc: "2.0",
      id,
      result: result === undefined ? null : result,
    });
  }

  /** Envia uma resposta de **erro** a um request do servidor. */
  private sendErrorResponse(id: number | string | null, code: number, message: string): void {
    this.sendRaw({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * Envia uma mensagem crua sem deixar a falha de transporte derrubar o handler
   * (o `handleMessage` roda dentro do callback do transporte).
   */
  private sendRaw(msg: ResponseMessage): void {
    try {
      this.transport.send(JSON.stringify(msg));
    } catch (err) {
      console.warn("[lsp] falha ao responder request do servidor:", err);
    }
  }

  /**
   * Instala os handlers **padrão** dos requests servidor→cliente.
   *
   * Todos devolvem uma resposta **válida** ao protocolo — o objetivo é destravar o
   * servidor, não implementar o LSP inteiro:
   * - `workspace/configuration` ⇒ array com uma entrada por item pedido (`null` = sem config);
   * - `workspace/workspaceFolders` ⇒ `null` (as pastas reais vêm do `LspManager`);
   * - `workspace/applyEdit` ⇒ `{ applied: false }` (o Scribe **não** aplica edits do servidor);
   * - `client/registerCapability` / `client/unregisterCapability` ⇒ `null` (registro guardado);
   * - `window/workDoneProgress/create` e os requests de `refresh` ⇒ `null` (nada a fazer).
   */
  private installDefaultRequestHandlers(): void {
    this.requestHandlers.set("workspace/configuration", (params) =>
      // Uma entrada por item pedido — o servidor casa por posição.
      readConfigurationItems(params).map(() => null),
    );
    this.requestHandlers.set("workspace/workspaceFolders", () => null);
    this.requestHandlers.set("workspace/applyEdit", () => ({ applied: false }));
    this.requestHandlers.set("client/registerCapability", (params) => {
      this.registerDynamicCapabilities(params);
      return null;
    });
    this.requestHandlers.set("client/unregisterCapability", (params) => {
      this.unregisterDynamicCapabilities(params);
      return null;
    });
    this.requestHandlers.set("window/workDoneProgress/create", () => null);
    for (const method of [
      "workspace/semanticTokens/refresh",
      "workspace/codeLens/refresh",
      "workspace/inlayHint/refresh",
      "workspace/diagnostic/refresh",
    ]) {
      this.requestHandlers.set(method, () => null);
    }
  }

  /** Guarda as capabilities registradas dinamicamente pelo servidor. */
  private registerDynamicCapabilities(params: unknown): void {
    for (const registration of readRegistrations(params)) {
      let byId = this.dynamicRegistrations.get(registration.method);
      if (!byId) {
        byId = new Map();
        this.dynamicRegistrations.set(registration.method, byId);
      }
      byId.set(registration.id, registration);
    }
  }

  /** Remove as capabilities unregistered pelo servidor. */
  private unregisterDynamicCapabilities(params: unknown): void {
    for (const registration of readRegistrations(params)) {
      this.dynamicRegistrations.get(registration.method)?.delete(registration.id);
    }
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

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

/** O valor é uma promise (handler assíncrono)? */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}