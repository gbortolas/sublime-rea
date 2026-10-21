import { describe, expect, it } from "vitest";

import type { ResourceLayer } from "../../shared";
import { PackageResolverImpl } from "./resolver";
import type { ResourceScanner, ScannedResource } from "./resolver";
import { collectPackageSnippets, parseSnippetFile } from "./package-snippets";

interface FakeResource {
  readonly packageName: string;
  readonly layer: ResourceLayer;
  readonly path: string;
  readonly content: string;
}

class FakeScanner implements ResourceScanner {
  private readonly byHandle = new Map<unknown, Uint8Array>();

  constructor(private readonly resources: readonly FakeResource[]) {}

  async scan(_roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<readonly ScannedResource[]> {
    return this.resources.map((resource) => {
      const data = new TextEncoder().encode(resource.content);
      this.byHandle.set(data, data);
      return {
        packageName: resource.packageName,
        layer: resource.layer,
        path: resource.path,
        size: data.byteLength,
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

/** Resolver de mentira com os recursos dados (a varredura é o que importa aqui). */
async function resolverWith(resources: readonly FakeResource[]): Promise<PackageResolverImpl> {
  const resolver = new PackageResolverImpl({ scanner: new FakeScanner(resources), platform: "linux" });
  await resolver.build({ os: ["/os"], app: ["/app"], user: ["/user"] });
  return resolver;
}

/** Coleta sem poluir a saída do teste (os avisos são verificados à parte). */
function collectSilently(
  resolver: PackageResolverImpl,
  options: Parameters<typeof collectPackageSnippets>[1] = {},
): Promise<readonly { trigger: string; body: string; description?: string; source: string }[]> {
  return collectPackageSnippets(resolver, { warn: () => undefined, ...options });
}

describe("parseSnippetFile — arquivo .sublime-snippet", () => {
  it("lê prefix + body (string) + description", () => {
    const parsed = parseSnippetFile(
      JSON.stringify({ prefix: "for", body: "for (;;) {}", description: "loop" }),
      "packages://P/snippets/for.sublime-snippet",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definitions).toEqual([
      {
        trigger: "for",
        body: "for (;;) {}",
        description: "loop",
        source: "packages://P/snippets/for.sublime-snippet",
      },
    ]);
  });

  it("junta o body em array com '\\n'", () => {
    const parsed = parseSnippetFile(
      JSON.stringify({ prefix: "for", body: ["for (let ${1:i} = 0; $1 < $2; $1++) {", "  $0", "}"] }),
      "packages://P/snippets/for.sublime-snippet",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definitions[0]?.body).toBe("for (let ${1:i} = 0; $1 < $2; $1++) {\n  $0\n}");
  });

  it("prefix em array vira uma definição por prefixo", () => {
    const parsed = parseSnippetFile(
      JSON.stringify({ prefix: ["for", "fori"], body: "x" }),
      "packages://P/snippets/loops.sublime-snippet",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definitions.map((d) => d.trigger)).toEqual(["for", "fori"]);
    expect(parsed.definitions.every((d) => d.body === "x")).toBe(true);
  });

  it("ignora JSON quebrado, sem prefix e sem body (motivo no `reason`)", () => {
    const broken = parseSnippetFile("{ nao é json", "packages://P/snippets/a.sublime-snippet");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toContain("JSON inválido");

    const noPrefix = parseSnippetFile(JSON.stringify({ body: "x" }), "packages://P/snippets/a.sublime-snippet");
    expect(noPrefix.ok).toBe(false);
    if (!noPrefix.ok) expect(noPrefix.reason).toContain("prefix");

    const noBody = parseSnippetFile(JSON.stringify({ prefix: "a" }), "packages://P/snippets/a.sublime-snippet");
    expect(noBody.ok).toBe(false);
    if (!noBody.ok) expect(noBody.reason).toContain("body");

    const notObject = parseSnippetFile("[1,2,3]", "packages://P/snippets/a.sublime-snippet");
    expect(notObject.ok).toBe(false);
  });
});

describe("collectPackageSnippets — leitura dos pacotes", () => {
  it("lê os snippets de um pacote (string e array no body)", async () => {
    const resolver = await resolverWith([
      {
        packageName: "MyPkg",
        layer: "app",
        path: "snippets/for.sublime-snippet",
        content: JSON.stringify({ prefix: "for", body: ["for (;;) {", "  $0", "}"] }),
      },
      {
        packageName: "MyPkg",
        layer: "app",
        path: "snippets/loops.sublime-snippet",
        content: JSON.stringify({ prefix: ["loop", "lp"], body: "while (${1:cond}) { $0 }" }),
      },
    ]);
    const snippets = await collectSilently(resolver);
    expect(snippets.map((s) => s.trigger).sort()).toEqual(["for", "loop", "lp"]);
    const forSnippet = snippets.find((s) => s.trigger === "for");
    expect(forSnippet?.body).toBe("for (;;) {\n  $0\n}");
    expect(forSnippet?.source).toBe("packages://MyPkg/snippets/for.sublime-snippet");
  });

  it("ignora arquivo inválido com warn (sem crash) e segue com os válidos", async () => {
    const resolver = await resolverWith([
      { packageName: "MyPkg", layer: "app", path: "snippets/broken.sublime-snippet", content: "{ nao é json" },
      { packageName: "MyPkg", layer: "app", path: "snippets/ok.sublime-snippet", content: JSON.stringify({ prefix: "ok", body: "x" }) },
    ]);
    const warnings: string[] = [];
    const snippets = await collectPackageSnippets(resolver, { warn: (m) => warnings.push(m) });
    expect(snippets.map((s) => s.trigger)).toEqual(["ok"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken.sublime-snippet");
  });

  it("precedência de camada: user > app > os no mesmo trigger", async () => {
    const resolver = await resolverWith([
      { packageName: "A", layer: "os", path: "snippets/x.sublime-snippet", content: JSON.stringify({ prefix: "dup", body: "os" }) },
      { packageName: "B", layer: "app", path: "snippets/y.sublime-snippet", content: JSON.stringify({ prefix: "dup", body: "app" }) },
      { packageName: "C", layer: "user", path: "snippets/z.sublime-snippet", content: JSON.stringify({ prefix: "dup", body: "user" }) },
    ]);
    const snippets = await collectSilently(resolver);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.body).toBe("user");
    expect(snippets[0]?.source).toBe("packages://C/snippets/z.sublime-snippet");
  });

  it("override de arquivo: a camada user substitui o app no MESMO caminho", async () => {
    const resolver = await resolverWith([
      { packageName: "A", layer: "app", path: "snippets/x.sublime-snippet", content: JSON.stringify({ prefix: "old", body: "app" }) },
      { packageName: "A", layer: "user", path: "snippets/x.sublime-snippet", content: JSON.stringify({ prefix: "new", body: "user" }) },
    ]);
    const snippets = await collectSilently(resolver);
    expect(snippets.map((s) => s.trigger)).toEqual(["new"]);
  });

  it("teto de definições: o excedente é ignorado com warn", async () => {
    const resources: FakeResource[] = [];
    for (let i = 0; i < 5; i++) {
      resources.push({
        packageName: "A",
        layer: "app",
        path: `snippets/s${i}.sublime-snippet`,
        content: JSON.stringify({ prefix: `t${i}`, body: "x" }),
      });
    }
    const resolver = await resolverWith(resources);
    const warnings: string[] = [];
    const snippets = await collectPackageSnippets(resolver, {
      maxDefinitions: 3,
      warn: (m) => warnings.push(m),
    });
    expect(snippets).toHaveLength(3);
    expect(warnings.some((w) => w.includes("teto"))).toBe(true);
  });

  it("teto do corpo: snippet acima do limite é ignorado com warn", async () => {
    const big = "x".repeat(200);
    const resolver = await resolverWith([
      { packageName: "A", layer: "app", path: "snippets/big.sublime-snippet", content: JSON.stringify({ prefix: "big", body: big }) },
      { packageName: "A", layer: "app", path: "snippets/small.sublime-snippet", content: JSON.stringify({ prefix: "small", body: "y" }) },
    ]);
    const warnings: string[] = [];
    const snippets = await collectPackageSnippets(resolver, {
      maxBodyBytes: 100,
      warn: (m) => warnings.push(m),
    });
    expect(snippets.map((s) => s.trigger)).toEqual(["small"]);
    expect(warnings.some((w) => w.includes("corpo acima"))).toBe(true);
  });

  it("pacote sem snippets devolve lista vazia", async () => {
    const resolver = await resolverWith([
      { packageName: "A", layer: "app", path: "syntaxes/x.sublime-syntax", content: "{}" },
    ]);
    expect(await collectSilently(resolver)).toEqual([]);
  });
});
