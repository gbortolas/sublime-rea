/**
 * Scribe — preload (ponte tipada via `contextBridge`).
 *
 * Requisitos (ver `docs/scaffold/00-convencoes-e-costuras.md` e `04-render-e-ui.md`):
 * - `sandbox: true` ⇒ o preload **não** pode `require` módulos locais: só `electron` em runtime.
 *   Por isso os nomes de canal/versão do contrato (`src/shared/ipc-contract.ts`) são **duplicados**
 *   aqui (strings constantes), e os tipos vêm por `import type` (apagado na compilação).
 * - `contextIsolation: true` ⇒ **nunca** expor `ipcRenderer` cru; só a superfície mínima abaixo.
 *
 * Superfície exposta: `window.scribe`.
 * - `scribe.open/text/revision/insert/snapshot` → request/response por `id` (DEC-IPC-4/5).
 * - `scribe.onDocumentChanged(cb)` → cancela a inscrição (evento `document.changed`).
 * - `scribe.host.ping/onReady` → liveness legada do host de extensões.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { DocumentChangedEvent, DocumentHandle, MainThreadBusy } from "../shared";

export interface HostReadyInfo {
  readonly apiVersion: string;
  readonly hostVersion: string;
}

/** Origem da edição aceita pelo contrato de `document.insert`. */
export type InsertOrigin = "plugin" | "user";

export interface ScribePreloadApi {
  readonly host: {
    ping(): Promise<"pong">;
    onReady(callback: (info: HostReadyInfo) => void): () => void;
  };
  open(path: string): Promise<DocumentHandle>;
  text(handle: DocumentHandle): Promise<string>;
  revision(handle: DocumentHandle): Promise<number>;
  insert(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin?: InsertOrigin,
  ): Promise<number>;
  snapshot(): Promise<MainThreadBusy>;
  onDocumentChanged(callback: (event: DocumentChangedEvent) => void): () => void;
}

// Duplicado de propósito: o preload não importa `src/shared` em runtime (sandbox).
const CHANNEL_REQUEST = "scribe:ipc:request";
const CHANNEL_EVENT = "scribe:ipc:event";
const IPC_VERSION = "1.0";
const CHANNEL_PING = "scribe:host:ping";
const CHANNEL_READY = "scribe:host:ready";

interface RequestEnvelope {
  readonly v: string;
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

interface ResponseEnvelope {
  readonly v: string;
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface EventEnvelope {
  readonly v: string;
  readonly event: string;
  readonly args: readonly unknown[];
}

let requestSeq = 0;

/** Envia um request e desembrulha a resposta; erro remoto vira exceção tipada (nunca silencioso). */
function call<T>(method: string, args: readonly unknown[]): Promise<T> {
  requestSeq += 1;
  const envelope: RequestEnvelope = { v: IPC_VERSION, id: requestSeq, method, args };
  return ipcRenderer
    .invoke(CHANNEL_REQUEST, envelope)
    .then((raw: unknown) => unwrap<T>(raw, requestSeq));
}

function unwrap<T>(raw: unknown, id: number): T {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Scribe IPC: resposta inválida (id ${id})`);
  }
  const response = raw as ResponseEnvelope;
  if (response.ok === true) return response.value as T;
  const code = response.error?.code ?? "unknown";
  const message = response.error?.message ?? "erro remoto sem mensagem";
  throw new Error(`Scribe IPC[${code}]: ${message}`);
}

const api: ScribePreloadApi = {
  host: {
    ping: (): Promise<"pong"> => ipcRenderer.invoke(CHANNEL_PING) as Promise<"pong">,
    onReady: (callback: (info: HostReadyInfo) => void): (() => void) => {
      const listener = (_event: unknown, info: HostReadyInfo): void => callback(info);
      ipcRenderer.on(CHANNEL_READY, listener);
      return () => {
        ipcRenderer.removeListener(CHANNEL_READY, listener);
      };
    },
  },
  open: (path: string): Promise<DocumentHandle> => call<DocumentHandle>("document.open", [path]),
  text: (handle: DocumentHandle): Promise<string> => call<string>("document.text", [handle]),
  revision: (handle: DocumentHandle): Promise<number> =>
    call<number>("document.revision", [handle]),
  insert: (
    handle: DocumentHandle,
    at: number,
    text: string,
    origin: InsertOrigin = "user",
  ): Promise<number> => call<number>("document.insert", [handle, at, text, origin]),
  snapshot: (): Promise<MainThreadBusy> => call<MainThreadBusy>("editor.snapshot", []),
  onDocumentChanged: (callback: (event: DocumentChangedEvent) => void): (() => void) => {
    const listener = (_event: unknown, raw: unknown): void => {
      if (typeof raw !== "object" || raw === null) return;
      const envelope = raw as EventEnvelope;
      if (envelope.event !== "document.changed") return;
      const argument = envelope.args[0];
      if (typeof argument === "object" && argument !== null) {
        callback(argument as DocumentChangedEvent);
      }
    };
    ipcRenderer.on(CHANNEL_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(CHANNEL_EVENT, listener);
    };
  },
};

contextBridge.exposeInMainWorld("scribe", api);

declare global {
  interface Window {
    readonly scribe: ScribePreloadApi;
  }
}
