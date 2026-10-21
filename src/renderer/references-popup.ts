/**
 * Scribe — popup de referências LSP (Find References).
 *
 * Overlay DOM acionado por Ctrl+Shift+F12 que lista arquivo + linha + coluna
 * de cada referência do símbolo sob o cursor. Filtro por texto, navegação
 * com setas/Enter/Esc. Ao clicar/Enter, o caret navega para a posição.
 */
import type { LspLocation } from "../shared";

export interface ReferencesPopupBinding {
  readonly isOpen: boolean;
  open(refs: LspLocation[], onSelect: (loc: LspLocation) => void): void;
  close(): void;
  dispose(): void;
}

/**
 * Alterna a visibilidade do popup.
 *
 * `hidden` é a **única fonte da verdade**: o atributo é colocado/removido e o CSS global
 * (`[hidden]{display:none!important}`) vence o `display:flex` inline do popup — sem isso o
 * popup aparecia no boot. O `display` inline não é alternado aqui.
 */
function setVisible(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

export function createReferencesPopup(): ReferencesPopupBinding {
  let isOpenValue = false;
  let allItems: LspLocation[] = [];
  let selectedIndex = 0;
  let filtered: LspLocation[] = [];
  let onSelect: ((loc: LspLocation) => void) | undefined;

  // Cria o DOM do popup dinamicamente
  const popup = document.createElement("div");
  popup.id = "references-popup";
  popup.className = "scribe-panel";
  popup.role = "dialog";
  popup.setAttribute("aria-label", "Referências do símbolo");
  popup.hidden = true;
  popup.style.cssText = [
    "position: absolute;",
    "top: 80px;",
    "left: 50%;",
    "transform: translateX(-50%);",
    // `min()` ⇒ o popup não ultrapassa a borda em janelas estreitas.
    "width: min(480px, calc(100% - 32px));",
    "max-height: 320px;",
    "background: var(--bg-overlay);",
    "border: 1px solid var(--border);",
    "border-radius: 6px;",
    "box-shadow: var(--s-shadow);",
    "display: flex;",
    "flex-direction: column;",
    "z-index: var(--z-panel);",
    "color: var(--fg);",
    "font-family: inherit;",
    "font-size: 13px;",
    // O pai (`#ui-overlay`) é `pointer-events:none` — sem isto o popup é inerte
    // (o input do filtro não recebia foco por clique e os itens não clicavam).
    "pointer-events: auto;",
  ].join(" ");
  setVisible(popup, false);

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Filtrar referências\u2026";
  input.setAttribute("aria-label", "Filtrar referências");
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText = [
    "margin: 8px;",
    "padding: 6px 8px;",
    "border: 1px solid var(--border);",
    "border-radius: 4px;",
    "background: var(--bg-input);",
    "color: var(--fg);",
    "font-family: inherit;",
    "font-size: 13px;",
    "outline: none;",
  ].join(" ");
  popup.appendChild(input);

  const list = document.createElement("div");
  list.role = "listbox";
  list.style.cssText = [
    "overflow-y: auto;",
    "flex: 1;",
    "padding: 0 4px 4px;",
  ].join(" ");
  popup.appendChild(list);

  // Injeta no overlay
  const overlay = document.getElementById("ui-overlay");
  if (overlay) {
    overlay.appendChild(popup);
  }

  function filterItems(): void {
    const lower = input.value.toLowerCase();
    filtered = lower.length === 0
      ? [...allItems]
      : allItems.filter((loc) => {
          const label = `${loc.uri}:${loc.range.startLine + 1}:${loc.range.startCol + 1}`;
          return label.toLowerCase().includes(lower);
        });
    selectedIndex = 0;
    render();
  }

  function render(): void {
    list.replaceChildren();
    for (let i = 0; i < filtered.length; i++) {
      const loc = filtered[i]!;
      const el = document.createElement("div");
      el.className = `ref-item${i === selectedIndex ? " selected" : ""}`;
      el.role = "option";
      el.setAttribute("aria-selected", String(i === selectedIndex));
      el.style.cssText = [
        "padding: 4px 8px;",
        "cursor: pointer;",
        "border-radius: 3px;",
        "display: flex;",
        "align-items: center;",
        "gap: 6px;",
        i === selectedIndex ? "background: var(--highlight);" : "",
      ].join(" ");

      // Ícone de referência (seta de retorno)
      const icon = document.createElement("span");
      icon.innerHTML = [
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none"',
        'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">',
        '<path d="M3.5 8l3 3.5-3 3.5"/><path d="M6.5 11.5H10a3 3 0 000-6H8"/></svg>',
      ].join(" ");
      icon.style.cssText = "flex-shrink: 0; opacity: .7;";
      el.appendChild(icon);

      // Nome do arquivo (última parte do caminho)
      const nameSpan = document.createElement("span");
      const fileName = loc.uri.slice(loc.uri.lastIndexOf("/") + 1);
      nameSpan.textContent = fileName;
      nameSpan.style.cssText = [
        "font-weight: 600;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "white-space: nowrap;",
      ].join(" ");
      el.appendChild(nameSpan);

      // Linha : coluna
      const posSpan = document.createElement("span");
      posSpan.textContent = `${loc.range.startLine + 1}:${loc.range.startCol + 1}`;
      posSpan.style.cssText = "color: var(--fg-secondary); flex-shrink: 0;";
      el.appendChild(posSpan);

      // Path (para desambiguar arquivos com mesmo nome)
      const pathSpan = document.createElement("span");
      const dirPart = loc.uri.slice(0, loc.uri.lastIndexOf("/"));
      pathSpan.textContent = dirPart;
      pathSpan.style.cssText = [
        "color: var(--fg-tertiary);",
        "font-size: 11px;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "white-space: nowrap;",
        "flex: 1;",
        "direction: rtl;",
        "text-align: right;",
      ].join(" ");
      el.appendChild(pathSpan);

      el.addEventListener("mousedown", (e: MouseEvent) => {
        e.preventDefault();
        selectIndex(i);
        confirmSelection();
      });

      el.addEventListener("mouseenter", () => {
        selectIndex(i);
      });

      list.appendChild(el);
    }

    if (filtered.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.style.cssText = "padding: 16px 8px; text-align: center; color: var(--fg-secondary);";
      emptyEl.textContent = "Nenhuma referência encontrada";
      list.appendChild(emptyEl);
    }
  }

  function selectIndex(index: number): void {
    if (index < 0 || index >= filtered.length) return;
    selectedIndex = index;
    const children = list.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      if (i === selectedIndex) {
        child.style.background = "var(--highlight)";
        child.setAttribute("aria-selected", "true");
      } else {
        child.style.background = "";
        child.setAttribute("aria-selected", "false");
      }
    }
  }

  function confirmSelection(): void {
    const item = filtered[selectedIndex];
    if (item !== undefined && onSelect !== undefined) {
      onSelect(item);
    }
    close();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (!isOpenValue) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        selectIndex(Math.min(selectedIndex + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        selectIndex(Math.max(selectedIndex - 1, 0));
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        confirmSelection();
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
    }
  }

  function open(
    refs: LspLocation[],
    callback: (loc: LspLocation) => void,
  ): void {
    allItems = refs;
    selectedIndex = 0;
    onSelect = callback;
    isOpenValue = true;
    setVisible(popup, true);
    input.value = "";
    input.focus();
    filterItems();
    document.addEventListener("keydown", handleKeyDown);
  }

  function close(): void {
    if (!isOpenValue) return;
    setVisible(popup, false);
    allItems = [];
    filtered = [];
    onSelect = undefined;
    isOpenValue = false;
    input.value = "";
    document.removeEventListener("keydown", handleKeyDown);
  }

  function dispose(): void {
    close();
    list.replaceChildren();
    popup.remove();
  }

  input.addEventListener("input", () => {
    filterItems();
  });

  return {
    get isOpen(): boolean { return isOpenValue; },
    open,
    close,
    dispose,
  };
}