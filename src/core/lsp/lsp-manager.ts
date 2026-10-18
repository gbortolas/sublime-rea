/**
 * Scribe — gerente de servidores LSP.
 *
 * Mantém o ciclo de vida de múltiplos servidores LSP, cada um responsável por um
 * conjunto de extensões de arquivo. Roteia operações de documento (open/change/close)
 * e pedidos de linguagem (completion/hover) para o servidor adequado.
 */

import { Emitter, type Event } from "../../shared/events";
import { type Disposable, DisposableStore } from "../../shared/disposable";
import type { LspServerConfig } from "../../shared/lsp-contract";
import { LspClient } from "./lsp-client";
import { LspStdioTransport } from "./lsp-transport";
import { LspError } from "./lsp-protocol";
import type { CompletionItem, Hover, Diagnostic, InitializeParams, Location, ReferenceParams, SignatureHelp, DocumentSymbol, RenameParams, PrepareRenameParams, WorkspaceEdit, Range, CodeAction, CodeActionParams } from "./lsp-protocol";

export class LspManager implements Disposable {
  private readonly clients = new Map<string, LspClient>();
  private readonly configs = new Map<string, LspServerConfig>();
  private readonly store = new DisposableStore();
  private readonly onDiagnosticsEmitter = new Emitter<{
    readonly uri: string;
    readonly diagnostics: readonly Diagnostic[];
  }>();

  /**
   * Diagnósticos publicados por qualquer servidor LSP, agregados num único evento.
   * O `uri` identifica o documento ao qual os diagnósticos se referem.
   */
  readonly onDiagnostics: Event<{
    readonly uri: string;
    readonly diagnostics: readonly Diagnostic[];
  }> = this.onDiagnosticsEmitter.event;

  constructor(configs: readonly LspServerConfig[]) {
    for (const config of configs) {
      this.configs.set(config.name, config);
    }
  }

  /**
   * Inicia um servidor LSP a partir da configuração fornecida.
   * Cria transporte + cliente, executa o handshake `initialize`/`initialized`
   * e conecta o encaminhamento de diagnósticos.
   */
  async startServer(config: LspServerConfig): Promise<LspClient> {
    if (this.clients.has(config.name)) {
      throw new LspError(
        "LSP_SERVER_ALREADY_STARTED",
        `Servidor "${config.name}" já iniciado`,
      );
    }

    const transport = new LspStdioTransport(
      config.spawn.command,
      [...config.spawn.args],
      config.spawn.env as Record<string, string> | undefined,
    );
    const client = new LspClient(transport);
    this.clients.set(config.name, client);
    this.store.add(client);

    // Encaminha diagnósticos deste servidor para o evento agregado
    client.onDiagnostics((params) => {
      this.onDiagnosticsEmitter.fire({
        uri: params.uri,
        diagnostics: [...params.diagnostics],
      });
    });

    const initParams: InitializeParams = {
      processId: process.pid,
      capabilities: {},
      clientInfo: { name: "Scribe" },
      rootUri: null,
      initializationOptions: config.initializationOptions,
    };

    await client.connect(initParams);
    return client;
  }

  /**
   * Retorna o cliente LSP que atende a extensão de arquivo fornecida
   * (sem ponto, ex.: `"ts"`, `"py"`), ou `undefined` se nenhum servidor
   * estiver registrado para ela.
   */
  getClient(extension: string): LspClient | undefined {
    for (const [name, client] of this.clients) {
      const config = this.configs.get(name);
      if (config && config.languages.includes(extension)) return client;
    }
    return undefined;
  }

  /** Notifica o servidor apropriado sobre a abertura de um documento. */
  openDocument(uri: string, languageId: string, text: string, version: number): void {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return;

    client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /** Notifica o servidor apropriado sobre a modificação de um documento. */
  changeDocument(uri: string, text: string, version: number): void {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return;

    client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Notifica o servidor apropriado sobre o fechamento de um documento. */
  closeDocument(uri: string): void {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return;

    client.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  /**
   * Solicita completação ao servidor adequado para o documento.
   * Retorna lista vazia se não houver servidor para a extensão.
   */
  async requestCompletion(
    uri: string,
    line: number,
    col: number,
  ): Promise<readonly CompletionItem[]> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return [];

    const result = await client.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line, character: col },
    });
    return extractCompletionItems(result);
  }

  /**
   * Solicita hover ao servidor adequado para o documento.
   * Retorna `null` se não houver servidor para a extensão.
   */
  async requestHover(
    uri: string,
    line: number,
    col: number,
  ): Promise<Hover | null> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return null;

    const result = await client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line, character: col },
    });
    return (result as Hover | null) ?? null;
  }

  /**
   * Solicita definição (go-to-definition) ao servidor adequado.
   * Retorna `null` se não houver servidor ou nenhuma definição encontrada.
   */
  async requestDefinition(
    uri: string,
    line: number,
    col: number,
  ): Promise<Location | null> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return null;

    const result = await client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line, character: col },
    });

    // LSP pode retornar Location, Location[], ou null
    if (result === null || result === undefined) return null;
    if (Array.isArray(result)) {
      return (result.length > 0 ? result[0] : null) as Location | null;
    }
    return result as Location;
  }

  /**
   * Solicita signature help ao servidor adequado.
   * Retorna `null` se não houver servidor.
   */
  async requestSignatureHelp(
    uri: string,
    line: number,
    col: number,
    triggerCharacter?: string,
  ): Promise<SignatureHelp | null> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return null;

    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line, character: col },
    };
    if (triggerCharacter !== undefined) {
      params.context = {
        triggerKind: 2, // triggerCharacter
        triggerCharacter,
        isRetrigger: false,
      };
    }

    const result = await client.sendRequest("textDocument/signatureHelp", params);
    return (result as SignatureHelp | null) ?? null;
  }

  /**
   * Solicita a lista de símbolos do documento (document symbols) ao servidor adequado.
   * Retorna array vazio se não houver servidor.
   */
  async requestDocumentSymbols(uri: string): Promise<readonly DocumentSymbol[]> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return [];

    const result = await client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    if (result === null || result === undefined) return [];
    if (Array.isArray(result)) return result as DocumentSymbol[];
    return [];
  }

  /**
   * Solicita rename (WorkspaceEdit) ao servidor adequado.
   * Retorna null se não houver servidor para a extensão.
   */
  async requestRename(
    uri: string,
    line: number,
    col: number,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return null;

    const result = await client.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line, character: col },
      newName,
    } satisfies RenameParams);
    return (result as WorkspaceEdit | null) ?? null;
  }

  /**
   * Solicita prepareRename ao servidor adequado.
   * Retorna null se não houver servidor, ou o Range / {range, placeholder} do símbolo.
   */
  async prepareRename(
    uri: string,
    line: number,
    col: number,
  ): Promise<Range | { range: Range; placeholder: string } | null> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return null;

    const result = await client.sendRequest("textDocument/prepareRename", {
      textDocument: { uri },
      position: { line, character: col },
    } satisfies PrepareRenameParams);
    return (result as Range | { range: Range; placeholder: string } | null) ?? null;
  }

  /**
   * Solicita referências (find references) ao servidor adequado para o documento.
   * Retorna array vazio se não houver servidor para a extensão.
   */
  async requestReferences(
    uri: string,
    line: number,
    col: number,
    includeDeclaration = true,
  ): Promise<readonly Location[]> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return [];

    const result = await client.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line, character: col },
      context: { includeDeclaration },
    } satisfies ReferenceParams);
    return (result as Location[]) ?? [];
  }

  /**
   * Solicita code actions ao servidor adequado para a posição do documento.
   * Retorna array vazio se não houver servidor para a extensão.
   */
  async requestCodeActions(
    uri: string,
    line: number,
    col: number,
    diagnostics: readonly Diagnostic[],
  ): Promise<readonly CodeAction[]> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return [];

    const result = await client.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: { line, character: col }, end: { line, character: col } },
      context: { diagnostics },
    } satisfies CodeActionParams);
    return (result as CodeAction[]) ?? [];
  }

  /** Desconecta todos os servidores LSP. */
  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const client of this.clients.values()) {
      promises.push(client.disconnect());
    }
    this.clients.clear();
    await Promise.allSettled(promises);
  }

  /** @inheritdoc */
  dispose(): void {
    this.store.dispose();
    this.onDiagnosticsEmitter.dispose();
    this.clients.clear();
  }

  // ── Internos ──────────────────────────────────────────────────────────────────────────────

  private extensionFromUri(uri: string): string {
    const idx = uri.lastIndexOf(".");
    if (idx === -1) return "";
    return uri.slice(idx + 1);
  }
}

/**
 * Extrai a lista de `CompletionItem` do formato de resposta do LSP.
 * O LSP pode retornar uma lista direta ou `{ isIncomplete, items }`.
 */
function extractCompletionItems(result: unknown): readonly CompletionItem[] {
  if (result === undefined || result === null) return [];
  if (Array.isArray(result)) return result as CompletionItem[];
  const obj = result as Record<string, unknown>;
  if (obj && Array.isArray(obj.items)) return obj.items as CompletionItem[];
  return [];
}