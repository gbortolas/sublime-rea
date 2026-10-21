/**
 * Scribe — **árvore de arquivos da workspace** (núcleo puro, sem DOM).
 *
 * O `indexFiles` (`./file-index.ts`) devolve uma lista **flat** de caminhos relativos
 * (`src/main/index.ts`, `README.md`, …). O *Explorer* precisa mostrar essa lista como uma
 * **hierarquia** de diretórios expansíveis. Este módulo faz a transformação em funções
 * **puras** — a UI (o renderer) só reflete o resultado.
 *
 * ## Convenção de caminho (importante)
 *
 * A árvore é montada a partir do **caminho relativo** que o `indexFiles` devolve, que já
 * inclui o **prefixo do basename da raiz** quando há mais de uma raiz:
 *
 * | raízes                | path do índice      | 1º nível da árvore |
 * |-----------------------|---------------------|---------------------|
 * | 1 raiz (`/w`)         | `src/main/index.ts` | `src`               |
 * | 2+ raízes (`/a`,`/b`) | `a/src/main.ts`     | `a`                 |
 *
 * ⇒ **o 1º nível da árvore é a raiz da workspace** (multi-raiz) ou o diretório de topo
 * (uma raiz só). O `path` de um nó é o caminho relativo **completo** (o prefixo incluído),
 * normalizado com `"/"` — é a **identidade** do nó (expansão, seleção e filtro usam ele).
 *
 * ⚠️ O `path` de um **diretório** não é um arquivo: ele não pode ser aberto. Só os nós
 * `kind: "file"` são.
 *
 * ## Regras
 *
 * - **Ordenação**: diretórios **antes** dos arquivos; dentro de cada nível, **alfabética
 *   case-insensitive** (desempate pelo nome exato, para a ordem ser determinística).
 * - **Filtro incremental** (`filterTree`): casa pelo **nome** do nó (case-insensitive,
 *   substring). Um diretório sobrevive quando **um filho casa** (o pai é mantido); quando o
 *   **próprio** diretório casa, ele é mantido **com todo o conteúdo** (é o comportamento do
 *   VS Code: filtrar por um diretório mostra o diretório inteiro).
 * - **Expansão** (`flattenTree`): só os filhos de um diretório **expandido** aparecem.
 */

/** O nó é um diretório (`dir`) ou um arquivo (`file`). */
export type FileTreeNodeKind = "dir" | "file";

/** Um nó da árvore (diretório ou arquivo). */
export interface FileTreeNode {
  /** Último segmento do caminho (é o que a UI mostra). */
  readonly name: string;
  /**
   * Caminho relativo **completo** do nó (separador `"/"`, prefixo da raiz incluído) —
   * é a **identidade** do nó (expansão, seleção, filtro).
   */
  readonly path: string;
  /** O nó é um diretório ou um arquivo. */
  readonly kind: FileTreeNodeKind;
  /** Filhos (só em diretórios). */
  readonly children?: readonly FileTreeNode[];
}

/** Uma entrada da lista **visível** (o que o renderer desenha, já achatado). */
export interface FlatTreeEntry {
  /** O nó. */
  readonly node: FileTreeNode;
  /** Profundidade (0 = 1º nível da árvore). */
  readonly depth: number;
  /** `true` quando o nó é um diretório **expandido** (irrelevante para arquivos). */
  readonly expanded: boolean;
}

/** Opções do {@link buildFileTree}. */
export interface FileTreeOptions {
  /**
   * Separador usado para **normalizar** os caminhos (default `"/"`).
   *
   * O `indexFiles` já devolve `"/"`; a opção existe para índices de outra origem. A
   * **divisão** aceita `"/"` e `"\\"` (o path de um índice Windows é normalizado).
   */
  readonly separator?: string;
}

// ---------------------------------------------------------------------------------------------
// Construção
// ---------------------------------------------------------------------------------------------

/** Nó em construção (mutável — só existe durante a montagem). */
interface MutableNode {
  name: string;
  path: string;
  kind: FileTreeNodeKind;
  children: Map<string, MutableNode>;
}

/** Divide um caminho em segmentos (ignora separadores vazios e `\0`). */
function splitSegments(path: string): readonly string[] {
  return path
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== "\0");
}

/** Compara dois nomes (case-insensitive, com desempate determinístico). */
function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/** Diretórios antes de arquivos; dentro de cada grupo, ordem alfabética. */
function compareNodes(a: MutableNode, b: MutableNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const byName = compareNames(a.name, b.name);
  if (byName !== 0) return byName;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Converte a estrutura mutável na árvore final (imutável e ordenada). */
function toNode(node: MutableNode): FileTreeNode {
  if (node.kind === "file") {
    return { name: node.name, path: node.path, kind: "file" };
  }
  const children = [...node.children.values()].sort(compareNodes).map(toNode);
  return { name: node.name, path: node.path, kind: "dir", children };
}

/**
 * Monta a **árvore** a partir da lista de caminhos relativos.
 *
 * - Caminhos vazios (ou só separadores) são **ignorados**;
 * - o separador é normalizado para `"/"` (o `path` do nó é o caminho relativo normalizado);
 * - a **ordem** é sempre: diretórios primeiro, depois alfabética case-insensitive;
 * - **conflito** de nome (o mesmo nome é arquivo e diretório) ⇒ o **diretório vence**
 *   (é o que preserva a hierarquia).
 */
export function buildFileTree(
  paths: readonly string[],
  options: FileTreeOptions = {},
): readonly FileTreeNode[] {
  const separator = options.separator ?? "/";
  const root: MutableNode = { name: "", path: "", kind: "dir", children: new Map() };

  for (const raw of paths) {
    const segments = splitSegments(raw);
    if (segments.length === 0) continue;

    let current = root;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!;
      const isLast = i === segments.length - 1;
      const childPath = current.path.length === 0 ? segment : `${current.path}${separator}${segment}`;

      let child = current.children.get(segment);
      if (child === undefined) {
        child = {
          name: segment,
          path: childPath,
          kind: isLast ? "file" : "dir",
          children: new Map(),
        };
        current.children.set(segment, child);
      } else if (!isLast && child.kind === "file") {
        // O mesmo nome é arquivo **e** diretório ⇒ o diretório vence (preserva a hierarquia).
        child.kind = "dir";
      }
      if (isLast) continue;
      current = child;
    }
  }

  return [...root.children.values()].sort(compareNodes).map(toNode);
}

// ---------------------------------------------------------------------------------------------
// Visibilidade (expansão)
// ---------------------------------------------------------------------------------------------

/**
 * Achata a árvore na **lista visível** (o que o renderer desenha).
 *
 * Um diretório aparece sempre; os **filhos** de um diretório só aparecem quando ele está
 * **expandido** (o `path` do diretório está no `expanded`). A profundidade é 0-based.
 */
export function flattenTree(
  tree: readonly FileTreeNode[],
  expanded: ReadonlySet<string>,
): readonly FlatTreeEntry[] {
  const entries: FlatTreeEntry[] = [];
  const walk = (nodes: readonly FileTreeNode[], depth: number): void => {
    for (const node of nodes) {
      const isDir = node.kind === "dir";
      const isExpanded = isDir && expanded.has(node.path);
      entries.push({ node, depth, expanded: isExpanded });
      if (isExpanded) walk(node.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);
  return entries;
}

/** Todos os caminhos de **diretório** da árvore (o "expandir tudo"). */
export function collectDirectoryPaths(tree: readonly FileTreeNode[]): ReadonlySet<string> {
  const paths = new Set<string>();
  const walk = (nodes: readonly FileTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== "dir") continue;
      paths.add(node.path);
      walk(node.children ?? []);
    }
  };
  walk(tree);
  return paths;
}

/** `true` quando o caminho está no conjunto de expandidos. */
export function isExpanded(expanded: ReadonlySet<string>, path: string): boolean {
  return expanded.has(path);
}

/**
 * Alterna a expansão de um diretório (**puro**): devolve um **novo** conjunto.
 *
 * O conjunto recebido **não** é mutado.
 */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** Define a expansão de um diretório (**puro**): devolve um **novo** conjunto. */
export function setExpanded(
  expanded: ReadonlySet<string>,
  path: string,
  value: boolean,
): Set<string> {
  const next = new Set(expanded);
  if (value) next.add(path);
  else next.delete(path);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Filtro incremental
// ---------------------------------------------------------------------------------------------

/** `true` quando o nome casa com a query (case-insensitive, substring). */
function nameMatches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query);
}

/**
 * Filtra a árvore (incremental, como no VS Code).
 *
 * - **query vazia** ⇒ devolve a árvore **como está** (mesma referência);
 * - casa pelo **nome** do nó (case-insensitive);
 * - um **diretório** sobrevive quando o **próprio nome** casa (mantido **com todo o
 *   conteúdo**) ou quando **um descendente** casa (mantido só com o que casou).
 */
export function filterTree(
  tree: readonly FileTreeNode[],
  query: string,
): readonly FileTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return tree;

  const filterNode = (node: FileTreeNode): FileTreeNode | undefined => {
    if (node.kind === "file") {
      return nameMatches(node.name, needle) ? node : undefined;
    }
    if (nameMatches(node.name, needle)) return node; // casou ⇒ mostra o diretório inteiro
    const children: FileTreeNode[] = [];
    for (const child of node.children ?? []) {
      const kept = filterNode(child);
      if (kept !== undefined) children.push(kept);
    }
    if (children.length === 0) return undefined;
    return { name: node.name, path: node.path, kind: "dir", children };
  };

  const result: FileTreeNode[] = [];
  for (const node of tree) {
    const kept = filterNode(node);
    if (kept !== undefined) result.push(kept);
  }
  return result;
}

/** Procura um nó pelo `path` (identidade do nó). */
export function findNode(
  tree: readonly FileTreeNode[],
  path: string,
): FileTreeNode | undefined {
  const walk = (nodes: readonly FileTreeNode[]): FileTreeNode | undefined => {
    for (const node of nodes) {
      if (node.path === path) return node;
      const found = walk(node.children ?? []);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(tree);
}
