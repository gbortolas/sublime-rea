/**
 * Scribe — assincronia e cancelamento (canônico).
 *
 * Fonte: `docs/architecture/06-padroes-transversais.md` (DEC-TR-5: `Lifetime`/`AbortSignal`
 * no lugar de refcount), `02` (DEC-CON-4: task serializável e **cancelável**) e
 * `03` (DEC-IPC-9: chamadas longas sempre async + `AbortSignal`).
 */
import type { Disposable } from "./disposable";

/** Cancelamento cooperativo — nunca é um erro de programação. */
export class CancellationError extends Error {
  readonly reason: string;

  constructor(reason = "cancelado") {
    super(`operação cancelada: ${reason}`);
    this.name = "CancellationError";
    this.reason = reason;
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof CancellationError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Escopo de vida de uma operação (DEC-TR-5).
 *
 * `Lifetime` **absorve** um `AbortSignal` externo (encadeia cancelamento) em vez de exigir que
 * todo mundo carregue refcounts — substitui a "lifetime" do alvo por primitiva idiomática.
 */
export class Lifetime implements Disposable {
  private readonly controller = new AbortController();
  private readonly parent: AbortSignal | undefined;
  private readonly onParentAbort: (() => void) | undefined;
  private isDisposedFlag = false;

  private constructor(parent?: AbortSignal) {
    this.parent = parent;
    this.onParentAbort = undefined;
    if (parent) {
      if (parent.aborted) {
        this.controller.abort(parent.reason);
      } else {
        this.onParentAbort = (): void => this.controller.abort(parent.reason);
        parent.addEventListener("abort", this.onParentAbort, { once: true });
      }
    }
  }

  /** Lifetime raiz (ninguém o cancela de fora). */
  static create(): Lifetime {
    return new Lifetime();
  }

  /** Lifetime filho, encadeado a um sinal externo. */
  static from(signal: AbortSignal): Lifetime {
    return new Lifetime(signal);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  throwIfAborted(): void {
    if (this.aborted) {
      throw new CancellationError(describeReason(this.controller.signal.reason));
    }
  }

  /** Corre `cb` e, ao terminar, descarta o lifetime (evita vazamento de listener pai). */
  async run<T>(cb: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    try {
      this.throwIfAborted();
      return await cb(this.controller.signal);
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.isDisposedFlag) return;
    this.isDisposedFlag = true;
    if (this.onParentAbort && this.parent) {
      this.parent.removeEventListener("abort", this.onParentAbort);
    }
    if (!this.controller.signal.aborted) this.controller.abort("lifetime descartado");
  }
}

function describeReason(reason: unknown): string {
  if (reason === undefined) return "cancelado";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/** Promise com resolução externa — base do request/response por `id` (DEC-IPC-5). */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn: ((value: T | PromiseLike<T>) => void) | undefined;
  private rejectFn: ((reason?: unknown) => void) | undefined;
  private settledFlag = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  get settled(): boolean {
    return this.settledFlag;
  }

  resolve(value: T): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.resolveFn?.(value);
  }

  reject(reason: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.rejectFn?.(reason);
  }

  /** Rejeita com `CancellationError` se ainda pendente (usado em timeout/cancel). */
  cancel(reason?: string): void {
    this.reject(new CancellationError(reason));
  }
}

/** `setTimeout` cancelável — a única espera permitida fora do event loop da UI. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancellationError(describeReason(signal.reason)));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancellationError(describeReason(signal?.reason)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Converte um erro cru num `Error` (o structured-clone não transporta classes). */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : JSON.stringify(err));
}
