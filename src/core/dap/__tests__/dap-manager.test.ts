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
import { MAX_EVALUATIONS_PER_WINDOW } from "../dap-manager";
import {
  MAX_EVALUATION_VALUE_LENGTH,
  type DapServerConfig,
} from "../../../shared/dap-contract";

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
 *
 * `onRequest` permite interceptar um comando (devolvendo o corpo da resposta),
 * `shouldFail` recusá-lo (`success: false`) e `silent` **não respondê-lo** (a requisição
 * fica pendente — é assim que se testa o teto de concorrência do `evaluate`).
 */
function autoRespond(
  proc: ChildProcess,
  onBreakpointsSent?: (body: unknown) => void,
  onRequest?:
    | ((
        command: string,
        args: unknown,
      ) => { body?: unknown; fail?: boolean; silent?: boolean } | undefined)
    | undefined,
): void {
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
      const request = JSON.parse(body) as {
        seq: number;
        command: string;
        arguments?: unknown;
      };
      const reply = (responseBody: unknown, success = true): void => {
        dapWrite(proc, {
          seq: 100 + request.seq,
          type: "response",
          request_seq: request.seq,
          success,
          command: request.command,
          body: responseBody,
          ...(success ? {} : { message: "recusado" }),
        });
      };
      if (onBreakpointsSent !== undefined && request.command === "setBreakpoints") {
        onBreakpointsSent(request.arguments);
      }
      const custom = onRequest?.(request.command, request.arguments);
      if (custom !== undefined) {
        if (custom.silent === true) continue; // não responde — a requisição fica pendente
        if (custom.fail === true) reply({}, false);
        else reply(custom.body ?? {});
        continue;
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
        case "evaluate":
          reply({ result: "42", type: "int", variablesReference: 0 });
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

/**
 * Adaptador que **responde ao `launch` só depois do `configurationDone`** — é o
 * comportamento real do debugpy (o debuggee sobe no `configurationDone`).
 *
 * Regressão do P4#27: o manager esperava a resposta do `launch` **antes** de mandar o
 * `configurationDone` ⇒ deadlock (a sessão nunca saía de `starting`).
 */
function autoRespondDeferredLaunch(proc: ChildProcess): void {
  let pendingLength = -1;
  let buffer = "";
  let launchSeq: number | undefined;
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
      const reply = (command: string, seq: number, responseBody: unknown): void => {
        dapWrite(proc, {
          seq: 100 + seq,
          type: "response",
          request_seq: seq,
          success: true,
          command,
          body: responseBody,
        });
      };
      if (request.command === "launch") {
        //fica pendente até o `configurationDone`
        launchSeq = request.seq;
        continue;
      }
      switch (request.command) {
        case "initialize":
          reply("initialize", request.seq, { supportsConfigurationDoneRequest: true });
          dapWrite(proc, { seq: 200, type: "event", event: "initialized" });
          break;
        case "configurationDone":
          reply("configurationDone", request.seq, {});
          if (launchSeq !== undefined) {
            reply("launch", launchSeq, {});
            launchSeq = undefined;
          }
          break;
        default:
          reply(request.command, request.seq, {});
          break;
      }
    }
  });
}

/**
 * Adaptador que **não** responde ao `launch` até `failLaunch()` ser chamado.
 *
 * Simula a **falha tardia**: o `launch` só falha depois da janela de tolerância (2s) — o
 * caso em que o manager não pode derrubar a sessão, mas precisa **registrar** a falha.
 */
function autoRespondLaunchOnDemand(proc: ChildProcess): { failLaunch: () => void } {
  let pendingLength = -1;
  let buffer = "";
  let launchSeq: number | undefined;
  const failLaunch = (): void => {
    if (launchSeq === undefined) return;
    dapWrite(proc, {
      seq: 900 + launchSeq,
      type: "response",
      request_seq: launchSeq,
      success: false,
      command: "launch",
      message: "launch falhou",
    });
    launchSeq = undefined;
  };
  proc.stdin?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      if (pendingLength < 0) {
        const termIdx = buffer.indexOf("\r\n\r\n");
        if (termIdx === -1) return;
        const header = buffer.slice(0, termIdx);
        buffer = buffer.slice(termIdx + 4);
        const match = header.match(/Content-Length:\s*(\d+)/);
        if (match === null) continue;
        const length = match[1];
        if (length === undefined) continue;
        pendingLength = parseInt(length, 10);
      }
      if (buffer.length < pendingLength) return;
      const body = buffer.slice(0, pendingLength);
      buffer = buffer.slice(pendingLength);
      pendingLength = -1;
      const request = JSON.parse(body) as { seq: number; command: string };
      const reply = (command: string, seq: number, responseBody: unknown): void => {
        dapWrite(proc, {
          seq: 100 + seq,
          type: "response",
          request_seq: seq,
          success: true,
          command,
          body: responseBody,
        });
      };
      if (request.command === "launch") {
        // Fica pendente: só falha quando `failLaunch()` for chamado.
        launchSeq = request.seq;
        continue;
      }
      switch (request.command) {
        case "initialize":
          reply("initialize", request.seq, { supportsConfigurationDoneRequest: true });
          dapWrite(proc, { seq: 200, type: "event", event: "initialized" });
          break;
        case "configurationDone":
          reply("configurationDone", request.seq, {});
          break;
        default:
          reply(request.command, request.seq, {});
          break;
      }
    }
  });
  return { failLaunch };
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

  it("start chega em running mesmo se o launch só responde depois do configurationDone", async () => {
    // Regressão do P4#27: o debugpy responde ao `launch` depois do `configurationDone`.
    // Esperar a resposta antes de mandar o `configurationDone` travava a sessão.
    const manager = new DapManager([config()]);
    autoRespondDeferredLaunch(proc);
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");
    expect(manager.state).toBe("running");
    manager.dispose();
  });

  it("start com comando que falha no spawn passa por starting → errored", async () => {    // spawn rejeita: o listener `error` do transporte dispara e o connect rejeita
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

  // ── Breakpoints condicionais (P4#27) ──────────────────────────────────────────────────────

  it("breakpointSpecsFor guarda a condição desejada", async () => {
    const manager = new DapManager([config()]);
    await manager.setBreakpoints("/tmp/main.py", [
      { line: 10, condition: "x > 3" },
      { line: 20 },
    ]);
    expect(manager.breakpointSpecsFor("/tmp/main.py")).toEqual([
      { line: 10, condition: "x > 3" },
      { line: 20 },
    ]);
    // A visão por linha continua válida (o gutter usa só as linhas).
    expect(manager.breakpointsFor("/tmp/main.py")).toEqual([10, 20]);
    manager.dispose();
  });

  it("a condição é enviada ao adaptador no setBreakpoints", async () => {
    const manager = new DapManager([config()]);
    const sent: unknown[] = [];
    autoRespond(proc, (body) => {
      sent.push(body);
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    await manager.setBreakpoints("/tmp/main.py", [{ line: 5, condition: "i == 2" }]);

    expect(sent.length).toBe(1);
    const args = sent[0] as { breakpoints?: { line: number; condition?: string }[] } | undefined;
    expect(args?.breakpoints?.[0]).toMatchObject({ line: 5, condition: "i == 2" });
    manager.dispose();
  });

  it("breakpoint sem condição omite o campo no protocolo", async () => {
    const manager = new DapManager([config()]);
    const sent: unknown[] = [];
    autoRespond(proc, (body) => {
      sent.push(body);
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    await manager.setBreakpoints("/tmp/main.py", [{ line: 5 }]);
    const args = sent[0] as { breakpoints?: Record<string, unknown>[] } | undefined;
    expect(args?.breakpoints?.[0]).toEqual({ line: 5 });
    manager.dispose();
  });

  // ── Logpoints e condição de paradas ───────────────────────────────────────────────────────

  it("o logpoint e a hitCondition chegam ao adaptador no setBreakpoints", async () => {
    // Sem isto, a UI dos logpoints é decorativa: a mensagem nunca chegaria ao adaptador.
    const manager = new DapManager([config()]);
    const sent: unknown[] = [];
    autoRespond(proc, (body) => {
      sent.push(body);
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    await manager.setBreakpoints("/tmp/main.py", [
      { line: 5, hitCondition: "3", logMessage: "i = ${i}" },
    ]);

    expect(sent.length).toBe(1);
    const args = sent[0] as
      | { breakpoints?: { line: number; hitCondition?: string; logMessage?: string }[] }
      | undefined;
    expect(args?.breakpoints?.[0]).toMatchObject({
      line: 5,
      hitCondition: "3",
      logMessage: "i = ${i}",
    });
    manager.dispose();
  });

  it("a spec do logpoint é preservada (fonte da verdade do core)", async () => {
    const manager = new DapManager([config()]);
    await manager.setBreakpoints("/tmp/main.py", [
      { line: 5, hitCondition: "3", logMessage: "i = ${i}" },
    ]);
    expect(manager.breakpointSpecsFor("/tmp/main.py")).toEqual([
      { line: 5, hitCondition: "3", logMessage: "i = ${i}" },
    ]);
    manager.dispose();
  });

  it("o breakpoint armado devolve a mensagem de log (badge de logpoint)", async () => {
    const manager = new DapManager([config()]);
    autoRespond(proc);
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    const armed = await manager.setBreakpoints("/tmp/main.py", [
      { line: 5, logMessage: "i = ${i}" },
    ]);
    // A linha devolvida é a do adaptador (o mock responde 42) — o que importa aqui é a
    // mensagem de log, que é o que o badge de logpoint mostra.
    expect(armed[0]).toMatchObject({ logMessage: "i = ${i}", verified: true });
    manager.dispose();
  });

  // ── evaluate (watch/hover) ───────────────────────────────────────────────────────────────

  it("evaluate devolve valor e tipo", async () => {
    const manager = new DapManager([config()]);
    autoRespond(proc);
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    const result = await manager.evaluate("x + 1", 7, "watch");
    expect(result).toEqual({ value: "42", type: "int", variablesReference: 0 });
    manager.dispose();
  });

  it("evaluate usa o contexto pedido", async () => {
    const manager = new DapManager([config()]);
    const contexts: string[] = [];
    autoRespond(proc, undefined, (command, args) => {
      if (command !== "evaluate") return undefined;
      const record = args as { context?: string };
      contexts.push(record.context ?? "");
      return { body: { result: "ok" } };
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    await manager.evaluate("x", 1, "hover");
    expect(contexts[0]).toBe("hover");
    manager.dispose();
  });

  it("evaluate cai para outro contexto quando o adaptador recusa", async () => {
    const manager = new DapManager([config()]);
    const contexts: string[] = [];
    autoRespond(proc, undefined, (command, args) => {
      if (command !== "evaluate") return undefined;
      const record = args as { context?: string };
      const context = record.context ?? "";
      contexts.push(context);
      if (context === "hover") return { fail: true };
      return { body: { result: "fallback" } };
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    // O fallback é `watch` — nunca `repl` (efeito colateral no debuggee).
    const result = await manager.evaluate("x", 1, "hover");
    expect(result.value).toBe("fallback");
    expect(contexts[0]).toBe("hover");
    expect(contexts[1]).toBe("watch");
    manager.dispose();
  });

  it("a cadeia de contextos nunca pede 'repl' (efeito colateral no debuggee)", async () => {
    // Regressão (achado de segurança do P4#27): o fallback escalava para `repl`, que
    // executa a expressão como **statement** no debuggee (mutação de estado).
    const manager = new DapManager([config()]);
    const contexts: string[] = [];
    autoRespond(proc, undefined, (command, args) => {
      if (command !== "evaluate") return undefined;
      contexts.push((args as { context?: string }).context ?? "");
      return { body: { result: "ok" } };
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    await manager.evaluate("x", 1, "repl");
    await manager.evaluate("x", 1, "clipboard");
    expect(contexts).toEqual(["watch", "watch"]);
    expect(contexts).not.toContain("repl");
    manager.dispose();
  });

  it("evaluate recusa expressão acima de 512 caracteres (teto no core)", async () => {
    // O teto não pode viver só na borda do IPC: o core é quem fala com o adaptador.
    const manager = new DapManager([config()]);
    let calls = 0;
    autoRespond(proc, undefined, (command) => {
      if (command === "evaluate") calls++;
      return undefined;
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    await expect(manager.evaluate("x".repeat(513), 1, "watch")).rejects.toMatchObject({
      code: "DAP_EXPRESSION_TOO_LONG",
    });
    expect(calls).toBe(0);
    manager.dispose();
  });

  it("evaluate recusa quando o teto de concorrência é excedido", async () => {
    // Um renderer comprometido dispararia avaliações paralelas: cada uma roda **no
    // debuggee** ⇒ o programa depurado travaria. O core recusa a excedente.
    const manager = new DapManager([config()]);
    autoRespond(proc, undefined, (command) =>
      command === "evaluate" ? { silent: true } : undefined,
    );
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    const inFlight = [
      manager.evaluate("a", 1, "watch"),
      manager.evaluate("b", 1, "watch"),
      manager.evaluate("c", 1, "watch"),
      manager.evaluate("d", 1, "watch"),
    ].map((promise) => promise.catch(() => undefined));

    await expect(manager.evaluate("e", 1, "watch")).rejects.toMatchObject({
      code: "DAP_EVAL_RATE_LIMITED",
    });
    manager.dispose();
    await Promise.all(inFlight);
  });

  it("evaluate recusa quando o teto de taxa da janela é excedido", async () => {
    // O relógio é congelado: a janela de 1 s não corre (o teste é determinístico).
    vi.useFakeTimers({ toFake: ["Date"] });
    const manager = new DapManager([config()]);
    try {
      autoRespond(proc);
      await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

      for (let i = 0; i < MAX_EVALUATIONS_PER_WINDOW; i++) {
        await manager.evaluate(`x${i}`, 1, "watch");
      }
      await expect(manager.evaluate("excedente", 1, "watch")).rejects.toMatchObject({
        code: "DAP_EVAL_RATE_LIMITED",
      });
    } finally {
      vi.useRealTimers();
      manager.dispose();
    }
  });

  it("evaluate trunca o valor e o tipo em 8 KB", async () => {
    const manager = new DapManager([config()]);
    autoRespond(proc, undefined, (command) => {
      if (command !== "evaluate") return undefined;
      return {
        body: {
          result: "x".repeat(MAX_EVALUATION_VALUE_LENGTH * 2),
          type: "y".repeat(MAX_EVALUATION_VALUE_LENGTH * 2),
          variablesReference: 0,
        },
      };
    });
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");

    const result = await manager.evaluate("x", 1, "watch");
    expect(result.value.length).toBe(MAX_EVALUATION_VALUE_LENGTH);
    expect(result.type?.length).toBe(MAX_EVALUATION_VALUE_LENGTH);
    manager.dispose();
  });

  it("evaluate sem sessão falha com DAP_NO_SESSION", async () => {
    const manager = new DapManager([config()]);
    await expect(manager.evaluate("x", 1, "watch")).rejects.toMatchObject({
      code: "DAP_NO_SESSION",
    });
    manager.dispose();
  });

  it("evaluate com expressão vazia é recusado antes de ir ao adaptador", async () => {
    const manager = new DapManager([config()]);
    autoRespond(proc);
    await expect(manager.start(config(), { program: "/tmp/main.py" })).resolves.toBe("running");
    await expect(manager.evaluate("   ", 1, "watch")).rejects.toMatchObject({
      code: "DAP_EMPTY_EXPRESSION",
    });
    manager.dispose();
  });

  // ── Falha tardia do `launch` (P4#27) ────────────────────────────────────────────────────────

  it("registra (1 warn) o launch que falha depois da janela de tolerância", async () => {
    // Regressão (achado na revisão do P4#27): o `launch` que chegava **depois** da janela
    // de 2s era engolido em silêncio ⇒ falha tardia virava degradação silenciosa.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = new DapManager([config()]);
    try {
      const adapter = autoRespondLaunchOnDemand(proc);
      const started = manager.start(config(), { program: "/tmp/main.py" });
      // Passa a janela de tolerância (2s): a sessão segue (o `launch` ainda não respondeu).
      await vi.advanceTimersByTimeAsync(2500);
      await expect(started).resolves.toBe("running");
      expect(warn).not.toHaveBeenCalled();

      // Agora o `launch` falha — tarde demais para derrubar a sessão, mas **registrado**.
      adapter.failLaunch();
      await vi.advanceTimersByTimeAsync(10);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("launch");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
      manager.dispose();
    }
  });
});
