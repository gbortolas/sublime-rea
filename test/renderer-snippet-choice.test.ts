/**
 * Scribe — testes do popup de escolha de snippet (`${1|a,b,c|}`).
 *
 * O ambiente de teste do projeto roda em **Node** (`environment: "node"`, sem jsdom), então o
 * DOM não é testável aqui: o que se testa é a **lógica pura** do popup (índice inicial,
 * movimento com setas, limites) e o **contrato** da API pública (funções presentes, no-op
 * seguro quando não há DOM).
 */
import { describe, expect, it, vi } from "vitest";

import {
  hideSnippetChoice,
  initialChoiceIndex,
  isSnippetChoiceVisible,
  moveChoiceIndex,
  showSnippetChoice,
} from "../src/renderer/snippet-choice";

describe("popup de escolha — lógica pura", () => {
  it("o índice inicial é a 1ª opção (-1 sem opções)", () => {
    expect(initialChoiceIndex(3)).toBe(0);
    expect(initialChoiceIndex(1)).toBe(0);
    expect(initialChoiceIndex(0)).toBe(-1);
  });

  it("as setas movem a seleção com clamp nos limites", () => {
    expect(moveChoiceIndex(0, 1, 3)).toBe(1);
    expect(moveChoiceIndex(1, 1, 3)).toBe(2);
    expect(moveChoiceIndex(2, 1, 3)).toBe(2); // não passa do fim
    expect(moveChoiceIndex(1, -1, 3)).toBe(0);
    expect(moveChoiceIndex(0, -1, 3)).toBe(0); // não passa do início
  });

  it("sem opções o índice é -1 (nada a selecionar)", () => {
    expect(moveChoiceIndex(0, 1, 0)).toBe(-1);
    expect(moveChoiceIndex(-1, -1, 0)).toBe(-1);
  });
});

describe("popup de escolha — contrato da API (sem DOM)", () => {
  it("showSnippetChoice sem DOM é um no-op seguro (não lança)", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    expect(() => showSnippetChoice({ choices: ["a", "b"], onPick, onCancel })).not.toThrow();
    expect(isSnippetChoiceVisible()).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("hideSnippetChoice sem popup é um no-op seguro", () => {
    expect(() => hideSnippetChoice()).not.toThrow();
    expect(isSnippetChoiceVisible()).toBe(false);
  });
});
