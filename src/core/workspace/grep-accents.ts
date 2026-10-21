/**
 * Scribe — o **dobramento de acentos** do `grep` (o que faz "acao" achar "ação").
 *
 * O dobramento precisa ser **1:1 em code units** (uma code unit do texto ⇒ uma code unit do
 * texto dobrado): é isso que permite varrer o texto dobrado e ainda reportar linha/coluna do
 * texto **original** (o `scanText` do shared devolve o offset no texto que ele recebeu).
 *
 * Regras (todas nossas — o alvo não expõe a busca em arquivos):
 * - **pré-composto** (NFC): "á" (1 code unit) ⇒ "a" (1 code unit) — a marca combinante some;
 * - **decomposto** (NFD): "a" + U+0301 ⇒ "a" + **sentinela** — a marca vira **1** code unit
 *   que **não casa com nada** (o padrão do usuário nunca contém o sentinela) e assim o 1:1
 *   não quebra (a marca ocupava 1 code unit no texto original);
 * - **bases que não decompõem** (ø, ł, đ, ß, …): uma tabela **1:1** (ver {@link
 *   ACCENT_BASE_FOLD}) — a dobra é letra por letra, porque a 1:1 não comporta "oe"/"ss";
 * - **escritas não-latinas** (cirílico, grego): **ficam como estão** — só o que decompõe em
 *   base **ASCII** + marca é dobrado (o "й" continua "й", o "ά" continua "ά").
 *
 * O **padrão** é dobrado com uma regra a mais: a marca do padrão é *implícita* (some), porque
 * a marca do **texto** vira sentinela (e a sentinela é casada por um `?` opcional na fonte
 * regex — ver {@link buildAccentTolerantSource}).
 */

/** O sentinela que substitui a marca combinante no texto dobrado (1 code unit, área privada). */
export const ACCENT_FOLD_SENTINEL = "\uE000";

/** Faixa das marcas combinantes Unicode (o que o dobramento remove). */
const COMBINING_MARK_FIRST = 0x0300;
const COMBINING_MARK_LAST = 0x036f;

/**
 * Tabela das bases **não-ASCII que não decompõem** (a dobra é 1:1: uma letra por letra).
 *
 * | base | ⇒ | base | ⇒ | base | ⇒ |
 * |---|---|---|---|---|---|
 * | ø | o | ł | l | đ | d |
 * | þ | t | ð | d | ß | s |
 * | ə | e | ĸ | k | ı | i |
 * | ŋ | n | ħ | h | ŧ | t |
 *
 * As maiúsculas são as counterparts diretas (`Ø`⇒`O`, `Ł`⇒`L`, …) — o *case* é resolvido pela
 * flag `i` do `RegExp`, não pela tabela. `æ`/`œ` **não** entram: a dobra 1:1 não comporta
 * "ae"/"oe" (elas ficariam sem dobra).
 */
export const ACCENT_BASE_FOLD: ReadonlyMap<string, string> = new Map([
  ["ø", "o"],
  ["Ø", "O"],
  ["ł", "l"],
  ["Ł", "L"],
  ["đ", "d"],
  ["Đ", "D"],
  ["þ", "t"],
  ["Þ", "T"],
  ["ð", "d"],
  ["Ð", "D"],
  ["ß", "s"],
  ["ẞ", "S"],
  ["ə", "e"],
  ["ĸ", "k"],
  ["ı", "i"],
  ["ŋ", "n"],
  ["Ŋ", "N"],
  ["ħ", "h"],
  ["Ħ", "H"],
  ["ŧ", "t"],
  ["Ŧ", "T"],
]);

/** `true` quando o code unit é uma marca combinante (U+0300–U+036F). */
export function isCombiningMarkCode(code: number): boolean {
  return code >= COMBINING_MARK_FIRST && code <= COMBINING_MARK_LAST;
}

/**
 * Dobra o acento de **um** caractere (1 code unit ⇒ 1 code unit).
 *
 * - ASCII: já é a base (devolve como está);
 * - marca combinante (NFD): vira o {@link ACCENT_FOLD_SENTINEL} (1 code unit, não casa com nada);
 * - base da tabela (ø, ł, ß, …): vira a letra ASCII equivalente;
 * - o que decompõe em base ASCII + marca ("á" ⇒ "a"): vira a base;
 * - o resto (cirílico, grego, emoji): **fica como está**.
 */
export function foldAccentChar(ch: string): string {
  if (ch.length !== 1) return ch; // par substituto (fora do BMP): preserva
  const code = ch.charCodeAt(0);
  if (code < 0x80) return ch; // ASCII: já é a base
  if (isCombiningMarkCode(code)) return ACCENT_FOLD_SENTINEL; // NFD: a marca vira sentinela
  const table = ACCENT_BASE_FOLD.get(ch);
  if (table !== undefined) return table; // base sem decomposição: tabela 1:1
  const decomposed = ch.normalize("NFD");
  if (decomposed.length !== 2) return ch; // não decompõe em base+marca
  const base = decomposed[0]!;
  const mark = decomposed[1]!;
  if (!isCombiningMarkCode(mark.charCodeAt(0))) return ch;
  if (base.charCodeAt(0) > 0x7f) return ch; // base não-ASCII (cirílico/grego): preserva
  return base;
}

/**
 * `true` quando o texto tem **algum** caractere **não-ASCII** (teste rápido, O(n) simples).
 *
 * É o teste que decide se o texto precisa ser **dobrado**: um texto ASCII não muda com o
 * dobramento (o padrão já é dobrado à parte) ⇒ a busca não copia o arquivo inteiro à toa.
 */
export function hasNonAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) return true;
  }
  return false;
}

/**
 * Dobra os acentos de um texto **preservando o tamanho** (1 code unit ⇒ 1 code unit).
 *
 * É o que permite buscar "acao" e achar "ação" **sem** reescrever o scanner: o `scanText` roda
 * sobre o texto dobrado e os offsets (linha/coluna) continuam valendo no original.
 */
export function foldAccents(text: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) continue; // ASCII: rápido
    if (code >= 0xd800 && code <= 0xdbff) {
      i++; // par substituto: pula os dois code units
      continue;
    }
    const ch = text[i]!;
    const folded = foldAccentChar(ch);
    if (folded === ch) continue;
    out += text.slice(start, i) + folded;
    start = i + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

/**
 * Dobra o **padrão** da busca (as marcas do padrão são *implícitas*: somem).
 *
 * O padrão **não** precisa preservar o tamanho (o offset vem do texto), então a marca do
 * padrão pode simplesmente sair — é o que faz "ação" (NFD) e "acao" dare o mesmo resultado.
 */
export function foldPatternAccents(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch.length === 1 && isCombiningMarkCode(ch.charCodeAt(0))) continue; // marca: implícita
    out += foldAccentChar(ch);
  }
  return out;
}

/** `true` quando o texto tem alguma marca combinante (ou seja: está decomposto — NFD). */
export function containsCombiningMark(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isCombiningMarkCode(text.charCodeAt(i))) return true;
  }
  return false;
}

/** Escapa os metacaracteres do `RegExp` (o padrão é **literal**). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Monta a **fonte regex** de uma busca literal que **tolerante a acento**.
 *
 * O texto dobrado troca a marca combinante pelo {@link ACCENT_FOLD_SENTINEL} (1 code unit, e
 * por isso o 1:1 do texto continua valendo). Como o padrão do usuário não tem sentinela, cada
 * caractere do padrão casa com o caractere **e, opcionalmente, com a sentinela** que vem logo
 * depois — assim "acao" acha "ação" tanto no NFC ("acao") quanto no NFD ("a" + U+0301 + "cao").
 *
 * O padrão é escapado caractere a caractere ⇒ continua **literal** (o `.` não casa com qualquer
 * coisa). Cada caractere vira `literal` + `sentinela?` — daí a fonte ser ~2× o padrão.
 */
export function buildAccentTolerantSource(pattern: string): string {
  let source = "";
  for (const ch of pattern) {
    if (ch.length === 1 && isCombiningMarkCode(ch.charCodeAt(0))) continue; // marca: implícita
    // O sentinela é literal (não é metacaracter) e o `?` o torna opcional.
    source += `${escapeRegExp(foldAccentChar(ch))}${ACCENT_FOLD_SENTINEL}?`;
  }
  return source;
}
