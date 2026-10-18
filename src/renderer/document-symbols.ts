/**
 * Scribe — popup de navegação por símbolos do documento (LSP Document Symbols).
 *
 * Overlay DOM acionado por Ctrl+Shift+O que lista funções, classes, variáveis
 * do documento atual. Filtro por nome, navegação com setas/Enter/Esc.
 */
import type { LspDocumentSymbol } from "../shared";

const SYMBOL_ICONS: Record<number, string> = {
  1:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2 4l6-3 6 3v8l-6 3-6-3V4z"/><path d="M8 1v14"/></svg>',   // File
  2:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2 5l6-3 6 3v6l-6 3-6-3V5z"/><path d="M8 2v12M2 8h12"/></svg>',   // Module
  3:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12M2 8h10M2 12h8"/></svg>',                              // Namespace
  5:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5.5 6.5h5M5.5 9.5h3"/></svg>',  // Class
  6:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M6 3L4 8h3l-2 5"/><circle cx="11.5" cy="5.5" r="2"/></svg>',           // Method
  7:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/></svg>',  // Property
  8:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5.5 7.5h5"/></svg>',        // Field
  9:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 8l3.5-4v8l-3.5-4z"/><path d="M9 4l3.5 4-3.5 4"/></svg>',           // Constructor
  10: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h8M2.5 12h11"/><circle cx="12.5" cy="8" r="2"/></svg>',     // Enum
  11: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8h5"/></svg>',    // Interface
  12: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M6 3L4 8h3l-2 5"/><circle cx="11.5" cy="5.5" r="2"/></svg>',              // Function
  13: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M3.5 5.5h9M5 5.5V3a2 2 0 012-2h2a2 2 0 012 2v2.5M4 10.5h8"/><path d="M5.5 10.5V13a2 2 0 002 2h1a2 2 0 002-2v-2.5"/></svg>',  // Variable
  14: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h8M2.5 12h11"/><circle cx="4" cy="8" r="1.5" fill="currentColor"/></svg>', // Constant
  23: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M4 8a4 4 0 018 0"/><path d="M6 8a2 2 0 014 0"/><circle cx="8" cy="4" r="1.5"/></svg>',        // Struct
  24: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="4" r="1.5"/><path d="M3 8.5l5-3 5 3"/><path d="M8 5.5v7"/></svg>',        // Event
};

function symbolIcon(kind: number): string {
  return SYMBOL_ICONS[kind] ?? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>';
}

function kindLabel(kind: number): string {
  const labels: Record<number, string> = {
    1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
    6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
    11: "interface", 12: "function", 13: "variable", 14: "constant",
    15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
    20: "key", 21: "null", 22: "enumMember", 23: "struct", 24: "event",
    25: "operator", 26: "typeParam",
  };
  return labels[kind] ?? "symbol";
}

export interface DocumentSymbolsBinding {
  readonly isOpen: boolean;
  open(symbols: LspDocumentSymbol[], onSelect: (sym: LspDocumentSymbol) => void): void;
  close(): void;
  dispose(): void;
}

export function createDocumentSymbolsPopup(): DocumentSymbolsBinding {
  let isOpenValue = false;
  let allItems: LspDocumentSymbol[] = [];
  let selectedIndex = 0;
  let filtered: LspDocumentSymbol[] = [];
  let onSelect: ((sym: LspDocumentSymbol) => void) | undefined;

  const popup = document.getElementById("document-symbols-popup");
  if (!popup) throw new Error("Scribe: #document-symbols-popup não encontrado no DOM");

  const input = popup.querySelector(".symbols-input") as HTMLInputElement | null;
  const list = popup.querySelector(".symbols-list");
  if (!input || !list) throw new Error("Scribe: .symbols-input ou .symbols-list não encontrado");

  const popupEl = popup as HTMLElement;
  const inputEl = input as HTMLInputElement;
  const listEl = list as HTMLElement;

  function filterItems(): void {
    const lower = inputEl.value.toLowerCase();
    filtered = lower.length === 0
      ? [...allItems]
      : allItems.filter((s) => s.name.toLowerCase().includes(lower));
    selectedIndex = 0;
    render();
  }

  function render(): void {
    listEl.replaceChildren();
    for (let i = 0; i < filtered.length; i++) {
      const sym = filtered[i]!;
      const el = document.createElement("div");
      el.className = `symbols-item${i === selectedIndex ? " selected" : ""}`;
      el.role = "option";
      el.setAttribute("aria-selected", String(i === selectedIndex));

      const iconSpan = document.createElement("span");
      iconSpan.className = "symbols-icon";
      iconSpan.innerHTML = symbolIcon(sym.kind);
      el.appendChild(iconSpan);

      const nameSpan = document.createElement("span");
      nameSpan.className = "symbols-name";
      nameSpan.textContent = sym.name;
      el.appendChild(nameSpan);

      if (sym.kind !== undefined) {
        const kindSpan = document.createElement("span");
        kindSpan.className = "symbols-kind";
        kindSpan.textContent = kindLabel(sym.kind);
        el.appendChild(kindSpan);
      }

      el.addEventListener("mousedown", (e: MouseEvent) => {
        e.preventDefault();
        selectIndex(i);
        confirmSelection();
      });

      el.addEventListener("mouseenter", () => {
        selectIndex(i);
      });

      listEl.appendChild(el);
    }

    if (filtered.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "symbols-empty";
      emptyEl.textContent = "Nenhum símbolo encontrado";
      listEl.appendChild(emptyEl);
    }
  }

  function selectIndex(index: number): void {
    if (index < 0 || index >= filtered.length) return;
    selectedIndex = index;
    const children = listEl.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      child.classList.toggle("selected", i === selectedIndex);
      child.setAttribute("aria-selected", String(i === selectedIndex));
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
    symbols: LspDocumentSymbol[],
    callback: (sym: LspDocumentSymbol) => void,
  ): void {
    allItems = symbols;
    selectedIndex = 0;
    onSelect = callback;
    isOpenValue = true;
    popupEl.hidden = false;
    inputEl.value = "";
    inputEl.focus();
    filterItems();
    document.addEventListener("keydown", handleKeyDown);
  }

  function close(): void {
    if (!isOpenValue) return;
    popupEl.hidden = true;
    allItems = [];
    filtered = [];
    onSelect = undefined;
    isOpenValue = false;
    inputEl.value = "";
    document.removeEventListener("keydown", handleKeyDown);
  }

  function dispose(): void {
    close();
    listEl.replaceChildren();
  }

  inputEl.addEventListener("input", () => {
    filterItems();
  });

  return {
    get isOpen(): boolean { return isOpenValue; },
    open,
    close,
    dispose,
  };
}