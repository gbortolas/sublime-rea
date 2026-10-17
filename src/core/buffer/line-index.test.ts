import { describe, expect, it } from "vitest";
import type { DocumentHandle } from "../../shared";
import { makeHandle } from "../../shared";
import { LineIndex } from "./line-index";
import { PieceTable } from "./piece-table";

const DOC: DocumentHandle = makeHandle<"DocumentHandle">(0, 1);

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Índice "de referência": construído do zero sobre o texto atual (recálculo completo). */
function freshIndex(text: string): LineIndex {
  return new LineIndex({ doc: DOC, source: new PieceTable(text), generation: 1 });
}

function expectMatchesFresh(index: LineIndex, reference: string): void {
  const fresh = freshIndex(reference);
  expect(index.lineCount()).toBe(fresh.lineCount());
  for (let line = 0; line < fresh.lineCount(); line += 1) {
    expect(index.offsetAtLine(line)).toBe(fresh.offsetAtLine(line));
  }
  for (const offset of sampleOffsets(reference.length)) {
    expect(index.lineAt(offset)).toBe(fresh.lineAt(offset));
  }
}

function sampleOffsets(length: number): number[] {
  const offsets = new Set<number>([0, length]);
  for (let i = 0; i < 40 && length > 0; i += 1) offsets.add(Math.floor((length * i) / 40));
  return [...offsets].filter((offset) => offset >= 0 && offset <= length);
}

describe("LineIndex", () => {
  it("conta linhas de LF, CRLF e última linha sem newline", () => {
    expect(freshIndex("").lineCount()).toBe(1);
    expect(freshIndex("abc").lineCount()).toBe(1);
    expect(freshIndex("a\nb").lineCount()).toBe(2);
    expect(freshIndex("a\n").lineCount()).toBe(2);
    expect(freshIndex("\n").lineCount()).toBe(2);
    expect(freshIndex("a\n\nb").lineCount()).toBe(3);
    expect(freshIndex("a\r\nb\r\nc").lineCount()).toBe(3);
    expect(freshIndex("a\r\nb\r\nc").offsetAtLine(2)).toBe(6);
  });

  it("mapeia offset↔linha nas bordas", () => {
    const index = freshIndex("aa\nbb\ncc");
    expect(index.offsetAtLine(0)).toBe(0);
    expect(index.offsetAtLine(1)).toBe(3);
    expect(index.offsetAtLine(2)).toBe(6);
    expect(index.lineAt(0)).toBe(0);
    expect(index.lineAt(2)).toBe(0);
    expect(index.lineAt(3)).toBe(1);
    expect(index.lineAt(index.offsetAtLine(2))).toBe(2);
    expect(index.lineAt(8)).toBe(2);
  });

  it("rejeita linha e offset fora do documento", () => {
    const index = freshIndex("a\nb");
    expect(() => index.offsetAtLine(2)).toThrow(RangeError);
    expect(() => index.offsetAtLine(-1)).toThrow(RangeError);
    expect(() => index.lineAt(4)).toThrow(RangeError);
    expect(() => index.lineAt(-1)).toThrow(RangeError);
  });

  it("scan devolve LineScanResult transferível (Uint32Array) com geração", () => {
    const index = freshIndex("a\nbb\nccc");
    const result = index.scan(7);
    expect(result.doc).toBe(DOC);
    expect(result.generation).toBe(1);
    expect(result.lineCount).toBe(3);
    expect(result.lineStarts).toBeInstanceOf(Uint32Array);
    expect([...result.lineStarts]).toEqual([0, 2, 5]);
  });

  it("incremental acompanha o recálculo completo em edições aleatórias", () => {
    const random = lcg(0xbadc0de);
    let reference = "alfa\nbeta\ngama\ndelta\nepsilon\n";
    const table = new PieceTable(reference);
    const index = new LineIndex({ doc: DOC, source: table, generation: 1 });
    let generation = 1;

    for (let step = 0; step < 300; step += 1) {
      const position = Math.floor(random() * (reference.length + 1));
      const roll = random();
      if (roll < 0.5) {
        const inserted = roll < 0.25 ? "\n" : "xy\nz";
        table.replace(position, position, inserted);
        index.applyDelta({ from: position, removed: "", inserted }, generation + 1);
        reference = reference.slice(0, position) + inserted + reference.slice(position);
      } else {
        const to = Math.min(reference.length, position + Math.floor(random() * 5));
        const removed = reference.slice(position, to);
        if (removed.length === 0) continue;
        table.replace(position, to, "");
        index.applyDelta({ from: position, removed, inserted: "" }, generation + 1);
        reference = reference.slice(0, position) + reference.slice(to);
      }
      generation += 1;

      if (step % 25 === 0) expect(index.generation).toBe(generation);
      expectMatchesFresh(index, reference);
    }

    expect(index.generation).toBe(generation);
    expectMatchesFresh(index, reference);
  });

  it("preserva o prefixo varrido quando a edição cai depois do cache", () => {
    const reference = "line\n".repeat(60000);
    const table = new PieceTable(reference);
    const index = new LineIndex({ doc: DOC, source: table, generation: 1 });

    // Varre só o primeiro chunk (cache parcial).
    index.lineAt(1);
    expect(index.isComplete).toBe(false);
    const cachedUpTo = index.cachedUpTo;
    expect(cachedUpTo).toBeGreaterThan(0);
    expect(cachedUpTo).toBeLessThan(reference.length);

    const position = cachedUpTo + 1000;
    const inserted = "novo\n";
    table.replace(position, position, inserted);
    index.applyDelta({ from: position, removed: "", inserted }, 2);

    // A edição começou depois do cache: o prefixo continua válido e não foi recalculado.
    expect(index.cachedUpTo).toBe(cachedUpTo);
    expect(index.isComplete).toBe(false);

    const updated = reference.slice(0, position) + inserted + reference.slice(position);
    expectMatchesFresh(index, updated);
  });

  it("trunca o cache quando a edição atravessa a fronteira varrida", () => {
    const reference = "line\n".repeat(60000);
    const table = new PieceTable(reference);
    const index = new LineIndex({ doc: DOC, source: table, generation: 1 });
    index.lineAt(1);
    const cachedUpTo = index.cachedUpTo;

    const from = cachedUpTo - 10;
    const to = cachedUpTo + 50;
    const removed = reference.slice(from, to);
    table.replace(from, to, "z");
    index.applyDelta({ from, removed, inserted: "z" }, 2);

    expect(index.cachedUpTo).toBe(from);
    const updated = reference.slice(0, from) + "z" + reference.slice(to);
    expectMatchesFresh(index, updated);
  });

  it("invalidate descarta o cache e continua correto", () => {
    const table = new PieceTable("a\nb\nc");
    const index = new LineIndex({ doc: DOC, source: table, generation: 1 });
    expect(index.lineCount()).toBe(3);
    table.replace(0, table.length, "só uma linha");
    index.invalidate();
    expect(index.lineCount()).toBe(1);
    expect(index.isComplete).toBe(true);
  });
});
