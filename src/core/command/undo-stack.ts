/**
 * Scribe — pilha de undo/redo por **delta inverso + transação** (DEC-TR-3).
 *
 * Fonte: `docs/architecture/06-padroes-transversais.md` §3 (DEC-TR-3: "o undo guarda os **inversos**
 * (delta), não snapshots; o agrupamento é uma **transação** explícita") e
 * `docs/architecture/01-buffer-e-edicao.md` (DEC-BUF-4: grupos com aninhamento, *glue* e variantes
 * *soft*).
 *
 * **Decisões nossas onde o doc é omisso** (`01`/`06` descrevem o *comportamento*, não a estrutura):
 *
 * 1. **Delta inverso = sequência espelhada.** Um passo guarda os `Edit` *forward* (redo) e o
 *    inverso derivado (`[at, insert, remove]` em ordem reversa). Reaplicar o inverso na ordem
 *    reversa restaura o estado anterior **sem recomputar offsets**: o `at` de cada `Edit` é válido
 *    no estado em que ele nasceu.
 * 2. **Grupo = chave de coalescência.** Entradas consecutivas com o **mesmo `groupId`** fundem num
 *    único passo (o `typing.42` do `06:136`). Registrar depois de um `undo` interrompe a fusão e
 *    descarta o redo (semântica de editor comum).
 * 3. **Glue = fundir passos marcados.** `markForGlue()` marca o passo do topo; `glueMarkedGroups()`
 *    funde cada sequência de passos marcados e **sela** o resultado (`groupId` indefinido, para não
 *    coalescer de novo com o mesmo grupo).
 * 4. **Soft undo/redo** move o cursor e registra a **intenção** (`softIntent`), sem tocar o texto —
 *    como pede DEC-BUF-4, que separa *soft* (por delta) do *hard* (por grupo).
 * 5. **Profundidade** = truncamento do mais antigo (não anel): previsível e testável.
 *
 * O alvo é um **port mínimo** definido aqui (`UndoTarget`) — **não** importamos o `TextStore` do
 * módulo de buffer (costura só via `src/shared`).
 */
import type { Edit, EditOrigin } from "../../shared";

/**
 * Alvo mínimo que a pilha sabe dirigir. Definido **localmente** de propósito: a pilha não conhece
 * `TextStore`/`Buffer` — qualquer coisa com texto + cursor serve (um `TextStore` real num lado, um
 * fake de teste no outro).
 */
export interface UndoTarget {
  /** Aplica uma sequência de deltas **em ordem** (cada `at` relativo ao estado anterior). */
  applyEdits(edits: readonly Edit[], origin: EditOrigin): void;
  /** Posição do cursor (code units UTF-16). */
  caret(): number;
  setCaret(n: number): void;
}

export interface UndoRecordOptions {
  /** Chave de coalescência (`typing.42`); `undefined` = passo próprio. */
  readonly groupId?: string;
  readonly origin?: EditOrigin;
  readonly caretBefore?: number;
  readonly caretAfter?: number;
}

export interface UndoStackOptions {
  /** Profundidade máxima do histórico; o mais antigo é truncado. Default `1000`. */
  readonly maxDepth?: number;
}

export type SoftIntent = "undo" | "redo";

const DEFAULT_MAX_DEPTH = 1000;

interface Step {
  label: string;
  groupId: string | undefined;
  origin: EditOrigin;
  /** Deltas *forward* (redo), em ordem de aplicação. */
  edits: Edit[];
  /** Deltas inversos (undo), já em ordem reversa e com `remove`/`insert` trocados. */
  inverse: Edit[];
  caretBefore: number;
  caretAfter: number;
  marked: boolean;
}

/** Inverte uma sequência de deltas: ordem reversa + `remove`/`insert` trocados. */
function invert(edits: readonly Edit[]): Edit[] {
  const out: Edit[] = [];
  for (const e of [...edits].reverse()) {
    out.push({ at: e.at, remove: e.insert, insert: e.remove });
  }
  return out;
}

/**
 * Pilha undo/redo com grupos, glue, soft e profundidade limitada.
 *
 * Invariantes:
 * - `undoSteps`/`redoSteps` são disjuntos; registrar uma transação limpa o redo;
 * - `undoDepth + redoDepth` nunca excede `maxDepth + redoDepth` (o redo só cresce ao desfazer);
 * - um passo só existe se tiver ≥ 1 delta (transação vazia é descartada).
 */
export class UndoStack {
  private readonly maxDepth: number;
  private undoSteps: Step[] = [];
  private redoSteps: Step[] = [];
  private softIntentFlag: SoftIntent | undefined;

  constructor(opts: UndoStackOptions = {}) {
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) {
      throw new RangeError(`UndoStack: maxDepth deve ser inteiro >= 1: ${this.maxDepth}`);
    }
  }

  get undoDepth(): number {
    return this.undoSteps.length;
  }

  get redoDepth(): number {
    return this.redoSteps.length;
  }

  /** `undoLabel` do passo do topo (distinto do `CommandId` — `06:144`). */
  get lastLabel(): string | undefined {
    return this.undoSteps[this.undoSteps.length - 1]?.label;
  }

  /** Última intenção registrada por *soft undo/redo* (ou `undefined` após uma operação dura). */
  get softIntent(): SoftIntent | undefined {
    return this.softIntentFlag;
  }

  /**
   * Registra uma **transação**: os deltas que um comando aplicou ao alvo. Funde com o topo quando
   * o `groupId` coincide (e não há redo pendente — editar depois de desfazer nunca funde).
   */
  record(label: string, edits: readonly Edit[], opts: UndoRecordOptions = {}): void {
    if (edits.length === 0) return;

    const groupId = opts.groupId;
    const origin: EditOrigin = opts.origin ?? "user";
    const caretBefore = opts.caretBefore ?? 0;
    const caretAfter = opts.caretAfter ?? caretBefore;

    const top = this.undoSteps[this.undoSteps.length - 1];
    const canMerge =
      this.redoSteps.length === 0 &&
      groupId !== undefined &&
      top !== undefined &&
      top.groupId === groupId;

    if (canMerge && top !== undefined) {
      top.edits.push(...edits);
      top.inverse = invert(top.edits);
      top.label = label;
      top.caretAfter = caretAfter;
      this.softIntentFlag = undefined;
      return;
    }

    if (this.redoSteps.length > 0) this.redoSteps = [];
    this.undoSteps.push({
      label,
      groupId,
      origin,
      edits: [...edits],
      inverse: invert(edits),
      caretBefore,
      caretAfter,
      marked: false,
    });
    if (this.undoSteps.length > this.maxDepth) {
      this.undoSteps.splice(0, this.undoSteps.length - this.maxDepth);
    }
    this.softIntentFlag = undefined;
  }

  /** Marca o passo do topo para *glue*. `false` = pilha vazia (nada a marcar). */
  markForGlue(): boolean {
    const top = this.undoSteps[this.undoSteps.length - 1];
    if (top === undefined) return false;
    top.marked = true;
    return true;
  }

  /** Desmarca o passo do topo. `false` = pilha vazia. */
  unmarkForGlue(): boolean {
    const top = this.undoSteps[this.undoSteps.length - 1];
    if (top === undefined) return false;
    top.marked = false;
    return true;
  }

  /**
   * Funde cada sequência de passos **marcados** num único passo (DEC-BUF-4). O resultado é selado
   * (`groupId` indefinido) para não voltar a coalescer. Devolve `true` se algo foi fundido.
   */
  glueMarkedGroups(): boolean {
    const merged: Step[] = [];
    let didMerge = false;
    for (const step of this.undoSteps) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && prev.marked && step.marked) {
        prev.edits.push(...step.edits);
        prev.inverse = invert(prev.edits);
        prev.caretAfter = step.caretAfter;
        prev.label = step.label;
        prev.groupId = undefined;
        prev.marked = false;
        didMerge = true;
      } else {
        merged.push(step);
      }
    }
    this.undoSteps = merged;
    return didMerge;
  }

  /** Desfaz o topo: aplica o inverso e restaura o cursor de antes da transação. */
  undo(target: UndoTarget): boolean {
    const step = this.undoSteps.pop();
    if (step === undefined) return false;
    target.applyEdits(step.inverse, "undo");
    target.setCaret(step.caretBefore);
    this.redoSteps.push(step);
    this.softIntentFlag = undefined;
    return true;
  }

  /** Refaz o topo do redo: reaplica os deltas forward com a origem original da transação. */
  redo(target: UndoTarget): boolean {
    const step = this.redoSteps.pop();
    if (step === undefined) return false;
    target.applyEdits(step.edits, step.origin);
    target.setCaret(step.caretAfter);
    this.undoSteps.push(step);
    this.softIntentFlag = undefined;
    return true;
  }

  /** *Soft undo*: leva o cursor para antes da última transação **sem** alterar o texto. */
  softUndo(target: UndoTarget): boolean {
    const top = this.undoSteps[this.undoSteps.length - 1];
    if (top === undefined) return false;
    target.setCaret(top.caretBefore);
    this.softIntentFlag = "undo";
    return true;
  }

  /** *Soft redo*: leva o cursor para depois da transação desfeita **sem** alterar o texto. */
  softRedo(target: UndoTarget): boolean {
    const top = this.redoSteps[this.redoSteps.length - 1];
    if (top === undefined) return false;
    target.setCaret(top.caretAfter);
    this.softIntentFlag = "redo";
    return true;
  }

  /**
   * Reaplica o histórico **atual** (o que ainda está no undo) em ordem cronológica a um alvo
   * qualquer — replay de macro/estado. `origin` é `"external"`: o alvo é estranho à transação.
   */
  applyTo(target: UndoTarget): void {
    const edits: Edit[] = [];
    for (const step of this.undoSteps) edits.push(...step.edits);
    if (edits.length === 0) return;
    target.applyEdits(edits, "external");
    const last = this.undoSteps[this.undoSteps.length - 1];
    if (last !== undefined) target.setCaret(last.caretAfter);
  }

  /** Limpa undo+redo. Recusa (via `CommandBus`) quando há escopo aberto — DEC-BUF-4/D4. */
  clear(): void {
    this.undoSteps = [];
    this.redoSteps = [];
    this.softIntentFlag = undefined;
  }
}
