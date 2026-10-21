/**
 * Scribe — **parser do `git status --porcelain=v1 -z`** (a lista de alterações do repo).
 *
 * **Por que `-z`:** o formato clássico (separado por `\n`) **cita** os caminhos com caractere
 * especial (`"arquivo com espaço.txt"`, escapes `\nnn` para byte não-ASCII) ⇒ parsear exigiria
 * um interpretador de C-quoting. O `-z` **não cita nada**: cada campo é terminado por **NUL**
 * e o caminho vai **literal** ⇒ o parser é trivial e não há ambiguidade com **espaço**, **acento**
 * ou qualquer byte do nome do arquivo.
 *
 * **Formato** (documentado pelo `git` — *não* observado no alvo; escolha nossa):
 *
 * ```text
 * XY<espaço>path<NUL>          entrada comum
 * XY<espaço>path<NUL>old<NUL>  renomeação/cópia: o 2º campo é o caminho ORIGINAL
 * ```
 *
 * - `X` = status no **índice** (staged), `Y` = status na **árvore de trabalho** (unstaged);
 * - ` ` = sem mudança · `M` modificado · `A` adicionado · `D` deletado · `R` renomeado ·
 *   `C` copiado · `U` não mesclado · `T` tipo mudou · `?` não rastreado · `!` ignorado;
 * - `??` = não rastreado · `!!` = ignorado · `UU`/`AA`/`AU`/`UA`/`DU`/`UD`/`DD` = **conflito**.
 *
 * **Com `--branch`** (o `git status --porcelain=v1 -z --branch`) sai **um campo extra no
 * começo**, o cabeçalho de branch (`## main...origin/main [ahead 1]`), também terminado em
 * NUL. O parser **ignora** esse campo (não é um arquivo) e `parseGitStatusBranch` extrai o
 * nome do branch ⇒ **branch e status saem do mesmo comando**.
 *
 * **Em `-z` a seta some e a ordem dos caminhos se inverte**: o campo principal é o caminho
 * **NOVO** (`to`) e o campo seguinte é o **ORIGINAL** (`from`).
 *
 * ⚠️ **Segurança (precedente obrigatório do repo):** o `main` roda o `git` com
 * `execFile("git", [...])` — **sem shell** — e o caminho do arquivo é **argumento**, nunca
 * concatenado numa string de comando (ver `runGit`/`sanitizedGitEnv` em `src/main/index.ts`).
 * Este módulo só **lê texto**: não executa nada e não toca no FS.
 */

/** Tipo do "kind" da mudança (usado pela UI para o rótulo e a cor do arquivo). */
export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechanged"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "unknown";

/** Uma linha do `git status` (um arquivo), já normalizada. */
export interface GitStatusEntry {
  /** Os **dois** códigos de status, exatamente como o `git` imprimiu (`" M"`, `"MM"`, `"??"`). */
  readonly xy: string;
  /** Caminho do arquivo, **relativo à raiz do repo** (é o que o `git` imprime). */
  readonly path: string;
  /** Caminho **original** — só em renomeação/cópia (o `git` imprime o `from` no 2º campo). */
  readonly oldPath?: string;
  /** Há mudança já no **índice** (staged ⇒ o botão mostra "−"). */
  readonly staged: boolean;
  /** Há mudança **não** indexada (unstaged ⇒ o botão mostra "+"). */
  readonly unstaged: boolean;
  /** Arquivo **não rastreado** (`??`). */
  readonly untracked: boolean;
  /** Arquivo **ignorado** (`!!` — só sai com `--ignored`). */
  readonly ignored?: boolean;
  /** **Conflito** de merge (`UU`, `AA`, `AU`, `UA`, `DU`, `UD`, `DD`). */
  readonly conflicted?: boolean;
}

/** Códigos que representam uma **mudança real** (`?`/`!`/espaço não são mudança). */
const CHANGE_CODES: ReadonlySet<string> = new Set(["M", "A", "D", "R", "C", "T"]);

/** Combinações **unmerged** (conflito) do porcelain v1. */
const UNMERGED_CODES: ReadonlySet<string> = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Prefixo do cabeçalho de branch de um repo **sem nenhum commit**.
 *
 * O `git` escreve `## No commits yet on main` (o nome do branch vem **depois**).
 */
const NO_COMMITS_PREFIX = "No commits yet on ";

/**
 * O par `XY` é um **conflito** (unmerged)?
 *
 * O `git` usa `U` na coluna do índice e/ou na da árvore de trabalho; `AA` (ambos adicionaram) e
 * `DD` (ambos deletaram) são conflitos sem `U`.
 */
export function isConflictStatus(xy: string): boolean {
  return UNMERGED_CODES.has(xy);
}

/**
 * Converte a **saída de `git status --porcelain=v1 -z`** em entradas de arquivo.
 *
 * **Puro** (sem DOM, sem FS, sem `child_process`) — é o que o vitest testa.
 *
 * - Cada **campo** termina em NUL; o campo seguinte de uma renomeação/cópia é o caminho
 *   original (`oldPath`).
 * - Campos malformados (sem `XY ` + caminho) são **ignorados** (robustidão: o `main` nunca
 *   deve quebrar o painel por causa de uma linha inesperada).
 * - O path sai **literal** (o `-z` não cita) ⇒ espaço, acento e unicode chegam intactos.
 */
export function parseGitStatusPorcelain(output: string): GitStatusEntry[] {
  if (output.length === 0) return [];
  // O último campo é "" (a saída termina em NUL) — o laço simplesmente não acha nada nele.
  const fields = output.split("\0");
  const entries: GitStatusEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const field = fields[index];
    index += 1;
    if (field === undefined || field.length < 4) continue; // precisa de "XY path"
    if (field.startsWith("#")) continue; // cabeçalho de branch (`## main...`) — não é arquivo
    const xy = field.slice(0, 2);
    const path = field.slice(3); // o separador é o espaço na posição 2
    if (path.length === 0) continue;
    const x = xy.charAt(0);
    const y = xy.charAt(1);

    // Renomeação/cópia: o **próximo** campo é o caminho original (`from`).
    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const source = fields[index];
      index += 1;
      if (source !== undefined && source.length > 0) oldPath = source;
    }

    const untracked = x === "?" && y === "?";
    const ignored = x === "!" && y === "!";
    const conflicted = !untracked && !ignored && isConflictStatus(xy);

    entries.push({
      xy,
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      staged: !untracked && !ignored && CHANGE_CODES.has(x),
      unstaged: !untracked && !ignored && CHANGE_CODES.has(y),
      untracked,
      ignored,
      conflicted,
    });
  }
  return entries;
}

/**
 * Extrai o **branch atual** do cabeçalho que o `--branch` acrescenta.
 *
 * O `git status --porcelain=v1 -z --branch` imprime, como **primeiro campo**:
 *
 * ```text
 * ## main...origin/main [ahead 1]     (formato moderno, git ≥ 2.13)
 * # branch.head main                  (formato antigo, git < 2.13)
 * ## No commits yet on main           (repo sem nenhum commit)
 * ```
 *
 * Devolve `null` quando não há cabeçalho (o comando foi rodado **sem** `--branch`) ou quando o
 * `git` falhou. Em *detached HEAD* devolve `"HEAD"`.
 */
export function parseGitStatusBranch(output: string): string | null {
  for (const field of output.split("\0")) {
    if (field.startsWith("# branch.head ")) {
      const name = field.slice("# branch.head ".length).trim();
      return name.length === 0 ? null : name;
    }
    if (!field.startsWith("## ")) continue;
    const rest = field.slice(3);
    // Tira o "[ahead 1, behind 2]" e o "origin/main" (o upstream).
    const semContagem = rest.split(" [")[0] ?? rest;
    const nome = (semContagem.split("...")[0] ?? semContagem).trim();
    if (nome.length === 0) return null;
    // Repo **sem commit**: "## No commits yet on main" ⇒ o branch é "main"
    // (o prefixo é do `git`, não faz parte do nome).
    const branch = nome.startsWith(NO_COMMITS_PREFIX)
      ? nome.slice(NO_COMMITS_PREFIX.length).trim()
      : nome;
    if (branch.length === 0) return null;
    // Detached HEAD: "HEAD (no branch)".
    return branch.endsWith(" (no branch)") ? "HEAD" : branch;
  }
  return null;
}

/**
 * O "kind" da mudança (o rótulo e a cor do arquivo na UI).
 *
 * A ordem de precedência: **conflito** → **não rastreado** → **ignorado** → o código do
 * índice (`X`) e, se ele for vazio, o da árvore de trabalho (`Y`).
 */
export function gitChangeKind(entry: GitStatusEntry): GitChangeKind {
  if (entry.conflicted === true) return "conflicted";
  if (entry.untracked) return "untracked";
  if (entry.ignored === true) return "ignored";
  const x = entry.xy.charAt(0);
  const y = entry.xy.charAt(1);
  const kind = (code: string): GitChangeKind | undefined => {
    switch (code) {
      case "A":
        return "added";
      case "M":
        return "modified";
      case "D":
        return "deleted";
      case "R":
        return "renamed";
      case "C":
        return "copied";
      case "T":
        return "typechanged";
      default:
        return undefined;
    }
  };
  return kind(x) ?? kind(y) ?? "unknown";
}

/** A letra que a UI mostra no "badge" do arquivo (a letra do próprio `git`). */
export function gitStatusBadge(entry: GitStatusEntry): string {
  switch (gitChangeKind(entry)) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typechanged":
      return "T";
    case "untracked":
      return "?";
    case "ignored":
      return "!";
    case "conflicted":
      return "!";
    default:
      return "?";
  }
}

/** Rótulo legível do status (o `title` do badge e o texto de acessibilidade). */
export function gitStatusLabel(entry: GitStatusEntry): string {
  switch (gitChangeKind(entry)) {
    case "added":
      return "Adicionado";
    case "modified":
      return "Modificado";
    case "deleted":
      return "Deletado";
    case "renamed":
      return "Renomeado";
    case "copied":
      return "Copiado";
    case "typechanged":
      return "Tipo alterado";
    case "untracked":
      return "Não rastreado";
    case "ignored":
      return "Ignorado";
    case "conflicted":
      return "Conflito";
    default:
      return "Alterado";
  }
}

/** O caminho que a UI mostra (`antigo → novo` quando é renomeação/cópia). */
export function gitStatusDisplayPath(entry: GitStatusEntry): string {
  if (entry.oldPath === undefined) return entry.path;
  return `${entry.oldPath} → ${entry.path}`;
}
