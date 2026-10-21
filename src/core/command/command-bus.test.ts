/**
 * Testes de `CommandBusImpl` — registro, `run`/`handled`, grupos de undo, glue, escopo,
 * `dispatch` (nativo e por tupla de extensão), eventos e soft undo/redo.
 */
import { describe, expect, it } from "vitest";
import type { Edit, EditOrigin, Selection } from "../../shared";
import { advanceSelections } from "../../shared";
import {
  CommandBusImpl,
  DuplicateCommandError,
  UnknownCommandError,
} from "./command-bus";
import { FakeRegistry, FakeScheduler } from "./__tests__/fakes";
import type { PingEvent } from "./__tests__/fakes";
import { FakeTarget } from "./__tests__/fakes";
import type { UndoTarget } from "./undo-stack";

/**
 * Alvo que desloca os cursores junto com o texto — como o `EditorCore` faz (mesma regra do
 * `advanceSelections`, a fonte única). O `FakeTarget` só mexe no caret, então não serve para
 * provar que o bus grava o **conjunto** de seleções.
 */
class AdvancingTarget implements UndoTarget {
  text = "";
  private cursor = 0;
  private sel: Selection = { anchor: 0, active: 0 };
  private sels: Selection[] = [{ anchor: 0, active: 0 }];

  applyEdits(edits: readonly Edit[], _origin: EditOrigin): void {
    for (const e of edits) {
      this.text = this.text.slice(0, e.at) + e.insert + this.text.slice(e.at + e.remove.length);
    }
    this.sels = [...advanceSelections(this.sels, edits)];
    const primary = this.sels[0];
    if (primary !== undefined) {
      this.sel = primary;
      this.cursor = primary.active;
    }
  }

  caret(): number {
    return this.cursor;
  }

  setCaret(n: number): void {
    this.cursor = n;
  }

  selection(): Selection {
    return this.sel;
  }

  setSelection(s: Selection): void {
    this.sel = s;
  }

  selections(): readonly Selection[] {
    return this.sels;
  }

  setSelections(sels: readonly Selection[]): void {
    this.sels = [...sels];
    this.sel = this.sels[0] ?? { anchor: 0, active: 0 };
  }
}

function makeBus(): { bus: CommandBusImpl; target: FakeTarget } {
  const target = new FakeTarget();
  const bus = new CommandBusImpl({
    registry: new FakeRegistry(),
    scheduler: new FakeScheduler(),
    target: () => target,
  });
  return { bus, target };
}

/** Comando de inserção que devolve o delta (o bus aplica — escritor único). */
function registerInsert(bus: CommandBusImpl, target: FakeTarget, name = "buffer.insert"): void {
  bus.register(name, "Insert Characters", (args) => {
    const { text } = args as { text: string };
    return [{ at: target.text.length, remove: "", insert: text }];
  });
}

describe("CommandBus — registro", () => {
  it("nome duplicado lança DuplicateCommandError", () => {
    const { bus } = makeBus();
    bus.register("x", "X", () => undefined);

    let thrown: unknown;
    try {
      bus.register("x", "Y", () => undefined);
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DuplicateCommandError);
    if (!(thrown instanceof DuplicateCommandError)) throw new Error("esperado DuplicateCommandError");
    expect(thrown.commandId).toBe("x");
  });

  it("o Disposable de register remove o comando", async () => {
    const { bus } = makeBus();
    const sub = bus.register("temp", "Temp", () => undefined);

    expect((await bus.run("temp")).handled).toBe(true);
    sub.dispose();
    expect((await bus.run("temp")).handled).toBe(false);
  });

  it("registrar de novo após dispose funciona", () => {
    const { bus } = makeBus();
    bus.register("x", "X", () => undefined).dispose();
    expect(() => bus.register("x", "X2", () => undefined)).not.toThrow();
  });
});

describe("CommandBus.run", () => {
  it("comando não registrado devolve handled:false (nunca silencioso)", async () => {
    const { bus } = makeBus();
    const result = await bus.run("nao.existe", { a: 1 });

    expect(result.handled).toBe(false);
    expect(result.name).toBe("nao.existe");
    expect(result.value).toBeUndefined();
  });

  it("propaga o valor devolvido pelo handler", async () => {
    const { bus } = makeBus();
    bus.register("answer", "Answer", () => 42);

    const result = await bus.run("answer");
    expect(result).toEqual({ name: "answer", handled: true, value: 42 });
  });

  it("aplica os deltas devolvidos e grava o undoLabel (= descrição, ≠ CommandId)", async () => {
    const { bus, target } = makeBus();
    registerInsert(bus, target);

    await bus.run("buffer.insert", { text: "hi" });

    expect(target.text).toBe("hi");
    expect(bus.undoStack.undoDepth).toBe(1);
    expect(bus.undoStack.lastLabel).toBe("Insert Characters");
    expect(bus.undoStack.lastLabel).not.toBe("buffer.insert");

    bus.undo();
    expect(target.text).toBe("");
    bus.redo();
    expect(target.text).toBe("hi");
  });

  it("um handler que não devolve Edit[] não toca o alvo nem o undo", async () => {
    const { bus, target } = makeBus();
    bus.register("noop", "No-op", () => "nada");

    await bus.run("noop");
    expect(target.text).toBe("");
    expect(bus.undoStack.undoDepth).toBe(0);
  });
});

describe("CommandBus — multi-cursor (conjunto de seleções no undo)", () => {
  it("recordResult grava 'selectionsBefore'/'selectionsAfter' (undo/redo restauram os N cursores)", async () => {
    const target = new AdvancingTarget();
    const bus = new CommandBusImpl({
      registry: new FakeRegistry(),
      scheduler: new FakeScheduler(),
      target: () => target,
    });
    bus.register("ins", "Insert", () => [{ at: 5, remove: "", insert: "X" }]);

    // Dois cursores antes da edição.
    target.setSelections([
      { anchor: 2, active: 2 },
      { anchor: 5, active: 5 },
    ]);

    await bus.run("ins");

    // O alvo desloca os cursores junto com o texto (mesma regra do `EditorCore`).
    expect(target.selections()).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 6, active: 6 },
    ]);

    // O "antes" foi gravado ⇒ o undo devolve os 2 cursores às posições originais.
    expect(bus.undo()).toBe(true);
    expect(target.selections()).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 5, active: 5 },
    ]);

    // O "depois" foi gravado ⇒ o redo devolve os 2 cursores avançados.
    expect(bus.redo()).toBe(true);
    expect(target.selections()).toEqual([
      { anchor: 2, active: 2 },
      { anchor: 6, active: 6 },
    ]);
  });
});

describe("CommandBus — agrupamento de undo", () => {
  it("10 edições de typing.42 = 1 passo de undo", async () => {
    const { bus, target } = makeBus();
    registerInsert(bus, target);

    for (let i = 0; i < 10; i += 1) {
      await bus.run("buffer.insert", { text: String(i) }, { group: "typing.42" });
    }

    expect(target.text).toBe("0123456789");
    expect(bus.undoStack.undoDepth).toBe(1);

    bus.undo();
    expect(target.text).toBe("");
    expect(bus.undoStack.redoDepth).toBe(1);

    bus.redo();
    expect(target.text).toBe("0123456789");
  });

  it("glue funde grupos marcados num único passo", async () => {
    const { bus, target } = makeBus();
    registerInsert(bus, target);

    await bus.run("buffer.insert", { text: "a" }, { group: "g1" });
    expect(bus.markForGlue()).toBe(true);
    await bus.run("buffer.insert", { text: "b" }, { group: "g2" });
    bus.markForGlue();

    expect(bus.undoStack.undoDepth).toBe(2);
    bus.glueMarkedGroups();
    expect(bus.undoStack.undoDepth).toBe(1);

    bus.undo();
    expect(target.text).toBe("");
  });

  it("run dentro de escopo agrupa tudo num passo (mesmo com grupos explícitos)", async () => {
    const { bus, target } = makeBus();
    registerInsert(bus, target);

    const scope = bus.openEditScope("macro");
    await bus.run("buffer.insert", { text: "a" }, { group: "g1" });
    await bus.run("buffer.insert", { text: "b" }, { group: "g2" });
    await bus.run("buffer.insert", { text: "c" });

    expect(target.text).toBe("abc");
    expect(bus.undoStack.undoDepth).toBe(1);

    scope.dispose();
    bus.undo();
    expect(target.text).toBe("");
  });

  it("escopos aninhados compartilham o grupo do escopo externo", async () => {
    const { bus, target } = makeBus();
    registerInsert(bus, target);

    const outer = bus.openEditScope("externo");
    await bus.run("buffer.insert", { text: "a" });
    const inner = bus.openEditScope("interno");
    await bus.run("buffer.insert", { text: "b" });
    inner.dispose();
    await bus.run("buffer.insert", { text: "c" });
    outer.dispose();

    expect(target.text).toBe("abc");
    expect(bus.undoStack.undoDepth).toBe(1);
    bus.undo();
    expect(target.text).toBe("");
  });
});

describe("CommandBus — dispatch", () => {
  it("resolve comando nativo por nome", async () => {
    const { bus, target } = makeBus();
    registerInsert(bus, target);

    await bus.dispatch({ name: "buffer.insert" }, { text: "n" });
    expect(target.text).toBe("n");
  });

  it("resolve ExtensionCommandRef pela tupla (instância, nome)", async () => {
    const { bus, target } = makeBus();
    const instance: object = { plugin: "demo" };
    const other: object = { plugin: "outro" };

    bus.registerExtension(instance, "plugin.insert", "Plugin Insert", (args) => {
      const { text } = args as { text: string };
      return [{ at: target.text.length, remove: "", insert: text }] satisfies Edit[];
    });
    // Um comando NATIVO de mesmo nome não pode ser escolhido por engano.
    bus.register("plugin.insert", "Native impostor", () => undefined);

    await bus.dispatch({ instance, name: "plugin.insert" }, { text: "P" });
    expect(target.text).toBe("P");

    // Outra instância não resolve: a tupla é a identidade (DEC-BUF-7).
    await expect(bus.dispatch({ instance: other, name: "plugin.insert" })).rejects.toThrow(
      UnknownCommandError,
    );

    // `{ name }` sozinho continua sendo o namespace nativo.
    await bus.dispatch({ name: "plugin.insert" });
    expect(target.text).toBe("P");
  });

  it("dispatch de comando inexistente lança UnknownCommandError", async () => {
    const { bus } = makeBus();
    await expect(bus.dispatch({ name: "nope" })).rejects.toThrow(UnknownCommandError);
  });
});

describe("CommandBus — eventos", () => {
  it("subscribe/emit por tipo, com descarte", () => {
    const { bus } = makeBus();
    const seen: number[] = [];
    const sub = bus.subscribe<PingEvent>("test.ping", (e) => seen.push(e.n));

    bus.emit<PingEvent>({ type: "test.ping", n: 1 });
    bus.emit<PingEvent>({ type: "test.ping", n: 2 });
    expect(seen).toEqual([1, 2]);

    sub.dispose();
    bus.emit<PingEvent>({ type: "test.ping", n: 3 });
    expect(seen).toEqual([1, 2]);
  });
});

describe("CommandBus — soft undo/redo", () => {
  it("move o cursor sem aplicar edição dura", async () => {
    const { bus, target } = makeBus();
    registerInsert(bus, target);

    target.setCaret(0);
    await bus.run("buffer.insert", { text: "abc" });
    expect(target.caret()).toBe(3);

    bus.softUndo();
    expect(target.caret()).toBe(0);
    expect(target.text).toBe("abc");
    expect(bus.undoStack.softIntent).toBe("undo");

    bus.undo();
    expect(target.text).toBe("");

    bus.softRedo();
    expect(target.caret()).toBe(3);
    expect(target.text).toBe("");
    expect(bus.undoStack.softIntent).toBe("redo");
  });

  it("sem alvo resolvido, soft undo/redo não explodem", () => {
    const bus = new CommandBusImpl({ registry: new FakeRegistry(), scheduler: new FakeScheduler() });
    expect(() => bus.softUndo()).not.toThrow();
    expect(() => bus.softRedo()).not.toThrow();
    expect(bus.undo()).toBe(false);
    expect(bus.redo()).toBe(false);
  });
});
