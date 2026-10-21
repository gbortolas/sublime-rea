/**
 * Scribe — popup de **escolha** de snippet (`${1|a,b,c|}`).
 *
 * Overlay DOM **autocontido** (não depende de `index.css`: o estilo é inline, como os outros
 * popups do renderer) que lista as opções de uma tab stop com **escolha**, marca a opção
 * selecionada e navega com **setas**; **Enter** escolhe, **Esc** cancela e um **clique** na
 * opção escolhe. O popup é montado no `#ui-overlay` (fallback: `document.body`), posicionado
 * perto do caret quando `x`/`y` são informados, e **sai do DOM** ao ser fechado.
 *
 * O listener de teclado é registrado em `document` na fase **capture** e chama
 * `stopPropagation()` — assim o editor (que ouve `keydown` na fase bubble) não vê as teclas do
 * popup (Enter não insere linha, Esc não encerra a sessão de snippet).
 *
 * A **lógica** (índice inicial, movimento com setas) é pura e testável sem DOM — o ambiente de
 * teste do projeto roda em Node (`environment: "node"`), sem jsdom.
 */

/** Opções e callbacks do popup de escolha. */
export interface SnippetChoicePopupOptions {
  /** Opções a listar (na ordem do template). */
  readonly choices: readonly string[];
  /** Chamado com o índice da opção escolhida (o popup já saiu do DOM). */
  readonly onPick: (index: number) => void;
  /** Chamado quando o usuário cancela (Esc) — o popup já saiu do DOM. */
  readonly onCancel: () => void;
  /** Posição horizontal do caret (px) — o popup abre perto dele. */
  readonly x?: number;
  /** Posição vertical do caret (px) — o popup abre perto dele. */
  readonly y?: number;
}

/**
 * Índice inicial da lista de opções (`0` = 1ª opção). `-1` quando não há opções.
 */
export function initialChoiceIndex(count: number): number {
  return count > 0 ? 0 : -1;
}

/**
 * Move a seleção em `delta` posições, com **clamp** nos limites da lista.
 * `-1` quando não há opções.
 */
export function moveChoiceIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= count) return count - 1;
  return next;
}

/** Popup aberto (estado do módulo — só um por vez). */
interface ActiveChoice {
  readonly popup: HTMLElement;
  readonly list: HTMLElement;
  readonly options: SnippetChoicePopupOptions;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  /** Índice da opção em foco (0-based). */
  selected: number;
}

let active: ActiveChoice | null = null;

/** `true` quando há DOM disponível (o módulo é usado no renderer; em Node, não). */
function hasDom(): boolean {
  return typeof document !== "undefined" && document !== null;
}

/** Remove o popup do DOM e desliga o listener (sem chamar callback). */
function teardown(): void {
  const current = active;
  if (current === null) return;
  active = null;
  document.removeEventListener("keydown", current.onKeyDown, true);
  current.popup.remove();
}

/** Repinta a lista marcando a opção selecionada. */
function renderSelection(): void {
  const current = active;
  if (current === null) return;
  const items = current.list.children;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    const selected = i === current.selected;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-selected", String(selected));
    item.style.background = selected ? "var(--highlight, #094771)" : "";
  }
}

/** Escolhe a opção `index` (sai do DOM **antes** do callback). */
function pick(index: number): void {
  const current = active;
  if (current === null) return;
  if (!Number.isInteger(index) || index < 0 || index >= current.options.choices.length) return;
  teardown();
  current.options.onPick(index);
}

/** Cancela (sai do DOM **antes** do callback). */
function cancel(): void {
  const current = active;
  if (current === null) return;
  teardown();
  current.options.onCancel();
}

/**
 * Abre o popup de escolha.
 *
 * Substitui um popup aberto (o anterior some do DOM **sem** `onCancel`). Sem DOM disponível
 * (Node/testes), a chamada é um no-op.
 */
export function showSnippetChoice(options: SnippetChoicePopupOptions): void {
  if (!hasDom()) return;
  if (active !== null) teardown();

  const popup = document.createElement("div");
  popup.id = "snippet-choice-popup";
  popup.className = "snippet-choice-popup";
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "Escolha do snippet");
  popup.tabIndex = -1;
  popup.style.cssText = [
    "position: fixed;",
    "z-index: 200;",
    "min-width: 160px;",
    "max-width: 420px;",
    "max-height: 240px;",
    "overflow-y: auto;",
    "padding: 4px;",
    "background: var(--bg-overlay, #252526);",
    "border: 1px solid var(--border, #3c3c3c);",
    "border-radius: 6px;",
    "box-shadow: 0 8px 24px rgba(0,0,0,.45);",
    "color: var(--fg, #ccc);",
    "font-family: inherit;",
    "font-size: 13px;",
  ].join(" ");

  if (options.x !== undefined && options.y !== undefined) {
    popup.style.left = `${options.x}px`;
    popup.style.top = `${options.y}px`;
  } else {
    popup.style.left = "50%";
    popup.style.top = "80px";
    popup.style.transform = "translateX(-50%)";
  }

  const list = document.createElement("div");
  list.className = "snippet-choice-list";
  list.setAttribute("role", "presentation");
  popup.appendChild(list);

  options.choices.forEach((choice, index) => {
    const item = document.createElement("div");
    item.className = "snippet-choice-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.textContent = choice;
    item.style.cssText = [
      "padding: 4px 8px;",
      "border-radius: 3px;",
      "cursor: pointer;",
      "white-space: pre;",
      "overflow: hidden;",
      "text-overflow: ellipsis;",
    ].join(" ");
    item.addEventListener("mousedown", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pick(index);
    });
    list.appendChild(item);
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    const current = active;
    if (current === null) return;
    const count = current.options.choices.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        event.stopPropagation();
        current.selected = moveChoiceIndex(current.selected, 1, count);
        renderSelection();
        break;
      case "ArrowUp":
        event.preventDefault();
        event.stopPropagation();
        current.selected = moveChoiceIndex(current.selected, -1, count);
        renderSelection();
        break;
      case "Home":
        event.preventDefault();
        event.stopPropagation();
        current.selected = moveChoiceIndex(current.selected, 0, count);
        renderSelection();
        break;
      case "End":
        event.preventDefault();
        event.stopPropagation();
        current.selected = moveChoiceIndex(current.selected, count - 1, count);
        renderSelection();
        break;
      case "Enter":
      case "Tab":
        event.preventDefault();
        event.stopPropagation();
        pick(current.selected);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        cancel();
        break;
      default:
        break;
    }
  };

  active = {
    popup,
    list,
    options,
    onKeyDown,
    selected: initialChoiceIndex(options.choices.length),
  };

  const host = document.getElementById("ui-overlay") ?? document.body;
  host.appendChild(popup);
  document.addEventListener("keydown", onKeyDown, true);
  renderSelection();
  popup.focus();
}

/**
 * Fecha o popup (chama `onCancel` do popup aberto). Sem popup aberto, é um no-op.
 */
export function hideSnippetChoice(): void {
  if (active === null) return;
  cancel();
}

/** `true` enquanto há um popup de escolha aberto. */
export function isSnippetChoiceVisible(): boolean {
  return active !== null;
}
