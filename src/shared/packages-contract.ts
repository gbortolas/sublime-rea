/**
 * Scribe — contratos de fronteira: recursos empacotados e namespace lógico.
 *
 * Fonte: `docs/architecture/05-empacotamento-e-recursos.md` (DEC-PKG-1..12).
 *
 * Reconciliação: `06:330` lista `['platform','installed','packages','user']` e `05:205` lista
 * `"os" | "app" | "user"`. **Canônico = `05`** (o doc dono do módulo): `os` (base do app),
 * `app` (pacotes instalados/embutidos) e `user` (do usuário). A lista de `06` é vocabulário
 * *conceitual* de precedência; o mapeamento está em `RESOURCE_LAYER_PRECEDENCE`.
 *
 * Invariantes (DEC-PKG-1/2/6): nada acessa caminho físico — a única porta é `packages://<Pkg>/<path>`;
 * o índice é varrido **uma vez** (no `TaskPool`) e vive em memória; `resolve` devolve a
 * **vencedora**, `layersFor` devolve a **cadeia completa** (insumo do `PropertySystem`).
 */
import type { Disposable } from "./disposable";
import type { Event } from "./events";

/** Único namespace de recursos (DEC-PKG-1). `packages://Default/Default.sublime-keymap` */
export type ResourceUri = `packages://${string}`;

/** Camadas, do mais baixo para o mais alto na ordem de *build*. */
export type ResourceLayer = "os" | "app" | "user";

/** Precedência (DEC-PKG-3): **primeiro vence**. Maior precedência primeiro. */
export const RESOURCE_LAYER_PRECEDENCE = ["user", "app", "os"] as const satisfies readonly ResourceLayer[];

/** Papel do recurso é definido pela **extensão**, não por manifesto (PKG-E7). */
export type ResourceKind =
  | "syntax"
  | "settings"
  | "keymap"
  | "mousemap"
  | "menu"
  | "macro"
  | "snippet"
  | "completions"
  | "build"
  | "theme"
  | "color-scheme"
  | "image"
  | "extension";

export type ResourcePlatform = "linux" | "osx" | "windows";

export interface ResourceEntry {
  readonly uri: ResourceUri;
  /** Pacote lógico (o `<Nome>` de `<Nome>.sublime-package`). */
  readonly packageName: string;
  readonly layer: ResourceLayer;
  readonly kind: ResourceKind;
  readonly size: number;
  /** Normalizado: ocultos de todos os SOs aparecem ocultos (DEC-PKG-6). */
  readonly hidden: boolean;
  readonly platform?: ResourcePlatform;
}

export class ResourceNotFoundError extends Error {
  readonly uri: string;

  constructor(uri: string) {
    super(`ResourceNotFoundError: ${uri}`);
    this.name = "ResourceNotFoundError";
    this.uri = uri;
  }
}

export class ResourceTooLargeError extends Error {
  readonly uri: string;
  readonly size: number;
  readonly maxSize: number;

  constructor(uri: string, size: number, maxSize: number) {
    super(`ResourceTooLargeError: ${uri} (${size} B > ${maxSize} B)`);
    this.name = "ResourceTooLargeError";
    this.uri = uri;
    this.size = size;
    this.maxSize = maxSize;
  }
}

export class ResourceIsDirectoryError extends Error {
  readonly uri: string;

  constructor(uri: string) {
    super(`ResourceIsDirectoryError: ${uri}`);
    this.name = "ResourceIsDirectoryError";
    this.uri = uri;
  }
}

/** Teto default de leitura (DEC-PKG-7): ~16 MiB. */
export const DEFAULT_MAX_RESOURCE_SIZE = 16 * 1024 * 1024;

/**
 * Resolutor de recursos: índice em memória + precedência por camada.
 * `build()` é a única operação com I/O (varredura), e roda no `TaskPool` (DEC-PKG-4).
 */
export interface PackageResolver {
  build(roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<void>;
  /** Vencedora pelo namespace (menor índice em `RESOURCE_LAYER_PRECEDENCE`). */
  resolve(uri: ResourceUri): ResourceEntry | undefined;
  /** Busca por glob simples (ex.: `**` `/.sublime-syntax` ou `*` `/Default.sublime-keymap`). */
  find(pattern: string): ResourceEntry[];
  load(uri: ResourceUri, opts?: { readonly maxSize?: number }): Promise<Uint8Array>;
  byKind(kind: ResourceKind): ResourceEntry[];
  /** Cadeia completa da maior para a menor precedência — alimenta o merge de propriedades. */
  layersFor(uri: ResourceUri): ResourceEntry[];
  /** `true` depois de um `build()` bem-sucedido. */
  readonly isBuilt: boolean;
  readonly onDidBuild: Event<void>;
  dispose(): Disposable;
}

/** Monta `packages://<pkg>/<path>` normalizando separadores (helper canônico). */
export function packagesUri(pkg: string, path: string): ResourceUri {
  const clean = path.replace(/^\/+/, "").replace(/\\/g, "/");
  return `packages://${pkg}/${clean}` as ResourceUri;
}

/** Decompõe um `ResourceUri`. Lança se não estiver no namespace. */
export function parseResourceUri(uri: string): { readonly packageName: string; readonly path: string } {
  if (!uri.startsWith("packages://")) {
    throw new ResourceNotFoundError(uri);
  }
  const rest = uri.slice("packages://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) {
    throw new ResourceNotFoundError(uri);
  }
  return { packageName: rest.slice(0, slash), path: rest.slice(slash + 1) };
}
