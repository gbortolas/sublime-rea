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