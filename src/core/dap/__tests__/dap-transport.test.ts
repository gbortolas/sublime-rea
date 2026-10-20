/**
 * Testes do transporte stdio DAP.
 *
 * Usa um mock de `child_process.spawn` para simular o processo do adaptador.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ── Mock do spawn (hoisted para funcionar com vi.mock) ──────────────────────────────────────

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// ── Import depois do mock ───────────────────────────────────────────────────────────────────

import { DapStdioTransport } from "../dap-transport";
import { DapError } from "../dap-protocol";

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

function frame(body: string): string {
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  Object.defineProperty(proc, "stdin", { value: stdin, writable: false, configurable: true });
  Object.defineProperty(proc, "stdout", { value: stdout, writable: false, configurable: true });
  Object.defineProperty(proc, "stderr", { value: stderr, writable: false });
  Object.defineProperty(proc, "killed", { value: false, writable: true, configurable: true });
  Object.defineProperty(proc, "exitCode", { value: null, writable: true, configurable: true });

  proc.kill = vi.fn((_signal?: number | string): boolean => {
    (proc as unknown as Record<string, unknown>).killed = true;
    (proc as unknown as Record<string, unknown>).exitCode = 0;
    proc.emit("exit", 0, null);
    return true;
  });

  return proc;
}

// ── Testes ──────────────────────────────────────────────────────────────────────────────────

describe("DapStdioTransport", () => {
  let proc: ChildProcess;
  let transport: DapStdioTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    transport = new DapStdioTransport("fake-adapter", ["--stdio"]);
  });

  it("connect spawna o processo com os argumentos corretos", async () => {
    await transport.connect();
    expect(mockSpawn).toHaveBeenCalledWith(
      "fake-adapter",
      ["--stdio"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(transport.connected).toBe(true);
  });

  it("connect duas vezes lança DAP_ALREADY_CONNECTED", async () => {
    await transport.connect();
    expect(() => transport.connect()).toThrow(DapError);
  });

  it("send sem conexão lança DAP_NOT_CONNECTED", () => {
    expect(() => transport.send("{}")).toThrow(DapError);
  });

  it("send escreve no stdin com framing Content-Length", async () => {
    await transport.connect();
    const chunks: string[] = [];
    proc.stdin?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    transport.send('{"seq":1}');
    const written = chunks.join("");
    expect(written).toBe(`Content-Length: ${Buffer.byteLength('{"seq":1}', "utf8")}\r\n\r\n{"seq":1}`);
  });

  it("emite uma mensagem completa recebida do stdout", async () => {
    await transport.connect();
    const received: string[] = [];
    transport.onMessage((raw) => received.push(raw));
    proc.stdout?.emit("data", Buffer.from(frame('{"type":"event","event":"stopped"}')));
    expect(received).toEqual(['{"type":"event","event":"stopped"}']);
  });

  it("lida com múltiplas mensagens num mesmo chunk", async () => {
    await transport.connect();
    const received: string[] = [];
    transport.onMessage((raw) => received.push(raw));
    const payload =
      frame('{"seq":1,"type":"event","event":"output"}') + frame('{"seq":2,"type":"event","event":"stopped"}');
    proc.stdout?.emit("data", Buffer.from(payload));
    expect(received).toHaveLength(2);
    expect(JSON.parse(received[1] ?? "{}")).toMatchObject({ seq: 2 });
  });

  it("lida com mensagem fracionada entre chunks", async () => {
    await transport.connect();
    const received: string[] = [];
    transport.onMessage((raw) => received.push(raw));
    const whole = frame('{"type":"event","event":"terminated"}');
    const cut = Math.floor(whole.length / 2);
    proc.stdout?.emit("data", Buffer.from(whole.slice(0, cut)));
    expect(received).toHaveLength(0);
    proc.stdout?.emit("data", Buffer.from(whole.slice(cut)));
    expect(received).toHaveLength(1);
  });

  it("onExit dispara quando o processo encerra e desconecta", async () => {
    await transport.connect();
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.onExit((info) => exits.push(info));
    proc.emit("exit", 0, null);
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(transport.connected).toBe(false);
  });

  it("disconnect mata o processo com SIGTERM", async () => {
    await transport.connect();
    transport.disconnect();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(transport.connected).toBe(false);
  });

  it("disconnect sem conexão é no-op", () => {
    expect(() => transport.disconnect()).not.toThrow();
  });
});
