/**
 * Scribe — **Outline**: a coluna da sidebar com a **estrutura** do documento ativo
 * (a árvore de símbolos do LSP — `textDocument/documentSymbol`).
 *
 * É o "Outline" do VS Code: funções, classes, variáveis — aninhadas como o servidor as
 * devolveu, filtráveis por nome, navegáveis pelo teclado e com **clique para pular** ao
 * símbolo.
 *
 * **Duas camadas, como no resto do renderer:**
 * 1. `OutlineModel` — a lógica **pura** (achatamento, filtro, navegação, agrupamento por
 *    kind). Sem DOM: é o que o vitest testa (o ambiente de teste é `node`, sem jsdom).
 * 2. `mountOutlineView` — o **DOM** (input de filtro + lista hierárquica). Quando não há
 *    DOM (ou não há `host`), devolve um handle **no-op**: nunca estoura.
 *
 * **De onde vêm os símbolos:** o `main` busca pelo bridge (`lsp.documentSymbols`) e entrega
 * a lista **achatada** — o core codifica a profundidade em `detail` (ver `flatSymbolDepth`).
 * O painel também aceita a forma **hierárquica** (`children`), que é a que o servidor LSP
 * devolve, e reconstrói os pais pela profundidade.
 *
 * Escolha nossa (não observada no alvo): o alvo (Sublime Text) não expõe uma árvore de
 * símbolos na barra lateral — o Outline aqui é uma evolução nossa, no espírito do editor.
 */
import { SymbolKind } from "../core/lsp/lsp-protocol";
import { watchHostVisibility } from "./host-visibility";

// ── Contrato de entrada ─────────────────────────────────────────────────────────────────────

/** Range de um símbolo (0-based, linha/coluna) — o mesmo formato do contrato do LSP. */
export interface OutlineSymbolRange {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

/**
 * Um símbolo na entrada do painel.
 *
 * Aceita as **duas** formas que o Scribe produz:
 * - **hierárquica** (o que o servidor LSP devolve): `children` aninhado;
 * - **achatada** (o que o bridge `lsp.documentSymbols` entrega): sem `children`, com a
 *   profundidade codificada no `detail` (ver `flatSymbolDepth`).
 *
 * É estruturalmente compatível com `LspDocumentSymbolHierarchy` (`src/shared/lsp-contract.ts`).
 */
export interface OutlineSymbolInput {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: OutlineSymbolRange;
  readonly children?: readonly OutlineSymbolInput[];
}

// ── Classificação por kind ──────────────────────────────────────────────────────────────────

/** Família do símbolo (usada para agrupar e para o estilo do ícone). */
export type OutlineSymbolGroup =
  | "módulos"
  | "tipos"
  | "funções"
  | "variáveis"
  | "valores"
  | "eventos"
  | "operadores"
  | "outros";

/** Metadados de um `SymbolKind` do LSP: nome, rótulo curto e família. */
export interface OutlineSymbolMeta {
  readonly kind: number;
  /** Nome canônico do kind (inglês, como no LSP) — usado em `title`/`aria-label`. */
  readonly name: string;
  /** Rótulo curto exibido no ícone (ex.: `C`, `M`, `fn`, `v`). */
  readonly label: string;
  /** Família do símbolo. */
  readonly group: OutlineSymbolGroup;
}

const SYMBOL_META: Readonly<Record<number, OutlineSymbolMeta>> = {
  [SymbolKind.File]: { kind: SymbolKind.File, name: "file", label: "fi", group: "módulos" },
  [SymbolKind.Module]: { kind: SymbolKind.Module, name: "module", label: "M", group: "módulos" },
  [SymbolKind.Namespace]: { kind: SymbolKind.Namespace, name: "namespace", label: "ns", group: "módulos" },
  [SymbolKind.Package]: { kind: SymbolKind.Package, name: "package", label: "pk", group: "módulos" },
  [SymbolKind.Class]: { kind: SymbolKind.Class, name: "class", label: "C", group: "tipos" },
  [SymbolKind.Method]: { kind: SymbolKind.Method, name: "method", label: "M", group: "funções" },
  [SymbolKind.Property]: { kind: SymbolKind.Property, name: "property", label: "p", group: "variáveis" },
  [SymbolKind.Field]: { kind: SymbolKind.Field, name: "field", label: "f", group: "variáveis" },
  [SymbolKind.Constructor]: { kind: SymbolKind.Constructor, name: "constructor", label: "ctor", group: "funções" },
  [SymbolKind.Enum]: { kind: SymbolKind.Enum, name: "enum", label: "E", group: "tipos" },
  [SymbolKind.Interface]: { kind: SymbolKind.Interface, name: "interface", label: "I", group: "tipos" },
  [SymbolKind.Function]: { kind: SymbolKind.Function, name: "function", label: "fn", group: "funções" },
  [SymbolKind.Variable]: { kind: SymbolKind.Variable, name: "variable", label: "v", group: "variáveis" },
  [SymbolKind.Constant]: { kind: SymbolKind.Constant, name: "constant", label: "c", group: "variáveis" },
  [SymbolKind.String]: { kind: SymbolKind.String, name: "string", label: "s", group: "valores" },
  [SymbolKind.Number]: { kind: SymbolKind.Number, name: "number", label: "n", group: "valores" },
  [SymbolKind.Boolean]: { kind: SymbolKind.Boolean, name: "boolean", label: "b", group: "valores" },
  [SymbolKind.Array]: { kind: SymbolKind.Array, name: "array", label: "[]", group: "valores" },
  [SymbolKind.Object]: { kind: SymbolKind.Object, name: "object", label: "o", group: "valores" },
  [SymbolKind.Key]: { kind: SymbolKind.Key, name: "key", label: "k", group: "valores" },
  [SymbolKind.Null]: { kind: SymbolKind.Null, name: "null", label: "nil", group: "valores" },
  [SymbolKind.EnumMember]: { kind: SymbolKind.EnumMember, name: "enumMember", label: "em", group: "valores" },
  [SymbolKind.Struct]: { kind: SymbolKind.Struct, name: "struct", label: "st", group: "tipos" },
  [SymbolKind.Event]: { kind: SymbolKind.Event, name: "event", label: "ev", group: "eventos" },
  [SymbolKind.Operator]: { kind: SymbolKind.Operator, name: "operator", label: "op", group: "operadores" },
  [SymbolKind.TypeParameter]: { kind: SymbolKind.TypeParameter, name: "typeParameter", label: "tp", group: "tipos" },
};

/** Metadados de um kind (desconhecido ⇒ `outros`/rótulo `?`). */
export function outlineSymbolMeta(kind: number): OutlineSymbolMeta {
  return (
    SYMBOL_META[kind] ?? {
      kind,
      name: "symbol",
      label: "?",
      group: "outros" as OutlineSymbolGroup,
    }
  );
}

/** Rótulo curto do kind (ex.: `C`, `M`, `fn`, `v`). */
export function outlineSymbolLabel(kind: number): string {
  return outlineSymbolMeta(kind).label;
}

/** Família do kind (ex.: `tipos`, `funções`, `variáveis`). */
export function outlineSymbolGroup(kind: number): OutlineSymbolGroup {
  return outlineSymbolMeta(kind).group;
}

// ── Modelo (puro) ───────────────────────────────────────────────────────────────────────────

/** Um nó da árvore (símbolo achatado, com a profundidade). */
export interface OutlineNode {
  /** Id estável do nó dentro da árvore (`"0"`, `"0.1"`, …). */
  readonly id: string;
  /** Nome do símbolo. */
  readonly name: string;
  /** Detalhe (assinatura, tipo) — ausente quando o símbolo é um nó de estrutura. */
  readonly detail?: string;
  /** `SymbolKind` do LSP. */
  readonly kind: number;
  /** Nome canônico do kind (`"class"`, `"function"`, …). */
  readonly kindName: string;
  /** Rótulo curto do kind (o que o ícone mostra). */
  readonly label: string;
  /** Família do kind. */
  readonly group: OutlineSymbolGroup;
  /** Profundidade na árvore (0-based). */
  readonly depth: number;
  /** Linha do **nome** do símbolo (0-based). */
  readonly line: number;
  /** Coluna do nome do símbolo (0-based). */
  readonly column: number;
  /** Fim do símbolo (0-based) — informativo. */
  readonly endLine: number;
  readonly endColumn: number;
  /** O símbolo tem filhos? */
  readonly hasChildren: boolean;
}

/** Para onde o painel manda pular quando o usuário escolhe um símbolo. */
export interface OutlineRevealTarget {
  /** Linha do símbolo (0-based). */
  readonly line: number;
  /** Coluna do símbolo (0-based). */
  readonly column: number;
  readonly name: string;
  readonly kind: number;
  readonly depth: number;
}

/** Por que o painel está vazio. */
export type OutlineEmptyReason = "no-symbols" | "no-match" | "no-lsp";

/** Texto do estado vazio (o painel mostra isto quando não há o que listar). */
export function describeOutlineEmpty(reason: OutlineEmptyReason): string {
  switch (reason) {
    case "no-lsp":
      return "Sem servidor LSP para este arquivo";
    case "no-match":
      return "Nenhum símbolo corresponde ao filtro";
    case "no-symbols":
      return "Nenhum símbolo neste documento";
  }
}

/** Estado observável do modelo — o DOM só reflete isto. */
export interface OutlineState {
  /** Todos os nós (sem filtro). */
  readonly nodes: readonly OutlineNode[];
  /** Nós visíveis depois do filtro. */
  readonly visibleNodes: readonly OutlineNode[];
  /** Filtro atual. */
  readonly query: string;
  /** Índice do nó selecionado dentro de `visibleNodes` (−1 = nada). */
  readonly selectedIndex: number;
  /** Motivo do vazio (undefined = há conteúdo). */
  readonly emptyReason: OutlineEmptyReason | undefined;
}

/** Opções do modelo. */
export interface OutlineModelOptions {
  /** Chamado quando o usuário pede para pular para o símbolo selecionado. */
  readonly onReveal?: ((target: OutlineRevealTarget) => void) | undefined;
  /** Chamado a cada mudança de estado (o DOM se redesenha). */
  readonly onChange?: ((state: OutlineState) => void) | undefined;
}

/**
 * Profundidade codificada no `detail` de um símbolo **achatado**.
 *
 * [OBSERVADO] O core achata a hierarquia do LSP e marca a profundidade com
 * `"·".repeat(depth)` no `detail` (`src/core/editor/editor-core.ts:588`). Um `detail` que
 * só tem "·" é, portanto, a **profundidade** do símbolo — e não um detalhe de verdade.
 * Um `detail` normal (assinatura, tipo) devolve `0`.
 */
export function flatSymbolDepth(symbol: { readonly detail?: string }): number {
  const detail = symbol.detail;
  if (detail === undefined || detail.length === 0) return 0;
  let depth = 0;
  for (const char of detail) {
    if (char !== "·") return 0;
    depth += 1;
  }
  return depth;
}

/** Entrada interna do modelo: o nó + o índice do pai (−1 = raiz). */
interface OutlineEntry {
  readonly node: OutlineNode;
  readonly parentIndex: number;
}

/**
 * Achata a hierarquia de símbolos numa lista de nós com `depth` (0-based).
 *
 * Aceita a forma hierárquica (`children`) e a achatada (profundidade no `detail`).
 * Os pais são reconstruídos pela **profundidade** (uma pilha), o que funciona nos dois
 * casos — inclusive na lista achatada, onde o pai é o símbolo anterior de menor depth.
 */
export function flattenOutlineSymbols(symbols: readonly OutlineSymbolInput[]): readonly OutlineNode[] {
  return flattenEntries(symbols).map((entry) => entry.node);
}

function flattenEntries(symbols: readonly OutlineSymbolInput[]): readonly OutlineEntry[] {
  const entries: OutlineEntry[] = [];

  const walk = (list: readonly OutlineSymbolInput[], depth: number, path: string): void => {
    list.forEach((symbol, index) => {
      const children = symbol.children ?? [];
      const dotDepth = flatSymbolDepth(symbol);
      // Numa lista achatada a profundidade vem do `detail`; numa hierárquica, da estrutura.
      const nodeDepth = depth > 0 ? depth : dotDepth;
      const id = path === "" ? String(index) : `${path}.${index}`;
      const meta = outlineSymbolMeta(symbol.kind);
      const node: OutlineNode = {
        id,
        name: symbol.name,
        // O "·" do detalhe achatado é codificação de profundidade, não detalhe.
        ...(symbol.detail !== undefined && dotDepth === 0 ? { detail: symbol.detail } : {}),
        kind: symbol.kind,
        kindName: meta.name,
        label: meta.label,
        group: meta.group,
        depth: nodeDepth,
        line: symbol.range.startLine,
        column: symbol.range.startCol,
        endLine: symbol.range.endLine,
        endColumn: symbol.range.endCol,
        hasChildren: children.length > 0,
      };
      entries.push({ node, parentIndex: -1 });
      if (children.length > 0) walk(children, depth + 1, id);
    });
  };

  walk(symbols, 0, "");

  // Reconstroi os pais pela profundidade (pilha) — vale para as duas formas de entrada.
  const stack: number[] = [];
  const linked: OutlineEntry[] = [];
  entries.forEach((entry, index) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if ((entries[top]?.node.depth ?? 0) < entry.node.depth) break;
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
    linked.push({ node: entry.node, parentIndex: parent ?? -1 });
    stack.push(index);
  });
  return linked;
}

/** Um grupo de símbolos por família (kind). */
export interface OutlineKindGroup {
  readonly group: OutlineSymbolGroup;
  readonly nodes: readonly OutlineNode[];
}

/**
 * Agrupa os nós por família de kind, preservando a ordem de aparição.
 *
 * Usado para uma visão agrupada (e testado isoladamente da hierarquia da árvore).
 */
export function groupOutlineByKind(nodes: readonly OutlineNode[]): readonly OutlineKindGroup[] {
  const order: OutlineSymbolGroup[] = [];
  const buckets = new Map<OutlineSymbolGroup, OutlineNode[]>();
  for (const node of nodes) {
    const bucket = buckets.get(node.group);
    if (bucket === undefined) {
      buckets.set(node.group, [node]);
      order.push(node.group);
    } else {
      bucket.push(node);
    }
  }
  return order.map((group) => ({ group, nodes: buckets.get(group) ?? [] }));
}

/**
 * Modelo **puro** da árvore de símbolos: estado, filtro, navegação e seleção.
 *
 * Não conhece DOM — quem desenha é `mountOutlineView`.
 */
export class OutlineModel {
  private entries: readonly OutlineEntry[] = [];
  private visible: readonly OutlineEntry[] = [];
  private queryValue = "";
  private selectedIndexValue = -1;
  private lspAvailableValue = true;

  constructor(private readonly options: OutlineModelOptions = {}) {}

  /** Todos os nós (sem filtro). */
  get nodes(): readonly OutlineNode[] {
    return this.entries.map((entry) => entry.node);
  }

  /** Nós visíveis depois do filtro. */
  get visibleNodes(): readonly OutlineNode[] {
    return this.visible.map((entry) => entry.node);
  }

  /** Filtro atual. */
  get query(): string {
    return this.queryValue;
  }

  /** Índice do selecionado em `visibleNodes` (−1 = nada selecionado). */
  get selectedIndex(): number {
    return this.selectedIndexValue;
  }

  /** O nó selecionado (undefined se não houver). */
  get selected(): OutlineNode | undefined {
    if (this.selectedIndexValue < 0) return undefined;
    return this.visible[this.selectedIndexValue]?.node;
  }

  /** Estado observável (o DOM só reflete isto). */
  state(): OutlineState {
    return {
      nodes: this.nodes,
      visibleNodes: this.visibleNodes,
      query: this.queryValue,
      selectedIndex: this.selectedIndexValue,
      emptyReason: this.emptyReason(),
    };
  }

  /**
   * Troca a lista de símbolos (a hierarquia é achatada).
   *
   * O filtro atual é **mantido** (o usuário não perde o que digitou quando o documento
   * recarrega); a seleção volta para o primeiro item visível.
   */
  setSymbols(symbols: readonly OutlineSymbolInput[]): void {
    this.entries = flattenEntries(symbols);
    this.applyFilter();
    this.selectedIndexValue = this.visible.length > 0 ? 0 : -1;
    this.emit();
  }

  /**
   * Filtra por nome (case-insensitive).
   *
   * Regra do VS Code: quando um **pai** casa, os **filhos** também aparecem (a subárvore
   * inteira fica visível). Um filho que casa sozinho aparece mesmo que o pai não case.
   */
  filter(query: string): void {
    const next = query.trim();
    if (this.queryValue === next) return;
    this.queryValue = next;
    this.applyFilter();
    this.selectedIndexValue = this.visible.length > 0 ? 0 : -1;
    this.emit();
  }

  /** Seleciona o próximo item visível (com wrap). */
  selectNext(): void {
    const count = this.visible.length;
    if (count === 0) return;
    this.selectedIndexValue =
      this.selectedIndexValue < 0 ? 0 : (this.selectedIndexValue + 1) % count;
    this.emit();
  }

  /** Seleciona o item anterior (com wrap). */
  selectPrev(): void {
    const count = this.visible.length;
    if (count === 0) return;
    this.selectedIndexValue =
      this.selectedIndexValue < 0
        ? count - 1
        : (this.selectedIndexValue - 1 + count) % count;
    this.emit();
  }

  /** Seleciona um item pelo índice (visível). */
  selectIndex(index: number): void {
    if (index < 0 || index >= this.visible.length) return;
    if (this.selectedIndexValue === index) return;
    this.selectedIndexValue = index;
    this.emit();
  }

  /** Seleciona um item pelo id do nó (`"0.1"`). */
  selectById(id: string): void {
    const index = this.visible.findIndex((entry) => entry.node.id === id);
    if (index < 0) return;
    this.selectIndex(index);
  }

  /** Emite o "pule para o símbolo" do item selecionado. */
  reveal(): void {
    const node = this.selected;
    if (node === undefined) return;
    this.options.onReveal?.({
      line: node.line,
      column: node.column,
      name: node.name,
      kind: node.kind,
      depth: node.depth,
    });
  }

  /** O servidor LSP está disponível para este documento? */
  setLspAvailable(available: boolean): void {
    if (this.lspAvailableValue === available) return;
    this.lspAvailableValue = available;
    this.emit();
  }

  /** Limpa o modelo (o painel some). */
  dispose(): void {
    this.entries = [];
    this.visible = [];
    this.queryValue = "";
    this.selectedIndexValue = -1;
  }

  // ---- interno -------------------------------------------------------------------------------

  private applyFilter(): void {
    const query = this.queryValue.trim().toLowerCase();
    if (query.length === 0) {
      this.visible = this.entries;
      return;
    }
    const flags: boolean[] = new Array<boolean>(this.entries.length).fill(false);
    const visible: OutlineEntry[] = [];
    this.entries.forEach((entry, index) => {
      const parentVisible = entry.parentIndex >= 0 ? flags[entry.parentIndex] === true : false;
      const self = entry.node.name.toLowerCase().includes(query);
      const isVisible = self || parentVisible;
      flags[index] = isVisible;
      if (isVisible) visible.push(entry);
    });
    this.visible = visible;
  }

  private emptyReason(): OutlineEmptyReason | undefined {
    if (!this.lspAvailableValue) return "no-lsp";
    if (this.entries.length === 0) return "no-symbols";
    if (this.visible.length === 0) return "no-match";
    return undefined;
  }

  private emit(): void {
    this.options.onChange?.(this.state());
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────────────────────

/** Opções do painel DOM. */
export interface OutlineViewOptions {
  /** Chamado quando o usuário escolhe um símbolo (o `main` move o caret). */
  readonly onReveal?: ((target: OutlineRevealTarget) => void) | undefined;
  /** Chamado quando o filtro muda (o `main` pode querer persistir a query). */
  readonly onFilterChange?: ((query: string) => void) | undefined;
  /** Placeholder do input de filtro. */
  readonly placeholder?: string;
  /** Rótulo acessível da coluna. */
  readonly ariaLabel?: string;
}

/** Superfície do painel (o `main` só reflete o estado por aqui). */
export interface OutlineViewHandle {
  /** O modelo puro — útil paraconsultar estado sem passar pelo DOM. */
  readonly model: OutlineModel;
  /** Troca a lista de símbolos (hierárquica ou achatada). */
  update(symbols: readonly OutlineSymbolInput[]): void;
  /** Muda o filtro (e o input). */
  setFilter(query: string): void;
  /** Diz se há servidor LSP para o documento (muda o estado vazio). */
  setLspAvailable(available: boolean): void;
  /** Foca o input de filtro. */
  focus(): void;
  /** Desmonta o painel. */
  dispose(): void;
}

const INDENT_STEP_PX = 12;
const INDENT_BASE_PX = 8;

/**
 * Monta o painel de Outline dentro do `host`.
 *
 * **Degradação:** sem DOM (ambiente de teste) ou sem `host`, devolve um handle **no-op** —
 * nada é desenhado, nada estoura. O modelo continua funcionando (é puro), o que permite
 * testar a lógica sem DOM.
 */
export function mountOutlineView(
  host: HTMLElement | null | undefined,
  options: OutlineViewOptions = {},
): OutlineViewHandle {
  // `render` é atribuído depois: sem DOM ele precisa ser um no-op.
  let render: () => void = (): void => {};

  const model = new OutlineModel({
    onReveal: options.onReveal,
    onChange: (): void => {
      render();
    },
  });

  if (host === null || host === undefined || typeof document === "undefined") {
    return {
      model,
      update: (symbols: readonly OutlineSymbolInput[]): void => {
        model.setSymbols(symbols);
      },
      setFilter: (query: string): void => {
        model.filter(query);
      },
      setLspAvailable: (available: boolean): void => {
        model.setLspAvailable(available);
      },
      focus: (): void => {},
      dispose: (): void => {
        model.dispose();
      },
    };
  }

  // O painel só redesenha quando está **visível** (e redesenha quando aparece).
  const visibility = watchHostVisibility(host, (): void => {
    render();
  });

  const root = document.createElement("div");
  root.className = "outline-view";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", options.ariaLabel ?? "Estrutura do documento");
  root.style.cssText = [
    "display: flex;",
    "flex-direction: column;",
    "min-height: 0;",
    "height: 100%;",
    "overflow: hidden;",
    "background: var(--s-sidebar);",
    "color: var(--s-fg);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-sm);",
  ].join(" ");

  const head = document.createElement("div");
  head.className = "outline-head";
  head.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-1);",
    "padding: var(--s-space-2);",
    "border-bottom: 1px solid var(--s-border);",
  ].join(" ");

  const input = document.createElement("input");
  input.className = "outline-filter";
  input.type = "text";
  input.placeholder = options.placeholder ?? "Filtrar símbolos";
  input.setAttribute("aria-label", "Filtrar símbolos");
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

  const count = document.createElement("span");
  count.className = "outline-count";
  count.setAttribute("aria-live", "polite");
  count.style.cssText = [
    "flex: 0 0 auto;",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-xs);",
  ].join(" ");

  head.append(input, count);

  const list = document.createElement("div");
  list.className = "outline-list";
  list.setAttribute("role", "tree");
  list.setAttribute("aria-label", "Símbolos do documento");
  list.style.cssText = ["flex: 1 1 auto;", "min-height: 0;", "overflow-y: auto;"].join(" ");

  const empty = document.createElement("div");
  empty.className = "outline-empty";
  empty.setAttribute("role", "status");
  empty.setAttribute("aria-live", "polite");
  empty.style.cssText = [
    "padding: var(--s-space-2);",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-xs);",
  ].join(" ");

  root.append(head, list, empty);
  host.appendChild(root);

  const onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        model.selectNext();
        break;
      case "ArrowUp":
        event.preventDefault();
        model.selectPrev();
        break;
      case "Home":
        event.preventDefault();
        model.selectIndex(0);
        break;
      case "End":
        event.preventDefault();
        model.selectIndex(model.state().visibleNodes.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        model.reveal();
        break;
      case "Escape":
        event.preventDefault();
        input.value = "";
        model.filter("");
        break;
      default:
        break;
    }
  };

  const onInput = (): void => {
    model.filter(input.value);
    options.onFilterChange?.(input.value);
  };

  root.addEventListener("keydown", onKeyDown);
  input.addEventListener("input", onInput);

  const renderOutline = (): void => {
    // Escondido (`host.hidden`) ⇒ **não** redesenha: o DOM fica sujo e é redesenhado
    // quando o host ficar visível (o Outline redesenha a cada edição do documento).
    if (visibility.hidden) {
      visibility.markDirty();
      return;
    }
    visibility.markClean();
    const state = model.state();

    count.textContent = state.nodes.length === 0 ? "" : describeSymbolCount(state.nodes.length);

    list.replaceChildren();
    state.visibleNodes.forEach((node, index) => {
      const item = document.createElement("div");
      const isSelected = index === state.selectedIndex;
      item.className = isSelected ? "outline-item selected" : "outline-item";
      item.setAttribute("role", "treeitem");
      item.setAttribute("aria-level", String(node.depth + 1));
      item.setAttribute("aria-selected", String(isSelected));
      if (node.hasChildren) item.setAttribute("aria-expanded", "true");
      item.setAttribute("data-depth", String(node.depth));
      item.setAttribute("data-kind", String(node.kind));
      item.setAttribute("data-group", node.group);
      item.title = `${node.name} — ${node.kindName}`;
      item.style.cssText = [
        "display: flex;",
        "align-items: center;",
        "gap: var(--s-space-1);",
        "width: 100%;",
        "text-align: left;",
        "background: transparent;",
        "border: none;",
        "color: var(--s-fg-muted);",
        "font-family: var(--s-font-ui);",
        "font-size: var(--s-fs-sm);",
        "padding: 1px var(--s-space-2);",
        "cursor: pointer;",
      ].join(" ");
      // A indentação segue a profundidade da árvore (o CSS pode sobrescrever).
      item.style.paddingLeft = `${INDENT_BASE_PX + node.depth * INDENT_STEP_PX}px`;

      const icon = document.createElement("span");
      icon.className = "outline-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = node.label;
      icon.style.cssText = [
        "flex: 0 0 auto;",
        "width: 18px;",
        "text-align: center;",
        "color: var(--s-subtle);",
        "font-family: var(--s-font-mono);",
        "font-size: var(--s-fs-xs);",
      ].join(" ");

      const name = document.createElement("span");
      name.className = "outline-name";
      name.textContent = node.name;
      name.style.cssText = [
        "flex: 1 1 auto;",
        "min-width: 0;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "white-space: nowrap;",
      ].join(" ");

      item.append(icon, name);

      if (node.detail !== undefined && node.detail.length > 0) {
        const detail = document.createElement("span");
        detail.className = "outline-detail";
        detail.textContent = node.detail;
        detail.style.cssText = ["flex: 0 0 auto;", "color: var(--s-subtle);", "font-size: var(--s-fs-xs);"].join(
          " ",
        );
        item.appendChild(detail);
      }

      item.addEventListener("click", (): void => {
        model.selectIndex(index);
        model.reveal();
      });

      list.appendChild(item);
    });

    const reason = state.emptyReason;
    if (reason === undefined) {
      empty.hidden = true;
      empty.textContent = "";
    } else {
      empty.hidden = false;
      empty.textContent = describeOutlineEmpty(reason);
    }
  };

  render = renderOutline;
  renderOutline();

  return {
    model,
    update: (symbols: readonly OutlineSymbolInput[]): void => {
      model.setSymbols(symbols);
    },
    setFilter: (query: string): void => {
      if (input.value !== query) input.value = query;
      model.filter(query);
    },
    setLspAvailable: (available: boolean): void => {
      model.setLspAvailable(available);
    },
    focus: (): void => {
      input.focus();
    },
    dispose: (): void => {
      visibility.dispose();
      root.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("input", onInput);
      root.remove();
      model.dispose();
    },
  };
}

/** "1 símbolo" / "N símbolos" — o contador da coluna. */
function describeSymbolCount(count: number): string {
  return count === 1 ? "1 símbolo" : `${count} símbolos`;
}
