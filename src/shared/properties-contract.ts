/**
 * Scribe — contratos de fronteira: sistema de propriedades e controles.
 *
 * Fonte: `docs/architecture/04-render-e-ui.md` (`Property`/`Control`) e
 * `docs/architecture/06-padroes-transversais.md` (`defineProperty`, DEC-TR-6/7) e
 * `docs/architecture/05-empacotamento-e-recursos.md` (DEC-PKG-9: precedência em camadas).
 *
 * Regra (DEC-TR-7): **tudo que é tunável é medido, não hardcoded** — `editor.ioWorkers`,
 * `render.backend` etc. nascem aqui com default explícito e override por camada/camada de
 * recurso.
 */
import type { Event } from "./events";
import type { ResourceLayer } from "./packages-contract";
import type { RenderPipeline } from "./render-contract";

/** Escopo de uma propriedade — a granularidade do override (06:250). */
export type PropertyScope = "global" | "window" | "view" | "document";

/**
 * Token opaco de propriedade (equivalente ao `defineProperty` de `06:250`).
 * Criado **uma vez** e compartilhado; `name` é a chave do merge por camadas.
 */
export interface PropertyDefinition<T> {
  readonly name: string;
  readonly defaultValue: T;
  readonly scope: PropertyScope;
}

export interface Property<T> {
  get(): T;
  set(v: T): void;
  watch(cb: (v: T) => void): () => void;
}

/** Nó de UI que sabe se desenhar — só fala com o `RenderPipeline` (DEC-REN-1). */
export interface Control {
  readonly properties: ReadonlyMap<string, Property<unknown>>;
  paint(p: RenderPipeline): void;
}

export interface PropertyChange {
  readonly name: string;
  readonly value: unknown;
  /** Origem do valor efetivo: a camada que venceu, ou `"default"`. */
  readonly source: ResourceLayer | "default";
}

/**
 * Dono do valor efetivo de cada propriedade. O merge é por **precedência de camada**
 * (DEC-PKG-9/DEC-TR-6): `user` > `app` > `os` > `default`.
 */
export interface PropertySystem {
  define<T>(name: string, defaultValue: T, opts?: { readonly scope?: PropertyScope }): PropertyDefinition<T>;
  /** Valor efetivo (medido) da propriedade. */
  value<T>(def: PropertyDefinition<T>): T;
  /** Override programático (vence tudo; não persiste em camada). */
  set<T>(def: PropertyDefinition<T>, value: T): void;
  /** Aplica um mapa de valores vindo de uma camada de recurso. */
  applyLayer(values: Readonly<Record<string, unknown>>, layer: ResourceLayer): void;
  /** Valor efetivo por nome, para chaves sem `PropertyDefinition` (ex.: lidas de settings JSON). */
  resolved(name: string): unknown;
  watch(name: string, cb: (change: PropertyChange) => void): () => void;
  readonly onChange: Event<PropertyChange>;
  readonly scope: PropertyScope;
}

/** Nomes canônicos usados no boot (DEC-TR-7). */
export const PROPERTY_IO_WORKERS = "editor.ioWorkers";
export const PROPERTY_INDEX_ON_STARTUP = "index.indexOnStartup";
