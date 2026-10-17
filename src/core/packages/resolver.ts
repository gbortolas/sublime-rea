/**
 * Scribe — `PackageResolver`: namespace lógico `packages://<Pkg>/<path>` em camadas.
 *
 * Fonte: `docs/architecture/05-empacotamento-e-recursos.md` (DEC-PKG-1..12) e
 * `docs/architecture/06-padroes-transversais.md` (§8, DEC-TR-6).
 *
 * Decisões nossas (não observadas no alvo), onde o doc deixava em aberto:
 * - **`kind` só existe para extensões conhecidas** (`PKG-E5`); arquivo sem extensão mapeada é
 *   **ignorado** no índice (a união `ResourceKind` é fechada, sem "outro").
 * - **`hidden` normaliza o prefixo `.hidden-`** (nome do pacote ou do arquivo). O `hidden: true`
 *   *dentro* do YAML exigiria ler o conteúdo no build; fica de fora do índice (`[DESCONHECIDO]`,
 *   consumido depois via conteúdo).
 * - **Plataforma por sufixo do nome do arquivo** ` (Linux)`/` (OSX)`/` (Windows)`, case-insensitive;
 *   variantes de outra plataforma são excluídas da resolução e a variante da plataforma corrente
 *   vence o arquivo neutro (DEC-PKG-6).
 * - `build()` é **atômico**: indexa em memória e só troca o índice no fim; falha de varredura
 *   preserva o índice anterior. `dispose()` devolve um `Disposable` já consumido (o contrato pede
 *   `Disposable`, não `void`).
 * - O `FileSystemResourceScanner` mantém os ZIPs abertos em memória após o `build` (pacotes são
 *   pequenos; evita reabrir no `load`).
 *
 * Clean-room: nada aqui deriva de código do alvo — só do contrato abstrato de `05`/`06`.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import {
  DEFAULT_MAX_RESOURCE_SIZE,
  Emitter,
  RESOURCE_LAYER_PRECEDENCE,
  ResourceNotFoundError,
  ResourceTooLargeError,
  packagesUri,
  parseResourceUri,
  toDisposable,
} from "../../shared";
import type {
  Disposable,
  Event,
  PackageResolver,
  ResourceEntry,
  ResourceKind,
  ResourceLayer,
  ResourcePlatform,
  ResourceUri,
} from "../../shared";
import { compileGlob } from "./glob";
import { UnsupportedArchiveError, ZipArchive } from "./zip";

const PACKAGE_SUFFIX = ".sublime-package";
const HIDDEN_PREFIX = ".hidden-";

/** Extensão → papel do recurso (DEC-PKG-2; `.py`/JS → `extension`, DEC-PKG-11). */
const KIND_RULES: readonly (readonly [string, ResourceKind])[] = [
  [".sublime-syntax", "syntax"],
  [".tmlanguage", "syntax"],
  [".sublime-settings", "settings"],
  [".tmpreferences", "settings"],
  [".sublime-keymap", "keymap"],
  [".sublime-mousemap", "mousemap"],
  [".sublime-menu", "menu"],
  [".sublime-macro", "macro"],
  [".sublime-snippet", "snippet"],
  [".sublime-completions", "completions"],
  [".sublime-build", "build"],
  [".sublime-theme", "theme"],
  [".sublime-color-scheme", "color-scheme"],
  [".tmtheme", "theme"],
  [".png", "image"],
  [".py", "extension"],
  [".js", "extension"],
  [".mjs", "extension"],
  [".cjs", "extension"],
];

/** Deriva o papel do recurso pela extensão do nome (case-insensitive). `undefined` = ignorar. */
export function resourceKindForFilename(filename: string): ResourceKind | undefined {
  return matchKind(filename)?.kind;
}

function matchKind(filename: string): { readonly kind: ResourceKind; readonly extension: string } | undefined {
  const lower = filename.toLowerCase();
  for (const rule of KIND_RULES) {
    if (lower.endsWith(rule[0])) {
      return { kind: rule[1], extension: filename.slice(filename.length - rule[0].length) };
    }
  }
  return undefined;
}

const PLATFORM_SUFFIX = / \((linux|osx|windows)\)$/i;

interface SplitName {
  readonly basePath: string;
  readonly platform?: ResourcePlatform;
}

/**
 * Remove o sufixo de plataforma do **stem** (nome sem extensão) do último segmento:
 * `Key (Linux).sublime-keymap` → `Key.sublime-keymap` + `linux`.
 */
function splitPlatform(p: string): SplitName {
  const slash = p.lastIndexOf("/");
  const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const matched = matchKind(name);
  if (matched === undefined) return { basePath: p };
  const stem = name.slice(0, name.length - matched.extension.length);
  const match = PLATFORM_SUFFIX.exec(stem);
  if (match === null) return { basePath: p };
  const suffix = match[1] ?? "";
  const platform = suffix.toLowerCase() as ResourcePlatform;
  return { basePath: dir + stem.slice(0, match.index) + matched.extension, platform };
}

function toResourcePlatform(platform: NodeJS.Platform): ResourcePlatform {
  switch (platform) {
    case "darwin":
      return "osx";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * Recurso descoberto pela varredura, antes de virar entrada de índice.
 * `handle` é **opaco** para o resolver; só o scanner sabe lê-lo.
 */
export interface ScannedResource {
  readonly packageName: string;
  readonly layer: ResourceLayer;
  readonly path: string;
  readonly size: number;
  readonly handle: unknown;
}

/** Porta de I/O do `PackageResolver`: varredura + leitura por handle (DEC-PKG-4, `build` = único I/O). */
export interface ResourceScanner {
  scan(roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<readonly ScannedResource[]>;
  load(handle: unknown): Promise<Uint8Array>;
}

type ResourceHandle =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "zip"; readonly zipPath: string; readonly entryName: string };

function isResourceHandle(value: unknown): value is ResourceHandle {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "file") return typeof (value as { path?: unknown }).path === "string";
  if (kind === "zip") {
    const zipPath = (value as { zipPath?: unknown }).zipPath;
    const entryName = (value as { entryName?: unknown }).entryName;
    return typeof zipPath === "string" && typeof entryName === "string";
  }
  return false;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

interface WalkedFile {
  readonly relPath: string;
  readonly fullPath: string;
  readonly size: number;
}

/**
 * Scanner de produção: pastas planas (`packages/<Nome>/…`, dev) e `<Nome>.sublime-package` (ZIP).
 * Só as **raízes** vêm do `build`; nada de caminho físico escapa do resolvedor (DEC-PKG-1).
 */
export class FileSystemResourceScanner implements ResourceScanner {
  private readonly archives = new Map<string, ZipArchive>();

  async scan(roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<readonly ScannedResource[]> {
    const out: ScannedResource[] = [];
    for (const layer of Object.keys(roots) as ResourceLayer[]) {
      const dirs = roots[layer];
      if (dirs === undefined) continue;
      for (const root of dirs) {
        await this.scanRoot(root, layer, out);
      }
    }
    return out;
  }

  async load(handle: unknown): Promise<Uint8Array> {
    if (!isResourceHandle(handle)) {
      throw new UnsupportedArchiveError("handle de recurso inválido");
    }
    if (handle.kind === "file") {
      return new Uint8Array(await readFile(handle.path));
    }
    let archive = this.archives.get(handle.zipPath);
    if (archive === undefined) {
      archive = ZipArchive.open(new Uint8Array(await readFile(handle.zipPath)));
      this.archives.set(handle.zipPath, archive);
    }
    const data = archive.read(handle.entryName);
    if (data === undefined) {
      throw new ResourceNotFoundError(`${handle.zipPath}#${handle.entryName}`);
    }
    return data;
  }

  private async scanRoot(root: string, layer: ResourceLayer, out: ScannedResource[]): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return; // raiz ausente: a camada simplesmente não contribui
      throw err;
    }
    for (const dirent of dirents) {
      const fullPath = path.join(root, dirent.name);
      if (dirent.isDirectory()) {
        await this.scanPackageDir(dirent.name, fullPath, layer, out);
      } else if (dirent.isFile() && dirent.name.endsWith(PACKAGE_SUFFIX)) {
        await this.scanPackageZip(dirent.name.slice(0, -PACKAGE_SUFFIX.length), fullPath, layer, out);
      }
    }
  }

  private async scanPackageDir(
    packageName: string,
    dir: string,
    layer: ResourceLayer,
    out: ScannedResource[],
  ): Promise<void> {
    for (const file of await this.walk(dir, "")) {
      out.push({
        packageName,
        layer,
        path: file.relPath,
        size: file.size,
        handle: { kind: "file", path: file.fullPath } satisfies ResourceHandle,
      });
    }
  }

  private async scanPackageZip(
    packageName: string,
    zipPath: string,
    layer: ResourceLayer,
    out: ScannedResource[],
  ): Promise<void> {
    const archive = ZipArchive.open(new Uint8Array(await readFile(zipPath)));
    this.archives.set(zipPath, archive);
    for (const entry of archive.entries) {
      if (entry.isDirectory) continue;
      out.push({
        packageName,
        layer,
        path: entry.name,
        size: entry.size,
        handle: { kind: "zip", zipPath, entryName: entry.name } satisfies ResourceHandle,
      });
    }
  }

  private async walk(dir: string, prefix: string): Promise<WalkedFile[]> {
    const result: WalkedFile[] = [];
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      const relPath = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        result.push(...(await this.walk(fullPath, relPath)));
      } else if (dirent.isFile()) {
        result.push({ relPath, fullPath, size: (await stat(fullPath)).size });
      }
    }
    return result;
  }
}

interface IndexedEntry {
  readonly entry: ResourceEntry;
  readonly logicalUri: ResourceUri;
  readonly handle: unknown;
}

export interface PackageResolverOptions {
  /** Scanner injetado (teste com fake, ou `FileSystemResourceScanner` em produção). */
  readonly scanner?: ResourceScanner;
  /** Plataforma corrente injetável (default `process.platform`) — DEC-PKG-6. */
  readonly platform?: NodeJS.Platform;
}

/** Implementação do `PackageResolver`: índice em memória + precedência `user > app > os`. */
export class PackageResolverImpl implements PackageResolver {
  private readonly scanner: ResourceScanner;
  private readonly currentPlatform: ResourcePlatform;
  private readonly buildEmitter = new Emitter<void>();
  private byUri = new Map<ResourceUri, IndexedEntry>();
  private byLogical = new Map<string, IndexedEntry[]>();
  private building: Promise<void> | undefined;
  private builtFlag = false;
  private disposed = false;

  readonly onDidBuild: Event<void>;

  constructor(options: PackageResolverOptions = {}) {
    this.scanner = options.scanner ?? new FileSystemResourceScanner();
    this.currentPlatform = toResourcePlatform(options.platform ?? process.platform);
    this.onDidBuild = this.buildEmitter.event;
  }

  get isBuilt(): boolean {
    return this.builtFlag;
  }

  build(roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new UnsupportedArchiveError("PackageResolver já descartado"));
    }
    if (this.building !== undefined) return this.building;
    const inFlight = this.rebuild(roots).finally(() => {
      this.building = undefined;
    });
    this.building = inFlight;
    return inFlight;
  }

  resolve(uri: ResourceUri): ResourceEntry | undefined {
    return this.resolveIndexed(uri)?.entry;
  }

  find(pattern: string): ResourceEntry[] {
    const matcher = compileGlob(pattern);
    const seen = new Set<ResourceUri>();
    const out: ResourceEntry[] = [];
    for (const indexed of this.byUri.values()) {
      if (!matcher.test(matchKey(indexed.entry))) continue;
      const winner = this.resolveIndexed(indexed.entry.uri);
      if (winner === undefined || seen.has(winner.entry.uri)) continue;
      seen.add(winner.entry.uri);
      out.push(winner.entry);
    }
    return out;
  }

  byKind(kind: ResourceKind): ResourceEntry[] {
    const seen = new Set<ResourceUri>();
    const out: ResourceEntry[] = [];
    for (const indexed of this.byUri.values()) {
      if (indexed.entry.kind !== kind) continue;
      const winner = this.resolveIndexed(indexed.entry.uri);
      if (winner === undefined || seen.has(winner.entry.uri)) continue;
      seen.add(winner.entry.uri);
      out.push(winner.entry);
    }
    return out;
  }

  layersFor(uri: ResourceUri): ResourceEntry[] {
    return this.rankedCandidates(uri).map((indexed) => indexed.entry);
  }

  async load(uri: ResourceUri, opts?: { readonly maxSize?: number }): Promise<Uint8Array> {
    const indexed = this.resolveIndexed(uri);
    if (indexed === undefined) {
      throw new ResourceNotFoundError(uri);
    }
    const maxSize = opts?.maxSize ?? DEFAULT_MAX_RESOURCE_SIZE;
    if (indexed.entry.size > maxSize) {
      throw new ResourceTooLargeError(uri, indexed.entry.size, maxSize);
    }
    const data = await this.scanner.load(indexed.handle);
    if (data.byteLength > maxSize) {
      throw new ResourceTooLargeError(uri, data.byteLength, maxSize);
    }
    return data;
  }

  dispose(): Disposable {
    this.disposed = true;
    this.buildEmitter.dispose();
    this.byUri.clear();
    this.byLogical.clear();
    this.builtFlag = false;
    return toDisposable(() => {
      /* já descartado */
    });
  }

  private async rebuild(roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<void> {
    const scanned = await this.scanner.scan(roots);
    const byUri = new Map<ResourceUri, IndexedEntry>();
    const byLogical = new Map<string, IndexedEntry[]>();
    for (const resource of scanned) {
      const indexed = this.indexOne(resource);
      if (indexed === undefined) continue;
      byUri.set(indexed.entry.uri, indexed);
      const list = byLogical.get(indexed.logicalUri);
      if (list === undefined) {
        byLogical.set(indexed.logicalUri, [indexed]);
      } else {
        list.push(indexed);
      }
    }
    this.byUri = byUri;
    this.byLogical = byLogical;
    this.builtFlag = true;
    this.buildEmitter.fire(undefined);
  }

  private indexOne(resource: ScannedResource): IndexedEntry | undefined {
    const slash = resource.path.lastIndexOf("/");
    const filename = slash >= 0 ? resource.path.slice(slash + 1) : resource.path;
    const kind = resourceKindForFilename(filename);
    if (kind === undefined) return undefined;
    const split = splitPlatform(resource.path);
    const hidden = resource.packageName.startsWith(HIDDEN_PREFIX) || filename.startsWith(HIDDEN_PREFIX);
    const entry: ResourceEntry = {
      uri: packagesUri(resource.packageName, resource.path),
      packageName: resource.packageName,
      layer: resource.layer,
      kind,
      size: resource.size,
      hidden,
      ...(split.platform !== undefined ? { platform: split.platform } : {}),
    };
    return {
      entry,
      logicalUri: packagesUri(resource.packageName, split.basePath),
      handle: resource.handle,
    };
  }

  private resolveIndexed(uri: ResourceUri): IndexedEntry | undefined {
    return this.rankedCandidates(uri)[0];
  }

  private rankedCandidates(uri: ResourceUri): IndexedEntry[] {
    let logical: ResourceUri;
    try {
      logical = this.logicalUriOf(uri);
    } catch (err) {
      if (err instanceof ResourceNotFoundError) return [];
      throw err;
    }
    const candidates = this.byLogical.get(logical);
    if (candidates === undefined) return [];
    const active = candidates.filter(
      (candidate) =>
        candidate.entry.platform === undefined || candidate.entry.platform === this.currentPlatform,
    );
    return active.sort((a, b) => {
      const layerDelta =
        RESOURCE_LAYER_PRECEDENCE.indexOf(a.entry.layer) - RESOURCE_LAYER_PRECEDENCE.indexOf(b.entry.layer);
      if (layerDelta !== 0) return layerDelta;
      const aMatch = a.entry.platform === this.currentPlatform ? 0 : 1;
      const bMatch = b.entry.platform === this.currentPlatform ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  private logicalUriOf(uri: ResourceUri): ResourceUri {
    const { packageName, path: inner } = parseResourceUri(uri);
    return packagesUri(packageName, splitPlatform(inner).basePath);
  }
}

function matchKey(entry: ResourceEntry): string {
  return `${entry.packageName}/${parseResourceUri(entry.uri).path}`;
}
