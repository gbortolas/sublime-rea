/**
 * Testes de integração do `EditorCore` com o LSP.
 *
 * Foco: o popup de **Document Symbols** não pode quebrar por causa do payload do
 * servidor (achado ALTO: `flattenDocumentSymbols` lia `sym.selectionRange.start` sem
 * guarda ⇒ exceção `Cannot read properties of undefined` quando o servidor devolve a
 * forma **plana** `SymbolInformation`, com o range em `location.range`).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorCore, InvalidDocumentHandleError } from "../src/core/editor";
import { LspManager } from "../src/core/lsp";
import type { FileSystem } from "../src/core/buffer";
import type { DocumentSymbolLike } from "../src/core/lsp";

/** FS em memória + registro das escritas (para provar o "salva antes de fechar"). */
function memoryFs(files: Readonly<Record<string, string>>): {
  readonly fs: FileSystem;
  readonly writes: Map<string, string>;
} {
  const writes = new Map<string, string>();
  const fs: FileSystem = {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
    writeFile: async (path: string, data: string): Promise<void> => {
      writes.set(path, data);
    },
  };
  return { fs, writes };
}

describe("EditorCore — LSP", () => {
  it("documentSymbols aceita a forma plana e ignora símbolo sem range (não lança)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/a.ts": "const x = 1;" }).fs,
      availableParallelism: 2,
    });
    const manager = new LspManager([]);
    const symbols: readonly DocumentSymbolLike[] = [
      // Forma **plana** (`SymbolInformation`): o range vem em `location.range`.
      {
        name: "plano",
        kind: 12,
        location: {
          uri: "file:///a.ts",
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
        },
      },
      // Símbolo **sem range nenhum** — payload incompleto: tem de ser ignorado.
      { name: "semRange", kind: 12 },
    ];
    vi.spyOn(manager, "requestDocumentSymbols").mockResolvedValue(symbols);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      core.attachLsp(manager);
      const handle = await core.openDocument("/a.ts");

      const result = await core.requestDocumentSymbols(handle);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("plano");
      expect(result[0]?.range).toEqual({
        startLine: 1,
        startCol: 2,
        endLine: 1,
        endCol: 7,
      });
      // 1 warn (e não uma exceção): o símbolo sem range foi pulado.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      core.dispose();
    }
  });

  it("documentSymbols achata a forma hierárquica (com children)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/a.ts": "const x = 1;" }).fs,
      availableParallelism: 2,
    });
    const manager = new LspManager([]);
    vi.spyOn(manager, "requestDocumentSymbols").mockResolvedValue([
      {
        name: "classe",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        children: [
          {
            name: "metodo",
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          },
        ],
      },
    ]);

    try {
      core.attachLsp(manager);
      const handle = await core.openDocument("/a.ts");

      const result = await core.requestDocumentSymbols(handle);

      expect(result.map((s) => s.name)).toEqual(["classe", "metodo"]);
      expect(result[0]?.range).toEqual({
        startLine: 0,
        startCol: 6,
        endLine: 0,
        endCol: 11,
      });
      // O filho é indentado com "··".
      expect(result[1]?.detail).toBe("·");
    } finally {
      core.dispose();
    }
  });

  it("closeDocument fecha o documento no servidor LSP (textDocument/didClose)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/a.ts": "const x = 1;" }).fs,
      availableParallelism: 2,
    });
    const manager = new LspManager([]);
    const closeDocument = vi.spyOn(manager, "closeDocument").mockImplementation(() => {});

    try {
      core.attachLsp(manager);
      const handle = await core.openDocument("/a.ts");

      await core.closeDocument(handle);

      expect(closeDocument).toHaveBeenCalledWith("file:///a.ts");
      // O documento foi descartado do core.
      expect(() => core.documentText(handle)).toThrow(InvalidDocumentHandleError);
    } finally {
      core.dispose();
    }
  });

  it("closeDocument salva o documento sujo antes de descartar o buffer", async () => {
    // O `saveDocument` do core grava via o TaskPool (FS real) ⇒ caminho temporário.
    const path = join(tmpdir(), `scribe-close-${process.pid}.ts`);
    const core = createEditorCore({
      fileSystem: memoryFs({ [path]: "const x = 1;" }).fs,
      availableParallelism: 2,
    });
    const manager = new LspManager([]);
    vi.spyOn(manager, "closeDocument").mockImplementation(() => {});

    try {
      core.attachLsp(manager);
      const handle = await core.openDocument(path);
      await core.insertText(handle, 0, "// edit\n", "user");
      expect(core.isDirty(handle)).toBe(true);

      await core.closeDocument(handle);

      // O `close` do registry descarta o buffer ⇒ sem salvar, a edição se perde.
      expect(readFileSync(path, "utf8")).toContain("// edit");
    } finally {
      core.dispose();
      rmSync(path, { force: true });
    }
  });

  it("dispose fecha no servidor LSP todos os documentos abertos", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/a.ts": "const x = 1;", "/b.ts": "const y = 2;" }).fs,
      availableParallelism: 2,
    });
    const manager = new LspManager([]);
    const closeDocument = vi.spyOn(manager, "closeDocument").mockImplementation(() => {});

    core.attachLsp(manager);
    await core.openDocument("/a.ts");
    await core.openDocument("/b.ts");

    core.dispose();

    const closed = closeDocument.mock.calls.map((call) => call[0]);
    expect(closed).toContain("file:///a.ts");
    expect(closed).toContain("file:///b.ts");
  });
});
