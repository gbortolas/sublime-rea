/**
 * Scribe — **parser do diff unificado** do `git` (o texto que sai de `git diff`).
 *
 * O `main` já executa o `git diff` (é o que alimenta as faixas do gutter) — mas o parsing
 * do `@@` vivia **inline** no `main` e só aceitava `--unified=0` (sem contexto). Aqui o
 * parsing vira um módulo **puro**: entra o texto do diff, sai a estrutura
 * (arquivos → hunks → linhas).
 *
 * **O módulo não executa nada** (`node:child_process` não entra aqui): o `main` continua
 * sendo o único que fala com o `git` (e o único que sanitiza o ambiente — o `diff.external`
 * do `.git/config` do repo do usuário é RCE se o ambiente não for isolado).
 *
 * **Formato tratado** (unified, sem cor):
 *
 * ```text
 * diff --git a/src/foo.ts b/src/foo.ts
 * index 1234567..89abcde 100644
 * --- a/src/foo.ts
 * +++ b/src/foo.ts
 * @@ -1,4 +1,5 @@ função()
 *  contexto
 * -removida
 * +adicionada
 * \ No newline at end of file
 * ```
 *
 * Decisões (todas nossas — o alvo não expõe diff unificado):
 * - **o corpo do hunk termina pelas contagens** (`@@ -a,b +c,d @@`), não por heurística de
 *   prefixo: é assim que o próprio `git` fecha o hunk, e é o que protege uma linha removida
 *   cujo conteúdo começa com `--` (viraria `--- …`, igual ao cabeçalho de arquivo);
 * - **`\ No newline at end of file`** é uma linha `meta` (não conta para as contagens);
 * - **path com espaço**: o path vem **depois** do prefixo `a/`/`b/` e vai até o fim da linha
 *   (o timestamp do formato `diff -u`, separado por TAB, é cortado);
 * - **`/dev/null`**: arquivo novo (só `+++`) ou removido (só `---`);
 * - **CRLF**: o `\r` é removido **só** das linhas de cabeçalho (`diff --git`, `index`, `---`,
 *   `+++`, `@@`) — no corpo do hunk o CR é parte da linha do arquivo e precisa ser preservado.
 */

/** Natureza de uma linha do diff. */
export type DiffLineKind = "add" | "del" | "ctx" | "meta";

/** Uma linha do diff (corpo do hunk ou metadado). */
export interface DiffLine {
  /** `add` (só no novo), `del` (só no antigo), `ctx` (nos dois) ou `meta` (cabeçalho). */
  readonly kind: DiffLineKind;
  /**
   * Conteúdo da linha **sem** o prefixo (`+`/`-`/espaço). Nos metadados, a linha crua
   * (ex.: `index 1234567..89abcde 100644`).
   */
  readonly text: string;
  /** Número da linha no arquivo **antigo** (1-based) — só em `del`/`ctx`. */
  readonly oldLine?: number;
  /** Número da linha no arquivo **novo** (1-based) — só em `add`/`ctx`. */
  readonly newLine?: number;
}

/** Um hunk (`@@ -a,b +c,d @@`) do diff. */
export interface DiffHunk {
  /** O cabeçalho cru (ex.: `@@ -1,4 +1,5 @@ função()`). */
  readonly header: string;
  /** O "section heading" do `git` (o contexto da função, quando o `git` o escreve). */
  readonly section: string;
  /** 1ª linha do hunk no arquivo antigo (1-based). */
  readonly oldStart: number;
  /** Nº de linhas do hunk no arquivo antigo. */
  readonly oldLines: number;
  /** 1ª linha do hunk no arquivo novo (1-based). */
  readonly newStart: number;
  /** Nº de linhas do hunk no arquivo novo. */
  readonly newLines: number;
  /** Caminho no lado antigo (sem o prefixo `a/`); `/dev/null` se o arquivo é novo. */
  readonly oldPath: string;
  /** Caminho no lado novo (sem o prefixo `b/`); `/dev/null` se o arquivo foi removido. */
  readonly newPath: string;
  /** As linhas do hunk (inclui os metadados internos, ex.: `\ No newline at end of file`). */
  readonly lines: readonly DiffLine[];
}

/** Um arquivo do diff (um bloco `diff --git`). */
export interface DiffFile {
  /** Caminho no lado antigo (sem o prefixo `a/`); `/dev/null` se o arquivo é novo. */
  readonly oldPath: string;
  /** Caminho no lado novo (sem o prefixo `b/`); `/dev/null` se o arquivo foi removido. */
  readonly newPath: string;
  /** Linhas de cabeçalho do arquivo (`diff --git`, `index`, `---`, `+++`, …). */
  readonly meta: readonly DiffLine[];
  /** Os hunks do arquivo (vazio em renome/mudança de modo sem alteração de conteúdo). */
  readonly hunks: readonly DiffHunk[];
}

/** Contagem de mudanças de um diff (o que o painel mostra no cabeçalho). */
export interface DiffSummary {
  /** Nº de hunks. */
  readonly hunks: number;
  /** Linhas adicionadas. */
  readonly added: number;
  /** Linhas removidas. */
  readonly removed: number;
}

/** Caminho que o `git` usa para "não há arquivo deste lado". */
export const DIFF_NULL_PATH = "/dev/null";

/** `true` quando o caminho é o "nulo" do `git` (arquivo novo ou removido). */
export function isNullPath(path: string): boolean {
  return path === DIFF_NULL_PATH;
}

/** Cabeçalho de hunk: `@@ -a,b +c,d @@` (as contagens podem faltar ⇒ 1). */
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Prefixo da linha `diff --git`. */
const DIFF_GIT_PREFIX = "diff --git ";

function addDiffLine(text: string, newLine: number): DiffLine {
  return { kind: "add", text, newLine };
}

function delDiffLine(text: string, oldLine: number): DiffLine {
  return { kind: "del", text, oldLine };
}

function ctxDiffLine(text: string, oldLine: number, newLine: number): DiffLine {
  return { kind: "ctx", text, oldLine, newLine };
}

function metaDiffLine(text: string): DiffLine {
  return { kind: "meta", text };
}

/**
 * Tira o prefixo `a/`/`b/` do caminho do `git`.
 *
 * Só um prefixo: o arquivo `a/foo.txt` (na raiz) sai do `git` como `a/a/foo.txt` ⇒
 * o resultado é `a/foo.txt` (o prefixo é do *diff*, não do nome).
 */
function stripPathPrefix(path: string): string {
  if (path === DIFF_NULL_PATH) return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/** Corta o timestamp do formato `diff -u` (`--- a/x\t2024-01-01 10:00:00 +0000`). */
function splitTimestamp(raw: string): string {
  const tab = raw.indexOf("\t");
  return tab >= 0 ? raw.slice(0, tab) : raw;
}

/**
 * Desfaz o *quoting* do `git` (`"a/foo\tbar.txt"` ⇒ `a/foo<TAB>bar.txt`).
 *
 * O `git` entre aspas o path quando ele tem caractere "estranho" (controle, `\`, `"`,
 * não-ASCII com `core.quotePath`); o espaço **não** é entre aspas ⇒ um path com espaço
 * chega cru.
 */
function unquoteGitPath(raw: string): string {
  let out = "";
  let index = 1; // pula a aspa de abertura
  while (index < raw.length) {
    const char = raw[index];
    if (char === undefined) break;
    if (char === "\\") {
      const next = raw[index + 1];
      index += 2;
      if (next === undefined) {
        out += "\\";
        break;
      }
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else out += next;
      continue;
    }
    if (char === '"') break;
    out += char;
    index += 1;
  }
  return out;
}

/** Índice da aspa de fechamento de um path entre aspas (ou `-1`). */
function findClosingQuote(raw: string): number {
  let index = 1;
  while (index < raw.length) {
    const char = raw[index];
    if (char === undefined) break;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index;
    index += 1;
  }
  return -1;
}

/**
 * Tira o `\r` do fim da linha (o CR do CRLF).
 *
 * ⚠️ Só nas linhas de **cabeçalho** (`diff --git`, `index`, `---`, `+++`, `@@`): no **corpo**
 * do hunk o CR é parte da linha do arquivo (num arquivo CRLF o conteúdo da linha termina em
 * `\r`) — perdê-lo muda o conteúdo que o painel mostra.
 */
function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Extrai o caminho de uma linha de cabeçalho (`--- a/x` / `+++ b/x`).
 *
 * - corta o timestamp (separado por TAB);
 * - des-quoting no estilo do `git`;
 * - tira o prefixo `a/`/`b/`.
 *
 * **Path com espaço:** o caminho é **tudo** depois do prefixo (`--- a/foo bar.txt` ⇒
 * `foo bar.txt`) — nunca separado por espaço.
 */
export function parseDiffHeaderPath(raw: string): string {
  const head = splitTimestamp(raw);
  const unquoted = head.startsWith('"') ? unquoteGitPath(head) : head;
  return stripPathPrefix(unquoted);
}

/** Tamanho do prefixo comum entre dois caminhos (heurística de rename). */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Separa os dois caminhos da linha `diff --git a/x b/y`.
 *
 * **Heurística (documentada):** o path pode conter espaços, então `a/x b/y` é ambíguo.
 * O `git` resolve isso com o quoting; aqui, quando os dois caminhos **não** estão entre
 * aspas, escolhe-se o corte ` b/` cujo par de caminhos tem o **maior prefixo comum**
 * (um rename costuma mudar só o fim do nome). Os caminhos definitivos vêm das linhas
 * `---`/`+++` (sem ambiguidade) — esta é só a rede de segurança (rename sem alteração,
 * mudança de modo, arquivo binário).
 */
function parseDiffGitPaths(line: string): { readonly oldPath: string; readonly newPath: string } {
  const rest = line.slice(DIFF_GIT_PREFIX.length);
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest);
    if (end > 0) {
      const oldRaw = rest.slice(0, end + 1);
      const tail = rest.slice(end + 1).trimStart();
      const tailEnd = tail.startsWith('"') ? findClosingQuote(tail) : -1;
      const newRaw = tailEnd > 0 ? tail.slice(0, tailEnd + 1) : tail;
      return {
        oldPath: stripPathPrefix(unquoteGitPath(oldRaw)),
        newPath: stripPathPrefix(unquoteGitPath(newRaw)),
      };
    }
  }
  let best = -1;
  let bestScore = -1;
  let index = rest.indexOf(" b/");
  while (index >= 0) {
    const oldPart = rest.slice(0, index);
    const newPart = rest.slice(index + 1);
    if (oldPart.startsWith("a/") && newPart.startsWith("b/")) {
      const score = commonPrefixLength(oldPart.slice(2), newPart.slice(2));
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    index = rest.indexOf(" b/", index + 1);
  }
  if (best < 0) {
    const only = stripPathPrefix(rest);
    return { oldPath: only, newPath: only };
  }
  return {
    oldPath: stripPathPrefix(rest.slice(0, best)),
    newPath: stripPathPrefix(rest.slice(best + 1)),
  };
}

/** Estado mutável do hunk enquanto o texto é lido. */
class HunkBuilder {
  readonly header: string;
  readonly section: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly oldPath: string;
  readonly newPath: string;
  readonly lines: DiffLine[] = [];

  private oldSeen = 0;
  private newSeen = 0;

  constructor(params: {
    readonly header: string;
    readonly section: string;
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly oldPath: string;
    readonly newPath: string;
  }) {
    this.header = params.header;
    this.section = params.section;
    this.oldStart = params.oldStart;
    this.oldLines = params.oldLines;
    this.newStart = params.newStart;
    this.newLines = params.newLines;
    this.oldPath = params.oldPath;
    this.newPath = params.newPath;
  }

  /** `true` quando as contagens do hunk foram satisfeitas (o corpo acabou). */
  get done(): boolean {
    return this.oldSeen >= this.oldLines && this.newSeen >= this.newLines;
  }

  /**
   * Consome uma linha do corpo do hunk.
   *
   * Devolve `false` quando a linha **não** é do corpo (aí quem chamou decide: é uma linha
   * de cabeçalho do arquivo ou lixo).
   */
  push(line: string): boolean {
    const marker = line.charAt(0);
    // `\ No newline at end of file` — metadado: não conta para as contagens.
    if (marker === "\\") {
      // O marcador é do `git` (não é conteúdo) ⇒ o CR do CRLF sai.
      this.lines.push(metaDiffLine(stripCarriageReturn(line)));
      return true;
    }
    if (marker === "+") {
      this.lines.push(addDiffLine(line.slice(1), this.newStart + this.newSeen));
      this.newSeen += 1;
      return true;
    }
    if (marker === "-") {
      this.lines.push(delDiffLine(line.slice(1), this.oldStart + this.oldSeen));
      this.oldSeen += 1;
      return true;
    }
    // Contexto: começa com espaço — ou é a linha vazia (contexto sem conteúdo).
    if (marker === " " || line === "") {
      this.lines.push(
        ctxDiffLine(line.slice(1), this.oldStart + this.oldSeen, this.newStart + this.newSeen),
      );
      this.oldSeen += 1;
      this.newSeen += 1;
      return true;
    }
    return false;
  }

  /** Congela o hunk. */
  build(): DiffHunk {
    return {
      header: this.header,
      section: this.section,
      oldStart: this.oldStart,
      oldLines: this.oldLines,
      newStart: this.newStart,
      newLines: this.newLines,
      oldPath: this.oldPath,
      newPath: this.newPath,
      lines: this.lines,
    };
  }
}

/**
 * Parseia o texto de um `git diff` unificado em **arquivos** (cada bloco `diff --git`).
 *
 * Diff vazio (sem alteração) ⇒ lista vazia.
 */
export function parseUnifiedDiffFiles(text: string): readonly DiffFile[] {
  const files: DiffFile[] = [];
  let meta: DiffLine[] = [];
  let hunks: DiffHunk[] = [];
  let oldPath = "";
  let newPath = "";
  let hunk: HunkBuilder | null = null;

  const flushFile = (): void => {
    if (meta.length === 0 && hunks.length === 0) return;
    files.push({ oldPath, newPath, meta, hunks });
    meta = [];
    hunks = [];
    oldPath = "";
    newPath = "";
  };

  const rawLines = text.split("\n");
  // O texto termina com "\n" ⇒ o último elemento é "" (não é uma linha do diff).
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  for (const rawLine of rawLines) {
    // ⚠️ O `\r` (CRLF) só é removido das linhas de **cabeçalho** — no corpo do hunk ele é
    // parte da linha do arquivo (o conteúdo precisa dele).
    const line = stripCarriageReturn(rawLine);

    // Novo arquivo.
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      // O hunk pendente (corpo já fechado, mas ainda não congelado) fecha aqui.
      if (hunk !== null) {
        hunks.push(hunk.build());
        hunk = null;
      }
      flushFile();
      meta.push(metaDiffLine(line));
      const paths = parseDiffGitPaths(line);
      oldPath = paths.oldPath;
      newPath = paths.newPath;
      continue;
    }

    if (hunk !== null) {
      if (!hunk.done) {
        // Corpo do hunk ⇒ o conteúdo vai **cru** (com o CR do CRLF).
        // (uma linha só com `\r` é o contexto vazio de um arquivo CRLF).
        const bodyLine = rawLine === "\r" ? "" : rawLine;
        if (hunk.push(bodyLine)) continue;
        // Linha inesperada no corpo ⇒ metadado do arquivo (o hunk já fechou).
        meta.push(metaDiffLine(line));
        continue;
      }
      // O hunk já fechou: só o marcador de "sem newline no fim" ainda pertence a ele.
      if (line.startsWith("\\")) {
        hunk.lines.push(metaDiffLine(line));
        continue;
      }
      hunks.push(hunk.build());
      hunk = null;
    }

    const match = HUNK_HEADER_PATTERN.exec(line);
    if (match !== null) {
      const oldStart = Number(match[1]);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      hunk = new HunkBuilder({
        header: line,
        section: (match[5] ?? "").trim(),
        oldStart,
        oldLines,
        newStart,
        newLines,
        oldPath,
        newPath,
      });
      continue;
    }

    // Cabeçalho do arquivo.
    meta.push(metaDiffLine(line));
    if (line.startsWith("--- ")) oldPath = parseDiffHeaderPath(line.slice(4));
    else if (line.startsWith("+++ ")) newPath = parseDiffHeaderPath(line.slice(4));
    else if (line.startsWith("rename from ")) {
      oldPath = stripPathPrefix(line.slice("rename from ".length).trim());
    } else if (line.startsWith("rename to ")) {
      newPath = stripPathPrefix(line.slice("rename to ".length).trim());
    }
  }

  if (hunk !== null) {
    hunks.push(hunk.build());
    hunk = null;
  }
  flushFile();
  return files;
}

/**
 * Parseia o texto de um `git diff` unificado em **hunks** (a lista plana).
 *
 * Diff vazio (sem alteração) ⇒ lista vazia. Os hunks carregam o caminho do arquivo de
 * origem (`oldPath`/`newPath`), então a lista plana basta para desenhar o painel.
 */
export function parseUnifiedDiff(text: string): readonly DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const file of parseUnifiedDiffFiles(text)) {
    for (const hunk of file.hunks) out.push(hunk);
  }
  return out;
}

/** Conta as linhas adicionadas/removidas de um hunk. */
export function countHunkChanges(hunk: DiffHunk): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

/** Contagem total de mudanças (o cabeçalho do painel mostra `+N −M`). */
export function summarizeDiff(hunks: readonly DiffHunk[]): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    const counts = countHunkChanges(hunk);
    added += counts.added;
    removed += counts.removed;
  }
  return { hunks: hunks.length, added, removed };
}
