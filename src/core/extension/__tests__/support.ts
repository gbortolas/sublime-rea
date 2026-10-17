/**
 * Apoio de teste do módulo `core/extension` (não é um teste; fica fora do build via `__tests__/**`).
 *
 * Provê um par de portas **em memória** compatível com `BridgePort` (entrega assíncrona por
 * microtask, como um `MessagePort` real) — os testes nunca abrem Electron.
 */
import type { BridgePort } from "../../../shared";

export interface MemoryPortPair {
  readonly a: BridgePort;
  readonly b: BridgePort;
}

function makePort(own: Set<(value: unknown) => void>, peer: Set<(value: unknown) => void>): BridgePort {
  const port: BridgePort = {
    postMessage: (message: unknown): void => {
      for (const listener of [...peer]) queueMicrotask(() => listener(message));
    },
    on: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") own.add(listener);
      return port;
    },
    off: (event: "message", listener: (value: unknown) => void): BridgePort => {
      if (event === "message") own.delete(listener);
      return port;
    },
    start: (): void => {
      /* nada: entrega já é assíncrona por microtask */
    },
    close: (): void => {
      own.clear();
    },
  };
  return port;
}

/** Par de portas ligadas: o que `a` posta chega aos listeners de `b` (e vice-versa). */
export function createMemoryPortPair(): MemoryPortPair {
  const aListeners = new Set<(value: unknown) => void>();
  const bListeners = new Set<(value: unknown) => void>();
  return {
    a: makePort(aListeners, bListeners),
    b: makePort(bListeners, aListeners),
  };
}

/** Captura tudo que chega numa porta (sem interferir no dispatch). */
export function collect(port: BridgePort): unknown[] {
  const messages: unknown[] = [];
  port.on("message", (message: unknown) => {
    messages.push(message);
  });
  return messages;
}

/** Esvazia a fila de microtasks/macrotasks (entrega de mensagens em memória). */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
