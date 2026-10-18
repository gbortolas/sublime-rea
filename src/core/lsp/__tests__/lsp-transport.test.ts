/**
 * Testes do transporte stdio LSP.
 *
 * Usa um mock de `child_process.spawn` para simular o processo do servidor.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ── Mock do spawn (hoisted para funcionar com vi.mock) ──────────────────────────────────────

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// ── Import depois do mock ───────────────────────────────────────────────────────────────────

import { LspStdioTransport } from "../lsp-transport";

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  Object.defineProperty(proc, "stdin", { value: stdin, writable: false, configurable: true });
  Object.defineProperty(proc, "stdout", { value: stdout, writable: false, configurable: true });
  Object.defineProperty(proc, "stderr", { value: stderr, writable: false });
  Object.defineProperty(proc, "killed", { value: false, writable: true });
  Object.defineProperty(proc, "exitCode", { value: null, writable: true });

  proc.kill = vi.fn((_signal?: number | string): boolean => {
    (proc as unknown as Record<string, unknown>).killed = true;
    (proc as unknown as Record<string, unknown>).exitCode = 0;
    proc.emit("exit", 0, null);
    return true;
  });

  return proc;
}

describe("LspStdioTransport", () => {
  let proc: ChildProcess;
  let transport: LspStdioTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    transport = new LspStdioTransport("fake-server", ["--stdio"]);
  });

  describe("connect", () => {
    it("spawna o processo com os argumentos corretos", async () => {
      transport.connect();
      // Dispara o setImmediate interno
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      expect(mockSpawn).toHaveBeenCalledWith(
        "fake-server",
        ["--stdio"],
        expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
      );
    });

    it("rejeita se stdin não está disponível", async () => {
      Object.defineProperty(proc, "stdin", { value: null });
      await expect(transport.connect()).rejects.toThrow(/stdin/);
    });

    it("rejeita se stdout não está disponível", async () => {
      Object.defineProperty(proc, "stdout", { value: null });
      await expect(transport.connect()).rejects.toThrow(/stdout/);
    });

    it("lança se já conectado", async () => {
      mockSpawn.mockReturnValue(createMockProcess());
      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      expect(() => transport.connect()).toThrow(/já conectado/);
    });

    it("dispara onError quando o processo emite error", async () => {
      const onError = vi.fn();
      transport.onError(onError);

      const connectPromise = transport.connect();
      proc.emit("error", new Error("ENOENT"));

      await expect(connectPromise).rejects.toThrow("ENOENT");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "ENOENT" }));
    });
  });

  describe("send", () => {
    it("escreve no stdin com framing Content-Length", async () => {
      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      const stdin = proc.stdin as PassThrough;
      const writeSpy = vi.spyOn(stdin, "write");

      const payload = JSON.stringify({ jsonrpc: "2.0", method: "exit" });
      transport.send(payload);

      const expected = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
      expect(writeSpy).toHaveBeenCalledWith(expected, "utf8");
    });

    it("lança se não conectado", () => {
      expect(() => transport.send("{}")).toThrow(/não conectado/);
    });
  });

  describe("recepção de mensagens", () => {
    it("emite onMessage para mensagem completa no stdout", async () => {
      const onMessage = vi.fn();
      transport.onMessage(onMessage);

      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
      const framed = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;

      const stdout = proc.stdout as PassThrough;
      stdout.write(Buffer.from(framed, "utf8"));

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(payload);
    });

    it("lida com mensagens fracionadas em múltiplos chunks", async () => {
      const onMessage = vi.fn();
      transport.onMessage(onMessage);

      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
      const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
      const half = Math.floor(payload.length / 2);

      const stdout = proc.stdout as PassThrough;
      stdout.write(Buffer.from(header + payload.slice(0, half), "utf8"));
      expect(onMessage).toHaveBeenCalledTimes(0); // ainda incompleta

      stdout.write(Buffer.from(payload.slice(half), "utf8"));
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(payload);
    });

    it("lida com múltiplas mensagens num único chunk", async () => {
      const onMessage = vi.fn();
      transport.onMessage(onMessage);

      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      const payload1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
      const payload2 = JSON.stringify({ jsonrpc: "2.0", method: "exit" });

      const framed1 = `Content-Length: ${Buffer.byteLength(payload1, "utf8")}\r\n\r\n${payload1}`;
      const framed2 = `Content-Length: ${Buffer.byteLength(payload2, "utf8")}\r\n\r\n${payload2}`;

      const stdout = proc.stdout as PassThrough;
      stdout.write(Buffer.from(framed1 + framed2, "utf8"));

      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(onMessage).toHaveBeenNthCalledWith(1, payload1);
      expect(onMessage).toHaveBeenNthCalledWith(2, payload2);
    });

    it("ignora cabeçalhos extras antes do Content-Length", async () => {
      const onMessage = vi.fn();
      transport.onMessage(onMessage);

      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
      const framed = [
        "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n",
        `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n`,
        "\r\n",
        payload,
      ].join("");

      const stdout = proc.stdout as PassThrough;
      stdout.write(Buffer.from(framed, "utf8"));

      expect(onMessage).toHaveBeenCalledWith(payload);
    });
  });

  describe("onExit", () => {
    it("emite quando o processo encerra", async () => {
      const onExit = vi.fn();
      transport.onExit(onExit);

      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      proc.emit("exit", 42, null);

      expect(onExit).toHaveBeenCalledWith({ code: 42, signal: null });
    });
  });

  describe("disconnect", () => {
    it("mata o processo e limpa recursos", async () => {
      transport.connect();
      await vi.waitFor(() => expect(transport.connected).toBe(true));

      transport.disconnect();

      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(transport.connected).toBe(false);
    });

    it("é seguro chamar disconnect múltiplas vezes", () => {
      expect(() => {
        transport.disconnect();
        transport.disconnect();
      }).not.toThrow();
    });
  });
});