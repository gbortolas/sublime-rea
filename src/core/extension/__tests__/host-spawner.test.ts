/**
 * Testes do spawner de `utilityProcess` (Electron) — **vazamento de listener**.
 *
 * ⚠️ O `on("message")` do processo registra um *wrapper* (o `utilityProcess` entrega
 * mensagens tipadas), mas o `off` recebia o listener **original** ⇒ `removeListener` não
 * encontrava o wrapper e ele **nunca saía** (vazamento + mensagem pós-`close`).
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const { electronMock } = vi.hoisted(() => ({
  electronMock: { child: undefined as unknown },
}));

vi.mock("electron", () => ({
  utilityProcess: {
    fork: (): unknown => electronMock.child,
  },
}));

import { electronHostSpawner } from "../host";

/** Processo hospedado falso — o suficiente para `on`/`removeListener`/`postMessage`. */
class FakeUtilityProcess extends EventEmitter {
  readonly pid = 4242;
  readonly sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  kill(): void {
    /* nada */
  }
}

describe("electronHostSpawner — ciclo de vida do listener", () => {
  it("off remove o listener registrado (o wrapper sai do processo)", async () => {
    const child = new FakeUtilityProcess();
    electronMock.child = child;

    const proc = await electronHostSpawner.spawn("/entry.js", { env: {}, name: "test" });
    const listener = (): void => {};

    proc.on("message", listener);
    expect(child.listenerCount("message")).toBe(1);

    proc.off("message", listener);
    // O wrapper **sai** — antes ele ficava registrado para sempre.
    expect(child.listenerCount("message")).toBe(0);
  });

  it("a mensagem chega ao listener original enquanto ele está registrado", async () => {
    const child = new FakeUtilityProcess();
    electronMock.child = child;

    const proc = await electronHostSpawner.spawn("/entry.js", { env: {}, name: "test" });
    const received: unknown[] = [];
    const listener = (message: unknown): void => {
      received.push(message);
    };

    proc.on("message", listener);
    child.emit("message", { hello: 1 });
    expect(received).toEqual([{ hello: 1 }]);

    proc.off("message", listener);
    child.emit("message", { hello: 2 });
    // Depois do `off` não chega mais nada (o listener vazado continuava ativo).
    expect(received).toHaveLength(1);
  });
});
