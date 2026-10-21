/**
 * Scribe — **painel de diff** (o "Diff View" do VS Code): mostra o diff unificado de um
 * arquivo (working tree vs `HEAD`) com linhas `+`/`-` coloridas, hunks navegáveis e clique
 * para pular à linha no editor.
 *
 * O módulo é **autocontido** (mesma convenção do painel de busca): a lógica **pura** vive
 * em {@link DiffViewModel} (sem DOM — é o que o vitest testa, já que o ambiente de teste
 * é `node`, sem jsdom) e o DOM vive em {@link mountDiffView}.
 *
 * **O módulo não fala com o `git`:** quem executa o `git diff` é o `main` (via IPC); aqui
 * só entra o texto do diff, que é parseado por `src/core/git/git-diff.ts` (parser puro).
 *
 * Escolhas nossas (o alvo não expõe diff unificado):
 * - a navegação entre hunks é **cíclica** (o último hunk volta ao primeiro);
 * - clicar numa linha **removida** salta para a linha do arquivo **novo** onde a remoção
 *   aconteceu (a linha removida não existe mais no arquivo novo);
 * - o filtro "só mudanças" esconde o contexto (mantém as linhas `+`/`-`).
 */
import type { DiffFile, DiffHunk, DiffLine } from "../core/git/git-diff";
import { isNullPath, summarizeDiff } from "../core/git/git-diff";
import { watchHostVisibility } from "./host-visibility";

/** Um hunk + as linhas que ele mostra (o que o painel desenha). */
export interface DiffHunkBlock {
  /** O hunk (cabeçalho `@@ …`). */
  readonly hunk: DiffHunk;
  /** As linhas visíveis do hunk (já filtradas por "só mudanças"). */
  readonly lines: readonly DiffLine[];
}

/** O que o painel recebe em {@link DiffViewHandle.update}. */
export type DiffViewUpdate = readonly DiffHunk[] | DiffFile;

/**
 * Modelo **puro** do painel de diff (estado + navegação; sem DOM).
 */
export class DiffViewModel {
  private hunks: readonly DiffHunk[] = [];
  private currentIndex = 0;
  private onlyChanges = false;

  /** Troca o diff exibido (a navegação volta para o primeiro hunk). */
  setDiff(hunks: readonly DiffHunk[]): void {
    this.hunks = hunks;
    this.currentIndex = 0;
  }

  /** Todos os hunks do diff atual. */
  get diff(): readonly DiffHunk[] {
    return this.hunks;
  }

  /** Nº de hunks (0 num diff vazio). */
  get hunkCount(): number {
    return this.hunks.length;
  }

  /** Índice do hunk atual (0-based). */
  get currentHunkIndex(): number {
    return this.currentIndex;
  }

  /** O hunk atual (`undefined` num diff vazio). */
  get currentHunk(): DiffHunk | undefined {
    return this.hunks[this.currentIndex];
  }

  /** `true` quando só as linhas alteradas são mostradas. */
  get showOnlyChanges(): boolean {
    return this.onlyChanges;
  }

  set showOnlyChanges(value: boolean) {
    this.onlyChanges = value;
  }

  /** Vai para o próximo hunk (cíclico). Devolve o hunk ou `undefined` (diff vazio). */
  nextHunk(): DiffHunk | undefined {
    if (this.hunks.length === 0) return undefined;
    this.currentIndex = (this.currentIndex + 1) % this.hunks.length;
    return this.currentHunk;
  }

  /** Vai para o hunk anterior (cíclico). Devolve o hunk ou `undefined` (diff vazio). */
  prevHunk(): DiffHunk | undefined {
    if (this.hunks.length === 0) return undefined;
    this.currentIndex = (this.currentIndex - 1 + this.hunks.length) % this.hunks.length;
    return this.currentHunk;
  }

  /** Seleciona um hunk pelo índice (fora da faixa ⇒ o hunk atual não muda). */
  goToHunk(index: number): DiffHunk | undefined {
    if (index < 0 || index >= this.hunks.length) return this.currentHunk;
    this.currentIndex = index;
    return this.currentHunk;
  }

  /**
   * Os hunks **visíveis** com as linhas que cada um mostra.
   *
   * Com {@link showOnlyChanges} ligado, o contexto (e os metadados internos) some — só
   * as linhas `+`/`-` ficam.
   */
  get visibleHunkBlocks(): readonly DiffHunkBlock[] {
    const blocks: DiffHunkBlock[] = [];
    for (const hunk of this.hunks) {
      const lines = this.onlyChanges
        ? hunk.lines.filter((line) => line.kind === "add" || line.kind === "del")
        : hunk.lines;
      blocks.push({ hunk, lines });
    }
    return blocks;
  }

  /** Todas as linhas visíveis (a lista plana que o painel desenha). */
  get visibleLines(): readonly DiffLine[] {
    const out: DiffLine[] = [];
    for (const block of this.visibleHunkBlocks) {
      for (const line of block.lines) out.push(line);
    }
    return out;
  }

  /**
   * A linha do **arquivo novo** para onde o editor deve saltar ao clicar nesta linha.
   *
   * - `add`/`ctx` ⇒ a própria linha (`newLine`);
   * - `del` ⇒ a linha do arquivo novo onde a remoção aconteceu (a linha removida não
   *   existe mais no arquivo novo) — `undefined` se o arquivo novo não tem linhas;
   * - `meta` ⇒ `undefined` (não há linha para onde saltar).
   */
  lineToJump(line: DiffLine): number | undefined {
    // A linha precisa pertencer ao diff atual (senão a posição não é definida).
    const hunk = this.hunkOf(line);
    if (hunk === undefined) return undefined;
    if (line.kind === "add" || line.kind === "ctx") return line.newLine;
    if (line.kind !== "del") return undefined;
    let target = hunk.newStart;
    for (const candidate of hunk.lines) {
      if (candidate === line) break;
      if (candidate.kind === "add" || candidate.kind === "ctx") target += 1;
    }
    return target >= 1 ? target : undefined;
  }

  /** A primeira linha alterada de um hunk (`undefined` se o hunk não tem mudança). */
  firstChangedLine(hunk: DiffHunk): DiffLine | undefined {
    for (const line of hunk.lines) {
      if (line.kind === "add" || line.kind === "del") return line;
    }
    return undefined;
  }

  /** O hunk que contém a linha (busca por identidade). */
  private hunkOf(line: DiffLine): DiffHunk | undefined {
    for (const hunk of this.hunks) {
      for (const candidate of hunk.lines) {
        if (candidate === line) return hunk;
      }
    }
    return undefined;
  }
}

/** Intenções emitidas pelo painel (o `main.ts` as traduz em IPC). */
export interface DiffViewOptions {
  /**
   * O usuário clicou numa linha ⇒ pular para essa linha no editor.
   * `line` é **1-based** e já é a linha do **arquivo novo**.
   */
  readonly onJump?: (line: number) => void;
  /** O hunk atual mudou (navegação ou clique no cabeçalho do hunk). */
  readonly onHunkChange?: (hunkIndex: number) => void;
  /** O usuário pediu para fechar o painel de diff. */
  readonly onClose?: () => void;
}

/** Superfície do painel (o `main.ts` só reflete o estado por aqui). */
export interface DiffViewHandle {
  /** O modelo puro (estado do painel). */
  readonly model: DiffViewModel;
  /** `true` quando o DOM foi montado (`false` ⇒ o app rodou sem DOM). */
  readonly mounted: boolean;
  /** Troca o diff exibido. */
  update(diff: DiffViewUpdate): void;
  /** Remove o painel do DOM (idempotente). */
  dispose(): void;
}

/** `true` quando há DOM disponível (o renderer; em Node, não). */
function hasDom(): boolean {
  return typeof document !== "undefined" && document !== null;
}

/** O caminho que o painel mostra (o lado novo; `/dev/null` ⇒ o arquivo foi removido). */
export function diffDisplayPath(oldPath: string, newPath: string): string {
  if (!isNullPath(newPath) && newPath.length > 0) return newPath;
  if (!isNullPath(oldPath) && oldPath.length > 0) return oldPath;
  return "";
}

/** `true` quando o update é a lista plana de hunks (e não um arquivo do diff). */
function isHunkList(update: DiffViewUpdate): update is readonly DiffHunk[] {
  return Array.isArray(update);
}

/** Normaliza o que chega em `update()` (lista de hunks ou um arquivo do diff). */
function normalizeUpdate(update: DiffViewUpdate): {
  readonly hunks: readonly DiffHunk[];
  readonly path: string;
} {
  if (isHunkList(update)) {
    const hunks: readonly DiffHunk[] = update;
    const first = hunks[0];
    return {
      hunks,
      path: first === undefined ? "" : diffDisplayPath(first.oldPath, first.newPath),
    };
  }
  const file: DiffFile = update;
  return { hunks: file.hunks, path: diffDisplayPath(file.oldPath, file.newPath) };
}

/** Estilo do prefixo da linha (`+`, `-`, espaço ou marcador de metadado). */
function markerOf(line: DiffLine): string {
  if (line.kind === "add") return "+";
  if (line.kind === "del") return "-";
  if (line.kind === "ctx") return " ";
  return "";
}

/**
 * O texto da linha **como se mostra**.
 *
 * O parser guarda o `\r` do CRLF (o CR é parte da linha do arquivo), mas na tela ele é o
 * **terminador** da linha — mostrar o caractere cru quebraria o desenho (o navegador
 * transforma `\r` em quebra de linha).
 */
function displayText(line: DiffLine): string {
  return line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text;
}

/** Cor de fundo da linha (só tokens do tema — cor literal nunca). */
function backgroundOf(kind: DiffLine["kind"]): string {
  if (kind === "add") return "color-mix(in srgb, var(--s-success) 14%, transparent)";
  if (kind === "del") return "color-mix(in srgb, var(--s-error) 14%, transparent)";
  return "transparent";
}

/** Cor do texto da linha (só tokens do tema). */
function colorOf(kind: DiffLine["kind"]): string {
  if (kind === "add") return "var(--s-success)";
  if (kind === "del") return "var(--s-error)";
  if (kind === "meta") return "var(--s-muted)";
  return "var(--s-fg-muted)";
}

/**
 * Monta o painel de diff dentro do `host` (cria o DOM, devolve o binding).
 *
 * **Sem DOM** (o app rodando em Node, ou o teste) ⇒ devolve um handle **no-op**: nada
 * quebra, `update()`/`dispose()` são inertes.
 */
export function mountDiffView(
  host: HTMLElement | null | undefined,
  options: DiffViewOptions = {},
): DiffViewHandle {
  const model = new DiffViewModel();

  if (!hasDom() || host === null || host === undefined) {
    return {
      model,
      mounted: false,
      update(diff: DiffViewUpdate): void {
        // Sem DOM: o estado do modelo continua válido, mas não há o que desenhar.
        model.setDiff(normalizeUpdate(diff).hunks);
      },
      dispose(): void {
        // nada a limpar
      },
    };
  }

  const root = document.createElement("div");
  root.className = "diff-view";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Diff do arquivo");
  root.style.cssText = [
    "display: flex;",
    "flex-direction: column;",
    "height: 100%;",
    "min-height: 0;",
    "background: var(--s-bg);",
    "color: var(--s-fg);",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-sm);",
  ].join(" ");

  // ── cabeçalho ────────────────────────────────────────────────────────────────────────────
  const head = document.createElement("div");
  head.className = "diff-view-head";
  head.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-2);",
    "padding: var(--s-space-1) var(--s-space-2);",
    "border-bottom: 1px solid var(--s-border);",
    "background: var(--s-sidebar);",
  ].join(" ");

  const title = document.createElement("span");
  title.className = "diff-view-title";
  title.style.cssText = [
    "font-weight: 600;",
    "max-width: 45%;",
    "overflow: hidden;",
    "text-overflow: ellipsis;",
    "white-space: nowrap;",
  ].join(" ");

  const stats = document.createElement("span");
  stats.className = "diff-view-stats";
  stats.style.cssText = ["color: var(--s-muted);", "font-family: var(--s-font-mono);"].join(" ");

  const spacer = document.createElement("span");
  spacer.style.cssText = ["flex: 1 1 auto;"].join(" ");

  const buttonStyle = [
    "background: transparent;",
    "border: 1px solid transparent;",
    "border-radius: var(--s-radius-sm);",
    "color: var(--s-fg-muted);",
    "cursor: pointer;",
    "font-family: var(--s-font-ui);",
    "font-size: var(--s-fs-xs);",
    "padding: 1px var(--s-space-1);",
  ].join(" ");

  const prevButton = document.createElement("button");
  prevButton.className = "diff-view-prev";
  prevButton.type = "button";
  prevButton.setAttribute("aria-label", "Hunk anterior");
  prevButton.textContent = "↑";
  prevButton.style.cssText = buttonStyle;

  const nextButton = document.createElement("button");
  nextButton.className = "diff-view-next";
  nextButton.type = "button";
  nextButton.setAttribute("aria-label", "Próximo hunk");
  nextButton.textContent = "↓";
  nextButton.style.cssText = buttonStyle;

  const onlyChangesLabel = document.createElement("label");
  onlyChangesLabel.className = "diff-view-only-changes";
  onlyChangesLabel.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "gap: var(--s-space-1);",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-xs);",
    "cursor: pointer;",
  ].join(" ");

  const onlyChangesInput = document.createElement("input");
  onlyChangesInput.className = "diff-view-only-changes-input";
  onlyChangesInput.type = "checkbox";
  onlyChangesInput.setAttribute("aria-label", "Mostrar só as linhas alteradas");

  onlyChangesLabel.append(onlyChangesInput, document.createTextNode("Só mudanças"));

  const closeButton = document.createElement("button");
  closeButton.className = "diff-view-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Fechar diff");
  closeButton.textContent = "×";
  closeButton.style.cssText = [
    "background: transparent;",
    "border: none;",
    "color: var(--s-muted);",
    "font-size: var(--s-fs-lg);",
    "line-height: 1;",
    "cursor: pointer;",
  ].join(" ");

  head.append(title, stats, spacer, prevButton, nextButton, onlyChangesLabel, closeButton);

  // ── corpo ────────────────────────────────────────────────────────────────────────────────
  const body = document.createElement("div");
  body.className = "diff-view-body";
  body.style.cssText = ["flex: 1 1 auto;", "min-height: 0;", "overflow: auto;"].join(" ");

  root.append(head, body);
  host.appendChild(root);

  let path = "";

  const notifyHunkChange = (): void => {
    options.onHunkChange?.(model.currentHunkIndex);
  };

  /**
   * Os blocos (hunks) desenhados — o índice é o do hunk.
   *
   * É o que permite **rolar** até o hunk atual **sem** redesenhar o DOM (o `main` pode
   * mandar um diff de 1 MiB: reconstruí-lo a cada troca de hunk é desperdício).
   */
  const hunkBlocks: Array<{ section: HTMLElement; header: HTMLElement }> = [];

  // O painel só redesenha quando está **visível** (e redesenha quando aparece).
  const visibility = watchHostVisibility(host, (): void => {
    render();
  });

  /**
   * Marca o hunk atual (sem rebuild ⇒ o destaque é atualizado na mão).
   */
  const markCurrentHunk = (): void => {
    hunkBlocks.forEach((entry, index) => {
      const isCurrent = index === model.currentHunkIndex;
      if (isCurrent) entry.section.setAttribute("data-current", "true");
      else entry.section.removeAttribute("data-current");
      if (isCurrent) entry.header.setAttribute("aria-current", "true");
      else entry.header.removeAttribute("aria-current");
    });
  };

  /**
   * Rola a visão até o hunk atual (sem rebuild).
   *
   * `scrollIntoView` não existe em todo ambiente (o DOM falso do teste) ⇒ é opcional.
   */
  const scrollToCurrentHunk = (): void => {
    const block = hunkBlocks[model.currentHunkIndex];
    if (block === undefined) return;
    markCurrentHunk();
    if (typeof block.section.scrollIntoView === "function") {
      block.section.scrollIntoView({ block: "nearest" });
    }
  };

  const render = (): void => {
    // Escondido (`host.hidden`) ⇒ **não** redesenha: o DOM fica sujo e é redesenhado
    // quando o host ficar visível (o `main` preenche o diff **antes** de abrir a seção).
    if (visibility.hidden) {
      visibility.markDirty();
      return;
    }
    visibility.markClean();
    title.textContent = path.length > 0 ? path : "Diff";
    title.title = path;
    const summary = summarizeDiff(model.diff);
    stats.textContent = `+${summary.added} −${summary.removed}`;
    body.replaceChildren();
    hunkBlocks.length = 0;

    if (model.hunkCount === 0) {
      const empty = document.createElement("div");
      empty.className = "diff-view-empty";
      empty.textContent = "Sem alterações";
      empty.style.cssText = [
        "padding: var(--s-space-3);",
        "color: var(--s-muted);",
        "font-size: var(--s-fs-xs);",
      ].join(" ");
      body.appendChild(empty);
      return;
    }

    const blocks = model.visibleHunkBlocks;
    blocks.forEach((block, index) => {
      const section = document.createElement("section");
      section.className = "diff-view-hunk";
      section.setAttribute("data-hunk", String(index));
      section.style.cssText = ["margin: 0 0 var(--s-space-2) 0;"].join(" ");

      const hunkHeader = document.createElement("button");
      hunkHeader.className = "diff-view-hunk-header";
      hunkHeader.type = "button";
      hunkHeader.textContent =
        block.hunk.section.length > 0
          ? `${block.hunk.header} ${block.hunk.section}`
          : block.hunk.header;
      hunkHeader.title = "Ir para este hunk";
      hunkHeader.style.cssText = [
        "display: block;",
        "width: 100%;",
        "text-align: left;",
        "background: var(--s-surface-raised);",
        "border: none;",
        "border-left: 2px solid var(--s-accent);",
        "color: var(--s-muted);",
        "cursor: pointer;",
        "font-family: var(--s-font-mono);",
        "font-size: var(--s-fs-xs);",
        "padding: 1px var(--s-space-2);",
        "white-space: pre;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
      ].join(" ");
      hunkHeader.addEventListener("click", (): void => {
        model.goToHunk(index);
        notifyHunkChange();
        scrollToCurrentHunk();
      });
      section.appendChild(hunkHeader);

      for (const line of block.lines) {
        const row = document.createElement("div");
        row.className = `diff-view-line diff-view-line-${line.kind}`;
        row.setAttribute("data-kind", line.kind);
        if (line.newLine !== undefined) row.setAttribute("data-new", String(line.newLine));
        if (line.oldLine !== undefined) row.setAttribute("data-old", String(line.oldLine));
        row.style.cssText = [
          "display: flex;",
          "align-items: baseline;",
          "gap: var(--s-space-1);",
          "background: " + backgroundOf(line.kind) + ";",
          "color: " + colorOf(line.kind) + ";",
          "font-family: var(--s-font-mono);",
          "font-size: var(--s-fs-xs);",
          "white-space: pre;",
        ].join(" ");

        const oldNo = document.createElement("span");
        oldNo.className = "diff-view-lineno diff-view-lineno-old";
        oldNo.textContent = line.oldLine === undefined ? "" : String(line.oldLine);
        oldNo.style.cssText = [
          "flex: 0 0 auto;",
          "min-width: 3em;",
          "text-align: right;",
          "padding-right: var(--s-space-1);",
          "color: var(--s-subtle);",
          "user-select: none;",
        ].join(" ");

        const newNo = document.createElement("span");
        newNo.className = "diff-view-lineno diff-view-lineno-new";
        newNo.textContent = line.newLine === undefined ? "" : String(line.newLine);
        newNo.style.cssText = [
          "flex: 0 0 auto;",
          "min-width: 3em;",
          "text-align: right;",
          "padding-right: var(--s-space-1);",
          "color: var(--s-subtle);",
          "user-select: none;",
        ].join(" ");

        const text = document.createElement("span");
        text.className = "diff-view-line-text";
        text.textContent = markerOf(line) + displayText(line);
        text.style.cssText = ["flex: 1 1 auto;", "min-width: 0;"].join(" ");

        row.append(oldNo, newNo, text);

        if (line.kind === "add" || line.kind === "del" || line.kind === "ctx") {
          row.style.cursor = "pointer";
          row.title = path.length > 0 ? `${path}:${line.newLine ?? line.oldLine ?? 0}` : "";
          row.addEventListener("click", (): void => {
            const target = model.lineToJump(line);
            if (target === undefined) return;
            options.onJump?.(target);
          });
        }

        section.appendChild(row);
      }

      body.appendChild(section);
      hunkBlocks.push({ section, header: hunkHeader });
    });

    // O hunk atual (o `update` volta para o primeiro) fica marcado.
    markCurrentHunk();
  };

  prevButton.addEventListener("click", (): void => {
    model.prevHunk();
    notifyHunkChange();
    // ⚠️ **Não** redesenha: o diff pode ter 1 MiB — só rola até o hunk.
    scrollToCurrentHunk();
  });

  nextButton.addEventListener("click", (): void => {
    model.nextHunk();
    notifyHunkChange();
    // ⚠️ **Não** redesenha: o diff pode ter 1 MiB — só rola até o hunk.
    scrollToCurrentHunk();
  });

  onlyChangesInput.addEventListener("change", (): void => {
    model.showOnlyChanges = onlyChangesInput.checked;
    render();
  });

  closeButton.addEventListener("click", (): void => {
    options.onClose?.();
  });

  render();

  let disposed = false;

  return {
    model,
    mounted: true,
    update(diff: DiffViewUpdate): void {
      if (disposed) return;
      const normalized = normalizeUpdate(diff);
      path = normalized.path;
      model.setDiff(normalized.hunks);
      onlyChangesInput.checked = model.showOnlyChanges;
      render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      visibility.dispose();
      root.remove();
    },
  };
}
