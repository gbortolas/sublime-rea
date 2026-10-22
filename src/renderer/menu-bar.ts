/**
 * Scribe — **barra de menu no DOM** (a casca do editor).
 *
 * ## Por que no DOM (e não no menu nativo)
 *
 * O **menu nativo** do Electron (GTK) **não troca de menu** quando o mouse passa por cima de
 * outro título. A causa é **medida** (A/B): o Electron só importa `gtk_menu_popup` (o caminho
 * legado) e **não** `gtk_menu_popup_at_widget` / `gtk_menu_attach_to_widget` — as APIs que o
 * `GtkMenuBar` usa para o *hover*. Um app GTK3 puro faz os dois gestos; o Electron, não ⇒
 * **não é consertável no menu nativo**.
 *
 * ⇒ A correção é um **menu bar no DOM** (a casca já é VS Code-like). De quebra, mata a
 * "fonte frankenstein" do menu GTK (a casca tem **uma** tipografia).
 *
 * ## A lógica é pura (testável sem DOM)
 *
 * O ambiente de teste do repo é `node` (**sem jsdom**) ⇒ o módulo separa a **decisão** da
 * **pintura**:
 *
 * - {@link groupByCategory} — a **ordem** dos títulos (File, Edit, Find, View, Debug);
 * - {@link openMenu} / {@link closeMenu} / {@link toggleMenu} / {@link switchMenu} — o
 *   **estado** (qual menu está aberto) — o `switchMenu` é o *hover* que **troca** o menu;
 * - {@link parseAccelerator} / {@link matchesAccelerator} / {@link findItemByAccelerator} — o
 *   casamento de uma tecla com o atalho de um item.
 *
 * A **pintura** é o {@link attachMenuBar} — testado contra o **DOM falso** do repo
 * (`test/helpers/fake-dom.ts`).
 */

/* ───────────────────────────── contrato ───────────────────────────── */

/**
 * Um item do menu (um **comando**).
 *
 * ⚠️ **Compatível estruturalmente** com o `Command` do contrato compartilhado
 * (`src/shared/command-contract.ts`): o `listCommands()` da ponte pode ser passado direto.
 */
export interface MenuBarItem {
  /** Id do comando — é o que o `onSelect` recebe. */
  readonly id: string;
  /** Rótulo visível do item. */
  readonly label: string;
  /**
   * A **categoria** ("File", "Edit", …) — é ela que dá o **título** do menu.
   *
   * ⚠️ Sem categoria, o item cai no grupo "Outros" (o **último** da barra).
   */
  readonly category?: string;
  /** O atalho, exibido **à direita** do rótulo (ex.: "Ctrl+N"). */
  readonly accelerator?: string;
}

/** Opções do {@link attachMenuBar}. */
export interface MenuBarOptions {
  /** O `<nav id="menu-bar">` que recebe a barra (`null` ⇒ degradação, sem DOM). */
  readonly container: HTMLElement | null | undefined;
  /** Os comandos (a lista do `command.list`). */
  readonly items: readonly MenuBarItem[];
  /** Executa o comando escolhido (o clique num item). */
  readonly onSelect: (id: string) => void;
  /**
   * O **atalho pressionado** (o módulo casa a tecla com o acelerador do item).
   *
   * Devolve `true` quando o atalho foi **tratado** (o módulo então impede o comportamento
   * padrão da tecla) e `false` quando **outro** caminho cuida dele.
   *
   * ⚠️ **Por que o `false` é essencial**: o `Ctrl+S`/`Ctrl+O`/`Ctrl+Z` já são tratados pelo
   * **canvas**; se a barra também os tratasse, o diálogo de "abrir" abriria **duas** vezes.
   * A barra só trata o que o canvas **não** cobre (F5, F9, F3, Ctrl+N, …).
   */
  readonly onAccelerator?: ((id: string) => boolean) | undefined;
  /**
   * O menu **fechou** — o chamador devolve o **foco** ao editor.
   *
   * ⚠️ Sem isto, depois de usar o menu o foco ficaria **no título** do menu e a digitação
   * iria para lá (e não para o documento).
   */
  readonly onClose?: ((reason: MenuBarCloseReason) => void) | undefined;
  /** O documento dono (por padrão, o `ownerDocument` do container). */
  readonly document?: Document | null | undefined;
}

/** **Por que** o menu fechou (o `onClose` recebe). */
export type MenuBarCloseReason =
  /** O usuário escolheu um item (o comando rodou). */
  | "select"
  /** O `Esc` (ou o `ArrowLeft` na navegação). */
  | "escape"
  /** O clique veio de **fora** da barra. */
  | "outside"
  /** Fechamento **programático** (a API `close()`). */
  | "api";

/** O handle da barra (o que o chamador guarda). */
export interface MenuBarHandle {
  /** A categoria do menu aberto (`undefined` = nenhum menu aberto). */
  readonly openCategory: string | undefined;
  /**
   * Troca a lista de itens (a lista de comandos chega **assíncrona** — o `command.list` é
   * um IPC ⇒ a barra nasce com os itens do renderer e é completada quando a lista chega).
   */
  setItems(items: readonly MenuBarItem[]): void;
  /** Fecha o menu (se estiver aberto). */
  close(): void;
  /** Desmonta a barra (remove os listeners e esvazia o container). */
  dispose(): void;
}

/* ───────────────────────────── lógica pura ───────────────────────────── */

/**
 * A **ordem** dos títulos da barra.
 *
 * ⚠️ A ordem é a do **core** (`listCommands()`), não a alfabética: File, Edit, Find, View,
 * Debug. Uma categoria **desconhecida** (o core ganhou uma nova) entra **depois** das
 * conhecidas, em ordem alfabética.
 */
export const MENU_CATEGORY_ORDER: readonly string[] = ["File", "Edit", "Find", "View", "Debug"];

/** O grupo dos itens **sem categoria** (o último da barra). */
export const MENU_OTHER_CATEGORY = "Outros";

/** Uma categoria da barra (um título + os seus itens). */
export interface MenuBarCategory {
  /** O rótulo do título ("File", "Edit", …). */
  readonly name: string;
  /** Os itens do menu (na ordem em que aparecem). */
  readonly items: readonly MenuBarItem[];
}

/**
 * Agrupa os itens por categoria, na **ordem canônica** (File, Edit, Find, View, Debug).
 *
 * ⚠️ Só entram as categorias que **têm** itens (uma categoria vazia não é um título).
 */
export function groupByCategory(items: readonly MenuBarItem[]): readonly MenuBarCategory[] {
  const buckets = new Map<string, MenuBarItem[]>();
  for (const item of items) {
    const raw = item.category?.trim() ?? "";
    const name = raw.length === 0 ? MENU_OTHER_CATEGORY : raw;
    const bucket = buckets.get(name);
    if (bucket === undefined) buckets.set(name, [item]);
    else bucket.push(item);
  }
  const names = [...buckets.keys()].sort(compareCategories);
  return names.map((name) => ({ name, items: buckets.get(name) ?? [] }));
}

/** A posição da categoria na ordem canônica (as desconhecidas vão para o fim). */
function categoryRank(name: string): number {
  const index = MENU_CATEGORY_ORDER.indexOf(name);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** O comparador da ordem canônica (as desconhecidas em ordem alfabética; "Outros" por último). */
function compareCategories(a: string, b: string): number {
  const rankA = categoryRank(a);
  const rankB = categoryRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (a === MENU_OTHER_CATEGORY) return 1;
  if (b === MENU_OTHER_CATEGORY) return -1;
  return a.localeCompare(b);
}

/** O estado da barra: **qual** menu está aberto. */
export interface MenuBarState {
  /** A categoria do menu aberto (`undefined` = nenhum). */
  readonly openCategory: string | undefined;
}

/** O estado "nenhum menu aberto". */
export const CLOSED_MENU: MenuBarState = Object.freeze({ openCategory: undefined });

/** Abre o menu da categoria. */
export function openMenu(_state: MenuBarState, category: string): MenuBarState {
  return { openCategory: category };
}

/** Fecha o menu. */
export function closeMenu(_state: MenuBarState): MenuBarState {
  return CLOSED_MENU;
}

/** O clique no título: abre o menu dele ou fecha (se já era esse). */
export function toggleMenu(state: MenuBarState, category: string): MenuBarState {
  return state.openCategory === category ? CLOSED_MENU : { openCategory: category };
}

/**
 * O **hover** num outro título: **troca** o menu aberto.
 *
 * ⚠️ **O bug do usuário**: com o menu aberto, passar o mouse por cima de outro título tem que
 * **trocar** o menu — e **não** fechar (nem reabrir com delay, que daria um piscar).
 *
 * ⚠️ **Sem menu aberto, o hover não abre nada** (o menu só abre por clique) — é o que
 * distingue o "hover que troca" do "hover que abre".
 */
export function switchMenu(state: MenuBarState, category: string): MenuBarState {
  if (state.openCategory === undefined) return state;
  if (state.openCategory === category) return state;
  return { openCategory: category };
}

/* ───────────────────────────── atalhos (puro) ───────────────────────────── */

/** Um atalho interpretado ("Ctrl+Shift+D" ⇒ as flags + a tecla). */
export interface ParsedAccelerator {
  /** A tecla, em minúsculas ("n", "f5"). */
  readonly key: string;
  /** `Ctrl` (ou `CmdOrCtrl`). */
  readonly ctrl: boolean;
  /** `Shift`. */
  readonly shift: boolean;
  /** `Alt` (ou `Option`). */
  readonly alt: boolean;
  /** `Meta` (o "Command" do macOS). */
  readonly meta: boolean;
}

/** A tecla de um evento (só o que o hit-test precisa). */
export interface AcceleratorEvent {
  /** O `key` do evento. */
  readonly key: string;
  /** `Ctrl` pressionado. */
  readonly ctrlKey: boolean;
  /** `Shift` pressionado. */
  readonly shiftKey: boolean;
  /** `Alt` pressionado. */
  readonly altKey: boolean;
  /** `Meta` pressionado. */
  readonly metaKey: boolean;
}

/**
 * Interpreta um atalho ("Ctrl+Shift+D", "F5", "CmdOrCtrl+O").
 *
 * A última parte é a **tecla**; as demais são modificadores. `undefined` quando o atalho é
 * inútil (vazio).
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | undefined {
  const parts = accelerator
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = parts[parts.length - 1];
  if (last === undefined) return undefined;
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  const has = (...names: readonly string[]): boolean =>
    modifiers.some((modifier) => names.includes(modifier));
  return {
    key: last.toLowerCase(),
    ctrl: has("ctrl", "cmdorctrl", "commandorcontrol", "control"),
    shift: has("shift"),
    alt: has("alt", "option", "altgr"),
    meta: has("meta", "cmd", "command", "super", "win"),
  };
}

/**
 * O atalho casa com a tecla?
 *
 * ⚠️ A tecla é comparada em **minúsculas** (com `Shift`, o `key` vem em maiúscula: `Ctrl+Shift+Z`
 * chega como `key === "Z"`). O `Shift` é **estrito**: `Ctrl+N` **não** casa com `Ctrl+Shift+N`.
 */
export function matchesAccelerator(
  accelerator: ParsedAccelerator,
  event: AcceleratorEvent,
): boolean {
  if (event.key.toLowerCase() !== accelerator.key) return false;
  if (accelerator.ctrl !== event.ctrlKey) return false;
  if (accelerator.shift !== event.shiftKey) return false;
  if (accelerator.alt !== event.altKey) return false;
  if (accelerator.meta !== event.metaKey) return false;
  return true;
}

/**
 * O item cujo atalho casa com a tecla (`undefined` ⇒ nenhum).
 *
 * ⚠️ O **primeiro** vence (a lista já vem na ordem da barra).
 */
export function findItemByAccelerator(
  items: readonly MenuBarItem[],
  event: AcceleratorEvent,
): MenuBarItem | undefined {
  for (const item of items) {
    if (item.accelerator === undefined) continue;
    const parsed = parseAccelerator(item.accelerator);
    if (parsed === undefined) continue;
    if (matchesAccelerator(parsed, event)) return item;
  }
  return undefined;
}

/* ───────────────────────────── a barra (DOM) ───────────────────────────── */

/** A classe do botão de título. */
const MENU_TITLE_CLASS = "menu-title";
/** A classe do popup (o menu aberto). */
const MENU_POPUP_CLASS = "menu-popup";
/** A classe de um item do menu. */
const MENU_ENTRY_CLASS = "menu-entry";

/** O handle "nada" (sem DOM — degradação explícita, sem crash). */
function createNoopHandle(): MenuBarHandle {
  return {
    openCategory: undefined,
    setItems: (): void => {},
    close: (): void => {},
    dispose: (): void => {},
  };
}

/** O documento dono (o `ownerDocument` do container, por padrão). */
function resolveDocument(options: MenuBarOptions): Document | null {
  if (options.document !== undefined) return options.document ?? null;
  const owner = options.container?.ownerDocument ?? null;
  if (owner !== null) return owner;
  if (typeof document !== "undefined") return document;
  return null;
}

/** A tecla do evento (o DOM falso do repo só tem `key`). */
function eventKey(event: Event): string {
  const key = (event as Partial<KeyboardEvent>).key;
  return typeof key === "string" ? key : "";
}

/** Um modificador do evento (`true` só quando o navegador diz `true`). */
function eventModifier(event: Event, name: "ctrlKey" | "shiftKey" | "altKey" | "metaKey"): boolean {
  return (event as unknown as Record<string, unknown>)[name] === true;
}

/** O nó do evento (`undefined` quando o DOM não o expõe). */
function eventTarget(event: Event): unknown {
  const target = (event as { target?: unknown }).target;
  return target === null ? undefined : target;
}

/**
 * O nó está **dentro** da raiz?
 *
 * ⚠️ O `contains` do DOM quando existe; senão, a cadeia de pais (o DOM falso do repo expõe o
 * `parent`).
 */
function isDescendant(root: HTMLElement, node: unknown): boolean {
  if (node === null || node === undefined) return false;
  const candidate = node as {
    contains?: (other: unknown) => boolean;
    parent?: unknown;
    parentNode?: unknown;
  };
  if (typeof candidate.contains === "function") {
    try {
      if (candidate.contains(node) === true) return true;
    } catch {
      /* sem `contains` utilizável ⇒ a cadeia de pais decide */
    }
  }
  let current: unknown = node;
  let guard = 0;
  while (current !== null && current !== undefined && guard < 128) {
    if (current === root) return true;
    const link = current as { parent?: unknown; parentNode?: unknown };
    current = link.parent ?? link.parentNode;
    guard += 1;
  }
  return false;
}

/**
 * Monta a barra de menu dentro do `container`.
 *
 * **Degradação**: sem `container` ou sem documento ⇒ devolve um handle **no-op** (sem crash).
 */
export function attachMenuBar(options: MenuBarOptions): MenuBarHandle {
  const container = options.container ?? null;
  const doc = resolveDocument(options);
  if (container === null || doc === null) return createNoopHandle();

  /** Os listeners do DOM **criado** pela barra (recriados a cada `render`). */
  const domDisposers: Array<() => void> = [];
  /** Os listeners **globais** (documento) — registrados uma vez. */
  const globalDisposers: Array<() => void> = [];
  /**
   * Os listeners dos **itens** do popup — descartados a cada `applyState` (o popup é
   * reconstruído a cada troca de menu ⇒ sem isto, o array cresceria sem parar).
   */
  const entryDisposers: Array<() => void> = [];

  // Os listeners do DOM **criado** pela barra são descartados a cada `render` (o `popup` é
  // reconstruído); os globais (documento) valem até o `dispose`.
  const listenDom = (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
  ): void => {
    const handler = listener as EventListener;
    target.addEventListener(type, handler);
    domDisposers.push(() => target.removeEventListener(type, handler));
  };

  /** O mesmo que o `listenDom`, mas o listener vive só até o próximo `applyState`. */
  const listenEntry = (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
  ): void => {
    const handler = listener as EventListener;
    target.addEventListener(type, handler);
    entryDisposers.push(() => target.removeEventListener(type, handler));
  };

  const listenGlobal = (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
  ): void => {
    const handler = listener as EventListener;
    target.addEventListener(type, handler);
    globalDisposers.push(() => target.removeEventListener(type, handler));
  };

  let currentItems: readonly MenuBarItem[] = options.items;
  let categories: readonly MenuBarCategory[] = groupByCategory(currentItems);
  let state: MenuBarState = CLOSED_MENU;
  const titleButtons = new Map<string, HTMLElement>();
  let popup: HTMLElement | null = null;
  /** O último clique nasceu **dentro** da barra? (o clique fora fecha o menu) */
  let clickInside = false;

  /** Foca o item `index` do popup aberto (o foco visível é o do design system). */
  const focusEntry = (index: number): void => {
    if (popup === null) return;
    const entries = popup.children;
    if (entries.length === 0) return;
    const bounded = ((index % entries.length) + entries.length) % entries.length;
    const entry = entries[bounded];
    if (entry === undefined) return;
    (entry as HTMLElement).focus?.();
  };

  /**
   * Fecha o menu (se estiver aberto) e avisa o chamador (**para ele devolver o foco**).
   *
   * ⚠️ O `onClose` só roda quando o menu **estava** aberto (um `Esc` com o menu fechado não
   * mexe no foco do editor).
   */
  const closeWith = (reason: MenuBarCloseReason): void => {
    if (state.openCategory === undefined) return;
    applyState(CLOSED_MENU);
    options.onClose?.(reason);
  };

  /** Desenha o estado: o `aria-expanded` dos títulos e o conteúdo do popup. */
  const applyState = (next: MenuBarState): void => {
    const category =
      next.openCategory === undefined
        ? undefined
        : categories.find((candidate) => candidate.name === next.openCategory);
    // Uma categoria que sumiu (a lista de comandos mudou) ⇒ o menu fecha.
    state = category === undefined ? CLOSED_MENU : { openCategory: category.name };

    for (const [name, button] of titleButtons) {
      const expanded = name === state.openCategory;
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      button.classList.toggle(`${MENU_TITLE_CLASS}-open`, expanded);
    }

    if (popup === null) return;
    // Os listeners dos itens anteriores morrem com eles (o popup é reconstruído).
    for (const dispose of entryDisposers) dispose();
    entryDisposers.length = 0;
    popup.replaceChildren();
    if (category === undefined) {
      popup.hidden = true;
      popup.removeAttribute("aria-label");
      return;
    }
    popup.hidden = false;
    popup.setAttribute("aria-label", category.name);

    const entries: HTMLElement[] = [];
    for (const item of category.items) {
      const entry = doc.createElement("button");
      entry.className = MENU_ENTRY_CLASS;
      entry.setAttribute("type", "button");
      entry.setAttribute("role", "menuitem");
      entry.setAttribute("data-command-id", item.id);
      const label = doc.createElement("span");
      label.className = "menu-entry-label";
      label.textContent = item.label;
      entry.appendChild(label);
      if (item.accelerator !== undefined) {
        const accelerator = doc.createElement("span");
        accelerator.className = "menu-entry-accelerator";
        accelerator.textContent = item.accelerator;
        entry.appendChild(accelerator);
      }
      listenEntry(entry, "click", (event) => {
        event.preventDefault();
        options.onSelect(item.id);
        closeWith("select");
      });
      entry.setAttribute("data-entry-index", String(entries.length));
      entries.push(entry);
      popup.appendChild(entry);
    }

    // A navegação por setas (o papel de `menuitem` do popup).
    entries.forEach((entry, index) => {
      listenEntry(entry, "keydown", (event) => {
        const key = eventKey(event);
        if (key === "ArrowDown") {
          event.preventDefault();
          focusEntry(index + 1);
        } else if (key === "ArrowUp") {
          event.preventDefault();
          focusEntry(index - 1);
        } else if (key === "Home") {
          event.preventDefault();
          focusEntry(0);
        } else if (key === "End") {
          event.preventDefault();
          focusEntry(entries.length - 1);
        } else if (key === "Escape") {
          event.preventDefault();
          closeWith("escape");
        }
      });
    });

    // O popup fica **sob** o título aberto.
    const title = titleButtons.get(category.name);
    const left = (title as Partial<HTMLElement> | undefined)?.offsetLeft;
    if (typeof left === "number" && Number.isFinite(left)) popup.style.left = `${left}px`;
  };

  /** (Re)desenha a barra: os títulos e o popup. */
  const render = (): void => {
    for (const dispose of domDisposers) dispose();
    domDisposers.length = 0;
    titleButtons.clear();
    container.replaceChildren();

    categories.forEach((category, position) => {
      const title = doc.createElement("button");
      title.className = MENU_TITLE_CLASS;
      title.setAttribute("type", "button");
      title.setAttribute("role", "menuitem");
      title.setAttribute("aria-haspopup", "true");
      title.setAttribute("aria-expanded", "false");
      title.setAttribute("data-menu-category", category.name);
      title.textContent = category.name;
      // O clique abre o menu dele.
      listenDom(title, "click", (event) => {
        event.preventDefault();
        applyState(toggleMenu(state, category.name));
      });
      // ⚠️ **O bug do usuário**: com o menu aberto, o hover num **outro** título **troca** o
      // menu — sem fechar e sem reabrir com delay (que daria um piscar).
      listenDom(title, "mouseenter", () => {
        applyState(switchMenu(state, category.name));
      });
      listenDom(title, "keydown", (event) => {
        const key = eventKey(event);
        if (key === "ArrowDown" || key === "Enter" || key === " ") {
          event.preventDefault();
          applyState(openMenu(state, category.name));
          focusEntry(0);
        } else if (key === "ArrowRight" || key === "ArrowLeft") {
          event.preventDefault();
          const step = key === "ArrowRight" ? 1 : -1;
          const next = categories[(position + step + categories.length) % categories.length];
          if (next === undefined) return;
          const button = titleButtons.get(next.name);
          button?.focus?.();
          applyState(switchMenu(state, next.name));
        } else if (key === "Escape") {
          if (state.openCategory === undefined) return;
          event.preventDefault();
          closeWith("escape");
        }
      });
      titleButtons.set(category.name, title);
      container.appendChild(title);
    });

    popup = doc.createElement("div");
    popup.className = MENU_POPUP_CLASS;
    popup.setAttribute("role", "menu");
    popup.hidden = true;
    container.appendChild(popup);

    applyState(state);
  };

  // O container é o "menubar" (o papel vem do HTML, mas o módulo garante).
  container.setAttribute("role", "menubar");

  // ── Os listeners globais (o documento) ──────────────────────────────────────────────────────
  //
  // ⚠️ O **clique fora** fecha o menu. Quem decide é o **alvo** do clique (o `event.target`):
  // se ele está dentro da barra, o clique é dela; se não, é "fora" ⇒ o menu fecha. O flag
  // `clickInside` é o **fallback** para um DOM que não expõe o alvo.
  listenGlobal(container, "click", () => {
    clickInside = true;
  });
  listenGlobal(doc, "click", (event) => {
    const target = eventTarget(event);
    const inside = target === undefined ? clickInside : isDescendant(container, target);
    clickInside = false;
    if (inside) return;
    closeWith("outside");
  });
  // O `Esc` fecha o menu (de qualquer lugar da janela).
  listenGlobal(doc, "keydown", (event) => {
    if (eventKey(event) !== "Escape") return;
    if (state.openCategory === undefined) return;
    event.preventDefault();
    closeWith("escape");
  });
  // O atalho: o módulo **só** avisa — quem decide se o atalho foi tratado é o chamador
  // (o canvas já trata o `Ctrl+S`/`Ctrl+O`/…).
  if (options.onAccelerator !== undefined) {
    listenGlobal(doc, "keydown", (event) => {
      const key = eventKey(event);
      if (key.length === 0) return;
      const item = findItemByAccelerator(currentItems, {
        key,
        ctrlKey: eventModifier(event, "ctrlKey"),
        shiftKey: eventModifier(event, "shiftKey"),
        altKey: eventModifier(event, "altKey"),
        metaKey: eventModifier(event, "metaKey"),
      });
      if (item === undefined) return;
      const handled = options.onAccelerator?.(item.id) ?? false;
      if (!handled) return;
      event.preventDefault();
    });
  }

  render();

  return {
    get openCategory(): string | undefined {
      return state.openCategory;
    },
    setItems: (items: readonly MenuBarItem[]): void => {
      currentItems = items;
      categories = groupByCategory(currentItems);
      render();
    },
    close: (): void => {
      closeWith("api");
    },
    dispose: (): void => {
      for (const dispose of domDisposers) dispose();
      domDisposers.length = 0;
      for (const dispose of entryDisposers) dispose();
      entryDisposers.length = 0;
      for (const dispose of globalDisposers) dispose();
      globalDisposers.length = 0;
      titleButtons.clear();
      popup = null;
      container.replaceChildren();
    },
  };
}
