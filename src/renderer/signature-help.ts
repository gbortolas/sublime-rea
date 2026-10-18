/**
 * Scribe — popup de signature help (LSP).
 *
 * Overlay DOM que mostra assinaturas de função quando o usuário digita `(`.
 * Navegação entre assinaturas com setas, fecha com Escape.
 */
import type { LspSignatureHelp } from "../shared";

export interface SignatureHelpBinding {
  readonly isOpen: boolean;
  show(help: LspSignatureHelp, x: number, y: number): void;
  close(): void;
  dispose(): void;
}

export function createSignatureHelp(): SignatureHelpBinding {
  let isOpenValue = false;

  const popup = document.getElementById("signature-popup");
  if (!popup) {
    throw new Error("Scribe: #signature-popup não encontrado no DOM");
  }

  const sigBody = popup.querySelector(".signature-body");
  if (!sigBody) {
    throw new Error("Scribe: .signature-body não encontrado dentro de #signature-popup");
  }

  const popupEl = popup as HTMLElement;
  const bodyEl = sigBody as HTMLElement;

  function show(help: LspSignatureHelp, x: number, y: number): void {
    isOpenValue = true;
    bodyEl.replaceChildren();

    const sig = help.signatures[help.activeSignature];
    if (sig !== undefined) {
      // Nome da função (label)
      const labelEl = document.createElement("div");
      labelEl.className = "signature-label";
      labelEl.textContent = sig.label;
      bodyEl.appendChild(labelEl);

      // Documentação
      if (sig.documentation !== undefined && sig.documentation.length > 0) {
        const docEl = document.createElement("div");
        docEl.className = "signature-doc";
        // Formatação markdown básica
        const doc = sig.documentation
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\n/g, "<br>");
        docEl.innerHTML = doc;
        bodyEl.appendChild(docEl);
      }

      // Parâmetros
      const params = sig.parameters;
      if (params !== undefined && params.length > 0) {
        const paramsList = document.createElement("div");
        paramsList.className = "signature-params";
        for (let i = 0; i < params.length; i++) {
          const p = params[i]!;
          const pEl = document.createElement("span");
          pEl.className = `signature-param${i === help.activeParameter ? " active" : ""}`;
          pEl.textContent = p.label;
          paramsList.appendChild(pEl);
          if (i < params.length - 1) {
            const sep = document.createElement("span");
            sep.className = "signature-param-sep";
            sep.textContent = ", ";
            paramsList.appendChild(sep);
          }
        }
        bodyEl.appendChild(paramsList);
      }
    }

    // Contador se houver múltiplas assinaturas
    if (help.signatures.length > 1) {
      const countEl = document.createElement("div");
      countEl.className = "signature-count";
      countEl.textContent = `${help.activeSignature + 1} de ${help.signatures.length}`;
      bodyEl.appendChild(countEl);
    }

    popupEl.style.left = `${x}px`;
    popupEl.style.top = `${y}px`;
    popupEl.hidden = false;
  }

  function close(): void {
    if (!isOpenValue) return;
    popupEl.hidden = true;
    isOpenValue = false;
    bodyEl.replaceChildren();
  }

  function dispose(): void {
    close();
  }

  return {
    get isOpen(): boolean {
      return isOpenValue;
    },
    show,
    close,
    dispose,
  };
}