/**
 * Scribe — *Explorer*: a **árvore de arquivos da workspace** na barra lateral.
 *
 * O painel é **autocontido** (mesma convenção do painel de busca): cria o próprio DOM
 * dentro do `host` que o chamador passa, cuida do filtro e tem `dispose()`. Ele **não**
 * fala com a ponte — quem busca os arquivos é o `main` (via IPC `workspace.files`); o painel
 * só reflete a lista e emite **intenções** (`onOpenFile`).
 *
 * A lógica (**construção da árvore, filtro, expansão, seleção**) vive em funções puras —
 * `src/core/workspace/file-tree.ts` (núcleo) e o {@link ExplorerTreeModel} (estado) — e é
 * o que o vitest testa (o ambiente de teste é `node`, **sem DOM**).
 *
 * ## Convenção de caminho
 *
 * A árvore é montada a partir do **caminho relativo** que o `indexFiles` devolve (com o
 * prefixo do basename da raiz em multi-raiz). O `path` do nó é essa identidade; o
 * **caminho absoluto** (o que o `controller.open` quer) vem do `WorkspaceFile` e é guardado
 * pelo modelo — ver {@link ExplorerFile}.
 *
 * **Degradação**: sem DOM (o ambiente de teste) ou sem `host`, o `mountExplorerTree` devolve
 * um handle **no-op** (o modelo continua funcionando, o DOM não existe).
 */
import {
  buildFileTree,
  collectDirectoryPaths,
  filterTree,
  flattenTree,
  setExpanded,
  toggleExpanded,
} from "../core/workspace/file-tree";
import type { FileTreeNode, FlatTreeEntry } from "../core/workspace/file-tree";
import { watchHostVisibility } from "./host-visibility";

// ---------------------------------------------------------------------------------------------
// Ícones (SVG inline — herdam `currentColor`, então acompanham o tema)
// ---------------------------------------------------------------------------------------------

const CHEVRON_RIGHT =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

const CHEVRON_DOWN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 6 8 10.5 12.5 6"/></svg>';

const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1.8 12.6V3.4a1 1 0 0 1 1-1h3.2l1.4 1.8h5.8a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z"/></svg>';

const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 1.6H4.2a1 1 0 0 0-1 1v10.8a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.4Z"/><path d="M9 1.6V5.4h3.8"/></svg>';

// ---------------------------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------------------------

/**
 * Um arquivo da workspace, visto pelo Explorer.
 *
 * ⚠️ **Estruturalmente idêntico** a `WorkspaceFile` (`src/shared/ipc-contract.ts`) ⇒ o
 * resultado de `bridge.workspaceFiles()` pode ser passado direto para
 * {@link ExplorerTreeHandle.update}.
 */
export interface ExplorerFile {
  /** Caminho **relativo** (é o que o `indexFiles` devolve) — a identidade na árvore. */
  readonly path: string;
  /** Caminho **absoluto** (o que o `controller.open` quer). Default: o próprio `path`. */
  readonly absolutePath?: string | undefined;
}

/** Estado observável do Explorer — o DOM só reflete isto. */
export interface ExplorerTreeState {
  /** Os arquivos carregados. */
  readonly files: readonly ExplorerFile[];
  /** O texto do filtro incremental ("" = sem filtro). */
  readonly query: string;
  /** Os caminhos (relativos) dos diretórios expandidos. */
  readonly expanded: ReadonlySet<string>;
  /** O caminho (relativo) do item selecionado, se houver. */
  readonly selected: string | undefined;
  /** Quantos itens estão visíveis (a lista desenhada). */
  readonly visibleCount: number;
}

/** Notificado a cada mudança de estado (o DOM se redesenha). */
export type ExplorerTreeOnChange = (state: ExplorerTreeState) => void;

/** Notificado quando o usuário **abre** um arquivo (caminho **absoluto**). */
export type ExplorerTreeOnOpenFile = (absolutePath: string) => void;

// ---------------------------------------------------------------------------------------------
// Modelo (estado puro — sem DOM)
// ---------------------------------------------------------------------------------------------

/** Opções do {@link ExplorerTreeModel}. */
export interface ExplorerTreeModelOptions {
  /** Chamado quando o usuário abre um arquivo (caminho **absoluto**). */
  readonly onOpenFile?: ExplorerTreeOnOpenFile | undefined;
  /** Notificado a cada mudança de estado. */
  readonly onChange?: ExplorerTreeOnChange | undefined;
}

/**
 * Estado do Explorer: **expansão** + **filtro** + **seleção**.
 *
 * Não conhece o DOM — o `mountExplorerTree` só reflete o que o modelo devolve.
 */
export class ExplorerTreeModel {
  private filesValue: readonly ExplorerFile[] = [];
  private treeValue: readonly FileTreeNode[] = [];
  private queryValue = "";
  private expandedValue: Set<string> = new Set<string>();
  private selectedValue: string | undefined = undefined;
  private readonly absolutePaths = new Map<string, string>();
  private readonly listeners = new Set<ExplorerTreeOnChange>();

  constructor(private readonly options: ExplorerTreeModelOptions = {}) {}

  /** Os arquivos carregados. */
  get files(): readonly ExplorerFile[] {
    return this.filesValue;
  }

  /** O texto do filtro incremental. */
  get query(): string {
    return this.queryValue;
  }

  /** Os diretórios expandidos (caminhos relativos). */
  get expanded(): ReadonlySet<string> {
    return this.expandedValue;
  }

  /** O item selecionado (caminho relativo), se houver. */
  get selected(): string | undefined {
    return this.selectedValue;
  }

  /** A árvore **completa** (sem filtro). */
  tree(): readonly FileTreeNode[] {
    return this.treeValue;
  }

  /** A árvore **filtrada** (o que o filtro incremental deixou passar). */
  filteredTree(): readonly FileTreeNode[] {
    return filterTree(this.treeValue, this.queryValue);
  }

  /**
   * A lista **visível** (achata a árvore filtrada respeitando a expansão).
   *
   * Com um filtro **ativo**, tudo aparece expandido (é o comportamento do VS Code: o
   * filtro revela o caminho do arquivo que casou).
   */
  visibleEntries(): readonly FlatTreeEntry[] {
    const filtered = this.filteredTree();
    if (this.queryValue.trim().length === 0) return flattenTree(filtered, this.expandedValue);
    return flattenTree(filtered, collectDirectoryPaths(filtered));
  }

  /** O estado observável (o DOM só reflete isto). */
  state(): ExplorerTreeState {
    return {
      files: this.filesValue,
      query: this.queryValue,
      expanded: this.expandedValue,
      selected: this.selectedValue,
      visibleCount: this.visibleEntries().length,
    };
  }

  /** O caminho **absoluto** de um arquivo (relativo), se ele existir. */
  absolutePathOf(path: string): string | undefined {
    return this.absolutePaths.get(path);
  }

  /** Assina as mudanças de estado (devolve a função de cancelamento). */
  subscribe(listener: ExplorerTreeOnChange): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Carrega a lista de arquivos (rebuild da árvore; a expansão é **preservada**). */
  setFiles(files: readonly ExplorerFile[]): void {
    this.filesValue = [...files];
    this.absolutePaths.clear();
    for (const file of files) {
      this.absolutePaths.set(file.path, file.absolutePath ?? file.path);
    }
    this.treeValue = buildFileTree(files.map((file) => file.path));
    if (this.selectedValue !== undefined && !this.absolutePaths.has(this.selectedValue)) {
      this.selectedValue = undefined;
    }
    this.emit();
  }

  /** Carrega uma lista de caminhos **relativos** (sem caminho absoluto). */
  setPaths(paths: readonly string[]): void {
    this.setFiles(paths.map((path) => ({ path })));
  }

  /** Define o filtro incremental ("" = sem filtro). */
  setQuery(query: string): void {
    if (this.queryValue === query) return;
    this.queryValue = query;
    this.emit();
  }

  /** Alterna a expansão de um diretório. */
  toggle(path: string): void {
    this.expandedValue = toggleExpanded(this.expandedValue, path);
    this.emit();
  }

  /** Expande (ou colapsa) um diretório. */
  setExpanded(path: string, expanded: boolean): void {
    this.expandedValue = setExpanded(this.expandedValue, path, expanded);
    this.emit();
  }

  /** Expande todos os diretórios. */
  expandAll(): void {
    this.expandedValue = new Set(collectDirectoryPaths(this.treeValue));
    this.emit();
  }

  /** Colapsa todos os diretórios. */
  collapseAll(): void {
    this.expandedValue = new Set<string>();
    this.emit();
  }

  /** Seleciona um item (caminho relativo). */
  select(path: string | undefined): void {
    if (this.selectedValue === path) return;
    this.selectedValue = path;
    this.emit();
  }

  /**
   * Abre um arquivo: seleciona e **notifica** o `onOpenFile` com o caminho **absoluto**.
   *
   * Não faz nada se o arquivo não existir na lista.
   */
  open(path: string): void {
    const absolute = this.absolutePaths.get(path);
    if (absolute === undefined) return;
    this.select(path);
    this.options.onOpenFile?.(absolute);
  }

  /** Emite a mudança de estado (modelo + assinantes + `onChange`). */
  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
    this.options.onChange?.(state);
  }
}

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

/** Opções do {@link mountExplorerTree}. */
export interface ExplorerTreeOptions {
  /** Modelo pronto (o chamador monta e consulta). Sem ele, um modelo novo é criado. */
  readonly model?: ExplorerTreeModel | undefined;
  /** Chamado quando o usuário clica num arquivo (caminho **absoluto**). */
  readonly onOpenFile?: ExplorerTreeOnOpenFile | undefined;
  /** Notificado a cada mudança de estado. */
  readonly onChange?: ExplorerTreeOnChange | undefined;
  /** Mostrar o campo de filtro (default `true`). */
  readonly showFilter?: boolean | undefined;
  /** Texto do estado vazio (sem arquivos). */
  readonly emptyMessage?: string | undefined;
}

/** Superfície do Explorer (o `main.ts` só reflete o estado por aqui). */
export interface ExplorerTreeHandle {
  /** O modelo (estado de expansão + filtro + seleção). */
  readonly model: ExplorerTreeModel;
  /** Carrega a lista de arquivos (rebuild da árvore). */
  update(files: readonly ExplorerFile[]): void;
  /** Carrega uma lista de caminhos relativos (sem caminho absoluto). */
  setPaths(paths: readonly string[]): void;
  /** Define o filtro incremental (o campo de filtro é atualizado). */
  setFilter(query: string): void;
  /** Expande todos os diretórios. */
  expandAll(): void;
  /** Colapsa todos os diretórios. */
  collapseAll(): void;
  /** Remove o DOM e cancela as assinaturas. */
  dispose(): void;
}

/**
 * Handle **degradado** (sem DOM ou sem `host).
 *
 * O **modelo continua funcionando** (ele é puro, não conhece o DOM) ⇒ o chamador ainda
 * consegue consultar o estado; só o **desenho** não acontece.
 */
function createNoopHandle(model: ExplorerTreeModel): ExplorerTreeHandle {
  return {
    model,
    update: (files: readonly ExplorerFile[]): void => {
      model.setFiles(files);
    },
    setPaths: (paths: readonly string[]): void => {
      model.setPaths(paths);
    },
    setFilter: (query: string): void => {
      model.setQuery(query);
    },
    expandAll: (): void => {
      model.expandAll();
    },
    collapseAll: (): void => {
      model.collapseAll();
    },
    dispose: (): void => {},
  };
}

/**
 * Monta o Explorer dentro do `host` (cria o DOM, devolve o handle).
 *
 * **Degradação**: sem `document` (ambiente de teste) ou sem `host` ⇒ devolve um handle
 * **no-op** (sem crash). O `host` é quem controla a **visibilidade** (`host.hidden`).
 */
export function mountExplorerTree(
  host: HTMLElement | null | undefined,
  options: ExplorerTreeOptions = {},
): ExplorerTreeHandle {
  const model =
    options.model ??
    new ExplorerTreeModel({
      onOpenFile: options.onOpenFile,
      onChange: options.onChange,
    });

  if (host === null || host === undefined || typeof document === "undefined") {
    return createNoopHandle(model);
  }

  // O painel só redesenha quando está **visível** (e redesenha quando aparece).
  const visibility = watchHostVisibility(host, (): void => {
    render();
  });

  const root = document.createElement("div");
  root.className = "explorer-tree";
  root.setAttribute("role", "tree");
  root.setAttribute("aria-label", "Arquivos da workspace");
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
  head.className = "explorer-tree-head";
  head.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-1);",
    "padding: var(--s-space-1) var(--s-space-2);",
    "border-bottom: 1px solid var(--s-border);",
  ].join(" ");

  const input = document.createElement("input");
  input.className = "explorer-tree-filter";
  input.type = "text";
  input.placeholder = "Filtrar arquivos";
  input.setAttribute("aria-label", "Filtrar arquivos");
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

  const list = document.createElement("div");
  list.className = "explorer-tree-list";
  list.setAttribute("role", "group");
  list.style.cssText = [
    "flex: 1 1 auto;",
    "min-height: 0;",
    "overflow-y: auto;",
    "overflow-x: hidden;",
    "padding: var(--s-space-1) 0;",
  ].join(" ");

  const empty = document.createElement("div");
  empty.className = "explorer-tree-empty";
  empty.setAttribute("role", "status");
  empty.style.cssText = [
    "padding: var(--s-space-2);",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-xs);",
  ].join(" ");

  if (options.showFilter !== false) {
    head.appendChild(input);
    root.appendChild(head);
  }
  root.append(list);
  host.appendChild(root);

  // Abre o arquivo: o `onOpenFile` das opções tem precedência; sem ele, o do modelo.
  const openFile = (path: string): void => {
    const absolute = model.absolutePathOf(path) ?? path;
    if (options.onOpenFile !== undefined) {
      model.select(path);
      options.onOpenFile(absolute);
      return;
    }
    model.open(path);
  };

  const activate = (node: FileTreeNode): void => {
    if (node.kind === "dir") {
      model.select(node.path);
      model.toggle(node.path);
      return;
    }
    openFile(node.path);
  };

  const render = (): void => {
    // Escondido (`host.hidden`) ⇒ **não** redesenha: o DOM fica sujo e é redesenhado
    // quando o host ficar visível.
    if (visibility.hidden) {
      visibility.markDirty();
      return;
    }
    visibility.markClean();
    const entries = model.visibleEntries();
    list.replaceChildren();
    if (entries.length === 0) {
      const filtering = model.query.trim().length > 0;
      empty.textContent = filtering
        ? "Nenhum arquivo corresponde ao filtro"
        : (options.emptyMessage ?? "Nenhum arquivo na workspace");
      empty.hidden = false;
      list.appendChild(empty);
      return;
    }
    empty.hidden = true;

    for (const entry of entries) {
      const node = entry.node;
      const isDir = node.kind === "dir";

      const item = document.createElement("div");
      item.className = `explorer-tree-item explorer-tree-${isDir ? "dir" : "file"}`;
      item.setAttribute("role", "treeitem");
      item.setAttribute("aria-level", String(entry.depth + 1));
      item.setAttribute("data-path", node.path);
      item.setAttribute("tabindex", "0");
      item.title = node.path;
      item.style.cssText = [
        "display: flex;",
        "align-items: center;",
        "gap: var(--s-space-1);",
        `padding: 2px var(--s-space-2) 2px ${8 + entry.depth * 12}px;`,
        "cursor: pointer;",
        "white-space: nowrap;",
        "overflow: hidden;",
      ].join(" ");

      if (isDir) item.setAttribute("aria-expanded", String(entry.expanded));
      if (model.selected === node.path) {
        item.classList.add("explorer-tree-selected");
        item.setAttribute("aria-selected", "true");
        item.style.backgroundColor = "var(--s-selected)";
      }

      const chevron = document.createElement("span");
      chevron.className = "explorer-tree-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.style.cssText = [
        "flex: 0 0 auto;",
        "width: 14px;",
        "display: inline-flex;",
        "align-items: center;",
        "opacity: .8;",
      ].join(" ");
      if (isDir) {
        chevron.innerHTML = entry.expanded ? CHEVRON_DOWN : CHEVRON_RIGHT;
      }

      const icon = document.createElement("span");
      icon.className = "explorer-tree-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.style.cssText = ["flex: 0 0 auto;", "display: inline-flex;", "opacity: .9;"].join(" ");
      icon.innerHTML = isDir ? FOLDER_ICON : FILE_ICON;

      const label = document.createElement("span");
      label.className = "explorer-tree-label";
      label.textContent = node.name;
      label.style.cssText = ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"].join(
        " ",
      );

      item.append(chevron, icon, label);
      item.addEventListener("click", (): void => {
        activate(node);
      });
      item.addEventListener("keydown", (event: KeyboardEvent): void => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        activate(node);
      });
      item.addEventListener("mouseenter", (): void => {
        if (model.selected === node.path) return;
        item.style.backgroundColor = "var(--s-hover)";
      });
      item.addEventListener("mouseleave", (): void => {
        if (model.selected === node.path) return;
        item.style.backgroundColor = "transparent";
      });
      list.appendChild(item);
    }
  };

  const unsubscribe = model.subscribe((): void => {
    render();
  });

  input.addEventListener("input", (): void => {
    model.setQuery(input.value);
  });

  render();

  return {
    model,
    update: (files: readonly ExplorerFile[]): void => {
      model.setFiles(files);
    },
    setPaths: (paths: readonly string[]): void => {
      model.setPaths(paths);
    },
    setFilter: (query: string): void => {
      input.value = query;
      model.setQuery(query);
    },
    expandAll: (): void => {
      model.expandAll();
    },
    collapseAll: (): void => {
      model.collapseAll();
    },
    dispose: (): void => {
      visibility.dispose();
      unsubscribe();
      root.remove();
    },
  };
}
