/**
 * Scribe — widget de hover tooltip (LSP).
 *
 * Overlay DOM `position: fixed` que exibe o conteúdo markdown do hover LSP
 * próximo da posição do mouse. Auto-esconde no próximo mouse move ou keypress.
 * Segue o mesmo padrão de `completions.ts`.
 */

export interface HoverTooltipBinding {
  show(contents: readonly string[], x: number, y: number): void;
  hide(): void;
  dispose(): void;
}

/**
 * Escapa HTML básico para evitar injeção no tooltip.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Formatação markdown bem simples: `code`, **bold**, linhas.
 * Suficiente para o que os servidores LSP costumam devolver.
 */
function formatMarkdown(text: string): string {
  // Escapa HTML primeiro
  let result = escapeHtml(text);
  // `code` inline
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  // **bold**
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // *italic*
  result = result.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Quebras de linha -> <br>
  result = result.replace(/\n/g, "<br>");
  return result;
}

export function createHoverTooltip(): HoverTooltipBinding {
  const tooltip = document.getElementById("hover-tooltip");
  if (!tooltip) {
    throw new Error("Scribe: #hover-tooltip não encontrado no DOM");
  }

  const body = tooltip.querySelector(".hover-body");
  if (!body) {
    throw new Error("Scribe: .hover-body não encontrado dentro de #hover-tooltip");
  }

  // Narrowed references
  const tooltipEl = tooltip as HTMLElement;
  const bodyEl = body as HTMLElement;

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let isShown = false;

  function show(contents: readonly string[], x: number, y: number): void {
    // Renderiza conteúdo
    bodyEl.replaceChildren();
    for (const line of contents) {
      const p = document.createElement("p");
      p.className = "hover-content-line";
      p.innerHTML = formatMarkdown(line);
      bodyEl.appendChild(p);
    }

    // Posiciona: tenta ficar abaixo/à direita do cursor, mas sem sair da janela
    const padding = 12;
    const maxX = window.innerWidth - tooltipEl.offsetWidth - padding;
    const maxY = window.innerHeight - tooltipEl.offsetHeight - padding;
    tooltipEl.style.left = `${Math.min(x + padding, Math.max(padding, maxX))}px`;
    tooltipEl.style.top = `${Math.min(y + padding, Math.max(padding, maxY))}px`;
    tooltipEl.hidden = false;
    isShown = true;

    // Auto-hide depois de 8 segundos
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hide();
    }, 8000);
  }

  function hide(): void {
    if (!isShown) return;
    tooltipEl.hidden = true;
    isShown = false;
    clearTimeout(hideTimer);
    hideTimer = undefined;
    bodyEl.replaceChildren();
  }

  function dispose(): void {
    hide();
    document.removeEventListener("mousemove", onUserInput);
    document.removeEventListener("keydown", onUserInput);
  }

  function onUserInput(): void {
    if (isShown) {
      hide();
    }
  }

  // Auto-esconde em qualquer mouse move ou keypress
  document.addEventListener("mousemove", onUserInput, { passive: true });
  document.addEventListener("keydown", onUserInput, { passive: true });

  return { show, hide, dispose };
}