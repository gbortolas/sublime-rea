/**
 * Scribe — **painel de Controle de Código** (o *Source Control* do VS Code).
 *
 * O painel é **autocontido**: cria o próprio DOM dentro do `host` que o chamador passa
 * (mesma convenção do painel de busca) e tem `dispose()`. Ele **não** fala com a ponte:
 * quem executa o `git` é o `main` (via IPC) — o painel só reflete o estado e emite
 * **intenções** (`onStage`, `onUnstage`, `onCommit`).
 *
 * A lógica **pura** (agrupar, contar, filtrar, descrever) vive em funções/classe **sem DOM**
 * — é o que o vitest testa (o ambiente de teste do repo é `node`, **sem jsdom**).
 *
 * ⚠️ **Segurança (precedente obrigatório do repo — RCE via `git diff` já corrigido):**
 * a execução do `git` é do `main`, **sempre** `execFile("git", [...])` — **sem shell** —
 * com `cwd` = raiz do repo, `env` sanitizado (sem `GIT_*` do usuário, `GIT_CONFIG_GLOBAL=/dev/null`,
 * `core.pager=cat`, `core.hooksPath=<nulo>`) e **`--` antes do path**. **NUNCA** concatenar
 * path/mensagem de commit numa string de shell. O contrato IPC exato está no **WIRING SPEC**
 * do relatório deste módulo.
 *
 * **WIRING SPEC (o que o `main`/preload/`main.ts` do renderer precisam implementar):**
 *
 * | método IPC    | payload                       | resultado                                        |
 * |---------------|-------------------------------|--------------------------------------------------|
 * | `git.status`  | `{ root?: string }`           | `{ branch: string \| null; entries: GitStatusEntry[] }` |
 * | `git.stage`   | `{ path: string; root?: string }` | `GitStatusResult` (o status novo)              |
 * | `git.unstage` | `{ path: string; root?: string }` | `GitStatusResult`                              |
 * | `git.commit`  | `{ message: string; root?: string }` | `{ ok: boolean; error?: string }`             |
 *
 * - `git.status` ⇒ **um** comando: `git status --porcelain=v1 -z --branch --untracked-files=all`
 *   (o `--branch` traz o branch no **mesmo** campo; `parseGitStatusBranch` extrai).
 * - `git.stage` ⇒ `git add -- <path>` · `git.unstage` ⇒ `git restore --staged -- <path>`
 *   (fallback p/ git < 2.23: `git reset -q HEAD -- <path>`) · `git.commit` ⇒ `git commit -m <msg>`.
 * - O `path` é **relativo à raiz do repo** (é o que o `git status` imprime) e vai como
 *   **argumento** (`--` antes dele) — nunca interpolado numa string de shell.
 * - A **mensagem de commit** também é um **argumento** (`-m <msg>`): o `parse-options` do git
 *   pega o próximo `argv` como valor, mesmo que comece com `-`.
 * - ⚠️ O `env` sanitizado ignora o `~/.gitconfig` ⇒ o commit usa **só** a identidade do
 *   `.git/config` do repo; se faltar `user.name`/`user.email`, o `main` devolve o erro do git
 *   (não inventa identidade).
 * - `core.hooksPath=/dev/null` (o `GIT_HARDENED_CONFIG` já existente) ⇒ **nenhum hook** do
 *   repo roda no commit (o hook é código arbitrário do repo).
 */
import type { GitChangeKind, GitStatusEntry } from "../core/git/git-status";
import { gitChangeKind, gitStatusBadge, gitStatusDisplayPath, gitStatusLabel } from "../core/git/git-status";
import { watchHostVisibility } from "./host-visibility";

// ── Modelo (puro) ────────────────────────────────────────────────────────────────────────────

/** Os grupos do painel (a ordem é a do VS Code: conflito → staged → changes → untracked). */
export type SourceControlGroupId = "conflicts" | "staged" | "changes" | "untracked";

/** Um grupo de arquivos (uma seção do painel). */
export interface SourceControlGroup {
  readonly id: SourceControlGroupId;
  /** Rótulo pronto para a UI (nunca a string interna do Scribe). */
  readonly label: string;
  readonly entries: readonly GitStatusEntry[];
}

/** Contagens do painel (o badge da status bar usa o `total`). */
export interface SourceControlCounts {
  /** Arquivos com mudança já no índice. */
  readonly staged: number;
  /** Arquivos com mudança não indexada. */
  readonly unstaged: number;
  /** Arquivos não rastreados. */
  readonly untracked: number;
  /** Arquivos em conflito. */
  readonly conflicts: number;
  /** Arquivos ignorados (fora dos grupos). */
  readonly ignored: number;
  /** Total de arquivos **visíveis** (ignorado não conta). */
  readonly total: number;
}

/** Rótulos dos grupos (a UI é em português, como o resto da casca). */
const GROUP_LABELS: Readonly<Record<SourceControlGroupId, string>> = {
  conflicts: "Conflitos",
  staged: "Alterações Preparadas",
  changes: "Alterações",
  untracked: "Não Rastreados",
};

/** A ordem de pintura dos grupos. */
const GROUP_ORDER: readonly SourceControlGroupId[] = ["conflicts", "staged", "changes", "untracked"];

/**
 * Agrupa as entradas nos 4 grupos.
 *
 * - **conflito** vai para "Conflitos" (e não aparece nos outros grupos);
 * - **não rastreado** vai para "Não Rastreados";
 * - **staged** e **unstaged** são independentes ⇒ um arquivo `MM` aparece em **dois** grupos
 *   (é o que o VS Code faz: "Alterações Preparadas" e "Alterações");
 * - **ignorado** não entra em grupo nenhum (mas continua em `entries`).
 *
 * Sempre devolve os **4 grupos** (mesmo vazios) ⇒ o formato é previsível para o teste e para
 * a UI (que esconde os grupos vazios).
 */
export function groupSourceControlEntries(
  entries: readonly GitStatusEntry[],
): readonly SourceControlGroup[] {
  const buckets: Record<SourceControlGroupId, GitStatusEntry[]> = {
    conflicts: [],
    staged: [],
    changes: [],
    untracked: [],
  };
  for (const entry of entries) {
    if (entry.ignored === true) continue;
    if (entry.conflicted === true) {
      buckets.conflicts.push(entry);
      continue;
    }
    if (entry.untracked) {
      buckets.untracked.push(entry);
      continue;
    }
    if (entry.staged) buckets.staged.push(entry);
    if (entry.unstaged) buckets.changes.push(entry);
  }
  return GROUP_ORDER.map((id) => ({ id, label: GROUP_LABELS[id], entries: buckets[id] }));
}

/** Conta as entradas por categoria (o `total` ignora os ignorados). */
export function countSourceControlEntries(
  entries: readonly GitStatusEntry[],
): SourceControlCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicts = 0;
  let ignored = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.ignored === true) {
      ignored += 1;
      continue;
    }
    total += 1;
    if (entry.conflicted === true) conflicts += 1;
    else if (entry.untracked) untracked += 1;
    if (entry.staged) staged += 1;
    if (entry.unstaged) unstaged += 1;
  }
  return { staged, unstaged, untracked, conflicts, ignored, total };
}

/**
 * Filtra as entradas por caminho (**sem diferenciar maiúsculas**).
 *
 * O texto procurado casa com o caminho **novo** e também com o **original** (renomeação).
 * Query vazia ⇒ todas as entradas.
 */
export function filterSourceControlEntries(
  entries: readonly GitStatusEntry[],
  query: string,
): readonly GitStatusEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...entries];
  return entries.filter((entry) => {
    if (entry.path.toLowerCase().includes(needle)) return true;
    const old = entry.oldPath;
    return old !== undefined && old.toLowerCase().includes(needle);
  });
}

/** Texto do cabeçalho ("3 alterações" / "1 alteração" / "0 alterações"). */
export function describeSourceControlCounts(counts: SourceControlCounts): string {
  if (counts.total === 1) return "1 alteração";
  return `${counts.total} alterações`;
}

/** Texto do estado vazio do painel. */
export function describeSourceControlEmpty(query: string): string {
  if (query.trim().length > 0) return "Nenhum arquivo corresponde ao filtro";
  return "Nenhuma alteração";
}

/** O branch atual, pronto para a UI ("—" quando não há repo). */
export function describeSourceControlBranch(branch: string): string {
  return branch.trim().length === 0 ? "sem branch" : branch.trim();
}

/**
 * O **badge** da status bar (`#status-git`): vazio quando não há alteração alguma.
 *
 * A UI usa: `⎇ ${badge}` (o `⎇` é o glifo do Source Control).
 */
export function formatSourceControlBadge(counts: SourceControlCounts): string {
  return counts.total === 0 ? "" : String(counts.total);
}

/** A cor (um **token** do tema — nunca uma cor literal) de cada "kind" de mudança. */
export function gitStatusColorToken(kind: GitChangeKind): string {
  switch (kind) {
    case "added":
      return "var(--s-success)";
    case "modified":
      return "var(--s-warn)";
    case "deleted":
      return "var(--s-error)";
    case "renamed":
    case "copied":
      return "var(--s-info)";
    case "typechanged":
      return "var(--s-accent)";
    case "conflicted":
      return "var(--s-error)";
    case "untracked":
      return "var(--s-muted)";
    case "ignored":
      return "var(--s-subtle)";
    default:
      return "var(--s-muted)";
  }
}

/** As **intenções** que o painel emite (o `main.ts` as traduz em IPC). */
export interface SourceControlCallbacks {
  /** "Preparar" (stage) um arquivo. */
  readonly onStage?: (path: string) => void;
  /** "Desfazer a preparação" (unstage) um arquivo. */
  readonly onUnstage?: (path: string) => void;
  /** "Preparar tudo" (stage em lote). */
  readonly onStageAll?: () => void;
  /** Confirmar (commit) com a mensagem escrita. */
  readonly onCommit?: (message: string) => void;
  /** O usuário selecionou um arquivo (o chamador abre o documento). */
  readonly onSelect?: (path: string) => void;
  /** O usuário pediu para recarregar o status. */
  readonly onRefresh?: () => void;
}

/**
 * O **modelo** do painel: estado + intenções.
 *
 * O modelo **não executa nada** — `stage`/`unstage`/`stageAll`/`commit` apenas **emitem
 * callbacks**. Quem executa é o `main` (via IPC); o painel volta a ser atualizado com o
 * `update(entries)` do chamador.
 */
export class SourceControlModel {
  private entries: readonly GitStatusEntry[] = [];
  private query = "";
  private selected: string | undefined;
  private message = "";
  private branchName = "";
  private errorMessage: string | null = null;
  private callbacks: SourceControlCallbacks;

  constructor(callbacks: SourceControlCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Troca os callbacks (o `main.ts` pode religar o painel a outro repo). */
  setCallbacks(callbacks: SourceControlCallbacks): void {
    this.callbacks = callbacks;
  }

  /** **Recebe** o status novo (a saída de `git status --porcelain=v1 -z` já parseada). */
  setStatus(entries: readonly GitStatusEntry[]): void {
    this.entries = [...entries];
  }

  /** Todas as entradas (inclusive as ignoradas). */
  get status(): readonly GitStatusEntry[] {
    return this.entries;
  }

  /** Os 4 grupos (sem filtro). */
  get groups(): readonly SourceControlGroup[] {
    return groupSourceControlEntries(this.entries);
  }

  /** Os grupos **visíveis** (aplicando o filtro atual). */
  get visibleGroups(): readonly SourceControlGroup[] {
    return groupSourceControlEntries(filterSourceControlEntries(this.entries, this.query));
  }

  /** As contagens do status atual. */
  get counts(): SourceControlCounts {
    return countSourceControlEntries(this.entries);
  }

  /** O filtro atual (o texto do campo de filtro). */
  get filterQuery(): string {
    return this.query;
  }

  /** Aplica o filtro de texto (o campo de filtro da UI). */
  setFilter(query: string): void {
    this.query = query;
  }

  /**
   * **Puro**: as entradas que casam com o termo (sem diferenciar maiúsculas).
   *
   * Não muda o estado do modelo — use `setFilter` para isso.
   */
  filter(query: string): readonly GitStatusEntry[] {
    return filterSourceControlEntries(this.entries, query);
  }

  /** Seleciona um arquivo (e avisa o chamador). */
  select(path: string): void {
    this.selected = path;
    this.callbacks.onSelect?.(path);
  }

  /** O arquivo selecionado (`undefined` se nenhum). */
  get selectedPath(): string | undefined {
    return this.selected;
  }

  /** A mensagem de commit atual. */
  get commitMessage(): string {
    return this.message;
  }

  /** Troca a mensagem de commit. */
  set commitMessage(message: string) {
    this.message = message;
  }

  /** Limpa a mensagem de commit (depois de um commit bem-sucedido). */
  clearCommitMessage(): void {
    this.message = "";
  }

  /** O branch atual. */
  get branch(): string {
    return this.branchName;
  }

  /** Troca o branch atual. */
  setBranch(branch: string): void {
    this.branchName = branch;
  }

  /** A última mensagem de erro do `git` (`null` ⇒ sem erro). */
  get error(): string | null {
    return this.errorMessage;
  }

  /** Registra (ou limpa) o erro do `git`. */
  setError(message: string | null): void {
    this.errorMessage = message;
  }

  // ── Intenções (não executam nada: só emitem callbacks) ───────────────────────────────────

  /** Intenção: **preparar** (stage) um arquivo. */
  stage(path: string): void {
    this.callbacks.onStage?.(path);
  }

  /** Intenção: **desfazer a preparação** (unstage) de um arquivo. */
  unstage(path: string): void {
    this.callbacks.onUnstage?.(path);
  }

  /**
   * Intenção: **preparar tudo**.
   *
   * Se existir `onStageAll`, ele é usado (um único `git add` no `main`). Sem ele, o modelo
   * emite `onStage` **por arquivo** (fallback para quem só implementa o stage individual).
   */
  stageAll(): void {
    const batch = this.callbacks.onStageAll;
    if (batch !== undefined) {
      batch();
      return;
    }
    for (const entry of this.entries) {
      if (entry.ignored === true) continue;
      if (entry.untracked || entry.unstaged) this.callbacks.onStage?.(entry.path);
    }
  }

  /**
   * Intenção: **confirmar** (commit).
   *
   * Não emite nada se a mensagem estiver vazia (um commit sem mensagem não faz sentido).
   * A mensagem **não** é limpa aqui — quem confirma (o `main`) avisa e o chamador limpa.
   */
  commit(): void {
    const message = this.message.trim();
    if (message.length === 0) return;
    this.callbacks.onCommit?.(message);
  }

  /** Intenção: **recarregar** o status. */
  refresh(): void {
    this.callbacks.onRefresh?.();
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────────────────────

/** Opções do painel (os callbacks são os mesmos do modelo). */
export type SourceControlPanelOptions = SourceControlCallbacks;

/** A superfície do painel (o `main.ts` só reflete o estado por aqui). */
export interface SourceControlPanelHandle {
  /** O modelo (contagens, seleção, mensagem). */
  readonly model: SourceControlModel;
  /** Recebe o status novo (entradas já parseadas). */
  update(entries: readonly GitStatusEntry[]): void;
  /** Troca o branch exibido no cabeçalho. */
  setBranch(branch: string): void;
  /** Mostra (ou limpa, com `null`) o erro do `git`. */
  setError(message: string | null): void;
  /** Limpa a mensagem de commit (após um commit bem-sucedido). */
  clearCommitMessage(): void;
  /** Remove o painel do DOM. */
  dispose(): void;
}

/** `true` quando há DOM disponível (o renderer tem; em Node, não). */
function hasDom(): boolean {
  return typeof document !== "undefined" && document !== null;
}

/** Cria um elemento com a classe dada (atalho do painel). */
function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/**
 * Monta o painel de Controle de Código dentro do `host` (cria o DOM, devolve o handle).
 *
 * **Sem DOM ⇒ degradação:** devolve um handle que só atualiza o modelo (nada de DOM, sem
 * throw) — o app não quebra em ambiente sem DOM (testes, SSR, headless).
 */
export function mountSourceControlPanel(
  host: HTMLElement | null | undefined,
  options: SourceControlPanelOptions = {},
): SourceControlPanelHandle {
  const model = new SourceControlModel(options);

  if (!hasDom() || host === null || host === undefined) {
    // Degradação: o modelo continua funcionando (o chamador consegue ler as contagens).
    return {
      model,
      update(entries: readonly GitStatusEntry[]): void {
        model.setStatus(entries);
      },
      setBranch(branch: string): void {
        model.setBranch(branch);
      },
      setError(message: string | null): void {
        model.setError(message);
      },
      clearCommitMessage(): void {
        model.clearCommitMessage();
      },
      dispose(): void {
        // nada a remover
      },
    };
  }

  const root = el("div", "source-control");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Controle de código");
  root.style.cssText = [
    "display: flex;",
    "flex-direction: column;",
    "min-height: 0;",
    "height: 100%;",
    "background: var(--s-sidebar);",
    "color: var(--s-fg);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-sm);",
  ].join(" ");

  // ── cabeçalho: branch + contagem + "preparar tudo" ──
  const head = el("div", "source-control-head");
  head.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-1);",
    "padding: var(--s-space-2);",
    "border-bottom: 1px solid var(--s-border);",
  ].join(" ");

  const branchEl = el("span", "source-control-branch");
  branchEl.style.cssText = [
    "flex: 0 1 auto;",
    "overflow: hidden;",
    "text-overflow: ellipsis;",
    "white-space: nowrap;",
    "font-weight: 600;",
  ].join(" ");

  const countEl = el("span", "source-control-count");
  countEl.style.cssText = ["color: var(--s-muted);", "font-size: var(--s-fs-xs);"].join(" ");

  const stageAllButton = el("button", "source-control-stage-all") as HTMLButtonElement;
  stageAllButton.type = "button";
  stageAllButton.textContent = "Preparar tudo";
  stageAllButton.setAttribute("aria-label", "Preparar todas as alterações");
  stageAllButton.title = "Preparar todas as alterações";
  stageAllButton.style.cssText = [
    "margin-left: auto;",
    "flex: 0 0 auto;",
    "padding: 1px var(--s-space-2);",
    "background: transparent;",
    "border: 1px solid var(--s-border-strong);",
    "border-radius: var(--s-radius-sm);",
    "color: var(--s-fg-muted);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-xs);",
    "cursor: pointer;",
  ].join(" ");

  head.append(branchEl, countEl, stageAllButton);

  // ── commit: mensagem + botão ──
  const commitBox = el("div", "source-control-commit");
  commitBox.style.cssText = [
    "display: flex;",
    "gap: var(--s-space-1);",
    "padding: var(--s-space-2);",
    "border-bottom: 1px solid var(--s-border);",
  ].join(" ");

  const messageInput = document.createElement("input") as HTMLInputElement;
  messageInput.className = "source-control-message";
  messageInput.type = "text";
  messageInput.placeholder = "Mensagem do commit";
  messageInput.setAttribute("aria-label", "Mensagem do commit");
  messageInput.setAttribute("autocomplete", "off");
  messageInput.setAttribute("spellcheck", "false");
  messageInput.style.cssText = [
    "flex: 1 1 auto;",
    "min-width: 0;",
    "padding: var(--s-space-1) var(--s-space-2);",
    "background: var(--s-bg);",
    "color: var(--s-fg);",
    "border: 1px solid var(--s-border-strong);",
    "border-radius: var(--s-radius);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-sm);",
  ].join(" ");

  const commitButton = el("button", "source-control-commit-button") as HTMLButtonElement;
  commitButton.type = "button";
  commitButton.textContent = "Commit";
  commitButton.setAttribute("aria-label", "Confirmar as alterações preparadas");
  commitButton.style.cssText = [
    "flex: 0 0 auto;",
    "padding: 1px var(--s-space-2);",
    "background: var(--s-accent);",
    "border: 1px solid transparent;",
    "border-radius: var(--s-radius);",
    "color: var(--s-fg);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-sm);",
    "cursor: pointer;",
  ].join(" ");

  commitBox.append(messageInput, commitButton);

  // ── filtro ──
  const filterBox = el("div", "source-control-filter");
  filterBox.style.cssText = ["padding: var(--s-space-1) var(--s-space-2);"].join(" ");

  const filterInput = document.createElement("input") as HTMLInputElement;
  filterInput.className = "source-control-filter-input";
  filterInput.type = "text";
  filterInput.placeholder = "Filtrar por nome";
  filterInput.setAttribute("aria-label", "Filtrar arquivos por nome");
  filterInput.setAttribute("autocomplete", "off");
  filterInput.style.cssText = [
    "width: 100%;",
    "box-sizing: border-box;",
    "padding: 1px var(--s-space-2);",
    "background: var(--s-bg);",
    "color: var(--s-fg);",
    "border: 1px solid var(--s-border-strong);",
    "border-radius: var(--s-radius);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-xs);",
  ].join(" ");

  filterBox.appendChild(filterInput);

  const list = el("div", "source-control-list");
  list.style.cssText = ["flex: 1 1 auto;", "min-height: 0;", "overflow-y: auto;"].join(" ");

  // ── erro do git (ex.: "Author identity unknown") ──
  const errorEl = el("div", "source-control-error");
  errorEl.setAttribute("role", "alert");
  errorEl.setAttribute("aria-live", "polite");
  errorEl.style.cssText = [
    "margin: var(--s-space-1) var(--s-space-2);",
    "padding: var(--s-space-1) var(--s-space-2);",
    "border: 1px solid var(--s-error);",
    "border-radius: var(--s-radius-sm);",
    "background: color-mix(in srgb, var(--s-error) 12%, transparent);",
    "color: var(--s-error);",
    "font-size: var(--s-fs-xs);",
    "white-space: pre-wrap;",
    "word-break: break-word;",
  ].join(" ");
  errorEl.hidden = true;

  root.append(head, commitBox, filterBox, errorEl, list);
  host.appendChild(root);

  // ── render ──

  /**
   * A visibilidade do painel (`host.hidden`).
   *
   * Escondido ⇒ **não** redesenha (o DOM fica sujo e é redesenhado quando o host ficar
   * visível): sem isso, o painel redesenha o DOM inteiro a cada evento mesmo ninguém
   * olhando.
   */
  const visibility = watchHostVisibility(host, (): void => {
    render();
  });

  const renderHeader = (): void => {
    branchEl.textContent = describeSourceControlBranch(model.branch);
    countEl.textContent = describeSourceControlCounts(model.counts);
    commitButton.disabled = model.commitMessage.trim().length === 0;
  };

  /** Desenha o erro do `git` (o painel **não** esconde a falha). */
  const renderError = (): void => {
    if (visibility.hidden) {
      visibility.markDirty();
      return;
    }
    const message = model.error;
    if (message === null || message.trim().length === 0) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  };

  const render = (): void => {
    if (visibility.hidden) {
      visibility.markDirty();
      return;
    }
    visibility.markClean();
    renderHeader();
    renderError();

    list.replaceChildren();
    const groups = model.visibleGroups.filter((group) => group.entries.length > 0);
    if (groups.length === 0) {
      const empty = el("div", "source-control-empty");
      empty.textContent = describeSourceControlEmpty(model.filterQuery);
      empty.style.cssText = [
        "padding: var(--s-space-2);",
        "color: var(--s-muted);",
        "font-size: var(--s-fs-xs);",
      ].join(" ");
      list.appendChild(empty);
      return;
    }

    for (const group of groups) {
      const groupEl = el("div", "source-control-group");
      groupEl.setAttribute("role", "group");

      const title = el("div", "source-control-group-title");
      title.textContent = `${group.label} (${group.entries.length})`;
      title.style.cssText = [
        "padding: var(--s-space-1) var(--s-space-2);",
        "color: var(--s-muted);",
        "font-size: var(--s-fs-xs);",
        "text-transform: uppercase;",
        "letter-spacing: 0.04em;",
      ].join(" ");
      groupEl.appendChild(title);

      for (const entry of group.entries) groupEl.appendChild(renderRow(entry));
      list.appendChild(groupEl);
    }
  };

  const actionButton = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const button = el("button", "source-control-action") as HTMLButtonElement;
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.style.cssText = [
      "flex: 0 0 auto;",
      "width: 20px;",
      "height: 20px;",
      "padding: 0;",
      "background: transparent;",
      "border: none;",
      "border-radius: var(--s-radius-sm);",
      "color: var(--s-fg-muted);",
      "font-family: var(--s-font-ui);",
      "font-size: var(--s-fs-md);",
      "line-height: 1;",
      "cursor: pointer;",
    ].join(" ");
    button.addEventListener("click", (event): void => {
      // ⚠️ O clique **não** sobe para a linha e **não** redesenha: o botão seria recriado
      // (o foco iria para o `<body>` e o campo de commit perderia o foco). O status novo
      // chega pelo `update()` do chamador.
      event.stopPropagation();
      onClick();
    });
    return button;
  };

  const renderRow = (entry: GitStatusEntry): HTMLElement => {
    const row = el("div", "source-control-row");
    row.setAttribute("role", "treeitem");
    if (model.selectedPath === entry.path) row.setAttribute("aria-selected", "true");
    row.style.cssText = [
      "display: flex;",
      "align-items: center;",
      "gap: var(--s-space-1);",
      "padding: 1px var(--s-space-2);",
    ].join(" ");

    const badge = el("span", "source-control-status");
    badge.textContent = gitStatusBadge(entry);
    badge.title = gitStatusLabel(entry);
    badge.setAttribute("aria-label", gitStatusLabel(entry));
    badge.style.cssText = [
      "flex: 0 0 auto;",
      "width: 12px;",
      "text-align: center;",
      "font-family: var(--s-font-mono);",
      "font-size: var(--s-fs-xs);",
      "font-weight: 600;",
      `color: ${gitStatusColorToken(gitChangeKind(entry))};`,
    ].join(" ");

    const path = el("span", "source-control-path");
    path.textContent = gitStatusDisplayPath(entry);
    path.title = entry.path;
    path.style.cssText = [
      "flex: 1 1 auto;",
      "min-width: 0;",
      "overflow: hidden;",
      "text-overflow: ellipsis;",
      "white-space: nowrap;",
      "font-family: var(--s-font-mono);",
      "font-size: var(--s-fs-xs);",
    ].join(" ");

    row.append(badge, path);

    // Conflito não tem ação de stage/unstage (a resolução é outro fluxo).
    if (entry.conflicted !== true) {
      if (entry.staged) {
        row.appendChild(
          actionButton("−", `Desfazer a preparação de ${entry.path}`, () => model.unstage(entry.path)),
        );
      }
      if (entry.unstaged || entry.untracked) {
        row.appendChild(
          actionButton("+", `Preparar ${entry.path}`, () => model.stage(entry.path)),
        );
      }
    }

    row.addEventListener("click", (): void => {
      model.select(entry.path);
      render();
    });

    return row;
  };

  // ── eventos ──
  messageInput.addEventListener("input", (): void => {
    model.commitMessage = messageInput.value;
    // Só o cabeçalho muda (o botão "Commit") — a lista não precisa ser redesenhada.
    renderHeader();
  });

  commitButton.addEventListener("click", (): void => {
    model.commit();
  });

  filterInput.addEventListener("input", (): void => {
    model.setFilter(filterInput.value);
    render();
  });

  stageAllButton.addEventListener("click", (): void => {
    model.stageAll();
  });

  render();

  return {
    model,
    update(entries: readonly GitStatusEntry[]): void {
      model.setStatus(entries);
      render();
    },
    setBranch(branch: string): void {
      model.setBranch(branch);
      render();
    },
    setError(message: string | null): void {
      model.setError(message);
      // O erro é **visível** no painel (não só na status bar).
      renderError();
    },
    clearCommitMessage(): void {
      model.clearCommitMessage();
      messageInput.value = "";
      render();
    },
    dispose(): void {
      visibility.dispose();
      root.remove();
    },
  };
}
