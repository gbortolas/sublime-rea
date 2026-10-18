/**
 * Scribe — contratos de fronteira: servidor LSP, diagnóstico, completação e hover.
 *
 * Define os tipos de **configuração** e os **resultados** que atravessam o IPC do Scribe
 * (main ↔ renderer). Os tipos do protocolo LSP em si (JSON-RPC + `TextDocumentItem`,
 * `CompletionParams`, etc.) vivem em `src/core/lsp/lsp-protocol.ts` — são **internos**
 * do módulo `core/lsp/` e não vazam pela ponte.
 *
 * Rótulo de origem: estes contratos são **escolha nossa** — o LSP é um padrão da indústria
 * (Microsoft), não observado no alvo (Sublime Text).
 */

// ── Configuração de servidor LSP ──────────────────────────────────────────────────────────

/** Origem do servidor: instalado pelo Scribe ou customizado pelo usuário. */
export type LspServerKind = "builtin" | "user";

/** Como o servidor é iniciado. */
export interface LspServerSpawnConfig {
  readonly command: string;
  readonly args: readonly string[];
  /** Variáveis de ambiente extra (mescladas com as do processo). */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Um servidor LSP conhecido pelo Scribe. Mapeia extensões de arquivo a um comando de
 * spawn e opções de inicialização.
 */
export interface LspServerConfig {
  readonly name: string;
  readonly kind: LspServerKind;
  /** Extensões de arquivo (sem ponto) que ativam este servidor. */
  readonly languages: readonly string[];
  /** Language ID enviado no `textDocument/didOpen` (ex.: "python", "typescript"). */
  readonly languageId: string;
  /** Como iniciar o servidor. */
  readonly spawn: LspServerSpawnConfig;
  /**
   * Opções do `initialize` enviado ao servidor (DEC-IPC-8: o cliente inicia a conversa).
   * Só campos reconhecidos; omissão = default do Scribe.
   */
  readonly initializationOptions?: Readonly<Record<string, unknown>>;
  /** Ativado por padrão? */
  readonly enabled: boolean;
}

// ── Servidores embutidos ───────────────────────────────────────────────────────────────────

/**
 * Servidores LSP embutidos (registrados no momento da construção do `LspManager`).
 * Cada um aponta para um binário esperado no `$PATH` — se não estiver disponível,
 * o servidor é ignorado silenciosamente.
 *
 * Expansão futura: servidores instalados via npm/pip (Scribe poderia gerenciá-los).
 */
export const BUILTIN_LSP_SERVERS: readonly LspServerConfig[] = [
  {
    name: "TypeScript (tsServer)",
    kind: "builtin",
    languages: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
    languageId: "typescript",
    spawn: { command: "typescript-language-server", args: ["--stdio"] },
    enabled: true,
  },
  {
    name: "Python (pyright)",
    kind: "builtin",
    languages: ["py", "pyw"],
    languageId: "python",
    spawn: { command: "pyright-langserver", args: ["--stdio"] },
    enabled: true,
  },
] as const;

// ── Resultados que cruzam o IPC ────────────────────────────────────────────────────────────

/** Um item de diagnóstico (erro/warning/info do LSP), já simplificado para o renderer. */
export interface LspDiagnostic {
  readonly range: {
    readonly startLine: number;
    readonly startCol: number;
    readonly endLine: number;
    readonly endCol: number;
  };
  readonly severity: "error" | "warning" | "info" | "hint";
  readonly message: string;
  readonly source: string;
}

/** Resultado de completação (já simplificado). */
export interface LspCompletionItem {
  readonly label: string;
  readonly kind?: string;
  readonly detail?: string;
  readonly insertText?: string;
}

/** Resultado de hover (texto markdown/plain). */
export interface LspHoverResult {
  readonly contents: readonly string[];
  readonly range?: { readonly startLine: number; readonly startCol: number; readonly endLine: number; readonly endCol: number };
}

/** Estado de conexão de um servidor LSP. */
export type LspConnectionState = "disconnected" | "connecting" | "connected" | "errored";

// ── Configuração global ───────────────────────────────────────────────────────────────────

export interface LspSettings {
  /** Servidores do usuário (custom). */
  readonly servers: readonly LspServerConfig[];
  /** Atalho de completação (default: `editor.action.triggerSuggest`). */
  readonly completionTrigger: string;
  /** Habilitar diagnósticos? */
  readonly diagnosticsEnabled: boolean;
}

export const DEFAULT_LSP_SETTINGS: LspSettings = {
  servers: [],
  completionTrigger: "Ctrl+Space",
  diagnosticsEnabled: true,
};