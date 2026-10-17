/**
 * Scribe — testes do adaptador do renderer (`DocumentLineSource`) e da guarda de boot.
 *
 * Sem Electron, sem canvas: o seam real (a classe exportada) é exercitado direto, e o boot
 * confirma que **não** sobe o loop quando não há canvas (ambiente `node`).
 */
import { describe, expect, it } from "vitest";

import { DocumentLineSource, bootRenderer } from "../src/renderer/main";

describe("DocumentLineSource", () => {
  it("mapeia o texto do documento em linhas", () => {
    const source = new DocumentLineSource("alpha\nbeta\ngamma");
    expect(source.lineCount()).toBe(3);
    expect(source.line(0)).toBe("alpha");
    expect(source.line(1)).toBe("beta");
    expect(source.line(2)).toBe("gamma");
    expect(source.line(3)).toBe("");
  });

  it("trata documento vazio como uma linha", () => {
    const source = new DocumentLineSource("");
    expect(source.lineCount()).toBe(1);
    expect(source.line(0)).toBe("");
  });

  it("atualiza o texto e a revisão em setText", () => {
    const source = new DocumentLineSource("a", 1);
    source.setText("a\nb", 2);
    expect(source.lineCount()).toBe(2);
    expect(source.line(1)).toBe("b");
    expect(source.revision).toBe(2);
  });

  it("mapeia offset ↔ linha/coluna", () => {
    const source = new DocumentLineSource("ab\ncd");
    expect(source.positionAt(0)).toEqual({ line: 0, column: 0 });
    expect(source.positionAt(3)).toEqual({ line: 1, column: 0 });
    expect(source.positionAt(99)).toEqual({ line: 1, column: 2 });
    expect(source.offsetOf(1, 1)).toBe(4);
    expect(source.offsetOf(0, 2)).toBe(2);
  });
});

describe("bootRenderer", () => {
  it("não sobe o loop quando não há canvas (ambiente node, sem throw)", async () => {
    expect(typeof document).toBe("undefined");
    await expect(bootRenderer()).resolves.toBe(false);
  });
});
