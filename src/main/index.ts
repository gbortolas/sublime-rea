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
import { join } from "node:path";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";

import { createNodeFileSystem } from "../core/buffer";
import { createEditorCore as composeEditorCore } from "../core/editor";
import type { EditorCore, EditorCoreOptions } from "../core/editor";
import { IPC_CHANNEL, IPC_VERSION, IpcProtocolError, parseIpcRequest, toDisposable } from "../shared";
import type {
  Disposable,
  DocumentHandle,
  IpcEventEnvelope,
  IpcRequest,
  IpcResponse,
  MainThreadBusy,
  ResourceLayer,
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
): Disposable {
  const subscription = core.onDocumentChanged((event) => {
    const envelope: IpcEventEnvelope<"document.changed"> = {
      v: IPC_VERSION,
      event: "document.changed",
      args: [event],
    };
    events.broadcast(IPC_CHANNEL.event, envelope);
  });
  ipc.handle(IPC_CHANNEL.request, (_event, raw) => handleIpcRequest(core, raw));
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
export async function handleIpcRequest(core: EditorCore, raw: unknown): Promise<IpcResponse> {
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
  try {
    const value = await dispatchIpc(core, request);
    return { v: IPC_VERSION, id: request.id, ok: true, value };
  } catch (error) {
    return {
      v: IPC_VERSION,
      id: request.id,
      ok: false,
      error: { code: errorCode(error, "dispatch-failed"), message: messageOf(error) },
    };
  }
}

async function dispatchIpc(core: EditorCore, request: IpcRequest): Promise<unknown> {
  switch (request.method) {
    case "document.open":
      return core.openDocument(requireString(request.args[0], "document.open", "path"));
    case "document.text":
      return core.documentText(requireHandle(request.args[0], "document.text"));
    case "document.revision":
      return core.revisionOf(requireHandle(request.args[0], "document.revision"));
    case "document.insert": {
      const handle = requireHandle(request.args[0], "document.insert");
      const at = requireNumber(request.args[1], "document.insert", "at");
      const text = requireString(request.args[2], "document.insert", "text");
      const origin = request.args[3] === "plugin" ? "plugin" : "user";
      return core.insertText(handle, at, text, origin);
    }
    case "editor.snapshot":
      return core.snapshot();
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

/** Raízes de recursos do app (diretório ausente é ignorado pelo scanner — DEC-PKG). */
function packageRoots(appPath: string, userData: string): Partial<Record<ResourceLayer, readonly string[]>> {
  return {
    os: [join(__dirname, "..", "..", "res")],
    app: [join(appPath, "res"), join(appPath, "packages")],
    user: [join(userData, "Packages")],
  };
}

/**
 * Ciclo de vida do Electron. Carrega `electron` **dinamicamente** (import estático quebraria o
 * uso do módulo em `node`), pelo que só deve ser chamada sob Electron.
 */
export async function startMainProcess(): Promise<void> {
  const electron = await import("electron");
  const { app, BrowserWindow, ipcMain } = electron;

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let core: EditorCore | null = null;
  let mainWindow: ElectronBrowserWindow | null = null;
  let ipcRegistration: Disposable | null = null;
  let metricsTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const events: IpcEventBroadcaster = {
    broadcast: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(channel, payload);
      }
    },
  };

  const createWindow = (): ElectronBrowserWindow => {
    const window = new BrowserWindow({
      width: 1024,
      height: 768,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    void window.loadFile(join(__dirname, "../renderer/index.html"));
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
    mainWindow = createWindow();
  });

  app.on("will-quit", shutdown);

  await app.whenReady();

  core = await createEditorCore({
    packageRoots: packageRoots(app.getAppPath(), app.getPath("userData")),
  });
  ipcRegistration = registerIpcHandlers(core, ipcMain, events);
  mainWindow = createWindow();

  const activeCore = core;
  void activeCore.packagesReady.catch((error: unknown) => {
    console.error("Scribe: falha ao indexar pacotes", error);
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
