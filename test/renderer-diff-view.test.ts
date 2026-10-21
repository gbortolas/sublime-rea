/**
 * Scribe — testes do **painel de diff** (`src/renderer/diff-view.ts`).
 *
 * O vitest roda em `environment: "node"` (**sem jsdom**) ⇒ a **lógica pura** do painel
 * ({@link DiffViewModel}: navegação entre hunks, filtro de "só mudanças", linha para onde
 * saltar) é testada sem DOM, e o **DOM** é testado contra o **DOM falso** compartilhado
 * (`test/helpers/fake-dom.ts`).
 *
 * O que o DOM prova: a navegação entre hunks **não** redesenha o diff (só rola até o hunk)
 * e o painel escondido **não** redesenha.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "../src/core/git/git-diff";
import type { DiffHunk } from "../src/core/git/git-diff";
import { DiffViewModel, diffDisplayPath, mountDiffView } from "../src/renderer/diff-view";
import {
  byClass,
  FakeElement,
  firstByClass,
  installFakeDom,
  uninstallFakeDom,
} from "./helpers/fake-dom";

const DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@ função()",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -20,1 +21,2 @@ outra()",
  " keep",
  "+new",
  "",
].join("\n");

function hunksOf(diff: string): readonly DiffHunk[] {
  return parseUnifiedDiff(diff);
}

describe("DiffViewModel — o diff carregado", () => {
  it("guarda os hunks e começa no primeiro", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    expect(model.hunkCount).toBe(2);
    expect(model.currentHunkIndex).toBe(0);
    expect(model.currentHunk?.header).toBe("@@ -1,3 +1,4 @@ função()");
  });

  it("diff vazio: sem hunks, sem linhas, sem navegação", () => {
    const model = new DiffViewModel();
    model.setDiff([]);
    expect(model.hunkCount).toBe(0);
    expect(model.currentHunk).toBeUndefined();
    expect(model.visibleLines).toEqual([]);
    expect(model.visibleHunkBlocks).toEqual([]);
    expect(model.nextHunk()).toBeUndefined();
    expect(model.prevHunk()).toBeUndefined();
  });

  it("a lista de linhas visíveis traz todos os hunks", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    expect(model.visibleLines.map((line) => line.kind)).toEqual([
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
      "ctx",
      "add",
    ]);
    expect(model.visibleHunkBlocks).toHaveLength(2);
  });
});

describe("DiffViewModel — navegação entre hunks", () => {
  it("nextHunk avança e devolve o hunk novo", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const next = model.nextHunk();
    expect(next?.header).toBe("@@ -20,1 +21,2 @@ outra()");
    expect(model.currentHunkIndex).toBe(1);
  });

  it("nextHunk é cíclico (o último volta ao primeiro)", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    model.nextHunk();
    model.nextHunk();
    expect(model.currentHunkIndex).toBe(0);
  });

  it("prevHunk recua e é cíclico (o primeiro volta ao último)", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const prev = model.prevHunk();
    expect(prev?.header).toBe("@@ -20,1 +21,2 @@ outra()");
    expect(model.currentHunkIndex).toBe(1);
  });

  it("goToHunk escolhe o hunk pelo índice (fora da faixa não muda)", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    model.goToHunk(1);
    expect(model.currentHunkIndex).toBe(1);
    model.goToHunk(99);
    expect(model.currentHunkIndex).toBe(1);
    model.goToHunk(-1);
    expect(model.currentHunkIndex).toBe(1);
  });

  it("setDiff volta a navegação para o primeiro hunk", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    model.nextHunk();
    model.setDiff(hunksOf(DIFF));
    expect(model.currentHunkIndex).toBe(0);
  });
});

describe("DiffViewModel — lineToJump (a linha no arquivo novo)", () => {
  it("uma linha adicionada salta para a própria linha do arquivo novo", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const added = model.diff[0]?.lines[2];
    expect(added?.kind).toBe("add");
    expect(model.lineToJump(added!)).toBe(2);
  });

  it("uma linha de contexto salta para a própria linha do arquivo novo", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const ctx = model.diff[0]?.lines[4];
    expect(ctx?.kind).toBe("ctx");
    expect(model.lineToJump(ctx!)).toBe(4);
  });

  it("uma linha removida salta para onde a remoção aconteceu no arquivo novo", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const removed = model.diff[0]?.lines[1];
    expect(removed?.kind).toBe("del");
    // A linha removida não existe mais: o ponto é a linha 2 do arquivo novo.
    expect(model.lineToJump(removed!)).toBe(2);
  });

  it("uma linha de metadado não tem linha para onde saltar", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const meta = { kind: "meta", text: "\\ No newline at end of file" } as const;
    expect(model.lineToJump(meta)).toBeUndefined();
  });

  it("uma linha que não pertence ao diff não tem linha para onde saltar", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const orphan = { kind: "add", text: "x", newLine: 7 } as const;
    expect(model.lineToJump(orphan)).toBeUndefined();
  });

  it("num diff vazio não há linha para onde saltar", () => {
    const model = new DiffViewModel();
    model.setDiff([]);
    const orphan = { kind: "add", text: "x", newLine: 7 } as const;
    expect(model.lineToJump(orphan)).toBeUndefined();
  });
});

describe("DiffViewModel — filtro \"só mudanças\"", () => {
  it("esconde o contexto (e os metadados internos)", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    model.showOnlyChanges = true;
    expect(model.visibleLines.map((line) => line.kind)).toEqual(["del", "add", "add", "add"]);
  });

  it("cada bloco mostra só as linhas alteradas do seu hunk", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    model.showOnlyChanges = true;
    const blocks = model.visibleHunkBlocks;
    expect(blocks[0]?.lines.map((line) => line.kind)).toEqual(["del", "add", "add"]);
    expect(blocks[1]?.lines.map((line) => line.kind)).toEqual(["add"]);
  });

  it("desligado, volta a mostrar tudo", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    model.showOnlyChanges = true;
    model.showOnlyChanges = false;
    expect(model.visibleLines).toHaveLength(7);
  });
});

describe("DiffViewModel — helpers", () => {
  it("firstChangedLine acha a primeira linha alterada do hunk", () => {
    const model = new DiffViewModel();
    model.setDiff(hunksOf(DIFF));
    const hunk = model.diff[0];
    expect(hunk === undefined ? undefined : model.firstChangedLine(hunk)?.kind).toBe("del");
  });

  it("diffDisplayPath prefere o lado novo e cai para o antigo", () => {
    expect(diffDisplayPath("a.txt", "b.txt")).toBe("b.txt");
    expect(diffDisplayPath("a.txt", "/dev/null")).toBe("a.txt");
    expect(diffDisplayPath("/dev/null", "/dev/null")).toBe("");
  });
});

describe("mountDiffView — degradação sem DOM", () => {
  it("sem host devolve um handle inerte (sem quebrar)", () => {
    const handle = mountDiffView(null);
    expect(handle.mounted).toBe(false);
    expect(() => handle.update([])).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("sem DOM (node) o handle também é inerte", () => {
    // O vitest roda em `environment: "node"` ⇒ não há `document` ⇒ degradação.
    const handle = mountDiffView(undefined);
    expect(handle.mounted).toBe(false);
    expect(() => handle.update(hunksOf(DIFF))).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("mesmo sem DOM, o modelo guarda o diff (o estado não depende da view)", () => {
    const handle = mountDiffView(null);
    handle.update(hunksOf(DIFF));
    expect(handle.model.hunkCount).toBe(2);
    expect(handle.model.visibleLines).toHaveLength(7);
  });

  it("dispose é idempotente", () => {
    const handle = mountDiffView(null);
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
  });
});

describe("mountDiffView — com DOM (o DOM falso compartilhado)", () => {
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

  /** Monta o painel no host falso e devolve o root. */
  function mount(
    options: Parameters<typeof mountDiffView>[1] = {},
  ): { root: FakeElement; handle: ReturnType<typeof mountDiffView> } {
    const handle = mountDiffView(host as unknown as HTMLElement, options);
    const root = host.children[0];
    expect(root).toBeDefined();
    if (root === undefined) throw new Error("painel não montado");
    return { root, handle };
  }

  it("desenha os hunks (um bloco por hunk) e o resumo", () => {
    const { root, handle } = mount();
    handle.update(hunksOf(DIFF));
    expect(byClass(root, "diff-view-hunk")).toHaveLength(2);
    expect(firstByClass(root, "diff-view-stats")?.textContent).toBe("+3 −1");
    expect(firstByClass(root, "diff-view-title")?.textContent).toBe("src/foo.ts");
  });

  it("o ↑/↓ **não** redesenha o diff (só rola até o hunk)", () => {
    const mudancas: number[] = [];
    const { root, handle } = mount({ onHunkChange: (index: number) => mudancas.push(index) });
    handle.update(hunksOf(DIFF));
    const blocos = byClass(root, "diff-view-hunk");
    expect(blocos).toHaveLength(2);
    const primeiro = blocos[0];

    (firstByClass(root, "diff-view-next") as FakeElement).dispatch("click");

    // O hunk atual mudou…
    expect(handle.model.currentHunkIndex).toBe(1);
    expect(mudancas).toEqual([1]);
    // …mas o DOM **não** foi reconstruído (o diff pode ter 1 MiB!).
    expect(byClass(root, "diff-view-hunk")[0]).toBe(primeiro);
    // E a visão rolou até o hunk atual.
    expect(blocos[1]?.scrollIntoViewCalls).toBe(1);
    // O hunk atual fica marcado.
    expect(blocos[1]?.getAttribute("data-current")).toBe("true");
    expect(blocos[0]?.getAttribute("data-current")).toBeUndefined();
  });

  it("o ↑ (hunk anterior) também só rola", () => {
    const { root, handle } = mount();
    handle.update(hunksOf(DIFF));
    const blocos = byClass(root, "diff-view-hunk");

    (firstByClass(root, "diff-view-next") as FakeElement).dispatch("click");
    (firstByClass(root, "diff-view-prev") as FakeElement).dispatch("click");

    expect(handle.model.currentHunkIndex).toBe(0);
    expect(byClass(root, "diff-view-hunk")[0]).toBe(blocos[0]);
    expect(blocos[0]?.scrollIntoViewCalls).toBe(1);
  });

  it("o clique no cabeçalho do hunk rola até ele (sem rebuild)", () => {
    const { root, handle } = mount();
    handle.update(hunksOf(DIFF));
    const blocos = byClass(root, "diff-view-hunk");
    const cabecalhos = byClass(root, "diff-view-hunk-header");

    (cabecalhos[1] as FakeElement).dispatch("click");

    expect(handle.model.currentHunkIndex).toBe(1);
    expect(byClass(root, "diff-view-hunk")[0]).toBe(blocos[0]);
    expect(blocos[1]?.scrollIntoViewCalls).toBe(1);
  });

  it("com o host escondido o painel não redesenha (e desenha quando volta)", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update(hunksOf(DIFF));
    expect(byClass(root, "diff-view-hunk")).toHaveLength(0);
    // O estado continua no modelo.
    expect(handle.model.hunkCount).toBe(2);

    // O host volta a aparecer ⇒ o painel redesenha (sem precisar de outro `update`).
    // (É o caso do `main`: ele preenche o diff **antes** de abrir a seção.)
    host.hidden = false;
    expect(byClass(root, "diff-view-hunk")).toHaveLength(2);
  });

  it("o próximo `update` com o host visível também desenha", () => {
    host.hidden = true;
    const { root, handle } = mount();
    handle.update(hunksOf(DIFF));
    expect(byClass(root, "diff-view-hunk")).toHaveLength(0);

    host.hidden = false;
    handle.update(hunksOf(DIFF));
    expect(byClass(root, "diff-view-hunk")).toHaveLength(2);
  });

  it("o clique numa linha avisa a linha do arquivo novo", () => {
    const saltos: number[] = [];
    const { root, handle } = mount({ onJump: (line: number) => saltos.push(line) });
    handle.update(hunksOf(DIFF));
    const linhas = byClass(root, "diff-view-line-add");
    (linhas[0] as FakeElement).dispatch("click");
    expect(saltos).toEqual([2]);
  });

  it("o \\r do CRLF não vira quebra de linha na tela", () => {
    // O parser **guarda** o `\r` (é parte da linha do arquivo) — a tela não mostra o
    // caractere cru (o navegador transformaria `\r` em quebra de linha).
    const crlf = "diff --git a/x.txt b/x.txt\r\n--- a/x.txt\r\n+++ b/x.txt\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n";
    const { root, handle } = mount();
    handle.update(parseUnifiedDiff(crlf));
    const textos = byClass(root, "diff-view-line-text").map((node) => node.textContent);
    expect(textos).toEqual(["-a", "+b"]);
  });
});
