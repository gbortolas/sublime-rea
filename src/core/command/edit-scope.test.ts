/**
 * Testes de `EditScopeImpl` — aninhamento, idempotência e o gate `UndoStackBusyError`.
 */
import { describe, expect, it } from "vitest";
import { UndoStackBusyError } from "../../shared";
import { CommandBusImpl } from "./command-bus";
import { FakeRegistry, FakeScheduler } from "./__tests__/fakes";

function makeBus(): CommandBusImpl {
  return new CommandBusImpl({ registry: new FakeRegistry(), scheduler: new FakeScheduler() });
}

function capture(fn: () => void): unknown {
  try {
    fn();
  } catch (err: unknown) {
    return err;
  }
  return undefined;
}

describe("EditScopeImpl — aninhamento", () => {
  it("abre e fecha incrementando/decrementando o contador do bus", () => {
    const bus = makeBus();

    const outer = bus.openEditScope("macro de plugin");
    expect(outer.active).toBe(true);
    expect(outer.reason).toBe("macro de plugin");
    expect(bus.openScopeCount).toBe(1);

    const inner = bus.openEditScope("comando interno");
    expect(inner.id).toBe(outer.id + 1);
    expect(bus.openScopeCount).toBe(2);

    inner.dispose();
    expect(inner.active).toBe(false);
    expect(bus.openScopeCount).toBe(1);

    outer.dispose();
    expect(bus.openScopeCount).toBe(0);
  });

  it("dispose é idempotente (não sub-trai o contador)", () => {
    const bus = makeBus();
    const scope = bus.openEditScope("x");

    scope.dispose();
    scope.dispose();
    scope.dispose();

    expect(bus.openScopeCount).toBe(0);
    expect(scope.active).toBe(false);
  });

  it("limpar a pilha com escopo aberto lança UndoStackBusyError (com a contagem)", () => {
    const bus = makeBus();
    const a = bus.openEditScope("a");
    const b = bus.openEditScope("b");

    const err = capture(() => bus.clearUndoStack());
    expect(err).toBeInstanceOf(UndoStackBusyError);
    if (!(err instanceof UndoStackBusyError)) throw new Error("esperado UndoStackBusyError");
    expect(err.openScopes).toBe(2);
    expect(err.name).toBe("UndoStackBusyError");

    // ainda há UM escopo aberto: continua recusando...
    a.dispose();
    expect(bus.openScopeCount).toBe(1);
    expect(() => bus.clearUndoStack()).toThrow(UndoStackBusyError);

    // ...e só limpa quando o aninhamento zera.
    b.dispose();
    expect(bus.openScopeCount).toBe(0);
    expect(() => bus.clearUndoStack()).not.toThrow();
  });

  it("glue com escopo aberto também é recusado", () => {
    const bus = makeBus();
    const scope = bus.openEditScope("macro");

    expect(() => bus.glueMarkedGroups()).toThrow(UndoStackBusyError);

    scope.dispose();
    expect(() => bus.glueMarkedGroups()).not.toThrow();
  });
});
