/**
 * Scribe — testes do popup **Quick Open** (⌘P / Ctrl+P).
 *
 * O ambiente de teste do projeto roda em **Node** (`environment: "node"`, sem jsdom), então o
 * DOM não é testável aqui: o que se testa é a **classificação fuzzy dos itens** (função pura),
 * o **item "criar arquivo"** (função pura) e o **contrato** da API pública (funções presentes,
 * no-op seguro quando não há DOM).
 *
 * ⚠️ **A casa é pelo caminho**: o candidato do matching é o **caminho** do item (a
 * `description` dos arquivos), não o `label` (o basename). O `label` é o desempate.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createFileCandidate,
  highlightIndices,
  hideQuickOpen,
  isQuickOpenVisible,
  rankQuickOpenItems,
  rankQuickOpenResults,
  showQuickOpen,
  type QuickOpenItem,
} from "../src/renderer/quick-open";

const ITEMS: readonly QuickOpenItem[] = [
  { id: "file:src/main.ts", label: "main.ts", description: "src/main.ts", kind: "file", payload: "/ws/src/main.ts" },
  { id: "file:foo/bar.ts", label: "bar.ts", description: "foo/bar.ts", kind: "file", payload: "/ws/foo/bar.ts" },
  { id: "cmd:file.open", label: "Abrir arquivo", description: "file.open", kind: "command", payload: "file.open" },
  { id: "recent:src/main.ts", label: "main.ts", description: "aberto agora", kind: "recent", payload: "/ws/src/main.ts" },
];

describe("Quick Open — classificação dos itens", () => {
  it("a query vazia devolve todos os itens na ordem original (recentes primeiro)", () => {
    const ranked = rankQuickOpenItems("", ITEMS);
    expect(ranked.map((entry) => entry.item.id)).toEqual(ITEMS.map((item) => item.id));
    expect(ranked.every((entry) => entry.match.indices.length === 0)).toBe(true);
  });

  it("casa no rótulo quando o rótulo serve (comando)", () => {
    const ranked = rankQuickOpenItems("abrir", ITEMS);
    expect(ranked[0]!.item.id).toBe("cmd:file.open");
    expect(ranked[0]!.source).toBe("label");
  });

  it("casa no CAMINHO (a descrição) quando o basename não serve", () => {
    // A casa é por segmento: "f bar" (e não "fb", que atravessaria os segmentos).
    const ranked = rankQuickOpenItems("f bar", ITEMS);
    expect(ranked[0]!.item.id).toBe("file:foo/bar.ts");
    expect(ranked[0]!.source).toBe("description");
    expect(ranked[0]!.match.indices).toEqual([0, 4, 5, 6]);
  });

  it("a query que fala a pasta desempata dois arquivos de mesmo basename", () => {
    const items: readonly QuickOpenItem[] = [
      { id: "file:src/main.ts", label: "main.ts", description: "src/main.ts", kind: "file" },
      { id: "file:src/renderer/main.ts", label: "main.ts", description: "src/renderer/main.ts", kind: "file" },
    ];
    const ranked = rankQuickOpenItems("renderer main", items);
    // "src/main.ts" nem casa (a pasta não é "renderer").
    expect(ranked.map((entry) => entry.item.id)).toEqual(["file:src/renderer/main.ts"]);
    expect(ranked[0]!.source).toBe("description");
  });

  it("ordena por score decrescente", () => {
    const ranked = rankQuickOpenItems("main", ITEMS);
    const scores = ranked.map((entry) => entry.match.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("o que não casa fica de fora", () => {
    const ranked = rankQuickOpenItems("zzzqqq", ITEMS);
    expect(ranked).toHaveLength(0);
  });
});

describe("Quick Open — o item 'criar arquivo'", () => {
  const ROOTS: readonly string[] = ["/ws"];
  const OPTIONS = { roots: ROOTS };

  it("aparece quando a query parece um caminho e não casa nenhum arquivo", () => {
    const ranked = rankQuickOpenResults("src/novo.ts", ITEMS, OPTIONS);
    expect(ranked[ranked.length - 1]!.item.kind).toBe("create");
    expect(ranked[ranked.length - 1]!.item.label).toBe("novo.ts");
  });

  it("NÃO aparece quando a query casa um arquivo", () => {
    const ranked = rankQuickOpenResults("main.ts", ITEMS, OPTIONS);
    expect(ranked.some((entry) => entry.item.kind === "create")).toBe(false);
  });

  it("NÃO aparece para um arquivo que EXISTE e é achado pelo CAMINHO", () => {
    // A query com "/" acha o arquivo pelo caminho ⇒ o "criar" (badge NOV) **não** é
    // offercido para um arquivo que já existe.
    const ranked = rankQuickOpenResults("src/main.ts", ITEMS, OPTIONS);
    expect(ranked.map((entry) => entry.item.id)).toContain("file:src/main.ts");
    expect(ranked.some((entry) => entry.item.kind === "create")).toBe(false);
  });

  it("NÃO aparece quando a query não parece um caminho", () => {
    // "novo" não tem "/" nem "." — não é um caminho.
    expect(createFileCandidate("novo", OPTIONS)).toBeNull();
  });

  it("NÃO aparece sem raízes (não há onde criar)", () => {
    expect(createFileCandidate("src/novo.ts", { roots: [] })).toBeNull();
  });

  it("NÃO aparece com a query vazia", () => {
    expect(createFileCandidate("   ", OPTIONS)).toBeNull();
    const ranked = rankQuickOpenResults("", ITEMS, OPTIONS);
    expect(ranked.some((entry) => entry.item.kind === "create")).toBe(false);
  });

  it("fica no FIM da lista (menor prioridade)", () => {
    const items: readonly QuickOpenItem[] = [
      { id: "cmd:file.open", label: "Abrir arquivo", description: "file.open", kind: "command" },
      { id: "cmd:file.save", label: "Salvar arquivo", description: "file.save", kind: "command" },
    ];
    // A query casa o comando (pela descrição) e **não** casa nenhum arquivo ⇒ o item
    // "criar" é offercido — mas por último.
    const ranked = rankQuickOpenResults("file.open", items, OPTIONS);
    expect(ranked.map((entry) => entry.item.id)).toEqual([
      "cmd:file.open",
      "create:/ws/file.open",
    ]);
  });

  it("expõe o path absoluto candidato e o relativo", () => {
    const item = createFileCandidate("src/novo.ts", OPTIONS);
    expect(item).not.toBeNull();
    expect(item!.kind).toBe("create");
    expect(item!.path).toBe("/ws/src/novo.ts");
    expect(item!.description).toBe("src/novo.ts");
    expect(item!.payload).toEqual({
      kind: "create",
      path: "/ws/src/novo.ts",
      relativePath: "src/novo.ts",
    });
  });

  it("aceita um nome com ponto (sem barra)", () => {
    const item = createFileCandidate("novo.ts", OPTIONS);
    expect(item?.path).toBe("/ws/novo.ts");
    expect(item?.label).toBe("novo.ts");
  });

  it("no multi-root, o prefixo da raiz escolhe a raiz", () => {
    const roots: readonly string[] = ["/ws/proj", "/ws/outro"];
    const item = createFileCandidate("proj/src/novo.ts", { roots });
    expect(item?.path).toBe("/ws/proj/src/novo.ts");
    expect(item?.description).toBe("src/novo.ts");
  });

  it("sem prefixo de raiz, usa a 1ª raiz", () => {
    const roots: readonly string[] = ["/ws/proj", "/ws/outro"];
    const item = createFileCandidate("src/novo.ts", { roots });
    expect(item?.path).toBe("/ws/proj/src/novo.ts");
  });

  it("a base (pasta do documento ativo) vale para o NOME SIMPLES", () => {
    // O VS Code cria o arquivo **ao lado** do documento aberto — não na raiz.
    const item = createFileCandidate("novo.ts", {
      roots: ROOTS,
      baseDir: "/ws/src/renderer",
    });
    expect(item?.path).toBe("/ws/src/renderer/novo.ts");
    // O caminho **relativo** à raiz é o que a lista mostra.
    expect(item?.description).toBe("src/renderer/novo.ts");
  });

  it("com '/' na query, a base é a RAIZ (a query já diz o caminho)", () => {
    const item = createFileCandidate("src/novo.ts", {
      roots: ROOTS,
      baseDir: "/ws/src/renderer",
    });
    expect(item?.path).toBe("/ws/src/novo.ts");
  });

  it("sem base, o nome simples nasce na raiz (o comportamento antigo)", () => {
    const item = createFileCandidate("novo.ts", OPTIONS);
    expect(item?.path).toBe("/ws/novo.ts");
  });

  it("uma base fora das raízes é ignorada (o confinamento é do `main`)", () => {
    const item = createFileCandidate("novo.ts", { roots: ROOTS, baseDir: "/outro/pasta" });
    expect(item?.path).toBe("/ws/novo.ts");
  });
});

describe("Quick Open — o destaque (highlightIndices)", () => {
  const item: QuickOpenItem = {
    id: "file:src/renderer/main.ts",
    label: "main.ts",
    description: "src/renderer/main.ts",
    kind: "file",
  };

  it("a casa veio do CAMINHO: o rótulo é destacado pelo próprio rótulo", () => {
    const [entry] = rankQuickOpenItems("renderer", [item]);
    expect(entry).toBeDefined();
    // O `label` ("main.ts") **não** casa com "renderer" ⇒ nenhum destaque (e, com certeza,
    // não os índices do caminho — que apontariam para "n.t" no basename).
    expect(highlightIndices(entry!, item.label, "renderer")).toEqual([]);
    // A descrição (o caminho) é destacada com os índices da casa.
    expect(highlightIndices(entry!, item.description!, "renderer")).toEqual(
      entry!.match.indices,
    );
  });

  it("a casa veio do rótulo (comando): o destaque é o do rótulo", () => {
    const command: QuickOpenItem = {
      id: "cmd:file.open",
      label: "Abrir arquivo",
      description: "file.open",
      kind: "command",
    };
    const [entry] = rankQuickOpenItems("abrir", [command]);
    expect(entry).toBeDefined();
    expect(highlightIndices(entry!, command.label, "abrir")).toEqual(entry!.match.indices);
    // A descrição não é o texto da casa ⇒ nada é destacado nela.
    expect(highlightIndices(entry!, command.description!, "abrir")).toEqual([]);
  });

  it("o rótulo que casa é recalculado (o destaque cai no texto certo)", () => {
    const [entry] = rankQuickOpenItems("main", [item]);
    expect(entry).toBeDefined();
    // "main" casa no rótulo ("main.ts") ⇒ o destaque do rótulo são as letras do basename.
    expect(highlightIndices(entry!, item.label, "main")).toEqual([0, 1, 2, 3]);
  });
});

describe("Quick Open — contrato da API (sem DOM)", () => {
  it("showQuickOpen sem DOM é um no-op seguro (não lança)", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    expect(() => showQuickOpen({ items: ITEMS, onPick, onCancel })).not.toThrow();
    expect(isQuickOpenVisible()).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("hideQuickOpen sem popup é um no-op seguro", () => {
    expect(() => hideQuickOpen()).not.toThrow();
    expect(isQuickOpenVisible()).toBe(false);
  });
});
