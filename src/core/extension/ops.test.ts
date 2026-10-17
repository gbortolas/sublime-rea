import { describe, expect, it } from "vitest";

import { ProtocolError } from "../../shared";

import { computeOpsHash, isMethodName, nameOf, OPS, OPS_COUNT, OPS_HASH, OPS_ORDER, opcodeOf } from "./ops";

describe("OPS — tabela densa de opcodes", () => {
  it("numera 1..N de forma densa e única", () => {
    expect(OPS_COUNT).toBe(OPS_ORDER.length);
    const numbers = Object.values(OPS).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: OPS_COUNT }, (_v, i) => i + 1));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("mantém nome ↔ número em roundtrip pela ordem congelada", () => {
    OPS_ORDER.forEach((name, index) => {
      expect(opcodeOf(name)).toBe(index + 1);
      expect(nameOf(index + 1)).toBe(name);
    });
  });

  it("reconhece métodos conhecidos e recusa desconhecidos (nunca silencioso)", () => {
    expect(isMethodName("ping")).toBe(true);
    expect(isMethodName("nao-existe")).toBe(false);

    expect(() => opcodeOf("nao-existe")).toThrowError(ProtocolError);
    try {
      opcodeOf("nao-existe");
    } catch (err) {
      expect((err as ProtocolError).code).toBe("ops.unknown-name");
    }

    expect(() => nameOf(999)).toThrowError(ProtocolError);
    try {
      nameOf(999);
    } catch (err) {
      expect((err as ProtocolError).code).toBe("ops.unknown-opcode");
    }
  });

  it("OPS_HASH é o hash da ordem canônica", () => {
    expect(OPS_HASH).toBe(computeOpsHash(OPS_ORDER));
    expect(OPS_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a ORDEM é o contrato: reordenar muda o hash (cópia local, sem tocar no módulo)", () => {
    const reversed = [...OPS_ORDER].reverse();
    expect(computeOpsHash(reversed)).not.toBe(OPS_HASH);

    // Troca adjacente — o caso mais sutil (mesmo conjunto de nomes).
    const swapped = [...OPS_ORDER];
    const first = swapped[0];
    const second = swapped[1];
    if (first === undefined || second === undefined) throw new Error("tabela com menos de 2 métodos");
    swapped[0] = second;
    swapped[1] = first;
    expect(computeOpsHash(swapped)).not.toBe(OPS_HASH);
  });
});
