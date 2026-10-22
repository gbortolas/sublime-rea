/**
 * Testes da geometria vertical do bitmap de glifo (baseline + *half-leading*).
 *
 * Contexto: o bitmap do glifo começa **no topo da faixa** (`y` do destino = `paddingTop +
 * row * lineHeight`, em `scene.ts`) ⇒ a posição vertical da tinta **dentro** do bitmap é a
 * única coisa que decide se o texto fica centrado na linha. Antes, o rasterizador usava
 * `textBaseline = "top"` e pintava na linha 0 ⇒ a tinta encostava no topo da faixa e o topo
 * das ascendentes era cortado pelo bitmap.
 *
 * `vitest` roda em `environment: "node"` (sem DOM/canvas) ⇒ aqui só a **matemática pura** é
 * testada (`computeBaselineRow`); a medição no app é feita via CDP.
 */
import { describe, expect, it } from "vitest";
import { computeBaselineRow } from "../src/renderer/main";

/**
 * Números reais medidos no Chromium headless com a fonte do app (`monospace` ⇒ Noto Sans Mono,
 * 15 px): `fontBoundingBoxAscent = 14`, `fontBoundingBoxDescent = 4` ⇒ caixa de conteúdo = 18 px;
 * `lineHeight = ceil(15 * 1.4) = 21` px.
 */
const REAL = { sizePx: 15, lineHeight: 21, ascent: 14, descent: 4 } as const;

/**
 * [OBSERVADO] no Chromium headless: a 15 px, o topo das maiúsculas (`A`/`H`/`b`/`d`/`k`) fica
 * ~12 px **acima** da baseline ⇒ com a baseline na linha 16, a tinta começa na linha 4 do
 * bitmap, ou seja ~3–4 px CSS abaixo do topo da faixa.
 */
const CAP_HEIGHT_PX = 12;

describe("computeBaselineRow — baseline dentro do bitmap", () => {
  it("15px/21px: baseline na linha 16 e bitmap de 20px (>= a altura antiga)", () => {
    const { baselineRow, bitmapHeight } = computeBaselineRow(REAL);
    expect(baselineRow).toBe(16);
    expect(bitmapHeight).toBe(20);
    // A altura histórica (ceil(sizePx * 1.3) = 20) não pode diminuir (atlas/empacotamento).
    expect(bitmapHeight).toBeGreaterThanOrEqual(Math.ceil(REAL.sizePx * 1.3));
  });

  it("a baseline fica estritamente dentro do bitmap", () => {
    const { baselineRow, bitmapHeight } = computeBaselineRow(REAL);
    expect(baselineRow).toBeGreaterThan(0);
    expect(baselineRow).toBeLessThan(bitmapHeight);
  });

  it("a caixa de conteúdo da fonte cabe inteira no bitmap (nada cortado)", () => {
    const { bitmapHeight } = computeBaselineRow(REAL);
    expect(bitmapHeight).toBeGreaterThanOrEqual(REAL.ascent + REAL.descent);
  });

  it("a tinta não encosta no topo: baseline − ascent >= 0", () => {
    const { baselineRow } = computeBaselineRow(REAL);
    expect(baselineRow - REAL.ascent).toBeGreaterThanOrEqual(0);
    // Regressão do bug: com `textBaseline = "top"` a baseline ficava na linha ~11 (< ascent 14)
    // ⇒ o topo das ascendentes saía do bitmap.
    expect(baselineRow).toBeGreaterThanOrEqual(REAL.ascent);
  });

  it("a tinta fica ~3–4px abaixo do topo da faixa (half-leading centrado)", () => {
    const { baselineRow } = computeBaselineRow(REAL);
    const inkTop = baselineRow - CAP_HEIGHT_PX;
    expect(inkTop).toBeGreaterThanOrEqual(3);
    expect(inkTop).toBeLessThanOrEqual(4);
  });
});

describe("computeBaselineRow — robustez", () => {
  it("nunca corta o topo, para qualquer tamanho de fonte", () => {
    for (const sizePx of [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 32]) {
      const lineHeight = Math.ceil(sizePx * 1.4);
      const ascent = Math.round(sizePx * 0.93);
      const descent = Math.round(sizePx * 0.27);
      const { baselineRow, bitmapHeight } = computeBaselineRow({ sizePx, lineHeight, ascent, descent });
      expect(baselineRow - ascent).toBeGreaterThanOrEqual(0);
      expect(baselineRow).toBeGreaterThan(0);
      expect(baselineRow).toBeLessThan(bitmapHeight);
      expect(bitmapHeight).toBeGreaterThanOrEqual(ascent + descent);
    }
  });

  it("linha apertada (lineHeight < caixa de conteúdo): a baseline não sobe acima da ascendente", () => {
    const { baselineRow, bitmapHeight } = computeBaselineRow({
      sizePx: 15,
      lineHeight: 10,
      ascent: 14,
      descent: 4,
    });
    expect(baselineRow).toBeGreaterThanOrEqual(14);
    expect(bitmapHeight).toBeGreaterThanOrEqual(14 + 4);
    expect(baselineRow).toBeLessThan(bitmapHeight);
  });

  it("métricas degeneradas (0/NaN) não quebram a geometria", () => {
    for (const ascent of [0, Number.NaN, -3]) {
      for (const descent of [0, Number.NaN, -1]) {
        const { baselineRow, bitmapHeight } = computeBaselineRow({
          sizePx: 15,
          lineHeight: 21,
          ascent,
          descent,
        });
        expect(Number.isFinite(baselineRow)).toBe(true);
        expect(Number.isFinite(bitmapHeight)).toBe(true);
        expect(baselineRow).toBeGreaterThan(0);
        expect(baselineRow).toBeLessThan(bitmapHeight);
        expect(bitmapHeight).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("é determinístico (mesmos números ⇒ mesma geometria)", () => {
    expect(computeBaselineRow(REAL)).toEqual(computeBaselineRow(REAL));
  });
});
