/**
 * Scribe — testes do popup **Quick Open** (⌘P / Ctrl+P).
 *
 * O ambiente de teste do projeto roda em **Node** (`environment: "node"`, sem jsdom), então o
 * DOM não é testável aqui: o que se testa é a **classificação fuzzy dos itens** (função pura)
 * e o **contrato** da API pública (funções presentes, no-op seguro quando não há DOM).
 */
import { describe, expect, it, vi } from "vitest";

import {
  hideQuickOpen,
  isQuickOpenVisible,
  rankQuickOpenItems,
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

  it("casa no rótulo quando o rótulo serve", () => {
    const ranked = rankQuickOpenItems("abrir", ITEMS);
    expect(ranked[0]!.item.id).toBe("cmd:file.open");
    expect(ranked[0]!.source).toBe("label");
  });

  it("casa na descrição (caminho) quando o rótulo não serve", () => {
    const ranked = rankQuickOpenItems("fb", ITEMS);
    expect(ranked[0]!.item.id).toBe("file:foo/bar.ts");
    expect(ranked[0]!.source).toBe("description");
    expect(ranked[0]!.match.indices).toEqual([0, 4]);
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
