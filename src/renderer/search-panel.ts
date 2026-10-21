/**
 * Scribe — painel de resultados da **busca na workspace** (o "grep" do VS Code).
 *
 * O painel é **autocontido**: cria o próprio DOM dentro do `host` que o chamador passa
 * (mesma convenção do painel de depuração), cuida do foco e tem `dispose()`. Ele **não**
 * fala com a ponte: quem busca é o `main` (via IPC) — o painel só reflete o estado e
 * emite **intenções** (`onOpen`, `onQueryChange`, `onClose`).
 *
 * A lógica **pura** (agrupar por arquivo, descrever o estado) vive em funções exportadas
 * e **sem DOM** — é o que o vitest testa (o renderer não tem DOM no ambiente de teste).
 *
 * **Escolha nossa (não observada no alvo):** o alvo não expõe a busca em arquivos; aqui o
 * painel é uma coluna de resultados agrupados por arquivo, com a contagem de ocorrências.
 */
import type { GrepMatch, GrepResult } from "../core/workspace/grep";

/** Intenções emitidas pelo painel (o `main.ts` as traduz em IPC). */
export interface SearchPanelOptions {
  /**
   * O usuário clicou numa ocorrência ⇒ abrir o arquivo na posição.
   * `line`/`column` são **0-based** (mesma convenção do core).
   */
  readonly onOpen: (path: string, line: number, column: number) => void;
  /** O texto da busca mudou (o chamador decide o debounce e dispara a busca). */
  readonly onQueryChange?: (query: string) => void;
  /** O usuário pediu para fechar o painel. */
  readonly onClose?: () => void;
}

/** Superfície do painel (o `main.ts` só reflete o estado por aqui). */
export interface SearchPanelBinding {
  dispose(): void;
  setResults(result: GrepResult): void;
  setBusy(busy: boolean): void;
}

/** Um arquivo do resultado, com as ocorrências dele. */
export interface GrepFileGroup {
  /** Caminho completo do arquivo. */
  readonly path: string;
  /** Nome do arquivo (último segmento do caminho). */
  readonly name: string;
  /** Quantas ocorrências o arquivo tem. */
  readonly count: number;
  /** As ocorrências do arquivo (ordenadas por linha/coluna). */
  readonly matches: readonly GrepMatch[];
}

/** Estado do painel (o texto que vai para a barra de status). */
export type SearchPanelStatusKind = "busy" | "idle" | "empty" | "results" | "truncated";

/** Estado observável do painel. */
export interface SearchPanelStatus {
  readonly kind: SearchPanelStatusKind;
  /** Total de ocorrências (0 nos estados sem resultado). */
  readonly total: number;
  /** Quantos arquivos têm ocorrência (0 nos estados sem resultado). */
  readonly files: number;
  /** Texto pronto para a UI (nunca a string interna do Scribe). */
  readonly text: string;
}

/** Último segmento de um caminho (o renderer não tem `node:path`). */
export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last === undefined || last.length === 0 ? path : last;
}

function compareByPosition(a: GrepMatch, b: GrepMatch): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

/**
 * Agrupa as ocorrências **por arquivo**.
 *
 * A ordem dos grupos é a da **1ª aparição** do arquivo (o core já entrega tudo ordenado
 * por `path`, então os grupos saem em ordem alfabética de caminho); dentro do grupo as
 * ocorrências ficam ordenadas por `(line, column)`.
 */
export function groupMatchesByFile(matches: readonly GrepMatch[]): readonly GrepFileGroup[] {
  const buckets = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const bucket = buckets.get(match.path);
    if (bucket === undefined) buckets.set(match.path, [match]);
    else bucket.push(match);
  }
  const groups: GrepFileGroup[] = [];
  for (const [path, bucket] of buckets) {
    const ordered = [...bucket].sort(compareByPosition);
    groups.push({ path, name: basenameOf(path), count: ordered.length, matches: ordered });
  }
  return groups;
}

/**
 * Descreve o estado do painel (a barra de status).
 *
 * - `busy` — busca em andamento;
 * - `idle` — ainda não houve busca;
 * - `empty` — a busca rodou e não achou nada;
 * - `results` — N ocorrências em M arquivos;
 * - `truncated` — o resultado está incompleto (bateu no teto).
 */
export function describeSearchStatus(
  result: GrepResult | undefined,
  busy: boolean,
): SearchPanelStatus {
  if (busy) return { kind: "busy", total: 0, files: 0, text: "Buscando…" };
  if (result === undefined) {
    return { kind: "idle", total: 0, files: 0, text: "Buscar em todos os arquivos" };
  }
  const total = result.matches.length;
  if (total === 0) return { kind: "empty", total: 0, files: 0, text: "Nenhum resultado" };
  const files = new Set(result.matches.map((match) => match.path)).size;
  const head = `${total} ${total === 1 ? "resultado" : "resultados"} em ${files} ${
    files === 1 ? "arquivo" : "arquivos"
  }`;
  if (result.truncated) {
    return { kind: "truncated", total, files, text: `${head} (resultado truncado)` };
  }
  return { kind: "results", total, files, text: head };
}

/** Teto de caracteres exibidos por ocorrência (o resto fica no `title`). */
const MAX_HIT_CHARS = 400;

function ellipsize(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Anexa o painel de busca ao `host` (cria o DOM, cuida do foco, devolve o binding).
 *
 * O `host` é quem controla a **visibilidade** (`host.hidden`): o painel só desenha.
 */
export function attachSearchPanel(
  host: HTMLElement,
  options: SearchPanelOptions,
): SearchPanelBinding {
  const root = document.createElement("div");
  root.className = "search-panel";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Busca na workspace");
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

  const head = document.createElement("div");
  head.className = "search-panel-head";
  head.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-1);",
    "padding: var(--s-space-2);",
    "border-bottom: 1px solid var(--s-border);",
  ].join(" ");

  const input = document.createElement("input");
  input.className = "search-panel-input";
  input.type = "text";
  input.placeholder = "Buscar em todos os arquivos";
  input.setAttribute("aria-label", "Buscar em todos os arquivos");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText = [
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

  const closeButton = document.createElement("button");
  closeButton.className = "search-panel-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Fechar busca");
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

  head.append(input, closeButton);

  const status = document.createElement("div");
  status.className = "search-panel-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.style.cssText = [
    "padding: var(--s-space-1) var(--s-space-2);",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-xs);",
  ].join(" ");

  const results = document.createElement("div");
  results.className = "search-panel-results";
  results.style.cssText = ["flex: 1 1 auto;", "min-height: 0;", "overflow-y: auto;"].join(" ");

  root.append(head, status, results);
  host.appendChild(root);

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

  input.addEventListener("input", (): void => {
    options.onQueryChange?.(input.value);
  });
  input.addEventListener("keydown", (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    // O `Esc` é do painel: não deixa o editor tratá-lo (o find bar também escuta).
    event.stopPropagation();
    options.onClose?.();
  });
  closeButton.addEventListener("click", (): void => {
    options.onClose?.();
  });

  let busy = false;
  let result: GrepResult | undefined;
  let groups: readonly GrepFileGroup[] = [];

  const render = (): void => {
    const info = describeSearchStatus(result, busy);
    status.textContent = info.text;
    results.replaceChildren();
    if (busy) {
      const spinner = document.createElement("div");
      spinner.className = "search-panel-busy";
      spinner.textContent = "Buscando…";
      spinner.style.cssText = ["padding: var(--s-space-2);", "color: var(--s-muted);"].join(" ");
      results.appendChild(spinner);
      return;
    }
    for (const group of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "search-panel-group";
      groupEl.setAttribute("role", "group");

      const fileEl = document.createElement("div");
      fileEl.className = "search-panel-file";
      fileEl.title = group.path;
      fileEl.style.cssText = [
        "display: flex;",
        "align-items: baseline;",
        "gap: var(--s-space-2);",
        "padding: var(--s-space-1) var(--s-space-2);",
        "font-weight: 600;",
      ].join(" ");

      const nameEl = document.createElement("span");
      nameEl.className = "search-panel-file-name";
      nameEl.textContent = group.name;
      nameEl.style.cssText = ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"].join(
        " ",
      );

      const countEl = document.createElement("span");
      countEl.className = "search-panel-file-count";
      countEl.textContent = String(group.count);
      countEl.style.cssText = [
        "color: var(--s-muted);",
        "font-weight: 400;",
        "font-size: var(--s-fs-xs);",
      ].join(" ");

      fileEl.append(nameEl, countEl);
      groupEl.appendChild(fileEl);

      for (const match of group.matches) {
        const hit = document.createElement("button");
        hit.className = "search-panel-hit";
        hit.type = "button";
        hit.title = `${group.path}:${match.line + 1}`;
        hit.style.cssText = [
          "display: flex;",
          "gap: var(--s-space-2);",
          "width: 100%;",
          "text-align: left;",
          "background: transparent;",
          "border: none;",
          "color: var(--s-fg-muted);",
          "font-family: var(--s-font-mono);",
          "font-size: var(--s-fs-xs);",
          "padding: 1px var(--s-space-2);",
          "cursor: pointer;",
        ].join(" ");

        const lineEl = document.createElement("span");
        lineEl.className = "search-panel-hit-line";
        lineEl.textContent = String(match.line + 1);
        lineEl.style.cssText = ["flex: 0 0 auto;", "color: var(--s-subtle);"].join(" ");

        const textEl = document.createElement("span");
        textEl.className = "search-panel-hit-text";
        const display = ellipsize(match.text.trim(), MAX_HIT_CHARS);
        textEl.textContent = display;
        textEl.title = match.text;
        textEl.style.cssText = [
          "flex: 1 1 auto;",
          "min-width: 0;",
          "overflow: hidden;",
          "text-overflow: ellipsis;",
          "white-space: pre;",
        ].join(" ");

        hit.append(lineEl, textEl);
        hit.addEventListener("click", (): void => {
          options.onOpen(match.path, match.line, match.column);
        });
        hit.addEventListener("mouseenter", (): void => {
          hit.style.backgroundColor = "var(--s-hover)";
        });
        hit.addEventListener("mouseleave", (): void => {
          hit.style.backgroundColor = "transparent";
        });
        groupEl.appendChild(hit);
      }
      results.appendChild(groupEl);
    }
  };

  render();

  // Foco: só toma o foco se ninguém estiver com ele (o painel do editor não é roubado).
  if (!host.hidden) {
    const active = document.activeElement;
    if (active === null || active === document.body) input.focus();
  }

  return {
    dispose(): void {
      // Devolve o foco a quem tinha antes (se o painel estava com o foco).
      if (previousFocus !== undefined && document.activeElement === input) previousFocus.focus();
      root.remove();
    },
    setResults(next: GrepResult): void {
      result = next;
      groups = groupMatchesByFile(next.matches);
      render();
    },
    setBusy(next: boolean): void {
      busy = next;
      render();
    },
  };
}
