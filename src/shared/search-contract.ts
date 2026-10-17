/**
 * Scribe — contratos de fronteira: busca e substituição (find bar + `TaskPool`).
 *
 * Fonte: `docs/architecture/02-concorrencia-e-scheduling.md` (DEC-CON-1/2/4/8: a UI nunca
 * bloqueia; a varredura é uma **task serializável** numa lane de fundo e o texto vai por
 * mensagem — o worker não tem o store) e `docs/architecture/06-padroes-transversais.md`
 * (DEC-TR-3/5: transação de edição e erro tipado, nunca silencioso).
 *
 * **Escolha nossa (não observada no alvo):** o alvo não expõe o shape da busca; aqui o
 * contrato é uma costura compartilhada entre **worker, main e testes** (a varredura é pura).
 *
 * Unidades: `index`/`length`/`scannedLength` e `line`/`column` estão em **code units UTF-16**
 * (a unidade do buffer — DEC-BUF-9); `line`/`column` são **0-based**. A **substituição é
 * literal** (o texto de substituição entra cru, sem interpretar `$1`/`$&`).
 */

/**
 * Pedido de busca (o que o usuário digita). Todos os campos menos `pattern` são opcionais;
 * `normalizeSearchQuery` aplica os defaults (`regex=false`, `caseSensitive=false`,
 * `wholeWord=false`) e clampa `maxMatches`.
 */
export interface SearchQuery {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxMatches?: number;
}

/** Uma ocorrência: offset/length em code units UTF-16 + linha/coluna 0-based do início. */
export interface SearchMatch {
  index: number;
  length: number;
  line: number;
  column: number;
}

/** Resultado de uma varredura: as ocorrências (possivelmente truncadas) e o quanto foi varrido. */
export interface SearchResult {
  /** Ocorrências em ordem crescente de `index`; no máximo `maxMatches`. */
  readonly matches: readonly SearchMatch[];
  /** `true` = havia mais ocorrências além do teto (`maxMatches`); o resultado está incompleto. */
  readonly truncated: boolean;
  /** Quantos code units foram varridos: `text.length` na varredura completa, o offset de parada se truncada. */
  readonly scannedLength: number;
}

/** Forma já validada/normalizada: o `RegExp` compilado (global) e o teto efetivo de ocorrências. */
export interface NormalizedSearchQuery {
  /** Padrão **original** (o que o usuário digitou — sem escape, sem bordas). */
  readonly pattern: string;
  /** `RegExp` global; `i` quando `caseSensitive=false`; bordas `\b` quando `wholeWord=true`. */
  readonly regex: RegExp;
  readonly maxMatches: number;
}

/** Resultado cross-boundary de `search.find`: a revisão do documento + a varredura. */
export interface SearchDocumentResult {
  readonly revision: number;
  readonly result: SearchResult;
}

/** Resultado cross-boundary de `search.replaceAll`. */
export interface ReplaceAllResult {
  readonly replaced: number;
  readonly revision: number;
}

/** Teto de ocorrências quando o chamador não pede outro (default do find bar). */
export const SEARCH_DEFAULT_MAX_MATCHES = 2000;
/** Teto absoluto de ocorrências por varredura (clamp duro — o resultado é serializável). */
export const SEARCH_MAX_MATCHES = 20000;
/** Teto do padrão do usuário, em code units UTF-16 (protege a compilação do `RegExp`). */
export const SEARCH_MAX_PATTERN_LENGTH = 512;
/** Teto do texto varrido, em code units UTF-16 (64 MiB) — acima disso a varredura recusa. */
export const SEARCH_MAX_TEXT_LENGTH = 64 * 1024 * 1024;

/** Códigos estáveis de erro de entrada da busca/substituição (DEC-TR-5). */
export type SearchErrorCode =
  | "search.pattern"
  | "search.tooLarge"
  | "search.tooManyMatches"
  | "search.emptyPattern";

/** Erro tipado de entrada da busca: padrão vazio/inválido, texto grande demais ou matches demais. */
export class SearchInputError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, detail: string) {
    super(`SearchInputError[${code}]: ${detail}`);
    this.name = "SearchInputError";
    this.code = code;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Escapa os metacaracteres do `RegExp` para buscar o padrão **como literal**. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Valida e normaliza um `SearchQuery`, montando o `RegExp` global. Ordem das falhas:
 * padrão vazio → `search.emptyPattern`; padrão acima do teto ou `regex` inválida → `search.pattern`.
 * `regex=false` escapa o padrão; `wholeWord` envolve em `\b(?:…)\b` (zero-width, **sem captura**);
 * `caseSensitive=false` liga a flag `i`. `maxMatches` é clampado em `[1, SEARCH_MAX_MATCHES]`
 * (valor não-finito cai no default; `0` vira 1).
 */
export function normalizeSearchQuery(query: SearchQuery): NormalizedSearchQuery {
  const pattern = query.pattern;
  if (pattern.length === 0) {
    throw new SearchInputError("search.emptyPattern", "o padrão de busca não pode ser vazio");
  }
  if (pattern.length > SEARCH_MAX_PATTERN_LENGTH) {
    throw new SearchInputError(
      "search.pattern",
      `o padrão excede o teto de ${SEARCH_MAX_PATTERN_LENGTH} code units`,
    );
  }

  const body = query.regex === true ? pattern : escapeRegExp(pattern);
  const source = query.wholeWord === true ? `\\b(?:${body})\\b` : body;
  const flags = query.caseSensitive === true ? "g" : "gi";
  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch (error) {
    throw new SearchInputError("search.pattern", `expressão regular inválida: ${describeError(error)}`);
  }

  const requested = query.maxMatches ?? SEARCH_DEFAULT_MAX_MATCHES;
  // Não-finito (`NaN`/`Infinity`/`-Infinity`) não tem truncamento coerente (`Math.floor(NaN)` é
  // `NaN` ⇒ o cap vira `NaN` e `truncated` **nunca** dispara): cai no default. `0` continua
  // clampado em 1 (pedir "zero matches" não é um cap válido).
  const finite = Number.isFinite(requested) ? requested : SEARCH_DEFAULT_MAX_MATCHES;
  const maxMatches = Math.max(1, Math.min(SEARCH_MAX_MATCHES, Math.floor(finite)));
  return { pattern, regex, maxMatches };
}

/**
 * Varredura **linear de uma passada** (usa `regex.exec` com `lastIndex`, sem lookbehind e sem
 * `String.match` global — não materializa um array gigante). Para ao bater `maxMatches` e devolve
 * `truncated: true`. Ocorrências de **comprimento zero** (ex.: `^`) são ignoradas e a varredura
 * avança 1 code unit para não travar. `line`/`column` são contados incrementalmente (`\n`, `\r\n`).
 * Texto acima de `SEARCH_MAX_TEXT_LENGTH` ⇒ `search.tooLarge`.
 */
export function scanText(text: string, normalized: NormalizedSearchQuery): SearchResult {
  if (text.length > SEARCH_MAX_TEXT_LENGTH) {
    throw new SearchInputError(
      "search.tooLarge",
      `o texto excede o teto de ${SEARCH_MAX_TEXT_LENGTH} code units`,
    );
  }

  const { regex, maxMatches } = normalized;
  regex.lastIndex = 0;

  const matches: SearchMatch[] = [];
  let truncated = false;
  let scannedLength = text.length;
  // Cursor incremental de newline (a varredura só avança): O(n) no total.
  let newlineScan = 0;
  let line = 0;
  let lineStart = 0;
  const positionAt = (index: number): { line: number; column: number } => {
    while (newlineScan < index) {
      if (text.charCodeAt(newlineScan) === 10 /* \n */) {
        line += 1;
        lineStart = newlineScan + 1;
      }
      newlineScan += 1;
    }
    return { line, column: index - lineStart };
  };

  for (;;) {
    const match = regex.exec(text);
    if (match === null) break;
    const length = match[0].length;
    if (length === 0) {
      // Ocorrência vazia (ex.: `^`, `\b`): ignora e avança 1 code unit para garantir progresso.
      if (regex.lastIndex <= match.index) regex.lastIndex = match.index + 1;
      continue;
    }
    if (matches.length >= maxMatches) {
      truncated = true;
      scannedLength = match.index;
      break;
    }
    const position = positionAt(match.index);
    matches.push({ index: match.index, length, line: position.line, column: position.column });
  }

  return { matches, truncated, scannedLength };
}

/** Conveniência: normaliza e varre (padrão de teste e de uso fora do worker). */
export function findMatches(text: string, query: SearchQuery): SearchResult {
  return scanText(text, normalizeSearchQuery(query));
}
