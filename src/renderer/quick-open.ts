/**
 * Scribe — **Quick Open** (⌘P / Ctrl+P): busca fuzzy de **arquivos**, **comandos** e
 * **recentes**, com navegação por teclado e **pré-visualização** do item selecionado.
 *
 * Overlay DOM **autocontido** (mesmo padrão do `snippet-choice.ts`): o módulo cria o DOM,
 * cuida do foco e devolve o controle — quem chama é o `main.ts` (que monta os itens e
 * decide o que fazer com o item escolhido).
 *
 * A **lógica** (a ordenação por *fuzzy score*) é uma função **pura** (`rankQuickOpenItems`),
 * testável sem DOM — o ambiente de teste do projeto roda em Node (`environment: "node"`),
 * sem jsdom.
 *
 * O teclado é lido **no input** (o popup precisa que os caracteres cheguem nele) e o
 * `stopPropagation()` impede que as teclas vazem para os atalhos globais do renderer
 * (enquanto o popup está aberto, ele é o dono do teclado).
 */
import { fuzzyScore, type FuzzyMatch } from "../core/workspace/file-index";

/** Um item do Quick Open (arquivo, comando ou recente). */
export interface QuickOpenItem {
  /** Identificador estável do item (caminho, id do comando…). */
  readonly id: string;
  /** Rótulo mostrado em destaque (o nome do arquivo, o rótulo do comando). */
  readonly label: string;
  /** Contexto secundário (o caminho relativo, a categoria do comando). */
  readonly description?: string;
  /** A natureza do item — muda o selo na lista. */
  readonly kind: "file" | "command" | "recent";
  /** O dado cru (caminho absoluto, id do comando…) — o `main.ts` é quem o interpreta. */
  readonly payload?: unknown;
}

/** Opções do popup. */
export interface QuickOpenOptions {
  /**
   * Os itens da lista.
   *
   * A **ordem** importa quando a query está vazia: os "recentes" (`kind: "recent"`) devem
   * vir **primeiro** (é o que o *Quick Open* mostra ao abrir). Com query, a lista é
   * reordenada pelo *fuzzy score*.
   */
  readonly items: readonly QuickOpenItem[];
  /** Chamado com o item escolhido (o popup já saiu do DOM). */
  readonly onPick: (item: QuickOpenItem) => void;
  /** Chamado quando o usuário cancela (Esc) — o popup já saiu do DOM. */
  readonly onCancel: () => void;
  /** Título exibido no popup (e usado como *placeholder* do input). */
  readonly title?: string;
  /**
   * Carrega o conteúdo a **pré-visualizar** do item selecionado (opcional).
   *
   * Devolve `undefined` (ou uma promessa rejeitada) quando não há o que pré-visualizar.
   * A carga é **assíncrona** (o `main.ts` lê o arquivo) e a corrida é resolvida por um
   * token — uma resposta atrasada de um item já desselecionado é descartada.
   */
  readonly loadPreview?: (item: QuickOpenItem) => Promise<string | undefined>;
}

/** Item classificado pelo *fuzzy* (com a origem da casa). */
export interface QuickOpenMatch {
  readonly item: QuickOpenItem;
  readonly match: FuzzyMatch;
  /** De onde veio a casa: o rótulo ou a descrição. */
  readonly source: "label" | "description";
}

/** Nº máximo de linhas desenhadas na lista (o resto fica no índice, não no DOM). */
const MAX_VISIBLE_ROWS = 100;

/** Nº máximo de linhas pré-visualizadas. */
const MAX_PREVIEW_LINES = 200;

/**
 * Classifica os itens pela query (fuzzy) e **ordena** por score decrescente.
 *
 * A casa é procurada **primeiro no rótulo** (é o mais específico) e, se não houver,
 * na **descrição** (o caminho relativo) — é o que faz "fb" achar "foo/bar.ts".
 *
 * Query vazia ⇒ **todos** os itens, na **ordem original** (os recentes primeiro).
 */
export function rankQuickOpenItems(
  query: string,
  items: readonly QuickOpenItem[],
): readonly QuickOpenMatch[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return items.map((item) => ({ item, match: { score: 0, indices: [] }, source: "label" }));
  }

  const hits: { hit: QuickOpenMatch; order: number }[] = [];
  items.forEach((item, order) => {
    const labelMatch = fuzzyScore(trimmed, item.label);
    if (labelMatch !== undefined) {
      hits.push({ hit: { item, match: labelMatch, source: "label" }, order });
      return;
    }
    if (item.description !== undefined) {
      const descriptionMatch = fuzzyScore(trimmed, item.description);
      if (descriptionMatch !== undefined) {
        hits.push({ hit: { item, match: descriptionMatch, source: "description" }, order });
      }
    }
  });

  return hits
    .sort((a, b) => b.hit.match.score - a.hit.match.score || a.order - b.order)
    .map((wrapped) => wrapped.hit);
}

/** Selo curto da natureza do item. */
function kindBadge(kind: QuickOpenItem["kind"]): string {
  switch (kind) {
    case "file":
      return "ARQ";
    case "command":
      return "CMD";
    case "recent":
      return "REC";
    default:
      return "";
  }
}

/** Popup aberto (estado do módulo — só um por vez). */
interface ActiveQuickOpen {
  readonly popup: HTMLElement;
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
  readonly preview: HTMLElement;
  readonly counter: HTMLElement;
  readonly options: QuickOpenOptions;
  readonly onInput: () => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  readonly onDocumentMouseDown: (event: MouseEvent) => void;
  /** Itens classificados (o filtro é recalculado a cada tecla). */
  ranked: readonly QuickOpenMatch[];
  /** Índice do item selecionado (0-based) dentro de `ranked`. */
  selected: number;
  /** Token da carga de pré-visualização (descarta respostas obsoletas). */
  previewToken: number;
  /** Id do item cuja pré-visualização já foi pedida (evita reler a cada tecla). */
  previewItemId: string | undefined;
}

let active: ActiveQuickOpen | null = null;

/** `true` quando há DOM disponível (o módulo é usado no renderer; em Node, não). */
function hasDom(): boolean {
  return typeof document !== "undefined" && document !== null;
}

/** Devolve o foco ao canvas do editor (é lá que o teclado do editor é lido). */
function focusEditorSurface(): void {
  document.getElementById("editor-surface")?.focus();
}

/** Remove o popup do DOM e desliga os listeners (sem chamar callback). */
function teardown(): void {
  const current = active;
  if (current === null) return;
  active = null;
  current.input.removeEventListener("input", current.onInput);
  current.input.removeEventListener("keydown", current.onKeyDown);
  document.removeEventListener("mousedown", current.onDocumentMouseDown, true);
  current.popup.remove();
}

/** Desenha o texto com os caracteres casados destacados. */
function renderHighlighted(parent: HTMLElement, text: string, indices: readonly number[]): void {
  if (indices.length === 0) {
    parent.textContent = text;
    return;
  }
  const marked = new Set(indices);
  let buffer = "";
  const flush = (): void => {
    if (buffer.length === 0) return;
    parent.appendChild(document.createTextNode(buffer));
    buffer = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    if (!marked.has(i)) {
      buffer += text.charAt(i);
      continue;
    }
    flush();
    const highlight = document.createElement("span");
    highlight.className = "quick-open-hl";
    highlight.style.cssText = "color: var(--s-accent); font-weight: 600;";
    highlight.textContent = text.charAt(i);
    parent.appendChild(highlight);
  }
  flush();
}

/** Repinta a lista (a partir do estado `ranked`/`selected`). */
function renderList(): void {
  const current = active;
  if (current === null) return;
  const { list, ranked, selected } = current;
  list.innerHTML = "";

  const visible = ranked.slice(0, MAX_VISIBLE_ROWS);
  visible.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "quick-open-item";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selected));
    row.setAttribute("data-index", String(index));
    if (index === selected) {
      row.style.background = "var(--s-selected)";
    }

    const badge = document.createElement("span");
    badge.className = "quick-open-badge";
    badge.style.cssText = [
      "flex: 0 0 auto;",
      "font-size: var(--s-fs-xs);",
      "color: var(--s-muted);",
      "text-transform: uppercase;",
      "letter-spacing: 0.04em;",
    ].join(" ");
    badge.textContent = kindBadge(entry.item.kind);
    row.appendChild(badge);

    const label = document.createElement("span");
    label.className = "quick-open-label";
    label.style.cssText = "flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis;";
    renderHighlighted(
      label,
      entry.item.label,
      entry.source === "label" ? entry.match.indices : [],
    );
    row.appendChild(label);

    if (entry.item.description !== undefined && entry.item.description.length > 0) {
      const description = document.createElement("span");
      description.className = "quick-open-desc";
      description.style.cssText = [
        "flex: 1 1 auto;",
        "min-width: 0;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "color: var(--s-muted);",
        "font-size: var(--s-fs-sm);",
      ].join(" ");
      renderHighlighted(
        description,
        entry.item.description,
        entry.source === "description" ? entry.match.indices : [],
      );
      row.appendChild(description);
    }

    row.addEventListener("mousedown", (event: MouseEvent) => {
      event.preventDefault();
      pick(index);
    });
    list.appendChild(row);
  });

  const total = ranked.length;
  const shown = Math.min(total, MAX_VISIBLE_ROWS);
  current.counter.textContent =
    total === 0 ? "sem resultados" : shown < total ? `${shown} de ${total}` : `${total}`;

  const selectedRow = list.querySelector(".quick-open-item:nth-child(" + String(selected + 1) + ")");
  if (selectedRow !== null) selectedRow.scrollIntoView({ block: "nearest" });
}

/** Recalcula o filtro (a cada tecla) e repinta a lista. */
function refilter(): void {
  const current = active;
  if (current === null) return;
  current.ranked = rankQuickOpenItems(current.input.value, current.options.items);
  current.selected = 0;
  renderList();
  loadPreview();
}

/** Pede a pré-visualização do item selecionado (corrida resolvida por token). */
function loadPreview(): void {
  const current = active;
  if (current === null) return;
  const loader = current.options.loadPreview;
  const entry = current.ranked[current.selected];
  if (loader === undefined || entry === undefined) {
    current.previewToken += 1;
    current.previewItemId = undefined;
    current.preview.textContent = "";
    current.preview.hidden = true;
    return;
  }
  // Já pré-visualizado (o `refilter` roda a cada tecla): não relê o arquivo.
  if (current.previewItemId === entry.item.id) return;
  current.previewToken += 1;
  const token = current.previewToken;
  current.previewItemId = entry.item.id;
  current.preview.hidden = false;
  current.preview.textContent = "";
  void loader(entry.item)
    .then((content) => {
      if (active !== current || current.previewToken !== token) return; // resposta obsoleta
      if (content === undefined) {
        current.preview.textContent = "";
        return;
      }
      const lines = content.split(/\r?\n/).slice(0, MAX_PREVIEW_LINES);
      current.preview.textContent = lines.join("\n");
    })
    .catch((error: unknown) => {
      if (active !== current || current.previewToken !== token) return;
      current.previewItemId = undefined;
      current.preview.textContent = "";
      console.warn("Scribe: falha ao carregar a pré-visualização do Quick Open", error);
    });
}

/** Nº de itens navegáveis (o resto do ranking fica fora do DOM). */
function navigableCount(ranked: readonly QuickOpenMatch[]): number {
  return Math.min(ranked.length, MAX_VISIBLE_ROWS);
}

/** Move a seleção (com *wrap*). */
function moveSelection(delta: number): void {
  const current = active;
  if (current === null) return;
  const count = navigableCount(current.ranked);
  if (count === 0) return;
  current.selected = (current.selected + delta + count) % count;
  renderList();
  loadPreview();
}

/** Escolhe o item (sai do DOM **antes** do callback). */
function pick(index: number): void {
  const current = active;
  if (current === null) return;
  const entry = current.ranked[index];
  if (entry === undefined) return;
  teardown();
  focusEditorSurface();
  current.options.onPick(entry.item);
}

/** Cancela (sai do DOM **antes** do callback). */
function cancel(): void {
  const current = active;
  if (current === null) return;
  teardown();
  focusEditorSurface();
  current.options.onCancel();
}

/**
 * Abre o popup do Quick Open.
 *
 * Substitui um popup aberto (o anterior some do DOM **sem** `onCancel`). Sem DOM disponível
 * (Node/testes), a chamada é um no-op.
 */
export function showQuickOpen(options: QuickOpenOptions): void {
  if (!hasDom()) return;
  if (active !== null) teardown();

  const popup = document.createElement("div");
  popup.id = "quick-open";
  popup.className = "quick-open";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-modal", "true");
  popup.setAttribute("aria-label", options.title ?? "Quick Open");
  popup.style.cssText = [
    "position: fixed;",
    "top: 64px;",
    "left: 50%;",
    "transform: translateX(-50%);",
    `z-index: var(--z-modal);`,
    "width: min(760px, calc(100% - 32px));",
    "max-height: min(520px, calc(100% - 96px));",
    "display: flex;",
    "flex-direction: column;",
    "overflow: hidden;",
    "background: var(--s-surface-raised);",
    "border: 1px solid var(--s-border-strong);",
    "border-radius: var(--s-radius-lg);",
    "box-shadow: var(--s-shadow);",
    "color: var(--s-fg);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-md);",
  ].join(" ");

  const input = document.createElement("input");
  input.id = "quick-open-input";
  input.className = "quick-open-input";
  input.type = "text";
  input.placeholder = options.title ?? "Buscar arquivo, comando ou recente…";
  input.setAttribute("aria-label", options.title ?? "Quick Open");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText = [
    "width: 100%;",
    "padding: var(--s-space-3);",
    "border: none;",
    "border-bottom: 1px solid var(--s-border);",
    "background: transparent;",
    "color: var(--s-fg);",
    "font-family: inherit;",
    "font-size: var(--s-fs-lg);",
    "outline: none;",
  ].join(" ");
  popup.appendChild(input);

  const body = document.createElement("div");
  body.className = "quick-open-body";
  body.style.cssText = "display: flex; min-height: 0; flex: 1 1 auto;";
  popup.appendChild(body);

  const list = document.createElement("div");
  list.id = "quick-open-list";
  list.className = "quick-open-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Resultados");
  list.style.cssText = [
    "flex: 1 1 auto;",
    "min-width: 0;",
    "max-height: 380px;",
    "overflow-y: auto;",
    "padding: var(--s-space-1);",
  ].join(" ");
  body.appendChild(list);

  const preview = document.createElement("div");
  preview.id = "quick-open-preview";
  preview.className = "quick-open-preview";
  preview.setAttribute("aria-live", "polite");
  preview.hidden = true;
  preview.style.cssText = [
    "flex: 1 1 42%;",
    "min-width: 0;",
    "max-width: 46%;",
    "overflow: auto;",
    "padding: var(--s-space-3);",
    "border-left: 1px solid var(--s-border);",
    "color: var(--s-muted);",
    "font-family: var(--s-font-mono);",
    "font-size: var(--s-fs-sm);",
    "line-height: 1.45;",
    "white-space: pre;",
  ].join(" ");
  body.appendChild(preview);

  const footer = document.createElement("div");
  footer.className = "quick-open-foot";
  footer.style.cssText = [
    "display: flex;",
    "justify-content: space-between;",
    "gap: var(--s-space-2);",
    "padding: var(--s-space-1) var(--s-space-3);",
    "border-top: 1px solid var(--s-border);",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-xs);",
  ].join(" ");
  const hints = document.createElement("span");
  hints.textContent = "↑↓ navegar · Enter abrir · Tab completar · Esc fechar";
  footer.appendChild(hints);
  const counter = document.createElement("span");
  counter.className = "quick-open-counter";
  footer.appendChild(counter);
  popup.appendChild(footer);

  const onInput = (): void => {
    refilter();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const current = active;
    if (current === null) return;
    // O popup é o dono do teclado enquanto está aberto: as teclas não vazam para os
    // atalhos globais do renderer (Ctrl+F, Ctrl+Shift+P, …).
    event.stopPropagation();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        break;
      case "Home":
        event.preventDefault();
        current.selected = 0;
        renderList();
        loadPreview();
        break;
      case "End":
        event.preventDefault();
        current.selected = Math.max(0, navigableCount(current.ranked) - 1);
        renderList();
        loadPreview();
        break;
      case "Enter":
        event.preventDefault();
        pick(current.selected);
        break;
      case "Tab": {
        event.preventDefault();
        const entry = current.ranked[current.selected];
        if (entry === undefined) break;
        // Completa a query com o rótulo do item selecionado (o popup continua aberto).
        current.input.value = entry.item.label;
        refilter();
        break;
      }
      case "Escape":
        event.preventDefault();
        cancel();
        break;
      default:
        break;
    }
  };

  /** Clique **fora** do popup fecha (como um modal). */
  const onDocumentMouseDown = (event: MouseEvent): void => {
    const current = active;
    if (current === null) return;
    const target = event.target;
    if (target instanceof Node && current.popup.contains(target)) return;
    cancel();
  };

  active = {
    popup,
    input,
    list,
    preview,
    counter,
    options,
    onInput,
    onKeyDown,
    onDocumentMouseDown,
    ranked: [],
    selected: 0,
    previewToken: 0,
    previewItemId: undefined,
  };

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  document.addEventListener("mousedown", onDocumentMouseDown, true);

  const host = document.getElementById("ui-overlay") ?? document.body;
  host.appendChild(popup);

  refilter();
  input.focus();
}

/**
 * Fecha o popup (chama `onCancel` do popup aberto). Sem popup aberto, é um no-op.
 */
export function hideQuickOpen(): void {
  if (active === null) return;
  cancel();
}

/** `true` enquanto o popup do Quick Open está aberto. */
export function isQuickOpenVisible(): boolean {
  return active !== null;
}
