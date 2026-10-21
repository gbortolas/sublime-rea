/**
 * Scribe — testes da matemática do minimap (`src/renderer/minimap.ts`).
 *
 * Cobre o que quebrou: a altura da linha **escala** com o documento (`h/lineCount`) e
 * virava um bloco cinza de largura total. Aqui travamos as invariantes:
 * - altura da linha **fixa** (3px) — nunca uma "faixa";
 * - largura da barra **proporcional** ao comprimento da linha (não largura total);
 * - documento grande ⇒ **corte** a partir do topo, com `truncated` sinalizado;
 * - clique (y → linha) coerente com a janela desenhada.
 *
 * As funções são puras (sem DOM), então rodam no ambiente `node` do vitest.
 */
import { describe, expect, it } from "vitest";

import {
  MINIMAP_BAR_MIN_WIDTH,
  MINIMAP_LINE_HEIGHT,
  computeMinimapLayout,
  computeMinimapWindow,
  minimapBarWidth,
  minimapLineAtY,
  minimapViewportRect,
} from "./minimap";

describe("computeMinimapLayout — altura de linha fixa", () => {
  it("altura da linha é fixa e não depende do número de linhas", () => {
    const few = computeMinimapLayout({ viewportHeight: 660, lineCount: 60 });
    const many = computeMinimapLayout({ viewportHeight: 660, lineCount: 10_000 });
    expect(few.lineH).toBe(MINIMAP_LINE_HEIGHT);
    expect(many.lineH).toBe(MINIMAP_LINE_HEIGHT);
    // A barra nunca passa de 4px — é isso que evita as "faixas" cinza.
    expect(few.lineH).toBeLessThanOrEqual(4);
    expect(many.lineH).toBeLessThanOrEqual(4);
  });

  it("com 1px de altura o passo vertical ganha 1px de gap (linhas não colam)", () => {
    const layout = computeMinimapLayout({ viewportHeight: 100, lineCount: 10, lineHeight: 1 });
    expect(layout.lineH).toBe(1);
    expect(layout.rowPitch).toBe(2);
  });

  it("documento vazio ⇒ nada a desenhar", () => {
    const layout = computeMinimapLayout({ viewportHeight: 660, lineCount: 0 });
    expect(layout.visibleLines).toBe(0);
    expect(layout.truncated).toBe(false);
    expect(layout.firstLine).toBe(0);
  });

  it("documento de 1 linha ⇒ 1 linha visível, sem corte", () => {
    const layout = computeMinimapLayout({ viewportHeight: 660, lineCount: 1 });
    expect(layout.visibleLines).toBe(1);
    expect(layout.truncated).toBe(false);
  });

  it("documento de 10.000 linhas ⇒ corta a partir do topo e sinaliza o corte", () => {
    const layout = computeMinimapLayout({ viewportHeight: 660, lineCount: 10_000 });
    expect(layout.firstLine).toBe(0);
    expect(layout.truncated).toBe(true);
    // 660 / 3 = 220 linhas cabem; o resto é cortado.
    expect(layout.visibleLines).toBe(220);
    expect(layout.visibleLines).toBeLessThan(10_000);
  });

  it("faixa de altura 0 ⇒ capacidade 0", () => {
    const layout = computeMinimapLayout({ viewportHeight: 0, lineCount: 100 });
    expect(layout.visibleLines).toBe(0);
  });

  // `fill`: a janela (range visível) é ampliada para ocupar a faixa inteira — sem isso o
  // minimap usava só ~13% da altura (a barra ficava colada no topo).
  it("fill ⇒ o passo vertical cresce para a janela ocupar a faixa toda", () => {
    const layout = computeMinimapLayout({
      viewportHeight: 660,
      lineCount: 200,
      firstLine: 10,
      maxLines: 30,
      fill: true,
    });
    expect(layout.visibleLines).toBe(30);
    expect(layout.firstLine).toBe(10);
    // 30 linhas em 660px ⇒ passo de 22px (o conteúdo preenche a faixa).
    expect(layout.rowPitch).toBe(22);
    expect(layout.rowPitch * layout.visibleLines).toBeGreaterThanOrEqual(660);
  });

  it("fill não altera o comportamento padrão (sem fill, o passo é o fixo de 3px)", () => {
    const plain = computeMinimapLayout({ viewportHeight: 660, lineCount: 200, firstLine: 10, maxLines: 30 });
    const filled = computeMinimapLayout({ viewportHeight: 660, lineCount: 200, firstLine: 10, maxLines: 30, fill: true });
    expect(plain.rowPitch).toBe(3);
    expect(filled.rowPitch).toBeGreaterThan(plain.rowPitch);
    expect(filled.visibleLines).toBe(plain.visibleLines);
  });

  it("fill com janela vazia não divide por zero", () => {
    const layout = computeMinimapLayout({ viewportHeight: 660, lineCount: 0, maxLines: 0, fill: true });
    expect(layout.visibleLines).toBe(0);
  });
});

describe("minimapBarWidth — largura proporcional ao comprimento da linha", () => {
  it("linha vazia ⇒ largura 0 (não há barra para desenhar)", () => {
    expect(minimapBarWidth({ lineLength: 0, maxLineLength: 40, availableWidth: 60 })).toBe(0);
  });

  it("linha mais longa ocupa toda a largura disponível", () => {
    expect(minimapBarWidth({ lineLength: 40, maxLineLength: 40, availableWidth: 60 })).toBe(60);
  });

  it("linha pela metade ocupa metade da largura (proporcional, não largura total)", () => {
    const width = minimapBarWidth({ lineLength: 20, maxLineLength: 40, availableWidth: 60 });
    expect(width).toBe(30);
    expect(width).toBeLessThan(60);
  });

  it("linha muito curta respeita a largura mínima", () => {
    const width = minimapBarWidth({ lineLength: 1, maxLineLength: 400, availableWidth: 60 });
    expect(width).toBe(MINIMAP_BAR_MIN_WIDTH);
  });

  it("nunca ultrapassa a largura disponível", () => {
    expect(minimapBarWidth({ lineLength: 100, maxLineLength: 40, availableWidth: 60 })).toBe(60);
    expect(minimapBarWidth({ lineLength: 10, maxLineLength: 0, availableWidth: 0 })).toBe(0);
  });
});

describe("minimapLineAtY — clique/hover mapeiam para a linha certa", () => {
  const lineCount = 1000;
  const rowPitch = 3;

  it("clique no topo vai para a primeira linha", () => {
    expect(minimapLineAtY({ y: 0, rowPitch, firstLine: 0, lineCount })).toBe(0);
    expect(minimapLineAtY({ y: 2, rowPitch, firstLine: 0, lineCount })).toBe(0);
  });

  it("clique no meio vai para a linha correspondente", () => {
    expect(minimapLineAtY({ y: 30, rowPitch, firstLine: 0, lineCount })).toBe(10);
    expect(minimapLineAtY({ y: 301, rowPitch, firstLine: 0, lineCount })).toBe(100);
  });

  it("clique no fim não passa do documento", () => {
    expect(minimapLineAtY({ y: 99_999, rowPitch, firstLine: 0, lineCount })).toBe(lineCount - 1);
  });

  it("com janela de corte, o clique é relativo ao início da janela", () => {
    expect(minimapLineAtY({ y: 0, rowPitch, firstLine: 500, lineCount })).toBe(500);
    expect(minimapLineAtY({ y: 30, rowPitch, firstLine: 500, lineCount })).toBe(510);
  });

  it("documento vazio ⇒ 0 (sem exceção)", () => {
    expect(minimapLineAtY({ y: 10, rowPitch, firstLine: 0, lineCount: 0 })).toBe(0);
  });
});

describe("minimapViewportRect — realce da viewport", () => {
  it("posiciona o realce na linha inicial da viewport", () => {
    const rect = minimapViewportRect({
      scrollLine: 10,
      visibleLineCount: 20,
      rowPitch: 3,
      firstLine: 0,
      visibleLines: 220,
      height: 660,
    });
    expect(rect.y).toBe(30);
    expect(rect.height).toBe(60);
  });

  it("recorta o realce quando a viewport passa do fim da faixa", () => {
    const rect = minimapViewportRect({
      scrollLine: 200,
      visibleLineCount: 40,
      rowPitch: 3,
      firstLine: 0,
      visibleLines: 220,
      height: 660,
    });
    expect(rect.y).toBe(600);
    expect(rect.height).toBe(60); // 660 - 600
  });

  it("viewport fora da janela desenhada ⇒ sem realce", () => {
    const rect = minimapViewportRect({
      scrollLine: 5_000,
      visibleLineCount: 20,
      rowPitch: 3,
      firstLine: 0,
      visibleLines: 220,
      height: 660,
    });
    expect(rect.height).toBe(0);
  });
});

describe("computeMinimapWindow — a janela desenhada é o range visível", () => {
  it("a janela é o range visível do editor (o mesmo que o HighlightStore cobre)", () => {
    const win = computeMinimapWindow({ scrollLine: 120, visibleLineCount: 38, lineCount: 10_000 });
    expect(win.firstLine).toBe(120);
    expect(win.count).toBe(38);
  });

  it("no fim do documento a janela é recortada", () => {
    const win = computeMinimapWindow({ scrollLine: 995, visibleLineCount: 38, lineCount: 1_000 });
    expect(win.firstLine).toBe(995);
    expect(win.count).toBe(5);
  });

  it("scroll além do fim ⇒ primeira linha válida", () => {
    const win = computeMinimapWindow({ scrollLine: 9_999, visibleLineCount: 38, lineCount: 1_000 });
    expect(win.firstLine).toBe(999);
    expect(win.count).toBe(1);
  });

  it("documento vazio ⇒ janela vazia", () => {
    const win = computeMinimapWindow({ scrollLine: 0, visibleLineCount: 38, lineCount: 0 });
    expect(win.firstLine).toBe(0);
    expect(win.count).toBe(0);
  });
});

describe("computeMinimapLayout — teto de linhas (maxLines)", () => {
  it("a janela é cortada no range visível, mesmo cabendo mais na faixa", () => {
    const layout = computeMinimapLayout({
      viewportHeight: 660,
      lineCount: 10_000,
      firstLine: 120,
      maxLines: 38,
    });
    expect(layout.visibleLines).toBe(38);
    expect(layout.firstLine).toBe(120);
    // O documento é maior ⇒ continua sinalizando o corte.
    expect(layout.truncated).toBe(true);
  });

  it("a faixa continua mandando (maxLines maior que a capacidade)", () => {
    const layout = computeMinimapLayout({
      viewportHeight: 60,
      lineCount: 10_000,
      firstLine: 0,
      maxLines: 500,
    });
    expect(layout.visibleLines).toBe(20); // 60 / 3
  });
});
