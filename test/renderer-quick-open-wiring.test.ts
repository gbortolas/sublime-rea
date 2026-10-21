/**
 * Scribe — testes da **montagem dos itens** do *Quick Open* (⌘P) no renderer.
 *
 * A função é pura (só a ponte entra como parâmetro) ⇒ o teste não precisa de DOM nem de
 * Electron: o que se prova é a **composição** da lista (recentes → comandos → arquivos) e a
 * **degradação** quando o preload é antigo (sem `workspace.files`).
 *
 * ⚠️ **Contrato com a pontuação pelo caminho**: o item de arquivo carrega o **caminho
 * completo** na `description` (relativo à raiz, com o prefixo da raiz no modo multi-root) e
 * o *basename* no `label` — é assim que o *matching* (que mora em `quick-open.ts`) consegue
 * pontuar pelo caminho. O item "criar arquivo" **não** vem daqui: ele é offercido pelo
 * popup, a cada tecla (é o que depende da query).
 */
import { describe, expect, it } from "vitest";

import { collectQuickOpenItems } from "../src/renderer/main";
import type { OpenDocumentInfo } from "../src/renderer/main";

const SESSIONS: readonly OpenDocumentInfo[] = [
  { handle: 7, label: "b.ts", path: "/w/b.ts" },
];

describe("Quick Open — a montagem dos itens", () => {
  it("recentes primeiro, depois comandos e arquivos da workspace", async () => {
    const items = await collectQuickOpenItems(
      {
        listCommands: async () => ({
          commands: [{ id: "file.open", label: "Abrir arquivo", category: "File" }],
        }),
        workspaceFiles: async () => ({
          files: [{ path: "src/a.ts", absolutePath: "/w/src/a.ts" }],
          truncated: false,
          warnings: [],
        }),
      },
      SESSIONS,
    );

    expect(items.map((item) => item.kind)).toEqual(["recent", "command", "file"]);
    expect(items[0]?.label).toBe("b.ts");
    expect(items[1]?.label).toBe("Abrir arquivo");
    expect(items[1]?.description).toBe("File");
    expect(items[2]?.label).toBe("a.ts");
    expect(items[2]?.description).toBe("src/a.ts");
  });

  it("o payload do arquivo é o caminho **absoluto** (o que o main abre)", async () => {
    const items = await collectQuickOpenItems(
      {
        listCommands: async () => ({ commands: [] }),
        workspaceFiles: async () => ({
          files: [{ path: "src/a.ts", absolutePath: "/w/src/a.ts" }],
          truncated: false,
          warnings: [],
        }),
      },
      [],
    );
    expect(items[0]?.payload).toEqual({ kind: "file", path: "/w/src/a.ts" });
  });

  it("a descrição do arquivo é o caminho COMPLETO (é o que a pontuação usa)", async () => {
    const items = await collectQuickOpenItems(
      {
        listCommands: async () => ({ commands: [] }),
        workspaceFiles: async () => ({
          // No multi-root, o caminho vem prefixado com o nome da raiz.
          files: [{ path: "proj/src/a.ts", absolutePath: "/w/proj/src/a.ts" }],
          truncated: false,
          warnings: [],
        }),
      },
      [],
    );
    // O `label` é o basename (só o desempate); a `description` é o caminho (o protagonista).
    expect(items[0]?.label).toBe("a.ts");
    expect(items[0]?.description).toBe("proj/src/a.ts");
  });

  it("a montagem nunca gera o item 'criar' (é o popup que o offerta, a cada tecla)", async () => {
    const items = await collectQuickOpenItems(
      {
        listCommands: async () => ({ commands: [] }),
        workspaceFiles: async () => ({
          files: [{ path: "src/a.ts", absolutePath: "/w/src/a.ts" }],
          truncated: false,
          warnings: [],
        }),
      },
      [],
    );
    expect(items.some((item) => item.kind === "create")).toBe(false);
  });

  it("preload antigo (sem `workspace.files`) ⇒ só comandos e recentes", async () => {
    const items = await collectQuickOpenItems(
      {
        listCommands: async () => ({ commands: [{ id: "file.open", label: "Abrir arquivo" }] }),
      },
      SESSIONS,
    );
    expect(items.map((item) => item.kind)).toEqual(["recent", "command"]);
  });

  it("sem ponte ⇒ só os recentes (o popup ainda abre — degradação explícita)", async () => {
    const items = await collectQuickOpenItems(undefined, SESSIONS);
    expect(items.map((item) => item.kind)).toEqual(["recent"]);
  });

  it("a falha da ponte não derruba a lista (o resto continua)", async () => {
    const items = await collectQuickOpenItems(
      {
        listCommands: async () => {
          throw new Error("ponte morta");
        },
        workspaceFiles: async () => ({
          files: [{ path: "a.ts", absolutePath: "/w/a.ts" }],
          truncated: false,
          warnings: [],
        }),
      },
      SESSIONS,
    );
    expect(items.map((item) => item.kind)).toEqual(["recent", "file"]);
  });
});
