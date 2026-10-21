/**
 * Scribe — **DOM falso** para os testes dos painéis do renderer.
 *
 * O ambiente de teste do repo é `node` (**sem jsdom**) ⇒ os painéis do renderer (Problemas,
 * Outline, Explorer, Controle de Código e Diff) são testados contra um **DOM falso** mínimo.
 *
 * O que este falso DOM cobre (a API que os 5 painéis usam):
 *
 * - criação (`document.createElement`/`createTextNode`), árvore (`append`, `appendChild`,
 *   `replaceChildren`, `remove`) e atributo (`setAttribute`/`getAttribute`/`removeAttribute`);
 * - `className`, `classList` (`add`/`remove`/`toggle`/`contains`), `dataset`, `innerHTML`,
 *   `textContent`, `title`, `id`, `type`, `value`, `placeholder`, `checked`, `hidden`,
 *   `disabled`, `autocomplete`, `spellcheck` e `style` (`cssText` + propriedades);
 * - **eventos com *bubbling*** (`addEventListener`/`removeEventListener`/`dispatch`) — o
 *   bubbling importa: o botão "+" da SCM está **dentro** da linha, e é o clique que sobe
 *   para a linha que redesenhava a lista;
 * - `focus()` (com `document.activeElement`) e `scrollIntoView()` (usado pelo painel de diff
 *   para rolar até o hunk atual **sem** redesenhar).
 */

/** As opções de um evento disparado pelo falso DOM. */
export interface FakeEventInit {
  /** O `key` do evento (o painel de Outline/Explorer leem `event.key`). */
  readonly key?: string;
}

/** As opções do `MutationObserver` falso (só o que os painéis usam). */
export interface FakeObserverOptions {
  /** Observa os atributos? */
  readonly attributes?: boolean;
  /** Só estes atributos (o `hidden`). */
  readonly attributeFilter?: readonly string[];
}

/** Um evento do falso DOM (o que os painéis recebem no listener). */
export class FakeEvent {
  readonly type: string;
  /** A tecla do evento ("" quando não é um evento de teclado). */
  readonly key: string;
  /** `true` quando alguém chamou `preventDefault()`. */
  defaultPrevented = false;
  /** `true` quando alguém chamou `stopPropagation()`. */
  propagationStopped = false;

  constructor(type: string, key = "") {
    this.type = type;
    this.key = key;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

/** Um listener registrado no falso DOM. */
export type FakeListener = (event: FakeEvent) => void;

/** O `style` do falso DOM (só o que os painéis usam). */
export class FakeStyle {
  cssText = "";
  paddingLeft = "";
  backgroundColor = "";
  [prop: string]: string;
}

/** A `classList` do falso DOM (mexe no `className` do dono). */
export class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  private tokens(): string[] {
    return this.owner.className.split(/\s+/).filter((token) => token.length > 0);
  }

  add(...names: string[]): void {
    const tokens = this.tokens();
    for (const name of names) if (!tokens.includes(name)) tokens.push(name);
    this.owner.className = tokens.join(" ");
  }

  remove(...names: string[]): void {
    this.owner.className = this.tokens()
      .filter((token) => !names.includes(token))
      .join(" ");
  }

  contains(name: string): boolean {
    return this.tokens().includes(name);
  }

  /** Liga/desliga a classe (com `force`, o resultado é o valor pedido). */
  toggle(name: string, force?: boolean): boolean {
    const next = force === undefined ? !this.contains(name) : force;
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

/** Um nó do falso DOM (a base de elemento e de texto). */
export class FakeNode {  parent: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  private readonly listeners = new Map<string, FakeListener[]>();

  appendChild<T extends FakeNode>(node: T): T {
    node.parent = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.childNodes) child.parent = null;
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    const parent = this.parent;
    if (parent === null) return;
    const index = parent.childNodes.indexOf(this);
    if (index >= 0) parent.childNodes.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type);
    if (list === undefined) this.listeners.set(type, [listener]);
    else list.push(listener);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  /**
   * Dispara um evento que **sobe** até a raiz (como no DOM).
   *
   * O `stopPropagation()` do evento corta a subida ⇒ o listener do pai não roda.
   */
  dispatch(type: string, init: FakeEventInit = {}): FakeEvent {
    const event = new FakeEvent(type, init.key ?? "");
    this.bubble(event, this);
    return event;
  }

  /** Sobe a árvore disparando os listeners (para no `stopPropagation`). */
  private bubble(event: FakeEvent, node: FakeNode | null): void {
    if (node === null) return;
    for (const listener of [...(node.listeners.get(event.type) ?? [])]) {
      listener(event);
      if (event.propagationStopped) return;
    }
    node.bubble(event, node.parent);
  }
}

/** Um registro de observação (o `MutationObserver` falso). */
interface FakeObserverRecord {
  readonly owner: FakeMutationObserver;
  readonly attributeFilter: readonly string[] | undefined;
}

/** Um elemento do falso DOM (só a API que os painéis usam). */
export class FakeElement extends FakeNode {
  readonly tagName: string;
  className = "";
  textContent = "";
  title = "";
  type = "";
  placeholder = "";
  value = "";
  id = "";
  disabled = false;
  checked = false;
  autocomplete = "";
  spellcheck = false;
  innerHTML = "";
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classList = new FakeClassList(this);
  /** O documento dono (o `focus()` precisa saber onde está o foco). */
  ownerDocument: FakeDocument | null = null;
  /** Quantas vezes o `scrollIntoView` foi chamado (o painel de diff usa). */
  scrollIntoViewCalls = 0;
  private hiddenValue = false;
  private readonly observers: FakeObserverRecord[] = [];

  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }

  /** Os filhos **elemento** (o `children` do DOM). */
  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  /** O `hidden` (reflete o atributo — muda o valor ⇒ avisa os observadores). */
  get hidden(): boolean {
    return this.hiddenValue;
  }

  set hidden(value: boolean) {
    if (this.hiddenValue === value) return;
    this.hiddenValue = value;
    for (const record of [...this.observers]) {
      const filter = record.attributeFilter;
      if (filter !== undefined && !filter.includes("hidden")) continue;
      record.owner.notify();
    }
  }

  /** Registra um observador (o `MutationObserver` falso). */
  addObserver(record: FakeObserverRecord): void {
    this.observers.push(record);
  }

  /** Remove um observador (o `disconnect`). */
  removeObserver(record: FakeObserverRecord): void {
    const index = this.observers.indexOf(record);
    if (index >= 0) this.observers.splice(index, 1);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  focus(): void {
    this.ownerDocument?.setActiveElement(this);
  }

  blur(): void {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.setActiveElement(null);
  }

  scrollIntoView(): void {
    this.scrollIntoViewCalls += 1;
  }
}

/** Um nó de texto do falso DOM. */
export class FakeText extends FakeNode {
  readonly data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }
}

/**
 * Um `MutationObserver` falso (o painel usa para redesenhar quando o host aparece).
 *
 * No DOM real o callback é assíncrono (microtask); no falso ele é **síncrono** (o teste
 * pode verificar na hora).
 */
export class FakeMutationObserver {
  private readonly records: Array<{ target: FakeElement; record: FakeObserverRecord }> = [];

  constructor(private readonly callback: () => void) {}

  observe(target: FakeElement, options?: FakeObserverOptions): void {
    const record: FakeObserverRecord = {
      owner: this,
      attributeFilter: options?.attributeFilter,
    };
    target.addObserver(record);
    this.records.push({ target, record });
  }

  disconnect(): void {
    for (const entry of this.records) entry.target.removeObserver(entry.record);
    this.records.length = 0;
  }

  /** Avisa o callback (o `FakeElement` chama quando o `hidden` muda). */
  notify(): void {
    this.callback();
  }
}

/** O `document` falso (o que os painéis esperam no `globalThis`). */
export class FakeDocument {
  /** O elemento com o foco (`null` = nenhum). */
  activeElement: FakeElement | null = null;

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  /** Troca o elemento com o foco (usado por `FakeElement.focus`). */
  setActiveElement(element: FakeElement | null): void {
    this.activeElement = element;
  }
}

/** Instala o `document` falso (e o `MutationObserver`) no `globalThis`. */
export function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  const ref = globalThis as { document?: unknown; MutationObserver?: unknown };
  ref.document = doc;
  ref.MutationObserver = FakeMutationObserver;
  return doc;
}

/** Remove o `document` falso (e o `MutationObserver`) do `globalThis`. */
export function uninstallFakeDom(): void {
  const ref = globalThis as { document?: unknown; MutationObserver?: unknown };
  delete ref.document;
  delete ref.MutationObserver;
}

/** Todos os descendentes **elemento** com a classe dada. */
export function byClass(root: FakeNode, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: FakeNode): void => {
    if (node instanceof FakeElement && node.className.split(/\s+/).includes(className)) {
      out.push(node);
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}

/** O primeiro descendente com a classe dada (`undefined` se não houver). */
export function firstByClass(root: FakeNode, className: string): FakeElement | undefined {
  return byClass(root, className)[0];
}
