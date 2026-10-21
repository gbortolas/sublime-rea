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
 *    - o candidato é um **caminho** e a casa é feita **por segmento de caminho** (`/`, `\`):
 *      os caracteres de um trecho da query precisam caber **no mesmo segmento** (a casa
 *      **não atravessa** segmentos) e os segmentos do caminho são consumidos **em ordem**;
 *    - os caracteres da query aparecem **em ordem** dentro do segmento (subsequência);
 *    - **espaço na query = `\b`**: a query é splitada em **trechos** e cada trecho
 *      (a partir do 2º) precisa **começar no início de uma palavra** do candidato — é o que
 *      faz "fo bar" casar "foo/bar.ts" e **não** casar "foobar.ts";
 *    - **barra na query = segmento de caminho**: a query é splitada **também** por `/` e
 *      `\`, e cada trecho assim introduzido casa com **um** segmento do caminho (em ordem,
 *      com **pulo** de segmento — como o VS Code). É o que faz "src/main.ts" casar
 *      "src/main.ts" (e "src main" casar também).
 *    - a **pontuação** privilegia: **consecutividade** (bônus alto), **início de palavra**
 *      (bônus) e o **basename** (bônus **leve** — é o desempate, não o protagonista).
 *
 * ⚠️ **Mudança de UX (P2.x)**: o candidato do matching é o **caminho completo** (relativo à
 * raiz, com o prefixo do nome da raiz no modo multi-root) — não só o *basename*. A casa é
 * feita em **qualquer parte do caminho** ("renderer" acha "src/renderer/main.ts"), e dois
 * arquivos de mesmo *basename* em pastas diferentes deixam de empatar quando a query fala
 * da pasta. O *basename* continua sendo um **desempate leve** (bônus pequeno), nunca o
 * fator dominante.
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
/** Bônus por caractere no **início de uma palavra** (ou de um segmento do caminho). */
const SCORE_WORD_START = 30;
/**
 * Bônus **leve** por caractere dentro do **basename** (depois da última `/`).
 *
 * ⚠️ É o **desempate**, não o protagonista: o candidato do matching é o caminho inteiro
 * (é o `label` — o basename — que é exibido na lista). Por isso o valor é pequeno: 12/char
 * + 48 (o "old") fazia o basename ganhar **de qualquer** casa no caminho.
 */
const SCORE_BASENAME = 4;
/** Bônus **leve** quando a query inteira casou **dentro do basename**. */
const SCORE_BASENAME_ONLY = 12;
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
 * Os limites (início/fim) do **segmento de caminho** em que `index` cai.
 *
 * O caminho é quebrado em `/` e `\` (o *basename* é o último segmento). O `end` é
 * **exclusivo** — é o limite em que a casa de um trecho da query para de poder crescer.
 */
function segmentBounds(
  candidate: string,
  index: number,
): { readonly start: number; readonly end: number } {
  let start = index;
  while (start > 0) {
    const previous = candidate.charAt(start - 1);
    if (previous === "/" || previous === "\\") break;
    start -= 1;
  }
  let end = index;
  while (end < candidate.length) {
    const current = candidate.charAt(end);
    if (current === "/" || current === "\\") break;
    end += 1;
  }
  return { start, end };
}

/**
 * Casa um **trecho** da query dentro de **um** segmento do caminho.
 *
 * A casa **não atravessa** segmentos: todos os caracteres do trecho precisam caber no mesmo
 * segmento do caminho (é o que impede "src" de casar o "s" de um diretório e o "rc" de
 * outro) e o trecho precisa caber **depois** da posição `from` (a ordem dos segmentos do
 * caminho é preservada).
 *
 * O trecho pode estar num segmento **seguinte** ao do trecho anterior (o **pulo** de
 * segmento, como o VS Code: "src main" acha "src/renderer/main.ts") — mas nunca no
 * anterior (a ordem do caminho é respeitada).
 *
 * Devolve os índices casados (no candidato) ou `undefined` (não coube).
 */
function matchQuerySegment(
  candidate: string,
  lower: string,
  segment: string,
  from: number,
  requireWordStart: boolean,
): readonly number[] | undefined {
  const head = segment.charAt(0);
  let start = lower.indexOf(head, from);
  while (start >= 0) {
    if (!requireWordStart || isWordStart(candidate, start)) {
      const bounds = segmentBounds(candidate, start);
      const indices: number[] = [start];
      let position = start + 1;
      let matched = true;
      for (let k = 1; k < segment.length; k += 1) {
        const found = lower.indexOf(segment.charAt(k), position);
        if (found < 0 || found >= bounds.end) {
          matched = false;
          break;
        }
        indices.push(found);
        position = found + 1;
      }
      if (matched) return indices;
    }
    start = lower.indexOf(head, start + 1);
  }
  return undefined;
}

/**
 * Um **trecho** da query (a casa de um trecho é feita dentro de **um** segmento do
 * caminho do candidato).
 */
interface QueryChunk {
  /** O trecho (em minúsculas). */
  readonly text: string;
  /**
   * `true` ⇒ o trecho precisa **começar no início de uma palavra** do candidato.
   *
   * É a regra do `\b` do **espaço** (o 2º trecho em diante precisa de limite de palavra).
   * Um trecho introduzido por **barra** (`/` ou `\`) é um **segmento de caminho**: ele casa
   * *dentro* do segmento (sem exigir limite de palavra) — é a semântica de caminho do
   * VS Code ("src/main" = "a pasta src e, dentro dela, algo que case com main").
   */
  readonly needsWordStart: boolean;
}

/**
 * Quebra a query em **trechos**: por **espaço** e por **separador de caminho** (`/`/`\`).
 *
 * - o **espaço** separa trechos que exigem **limite de palavra** (`\b`) — a regra já
 *   existente ("fo bar" casa "foo/bar.ts"; "foobar.ts" não);
 * - a **barra** separa **segmentos de caminho** — "src/main.ts" casa "src/main.ts" (a query
 *   fala o *caminho*, não uma sequência de letras soltas);
 * - o 1º trecho da query **nunca** exige limite de palavra (a query pode começar no meio do
 *   segmento — "maint" acha "main.ts").
 *
 * ⚠️ O separador que **introduz** o trecho é o que decide a regra: um separador com barra
 * (mesmo misturado com espaço) vale como **segmento de caminho**.
 */
function splitQuery(query: string): readonly QueryChunk[] {
  const chunks: QueryChunk[] = [];
  /** Como o trecho atual foi introduzido (`undefined` = é o 1º da query). */
  let separator: "space" | "path" | undefined;

  // As partes alternam: [texto, separador, texto, …] (o separador é um grupo capturado).
  for (const part of query.split(/([\s/\\]+)/)) {
    if (part.length === 0) continue;
    if (/^[\s/\\]+$/.test(part)) {
      separator = /[\\/]/.test(part) ? "path" : "space";
      continue;
    }
    chunks.push({
      text: part.toLowerCase(),
      needsWordStart: separator === "space" && chunks.length > 0,
    });
    separator = undefined;
  }
  return chunks;
}

/**
 * Casa a query no candidato e devolve a pontuação + as posições casadas.
 *
 * `undefined` quando a query **não casa** (nada a selecionar).
 *
 * A query vazia (ou só com espaços) casa com **tudo**, com pontuação `0` e sem índices.
 *
 * O candidato é tratado como um **caminho**: a casa é feita **por segmento** (a casa não
 * atravessa `/` nem `\`) e os segmentos são consumidos **em ordem** — é o que permite casar
 * em qualquer parte do caminho ("renderer" acha "src/renderer/main.ts") sem virar um
 * "fuzzy" cego que mistura as pastas.
 *
 * ⚠️ A query é splitada por **espaço** e por **barra** (ver {@link splitQuery}): um trecho
 * separado por barra casa **um** segmento do caminho (com pulo de segmento, como o VS Code)
 * — é o que faz "src/main.ts" achar "src/main.ts".
 */
export function fuzzyScore(query: string, candidate: string): FuzzyMatch | undefined {
  const chunks = splitQuery(query.trim());
  if (chunks.length === 0) return { score: 0, indices: [] };

  const lower = candidate.toLowerCase();
  // O "basename" é o que vem depois da última barra (`/` ou `\` — Windows).
  const basenameStart = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\")) + 1;

  const indices: number[] = [];
  let score = 0;
  let cursor = 0; // próxima posição livre no candidato (a ordem dos segmentos é preservada)

  for (const chunk of chunks) {
    const matched = matchQuerySegment(candidate, lower, chunk.text, cursor, chunk.needsWordStart);
    if (matched === undefined) return undefined;
    for (const index of matched) indices.push(index);
    cursor = matched[matched.length - 1]! + 1;
    if (chunk.needsWordStart) score += SCORE_SEGMENT_BOUNDARY;
  }

  let previous = -1; // índice da última casa
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
 *
 * O texto usado na casa é o que o chamador **passa** em `toText` — para os arquivos da
 * workspace é o **caminho completo** (relativo à raiz), não o basename.
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
    //
    // ⚠️ **Multi-root (o `main` precisa mexer)**: o prefixo só existe quando `roots` tem
    // **mais de uma** entrada — e hoje o `main` (`resolveWorkspaceRoots`) **achata** as
    // raízes em uma só (ele expande cada candidata até a pasta com `.git` e deduplica).
    // Para o modo multi-root, o `main` precisa: (a) **não** expandir/deduplicar as raízes
    // quando há mais de uma candidata, e (b) mandar as raízes **expandidas** (as que o
    // `indexFiles` usa) de volta ao renderer (o `WorkspaceFilesResult` não traz `roots`),
    // para que o "criar arquivo" aponte para a raiz certa.
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
