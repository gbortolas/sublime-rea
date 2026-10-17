import { describe, expect, it } from "vitest";
import type { DocumentHandle } from "../../shared";
import {
  DocumentIoError,
  DocumentRegistryImpl,
  FileSystemUnavailableError,
  UnknownDocumentError,
  type FileSystem,
} from "./registry";

class FakeFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
}

describe("DocumentRegistryImpl", () => {
  it("cria documento em memória e resolve o handle", () => {
    const registry = new DocumentRegistryImpl();
    const buffer = registry.create("file:///a.txt", "conteúdo");

    expect(buffer.text()).toBe("conteúdo");
    expect(registry.isValid(buffer.handle)).toBe(true);
    expect(registry.resolve(buffer.handle)).toBe(buffer);
    expect(registry.get(buffer.handle)?.uri).toBe("file:///a.txt");
    expect(registry.get(buffer.handle)?.dirty).toBe(false);
    expect(registry.resolve(999 as DocumentHandle)).toBeUndefined();
  });

  it("invalida o handle antigo e não deixa ABA ao reciclar o slot (DEC-TR-1)", () => {
    const registry = new DocumentRegistryImpl();
    const first = registry.create("file:///a.txt");
    const staleHandle = first.handle;

    registry.dispose(staleHandle);
    expect(registry.isValid(staleHandle)).toBe(false);
    expect(registry.resolve(staleHandle)).toBeUndefined();
    expect(registry.get(staleHandle)).toBeUndefined();

    const second = registry.create("file:///b.txt");
    expect(second.handle).not.toBe(staleHandle);
    expect(registry.isValid(second.handle)).toBe(true);
    expect(registry.isValid(staleHandle)).toBe(false);
    expect(registry.resolve(staleHandle)).toBeUndefined();
    expect(registry.resolve(second.handle)).toBe(second);
    expect(second.text()).toBe("");
  });

  it("emite onDidChange ao criar, abrir e descartar", async () => {
    const fs = new FakeFileSystem();
    fs.write("/tmp/nota.txt", "linha\n");
    const registry = new DocumentRegistryImpl(fs);

    const seen: DocumentHandle[] = [];
    const sub = registry.onDidChange((handle) => seen.push(handle));

    const created = registry.create("file:///mem.txt");
    const opened = await registry.open("/tmp/nota.txt");
    registry.dispose(created.handle);

    expect(seen).toEqual([created.handle, opened, created.handle]);
    sub.dispose();
  });

  it("abre do disco pelo port injetado e reusa o handle na reabertura", async () => {
    const fs = new FakeFileSystem();
    fs.write("/tmp/poema.txt", "rosa\nverde\n");
    const registry = new DocumentRegistryImpl(fs);

    const handle = await registry.open("/tmp/poema.txt");
    const buffer = registry.resolve(handle);
    expect(buffer?.text()).toBe("rosa\nverde\n");
    expect(buffer?.lineCount()).toBe(3);

    const again = await registry.open("/tmp/poema.txt");
    expect(again).toBe(handle);

    await registry.close(handle);
    expect(registry.isValid(handle)).toBe(false);
  });

  it("rejeita open sem port e propaga erro de I/O tipado", async () => {
    const withoutPort = new DocumentRegistryImpl();
    await expect(withoutPort.open("/tmp/x")).rejects.toBeInstanceOf(FileSystemUnavailableError);

    const registry = new DocumentRegistryImpl(new FakeFileSystem());
    await expect(registry.open("/tmp/ausente")).rejects.toBeInstanceOf(DocumentIoError);
  });

  it("fechar handle inválido é erro alto, descartar é idempotente", async () => {
    const registry = new DocumentRegistryImpl();
    const buffer = registry.create("file:///a.txt");
    registry.dispose(buffer.handle);

    await expect(registry.close(buffer.handle)).rejects.toBeInstanceOf(UnknownDocumentError);
    registry.dispose(buffer.handle); // não lança
    expect(registry.isValid(buffer.handle)).toBe(false);
  });

  it("a façade observável do buffer funciona através do registry", () => {
    const registry = new DocumentRegistryImpl();
    const buffer = registry.create("file:///a.txt", "abc");

    const revisions: number[] = [];
    buffer.onDidChange((event) => revisions.push(event.revision));

    buffer.apply({ from: 0, removed: "", inserted: ">> " }, "plugin");
    expect(buffer.text()).toBe(">> abc");
    expect(buffer.revision).toBe(2);
    expect(revisions).toEqual([2]);
  });
});
