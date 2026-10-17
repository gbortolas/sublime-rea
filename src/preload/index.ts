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
import type {
  DocumentChangedEvent,
  DocumentHandle,
  DocumentHighlight,
  DocumentUndoState,
  MainThreadBusy,
  ReplaceAllResult,
  SearchDocumentResult,
  SearchQuery,
} from "../shared";

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
  open(path: string, signalId?: number): Promise<DocumentHandle>;
  openDialog(): Promise<string | null>;
  text(handle: DocumentHandle): Promise<string>;
  revision(handle: DocumentHandle): Promise<number>;
  insert(
    handle: DocumentHandle,
    at: number,
    text: string,
    origin?: InsertOrigin,
  ): Promise<number>;
  undo(handle: DocumentHandle): Promise<DocumentUndoState>;
  redo(handle: DocumentHandle): Promise<DocumentUndoState>;
  undoState(handle: DocumentHandle): Promise<DocumentUndoState>;
  /** Destaque de sintaxe de um range de linhas (o main resolve a gramática e tokeniza). */
  highlight(handle: DocumentHandle, first: number, count: number): Promise<DocumentHighlight>;
  /** Busca numa lane de fundo (o main usa o `TaskPool` + `Scheduler`). */
  find(handle: DocumentHandle, query: SearchQuery): Promise<SearchDocumentResult>;
  /** Substitui todas as ocorrências (um só passo de undo). */
  replaceAll(
    handle: DocumentHandle,
    query: SearchQuery,
    replacement: string,
  ): Promise<ReplaceAllResult>;
  /** Cancela a operação em voo identificada por `signalId` (envelope `IpcCancel`). */
  cancel(signalId: number): void;
  /** Gera um `signalId` novo para uma operação cancelável (evita colisão com outros chamadores). */
  nextSignalId(): number;
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
  readonly signalId?: number;
}

/** Push de cancelamento (mesmo canal; sem `id`/`method` — o main despacha pelo `kind`). */
interface CancelEnvelope {
  readonly v: string;
  readonly kind: "cancel";
  readonly signalId: number;
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
let signalSeq = 0;

/** Envia um request e desembrulha a resposta; erro remoto vira exceção tipada (nunca silencioso). */
function call<T>(method: string, args: readonly unknown[], signalId?: number): Promise<T> {
  requestSeq += 1;
  const id = requestSeq;
  const envelope: RequestEnvelope =
    signalId === undefined ? { v: IPC_VERSION, id, method, args } : { v: IPC_VERSION, id, method, args, signalId };
  return ipcRenderer.invoke(CHANNEL_REQUEST, envelope).then((raw: unknown) => unwrap<T>(raw, id));
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
  open: (path: string, signalId?: number): Promise<DocumentHandle> =>
    call<DocumentHandle>("document.open", [path], signalId),
  openDialog: (): Promise<string | null> => call<string | null>("document.openDialog", []),
  text: (handle: DocumentHandle): Promise<string> => call<string>("document.text", [handle]),
  revision: (handle: DocumentHandle): Promise<number> =>
    call<number>("document.revision", [handle]),
  insert: (
    handle: DocumentHandle,
    at: number,
    text: string,
    origin: InsertOrigin = "user",
  ): Promise<number> => call<number>("document.insert", [handle, at, text, origin]),
  undo: (handle: DocumentHandle): Promise<DocumentUndoState> =>
    call<DocumentUndoState>("editor.undo", [handle]),
  redo: (handle: DocumentHandle): Promise<DocumentUndoState> =>
    call<DocumentUndoState>("editor.redo", [handle]),
  undoState: (handle: DocumentHandle): Promise<DocumentUndoState> =>
    call<DocumentUndoState>("editor.undoState", [handle]),
  highlight: (handle: DocumentHandle, first: number, count: number): Promise<DocumentHighlight> =>
    call<DocumentHighlight>("syntax.highlight", [handle, first, count]),
  find: (handle: DocumentHandle, query: SearchQuery): Promise<SearchDocumentResult> =>
    call<SearchDocumentResult>("search.find", [handle, query]),
  replaceAll: (
    handle: DocumentHandle,
    query: SearchQuery,
    replacement: string,
  ): Promise<ReplaceAllResult> =>
    call<ReplaceAllResult>("search.replaceAll", [handle, query, replacement]),
  cancel: (signalId: number): void => {
    const envelope: CancelEnvelope = { v: IPC_VERSION, kind: "cancel", signalId };
    // Push: sem resposta correlacionada; engolir a rejeição da ponte é intencional.
    void ipcRenderer.invoke(CHANNEL_REQUEST, envelope).catch(() => undefined);
  },
  nextSignalId: (): number => {
    signalSeq += 1;
    return signalSeq;
  },
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
