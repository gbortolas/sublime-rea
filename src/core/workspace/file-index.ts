/**
 * Scribe — **índice de arquivos da workspace** + **fuzzy matching** (núcleo puro, sem DOM).
 *
 * Duas peças, no mesmo módulo porque são a mesma feature (o *Quick Open*):
 *
 * 1. **`indexFiles()`** — percorre as raízes da workspace com um **port** mínimo de I/O
 *    (`DirectoryReader.readDir`) e devolve a lista de arquivos (caminhos **relativos**,
 *    ordenados). O port é injetado: produção usa `node:fs/promises` (no `main`), teste usa
 *    um fake em memória — o módulo **não** importa `node:fs` (o mesmo bundle roda no renderer).
 *
 *    Ruído é filtrado: diretórios ruidosos (`node_modules`, `.git`, `dist`, …) são pulados,
 *    o `.gitignore` da raiz é respeitado (padrões simples) e há **tetos** (20.000 arquivos /
 *    5 níveis) — o que exceder é ignorado **com warn** (nunca em silêncio).
 *
 * 2. **`fuzzyScore()` / `fuzzyFilter()`** — o *matching* propriamente dito, em funções
 *    **puras** (sem DOM, sem I/O) para o teste unitário. Regras:
 *
 *    - **case-insensitive**;
 *    - os caracteres da query aparecem **em ordem** no candidato (subsequência);
 *    - **espaço na query = `\b`**: a query é splitada em **segmentos** e cada segmento
 *      (a partir do 2º) precisa **começar no início de uma palavra** do candidato — é o que
 *      faz "fo bar" casar "foo/bar.ts" e **não** casar "foobar.ts";
 *    - a **pontuação** privilegia: **consecutividade** (bônus alto), **início de palavra**
 *      (bônus) e **caminho** (bônus quando a casa cai no *basename* do arquivo).
 *
 * Rótulo de origem: **escolha nossa** (o alvo não expõe nada equivalente) — a heurística
 * segue o *Goto File* do Sublime (a 1ª casa tende a ser no início de uma palavra) e o
 * *Command Center* do VS Code (a mesma lista serve a arquivos, comandos e recentes).
 */
import { globMatches } from "../packages/glob";

// ---------------------------------------------------------------------------------------------
// Fuzzy matching (puro)
// ---------------------------------------------------------------------------------------------

/** Resultado de um *fuzzy match*: a pontuação e as posições casadas no candidato. */
export interface FuzzyMatch {
  /** Pontuação (maior = melhor). */
  readonly score: number;
  /** Índices (no candidato) dos caracteres casados, em ordem crescente. */
  readonly indices: readonly number[];
}

/** Um item que casou com a query. */
export interface FuzzyFilterHit<T> {
  readonly item: T;
  readonly match: FuzzyMatch;
}

/** Separadores que marcam o **início de uma palavra** no candidato. */
const WORD_SEPARATORS = new Set([
  "/", "\\", ".", "_", "-", " ", ":", ";", ",", "(", ")", "[", "]", "{", "}",
  "+", "=", "@", "#", "$", "%", "&", "*", "!", "?", "<", ">", "|", "~", "^",
]);

/** Pontuação base por caractere casado. */
const SCORE_MATCH = 16;
/** Bônus por caractere **consecutivo** (imediatamente após o anterior). */
const SCORE_CONSECUTIVE = 32;
/** Bônus por caractere no **início de uma palavra**. */
const SCORE_WORD_START = 30;
/** Bônus por caractere dentro do **basename** (depois da última `/`). */
const SCORE_BASENAME = 12;
/** Bônus quando a query inteira casou **dentro do basename**. */
const SCORE_BASENAME_ONLY = 48;
/** Bônus por segmento que começa no **início de uma palavra** (a query tinha espaço). */
const SCORE_SEGMENT_BOUNDARY = 24;
/** Penalidade por caractere pulado entre duas casas. */
const PENALTY_GAP = 3;
/** Penalidade por caractere antes da primeira casa (limitada). */
const PENALTY_LEADING = 1;
/** Penalidade por caractere do candidato (limitada) — prefere caminhos curtos. */
const PENALTY_LENGTH = 1;

/** `true` quando o caractere em `index` começa uma **palavra** no candidato. */
function isWordStart(candidate: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = candidate.charAt(index - 1);
  const cur = candidate.charAt(index);
  if (prev.length === 0 || cur.length === 0) return false;
  if (WORD_SEPARATORS.has(prev)) return true;
  // Fronteira *camelCase*: "fooBar" — o "B" começa uma palavra.
  const prevIsLower = prev === prev.toLowerCase() && prev !== prev.toUpperCase();
  const curIsUpper = cur === cur.toUpperCase() && cur !== cur.toLowerCase();
  return prevIsLower && curIsUpper;
}

/**
 * Casa a query no candidato e devolve a pontuação + as posições casadas.
 *
 * `undefined` quando a query **não casa** (nada a selecionar).
 *
 * A query vazia (ou só com espaços) casa com **tudo**, com pontuação `0` e sem índices.
 */
export function fuzzyScore(query: string, candidate: string): FuzzyMatch | undefined {
  const segments = query
    .trim()
    .split(/\s+/)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return { score: 0, indices: [] };

  const lower = candidate.toLowerCase();
  // O "basename" é o que vem depois da última barra (`/` ou `\` — Windows).
  const basenameStart = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\")) + 1;

  const indices: number[] = [];
  let score = 0;
  let cursor = 0; // próxima posição livre no candidato
  let previous = -1; // índice da última casa

  for (let s = 0; s < segments.length; s += 1) {
    const segment = segments[s]!.toLowerCase();
    // A partir do 2º segmento, a query tinha **espaço** ⇒ a casa precisa ser no início
    // de uma palavra (a regra do `\b`).
    const needsBoundary = s > 0;

    let start = -1;
    if (needsBoundary) {
      // Procura a 1ª ocorrência que **comece uma palavra**.
      let p = lower.indexOf(segment.charAt(0), cursor);
      while (p >= 0) {
        if (isWordStart(candidate, p)) {
          start = p;
          break;
        }
        p = lower.indexOf(segment.charAt(0), p + 1);
      }
    } else {
      start = lower.indexOf(segment.charAt(0), cursor);
    }
    if (start < 0) return undefined;

    // Casa o resto do segmento (fuzzy): o 1º caractere já está em `start`.
    let position = start;
    for (let k = 0; k < segment.length; k += 1) {
      const found = lower.indexOf(segment.charAt(k), position);
      if (found < 0) return undefined;
      indices.push(found);
      position = found + 1;
    }
    cursor = position;
    if (needsBoundary) score += SCORE_SEGMENT_BOUNDARY;
  }

  for (const index of indices) {
    score += SCORE_MATCH;
    if (previous >= 0 && index === previous + 1) score += SCORE_CONSECUTIVE;
    if (isWordStart(candidate, index)) score += SCORE_WORD_START;
    if (index >= basenameStart) score += SCORE_BASENAME;
    if (previous >= 0) {
      const gap = index - previous - 1;
      if (gap > 0) score -= PENALTY_GAP * gap;
    }
    previous = index;
  }

  const first = indices[0] ?? 0;
  score -= PENALTY_LEADING * Math.min(first, 20);
  if (first >= basenameStart) score += SCORE_BASENAME_ONLY;
  score -= PENALTY_LENGTH * Math.min(20, Math.floor(candidate.length / 4));

  return { score, indices };
}

/**
 * Filtra (e **ordena**) uma lista pela query.
 *
 * - query vazia ⇒ **todos** os itens, na **ordem original** (é o que faz os "recentes"
 *   aparecerem primeiro);
 * - query não vazia ⇒ só os itens que casam, ordenados por **score decrescente**
 *   (empate mantém a ordem original).
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  toText: (item: T) => string,
): readonly FuzzyFilterHit<T>[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return items.map((item) => ({ item, match: { score: 0, indices: [] } }));
  }

  const hits: { hit: FuzzyFilterHit<T>; order: number }[] = [];
  items.forEach((item, order) => {
    const match = fuzzyScore(trimmed, toText(item));
    if (match !== undefined) hits.push({ hit: { item, match }, order });
  });
  return hits
    .sort((a, b) => b.hit.match.score - a.hit.match.score || a.order - b.order)
    .map((wrapped) => wrapped.hit);
}

// ---------------------------------------------------------------------------------------------
// Índice de arquivos da workspace
// ---------------------------------------------------------------------------------------------

/** Entrada de diretório devolvida pelo port de I/O. */
export interface DirEntry {
  /** Nome do arquivo/diretório (**sem** o caminho). */
  readonly name: string;
  /** `true` para diretórios. */
  readonly isDirectory: boolean;
  /** `true` para arquivos regulares (opcional no port). */
  readonly isFile?: boolean;
}

/**
 * Port mínimo de I/O exigido pelo índice.
 *
 * Produção: `node:fs/promises` (implementado no `main`). Teste: fake em memória.
 * `readFile` é **opcional** — sem ele o índice apenas não respeita o `.gitignore`.
 */
export interface DirectoryReader {
  readDir(path: string): Promise<readonly DirEntry[]>;
  /** Leitura de um arquivo de texto (usada só para o `.gitignore` da raiz). */
  readFile?(path: string): Promise<string>;
}

/** Um arquivo indexado. */
export interface FileIndexEntry {
  /** Caminho **relativo** à raiz (separador `/`) — é o que a UI mostra e casa na query. */
  readonly path: string;
  /** Caminho absoluto (o que o `main` usa para abrir o arquivo). */
  readonly absolutePath: string;
  /** A raiz da workspace a que o arquivo pertence. */
  readonly root: string;
}

/** Resultado do `indexFiles()`. */
export interface FileIndexResult {
  /** Caminhos relativos, **ordenados** (é a lista que o *Quick Open* consome). */
  readonly files: readonly string[];
  /** Os mesmos arquivos, com o caminho absoluto (para abrir). */
  readonly entries: readonly FileIndexEntry[];
  /** As raízes percorridas. */
  readonly roots: readonly string[];
  /** `true` quando algum teto foi atingido (arquivos ou profundidade). */
  readonly truncated: boolean;
  /** Avisos gerados durante a varredura (tetos, diretórios ilegíveis). */
  readonly warnings: readonly string[];
}

/** Opções do `indexFiles()`. */
export interface FileIndexOptions {
  /** Teto de arquivos (default {@link DEFAULT_MAX_FILES}). */
  readonly maxFiles?: number;
  /** Teto de níveis de diretório abaixo da raiz (default {@link DEFAULT_MAX_DEPTH}). */
  readonly maxDepth?: number;
  /** Diretórios ruidosos pulados (default {@link DEFAULT_IGNORED_DIRECTORIES}). */
  readonly ignoredDirectories?: readonly string[];
  /** Respeitar o `.gitignore` da raiz (default `true`). */
  readonly respectGitignore?: boolean;
  /** Canal de aviso (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

/** Diretórios ruidosos pulados por padrão. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "release",
  "target",
  "out",
  "build",
  ".cache",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "coverage",
];

/** Teto de arquivos do índice. */
export const DEFAULT_MAX_FILES = 20_000;

/** Teto de níveis de diretório abaixo da raiz. */
export const DEFAULT_MAX_DEPTH = 5;

/** Padrão de `.gitignore` (simplificado). */
interface GitignorePattern {
  /** O padrão (glob), sem a `/` final. */
  readonly pattern: string;
  /** `true` para padrões que só casam diretórios ("build/"). */
  readonly directoryOnly: boolean;
  /** `true` quando o padrão tem `/` (ancorado na raiz). */
  readonly anchored: boolean;
}

/** Separador de caminho do host (o renderer recebe caminhos do `main`). */
function separatorOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Junta um diretório e um nome preservando o separador do host. */
function joinPath(dir: string, name: string): string {
  if (dir.length === 0) return name;
  const separator = separatorOf(dir);
  return dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`;
}

/** Último segmento de um caminho (o "nome" da raiz). */
function baseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return cut < 0 ? normalized : normalized.slice(cut + 1);
}

/** Mensagem legível de um erro desconhecido. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `true` quando o erro é "arquivo não existe" (caso normal: não há `.gitignore`). */
function isMissingFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Lê o `.gitignore` da raiz e devolve os padrões (simplificado).
 *
 * Suporta: comentários (`#`), padrões de diretório (`build/`), padrões ancorados
 * (`/src/gen` ou `docs/*.md`) e padrões "em qualquer nível" (`*.log`).
 * **Negações** (`!padrão`) e escapamentos **não** são suportados (documentado).
 */
function parseGitignore(content: string): GitignorePattern[] {
  const patterns: GitignorePattern[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("!")) continue; // negação: não suportada
    let pattern = line;
    let directoryOnly = false;
    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern.length === 0) continue;
    patterns.push({ pattern, directoryOnly, anchored: pattern.includes("/") });
  }
  return patterns;
}

/** `true` quando o caminho relativo casa com algum padrão do `.gitignore`. */
function isIgnoredByPatterns(
  patterns: readonly GitignorePattern[],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  for (const pattern of patterns) {
    if (pattern.directoryOnly && !isDirectory) continue;
    if (pattern.anchored) {
      if (globMatches(pattern.pattern, relativePath)) return true;
      continue;
    }
    // Padrão sem `/`: casa em qualquer nível ⇒ basta um segmento do caminho casar.
    for (const segment of relativePath.split("/")) {
      if (globMatches(pattern.pattern, segment)) return true;
    }
  }
  return false;
}

/**
 * Monta o índice de arquivos da workspace.
 *
 * -Percorre* as raízes em profundidade, pulando os diretórios ruidosos, respeitando o
 * `.gitignore` da raiz e respeitando os tetos ({@link DEFAULT_MAX_FILES} arquivos /
 * {@link DEFAULT_MAX_DEPTH} níveis) — o que exceder é ignorado **com warn**.
 */
export async function indexFiles(
  roots: readonly string[],
  reader: DirectoryReader,
  options: FileIndexOptions = {},
): Promise<FileIndexResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
  const respectGitignore = options.respectGitignore ?? true;
  const warn = options.warn ?? ((message: string): void => { console.warn(message); });

  const entries: FileIndexEntry[] = [];
  const warnings: string[] = [];
  let stop = false;
  let fileCapReached = false;
  let depthLimited = false;

  const walk = async (
    root: string,
    dir: string,
    relativeDir: string,
    depth: number,
    patterns: readonly GitignorePattern[],
    prefix: string,
  ): Promise<void> => {
    if (stop) return;
    let children: readonly DirEntry[];
    try {
      children = await reader.readDir(dir);
    } catch (error) {
      const message = `Scribe: não foi possível listar "${dir}": ${describeError(error)}`;
      warnings.push(message);
      warn(message);
      return;
    }

    for (const child of children) {
      if (stop) return;
      const name = child.name;
      if (name.length === 0) continue;
      const relative = relativeDir.length === 0 ? name : `${relativeDir}/${name}`;

      if (child.isDirectory) {
        if (ignored.has(name)) continue;
        if (isIgnoredByPatterns(patterns, relative, true)) continue;
        if (depth + 1 > maxDepth) {
          depthLimited = true;
          const message = `Scribe: profundidade máxima (${maxDepth}) atingida em "${relative}" — a árvore foi truncada`;
          warnings.push(message);
          warn(message);
          continue;
        }
        await walk(root, joinPath(dir, name), relative, depth + 1, patterns, prefix);
        continue;
      }

      // O próprio `.gitignore` não é conteúdo de workspace.
      if (name === ".gitignore") continue;
      if (isIgnoredByPatterns(patterns, relative, false)) continue;

      if (entries.length >= maxFiles) {
        stop = true;
        fileCapReached = true;
        const message = `Scribe: limite de ${maxFiles} arquivos atingido — o índice foi truncado`;
        warnings.push(message);
        warn(message);
        return;
      }
      entries.push({
        path: `${prefix}${relative}`,
        absolutePath: joinPath(dir, name),
        root,
      });
    }
  };

  for (const root of roots) {
    if (stop) break;
    let patterns: readonly GitignorePattern[] = [];
    if (respectGitignore && reader.readFile !== undefined) {
      try {
        patterns = parseGitignore(await reader.readFile(joinPath(root, ".gitignore")));
      } catch (error) {
        // A ausência de `.gitignore` é o caso normal (o erro ENOENT não é aviso).
        if (!isMissingFile(error)) {
          const message = `Scribe: não foi possível ler o .gitignore de "${root}": ${describeError(error)}`;
          warnings.push(message);
          warn(message);
        }
      }
    }
    // Com mais de uma raiz, o caminho relativo ganha o **nome da raiz** como prefixo
    // (senão "src/main.ts" de duas raízes seria ambíguo).
    const prefix = roots.length > 1 ? `${baseName(root)}/` : "";
    await walk(root, root, "", 0, patterns, prefix);
  }

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: sorted.map((entry) => entry.path),
    entries: sorted,
    roots: [...roots],
    truncated: fileCapReached || depthLimited,
    warnings,
  };
}

/**
 * Acha o **melhor** arquivo do índice para a query (o *fuzzy* decide).
 *
 * Devolve `undefined` quando nada casa.
 */
export function findFile(index: FileIndexResult, query: string): FileIndexEntry | undefined {
  const hits = fuzzyFilter(query, index.entries, (entry) => entry.path);
  return hits[0]?.item;
}
