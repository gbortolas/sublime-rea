/**
 * Scribe — contratos de fronteira: buffer, edição, registro de documentos e comandos.
 *
 * **Este arquivo é a forma congelada em código dos contratos da Fase 2**
 * (`docs/architecture/`), para que cada módulo do scaffold possa ser escrito em paralelo sem
 * redefinir tipos. As implementações vivem em `src/core/**`.
 *
 * Reconciliações de divergência (o digest da Fase 2 encontrou shapes conflitantes):
 *
 * | Símbolo | Shapes no digest | Canônico (aqui) |
 * |---|---|---|
 * | `TextStore` | `01:274` (síncrono, `slice(from,to)`/`replace`/`flushChunk`) e `02:252` (assíncrono, `slice(range)`/`apply(edits)`) | **assíncrono** (`02`) = fronteira entre threads. O núcleo **síncrono** que o `01` descreve é a **`PieceTable`**, exportada pelo módulo `buffer` como *interna* (só para teste) |
 * | `DocumentRegistry` | `01:264` (síncrono: `create`/`resolve`/`isValid`/`dispose`) e `02:269` (assíncrono: `open`/`get`/`close`/`onDidChange`) | **união**: ciclo de vida assíncrono + lookup quente síncrono (`resolve`/`isValid`) |
 * | `Buffer.on('changed')` | `06:97` (API por string) | **`onDidChange(cb): Disposable`** (`01`), como no resto do Scribe |
 * | `onDidChange` | `02` escreveu `(cb) => Disposable` | **`Event<T>`** (canônico do Scribe) |
 * | `Task<T>` | `02:220` | `Task<K extends TaskKind>` — o tipo do resultado é derivado do `kind` (`TaskResultMap`) |
 * | `Disposable` | redefinido em `02:304` e `03:287` | um só: `src/shared/disposable.ts` |
 *
 * Rótulo de origem: tudo aqui é **escolha nossa** (não observada no alvo) — são as costuras do
 * Scribe, derivadas dos padrões com Evidence IDs nos docs da Fase 2.
 */
import type { Disposable } from "./disposable";
import type { Event } from "./events";
import type { DocumentHandle } from "./handles";
import type { Scheduler } from "./concurrency-contract";

/** Quem originou a edição — governa agrupamento de undo e reentrância (DEC-BUF-4/8). */
export type EditOrigin = "user" | "plugin" | "external" | "undo";

/** Delta de edição (DEC-BUF-3). Offsets em **code units UTF-16** (DEC-BUF-9). */
export interface TextDelta {
  readonly from: number;
  readonly removed: string;
  readonly inserted: string;
}

export interface TextDeltaEvent {
  readonly delta: TextDelta;
  readonly revision: number;
}

/** Edit no formato do undo/redo — delta inverso (DEC-TR-3). */
export interface Edit {
  readonly at: number;
  readonly remove: string;
  readonly insert: string;
}

/**
 * Fronteira do texto (DEC-BUF-2/6): o que atravessa para um worker. `generation` acompanha
 * todo resultado para que o chamador **descarte o obsoleto** (DEC-CON-8).
 */
export interface TextStore {
  readonly doc: DocumentHandle;
  readonly generation: number;
  readonly length: number;
  slice(range: { readonly start: number; readonly end: number }): string;
  apply(edits: readonly Edit[], origin: EditOrigin): Promise<void>;
  lineCountUpTo(offset: number): Promise<number>;
}

/** Resultado de `Task.kind === "scanLines"` (DEC-BUF-5: scan com cache, fora da main thread). */
export interface LineScanResult {
  readonly doc: DocumentHandle;
  readonly generation: number;
  readonly lineCount: number;
  /** Offsets de início de linha em code units UTF-16 (transferível, sem strings). */
  readonly lineStarts: Uint32Array;
}

/** Resultado de `Task.kind === "index"` (lane `index`, cold-start — DEC-CON-6). */
export interface IndexResult {
  readonly doc: DocumentHandle;
  readonly generation: number;
  readonly symbolCount: number;
  readonly durationMs: number;
}

/** Façade pública observável do documento (espelha `TextBuffer` — `01`, DEC-BUF-1). */
export interface Buffer {
  readonly handle: DocumentHandle;
  /** Sobe a cada mutação; validade de resultado assíncrono (DEC-BUF-10). */
  readonly revision: number;
  /** Materializa o documento a partir dos spans (custo O(n) — não chamar em loop quente). */
  text(): string;
  lineCount(): number;
  offsetAtLine(line: number): number;
  lineAt(offset: number): number;
  apply(delta: TextDelta, origin: EditOrigin): void;
  onDidChange(cb: (e: TextDeltaEvent) => void): Disposable;
}

/** Estado do documento — mora no registry, **nunca** no handle (DEC-TR-1). */
export interface DocumentState {
  readonly handle: DocumentHandle;
  readonly generation: number;
  readonly uri: string;
  readonly store: TextStore;
  readonly dirty: boolean;
}

/**
 * Autoridade única de vivacidade de documento (DEC-TR-1): `resolve`/`isValid` são o *guard*
 * obrigatório de toda travessia de fronteira; handles obsoletos (geração antiga) falham aqui.
 */
export interface DocumentRegistry {
  /** Documento em memória, sem I/O (síncrono — `01`). */
  create(uri: string, text?: string): Buffer;
  /** Abre do disco (I/O vai para o `TaskPool` — `02`). */
  open(path: string): Promise<DocumentHandle>;
  /** Lookup quente, síncrono. */
  resolve(handle: DocumentHandle): Buffer | undefined;
  get(handle: DocumentHandle): DocumentState | undefined;
  isValid(handle: DocumentHandle): boolean;
  close(handle: DocumentHandle): Promise<void>;
  dispose(handle: DocumentHandle): void;
  readonly onDidChange: Event<DocumentHandle>;
}

/** Escopo de edição aninhável (DEC-BUF-8) — token opaco, só encaminhado. */
export interface EditScope extends Disposable {
  readonly id: number;
  readonly reason: string;
  readonly active: boolean;
}

/** Erro alto: não se limpa a pilha de undo com escopo aberto (DEC-BUF-4). */
export class UndoStackBusyError extends Error {
  readonly openScopes: number;

  constructor(openScopes: number) {
    super(`UndoStackBusyError: ${openScopes} escopo(s) de edição ainda aberto(s)`);
    this.name = "UndoStackBusyError";
    this.openScopes = openScopes;
  }
}

/** Contexto entregue ao handler de comando. */
export interface CommandContext {
  readonly name: string;
  readonly origin: EditOrigin;
  readonly scope: EditScope | undefined;
  readonly registry: DocumentRegistry;
  readonly scheduler: Scheduler;
}

export type CommandHandler = (
  args: unknown,
  ctx: CommandContext,
) => unknown | Promise<unknown>;

export interface CommandResult {
  readonly name: string;
  /** `false` = comando não registrado (nunca silencioso — DEC-TR-5). */
  readonly handled: boolean;
  readonly value?: unknown;
}

export interface NativeCommand {
  readonly name: string;
}

/** Referência a comando de plugin: tupla `(instância, nome)` (DEC-BUF-7). */
export interface ExtensionCommandRef {
  readonly instance: unknown;
  readonly name: string;
}

export interface EditorEvent {
  readonly type: string;
}

/**
 * Barramento canônico de comandos — **definido no doc `01`**, referenciado por `03`/`06`.
 * Toda mutação de documento passa por aqui (DEC-TR-4: lane de edição, escrita única).
 */
export interface CommandBus {
  register(name: string, description: string, run: CommandHandler): Disposable;
  run(
    name: string,
    args?: unknown,
    opts?: { readonly group?: string; readonly origin?: EditOrigin },
  ): Promise<CommandResult>;
  dispatch(ref: NativeCommand | ExtensionCommandRef, args?: unknown): Promise<void>;
  subscribe<T extends EditorEvent>(type: T["type"], cb: (e: T) => void): Disposable;
  /** Contador de aninhamento — `run` dentro de escopo vira um grupo de undo só. */
  openEditScope(reason: string): EditScope;
  /** Funde grupos marcados num único passo de undo (*glue* — DEC-BUF-4). */
  glueMarkedGroups(): void;
  softUndo(): void;
  softRedo(): void;
}
