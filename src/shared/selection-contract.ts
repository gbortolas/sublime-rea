/**
 * Scribe — contrato de **seleção de texto** no editor.
 *
 * A seleção é representada por dois offsets (UTF-16 code units da string do documento):
 * - `anchor`: onde a seleção **começou** (click, Shift+seta, etc.)
 * - `active`: onde o cursor **está agora**
 *
 * Quando `anchor === active` não há seleção (só o cursor).
 * A seleção normalizada tem `start <= end` (útil para operações de delete/substituir).
 *
 * Origem: observação do Sublime Text (seleção por ranges contínuos, sem múltiplos cursores —
 * P1#1 do ROADMAP.md implementa seleção simples; multi-cursor é P2#5).
 */
export interface Selection {
  readonly anchor: number;
  readonly active: number;
}

/** Conjunto de seleções múltiplas (multi-cursor, P2#5). */
export type SelectionSet = readonly Selection[];

/** Coleção de operações sobre `SelectionSet`. */
export const SelectionSetOps = {
  /** Cria um `SelectionSet` com uma única seleção colapsada. */
  singular(pos: number): SelectionSet {
    return [SelectionOps.collapsed(pos)];
  },

  /** Devolve o `active` da primeira seleção (considerada a primária). */
  primaryActive(s: SelectionSet): number {
    return s.length > 0 ? s[0]!.active : 0;
  },

  /** Aplica um delta (deslocamento) a todas as seleções após um offset. */
  applyDelta(s: SelectionSet, at: number, delta: number): SelectionSet {
    return s.map((sel) => {
      const adjust = (n: number): number => n >= at ? n + delta : n;
      return { anchor: adjust(sel.anchor), active: adjust(sel.active) };
    });
  },

  /** Normaliza todas as seleções (cada uma vira `{start, end}`). */
  normalizeAll(s: SelectionSet): readonly { readonly start: number; readonly end: number }[] {
    return s.map(SelectionOps.normalized);
  },

  /** Verifica se algum offset cai dentro de alguma seleção (útil para Ctrl+D). */
  containsOffset(s: SelectionSet, offset: number): boolean {
    const ranges = SelectionSetOps.normalizeAll(s);
    for (const r of ranges) {
      if (offset >= r.start && offset < r.end) return true;
    }
    return false;
  },
} as const;

/**
 * Edição pontual que desloca cursores: substitui `remove` caracteres a partir de `at` por
 * `insert`. Tem a **mesma forma** do `Edit` do buffer (`buffer-contract.ts`) — o core e o renderer
 * falam a mesma língua de delta.
 */
export interface SelectionEdit {
  /** Offset do início do trecho substituído (code units UTF-16). */
  readonly at: number;
  /** Trecho removido (string vazia = inserção pura). */
  readonly remove: string;
  /** Texto inserido. */
  readonly insert: string;
}

/**
 * Desloca **uma** posição pela edição `at`/`remove`/`insert`:
 * - `p < at` ⇒ `p` (a posição está **antes** do trecho editado);
 * - `p > at + remove.length` ⇒ `p + (insert.length - remove.length)` (está **depois**: desloca);
 * - dentro do trecho removido (bordas inclusas) ⇒ `at + insert.length` (o cursor "cola" no fim
 *   do texto inserido).
 */
function advanceOffset(
  p: number,
  at: number,
  removedEnd: number,
  delta: number,
  insertedEnd: number,
): number {
  if (p < at) return p;
  if (p > removedEnd) return p + delta;
  return insertedEnd;
}

/**
 * Avança um conjunto de seleções pelos `edits` aplicados — **fonte única** da regra de
 * deslocamento de cursores (P2#5).
 *
 * Os edits são aplicados **cumulativamente, na ordem em que foram aplicados ao buffer**: cada
 * edit recebe as posições já deslocadas pelos anteriores (o `at` de um edit é relativo ao estado
 * do buffer depois dos edits anteriores — a mesma semântica do `document.batchInsert`).
 *
 * Aplica-se a `anchor` e a `active` de cada seleção. O resultado é um `SelectionSet` **novo**
 * (imutável): a entrada nunca é tocada.
 */
export function advanceSelections(
  selections: SelectionSet,
  edits: readonly SelectionEdit[],
): SelectionSet {
  if (edits.length === 0) return selections;
  let current: SelectionSet = selections;
  for (const edit of edits) {
    const at = edit.at;
    const removedEnd = at + edit.remove.length;
    const delta = edit.insert.length - edit.remove.length;
    const insertedEnd = at + edit.insert.length;
    current = current.map((sel) => ({
      anchor: advanceOffset(sel.anchor, at, removedEnd, delta, insertedEnd),
      active: advanceOffset(sel.active, at, removedEnd, delta, insertedEnd),
    }));
  }
  return current;
}

/** Operações úteis sobre `Selection`. */
export const SelectionOps = {
  /** `true` se a seleção está colapsada (só cursor, sem faixa selecionada). */
  isCollapsed(s: Selection): boolean {
    return s.anchor === s.active;
  },

  /** Devolve o início (offset menor) e fim (offset maior) da seleção. */
  normalized(s: Selection): { readonly start: number; readonly end: number } {
    return s.anchor <= s.active
      ? { start: s.anchor, end: s.active }
      : { start: s.active, end: s.anchor };
  },

  /** Cria uma `Selection` colapsada no offset `pos`. */
  collapsed(pos: number): Selection {
    return { anchor: pos, active: pos };
  },
} as const;