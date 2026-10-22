/**
 * Scribe — testes da **barra de menu** (do DOM) e da sua **fiação** no renderer.
 *
 * ## O bug que a barra mata
 *
 * O **menu nativo** do Electron (GTK) **não troca de menu** quando o mouse passa por cima de
 * outro título: o Electron só importa `gtk_menu_popup` (o caminho legado) e **não**
 * `gtk_menu_popup_at_widget`/`gtk_menu_attach_to_widget` (as APIs que o `GtkMenuBar` usa no
 * *hover*) ⇒ **não é consertável no menu nativo**. A correção é um menu bar no **DOM** — e o
 * teste (b) prova o gesto que o GTK não fazia: **com o menu aberto, o `mouseenter` em outro
 * título TROCA o menu** (sem fechar e sem reabrir com delay).
 *
 * ## O ambiente
 *
 * O vitest do repo roda em `environment: "node"` (**sem jsdom**) ⇒ o DOM é o **falso**
 * (`test/helpers/fake-dom.ts`). O `FakeDocument` **não** tem `addEventListener` ⇒ o teste
 * monta um **documento com eventos** (um stub local) — é ele que carrega os listeners
 * globais (o clique fora, o `Esc` e os atalhos).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOSED_MENU,
  MENU_CATEGORY_ORDER,
  attachMenuBar,
  findItemByAccelerator,
  groupByCategory,
  matchesAccelerator,
  parseAccelerator,
  switchMenu,
  toggleMenu,
  type MenuBarItem,
} from "../src/renderer/menu-bar";
import { mergeMenuItems, menuAcceleratorAction } from "../src/renderer/main";
import {
  FakeElement,
  installFakeDom,
  uninstallFakeDom,
  type FakeDocument,
} from "./helpers/fake-dom";

/* ───────────────────────────── o DOM com eventos ───────────────────────────── */

/** As opções de um evento do stub. */
interface StubEventInit {
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly target?: unknown;
}

/** O evento do stub (o `FakeEvent` do repo só tem `key`). */
class StubEvent {
  readonly type: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly target: unknown;
  defaultPrevented = false;

  constructor(type: string, init: StubEventInit = {}) {
    this.type = type;
    this.key = init.key ?? "";
    this.ctrlKey = init.ctrlKey === true;
    this.shiftKey = init.shiftKey === true;
    this.altKey = init.altKey === true;
    this.metaKey = init.metaKey === true;
    this.target = init.target;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {}
}

/**
 * Um `document` falso **com eventos** (o `FakeDocument` do repo não os tem).
 *
 * O `createElement` delega ao `FakeDocument` (os elementos saem com o `ownerDocument` certo) e
 * o `dispatch` chama os listeners registrados.
 */
class StubDocument {
  private readonly listeners = new Map<string, Array<(event: StubEvent) => void>>();

  constructor(private readonly owner: FakeDocument) {}

  createElement(tagName: string): FakeElement {
    return this.owner.createElement(tagName);
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type);
    const handler = listener as unknown as (event: StubEvent) => void;
    if (list === undefined) this.listeners.set(type, [handler]);
    else list.push(handler);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const index = list.indexOf(listener as unknown as (event: StubEvent) => void);
    if (index >= 0) list.splice(index, 1);
  }

  /** Dispara um evento no "documento" (os listeners globais rodam). */
  dispatch(type: string, init: StubEventInit = {}): StubEvent {
    const event = new StubEvent(type, init);
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
}

/* ───────────────────────────── o cenário ───────────────────────────── */

/** Os comandos do cenário (a lista que o `command.list` devolve). */
const ITEMS: readonly MenuBarItem[] = [
  { id: "file.new", label: "Novo arquivo", category: "File", accelerator: "Ctrl+N" },
  { id: "file.open", label: "Abrir arquivo", category: "File", accelerator: "Ctrl+O" },
  { id: "file.save", label: "Salvar", category: "File", accelerator: "Ctrl+S" },
  { id: "edit.undo", label: "Desfazer", category: "Edit", accelerator: "Ctrl+Z" },
  { id: "find.open", label: "Buscar", category: "Find", accelerator: "Ctrl+F" },
  { id: "find.next", label: "Próxima ocorrência", category: "Find", accelerator: "F3" },
  { id: "view.toggleTheme", label: "Alternar tema", category: "View", accelerator: "Ctrl+Shift+T" },
  { id: "debug.start", label: "Iniciar depuração", category: "Debug", accelerator: "F5" },
  { id: "debug.toggleBreakpoint", label: "Alternar breakpoint", category: "Debug", accelerator: "F9" },
];

/** A barra montada (o DOM falso + o documento com eventos). */
interface Mounted {
  readonly nav: FakeElement;
  readonly doc: StubDocument;
  readonly outside: FakeElement;
  readonly onSelect: ReturnType<typeof vi.fn>;
  readonly onAccelerator: ReturnType<typeof vi.fn>;
  readonly handle: ReturnType<typeof attachMenuBar>;
  /** Os botões de título (na ordem da barra). */
  titles(): FakeElement[];
  /** O popup (o menu aberto). */
  popup(): FakeElement | undefined;
  /** Os itens do popup aberto. */
  entries(): FakeElement[];
}

let mounted: Mounted | undefined;

beforeEach(() => {
  const owner = installFakeDom();
  const doc = new StubDocument(owner);
  const nav = owner.createElement("nav");
  // Um "corpo" fora da barra (o alvo do clique fora).
  const outside = owner.createElement("div");
  const onSelect = vi.fn();
  const onAccelerator = vi.fn(() => true);
  const handle = attachMenuBar({
    container: nav as unknown as HTMLElement,
    items: ITEMS,
    onSelect,
    onAccelerator,
    document: doc as unknown as Document,
  });
  mounted = {
    nav,
    doc,
    outside,
    onSelect,
    onAccelerator,
    handle,
    titles: () => nav.children.filter((child) => child.className === "menu-title"),
    popup: () => nav.children.find((child) => child.className === "menu-popup"),
    entries: () => {
      const popup = mounted?.popup();
      return popup === undefined ? [] : popup.children;
    },
  };
});

afterEach(() => {
  mounted?.handle.dispose();
  mounted = undefined;
  uninstallFakeDom();
});

/* ───────────────────────────── a lógica pura ───────────────────────────── */

describe("barra de menu — a lógica pura", () => {
  it("os títulos saem na ordem canônica (File, Edit, Find, View, Debug)", () => {
    const groups = groupByCategory([
      { id: "view.toggleTheme", label: "Tema", category: "View" },
      { id: "debug.start", label: "Depurar", category: "Debug" },
      { id: "file.open", label: "Abrir", category: "File" },
      { id: "find.open", label: "Buscar", category: "Find" },
      { id: "edit.undo", label: "Desfazer", category: "Edit" },
    ]);

    expect(groups.map((group) => group.name)).toEqual(["File", "Edit", "Find", "View", "Debug"]);
    expect(MENU_CATEGORY_ORDER).toEqual(["File", "Edit", "Find", "View", "Debug"]);
  });

  it("uma categoria sem item não vira título (e os itens sem categoria vão para 'Outros')", () => {
    const groups = groupByCategory([
      { id: "file.open", label: "Abrir", category: "File" },
      { id: "sem.categoria", label: "Sem categoria" },
    ]);

    expect(groups.map((group) => group.name)).toEqual(["File", "Outros"]);
    expect(groups[1]?.items[0]?.id).toBe("sem.categoria");
  });

  it("o clique no título alterna (abre e fecha)", () => {
    const opened = toggleMenu(CLOSED_MENU, "File");
    expect(opened.openCategory).toBe("File");
    expect(toggleMenu(opened, "File").openCategory).toBeUndefined();
  });

  it("o hover TROCA o menu aberto (e não abre nada quando não há menu)", () => {
    const opened = toggleMenu(CLOSED_MENU, "File");

    // ⚠️ **O bug do usuário**: com o menu aberto, o hover em outro título troca o menu.
    const switched = switchMenu(opened, "Edit");
    expect(switched.openCategory).toBe("Edit");
    // O hover no **mesmo** título não muda nada.
    expect(switchMenu(switched, "Edit").openCategory).toBe("Edit");
    // Sem menu aberto, o hover **não abre** nada.
    expect(switchMenu(CLOSED_MENU, "Edit").openCategory).toBeUndefined();
  });

  it("o atalho é interpretado (Ctrl+Shift+D ⇒ Ctrl+Shift+d)", () => {
    const parsed = parseAccelerator("Ctrl+Shift+D");
    expect(parsed).toEqual({ key: "d", ctrl: true, shift: true, alt: false, meta: false });
  });

  it("o atalho casa com a tecla (o Shift é estrito)", () => {
    const parsed = parseAccelerator("Ctrl+N");
    expect(parsed).toBeDefined();
    if (parsed === undefined) return;

    // Ctrl+N ⇒ casa.
    expect(
      matchesAccelerator(parsed, {
        key: "n",
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }),
    ).toBe(true);
    // Ctrl+Shift+N ⇒ **não** casa (o Shift é estrito).
    expect(
      matchesAccelerator(parsed, {
        key: "N",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
      }),
    ).toBe(false);
    // Ctrl sem o modificador ⇒ não casa.
    expect(
      matchesAccelerator(parsed, {
        key: "n",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }),
    ).toBe(false);
  });

  it("o item é encontrado pelo atalho (F5 ⇒ debug.start)", () => {
    const item = findItemByAccelerator(ITEMS, {
      key: "F5",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    });
    expect(item?.id).toBe("debug.start");
  });
});

/* ───────────────────────────── o DOM ───────────────────────────── */

describe("barra de menu — o DOM", () => {
  it("monta os títulos na ordem certa (e só os que têm itens)", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    expect(bar.titles().map((title) => title.textContent)).toEqual([
      "File",
      "Edit",
      "Find",
      "View",
      "Debug",
    ]);
    // O papel de `menubar` e o `aria-haspopup` dos títulos.
    expect(bar.nav.getAttribute("role")).toBe("menubar");
    for (const title of bar.titles()) {
      expect(title.getAttribute("aria-haspopup")).toBe("true");
      expect(title.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("o clique num título abre o menu dele (e o `aria-expanded` acompanha)", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    const file = bar.titles()[0];
    expect(file).toBeDefined();
    if (file === undefined) return;

    file.dispatch("click");

    expect(bar.handle.openCategory).toBe("File");
    expect(file.getAttribute("aria-expanded")).toBe("true");
    const popup = bar.popup();
    expect(popup?.hidden).toBe(false);
    expect(popup?.getAttribute("role")).toBe("menu");
    expect(bar.entries().map((entry) => entry.getAttribute("data-command-id"))).toEqual([
      "file.new",
      "file.open",
      "file.save",
    ]);
  });

  it("⚠️ com o menu aberto, o `mouseenter` em OUTRO título TROCA o menu (o bug do usuário!)", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    const titles = bar.titles();
    const file = titles[0];
    const edit = titles[1];
    expect(file).toBeDefined();
    expect(edit).toBeDefined();
    if (file === undefined || edit === undefined) return;

    // Abre o menu "File" (o clique).
    file.dispatch("click");
    expect(bar.handle.openCategory).toBe("File");
    expect(bar.entries().map((entry) => entry.getAttribute("data-command-id"))).toEqual([
      "file.new",
      "file.open",
      "file.save",
    ]);

    // ⚠️ O **hover** em outro título **troca** o menu — e o menu **continua aberto** (não fecha
    // nem reabre com delay: o popup é o mesmo, reconstruído com o conteúdo novo).
    edit.dispatch("mouseenter");

    expect(bar.handle.openCategory).toBe("Edit");
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    expect(file.getAttribute("aria-expanded")).toBe("false");
    const popup = bar.popup();
    expect(popup?.hidden).toBe(false);
    expect(bar.entries().map((entry) => entry.getAttribute("data-command-id"))).toEqual(["edit.undo"]);
  });

  it("o `Esc` fecha o menu", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    const file = bar.titles()[0];
    if (file === undefined) return;
    file.dispatch("click");
    expect(bar.handle.openCategory).toBe("File");

    // O `Esc` no **documento** (o menu pode estar aberto com o foco em qualquer lugar).
    bar.doc.dispatch("keydown", { key: "Escape" });

    expect(bar.handle.openCategory).toBeUndefined();
    expect(bar.popup()?.hidden).toBe(true);
    expect(file.getAttribute("aria-expanded")).toBe("false");
  });

  it("o clique fora fecha o menu", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    const file = bar.titles()[0];
    if (file === undefined) return;
    file.dispatch("click");
    expect(bar.handle.openCategory).toBe("File");

    // O clique **fora** (o alvo não está na barra).
    bar.doc.dispatch("click", { target: bar.outside });

    expect(bar.handle.openCategory).toBeUndefined();
  });

  it("o clique num item chama o `onSelect` com o id certo e fecha o menu", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    const file = bar.titles()[0];
    if (file === undefined) return;
    file.dispatch("click");

    const entry = bar.entries()[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    entry.dispatch("click");

    expect(bar.onSelect).toHaveBeenCalledTimes(1);
    expect(bar.onSelect).toHaveBeenCalledWith("file.new");
    expect(bar.handle.openCategory).toBeUndefined();
  });

  it("o atalho aparece à direita do rótulo (dimmed)", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    const file = bar.titles()[0];
    if (file === undefined) return;
    file.dispatch("click");

    const entry = bar.entries()[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const label = entry.children[0];
    const accelerator = entry.children[1];
    expect(label?.className).toBe("menu-entry-label");
    expect(label?.textContent).toBe("Novo arquivo");
    expect(accelerator?.className).toBe("menu-entry-accelerator");
    expect(accelerator?.textContent).toBe("Ctrl+N");
  });

  it("o `Ctrl+N` dispara o atalho do `file.new` (a interceptação)", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    bar.doc.dispatch("keydown", { key: "n", ctrlKey: true });

    expect(bar.onAccelerator).toHaveBeenCalledWith("file.new");
  });

  it("o `F5`/`F9` disparam os atalhos do depurador", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;

    bar.doc.dispatch("keydown", { key: "F5" });
    bar.doc.dispatch("keydown", { key: "F9" });

    expect(bar.onAccelerator).toHaveBeenCalledWith("debug.start");
    expect(bar.onAccelerator).toHaveBeenCalledWith("debug.toggleBreakpoint");
  });

  it("um atalho que o chamador **não** trata não é impedido (o canvas cuida)", () => {
    const bar = mounted;
    expect(bar).toBeDefined();
    if (bar === undefined) return;
    bar.onAccelerator.mockReturnValue(false);

    const event = bar.doc.dispatch("keydown", { key: "s", ctrlKey: true });

    expect(bar.onAccelerator).toHaveBeenCalledWith("file.save");
    expect(event.defaultPrevented).toBe(false);
  });

  it("sem DOM, a barra degrada (sem crash) e o `dispose` limpa o container", () => {
    const handle = attachMenuBar({ container: null, items: ITEMS, onSelect: () => {} });
    expect(handle.openCategory).toBeUndefined();
    handle.setItems(ITEMS);
    handle.close();
    handle.dispose();
  });

  it("o `onClose` avisa o **porquê** do fechamento (o foco volta ao editor)", () => {
    const owner = installFakeDom();
    const doc = new StubDocument(owner);
    const nav = owner.createElement("nav");
    const reasons: string[] = [];
    const handle = attachMenuBar({
      container: nav as unknown as HTMLElement,
      items: ITEMS,
      onSelect: () => {},
      onClose: (reason) => reasons.push(reason),
      document: doc as unknown as Document,
    });
    const title = nav.children.find((child) => child.className === "menu-title");
    expect(title).toBeDefined();
    if (title === undefined) {
      handle.dispose();
      return;
    }

    // O `Esc` ⇒ "escape".
    title.dispatch("click");
    doc.dispatch("keydown", { key: "Escape" });
    expect(reasons).toEqual(["escape"]);

    // O clique num item ⇒ "select".
    title.dispatch("click");
    const popup = nav.children.find((child) => child.className === "menu-popup");
    const entry = popup?.children[0];
    expect(entry).toBeDefined();
    entry?.dispatch("click");
    expect(reasons).toEqual(["escape", "select"]);

    // O clique fora ⇒ "outside".
    title.dispatch("click");
    doc.dispatch("click", { target: owner.createElement("div") });
    expect(reasons).toEqual(["escape", "select", "outside"]);

    // Um `Esc` com o menu **fechado** não mexe no foco (nada a fechar).
    doc.dispatch("keydown", { key: "Escape" });
    expect(reasons).toEqual(["escape", "select", "outside"]);

    handle.dispose();
  });
});

/* ───────────────────────────── a fiação (o renderer) ───────────────────────────── */

describe("barra de menu — a fiação no renderer", () => {
  it("o `Ctrl+N` é o `file.new` (a interceptação acontece **antes** do IPC)", () => {
    expect(menuAcceleratorAction("file.new")).toBe("new-file");
  });

  it("o `F5`/`Shift+F5`/`F9`/`Ctrl+Shift+D` disparam as ações do DAP", () => {
    expect(menuAcceleratorAction("debug.start")).toBe("debug-start");
    expect(menuAcceleratorAction("debug.stop")).toBe("debug-stop");
    expect(menuAcceleratorAction("debug.toggleBreakpoint")).toBe("debug-toggle-breakpoint");
    expect(menuAcceleratorAction("debug.togglePanel")).toBe("debug-toggle-panel");
    expect(menuAcceleratorAction("debug.stepOver")).toBe("debug-step-over");
    expect(menuAcceleratorAction("debug.stepInto")).toBe("debug-step-into");
    expect(menuAcceleratorAction("debug.stepOut")).toBe("debug-step-out");
  });

  it("o `F3`/`Shift+F3` (± a busca) disparam a navegação da find bar", () => {
    expect(menuAcceleratorAction("find.next")).toBe("find-next");
    expect(menuAcceleratorAction("find.prev")).toBe("find-prev");
  });

  it("os atalhos que o **canvas** já cobre NÃO são tratados pela barra", () => {
    // ⚠️ Se a barra os tratasse, o `Ctrl+O` abriria o diálogo **duas** vezes (o canvas já
    // trata) — e o `Ctrl+S` salvaria **duas** vezes.
    for (const id of [
      "file.open",
      "file.save",
      "edit.undo",
      "edit.redo",
      "edit.cut",
      "edit.copy",
      "edit.paste",
      "edit.selectAll",
      "find.open",
      "view.toggleTheme",
    ]) {
      expect(menuAcceleratorAction(id)).toBeUndefined();
    }
  });

  it("a lista do renderer se junta à do core (o core vence em ids repetidos)", () => {
    const core = [
      { id: "file.open", label: "Abrir arquivo", category: "File", accelerator: "Ctrl+O" },
      { id: "file.new", label: "Novo arquivo", category: "File", accelerator: "Ctrl+N" },
    ];
    const extra = [
      { id: "file.new", label: "Novo arquivo (renderer)", category: "File", accelerator: "Ctrl+N" },
      { id: "find.next", label: "Próxima ocorrência", category: "Find", accelerator: "F3" },
    ];

    const merged = mergeMenuItems(core, extra);

    expect(merged.map((item) => item.id)).toEqual(["file.open", "file.new", "find.next"]);
    // O core vence: o rótulo é o do core.
    expect(merged[1]?.label).toBe("Novo arquivo");
    // E a categoria do "file.new" é a "File" ⇒ o título do menu.
    const groups = groupByCategory(merged);
    expect(groups[0]?.name).toBe("File");
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["file.open", "file.new"]);
  });
});
