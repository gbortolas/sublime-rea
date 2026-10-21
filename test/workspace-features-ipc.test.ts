/**
 * Scribe — testes da **fiação** das 3 features novas (⌘P, sticky scroll e grep) na camada
 * de IPC: o *main* despacha `workspace.files` e `search.files`, e o *preload* expõe os
 * métodos correspondentes.
 *
 * O que se prova aqui:
 * - `workspace.files` devolve o índice de arquivos da workspace (relativo + absoluto) e
 *   respeita o teto/avisos do `indexFiles` do core;
 * - `search.files` varre os arquivos da workspace e devolve as ocorrências (o `GrepResult`);
 * - `document.close` fecha o documento no core (o `didClose` do LSP);
 * - o **preload** expõe os 3 métodos com o nome do método do contrato no wire.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { clearWorkspaceIndexCache } from "../src/main/index";
import { IPC_METHODS, IPC_VERSION } from "../src/shared";
import type { DocumentHandle, GrepResult, IpcResponse, WorkspaceFilesResult } from "../src/shared";

const { exposed, invoke } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown): void => {
      exposed.set(key, api);
    },
  },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

/** `FileSystem` em memória (o core do teste não toca no disco). */
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

/** Cria uma workspace temporária com dois arquivos e um diretório. */
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scribe-ws-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "alvo.ts"), "const alvo = 1;\noutro alvo\n", "utf8");
  await writeFile(join(root, "nota.txt"), "sem alvo aqui\n", "utf8");
  return root;
}

async function call(
  method: string,
  args: readonly unknown[],
  core: Awaited<ReturnType<typeof createEditorCore>>,
): Promise<IpcResponse> {
  return handleIpcRequest(core, { v: IPC_VERSION, id: 1, method, args });
}

describe("main — `workspace.files` (o índice do Quick Open)", () => {
  it("devolve o índice da workspace (caminho relativo + absoluto)", async () => {
    const root = await makeWorkspace();
    clearWorkspaceIndexCache();
    const core = await createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 2 });
    try {
      const response = await call("workspace.files", [[root]], core);
      expect(response.ok).toBe(true);
      const value = (response.ok ? response.value : undefined) as WorkspaceFilesResult;
      const paths = value.files.map((file) => file.path).sort();
      expect(paths).toEqual(["nota.txt", "src/alvo.ts"]);
      const entry = value.files.find((file) => file.path === "src/alvo.ts");
      expect(entry?.absolutePath).toBe(join(root, "src", "alvo.ts"));
      expect(value.truncated).toBe(false);
      expect(value.warnings).toEqual([]);
    } finally {
      core.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uma raiz inexistente não derruba o despacho (a lista fica vazia)", async () => {
    clearWorkspaceIndexCache();
    const core = await createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 2 });
    try {
      const response = await call("workspace.files", [["/nao/existe/nem/um/poco"]], core);
      expect(response.ok).toBe(true);
      const value = (response.ok ? response.value : undefined) as WorkspaceFilesResult;
      expect(value.files).toEqual([]);
    } finally {
      core.dispose();
    }
  });
});

describe("main — `search.files` (o grep da workspace)", () => {
  it("acha as ocorrências nos arquivos da workspace", async () => {
    const root = await makeWorkspace();
    clearWorkspaceIndexCache();
    const core = await createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 2 });
    try {
      const response = await call("search.files", ["alvo", { roots: [root] }], core);
      expect(response.ok).toBe(true);
      const value = (response.ok ? response.value : undefined) as GrepResult;
      // 2 ocorrências em `src/alvo.ts` + 1 em `nota.txt`.
      expect(value.matches.length).toBe(3);
      expect(value.matches[0]?.line).toBe(0);
      expect(value.matches[0]?.text).toContain("alvo");
      expect(value.filesScanned).toBeGreaterThan(0);
      expect(value.truncated).toBe(false);
    } finally {
      core.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("um padrão vazio é **erro** (o mesmo contrato do find bar)", async () => {
    const root = await makeWorkspace();
    clearWorkspaceIndexCache();
    const core = await createEditorCore({ fileSystem: memoryFs({}), availableParallelism: 2 });
    try {
      const response = await call("search.files", ["", { roots: [root] }], core);
      expect(response.ok).toBe(false);
    } finally {
      core.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("main — `document.close` (o `didClose` do LSP)", () => {
  it("fecha o documento no core", async () => {
    const core = await createEditorCore({
      fileSystem: memoryFs({ "/a.txt": "hi" }),
      availableParallelism: 2,
    });
    try {
      const opened = await call("document.open", ["/a.txt"], core);
      expect(opened.ok).toBe(true);
      const handle = (opened.ok ? opened.value : 0) as DocumentHandle;
      expect(core.documentText(handle)).toBe("hi");

      const closed = await call("document.close", [handle], core);
      expect(closed.ok).toBe(true);
      // O documento não existe mais no core (o `registry` não devolve o estado).
      expect(core.registry.get(handle)).toBeUndefined();
    } finally {
      core.dispose();
    }
  });
});

describe("contrato IPC — os métodos novos", () => {
  it("os 3 métodos novos estão no catálogo (o wire os aceita)", () => {
    expect(IPC_METHODS).toContain("workspace.files");
    expect(IPC_METHODS).toContain("search.files");
    expect(IPC_METHODS).toContain("document.close");
  });
});

describe("preload — a superfície nova", () => {
  it("expõe `workspaceFiles`, `searchFiles` e `closeDocument`", async () => {
    // Efeito colateral: o preload se registra no `contextBridge` no import.
    await import("../src/preload/index");
    const api = exposed.get("scribe") as {
      workspaceFiles: (roots?: readonly string[]) => Promise<unknown>;
      searchFiles: (query: string, options?: unknown, signalId?: number) => Promise<unknown>;
      closeDocument: (handle: number) => Promise<void>;
    };

    invoke.mockResolvedValueOnce({ v: "1.0", id: 1, ok: true, value: { files: [], truncated: false, warnings: [] } });
    await api.workspaceFiles(["/w"]);
    expect(invoke).toHaveBeenCalledWith(
      "scribe:ipc:request",
      expect.objectContaining({ method: "workspace.files", args: [["/w"]] }),
    );

    invoke.mockResolvedValueOnce({ v: "1.0", id: 2, ok: true, value: { matches: [], truncated: false, filesScanned: 0 } });
    await api.searchFiles("alvo", undefined, 7);
    expect(invoke).toHaveBeenCalledWith(
      "scribe:ipc:request",
      expect.objectContaining({ method: "search.files", args: ["alvo"], signalId: 7 }),
    );

    invoke.mockResolvedValueOnce({ v: "1.0", id: 3, ok: true, value: undefined });
    await api.closeDocument(42);
    expect(invoke).toHaveBeenCalledWith(
      "scribe:ipc:request",
      expect.objectContaining({ method: "document.close", args: [42] }),
    );
  });
});
