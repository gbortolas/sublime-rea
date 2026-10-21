/**
 * Scribe — testes da geometria dos popups (clamp).
 *
 * O ambiente de teste do projeto roda em **Node** (`environment: "node"`, sem jsdom), então o
 * DOM não é testável aqui: o que se testa é a função **pura** de clamp (`clampPopupPosition`),
 * que é a correção dos popups que saíam da janela (a escolha de snippet abria 290px para
 * fora numa janela de 1280px; a completação e a ajuda de assinatura eram cortadas na borda).
 */
import { describe, expect, it } from "vitest";

import { clampPopupPosition, POPUP_PADDING } from "../src/renderer/popup-geometry";

/** Janela de 1280×820 (o tamanho padrão da janela do Scribe). */
const VIEWPORT = { width: 1280, height: 820 };

describe("clamp de popup — posição dentro da janela", () => {
  it("um popup longe das bordas fica exatamente onde foi pedido", () => {
    const pos = clampPopupPosition(
      { x: 300, y: 200 },
      { width: 200, height: 100 },
      VIEWPORT,
    );
    expect(pos).toEqual({ x: 300, y: 200 });
  });

  it("o popup é puxado para dentro quando passa da borda direita", () => {
    // Caret em x=1410 numa janela de 1280: sem clamp, o popup (160 de largura) saía 290px.
    const pos = clampPopupPosition(
      { x: 1410, y: 200 },
      { width: 160, height: 80 },
      VIEWPORT,
    );
    expect(pos.x).toBe(1280 - 160 - POPUP_PADDING);
    expect(pos.x + 160).toBeLessThanOrEqual(1280 - POPUP_PADDING);
    expect(pos.y).toBe(200);
  });

  it("o popup é puxado para cima quando passa da borda inferior", () => {
    const pos = clampPopupPosition(
      { x: 100, y: 790 },
      { width: 200, height: 120 },
      VIEWPORT,
    );
    expect(pos.y).toBe(820 - 120 - POPUP_PADDING);
    expect(pos.y + 120).toBeLessThanOrEqual(820 - POPUP_PADDING);
  });

  it("o popup nunca fica a menos que a margem da borda", () => {
    const pos = clampPopupPosition(
      { x: -500, y: -500 },
      { width: 200, height: 100 },
      VIEWPORT,
    );
    expect(pos.x).toBe(POPUP_PADDING);
    expect(pos.y).toBe(POPUP_PADDING);
  });

  it("o deslocamento (offset) é aplicado antes do clamp", () => {
    const pos = clampPopupPosition(
      { x: 100, y: 100 },
      { width: 200, height: 100 },
      VIEWPORT,
      { offset: 12 },
    );
    expect(pos).toEqual({ x: 112, y: 112 });
  });

  it("a margem é configurável", () => {
    const pos = clampPopupPosition(
      { x: 1400, y: 900 },
      { width: 100, height: 100 },
      VIEWPORT,
      { padding: 4 },
    );
    expect(pos.x).toBe(1280 - 100 - 4);
    expect(pos.y).toBe(820 - 100 - 4);
  });

  it("um popup maior que a área visível encosta na margem (não some)", () => {
    const pos = clampPopupPosition(
      { x: 100, y: 100 },
      { width: 2000, height: 1000 },
      { width: 300, height: 200 },
    );
    expect(pos.x).toBe(POPUP_PADDING);
    expect(pos.y).toBe(POPUP_PADDING);
  });

  it("o clamp é idempotente (reaplicar não move o popup)", () => {
    const size = { width: 200, height: 100 };
    const first = clampPopupPosition({ x: 1400, y: 900 }, size, VIEWPORT);
    const second = clampPopupPosition(first, size, VIEWPORT);
    expect(second).toEqual(first);
  });
});
