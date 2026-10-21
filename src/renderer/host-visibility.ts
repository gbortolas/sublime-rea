/**
 * Scribe — **visibilidade do host** dos painéis do renderer.
 *
 * Os painéis do renderer (Problemas, Outline, Explorer, Controle de Código e Diff) só
 * reescrevem o DOM quando estão **visíveis** (`host.hidden === false`): redesenhar a lista
 * inteira a cada evento (o Outline, a cada edição do documento) é trabalho jogado fora
 * quando ninguém está olhando.
 *
 * ⚠️ **O `update()` pode chegar ANTES de o painel ficar visível:** o `main` preenche o
 * painel e *depois* troca a seção (`update()` → `showSidebarSection()`). Por isso o painel
 * marca o DOM como **sujo** ({@link HostVisibility.markDirty}) e o
 * {@link watchHostVisibility} redesenha assim que o host ficar visível — observado com um
 * `MutationObserver` no atributo `hidden`.
 *
 * **Sem `MutationObserver`** (o DOM falso do teste, um ambiente sem DOM) o helper degrada:
 * o painel só redesenha no **próximo** `update` (com o host visível) — o estado continua
 * no modelo, então nada se perde.
 */

/** O estado de visibilidade de um painel (o que o painel consulta a cada desenho). */
export interface HostVisibility {
  /** `true` quando o host está escondido (`host.hidden`). */
  readonly hidden: boolean;
  /** Marca o DOM como **sujo** (redesenha assim que o host ficar visível). */
  markDirty(): void;
  /** O DOM está em dia (o painel foi desenhado). */
  markClean(): void;
  /** Desconecta o observador (o `dispose` do painel). */
  dispose(): void;
}

/**
 * Observa a visibilidade do `host` e redesenha o painel quando ele **aparece**.
 *
 * @param host O elemento que o chamador controla (`host.hidden`).
 * @param redraw O desenho do painel (é chamado quando o host fica visível e o DOM está sujo).
 */
export function watchHostVisibility(host: HTMLElement, redraw: () => void): HostVisibility {
  let dirty = false;
  let observer: MutationObserver | null = null;

  if (typeof MutationObserver !== "undefined") {
    observer = new MutationObserver((): void => {
      if (host.hidden === true) return;
      if (!dirty) return;
      dirty = false;
      redraw();
    });
    observer.observe(host, { attributes: true, attributeFilter: ["hidden"] });
  }

  return {
    get hidden(): boolean {
      return host.hidden === true;
    },
    markDirty(): void {
      dirty = true;
    },
    markClean(): void {
      dirty = false;
    },
    dispose(): void {
      observer?.disconnect();
      observer = null;
    },
  };
}
