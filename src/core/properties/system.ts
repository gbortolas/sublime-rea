/**
 * Scribe — `PropertySystem`: valor efetivo por precedência de camada (DEC-TR-6 / DEC-PKG-9).
 *
 * Fonte: `docs/architecture/06-padroes-transversais.md` §6 (`defineProperty`, schema tipado) e
 * `docs/architecture/05-empacotamento-e-recursos.md` (precedência em camadas).
 *
 * Precedência do valor efetivo: **`user` > `app` > `os` > default** (`RESOURCE_LAYER_PRECEDENCE`).
 * Além disso há o **override programático** (`set`), que vence tudo e não persiste em camada.
 *
 * Ortogonalmente ao `PackageResolver`: valores de settings entram por `applyLayer(values, layer)`
 * **depois de parseados** (o `PackageResolver` só entrega bytes/entradas; aqui é que se mescla).
 * `applyLayer` **substitui** o mapa daquela camada (trocar de novo a mesma camada é idempotente).
 */
import { Emitter, RESOURCE_LAYER_PRECEDENCE } from "../../shared";
import type { Event, PropertyDefinition, PropertyScope, PropertySystem, ResourceLayer } from "../../shared";

/** `PropertyChange` + a marca de override programático (não representável na união de `source`). */
export interface PropertyChangeDetail {
  readonly name: string;
  readonly value: unknown;
  /** Camada que venceu (`user`/`app`/`os`) ou `"default"`. */
  readonly source: ResourceLayer | "default";
  /** `true` quando o valor efetivo veio de `set()` (override), não da cadeia de camadas. */
  readonly overridden: boolean;
}

export interface PropertySystemOptions {
  readonly scope?: PropertyScope;
}

/** Cria um **token opaco** de propriedade (equivalente ao `defineProperty` do doc 06). */
export function defineProperty<T>(
  name: string,
  defaultValue: T,
  opts?: { readonly scope?: PropertyScope },
): PropertyDefinition<T> {
  return Object.freeze({ name, defaultValue, scope: opts?.scope ?? "global" });
}

interface Resolution {
  readonly found: boolean;
  readonly value: unknown;
  readonly source: ResourceLayer | "default";
  readonly overridden: boolean;
}

/** Implementação do `PropertySystem` com precedência explícita e evento de mudança real. */
export class PropertySystemImpl implements PropertySystem {
  readonly scope: PropertyScope;
  readonly onChange: Event<PropertyChangeDetail>;

  private readonly emitter = new Emitter<PropertyChangeDetail>();
  private readonly definitions = new Map<string, PropertyDefinition<unknown>>();
  private readonly layers = new Map<ResourceLayer, Map<string, unknown>>();
  private readonly overrides = new Map<string, unknown>();

  constructor(options: PropertySystemOptions = {}) {
    this.scope = options.scope ?? "global";
    this.onChange = this.emitter.event;
  }

  define<T>(
    name: string,
    defaultValue: T,
    opts?: { readonly scope?: PropertyScope },
  ): PropertyDefinition<T> {
    const definition: PropertyDefinition<T> = Object.freeze({
      name,
      defaultValue,
      scope: opts?.scope ?? this.scope,
    });
    this.register(definition);
    return definition;
  }

  value<T>(definition: PropertyDefinition<T>): T {
    this.register(definition);
    const resolution = this.resolve(definition.name);
    return resolution.found ? (resolution.value as T) : definition.defaultValue;
  }

  set<T>(definition: PropertyDefinition<T>, value: T): void {
    this.register(definition);
    const before = this.resolve(definition.name);
    if (this.overrides.has(definition.name) && Object.is(this.overrides.get(definition.name), value)) {
      return;
    }
    this.overrides.set(definition.name, value);
    const after = this.resolve(definition.name);
    if (!Object.is(before.value, after.value) || before.found !== after.found) {
      this.emit(definition.name, after);
    }
  }

  applyLayer(values: Readonly<Record<string, unknown>>, layer: ResourceLayer): void {
    const affected = new Set<string>();
    const previous = this.layers.get(layer);
    if (previous !== undefined) {
      for (const key of previous.keys()) affected.add(key);
    }
    for (const key of Object.keys(values)) affected.add(key);

    const before = new Map<string, Resolution>();
    for (const name of affected) before.set(name, this.resolve(name));

    this.layers.set(layer, new Map(Object.entries(values)));

    for (const name of affected) {
      const after = this.resolve(name);
      const prev = before.get(name);
      if (prev === undefined || (Object.is(prev.value, after.value) && prev.found === after.found)) {
        continue;
      }
      this.emit(name, after);
    }
  }

  resolved(name: string): unknown {
    const resolution = this.resolve(name);
    return resolution.found ? resolution.value : undefined;
  }

  watch(name: string, cb: (change: PropertyChangeDetail) => void): () => void {
    const subscription = this.emitter.event((change) => {
      if (change.name === name) cb(change);
    });
    return () => subscription.dispose();
  }

  dispose(): void {
    this.emitter.dispose();
    this.definitions.clear();
    this.layers.clear();
    this.overrides.clear();
  }

  private register(definition: PropertyDefinition<unknown>): void {
    if (!this.definitions.has(definition.name)) {
      this.definitions.set(definition.name, definition);
    }
  }

  private resolve(name: string): Resolution {
    if (this.overrides.has(name)) {
      const underlying = this.resolveLayer(name);
      return {
        found: true,
        value: this.overrides.get(name),
        source: underlying.source,
        overridden: true,
      };
    }
    return this.resolveLayer(name);
  }

  private resolveLayer(name: string): Resolution {
    for (const layer of RESOURCE_LAYER_PRECEDENCE) {
      const values = this.layers.get(layer);
      if (values !== undefined && values.has(name)) {
        return { found: true, value: values.get(name), source: layer, overridden: false };
      }
    }
    const definition = this.definitions.get(name);
    if (definition !== undefined) {
      return { found: true, value: definition.defaultValue, source: "default", overridden: false };
    }
    return { found: false, value: undefined, source: "default", overridden: false };
  }

  private emit(name: string, resolution: Resolution): void {
    this.emitter.fire({
      name,
      value: resolution.value,
      source: resolution.source,
      overridden: resolution.overridden,
    });
  }
}
