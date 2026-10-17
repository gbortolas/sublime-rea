import { describe, expect, it } from "vitest";
import type { DocumentHandle, TextDeltaEvent } from "../../shared";
import { makeHandle } from "../../shared";
import { BufferDisposedError, BufferImpl } from "./buffer";
import { LocalTextStore } from "./store";

const DOC: DocumentHandle = makeHandle<"DocumentHandle">(1, 1);

function makeBuffer(text = ""): BufferImpl {
  return new BufferImpl(DOC, new LocalTextStore(DOC, text));
}

describe("BufferImpl", () => {
  it("é a façade de leitura do documento", () => {
    const buffer = makeBuffer("uma\nduas\nlinhas");
    expect(buffer.handle).toBe(DOC);
    expect(buffer.revision).toBe(1);
    expect(buffer.text()).toBe("uma\nduas\nlinhas");
    expect(buffer.lineCount()).toBe(3);
    expect(buffer.offsetAtLine(2)).toBe(9);
    expect(buffer.lineAt(5)).toBe(1);
  });

  it("notifica listeners com o delta e a revisão nova", () => {
    const buffer = makeBuffer("abc");
    const events: TextDeltaEvent[] = [];
    const sub = buffer.onDidChange((event) => events.push(event));

    const delta = { from: 1, removed: "b", inserted: "B" };
    buffer.apply(delta, "user");

    expect(events).toHaveLength(1);
    expect(events[0]?.delta).toEqual(delta);
    expect(events[0]?.revision).toBe(2);
    expect(buffer.revision).toBe(2);
    expect(buffer.text()).toBe("aBc");

    sub.dispose();
    buffer.apply({ from: 0, removed: "", inserted: "!" }, "user");
    expect(events).toHaveLength(1);
    expect(buffer.revision).toBe(3);
  });

  it("deixa um listener quebrado não matar os demais (erro alto no fim)", () => {
    const buffer = makeBuffer("abc");
    let reached = false;
    buffer.onDidChange(() => {
      throw new Error("listener quebrado");
    });
    buffer.onDidChange(() => {
      reached = true;
    });

    expect(() => buffer.apply({ from: 0, removed: "", inserted: "x" }, "user")).toThrow(
      "listener quebrado",
    );
    expect(reached).toBe(true);
    expect(buffer.text()).toBe("xabc");
  });

  it("recusa mutação depois de descartado", () => {
    const buffer = makeBuffer("abc");
    buffer.dispose();
    expect(buffer.isDisposed).toBe(true);
    expect(() => buffer.apply({ from: 0, removed: "", inserted: "x" }, "user")).toThrow(
      BufferDisposedError,
    );
    buffer.dispose(); // idempotente
  });
});
