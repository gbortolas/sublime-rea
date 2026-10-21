/**
 * Scribe — cache dos snippets de pacote (achado BAIXO da auditoria com runtime).
 *
 * **O bug:** o cache guardava a **promise**; se ela **rejeitasse**, todo `snippets.list`
 * posterior recebia a **mesma** rejeição (o cache nunca era invalidado) ⇒ o app ficava sem
 * snippets **para sempre**.
 *
 * **A correção:** na rejeição, a entrada é **evictida** (o erro é devolvido só uma vez; a
 * próxima chamada tenta de novo).
 */
import { describe, expect, it } from "vitest";

import { packageSnippetsFor } from "../src/main/index";
import type { PackageSnippetSource } from "../src/main/index";
import { Emitter } from "../src/shared/events";
import type {
  Disposable,
  PackageResolver,
  ResourceEntry,
  ResourceKind,
  ResourceLayer,
  ResourceUri,
} from "../src/shared";

/** Resolvedor fake: a 1ª leitura de `byKind` falha (o resto é vazio). */
class FlakyResolver implements PackageResolver {
  readonly emitter = new Emitter<void>();
  readonly onDidBuild = this.emitter.event;
  readonly isBuilt = true;
  reads = 0;

  byKind(_kind: ResourceKind): ResourceEntry[] {
    this.reads += 1;
    if (this.reads === 1) throw new Error("índice de pacotes indisponível");
    return [];
  }

  build(_roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<void> {
    return Promise.resolve();
  }

  resolve(_uri: ResourceUri): ResourceEntry | undefined {
    return undefined;
  }

  find(_pattern: string): ResourceEntry[] {
    return [];
  }

  load(_uri: ResourceUri, _opts?: { readonly maxSize?: number }): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  layersFor(_uri: ResourceUri): ResourceEntry[] {
    return [];
  }

  dispose(): Disposable {
    return {
      dispose: (): void => {
        this.emitter.dispose();
      },
    };
  }
}

describe("main — cache dos snippets de pacote", () => {
  it("evicta a promise rejeitada (a 2ª chamada tenta de novo)", async () => {
    const packages = new FlakyResolver();
    const source: PackageSnippetSource = {
      packagesReady: Promise.resolve(),
      packages,
    };

    // 1ª chamada: falha (o erro é devolvido **uma vez**).
    await expect(packageSnippetsFor(source)).rejects.toThrow("índice de pacotes indisponível");

    // 2ª chamada: o cache foi evictido ⇒ nova leitura (que agora funciona).
    await expect(packageSnippetsFor(source)).resolves.toEqual([]);
    expect(packages.reads).toBe(2);
  });

  it("cacheia o resultado bem-sucedido (a 2ª chamada não relê)", async () => {
    const packages = new FlakyResolver();
    packages.reads = 1; // a 1ª leitura passa (falha só na 1ª de todo)
    const source: PackageSnippetSource = {
      packagesReady: Promise.resolve(),
      packages,
    };

    await expect(packageSnippetsFor(source)).resolves.toEqual([]);
    const before = packages.reads;
    await expect(packageSnippetsFor(source)).resolves.toEqual([]);
    expect(packages.reads).toBe(before);
  });
});
