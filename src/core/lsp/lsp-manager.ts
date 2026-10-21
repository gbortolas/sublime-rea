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
import type { CompletionItem, Hover, Diagnostic, InitializeParams, InitializeResult, Location, ReferenceParams, SignatureHelp, DocumentSymbol, DocumentSymbolLike, SymbolInformation, RenameParams, PrepareRenameParams, WorkspaceEdit, Range, Position, CodeAction, CodeActionParams, TextEdit, DocumentFormattingParams, FoldingRange, FoldingRangeParams, InlayHint, InlayHintParams, WorkspaceFolder, ClientCapabilities, TextDocumentContentChangeEvent } from "./lsp-protocol";
import { SymbolKind, TextDocumentSyncKind } from "./lsp-protocol";

/**
 * Capacidades do cliente no `initialize`.
 *
 * ⚠️ **Não pode ser `{}`**: o `typescript-language-server` (e o `pyright`) derivam o
 * suporte a diagnósticos de `capabilities.textDocument.publishDiagnostics`
 * (`features.diagnosticsSupport = Boolean(publishDiagnostics)`) — sem ele o servidor
 * **não publica diagnóstico nenhum** e o app nunca mostra erro em `.ts`/`.py`
 * (achado ALTO da auditoria com runtime).
 *
 * Declaramos também `textDocument.synchronization.textDocumentSync = 1` (**full**):
 * o Scribe reescreve o documento inteiro a cada edição, então sincronização full é o
 * modo coerente com o que o app faz. Se o servidor **ignorar** o pedido e responder
 * `textDocumentSync.change = 2` (incremental), o `LspManager` respeita a resposta e
 * passa a mandar o **delta** (ver `changeDocument`).
 */
const CLIENT_CAPABILITIES: ClientCapabilities = {
  textDocument: {
    publishDiagnostics: { relatedInformation: true, versionSupport: true },
    synchronization: {
      didSave: true,
      dynamicRegistration: false,
      textDocumentSync: TextDocumentSyncKind.Full,
    },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
      },
    },
    definition: { linkSupport: true },
    codeAction: {
      resolveSupport: true,
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
      },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    foldingRange: {},
    references: {},
  },
  workspace: { workspaceFolders: true, configuration: true },
};

/** Documento sincronizado com o servidor (texto + início de cada linha). */
interface SyncedDocument {
  readonly text: string;
  /** Offset do início de cada linha do texto (para converter offset → posição LSP). */
  readonly lineStarts: readonly number[];
}

export class LspManager implements Disposable {
  private readonly clients = new Map<string, LspClient>();
  private readonly configs = new Map<string, LspServerConfig>();
  private readonly store = new DisposableStore();
  private readonly onDiagnosticsEmitter = new Emitter<{
    readonly uri: string;
    readonly diagnostics: readonly Diagnostic[];
  }>();

  /** Modo de sincronização **negociado** por servidor (`InitializeResult`). */
  private readonly syncKinds = new Map<string, TextDocumentSyncKind>();
  /** Último texto enviado por documento (só em modo incremental — base do delta). */
  private readonly syncedDocs = new Map<string, SyncedDocument>();

  /** Pastas de workspace atuais (null = nenhuma, array vazio = single-root sem pasta). */
  private _workspaceFolders: readonly WorkspaceFolder[] | null = null;

  /** Define as pastas de workspace. Envia `workspace/didChangeWorkspaceFolders` para servidores já conectados. */
  setWorkspaceFolders(folders: readonly WorkspaceFolder[] | null): void {
    const old = this._workspaceFolders;
    this._workspaceFolders = folders;
    if (old !== null && folders !== null) {
      // Envia notificação de mudança para servidores já inicializados
      const added = folders.filter((f) => !old.some((o) => o.uri === f.uri));
      const removed = old.filter((o) => !folders.some((f) => f.uri === o.uri));
      if (added.length > 0 || removed.length > 0) {
        for (const client of this.clients.values()) {
          if (client.initialized) {
            client.sendNotification("workspace/didChangeWorkspaceFolders", {
              event: {
                added: added.map((f) => ({ uri: f.uri, name: f.name })),
                removed: removed.map((f) => ({ uri: f.uri, name: f.name })),
              },
            });
          }
        }
      }
    }
  }

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
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: "Scribe" },
      rootUri: this._workspaceFolders !== null && this._workspaceFolders.length > 0
        ? this._workspaceFolders[0]!.uri
        : null,
      workspaceFolders: this._workspaceFolders,
      initializationOptions: config.initializationOptions,
    };

    try {
      const result = await client.connect(initParams);
      // O **servidor** decide o modo de sincronização: respeitamos a resposta (se vier
      // `change: 2`, mandamos delta; se vier `change: 1`/ausente, mandamos o texto inteiro).
      this.syncKinds.set(config.name, syncKindOf(result));
      return client;
    } catch (err) {
      // O stderr do servidor tem a **razão real** da falha (o sintoma é só "timeout").
      const stderrTail = transport.stderr.trim();
      if (stderrTail.length > 0) {
        console.warn(`Scribe: stderr do servidor LSP "${config.name}": ${stderrTail.slice(-600)}`);
      }
      // O servidor **não** subiu (comando ausente, handshake falho): tira ele do registro.
      // Sem isso, o cliente ficaria registrado mas desconectado e **toda** operação de
      // documento para aquela extensão quebraria com `LSP_NOT_CONNECTED` — inclusive a
      // simples abertura do arquivo (achado no E2E do P4#27).
      this.clients.delete(config.name);
      // Descarta o cliente **e** o transporte: sem isto, o processo do servidor que
      // falhou continua vivo (órfão) e o transporte fica com os listeners abertos.
      transport.dispose();
      client.dispose();
      throw err;
    }
  }

  /**
   * Retorna o cliente LSP que atende a extensão de arquivo fornecida
   * (sem ponto, ex.: `"ts"`, `"py"`), ou `undefined` se nenhum servidor
   * estiver registrado para ela.
   */
  getClient(extension: string): LspClient | undefined {
    return this.findServer(extension)?.client;
  }

  /** Notifica o servidor apropriado sobre a abertura de um documento. */
  openDocument(uri: string, languageId: string, text: string, version: number): void {
    const ext = this.extensionFromUri(uri);
    const found = this.findServer(ext);
    if (!found) return;

    this.notifySafely(found.client, "textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
    this.rememberDocument(uri, text, found.name);
  }

  /**
   * Notifica o servidor apropriado sobre a modificação de um documento.
   *
   * O **modo** de sincronização é o que o servidor declarou no `initialize`:
   * - **full** (`change: 1`): mandamos o documento inteiro (é o que o Scribe reescreve);
   * - **incremental** (`change: 2`): mandamos **só o delta** (prefixo/sufixo comuns) —
   *   sem isto, um arquivo de 1 MB mandaria 1 MB por tecla.
   *
   * Sem o texto anterior (documento aberto fora do gerente), o modo incremental não
   * tem como montar o delta ⇒ reenviamos o documento inteiro (`didClose` + `didOpen`).
   */
  changeDocument(uri: string, text: string, version: number): void {
    const ext = this.extensionFromUri(uri);
    const found = this.findServer(ext);
    if (!found) return;

    const kind = this.syncKinds.get(found.name) ?? TextDocumentSyncKind.Full;
    const previous = this.syncedDocs.get(uri);

    if (kind === TextDocumentSyncKind.Incremental && previous === undefined) {
      // Sem base para o delta: ressincroniza o documento inteiro.
      this.resyncDocument(found.client, found.name, uri, ext, text, version);
      return;
    }

    let contentChanges: readonly TextDocumentContentChangeEvent[];
    if (kind === TextDocumentSyncKind.Incremental && previous !== undefined) {
      const change = computeTextChange(previous, text);
      contentChanges = change !== null ? [change] : [];
    } else {
      contentChanges = [{ text }];
    }

    this.rememberDocument(uri, text, found.name);
    this.notifySafely(found.client, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges,
    });
  }

  /** Notifica o servidor apropriado sobre o fechamento de um documento. */
  closeDocument(uri: string): void {
    const ext = this.extensionFromUri(uri);
    const found = this.findServer(ext);
    this.syncedDocs.delete(uri);
    if (!found) return;

    this.notifySafely(found.client, "textDocument/didClose", {
      textDocument: { uri },
    });
  }

  /**
   * Envia uma notificação **sem** deixar a falha virar erro de edição.
   *
   * Um servidor que morreu (ou que nunca subiu) não pode derrubar a abertura/alteração do
   * documento: no máximo o recurso LSP daquele arquivo fica indisponível. A degradação é
   * declarada (1 `warn`), nunca silenciosa.
   */
  private notifySafely(client: LspClient, method: string, params: unknown): void {
    try {
      client.sendNotification(method, params);
    } catch (err) {
      console.warn(`[lsp] notificação "${method}" ignorada:`, err);
    }
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
   *
   * O servidor pode devolver a forma **hierárquica** (`DocumentSymbol`) ou a **plana**
   * (`SymbolInformation`, com o range em `location.range`) — as duas são normalizadas
   * aqui, e entradas malformadas são descartadas (o cliente nunca deve estourar por
   * causa do payload de um servidor).
   */
  async requestDocumentSymbols(uri: string): Promise<readonly DocumentSymbolLike[]> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return [];

    const result = await client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    return extractDocumentSymbols(result);
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

  /**
   * Solicita formatação de documento inteiro ao servidor adequado.
   * Retorna null se não houver servidor para a extensão.
   */
  async requestFormatting(
    uri: string,
    options?: { readonly tabSize?: number; readonly insertSpaces?: boolean },
  ): Promise<readonly TextEdit[] | null> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return null;

    const result = await client.sendRequest("textDocument/formatting", {
      textDocument: { uri },
      options: {
        tabSize: options?.tabSize ?? 2,
        insertSpaces: options?.insertSpaces ?? true,
      },
    } satisfies DocumentFormattingParams);
    return (result as TextEdit[]) ?? null;
  }

  /**
   * Solicita folding ranges ao servidor adequado para o documento.
   * Retorna array vazio se não houver servidor para a extensão.
   */
  async requestFoldingRange(uri: string): Promise<readonly FoldingRange[]> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return [];

    const result = await client.sendRequest("textDocument/foldingRange", {
      textDocument: { uri },
    } satisfies FoldingRangeParams);
    return (result as FoldingRange[]) ?? [];
  }

  /**
   * Solicita inlay hints ao servidor adequado para um range do documento.
   * Retorna array vazio se não houver servidor para a extensão.
   */
  async requestInlayHints(
    uri: string,
    range?: { readonly startLine: number; readonly startCol: number; readonly endLine: number; readonly endCol: number },
  ): Promise<readonly InlayHint[]> {
    const ext = this.extensionFromUri(uri);
    const client = this.getClient(ext);
    if (!client) return [];

    const params: InlayHintParams = {
      textDocument: { uri },
      ...(range !== undefined
        ? {
            range: {
              start: { line: range.startLine, character: range.startCol },
              end: { line: range.endLine, character: range.endCol },
            },
          }
        : {}),
    };
    const result = await client.sendRequest("textDocument/inlayHint", params);
    return (result as InlayHint[]) ?? [];
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
    this.syncKinds.clear();
    this.syncedDocs.clear();
  }

  // ── Internos ──────────────────────────────────────────────────────────────────────────────

  private extensionFromUri(uri: string): string {
    const idx = uri.lastIndexOf(".");
    if (idx === -1) return "";
    return uri.slice(idx + 1);
  }

  /** Servidor (cliente + nome) que atende a extensão — `undefined` se nenhum atender. */
  private findServer(extension: string): { readonly client: LspClient; readonly name: string } | undefined {
    for (const [name, client] of this.clients) {
      const config = this.configs.get(name);
      if (config && config.languages.includes(extension)) return { client, name };
    }
    return undefined;
  }

  /**
   * Guarda o texto sincronizado do documento (base do delta incremental).
   * Em modo **full** o texto é dispensável ⇒ não é guardado (memória).
   */
  private rememberDocument(uri: string, text: string, serverName: string): void {
    if ((this.syncKinds.get(serverName) ?? TextDocumentSyncKind.Full) !== TextDocumentSyncKind.Incremental) {
      this.syncedDocs.delete(uri);
      return;
    }
    this.syncedDocs.set(uri, { text, lineStarts: computeLineStarts(text) });
  }

  /** Reenvia o documento inteiro (`didClose` + `didOpen`) — usado sem base para o delta. */
  private resyncDocument(
    client: LspClient,
    serverName: string,
    uri: string,
    extension: string,
    text: string,
    version: number,
  ): void {
    this.notifySafely(client, "textDocument/didClose", { textDocument: { uri } });
    this.notifySafely(client, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: extension.length > 0 ? extension : "plaintext",
        version,
        text,
      },
    });
    this.rememberDocument(uri, text, serverName);
  }
}

// ── Sincronização de texto ─────────────────────────────────────────────────────────────────

/** Modo de sincronização declarado pelo servidor no `InitializeResult`. */
function syncKindOf(result: InitializeResult | undefined): TextDocumentSyncKind {
  const declared = result?.capabilities?.textDocumentSync;
  if (typeof declared === "number") return declared as TextDocumentSyncKind;
  if (declared !== undefined && typeof declared === "object" && typeof declared.change === "number") {
    return declared.change as TextDocumentSyncKind;
  }
  // Sem declaração ⇒ full (o padrão do LSP).
  return TextDocumentSyncKind.Full;
}

/** Deslocamento do início de cada linha do texto. */
function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    starts.push(idx + 1);
    idx = text.indexOf("\n", idx + 1);
  }
  return starts;
}

/** Converte um deslocamento (UTF-16) em posição LSP (linha/coluna). */
function positionAt(lineStarts: readonly number[], offset: number): Position {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - lineStarts[lo]! };
}

/** O índice cai no meio de um par substituto (emoji)? Não podemos cortar um par ao meio. */
function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/** Tamanho do bloco comparado por vez (comparação nativa, sem custo por caractere). */
const DIFF_CHUNK = 8192;

/** Comprimento do prefixo comum entre `a` e `b` (comparação em blocos). */
function commonPrefixLength(a: string, b: string, max: number): number {
  let i = 0;
  while (i < max) {
    const size = Math.min(DIFF_CHUNK, max - i);
    const chunk = a.slice(i, i + size);
    if (!b.startsWith(chunk, i)) {
      let j = i;
      while (j < i + size && a.charCodeAt(j) === b.charCodeAt(j)) j += 1;
      return j;
    }
    i += size;
  }
  return max;
}

/** Comprimento do sufixo comum entre `a` e `b` (comparação em blocos, de trás para frente). */
function commonSuffixLength(a: string, b: string, limit: number): number {
  let s = 0;
  while (s < limit) {
    const size = Math.min(DIFF_CHUNK, limit - s);
    const chunk = a.slice(a.length - size - s, a.length - s);
    if (!b.endsWith(chunk, b.length - s)) {
      let j = 0;
      while (
        j < size &&
        a.charCodeAt(a.length - 1 - s - j) === b.charCodeAt(b.length - 1 - s - j)
      ) {
        j += 1;
      }
      return s + j;
    }
    s += size;
  }
  return s;
}

/**
 * Delta entre o texto sincronizado e o novo texto.
 *
 * Estratégia: prefixo comum + sufixo comum (comparação em blocos, nativa) ⇒ o que
 * sobra é a região alterada. O range é calculado **no texto antigo** (é ele que o
 * servidor ainda tem) e o `text` é o trecho novo.
 *
 * `null` = o texto não mudou (nada a enviar).
 */
function computeTextChange(previous: SyncedDocument, next: string): TextDocumentContentChangeEvent | null {
  const oldText = previous.text;
  if (oldText === next) return null;

  const max = Math.min(oldText.length, next.length);
  let prefix = commonPrefixLength(oldText, next, max);
  // Nunca cortar um par substituto ao meio (o servidor contaria unidades erradas).
  if (splitsSurrogatePair(oldText, prefix)) prefix -= 1;
  const suffix = commonSuffixLength(oldText, next, max - prefix);
  const oldEnd = oldText.length - suffix;
  const newEnd = next.length - suffix;

  return {
    range: {
      start: positionAt(previous.lineStarts, prefix),
      end: positionAt(previous.lineStarts, oldEnd),
    },
    text: next.slice(prefix, newEnd),
  };
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

// ── Document symbols ───────────────────────────────────────────────────────────────────────

/** Extrai a lista de símbolos da resposta do servidor, tolerando payload malformado. */
function extractDocumentSymbols(result: unknown): readonly DocumentSymbolLike[] {
  if (!Array.isArray(result)) return [];
  const symbols: DocumentSymbolLike[] = [];
  for (const item of result) {
    const symbol = toDocumentSymbolLike(item);
    if (symbol !== undefined) symbols.push(symbol);
  }
  return symbols;
}

/**
 * Normaliza um item da resposta de `textDocument/documentSymbol`.
 *
 * Aceita as duas formas do protocolo:
 * - **plana** (`SymbolInformation`): o range vem em `location.range`;
 * - **hierárquica** (`DocumentSymbol`): o range vem em `selectionRange` (opcional).
 *
 * `undefined` = item inválido (sem `name`) — o cliente **ignora** em vez de estourar.
 */
function toDocumentSymbolLike(item: unknown): DocumentSymbolLike | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const rec = item as Record<string, unknown>;

  const name = rec["name"];
  if (typeof name !== "string") return undefined;
  const rawKind = rec["kind"];
  const kind = typeof rawKind === "number" ? rawKind : SymbolKind.Variable;
  const detail = rec["detail"];

  // Forma plana: `location.range`. Sem range utilizável ⇒ o símbolo é descartado
  // (payload malformado — o cliente não deve estourar por causa do servidor).
  const location = rec["location"];
  if (typeof location === "object" && location !== null) {
    const locRec = location as Record<string, unknown>;
    const range = locRec["range"];
    const uri = locRec["uri"];
    if (isRangeLike(range) && typeof uri === "string") {
      return {
        name,
        kind,
        location: { uri, range },
        ...(typeof detail === "string" ? { detail } : {}),
      } as SymbolInformation;
    }
    return undefined;
  }

  // Forma hierárquica: `range` + `selectionRange` (+ `children`). O range pode faltar
  // (payload incompleto) — quem decide o que fazer com o símbolo é o cliente.
  const range = rec["range"];
  const selectionRange = rec["selectionRange"];
  const children = rec["children"];
  return {
    name,
    kind,
    ...(isRangeLike(range) ? { range } : {}),
    ...(isRangeLike(selectionRange) ? { selectionRange } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
    ...(Array.isArray(children)
      ? { children: extractDocumentSymbols(children).filter(isHierarchicalSymbol) }
      : {}),
  };
}

/** Guard: o símbolo é da forma hierárquica (`DocumentSymbol`, tem `children`/`range`). */
function isHierarchicalSymbol(symbol: DocumentSymbolLike): symbol is DocumentSymbol {
  return !("location" in symbol);
}

/** Guard de forma: o valor tem `start`/`end` com `line`/`character` numéricos? */
function isRangeLike(value: unknown): value is Range {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return isPositionLike(rec["start"]) && isPositionLike(rec["end"]);
}

/** Guard de forma: o valor tem `line`/`character` numéricos? */
function isPositionLike(value: unknown): value is Position {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec["line"] === "number" && typeof rec["character"] === "number";
}
