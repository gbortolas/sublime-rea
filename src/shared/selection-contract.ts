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