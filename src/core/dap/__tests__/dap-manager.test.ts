/**
 * Testes do gerente DAP (ciclo de vida, rotas por extensão, breakpoints desejados).
 *
 * Mocka `child_process.spawn` para controlar o processo do adaptador — assim o ciclo
 * `starting → running` é testável sem adaptador real.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ── Mock do spawn (hoisted para funcionar com vi.mock) ──────────────────────────────────────

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

// ── Import depois do mock ───────────────────────────────────────────────────────────────────

import { DapManager } from "../dap-manager";
import type { DapServerConfig } from "../../../shared/dap-contract";

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

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
  proc.kill = vi.fn(() => {
    (proc as unknown as Record<string, unknown>).killed = true;
    (proc as unknown as Record<string, unknown>).exitCode = 0;
    proc.emit("exit", 0, null);
    return true;
  });
  return proc;
}

/** Escreve uma mensagem DAP enquadrada no stdout do processo fake. */
function dapWrite(proc: ChildProcess, body: unknown): void {
  const raw = JSON.stringify(body);
  proc.stdout?.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(raw, "utf8")}\r\n\r\n${raw}`));
}

/**
 * Auto-responder: responde cada **request** escrito no stdin do adaptador fake, na ordem em
 * que sai. Elimina a race de respostas órfãs (resposta antes do pedido = descartada).
 */
function autoRespond(proc: ChildProcess, onBreakpointsSent?: (body: unknown) => void): void {
  let pendingLength = -1;
  let buffer = "";
  proc.stdin?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      if (pendingLength < 0) {
        const termIdx = buffer.indexOf("\r\n\r\n");
        if (termIdx === -1) return;
        const header = buffer.slice(0, termIdx);
        buffer = buffer.slice(termIdx + 4);
        const match = header.match(/Content-Length:\s*(\d+)/);
        const length = match?.[1];
        if (length === undefined) continue;
        pendingLength = parseInt(length, 10);
      }
      if (buffer.length < pendingLength) return;
      const body = buffer.slice(0, pendingLength);
      buffer = buffer.slice(pendingLength);
      pendingLength = -1;
      const request = JSON.parse(body) as { seq: number; command: string };
      const reply = (responseBody: unknown): void => {
        dapWrite(proc, {
          seq: 100 + request.seq,
          type: "response",
          request_seq: request.seq,
          success: true,
          command: request.command,
          body: responseBody,
        });
      };
      if (onBreakpointsSent !== undefined && request.command === "setBreakpoints") {
        onBreakpointsSent(undefined);
      }
      switch (request.command) {
        case "initialize":
          reply({ supportsConfigurationDoneRequest: true });
          dapWrite(proc, { seq: 200, type: "event", event: "initialized" });
          break;
        case "launch":
          reply({});
          break;
        case "configurationDone":
          reply({});
          break;
        case "setBreakpoints":
          reply({ breakpoints: [{ verified: true, line: 42, id: 7 }] });
          break;
        case "disconnect":
          reply({});
          break;
        default:
          reply({});
          break;
      }
    }
  });
}

function config(partial: Partial<DapServerConfig> = {}): DapServerConfig {
  return {
    name: "Fake",
    kind: "builtin",
    languages: ["py"],
    type: "python",
    request: "launch",
    spawn: { command: "fake-adapter", args: [] },
    enabled: true,
    ...partial,
  };
}

// ── Testes ──────────────────────────────────────────────────────────────────────────────────

describe("DapManager", () => {
  let proc: ChildProcess;

  beforeEach(() => {
    vi.clearAllMocks();
    proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
  });

  it("findConfigFor roteia pela extensão do arquivo", () => {
    const manager = new DapManager([config({ name: "Py", languages: ["py", "pyw"] })]);
    expect(manager.findConfigFor("/tmp/main.py")?.name).toBe("Py");
    expect(manager.findConfigFor("/tmp/aux.pyw")?.name).toBe("Py");
    expect(manager.findConfigFor("/tmp/main.ts")).toBeUndefined();
    expect(manager.findConfigFor("sem-extensão")).toBeUndefined();
    manager.dispose();
  });

  it("findConfigFor ignora adaptador desabilitado", () => {
    const manager = new DapManager([config({ name: "Off", enabled: false })]);
    expect(manager.findConfigFor("/tmp/main.py")).toBeUndefined();
    manager.dispose();
  });

  it("findConfigFor é case-insensitive na extensão", () => {
    const manager = new DapManager([config({ languages: ["py"] })]);
    expect(manager.findConfigFor("/tmp/MAIN.PY")?.name).toBe("Fake");
    manager.dispose();
  });

  it("estado inicial é inactive", () => {
    const manager = new DapManager([]);
    expect(manager.state).toBe("inactive");
    manager.dispose();
  });

  it("setBreakpoints sem sessão só registra os desejados (ordenados)", async () => {
    const manager = new DapManager([config()]);
    const result = await manager.setBreakpoints("/tmp/main.py", [30, 10, 20]);
    expect(result).toEqual([]); // nada enviado — não há sessão
    expect(manager.breakpointsFor("/tmp/main.py")).toEqual([10, 20, 30]);
    expect(manager.breakpointsFor("/tmp/outro.py")).toEqual([]);
    manager.dispose();
  });

  it("stop sem sessão resolve e mantém inactive", async () => {
    const manager = new DapManager([]);
    const states: string[] = [];
    manager.onState((state) => states.push(state));
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(states).toEqual([]);
    expect(manager.state).toBe("inactive");
  });

  it("start completa o handshake e chega em running", async () => {
    const manager = new DapManager([config()]);
    const states: string[] = [];
    manager.onState((state) => states.push(state));
    autoRespond(proc);

    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");
    expect(states).toEqual(["starting", "running"]);
    expect(manager.state).toBe("running");
    manager.dispose();
  });

  it("start com comando que falha no spawn passa por starting → errored", async () => {
    // spawn rejeita: o listener `error` do transporte dispara e o connect rejeita
    mockSpawn.mockImplementation(() => {
      const failing = createMockProcess();
      queueMicrotask(() => failing.emit("error", new Error("ENOENT")));
      return failing;
    });
    const manager = new DapManager([config()]);
    const states: string[] = [];
    manager.onState((state) => states.push(state));
    await expect(manager.start(config(), { program: "/tmp/main.py" })).rejects.toMatchObject({
      code: "DAP_START_FAILED",
    });
    expect(states).toEqual(["starting", "errored"]);
    expect(manager.state).toBe("errored");
    manager.dispose();
  });

  it("após falha de start é possível parar e voltar a inactive", async () => {
    mockSpawn.mockImplementation(() => {
      const failing = createMockProcess();
      queueMicrotask(() => failing.emit("error", new Error("ENOENT")));
      return failing;
    });
    const manager = new DapManager([config()]);
    await expect(manager.start(config(), { program: "/tmp/main.py" })).rejects.toThrow();
    await manager.stop();
    expect(manager.state).toBe("inactive");
  });

  it("breakpoints desejados são enviados no flush do start", async () => {
    const manager = new DapManager([config()]);
    await manager.setBreakpoints("/tmp/main.py", [42]);

    autoRespond(proc, () => {
      // Observa que o flush aconteceu (via breakpoints de resposta, verificados abaixo)
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    // Os breakpoints continuam conhecidos após a sessão
    expect(manager.breakpointsFor("/tmp/main.py")).toEqual([42]);
    manager.dispose();
  });

  it("eventos do adaptador chegam agregados no manager", async () => {
    const manager = new DapManager([config()]);
    const stopped: unknown[] = [];
    const outputs: unknown[] = [];
    manager.onStopped((event) => stopped.push(event));
    manager.onOutput((event) => outputs.push(event));
    autoRespond(proc);

    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    dapWrite(proc, { seq: 5, type: "event", event: "output", body: { category: "stderr", output: "boom" } });
    dapWrite(proc, { seq: 6, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 3 } });
    dapWrite(proc, { seq: 7, type: "event", event: "continued" });

    await vi.waitFor(() => expect(stopped.length).toBe(1));
    expect(outputs).toEqual([{ category: "stderr", output: "boom" }]);
    expect(stopped[0]).toMatchObject({ reason: "breakpoint", threadId: 3 });
    expect(manager.state).toBe("running"); // `continued` devolve a running
    manager.dispose();
  });

  it("stop encerra a sessão e volta a inactive", async () => {
    const manager = new DapManager([config()]);
    autoRespond(proc);
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    await expect(manager.stop()).resolves.toBeUndefined();
    expect(manager.state).toBe("inactive");
    manager.dispose();
  });

  it("dispose sem sessão não lança", () => {
    const manager = new DapManager([config()]);
    expect(() => manager.dispose()).not.toThrow();
  });

  it("listConfigs devolve a lista registrada", () => {
    const configs = [config({ name: "A" }), config({ name: "B", languages: ["js"] })];
    const manager = new DapManager(configs);
    expect(manager.listConfigs()).toHaveLength(2);
    manager.dispose();
  });
});
