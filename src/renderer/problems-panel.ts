/**
 * Scribe — **painel de problemas** (o "Problems" do VS Code).
 *
 * O painel lista os **diagnósticos do LSP** (erro/aviso/info/dica) **agrupados por arquivo**,
 * com **filtro** (mensagem ou caminho, sem diferenciar maiúsculas), **contagem por severidade**
 * e **"pular para o erro"** (o `onJump` leva o chamador até a linha/coluna).
 *
 * O módulo é **autocontido** (mesma convenção do painel de busca): a lógica pura vive na
 * classe `ProblemsModel` e nas funções exportadas — **sem DOM**, que é o que o vitest
 * testa (o ambiente de teste é `node`, sem jsdom). A parte de DOM vive em
 * `mountProblemsPanel`, que **degrada**: sem `host` (ou sem DOM) devolve um handle inerte
 * em vez de explodir.
 *
 * **Escolha nossa (não observada no alvo):** o alvo não expõe um painel de problemas; aqui a
 * lista segue o desenho do VS Code (arquivo → diagnóstico), que é o padrão da indústria a que
 * o Scribe se parece.
 */
import type { LspDiagnostic } from "../shared";
import { watchHostVisibility } from "./host-visibility";

// ── Tipos ────────────────────────────────────────────────────────────────────────────────────

/** Severidade de um problema (a mesma do contrato LSP, já normalizada). */
export type ProblemSeverity = "error" | "warning" | "info" | "hint";

/**
 * Um diagnóstico **com o arquivo** a que pertence.
 *
 * O IPC entrega `{ handle, diagnostics }` — o handle não é um caminho, então quem monta o
 * painel translate o handle em caminho (é o `main.ts` que sabe) e entrega a lista aqui.
 */
export interface ProblemEntry {
  /** Caminho do arquivo (o que o painel agrupa/exibe e o que o `onJump` recebe). */
  readonly path: string;
  /** O diagnóstico (mensagem, severidade e range). */
  readonly diagnostic: LspDiagnostic;
}

/** Um diagnóstico pronto para exibição (com o arquivo já resolvido). */
export interface ProblemItem {
  /** Caminho do arquivo. */
  readonly path: string;
  /** Nome do arquivo (último segmento do caminho). */
  readonly name: string;
  /** Severidade. */
  readonly severity: ProblemSeverity;
  /** Mensagem do diagnóstico. */
  readonly message: string;
  /** Origem do diagnóstico (o servidor LSP que o produziu) — pode ser vazia. */
  readonly source: string;
  /** Linha do início do range — **0-based** (a convenção do core). */
  readonly line: number;
  /** Coluna do início do range — **0-based** (a convenção do core). */
  readonly column: number;
}

/** Os problemas de um arquivo (um grupo da lista). */
export interface ProblemFileGroup {
  /** Caminho do arquivo. */
  readonly path: string;
  /** Nome do arquivo (último segmento do caminho). */
  readonly name: string;
  /** Quantos problemas o arquivo tem. */
  readonly count: number;
  /** Os problemas do arquivo (erros primeiro, depois por linha/coluna). */
  readonly items: readonly ProblemItem[];
}

/** Contagem por severidade. */
export interface ProblemCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
  readonly hint: number;
  /** Total (a soma das severidades). */
  readonly total: number;
}

// ── Funções puras ───────────────────────────────────────────────────────────────────────────

/** Ordem canônica das severidades (do mais grave para o mais leve). */
const SEVERITY_ORDER: readonly ProblemSeverity[] = ["error", "warning", "info", "hint"];

/** Ranque de cada severidade (menor = mais grave). */
const SEVERITY_RANK: Readonly<Record<ProblemSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/** Rótulo de cada severidade (o que aparece na lista). */
const SEVERITY_LABELS: Readonly<Record<ProblemSeverity, string>> = {
  error: "Erro",
  warning: "Aviso",
  info: "Info",
  hint: "Dica",
};

/** Ranque da severidade (0 = erro … 3 = dica). */
export function severityRank(severity: ProblemSeverity): number {
  return SEVERITY_RANK[severity];
}

/** Rótulo curto da severidade ("Erro", "Aviso", "Info", "Dica"). */
export function severityLabel(severity: ProblemSeverity): string {
  return SEVERITY_LABELS[severity];
}

/** Último segmento de um caminho (o renderer não tem `node:path`). */
export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last === undefined || last.length === 0 ? path : last;
}

/** Converte um par (caminho + diagnóstico) no item exibível. */
export function toProblemItem(entry: ProblemEntry): ProblemItem {
  const diagnostic = entry.diagnostic;
  return {
    path: entry.path,
    name: basenameOf(entry.path),
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
    line: diagnostic.range.startLine,
    column: diagnostic.range.startCol,
  };
}

/**
 * Achata os diagnósticos de um arquivo em entradas (atalho para quem monta a lista).
 *
 * O `main.ts` recebe `{ handle, diagnostics }` do LSP e traduz o handle em caminho; este
 * atalho evita repetir o `map` a cada atualização.
 */
export function problemEntries(
  path: string,
  diagnostics: readonly LspDiagnostic[],
): readonly ProblemEntry[] {
  return diagnostics.map((diagnostic) => ({ path, diagnostic }));
}

/** Compara dois caminhos (sem `localeCompare` — a ordem não pode depender do locale). */
function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Ordem canônica dos itens: **severidade**, depois arquivo, linha e coluna. */
function compareItems(a: ProblemItem, b: ProblemItem): number {
  const rank = severityRank(a.severity) - severityRank(b.severity);
  if (rank !== 0) return rank;
  const path = comparePaths(a.path, b.path);
  if (path !== 0) return path;
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

/** O item casa com a consulta? (mensagem **ou** caminho, sem diferenciar maiúsculas). */
export function matchesQuery(item: ProblemItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    item.message.toLowerCase().includes(needle) ||
    item.path.toLowerCase().includes(needle)
  );
}

/** Conta as severidades de uma lista de itens. */
export function countSeverities(items: readonly ProblemItem[]): ProblemCounts {
  let error = 0;
  let warning = 0;
  let info = 0;
  let hint = 0;
  for (const item of items) {
    switch (item.severity) {
      case "error":
        error += 1;
        break;
      case "warning":
        warning += 1;
        break;
      case "info":
        info += 1;
        break;
      case "hint":
        hint += 1;
        break;
    }
  }
  return { error, warning, info, hint, total: items.length };
}

/**
 * Agrupa os itens **por arquivo**.
 *
 * A ordem dos grupos é pela **severidade mais grave** do grupo (o arquivo com erro vem
 * antes do arquivo que só tem avisos) e, empatando, pelo caminho; dentro do grupo os itens
 * ficam por **severidade** e depois por **linha/coluna**.
 */
export function groupByFile(items: readonly ProblemItem[]): readonly ProblemFileGroup[] {
  const buckets = new Map<string, ProblemItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.path);
    if (bucket === undefined) buckets.set(item.path, [item]);
    else bucket.push(item);
  }
  const groups: ProblemFileGroup[] = [];
  for (const [path, bucket] of buckets) {
    const ordered = [...bucket].sort((a, b) => {
      const rank = severityRank(a.severity) - severityRank(b.severity);
      if (rank !== 0) return rank;
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });
    groups.push({ path, name: basenameOf(path), count: ordered.length, items: ordered });
  }
  groups.sort((a, b) => {
    const worst = worstRank(a.items) - worstRank(b.items);
    if (worst !== 0) return worst;
    return comparePaths(a.path, b.path);
  });
  return groups;
}

/** O rank da severidade mais grave de um grupo. */
function worstRank(items: readonly ProblemItem[]): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const rank = severityRank(item.severity);
    if (rank < worst) worst = rank;
  }
  return worst;
}

/** `arquivo:linha:coluna` — **1-based** (é o que o usuário lê). */
export function formatLocation(item: ProblemItem): string {
  return `${item.name}:${item.line + 1}:${item.column + 1}`;
}

// ── Modelo ──────────────────────────────────────────────────────────────────────────────────

/**
 * O estado do painel de problemas (a parte **pura** — sem DOM).
 *
 * A lista canônica é ordenada por **severidade** (erro primeiro), depois por **arquivo**,
 * **linha** e **coluna**; o filtro casa na **mensagem** e no **caminho** (sem diferenciar
 * maiúsculas).
 */
export class ProblemsModel {
  /** Os diagnósticos atuais (a entrada crua, com o caminho). */
  private entries: readonly ProblemEntry[] = [];
  /** Os itens derivados (ordenados) — cacheados para não reordenar a cada leitura. */
  private itemsCache: readonly ProblemItem[] = [];
  /** O filtro atual ("" = sem filtro). */
  private query = "";

  /** Substitui o conjunto de diagnósticos (a entrada do `lsp.diagnostics`). */
  setDiagnostics(entries: readonly ProblemEntry[]): void {
    this.entries = [...entries];
    this.rebuild();
  }

  /** Esvazia o painel (o arquivo fechou, o servidor caiu…). */
  clear(): void {
    this.entries = [];
    this.itemsCache = [];
  }

  /** Define o filtro atual (o `visibleItems` passa a refletir o filtro). */
  setFilter(query: string): void {
    this.query = query;
  }

  /** O filtro atual ("" = sem filtro). */
  get filterQuery(): string {
    return this.query;
  }

  /**
   * Filtra a lista atual — **puro**: não muda o estado do modelo.
   *
   * Casa na **mensagem** e no **caminho**, sem diferenciar maiúsculas.
   */
  filter(query: string): readonly ProblemItem[] {
    const needle = query.trim();
    if (needle.length === 0) return this.itemsCache;
    return this.itemsCache.filter((item) => matchesQuery(item, needle));
  }

  /** Todos os itens (ordem canônica: severidade, arquivo, linha, coluna). */
  get items(): readonly ProblemItem[] {
    return this.itemsCache;
  }

  /** Os itens **visíveis** (o filtro atual já aplicado). */
  get visibleItems(): readonly ProblemItem[] {
    return this.filter(this.query);
  }

  /** Os itens visíveis **agrupados por arquivo**. */
  get groups(): readonly ProblemFileGroup[] {
    return groupByFile(this.visibleItems);
  }

  /** Contagem por severidade de **todos** os diagnósticos (o badge da status bar). */
  get counts(): ProblemCounts {
    return countSeverities(this.itemsCache);
  }

  /** Contagem por severidade do que está **visível** (o cabeçalho do painel). */
  get visibleCounts(): ProblemCounts {
    return countSeverities(this.visibleItems);
  }

  /** Reconstrói o cache dos itens (chamado quando o conjunto muda). */
  private rebuild(): void {
    const items: ProblemItem[] = [];
    for (const entry of this.entries) items.push(toProblemItem(entry));
    items.sort(compareItems);
    this.itemsCache = items;
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────────────────────

/** Intenções emitidas pelo painel (o `main.ts` as traduz em IPC/ações do editor). */
export interface ProblemsPanelOptions {
  /**
   * O usuário clicou num diagnóstico ⇒ pular para a posição.
   * `line`/`column` são **0-based** (a convenção do core — a UI exibe 1-based).
   */
  readonly onJump?: (file: string, line: number, column: number) => void;
  /** O texto do filtro mudou. */
  readonly onFilterChange?: (query: string) => void;
  /** O usuário pediu para fechar o painel. */
  readonly onClose?: () => void;
}

/** Superfície do painel (o `main.ts` só reflete o estado por aqui). */
export interface ProblemsPanelHandle {
  /** O modelo (o `main.ts` lê as contagens daqui para o badge da status bar). */
  readonly model: ProblemsModel;
  /** Substitui a lista de diagnósticos. */
  update(diagnostics: readonly ProblemEntry[]): void;
  /** Define o filtro (e sincroniza o campo de busca). */
  setFilter(query: string): void;
  /** Remove o painel do DOM. */
  dispose(): void;
}

/** Ícones por severidade (o `currentColor` deixa a cor com o tema). */
const SEVERITY_ICONS: Readonly<Record<ProblemSeverity, string>> = {
  error:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/></svg>',
  warning:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.4l6 10.9H2z"/><path d="M8 6.6v3.1M8 11.4v.01"/></svg>',
  info:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v3.7M8 5.1v.01"/></svg>',
  hint:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2a4 4 0 00-2.4 7.2c.6.5.9 1.1.9 1.8h3c0-.7.3-1.3.9-1.8A4 4 0 008 2.2z"/><path d="M6.6 13h2.8"/></svg>',
};

/**
 * Monta o painel de problemas dentro do `host` (cria o DOM, devolve o handle).
 *
 * O `host` é quem controla a **visibilidade** (`host.hidden`): o painel só desenha.
 * Sem `host` (ou sem DOM — o renderer em modo demo/teste) devolve um handle **inerte**:
 * nada lança, o modelo continua funcionando (o badge da status bar ainda tem o que ler).
 */
export function mountProblemsPanel(
  host: HTMLElement | null | undefined,
  options: ProblemsPanelOptions = {},
): ProblemsPanelHandle {
  const model = new ProblemsModel();

  if (
    host === undefined ||
    host === null ||
    typeof document === "undefined" ||
    typeof host.appendChild !== "function"
  ) {
    // Degradação: sem DOM não há o que desenhar — o handle só guarda o estado.
    return {
      model,
      update(diagnostics: readonly ProblemEntry[]): void {
        model.setDiagnostics(diagnostics);
      },
      setFilter(query: string): void {
        model.setFilter(query);
      },
      dispose(): void {
        model.clear();
      },
    };
  }

  // O `host` já é um elemento (o `return` acima narrowing) — um `const` preserva o tipo
  // dentro das funções aninhadas (o `render`).
  const container: HTMLElement = host;

  // O painel só redesenha quando está **visível** (e redesenha quando aparece).
  const visibility = watchHostVisibility(container, (): void => {
    render();
  });

  const root = document.createElement("div");
  root.className = "problems-panel";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Problemas");
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

  // ── Cabeçalho ──────────────────────────────────────────────────────────────────────────────
  const head = document.createElement("div");
  head.className = "problems-panel-head";
  head.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-2);",
    "padding: var(--s-space-1) var(--s-space-2);",
    "border-bottom: 1px solid var(--s-border);",
  ].join(" ");

  const title = document.createElement("span");
  title.className = "problems-panel-title";
  title.textContent = "Problemas";
  title.style.cssText = ["font-weight: 600;", "flex: 0 0 auto;"].join(" ");

  const counts = document.createElement("div");
  counts.className = "problems-panel-counts";
  counts.setAttribute("role", "status");
  counts.setAttribute("aria-live", "polite");
  counts.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-1);",
    "flex: 1 1 auto;",
    "min-width: 0;",
    "overflow: hidden;",
  ].join(" ");

  const closeButton = document.createElement("button");
  closeButton.className = "problems-panel-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Fechar painel de problemas");
  closeButton.textContent = "×";
  closeButton.style.cssText = [
    "flex: 0 0 auto;",
    "background: transparent;",
    "border: none;",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-lg);",
    "line-height: 1;",
    "cursor: pointer;",
  ].join(" ");

  head.append(title, counts, closeButton);

  // ── Filtro ────────────────────────────────────────────────────────────────────────────────
  const filter = document.createElement("input");
  filter.className = "problems-panel-filter";
  filter.type = "search";
  filter.placeholder = "Filtrar por mensagem ou arquivo";
  filter.setAttribute("aria-label", "Filtrar problemas");
  filter.autocomplete = "off";
  filter.spellcheck = false;
  filter.style.cssText = [
    "flex: 0 0 auto;",
    "width: 100%;",
    "box-sizing: border-box;",
    "padding: var(--s-space-1) var(--s-space-2);",
    "margin: var(--s-space-1) var(--s-space-2);",
    "background: var(--s-bg);",
    "color: var(--s-fg);",
    "border: 1px solid var(--s-border-strong);",
    "border-radius: var(--s-radius-sm);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-sm);",
  ].join(" ");

  // ── Lista ─────────────────────────────────────────────────────────────────────────────────
  const list = document.createElement("ul");
  list.className = "problems-panel-list";
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Lista de problemas");
  list.style.cssText = [
    "flex: 1 1 auto;",
    "min-height: 0;",
    "overflow-y: auto;",
    "margin: 0;",
    "padding: 0;",
    "list-style: none;",
  ].join(" ");

  root.append(head, filter, list);
  host.appendChild(root);

  closeButton.addEventListener("click", (): void => {
    options.onClose?.();
  });

  filter.addEventListener("input", (): void => {
    model.setFilter(filter.value);
    render();
    options.onFilterChange?.(filter.value);
  });

  filter.addEventListener("keydown", (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    // O `Esc` é do painel: não deixa o editor tratá-lo.
    event.stopPropagation();
    options.onClose?.();
  });

  /** Os grupos em que um arquivo está recolhido (o clique no cabeçalho do arquivo). */
  const collapsed = new Set<string>();
  /** Contador de ids (o `aria-controls` do cabeçalho aponta para a lista do grupo). */
  let groupSeq = 0;

  /** Desenha a contagem do cabeçalho (só as severidades que existem). */
  function renderCounts(): void {
    const visible = model.visibleCounts;
    counts.replaceChildren();
    for (const severity of SEVERITY_ORDER) {
      const value = visible[severity];
      if (value === 0) continue;
      const chip = document.createElement("span");
      chip.className = `problems-count problems-count--${severity}`;
      chip.dataset["severity"] = severity;
      chip.textContent = String(value);
      chip.title = `${value} ${severityLabel(severity).toLowerCase()}`;
      chip.setAttribute("aria-label", `${value} ${severityLabel(severity).toLowerCase()}`);
      chip.style.cssText = [
        "font-size: var(--s-fs-xs);",
        "font-family: var(--s-font-mono);",
        "padding: 0 var(--s-space-1);",
        "border-radius: var(--s-radius-sm);",
        "border: 1px solid var(--s-border);",
      ].join(" ");
      counts.appendChild(chip);
    }
    if (visible.total === 0) {
      const empty = document.createElement("span");
      empty.className = "problems-count problems-count--total";
      empty.textContent = "0";
      empty.style.cssText = ["font-size: var(--s-fs-xs);", "color: var(--s-muted);"].join(" ");
      counts.appendChild(empty);
    }
  }

  /** Desenha um item de diagnóstico (a linha da lista). */
  function renderItem(item: ProblemItem): HTMLElement {
    const row = document.createElement("li");
    row.className = "problems-item";
    row.setAttribute("role", "listitem");

    const button = document.createElement("button");
    button.className = "problems-item-button";
    button.type = "button";
    button.title = `${item.path}:${item.line + 1}:${item.column + 1} — ${item.message}`;
    button.style.cssText = [
      "display: flex;",
      "align-items: baseline;",
      "gap: var(--s-space-2);",
      "width: 100%;",
      "text-align: left;",
      "background: transparent;",
      "border: none;",
      "color: var(--s-fg-muted);",
      "font-family: var(--s-font-ui);",
      "font-size: var(--s-fs-xs);",
      "padding: 1px var(--s-space-2);",
      "cursor: pointer;",
    ].join(" ");

    const icon = document.createElement("span");
    icon.className = `problems-item-icon problems-item-icon--${item.severity}`;
    icon.innerHTML = SEVERITY_ICONS[item.severity];
    icon.style.cssText = ["flex: 0 0 auto;", "display: inline-flex;", "align-items: center;"].join(" ");

    const severity = document.createElement("span");
    severity.className = `problems-item-severity problems-item-severity--${item.severity}`;
    severity.textContent = severityLabel(item.severity);
    severity.style.cssText = ["flex: 0 0 auto;", "min-width: 4.5em;"].join(" ");

    const location = document.createElement("span");
    location.className = "problems-item-location";
    location.textContent = formatLocation(item);
    location.style.cssText = [
      "flex: 0 0 auto;",
      "font-family: var(--s-font-mono);",
      "color: var(--s-subtle);",
    ].join(" ");

    const message = document.createElement("span");
    message.className = "problems-item-message";
    message.textContent = item.message;
    message.style.cssText = [
      "flex: 1 1 auto;",
      "min-width: 0;",
      "overflow: hidden;",
      "text-overflow: ellipsis;",
      "white-space: nowrap;",
    ].join(" ");

    button.append(icon, severity, location, message);

    if (item.source.length > 0) {
      const source = document.createElement("span");
      source.className = "problems-item-source";
      source.textContent = item.source;
      source.style.cssText = ["flex: 0 0 auto;", "color: var(--s-subtle);"].join(" ");
      button.appendChild(source);
    }

    button.addEventListener("click", (): void => {
      options.onJump?.(item.path, item.line, item.column);
    });

    row.appendChild(button);
    return row;
  }

  /** Desenha um grupo (um arquivo e seus diagnósticos). */
  function renderGroup(group: ProblemFileGroup): HTMLElement {
    const wrapper = document.createElement("li");
    wrapper.className = "problems-group";
    wrapper.setAttribute("role", "listitem");

    const groupHead = document.createElement("button");
    groupHead.className = "problems-group-head";
    groupHead.type = "button";
    groupHead.title = group.path;
    groupHead.style.cssText = [
      "display: flex;",
      "align-items: baseline;",
      "gap: var(--s-space-2);",
      "width: 100%;",
      "text-align: left;",
      "background: transparent;",
      "border: none;",
      "color: var(--s-fg);",
      "font-family: var(--s-font-ui);",
      "font-size: var(--s-fs-sm);",
      "font-weight: 600;",
      "padding: var(--s-space-1) var(--s-space-2);",
      "cursor: pointer;",
    ].join(" ");

    const name = document.createElement("span");
    name.className = "problems-group-name";
    name.textContent = group.name;
    name.style.cssText = [
      "flex: 1 1 auto;",
      "min-width: 0;",
      "overflow: hidden;",
      "text-overflow: ellipsis;",
      "white-space: nowrap;",
    ].join(" ");

    const groupCount = document.createElement("span");
    groupCount.className = "problems-group-count";
    groupCount.textContent = String(group.count);
    groupCount.style.cssText = ["flex: 0 0 auto;", "color: var(--s-muted);", "font-weight: 400;"].join(
      " ",
    );

    groupHead.append(name, groupCount);

    const items = document.createElement("ul");
    items.className = "problems-group-items";
    items.id = `problems-group-items-${(groupSeq += 1)}`;
    items.setAttribute("role", "list");
    items.style.cssText = ["margin: 0;", "padding: 0;", "list-style: none;"].join(" ");

    for (const item of group.items) items.appendChild(renderItem(item));

    const isCollapsed = collapsed.has(group.path);
    groupHead.setAttribute("aria-expanded", String(!isCollapsed));
    groupHead.setAttribute("aria-controls", items.id);
    wrapper.classList.toggle("problems-group--collapsed", isCollapsed);
    items.hidden = isCollapsed;

    groupHead.addEventListener("click", (): void => {
      if (collapsed.has(group.path)) collapsed.delete(group.path);
      else collapsed.add(group.path);
      render();
    });

    wrapper.append(groupHead, items);
    return wrapper;
  }

  /** Desenha o painel inteiro (cabeçalho + lista). */
  function render(): void {
    // Escondido (`host.hidden`) ⇒ **não** redesenha: o DOM fica sujo e é redesenhado
    // quando o host ficar visível (evita rebuild a cada diagnóstico).
    if (visibility.hidden) {
      visibility.markDirty();
      return;
    }
    visibility.markClean();
    renderCounts();
    list.replaceChildren();

    const groups = model.groups;
    if (groups.length === 0) {
      const empty = document.createElement("li");
      empty.className = "problems-panel-empty";
      empty.setAttribute("role", "listitem");
      empty.textContent =
        model.filterQuery.trim().length > 0
          ? "Nenhum problema corresponde ao filtro"
          : "Nenhum problema";
      empty.style.cssText = [
        "padding: var(--s-space-2);",
        "color: var(--s-muted);",
        "font-size: var(--s-fs-xs);",
      ].join(" ");
      list.appendChild(empty);
      return;
    }

    for (const group of groups) list.appendChild(renderGroup(group));
  }

  render();

  return {
    model,
    update(diagnostics: readonly ProblemEntry[]): void {
      model.setDiagnostics(diagnostics);
      render();
    },
    setFilter(query: string): void {
      model.setFilter(query);
      filter.value = query;
      render();
    },
    dispose(): void {
      visibility.dispose();
      root.remove();
      model.clear();
    },
  };
}
