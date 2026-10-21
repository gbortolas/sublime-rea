/**
 * Scribe — interface de depuração (DAP) no renderer.
 *
 * Constrói dinamicamente (sem markup estático) a **barra de ferramentas** de depuração e o
 * **painel** com a pilha de chamadas, escopos e variáveis, além do log de saída do programa.
 *
 * Desde o P4#27 o painel gained mais três partes:
 * - **Breakpoints** com **condição**, **condição de paradas** (`hitCondition`) e
 *   **mensagem de log** (`logMessage`) editáveis por breakpoint (breakpoint condicional,
 *   logpoint — o badge "log" marca os que só registram);
 * - **Observação** (watch): expressões reavaliadas a cada parada;
 * - **tooltip de valor**: mostra o valor de uma variável sob o mouse durante a parada.
 *
 * O widget é "burro": não fala com a ponte. Ele expõe uma API (`DebugViewBinding`) e emite
 * intenções (`onAction`, `onFrameSelect`, `onScopeToggle`, `onVariableToggle`,
 * `onBreakpointSpecChange`, `onWatchAdd`, …) que o `main.ts` traduz para chamadas IPC.
 */
import {
  applyBreakpointFieldToList,
  isLogpointSpec,
  MAX_BREAKPOINT_FIELD_LENGTH,
  type DapBreakpointField,
  type DapBreakpointSpec,
  type DapScope,
  type DapSessionState,
  type DapStackFrame,
  type DapVariable,
} from "../shared";

/**
 * Uma linha de breakpoint do painel.
 *
 * A linha é **persistente**: os três campos (condição, condição de paradas e mensagem de
 * log) nascem uma vez e são reaproveitados — é o que impede a perda de foco (e do cursor)
 * a cada `render()`.
 */
interface BreakpointRow {
  /** Contêiner da linha (cabeçalho + campos). */
  readonly element: HTMLElement;
  /** Badge de logpoint (visível só quando o breakpoint é um logpoint). */
  readonly badge: HTMLElement;
  /** Campo da condição (o breakpoint só para quando ela é verdadeira). */
  readonly conditionInput: HTMLInputElement;
  /** Campo da condição de paradas (só para na Nª ocorrência). */
  readonly hitConditionInput: HTMLInputElement;
  /** Campo da mensagem de log (logpoint: registra em vez de parar). */
  readonly logMessageInput: HTMLInputElement;
}

/** Ações da barra de ferramentas de depuração. */
export type DebugAction =
  | "start"
  | "continue"
  | "pause"
  | "stepOver"
  | "stepInto"
  | "stepOut"
  | "stop";

export interface DebugViewBinding {
  readonly isOpen: boolean;
  /** Atualiza o estado da sessão (habilita/desabilita botões e a visibilidade). */
  setState(state: DapSessionState): void;
  /** Mostra a parada atual (thread + pilha de chamadas). */
  showStopped(threadId: number | undefined, frames: readonly DapStackFrame[]): void;
  /** Preenche os escopos de um frame (disparado ao selecionar o frame). */
  setScopes(frameId: number, scopes: readonly DapScope[]): void;
  /** Preenche as variáveis de um escopo (ou de um nó expandido). */
  setVariables(reference: number, variables: readonly DapVariable[]): void;
  /** Limpa o estado de parada (ao continuar/encerrar). */
  clearStop(): void;
  /** Anexa uma linha à saída do programa. */
  appendOutput(category: string, text: string): void;
  /** Atualiza o contador de breakpoints exibido na barra. */
  setBreakpointCount(count: number): void;
  /** Lista os breakpoints do arquivo (com a condição de cada um). */
  setBreakpointSpecs(specs: readonly DapBreakpointSpec[], documentKey?: string): void;
  /**
   * Um campo do breakpoint foi editado (condição, condição de paradas ou log).
   *
   * O painel entrega a spec **inteira** (o campo editado + os demais, preservados): o
   * `main.ts` é a fonte da verdade e reenvia a lista completa ao adaptador.
   */
  onBreakpointSpecChange(callback: (line: number, spec: DapBreakpointSpec) => void): void;
  /**
   * A condição de um breakpoint foi editada pelo usuário.
   *
   * @deprecated Use {@link DebugViewBinding.onBreakpointSpecChange} — este gancho só
   * carrega a `condition` (e só é chamado quando o gancho novo **não** está registrado).
   */
  onBreakpointConditionChange(callback: (line: number, condition: string) => void): void;
  /** O usuário pediu a remoção de um breakpoint. */
  onBreakpointRemove(callback: (line: number) => void): void;
  /** Define as expressões de observação (watch). */
  setWatchExpressions(expressions: readonly string[]): void;
  /** Atualiza os valores avaliados das expressões de observação. */
  setWatchValues(values: ReadonlyMap<string, string>): void;
  /** O usuário cadastrou uma expressão de observação. */
  onWatchAdd(callback: (expression: string) => void): void;
  /** O usuário removeu uma expressão de observação. */
  onWatchRemove(callback: (expression: string) => void): void;
  /** O usuário pediu a reavaliação das expressões de observação. */
  onWatchRefresh(callback: () => void): void;
  /** Mostra o valor de uma variável sob o mouse (hover de depuração). */
  showDebugValue(text: string, x: number, y: number): void;
  /** Esconde o tooltip de valor. */
  hideDebugValue(): void;
  onAction(callback: (action: DebugAction) => void): void;
  onFrameSelect(callback: (frame: DapStackFrame) => void): void;
  /** Pedido de escopos de um frame (quando ele é selecionado). */
  onScopesRequest(callback: (frame: DapStackFrame) => void): void;
  /** Pedido de variáveis de um nó (escopo ou variável expansível). */
  onVariablesRequest(callback: (reference: number) => void): void;
  open(): void;
  close(): void;
  dispose(): void;
  /**
   * Notifica a **mudança de visibilidade** do painel (abriu/fechou).
   *
   * O renderer usa isto para sincronizar o minimap (que divide a faixa direita com o
   * painel) e recalcular o wrap do texto. É um **evento**, e não um gancho por frame:
   * um gancho por frame que marcasse o layout como sujo realimentava o próprio frame
   * (loop de layout) e travava o renderer.
   */
  onVisibilityChange(callback: (open: boolean) => void): void;
}

const FRAME_ICON_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6.5 3.5l3.5 4.5-3.5 4.5"/></svg>';

const CHEVRON_RIGHT =
  '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 4l4 4-4 4"/></svg>';

const CHEVRON_DOWN =
  '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 6l4 4 4-4"/></svg>';

/**
 * Monta um ícone **SVG inline** no padrão do repo (viewBox 16×16, `currentColor`, `fill:none`).
 *
 * Antes o painel usava glifos Unicode (triângulo de play, pausa, setas de passo, quadrado de
 * stop,times, mais e refresh) — eles caíam numa **fonte de fallback** do sistema (o "glifo
 * estranho" reportado). SVG inline herda a cor do tema e escala com o zoom, sem depender de
 * nenhuma fonte instalada.
 */
function icon(body: string, size = 14): string {
  return (
    `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    body +
    `</svg>`
  );
}

/** Iniciar / continuar. */
const ICON_PLAY = icon('<path d="M5.6 3.6 12.4 8l-6.8 4.4z"/>');
/** Pausar. */
const ICON_PAUSE = icon('<path d="M6.3 3.8v8.4M9.7 3.8v8.4"/>');
/** Passo por cima: reta para a direita que **desce** em curva. */
const ICON_STEP_OVER = icon('<path d="M2.8 4.4h5a2.6 2.6 0 0 1 0 5.2"/><path d="M6.6 8 7.8 9.6 9 8"/>');
/** Passo para dentro: reta para **baixo** que vira para a direita. */
const ICON_STEP_INTO = icon('<path d="M8 2.6v6h5.2"/><path d="M11.4 6.8 13.4 8.6 11.4 10.4"/>');
/** Passo para fora: reta para a direita que **sobe** em curva. */
const ICON_STEP_OUT = icon('<path d="M2.8 11.6h5a2.6 2.6 0 0 0 0-5.2"/><path d="M6.6 8 7.8 6.4 9 8"/>');
/** Encerrar. */
const ICON_STOP = icon('<rect x="4.3" y="4.3" width="7.4" height="7.4" rx="1.2"/>');
/** Fechar (painel). */
const ICON_CLOSE = icon('<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>');
/** Fechar / remover (linhas). */
const ICON_CLOSE_SMALL = icon('<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>', 12);
/** Adicionar expressão de observação. */
const ICON_PLUS = icon('<path d="M8 3.4v9.2M3.4 8h9.2"/>', 12);
/** Reavaliar expressões de observação. */
const ICON_REFRESH = icon(
  '<path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33"/>' +
  '<path d="M14 2v3.33h-3.33"/>',
  12,
);
/** Separador / valor ausente. */
const ICON_DASH = icon('<path d="M4 8h8"/>', 12);
/**
 * Logpoint: balão de fala (o badge "log" da linha do breakpoint).
 *
 * Ícone **SVG inline** (nada de glifo Unicode): o balão diz "isto aqui é uma mensagem",
 * não uma parada.
 */
const ICON_LOG = icon('<path d="M3 4.4h10v5.3H7.5L4.3 12.3V9.7H3z"/>', 11);

/**
 * Alterna a visibilidade de um painel.
 *
 * `hidden` é a **única fonte da verdade**: o atributo é colocado/removido e o CSS global
 * (`[hidden]{display:none!important}`) vence o `display:flex` inline do painel — sem isso o
 * painel aparecia no boot. O `display` inline não é alternado aqui.
 */
function setVisible(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

/** Cria a interface de depuração (barra + painel) e injeta no `#ui-overlay`. */
export function createDebugView(): DebugViewBinding {
  let isOpenValue = false;
  let state: DapSessionState = "inactive";
  let frames: readonly DapStackFrame[] = [];
  let selectedFrameIndex = 0;
  let breakpointCount = 0;

  const scopesByFrame = new Map<number, readonly DapScope[]>();
  const variablesByRef = new Map<number, readonly DapVariable[]>();
  const expandedRefs = new Set<number>();

  /** Breakpoints do arquivo exibido (com condição, condição de paradas e log). */
  let breakpointSpecs: readonly DapBreakpointSpec[] = [];
  /** Documento cuja lista de breakpoints está no painel (o painel segue o documento ativo). */
  let breakpointDocumentKey: string | undefined;
  /** Linhas de breakpoint → linha da UI (**persistentes**: os inputs não perdem o foco). */
  const breakpointRows = new Map<number, BreakpointRow>();
  /** Linhas na ordem em que estão no DOM (evita mexer no DOM quando nada mudou). */
  let renderedBreakpointLines: number[] = [];

  /** Expressões de observação e seus últimos valores avaliados. */
  let watchExpressions: readonly string[] = [];
  let watchValues = new Map<string, string>();

  let onAction: ((action: DebugAction) => void) | undefined;
  let onFrameSelect: ((frame: DapStackFrame) => void) | undefined;
  /** Notificado quando o painel abre/fecha (o renderer sincroniza o minimap com ele). */
  let visibilityCallback: ((open: boolean) => void) | undefined;

  function notifyVisibility(): void {
    visibilityCallback?.(isOpenValue);
  }
  let onScopesRequest: ((frame: DapStackFrame) => void) | undefined;
  let onVariablesRequest: ((reference: number) => void) | undefined;
  let onBreakpointSpecChange: ((line: number, spec: DapBreakpointSpec) => void) | undefined;
  let onBreakpointConditionChange: ((line: number, condition: string) => void) | undefined;
  let onBreakpointRemove: ((line: number) => void) | undefined;
  let onWatchAdd: ((expression: string) => void) | undefined;
  let onWatchRemove: ((expression: string) => void) | undefined;
  let onWatchRefresh: (() => void) | undefined;

  const overlay = document.getElementById("ui-overlay");

  // ── Barra de ferramentas ──────────────────────────────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.id = "debug-toolbar";
  toolbar.className = "scribe-panel";
  toolbar.role = "toolbar";
  toolbar.setAttribute("aria-label", "Depuração");
  toolbar.hidden = true;
  toolbar.style.cssText = [
    "position: absolute;",
    // O `top` vem do CSS (`#debug-toolbar`): a barra desce para debaixo da find bar
    // quando ela está aberta (aqui ela ficava no mesmo canto e cobria o "×" da busca).
    // Canto direito da área de texto, à direita do minimap (mesma convenção do find bar).
    "right: calc(var(--s-minimap-w) + 12px);",
    "display: flex;",
    "align-items: center;",
    "gap: 4px;",
    "padding: 4px 6px;",
    "background: var(--s-statusbar);",
    "border: 1px solid var(--s-border);",
    "border-radius: 6px;",
    "box-shadow: var(--s-shadow);",
    "z-index: var(--z-toolbar);",
    "font-family: inherit;",
    "font-size: 12px;",
    "color: var(--s-fg);",
    // O pai (`#ui-overlay`) é `pointer-events:none` — sem isto a barra é inerte.
    "pointer-events: auto;",
  ].join(" ");
  setVisible(toolbar, false);

  const stateLabel = document.createElement("span");
  stateLabel.style.cssText = [
    "padding: 0 6px;",
    "font-weight: 600;",
    "color: var(--s-accent);",
    "text-transform: lowercase;",
  ].join(" ");
  toolbar.appendChild(stateLabel);

  const buttons: { action: DebugAction; icon: string; title: string; id: string }[] = [
    { action: "continue", icon: ICON_PLAY, title: "Continuar (F5)", id: "debug-continue" },
    { action: "pause", icon: ICON_PAUSE, title: "Pausar", id: "debug-pause" },
    { action: "stepOver", icon: ICON_STEP_OVER, title: "Passo por cima (F10)", id: "debug-step-over" },
    { action: "stepInto", icon: ICON_STEP_INTO, title: "Passo para dentro (F11)", id: "debug-step-into" },
    { action: "stepOut", icon: ICON_STEP_OUT, title: "Passo para fora (Shift+F11)", id: "debug-step-out" },
    { action: "stop", icon: ICON_STOP, title: "Encerrar (Shift+F5)", id: "debug-stop" },
  ];
  const buttonById = new Map<string, HTMLButtonElement>();
  for (const spec of buttons) {
    const button = document.createElement("button");
    button.id = spec.id;
    button.type = "button";
    button.innerHTML = spec.icon;
    button.title = spec.title;
    button.setAttribute("aria-label", spec.title);
    button.style.cssText = [
      "min-width: 24px;",
      "height: 22px;",
      "display: inline-flex;",
      "align-items: center;",
      "justify-content: center;",
      "padding: 0 3px;",
      "border: none;",
      "border-radius: 4px;",
      "background: transparent;",
      "color: inherit;",
      "cursor: pointer;",
      "line-height: 1;",
    ].join(" ");
    button.addEventListener("click", () => onAction?.(spec.action));
    buttonById.set(spec.id, button);
    toolbar.appendChild(button);
  }
  overlay?.appendChild(toolbar);

  // ── Painel ────────────────────────────────────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.id = "debug-panel";
  panel.className = "scribe-panel";
  panel.role = "complementary";
  panel.setAttribute("aria-label", "Depuração — pilha e variáveis");
  panel.hidden = true;
  panel.style.cssText = [
    "position: absolute;",
    // O `top` vem do CSS (`#debug-panel`): logo abaixo da barra de ferramentas, que por
    // sua vez desce para debaixo da find bar quando ela está aberta.
    // Canto direito da área de texto, à direita do minimap (mesma convenção do find bar).
    "right: calc(var(--s-minimap-w) + 12px);",
    "width: 340px;",
    "max-height: 62vh;",
    "display: flex;",
    "flex-direction: column;",
    "background: var(--s-sidebar);",
    "border: 1px solid var(--s-border);",
    "border-radius: 6px;",
    "box-shadow: var(--s-shadow);",
    "z-index: var(--z-panel);",
    "color: var(--s-fg);",
    "font-family: inherit;",
    "font-size: 12px;",
    // O conteúdo grande rola **dentro** do painel (o corpo tem `overflow-y:auto`).
    "overflow: hidden;",
    // O pai (`#ui-overlay`) é `pointer-events:none` — sem isto o painel é inerte.
    "pointer-events: auto;",
  ].join(" ");
  setVisible(panel, false);

  /**
   * Recalcula o recuo à direita da barra e do painel.
   *
   * A faixa da direita é disputada pelo **minimap** (`--s-minimap-w`, 72px). Com o painel de
   * depuração aberto o `main.ts` esconde o minimap (`applyMinimapVisibility`) — a faixa fica
   * livre e os painéis encostam na borda; com o minimap visível (painel fechado, sessão ativa)
   * eles ficam à **direita** dele, como o find bar.
   */
  function applyRightOffset(): void {
    const offset = isOpenValue ? "12px" : "calc(var(--s-minimap-w) + 12px)";
    toolbar.style.right = offset;
    panel.style.right = offset;
  }
  applyRightOffset();

  const header = document.createElement("div");
  header.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "justify-content: space-between;",
    "padding: 6px 8px;",
    "border-bottom: 1px solid var(--s-border);",
    "font-weight: 600;",
  ].join(" ");
  header.textContent = "Depuração";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.id = "debug-close";
  closeButton.innerHTML = ICON_CLOSE;
  closeButton.title = "Fechar painel";
  closeButton.setAttribute("aria-label", "Fechar painel");
  closeButton.style.cssText = [
    "display: inline-flex;",
    "align-items: center;",
    "justify-content: center;",
    "width: 20px;",
    "height: 20px;",
    "padding: 0;",
    "border: none;",
    "background: transparent;",
    "color: inherit;",
    "cursor: pointer;",
    "line-height: 1;",
  ].join(" ");
  closeButton.addEventListener("click", () => closePanel());
  header.appendChild(closeButton);
  panel.appendChild(header);

  const body = document.createElement("div");
  body.style.cssText = "overflow-y: auto; padding: 4px 0; flex: 1;";

  /**
   * Hosts persistentes: cada seção é reconstruída **dentro** do seu host, e os campos de
   * entrada (condição do breakpoint, expressão de observação) vivem em hosts que **nunca**
   * são reconstruídos — assim o foco não se perde a cada `render()`.
   */
  const stackHost = document.createElement("div");
  const varsHost = document.createElement("div");
  const watchControlsHost = document.createElement("div");
  const watchListHost = document.createElement("div");
  const bpHost = document.createElement("div");
  /**
   * Rótulo da seção de breakpoints (**persistente** — só o texto muda).
   */
  const bpSectionLabel = sectionLabel("Breakpoints");
  /**
   * Container das linhas de breakpoint (**persistente** — as linhas é que entram/saem).
   */
  const bpRowsHost = document.createElement("div");
  bpHost.append(bpSectionLabel, bpRowsHost);
  const outHost = document.createElement("div");
  body.append(stackHost, varsHost, watchControlsHost, watchListHost, bpHost, outHost);
  panel.appendChild(body);

  overlay?.appendChild(panel);

  // ── Tooltip de valor (hover de depuração) ─────────────────────────────────────────────────
  const valueTip = document.createElement("div");
  valueTip.id = "debug-value-tooltip";
  valueTip.role = "tooltip";
  valueTip.hidden = true;
  valueTip.style.cssText = [
    "position: fixed;",
    "z-index: var(--z-tooltip);",
    "max-width: 320px;",
    "padding: 4px 8px;",
    "background: var(--s-editor);",
    "border: 1px solid var(--s-border);",
    "border-radius: 4px;",
    "box-shadow: var(--s-shadow);",
    "color: var(--s-fg);",
    "font-family: var(--s-font-mono);",
    "font-size: 11px;",
    "pointer-events: none;",
    "white-space: pre-wrap;",
  ].join(" ");
  overlay?.appendChild(valueTip);
  setVisible(valueTip, false);

  // ── Helpers de render ─────────────────────────────────────────────────────────────────────
  function sectionLabel(text: string): HTMLElement {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = [
      "padding: 4px 10px 2px;",
      "font-size: 10px;",
      "letter-spacing: .08em;",
      "text-transform: uppercase;",
      "color: var(--s-fg-muted);",
    ].join(" ");
    return el;
  }

  function row(indent: number, expandable: boolean, expanded: boolean, main: string, secondary?: string): HTMLElement {
    const el = document.createElement("div");
    el.style.cssText = [
      "display: flex;",
      "align-items: center;",
      "gap: 4px;",
      `padding: 2px 10px 2px ${10 + indent * 14}px;`,
      "cursor: pointer;",
      "white-space: nowrap;",
      "overflow: hidden;",
    ].join(" ");
    if (expandable) {
      const chevron = document.createElement("span");
      chevron.innerHTML = expanded ? CHEVRON_DOWN : CHEVRON_RIGHT;
      chevron.style.cssText = "flex-shrink: 0; opacity: .8; display: inline-flex;";
      el.appendChild(chevron);
    } else {
      const spacer = document.createElement("span");
      spacer.style.cssText = "width: 10px; flex-shrink: 0;";
      el.appendChild(spacer);
    }
    const nameSpan = document.createElement("span");
    nameSpan.textContent = main;
    nameSpan.style.cssText = "overflow: hidden; text-overflow: ellipsis;";
    el.appendChild(nameSpan);
    if (secondary !== undefined) {
      const secSpan = document.createElement("span");
      secSpan.textContent = secondary;
      secSpan.style.cssText = [
        "color: var(--s-accent);",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "flex: 1;",
      ].join(" ");
      el.appendChild(secSpan);
    }
    return el;
  }

  function frameLabel(frame: DapStackFrame): string {
    const file = frame.path !== undefined ? frame.path.slice(frame.path.lastIndexOf("/") + 1) : "";
    return file.length > 0 ? `${frame.name}  ${file}:${frame.line}` : `${frame.name}`;
  }

  function renderVariables(parent: HTMLElement, variables: readonly DapVariable[], indent: number): void {
    for (const variable of variables) {
      const expandable = variable.variablesReference > 0;
      const expanded = expandedRefs.has(variable.variablesReference);
      const value = variable.type !== undefined && variable.type.length > 0
        ? `${variable.value}  : ${variable.type}`
        : variable.value;
      const el = row(indent, expandable, expanded, variable.name, value);
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!expandable) return;
        if (expanded) {
          expandedRefs.delete(variable.variablesReference);
          variablesByRef.delete(variable.variablesReference);
          render();
          return;
        }
        expandedRefs.add(variable.variablesReference);
        render();
        onVariablesRequest?.(variable.variablesReference);
      });
      parent.appendChild(el);
      if (expandable && expanded) {
        const children = variablesByRef.get(variable.variablesReference);
        if (children !== undefined) {
          renderVariables(parent, children, indent + 1);
        }
      }
    }
  }

  // ── Breakpoints (condição · condição de paradas · log) ───────────────────────────────────

  /**
   * Desenha a lista de breakpoints.
   *
   * O DOM só é mexido quando o **conjunto de linhas** muda (um breakpoint foi
   * adicionado/removido) — nesse caso, reordenar é inevitável. Quando só os **valores**
   * mudam (o usuário editou um campo), os inputs são atualizados no lugar: o campo em
   * edição **não** é tocado (o cursor não salta) e o foco não se perde.
   */
  function renderBreakpoints(): void {
    const lines = breakpointSpecs.map((spec) => spec.line);
    const orderChanged =
      lines.length !== renderedBreakpointLines.length ||
      lines.some((line, index) => line !== renderedBreakpointLines[index]);

    if (orderChanged) {
      renderedBreakpointLines = lines;
      // Linhas que sumiram: a row (e seus inputs) saem do mapa — sem isso o input velho
      // (com a condição antiga) seria reusado quando a mesma linha voltasse a ter
      // breakpoint.
      const live = new Set(lines);
      for (const [line, row] of [...breakpointRows]) {
        if (live.has(line)) continue;
        row.element.remove();
        breakpointRows.delete(line);
      }
      // Coloca as linhas na ordem das specs (reaproveitando as rows existentes).
      lines.forEach((line, index) => {
        const row = getBreakpointRow(line);
        const current = bpRowsHost.children[index];
        if (current === row.element) return;
        bpRowsHost.insertBefore(row.element, current ?? null);
      });
    }

    bpSectionLabel.textContent = `Breakpoints (${breakpointSpecs.length})`;
    setVisible(bpSectionLabel, breakpointSpecs.length > 0);

    for (const spec of breakpointSpecs) {
      const row = breakpointRows.get(spec.line);
      if (row === undefined) continue;
      setFieldValue(row.conditionInput, spec.condition ?? "");
      setFieldValue(row.hitConditionInput, spec.hitCondition ?? "");
      setFieldValue(row.logMessageInput, spec.logMessage ?? "");
      // Logpoint = tem mensagem de log **e** não tem condição.
      setVisible(row.badge, isLogpointSpec(spec));
    }
  }

  /**
   * Linha de breakpoint da UI — **persistente**: os três campos nascem uma vez e são
   * reaproveitados (é o que impede a perda de foco a cada `render()`).
   */
  function getBreakpointRow(line: number): BreakpointRow {
    const existing = breakpointRows.get(line);
    if (existing !== undefined) return existing;

    const element = document.createElement("div");
    element.className = "debug-breakpoint";
    element.style.cssText = [
      "display: flex;",
      "flex-direction: column;",
      "gap: 3px;",
      "padding: 3px 10px 5px;",
    ].join(" ");

    // ── Cabeçalho: linha · badge de logpoint · remover ─────────────────────────────────────
    const head = document.createElement("div");
    head.style.cssText = "display: flex; align-items: center; gap: 6px;";

    const label = document.createElement("span");
    label.textContent = `linha ${line}`;
    label.style.cssText = "flex: 0 0 auto; color: var(--s-fg-muted);";
    head.appendChild(label);

    const badge = document.createElement("span");
    badge.className = "debug-logpoint-badge";
    badge.title = "logpoint — registra a mensagem em vez de parar";
    badge.setAttribute("aria-label", "logpoint");
    badge.style.cssText = [
      "flex: 0 0 auto;",
      "display: inline-flex;",
      "align-items: center;",
      "gap: 3px;",
      "padding: 0 5px;",
      "height: 15px;",
      "border: 1px solid var(--s-accent);",
      "border-radius: 8px;",
      "color: var(--s-accent);",
      "font-size: 9px;",
      "letter-spacing: .04em;",
      "line-height: 1;",
    ].join(" ");
    const badgeIcon = document.createElement("span");
    badgeIcon.innerHTML = ICON_LOG;
    badgeIcon.style.cssText = "display: inline-flex; align-items: center;";
    badge.appendChild(badgeIcon);
    const badgeText = document.createElement("span");
    badgeText.textContent = "log";
    badge.appendChild(badgeText);
    setVisible(badge, false);
    head.appendChild(badge);

    const spacer = document.createElement("span");
    spacer.style.cssText = "flex: 1 1 auto;";
    head.appendChild(spacer);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.innerHTML = ICON_CLOSE_SMALL;
    remove.title = "Remover breakpoint";
    remove.setAttribute("aria-label", "Remover breakpoint");
    remove.style.cssText = [
      "flex: 0 0 auto;",
      "display: inline-flex;",
      "align-items: center;",
      "justify-content: center;",
      "width: 18px;",
      "height: 18px;",
      "padding: 0;",
      "border: none;",
      "background: transparent;",
      "color: var(--s-fg-muted);",
      "cursor: pointer;",
      "line-height: 1;",
    ].join(" ");
    remove.addEventListener("click", () => onBreakpointRemove?.(line));
    head.appendChild(remove);

    element.appendChild(head);

    // ── Campos: condição · condição de paradas · mensagem de log ───────────────────────────
    const conditionInput = createFieldInput("condição (ex.: x > 3)", line, "condition");
    const hitConditionInput = createFieldInput("hitCondition (ex.: 3)", line, "hitCondition");
    const logMessageInput = createFieldInput(
      "mensagem de log (ex.: i = ${i})",
      line,
      "logMessage",
    );

    const fields = document.createElement("div");
    fields.style.cssText = "display: flex; align-items: center; gap: 4px;";
    fields.appendChild(conditionInput);
    element.appendChild(fields);

    const extras = document.createElement("div");
    extras.style.cssText = "display: flex; align-items: center; gap: 4px;";
    extras.appendChild(hitConditionInput);
    extras.appendChild(logMessageInput);
    element.appendChild(extras);

    const row: BreakpointRow = {
      element,
      badge,
      conditionInput,
      hitConditionInput,
      logMessageInput,
    };
    breakpointRows.set(line, row);
    return row;
  }

  /**
   * Campo editável de um breakpoint (condição, condição de paradas ou mensagem de log).
   *
   * O `maxLength` é o **teto do contrato** — o navegador recusa o excedente, e a
   * notificação trunca de novo (defesa em profundidade: o `value` pode vir colado).
   */
  function createFieldInput(
    placeholder: string,
    line: number,
    field: DapBreakpointField,
  ): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "debug-breakpoint-field";
    input.placeholder = placeholder;
    input.maxLength = MAX_BREAKPOINT_FIELD_LENGTH[field];
    input.setAttribute("aria-label", `${field} do breakpoint na linha ${line}`);
    input.style.cssText = [
      "flex: 1 1 auto;",
      "min-width: 0;",
      "height: 20px;",
      "padding: 0 6px;",
      "border: 1px solid var(--s-border);",
      "border-radius: 3px;",
      "background: var(--s-editor);",
      "color: var(--s-fg);",
      "font-family: var(--s-font-mono);",
      "font-size: 11px;",
    ].join(" ");
    input.addEventListener("change", () => {
      notifyBreakpointFieldChange(line, field, input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
    return input;
  }

  /**
   * Notifica a edição de um campo do breakpoint.
   *
   * O painel é "burro": não decide o que fazer com a spec — entrega a spec **nova**
   * (campo limpo ⇒ o campo **some** da spec; valor longo ⇒ truncado no teto do
   * contrato). O `main.ts` é a fonte da verdade e reenvia a lista ao adaptador.
   */
  function notifyBreakpointFieldChange(
    line: number,
    field: DapBreakpointField,
    rawValue: string,
  ): void {
    // A lista local passa a refletir a edição **na hora**: uma segunda edição (noutro
    // campo) não pode partir de uma spec velha e apagar a primeira edição.
    const nextList = applyBreakpointFieldToList(breakpointSpecs, line, field, rawValue);
    const next = nextList.find((candidate) => candidate.line === line);
    if (next === undefined) return;
    breakpointSpecs = nextList;
    // Redesenha (o badge de logpoint aparece já, sem esperar o `main` responder).
    renderBreakpoints();
    if (onBreakpointSpecChange !== undefined) {
      onBreakpointSpecChange(line, next);
      return;
    }
    // Compatibilidade: sem o gancho novo, só a `condition` chega ao `main.ts`.
    if (field === "condition") onBreakpointConditionChange?.(line, next.condition ?? "");
  }

  /**
   * Escreve no campo **sem** mexer no campo em edição — o cursor não pode saltar (e o
   * foco não pode se perder) enquanto o usuário digita.
   */
  function setFieldValue(input: HTMLInputElement, value: string): void {
    if (document.activeElement === input) return;
    if (input.value === value) return;
    input.value = value;
  }

  // ── Expressões de observação (watch) ───────────────────────────────────────────────────────

  const watchInput = document.createElement("input");
  watchInput.type = "text";
  watchInput.placeholder = "expressão (ex.: x + 1)";
  watchInput.setAttribute("aria-label", "Expressão de observação");
  watchInput.style.cssText = [
    "flex: 1 1 auto;",
    "min-width: 0;",
    "height: 20px;",
    "padding: 0 6px;",
    "border: 1px solid var(--s-border);",
    "border-radius: 3px;",
    "background: var(--s-editor);",
    "color: var(--s-fg);",
    "font-family: var(--s-font-mono);",
    "font-size: 11px;",
  ].join(" ");

  const watchAddButton = document.createElement("button");
  watchAddButton.type = "button";
  watchAddButton.innerHTML = ICON_PLUS;
  watchAddButton.title = "Adicionar expressão de observação";
  watchAddButton.setAttribute("aria-label", "Adicionar expressão de observação");
  watchAddButton.style.cssText = [
    "flex: 0 0 auto;",
    "display: inline-flex;",
    "align-items: center;",
    "justify-content: center;",
    "height: 20px;",
    "width: 22px;",
    "padding: 0;",
    "border: 1px solid var(--s-border);",
    "border-radius: 3px;",
    "background: transparent;",
    "color: var(--s-fg);",
    "cursor: pointer;",
    "line-height: 1;",
  ].join(" ");

  const commitWatch = (): void => {
    const expression = watchInput.value.trim();
    if (expression.length === 0) return;
    onWatchAdd?.(expression);
    watchInput.value = "";
  };

  watchAddButton.addEventListener("click", commitWatch);
  watchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitWatch();
    }
  });

  const watchRefreshButton = document.createElement("button");
  watchRefreshButton.type = "button";
  watchRefreshButton.innerHTML = ICON_REFRESH;
  watchRefreshButton.title = "Reavaliar expressões";
  watchRefreshButton.setAttribute("aria-label", "Reavaliar expressões");
  watchRefreshButton.style.cssText = [
    "flex: 0 0 auto;",
    "display: inline-flex;",
    "align-items: center;",
    "justify-content: center;",
    "height: 20px;",
    "width: 22px;",
    "padding: 0;",
    "border: 1px solid var(--s-border);",
    "border-radius: 3px;",
    "background: transparent;",
    "color: var(--s-fg);",
    "cursor: pointer;",
    "line-height: 1;",
  ].join(" ");
  watchRefreshButton.addEventListener("click", () => onWatchRefresh?.());

  /** Controles de observação (persistentes — o input nunca perde o foco). */
  function buildWatchControls(): void {
    if (watchControlsHost.childElementCount > 0) return;
    watchControlsHost.appendChild(sectionLabel("Observação"));
    const controls = document.createElement("div");
    controls.style.cssText = [
      "display: flex;",
      "align-items: center;",
      "gap: 4px;",
      "padding: 2px 10px 4px;",
    ].join(" ");
    controls.appendChild(watchInput);
    controls.appendChild(watchAddButton);
    controls.appendChild(watchRefreshButton);
    watchControlsHost.appendChild(controls);
  }

  function renderWatch(): void {
    buildWatchControls();
    watchListHost.replaceChildren();
    if (watchExpressions.length === 0) return;

    for (const expression of watchExpressions) {
      const el = document.createElement("div");
      el.style.cssText = [
        "display: flex;",
        "align-items: center;",
        "gap: 6px;",
        "padding: 2px 10px;",
      ].join(" ");

      const name = document.createElement("span");
      name.textContent = expression;
      name.style.cssText = [
        "font-family: var(--s-font-mono);",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "white-space: nowrap;",
      ].join(" ");
      el.appendChild(name);

      const value = document.createElement("span");
      const evaluated = watchValues.get(expression);
      if (evaluated === undefined) {
        // Sem valor avaliado: um traço (SVG) no lugar do glifo Unicode.
        value.innerHTML = ICON_DASH;
        value.title = "sem valor avaliado";
        value.setAttribute("aria-label", "sem valor avaliado");
        value.style.cssText = [
          "flex: 0 0 auto;",
          "display: inline-flex;",
          "align-items: center;",
          "opacity: .6;",
        ].join(" ");
      } else {
        value.textContent = evaluated;
        value.title = evaluated;
        value.style.cssText = [
          "flex: 1 1 auto;",
          "min-width: 0;",
          "color: var(--s-accent);",
          "font-family: var(--s-font-mono);",
          "overflow: hidden;",
          "text-overflow: ellipsis;",
          "white-space: nowrap;",
        ].join(" ");
      }
      el.appendChild(value);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.innerHTML = ICON_CLOSE_SMALL;
      remove.title = "Remover expressão";
      remove.setAttribute("aria-label", "Remover expressão");
      remove.style.cssText = [
        "flex: 0 0 auto;",
        "display: inline-flex;",
        "align-items: center;",
        "justify-content: center;",
        "width: 18px;",
        "height: 18px;",
        "padding: 0;",
        "border: none;",
        "background: transparent;",
        "color: var(--s-fg-muted);",
        "cursor: pointer;",
        "line-height: 1;",
      ].join(" ");
      remove.addEventListener("click", () => onWatchRemove?.(expression));
      el.appendChild(remove);

      watchListHost.appendChild(el);
    }
  }

  // ── Render principal ───────────────────────────────────────────────────────────────────────
  function render(): void {
    stateLabel.textContent = state;
    stackHost.replaceChildren();
    varsHost.replaceChildren();
    outHost.replaceChildren();

    // Botões: continuar só quando parado; pausar só quando rodando.
    const running = state === "running";
    const stopped = state === "stopped";
    const active = state !== "inactive" && state !== "terminated" && state !== "errored";
    for (const [id, button] of buttonById) {
      if (id === "debug-continue") button.disabled = !stopped;
      else if (id === "debug-pause") button.disabled = !running;
      else button.disabled = !active;
      button.style.opacity = button.disabled ? "0.4" : "1";
    }

    if (stopped) {
      stackHost.appendChild(sectionLabel("Pilha de chamadas"));
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i]!;
        const el = row(0, false, false, `${i + 1}.`, frameLabel(frame));
        if (i === selectedFrameIndex) {
          el.style.background = "var(--s-highlight)";
        }
        el.addEventListener("click", () => {
          selectedFrameIndex = i;
          render();
          onFrameSelect?.(frame);
          requestScopes(frame);
        });
        const frameIcon = document.createElement("span");
        frameIcon.innerHTML = FRAME_ICON_SVG;
        frameIcon.style.cssText = "flex-shrink: 0; opacity: .7; display: inline-flex;";
        el.insertBefore(frameIcon, el.children[1] ?? null);
        stackHost.appendChild(el);
      }

      const selected = frames[selectedFrameIndex];
      if (selected !== undefined) {
        const scopes = scopesByFrame.get(selected.id);
        if (scopes !== undefined && scopes.length > 0) {
          varsHost.appendChild(sectionLabel("Variáveis"));
          for (const scope of scopes) {
            const expandable = scope.variablesReference > 0;
            const expanded = expandedRefs.has(scope.variablesReference);
            const el = row(0, expandable, expanded, scope.name, "");
            el.addEventListener("click", (event) => {
              event.stopPropagation();
              if (!expandable) return;
              if (expanded) {
                expandedRefs.delete(scope.variablesReference);
                variablesByRef.delete(scope.variablesReference);
              } else {
                expandedRefs.add(scope.variablesReference);
                onVariablesRequest?.(scope.variablesReference);
              }
              render();
            });
            varsHost.appendChild(el);
            if (expanded) {
              const vars = variablesByRef.get(scope.variablesReference);
              if (vars !== undefined) renderVariables(varsHost, vars, 1);
            }
          }
        }
      }
    } else if (state === "inactive" || state === "terminated") {
      const empty = document.createElement("div");
      empty.textContent = "Nenhuma sessão de depuração ativa. F5 inicia.";
      empty.style.cssText = "padding: 10px; color: var(--s-fg-muted);";
      stackHost.appendChild(empty);
    } else if (breakpointCount > 0) {
      stackHost.appendChild(sectionLabel(`Breakpoints: ${breakpointCount}`));
    }

    renderWatch();
    renderBreakpoints();

    if (outputLines.length > 0) {
      outHost.appendChild(sectionLabel("Saída"));
      const out = document.createElement("pre");
      out.style.cssText = [
        "margin: 0;",
        "padding: 4px 10px 8px;",
        "white-space: pre-wrap;",
        "word-break: break-word;",
        "color: var(--s-fg-muted);",
        "font-family: var(--s-font-mono);",
        "font-size: 11px;",
        "max-height: 160px;",
        "overflow-y: auto;",
      ].join(" ");
      out.textContent = outputLines.slice(-200).join("");
      outHost.appendChild(out);
    }
  }

  /** Solicita os escopos de um frame apenas uma vez (cacheado em `scopesByFrame`). */
  function requestScopes(frame: DapStackFrame): void {
    if (scopesByFrame.has(frame.id)) return;
    onScopesRequest?.(frame);
  }

  const outputLines: string[] = [];
  let outputDirty = false;

  function flushOutput(): void {
    if (!outputDirty) return;
    outputDirty = false;
    if (isOpenValue && state === "stopped") render();
  }

  /**
   * Abre/fecha o painel.
   *
   * ⚠️ O nome local é `openPanel`/`closePanel` (e **não** `close`): um `close()` solto
   * neste escopo resolveria para o **`window.close()` global** e o botão "×" fecharia a
   * **janela** — o app inteiro saía (exit 0) ao fechar o painel de depuração.
   */
  function openPanel(): void {
    isOpenValue = true;
    setVisible(panel, true);
    setVisible(toolbar, true);
    applyRightOffset();
    render();
    notifyVisibility();
  }

  function closePanel(): void {
    isOpenValue = false;
    setVisible(panel, false);
    const active = state !== "inactive" && state !== "terminated" && state !== "errored";
    setVisible(toolbar, active);
    applyRightOffset();
    render();
    notifyVisibility();
  }

  return {
    get isOpen(): boolean {
      return isOpenValue;
    },
    setState(next: DapSessionState): void {
      state = next;
      const active = state !== "inactive" && state !== "terminated" && state !== "errored";
      // A barra fica visível enquanto o painel estiver aberto (mesmo sem sessão).
      setVisible(toolbar, isOpenValue || active);
      applyRightOffset();
      if (!active) {
        if (state === "inactive" || state === "terminated") {
          scopesByFrame.clear();
          variablesByRef.clear();
          expandedRefs.clear();
          frames = [];
        }
      } else if (state === "running") {
        scopesByFrame.clear();
        variablesByRef.clear();
        expandedRefs.clear();
        frames = [];
      }
      render();
    },
    showStopped(_threadId: number | undefined, nextFrames: readonly DapStackFrame[]): void {
      frames = nextFrames;
      selectedFrameIndex = 0;
      scopesByFrame.clear();
      variablesByRef.clear();
      expandedRefs.clear();
      isOpenValue = true;
      setVisible(panel, true);
      setVisible(toolbar, true);
      applyRightOffset();
      render();
      const first = frames[0];
      if (first !== undefined) {
        onFrameSelect?.(first);
        requestScopes(first);
      }
    },
    setScopes(frameId: number, scopes: readonly DapScope[]): void {
      scopesByFrame.set(frameId, scopes);
      render();
    },
    setVariables(reference: number, variables: readonly DapVariable[]): void {
      variablesByRef.set(reference, variables);
      render();
    },
    clearStop(): void {
      scopesByFrame.clear();
      variablesByRef.clear();
      expandedRefs.clear();
      frames = [];
      render();
    },
    appendOutput(category: string, text: string): void {
      const prefix = category === "stderr" ? "" : "";
      outputLines.push(`${prefix}${text}`);
      outputDirty = true;
      flushOutput();
    },
    setBreakpointCount(count: number): void {
      breakpointCount = count;
      render();
    },
    setBreakpointSpecs(specs: readonly DapBreakpointSpec[], documentKey?: string): void {
      // Documento **diferente**: os campos da lista anterior não podem ser reusados (a
      // condição/log antiga voltaria no campo) — a lista é recriada do zero.
      if (documentKey !== undefined && documentKey !== breakpointDocumentKey) {
        breakpointDocumentKey = documentKey;
        for (const row of breakpointRows.values()) row.element.remove();
        breakpointRows.clear();
        renderedBreakpointLines = []; // força a reconstrução da lista
      }
      breakpointSpecs = specs;
      // As linhas que **sumiram** são descartadas (acontece em `renderBreakpoints`): sem
      // isso o mapa cresceria sem limite e o input velho (com a condição antiga) seria
      // reusado quando a mesma linha voltasse a ter breakpoint.
      renderBreakpoints();
    },
    onBreakpointSpecChange(callback: (line: number, spec: DapBreakpointSpec) => void): void {
      onBreakpointSpecChange = callback;
    },
    onBreakpointConditionChange(callback: (line: number, condition: string) => void): void {
      onBreakpointConditionChange = callback;
    },
    onBreakpointRemove(callback: (line: number) => void): void {
      onBreakpointRemove = callback;
    },
    setWatchExpressions(expressions: readonly string[]): void {
      watchExpressions = expressions;
      renderWatch();
    },
    setWatchValues(values: ReadonlyMap<string, string>): void {
      watchValues = new Map(values);
      renderWatch();
    },
    onWatchAdd(callback: (expression: string) => void): void {
      onWatchAdd = callback;
    },
    onWatchRemove(callback: (expression: string) => void): void {
      onWatchRemove = callback;
    },
    onWatchRefresh(callback: () => void): void {
      onWatchRefresh = callback;
    },
    showDebugValue(text: string, x: number, y: number): void {
      valueTip.textContent = text;
      setVisible(valueTip, true);
      const width = valueTip.offsetWidth;
      const height = valueTip.offsetHeight;
      const left = Math.min(x + 12, Math.max(0, window.innerWidth - width - 8));
      const top = Math.min(y + 16, Math.max(0, window.innerHeight - height - 8));
      valueTip.style.left = `${left}px`;
      valueTip.style.top = `${top}px`;
    },
    hideDebugValue(): void {
      setVisible(valueTip, false);
    },
    onAction(callback: (action: DebugAction) => void): void {
      onAction = callback;
    },
    onVisibilityChange(callback: (open: boolean) => void): void {
      visibilityCallback = callback;
    },
    onFrameSelect(callback: (frame: DapStackFrame) => void): void {
      onFrameSelect = callback;
    },
    onScopesRequest(callback: (frame: DapStackFrame) => void): void {
      onScopesRequest = callback;
    },
    onVariablesRequest(callback: (reference: number) => void): void {
      onVariablesRequest = callback;
    },
    open(): void {
      openPanel();
    },
    close(): void {
      closePanel();
    },
    dispose(): void {
      toolbar.remove();
      panel.remove();
      valueTip.remove();
      breakpointRows.clear();
      renderedBreakpointLines = [];
    },
  };
}
