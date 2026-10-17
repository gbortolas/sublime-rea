import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import {
  ResourceNotFoundError,
  ResourceTooLargeError,
} from "../../shared";
import type { ResourceLayer, ResourceUri } from "../../shared";
import { FileSystemResourceScanner, PackageResolverImpl } from "./resolver";
import type { ResourceScanner, ScannedResource } from "./resolver";

interface FakeResource {
  readonly packageName: string;
  readonly layer: ResourceLayer;
  readonly path: string;
  readonly data?: Uint8Array;
  readonly size?: number;
}

class FakeScanner implements ResourceScanner {
  private readonly byHandle = new Map<unknown, Uint8Array>();

  constructor(private readonly resources: readonly FakeResource[]) {}

  async scan(_roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<readonly ScannedResource[]> {
    return this.resources.map((resource) => {
      const data = resource.data ?? new Uint8Array(resource.size ?? 0);
      this.byHandle.set(data, data);
      return {
        packageName: resource.packageName,
        layer: resource.layer,
        path: resource.path,
        size: resource.size ?? data.byteLength,
        handle: data,
      };
    });
  }

  async load(handle: unknown): Promise<Uint8Array> {
    const data = this.byHandle.get(handle);
    if (data === undefined) throw new Error("handle desconhecido no FakeScanner");
    return data;
  }
}

function uri(value: string): ResourceUri {
  return value as ResourceUri;
}

describe("PackageResolverImpl (scanner fake)", () => {
  it("resolve por precedência user > app > os e layersFor na ordem", async () => {
    const scanner = new FakeScanner([
      { packageName: "Default", layer: "os", path: "Default.sublime-menu", size: 1 },
      { packageName: "Default", layer: "app", path: "Default.sublime-menu", size: 2 },
      { packageName: "Default", layer: "user", path: "Default.sublime-menu", size: 3 },
    ]);
    const resolver = new PackageResolverImpl({ scanner, platform: "linux" });
    await resolver.build({ os: ["/os"], app: ["/app"], user: ["/user"] });

    expect(resolver.isBuilt).toBe(true);
    const target = uri("packages://Default/Default.sublime-menu");
    expect(resolver.resolve(target)?.layer).toBe("user");
    expect(resolver.layersFor(target).map((e) => e.layer)).toEqual(["user", "app", "os"]);
    expect(resolver.layersFor(target).map((e) => e.size)).toEqual([3, 2, 1]);
  });

  it("deriva kind por extensão e agrupa por byKind", async () => {
    const scanner = new FakeScanner([
      { packageName: "P", layer: "app", path: "A.sublime-settings", size: 1 },
      { packageName: "P", layer: "app", path: "Icon.png", size: 2 },
      { packageName: "P", layer: "app", path: "plugin.py", size: 3 },
      { packageName: "P", layer: "app", path: "README.md", size: 4 },
    ]);
    const resolver = new PackageResolverImpl({ scanner });
    await resolver.build({ app: ["/app"] });

    expect(resolver.resolve(uri("packages://P/A.sublime-settings"))?.kind).toBe("settings");
    expect(resolver.resolve(uri("packages://P/plugin.py"))?.kind).toBe("extension");
    expect(resolver.resolve(uri("packages://P/README.md"))).toBeUndefined();
    expect(resolver.byKind("image").map((e) => e.packageName)).toEqual(["P"]);
    expect(resolver.byKind("extension").map((e) => e.size)).toEqual([3]);
  });

  it("aplica sufixo de plataforma contra a plataforma injetada", async () => {
    const resources: readonly FakeResource[] = [
      { packageName: "P", layer: "app", path: "Key.sublime-keymap", size: 1 },
      { packageName: "P", layer: "app", path: "Key (Windows).sublime-keymap", size: 2 },
      { packageName: "P", layer: "app", path: "Key (Linux).sublime-keymap", size: 3 },
    ];
    const target = uri("packages://P/Key.sublime-keymap");

    const linux = new PackageResolverImpl({ scanner: new FakeScanner(resources), platform: "linux" });
    await linux.build({ app: ["/app"] });
    expect(linux.resolve(target)?.platform).toBe("linux");
    expect(linux.resolve(target)?.size).toBe(3);

    const windows = new PackageResolverImpl({ scanner: new FakeScanner(resources), platform: "win32" });
    await windows.build({ app: ["/app"] });
    expect(windows.resolve(target)?.platform).toBe("windows");
    expect(windows.resolve(target)?.size).toBe(2);

    const onlyWindows = new PackageResolverImpl({
      scanner: new FakeScanner([{ packageName: "P", layer: "app", path: "Key (Windows).sublime-keymap", size: 2 }]),
      platform: "darwin",
    });
    await onlyWindows.build({ app: ["/app"] });
    expect(onlyWindows.resolve(target)).toBeUndefined();
  });

  it("normaliza hidden pelo prefixo .hidden-", async () => {
    const scanner = new FakeScanner([
      { packageName: "P", layer: "app", path: ".hidden-Internals.sublime-settings", size: 1 },
      { packageName: ".hidden-P", layer: "app", path: "Visible.sublime-settings", size: 2 },
      { packageName: "P", layer: "app", path: "Normal.sublime-settings", size: 3 },
    ]);
    const resolver = new PackageResolverImpl({ scanner });
    await resolver.build({ app: ["/app"] });
    expect(resolver.resolve(uri("packages://P/.hidden-Internals.sublime-settings"))?.hidden).toBe(true);
    expect(resolver.resolve(uri("packages://.hidden-P/Visible.sublime-settings"))?.hidden).toBe(true);
    expect(resolver.resolve(uri("packages://P/Normal.sublime-settings"))?.hidden).toBe(false);
  });

  it("find casa por glob de nome lógico", async () => {
    const scanner = new FakeScanner([
      { packageName: "Default", layer: "app", path: "Default.sublime-keymap", size: 1 },
      { packageName: "Default", layer: "app", path: "syntaxes/Plain.sublime-syntax", size: 2 },
      { packageName: "P", layer: "app", path: "P.sublime-syntax", size: 3 },
    ]);
    const resolver = new PackageResolverImpl({ scanner });
    await resolver.build({ app: ["/app"] });
    expect(
      resolver.find("**/*.sublime-syntax").map((e) => e.uri).sort(),
    ).toEqual([uri("packages://Default/syntaxes/Plain.sublime-syntax"), uri("packages://P/P.sublime-syntax")]);
    expect(resolver.find("*/Default.sublime-keymap")).toHaveLength(1);
  });

  it("load devolve bytes e respeita maxSize", async () => {
    const data = new TextEncoder().encode("hello-resource");
    const scanner = new FakeScanner([{ packageName: "P", layer: "app", path: "R.sublime-menu", data }]);
    const resolver = new PackageResolverImpl({ scanner });
    await resolver.build({ app: ["/app"] });
    const target = uri("packages://P/R.sublime-menu");

    const bytes = await resolver.load(target);
    expect(new TextDecoder().decode(bytes)).toBe("hello-resource");
    await expect(resolver.load(target, { maxSize: 4 })).rejects.toBeInstanceOf(ResourceTooLargeError);
  });

  it("load de entrada inexistente lança ResourceNotFoundError", async () => {
    const resolver = new PackageResolverImpl({ scanner: new FakeScanner([]) });
    await resolver.build({});
    await expect(resolver.load(uri("packages://Nope/x.sublime-menu"))).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("resolve de uri fora do namespace devolve undefined", async () => {
    const resolver = new PackageResolverImpl({ scanner: new FakeScanner([]) });
    await resolver.build({});
    expect(resolver.resolve(uri("packages://sem-barra"))).toBeUndefined();
    expect(resolver.layersFor(uri("packages://sem-barra"))).toEqual([]);
  });

  it("build é idempotente e emite onDidBuild", async () => {
    const scanner = new FakeScanner([{ packageName: "P", layer: "app", path: "A.sublime-menu", size: 1 }]);
    const resolver = new PackageResolverImpl({ scanner });
    let builds = 0;
    const sub = resolver.onDidBuild(() => {
      builds += 1;
    });
    await resolver.build({ app: ["/app"] });
    await resolver.build({ app: ["/app"] });
    expect(builds).toBe(2);
    expect(resolver.resolve(uri("packages://P/A.sublime-menu"))?.kind).toBe("menu");
    sub.dispose();
    resolver.dispose().dispose();
    expect(resolver.isBuilt).toBe(false);
  });
});

describe("FileSystemResourceScanner (diretório temporário real)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scribe-pkg-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function buildPackageZip(): Buffer {
    const nameBuf = Buffer.from("Main.sublime-menu", "utf8");
    const payload = deflateRawSync(Buffer.from("[{}]"));
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(2, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(2, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 42);
    nameBuf.copy(cen, 46);
    const cd = cen;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(local.length + payload.length, 16);
    return Buffer.concat([local, payload, cd, eocd]);
  }

  it("varre pasta plana e .sublime-package e lê conteúdo", async () => {
    const packagesDir = path.join(root, "packages");
    const devPkg = path.join(packagesDir, "MyPlugin");
    mkdirSync(devPkg, { recursive: true });
    writeFileSync(path.join(devPkg, "My.sublime-settings"), "{}");
    writeFileSync(path.join(packagesDir, "Zipped.sublime-package"), buildPackageZip());

    const resolver = new PackageResolverImpl({
      scanner: new FileSystemResourceScanner(),
      platform: "linux",
    });
    await resolver.build({ app: [packagesDir] });

    expect(resolver.resolve(uri("packages://MyPlugin/My.sublime-settings"))?.kind).toBe("settings");
    const zipped = resolver.resolve(uri("packages://Zipped/Main.sublime-menu"));
    expect(zipped?.kind).toBe("menu");
    const bytes = await resolver.load(uri("packages://Zipped/Main.sublime-menu"));
    expect(new TextDecoder().decode(bytes)).toBe("[{}]");
  });
});
