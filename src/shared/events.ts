/**
 * Scribe — eventos observáveis (canônico).
 *
 * Fonte: `docs/architecture/06-padroes-transversais.md` (handle + evento por fronteira) e
 * `Buffer.onDidChange`/`DocumentRegistry.onDidChange` de `01`/`02`.
 *
 * Regra: `fire()` **nunca** deixa um listener quebrado matar os demais; a primeira exceção é
 * relançada ao final (erro alto, sem engolir — DEC-TR-5).
 */
import type { Disposable } from "./disposable";

export type Event<T> = (listener: (e: T) => void) => Disposable;

export interface EmitterOptions {
  /** Chamado na transição 0 → 1 listeners (lazy: ligar recursos só quando há interessado). */
  readonly onFirstListener?: () => void;
  /** Chamado na transição 1 → 0 listeners. */
  readonly onNoListeners?: () => void;
}

export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(e: T) => void>();
  private isDisposedFlag = false;
  private readonly opts: EmitterOptions;

  constructor(opts: EmitterOptions = {}) {
    this.opts = opts;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  get isDisposed(): boolean {
    return this.isDisposedFlag;
  }

  readonly event: Event<T> = (listener: (e: T) => void): Disposable => {
    if (this.isDisposedFlag) {
      throw new Error("Emitter: não é possível assinar um emitter já descartado");
    }
    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(listener);
    if (wasEmpty) this.opts.onFirstListener?.();

    let active = true;
    return {
      dispose: (): void => {
        if (!active) return;
        active = false;
        const removed = this.listeners.delete(listener);
        if (removed && this.listeners.size === 0) this.opts.onNoListeners?.();
      },
    };
  };

  fire(event: T): void {
    if (this.isDisposedFlag) return;
    const snapshot = [...this.listeners];
    let firstError: unknown;
    for (const listener of snapshot) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener(event);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Limpa listeners sem descartar o emitter (permite reutilizar). */
  clear(): void {
    if (this.listeners.size === 0) return;
    this.listeners.clear();
    this.opts.onNoListeners?.();
  }

  dispose(): void {
    if (this.isDisposedFlag) return;
    this.isDisposedFlag = true;
    this.clear();
  }
}
