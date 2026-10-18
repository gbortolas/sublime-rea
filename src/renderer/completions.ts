/**
 * Scribe — widget de popup de completação (LSP).
 *
 * Overlay DOM sobre o canvas que mostra os itens de completação e permite
 * navegação por setas, seleção com Enter/Tab e fechamento com Escape.
 * Segue os mesmos padrões de `command-palette.ts` (DOM com pointer-events: auto,
 * posicionado absolutamente dentro de `#ui-overlay`).
 */
import type { LspCompletionItem } from "../shared";

// ── Ícones SVG inline por kind ──────────────────────────────────────────────────────────────────

const KIND_ICONS: Record<string, string> = {
  method: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M6 3L4 8h3l-2 5"/><circle cx="11.5" cy="5.5" r="2"/></svg>',
  function: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M6 3L4 8h3l-2 5"/><circle cx="11.5" cy="5.5" r="2"/></svg>',
  variable: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M3.5 5.5h9M5 5.5V3a2 2 0 012-2h2a2 2 0 012 2v2.5M4 10.5h8"/><path d="M5.5 10.5V13a2 2 0 002 2h1a2 2 0 002-2v-2.5"/></svg>',
  property: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/></svg>',
  keyword: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 8l3.5-4v8l-3.5-4z"/><path d="M9 4l3.5 4-3.5 4"/></svg>',
  snippet: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5l4-2v11l-4-2v-7z"/><path d="M10 3l3.5 3.5L10 10"/></svg>',
  class: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5.5 6.5h5M5.5 9.5h3"/></svg>',
  module: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2 5l6-3 6 3v6l-6 3-6-3V5z"/><path d="M8 2v12M2 8h12"/></svg>',
  interface: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8h5"/></svg>',
  enum: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h8M2.5 12h11"/><circle cx="12.5" cy="8" r="2"/></svg>',
};

function kindIcon(kind: string | undefined): string {
  const icon = kind !== undefined ? KIND_ICONS[kind.toLowerCase()] : undefined;
  return icon ?? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>';
}

// ── Binding ─────────────────────────────────────────────────────────────────────────────────────

export interface CompletionPopupBinding {
  readonly isOpen: boolean;
  open(
    items: LspCompletionItem[],
    onSelect: (item: LspCompletionItem) => void,
    x: number,
    y: number,
  ): void;
  close(): void;
  selectNext(): void;
  selectPrev(): void;
  readonly selected: LspCompletionItem | undefined;
  dispose(): void;
}

/**
 * Cria o popup de completação DOM. Os itens são renderizados como uma lista
 * dentro de `#completion-popup`. O popup é posicionado em `x`/`y` absolutos
 * dentro de `#ui-overlay` (ou `position: fixed` se preferir).
 */
export function createCompletionPopup(): CompletionPopupBinding {
  let isOpenValue = false;
  let selectedIndex = 0;
  let items: LspCompletionItem[] = [];
  let onSelect: ((item: LspCompletionItem) => void) | undefined;

  const popup = document.getElementById("completion-popup");
  if (!popup) {
    throw new Error("Scribe: #completion-popup não encontrado no DOM");
  }

  const list = popup.querySelector(".completion-list");
  if (!list) {
    throw new Error("Scribe: .completion-list não encontrado dentro de #completion-popup");
  }

  // Narrowed references — TypeScript não sabe que o guard acima cobre o escopo das closures,
  // então usamos asserções non-null nas variáveis locais que nunca re-atribuímos.
  const popupEl = popup as HTMLElement;
  const listEl = list as HTMLElement;

  function render(): void {
    listEl.replaceChildren();
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const el = document.createElement("div");
      el.className = `completion-item${i === selectedIndex ? " selected" : ""}`;
      el.role = "option";
      el.setAttribute("aria-selected", String(i === selectedIndex));
      el.dataset.index = String(i);

      // Ícone do kind
      const iconSpan = document.createElement("span");
      iconSpan.className = "completion-icon";
      iconSpan.innerHTML = kindIcon(item.kind);
      el.appendChild(iconSpan);

      // Label
      const labelSpan = document.createElement("span");
      labelSpan.className = "completion-label";
      labelSpan.textContent = item.label;
      el.appendChild(labelSpan);

      // Detail
      if (item.detail !== undefined && item.detail.length > 0) {
        const detailSpan = document.createElement("span");
        detailSpan.className = "completion-detail";
        detailSpan.textContent = item.detail;
        el.appendChild(detailSpan);
      }

      // Kind tag
      if (item.kind !== undefined && item.kind.length > 0) {
        const kindSpan = document.createElement("span");
        kindSpan.className = "completion-kind";
        kindSpan.textContent = item.kind;
        el.appendChild(kindSpan);
      }

      el.addEventListener("mousedown", (e: MouseEvent) => {
        e.preventDefault();
        selectIndex(i);
      });

      el.addEventListener("mouseenter", () => {
        selectIndex(i);
      });

      listEl.appendChild(el);
    }
  }

  function selectIndex(index: number): void {
    if (index < 0 || index >= items.length) return;
    selectedIndex = index;
    // Atualiza visual
    const children = listEl.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      const selected = i === selectedIndex;
      child.classList.toggle("selected", selected);
      child.setAttribute("aria-selected", String(selected));
    }
  }

  function selectNext(): void {
    if (items.length === 0) return;
    selectIndex(Math.min(selectedIndex + 1, items.length - 1));
  }

  function selectPrev(): void {
    if (items.length === 0) return;
    selectIndex(Math.max(selectedIndex - 1, 0));
  }

  function confirmSelection(): void {
    const item = items[selectedIndex];
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
        selectNext();
        break;
      case "ArrowUp":
        e.preventDefault();
        selectPrev();
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

  const boundKeyDown = handleKeyDown;

  function open(
    newItems: LspCompletionItem[],
    callback: (item: LspCompletionItem) => void,
    x: number,
    y: number,
  ): void {
    items = newItems;
    selectedIndex = 0;
    onSelect = callback;
    isOpenValue = true;
    popupEl.style.left = `${x}px`;
    popupEl.style.top = `${y}px`;
    popupEl.hidden = false;
    render();
    document.addEventListener("keydown", boundKeyDown);
  }

  function close(): void {
    if (!isOpenValue) return;
    popupEl.hidden = true;
    items = [];
    onSelect = undefined;
    isOpenValue = false;
    document.removeEventListener("keydown", boundKeyDown);
  }

  function dispose(): void {
    close();
    listEl.replaceChildren();
  }

  return {
    get isOpen(): boolean {
      return isOpenValue;
    },
    open,
    close,
    selectNext,
    selectPrev,
    get selected(): LspCompletionItem | undefined {
      return items[selectedIndex];
    },
    dispose,
  };
}