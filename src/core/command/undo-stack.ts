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
 * 6. **Escopo por documento (a linha do tempo de cada aba).** A pilha é **global**, mas cada
 *    **documento** tem a sua própria linha do tempo: um passo carrega o `scopeId` do documento que
 *    o criou e `undo`/`redo` só tocam os passos do **escopo do alvo**. Passos de outro documento são
 *    **pulados** (não aplicados, **não** consumidos) — sem isso, desfazer na aba B aplicava os
 *    deltas da aba A no buffer de B (texto corrompido).
 *    - O `scopeId` do alvo é **opcional**: `undefined` = "sem escopo" (alvos de teste que não sabem
 *      seu documento) — ele casa **só** com passos sem escopo.
 *    - A **ordem global** é preservada: os passos de outros escopos ficam na pilha; o passo
 *      desfeito sai do lugar e volta para o topo do redo **do mesmo escopo**.
 *    - `undoDepth`/`redoDepth` (globais) continuam existindo (compatibilidade);
 *      `undoDepthFor`/`redoDepthFor` contam **por escopo** — é o que o `EditorCore` usa para
 *      `canUndo`/`canRedo` de cada aba.
 *    - `lastLabel`/`softIntent` são **globais** (última operação); `lastLabelFor`/`softIntentFor`
 *      são **por escopo**.
 *    - `clear()` limpa **todos** os escopos ("limpar todo o histórico"); `clearScope()` limpa
 *      **um** escopo.
 *
 * O alvo é um **port mínimo** definido aqui (`UndoTarget`) — **não** importamos o `TextStore` do
 * módulo de buffer (costura só via `src/shared`).
 */
import type { Edit, EditOrigin, Selection } from "../../shared";

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
  /** Estado de seleção atual. */
  selection(): Selection;
  /** Substitui o estado de seleção. */
  setSelection(s: Selection): void;
  /** Múltiplas seleções (P2#5). Array vazio = sem cursor. */
  selections(): readonly Selection[];
  /** Substitui todas as seleções. */
  setSelections(sels: readonly Selection[]): void;
  /**
   * Escopo (documento) a que o alvo pertence — ex.: o handle do documento (`String(handle)`).
   *
   * **Opcional**: `undefined` = o alvo **não sabe** seu documento (alvos de teste). Nesse caso o
   * alvo casa **só** com passos **sem escopo**. É o que separa as linhas do tempo: desfazer num
   * alvo só toca passos do **mesmo** escopo — os de outros documentos são pulados.
   */
  scopeId?(): string | undefined;
}

export interface UndoRecordOptions {
  /** Chave de coalescência (`typing.42`); `undefined` = passo próprio. */
  readonly groupId?: string;
  readonly origin?: EditOrigin;
  /**
   * Escopo (documento) dono do passo — `undefined` = passo sem escopo.
   * Passos de escopos diferentes **nunca** se misturam (nem na fusão, nem no *glue*).
   */
  readonly scopeId?: string;
  readonly caretBefore?: number;
  readonly caretAfter?: number;
  readonly selectionBefore?: Selection;
  readonly selectionAfter?: Selection;
  readonly selectionsBefore?: readonly Selection[];
  readonly selectionsAfter?: readonly Selection[];
}

export interface UndoStackOptions {
  /** Profundidade máxima do histórico; o mais antigo é truncado. Default `1000`. */
  readonly maxDepth?: number;
}

export type SoftIntent = "undo" | "redo";

const DEFAULT_MAX_DEPTH = 1000;
/** Chave interna do escopo "sem escopo" (`undefined`) — não colide com um id real. */
const NO_SCOPE_KEY = "sem-escopo";

/** Chave interna de um escopo: `undefined` → chave própria; um id real → `s:<id>`. */
function scopeKey(scopeId: string | undefined): string {
  return scopeId === undefined ? NO_SCOPE_KEY : `s:${scopeId}`;
}

interface Step {
  label: string;
  groupId: string | undefined;
  origin: EditOrigin;
  /** Escopo (documento) dono do passo — `undefined` = sem escopo. */
  scopeId: string | undefined;
  /** Ordem cronológica (mono crescente) — mantém a pilha ordenada mesmo depois de um refazer. */
  seq: number;
  /** Deltas *forward* (redo), em ordem de aplicação. */
  edits: Edit[];
  /** Deltas inversos (undo), já em ordem reversa e com `remove`/`insert` trocados. */
  inverse: Edit[];
  caretBefore: number;
  caretAfter: number;
  selectionBefore: Selection;
  selectionAfter: Selection;
  selectionsBefore: readonly Selection[];
  selectionsAfter: readonly Selection[];
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
 * Pilha undo/redo com grupos, glue, soft, profundidade limitada e **escopo por documento**.
 *
 * Invariantes:
 * - `undoSteps`/`redoSteps` são disjuntos; registrar uma transação limpa o redo **do escopo**;
 * - `undoDepth + redoDepth` nunca excede `maxDepth + redoDepth` (o redo só cresce ao desfazer);
 * - um passo só existe se tiver ≥ 1 delta (transação vazia é descartada);
 * - `undo`/`redo` só aplicam passos do **escopo do alvo** — os de outros documentos são pulados
 *   (e ficam na pilha: a ordem global é preservada).
 */
export class UndoStack {
  private readonly maxDepth: number;
  private undoSteps: Step[] = [];
  private redoSteps: Step[] = [];
  /** Intenção de *soft* por escopo (chave = `scopeKey`). */
  private readonly softIntents = new Map<string, SoftIntent>();
  /** Última intenção de *soft* registrada (qualquer escopo) — compatibilidade. */
  private lastSoftIntent: { readonly key: string; readonly intent: SoftIntent } | undefined;
  /** Contador de ordem cronológica dos passos. */
  private seqCounter = 0;

  constructor(opts: UndoStackOptions = {}) {
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    if (!Number.isInteger(this.maxDepth) || this.maxDepth < 1) {
      throw new RangeError(`UndoStack: maxDepth deve ser inteiro >= 1: ${this.maxDepth}`);
    }
  }

  // --- Profundidade ----------------------------------------------------------------------------

  /** Profundidade **global** do undo (todos os escopos) — compatibilidade. */
  get undoDepth(): number {
    return this.undoSteps.length;
  }

  /** Profundidade **global** do redo (todos os escopos) — compatibilidade. */
  get redoDepth(): number {
    return this.redoSteps.length;
  }

  /**
   * Quantos passos o **escopo** pode desfazer — é o `canUndo` da aba (não o total global).
   * `scopeId` `undefined` = passos **sem escopo**.
   */
  undoDepthFor(scopeId: string | undefined): number {
    return this.countScope(this.undoSteps, scopeId);
  }

  /** Quantos passos o **escopo** pode refazer — é o `canRedo` da aba. */
  redoDepthFor(scopeId: string | undefined): number {
    return this.countScope(this.redoSteps, scopeId);
  }

  // --- Rótulo e intenção ------------------------------------------------------------------------

  /** `undoLabel` do passo do topo **global** (distinto do `CommandId` — `06:144`). */
  get lastLabel(): string | undefined {
    return this.undoSteps[this.undoSteps.length - 1]?.label;
  }

  /** `undoLabel` do passo mais recente **do escopo** (o rótulo que a aba mostra). */
  lastLabelFor(scopeId: string | undefined): string | undefined {
    return this.topStepOf(this.undoSteps, scopeId)?.label;
  }

  /** Última intenção registrada por *soft undo/redo* (ou `undefined` após uma operação dura). */
  get softIntent(): SoftIntent | undefined {
    return this.lastSoftIntent?.intent;
  }

  /** Intenção de *soft* **do escopo** (a de outro documento não aparece aqui). */
  softIntentFor(scopeId: string | undefined): SoftIntent | undefined {
    return this.softIntents.get(scopeKey(scopeId));
  }

  // --- Registro --------------------------------------------------------------------------------

  /**
   * Registra uma **transação**: os deltas que um comando aplicou ao alvo. Funde com o topo quando
   * o `groupId` coincide **e o escopo também** (e não há redo pendente no escopo — editar depois
   * de desfazer nunca funde).
   */
  record(label: string, edits: readonly Edit[], opts: UndoRecordOptions = {}): void {
    if (edits.length === 0) return;

    const groupId = opts.groupId;
    const scopeId = opts.scopeId;
    const origin: EditOrigin = opts.origin ?? "user";
    const caretBefore = opts.caretBefore ?? 0;
    const caretAfter = opts.caretAfter ?? caretBefore;
    const selectionBefore = opts.selectionBefore ?? { anchor: 0, active: 0 };
    const selectionAfter = opts.selectionAfter ?? selectionBefore;
    const selectionsBefore = opts.selectionsBefore ?? [selectionBefore];
    const selectionsAfter = opts.selectionsAfter ?? [selectionAfter];

    const top = this.undoSteps[this.undoSteps.length - 1];
    const canMerge =
      !this.hasRedoFor(scopeId) &&
      groupId !== undefined &&
      top !== undefined &&
      top.groupId === groupId &&
      top.scopeId === scopeId;

    if (canMerge && top !== undefined) {
      top.edits.push(...edits);
      top.inverse = invert(top.edits);
      top.label = label;
      top.caretAfter = caretAfter;
      top.selectionAfter = selectionAfter;
      top.selectionsAfter = selectionsAfter;
      this.clearSoftIntent(scopeId);
      return;
    }

    // Novo passo: descarta o redo **do próprio escopo** — o redo de outro documento sobrevive
    // (cada documento tem a sua linha do tempo).
    this.redoSteps = this.redoSteps.filter((step) => step.scopeId !== scopeId);
    this.seqCounter += 1;
    this.undoSteps.push({
      label,
      groupId,
      origin,
      scopeId,
      seq: this.seqCounter,
      edits: [...edits],
      inverse: invert(edits),
      caretBefore,
      caretAfter,
      selectionBefore,
      selectionAfter,
      selectionsBefore,
      selectionsAfter,
      marked: false,
    });
    if (this.undoSteps.length > this.maxDepth) {
      this.undoSteps.splice(0, this.undoSteps.length - this.maxDepth);
    }
    this.clearSoftIntent(scopeId);
  }

  // --- Glue ------------------------------------------------------------------------------------

  /** Marca o passo do topo **global** para *glue*. `false` = pilha vazia (nada a marcar). */
  markForGlue(): boolean {
    const top = this.undoSteps[this.undoSteps.length - 1];
    if (top === undefined) return false;
    top.marked = true;
    return true;
  }

  /** Desmarca o passo do topo **global**. `false` = pilha vazia. */
  unmarkForGlue(): boolean {
    const top = this.undoSteps[this.undoSteps.length - 1];
    if (top === undefined) return false;
    top.marked = false;
    return true;
  }

  /** Marca o passo mais recente **do escopo** para *glue*. `false` = escopo sem passos. */
  markForGlueFor(scopeId: string | undefined): boolean {
    const step = this.topStepOf(this.undoSteps, scopeId);
    if (step === undefined) return false;
    step.marked = true;
    return true;
  }

  /** Desmarca o passo mais recente **do escopo**. `false` = escopo sem passos. */
  unmarkForGlueFor(scopeId: string | undefined): boolean {
    const step = this.topStepOf(this.undoSteps, scopeId);
    if (step === undefined) return false;
    step.marked = false;
    return true;
  }

  /**
   * Funde cada sequência de passos **marcados** num único passo (DEC-BUF-4). O resultado é selado
   * (`groupId` indefinido) para não voltar a coalescer. Só funde passos do **mesmo escopo** — um
   * passo fundido com o de outro documento carregaria os deltas dos dois (corrupção).
   * Devolve `true` se algo foi fundido.
   */
  glueMarkedGroups(): boolean {
    const merged: Step[] = [];
    let didMerge = false;
    for (const step of this.undoSteps) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && prev.marked && step.marked && prev.scopeId === step.scopeId) {
        prev.edits.push(...step.edits);
        prev.inverse = invert(prev.edits);
        prev.caretAfter = step.caretAfter;
        prev.selectionAfter = step.selectionAfter;
        prev.selectionsAfter = step.selectionsAfter;
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

  // --- Undo / redo (escopo do alvo) -------------------------------------------------------------

  /**
   * Desfaz o passo mais recente **do escopo do alvo**: aplica o inverso e restaura o cursor de
   * antes da transação. Passos de **outros** escopos são pulados (não aplicados, não consumidos) —
   * é o que impede um undo na aba B de aplicar os deltas da aba A no buffer de B.
   */
  undo(target: UndoTarget): boolean {
    const scopeId = target.scopeId?.();
    const index = this.indexOfTop(this.undoSteps, scopeId);
    if (index < 0) return false;
    const step = this.undoSteps.splice(index, 1)[0];
    if (step === undefined) return false;
    target.applyEdits(step.inverse, "undo");
    target.setCaret(step.caretBefore);
    target.setSelection(step.selectionBefore);
    target.setSelections(step.selectionsBefore);
    this.redoSteps.push(step);
    this.clearSoftIntent(scopeId);
    return true;
  }

  /**
   * Refaz o passo mais recente **do escopo do alvo**: reaplica os deltas forward com a origem
   * original da transação. Passos de outros escopos são pulados.
   */
  redo(target: UndoTarget): boolean {
    const scopeId = target.scopeId?.();
    const index = this.indexOfTop(this.redoSteps, scopeId);
    if (index < 0) return false;
    const step = this.redoSteps.splice(index, 1)[0];
    if (step === undefined) return false;
    target.applyEdits(step.edits, step.origin);
    target.setCaret(step.caretAfter);
    target.setSelection(step.selectionAfter);
    target.setSelections(step.selectionsAfter);
    // O passo volta para a pilha **na sua ordem cronológica** (a pilha fica ordenada por `seq`).
    this.insertBySeq(step);
    this.clearSoftIntent(scopeId);
    return true;
  }

  /**
   * *Soft undo*: leva o cursor para antes da última transação **do escopo do alvo** — sem alterar
   * o texto.
   */
  softUndo(target: UndoTarget): boolean {
    const scopeId = target.scopeId?.();
    const step = this.topStepOf(this.undoSteps, scopeId);
    if (step === undefined) return false;
    target.setCaret(step.caretBefore);
    this.setSoftIntent(scopeId, "undo");
    return true;
  }

  /**
   * *Soft redo*: leva o cursor para depois da transação desfeita **do escopo do alvo** — sem
   * alterar o texto.
   */
  softRedo(target: UndoTarget): boolean {
    const scopeId = target.scopeId?.();
    const step = this.topStepOf(this.redoSteps, scopeId);
    if (step === undefined) return false;
    target.setCaret(step.caretAfter);
    this.setSoftIntent(scopeId, "redo");
    return true;
  }

  /**
   * Reaplica o histórico **do escopo do alvo** (o que ainda está no undo) em ordem cronológica —
   * replay de macro/estado. `origin` é `"external"`: o alvo é estranho à transação. Passos de
   * outros escopos são ignorados (aplicá-los corromperia o buffer).
   */
  applyTo(target: UndoTarget): void {
    const scopeId = target.scopeId?.();
    const edits: Edit[] = [];
    for (const step of this.undoSteps) {
      if (step.scopeId !== scopeId) continue;
      edits.push(...step.edits);
    }
    if (edits.length === 0) return;
    target.applyEdits(edits, "external");
    const last = this.topStepOf(this.undoSteps, scopeId);
    if (last !== undefined) {
      target.setCaret(last.caretAfter);
      target.setSelection(last.selectionAfter);
      target.setSelections(last.selectionsAfter);
    }
  }

  // --- Limpeza ---------------------------------------------------------------------------------

  /**
   * Limpa undo+redo de **todos** os escopos ("limpar todo o histórico"). Recusa (via `CommandBus`)
   * quando há escopo aberto — DEC-BUF-4/D4. Para limpar **um** documento, use `clearScope`.
   */
  clear(): void {
    this.undoSteps = [];
    this.redoSteps = [];
    this.softIntents.clear();
    this.lastSoftIntent = undefined;
  }

  /** Limpa undo+redo de **um escopo** (os outros documentos mantêm a linha do tempo). */
  clearScope(scopeId: string | undefined): void {
    this.undoSteps = this.undoSteps.filter((step) => step.scopeId !== scopeId);
    this.redoSteps = this.redoSteps.filter((step) => step.scopeId !== scopeId);
    this.clearSoftIntent(scopeId);
  }

  // --- Interno --------------------------------------------------------------------------------

  /** Índice do passo mais recente do escopo (do topo para baixo); `-1` = não há. */
  private indexOfTop(steps: readonly Step[], scopeId: string | undefined): number {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i]?.scopeId === scopeId) return i;
    }
    return -1;
  }

  /** Passo mais recente do escopo (do topo para baixo) ou `undefined`. */
  private topStepOf(steps: readonly Step[], scopeId: string | undefined): Step | undefined {
    const index = this.indexOfTop(steps, scopeId);
    return index < 0 ? undefined : steps[index];
  }

  /** Quantos passos da pilha pertencem ao escopo. */
  private countScope(steps: readonly Step[], scopeId: string | undefined): number {
    let count = 0;
    for (const step of steps) {
      if (step.scopeId === scopeId) count += 1;
    }
    return count;
  }

  /** Há redo pendente **no escopo**? (um redo de outro documento não bloqueia a fusão) */
  private hasRedoFor(scopeId: string | undefined): boolean {
    return this.redoSteps.some((step) => step.scopeId === scopeId);
  }

  /** Reinsere um passo na pilha de undo mantendo a **ordem cronológica** (`seq`). */
  private insertBySeq(step: Step): void {
    let index = this.undoSteps.length;
    while (index > 0 && (this.undoSteps[index - 1]?.seq ?? 0) > step.seq) {
      index -= 1;
    }
    this.undoSteps.splice(index, 0, step);
  }

  /** Registra a intenção de *soft* do escopo. */
  private setSoftIntent(scopeId: string | undefined, intent: SoftIntent): void {
    const key = scopeKey(scopeId);
    this.softIntents.set(key, intent);
    this.lastSoftIntent = { key, intent };
  }

  /** Apaga a intenção de *soft* do escopo (operação dura ou nova edição). */
  private clearSoftIntent(scopeId: string | undefined): void {
    const key = scopeKey(scopeId);
    this.softIntents.delete(key);
    if (this.lastSoftIntent?.key === key) this.lastSoftIntent = undefined;
  }
}
