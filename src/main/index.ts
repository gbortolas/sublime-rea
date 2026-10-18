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
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";

import { createNodeFileSystem } from "../core/buffer";
import { createEditorCore as composeEditorCore } from "../core/editor";
import type { EditorCore, EditorCoreOptions } from "../core/editor";
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
  IpcEventEnvelope,
  IpcRequest,
  IpcResponse,
  MainThreadBusy,
  ResourceLayer,
  SearchQuery,
} from "../shared";

export type { EditorCore, EditorCoreOptions } from "../core/editor";

/**
 * Canais legados do host de extensões (a preload duplica as strings — ela não importa este
 * módulo). Mantidos para a *liveness* `ping`/`ready` que a ponte tipada do preload consome.
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
}

/** Dependências injetadas no despacho de IPC (tudo opcional — os testes passam o que precisam). */
export interface IpcHandlerDeps {
  readonly signals?: IpcSignalRegistry;
  readonly dialog?: FileDialogPort;
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
  const handlerDeps: IpcHandlerDeps =
    deps.dialog !== undefined ? { signals, dialog: deps.dialog } : { signals };

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

async function dispatchIpc(
  core: EditorCore,
  request: IpcRequest,
  deps: IpcHandlerDeps,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  switch (request.method) {
    case "document.open":
      return core.openDocument(requireString(request.args[0], "document.open", "path"), signal);
    case "document.openDialog": {
      if (deps.dialog === undefined) {
        throw new IpcProtocolError(
          "dialog-unavailable",
          "document.openDialog: nenhum diálogo foi injetado",
        );
      }
      return deps.dialog.showOpenDialog();
    }
    case "document.text":
      return core.documentText(requireHandle(request.args[0], "document.text"));
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
      return core.insertText(handle, at, text, origin);
    }
    case "document.replaceOne": {
      const handle = requireHandle(request.args[0], "document.replaceOne");
      const at = requireNumber(request.args[1], "document.replaceOne", "at");
      const remove = requireNumber(request.args[2], "document.replaceOne", "remove");
      const insert = requireString(request.args[3], "document.replaceOne", "insert");
      return core.replaceOne(handle, at, remove, insert);
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
    case "command.list":
      return core.listCommands();
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
          await core.openDocument(path, signal);
        }
        return;
      }
      return core.executeCommand(commandId);
    }
    default:
      // Inalcançável: `parseIpcRequest` já validou o método; guarda contra regressão.
      throw new IpcProtocolError("unknown-method", "método desconhecido");
  }
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
  const { app, BrowserWindow, dialog, ipcMain, Menu } = electron;

  function sendMenuAction(window: ElectronBrowserWindow | null, action: string): void {
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.menuAction, action);
    }
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let core: EditorCore | null = null;
  let mainWindow: ElectronBrowserWindow | null = null;
  let ipcRegistration: Disposable | null = null;
  let metricsTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  // Documento vindo da CLI (ex.: `electron . notas.txt`). `open-file` (macOS) pode chegar antes da
  // janela existir; guardamos o último e o consumimos na criação. Em dev, o Electron injeta `.`,
  // o diretório do app e o binário — descartamos os três.
  const ignoredArgv = [".", app.getAppPath(), process.execPath];
  let pendingDocumentPath: string | undefined = toAbsoluteDocumentPath(
    extractDocumentPath(process.argv, isExistingFile, ignoredArgv),
  );

  const events: IpcEventBroadcaster = {
    broadcast: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(channel, payload);
      }
    },
  };

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
  };

  /** Carrega o `index.html` da casca, injetando o documento como query `file` quando houver. */
  const loadRenderer = (window: ElectronBrowserWindow, documentPath?: string): void => {
    const indexHtml = join(__dirname, "../renderer/index.html");
    if (documentPath === undefined) {
      void window.loadFile(indexHtml);
    } else {
      void window.loadFile(indexHtml, { query: { file: documentPath } });
    }
  };

  const createWindow = (documentPath?: string): ElectronBrowserWindow => {
    const window = new BrowserWindow({
      width: 1024,
      height: 768,
      title: "Scribe",
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Menu in-window (rápido no Linux, sem D-Bus lag)
    window.setMenu(createAppMenu(window));
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

  /** Constrói o menu nativo para uma janela específica (in-window, sem D-Bus). */
  const createAppMenu = (win: ElectronBrowserWindow): Electron.Menu => {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "File",
        submenu: [
          { label: "Open", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction(win, "file.open") },
          { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenuAction(win, "file.save") },
          { type: "separator" },
          { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => sendMenuAction(win, "edit.undo") },
          { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: () => sendMenuAction(win, "edit.redo") },
          { type: "separator" },
          { label: "Cut", accelerator: "CmdOrCtrl+X", click: () => sendMenuAction(win, "edit.cut") },
          { label: "Copy", accelerator: "CmdOrCtrl+C", click: () => sendMenuAction(win, "edit.copy") },
          { label: "Paste", accelerator: "CmdOrCtrl+V", click: () => sendMenuAction(win, "edit.paste") },
          { label: "Select All", accelerator: "CmdOrCtrl+A", click: () => sendMenuAction(win, "edit.selectAll") },
        ],
      },
      {
        label: "Find",
        submenu: [
          { label: "Find", accelerator: "CmdOrCtrl+F", click: () => sendMenuAction(win, "find.open") },
          { label: "Find Next", accelerator: "F3", click: () => sendMenuAction(win, "find.next") },
          { label: "Find Previous", accelerator: "Shift+F3", click: () => sendMenuAction(win, "find.prev") },
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Toggle Theme", accelerator: "CmdOrCtrl+Shift+T", click: () => sendMenuAction(win, "view.toggleTheme") },
        ],
      },
    ];
    return Menu.buildFromTemplate(template);
  };

  await app.whenReady();

  core = await createEditorCore({
    packageRoots: packageRoots(app.getAppPath(), app.getPath("userData")),
  });
  ipcRegistration = registerIpcHandlers(core, ipcMain, events, {
    signals,
    dialog: fileDialog,
  });
  mainWindow = createWindow(pendingDocumentPath);

  const activeCore = core;
  void activeCore.packagesReady.catch((error: unknown) => {
    console.error("Scribe: falha ao indexar pacotes", error);
  });

  // P3#10: plugin host — inicia o processo de extensão em background.
  // O entry bundleado vive em `dist/core/extension/plugin-host-entry.js`.
  void activeCore.startPluginHost(join(__dirname, "../core/extension/plugin-host-entry.js"), {
    name: "scribe-plugin-host",
  }).then((session) => {
    console.info(`Scribe: plugin host ready (handle=${session.handle}, pid=${String((session as { bridge?: { port?: unknown } }).bridge?.port)}`);
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
