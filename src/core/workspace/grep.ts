/**
 * Scribe — busca em **todos os arquivos da workspace** (o "grep" do VS Code).
 *
 * O `find bar` busca **no documento aberto** (`src/shared/search-contract.ts` ⇒
 * `normalizeSearchQuery` + `scanText`, task `search` na lane `index` do `TaskPool`). Aqui a
 * **mesma semântica** é aplicada a **vários arquivos**, em paralelo e fora da UI.
 *
 * Decisões (todas nossas — o alvo não expõe a busca em arquivos):
 * - **o scanner não é reescrito**: `scanText` faz a varredura (literal/regex, colunas em
 *   code units UTF-16, `line`/`column` 0-based) e o módulo só **orquestra** a leitura dos
 *   arquivos;
 * - **acento-insensitivo por padrão** (`ignoreAccents`, default `true`): o texto e o padrão
 *   são "dobrados" (NFC→ASCII, NFD→base+sentinela) com uma transformação **1:1 em code
 *   units** ⇒ os offsets (e portanto linha/coluna) continuam válidos no texto original
 *   (o dobramento mora em `grep-accents.ts`);
 * - **regex** (`regex`, default `false` = literal): com `regex=true` o padrão vai cru para o
 *   `RegExp` do shared e **a dobra de acentos fica desligada** (dobrar o *padrão* quebraria a
 *   semântica de `[á-ú]`/`\p{...}`, e dobrar o *texto* quebraria `\p{L}` com letras acentuadas);
 * - **padrão catastrófico**: no modo regex, um padrão com **quantificador aninhado**
 *   (`(a+)+`) ou **alternância ambígua** (`(a|aa)+`) é **recusado antes de varrer** (o
 *   `RegExp` do JS faz *backtracking* ⇒ a busca não terminaria e travaria o app inteiro);
 * - **case** (`caseSensitive`, default `false` = ignora o case, como o find bar);
 * - **binários**: por padrão são **ignorados** (`includeBinary`, default `false`); com
 *   `includeBinary=true` o arquivo entra na varredura (o `readFile` é utf8 e preserva o NUL);
 * - **pula** o que não é texto: arquivo grande (> `maxFileLength`, em **code units** do texto
 *   decodificado — no modo regex o teto é **menor**: {@link GREP_REGEX_MAX_FILE_LENGTH}),
 *   binário (contém `\0`, salvo `includeBinary`) e diretório/ilegível (o `readFile` falha ⇒
 *   o arquivo é pulado e a busca continua);
 * - **tetos**: `maxMatches` (ocorrências) e `maxFiles` (arquivos) ⇒ `truncated: true`;
 * - **paralelo**: a leitura tem concorrência limitada (`concurrency`, default 8) e o
 *   `AbortSignal` cancela a operação no meio da leitura.
 *
 * **Multi-root:** o núcleo é **agnóstico de raízes** — ele recebe a lista de arquivos
 * (`files`, caminhos absolutos) e não sabe de onde eles vieram. Quem resolve as raízes é o
 * `main` (o `workspaceIndex`): ele expande **cada** raiz e entrega a lista **plana** de
 * arquivos. Um caminho de arquivo **não** precisa estar sob uma raiz conhecida pelo núcleo.
 *
 * O módulo é **puro** (a I/O entra por `readFile`): o `main` injeta o `FileSystem` e o
 * renderer nunca chama isto direto (a travessia é o IPC).
 *
 * ⚠️ **Contrato do port de leitura** (ver {@link GrepReadFile}): o `readFile` recebe o
 * **teto** do arquivo e **precisa respeitá-lo** (ler no máximo N bytes e sinalizar "grande
 * demais" com o código {@link GREP_FILE_TOO_LARGE}) — sem isso, o núcleo materializaria o
 * arquivo inteiro (2 GB!) antes de poder descartá-lo.
 *
 * ⚠️ **Residual conhecido (follow-up):** a varredura é **síncrona** no processo principal
 * (o `main` roda o `grepWorkspace` no event loop ⇒ a janela, o IPC e o LSP **esperam** o
 * scan terminar). O que esta rodada mitiga é o pior caso (padrão catastrófico ⇒ recusado;
 * arquivo grande ⇒ pulado antes de ser lido), mas o **budget de tempo** (o scan rodar numa
 * *worker* ou ser interrompido por um teto de tempo) ainda **não** existe.
 */
import { CancellationError, SearchInputError, toError } from "../../shared";
import {
  normalizeSearchQuery,
  scanText,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_PATTERN_LENGTH,
} from "../../shared/search-contract";
import type { NormalizedSearchQuery, SearchResult } from "../../shared/search-contract";
import {
  buildAccentTolerantSource,
  containsCombiningMark,
  foldAccents,
  foldPatternAccents,
  hasNonAscii,
} from "./grep-accents";

export { foldAccents } from "./grep-accents";

/** Uma ocorrência encontrada num arquivo da workspace. */
export interface GrepMatch {
  /** Caminho do arquivo (o mesmo string que o chamador passou em `files`). */
  readonly path: string;
  /** Linha da ocorrência — **0-based** (mesma convenção de `scanText`). */
  readonly line: number;
  /** Coluna da ocorrência — **0-based**, em code units UTF-16. */
  readonly column: number;
  /** A **linha inteira** onde a ocorrência está (sem o terminador de linha). */
  readonly text: string;
}

/** Resultado de uma varredura da workspace. */
export interface GrepResult {
  /** Ocorrências ordenadas por `(path, line, column)`. */
  readonly matches: readonly GrepMatch[];
  /** `true` = o resultado está **incompleto** (bateu no teto de matches/arquivos). */
  readonly truncated: boolean;
  /** Quantos arquivos foram **de fato varridos** (lidos e varridos — pulados não contam). */
  readonly filesScanned: number;
  /**
   * Os **avisos** da busca (o que foi desligado/ajustado — **nunca** um crash).
   *
   * Ex.: no modo `regex` a dobra de acentos é desligada (a regex do usuário precisa casar
   * com o texto **exatamente**) ⇒ o aviso diz isso explicitamente, em vez de descartar a
   * opção em silêncio.
   */
  readonly warnings?: readonly string[];
}

/**
 * O port de leitura do `grep`.
 *
 * ⚠️ **Contrato (mudança)**: o port recebe o **teto** (`maxLength`, em code units do texto
 * decodificado) e **precisa respeitá-lo** — o `main` lê no máximo N bytes e, se o arquivo
 * for maior, **sinaliza** ("grande demais") lançando um erro com o código
 * {@link GREP_FILE_TOO_LARGE}. Sem isso, o núcleo materializaria o arquivo inteiro (2 GB!)
 * antes de poder descartá-lo.
 *
 * Um port que **ignora** o `maxLength` ainda funciona (o núcleo checa o tamanho do texto
 * depois) — mas o arquivo grande já foi lido: por isso o `main` precisa adaptar o port.
 */
export type GrepReadFile = (path: string, maxLength: number) => Promise<string>;

/** Opções da busca na workspace. */
export interface GrepOptions {
  /**
   * O padrão **cru** (o que o usuário digitou). A normalização é feita aqui, com o mesmo
   * `normalizeSearchQuery` do find bar: **literal** (o padrão é escapado) ou **regex**
   * (`regex: true`), com teto de ocorrências.
   */
  readonly query: string;
  /**
   * Caminhos candidatos (a lista de arquivos da workspace).
   *
   * O núcleo é **agnóstico de raízes**: quem resolve as raízes é o `main` (ele expande cada
   * raiz e entrega a lista **plana** de arquivos absolutos) — aqui só chega o caminho.
   */
  readonly files: readonly string[];
  /**
   * Lê o conteúdo de um arquivo (injetado: o `main` passa o `FileSystem`).
   *
   * ⚠️ O port recebe o **teto** do arquivo ({@link GrepOptions.maxFileLength}) e **precisa
   * respeitá-lo** (ler no máximo N bytes e sinalizar "grande demais" com o código
   * {@link GREP_FILE_TOO_LARGE}) — ver {@link GrepReadFile}.
   */
  readonly readFile: GrepReadFile;
  /** Cancela a busca (cooperativo): aborta no meio da leitura. */
  readonly signal?: AbortSignal;
  /** Teto de ocorrências (default {@link GREP_DEFAULT_MAX_MATCHES}). */
  readonly maxMatches?: number;
  /**
   * Teto de tamanho por arquivo, em **code units UTF-16 do texto decodificado**
   * (default {@link GREP_DEFAULT_MAX_FILE_LENGTH}).
   *
   * O nome é honesto: o `readFile` entrega **texto** (utf8), então o limite é medido em
   * code units — e não em bytes do arquivo (um arquivo de 1 MiB de UTF-8 com acentos tem
   * menos code units que bytes).
   *
   * ⚠️ Em modo `regex` o teto efetivo é **menor** ({@link GREP_REGEX_MAX_FILE_LENGTH}) —
   * a regex do usuário pode ser cara.
   */
  readonly maxFileLength?: number;
  /**
   * @deprecated Use {@link GrepOptions.maxFileLength} — este nome mentia (media code units,
   * não bytes). Aceito como **apelido** (se `maxFileLength` não vier, este valor vale).
   */
  readonly maxFileBytes?: number;
  /** Teto de arquivos varridos (default {@link GREP_DEFAULT_MAX_FILES}). */
  readonly maxFiles?: number;
  /** Leituras em paralelo (default {@link GREP_DEFAULT_CONCURRENCY}). */
  readonly concurrency?: number;
  /**
   * Busca **acento-insensitiva** (default `true`): "acao" casa com "ação" (NFC **e** NFD).
   * Desligar ⇒ o padrão casa **exatamente** (byte a byte, fora o case).
   *
   * **Com `regex: true` a dobra fica desligada** (dobrar o padrão quebraria a semântica da
   * regex; dobrar o texto quebraria `\p{L}` com letras acentuadas).
   */
  readonly ignoreAccents?: boolean;
  /**
   * O padrão é uma **expressão regular** (default `false` = literal).
   *
   * Com `regex: true` o padrão vai **cru** para o `RegExp` do shared (sem escape) e a dobra
   * de acentos é **desligada**.
   */
  readonly regex?: boolean;
  /**
   * A busca **diferencia maiúsculas** (default `false` = ignora o case, como o find bar).
   */
  readonly caseSensitive?: boolean;
  /**
   * Inclui os arquivos **binários** na varredura (default `false` = são ignorados, como até
   * agora). Com `true`, o arquivo binário (contém NUL) entra na varredura como texto.
   */
  readonly includeBinary?: boolean;
  /** Notificado quando um arquivo **não pôde ser lido** (o arquivo é pulado, a busca segue). */
  readonly onError?: (path: string, error: Error) => void;
}

/** Teto de ocorrências (default). */
export const GREP_DEFAULT_MAX_MATCHES = 500;
/** Teto de tamanho por arquivo (default) — 512 KiB (em code units do texto decodificado). */
export const GREP_DEFAULT_MAX_FILE_LENGTH = 512 * 1024;
/**
 * O teto de tamanho por arquivo no modo **regex** — 64 KiB (mais estrito que o literal).
 *
 * A regex do usuário pode ser cara (mesmo sem ser catastrófica): o teto menor limita o
 * pior caso de uma varredura por arquivo.
 */
export const GREP_REGEX_MAX_FILE_LENGTH = 64 * 1024;
/** @deprecated ApELido de {@link GREP_DEFAULT_MAX_FILE_LENGTH} (o nome antigo mentia). */
export const GREP_DEFAULT_MAX_FILE_BYTES = GREP_DEFAULT_MAX_FILE_LENGTH;
/** Teto de arquivos varridos (default). */
export const GREP_DEFAULT_MAX_FILES = 2000;
/** Leituras em paralelo (default). */
export const GREP_DEFAULT_CONCURRENCY = 8;

/**
 * O código de erro que o **port de leitura** usa para dizer "o arquivo é grande demais".
 *
 * ⚠️ **Contrato com o `main`**: o port **precisa** respeitar o `maxLength` que recebe
 * (ler no máximo N bytes) e, quando o arquivo for maior, **lançar** um erro com este
 * código. O núcleo então pula o arquivo e avisa — sem nunca materializar um arquivo de
 * 2 GB na memória.
 */
export const GREP_FILE_TOO_LARGE = "search.tooLarge";

// ---------------------------------------------------------------------------------------------
// Detecção de padrão "catastrófico" (o `RegExp` do JS faz *backtracking*)
// ---------------------------------------------------------------------------------------------

/** O que a análise do padrão encontrou (a mensagem do erro diz o quê). */
export type CatastrophicPatternReason = "quantificador aninhado" | "alternância ambígua";

/** O quantificador que segue um átomo. */
interface Quantifier {
  /** `true` quando o quantificador é **sem limite** (`*`, `+`, `{n,}`). */
  readonly unbounded: boolean;
  /** O índice logo depois do quantificador. */
  readonly end: number;
}

/**
 * Lê o quantificador que começa em `index` (ou devolve "sem quantificador").
 *
 * `*`/`+` são **sem limite**; `{n,}` também; `{n}` e `{n,m}` são limitados; `?` é
 * "opcional" (não é sem limite). O marcador *lazy* (`*?`, `+?`) faz parte do quantificador.
 */
function readQuantifier(source: string, index: number): Quantifier {
  const ch = source.charAt(index);
  let end = index;
  let unbounded = false;
  let present = false;
  if (ch === "*" || ch === "+") {
    present = true;
    unbounded = true;
    end = index + 1;
  } else if (ch === "?") {
    present = true;
    end = index + 1;
  } else if (ch === "{") {
    const close = source.indexOf("}", index);
    if (close > index) {
      const parts = source.slice(index + 1, close).split(",");
      const lower = Number(parts[0]);
      const upper =
        parts.length > 1
          ? parts[1]!.trim() === ""
            ? Number.POSITIVE_INFINITY
            : Number(parts[1]!)
          : lower;
      present = Number.isFinite(lower);
      unbounded = present && (!Number.isFinite(upper) || upper > lower);
      end = close + 1;
    }
  }
  if (!present) return { unbounded: false, end: index };
  if (source.charAt(end) === "?") end += 1; // marcador *lazy*
  return { unbounded, end };
}

/** Devolve o índice logo depois do `]` da classe de caracteres que começa em `index`. */
function skipCharClass(source: string, index: number): number {
  let i = index + 1;
  if (source.charAt(i) === "^") i += 1;
  if (source.charAt(i) === "]") i += 1; // o "]" pode ser literal no começo da classe
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "]") return i + 1;
    i += 1;
  }
  return i;
}

/** Um grupo aberto na fonte da regex (o corpo é acumulado para a análise). */
interface RegexFrame {
  /** O corpo do grupo (o fonte entre `(` e `)`). */
  body: string;
  /** `true` quando o corpo tem um quantificador **sem limite** (`*`, `+`, `{n,}`). */
  hasUnbounded: boolean;
  /** `true` quando o corpo tem uma alternância (`|`). */
  hasAlternation: boolean;
}

/** Divide o corpo de um grupo nas alternativas de topo (`|` fora de grupo/classe). */
function splitTopLevelAlternatives(body: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch === "\\") {
      current += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "[") {
      const end = skipCharClass(body, i);
      current += body.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts;
}

/** O índice do `(` que casa com o `)` em `closeIndex` (−1 quando não acha). */
function matchingOpenParen(source: string, closeIndex: number): number {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    const ch = source.charAt(i);
    if (ch === ")") depth += 1;
    else if (ch === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `true` quando a alternativa pode casar **vazio** (ex.: "a*", "a{0,3}", ""). */
function isNullableAlternative(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.length === 0) return true;
  const last = trimmed.charAt(trimmed.length - 1);
  if (last === "*" || last === "?") return true;
  if (last === "}") {
    const open = trimmed.lastIndexOf("{");
    if (open >= 0) {
      const body = trimmed.slice(open + 1, trimmed.length - 1);
      const lower = body.split(",")[0]?.trim() ?? "";
      return lower.length === 0 || Number(lower) === 0;
    }
    return false;
  }
  if (last === ")") {
    const open = matchingOpenParen(trimmed, trimmed.length - 1);
    if (open < 0) return false;
    const inner = trimmed.slice(open + 1, trimmed.length - 1);
    return splitTopLevelAlternatives(inner).some((alternative) => isNullableAlternative(alternative));
  }
  return false;
}

/** `true` quando uma alternativa é **prefixo** da outra (⇒ as duas casam a mesma string). */
function alternativesOverlap(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  return left.startsWith(right) || right.startsWith(left);
}

/** `true` quando as alternativas de um grupo se sobrepõem (ou alguma casa vazio). */
function hasAmbiguousAlternatives(body: string): boolean {
  const alternatives = splitTopLevelAlternatives(body);
  for (const alternative of alternatives) {
    if (isNullableAlternative(alternative)) return true;
  }
  for (let i = 0; i < alternatives.length; i += 1) {
    for (let j = i + 1; j < alternatives.length; j += 1) {
      if (alternativesOverlap(alternatives[i]!, alternatives[j]!)) return true;
    }
  }
  return false;
}

/**
 * Analisa a fonte de uma regex e diz se ela é **catastrófica**.
 *
 * O `RegExp` do JS é um motor de **backtracking**: um padrão como `(a+)+` (quantificador
 * aninhado) ou `(a|aa)+` (alternância ambígua) faz o motor explorar 2^n caminhos num texto
 * de n caracteres ⇒ a varredura **não termina** (e, como o `grep` roda no processo
 * principal, o app inteiro trava).
 *
 * A detecção é **conservadora** (só recusa o que é claramente catastrófico):
 * - **quantificador aninhado**: um grupo quantificado sem limite (`*`, `+`, `{n,}`) cujo
 *   corpo tem outro quantificador sem limite;
 * - **alternância ambígua**: um grupo quantificado sem limite cujas alternativas se
 *   **sobrepõem** (uma é prefixo da outra) ou alguma delas pode casar **vazio**.
 */
function findCatastrophicConstruct(source: string): CatastrophicPatternReason | undefined {
  const stack: RegexFrame[] = [];
  let reason: CatastrophicPatternReason | undefined;

  const top = (): RegexFrame | undefined => stack[stack.length - 1];
  const markUnbounded = (): void => {
    const frame = top();
    if (frame !== undefined) frame.hasUnbounded = true;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);

    if (ch === "\\") {
      i += 2; // o caractere escapado (um átomo)
      const quant = readQuantifier(source, i);
      if (quant.unbounded) markUnbounded();
      i = quant.end;
      continue;
    }

    if (ch === "[") {
      i = skipCharClass(source, i);
      const quant = readQuantifier(source, i);
      if (quant.unbounded) markUnbounded();
      i = quant.end;
      continue;
    }

    if (ch === "(") {
      stack.push({ body: "", hasUnbounded: false, hasAlternation: false });
      i += 1;
      continue;
    }

    if (ch === ")") {
      const frame = stack.pop();
      i += 1;
      if (frame === undefined) continue;
      const quant = readQuantifier(source, i);
      const parent = top();
      if (parent !== undefined) {
        parent.body += `(${frame.body})`;
        // O grupo (ou o quantificador dele) é um quantificador sem limite no corpo do pai.
        if (frame.hasUnbounded || quant.unbounded) parent.hasUnbounded = true;
        if (frame.hasAlternation) parent.hasAlternation = true;
      }
      if (quant.unbounded) {
        if (reason === undefined && frame.hasUnbounded) reason = "quantificador aninhado";
        if (reason === undefined && frame.hasAlternation && hasAmbiguousAlternatives(frame.body)) {
          reason = "alternância ambígua";
        }
      }
      i = quant.end;
      continue;
    }

    if (ch === "|") {
      const frame = top();
      if (frame !== undefined) {
        frame.hasAlternation = true;
        // O `|` fica no corpo (é ele que separa as alternativas — a ambiguidade é
        // comparada entre elas).
        frame.body += "|";
      }
      i += 1;
      continue;
    }

    // Um átomo comum (`.`, `a`, `^`, `$`, …).
    const frame = top();
    if (frame !== undefined) frame.body += ch;
    i += 1;
    const quant = readQuantifier(source, i);
    if (quant.unbounded) markUnbounded();
    i = quant.end;
  }

  return reason;
}

/**
 * `true` quando o padrão regex é **catastrófico** (a varredura pode não terminar).
 *
 * Ver {@link findCatastrophicConstruct} (a regra) — o export é o **contrato** que o
 * teste (e quem valida o padrão antes de varrer) usa.
 */
export function isCatastrophicPattern(pattern: string): boolean {
  return findCatastrophicConstruct(pattern) !== undefined;
}

/**
 * `true` quando o texto tem um byte NUL ⇒ é binário (não é texto).
 *
 * Com `includeBinary: true` o arquivo **entra** na varredura (o `readFile` é utf8 e
 * preserva o NUL).
 */
function isBinaryText(text: string): boolean {
  return text.indexOf("\u0000") >= 0;
}

/**
 * `true` quando o erro do port diz "o arquivo é grande demais".
 *
 * O port sinaliza isso lançando um erro com o código {@link GREP_FILE_TOO_LARGE} (é o
 * contrato com o `main`) — o arquivo é pulado e a busca continua.
 */
function isTooLargeError(error: Error): boolean {
  const code = (error as { readonly code?: unknown }).code;
  return code === GREP_FILE_TOO_LARGE;
}

/** O erro de "arquivo grande demais" (a mensagem diz o teto que foi estourado). */
function tooLargeError(path: string, maxFileLength: number): Error {
  return new SearchInputError(
    "search.tooLarge",
    `o arquivo "${path}" excede o teto de ${maxFileLength} code units por arquivo`,
  );
}

/** A linha (sem o terminador) que contém o offset — no texto **original**. */
function lineTextAt(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  let end = text.indexOf("\n", offset);
  if (end < 0) end = text.length;
  const line = text.slice(start, end);
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function compareMatches(a: GrepMatch, b: GrepMatch): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

function positiveOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

function describeReason(reason: unknown): string {
  if (reason === undefined || reason === null) return "cancelado";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/** Resultado da leitura de um arquivo (nunca rejeita: o erro vira `ok: false`). */
type ReadOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: Error };

/** Portão de abort: rejeita quando o sinal aborta (e pode ser desregistrado). */
interface AbortGate {
  readonly promise: Promise<never>;
  dispose(): void;
}

function createAbortGate(signal: AbortSignal): AbortGate {
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new CancellationError(describeReason(signal.reason)));
      return;
    }
    listener = (): void => {
      reject(new CancellationError(describeReason(signal.reason)));
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose: (): void => {
      if (listener !== undefined) signal.removeEventListener("abort", listener);
    },
  };
}

/**
 * Lê o arquivo respeitando o cancelamento.
 *
 * A leitura vira uma promessa que **nunca rejeita** (o erro vira `ok: false`): assim o
 * `race` com o abort pode vencer sem deixar uma rejeição não treatmentada quando a leitura
 * falha **depois** do cancelamento.
 */
async function readFileCancellable(
  path: string,
  readFile: GrepReadFile,
  maxLength: number,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  if (signal === undefined) {
    try {
      return { ok: true, text: await readFile(path, maxLength) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  }
  const settled: Promise<ReadOutcome> = readFile(path, maxLength).then(
    (text): ReadOutcome => ({ ok: true, text }),
    (error: unknown): ReadOutcome => ({ ok: false, error: toError(error) }),
  );
  const gate = createAbortGate(signal);
  try {
    return await Promise.race([settled, gate.promise]);
  } finally {
    gate.dispose();
  }
}

/**
 * Busca o padrão em **todos os arquivos** candidatos.
 *
 * - a leitura é **paralela** (concorrência limitada) e **cancelável** (`signal`);
 * - arquivo grande/binário/ilegível é **pulado** (a busca continua);
 * - `truncated: true` quando o resultado está incompleto (bateu no teto de matches ou de
 *   arquivos);
 * - as ocorrências saem ordenadas por `(path, line, column)`.
 *
 * Lança `SearchInputError` para padrão vazio/excedente/inválido (o mesmo contrato do find
 * bar) e `CancellationError` quando o `signal` aborta.
 *
 * **Limites conhecidos (documentados de propósito):**
 * - o `RegExp` do shared é compilado com as flags `g`/`gi` — **sem `u`** ⇒ `\p{…}`/`\u{…}`
 *   não funcionam; **sem `m`** ⇒ o `^`/$` ancoram o texto todo, não a linha;
 * - com acento-insensibilidade, um padrão **longo** (> ~250 caracteres) não cabe na fonte
 *   "tolerante" (ela dobra de tamanho por causa do sentinela opcional) ⇒ em arquivos **NFD**
 *   ele volta ao comportamento literal (a dobra de acento é perdida **só** nesses arquivos);
 * - a dobra de acento é **1:1**: `ß` dobra para `s` (e não `ss`) e `æ`/`œ` **não** dobram
 *   (a dobra 1:1 não comporta duas letras).
 */
export async function grepWorkspace(options: GrepOptions): Promise<GrepResult> {
  const maxMatches = Math.min(
    positiveOr(options.maxMatches, GREP_DEFAULT_MAX_MATCHES),
    SEARCH_MAX_MATCHES,
  );
  // `maxFileLength` é o nome honesto (code units do texto decodificado); `maxFileBytes` é o
  // apelido antigo (aceito, mas só se o novo não vier).
  const regexMode = options.regex === true;
  const requestedFileLength = positiveOr(
    options.maxFileLength ?? options.maxFileBytes,
    GREP_DEFAULT_MAX_FILE_LENGTH,
  );
  // ⚠️ Em modo **regex** o teto é **mais estrito** (64 KiB): a regex do usuário pode ser
  // cara (mesmo sem ser catastrófica) ⇒ o pior caso por arquivo é menor.
  const maxFileLength = regexMode
    ? Math.min(requestedFileLength, GREP_REGEX_MAX_FILE_LENGTH)
    : requestedFileLength;
  const maxFiles = positiveOr(options.maxFiles, GREP_DEFAULT_MAX_FILES);
  const concurrency = positiveOr(options.concurrency, GREP_DEFAULT_CONCURRENCY);
  const ignoreAccents = options.ignoreAccents ?? true;
  const caseSensitive = options.caseSensitive ?? false;
  const includeBinary = options.includeBinary === true;
  // Com regex a dobra de acentos fica **desligada** (dobrar o padrão quebraria `[á-ú]`/`\p{…}`
  // e dobrar o texto quebraria `\p{L}` com letras acentuadas).
  const fold = ignoreAccents && !regexMode;

  const signal = options.signal;
  if (signal?.aborted) throw new CancellationError(describeReason(signal.reason));

  const candidates = options.files.slice(0, maxFiles);
  let truncated = options.files.length > candidates.length;

  // Valida o padrão com o **mesmo** contrato do find bar (vazio/excedente/inválido ⇒ erro
  // tipado). Em modo regex a validação é a da **regex** (o padrão vai cru para o `RegExp`).
  const rawPattern = options.query;
  normalizeSearchQuery({ pattern: rawPattern, regex: regexMode, caseSensitive });

  // ⚠️ **Padrão catastrófico**: o `RegExp` do JS faz *backtracking* ⇒ `(a+)+` (quantificador
  // aninhado) ou `(a|aa)+` (alternância ambígua) **não terminam** num texto com "aaaa…".
  // Como o `grep` roda no processo principal, isso travaria o app inteiro ⇒ o padrão é
  // **recusado antes de varrer**, com um erro claro (nunca um crash).
  if (regexMode) {
    const catastrophe = findCatastrophicConstruct(rawPattern);
    if (catastrophe !== undefined) {
      throw new SearchInputError(
        "search.pattern",
        `padrão regex potencialmente catastrófico (${catastrophe}) — a busca foi cancelada para não travar o editor`,
      );
    }
  }

  // O padrão efetivo (literal, já dobrado). O padrão **não** precisa preservar o tamanho
  // (o offset vem do texto), então a marca do padrão é implícita e simplesmente some.
  const foldedPattern = foldPatternAccents(rawPattern);
  const pattern = fold ? foldedPattern : rawPattern;
  if (pattern.length === 0) {
    throw new SearchInputError(
      "search.emptyPattern",
      "o padrão de busca não pode ser vazio",
    );
  }
  // O padrão **tinha** acento? (o dobramento mudou o padrão) — é o que decide se o texto
  // precisa ser dobrado (o texto ASCII não muda com o dobramento).
  const patternHasAccent = foldedPattern !== rawPattern;
  // A fonte **tolerante a acento** (literal + sentinela opcional depois de cada caractere):
  // só é usada nos arquivos que têm marca combinante (NFD) — e só se couber no teto de
  // padrão do shared (senão o arquivo é varrido com o padrão literal simples).
  const tolerantSource = fold ? buildAccentTolerantSource(rawPattern) : undefined;
  const tolerantUsable =
    tolerantSource !== undefined && tolerantSource.length <= SEARCH_MAX_PATTERN_LENGTH;

  // Os **avisos** da busca (o que foi desligado — nunca um crash).
  const warnings: string[] = [];
  if (regexMode && ignoreAccents) {
    const warning =
      "a busca acento-insensitiva foi desligada no modo regex (o padrão casa com o texto exatamente)";
    warnings.push(warning);
    // O descarte **não** é silencioso: o `main` vê o aviso no log e o resultado o carrega.
    console.warn(`Scribe: grep — ${warning}`);
  }

  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let budget = maxMatches;
  let cursor = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const index = cursor++;
      if (index >= candidates.length) return;
      if (budget <= 0) {
        // Parou por falta de orçamento: o resultado está **incompleto** (pode haver mais
        // ocorrências nos arquivos que não chegaram a ser varridos).
        truncated = true;
        stop = true;
        return;
      }
      const path = candidates[index]!;
      // O port recebe o **teto**: ele lê no máximo `maxFileLength` e sinaliza "grande
      // demais" (o arquivo de 2 GB nunca é materializado aqui).
      const outcome = await readFileCancellable(path, options.readFile, maxFileLength, signal);
      if (!outcome.ok) {
        // Diretório, sem permissão, arquivo que sumiu: pula o arquivo e **continua**.
        options.onError?.(
          path,
          isTooLargeError(outcome.error) ? tooLargeError(path, maxFileLength) : outcome.error,
        );
        continue;
      }
      if (stop) return;
      const text = outcome.text;
      if (text.length > maxFileLength) {
        // O port **ignorou** o teto (port antigo): o arquivo é pulado — com aviso (o teto
        // aparece na mensagem, para o usuário saber por que o arquivo sumiu).
        options.onError?.(path, tooLargeError(path, maxFileLength));
        continue;
      }
      if (!includeBinary && isBinaryText(text)) continue; // binário: pulado (salvo `includeBinary`)
      // O texto só é **dobrado** quando há acento em jogo: um texto ASCII não muda com o
      // dobramento (o padrão já foi dobrado) ⇒ a cópia do arquivo inteiro é evitada (o
      // `foldAccents` devolve a mesma string quando nada muda — mas o teste é O(n) e o
      // dobramento é caro quando há caractere não-ASCII).
      const mustFold = fold && (patternHasAccent || hasNonAscii(text));
      let scan: SearchResult;
      try {
        let normalized: NormalizedSearchQuery;
        if (regexMode) {
          // Regex do usuário: o padrão vai cru e o texto **não** é dobrado.
          normalized = normalizeSearchQuery({
            pattern: rawPattern,
            regex: true,
            caseSensitive,
            maxMatches: budget,
          });
        } else if (tolerantUsable && tolerantSource !== undefined && containsCombiningMark(text)) {
          // Texto em NFD: a marca virou sentinela no texto dobrado ⇒ o padrão casa com a
          // sentinela **opcional** depois de cada caractere.
          normalized = normalizeSearchQuery({
            pattern: tolerantSource,
            regex: true,
            caseSensitive,
            maxMatches: budget,
          });
        } else {
          normalized = normalizeSearchQuery({
            pattern,
            regex: false,
            caseSensitive,
            maxMatches: budget,
          });
        }
        scan = scanText(mustFold ? foldAccents(text) : text, normalized);
      } catch (error) {
        // Só o texto acima do teto do `scanText` chega aqui (o padrão já foi validado):
        // um arquivo gigante é pulado — a busca dos outros arquivos continua.
        options.onError?.(path, toError(error));
        continue;
      }
      filesScanned += 1;
      for (const hit of scan.matches) {
        if (budget <= 0) {
          truncated = true;
          stop = true;
          break;
        }
        matches.push({
          path,
          line: hit.line,
          column: hit.column,
          text: lineTextAt(text, hit.index),
        });
        budget -= 1;
      }
      if (scan.truncated) {
        truncated = true;
        stop = true;
        return;
      }
    }
  };

  const workerCount = Math.min(concurrency, candidates.length);
  const settled = await Promise.allSettled(
    Array.from({ length: workerCount }, (): Promise<void> => worker()),
  );
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      throw outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
    }
  }

  matches.sort(compareMatches);
  return { matches, truncated, filesScanned, warnings };
}
