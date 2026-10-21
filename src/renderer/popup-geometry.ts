/**
 * Scribe — geometria dos popups da casca (clamp).
 *
 * Os popups (completação, ajuda de assinatura, escolha de snippet, hover) são posicionados
 * perto do caret — mas perto da **borda** da janela eles saíam da tela: a escolha de snippet
 * abria em `x=1410..1570` numa janela de 1280px (290px cortados).
 *
 * Aqui mora o **clamp** em funções **puras** (sem DOM), testáveis no ambiente de teste do
 * projeto (Node, sem jsdom). A parte que mede o elemento e o host fica em
 * `clampPopupElement()` — ela só roda no renderer.
 */

/** Largura/altura (px) de uma caixa. */
export interface Box {
  readonly width: number;
  readonly height: number;
}

/** Coordenada (px). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Opções de posicionamento de um popup. */
export interface PopupPlacement {
  /** Deslocamento em relação à âncora (o popup abre um pouco à direita/abaixo do caret). */
  readonly offset?: number;
  /** Margem mínima entre o popup e a borda da área visível. */
  readonly padding?: number;
}

/** Margem padrão entre o popup e a borda da área visível (a do hover tooltip). */
export const POPUP_PADDING = 12;

/**
 * Limita a posição do popup para que ele caiba **inteiro** na área visível.
 *
 * - A posição desejada é a âncora deslocada por `offset`.
 * - O popup nunca fica a menos de `padding` da borda (nem à esquerda nem acima).
 * - Se o popup for maior que a área visível, ele encosta no `padding` (o excedente é
 *   recortado pelo `overflow` do host — melhor do que sumir fora da tela).
 */
export function clampPopupPosition(
  anchor: Point,
  size: Box,
  viewport: Box,
  placement: PopupPlacement = {},
): Point {
  const offset = placement.offset ?? 0;
  const padding = placement.padding ?? POPUP_PADDING;
  return {
    x: clampAxis(anchor.x + offset, size.width, viewport.width, padding),
    y: clampAxis(anchor.y + offset, size.height, viewport.height, padding),
  };
}

/**
 * Limita um eixo: `[padding, viewport - extent - padding]`, com o mínimo valendo `padding`.
 */
function clampAxis(desired: number, extent: number, viewportExtent: number, padding: number): number {
  const upper = Math.max(padding, viewportExtent - extent - padding);
  return Math.min(Math.max(desired, padding), upper);
}

/**
 * Aplica o clamp a um popup **já visível** no DOM (o `getBoundingClientRect()` de um
 * elemento `hidden` devolve 0×0 — meça só depois de `hidden = false`).
 *
 * A área de referência é a **janela** para popups `position: fixed` e o **host posicionado**
 * (`#ui-overlay`) para popups `position: absolute` — as coordenadas da âncora estão no
 * mesmo espaço do que as do popup.
 */
export function clampPopupElement(
  element: HTMLElement,
  anchor: Point,
  placement: PopupPlacement = {},
): Point {
  const rect = element.getBoundingClientRect();
  return clampPopupPosition(
    anchor,
    { width: rect.width, height: rect.height },
    visibleArea(element),
    placement,
  );
}

/**
 * Área visível de referência do popup: a janela (fixo) ou o host posicionado (absoluto).
 */
function visibleArea(element: HTMLElement): Box {
  if (window.getComputedStyle(element).position === "fixed") {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  const parent = element.offsetParent;
  if (parent instanceof HTMLElement) {
    const rect = parent.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}
