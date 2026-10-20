/**
 * Testes do cliente DAP (correlação de requisições, eventos, requisições reversas).
 *
 * Usa um transporte falso — o cliente só depende de `onMessage`, `connected`, `send`,
 * `connect` e `disconnect`.
 */
import { describe, expect, it, vi } from "vitest";

import { DapClient } from "../dap-client";
import { DapRequestError } from "../dap-protocol";
import type { Disposable } from "../../../shared/disposable";
import type { DapStdioTransport } from "../dap-transport";

// ── Transporte falso ────────────────────────────────────────────────────────────────────────

interface FakeTransport {
  readonly transport: DapStdioTransport;
  deliver(msg: unknown): void;
  /** Entrega texto cru (sem serializar) — para simular JSON inválido. */
  deliverRaw(raw: string): void;
  readonly sent: string[];
  isConnected(): boolean;
  setConnected(value: boolean): void;
}

function createFakeTransport(): FakeTransport {
  let handler: ((raw: string) => void) | undefined;
  let connected = false;
  const sent: string[] = [];
  const fake = {
    // Conforme o contrato `Event<T>`: devolve um `Disposable` (objeto com `.dispose()`).
    onMessage: (h: (raw: string) => void): Disposable => {
      handler = h;
      let active = true;
      return {
        dispose: (): void => {
          if (!active) return;
          active = false;
          handler = undefined;
        },
      };
    },
    get connected(): boolean {
      return connected;
    },
    connect: async (): Promise<void> => {
      connected = true;
    },
    send: (raw: string): void => {
      sent.push(raw);
    },
    disconnect: (): void => {
      connected = false;
    },
    dispose: (): void => {},
  };
  return {
    transport: fake as unknown as DapStdioTransport,
    deliver: (msg: unknown): void => {
      handler?.(JSON.stringify(msg));
    },
    deliverRaw: (raw: string): void => {
      handler?.(raw);
    },
    sent,
    isConnected: (): boolean => connected,
    setConnected: (value: boolean): void => {
      connected = value;
    },
  };
}

// ── Testes ──────────────────────────────────────────────────────────────────────────────────

describe("DapClient", () => {
  it("sendRequest sem conexão lança DAP_NOT_CONNECTED", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await expect(client.sendRequest("threads")).rejects.toMatchObject({ code: "DAP_NOT_CONNECTED" });
  });

  it("sendRequest serializa a requisição com seq e command", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await client.connect();
    const pending = client.sendRequest("stackTrace", { threadId: 7 });
    expect(fake.sent).toHaveLength(1);
    const msg = JSON.parse(fake.sent[0] ?? "{}") as { seq: number; type: string; command: string; arguments?: unknown };
    expect(msg).toMatchObject({ seq: 1, type: "request", command: "stackTrace", arguments: { threadId: 7 } });
    // Cobre a promise para não vazar rejeição no fim do teste
    fake.deliver({ seq: 1, type: "response", request_seq: 1, success: true, command: "stackTrace", body: {} });
    await pending;
  });

  it("correlaciona a resposta por request_seq e resolve com o body", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await client.connect();
    const pending = client.sendRequest("threads");
    fake.deliver({
      seq: 9,
      type: "response",
      request_seq: 1,
      success: true,
      command: "threads",
      body: { threads: [{ id: 1, name: "Main" }] },
    });
    await expect(pending).resolves.toEqual({ threads: [{ id: 1, name: "Main" }] });
  });

  it("resposta com success:false rejeita com DapRequestError", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await client.connect();
    const pending = client.sendRequest("pause", { threadId: 1 });
    fake.deliver({ seq: 2, type: "response", request_seq: 1, success: false, command: "pause", message: "não dá" });
    await expect(pending).rejects.toThrow(DapRequestError);
    await expect(pending).rejects.toMatchObject({ command: "pause" });
  });

  it("requisição sem resposta rejeita por timeout", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport, 30);
    await client.connect();
    await expect(client.sendRequest("threads")).rejects.toMatchObject({ code: "DAP_TIMEOUT" });
  });

  it("resposta órfã (pending desconhecido) é ignorada", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await client.connect();
    expect(() =>
      fake.deliver({ seq: 5, type: "response", request_seq: 42, success: true, command: "x" }),
    ).not.toThrow();
  });

  it("encaminha eventos canônicos: stopped, output, terminated, initialized", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    const stopped: unknown[] = [];
    const outputs: unknown[] = [];
    const terminated: unknown[] = [];
    const initialized: unknown[] = [];
    client.onStopped((body) => stopped.push(body));
    client.onOutput((body) => outputs.push(body));
    client.onTerminated((body) => terminated.push(body));
    client.onInitialized((body) => initialized.push(body));

    fake.deliver({ seq: 1, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } });
    fake.deliver({ seq: 2, type: "event", event: "output", body: { category: "stdout", output: "oi" } });
    fake.deliver({ seq: 3, type: "event", event: "terminated" });
    fake.deliver({ seq: 4, type: "event", event: "initialized" });

    expect(stopped).toEqual([{ reason: "breakpoint", threadId: 1 }]);
    expect(outputs).toEqual([{ category: "stdout", output: "oi" }]);
    expect(terminated).toEqual([{}]);
    expect(initialized).toEqual([{}]);
  });

  it("onNotification recebe por nome e o disposable remove o handler", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    const seen: unknown[] = [];
    const disposable = client.onNotification("breakpoint", (body) => seen.push(body));
    fake.deliver({ seq: 1, type: "event", event: "breakpoint", body: { reason: "new" } });
    expect(seen).toHaveLength(1);
    disposable.dispose();
    fake.deliver({ seq: 2, type: "event", event: "breakpoint", body: { reason: "changed" } });
    expect(seen).toHaveLength(1);
  });

  it("waitForEvent resolve para evento já recebido (histórico curto)", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    fake.deliver({ seq: 1, type: "event", event: "initialized" });
    await expect(client.waitForEvent("initialized", 50)).resolves.toBeUndefined();
  });

  it("waitForEvent rejeita por DAP_TIMEOUT quando o evento não chega", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await expect(client.waitForEvent("initialized", 30)).rejects.toMatchObject({ code: "DAP_TIMEOUT" });
  });

  it("requisição reversa recebe resposta success:false", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await client.connect();
    fake.sent.length = 0;
    fake.deliver({ seq: 10, type: "request", command: "runInTerminal", arguments: {} });
    expect(fake.sent).toHaveLength(1);
    const response = JSON.parse(fake.sent[0] ?? "{}") as { type: string; success: boolean; request_seq: number };
    expect(response).toMatchObject({ type: "response", success: false, request_seq: 10 });
  });

  it("JSON inválido no transporte não quebra o cliente", () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    expect(() => fake.deliverRaw("não é json")).not.toThrow();
    client.dispose();
  });

  it("dispose rejeita requisições pendentes", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport, 60000);
    await client.connect();
    const pending = client.sendRequest("threads");
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: "DAP_CLOSED" });
  });

  it("disconnect sem conexão não lança", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it("disconnect com conexão envia disconnect e fecha o transporte", async () => {
    const fake = createFakeTransport();
    const client = new DapClient(fake.transport);
    await client.connect();
    const done = client.disconnect(false);
    // Espera o pedido `disconnect` sair e responde à correlação correta
    await vi.waitFor(() => expect(fake.sent.some((raw) => raw.includes('"disconnect"'))).toBe(true));
    fake.deliver({ seq: 2, type: "response", request_seq: 1, success: true, command: "disconnect" });
    await done;
    expect(fake.isConnected()).toBe(false);
    expect(fake.sent.some((raw) => raw.includes('"disconnect"'))).toBe(true);
  });
});
