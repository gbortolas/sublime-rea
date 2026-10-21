/**
 * Scribe — interface de depuração (DAP) no renderer.
 *
 * Constrói dinamicamente (sem markup estático) a **barra de ferramentas** de depuração e o
 * **painel** com a pilha de chamadas, escopos e variáveis, além do log de saída do programa.
 *
 * Desde o P4#27 o painel gained mais três partes:
 * - **Breakpoints** com **condição** editável por breakpoint (breakpoint condicional);
 * - **Observação** (watch): expressões reavaliadas a cada parada;
 * - **tooltip de valor**: mostra o valor de uma variável sob o mouse durante a parada.
 *
 * O widget é "burro": não fala com a ponte. Ele expõe uma API (`DebugViewBinding`) e emite
 * intenções (`onAction`, `onFrameSelect`, `onScopeToggle`, `onVariableToggle`,
 * `onBreakpointConditionChange`, `onWatchAdd`, …) que o `main.ts` traduz para chamadas IPC.
 */
import type {
  DapBreakpointSpec,
  DapScope,
  DapSessionState,
  DapStackFrame,
  DapVariable,
} from "../shared";

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
  /** A condição de um breakpoint foi editada pelo usuário. */
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

  /** Breakpoints do arquivo exibido (com condição). */
  let breakpointSpecs: readonly DapBreakpointSpec[] = [];
  /** Assinatura dos specs — evita re-render (e perda de foco) a cada evento. */
  let breakpointSignature = "";
  /** Documento cuja lista de breakpoints está no painel (o painel segue o documento ativo). */
  let breakpointDocumentKey: string | undefined;
  /** Campos de condição persistentes por linha (recriados só quando a linha muda). */
  const conditionInputs = new Map<number, HTMLInputElement>();

  /** Expressões de observação e seus últimos valores avaliados. */
  let watchExpressions: readonly string[] = [];
  let watchValues = new Map<string, string>();

  let onAction: ((action: DebugAction) => void) | undefined;
  let onFrameSelect: ((frame: DapStackFrame) => void) | undefined;
  let onScopesRequest: ((frame: DapStackFrame) => void) | undefined;
  let onVariablesRequest: ((reference: number) => void) | undefined;
  let onBreakpointConditionChange: ((line: number, condition: string) => void) | undefined;
  let onBreakpointRemove: ((line: number) => void) | undefined;
  let onWatchAdd: ((expression: string) => void) | undefined;
  let onWatchRemove: ((expression: string) => void) | undefined;
  let onWatchRefresh: (() => void) | undefined;

  const overlay = document.getElementById("ui-overlay");

  // ── Barra de ferramentas ──────────────────────────────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.id = "debug-toolbar";
  toolbar.role = "toolbar";
  toolbar.setAttribute("aria-label", "Depuração");
  toolbar.hidden = true;
  toolbar.style.cssText = [
    "position: absolute;",
    "top: 8px;",
    "left: 50%;",
    "transform: translateX(-50%);",
    "display: flex;",
    "align-items: center;",
    "gap: 4px;",
    "padding: 4px 6px;",
    "background: var(--s-statusbar, #1f1f22);",
    "border: 1px solid var(--s-border, #2b2b2f);",
    "border-radius: 6px;",
    "box-shadow: 0 4px 16px rgba(0,0,0,.35);",
    "z-index: 150;",
    "font-family: inherit;",
    "font-size: 12px;",
    "color: var(--s-fg, #ccc);",
  ].join(" ");

  const stateLabel = document.createElement("span");
  stateLabel.style.cssText = [
    "padding: 0 6px;",
    "font-weight: 600;",
    "color: var(--s-accent, #3794ff);",
    "text-transform: lowercase;",
  ].join(" ");
  toolbar.appendChild(stateLabel);

  const buttons: { action: DebugAction; label: string; title: string; id: string }[] = [
    { action: "continue", label: "▶", title: "Continuar (F5)", id: "debug-continue" },
    { action: "pause", label: "⏸", title: "Pausar", id: "debug-pause" },
    { action: "stepOver", label: "⤵", title: "Passo por cima (F10)", id: "debug-step-over" },
    { action: "stepInto", label: "⤓", title: "Passo para dentro (F11)", id: "debug-step-into" },
    { action: "stepOut", label: "⤴", title: "Passo para fora (Shift+F11)", id: "debug-step-out" },
    { action: "stop", label: "■", title: "Encerrar (Shift+F5)", id: "debug-stop" },
  ];
  const buttonById = new Map<string, HTMLButtonElement>();
  for (const spec of buttons) {
    const button = document.createElement("button");
    button.id = spec.id;
    button.type = "button";
    button.textContent = spec.label;
    button.title = spec.title;
    button.style.cssText = [
      "min-width: 24px;",
      "height: 22px;",
      "border: none;",
      "border-radius: 4px;",
      "background: transparent;",
      "color: inherit;",
      "cursor: pointer;",
      "font-size: 13px;",
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
  panel.role = "complementary";
  panel.setAttribute("aria-label", "Depuração — pilha e variáveis");
  panel.hidden = true;
  panel.style.cssText = [
    "position: absolute;",
    "top: 44px;",
    "right: 12px;",
    "width: 340px;",
    "max-height: 62vh;",
    "display: flex;",
    "flex-direction: column;",
    "background: var(--s-sidebar, #252526);",
    "border: 1px solid var(--s-border, #3c3c3c);",
    "border-radius: 6px;",
    "box-shadow: 0 8px 24px rgba(0,0,0,.4);",
    "z-index: 145;",
    "color: var(--s-fg, #ccc);",
    "font-family: inherit;",
    "font-size: 12px;",
    "overflow: hidden;",
  ].join(" ");

  const header = document.createElement("div");
  header.style.cssText = [
    "display: flex;",
    "align-items: center;",
    "justify-content: space-between;",
    "padding: 6px 8px;",
    "border-bottom: 1px solid var(--s-border, #3c3c3c);",
    "font-weight: 600;",
  ].join(" ");
  header.textContent = "Depuração";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Fechar painel";
  closeButton.style.cssText = [
    "border: none;",
    "background: transparent;",
    "color: inherit;",
    "cursor: pointer;",
    "font-size: 15px;",
    "line-height: 1;",
  ].join(" ");
  closeButton.addEventListener("click", () => close());
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
    "z-index: 220;",
    "max-width: 320px;",
    "padding: 4px 8px;",
    "background: var(--s-editor, #1e1e1e);",
    "border: 1px solid var(--s-border, #3c3c3c);",
    "border-radius: 4px;",
    "box-shadow: 0 4px 12px rgba(0,0,0,.4);",
    "color: var(--s-fg, #ccc);",
    "font-family: ui-monospace, monospace;",
    "font-size: 11px;",
    "pointer-events: none;",
    "white-space: pre-wrap;",
  ].join(" ");
  overlay?.appendChild(valueTip);

  // ── Helpers de render ─────────────────────────────────────────────────────────────────────
  function sectionLabel(text: string): HTMLElement {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = [
      "padding: 4px 10px 2px;",
      "font-size: 10px;",
      "letter-spacing: .08em;",
      "text-transform: uppercase;",
      "color: var(--s-fg-muted, #888);",
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
        "color: var(--s-accent, #3794ff);",
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

  // ── Breakpoints condicionais ──────────────────────────────────────────────────────────────

  /**
   * Reconstrói a lista de breakpoints **só quando a assinatura muda** — do contrário, um
   * `render()` (disparado por qualquer evento) derrubaria o foco do campo de condição que o
   * usuário está editando.
   */
  function renderBreakpoints(): void {
    const signature = breakpointSpecs
      .map((spec) => `${spec.line}:${spec.condition ?? ""}`)
      .join("|");
    if (signature === breakpointSignature) return;
    breakpointSignature = signature;

    bpHost.replaceChildren();
    if (breakpointSpecs.length === 0) return;

    bpHost.appendChild(sectionLabel(`Breakpoints (${breakpointSpecs.length})`));

    for (const spec of breakpointSpecs) {
      const el = document.createElement("div");
      el.style.cssText = [
        "display: flex;",
        "align-items: center;",
        "gap: 6px;",
        "padding: 2px 10px;",
      ].join(" ");

      const label = document.createElement("span");
      label.textContent = `linha ${spec.line}`;
      label.style.cssText = "flex: 0 0 auto; color: var(--s-fg-muted, #999);";
      el.appendChild(label);

      const input = getConditionInput(spec.line);
      el.appendChild(input);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remover breakpoint";
      remove.style.cssText = [
        "flex: 0 0 auto;",
        "border: none;",
        "background: transparent;",
        "color: var(--s-fg-muted, #999);",
        "cursor: pointer;",
        "font-size: 13px;",
        "line-height: 1;",
      ].join(" ");
      remove.addEventListener("click", () => onBreakpointRemove?.(spec.line));
      el.appendChild(remove);

      bpHost.appendChild(el);
    }
  }

  /** Campo de condição de uma linha (persistente: mantém o foco durante a edição). */
  function getConditionInput(line: number): HTMLInputElement {
    const existing = conditionInputs.get(line);
    if (existing !== undefined) return existing;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "debug-condition";
    input.placeholder = "condição (ex.: x > 3)";
    // A condição vigente entra no campo — um input novo não pode nascer vazio.
    input.value = breakpointSpecs.find((spec) => spec.line === line)?.condition ?? "";
    input.style.cssText = [
      "flex: 1 1 auto;",
      "min-width: 0;",
      "height: 20px;",
      "padding: 0 6px;",
      "border: 1px solid var(--s-border, #3c3c3c);",
      "border-radius: 3px;",
      "background: var(--s-editor, #1e1e1e);",
      "color: var(--s-fg, #ccc);",
      "font-family: ui-monospace, monospace;",
      "font-size: 11px;",
    ].join(" ");
    input.addEventListener("change", () => {
      onBreakpointConditionChange?.(line, input.value.trim());
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
    conditionInputs.set(line, input);
    return input;
  }

  // ── Expressões de observação (watch) ───────────────────────────────────────────────────────

  const watchInput = document.createElement("input");
  watchInput.type = "text";
  watchInput.placeholder = "expressão (ex.: x + 1)";
  watchInput.style.cssText = [
    "flex: 1 1 auto;",
    "min-width: 0;",
    "height: 20px;",
    "padding: 0 6px;",
    "border: 1px solid var(--s-border, #3c3c3c);",
    "border-radius: 3px;",
    "background: var(--s-editor, #1e1e1e);",
    "color: var(--s-fg, #ccc);",
    "font-family: ui-monospace, monospace;",
    "font-size: 11px;",
  ].join(" ");

  const watchAddButton = document.createElement("button");
  watchAddButton.type = "button";
  watchAddButton.textContent = "＋";
  watchAddButton.title = "Adicionar expressão de observação";
  watchAddButton.style.cssText = [
    "flex: 0 0 auto;",
    "height: 20px;",
    "width: 22px;",
    "border: 1px solid var(--s-border, #3c3c3c);",
    "border-radius: 3px;",
    "background: transparent;",
    "color: var(--s-fg, #ccc);",
    "cursor: pointer;",
    "font-size: 12px;",
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
  watchRefreshButton.textContent = "⟳";
  watchRefreshButton.title = "Reavaliar expressões";
  watchRefreshButton.style.cssText = [
    "flex: 0 0 auto;",
    "height: 20px;",
    "width: 22px;",
    "border: 1px solid var(--s-border, #3c3c3c);",
    "border-radius: 3px;",
    "background: transparent;",
    "color: var(--s-fg, #ccc);",
    "cursor: pointer;",
    "font-size: 12px;",
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
        "font-family: ui-monospace, monospace;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "white-space: nowrap;",
      ].join(" ");
      el.appendChild(name);

      const value = document.createElement("span");
      value.textContent = watchValues.get(expression) ?? "—";
      value.title = watchValues.get(expression) ?? "";
      value.style.cssText = [
        "flex: 1 1 auto;",
        "min-width: 0;",
        "color: var(--s-accent, #3794ff);",
        "font-family: ui-monospace, monospace;",
        "overflow: hidden;",
        "text-overflow: ellipsis;",
        "white-space: nowrap;",
      ].join(" ");
      el.appendChild(value);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remover expressão";
      remove.style.cssText = [
        "flex: 0 0 auto;",
        "border: none;",
        "background: transparent;",
        "color: var(--s-fg-muted, #999);",
        "cursor: pointer;",
        "font-size: 13px;",
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
          el.style.background = "var(--s-highlight, #094771)";
        }
        el.addEventListener("click", () => {
          selectedFrameIndex = i;
          render();
          onFrameSelect?.(frame);
          requestScopes(frame);
        });
        const icon = document.createElement("span");
        icon.innerHTML = FRAME_ICON_SVG;
        icon.style.cssText = "flex-shrink: 0; opacity: .7; display: inline-flex;";
        el.insertBefore(icon, el.children[1] ?? null);
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
      empty.style.cssText = "padding: 10px; color: var(--s-fg-muted, #888);";
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
        "color: var(--s-fg-muted, #aaa);",
        "font-family: ui-monospace, monospace;",
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

  return {
    get isOpen(): boolean {
      return isOpenValue;
    },
    setState(next: DapSessionState): void {
      state = next;
      const active = state !== "inactive" && state !== "terminated" && state !== "errored";
      // A barra fica visível enquanto o painel estiver aberto (mesmo sem sessão).
      toolbar.hidden = !isOpenValue && !active;
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
      panel.hidden = false;
      toolbar.hidden = false;
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
      // Documento **diferente**: os inputs da lista anterior não podem ser reusados (a
      // condição antiga voltaria no campo) — a lista é recriada do zero.
      if (documentKey !== undefined && documentKey !== breakpointDocumentKey) {
        breakpointDocumentKey = documentKey;
        conditionInputs.clear();
        breakpointSignature = ""; // força a reconstrução da lista
      }
      breakpointSpecs = specs;
      // As entradas das linhas que **sumiram** são descartadas: sem isso o mapa cresceria
      // sem limite e o input velho (com a condição antiga) seria reusado quando a mesma
      // linha voltasse a ter breakpoint.
      const lines = new Set(specs.map((spec) => spec.line));
      for (const line of [...conditionInputs.keys()]) {
        if (lines.has(line)) continue;
        conditionInputs.delete(line);
      }
      // O valor do campo só é aplicado quando o usuário **não** está editando-o.
      for (const spec of specs) {
        const input = conditionInputs.get(spec.line);
        if (input === undefined) continue;
        if (document.activeElement === input) continue;
        input.value = spec.condition ?? "";
      }
      renderBreakpoints();
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
      valueTip.hidden = false;
      const width = valueTip.offsetWidth;
      const height = valueTip.offsetHeight;
      const left = Math.min(x + 12, Math.max(0, window.innerWidth - width - 8));
      const top = Math.min(y + 16, Math.max(0, window.innerHeight - height - 8));
      valueTip.style.left = `${left}px`;
      valueTip.style.top = `${top}px`;
    },
    hideDebugValue(): void {
      valueTip.hidden = true;
    },
    onAction(callback: (action: DebugAction) => void): void {
      onAction = callback;
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
      isOpenValue = true;
      panel.hidden = false;
      toolbar.hidden = false;
      render();
    },
    close(): void {
      isOpenValue = false;
      panel.hidden = true;
      const active = state !== "inactive" && state !== "terminated" && state !== "errored";
      toolbar.hidden = !active;
      render();
    },
    dispose(): void {
      toolbar.remove();
      panel.remove();
      valueTip.remove();
      conditionInputs.clear();
    },
  };
}
