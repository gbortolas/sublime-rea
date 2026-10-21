/**
 * Scribe — integração dos **snippets de pacote**: do pacote (`.sublime-snippet`) até o
 * trigger do editor.
 *
 * Prova três coisas:
 * - o `main` responde `snippets.list` com a lista lida do `PackageResolver` (e o método
 *   existe no contrato — o runtime valida o nome);
 * - o renderer **mescla** a lista com os snippets embutidos (o de pacote redefine o trigger
 *   embutido) e a expansão passa pelo **mesmo** pipeline (`parseSnippet` ⇒ tab stops);
 * - **degradação**: sem o método na ponte (preload velho) o app segue só com os embutidos.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_METHODS, IPC_VERSION, isIpcMethodName } from "../src/shared";
import type { PackageSnippetDefinition } from "../src/shared";
import {
  indexPackageSnippets,
  packageSnippetToSnippet,
  resolveSnippetForWord,
} from "../src/renderer/main";
import { parseSnippet } from "../src/renderer/snippets";

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
    writeFile: async (_path: string, _data: string): Promise<void> => {
      // mock em memória
    },
  };
}

const root = mkdtempSync(path.join(tmpdir(), "scribe-snippets-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Cria `Packages/<Nome>/snippets/<arquivo>` dentro de `root` e devolve a raiz do pacote. */
function writePackageFile(pkg: string, relative: string, content: string): string {
  const dir = path.join(root, pkg, path.dirname(relative));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, path.basename(relative)), content);
  return root;
}

describe("snippets.list — IPC (main)", () => {
  it("o método existe no contrato (o runtime valida o nome)", () => {
    expect(isIpcMethodName("snippets.list")).toBe(true);
    expect(IPC_METHODS).toContain("snippets.list");
  });

  it("devolve os snippets do pacote (com a origem) e o envelope { snippets }", async () => {
    writePackageFile(
      "MyPkg",
      "snippets/hello.sublime-snippet",
      JSON.stringify({
        prefix: ["hello", "hi"],
        body: ["console.log('${1:msg}');", "$0"],
        description: "log",
      }),
    );
    const core = createEditorCore({
      fileSystem: memoryFs({}),
      availableParallelism: 4,
      packageRoots: { user: [root] },
    });
    try {
      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 1,
        method: "snippets.list",
        args: [],
      });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const value = response.value as { snippets?: PackageSnippetDefinition[] };
      expect(Array.isArray(value.snippets)).toBe(true);
      const triggers = (value.snippets ?? []).map((s) => s.trigger).sort();
      expect(triggers).toEqual(["hello", "hi"]);
      const hello = value.snippets?.find((s) => s.trigger === "hello");
      expect(hello?.body).toBe("console.log('${1:msg}');\n$0");
      expect(hello?.description).toBe("log");
      expect(hello?.source).toContain("hello.sublime-snippet");
    } finally {
      core.dispose();
    }
  });

  it("pacote sem snippets devolve lista vazia (sem erro)", async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "scribe-snippets-empty-"));
    const core = createEditorCore({
      fileSystem: memoryFs({}),
      availableParallelism: 4,
      packageRoots: { user: [emptyRoot] },
    });
    try {
      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 2,
        method: "snippets.list",
        args: [],
      });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const value = response.value as { snippets?: PackageSnippetDefinition[] };
      expect(value.snippets).toEqual([]);
    } finally {
      core.dispose();
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("snippets de pacote — merge no renderer", () => {
  const definitions: readonly PackageSnippetDefinition[] = [
    {
      trigger: "for",
      body: "for (const ${1:item} of ${2:list}) {\n  $0\n}",
      description: "pacote",
      source: "packages://MyPkg/snippets/for.sublime-snippet",
    },
    {
      trigger: "xyz",
      body: "Xyz($1);$0",
      source: "packages://MyPkg/snippets/xyz.sublime-snippet",
    },
  ];

  it("indexa por trigger (lowercased) e o de pacote redefine o embutido", () => {
    const index = indexPackageSnippets(definitions);
    expect(index.size).toBe(2);
    expect(index.get("for")?.source).toBe("packages://MyPkg/snippets/for.sublime-snippet");

    const resolved = resolveSnippetForWord("for", index);
    expect(resolved?.template).toBe("for (const ${1:item} of ${2:list}) {\n  $0\n}");
    expect(resolved?.description).toBe("pacote");
  });

  it("a busca é case-insensitive (como a dos embutidos)", () => {
    const index = indexPackageSnippets(definitions);
    expect(resolveSnippetForWord("FOR", index)?.template).toContain("of ${2:list}");
    expect(resolveSnippetForWord("Xyz", index)?.template).toBe("Xyz($1);$0");
  });

  it("um trigger que não é de pacote cai nos embutidos", () => {
    const index = indexPackageSnippets(definitions);
    const builtin = resolveSnippetForWord("fn", index);
    expect(builtin?.template).toContain("=>");
  });

  it("degradação: ponte sem `snippets.list` (índice vazio) ⇒ só os embutidos", () => {
    const empty = indexPackageSnippets([]);
    expect(resolveSnippetForWord("for", empty)?.template).toContain("for (let ${1:i}");
    expect(resolveSnippetForWord("xyz", empty)).toBeUndefined();
  });

  it("a expansão do snippet de pacote usa o MESMO pipeline (tab stops, escolhas)", () => {
    const index = indexPackageSnippets(definitions);
    const snippet = resolveSnippetForWord("xyz", index);
    expect(snippet).toBeDefined();
    if (snippet === undefined) return;
    const expansion = parseSnippet(snippet.template);
    expect(expansion.text).toBe("Xyz();");
    expect(expansion.tabStops.map((s) => s.index)).toEqual([1, 0]);

    // Escolhas (`${1|a,b,c|}`) do pacote também viram escolha (o dropdown usa a lista).
    const withChoice = packageSnippetToSnippet({
      trigger: "choice",
      body: "${1|um,dois|}",
      source: "packages://MyPkg/snippets/choice.sublime-snippet",
    });
    const choiceExpansion = parseSnippet(withChoice.template);
    expect(choiceExpansion.text).toBe("um");
    expect(choiceExpansion.occurrences[0]?.choices).toEqual(["um", "dois"]);
  });
});
