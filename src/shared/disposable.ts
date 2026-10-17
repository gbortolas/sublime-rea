/**
 * Scribe — descarte determinístico (canônico).
 *
 * Fonte: `docs/architecture/06-padroes-transversais.md` (§padrões transversais, DEC-TR-2) e
 * o `Disposable` repetido em `02`/`03` do digest — aqui definido **uma vez só**.
 *
 * Regra: toda subscrição/traversal de fronteira **exige** descarte explícito; nada de
 * refcount manual (DEC-TR-5 usa `Lifetime`/`AbortSignal`).
 */

export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      fn();
    },
  };
}

/** Coletor de descartáveis — descarta em ordem reversa, idempotente. */
export class DisposableStore implements Disposable {
  private readonly items = new Set<Disposable>();
  private isDisposedFlag = false;

  get isDisposed(): boolean {
    return this.isDisposedFlag;
  }

  get size(): number {
    return this.items.size;
  }

  add<T extends Disposable>(item: T): T {
    if (this.isDisposedFlag) {
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  delete(item: Disposable): boolean {
    return this.items.delete(item);
  }

  /** Descarta o conteúdo mas mantém o store utilizável. */
  clear(): void {
    const snapshot = [...this.items].reverse();
    this.items.clear();
    for (const item of snapshot) item.dispose();
  }

  dispose(): void {
    if (this.isDisposedFlag) return;
    this.isDisposedFlag = true;
    this.clear();
  }
}

/** Slot de descartável substituível (ex.: trocar o handler de um observer). */
export class MutableDisposable<T extends Disposable> implements Disposable {
  private current: T | undefined;
  private isDisposedFlag = false;

  get value(): T | undefined {
    return this.current;
  }

  set value(next: T | undefined) {
    if (this.current === next) return;
    this.current?.dispose();
    this.current = this.isDisposedFlag ? undefined : next;
    if (this.isDisposedFlag) next?.dispose();
  }

  clear(): void {
    this.value = undefined;
  }

  get isDisposed(): boolean {
    return this.isDisposedFlag;
  }

  dispose(): void {
    if (this.isDisposedFlag) return;
    this.isDisposedFlag = true;
    this.current?.dispose();
    this.current = undefined;
  }
}

export function disposeAll(items: Iterable<Disposable>): void {
  const list = Array.isArray(items) ? items : [...items];
  for (const item of list.reverse()) item.dispose();
}

/** Executa `cb` e sempre descarta o recurso (padrão `using`-like sem depender de TS 5.2+). */
export function withDisposable<T, R>(resource: T & Disposable, cb: (r: T) => R): R {
  try {
    return cb(resource);
  } finally {
    resource.dispose();
  }
}
