/**
 * Scribe — processo principal do Electron: ciclo de vida, janela, composição do núcleo e IPC.
 *
 * Escopo (Fase 3 / P2.2, costura final): o `main` **monta** o `EditorCore` (`src/core/editor`),
 * registra os handlers do contrato de IPC (`src/shared/ipc-contract.ts`), abre a `BrowserWindow`
 * endurecida (`contextIsolation`, sem `nodeIntegration`, `sandbox`) e publica as métricas
 * `MainThreadBusy` (DEC-CON-10). O núcleo em si é assíncrono e **nunca** bloqueia a UI (DEC-CON-1).
 *
 * **Sem Electron, para teste:** `createEditorCore()`, `registerIpcHandlers()` e
 * `handleIpcRequest()` são funções puras (não tocam `electron`). O acesso ao Electron é
 * **dinâmico**, dentro de `startMainProcess()`, que só roda quando o processo é o Electron
 * (`process.versions.electron`) — por isso este módulo é importável em `node`/vitest.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow as ElectronBrowserWindow, SaveDialogOptions as ElectronSaveDialogOptions } from "electron";

import { createNodeFileSystem } from "../core/buffer";
import { createEditorCore as composeEditorCore } from "../core/editor";
import type { EditorCore, EditorCoreOptions } from "../core/editor";
import { parseGitStatusBranch, parseGitStatusPorcelain } from "../core/git/git-status";
import { indexFiles } from "../core/workspace/file-index";
import type { DirectoryReader, FileIndexResult } from "../core/workspace/file-index";
import { GREP_DEFAULT_MAX_FILES } from "../core/workspace/grep";
import {
  IPC_CHANNEL,
  IPC_VERSION,
  IpcProtocolError,
  isAbortError,
  parseIpcCancel,
  parseIpcRequest,
  toDisposable,
} from "../shared";
import type {
  Disposable,
  DocumentHandle,
  GitCommitResult,
  GitStatusResult,
  GrepTaskOptions,
  IpcEventEnvelope,
  IpcRequest,
  IpcResponse,
  LspDiagnostic,
  MainThreadBusy,
  PackageResolver,
  PackageSnippetDefinition,
  ResourceLayer,
  SearchQuery,
  Selection,
  SelectionSet,
  WorkspaceCreateFileResult,
} from "../shared";
import type { Event } from "../shared/events";
import { LspManager } from "../core/lsp/lsp-manager";
import type { Diagnostic } from "../core/lsp/lsp-protocol";
import { BUILTIN_LSP_SERVERS } from "../shared/lsp-contract";
import { collectPackageSnippets } from "../core/packages/package-snippets";
import { DapManager } from "../core/dap/dap-manager";
import { normalizeBreakpointSpecs } from "../core/dap/dap-breakpoints";
import { BUILTIN_DAP_SERVERS, MAX_EVALUATION_LENGTH, truncateEvaluation, type DapEvaluationContext } from "../shared/dap-contract";

export type { EditorCore, EditorCoreOptions } from "../core/editor";

/**
 * Canais legados do host de extensões (a preload duplica as strings — ela não importa este
 * módulo). Mantidos para a *liveness* `ping`/`ready` que a ponte tipada do preload consome.
 *
 * ⚠️ `menuAction` ficou **morto**: o menu nativo foi removido (o menu é do DOM) ⇒ o `main`
 * não emite mais neste canal. A constante fica (o preload ainda declara o canal — um preload
 * velho não quebra) e nada mais depende dela.
 */
export const IPC_CHANNELS = {
  ping: "scribe:host:ping",
  ready: "scribe:host:ready",
  exit: "scribe:host:exit",
  menuAction: "scribe:menu:action",
} as const;

/** Intervalo de publicação das métricas `MainThreadBusy` (observabilidade, DEC-CON-10). */
export const METRICS_INTERVAL_MS = 5_000;

/** Registrador de request/response do main (subconjunto de `ipcMain` que usamos). */
export interface MainIpcHost {
  handle(
    channel: string,
    listener: (event: unknown, ...args: readonly unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

/** Como entregar um evento a todos os renderers vivos (subconjunto de `webContents.send`). */
export interface IpcEventBroadcaster {
  broadcast(channel: string, payload: unknown): void;
}

/**
 * Mapa `signalId → AbortController` do main (DEC-IPC-9). O renderer manda um `signalId` junto do
 * request; um envelope `IpcCancel` com o mesmo `signalId` aborta a operação em voo. Um controller
 * por `signalId`, liberado ao terminar (ou no cancel).
 */
export interface IpcSignalRegistry {
  /** Cria/renova o controller do `signalId` e devolve o `AbortSignal` da operação. */
  create(signalId: number): AbortSignal;
  /** Aborta a operação do `signalId` (no-op se já terminou/abortou). */
  abort(signalId: number): void;
  /** Libera o controller do `signalId` (chamado no `finally` do request). */
  release(signalId: number): void;
  /** Quantos controllers continuam em voo (observabilidade/teste). */
  readonly pending: number;
}

export function createIpcSignalRegistry(): IpcSignalRegistry {
  const controllers = new Map<number, AbortController>();
  return {
    create(signalId: number): AbortSignal {
      const existing = controllers.get(signalId);
      if (existing !== undefined && !existing.signal.aborted) existing.abort("substituído");
      const controller = new AbortController();
      controllers.set(signalId, controller);
      return controller.signal;
    },
    abort(signalId: number): void {
      const controller = controllers.get(signalId);
      if (controller !== undefined && !controller.signal.aborted) {
        controller.abort("cancelado pelo renderer");
      }
    },
    release(signalId: number): void {
      controllers.delete(signalId);
    },
    get pending(): number {
      return controllers.size;
    },
  };
}

/** Port mínimo de diálogo de arquivo do main (produção = `dialog.showOpenDialog` do Electron). */
export interface FileDialogPort {
  showOpenDialog(): Promise<string | null>;
  /**
   * Diálogo "salvar como" — devolve o caminho escolhido (`null` = cancelado).
   *
   * ⚠️ **Opcional de propósito**: um `deps.dialog` injetado por um teste (ou por um host mais
   * antigo) pode não ter o método ⇒ o `main` degrada com
   * `IpcProtocolError("dialog-unavailable", …)` (nunca um crash).
   */
  showSaveDialog?(options?: { readonly defaultPath?: string }): Promise<string | null>;
}

/** Dependências injetadas no despacho de IPC (tudo opcional — os testes passam o que precisam). */
export interface IpcHandlerDeps {
  readonly signals?: IpcSignalRegistry;
  readonly dialog?: FileDialogPort;
  /** Gerente de depuração (DAP). Sem ele, os métodos `dap.*` falham com `dap-unavailable`. */
  readonly dap?: DapManager;
}

/** `true` quando o envelope é um `IpcCancel` (push de cancelamento, não um request). */
export function isCancelEnvelope(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "cancel"
  );
}

/** Predicado de arquivo existente para o filtro de argv (injetável em teste). */
export type FileProbe = (path: string) => boolean;

/** Predicado de produção: existe e é arquivo comum (nunca lança). */
export const isExistingFile: FileProbe = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Extrai o caminho de documento dos argumentos do processo (CLI/`open-file`).
 *
 * Heurística (escolha nossa): o **último** argumento que **não** começa com `-`, não é um dos
 * `ignore` (em dev o Electron injeta `.`, o diretório do app e o binário) e **aponta para um
 * arquivo existente**. Sem nenhum candidato, devolve `undefined`.
 */
export function extractDocumentPath(
  argv: readonly string[],
  isFile: FileProbe,
  ignore: readonly string[] = [],
): string | undefined {
  let found: string | undefined;
  for (const arg of argv) {
    if (arg.length === 0) continue;
    if (arg.startsWith("-")) continue;
    if (ignore.includes(arg)) continue;
    if (!isFile(arg)) continue;
    found = arg;
  }
  return found;
}

/** Normaliza um candidato de argv para caminho absoluto (ou `undefined`). */
function toAbsoluteDocumentPath(path: string | undefined): string | undefined {
  return path === undefined ? undefined : resolve(path);
}

/**
 * A URL é a **casca do próprio app**? (bloqueio de navegação — achado BAIXO)
 *
 * Só a própria casca (`file://…/renderer/index.html`) pode ser navegada: qualquer outra URL
 * (http/https, outro `file://`) é **bloqueada** pelo `will-navigate` — sem isso, o renderer
 * conseguia navegar o app para uma página remota.
 */
export function isOwnRendererUrl(url: string, rendererIndexPath: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    return resolve(fileURLToPath(parsed)) === resolve(rendererIndexPath);
  } catch (error) {
    // URL inválida ⇒ não é a casca ⇒ bloqueia (o motivo vai para o log).
    console.warn("Scribe: URL de navegação inválida:", error);
    return false;
  }
}

/** Subconjunto de `BrowserWindow` usado pelo broadcaster (o suficiente para o teste). */
export interface BroadcastWindow {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/**
 * Broadcaster de eventos do IPC: envia para todas as janelas **vivas**.
 *
 * Janela (ou `webContents`) destruída ⇒ `send` **lança** ⇒ o evento (ex.:
 * `document.changed`) se perdia (achado BAIXO). Aqui a janela morta é **ignorada**.
 */
export function createEventBroadcaster(
  windows: () => readonly BroadcastWindow[],
): IpcEventBroadcaster {
  return {
    broadcast: (channel, payload) => {
      for (const window of windows()) {
        if (window.isDestroyed()) continue;
        const contents = window.webContents;
        if (contents.isDestroyed()) continue;
        contents.send(channel, payload);
      }
    },
  };
}

/**
 * Severidade do LSP (protocolo) → severidade do contrato que o renderer consome.
 * Mesma mapeação do `core` (`convertSeverity`): 1=erro, 2=warning, 3=info, 4=hint.
 */
function toLspSeverity(severity: number | undefined): LspDiagnostic["severity"] {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "info";
  }
}

/**
 * Converte um diagnóstico **cru** do LSP no contrato que o renderer consome.
 *
 * ⚠️ Duplicata de propósito: o `core` tem a sua (`convertDiagnostic`, **privada**), mas o
 * `main` **não pode** reler o cache do core (ele é atualizado **depois** do nosso listener —
 * ver {@link broadcastLspDiagnostics}). As duas conversões precisam concordar no formato.
 */
export function toLspDiagnostic(diagnostic: Diagnostic): LspDiagnostic {
  return {
    range: {
      startLine: diagnostic.range.start.line,
      startCol: diagnostic.range.start.character,
      endLine: diagnostic.range.end.line,
      endCol: diagnostic.range.end.character,
    },
    severity: toLspSeverity(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? "LSP",
  };
}

/**
 * Fonte de diagnósticos do LSP — o subset do `LspManager` que o `main` consome
 * (injetável: um `Emitter` basta para o teste).
 */
export interface LspDiagnosticsSource {
  readonly onDiagnostics: Event<{
    readonly uri: string;
    readonly diagnostics: readonly Diagnostic[];
  }>;
}

/**
 * Conecta os diagnósticos do LSP ao *broadcast* IPC (`lsp.diagnostics`).
 *
 * ⚠️ **Usa os dados do próprio evento** (`params.diagnostics`) e **não** o cache do core
 * (`documentDiagnostics`): o core assina o `onDiagnostics` do `LspManager` **depois** (no
 * `attachLsp`, assíncrono) ⇒ o `Emitter.fire` (Set ⇒ ordem de inserção) chamava o `main`
 * **primeiro**, com o cache ainda da publicação **anterior** ⇒ o renderer recebia o
 * diagnóstico **atrasado em um evento** (e, se o servidor publicasse **uma vez só**, o
 * renderer **nunca** veria o diagnóstico).
 */
export function broadcastLspDiagnostics(
  source: LspDiagnosticsSource,
  core: Pick<EditorCore, "findHandleByUri">,
  events: IpcEventBroadcaster,
): Disposable {
  return source.onDiagnostics((params) => {
    const handle = core.findHandleByUri(params.uri);
    if (handle === undefined) return; // documento não está aberto no core
    const envelope: IpcEventEnvelope<"lsp.diagnostics"> = {
      v: IPC_VERSION,
      event: "lsp.diagnostics",
      args: [{ handle, diagnostics: params.diagnostics.map(toLspDiagnostic) }],
    };
    events.broadcast(IPC_CHANNEL.event, envelope);
  });
}

// ── Servidores LSP fora do shell do usuário (AppImage) ────────────────────────────────────

/**
 * Layout global do node: onde ficam os **binários** (`typescript-language-server`,
 * `pyright-langserver`) e os `node_modules` **globais** (`typescript/lib/tsserver.js`).
 */
export interface GlobalNodeLayout {
  /** Diretórios de binários globais (o `npm -g` instala aqui). */
  readonly binDirs: readonly string[];
  /** Raízes de `node_modules` global (`<prefixo>/lib/node_modules`). */
  readonly moduleRoots: readonly string[];
}

/** Layout vazio (nada encontrado). */
const EMPTY_NODE_LAYOUT: GlobalNodeLayout = { binDirs: [], moduleRoots: [] };

/**
 * Descobre o **prefixo global** do `npm` (onde o `npm -g` instala os binários).
 *
 * ⚠️ O `npm -g` do usuário pode estar em **qualquer** prefixo (nvm, pnpm, volta, asdf, npm
 * do sistema) — o AppImage só varria o `~/.nvm`, então fora dele o app ficava **sem LSP
 * nenhum** (achado MÉDIO). `npm config get prefix` é o caminho canônico; `npm bin -g`
 * (npm < 9) é o fallback.
 *
 * @param npmCandidates executáveis do `npm` a tentar, em ordem (o `npm` do PATH primeiro).
 * @param run           sonda (injetável — em produção: `execFileSync` **sem shell**).
 */
export function detectGlobalNodeLayout(
  npmCandidates: readonly string[],
  run: (file: string, args: readonly string[]) => string | undefined,
): GlobalNodeLayout {
  for (const npm of npmCandidates) {
    const prefix = trimProbe(run(npm, ["config", "get", "prefix"]));
    if (prefix !== undefined) {
      return {
        binDirs: [join(prefix, "bin")],
        moduleRoots: [join(prefix, "lib", "node_modules")],
      };
    }
  }
  for (const npm of npmCandidates) {
    // npm < 9: `npm bin -g` devolve o **diretório de binários** (não o prefixo).
    const bin = trimProbe(run(npm, ["bin", "-g"]));
    if (bin !== undefined) {
      return {
        binDirs: [bin],
        moduleRoots: [join(dirname(bin), "lib", "node_modules")],
      };
    }
  }
  return EMPTY_NODE_LAYOUT;
}

/**
 * Layout do node gerenciado pelo **nvm** (`~/.nvm/versions/node/*`).
 *
 * @param nvmRoot  raiz do nvm.
 * @param listDirs lista os diretórios (injetável p/ teste).
 * @param exists   predicado de existência (injetável p/ teste).
 */
export function nvmNodeLayout(
  nvmRoot: string,
  listDirs: (path: string) => readonly string[],
  exists: (path: string) => boolean,
): GlobalNodeLayout {
  let versions: readonly string[];
  try {
    versions = listDirs(nvmRoot);
  } catch {
    return EMPTY_NODE_LAYOUT; // sem nvm
  }
  const binDirs: string[] = [];
  const moduleRoots: string[] = [];
  // Do **mais novo** para o mais antigo (mesma ordem do código anterior).
  for (const version of [...versions].sort().reverse()) {
    const bin = join(nvmRoot, version, "bin");
    if (exists(bin)) binDirs.push(bin);
    moduleRoots.push(join(nvmRoot, version, "lib", "node_modules"));
  }
  return { binDirs, moduleRoots };
}

/** Normaliza a saída da sonda (`undefined` = comando falhou / não existe). */
function trimProbe(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Lista os diretórios de um caminho (vazio quando não existe). */
function readDirNames(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Orçao **total** da sondagem do `npm` no boot (o app não pode ficar pendurado).
 *
 * ⚠️ O `npm config get prefix` é rápido, mas numa máquina estragada ele pode travar ⇒ o
 * orçamento corta a sondagem e o app segue (com o fallback do nvm).
 */
const NPM_PROBE_BUDGET_MS = 3_000;

/**
 * Sonda o `npm` — **sem shell** (`execFileSync` com array de args) e com orçamento de tempo.
 */
function makeNpmProbe(
  budgetMs: number,
): (file: string, args: readonly string[]) => string | undefined {
  const deadline = Date.now() + budgetMs;
  return (file, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    try {
      const output: string = execFileSync(file, args, {
        encoding: "utf8",
        timeout: remaining,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      return output;
    } catch {
      // Sem `npm`, timeout ou erro ⇒ segue com o fallback (nvm).
      return undefined;
    }
  };
}

/**
 * Monta o layout global do node: prefixo do `npm` (o `npm -g` do usuário) + nvm.
 *
 * A ordem importa: o prefixo do `npm` vem **primeiro** (é o toolchain ativo do usuário — o
 * mesmo `node` com que os servidores LSP foram instalados).
 */
function buildGlobalNodeLayout(): GlobalNodeLayout {
  const nvm = nvmNodeLayout(
    join(homedir(), ".nvm", "versions", "node"),
    readDirNames,
    existsSync,
  );
  const npm = detectGlobalNodeLayout(
    ["npm", ...nvm.binDirs.map((dir) => join(dir, "npm"))],
    makeNpmProbe(NPM_PROBE_BUDGET_MS),
  );
  return {
    binDirs: [...npm.binDirs, ...nvm.binDirs],
    moduleRoots: [...npm.moduleRoots, ...nvm.moduleRoots],
  };
}

/**
 * PID do processo hospedado (o plugin host), para o log de boot.
 *
 * ⚠️ O `HostSession` **não expõe** o pid (só o `core` sabe — o `HostProcess` tem `pid`).
 * Até o `core` expor, o log diz isso explicitamente (antes imprimia `bridge.port`, que é um
 * **objeto** — e a linha ficava sem o `)` de fechamento).
 */
export function describePluginHostPid(session: unknown): string {
  if (typeof session === "object" && session !== null) {
    const pid = (session as { readonly pid?: unknown }).pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return String(pid);
  }
  return "(não exposto pelo core)";
}

/**
 * Cria o `EditorCore` do processo principal, injetando o `FileSystem` de produção
 * (`node:fs/promises`). Continua utilizável sem Electron (o `FileSystem` é a única I/O).
 */
export async function createEditorCore(options: EditorCoreOptions = {}): Promise<EditorCore> {
  const fileSystem = options.fileSystem ?? (await createNodeFileSystem());
  return composeEditorCore({ ...options, fileSystem });
}

/**
 * Registra no `main` os handlers do contrato tipado (`document.*`, `editor.snapshot`) e o
 * *broadcast* do evento `document.changed`. Não depende de Electron: recebe o host de IPC e o
 * broadcaster por injeção (em produção, `ipcMain` e as janelas do Electron).
 */
export function registerIpcHandlers(
  core: EditorCore,
  ipc: MainIpcHost,
  events: IpcEventBroadcaster,
  deps: IpcHandlerDeps = {},
): Disposable {
  const signals = deps.signals ?? createIpcSignalRegistry();
  const handlerDeps: IpcHandlerDeps = {
    signals,
    ...(deps.dialog !== undefined ? { dialog: deps.dialog } : {}),
    ...(deps.dap !== undefined ? { dap: deps.dap } : {}),
  };

  const subscription = core.onDocumentChanged((event) => {
    const envelope: IpcEventEnvelope<"document.changed"> = {
      v: IPC_VERSION,
      event: "document.changed",
      args: [event],
    };
    events.broadcast(IPC_CHANNEL.event, envelope);
  });
  ipc.handle(IPC_CHANNEL.request, (_event, raw) => {
    // O cancelamento chega no mesmo canal, mas é um push sem resposta (DEC-IPC-9).
    if (isCancelEnvelope(raw)) {
      try {
        signals.abort(parseIpcCancel(raw).signalId);
      } catch (error) {
        // Envelope malformado num push: não há resposta; registra e segue (DEC-TR-5).
        console.error("Scribe: cancelamento IPC inválido", messageOf(error));
      }
      return undefined;
    }
    return handleIpcRequest(core, raw, handlerDeps);
  });
  return toDisposable(() => {
    subscription.dispose();
    ipc.removeHandler(IPC_CHANNEL.request);
  });
}

/**
 * Executa um envelope de requisição contra o núcleo e devolve o envelope de resposta. Um
 * envelope inválido ou um método desconhecido produzem `ok: false` com `code` estável — **nunca**
 * silencioso (DEC-TR-5). Exportada para teste (não toca Electron).
 */
export async function handleIpcRequest(
  core: EditorCore,
  raw: unknown,
  deps: IpcHandlerDeps = {},
): Promise<IpcResponse> {
  let request: IpcRequest;
  try {
    request = parseIpcRequest(raw);
  } catch (error) {
    return {
      v: IPC_VERSION,
      id: extractId(raw),
      ok: false,
      error: { code: errorCode(error, "invalid-envelope"), message: messageOf(error) },
    };
  }

  const signalId = request.signalId;
  const signal = signalId !== undefined ? deps.signals?.create(signalId) : undefined;
  try {
    const value = await dispatchIpc(core, request, deps, signal);
    return { v: IPC_VERSION, id: request.id, ok: true, value };
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) {
      // Cancelamento é resultado previsível: código estável, sem vazar stack (DEC-TR-5).
      return {
        v: IPC_VERSION,
        id: request.id,
        ok: false,
        error: { code: "cancelled", message: "operação cancelada" },
      };
    }
    return {
      v: IPC_VERSION,
      id: request.id,
      ok: false,
      error: { code: errorCode(error, "dispatch-failed"), message: messageOf(error) },
    };
  } finally {
    if (signalId !== undefined) deps.signals?.release(signalId);
  }
}

// ── git: execução isolada (sem config do usuário ⇒ sem `diff.external`/`core.pager`) ───────

/** "Dispositivo nulo" do SO — alvo de `GIT_CONFIG_GLOBAL`/`core.hooksPath` (config vazia). */
const NULL_DEVICE: string = process.platform === "win32" ? "NUL" : "/dev/null";

/** Timeout dos comandos `git` (o app não pode ficar pendurado por um repo lento). */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Timeout **exclusivo do `git commit`** (60 s).
 *
 * O commit é o comando mais lento (index grande, hooks, assinatura) e o SIGTERM do timeout
 * genérico (5 s) matava o `git` **no meio da escrita do índice** ⇒ `.git/index.lock`
 * órfão ⇒ **todo** `git` seguinte falha ("Unable to create index.lock: File exists").
 * O app **não** apaga o lock (é estado do repo do usuário) — ele só dá mais tempo e
 * **reporta** o erro (achado BAIXO).
 */
const GIT_COMMIT_TIMEOUT_MS = 60_000;

/** Teto da mensagem de commit (64 KiB) — mensagem gigante é denial-of-service no IPC. */
const GIT_COMMIT_MESSAGE_MAX = 64 * 1024;

/** Teto de saída do `git blame --porcelain` (1 KB era apertado ⇒ `null` silencioso). */
const GIT_BLAME_MAX_BUFFER = 64 * 1024;

/** Teto de saída do `git diff` (64 KB cortava diffs médios ⇒ gutter sem faixas). */
const GIT_DIFF_MAX_BUFFER = 1024 * 1024;

/** Teto de saída do `git status --porcelain` (1 MiB — a lista de arquivos do repo). */
const GIT_STATUS_MAX_BUFFER = 1024 * 1024;

/**
 * Ambiente **mínimo** para o `git`.
 *
 * **Por que sanitizar (achado ALTO — RCE):** o `git` roda **dentro do repositório do
 * documento** e o `.git/config` desse repo é **controlado por quem tem o arquivo na mão**.
 * Com o ambiente do usuário, o `git diff` honra `diff.external` ⇒ **executa um comando
 * arbitrário** só por abrir um arquivo. As mitigações:
 * - `GIT_CONFIG_NOSYSTEM=1` ⇒ ignora `/etc/gitconfig`;
 * - `GIT_CONFIG_GLOBAL=/dev/null` ⇒ ignora `~/.gitconfig` **e** o `XDG_CONFIG_HOME`;
 * - `GIT_CONFIG_COUNT=0` ⇒ descarta configs vindos de `GIT_CONFIG_KEY_*` do ambiente;
 * - `GIT_TERMINAL_PROMPT=0` ⇒ nunca pede credencial (nada de prompt travar o app);
 * - `GIT_LITERAL_PATHSPECS=1` ⇒ **sem magic de pathspec** (achado MÉDIO): sem ela,
 *   `git add -- ':/'` (ou `':!x.ts'`) stageia **o repositório inteiro** — o `--` só
 *   bloqueia *opções*, não a *magic*.
 *
 * Toda outra variável `GIT_*` herdada (incluindo `GIT_EXTERNAL_DIFF` e `GIT_DIR`) é
 * **descartada**: o `git` só enxerga o que o app decide.
 */
function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = NULL_DEVICE;
  env["GIT_CONFIG_COUNT"] = "0";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_LITERAL_PATHSPECS"] = "1";
  return env;
}

/**
 * Config que o `git` **não** pode deixar de obedecer (vai **antes** do subcomando):
 * - `core.pager=cat` ⇒ a saída vem inteira, sem pager;
 * - `core.hooksPath=<nulo>` ⇒ nenhum hook do repo é executado;
 * - `core.fsmonitor=false` ⇒ o `core.fsmonitor=<script>` do `.git/config` **não** roda
 *   (achado MÉDIO — RCE: o `git status` executava o script do repo);
 * - `core.untrackedCache=false` ⇒ o cache de untracked (mesma família de config local)
 *   fica desligado;
 * - `commit.gpgsign=false` ⇒ o `commit.gpgsign=true` + `gpg.program=<script>` do
 *   `.git/config` **não** assina (o `git commit` executava o script).
 *
 * O `-c` (escopo de comando) tem **precedência** sobre o `.git/config` do repo —
 * verificado empiricamente (o marcador do `fsmonitor`/`gpg` não é criado).
 */
const GIT_HARDENED_CONFIG: readonly string[] = [
  "-c",
  "core.pager=cat",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Executa o `git` **sem shell** (o path do documento é **argumento**, nunca string de
 * comando) e devolve a stdout. Erro ⇒ rejeição (o chamador decide o fallback).
 *
 * **Assíncrono de propósito (achado MÉDIO):** `execFileSync` bloqueava o *event loop* do
 * processo principal por até 5 s ⇒ o app "não respondia" durante o diff.
 */
function runGit(
  args: readonly string[],
  options: { readonly cwd?: string; readonly maxBuffer: number; readonly timeout?: number },
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: sanitizedGitEnv(),
        timeout: options.timeout ?? GIT_TIMEOUT_MS,
        encoding: "utf-8",
        maxBuffer: options.maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          // O `execFile` **não** põe o `stderr` no erro (só na mensagem) ⇒ ele é anexado
          // aqui: é a mensagem do `git` que o painel de commit mostra ao usuário.
          if (typeof stderr === "string" && stderr.length > 0) {
            (error as { stderr?: string }).stderr = stderr;
          }
          rejectPromise(error);
        } else resolvePromise(stdout);
      },
    );
  });
}

// ── Workspace: índice de arquivos (Quick Open) e busca em todos os arquivos (grep) ────────────

/**
 * Adaptador do port de I/O do índice (`DirectoryReader`) para o `node:fs/promises`.
 *
 * O core **não** importa `node:fs` (o mesmo bundle roda no renderer) — a I/O entra por este
 * port, que só o `main` implementa.
 */
export const nodeDirectoryReader: DirectoryReader = {
  readDir: async (path: string): Promise<readonly { name: string; isDirectory: boolean; isFile: boolean }[]> => {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  },
  readFile: (path: string): Promise<string> => readFile(path, "utf8"),
};

/**
 * Raiz da **workspace** de um diretório: a pasta que contém `.git` (o *work root*).
 *
 * ⚠️ **Escolha nossa** (o alvo não expõe o conceito): o *Quick Open* e o *grep* trabalham
 * sobre a **workspace**, não sobre o diretório do arquivo. Sem `.git` (ou sem repo), o
 * próprio diretório é a raiz.
 */
export async function findWorkspaceRoot(dir: string): Promise<string> {
  let current = resolve(dir);
  for (;;) {
    // `.git` pode ser um diretório (repo normal) ou um arquivo (worktree/submodule).
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(dir);
    current = parent;
  }
}

/** Raízes candidatas → raízes reais (expandidas até a raiz da workspace, sem duplicatas). */
async function resolveWorkspaceRoots(roots: readonly string[]): Promise<string[]> {
  const candidates = roots.length > 0 ? roots : [process.cwd()];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const absolute = resolve(candidate);
    try {
      const info = await stat(absolute);
      if (!info.isDirectory()) continue;
    } catch (error) {
      console.warn(`Scribe: raiz da workspace inacessível "${absolute}": ${messageOf(error)}`);
      continue;
    }
    const root = await findWorkspaceRoot(absolute);
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

/** TTL do cache do índice (5s): o *Quick Open* e o *grep* reusam a mesma varredura. */
export const WORKSPACE_INDEX_TTL_MS = 5_000;

/**
 * Uma varredura da workspace: o índice **e** as raízes **efetivas** que o `main` varreu
 * (absolutas — o `path` de cada arquivo do índice é relativo a elas).
 */
export interface WorkspaceIndexSnapshot {
  /** O índice (relativo + absoluto) dos arquivos. */
  readonly index: FileIndexResult;
  /** As raízes absolutas que o `main` expandiu e varreu (pode ser vazia). */
  readonly roots: readonly string[];
}

/** Cache do índice por conjunto de raízes (o *grep* varre a árvore a cada tecla sem reindexar). */
const workspaceIndexCache = new Map<string, { at: number; result: WorkspaceIndexSnapshot }>();

/** Limpa o cache do índice da workspace (teste). */
export function clearWorkspaceIndexCache(): void {
  workspaceIndexCache.clear();
}

/**
 * Índice de arquivos da workspace (com cache curto).
 *
 * As raízes são expandidas até a raiz da workspace; a varredura usa o `indexFiles` do core
 * (que respeita o `.gitignore`, pula diretórios ruidosos e tem tetos).
 */
export async function workspaceIndex(roots: readonly string[]): Promise<FileIndexResult> {
  return (await workspaceIndexSnapshot(roots)).index;
}

/**
 * O mesmo índice, mas **com as raízes efetivas** (as que o `main` expandiu e varreu).
 *
 * O renderer precisa delas para resolver um caminho absoluto (ex.: o "criar arquivo" do ⌘P
 * precisa saber a raiz para confinear o path).
 */
export async function workspaceIndexSnapshot(
  roots: readonly string[],
): Promise<WorkspaceIndexSnapshot> {
  const resolved = await resolveWorkspaceRoots(roots);
  const key = resolved.join("\u0000");
  const cached = workspaceIndexCache.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < WORKSPACE_INDEX_TTL_MS) return cached.result;
  const index = await indexFiles(resolved, nodeDirectoryReader);
  const result: WorkspaceIndexSnapshot = { index, roots: resolved };
  workspaceIndexCache.set(key, { at: now, result });
  // Cache pequeno: só as últimas raízes importam.
  if (workspaceIndexCache.size > 8) {
    const oldest = [...workspaceIndexCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest !== undefined) workspaceIndexCache.delete(oldest[0]);
  }
  return result;
}

/** Lê um array de strings do wire (a lista de raízes do *Quick Open*). */
function optionalStringArray(value: unknown, method: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new IpcProtocolError("invalid-args", `${method}: roots deve ser um array`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new IpcProtocolError("invalid-args", `${method}: roots deve conter strings`);
    }
    out.push(item);
  }
  return out;
}

// ── Documentos abertos: as raízes candidatas (o "criar arquivo" e as operações de `git`) ────

/**
 * Documentos abertos por `core` (`handle → path absoluto`).
 *
 * O `EditorCore` **não** expõe a lista de documentos abertos (o `registry` não enumera) ⇒ o
 * `main` mantém o próprio registro a partir do `document.open`/`document.close` do IPC.
 */
const openDocuments = new WeakMap<EditorCore, Map<DocumentHandle, string>>();

/** Registra um documento aberto (raiz do `git` e confinamento do `createFile`). */
function trackOpenDocument(core: EditorCore, handle: DocumentHandle, path: string): void {
  let docs = openDocuments.get(core);
  if (docs === undefined) {
    docs = new Map<DocumentHandle, string>();
    openDocuments.set(core, docs);
  }
  docs.set(handle, path);
}

/** Esquece um documento fechado (o `WeakMap` some com o `core`). */
function untrackOpenDocument(core: EditorCore, handle: DocumentHandle): void {
  openDocuments.get(core)?.delete(handle);
}

/**
 * Há algum documento **aberto** neste core?
 *
 * A busca na workspace precisa de uma workspace: as raízes conhecidas são as dos documentos
 * abertos (o `cwd` é só o **fallback** de `knownWorkspaceRoots` — usá-lo na busca varreria o
 * repositório do processo **em silêncio**; achado do E2E de 2026-10-21).
 */
function hasOpenDocuments(core: EditorCore): boolean {
  const docs = openDocuments.get(core);
  return docs !== undefined && docs.size > 0;
}

/**
 * Caminho do documento **mais recentemente aberto** (o "ativo", na aproximação do `main`).
 *
 * O `EditorCore` guarda o documento ativo **internamente** (não expõe o handle) ⇒ o `main`
 * usa o último aberto como aproximação (é o que o `git`/o *create file* precisam).
 */
function activeDocumentPath(core: EditorCore): string | undefined {
  const docs = openDocuments.get(core);
  if (docs === undefined || docs.size === 0) return undefined;
  let last: string | undefined;
  for (const path of docs.values()) last = path;
  return last;
}

/**
 * Raízes **conhecidas** da workspace — a **fonte de verdade** do confinamento.
 *
 * São as raízes que o **`main`** calcula:
 * - a raiz de cada **documento aberto** ({@link findWorkspaceRoot} — a pasta que tem `.git`,
 *   a mesma que o `workspace.files` expande);
 * - **só quando não há documento aberto**, o `cwd` do processo (o *fallback*).
 *
 * ⚠️ O `root` que vem do **renderer** **não** entra aqui: ele é apenas **conferido**
 * contra esta lista (e recusado se estiver fora) — é o que impede um renderer
 * comprometido de ler/commitar em um repositório qualquer do disco (achado ALTO).
 *
 * ⚠️ O `cwd` é **fallback**, não constante: o app aberto pelo `.desktop` tem `cwd = $HOME`
 * ⇒ incluí-lo sempre transformava o confinamento do `createFile` em "qualquer lugar sob
 * `$HOME`" (achado MÉDIO).
 */
async function knownWorkspaceRoots(core: EditorCore): Promise<string[]> {
  const roots: string[] = [];
  const docs = openDocuments.get(core);
  if (docs !== undefined) {
    for (const path of docs.values()) {
      const root = await findWorkspaceRoot(dirname(path));
      if (!roots.includes(root)) roots.push(root);
    }
  }
  if (roots.length === 0) {
    const cwdRoot = await findWorkspaceRoot(resolve(process.cwd()));
    if (!roots.includes(cwdRoot)) roots.push(cwdRoot);
  }
  return roots;
}

/** O caminho absoluto está **dentro** da raiz (ou é a própria raiz)? */
function isInsideRoot(root: string, absolute: string): boolean {
  if (absolute === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return absolute.startsWith(prefix);
}

/** O path tem algum segmento `..`? (o `resolve` normalizaria e escaparia da raiz) */
function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === "..");
}

/**
 * O `realpath` do **ancestral existente mais próximo** do path pedido.
 *
 * O path pedido pode não existir ainda (é o `createFile`) ⇒ sobe até o primeiro ancestral
 * que existe e devolve o `realpath` dele (a resolve de symlinks).
 */
async function realpathOfNearestExisting(absolute: string): Promise<string> {
  let current = absolute;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      const code = errorCode(error, "");
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Confina um path a uma das raízes conhecidas — **sem symlink** no caminho.
 *
 * A checagem **lexical** ({@link isInsideRoot}) não basta: um symlink dentro da raiz
 * (`ws/link → /tmp/out`) leva a escrita para fora (achado ALTO — o `createFile` criava
 * `/tmp/out/evil.sh`). Então:
 * 1. o path tem de estar **dentro** de uma raiz conhecida (lexical);
 * 2. **nenhum segmento** entre a raiz e o alvo pode ser symlink (`lstat`);
 * 3. o `realpath` do ancestral existente mais próximo tem de estar dentro da raiz
 *    (realpath) — o `..` já foi barrado antes do `resolve`.
 *
 * Devolve a raiz que hosts o path (o `relativePath` do resultado).
 */
async function assertPathInsideWorkspace(
  absolute: string,
  roots: readonly string[],
): Promise<string> {
  const host = roots.find((candidate) => isInsideRoot(candidate, absolute));
  if (host === undefined) {
    throw new IpcProtocolError("invalid-args", "path-outside-workspace");
  }
  // (2) nenhum segmento do caminho (entre a raiz e o alvo) pode ser symlink.
  let current = host;
  for (const segment of relative(host, absolute).split(sep)) {
    if (segment.length === 0) continue;
    current = join(current, segment);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      // Não existe (ou o pai não é diretório) ⇒ o resto do caminho também não existe.
      const code = errorCode(error, "");
      if (code === "ENOENT" || code === "ENOTDIR") break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new IpcProtocolError("invalid-args", "path-outside-workspace");
    }
  }
  // (3) o `realpath` do ancestral existente tem de continuar dentro da raiz.
  const realHost = await realpathOfNearestExisting(host);
  const real = await realpathOfNearestExisting(absolute);
  if (!isInsideRoot(realHost, real)) {
    throw new IpcProtocolError("invalid-args", "path-outside-workspace");
  }
  return host;
}

// ── `search.files`: confinamento das raízes + tetos da varredura ────────────────────────────

/**
 * Teto de arquivos que a busca entrega ao worker.
 *
 * ⚠️ A lista de arquivos **cruza o port** do `TaskPool` a cada tecla (o `postMessage` clona
 * a lista inteira ⇒ ~1,6 MB com 20 000 paths) ⇒ o teto é imposto **no `main`** (a lista é
 * cortada **antes** de chegar ao core), não só dentro do worker (achado BAIXO).
 *
 * É o mesmo teto do core ({@link GREP_DEFAULT_MAX_FILES}) — o `maxFiles` pedido pelo renderer
 * **respeita** este teto (o `main` é quem decide o teto final).
 */
const GREP_MAX_FILES = GREP_DEFAULT_MAX_FILES;

/**
 * Teto duro do **orçamento de tempo** que o renderer pode pedir (60 s — o contrato IPC).
 *
 * O orçamento é **soft** (a varredura para *entre arquivos* e o resultado sai incompleto, com
 * aviso) ⇒ o teto só limita o pior caso; o teto **duro** do `TaskPool` (30 s, que mata o
 * worker) continua valendo por baixo.
 */
const GREP_MAX_BUDGET_MS = 60_000;

/**
 * Confinamento das raízes do `search.files` (achado MÉDIO — leitura arbitrária de arquivo).
 *
 * As raízes vêm do **renderer** ⇒ sem confinamento, um renderer comprometido mandava `/etc`
 * (ou `$HOME`) e o app varria esse diretório e **devolvia o texto** das linhas casadas
 * (canal de exfiltração).
 *
 * A política é a **mesma** do `createFile`:
 * - a raiz pedida tem de estar **dentro** (ou ser igual) de uma raiz **conhecida**
 *   ({@link knownWorkspaceRoots}: a raiz dos documentos abertos; o `cwd` como fallback);
 * - a checagem é {@link assertPathInsideWorkspace} (lexical + symlink + realpath) ⇒ um
 *   symlink **dentro** da workspace apontando para fora também é barrado;
 * - uma raiz **fora** é **descartada** (com aviso no log) — a busca **não falha** (as raízes
 *   legítimas — os diretórios dos documentos abertos — nunca caem aqui);
 * - se **nenhuma** raiz sobreviver ⇒ a busca devolve um resultado **vazio**, com aviso.
 */
async function confineSearchRoots(
  requested: readonly string[],
  known: readonly string[],
): Promise<{ readonly roots: readonly string[]; readonly discarded: readonly string[] }> {
  const roots: string[] = [];
  const discarded: string[] = [];
  for (const candidate of requested) {
    const absolute = resolve(candidate);
    try {
      await assertPathInsideWorkspace(absolute, known);
    } catch {
      // Fora da workspace (ou symlink para fora) ⇒ **descartada** (falha fechada).
      discarded.push(absolute);
      continue;
    }
    if (!roots.includes(absolute)) roots.push(absolute);
  }
  return { roots, discarded };
}

/** O teto de arquivos da busca (`maxFiles` do renderer respeita o mesmo teto). */
function clampGrepMaxFiles(requested: number | undefined): number {
  // ⚠️ Um valor **não positivo** significa "o default" (a mesma semântica do core,
  // `positiveOr`) — não "zero arquivos".
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return GREP_MAX_FILES;
  }
  return Math.min(GREP_MAX_FILES, Math.floor(requested));
}

/** O orçamento de tempo pedido pelo renderer é clampado (nada de orçamento infinito). */
function clampGrepBudgetMs(requested: number): number {
  if (!Number.isFinite(requested)) return GREP_MAX_BUDGET_MS;
  return Math.min(GREP_MAX_BUDGET_MS, Math.max(1, Math.floor(requested)));
}

// ── `git`: raiz do repositório, status e as operações de stage/commit/diff ─────────────────

/** O `root` opcional do wire (`string` não vazia ⇒ `undefined`). */
function optionalRoot(value: unknown, method: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new IpcProtocolError("invalid-args", `${method}: 'root' deve ser string não vazia`);
  }
  return value;
}

/**
 * A raiz **canônica** de uma das raízes conhecidas: a do documento ativo (ou a 1ª).
 */
async function primaryKnownRoot(core: EditorCore, known: readonly string[]): Promise<string> {
  const active = activeDocumentPath(core);
  if (active !== undefined) {
    const activeRoot = await findWorkspaceRoot(dirname(active));
    if (known.includes(activeRoot)) return activeRoot;
  }
  const first = known[0];
  if (first === undefined) {
    throw new IpcProtocolError("invalid-args", "root-outside-workspace");
  }
  return first;
}

/**
 * A raiz conhecida que **hosts** um path (a mais específica — o match exato vence).
 *
 * Repo aninhado (`/repo` e `/repo/sub` com `.git` nos dois) ⇒ a raiz **mais longa** que
 * contém o path é a do repo de verdade.
 */
function hostRoot(known: readonly string[], absolute: string): string | undefined {
  let best: string | undefined;
  for (const candidate of known) {
    if (!isInsideRoot(candidate, absolute)) continue;
    if (candidate === absolute) return candidate;
    if (best === undefined || candidate.length > best.length) best = candidate;
  }
  return best;
}

/**
 * A raiz do repositório das operações de `git` — **sempre derivada no `main`**.
 *
 * - Com `root` do renderer: ele **não** é fonte de verdade — só é aceito se estiver
 *   **dentro** de uma raiz conhecida ({@link knownWorkspaceRoots}); fora ⇒
 *   `invalid-args` ("root-outside-workspace"). É isso que impede um renderer
 *   comprometido de commitar/enumerar um repositório qualquer do disco (achado ALTO).
 * - Sem `root`: a raiz do documento ativo (ou a 1ª raiz conhecida).
 *
 * A política é **uniforme**: `git.status`/`git.stage`/`git.unstage`/`git.stageAll`/
 * `git.commit`/`git.diffText` passam todos por aqui.
 */
async function gitRootFor(core: EditorCore, root: string | undefined): Promise<string> {
  const known = await knownWorkspaceRoots(core);
  if (root === undefined) return primaryKnownRoot(core, known);
  const absolute = resolve(root);
  const host = hostRoot(known, absolute);
  if (host === undefined) {
    throw new IpcProtocolError("invalid-args", "root-outside-workspace");
  }
  // O `git` roda **na raiz conhecida** (nunca no path do renderer): os paths do status
  // são relativos à raiz do repositório ⇒ o `cwd` tem de ser a raiz canônica.
  return host;
}

/**
 * `git status --porcelain=v1 -z --branch` na raiz → o resultado tipado do contrato.
 *
 * **Sem repositório** ⇒ lista vazia e `branch: null` (o painel mostra "sem repositório") —
 * nunca derruba a promise. **Qualquer outra falha** (inclusive "a saída do `git` estourou o
 * `maxBuffer`" — repo enorme) vira **erro**: antes, um repo grande devolvia "sem
 * repositório" (mentira) e o painel jurava que o repo não era um repo (achado BAIXO).
 */
async function gitStatusAt(root: string): Promise<GitStatusResult> {
  try {
    const output = await runGit(
      [
        ...GIT_HARDENED_CONFIG,
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
        "--untracked-files=all",
      ],
      { cwd: root, maxBuffer: GIT_STATUS_MAX_BUFFER },
    );
    return { branch: parseGitStatusBranch(output), entries: parseGitStatusPorcelain(output) };
  } catch (error) {
    if (isNotARepositoryError(error)) {
      console.warn(`Scribe: "${root}" não é um repositório git`);
      return { branch: null, entries: [] };
    }
    if (isGitOutputTooLarge(error)) {
      throw new IpcProtocolError(
        "git-failed",
        "status do repositório grande demais (limite de saída excedido)",
      );
    }
    throw new IpcProtocolError("git-failed", gitErrorMessage(error));
  }
}

/** O `git` falhou porque o diretório **não é** um repositório (`exit 128`). */
function isNotARepositoryError(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" && stderr.length > 0 ? stderr : messageOf(error);
  return /not a git repository/i.test(text);
}

/** A saída do `git` estourou o `maxBuffer` (repo grande) — **não** é "sem repositório". */
function isGitOutputTooLarge(error: unknown): boolean {
  const code = errorCode(error, "");
  return code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || code === "ENOBUFS";
}

/** O `git` foi interrompido pelo timeout (o commit pode ter deixado `index.lock`). */
function isGitTimeout(error: unknown): boolean {
  return (error as { killed?: unknown }).killed === true;
}

/** A mensagem do `git` (o `stderr` do `execFile`; sem ele, a mensagem do erro). */
function gitErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
  const message = messageOf(error);
  // Sem `stderr` anexado, o `execFile` monta "Command failed: <cmd>\n<stderr>" ⇒ o que o
  // renderer precisa (a mensagem do `git`) é a parte de baixo.
  if (message.startsWith("Command failed:")) {
    const cut = message.indexOf("\n");
    if (cut >= 0) {
      const tail = message.slice(cut + 1).trim();
      if (tail.length > 0) return tail;
    }
  }
  return message;
}

/**
 * Roda um `git` que **precisa** dar certo (stage/unstage/stageAll).
 *
 * A falha vira um `IpcProtocolError("git-failed", <mensagem do git>)` — o renderer mostra o
 * motivo (sem repositório, path inválido, …) em vez de um erro genérico.
 */
async function runGitOrFail(args: readonly string[], root: string): Promise<void> {
  try {
    await runGit(args, { cwd: root, maxBuffer: GIT_STATUS_MAX_BUFFER });
  } catch (error) {
    throw new IpcProtocolError("git-failed", gitErrorMessage(error));
  }
}

/**
 * Cria um arquivo **novo** (vazio) no caminho escolhido no diálogo "salvar como".
 *
 * ⚠️ **O diálogo é a autorização**: o usuário escolheu o caminho (e confirmou a sobrescrita
 * quando o arquivo já existia) ⇒ o `main` escreve com `flag: "w"` (sobrescreve o escolhido).
 * Por isso o confinamento das raízes da workspace (que é do `workspace.createFile`) **não**
 * se aplica aqui — e o `flag: "wx"` (que falha se o arquivo existe) também não.
 *
 * O cancelamento do usuário ⇒ `null` (não é erro). Falha de disco/permissão ⇒
 * `IpcProtocolError("file-new-failed", …)` (erro tipado, nunca um crash).
 */
async function createNewFile(
  dialog: FileDialogPort,
  options?: { readonly defaultPath?: string },
): Promise<string | null> {
  if (typeof dialog.showSaveDialog !== "function") {
    throw new IpcProtocolError(
      "dialog-unavailable",
      "nenhum diálogo de 'salvar como' foi injetado",
    );
  }
  const chosen = await dialog.showSaveDialog(options);
  if (chosen === null) return null;
  const absolute = resolve(chosen);
  try {
    // O diretório pai pode não existir (o usuário escolheu um caminho novo) ⇒ `mkdir`
    // recursivo antes de escrever.
    await mkdir(dirname(absolute), { recursive: true });
    // `flag: "w"`: cria **ou** sobrescreve (o diálogo já deu o consentimento).
    await writeFile(absolute, "", { encoding: "utf8", flag: "w" });
  } catch (error) {
    throw new IpcProtocolError(
      "file-new-failed",
      `não foi possível criar "${absolute}": ${messageOf(error)}`,
    );
  }
  return absolute;
}

async function dispatchIpc(
  core: EditorCore,
  request: IpcRequest,
  deps: IpcHandlerDeps,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  switch (request.method) {
    case "document.open": {
      const path = requireString(request.args[0], "document.open", "path");
      const handle = await core.openDocument(path, signal);
      // O `main` registra o documento aberto: é a **fonte das raízes** candidatas
      // (o `createFile` e o `git` workam na raiz do documento ativo).
      trackOpenDocument(core, handle, resolve(path));
      return handle;
    }
    case "document.openDialog": {
      if (deps.dialog === undefined) {
        throw new IpcProtocolError(
          "dialog-unavailable",
          "document.openDialog: nenhum diálogo foi injetado",
        );
      }
      return deps.dialog.showOpenDialog();
    }
    case "file.new": {
      // ⚠️ O `file.new` **precisa** do diálogo "salvar como" (é ele que escolhe o caminho
      // e autoriza a escrita) ⇒ sem ele, o pedido falha com erro tipado (nunca um crash).
      if (deps.dialog === undefined) {
        throw new IpcProtocolError(
          "dialog-unavailable",
          "file.new: nenhum diálogo foi injetado",
        );
      }
      return createNewFile(deps.dialog);
    }
    case "document.text":
      return core.documentText(requireHandle(request.args[0], "document.text"));
    case "document.close": {
      // Fecha o documento no core: o `didClose` do LSP sai por aqui (sem ele, o servidor
      // LSP **acumula** os documentos abertos).
      const handle = requireHandle(request.args[0], "document.close");
      untrackOpenDocument(core, handle);
      return core.closeDocument(handle);
    }
    case "document.revision":
      return core.revisionOf(requireHandle(request.args[0], "document.revision"));
    case "document.save": {
      const handle = requireHandle(request.args[0], "document.save");
      return core.saveDocument(handle, signal);
    }
    case "document.isDirty": {
      const handle = requireHandle(request.args[0], "document.isDirty");
      return core.isDirty(handle);
    }
    case "document.insert": {
      const handle = requireHandle(request.args[0], "document.insert");
      const at = requireNumber(request.args[1], "document.insert", "at");
      const text = requireString(request.args[2], "document.insert", "text");
      const origin = request.args[3] === "plugin" ? "plugin" : "user";
      const selections = optionalSelections(request.args[4], "document.insert");
      return core.insertText(handle, at, text, origin, selections);
    }
    case "document.batchInsert": {
      const handle = requireHandle(request.args[0], "document.batchInsert");
      const inserts = requireBatchInserts(request.args[1], "document.batchInsert");
      const origin = request.args[2] === "plugin" ? "plugin" : "user";
      const selections = optionalSelections(request.args[3], "document.batchInsert");
      return core.batchInsert(handle, inserts, origin, selections);
    }
    case "document.replaceOne": {
      const handle = requireHandle(request.args[0], "document.replaceOne");
      const at = requireNumber(request.args[1], "document.replaceOne", "at");
      const remove = requireNumber(request.args[2], "document.replaceOne", "remove");
      const insert = requireString(request.args[3], "document.replaceOne", "insert");
      const selections = optionalSelections(request.args[4], "document.replaceOne");
      return core.replaceOne(handle, at, remove, insert, selections);
    }
    case "editor.undo":
      return core.undoDocument(requireHandle(request.args[0], "editor.undo"));
    case "editor.redo":
      return core.redoDocument(requireHandle(request.args[0], "editor.redo"));
    case "editor.undoState":
      return core.undoStateOf(requireHandle(request.args[0], "editor.undoState"));
    case "editor.snapshot":
      return core.snapshot();
    case "syntax.highlight": {
      const handle = requireHandle(request.args[0], "syntax.highlight");
      const first = requireNumber(request.args[1], "syntax.highlight", "first");
      const count = requireNumber(request.args[2], "syntax.highlight", "count");
      return core.highlightDocument(handle, first, count);
    }
    case "search.find": {
      const handle = requireHandle(request.args[0], "search.find");
      const query = requireSearchQuery(request.args[1], "search.find");
      return core.searchDocument(handle, query, signal);
    }
    case "search.replaceAll": {
      const handle = requireHandle(request.args[0], "search.replaceAll");
      const query = requireSearchQuery(request.args[1], "search.replaceAll");
      const replacement = requireString(request.args[2], "search.replaceAll", "replacement");
      return core.replaceAll(handle, query, replacement, signal);
    }
    case "workspace.files": {
      const roots = optionalStringArray(request.args[0], "workspace.files") ?? [];
      const snapshot = await workspaceIndexSnapshot(roots);
      return {
        files: snapshot.index.entries.map((entry) => ({
          path: entry.path,
          absolutePath: entry.absolutePath,
        })),
        truncated: snapshot.index.truncated,
        warnings: snapshot.index.warnings,
        // As raízes **efetivas** que o `main` varreu (absolutas): o renderer precisa delas
        // para resolver um path absoluto (ex.: o "criar arquivo" do ⌘P).
        roots: snapshot.roots,
      };
    }
    case "workspace.createFile": {
      const raw = requireString(request.args[0], "workspace.createFile", "path");
      if (raw.length === 0 || raw.includes("\0")) {
        throw new IpcProtocolError(
          "invalid-args",
          "workspace.createFile: 'path' deve ser um caminho não vazio",
        );
      }
      // **`..` é rejeitado antes do `resolve`**: o `resolve` normaliza o path e o escape da
      // raiz viraria invisível (a checagem abaixo já é feita sobre o path resolvido).
      if (hasParentSegment(raw)) {
        throw new IpcProtocolError("invalid-args", "path-outside-workspace");
      }
      const absolute = resolve(raw);
      // **Confinamento**: o path tem de estar dentro de uma das raízes **conhecidas**
      // (a raiz dos documentos abertos; o `cwd` só como fallback) **e** nenhum segmento
      // do caminho pode ser symlink (a checagem lexical sozinha deixa o symlink
      // `ws/link → /tmp/out` escrever fora — achado ALTO).
      const roots = await knownWorkspaceRoots(core);
      const root = await assertPathInsideWorkspace(absolute, roots);
      // O diretório é criado **depois** da validação (e reconferido depois do `mkdir`:
      // o `mkdir` recursivo é o instante em que um symlink trocado no caminho escaparia).
      await mkdir(dirname(absolute), { recursive: true });
      await assertPathInsideWorkspace(dirname(absolute), roots);
      let created = true;
      try {
        // `flag: "wx"` ⇒ falha se o arquivo **já existe** (nunca sobrescreve).
        await writeFile(absolute, "", { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (errorCode(error, "") === "EEXIST") {
          created = false;
        } else {
          throw error;
        }
      }
      const result: WorkspaceCreateFileResult = {
        path: absolute,
        created,
        relativePath: relative(root, absolute),
      };
      return result;
    }
    case "search.files": {
      const query = requireString(request.args[0], "search.files", "query");
      const options = optionalSearchFilesOptions(request.args[1]);
      // ── Confinamento das raízes (achado MÉDIO — leitura arbitrária de arquivo) ─────
      // As raízes vêm do **renderer** ⇒ sem confinamento, um renderer comprometido mandava
      // `/etc` (ou `$HOME`) e o app varria esse diretório e **devolvia o texto** das linhas
      // casadas (canal de exfiltração). A raiz pedida tem de estar **dentro** de uma raiz
      // **conhecida** (a dos documentos abertos; o `cwd` como fallback).
      const known = await knownWorkspaceRoots(core);
      const requested = options.roots ?? [];
      let roots: readonly string[];
      let discarded: readonly string[] = [];
      // `true` = não há **documento aberto** ⇒ a busca não tem workspace (achado do E2E).
      let semDocumento = false;
      if (requested.length === 0) {
        // Sem raízes pedidas ⇒ a workspace dos **documentos abertos**.
        // ⚠️ `knownWorkspaceRoots` cai no **fallback do `cwd`** quando não há documento ⇒ a
        // busca varreria o repositório do processo **em silêncio** (o app aberto pelo
        // `.desktop` tem `cwd = $HOME` ⇒ varreria a casa do usuário!). A busca precisa de
        // uma workspace ⇒ **sem documento aberto**, ela é **ignorada** (o ramo "nenhuma
        // raiz" abaixo devolve o resultado vazio **com aviso** — o descarte nunca é
        // silencioso).
        semDocumento = !hasOpenDocuments(core);
        roots = semDocumento ? [] : known;
      } else {
        const confined = await confineSearchRoots(requested, known);
        roots = confined.roots;
        discarded = confined.discarded;
      }
      for (const root of discarded) {
        console.warn(`Scribe: raiz da busca fora da workspace descartada: "${root}"`);
      }
      // O teto de arquivos: a lista **cruza o port** do `TaskPool` a cada tecla ⇒ o `main`
      // corta a lista **antes** de entregar ao core (o `maxFiles` do renderer respeita o
      // mesmo teto — o `main` é quem decide o teto final).
      const maxFiles = clampGrepMaxFiles(options.maxFiles);
      // O orçamento de tempo: o renderer **não** pode pedir um orçamento infinito.
      const budgetMs =
        options.budgetMs !== undefined ? clampGrepBudgetMs(options.budgetMs) : undefined;
      // As opções do IPC → as opções da task `grep` (só as que existem no contrato — o
      // `roots` é do `main`, ele resolve as raízes e entrega a lista **plana** de arquivos).
      const grepOptions: GrepTaskOptions = {
        maxFiles,
        ...(budgetMs !== undefined ? { budgetMs } : {}),
        ...(options.maxMatches !== undefined ? { maxMatches: options.maxMatches } : {}),
        ...(options.ignoreAccents !== undefined ? { ignoreAccents: options.ignoreAccents } : {}),
        // Regex (padrão cru) / case / binários — o mesmo contrato do find bar.
        ...(options.regex !== undefined ? { regex: options.regex } : {}),
        ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive } : {}),
        ...(options.includeBinary !== undefined ? { includeBinary: options.includeBinary } : {}),
      };
      // O `grep` varre os **caminhos absolutos** (o que o worker lê) — cortados no teto.
      // (Nenhuma raiz sobrevivida ⇒ a lista é vazia: a busca **não varre nada**.)
      const files =
        roots.length === 0
          ? []
          : (await workspaceIndex(roots)).entries
              .slice(0, maxFiles)
              .map((entry) => entry.absolutePath);
      // ⚠️ A varredura roda **no worker** (lane `grep`): o `main` não lê nenhum arquivo —
      // quem lê é o worker (`nodeGrepReadFile`), que respeita o teto por arquivo.
      const result = await core.grepFiles({
        query,
        files,
        options: grepOptions,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (roots.length === 0) {
        // Nenhuma raiz sobreviveu ⇒ o resultado é **vazio**, com o aviso (o painel da busca
        // mostra os avisos — o descarte nunca é silencioso).
        return {
          ...result,
          warnings: [
            ...(result.warnings ?? []),
            semDocumento
              ? "nenhum documento está aberto — abra um arquivo para buscar na workspace"
              : "nenhuma raiz da busca está dentro da workspace — a busca foi ignorada",
          ],
        };
      }
      return result;
    }
    case "command.list":
      // O contrato (`CommandListResult`) é `{ commands: [...] }` — devolver o array puro
      // quebrava a palette (ela lia `result.commands` e recebia `undefined` ⇒ lista vazia).
      return { commands: core.listCommands() };
    case "command.execute": {
      const commandId = requireString(request.args[0], "command.execute", "commandId");
      // file.open precisa do dialog injetado (não vive no core)
      if (commandId === "file.open") {
        if (deps.dialog === undefined) {
          throw new IpcProtocolError(
            "dialog-unavailable",
            "command.execute: file.open requer diálogo",
          );
        }
        const path = await deps.dialog.showOpenDialog();
        if (path !== null) {
          const handle = await core.openDocument(path, signal);
          trackOpenDocument(core, handle, resolve(path));
        }
        return;
      }
      // file.new também precisa do diálogo ("salvar como"): o main cria o arquivo e devolve
      // o caminho (o renderer intercepta o comando **antes** do IPC — o valor aqui é um
      // *superset* do `void` declarado no contrato).
      if (commandId === "file.new") {
        if (deps.dialog === undefined) {
          throw new IpcProtocolError(
            "dialog-unavailable",
            "command.execute: file.new requer diálogo de 'salvar como'",
          );
        }
        return createNewFile(deps.dialog);
      }
      return core.executeCommand(commandId);
    }
    case "lsp.completions": {
      const handle = requireHandle(request.args[0], "lsp.completions");
      const line = requireNumber(request.args[1], "lsp.completions", "line");
      const col = requireNumber(request.args[2], "lsp.completions", "col");
      return core.requestCompletions(handle, line, col);
    }
    case "lsp.hover": {
      const handle = requireHandle(request.args[0], "lsp.hover");
      const line = requireNumber(request.args[1], "lsp.hover", "line");
      const col = requireNumber(request.args[2], "lsp.hover", "col");
      return core.requestHover(handle, line, col);
    }
    case "lsp.diagnostics":
      return core.documentDiagnostics(requireHandle(request.args[0], "lsp.diagnostics"));
    case "lsp.definition": {
      const handleDef = requireHandle(request.args[0], "lsp.definition");
      const lineDef = requireNumber(request.args[1], "lsp.definition", "line");
      const colDef = requireNumber(request.args[2], "lsp.definition", "col");
      return core.requestDefinition(handleDef, lineDef, colDef);
    }
    case "lsp.signatureHelp": {
      const handleSig = requireHandle(request.args[0], "lsp.signatureHelp");
      const lineSig = requireNumber(request.args[1], "lsp.signatureHelp", "line");
      const colSig = requireNumber(request.args[2], "lsp.signatureHelp", "col");
      const triggerSig = request.args[3] as string | undefined;
      return core.requestSignatureHelp(handleSig, lineSig, colSig, triggerSig);
    }
    case "lsp.documentSymbols":
      return core.requestDocumentSymbols(requireHandle(request.args[0], "lsp.documentSymbols"));
    case "lsp.rename": {
      const handle = requireHandle(request.args[0], "lsp.rename");
      const line = requireNumber(request.args[1], "lsp.rename", "line");
      const col = requireNumber(request.args[2], "lsp.rename", "col");
      const newName = requireString(request.args[3], "lsp.rename", "newName");
      return core.requestRename(handle, line, col, newName);
    }
    case "lsp.references": {
      const handle = requireHandle(request.args[0], "lsp.references");
      const line = requireNumber(request.args[1], "lsp.references", "line");
      const col = requireNumber(request.args[2], "lsp.references", "col");
      return core.requestReferences(handle, line, col);
    }
    case "lsp.codeActions": {
      const handle = requireHandle(request.args[0], "lsp.codeActions");
      const line = requireNumber(request.args[1], "lsp.codeActions", "line");
      const col = requireNumber(request.args[2], "lsp.codeActions", "col");
      return core.requestCodeActions(handle, line, col);
    }
    case "lsp.formatting": {
      const handle = requireHandle(request.args[0], "lsp.formatting");
      const tabSize = request.args[1] as number | undefined;
      const insertSpaces = request.args[2] as boolean | undefined;
      const formattingOpts = (tabSize !== undefined)
        ? { tabSize, ...(insertSpaces !== undefined ? { insertSpaces } : {}) }
        : undefined;
      return core.requestFormatting(handle, formattingOpts);
    }
    case "lsp.foldingRange":
      return core.requestFoldingRange(requireHandle(request.args[0], "lsp.foldingRange"));
    case "lsp.inlayHints": {
      const handle = requireHandle(request.args[0], "lsp.inlayHints");
      const startLine = request.args[1] as number | undefined;
      const endLine = request.args[2] as number | undefined;
      return core.requestInlayHints(handle, startLine, endLine);
    }
    case "git.blame": {
      const blameHandle = requireHandle(request.args[0], "git.blame");
      const blameLine = requireNumber(request.args[1], "git.blame", "line");
      const state = core.registry.get(blameHandle);
      if (state === undefined) return null;
      const path = state.uri;
      try {
        // **Sem shell**: o path vem do renderer (`document.open`) e, dentro de uma
        // string de shell, `$(...)`/backticks expandem ⇒ execução de código. O path vai
        // como **argumento** (o `--` separa as opções do path).
        //
        // **`cwd` = o diretório do documento (achado MÉDIO):** sem ele, o `git` roda no
        // repo do **app** ⇒ o arquivo do documento está "outside repository" ⇒ o blame
        // devolvia `null` **sempre**.
        const result = await runGit(
          [
            ...GIT_HARDENED_CONFIG,
            "blame",
            "-L",
            `${blameLine + 1},${blameLine + 1}`,
            "--porcelain",
            "--",
            path,
          ],
          { cwd: dirname(path), maxBuffer: GIT_BLAME_MAX_BUFFER },
        );
        if (!result) return null;
        const lines = result.split("\n");
        const firstLine = lines[0];
        if (!firstLine) return null;
        const parts = firstLine.split(" ");
        const commitHash = parts[0] ?? "";
        let author = "unknown";
        let authorTime = "";
        for (const line of lines) {
          if (line.startsWith("author ")) author = line.slice(7);
          if (line.startsWith("author-time ")) authorTime = line.slice(12);
        }
        const date = authorTime ? new Date(parseInt(authorTime, 10) * 1000) : null;
        const timeAgo = date ? timeAgoStr(date) : "";
        return { commitHash: commitHash.slice(0, 8), author, timeAgo };
      } catch {
        // `blame` sem repo/commit/linha ⇒ `null` (o contrato manda `null`, não erro).
        return null;
      }
    }
    case "git.diff": {
      const handle = requireHandle(request.args[0], "git.diff");
      const path = core.registry.get(handle)?.uri;
      if (path === undefined) return [];
      try {
        // `dirname` (e não `substring(0, lastIndexOf("/"))`): path sem "/" dava `cwd: ""`
        // e path Windows dava `""` — o `git` caía no cwd do app (achado BAIXO).
        const dir = dirname(path);
        // **Sem shell** (mesma razão do `git.blame`): o path é argumento, não string.
        //
        // `--no-ext-diff --no-textconv` + `core.pager=cat` + ambiente sanitizado
        // (achado ALTO — RCE): o `.git/config` do repo do documento é **do usuário** e
        // `diff.external` manda um comando **arbitrário** para o `git diff` executá-lo.
        const result = await runGit(
          [
            ...GIT_HARDENED_CONFIG,
            "diff",
            "HEAD",
            "--unified=0",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            path,
          ],
          { cwd: dir, maxBuffer: GIT_DIFF_MAX_BUFFER },
        );
        if (!result) return [];
        // Parse unified diff: @@ -start,count +start,count @@
        const ranges: { startLine: number; lineCount: number; kind: string }[] = [];
        for (const line of result.split("\n")) {
          const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
          if (match) {
            const start = parseInt(match[1]!, 10) - 1;
            const count = match[2] ? parseInt(match[2], 10) : 1;
            ranges.push({ startLine: start, lineCount: count, kind: "modified" });
          }
        }
        return ranges;
      } catch {
        // Sem repo/commit (ou `git` falhou) ⇒ **nenhum** range (o contrato manda lista vazia).
        return [];
      }
    }
    // ── `git`: o painel de *Source Control* (status/stage/commit) ───────────────────────────
    // **Sem shell, sempre**: o path e a mensagem de commit são **argumentos** (`argv`), nunca
    // string de comando (é o precedente obrigatório depois do RCE via `git diff`).
    case "git.status": {
      const root = await gitRootFor(core, optionalRoot(request.args[0], "git.status"));
      return gitStatusAt(root);
    }
    case "git.stage": {
      const path = requireString(request.args[0], "git.stage", "path");
      const root = await gitRootFor(core, optionalRoot(request.args[1], "git.stage"));
      await runGitOrFail([...GIT_HARDENED_CONFIG, "add", "--", path], root);
      return gitStatusAt(root);
    }
    case "git.unstage": {
      const path = requireString(request.args[0], "git.unstage", "path");
      const root = await gitRootFor(core, optionalRoot(request.args[1], "git.unstage"));
      try {
        // `git restore` é do git ≥ 2.23.
        await runGit([...GIT_HARDENED_CONFIG, "restore", "--staged", "--", path], {
          cwd: root,
          maxBuffer: GIT_STATUS_MAX_BUFFER,
        });
      } catch (error) {
        // Git antigo ⇒ o fallback é o `git reset` (se ele também falhar, o erro **original**
        // do `restore` é o que sobe — o `reset` é só uma tentativa).
        try {
          await runGit([...GIT_HARDENED_CONFIG, "reset", "-q", "HEAD", "--", path], {
            cwd: root,
            maxBuffer: GIT_STATUS_MAX_BUFFER,
          });
        } catch {
          throw new IpcProtocolError("git-failed", gitErrorMessage(error));
        }
      }
      return gitStatusAt(root);
    }
    case "git.stageAll": {
      const root = await gitRootFor(core, optionalRoot(request.args[0], "git.stageAll"));
      await runGitOrFail([...GIT_HARDENED_CONFIG, "add", "-A", "--", "."], root);
      return gitStatusAt(root);
    }
    case "git.commit": {
      const message = requireString(request.args[0], "git.commit", "message");
      // Teto + NUL: mensagem gigante é denial-of-service e o NUL quebra o `execFile`
      // (o `spawn` recusa arg com NUL) — o erro sai **antes** do `git` (achado BAIXO).
      if (message.length > GIT_COMMIT_MESSAGE_MAX) {
        throw new IpcProtocolError(
          "invalid-args",
          `git.commit: mensagem acima de ${GIT_COMMIT_MESSAGE_MAX} caracteres`,
        );
      }
      if (message.includes("\0")) {
        throw new IpcProtocolError("invalid-args", "git.commit: mensagem inválida (contém NUL)");
      }
      const root = await gitRootFor(core, optionalRoot(request.args[1], "git.commit"));
      try {
        // A mensagem vai como **argumento** (`-m <mensagem>`) — nunca interpolada ⇒ uma
        // mensagem que começa por `-` é **literal** (o `-m` consome o argumento seguinte).
        await runGit([...GIT_HARDENED_CONFIG, "commit", "-m", message], {
          cwd: root,
          maxBuffer: GIT_STATUS_MAX_BUFFER,
          // Timeout **maior e exclusivo** do commit: o SIGTERM do timeout genérico matava o
          // `git` no meio da escrita do índice ⇒ `.git/index.lock` órfão (achado BAIXO).
          timeout: GIT_COMMIT_TIMEOUT_MS,
        });
        const ok: GitCommitResult = { ok: true };
        return ok;
      } catch (error) {
        // ⚠️ O ambiente é sanitizado (`GIT_CONFIG_GLOBAL=/dev/null`) ⇒ sem `user.name`/
        // `user.email` globais o commit falha por **falta de identidade**. A mensagem do `git`
        // é propagada (o `main` **não** inventa identidade).
        const failed: GitCommitResult = {
          ok: false,
          error: isGitTimeout(error)
            ? `tempo esgotado (${GIT_COMMIT_TIMEOUT_MS / 1000}s) — o commit foi interrompido; se o repositório ficou com .git/index.lock, remova-o`
            : gitErrorMessage(error),
        };
        return failed;
      }
    }
    case "git.diffText": {
      const path = requireString(request.args[0], "git.diffText", "path");
      const known = await knownWorkspaceRoots(core);
      // Path **relativo** ⇒ relativo à raiz conhecida (é assim que o `git status` devolve
      // os paths e o painel os repassa); path absoluto ⇒ é ele mesmo (normalizado).
      const base = await primaryKnownRoot(core, known);
      const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
      // **Confinamento**: o path tem de estar dentro de uma raiz **conhecida**. A raiz
      // **nunca** é derivada do path do renderer (fazer isso deixava o `cwd` ser a raiz do
      // repo **alheio** ⇒ o painel lia o conteúdo não commitado de qualquer repo do disco
      // — achado ALTO).
      const root = hostRoot(known, absolute);
      if (root === undefined) {
        throw new IpcProtocolError("invalid-args", "path-outside-workspace");
      }
      try {
        // **Sem** `--unified=0`: o painel precisa do **contexto** das linhas.
        // `--no-ext-diff --no-textconv` + config endurecido (o RCE do `diff.external`).
        return await runGit(
          [
            ...GIT_HARDENED_CONFIG,
            "diff",
            "HEAD",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            absolute,
          ],
          { cwd: root, maxBuffer: GIT_DIFF_MAX_BUFFER },
        );
      } catch {
        // Sem repo/HEAD (ou `git` falhou) ⇒ diff vazio (o painel mostra "sem diff").
        return "";
      }
    }
    case "dap.start": {
      const dap = requireDap(deps);
      const handle = requireHandle(request.args[0], "dap.start");
      const path = core.registry.get(handle)?.uri;
      if (path === undefined) {
        throw new IpcProtocolError("dap-no-document", "dap.start: documento não encontrado");
      }
      const config = dap.findConfigFor(path);
      if (config === undefined) {
        throw new IpcProtocolError(
          "dap-no-adapter",
          `dap.start: nenhum adaptador de depuração para "${path}"`,
        );
      }
      return request.args[1] === true
        ? dap.start(config, { program: path, stopOnEntry: true })
        : dap.start(config, { program: path });
    }
    case "dap.stop":
      return requireDap(deps).stop().then(() => requireDap(deps).state);
    case "dap.state":
      return requireDap(deps).state;
    case "dap.setBreakpoints": {
      const dap = requireDap(deps);
      const handle = requireHandle(request.args[0], "dap.setBreakpoints");
      const rawSpecs = request.args[1];
      if (!Array.isArray(rawSpecs)) {
        throw new IpcProtocolError(
          "invalid-args",
          "dap.setBreakpoints: specs deve ser um array",
        );
      }
      // Aceita números (só a linha) ou specs com condição — a normalização é do core.
      const specs = normalizeBreakpointSpecs(rawSpecs);
      const path = core.registry.get(handle)?.uri;
      if (path === undefined) return [];
      return dap.setBreakpoints(path, specs);
    }
    case "dap.breakpoints": {
      const dap = requireDap(deps);
      const handle = requireHandle(request.args[0], "dap.breakpoints");
      const path = core.registry.get(handle)?.uri;
      if (path === undefined) return [];
      return dap.breakpointSpecsFor(path);
    }
    case "dap.threads":
      return requireDap(deps).threads();
    case "dap.stackTrace":
      return requireDap(deps).stackTrace(
        requireNumber(request.args[0], "dap.stackTrace", "threadId"),
      );
    case "dap.scopes":
      return requireDap(deps).scopes(
        requireNumber(request.args[0], "dap.scopes", "frameId"),
      );
    case "dap.variables":
      return requireDap(deps).variables(
        requireNumber(request.args[0], "dap.variables", "variablesReference"),
      );
    case "dap.continue":
      return requireDap(deps)
        .continueExecution(requireNumber(request.args[0], "dap.continue", "threadId"))
        .then(() => undefined);
    case "dap.pause":
      return requireDap(deps)
        .pause(requireNumber(request.args[0], "dap.pause", "threadId"))
        .then(() => undefined);
    case "dap.stepOver":
      return requireDap(deps)
        .stepOver(requireNumber(request.args[0], "dap.stepOver", "threadId"))
        .then(() => undefined);
    case "dap.stepInto":
      return requireDap(deps)
        .stepInto(requireNumber(request.args[0], "dap.stepInto", "threadId"))
        .then(() => undefined);
    case "dap.stepOut":
      return requireDap(deps)
        .stepOut(requireNumber(request.args[0], "dap.stepOut", "threadId"))
        .then(() => undefined);
    case "dap.evaluate": {
      const dap = requireDap(deps);
      const expression = request.args[0];
      if (typeof expression !== "string" || expression.trim().length === 0) {
        throw new IpcProtocolError(
          "invalid-args",
          "dap.evaluate: expression deve ser uma string não vazia",
        );
      }
      // Teto de tamanho (o mesmo da condição de breakpoint): expressão gigante é erro de
      // digitação e não vale o roundtrip — degrada com `null` + 1 `warn`.
      if (expression.trim().length > MAX_EVALUATION_LENGTH) {
        console.warn(
          `[dap] evaluate: expressão acima de ${MAX_EVALUATION_LENGTH} caracteres foi ignorada`,
        );
        return null;
      }
      // `frameId` é o **frame da pilha** (identificador do adaptador): inteiro positivo.
      const rawFrameId = request.args[1];
      if (
        typeof rawFrameId !== "number" ||
        !Number.isInteger(rawFrameId) ||
        rawFrameId <= 0
      ) {
        throw new IpcProtocolError(
          "invalid-args",
          "dap.evaluate: 'frameId' deve ser um inteiro positivo",
        );
      }
      const frameId = rawFrameId;
      // Só `watch` e `hover`: `repl` executa a expressão como **statement** no debuggee
      // (efeito colateral + mutação de estado) — o IPC não o aceita.
      const rawContext = request.args[2];
      const context: DapEvaluationContext = rawContext === "hover" ? "hover" : "watch";
      try {
        // O valor vem do programa depurado: é truncado antes de cruzar o IPC.
        return truncateEvaluation(await dap.evaluate(expression, frameId, context));
      } catch (err) {
        // Degradação silenciosa: o hover/watch mostra "—"; não derruba a UI.
        console.warn("[dap] evaluate falhou:", errorCode(err, "DAP_EVALUATE_FAILED"));
        return null;
      }
    }
    case "snippets.list": {
      const snippets = await packageSnippetsFor(core);
      return { snippets };
    }
    default:
      // Inalcançável: `parseIpcRequest` já validou o método; guarda contra regressão.
      throw new IpcProtocolError("unknown-method", "método desconhecido");
  }
}

/**
 * Fonte dos snippets de pacote — o subset do `EditorCore` que o cache usa (injetável: o
 * teste precisa de um `PackageResolver` fake).
 */
export interface PackageSnippetSource {
  /** Resolve quando o índice de pacotes estiver pronto. */
  readonly packagesReady: Promise<void>;
  /** Resolvedor de recursos de pacote. */
  readonly packages: PackageResolver;
}

/**
 * Cache dos snippets de pacote por core (o `snippets.list` é **global ao app**).
 *
 * A lista é lida do `PackageResolver` (I/O) — sem cache, cada chamada releria os arquivos
 * do pacote. O cache é invalidado quando o índice de pacotes é **reconstruído**
 * (`onDidBuild`).
 */
const snippetCache = new WeakMap<PackageSnippetSource, Promise<readonly PackageSnippetDefinition[]>>();

/**
 * Lê (e cacheia) os snippets de pacote do core.
 *
 * ⚠️ O cache guarda a **promise**: se ela **rejeitar**, todo `snippets.list` posterior
 * receberia a **mesma** rejeição (o cache nunca era invalidado) ⇒ o app ficava sem
 * snippets **para sempre**. Na rejeição a entrada é **evictida** (o erro é devolvido só
 * uma vez; a próxima chamada tenta de novo).
 */
export async function packageSnippetsFor(
  core: PackageSnippetSource,
): Promise<readonly PackageSnippetDefinition[]> {
  const cached = snippetCache.get(core);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<readonly PackageSnippetDefinition[]> => {
    // O índice de pacotes é construído no boot: espera (senão a 1ª chamada devolveria vazio).
    await core.packagesReady.catch(() => undefined);
    return collectPackageSnippets(core.packages);
  })();
  snippetCache.set(core, pending);
  // Promessa rejeitada ⇒ **evictir** a entrada (senão o erro se repete para sempre).
  void pending.catch(() => {
    if (snippetCache.get(core) === pending) snippetCache.delete(core);
  });
  // Índice reconstruído ⇒ a lista cacheada não vale mais.
  const subscription = core.packages.onDidBuild(() => {
    snippetCache.delete(core);
    subscription.dispose();
  });
  return pending;
}

function requireDap(deps: IpcHandlerDeps): DapManager {
  if (deps.dap === undefined) {
    throw new IpcProtocolError(
      "dap-unavailable",
      "depuração indisponível: gerente DAP não injetado",
    );
  }
  return deps.dap;
}

function extractId(raw: unknown): number {
  if (typeof raw === "object" && raw !== null) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "number" && Number.isInteger(id)) return id;
  }
  return 0;
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof IpcProtocolError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return fallback;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "erro desconhecido";
}

function timeAgoStr(date: Date): string {
  const diff = Date.now() - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "agora";
  const min = Math.floor(sec / 60);
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} mes${months > 1 ? "es" : ""}`;
  const years = Math.floor(months / 12);
  return `há ${years} ano${years > 1 ? "s" : ""}`;
}

function requireString(value: unknown, method: string, name: string): string {
  if (typeof value !== "string") {
    throw new IpcProtocolError("invalid-args", `${method}: '${name}' deve ser string`);
  }
  return value;
}

function requireNumber(value: unknown, method: string, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IpcProtocolError("invalid-args", `${method}: '${name}' deve ser número`);
  }
  return value;
}

function requireHandle(value: unknown, method: string): DocumentHandle {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new IpcProtocolError("invalid-args", `${method}: 'handle' deve ser inteiro`);
  }
  return value as DocumentHandle;
}

/**
 * Entradas do `document.batchInsert`: `{at, text, remove?}`.
 *
 * O `at` de cada entrada é **absoluto no estado do buffer após as entradas anteriores** ⇒ um
 * lote multi-cursor deve entrar em ordem **descendente**. `remove` (padrão `""`) é o trecho a
 * apagar em `at` (permite apagar em N cursores).
 */
interface BatchInsertEntry {
  readonly at: number;
  readonly text: string;
  readonly remove?: string;
}

/** Valida as entradas do lote (tipo errado ⇒ `invalid-args`, nunca aceito em silêncio). */
function requireBatchInserts(value: unknown, method: string): BatchInsertEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IpcProtocolError("invalid-args", `${method}: inserts deve ser array não vazio`);
  }
  const out: BatchInsertEntry[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "object" || item === null) {
      throw new IpcProtocolError("invalid-args", `${method}: cada insert deve ser um objeto`);
    }
    const record = item as Record<string, unknown>;
    const at = record["at"];
    const text = record["text"];
    const remove = record["remove"];
    if (typeof at !== "number" || !Number.isInteger(at) || at < 0) {
      throw new IpcProtocolError("invalid-args", `${method}: 'insert.at' deve ser inteiro >= 0`);
    }
    if (typeof text !== "string") {
      throw new IpcProtocolError("invalid-args", `${method}: 'insert.text' deve ser string`);
    }
    if (remove !== undefined && typeof remove !== "string") {
      throw new IpcProtocolError("invalid-args", `${method}: 'insert.remove' deve ser string`);
    }
    out.push({ at, text, ...(remove !== undefined ? { remove } : {}) });
  }
  return out;
}

/**
 * Conjunto de cursores (multi-cursor, P2#5) vindo do wire: `[{anchor, active}, …]`.
 *
 * **Opcional**: `undefined`/`null` (cliente antigo, ou chamada sem o parâmetro) ⇒ `undefined` (o
 * core infere o cursor). Um valor malformado é `invalid-args` — nunca aceito em silêncio.
 */
function optionalSelections(value: unknown, method: string): SelectionSet | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new IpcProtocolError("invalid-args", `${method}: 'selections' deve ser array`);
  }
  const out: Selection[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item !== "object" || item === null) {
      throw new IpcProtocolError("invalid-args", `${method}: 'selections' deve conter seleções`);
    }
    const record = item as Record<string, unknown>;
    const anchor = record["anchor"];
    const active = record["active"];
    if (
      typeof anchor !== "number" ||
      !Number.isInteger(anchor) ||
      anchor < 0 ||
      typeof active !== "number" ||
      !Number.isInteger(active) ||
      active < 0
    ) {
      throw new IpcProtocolError(
        "invalid-args",
        `${method}: 'selections' exige 'anchor'/'active' inteiros >= 0`,
      );
    }
    out.push({ anchor, active });
  }
  return out;
}

/** Valida/parseia um `SearchQuery` vindo do wire (sem `any`); tipo errado ⇒ `invalid-args`. */
function requireSearchQuery(value: unknown, method: string): SearchQuery {
  if (typeof value !== "object" || value === null) {
    throw new IpcProtocolError("invalid-args", `${method}: 'query' deve ser um objeto`);
  }
  const record = value as Record<string, unknown>;
  const pattern = record["pattern"];
  if (typeof pattern !== "string") {
    throw new IpcProtocolError("invalid-args", `${method}: 'query.pattern' deve ser string`);
  }
  const query: {
    pattern: string;
    regex?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    maxMatches?: number;
  } = { pattern };
  for (const key of ["regex", "caseSensitive", "wholeWord"] as const) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") {
      throw new IpcProtocolError("invalid-args", `${method}: 'query.${key}' deve ser booleano`);
    }
    query[key] = field;
  }
  const maxMatches = record["maxMatches"];
  if (maxMatches !== undefined) {
    if (typeof maxMatches !== "number" || !Number.isFinite(maxMatches)) {
      throw new IpcProtocolError("invalid-args", `${method}: 'query.maxMatches' deve ser número`);
    }
    query.maxMatches = maxMatches;
  }
  return query;
}

/** Opções da busca em todos os arquivos (`search.files`) — validadas no wire. */
function optionalSearchFilesOptions(value: unknown): {
  readonly roots?: readonly string[];
  readonly maxMatches?: number;
  readonly maxFiles?: number;
  readonly budgetMs?: number;
  readonly ignoreAccents?: boolean;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly includeBinary?: boolean;
} {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") {
    throw new IpcProtocolError("invalid-args", "search.files: options deve ser um objeto");
  }
  const record = value as Record<string, unknown>;
  const options: {
    roots?: readonly string[];
    maxMatches?: number;
    maxFiles?: number;
    budgetMs?: number;
    ignoreAccents?: boolean;
    regex?: boolean;
    caseSensitive?: boolean;
    includeBinary?: boolean;
  } = {};
  const roots = record["roots"];
  if (roots !== undefined) {
    const parsed = optionalStringArray(roots, "search.files");
    if (parsed !== undefined) options.roots = parsed;
  }
  for (const key of ["maxMatches", "maxFiles", "budgetMs"] as const) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== "number" || !Number.isFinite(field)) {
      throw new IpcProtocolError("invalid-args", `search.files: '${key}' deve ser número`);
    }
    options[key] = field;
  }
  // Os booleanos seguem o mesmo padrão do `requireSearchQuery`: tipo errado ⇒ `invalid-args`.
  for (const key of ["ignoreAccents", "regex", "caseSensitive", "includeBinary"] as const) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") {
      throw new IpcProtocolError("invalid-args", `search.files: '${key}' deve ser booleano`);
    }
    options[key] = field;
  }
  return options;
}

/** Raízes de recursos do app (diretório ausente é ignorado pelo scanner — DEC-PKG). */
export function packageRoots(appPath: string, userData: string): Partial<Record<ResourceLayer, readonly string[]>> {
  return {
    os: [join(__dirname, "..", "..", "res")],
    // Cada raiz é um **contentor de pacotes** (o scanner só desce em diretórios): a gramática de
    // brinde vive em `assets/grammars/`, então a raiz é `assets/` e o pacote é `grammars` —
    // apontar direto para `assets/grammars` faria o scanner **ignorar** a gramática.
    app: [join(appPath, "res"), join(appPath, "packages"), join(appPath, "assets")],
    user: [join(userData, "Packages")],
  };
}

/**
 * Ciclo de vida do Electron. Carrega `electron` **dinamicamente** (import estático quebraria o
 * uso do módulo em `node`), pelo que só deve ser chamada sob Electron.
 */
export async function startMainProcess(): Promise<void> {
  const electron = await import("electron");
  const { app, BrowserWindow, dialog, ipcMain } = electron;

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let core: EditorCore | null = null;
  let mainWindow: ElectronBrowserWindow | null = null;
  let ipcRegistration: Disposable | null = null;
  let diagnosticsSubscription: Disposable | null = null;
  let metricsTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  // Documento vindo da CLI (ex.: `electron . notas.txt`). `open-file` (macOS) pode chegar antes da
  // janela existir; guardamos o último e o consumimos na criação. Em dev, o Electron injeta `.`,
  // o diretório do app e o binário — descartamos os três.
  const ignoredArgv = [".", app.getAppPath(), process.execPath];
  let pendingDocumentPath: string | undefined = toAbsoluteDocumentPath(
    extractDocumentPath(process.argv, isExistingFile, ignoredArgv),
  );

  const events: IpcEventBroadcaster = createEventBroadcaster(() => BrowserWindow.getAllWindows());

  const signals = createIpcSignalRegistry();
  const fileDialog: FileDialogPort = {
    async showOpenDialog(): Promise<string | null> {
      const result =
        mainWindow === null || mainWindow.isDestroyed()
          ? await dialog.showOpenDialog({ properties: ["openFile"] })
          : await dialog.showOpenDialog(mainWindow, { properties: ["openFile"] });
      const chosen = result.filePaths[0];
      return result.canceled || chosen === undefined ? null : chosen;
    },
    async showSaveDialog(options?: { readonly defaultPath?: string }): Promise<string | null> {
      const defaultPath = options?.defaultPath;
      const saveOptions: ElectronSaveDialogOptions = {
        ...(defaultPath === undefined ? {} : { defaultPath }),
        filters: [
          { name: "Arquivos de texto", extensions: ["txt", "md", "markdown"] },
          {
            name: "Código",
            extensions: [
              "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "py", "rs", "go",
              "c", "h", "cpp", "hpp", "java", "cs", "rb", "php", "css", "html",
              "sh", "yml", "yaml", "toml", "xml", "sql",
            ],
          },
          { name: "Todos os arquivos", extensions: ["*"] },
        ],
      };
      const result =
        mainWindow === null || mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(saveOptions)
          : await dialog.showSaveDialog(mainWindow, saveOptions);
      const chosen = result.filePath;
      return result.canceled || chosen === undefined || chosen.length === 0 ? null : chosen;
    },
  };

  /** Caminho da casca do renderer — a **única** URL que o renderer pode navegar. */
  const rendererIndexPath = resolve(join(__dirname, "../renderer/index.html"));

  /** Carrega o `index.html` da casca, injetando o documento como query `file` quando houver. */
  const loadRenderer = (window: ElectronBrowserWindow, documentPath?: string): void => {
    if (documentPath === undefined) {
      void window.loadFile(rendererIndexPath);
    } else {
      void window.loadFile(rendererIndexPath, { query: { file: documentPath } });
    }
  };

  const createWindow = (documentPath?: string): ElectronBrowserWindow => {
    const window = new BrowserWindow({
      // Janela maior que a padrão: com rail (48) + painel lateral (240), 1024 deixava
      // só ~736px de editor — apertado para ler/editar. `minWidth` impede que o
      // layout colapse.
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 560,
      title: "Scribe",
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // **`window.open` não abre janela remota** (achado BAIXO): sem handler, o
    // `window.open("https://…")` do renderer abria uma page nova **dentro do app**
    // (ela não herda o preload, mas mesmo assim é uma navegação remota dentro do app).
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // **Navegação externa bloqueada**: só a casca do próprio app é permitido navegar.
    window.webContents.on("will-navigate", (event, url) => {
      if (isOwnRendererUrl(url, rendererIndexPath)) return;
      event.preventDefault();
      console.warn(`Scribe: navegação bloqueada: ${url}`);
    });
    // **Sem menu nativo**: o menu é do **DOM** (a casca é VS Code-like) — o menu nativo do
    // GTK não troca de menu no hover do mouse (e não é consertável: o Electron não importa
    // `gtk_menu_popup_at_widget`). `setMenu(null)` remove a barra nativa ⇒ o renderer
    // assume os aceleradores e os itens (o `scribe:menu:action` fica **morto** — o preload
    // ainda expõe `onMenuAction`, inofensivo: se o main nunca emite, o callback nunca roda).
    window.setMenu(null);
    // Diagnóstico: se o renderer morrer (crash/OOM), a janela fecha e o app inteiro sai
    // (`window-all-closed`). Logar o motivo é o que permite diagnosticar esse tipo de morte.
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error(
        `Scribe: renderer morreu (reason=${details.reason}, exitCode=${details.exitCode})`,
      );
    });
    window.webContents.on("unresponsive", () => {
      console.error("Scribe: renderer travou (unresponsive)");
    });
    loadRenderer(window, documentPath);
    window.once("ready-to-show", () => window.show());
    return window;
  };

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (metricsTimer !== null) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
    void lspManager.disconnectAll().catch(() => {});
    void dapManager.stop().catch(() => {});
    diagnosticsSubscription?.dispose();
    diagnosticsSubscription = null;
    ipcRegistration?.dispose();
    ipcRegistration = null;
    core?.dispose();
    core = null;
  };

  // Liveness legada do host de extensões (a preload continua consumindo `scribe:host:ping`).
  ipcMain.handle(IPC_CHANNELS.ping, () => "pong");

  // macOS: abrir arquivo pelo Finder/`open` com o app já rodando. Guarda o caminho e, se houver
  // janela, recarrega a casca com a query `file` (o renderer abre o documento no boot).
  app.on("open-file", (event, path) => {
    event.preventDefault();
    const target = resolve(path);
    pendingDocumentPath = target;
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      loadRenderer(mainWindow, target);
    }
  });

  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    mainWindow = createWindow(pendingDocumentPath);
  });

  app.on("will-quit", shutdown);

  await app.whenReady();

  // ── DAP: gerente de depuração (uma sessão por vez) ─────────────────────────────────────────
  const dapManager = new DapManager(BUILTIN_DAP_SERVERS);

  core = await createEditorCore({
    packageRoots: packageRoots(app.getAppPath(), app.getPath("userData")),
  });

  // ── DAP: salvar o documento **antes** de depurar ──────────────────────────────────────────
  // O debuggee roda o arquivo **do disco**: com o buffer sujo, o depurador pararia num código
  // diferente do que o editor mostra. O gancho roda **antes** do adaptador subir (o
  // `DapManager` cuida do resto) e é um no-op quando o documento não está aberto.
  dapManager.setBeforeLaunch(async (program: string) => {
    const current = core;
    if (current === null) return;
    const handle = current.findHandleByUri(program);
    if (handle === undefined) return;
    await current.saveDocument(handle);
  });

  ipcRegistration = registerIpcHandlers(core, ipcMain, events, {
    signals,
    dialog: fileDialog,
    dap: dapManager,
  });
  mainWindow = createWindow(pendingDocumentPath);

  // Encaminha os eventos do DAP para o renderer (estado, parada, saída e breakpoints).
  dapManager.onState((state) => {
    const envelope: IpcEventEnvelope<"dap.state"> = {
      v: IPC_VERSION,
      event: "dap.state",
      args: [{ state }],
    };
    events.broadcast(IPC_CHANNEL.event, envelope);
  });
  dapManager.onStopped((event) => {
    const envelope: IpcEventEnvelope<"dap.stopped"> = {
      v: IPC_VERSION,
      event: "dap.stopped",
      args: [{
        reason: event.reason,
        ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
        ...(event.description !== undefined ? { description: event.description } : {}),
        ...(event.text !== undefined ? { text: event.text } : {}),
      }],
    };
    events.broadcast(IPC_CHANNEL.event, envelope);
  });
  dapManager.onOutput((event) => {
    const envelope: IpcEventEnvelope<"dap.output"> = {
      v: IPC_VERSION,
      event: "dap.output",
      args: [{ category: event.category, output: event.output }],
    };
    events.broadcast(IPC_CHANNEL.event, envelope);
  });
  dapManager.onBreakpoints((event) => {
    const envelope: IpcEventEnvelope<"dap.breakpoints"> = {
      v: IPC_VERSION,
      event: "dap.breakpoints",
      args: [{ path: event.sourcePath, breakpoints: [...event.breakpoints] }],
    };
    events.broadcast(IPC_CHANNEL.event, envelope);
  });

  const activeCore = core;
  void activeCore.packagesReady.catch((error: unknown) => {
    console.error("Scribe: falha ao indexar pacotes", error);
  });

  // ── LSP: inicializa servidores ──────────────────────────────────────────────────────────────
  const lspManager = new LspManager(BUILTIN_LSP_SERVERS);

  /** Layout global do node (prefixo do `npm` + nvm) — memoizado no boot. */
  let nodeLayout: GlobalNodeLayout | undefined;
  function globalNodeLayout(): GlobalNodeLayout {
    nodeLayout ??= buildGlobalNodeLayout();
    return nodeLayout;
  }

  /**
   * Acha o `tsserver.js` do TypeScript **5.x** (o que o `typescript-language-server` usa).
   *
   * Ordem: (1) o `typescript` do próprio projeto (dev/build local); (2) o `typescript` global
   * do node do usuário — prefixo do `npm` **e** nvm (é o caso do **AppImage**, que não
   * embute `node_modules`).
   * ⚠️ O TypeScript **7+** (tsgo) **não tem** `tsserver.js` ⇒ o LSP não funciona com ele.
   */
  function resolveTsserverPath(): string | undefined {
    try {
      const local = require.resolve("typescript/lib/tsserver.js");
      // ⚠️ No **AppImage** o `node_modules` do projeto não é embutido ⇒ o path resolvido
      // **não existe** em disco ⇒ o servidor LSP rejeitaria o `tsserver` ⇒ handshake
      // travado. Só use o path local se ele realmente existir.
      if (existsSync(local)) return local;
    } catch {
      // sem `typescript` local — tenta o global
    }
    for (const root of globalNodeLayout().moduleRoots) {
      const candidate = join(root, "typescript", "lib", "tsserver.js");
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * Garante que os servidores LSP (`typescript-language-server`, `pyright-langserver`) estejam
   * no `PATH` do processo.
   *
   * Eles são instalados pelo `npm -g` — que o `setup.py` roda no **shell do usuário**. Quando o
   * app é aberto pelo **AppImage** (launcher do desktop), o `PATH` é o da sessão do desktop e
   * **não** tem o `bin` do node do usuário ⇒ o spawn falhava com ENOENT e o app ficava sem
   * LSP. Aqui acrescentamos o `bin` do **prefixo global do `npm`** e o do nvm, se existirem.
   */
  function ensureLspServersOnPath(): void {
    const path = process.env["PATH"] ?? "";
    const parts = path.split(":").filter((p) => p.length > 0);
    const has = (bin: string): boolean => parts.some((p) => existsSync(join(p, bin)));
    if (has("typescript-language-server") && has("pyright-langserver")) return;

    // ⚠️ Ordem: o prefixo do `npm` (toolchain ativo do usuário) **primeiro**, depois o nvm
    // (do mais novo para o mais antigo). Duplicatas removidas (o prefixo do `npm` pode ser
    // uma das versões do nvm).
    const seen = new Set<string>();
    const candidates = globalNodeLayout().binDirs.filter((dir) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return true;
    });
    // ⚠️ `unshift` em laço inverteria a ordem (o **mais antigo** do nvm ficaria na frente ⇒ o
    // `node` v14 seria o do PATH ⇒ os servidores LSP (que exigem Node ≥ 18) não subem).
    // `unshift(...candidates)` preserva a ordem: o mais novo primeiro.
    const missing = candidates.filter((dir) => !parts.includes(dir));
    if (missing.length > 0) parts.unshift(...missing);
    if (parts.length > 0) process.env["PATH"] = parts.join(":");
  }

  // ⚠️ A chamada vem **depois** da declaração de `nodeLayout` (acima): chamar antes cairia
  // na zona morta temporal do `let` ⇒ ReferenceError no boot (o app não subia no AppImage).
  ensureLspServersOnPath();

  // Detecta pastas de workspace a partir do CWD (marcador: .git / package.json / pyproject.toml)
  function detectWorkspaceFolders(): readonly { readonly uri: string; readonly name: string }[] {
    const dir = process.cwd();
    const markers = [dir + "/.git", dir + "/package.json", dir + "/pyproject.toml"];
    const found = markers.some((p) => { try { statSync(p); return true; } catch { return false; } });
    if (found) {
      return [{ uri: "file://" + dir, name: dir.split("/").filter(Boolean).pop() ?? "workspace" }];
    }
    return [];
  }
  const wf = detectWorkspaceFolders();
  if (wf.length > 0) lspManager.setWorkspaceFolders(wf);

  // Conecta diagnósticos ao broadcast IPC: resolve handle pela URI e dispara evento.
  // ⚠️ Os dados vêm do **próprio evento** (e não do cache do core) — ver
  // {@link broadcastLspDiagnostics}: o cache do core é atualizado **depois** deste listener.
  diagnosticsSubscription = broadcastLspDiagnostics(lspManager, activeCore, events);

  // Inicia cada servidor builtin com try/catch (pode não estar instalado)
  const lspInitPromises = [];
  for (const baseConfig of BUILTIN_LSP_SERVERS) {
    if (!baseConfig.enabled) continue;

    // Para o TypeScript server: injeta o path do `typescript` local como
    // `initializationOptions.tsserver.path` (o server global precisa saber
    // onde está o `tsserver.js` — sem isso ele rejeita o handshake).
    let config = baseConfig;
    if (baseConfig.languageId === "typescript") {
      const tsserverPath = resolveTsserverPath();
      console.info(`Scribe: tsserver.path = ${tsserverPath ?? "(não encontrado)"}`);
      if (tsserverPath !== undefined) {
        config = {
          ...baseConfig,
          initializationOptions: {
            ...baseConfig.initializationOptions,
            tsserver: { path: tsserverPath },
          },
        };
      }
      // Sem `tsserver.js` (o TypeScript 7+/tsgo **não tem** `tsserver.js`; o servidor LSP
      // precisa do TS 5.x) — deixa o config original e o `startServer` mostra o warning.
    }

    lspInitPromises.push(
      lspManager.startServer(config).then((client) => {
        console.info(`Scribe: servidor LSP "${config.name}" iniciado`);
        return client;
      }).catch((error: unknown) => {
        console.warn(`Scribe: servidor LSP "${config.name}" não disponível:`, error instanceof Error ? error.message : String(error));
      }),
    );
  }
  // Aguarda todos os servidores tentarem iniciar e depois associa ao core
  void Promise.allSettled(lspInitPromises).then(() => {
    activeCore.attachLsp(lspManager);
    console.info("Scribe: LSP Manager associado ao EditorCore");
  });

  // P3#10: plugin host — inicia o processo de extensão em background.
  // O entry bundleado vive em `dist/core/extension/plugin-host-entry.js`.
  void activeCore.startPluginHost(join(__dirname, "../core/extension/plugin-host-entry.js"), {
    name: "scribe-plugin-host",
  }).then((session) => {
    console.info(
      `Scribe: plugin host ready (handle=${session.handle}, name=${session.name}, pid=${describePluginHostPid(session)})`,
    );
  }).catch((error: unknown) => {
    console.warn("Scribe: plugin host não disponível (modo headless ou Electron ausente?)", error);
  });

  metricsTimer = setInterval(() => {
    const busy: MainThreadBusy = activeCore.snapshot();
    console.info(`Scribe: MainThreadBusy ${JSON.stringify(busy)}`);
  }, METRICS_INTERVAL_MS);
  metricsTimer.unref();
}

// Só arranca sob Electron; em `node`/vitest o módulo é apenas importável (sem efeitos colaterais).
if (process.versions.electron !== undefined) {
  void startMainProcess().catch((error: unknown) => {
    console.error("Scribe: falha no boot do processo principal", error);
  });
}
