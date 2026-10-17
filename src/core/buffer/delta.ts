/**
 * Deltas de edição — conversão, validação de offsets UTF-16 e inversão (DEC-BUF-3/9, DEC-TR-3).
 *
 * **Padrão observado a que corresponde:** no alvo toda mudança aplicada materializa um objeto
 * próprio (uma "mudança", `BUF-E11`) — ou seja, a edição é um **valor**, não um efeito colateral.
 * `TextDelta`/`Edit` são a forma explícita e serializável desse valor (divergência deliberada
 * D5 do doc `01`, que marca os campos nomeados como **escolha nossa**).
 *
 * **Offsets:** sempre em **code units UTF-16** (DEC-BUF-9, escolha nossa — o alvo usa UTF-32/SSO
 * nas strings internas, `BUF-E12`, mas o encoding do corpo é `[DESCONHECIDO]`, `BUF-U2`).
 * Regra dura desta camada: **nunca** aceitar um offset que caia no meio de um par surrogado —
 * `from` e `from + removed.length` têm de ser fronteiras de ponto de código.
 *
 * **Erros:** tipados e altos (`TextDeltaError`) — nada de `catch {}` silencioso (DEC-TR-5).
 */
import type { Edit, TextDelta } from "../../shared";

/** Motivo tipado de rejeição de um delta/edit. */
export type TextDeltaErrorReason =
  | "out-of-range"
  | "surrogate-split"
  | "removed-mismatch"
  | "invalid-code-point";

/** Erro alto de delta inválido (DEC-TR-5): o chamador não pode ignorar uma edição malformada. */
export class TextDeltaError extends Error {
  readonly reason: TextDeltaErrorReason;

  constructor(reason: TextDeltaErrorReason, message: string) {
    super(`TextDeltaError(${reason}): ${message}`);
    this.name = "TextDeltaError";
    this.reason = reason;
  }
}

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const MAX_CODE_POINT = 0x10ffff;

export function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

export function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/** `true` se `offset` cai **entre** as duas metades de um par surrogado de `text`. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  return isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset));
}

/** Valida um offset contra `text`: faixa `[0, text.length]` e fronteira de ponto de código. */
export function assertOffset(text: string, offset: number, label: string): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new TextDeltaError(
      "out-of-range",
      `${label} fora da faixa 0..${text.length}: ${offset}`,
    );
  }
  if (splitsSurrogatePair(text, offset)) {
    throw new TextDeltaError(
      "surrogate-split",
      `${label} cai no meio de um par surrogado: ${offset}`,
    );
  }
}

/** Valida um delta contra o texto **antes** da edição (offsets e `removed` verbatim). */
export function validateDelta(text: string, delta: TextDelta): void {
  assertOffset(text, delta.from, "delta.from");
  const end = delta.from + delta.removed.length;
  if (!Number.isInteger(end) || end > text.length) {
    throw new TextDeltaError(
      "out-of-range",
      `delta.from + removed.length fora da faixa 0..${text.length}: ${end}`,
    );
  }
  assertOffset(text, end, "delta.from + removed.length");
  const actual = text.slice(delta.from, end);
  if (actual !== delta.removed) {
    throw new TextDeltaError(
      "removed-mismatch",
      `texto removido diverge do documento em ${delta.from} (esperado ${delta.removed.length} code units)`,
    );
  }
}

/** Aplica um delta a um `string` (sem tocar no `PieceTable`) — usado em teste e conversão. */
export function applyDelta(text: string, delta: TextDelta): string {
  validateDelta(text, delta);
  if (delta.removed.length === 0 && delta.inserted.length === 0) return text;
  const end = delta.from + delta.removed.length;
  return text.slice(0, delta.from) + delta.inserted + text.slice(end);
}

/** `TextDelta` → `Edit` (forma do undo/redo). */
export function deltaToEdit(delta: TextDelta): Edit {
  return { at: delta.from, remove: delta.removed, insert: delta.inserted };
}

/** `Edit` → `TextDelta`. */
export function editToDelta(edit: Edit): TextDelta {
  return { from: edit.at, removed: edit.remove, inserted: edit.insert };
}

/** Valida um `Edit` contra o texto antes da edição. */
export function validateEdit(text: string, edit: Edit): void {
  validateDelta(text, editToDelta(edit));
}

/** Aplica um `Edit` a um `string`. */
export function applyEdit(text: string, edit: Edit): string {
  return applyDelta(text, editToDelta(edit));
}

/** Inverte um delta: o inverso é trocar `removed` ↔ `inserted` no mesmo offset (DEC-TR-3). */
export function invertDelta(delta: TextDelta): TextDelta {
  return { from: delta.from, removed: delta.inserted, inserted: delta.removed };
}

/** Inverte um `Edit` — insumo do undo por delta inverso (DEC-TR-3). */
export function invertEdit(edit: Edit): Edit {
  return { at: edit.at, remove: edit.insert, insert: edit.remove };
}

/** `true` se o delta não muda nada. */
export function isEmptyDelta(delta: TextDelta): boolean {
  return delta.removed.length === 0 && delta.inserted.length === 0;
}

/** Ponte de codificação da borda (DEC-BUF-9): code units UTF-16 → pontos de código. */
export function utf16ToCodePoints(text: string): number[] {
  const out: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined) out.push(codePoint);
  }
  return out;
}

/** Ponte de codificação da borda (DEC-BUF-9): pontos de código → code units UTF-16. */
export function codePointsToUtf16(codePoints: readonly number[]): string {
  let out = "";
  for (const codePoint of codePoints) {
    if (
      !Number.isInteger(codePoint) ||
      codePoint < 0 ||
      codePoint > MAX_CODE_POINT ||
      (codePoint >= HIGH_SURROGATE_MIN && codePoint <= LOW_SURROGATE_MAX)
    ) {
      throw new TextDeltaError("invalid-code-point", `ponto de código inválido: ${codePoint}`);
    }
    out += String.fromCodePoint(codePoint);
  }
  return out;
}
