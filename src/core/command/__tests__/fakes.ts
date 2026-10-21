/**
 * Scribe — fakes tipados **apenas para teste** do módulo `command`.
 *
 * Vive em `__tests__/` porque `tsconfig.build.json` exclui `src/**\/__tests__/**` do build — nada
 * aqui vai para `dist/`. Não é código de produção: são ports mínimos, determinísticos e sem rede.
 */
import type {
  Buffer,
  Disposable,
  DocumentHandle,
  DocumentRegistry,
  DocumentState,
  Edit,
  EditorEvent,
  EditOrigin,
  Event,
  MainThreadBusy,
  Priority,
  Scheduler,
  SchedulerTarget,
} from "../../../shared";
import type { UndoTarget } from "../undo-stack";
import type { Selection } from "../../../shared";

/** `DocumentRegistry` fake: lookup vazio, sem I/O. */
export class FakeRegistry implements DocumentRegistry {
  readonly onDidChange: Event<DocumentHandle> = (): Disposable => ({ dispose: (): void => {} });

  create(_uri: string, _text?: string): Buffer {
    throw new Error("FakeRegistry.create: não implementado no fake");
  }

  open(_path: string): Promise<DocumentHandle> {
    return Promise.reject(new Error("FakeRegistry.open: não implementado no fake"));
  }

  resolve(_handle: DocumentHandle): Buffer | undefined {
    return undefined;
  }

  get(_handle: DocumentHandle): DocumentState | undefined {
    return undefined;
  }

  isValid(_handle: DocumentHandle): boolean {
    return false;
  }

  close(_handle: DocumentHandle): Promise<void> {
    return Promise.resolve();
  }

  dispose(_handle: DocumentHandle): void {
    // no-op
  }
}

/** `Scheduler` fake: executa inline e resolve na hora (sem timing real). */
export class FakeScheduler implements Scheduler {
  readonly isUIThread = true;

  post<T>(
    _priority: Priority,
    cb: () => T | Promise<T>,
    _opts?: { readonly handle?: DocumentHandle },
  ): Promise<T> {
    return Promise.resolve(cb());
  }

  postTo(_target: SchedulerTarget, cb: () => void): void {
    cb();
  }

  waitOn(_cell: Int32Array, _expected: number, _timeoutMs?: number): Promise<"ok" | "timedout"> {
    return Promise.resolve("ok");
  }

  snapshot(): MainThreadBusy {
    return { busyMs: 0, pendingCallbacks: 0, lanes: { io: 0, index: 0, fileRead: 0, grep: 0 } };
  }
}

/**
 * Alvo de undo fake: um `string` + um cursor. `applyEdits` aplica **em ordem** (cada `at` é
 * relativo ao estado anterior) e deixa o cursor no fim do último `insert` — comportamento de um
 * editor de verdade (inserir deixa o cursor depois do texto inserido).
 */
export class FakeTarget implements UndoTarget {
  text = "";
  private cursor = 0;
  private sel: Selection = { anchor: 0, active: 0 };
  private sels: Selection[] = [{ anchor: 0, active: 0 }];

  applyEdits(edits: readonly Edit[], _origin: EditOrigin): void {
    for (const e of edits) {
      this.text = this.text.slice(0, e.at) + e.insert + this.text.slice(e.at + e.remove.length);
      this.cursor = e.at + e.insert.length;
    }
  }

  caret(): number {
    return this.cursor;
  }

  setCaret(n: number): void {
    this.cursor = n;
  }

  selection(): Selection {
    return this.sel;
  }

  setSelection(s: Selection): void {
    this.sel = s;
  }

  selections(): readonly Selection[] {
    return this.sels;
  }

  setSelections(sels: readonly Selection[]): void {
    this.sels = sels as Selection[];
    this.sel = sels.length > 0 ? sels[0]! : { anchor: 0, active: 0 };
  }
}

/** Evento de teste com `type` literal (para exercitar `subscribe`/`emit`). */
export interface PingEvent extends EditorEvent {
  readonly type: "test.ping";
  readonly n: number;
}
