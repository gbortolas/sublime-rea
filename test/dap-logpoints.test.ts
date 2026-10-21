/**
 * Testes das **duas limitações de UI** do DAP: *logpoints* (`logMessage` — o breakpoint
 * **loga** em vez de parar) e *condição de paradas* (`hitCondition` — o breakpoint só para
 * na Nª ocorrência).
 *
 * Cobre a parte **pura** — o contrato compartilhado (`applyBreakpointField`,
 * `isLogpointSpec`, os tetos) — que é exatamente o que a interface do painel usa para
 * avisar o `main.ts` do que mudou.
 *
 * A interface em si (`src/renderer/debug-panel.ts`) é um widget de DOM e o ambiente de
 * teste é `node` (sem DOM): a UI é coberta pela **lógica** que ela consome (aqui) e pelo
 * caminho até o adaptador (`dap-manager.test.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  applyBreakpointField,
  applyBreakpointFieldToList,
  isLogpointSpec,
  MAX_BREAKPOINT_CONDITION_LENGTH,
  MAX_BREAKPOINT_FIELD_LENGTH,
  MAX_BREAKPOINT_HIT_CONDITION_LENGTH,
  MAX_BREAKPOINT_LOG_MESSAGE_LENGTH,
  type DapBreakpointSpec,
} from "../src/shared/dap-contract";

describe("tetos dos campos de breakpoint", () => {
  it("condição 512 · hitCondition 64 · logMessage 512", () => {
    expect(MAX_BREAKPOINT_CONDITION_LENGTH).toBe(512);
    expect(MAX_BREAKPOINT_HIT_CONDITION_LENGTH).toBe(64);
    expect(MAX_BREAKPOINT_LOG_MESSAGE_LENGTH).toBe(512);
  });

  it("o mapa de tetos cobre os três campos", () => {
    expect(MAX_BREAKPOINT_FIELD_LENGTH).toEqual({
      condition: MAX_BREAKPOINT_CONDITION_LENGTH,
      hitCondition: MAX_BREAKPOINT_HIT_CONDITION_LENGTH,
      logMessage: MAX_BREAKPOINT_LOG_MESSAGE_LENGTH,
    });
  });
});

describe("applyBreakpointField (edição de um campo)", () => {
  it("grava o campo editado e preserva os demais", () => {
    const spec: DapBreakpointSpec = { line: 10, condition: "x > 3", hitCondition: "2" };
    const next = applyBreakpointField(spec, "logMessage", "i = ${i}");
    expect(next).toEqual({ line: 10, condition: "x > 3", hitCondition: "2", logMessage: "i = ${i}" });
  });

  it("apara o valor (espaços nas pontas)", () => {
    const next = applyBreakpointField({ line: 1 }, "hitCondition", "  3  ");
    expect(next.hitCondition).toBe("3");
  });

  it("trunca no teto do campo", () => {
    const condition = applyBreakpointField(
      { line: 1 },
      "condition",
      "a".repeat(MAX_BREAKPOINT_CONDITION_LENGTH + 50),
    ).condition;
    expect(condition?.length).toBe(MAX_BREAKPOINT_CONDITION_LENGTH);

    const hit = applyBreakpointField(
      { line: 1 },
      "hitCondition",
      "h".repeat(MAX_BREAKPOINT_HIT_CONDITION_LENGTH + 50),
    ).hitCondition;
    expect(hit?.length).toBe(MAX_BREAKPOINT_HIT_CONDITION_LENGTH);

    const log = applyBreakpointField(
      { line: 1 },
      "logMessage",
      "l".repeat(MAX_BREAKPOINT_LOG_MESSAGE_LENGTH + 50),
    ).logMessage;
    expect(log?.length).toBe(MAX_BREAKPOINT_LOG_MESSAGE_LENGTH);
  });

  it("campo limpo **some** da spec (nunca vira string vazia)", () => {
    const next = applyBreakpointField({ line: 7, condition: "x > 3" }, "condition", "   ");
    expect(next).toEqual({ line: 7 });
    expect("condition" in next).toBe(false);
  });

  it("campo limpo some sem afetar os outros", () => {
    const next = applyBreakpointField(
      { line: 7, condition: "x > 3", logMessage: "oi" },
      "condition",
      "",
    );
    expect(next).toEqual({ line: 7, logMessage: "oi" });
  });

  it("editar a condição não apaga o logpoint (e vice-versa)", () => {
    const withLog = applyBreakpointField({ line: 3, logMessage: "oi" }, "condition", "x");
    expect(withLog).toEqual({ line: 3, condition: "x", logMessage: "oi" });

    const withCondition = applyBreakpointField({ line: 3, condition: "x" }, "logMessage", "oi");
    expect(withCondition).toEqual({ line: 3, condition: "x", logMessage: "oi" });
  });

  it("a linha nunca muda", () => {
    expect(applyBreakpointField({ line: 42 }, "logMessage", "oi").line).toBe(42);
  });
});

describe("isLogpointSpec (badge 'log' do painel)", () => {  it("logpoint: tem mensagem de log e não tem condição", () => {
    expect(isLogpointSpec({ line: 1, logMessage: "i = ${i}" })).toBe(true);
  });

  it("com condição não é logpoint puro (é breakpoint condicional com log)", () => {
    expect(isLogpointSpec({ line: 1, condition: "x", logMessage: "oi" })).toBe(false);
  });

  it("sem mensagem de log não é logpoint", () => {
    expect(isLogpointSpec({ line: 1 })).toBe(false);
    expect(isLogpointSpec({ line: 1, condition: "x" })).toBe(false);
  });

  it("mensagem de log vazia não é logpoint", () => {
    expect(isLogpointSpec({ line: 1, logMessage: "" })).toBe(false);
  });
});

describe("applyBreakpointFieldToList (edição dentro da lista)", () => {
  it("troca só a linha editada", () => {
    const list = applyBreakpointFieldToList(
      [{ line: 10, condition: "x" }, { line: 20 }],
      20,
      "logMessage",
      "i = ${i}",
    );
    expect(list).toEqual([
      { line: 10, condition: "x" },
      { line: 20, logMessage: "i = ${i}" },
    ]);
  });

  it("edições em campos diferentes não se apagam (a spec local acumula)", () => {
    let list: DapBreakpointSpec[] = [{ line: 10 }];
    list = applyBreakpointFieldToList(list, 10, "condition", "x > 3");
    list = applyBreakpointFieldToList(list, 10, "hitCondition", "3");
    list = applyBreakpointFieldToList(list, 10, "logMessage", "i = ${i}");
    expect(list[0]).toEqual({
      line: 10,
      condition: "x > 3",
      hitCondition: "3",
      logMessage: "i = ${i}",
    });
  });

  it("limpar um campo remove só ele da spec da linha", () => {
    const list = applyBreakpointFieldToList(
      [{ line: 10, condition: "x > 3", logMessage: "oi" }],
      10,
      "logMessage",
      "",
    );
    expect(list[0]).toEqual({ line: 10, condition: "x > 3" });
  });

  it("linha inexistente não muda a lista", () => {
    const list = applyBreakpointFieldToList([{ line: 10 }], 99, "logMessage", "oi");
    expect(list).toEqual([{ line: 10 }]);
  });
});
