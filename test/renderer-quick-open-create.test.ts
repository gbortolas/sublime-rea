/**
 * Scribe — testes do item **"criar arquivo"** do Quick Open (⌘P) com **path absoluto**.
 *
 * ⚠️ **O bug**: a query absoluta que **não** está dentro de nenhuma raiz era anexada à
 * raiz (`joinUnder`) ⇒ o item "criar" apontava para um **espelho** dentro da workspace
 * (ex.: `<repo>/tmp/opencode/rev/fora.txt` em vez de `/tmp/opencode/rev/fora.txt`).
 * O `main` recusaria a escrita fora (o confinamento funciona), mas o usuário via o
 * arquivo **no lugar errado** ⇒ agora o item **não é oferecido** (`null`).
 *
 * A função é **pura** (sem DOM, sem disco) ⇒ o teste roda em Node.
 */
import { describe, expect, it } from "vitest";

import {
  createFileCandidate,
  rankQuickOpenResults,
  type QuickOpenItem,
} from "../src/renderer/quick-open";

const ROOTS: readonly string[] = ["/ws"];
const OPTIONS = { roots: ROOTS };

/** A lista de arquivos (nenhum casa com as queries abaixo). */
const ITEMS: readonly QuickOpenItem[] = [
  { id: "file:src/main.ts", label: "main.ts", description: "src/main.ts", kind: "file" },
];

describe("Quick Open — 'criar' com path ABSOLUTO", () => {
  it("um path absoluto DENTRO de uma raiz continua válido (o caminho é o pedido)", () => {
    const item = createFileCandidate("/ws/src/novo.ts", OPTIONS);
    expect(item).not.toBeNull();
    expect(item!.kind).toBe("create");
    expect(item!.path).toBe("/ws/src/novo.ts");
    // A lista mostra o caminho **relativo à raiz** (o mesmo dos demais arquivos).
    expect(item!.description).toBe("src/novo.ts");
  });

  it("um path absoluto FORA das raízes NÃO gera item (o 'espelho' no lugar errado)", () => {
    // O caso do bug: o `main` deixaria o arquivo na raiz, e não onde o usuário pediu.
    expect(createFileCandidate("/tmp/opencode/rev/fora.txt", OPTIONS)).toBeNull();
  });

  it("a LISTA não oferece o 'criar' para um path absoluto fora das raízes", () => {
    const ranked = rankQuickOpenResults("/tmp/opencode/rev/fora.txt", ITEMS, OPTIONS);
    expect(ranked.some((entry) => entry.item.kind === "create")).toBe(false);
  });

  it("uma raiz que é só um PREFIXO do texto não vale (o path não está dentro)", () => {
    // "/wsx/fora.txt" **não** está dentro de "/ws" (o `main` recusaria) ⇒ não há item.
    expect(createFileCandidate("/wsx/fora.txt", OPTIONS)).toBeNull();
  });

  it("um path absoluto dentro da BASE (fora das raízes) é válido e não vira espelho", () => {
    const item = createFileCandidate("/outro/dir/novo.ts", {
      roots: ROOTS,
      baseDir: "/outro/dir",
    });
    expect(item).not.toBeNull();
    // O caminho é **exatamente** o pedido (nada de espelho dentro de "/ws").
    expect(item!.path).toBe("/outro/dir/novo.ts");
  });

  it("o path RELATIVO continua o mesmo (a correção não mexeu nele)", () => {
    const item = createFileCandidate("src/novo.ts", OPTIONS);
    expect(item!.path).toBe("/ws/src/novo.ts");
    expect(item!.description).toBe("src/novo.ts");
  });

  it("no multi-root, o path absoluto escolhe a raiz que o contém", () => {
    const roots: readonly string[] = ["/ws/proj", "/ws/outro"];
    const item = createFileCandidate("/ws/outro/src/novo.ts", { roots });
    expect(item!.path).toBe("/ws/outro/src/novo.ts");
    expect(item!.description).toBe("src/novo.ts");
  });

  it("um path absoluto Windows fora das raízes também é recusado", () => {
    expect(createFileCandidate("C:\\fora\\novo.ts", { roots: ["C:/ws"] })).toBeNull();
    expect(createFileCandidate("C:\\ws\\novo.ts", { roots: ["C:/ws"] })?.path).toBe("C:/ws/novo.ts");
  });
});
