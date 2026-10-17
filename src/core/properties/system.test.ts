import { describe, expect, it } from "vitest";

import type { PropertyChange } from "../../shared";
import { PropertySystemImpl, defineProperty } from "./system";
import type { PropertyChangeDetail } from "./system";

describe("PropertySystemImpl", () => {
  it("resolve por precedência user > app > os > default", () => {
    const ps = new PropertySystemImpl();
    const workers = defineProperty("editor.ioWorkers", 2);
    expect(ps.value(workers)).toBe(2);

    ps.applyLayer({ "editor.ioWorkers": 4 }, "os");
    expect(ps.value(workers)).toBe(4);
    ps.applyLayer({ "editor.ioWorkers": 8 }, "app");
    expect(ps.value(workers)).toBe(8);
    ps.applyLayer({ "editor.ioWorkers": 16 }, "user");
    expect(ps.value(workers)).toBe(16);
  });

  it("reporta source da camada vencedora", () => {
    const ps = new PropertySystemImpl();
    const workers = defineProperty("editor.ioWorkers", 2);
    const changes: PropertyChange[] = [];
    ps.watch("editor.ioWorkers", (change) => changes.push(change));

    ps.applyLayer({ "editor.ioWorkers": 4 }, "os");
    expect(changes.at(-1)).toMatchObject({ value: 4, source: "os" });
    ps.applyLayer({ "editor.ioWorkers": 8 }, "app");
    expect(changes.at(-1)).toMatchObject({ value: 8, source: "app" });
    ps.applyLayer({ "editor.ioWorkers": 16 }, "user");
    expect(changes.at(-1)).toMatchObject({ value: 16, source: "user" });
    expect(ps.resolved("editor.ioWorkers")).toBe(16);
    expect(workers.scope).toBe("global");
  });

  it("set vence as camadas e marca overridden", () => {
    const ps = new PropertySystemImpl();
    const workers = defineProperty("editor.ioWorkers", 2);
    ps.applyLayer({ "editor.ioWorkers": 16 }, "user");

    const changes: PropertyChange[] = [];
    ps.watch("editor.ioWorkers", (change) => changes.push(change));
    ps.set(workers, 99);

    expect(ps.value(workers)).toBe(99);
    const last = changes.at(-1) as PropertyChangeDetail;
    expect(last.overridden).toBe(true);
    expect(last.value).toBe(99);
  });

  it("watch dispara em mudança real e não em set repetido", () => {
    const ps = new PropertySystemImpl();
    const workers = defineProperty("editor.ioWorkers", 2);
    let fired = 0;
    ps.watch("editor.ioWorkers", () => {
      fired += 1;
    });
    ps.set(workers, 5);
    ps.set(workers, 5);
    expect(fired).toBe(1);
    ps.set(workers, 6);
    expect(fired).toBe(2);
  });

  it("applyLayer é determinístico: mesma camada de novo é idempotente", () => {
    const ps = new PropertySystemImpl();
    const workers = defineProperty("editor.ioWorkers", 2);
    let fired = 0;
    ps.watch("editor.ioWorkers", () => {
      fired += 1;
    });
    ps.applyLayer({ "editor.ioWorkers": 4 }, "app");
    ps.applyLayer({ "editor.ioWorkers": 4 }, "app");
    expect(fired).toBe(1);
    expect(ps.value(workers)).toBe(4);
  });

  it("reverte a camada quando o mapa novo remove a chave", () => {
    const ps = new PropertySystemImpl();
    const workers = defineProperty("editor.ioWorkers", 2);
    ps.applyLayer({ "editor.ioWorkers": 4 }, "os");
    ps.applyLayer({ "editor.ioWorkers": 8 }, "app");
    expect(ps.value(workers)).toBe(8);

    ps.applyLayer({}, "app");
    expect(ps.value(workers)).toBe(4);
    ps.applyLayer({}, "os");
    expect(ps.value(workers)).toBe(2);
  });

  it("resolved devolve undefined para chave desconhecida", () => {
    const ps = new PropertySystemImpl();
    expect(ps.resolved("nao.existe")).toBeUndefined();
    ps.applyLayer({ "nao.existe": "x" }, "user");
    expect(ps.resolved("nao.existe")).toBe("x");
  });

  it("onChange recebe todas as mudanças e watch filtra por nome", () => {
    const ps = new PropertySystemImpl();
    const all: PropertyChange[] = [];
    ps.onChange((change) => all.push(change));
    ps.applyLayer({ a: 1, b: 2 }, "app");
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("define honra escopo default do sistema e escopo por propriedade", () => {
    const ps = new PropertySystemImpl({ scope: "view" });
    const a = ps.define("a", 1);
    const b = ps.define("b", 2, { scope: "document" });
    expect(a.scope).toBe("view");
    expect(b.scope).toBe("document");
    expect(ps.scope).toBe("view");
  });
});
