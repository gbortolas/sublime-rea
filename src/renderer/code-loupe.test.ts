/**
 * Scribe — testes da geometria da lupa (`src/renderer/code-loupe.ts`).
 *
 * A lupa é a "coluna de código" ampliada: o preview **magnificado** (fonte × 2.5) e **colorido**
 * que segue o mouse sobre o minimap. Aqui travamos as invariantes puras (sem DOM):
 * - a janela de linhas é **centrada** na linha sob o mouse e **recortada** no documento;
 * - o painel fica **à esquerda** do minimap (nunca sobre ele) e dentro da janela;
 * - a linha sob o mouse fica **centralizada** no painel (sem buraco no topo);
 * - o zoom multiplica a fonte do editor;
 * - sem spans ⇒ texto puro (degradação), sem inventar caracteres.
 */
import { describe, expect, it } from "vitest";

import type { HighlightSpan, ScopeStyle, ThemeResolver } from "../shared";
import {
  LOUPE_LINE_COUNT,
  LOUPE_MIN_WIDTH_PX,
  LOUPE_ZOOM,
  computeLoupeContentOffset,
  computeLoupePanelSize,
  computeLoupePosition,
  computeLoupeWindow,
  loupeLineOffset,
  tokenizeLoupeLine,
} from "./code-loupe";

/** Tema fake: `keyword` → verde, `comment` → cinza. */
const theme: ThemeResolver = {
  styleFor(scope: string): ScopeStyle | undefined {
    if (scope === "keyword") return { color: 0x00ff00ff };
    if (scope === "comment") return { color: 0x808080ff };
    return undefined;
  },
};

describe("computeLoupeWindow — janela de linhas do preview", () => {
  it("centra a janela na linha sob o mouse", () => {
    const win = computeLoupeWindow({ line: 100, lineCount: 1000 });
    expect(win.count).toBe(LOUPE_LINE_COUNT);
    expect(win.firstLine).toBe(100 - Math.floor(LOUPE_LINE_COUNT / 2));
    expect(win.lastLine).toBe(win.firstLine + LOUPE_LINE_COUNT - 1);
  });

  it("no topo do documento a janela começa em 0 (sem linhas negativas)", () => {
    const win = computeLoupeWindow({ line: 0, lineCount: 1000 });
    expect(win.firstLine).toBe(0);
    expect(win.lastLine).toBe(LOUPE_LINE_COUNT - 1);
    expect(win.count).toBe(LOUPE_LINE_COUNT);
  });

  it("no fim do documento a janela para na última linha", () => {
    const win = computeLoupeWindow({ line: 999, lineCount: 1000 });
    expect(win.lastLine).toBe(999);
    expect(win.firstLine).toBe(1000 - LOUPE_LINE_COUNT);
    expect(win.count).toBe(LOUPE_LINE_COUNT);
  });

  it("documento mais curto que a janela ⇒ mostra só o que existe", () => {
    const win = computeLoupeWindow({ line: 2, lineCount: 5 });
    expect(win.count).toBe(5);
    expect(win.firstLine).toBe(0);
    expect(win.lastLine).toBe(4);
  });

  it("documento vazio ⇒ janela vazia (nada a mostrar)", () => {
    const win = computeLoupeWindow({ line: 0, lineCount: 0 });
    expect(win.count).toBe(0);
    expect(win.lastLine).toBe(-1);
  });
});

describe("computeLoupePanelSize — zoom e tamanho do painel", () => {
  it("multiplica a fonte do editor pelo zoom (2.5×)", () => {
    const size = computeLoupePanelSize({ fontSize: 15, lines: 14 });
    expect(size.fontSize).toBe(Math.round(15 * LOUPE_ZOOM));
    expect(size.fontSize).toBe(38);
    expect(LOUPE_ZOOM).toBe(2.5);
  });

  it("a altura acompanha a quantidade de linhas", () => {
    const size = computeLoupePanelSize({ fontSize: 15, lines: 10 });
    expect(size.height).toBe(size.lineHeight * 10);
  });

  it("a largura nunca passa do espaço disponível à esquerda do minimap", () => {
    const size = computeLoupePanelSize({ fontSize: 15, lines: 14, availableWidth: 200 });
    expect(size.width).toBe(200);
    expect(size.width).toBeLessThan(360);
  });

  it("sem limite de espaço ⇒ largura padrão (360px)", () => {
    const size = computeLoupePanelSize({ fontSize: 15, lines: 14 });
    expect(size.width).toBe(360);
  });
});

describe("computeLoupePosition — o painel fica à esquerda do minimap", () => {
  const base = {
    minimapLeft: 1000,
    pointerY: 400,
    panelWidth: 360,
    panelHeight: 600,
    viewportWidth: 1200,
    viewportHeight: 900,
  };

  it("nunca fica sobre o minimap", () => {
    const pos = computeLoupePosition(base);
    expect(pos.left + base.panelWidth).toBeLessThanOrEqual(base.minimapLeft - 8);
  });

  it("segue o mouse verticalmente (centrado)", () => {
    const pos = computeLoupePosition(base);
    expect(pos.top).toBe(400 - 300);
  });

  it("não sai da janela (topo e base)", () => {
    const top = computeLoupePosition({ ...base, pointerY: 0 });
    expect(top.top).toBeGreaterThanOrEqual(8);
    const bottom = computeLoupePosition({ ...base, pointerY: 900 });
    expect(bottom.top + base.panelHeight).toBeLessThanOrEqual(900);
  });

  it("sem espaço à esquerda ⇒ largura insuficiente (a lupa não abre)", () => {
    // O chamador esconde a lupa quando `width < LOUPE_MIN_WIDTH_PX`.
    const size = computeLoupePanelSize({ fontSize: 15, lines: 14, availableWidth: 100 });
    expect(size.width).toBeLessThan(LOUPE_MIN_WIDTH_PX);
  });
});

describe("loupeLineOffset / computeLoupeContentOffset — a linha sob o mouse", () => {
  it("o offset é a distância da linha sob o mouse até o topo da janela", () => {
    expect(loupeLineOffset({ line: 10, firstLine: 0, lineHeight: 40 })).toBe(400);
    expect(loupeLineOffset({ line: 3, firstLine: 3, lineHeight: 40 })).toBe(0);
  });

  it("a linha sob o mouse fica no meio do painel", () => {
    const offset = computeLoupeContentOffset({
      hoverOffset: 7 * 40,
      lineHeight: 40,
      contentHeight: 14 * 40,
      panelHeight: 7 * 40,
    });
    // A 8ª linha (índice 7) é o centro do painel: 280 - 160 = 120 = 280/2 - 40/2.
    expect(offset).toBe(-160);
    expect(7 * 40 + offset).toBe(120);
  });

  it("painel do tamanho do conteúdo ⇒ não desliza (a linha fica onde está)", () => {
    const offset = computeLoupeContentOffset({
      hoverOffset: 7 * 40,
      lineHeight: 40,
      contentHeight: 14 * 40,
      panelHeight: 14 * 40,
    });
    expect(offset).toBe(0);
  });

  it("no topo do documento não deixa buraco (conteúdo não desliza)", () => {
    const offset = computeLoupeContentOffset({
      hoverOffset: 0,
      lineHeight: 40,
      contentHeight: 14 * 40,
      panelHeight: 14 * 40,
    });
    expect(offset).toBe(0);
  });

  it("painel menor que o conteúdo ⇒ o conteúdo desliza (sem ultrapassar as bordas)", () => {
    const offset = computeLoupeContentOffset({
      hoverOffset: 13 * 40,
      lineHeight: 40,
      contentHeight: 14 * 40,
      panelHeight: 7 * 40,
    });
    expect(offset).toBe(-(14 * 40 - 7 * 40));
  });
});

describe("tokenizeLoupeLine — cor por token", () => {
  const spans: readonly HighlightSpan[] = [
    { start: 0, end: 2, scope: "keyword" },
    { start: 3, end: 9, scope: "comment" },
  ];

  it("sem spans ⇒ texto puro (degradação para arquivo sem gramática)", () => {
    const tokens = tokenizeLoupeLine("const x = 1", undefined, theme);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.text).toBe("const x = 1");
    expect(tokens[0]?.color).toBeUndefined();
  });

  it("aplica a cor do tema em cada span", () => {
    const tokens = tokenizeLoupeLine("if (x) //oi", spans, theme);
    expect(tokens[0]?.text).toBe("if");
    expect(tokens[0]?.color).toBe("#00ff00");
    expect(tokens[1]?.text).toBe(" ");
    expect(tokens[1]?.color).toBeUndefined();
    expect(tokens[2]?.text).toBe("(x) //");
    expect(tokens[2]?.color).toBe("#808080");
    // A cauda depois do último span fica sem cor.
    expect(tokens[3]?.text).toBe("oi");
    expect(tokens[3]?.color).toBeUndefined();
  });

  it("span fora do texto é recortado (nunca inventa caracteres)", () => {
    const tokens = tokenizeLoupeLine("ab", [{ start: 0, end: 99, scope: "keyword" }], theme);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.text).toBe("ab");
  });

  it("escopo sem regra de tema ⇒ sem cor (herda a cor do painel)", () => {
    const tokens = tokenizeLoupeLine("xyz", [{ start: 0, end: 3, scope: "desconhecido" }], theme);
    expect(tokens[0]?.text).toBe("xyz");
    expect(tokens[0]?.color).toBeUndefined();
  });

  it("linha vazia ⇒ nenhum token", () => {
    expect(tokenizeLoupeLine("", spans, theme)).toEqual([]);
  });
});
