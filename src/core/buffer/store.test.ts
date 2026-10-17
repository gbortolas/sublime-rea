import { describe, expect, it } from "vitest";
import type { DocumentHandle } from "../../shared";
import { makeHandle } from "../../shared";
import { TextDeltaError } from "./delta";
import { LocalTextStore } from "./store";

const DOC: DocumentHandle = makeHandle<"DocumentHandle">(3, 1);

describe("LocalTextStore", () => {
  it("expõe length/slice/text do núcleo", () => {
    const store = new LocalTextStore(DOC, "hello world");
    expect(store.doc).toBe(DOC);
    expect(store.length).toBe(11);
    expect(store.text()).toBe("hello world");
    expect(store.slice({ start: 0, end: 5 })).toBe("hello");
    expect(store.slice({ start: 6, end: 11 })).toBe("world");
    expect(store.generation).toBe(1);
  });

  it("aplica um lote e sobe a geração uma vez por edit", async () => {
    const store = new LocalTextStore(DOC, "abc");
    await store.apply(
      [
        { at: 0, remove: "", insert: "X" },
        { at: 4, remove: "", insert: "Y" },
      ],
      "plugin",
    );
    expect(store.text()).toBe("XabcY");
    expect(store.generation).toBe(3);
    expect(store.lastOrigin).toBe("plugin");
  });

  it("serializa dois applies concorrentes (nada intercala)", async () => {
    const store = new LocalTextStore(DOC, "abc");
    const first = store.apply([{ at: 0, remove: "", insert: "X" }], "user");
    const second = store.apply([{ at: 0, remove: "", insert: "Y" }], "plugin");

    await Promise.all([first, second]);

    // FIFO: o primeiro lote precede o segundo.
    expect(store.text()).toBe("YXabc");
    expect(store.generation).toBe(3);
  });

  it("mantém a geração monotônica e a fila viva após um erro", async () => {
    const store = new LocalTextStore(DOC, "abc");
    const generations: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await store.apply([{ at: store.length, remove: "", insert: String(i) }], "user");
      generations.push(store.generation);
    }
    expect(generations).toEqual([2, 3, 4, 5, 6]);

    await expect(
      store.apply([{ at: 0, remove: "zzz", insert: "" }], "user"),
    ).rejects.toBeInstanceOf(TextDeltaError);

    // A rejeição não envenena a fila.
    await store.apply([{ at: 0, remove: "", insert: "!" }], "user");
    expect(store.text()).toBe("!abc01234");
    expect(store.generation).toBe(7);
  });

  it("delega lineCountUpTo ao índice de linhas", async () => {
    const store = new LocalTextStore(DOC, "a\nb\nc");
    expect(await store.lineCountUpTo(0)).toBe(1);
    expect(await store.lineCountUpTo(2)).toBe(2);
    expect(await store.lineCountUpTo(4)).toBe(3);
    expect(store.lineCount()).toBe(3);
    expect(store.offsetAtLine(2)).toBe(4);
    expect(store.lineAt(3)).toBe(1);
  });

  it("rejeita delta que partiria um par surrogado", () => {
    const store = new LocalTextStore(DOC, "a😀b");
    try {
      store.applyDelta({ from: 2, removed: "", inserted: "x" }, "user");
      throw new Error("esperava TextDeltaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TextDeltaError);
      expect((err as TextDeltaError).reason).toBe("surrogate-split");
    }
    expect(store.text()).toBe("a😀b");
    expect(store.generation).toBe(1);
  });

  it("aplica delta síncrono e mantém índice/geração coerentes", () => {
    const store = new LocalTextStore(DOC, "one\ntwo");
    store.applyDelta({ from: 3, removed: "\n", inserted: " " }, "user");
    expect(store.text()).toBe("one two");
    expect(store.lineCount()).toBe(1);
    expect(store.generation).toBe(2);
  });

  it("compacta o buffer add sob demanda sem alterar o texto", () => {
    const store = new LocalTextStore(DOC, "base");
    for (let i = 0; i < 100; i += 1) {
      store.applyDelta({ from: 4, removed: "", inserted: "0123456789" }, "user");
      store.applyDelta({ from: 4, removed: "0123456789", inserted: "" }, "user");
    }
    const before = store.text();
    store.flushChunk();
    expect(store.text()).toBe(before);
    expect(store.lineCount()).toBe(1);
  });
});
