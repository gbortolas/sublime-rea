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
 *   são "dobrados" (NFC→NFD, tira a marca combinante) com uma transformação **1:1 em code
 *   units** ⇒ os offsets (e portanto linha/coluna) continuam válidos no texto original;
 * - **pula** o que não é texto: arquivo grande (> `maxFileBytes`), binário (contém `\0`) e
 *   diretório/ilegível (o `readFile` falha ⇒ o arquivo é pulado e a busca continua);
 * - **tetos**: `maxMatches` (ocorrências) e `maxFiles` (arquivos) ⇒ `truncated: true`;
 * - **paralelo**: a leitura tem concorrência limitada (`concurrency`, default 8) e o
 *   `AbortSignal` cancela a operação no meio da leitura.
 *
 * O módulo é **puro** (a I/O entra por `readFile`): o `main` injeta o `FileSystem` e o
 * renderer nunca chama isto direto (a travessia é o IPC).
 */
import { CancellationError, toError } from "../../shared";
import {
  normalizeSearchQuery,
  scanText,
  SEARCH_MAX_MATCHES,
} from "../../shared/search-contract";
import type { SearchResult } from "../../shared/search-contract";

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
}

/** Opções da busca na workspace. */
export interface GrepOptions {
  /**
   * O padrão **cru** (o que o usuário digitou). A normalização é feita aqui, com o mesmo
   * `normalizeSearchQuery` do find bar: **literal** (o padrão é escapado), **sem case**
   * (a flag `i`), com teto de ocorrências.
   */
  readonly query: string;
  /** Caminhos candidatos (a lista de arquivos da workspace). */
  readonly files: readonly string[];
  /** Lê o conteúdo de um arquivo (injetado: o `main` passa o `FileSystem`). */
  readonly readFile: (path: string) => Promise<string>;
  /** Cancela a busca (cooperativo): aborta no meio da leitura. */
  readonly signal?: AbortSignal;
  /** Teto de ocorrências (default {@link GREP_DEFAULT_MAX_MATCHES}). */
  readonly maxMatches?: number;
  /** Teto de tamanho por arquivo, em code units (default {@link GREP_DEFAULT_MAX_FILE_BYTES}). */
  readonly maxFileBytes?: number;
  /** Teto de arquivos varridos (default {@link GREP_DEFAULT_MAX_FILES}). */
  readonly maxFiles?: number;
  /** Leituras em paralelo (default {@link GREP_DEFAULT_CONCURRENCY}). */
  readonly concurrency?: number;
  /**
   * Busca **acento-insensitiva** (default `true`): "acao" casa com "ação".
   * Desligar ⇒ o padrão casa **exatamente** (byte a byte, fora o case).
   */
  readonly ignoreAccents?: boolean;
  /** Notificado quando um arquivo **não pôde ser lido** (o arquivo é pulado, a busca segue). */
  readonly onError?: (path: string, error: Error) => void;
}

/** Teto de ocorrências (default). */
export const GREP_DEFAULT_MAX_MATCHES = 500;
/** Teto de tamanho por arquivo (default) — 512 KiB. */
export const GREP_DEFAULT_MAX_FILE_BYTES = 512 * 1024;
/** Teto de arquivos varridos (default). */
export const GREP_DEFAULT_MAX_FILES = 2000;
/** Leituras em paralelo (default). */
export const GREP_DEFAULT_CONCURRENCY = 8;

/** Faixa das marcas combinantes Unicode (o que o "dobramento" de acento remove). */
const COMBINING_MARK_FIRST = 0x0300;
const COMBINING_MARK_LAST = 0x036f;

/**
 * Dobra o acento de um caractere **1:1** (uma code unit ⇒ uma code unit).
 *
 * Só funciona para o que decompõe em `base ASCII + marca combinante` (ex.: "á" ⇒ "a",
 * "ç" ⇒ "c", "ñ" ⇒ "n"). O que não decompõe ("ø", "ß", "Ł") fica como está. O tamanho do
 * texto **não muda** ⇒ os offsets do texto dobrado são os do texto original.
 */
function foldChar(ch: string): string {
  if (ch.length !== 1) return ch; // par substituto (fora do BMP): preserva
  const code = ch.charCodeAt(0);
  if (code < 0x80) return ch; // ASCII: já é a base
  const decomposed = ch.normalize("NFD");
  if (decomposed.length !== 2) return ch; // não decompõe em base+marca
  const base = decomposed[0]!;
  const mark = decomposed[1]!;
  const markCode = mark.charCodeAt(0);
  if (markCode < COMBINING_MARK_FIRST || markCode > COMBINING_MARK_LAST) return ch;
  if (base.charCodeAt(0) > 0x7f) return ch; // base não-ASCII: preserva
  return base;
}

/**
 * Dobra os acentos de um texto **preservando o tamanho** (1 code unit ⇒ 1 code unit).
 *
 * É o que permite buscar "acao" e achar "ação" **sem** reescrever o scanner: o `scanText`
 * roda sobre o texto dobrado e os offsets (linha/coluna) continuam valendo no original.
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
    const folded = foldChar(ch);
    if (folded === ch) continue;
    out += text.slice(start, i) + folded;
    start = i + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

/** `true` quando o texto tem um byte NUL ⇒ é binário (não é texto). */
function isBinaryText(text: string): boolean {
  return text.indexOf("\u0000") >= 0;
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
  readFile: (path: string) => Promise<string>,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  if (signal === undefined) {
    try {
      return { ok: true, text: await readFile(path) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  }
  const settled: Promise<ReadOutcome> = readFile(path).then(
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
 */
export async function grepWorkspace(options: GrepOptions): Promise<GrepResult> {
  const maxMatches = Math.min(
    positiveOr(options.maxMatches, GREP_DEFAULT_MAX_MATCHES),
    SEARCH_MAX_MATCHES,
  );
  const maxFileBytes = positiveOr(options.maxFileBytes, GREP_DEFAULT_MAX_FILE_BYTES);
  const maxFiles = positiveOr(options.maxFiles, GREP_DEFAULT_MAX_FILES);
  const concurrency = positiveOr(options.concurrency, GREP_DEFAULT_CONCURRENCY);
  const ignoreAccents = options.ignoreAccents ?? true;

  const signal = options.signal;
  if (signal?.aborted) throw new CancellationError(describeReason(signal.reason));

  const candidates = options.files.slice(0, maxFiles);
  let truncated = options.files.length > candidates.length;

  // Valida o padrão com o **mesmo** contrato do find bar (vazio/excedente ⇒ erro tipado).
  const pattern = ignoreAccents ? foldAccents(options.query) : options.query;
  normalizeSearchQuery({ pattern });

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
      const outcome = await readFileCancellable(path, options.readFile, signal);
      if (!outcome.ok) {
        // Diretório, sem permissão, arquivo que sumiu: pula o arquivo e **continua**.
        options.onError?.(path, outcome.error);
        continue;
      }
      if (stop) return;
      const text = outcome.text;
      if (text.length > maxFileBytes) continue; // arquivo grande: pulado
      if (isBinaryText(text)) continue; // binário: pulado
      let scan: SearchResult;
      try {
        scan = scanText(
          ignoreAccents ? foldAccents(text) : text,
          normalizeSearchQuery({ pattern, maxMatches: budget }),
        );
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
  return { matches, truncated, filesScanned };
}
