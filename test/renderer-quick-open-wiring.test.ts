/**
 * Scribe — testes da **montagem dos itens** do *Quick Open* (⌘P) no renderer.
 *
 * A função é pura (só a ponte entra como parâmetro) ⇒ o teste não precisa de DOM nem de
 * Electron: o que se prova é a **composição** da lista (recentes → comandos → arquivos) e a
 * **degradação** quando o preload é antigo (sem `workspace.files`).
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
