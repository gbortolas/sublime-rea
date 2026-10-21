/**
 * Scribe — transporte stdio para LSP.
 *
 * Gerencia o ciclo de vida de um processo de servidor LSP, escreve mensagens no stdin
 * usando o framing `Content-Length` e lê do stdout reconstituindo mensagens completas.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { Emitter, type Event } from "../../shared/events";
import { toDisposable, type Disposable, DisposableStore } from "../../shared/disposable";
import { LspError } from "./lsp-protocol";

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

const HEADER_TERMINATOR = Buffer.from("\r\n\r\n", "utf8");
const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)\r?$/im;

/**
 * Buffer de mensagens com decodificação do framing `Content-Length`.
 *
 * Acumula dados crus do stdout e extrai mensagens completas na ordem em que chegam.
 * Lida com múltiplas mensagens num mesmo chunk e mensagens fracionadas em chunks.
 *
 * ⚠️ O accumulate é em **bytes**, não em string: o `Content-Length` do protocolo LSP é o
 * tamanho do corpo **em bytes UTF-8**. Decodificar em string e comparar com o comprimento
 * da string quebra com **qualquer caractere não-ASCII** (acento, emoji) — a mensagem
 * nunca é extraída e **todas as seguintes** ficam travadas (o diagnóstico nunca chega).
 */
class MessageBuffer {
  private data: Buffer = Buffer.alloc(0);
  private pendingLength = -1;

  append(chunk: Buffer | string): void {
    this.data = Buffer.concat([
      this.data,
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
    ]);
  }

  /**
   * Tenta extrair a próxima mensagem completa do buffer.
   * @returns o corpo da mensagem (JSON payload) ou `null` se ainda não há dados suficientes.
   */
  extractNext(): string | null {
    while (true) {
      if (this.pendingLength < 0) {
        const termIdx = this.data.indexOf(HEADER_TERMINATOR);
        if (termIdx === -1) return null;

        const headerBlock = this.data.subarray(0, termIdx).toString("utf8");
        this.data = this.data.subarray(termIdx + HEADER_TERMINATOR.length);

        const match = headerBlock.match(CONTENT_LENGTH_RE);
        if (!match) continue; // cabeçalho inválido — descarta e tenta de novo

        // `noUncheckedIndexedAccess`: o match garantiu o grupo de captura
        const lengthStr = match[1];
        if (lengthStr === undefined) continue;

        this.pendingLength = parseInt(lengthStr, 10);
        if (Number.isNaN(this.pendingLength) || this.pendingLength < 0) {
          this.pendingLength = -1;
          continue;
        }
      }

      // `length` é em **bytes**: compara com o buffer, não com o comprimento da string.
      if (this.data.length < this.pendingLength) return null;

      const body = this.data.subarray(0, this.pendingLength).toString("utf8");
      this.data = this.data.subarray(this.pendingLength);
      this.pendingLength = -1;
      return body;
    }
  }
}

// ── Transporte ──────────────────────────────────────────────────────────────────────────────

export class LspStdioTransport implements Disposable {
  private proc: ChildProcess | null = null;
  private readonly store = new DisposableStore();
  /** Últimos 4 KB do stderr do servidor (diagnóstico quando o handshake falha). */
  private stderrBuffer = "";
  private readonly buffer = new MessageBuffer();

  private readonly onMessageEmitter = new Emitter<string>();
  private readonly onErrorEmitter = new Emitter<Error>();
  private readonly onExitEmitter = new Emitter<{
    readonly code: number | null;
    readonly signal: string | null;
  }>();

  /** Evento disparado a cada mensagem JSON crua recebida do servidor. */
  readonly onMessage: Event<string> = this.onMessageEmitter.event;

  /** Evento disparado em erro do processo (ex.: comando não encontrado). */
  readonly onError: Event<Error> = this.onErrorEmitter.event;

  /** Evento disparado quando o processo encerra. */
  readonly onExit: Event<{
    readonly code: number | null;
    readonly signal: string | null;
  }> = this.onExitEmitter.event;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly extraEnv?: Readonly<Record<string, string>>,
  ) {}

  /** `true` se o processo está ativo e os pipes estão abertos. */
  get connected(): boolean {
    return this.proc !== null && !this.proc.killed && this.proc.exitCode === null;
  }

  /**
   * Dispara o processo do servidor LSP e conecta os pipes.
   * A promise resolve após o primeiro tick do event loop (o processo pode falhar
   * imediatamente e rejeitar pelo evento `error`).
   */
  connect(): Promise<void> {
    if (this.proc !== null) {
      throw new LspError("LSP_ALREADY_CONNECTED", "Transport já conectado");
    }

    return new Promise<void>((resolve, reject) => {
      const env = { ...process.env, ...this.extraEnv };
      let resolved = false;

      const proc = spawn(this.command, [...this.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      this.proc = proc;

      proc.on("error", (err: Error) => {
        this.onErrorEmitter.fire(err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      proc.on("exit", (code, signal) => {
        this.onExitEmitter.fire({ code, signal });
        this.proc = null;
      });

      // stdin — valida que o pipe existe
      if (!proc.stdin) {
        reject(new LspError("LSP_NO_STDIN", "stdin indisponível"));
        return;
      }

      // stdout — decodifica mensagens
      if (!proc.stdout) {
        reject(new LspError("LSP_NO_STDOUT", "stdout indisponível"));
        return;
      }

      const onStdoutData = (chunk: Buffer): void => {
        this.buffer.append(chunk);
        this.flushBuffer();
      };
      proc.stdout.on("data", onStdoutData);
      this.store.add(toDisposable(() => proc.stdout?.off("data", onStdoutData)));

      // stderr do servidor LSP: **bufferizado** (o erro real do servidor — ex.: "Could not find
      // a valid TypeScript installation" — é a única pista quando o handshake trava).
      proc.stderr?.on("data", (chunk: Buffer) => {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString("utf8")).slice(-4096);
      });

      this.store.add(toDisposable(() => {
        if (!proc.killed) {
          const stillRunning = proc.exitCode === null;
          if (stillRunning) {
            proc.stdin?.end();
            proc.kill("SIGTERM");
          }
        }
      }));

      // Resolve após o próximo tick (permite que `error` dispare antes caso o spawn falhe)
      setImmediate(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });
  }

  /**
   * Envia uma mensagem JSON crua para o servidor com o framing `Content-Length`.
   */
  send(message: string): void {
    const stdin = this.proc?.stdin;
    if (!stdin || this.proc?.exitCode !== null) {
      throw new LspError("LSP_NOT_CONNECTED", "Transport não conectado");
    }
    const encoded = `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`;
    stdin.write(encoded, "utf8");
  }

  /**
   * Desconecta o transporte: envia SIGTERM e, se o processo não terminar em 3s, SIGKILL.
   */
  disconnect(): void {
    const proc = this.proc;
    if (!proc) return;

    // Fecha o stdin para sinalizar fim de entrada
    try { proc.stdin?.end(); } catch { /* pipe já fechado */ }

    // SIGTERM
    const sigtermSent = proc.kill("SIGTERM");

    // SIGKILL após 3s
    if (sigtermSent || proc.exitCode === null) {
      const timer = setTimeout(() => {
        try {
          if (!proc.killed && proc.exitCode === null) {
            proc.kill("SIGKILL");
          }
        } catch { /* processo já encerrou */ }
      }, 3000);

      this.store.add(toDisposable(() => clearTimeout(timer)));
    }

    this.store.dispose();
    this.onMessageEmitter.dispose();
    this.onErrorEmitter.dispose();
    this.onExitEmitter.dispose();
    this.proc = null;
  }

  /** @inheritdoc */
  dispose(): void {
    this.disconnect();
  }

  /**
   * Últimos 4 KB do **stderr** do servidor (o motivo real de um handshake que trava — ex.:
   * "Could not find a valid TypeScript installation").
   */
  get stderr(): string {
    return this.stderrBuffer;
  }

  private flushBuffer(): void {
    let content: string | null;
    while ((content = this.buffer.extractNext()) !== null) {
      this.onMessageEmitter.fire(content);
    }
  }
}