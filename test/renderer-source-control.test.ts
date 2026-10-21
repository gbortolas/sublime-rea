/**
 * Scribe — testes do **painel de Controle de Código** (`src/renderer/source-control.ts`).
 *
 * O ambiente de teste do repo é `node` (**sem jsdom**) ⇒ o DOM do painel é testado com um
 * **DOM falso** (o compartilhado em `test/helpers/fake-dom.ts`) e a lógica (modelo,
 * agrupamento, contagens, filtro, intenções) é testada **puramente**.
 *
 * O que importa aqui: o painel **não executa nada** — `stage`/`unstage`/`commit` só **emitem
 * callbacks** (quem executa o `git` é o `main`, via IPC, **sem shell**).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { GitStatusEntry } from "../src/core/git/git-status";
import {
  SourceControlModel,
  countSourceControlEntries,
  describeSourceControlBranch,
  describeSourceControlCounts,
  describeSourceControlEmpty,
  filterSourceControlEntries,
  formatSourceControlBadge,
  gitStatusColorToken,
  groupSourceControlEntries,
  mountSourceControlPanel,
} from "../src/renderer/source-control";
import {
  byClass,
  FakeElement,
  firstByClass,
  installFakeDom,
  uninstallFakeDom,
} from "./helpers/fake-dom";

// ── atalhos ──────────────────────────────────────────────────────────────────────────────────

interface EntrySpec {
  readonly path: string;
  readonly xy: string;
  readonly oldPath?: string;
  readonly staged?: boolean;
  readonly unstaged?: boolean;
  readonly untracked?: boolean;
  readonly ignored?: boolean;
  readonly conflicted?: boolean;
}

/** Entrada de status (com os defaults do porcelain). */
function makeEntry(spec: EntrySpec): GitStatusEntry {
  const base = {
    xy: spec.xy,
    path: spec.path,
    staged: spec.staged ?? false,
    unstaged: spec.unstaged ?? false,
    untracked: spec.untracked ?? false,
    ignored: spec.ignored ?? false,
    conflicted: spec.conflicted ?? false,
  };
  return spec.oldPath === undefined ? base : { ...base, oldPath: spec.oldPath };
}

/** Entradas usadas nos testes do modelo. */
const ENTRIES: readonly GitStatusEntry[] = [
  makeEntry({ path: "conflito.txt", xy: "UU", conflicted: true }),
  makeEntry({ path: "preparado.txt", xy: "M ", staged: true }),
  makeEntry({ path: "ambos.txt", xy: "MM", staged: true, unstaged: true }),
  makeEntry({ path: "alterado.txt", xy: " M", unstaged: true }),
  makeEntry({ path: "novo.txt", xy: "??", untracked: true }),
  makeEntry({ path: "ignorado.txt", xy: "!!", ignored: true }),
];

// ── modelo (puro) ───────────────────────────────────────────────────────────────────────────

describe("SourceControlModel — agrupamento", () => {
  it("manda cada entrada para o grupo certo (o `MM` aparece nos **dois**)", () => {
    const groups = groupSourceControlEntries(ENTRIES);
    expect(groups.map((group) => group.id)).toEqual(["conflicts", "staged", "changes", "untracked"]);
    const byId = new Map(groups.map((group) => [group.id, group]));
    expect(byId.get("conflicts")?.entries.map((e) => e.path)).toEqual(["conflito.txt"]);
    expect(byId.get("staged")?.entries.map((e) => e.path)).toEqual(["preparado.txt", "ambos.txt"]);
    expect(byId.get("changes")?.entries.map((e) => e.path)).toEqual(["ambos.txt", "alterado.txt"]);
    expect(byId.get("untracked")?.entries.map((e) => e.path)).toEqual(["novo.txt"]);
  });

  it("o ignorado não entra em grupo nenhum", () => {
    const groups = groupSourceControlEntries(ENTRIES);
    const todos = groups.flatMap((group) => group.entries.map((e) => e.path));
    expect(todos).not.toContain("ignorado.txt");
  });

  it("sempre devolve os 4 grupos (mesmo vazios)", () => {
    const groups = groupSourceControlEntries([]);
    expect(groups).toHaveLength(4);
    expect(groups.every((group) => group.entries.length === 0)).toBe(true);
  });

  it("os grupos têm rótulo pronto para a UI", () => {
    const groups = groupSourceControlEntries([]);
    expect(groups.map((group) => group.label)).toEqual([
      "Conflitos",
      "Alterações Preparadas",
      "Alterações",
      "Não Rastreados",
    ]);
  });
});

describe("SourceControlModel — contagens", () => {
  it("conta por categoria (o ignorado não conta no total)", () => {
    const counts = countSourceControlEntries(ENTRIES);
    expect(counts.staged).toBe(2);
    expect(counts.unstaged).toBe(2);
    expect(counts.untracked).toBe(1);
    expect(counts.conflicts).toBe(1);
    expect(counts.ignored).toBe(1);
    expect(counts.total).toBe(5);
  });

  it("o modelo expõe as contagens do status atual", () => {
    const model = new SourceControlModel();
    model.setStatus(ENTRIES);
    expect(model.counts.total).toBe(5);
    expect(model.status).toHaveLength(6);
  });
});

describe("SourceControlModel — filtro", () => {
  it("filtra por caminho, sem diferenciar maiúsculas", () => {
    const filtrado = filterSourceControlEntries(ENTRIES, "ALTERADO");
    expect(filtrado.map((e) => e.path)).toEqual(["alterado.txt"]);
  });

  it("filtra também pelo caminho **original** (renomeação)", () => {
    const entrada = makeEntry({ path: "novo.txt", xy: "R ", oldPath: "antigo.txt", staged: true });
    expect(filterSourceControlEntries([entrada], "antigo").map((e) => e.path)).toEqual(["novo.txt"]);
  });

  it("query vazia ⇒ tudo", () => {
    expect(filterSourceControlEntries(ENTRIES, "   ")).toHaveLength(ENTRIES.length);
  });

  it("`filter` é puro: não muda o filtro do modelo", () => {
    const model = new SourceControlModel();
    model.setStatus(ENTRIES);
    model.filter("alterado");
    expect(model.filterQuery).toBe("");
    model.setFilter("alterado");
    expect(model.filterQuery).toBe("alterado");
    expect(model.visibleGroups.flatMap((g) => g.entries).map((e) => e.path)).toEqual([
      "alterado.txt",
    ]);
  });
});

describe("SourceControlModel — mensagem de commit", () => {
  it("get/set", () => {
    const model = new SourceControlModel();
    expect(model.commitMessage).toBe("");
    model.commitMessage = "mensagem";
    expect(model.commitMessage).toBe("mensagem");
    model.clearCommitMessage();
    expect(model.commitMessage).toBe("");
  });
});

describe("SourceControlModel — intenções (não executam nada)", () => {
  it("`stage` emite `onStage` com o path", () => {
    const staged: string[] = [];
    const model = new SourceControlModel({ onStage: (path) => staged.push(path) });
    model.stage("a.txt");
    expect(staged).toEqual(["a.txt"]);
    // A intenção **não** muda o status (quem executa é o `main`).
    expect(model.status).toEqual([]);
  });

  it("`unstage` emite `onUnstage` com o path", () => {
    const unstaged: string[] = [];
    const model = new SourceControlModel({ onUnstage: (path) => unstaged.push(path) });
    model.unstage("a.txt");
    expect(unstaged).toEqual(["a.txt"]);
  });

  it("`stageAll` emite `onStageAll` (lote)", () => {
    let chamadas = 0;
    const model = new SourceControlModel({ onStageAll: () => (chamadas += 1) });
    model.setStatus(ENTRIES);
    model.stageAll();
    expect(chamadas).toBe(1);
  });

  it("`stageAll` sem `onStageAll` cai para `onStage` por arquivo", () => {
    const staged: string[] = [];
    const model = new SourceControlModel({ onStage: (path) => staged.push(path) });
    model.setStatus(ENTRIES);
    model.stageAll();
    expect(staged).toEqual(["ambos.txt", "alterado.txt", "novo.txt"]);
  });

  it("`commit` emite `onCommit` com a mensagem", () => {
    const commits: string[] = [];
    const model = new SourceControlModel({ onCommit: (message) => commits.push(message) });
    model.commitMessage = "corrige o bug";
    model.commit();
    expect(commits).toEqual(["corrige o bug"]);
  });

  it("`commit` sem mensagem não emite nada", () => {
    const commits: string[] = [];
    const model = new SourceControlModel({ onCommit: (message) => commits.push(message) });
    model.commit();
    model.commitMessage = "   ";
    model.commit();
    expect(commits).toEqual([]);
  });

  it("`select` guarda a seleção e avisa o chamador", () => {
    const selecionadas: string[] = [];
    const model = new SourceControlModel({ onSelect: (path) => selecionadas.push(path) });
    model.select("a.txt");
    expect(model.selectedPath).toBe("a.txt");
    expect(selecionadas).toEqual(["a.txt"]);
  });
});

describe("SourceControlModel — estado vazio", () => {
  it("sem status: zero contagens e nenhum grupo com arquivos", () => {
    const model = new SourceControlModel();
    model.setStatus([]);
    expect(model.counts.total).toBe(0);
    expect(model.visibleGroups.every((group) => group.entries.length === 0)).toBe(true);
  });

  it("textos do estado vazio", () => {
    expect(describeSourceControlCounts({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ignored: 0, total: 0 })).toBe("0 alterações");
    expect(describeSourceControlCounts({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ignored: 0, total: 1 })).toBe("1 alteração");
    expect(describeSourceControlCounts({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ignored: 0, total: 3 })).toBe("3 alterações");
    expect(describeSourceControlEmpty("")).toBe("Nenhuma alteração");
    expect(describeSourceControlEmpty("abc")).toBe("Nenhum arquivo corresponde ao filtro");
    expect(formatSourceControlBadge({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ignored: 0, total: 0 })).toBe("");
    expect(formatSourceControlBadge({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ignored: 0, total: 4 })).toBe("4");
    expect(describeSourceControlBranch("")).toBe("sem branch");
    expect(describeSourceControlBranch(" main ")).toBe("main");
  });

  it("a cor de cada kind é um **token** do tema (nunca uma cor literal)", () => {
    for (const kind of ["added", "modified", "deleted", "renamed", "untracked", "conflicted"] as const) {
      expect(gitStatusColorToken(kind)).toMatch(/^var\(--s-[a-z-]+\)$/);
    }
  });
});

// ── DOM falso (o ambiente de teste é `node`, sem jsdom) ──────────────────────────────────────
// O DOM falso é **compartilhado** (`test/helpers/fake-dom.ts`) — os 5 painéis do renderer são
// testados contra ele (o SCM foi o primeiro).

describe("mountSourceControlPanel — degradação **sem** DOM", () => {
  beforeAll(() => {
    uninstallFakeDom();
  });

  afterAll(() => {
    uninstallFakeDom();
  });

  it("sem `document` e sem host ⇒ handle no-op (não quebra)", () => {
    const handle = mountSourceControlPanel(undefined, {});
    expect(() => handle.update(ENTRIES)).not.toThrow();
    expect(() => handle.setBranch("main")).not.toThrow();
    expect(() => handle.setError("erro")).not.toThrow();
    expect(() => handle.clearCommitMessage()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("sem DOM o modelo continua funcionando (o chamador lê as contagens)", () => {
    const handle = mountSourceControlPanel(undefined, {});
    handle.update(ENTRIES);
    expect(handle.model.counts.total).toBe(5);
    expect(handle.model.branch).toBe("");
    handle.setBranch("main");
    expect(handle.model.branch).toBe("main");
  });

  it("sem DOM, um host qualquer também degrada (nada é criado)", () => {
    const host = new FakeElement("div");
    const handle = mountSourceControlPanel(host as unknown as HTMLElement, {});
    expect(host.children).toHaveLength(0);
    expect(() => handle.dispose()).not.toThrow();
  });
});

describe("mountSourceControlPanel — com DOM", () => {
  let host: FakeElement;

  beforeAll(() => {
    installFakeDom();
  });

  afterAll(() => {
    uninstallFakeDom();
  });

  beforeEach(() => {
    host = new FakeElement("div");
  });

  /** Monta o painel e devolve o root. */
  function mount(
    options: Parameters<typeof mountSourceControlPanel>[1] = {},
  ): { root: FakeElement; handle: ReturnType<typeof mountSourceControlPanel> } {
    const handle = mountSourceControlPanel(host as unknown as HTMLElement, options);
    const root = host.children[0];
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("painel não montado");
    return { root, handle };
  }

  it("monta o cabeçalho (branch + contagem), o commit e a lista", () => {
    const { root } = mount();
    expect(root.className).toBe("source-control");
    expect(byClass(root, "source-control-branch")).toHaveLength(1);
    expect(byClass(root, "source-control-count")[0]?.textContent).toBe("0 alterações");
    expect(byClass(root, "source-control-message")).toHaveLength(1);
    expect(byClass(root, "source-control-commit-button")).toHaveLength(1);
    expect(byClass(root, "source-control-list")).toHaveLength(1);
  });

  it("`setBranch` escreve o branch no cabeçalho", () => {
    const { root, handle } = mount();
    handle.setBranch("feature/x");
    expect(byClass(root, "source-control-branch")[0]?.textContent).toBe("feature/x");
  });

  it("`update` desenha uma linha por arquivo, com o status colorido", () => {
    const { root, handle } = mount();
    handle.update([makeEntry({ path: "a.txt", xy: " M", unstaged: true })]);
    const rows = byClass(root, "source-control-row");
    expect(rows).toHaveLength(1);
    expect(byClass(rows[0] as FakeElement, "source-control-status")[0]?.textContent).toBe("M");
    expect(byClass(rows[0] as FakeElement, "source-control-path")[0]?.textContent).toBe("a.txt");
    const badge = byClass(rows[0] as FakeElement, "source-control-status")[0];
    expect(badge?.style.cssText).toContain("var(--s-warn)");
  });

  it("o botão de stage (+) prepara e o de unstage (−) desfaz", () => {
    const staged: string[] = [];
    const unstaged: string[] = [];
    const { root, handle } = mount({
      onStage: (path) => staged.push(path),
      onUnstage: (path) => unstaged.push(path),
    });
    handle.update([
      makeEntry({ path: "preparado.txt", xy: "M ", staged: true }),
      makeEntry({ path: "alterado.txt", xy: " M", unstaged: true }),
    ]);
    const rows = byClass(root, "source-control-row");
    const botoesPreparado = byClass(rows[0] as FakeElement, "source-control-action");
    const botoesAlterado = byClass(rows[1] as FakeElement, "source-control-action");
    expect(botoesPreparado.map((button) => button.textContent)).toEqual(["−"]);
    expect(botoesAlterado.map((button) => button.textContent)).toEqual(["+"]);
    (botoesPreparado[0] as FakeElement).dispatch("click");
    (botoesAlterado[0] as FakeElement).dispatch("click");
    expect(unstaged).toEqual(["preparado.txt"]);
    expect(staged).toEqual(["alterado.txt"]);
  });

  it("a mensagem digitada vai para o commit", () => {
    const commits: string[] = [];
    const { root, handle } = mount({ onCommit: (message) => commits.push(message) });
    const input = byClass(root, "source-control-message")[0] as FakeElement;
    input.value = "corrige o bug";
    input.dispatch("input");
    (byClass(root, "source-control-commit-button")[0] as FakeElement).dispatch("click");
    expect(commits).toEqual(["corrige o bug"]);
    expect(handle.model.commitMessage).toBe("corrige o bug");
  });

  it("o filtro esconde as linhas que não casam", () => {
    const { root, handle } = mount();
    handle.update([
      makeEntry({ path: "alfa.txt", xy: " M", unstaged: true }),
      makeEntry({ path: "beta.txt", xy: " M", unstaged: true }),
    ]);
    expect(byClass(root, "source-control-row")).toHaveLength(2);
    const filter = byClass(root, "source-control-filter-input")[0] as FakeElement;
    filter.value = "beta";
    filter.dispatch("input");
    const rows = byClass(root, "source-control-row");
    expect(rows).toHaveLength(1);
    expect(byClass(rows[0] as FakeElement, "source-control-path")[0]?.textContent).toBe("beta.txt");
  });

  it("estado vazio: “Nenhuma alteração”", () => {
    const { root, handle } = mount();
    handle.update([]);
    expect(byClass(root, "source-control-empty")[0]?.textContent).toBe("Nenhuma alteração");
    expect(byClass(root, "source-control-row")).toHaveLength(0);
  });

  it("“Preparar tudo” emite a intenção de stage em lote", () => {
    let chamadas = 0;
    const { root, handle } = mount({ onStageAll: () => (chamadas += 1) });
    handle.update(ENTRIES);
    (byClass(root, "source-control-stage-all")[0] as FakeElement).dispatch("click");
    expect(chamadas).toBe(1);
  });

  it("clicar na linha seleciona o arquivo", () => {
    const selecionadas: string[] = [];
    const { root, handle } = mount({ onSelect: (path) => selecionadas.push(path) });
    handle.update([makeEntry({ path: "a.txt", xy: " M", unstaged: true })]);
    (byClass(root, "source-control-row")[0] as FakeElement).dispatch("click");
    expect(selecionadas).toEqual(["a.txt"]);
    expect(handle.model.selectedPath).toBe("a.txt");
  });

  it("`dispose` remove o painel do host", () => {
    const { handle } = mount();
    expect(host.children).toHaveLength(1);
    handle.dispose();
    expect(host.children).toHaveLength(0);
  });

  // ── o erro do git é visível no painel (e não só na status bar) ──

  it("`setError` desenha o erro do git no painel", () => {
    const { root, handle } = mount();
    const erro = firstByClass(root, "source-control-error");
    expect(erro).toBeDefined();
    expect(erro?.hidden).toBe(true);

    handle.setError("Author identity unknown");

    expect(erro?.hidden).toBe(false);
    expect(erro?.textContent).toBe("Author identity unknown");
    expect(handle.model.error).toBe("Author identity unknown");
  });

  it("`setError(null)` esconde o erro", () => {
    const { root, handle } = mount();
    const erro = firstByClass(root, "source-control-error");
    handle.setError("falhou");
    expect(erro?.hidden).toBe(false);

    handle.setError(null);

    expect(erro?.hidden).toBe(true);
    expect(erro?.textContent).toBe("");
    expect(handle.model.error).toBeNull();
  });

  it("o `update` redesenha o erro (o erro continua visível)", () => {
    const { root, handle } = mount();
    handle.setError("falhou");
    handle.update([makeEntry({ path: "a.txt", xy: " M", unstaged: true })]);
    const erro = firstByClass(root, "source-control-error");
    expect(erro?.hidden).toBe(false);
    expect(erro?.textContent).toBe("falhou");
  });

  // ── o botão "+"/"−" não pode roubar o foco ──

  it("o clique no botão (+) não redesenha a lista (o foco não se perde)", () => {
    const staged: string[] = [];
    const { root, handle } = mount({ onStage: (path) => staged.push(path) });
    handle.update([makeEntry({ path: "a.txt", xy: " M", unstaged: true })]);

    const row = byClass(root, "source-control-row")[0];
    const botao = firstByClass(row ?? root, "source-control-action");
    expect(botao).toBeDefined();
    botao?.focus();

    botao?.dispatch("click");

    expect(staged).toEqual(["a.txt"]);
    // O botão **não** foi recriado (a lista não foi redesenhada) ⇒ o foco continua nele.
    expect(byClass(root, "source-control-action")[0]).toBe(botao);
    expect(byClass(root, "source-control-row")[0]).toBe(row);
    // O clique não seleciona o arquivo (o clique não sobe para a linha).
    expect(handle.model.selectedPath).toBeUndefined();
  });

  it("o clique no botão (−) também não redesenha a lista", () => {
    const unstaged: string[] = [];
    const { root, handle } = mount({ onUnstage: (path) => unstaged.push(path) });
    handle.update([makeEntry({ path: "a.txt", xy: "M ", staged: true })]);
    const botao = firstByClass(root, "source-control-action");
    botao?.dispatch("click");
    expect(unstaged).toEqual(["a.txt"]);
    expect(byClass(root, "source-control-action")[0]).toBe(botao);
  });

  // ── host escondido ⇒ não redesenha ──

  it("com o host escondido o painel não redesenha (e desenha quando volta)", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update([makeEntry({ path: "a.txt", xy: " M", unstaged: true })]);

    // Escondido ⇒ a lista não foi desenhada…
    expect(byClass(root, "source-control-row")).toHaveLength(0);
    // …mas o estado está no modelo.
    expect(handle.model.counts.total).toBe(1);

    // O host volta a aparecer ⇒ o painel redesenha (sem precisar de outro `update`).
    host.hidden = false;
    expect(byClass(root, "source-control-row")).toHaveLength(1);
  });

  it("o próximo `update` com o host visível também desenha", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update([makeEntry({ path: "a.txt", xy: " M", unstaged: true })]);
    expect(byClass(root, "source-control-row")).toHaveLength(0);

    host.hidden = false;
    handle.update([makeEntry({ path: "a.txt", xy: " M", unstaged: true })]);
    expect(byClass(root, "source-control-row")).toHaveLength(1);
  });
});
