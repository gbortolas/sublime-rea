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
 *
 * ⚠️ **Pontuação pelo caminho completo**: o candidato do matching é o **caminho** do item
 * (relativo à raiz, com o prefixo do nome da raiz no modo multi-root) — não o *basename*.
 * O *basename* (o `label`, o que a lista mostra em destaque) é só um **desempate leve**.
 * Assim, dois `main.ts` em pastas diferentes deixam de empatar quando a query fala da
 * pasta, e a casa funciona em **qualquer segmento** do caminho.
 *
 * ⚠️ **"Criar arquivo"**: quando a query **não casa nenhum arquivo** mas **parece um
 * caminho** (tem `/` ou `.`), a lista ganha um item extra (`kind: "create"`) **no fim** —
 * o comportamento do VS Code. O `main` é quem efetivamente cria o arquivo.
 *
 * ⚠️ **A base do "criar"**: a query que é um **nome simples** (sem `/`) nasce na **base**
 * (`baseDir` — a pasta do documento ativo; é o que o VS Code faz), e não na raiz da
 * workspace. Com `/` na query, a base é a **raiz** (a query já diz o caminho).
 */
import { fuzzyScore, type FuzzyMatch } from "../core/workspace/file-index";

/** Um item do Quick Open (arquivo, comando, recente ou "criar arquivo"). */
export interface QuickOpenItem {
  /** Identificador estável do item (caminho, id do comando…). */
  readonly id: string;
  /** Rótulo mostrado em destaque (o nome do arquivo, o rótulo do comando). */
  readonly label: string;
  /** Contexto secundário (o caminho relativo, a categoria do comando). */
  readonly description?: string;
  /** A natureza do item — muda o selo na lista. */
  readonly kind: "file" | "command" | "recent" | "create";
  /** O dado cru (caminho absoluto, id do comando…) — o `main.ts` é quem o interpreta. */
  readonly payload?: unknown;
  /**
   * O **caminho** do item.
   *
   * - arquivo/reciente: o caminho **relativo** à raiz (o mesmo texto da `description`) —
   *   é o **candidato principal** do matching;
   * - "criar": o caminho **absoluto** candidato (o que o `main` vai criar).
   */
  readonly path?: string;
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
  /**
   * As **raízes** da workspace — habilitam o item "criar arquivo".
   *
   * Sem raízes, o item "criar" nunca aparece (não há onde criar o arquivo).
   */
  readonly roots?: readonly string[];
  /**
   * A pasta em que um arquivo **novo** nasce (a pasta do **documento ativo**).
   *
   * É o que o VS Code faz: digitando "novo.ts" com "src/renderer/x.ts" aberto, o arquivo
   * nasce **ao lado** dele. Sem esta base, o "criar" cai na **raiz** da workspace.
   *
   * ⚠️ Só vale para a query que é um **nome simples** (sem `/`) — com `/`, a query já
   * diz o caminho e a base é a **raiz**.
   */
  readonly baseDir?: string;
}

/** Item classificado pelo *fuzzy* (com a origem da casa). */
export interface QuickOpenMatch {
  readonly item: QuickOpenItem;
  readonly match: FuzzyMatch;
  /** De onde veio a casa: o rótulo, a descrição ou o caminho. */
  readonly source: "label" | "description" | "path";
}

/**
 * Bônus **leve** quando o *basename* (o `label`) também casa com a query.
 *
 * É o **desempate**: o caminho é o protagonista, mas entre dois arquivos que casaram
 * igual, o que tem o *basename* exato fica na frente.
 */
const SCORE_BASENAME_TIEBREAK = 8;

/** Nº máximo de linhas desenhadas na lista (o resto fica no índice, não no DOM). */
const MAX_VISIBLE_ROWS = 100;

/** Nº máximo de linhas pré-visualizadas. */
const MAX_PREVIEW_LINES = 200;

/** Separadores de caminho (o renderer não tem `node:path`). */
const PATH_SEPARATORS = /[\\/]+/;

/** Separador de caminho do host (o renderer não tem `node:path`). */
function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Último segmento de um caminho (o "nome" do arquivo/da raiz). */
function baseNameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return cut < 0 ? normalized : normalized.slice(cut + 1);
}

/** Junta a raiz e o caminho relativo (preservando o separador do host). */
function joinUnder(root: string, relative: string): string {
  const base = root.replace(/[\\/]+$/, "");
  if (relative.length === 0) return base;
  return `${base}${separatorOf(base)}${relative}`;
}

/** `true` quando o caminho é **absoluto** (Unix ou Windows). */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * O caminho de `absolute` **relativo** a `root` — ou `undefined` (não está dentro).
 *
 * A comparação é feita com os separadores normalizados (`/`), mas o retorno preserva o
 * separador do caminho absoluto.
 */
function relativeToRoot(root: string, absolute: string): string | undefined {
  const base = root.replace(/[\\/]+$/, "");
  const normalizedBase = base.replace(/\\/g, "/");
  const normalizedAbsolute = absolute.replace(/\\/g, "/");
  if (normalizedAbsolute === normalizedBase) return "";
  const prefix = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  if (!normalizedAbsolute.startsWith(prefix)) return undefined;
  return absolute.slice(base.length + 1);
}

/**
 * Casa a query em **um** item e devolve o score (+ de onde veio a casa).
 *
 * - **arquivo/reciente**: o **caminho** é o candidato principal (`path` ou `description`);
 *   o `label` (o *basename*) é só um desempate leve. Sem casa no caminho, o `label` é
 *   o plano B (item sem caminho — o *item* do popup é agnóstico quanto ao formato);
 * - **comando**: o `label` é o candidato principal e a `description` (a categoria) é o
 *   plano B;
 * - **"criar"**: não é buscável (o item é offercido pelo `createFileCandidate`).
 */
function matchItem(query: string, item: QuickOpenItem): Omit<QuickOpenMatch, "item"> | undefined {
  if (item.kind === "create") return undefined;

  if (item.kind === "command") {
    const labelMatch = fuzzyScore(query, item.label);
    if (labelMatch !== undefined) return { match: labelMatch, source: "label" };
    if (item.description !== undefined) {
      const descriptionMatch = fuzzyScore(query, item.description);
      if (descriptionMatch !== undefined) return { match: descriptionMatch, source: "description" };
    }
    return undefined;
  }

  // Arquivo/recente: o **caminho completo** é o protagonista.
  const path = item.path ?? item.description;
  if (path !== undefined && path.length > 0) {
    const pathMatch = fuzzyScore(query, path);
    if (pathMatch !== undefined) {
      // O basename (o `label`) é um desempate leve: só entra se ele também casar.
      const basenameMatch = fuzzyScore(query, item.label);
      const bonus = basenameMatch === undefined ? 0 : SCORE_BASENAME_TIEBREAK;
      const source = item.description === path ? "description" : "path";
      return { match: { score: pathMatch.score + bonus, indices: pathMatch.indices }, source };
    }
  }

  const labelMatch = fuzzyScore(query, item.label);
  if (labelMatch !== undefined) return { match: labelMatch, source: "label" };
  return undefined;
}

/**
 * Classifica os itens pela query (fuzzy) e **ordena** por score decrescente.
 *
 * A casa é procurada no **caminho** do item (o candidato principal — relativo à raiz, com
 * o prefixo da raiz no modo multi-root) e, para os comandos, no **rótulo**.
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
    const matched = matchItem(trimmed, item);
    if (matched !== undefined) hits.push({ hit: { item, ...matched }, order });
  });

  return hits
    .sort((a, b) => b.hit.match.score - a.hit.match.score || a.order - b.order)
    .map((wrapped) => wrapped.hit);
}

/**
 * As opções do item "criar arquivo" (as raízes + a **base** em que o arquivo nasce).
 */
export interface CreateFileOptions {
  /**
   * As **raízes** da workspace — o `main` valida o confinamento do arquivo a uma delas.
   */
  readonly roots: readonly string[];
  /**
   * A pasta-base em que o arquivo **novo** nasce (a pasta do **documento ativo**).
   *
   * Vale para a query que é um **nome simples** (sem `/`): "novo.ts" nasce **aqui** (é o
   * que o VS Code faz). Com `/` na query, a base é a **raiz** (a query já diz o caminho).
   */
  readonly baseDir?: string;
}

/**
 * O item "criar arquivo" para a query — ou `null` quando a query não vira arquivo.
 *
 * Regras:
 * - a query não pode ser vazia e precisa **parecer um caminho** (tem `/` ou `.`);
 * - o caminho é resolvido contra as **raízes**: a 1ª, ou a cujo *basename* é o 1º
 *   segmento da query (o caso multi-root: "proj/src/a.ts" ⇒ raiz "proj");
 * - a query que é um **nome simples** (sem `/`) nasce na **base** (a pasta do documento
 *   ativo) — quando ela está dentro de uma das raízes; senão, na 1ª raiz;
 * - o `path` do item é o **absoluto** candidato — quem **valida** o confinamento à raiz
 *   da workspace é o `main` (o renderer não cria arquivo);
 * - a query que é um **caminho absoluto** só vira item quando está **dentro** de uma
 *   raiz (ou da base) — fora delas o item seria um **espelho** no lugar errado (o
 *   `main` recusa a escrita fora ⇒ o arquivo nasceria na raiz, e não onde o usuário
 *   pediu) ⇒ nesses casos a função devolve `null` (não há item "criar").
 *
 * A função é **pura**: não toca o DOM nem o disco.
 */
export function createFileCandidate(
  query: string,
  options: CreateFileOptions,
): QuickOpenItem | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  // "parece um caminho": tem `/` ou `.` (um nome solto — "main" — não vira arquivo).
  if (!trimmed.includes("/") && !trimmed.includes(".")) return null;
  const roots = options.roots;
  if (roots.length === 0) return null;

  const segments = trimmed.split(PATH_SEPARATORS).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  let root = roots[0]!;
  let relative: string;
  /**
   * O caminho **mostrado** na lista (o relativo à raiz).
   *
   * Só o **caminho absoluto fora de toda raiz** (mas dentro da base) muda: não há
   * caminho relativo a uma raiz ⇒ a lista mostra o **absoluto** (o que o usuário
   * digitou).
   */
  let shownPath: string | undefined;

  if (isAbsolutePath(trimmed)) {
    // ⚠️ **Caminho absoluto**: a raiz é a que **contém** o caminho.
    //
    // Um caminho **fora** de todas as raízes (e fora da base) é **recusado** (`null`):
    // o `main` não deixa escrever fora da workspace ⇒ o item "criar" mostraria um
    // **espelho** no lugar errado (ex.: `<repo>/tmp/alguem/fora.txt` em vez de
    // `/tmp/alguem/fora.txt`) — o usuário veria o arquivo no lugar errado.
    const owner = roots.find((candidate) => relativeToRoot(candidate, trimmed) !== undefined);
    if (owner !== undefined) {
      root = owner;
      relative = relativeToRoot(owner, trimmed) ?? trimmed;
    } else {
      // Dentro da **base** (a pasta do documento ativo), mas fora das raízes: o
      // caminho absoluto é o candidato (sem espelho).
      const base = options.baseDir;
      if (base === undefined || base.length === 0 || relativeToRoot(base, trimmed) === undefined) {
        return null;
      }
      root = base;
      relative = relativeToRoot(base, trimmed) ?? trimmed;
      shownPath = trimmed;
    }
  } else {
    // Relativo: se o 1º segmento é o *basename* de uma raiz, é o prefixo multi-root.
    const head = segments[0]!;
    const named = roots.find((candidate) => baseNameOf(candidate) === head);
    if (named !== undefined && segments.length > 1) {
      root = named;
      relative = segments.slice(1).join("/");
    } else {
      relative = segments.join("/");
    }
  }

  // A **base** (a pasta do documento ativo): ela vale só para a query que é um nome
  // simples (sem `/`) — com `/`, a query já diz o caminho e a base é a raiz.
  const baseDir = options.baseDir;
  if (baseDir !== undefined && baseDir.length > 0 && !trimmed.includes("/")) {
    const owner = roots.find((candidate) => relativeToRoot(candidate, baseDir) !== undefined);
    if (owner !== undefined) {
      const baseRelative = relativeToRoot(owner, baseDir) ?? "";
      root = owner;
      relative = baseRelative.length === 0 ? relative : `${baseRelative}/${relative}`;
    }
  }

  const absolute = joinUnder(root, relative);
  const shown = shownPath ?? relative;
  return {
    id: `create:${absolute}`,
    label: baseNameOf(shown.length > 0 ? shown : trimmed),
    description: shown.length > 0 ? shown : trimmed,
    kind: "create",
    path: absolute,
    payload: { kind: "create", path: absolute, relativePath: shown },
  };
}

/**
 * O ranking dos itens **mais** o item "criar arquivo" (quando a query merece).
 *
 * O item "criar" entra **no fim** da lista (menor prioridade) e só aparece quando:
 * - a query **não casa nenhum arquivo** (nem recente) — a lista de arquivos manda; e
 * - a query **parece um caminho** (tem `/` ou `.`).
 */
export function rankQuickOpenResults(
  query: string,
  items: readonly QuickOpenItem[],
  options: CreateFileOptions = { roots: [] },
): readonly QuickOpenMatch[] {
  const ranked = rankQuickOpenItems(query, items);
  const matchedFile = ranked.some(
    (entry) => entry.item.kind === "file" || entry.item.kind === "recent",
  );
  if (matchedFile) return ranked;
  const create = createFileCandidate(query, options);
  if (create === null) return ranked;
  const text = create.description ?? create.label;
  const match = fuzzyScore(query.trim(), text) ?? { score: 0, indices: [] };
  return [...ranked, { item: create, match, source: "description" }];
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
    case "create":
      return "NOV";
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

/**
 * Os índices a destacar num texto (o rótulo ou a descrição) do item classificado.
 *
 * ⚠️ Os índices da casa valem para **um** texto só: o texto que a casa usou (o `label` do
 * comando, a `description`/caminho do arquivo). Quando o texto a destacar é **outro**
 * (o `label` do arquivo, quando a casa veio do caminho), os índices são **recalculados**
 * sobre ele — senão o destaque cairia em letras erradas (o "n.t" do basename).
 *
 * A função é exportada para poder ser testada (o DOM não existe no ambiente de teste).
 */
export function highlightIndices(
  entry: QuickOpenMatch,
  text: string,
  query: string,
): readonly number[] {
  const isLabel = text === entry.item.label;
  const isDescription = entry.item.description !== undefined && text === entry.item.description;
  const isPath = entry.item.path !== undefined && text === entry.item.path;

  // Os índices da casa valem para **o texto que a casa usou**.
  if (entry.source === "label" && isLabel) return entry.match.indices;
  if (entry.source === "description" && isDescription) return entry.match.indices;
  if (entry.source === "path" && isPath) return entry.match.indices;

  // Qualquer outro texto (o rótulo do arquivo, quando a casa veio do caminho): o
  // destaque é **recalculado** sobre ele — senão o destaque cairia em letras erradas.
  const own = fuzzyScore(query.trim(), text);
  return own === undefined ? [] : own.indices;
}

/** Repinta a lista (a partir do estado `ranked`/`selected`). */
function renderList(): void {
  const current = active;
  if (current === null) return;
  const { list, ranked, selected } = current;
  const query = current.input.value;
  list.innerHTML = "";

  const visible = ranked.slice(0, MAX_VISIBLE_ROWS);
  visible.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "quick-open-item";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selected));
    row.setAttribute("data-index", String(index));
    row.setAttribute("data-kind", entry.item.kind);
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
      highlightIndices(entry, entry.item.label, query),
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
        highlightIndices(entry, entry.item.description, query),
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
  // O item "criar arquivo" é offerido aqui (a cada tecla) — ele depende da query.
  current.ranked = rankQuickOpenResults(current.input.value, current.options.items, {
    roots: current.options.roots ?? [],
    ...(current.options.baseDir !== undefined ? { baseDir: current.options.baseDir } : {}),
  });
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
        // No item "criar", completa com o **caminho** (o rótulo é só o basename — perder
        // a pasta mudaria o arquivo a ser criado).
        current.input.value =
          entry.item.kind === "create"
            ? (entry.item.description ?? entry.item.label)
            : entry.item.label;
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
