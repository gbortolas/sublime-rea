/**
 * Testes da normalização de breakpoints (DAP) — função pura.
 *
 * Cobre a sanitização da entrada que vem do renderer/IPC: linhas inválidas, duplicatas,
 * tetos de tamanho e a conversão para o formato `SourceBreakpoint` do protocolo.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_BREAKPOINTS_PER_FILE,
  MAX_CONDITION_LENGTH,
  MAX_HIT_CONDITION_LENGTH,
  MAX_LOG_MESSAGE_LENGTH,
  normalizeBreakpointSpecs,
  toSourceBreakpoints,
} from "../dap-breakpoints";

describe("normalizeBreakpointSpecs", () => {
  it("números viram specs sem condição", () => {
    expect(normalizeBreakpointSpecs([10, 20])).toEqual([{ line: 10 }, { line: 20 }]);
  });

  it("objetos preservam a condição", () => {
    const specs = normalizeBreakpointSpecs([{ line: 7, condition: "x > 3" }]);
    expect(specs).toEqual([{ line: 7, condition: "x > 3" }]);
  });

  it("preserva hitCondition e logMessage", () => {
    const specs = normalizeBreakpointSpecs([
      { line: 3, hitCondition: "2", logMessage: "chegou em {x}" },
    ]);
    expect(specs[0]).toMatchObject({ line: 3, hitCondition: "2", logMessage: "chegou em {x}" });
  });

  it("a spec de um logpoint sobrevive à normalização (mensagem + linha)", () => {
    const specs = normalizeBreakpointSpecs([
      { line: 12, logMessage: "i = ${i}" },
    ]);
    expect(specs).toEqual([{ line: 12, logMessage: "i = ${i}" }]);
  });

  it("os três campos convivem na mesma spec", () => {
    const specs = normalizeBreakpointSpecs([
      { line: 12, condition: "x > 1", hitCondition: "3", logMessage: "i = ${i}" },
    ]);
    expect(specs[0]).toEqual({
      line: 12,
      condition: "x > 1",
      hitCondition: "3",
      logMessage: "i = ${i}",
    });
  });

  it("mensagem de log vazia é omitida (não vira string vazia)", () => {
    const specs = normalizeBreakpointSpecs([{ line: 1, logMessage: "   " }]);
    expect(specs).toEqual([{ line: 1 }]);
    expect("logMessage" in (specs[0] as object)).toBe(false);
  });

  it("descarta linhas inválidas (0, negativo, fracionário, NaN)", () => {
    expect(normalizeBreakpointSpecs([0, -3, 1.5, Number.NaN, 5])).toEqual([{ line: 5 }]);
  });

  it("descarta entradas que não são número nem objeto", () => {
    const specs = normalizeBreakpointSpecs(["7", null, undefined, true, { line: "9" }, 4]);
    expect(specs).toEqual([{ line: 4 }]);
  });

  it("descarta objeto sem linha válida", () => {
    expect(normalizeBreakpointSpecs([{ condition: "x" }])).toEqual([]);
  });

  it("linhas repetidas: vence a última", () => {
    const specs = normalizeBreakpointSpecs([
      { line: 5, condition: "a" },
      { line: 5, condition: "b" },
    ]);
    expect(specs).toEqual([{ line: 5, condition: "b" }]);
  });

  it("ordena por linha ascendente", () => {
    expect(normalizeBreakpointSpecs([30, 10, 20]).map((s) => s.line)).toEqual([10, 20, 30]);
  });

  it("entrada não-array vira lista vazia", () => {
    expect(normalizeBreakpointSpecs(undefined)).toEqual([]);
    expect(normalizeBreakpointSpecs(42)).toEqual([]);
    expect(normalizeBreakpointSpecs("10")).toEqual([]);
  });

  it("condição vazia ou só com espaços é omitida", () => {
    const specs = normalizeBreakpointSpecs([{ line: 1, condition: "   " }]);
    expect(specs).toEqual([{ line: 1 }]);
    expect("condition" in (specs[0] as object)).toBe(false);
  });

  it("condição é aparada", () => {
    expect(normalizeBreakpointSpecs([{ line: 1, condition: "  x > 1  " }])[0]?.condition).toBe(
      "x > 1",
    );
  });

  it("trunca a condição no teto", () => {
    const long = "a".repeat(MAX_CONDITION_LENGTH + 50);
    const condition = normalizeBreakpointSpecs([{ line: 1, condition: long }])[0]?.condition;
    expect(condition?.length).toBe(MAX_CONDITION_LENGTH);
  });

  it("trunca hitCondition e logMessage nos tetos", () => {
    const spec = normalizeBreakpointSpecs([
      {
        line: 1,
        hitCondition: "h".repeat(MAX_HIT_CONDITION_LENGTH + 10),
        logMessage: "l".repeat(MAX_LOG_MESSAGE_LENGTH + 10),
      },
    ])[0];
    expect(spec?.hitCondition?.length).toBe(MAX_HIT_CONDITION_LENGTH);
    expect(spec?.logMessage?.length).toBe(MAX_LOG_MESSAGE_LENGTH);
  });

  it("ignora campos textuais que não são string", () => {
    const spec = normalizeBreakpointSpecs([{ line: 1, condition: 42 }])[0];
    expect(spec).toEqual({ line: 1 });
  });

  it("limita a quantidade de breakpoints por arquivo", () => {
    const many = Array.from({ length: MAX_BREAKPOINTS_PER_FILE + 25 }, (_, i) => i + 1);
    expect(normalizeBreakpointSpecs(many).length).toBe(MAX_BREAKPOINTS_PER_FILE);
  });
});

describe("toSourceBreakpoints", () => {
  it("omite os campos ausentes", () => {
    const protocol = toSourceBreakpoints([{ line: 3 }]);
    expect(protocol).toEqual([{ line: 3 }]);
    expect("condition" in protocol[0]!).toBe(false);
  });

  it("carrega condição, hitCondition e logMessage", () => {
    const protocol = toSourceBreakpoints([
      { line: 3, condition: "x", hitCondition: "2", logMessage: "oi" },
    ]);
    expect(protocol[0]).toEqual({
      line: 3,
      condition: "x",
      hitCondition: "2",
      logMessage: "oi",
    });
  });

  it("o logpoint chega ao adaptador no formato do protocolo", () => {
    // O logpoint só funciona se o adaptador receber a mensagem (`SourceBreakpoint.logMessage`).
    const protocol = toSourceBreakpoints([{ line: 12, logMessage: "i = ${i}" }]);
    expect(protocol[0]).toEqual({ line: 12, logMessage: "i = ${i}" });
  });

  it("a condição de paradas chega ao adaptador no formato do protocolo", () => {
    const protocol = toSourceBreakpoints([{ line: 12, hitCondition: "3" }]);
    expect(protocol[0]).toEqual({ line: 12, hitCondition: "3" });
  });

  it("lista vazia vira lista vazia", () => {
    expect(toSourceBreakpoints([])).toEqual([]);
  });
});
