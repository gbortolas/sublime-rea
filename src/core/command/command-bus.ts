/**
 * Scribe — barramento canônico de comandos (`CommandBusImpl`).
 *
 * Fonte: `docs/architecture/01-buffer-e-edicao.md` §4 (contrato **canônico** `CommandBus`,
 * DEC-BUF-3/4/7/8) e `docs/architecture/06-padroes-transversais.md` §3 (DEC-TR-3: delta inverso +
 * transação explícita; `CommandId` ≠ `undoLabel`).
 *
 * **Escolhas nossas onde o doc é omisso:**
 * 1. **Quem aplica os deltas.** O handler **devolve** os `Edit[]` (a *intenção* materializada no
 *    delta, `06:135`); o bus é o **escritor único** (DEC-TR-4) e aplica-os ao `UndoTarget`, depois
 *    registra a transação na pilha. Um handler que devolve outra coisa não toca o alvo.
 * 2. **Escopo vence o `group`.** Dentro de um `EditScope` aberto, todo `run` cai no grupo do escopo
 *    mais externo (`scope:<id>`), ignorando um `group` explícito — garante a DEC-BUF-4 ("o grupo
 *    externo funde tudo num único passo de undo") mesmo quando o plugin passa grupos.
 * 3. **`undoLabel` = `description`.** O `name` é o `CommandId` (contrato de keymap/palette), a
 *    `description` é o rótulo humano gravado no undo (`06:144`).
 * 4. **Comandos de extensão** entram por `registerExtension(instance, name, …)` e são resolvidos
 *    pela **tupla `(instância, nome)`** (DEC-BUF-7); `dispatch` de comando inexistente **lança**
 *    (`UnknownCommandError`) — nunca silencioso (DEC-TR-5).
 * 5. **`undo()`/`redo()`/`emit()`** são extensões da implementação (fora do contrato congelado, que
 *    só expõe `softUndo`/`softRedo`) para que o bus seja utilizável e testável sozinho.
 */
import type {
  CommandBus,
  CommandContext,
  CommandHandler,
  CommandResult,
  Disposable,
  DocumentRegistry,
  Edit,
  EditorEvent,
  EditOrigin,
  EditScope,
  ExtensionCommandRef,
  NativeCommand,
  Scheduler,
} from "../../shared";
import { Emitter, toDisposable } from "../../shared";
import { assertScopesClosed, EditScopeImpl } from "./edit-scope";
import type { EditScopeHost } from "./edit-scope";
import { UndoStack } from "./undo-stack";
import type { UndoRecordOptions, UndoTarget } from "./undo-stack";

/** Erro alto: registrar dois comandos com o mesmo `CommandId`. */
export class DuplicateCommandError extends Error {
  readonly commandId: string;

  constructor(commandId: string) {
    super(`DuplicateCommandError: comando já registrado: ${commandId}`);
    this.name = "DuplicateCommandError";
    this.commandId = commandId;
  }
}

/** Erro alto: `dispatch` de um comando (nativo ou de extensão) não registrado (DEC-TR-5). */
export class UnknownCommandError extends Error {
  readonly commandId: string;
  readonly kind: "native" | "extension";

  constructor(commandId: string, kind: "native" | "extension") {
    super(`UnknownCommandError: comando ${kind} não registrado: ${commandId}`);
    this.name = "UnknownCommandError";
    this.commandId = commandId;
    this.kind = kind;
  }
}

export interface RunOptions {
  /** Chave de coalescência de undo (ex.: `typing.42`). */
  readonly group?: string;
  readonly origin?: EditOrigin;
}

export interface CommandBusOptions {
  readonly registry: DocumentRegistry;
  readonly scheduler: Scheduler;
  /** Pilha injetável (teste determinístico); default = `new UndoStack()`. */
  readonly undoStack?: UndoStack;
  /** Resolve o alvo da edição corrente; ausente = comandos não aplicam/registram deltas. */
  readonly target?: () => UndoTarget | undefined;
}

interface RegisteredCommand {
  /** `CommandId` — nome estável (contrato de keymap/palette/macro). */
  readonly id: string;
  /** `undoLabel` — rótulo humano gravado no undo. */
  readonly label: string;
  readonly run: CommandHandler;
}

function isEdit(value: unknown): value is Edit {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o["at"] === "number" &&
    typeof o["remove"] === "string" &&
    typeof o["insert"] === "string"
  );
}

/**
 * Extrai os `Edit[]` devolvidos por um handler. Devolve `undefined` quando o valor **não** é uma
 * lista de deltas válidos (o comando não produziu edição de texto).
 */
export function extractEdits(value: unknown): Edit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Edit[] = [];
  for (const item of value) {
    if (!isEdit(item)) return undefined;
    out.push(item);
  }
  return out;
}

function isExtensionCommandRef(
  ref: NativeCommand | ExtensionCommandRef,
): ref is ExtensionCommandRef {
  return "instance" in ref;
}

/** Implementação canônica do `CommandBus` (doc `01`). */
export class CommandBusImpl implements CommandBus, EditScopeHost {
  private readonly registry: DocumentRegistry;
  private readonly scheduler: Scheduler;
  private readonly history: UndoStack;
  private readonly resolveTarget: (() => UndoTarget | undefined) | undefined;

  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly extensionCommands = new Map<unknown, Map<string, RegisteredCommand>>();
  private readonly emitters = new Map<string, Emitter<EditorEvent>>();
  private readonly scopeStack: EditScopeImpl[] = [];
  private scopeSeq = 0;

  constructor(opts: CommandBusOptions) {
    this.registry = opts.registry;
    this.scheduler = opts.scheduler;
    this.history = opts.undoStack ?? new UndoStack();
    this.resolveTarget = opts.target;
  }

  /** Pilha de undo/redo do bus (para observação e undo/redo duros). */
  get undoStack(): UndoStack {
    return this.history;
  }

  /** Aninhamento de escopos aberto (DEC-BUF-4). */
  get openScopeCount(): number {
    return this.scopeStack.length;
  }

  register(name: string, description: string, run: CommandHandler): Disposable {
    if (this.commands.has(name)) throw new DuplicateCommandError(name);
    const record: RegisteredCommand = { id: name, label: description, run };
    this.commands.set(name, record);
    return toDisposable((): void => {
      if (this.commands.get(name) === record) this.commands.delete(name);
    });
  }

  /**
   * Registra um comando de plugin identificado pela tupla `(instância, nome)` (DEC-BUF-7).
   * Extensão do contrato congelado — necessária para que `dispatch` resolva a tupla.
   */
  registerExtension(
    instance: unknown,
    name: string,
    description: string,
    run: CommandHandler,
  ): Disposable {
    let bucket = this.extensionCommands.get(instance);
    if (bucket === undefined) {
      bucket = new Map<string, RegisteredCommand>();
      this.extensionCommands.set(instance, bucket);
    }
    if (bucket.has(name)) throw new DuplicateCommandError(name);
    const record: RegisteredCommand = { id: name, label: description, run };
    bucket.set(name, record);
    return toDisposable((): void => {
      const current = this.extensionCommands.get(instance);
      if (current === undefined) return;
      if (current.get(name) === record) current.delete(name);
      if (current.size === 0) this.extensionCommands.delete(instance);
    });
  }

  async run(name: string, args?: unknown, opts?: RunOptions): Promise<CommandResult> {
    const record = this.commands.get(name);
    if (record === undefined) return { name, handled: false };
    return this.execute(record, args, opts);
  }

  async dispatch(ref: NativeCommand | ExtensionCommandRef, args?: unknown): Promise<void> {
    if (isExtensionCommandRef(ref)) {
      const record = this.extensionCommands.get(ref.instance)?.get(ref.name);
      if (record === undefined) throw new UnknownCommandError(ref.name, "extension");
      await this.execute(record, args, undefined);
      return;
    }
    const result = await this.run(ref.name, args);
    if (!result.handled) throw new UnknownCommandError(ref.name, "native");
  }

  subscribe<T extends EditorEvent>(type: T["type"], cb: (e: T) => void): Disposable {
    let emitter = this.emitters.get(type);
    if (emitter === undefined) {
      emitter = new Emitter<EditorEvent>();
      this.emitters.set(type, emitter);
    }
    return emitter.event((e: EditorEvent): void => {
      cb(e as T);
    });
  }

  /** Emite um evento tipado para os assinantes do seu `type` (extensão da implementação). */
  emit<T extends EditorEvent>(event: T): void {
    this.emitters.get(event.type)?.fire(event);
  }

  openEditScope(reason: string): EditScope {
    this.scopeSeq += 1;
    const scope = new EditScopeImpl(this.scopeSeq, reason, this);
    this.scopeStack.push(scope);
    return scope;
  }

  /** `EditScopeHost`: o escopo avisa que saiu; o contador é do bus. */
  releaseScope(scope: EditScopeImpl): void {
    const index = this.scopeStack.indexOf(scope);
    if (index >= 0) this.scopeStack.splice(index, 1);
  }

  glueMarkedGroups(): void {
    assertScopesClosed(this.scopeStack.length);
    this.history.glueMarkedGroups();
  }

  softUndo(): void {
    const target = this.resolveTarget?.();
    if (target !== undefined) this.history.softUndo(target);
  }

  softRedo(): void {
    const target = this.resolveTarget?.();
    if (target !== undefined) this.history.softRedo(target);
  }

  // --- Extensões da implementação (fora do contrato congelado) -------------------------------

  /** Desfaz duro (aplica o inverso). Fora do contrato do doc `01`, que só expõe `softUndo`. */
  undo(): boolean {
    const target = this.resolveTarget?.();
    return target === undefined ? false : this.history.undo(target);
  }

  /** Refaz duro. Par simétrico de `undo()`. */
  redo(): boolean {
    const target = this.resolveTarget?.();
    return target === undefined ? false : this.history.redo(target);
  }

  /** Marca o grupo do topo para *glue*. */
  markForGlue(): boolean {
    return this.history.markForGlue();
  }

  /** Desmarca o grupo do topo. */
  unmarkForGlue(): boolean {
    return this.history.unmarkForGlue();
  }

  /** Limpa undo+redo — **recusa** com escopo aberto (DEC-BUF-4/D4). */
  clearUndoStack(): void {
    assertScopesClosed(this.scopeStack.length);
    this.history.clear();
  }

  // --- Interno ------------------------------------------------------------------------------

  private async execute(
    record: RegisteredCommand,
    args: unknown,
    opts: RunOptions | undefined,
  ): Promise<CommandResult> {
    const origin: EditOrigin = opts?.origin ?? "user";
    const scope = this.scopeStack[this.scopeStack.length - 1];
    const root = this.scopeStack[0];
    const group = root !== undefined ? `scope:${root.id}` : opts?.group;

    const ctx: CommandContext = {
      name: record.id,
      origin,
      scope,
      registry: this.registry,
      scheduler: this.scheduler,
    };

    const value = await record.run(args, ctx);
    this.recordResult(record, value, origin, group);

    return value === undefined
      ? { name: record.id, handled: true }
      : { name: record.id, handled: true, value };
  }

  private recordResult(
    record: RegisteredCommand,
    value: unknown,
    origin: EditOrigin,
    group: string | undefined,
  ): void {
    const edits = extractEdits(value);
    if (edits === undefined || edits.length === 0) return;

    const target = this.resolveTarget?.();
    if (target === undefined) return;

    // O "antes" é lido **antes** de aplicar os deltas; o "depois", **depois** — o alvo
    // (o `EditorCore`) desloca os cursores junto com o texto, então o "depois" já vem
    // posicionado. É isso que faz o undo restaurar o **conjunto** de cursores (multi-cursor,
    // P2#5) e não só o caret.
    const caretBefore = target.caret();
    const selectionBefore = target.selection();
    const selectionsBefore = [...target.selections()];
    target.applyEdits(edits, origin);
    const caretAfter = target.caret();
    const selectionAfter = target.selection();
    const selectionsAfter = [...target.selections()];

    const base: UndoRecordOptions = {
      origin,
      caretBefore,
      caretAfter,
      selectionBefore,
      selectionAfter,
      selectionsBefore,
      selectionsAfter,
    };
    if (group === undefined) {
      this.history.record(record.label, edits, base);
    } else {
      this.history.record(record.label, edits, { ...base, groupId: group });
    }
  }
}
