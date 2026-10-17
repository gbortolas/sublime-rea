import { describe, expect, it } from "vitest";
import { PieceTable } from "./piece-table";

/** LCG determinístico — nada de `Math.random()` (o scaffold exige determinismo). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomChunk(random: () => number, maxLength: number): string {
  const alphabet = "abcdefghij\n";
  const length = 1 + Math.floor(random() * maxLength);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const char = alphabet[Math.floor(random() * alphabet.length)] ?? "a";
    out += char;
  }
  return out;
}

describe("PieceTable", () => {
  it("começa vazia e materializa o texto original", () => {
    const empty = new PieceTable();
    expect(empty.length).toBe(0);
    expect(empty.text()).toBe("");
    expect(empty.spanCount).toBe(0);

    const seeded = new PieceTable("Hello World");
    expect(seeded.length).toBe(11);
    expect(seeded.text()).toBe("Hello World");
    expect(seeded.spanCount).toBe(1);
  });

  it("insere no início, no meio e no fim", () => {
    const table = new PieceTable("Hello World");
    table.replace(0, 0, ">>> ");
    expect(table.text()).toBe(">>> Hello World");

    table.replace(9, 9, "!");
    expect(table.text()).toBe(">>> Hello! World");

    table.replace(table.length, table.length, " :)");
    expect(table.text()).toBe(">>> Hello! World :)");
    expect(table.length).toBe(table.text().length);
  });

  it("substitui, apaga e remove spans que viram vazios", () => {
    const table = new PieceTable("abcdef");
    table.replace(2, 4, "XY");
    expect(table.text()).toBe("abXYef");

    table.replace(0, table.length, "");
    expect(table.text()).toBe("");
    expect(table.length).toBe(0);
    expect(table.spanCount).toBe(0);

    const reap = new PieceTable("one two three");
    reap.replace(3, 4, "_");
    expect(reap.text()).toBe("one_two three");
  });

  it("apaga apenas uma parte de um span sem tocar no resto", () => {
    const table = new PieceTable("0123456789");
    table.replace(3, 6, "");
    expect(table.text()).toBe("0126789");
  });

  it("funde spans contíguos ao digitar sequencialmente (não cresce sem limite)", () => {
    const table = new PieceTable();
    for (const char of "digitação") table.replace(table.length, table.length, char);
    expect(table.text()).toBe("digitação");
    expect(table.spanCount).toBe(1);
  });

  it("rejeita faixas inválidas com RangeError", () => {
    const table = new PieceTable("abc");
    expect(() => table.slice(-1, 1)).toThrow(RangeError);
    expect(() => table.slice(0, 4)).toThrow(RangeError);
    expect(() => table.slice(2, 1)).toThrow(RangeError);
    expect(() => table.replace(0.5, 1, "x")).toThrow(RangeError);
    expect(() => table.replace(0, 99, "x")).toThrow(RangeError);
  });

  it("flushChunk compacta o buffer add sem alterar o texto", () => {
    const table = new PieceTable("base");
    table.replace(4, 4, "0123456789");
    table.replace(4, 10, "");
    const before = table.text();
    const addBefore = table.addLength;

    expect(table.deadAddLength).toBeGreaterThan(0);
    table.flushChunk();

    expect(table.text()).toBe(before);
    expect(table.addLength).toBeLessThan(addBefore);
    expect(table.deadAddLength).toBe(0);
    expect(table.length).toBe(before.length);
  });

  it("flushChunk é no-op quando não há bytes mortos", () => {
    const table = new PieceTable("abc");
    table.replace(3, 3, "def");
    const addBefore = table.addLength;
    table.flushChunk();
    expect(table.addLength).toBe(addBefore);
    expect(table.text()).toBe("abcdef");
  });

  it("mantém integridade em 100k caracteres com edições aleatórias", () => {
    const random = lcg(0xc0ffee);
    let reference = "The quick brown fox jumps over the lazy dog.\n".repeat(2500);
    const table = new PieceTable(reference);

    expect(table.length).toBe(reference.length);
    expect(table.length).toBeGreaterThan(100000);

    for (let step = 0; step < 500; step += 1) {
      const position = Math.floor(random() * (reference.length + 1));
      const roll = random();
      if (roll < 0.55 || reference.length === 0) {
        const inserted = randomChunk(random, 12);
        table.replace(position, position, inserted);
        reference = reference.slice(0, position) + inserted + reference.slice(position);
      } else {
        const to = Math.min(reference.length, position + Math.floor(random() * 40));
        table.replace(position, to, "");
        reference = reference.slice(0, position) + reference.slice(to);
      }

      if (step % 50 === 0) {
        expect(table.text()).toBe(reference);
      } else {
        const from = Math.floor(random() * (reference.length + 1));
        const to = from + Math.floor(random() * (reference.length - from + 1));
        expect(table.slice(from, to)).toBe(reference.slice(from, to));
      }
    }

    expect(table.text()).toBe(reference);
    expect(table.length).toBe(reference.length);
  });
});
