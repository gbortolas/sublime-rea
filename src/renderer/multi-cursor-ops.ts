/**
 * Scribe — **multi-cursor ao estilo VS Code** (P2#5): a matemática, **puro** (sem DOM).
 *
 * O que este módulo resolve (e o que **não**):
 * - `findOccurrences` — as ocorrências de um termo, respeitando os **limites de palavra**
 *   ("cat" não casa dentro de "concatenar") e **sem sobreposição**;
 * - `nextOccurrence` — a próxima ocorrência **depois** de um offset, com *wrap*;
 * - `wordAt` — a **palavra** sob um offset (a unidade do Ctrl+D);
 * - `cursorAbove`/`cursorBelow` — o cursor extra na linha vizinha, **preservando a coluna**;
 * - `selectAllOccurrences` — todas as ocorrências viram seleções (Ctrl+Shift+L);
 * - `selectNextOccurrence` — a máquina de estados do **Ctrl+D** (acrescenta, nunca substitui).
 *
 * **Contrato de primário:** o cursor primário é o **primeiro** do conjunto (`selections[0]`) —
 * é a convenção do renderer (`setSelections` desenha `sels[0]` como primário) e do core
 * (`advanceCursorSet`). Por isso o cursor **novo** entra no **início** do conjunto: ele passa a
 * ser o primário (como no VS Code, em que o cursor acrescentado é o ativo).
 *
 * Nada aqui toca no documento: quem aplica o resultado no editor é o `main.ts` (que também
 * cuida do redesenho). As funções são **puras** — mesma entrada, mesma saída — para poderem
 * ser testadas sem DOM (o ambiente de teste do repo é `node`).
 */
import { SelectionOps } from "../shared";
import type { SelectionSet } from "../shared";

/** Classe de caractere de "palavra": a classe de identificador (letra, número ou `_`). */
const WORD_CHAR_PATTERN = /[\p{L}\p{N}_]/u;

/** `true` para caractere de palavra (identificador). */
export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_PATTERN.test(ch);
}

/** Opções de `findOccurrences`. */
export interface FindOccurrencesOptions {
  /** Distingue maiúsculas (default `true` — como o VS Code). */
  readonly caseSensitive?: boolean;
  /** Exige **limites de palavra** (default `true`). */
  readonly wordBoundary?: boolean;
}

/**
 * As ocorrências de `needle` em `text` — os **offsets** de início, **sem sobreposição** e
 * respeitando os **limites de palavra**.
 *
 * Os limites de palavra valem para as **bordas do termo**: se o termo começa com caractere de
 * palavra, o caractere **antes** da ocorrência não pode ser de palavra (e vice-versa). Assim
 * "cat" casa em "um gato" e em "gato." mas **não** em "concatenar" nem em "catálogo".
 *
 * A busca é **case-sensitive** por padrão (`caseSensitive: false` compara em minúsculas — o
 * `toLowerCase` pode deslocar offsets em caracteres exóticos como "İ").
 */
export function findOccurrences(
  text: string,
  needle: string,
  options?: FindOccurrencesOptions,
): number[] {
  if (needle.length === 0 || text.length === 0) return [];
  const caseSensitive = options?.caseSensitive ?? true;
  const wordBoundary = options?.wordBoundary ?? true;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const term = caseSensitive ? needle : needle.toLowerCase();
  // Só as bordas do termo que **são** caractere de palavra exigem limite de palavra.
  const checkLeft = wordBoundary && isWordChar(term[0]);
  const checkRight = wordBoundary && isWordChar(term[term.length - 1]);
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(term, from);
    if (at < 0) break;
    // Sem sobreposição: a próxima busca começa **depois** do trecho casado.
    from = at + term.length;
    if (checkLeft && isWordChar(haystack[at - 1])) continue;
    if (checkRight && isWordChar(haystack[at + term.length])) continue;
    offsets.push(at);
  }
  return offsets;
}

/**
 * A próxima ocorrência **depois** de `from`.
 *
 * Com *wrap*: quando não há nenhuma depois de `from`, volta para a **primeira** (é o que
 * permite ao Ctrl+D dar a volta no documento). `undefined` só quando não há ocorrência
 * alguma.
 *
 * ⚠️ O *wrap* pode devolver uma ocorrência **já selecionada** — quem chama decide o que fazer
 * com ela (o Ctrl+D não a acrescenta de novo).
 */
export function nextOccurrence(offsets: readonly number[], from: number): number | undefined {
  if (offsets.length === 0) return undefined;
  for (const offset of offsets) {
    if (offset > from) return offset;
  }
  return offsets[0];
}

/** A **palavra** (sequência de identificadores) que contém um offset. */
export interface WordRange {
  /** Início da palavra (offset). */
  readonly start: number;
  /** Fim da palavra (offset, exclusivo). */
  readonly end: number;
  /** O texto da palavra. */
  readonly text: string;
}

/**
 * A palavra sob o offset — a unidade de seleção do Ctrl+D.
 *
 * A palavra é a que **contém** o offset: com o cursor no meio (ou colado no fim) dela, a
 * palavra é a mesma. `undefined` quando não há palavra ali (espaço, pontuação, fim do texto).
 */
export function wordAt(text: string, offset: number): WordRange | undefined {
  if (text.length === 0) return undefined;
  const at = Math.max(0, Math.min(offset, text.length));
  let start = at;
  let end = at;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;
  while (end < text.length && isWordChar(text[end])) end += 1;
  if (start === end) return undefined;
  return { start, end, text: text.slice(start, end) };
}

/**
 * A vista mínima do documento que o multi-cursor precisa (a `DocumentLineSource` do renderer
 * satisfaz este contrato).
 */
export interface MultiCursorLineSource {
  positionAt(offset: number): { readonly line: number; readonly column: number };
  offsetOf(line: number, column: number): number;
  lineCount(): number;
  line(index: number): string;
}

/**
 * O cursor extra na linha vizinha (`delta` = -1 acima, +1 abaixo) — **preservando a coluna**.
 *
 * - a coluna é **limitada** ao fim da linha de destino (numa linha mais curta, o cursor fica
 *   no fim dela);
 * - no **limite do documento** (primeira/última linha) o conjunto **não muda**;
 * - o cursor novo entra no **início** do conjunto: ele passa a ser o **primário** (é o que o
 *   VS Code faz — o cursor acrescentado é o ativo).
 */
export function cursorOnNeighborLine(
  selections: SelectionSet,
  source: MultiCursorLineSource,
  delta: number,
): SelectionSet {
  const primary = selections[0];
  if (primary === undefined) return selections;
  const pos = source.positionAt(primary.active);
  const targetLine = pos.line + delta;
  if (targetLine < 0 || targetLine >= source.lineCount()) return selections;
  const targetLength = source.line(targetLine).length;
  const column = Math.max(0, Math.min(pos.column, targetLength));
  const offset = source.offsetOf(targetLine, column);
  return [SelectionOps.collapsed(offset), ...selections];
}

/** O cursor extra na linha **acima** (`delta` = quantas linhas, default 1). */
export function cursorAbove(
  selections: SelectionSet,
  source: MultiCursorLineSource,
  delta = 1,
): SelectionSet {
  return cursorOnNeighborLine(selections, source, -Math.abs(delta));
}

/** O cursor extra na linha **abaixo** (`delta` = quantas linhas, default 1). */
export function cursorBelow(
  selections: SelectionSet,
  source: MultiCursorLineSource,
  delta = 1,
): SelectionSet {
  return cursorOnNeighborLine(selections, source, Math.abs(delta));
}

/** O texto selecionado pela seleção primária ("" quando ela está colapsada). */
function primaryText(selections: SelectionSet, text: string): string {
  const primary = selections[0];
  if (primary === undefined || SelectionOps.isCollapsed(primary)) return "";
  const { start, end } = SelectionOps.normalized(primary);
  return text.slice(start, end);
}

/**
 * `true` quando alguma seleção do conjunto **cobre** o intervalo `[start, end)`.
 *
 * É o teste que fecha o *wrap* do Ctrl+D: a ocorrência que voltou ao início do documento já
 * está selecionada ⇒ não há mais nada a acrescentar.
 */
export function selectionsCover(
  selections: SelectionSet,
  start: number,
  end: number,
): boolean {
  return selections.some((sel) => {
    const range = SelectionOps.normalized(sel);
    return range.start <= start && range.end >= end;
  });
}

/**
 * Todas as ocorrências do termo viram **seleções** (Ctrl+Shift+L) — o conjunto é
 * **substituído** pelas ocorrências.
 *
 * - a ocorrência que contém o cursor primário vai para a frente (ela passa a ser a primária);
 * - as demais ficam em ordem de documento;
 * - sem ocorrências (ou sem termo) o conjunto **não muda**.
 */
export function selectAllOccurrences(
  selections: SelectionSet,
  text: string,
  needle: string,
): SelectionSet {
  const term = needle.length > 0 ? needle : primaryText(selections, text);
  if (term.length === 0) return selections;
  const offsets = findOccurrences(text, term);
  if (offsets.length === 0) return selections;
  const caret = selections[0]?.active ?? 0;
  const current = offsets.find((offset) => caret >= offset && caret <= offset + term.length);
  const ordered =
    current === undefined
      ? offsets
      : [current, ...offsets.filter((offset) => offset !== current)];
  return ordered.map((offset) => ({ anchor: offset, active: offset + term.length }));
}

/**
 * O conjunto de cursores depois de um **Ctrl+D** — **acrescenta**, nunca substitui.
 *
 * - **1ª vez** (cursor colapsado): a **palavra sob o cursor** vira a seleção primária (os
 *   cursores extras continuam vivos);
 * - **vezes seguintes**: a próxima ocorrência **depois** da seleção primária é acrescentada e
 *   passa a ser a primária (o caret vai para lá);
 * - **sem mais ocorrências**: `undefined` — o conjunto continua como está (sem erro, sem toast).
 */
export function selectNextOccurrence(
  selections: SelectionSet,
  text: string,
): SelectionSet | undefined {
  const primary = selections[0];
  if (primary === undefined) return undefined;
  if (SelectionOps.isCollapsed(primary)) {
    const word = wordAt(text, primary.active);
    if (word === undefined) return undefined;
    // A palavra sob o cursor **vira** a seleção primária — os cursores extras (de um
    // Ctrl+click, por exemplo) continuam vivos.
    return [{ anchor: word.start, active: word.end }, ...selections.slice(1)];
  }
  const { start, end } = SelectionOps.normalized(primary);
  const term = text.slice(start, end);
  if (term.length === 0) return undefined;
  const offsets = findOccurrences(text, term);
  if (offsets.length === 0) return undefined;
  const next = nextOccurrence(offsets, end);
  if (next === undefined) return undefined;
  // O wrap devolveu uma ocorrência que já está no conjunto: não há mais nada a acrescentar.
  if (selectionsCover(selections, next, next + term.length)) return undefined;
  return [{ anchor: next, active: next + term.length }, ...selections];
}
