import { describe, expect, it } from "vitest";
import {
  TextDeltaError,
  applyDelta,
  applyEdit,
  assertOffset,
  codePointsToUtf16,
  deltaToEdit,
  editToDelta,
  invertDelta,
  invertEdit,
  isEmptyDelta,
  isHighSurrogate,
  isLowSurrogate,
  splitsSurrogatePair,
  utf16ToCodePoints,
  validateDelta,
  validateEdit,
} from "./delta";

describe("delta — aplicação e validação", () => {
  it("aplica inserção, remoção e substituição", () => {
    expect(applyDelta("hello", { from: 0, removed: "", inserted: ">> " })).toBe(">> hello");
    expect(applyDelta("hello", { from: 5, removed: "", inserted: "!" })).toBe("hello!");
    expect(applyDelta("hello", { from: 1, removed: "ell", inserted: "ipp" })).toBe("hippo");
    expect(applyDelta("hello", { from: 0, removed: "hello", inserted: "" })).toBe("");
  });

  it("converte TextDelta ⇄ Edit", () => {
    const delta = { from: 3, removed: "abc", inserted: "xyz" };
    expect(deltaToEdit(delta)).toEqual({ at: 3, remove: "abc", insert: "xyz" });
    expect(editToDelta(deltaToEdit(delta))).toEqual(delta);
    expect(applyEdit("abcabc", { at: 3, remove: "abc", insert: "xyz" })).toBe("abcxyz");
  });

  it("rejeita removed que não bate com o documento", () => {
    expect(() => validateDelta("hello", { from: 0, removed: "nope", inserted: "" })).toThrow(
      TextDeltaError,
    );
    try {
      validateDelta("hello", { from: 0, removed: "nope", inserted: "" });
    } catch (err) {
      expect((err as TextDeltaError).reason).toBe("removed-mismatch");
    }
  });

  it("rejeita offsets fora da faixa", () => {
    expect(() => validateDelta("hello", { from: -1, removed: "", inserted: "x" })).toThrow(
      TextDeltaError,
    );
    expect(() => validateDelta("hello", { from: 6, removed: "", inserted: "x" })).toThrow(
      TextDeltaError,
    );
    expect(() => validateEdit("hello", { at: 0, remove: "hellox", insert: "" })).toThrow(
      TextDeltaError,
    );
  });
});

describe("delta — offsets UTF-16 e surrogados", () => {
  const text = "a😀b"; // "😀" ocupa os code units 1 e 2

  it("detecta metades de par surrogado", () => {
    expect(isHighSurrogate(text.charCodeAt(1))).toBe(true);
    expect(isLowSurrogate(text.charCodeAt(2))).toBe(true);
    expect(splitsSurrogatePair(text, 2)).toBe(true);
    expect(splitsSurrogatePair(text, 1)).toBe(false);
    expect(splitsSurrogatePair(text, 3)).toBe(false);
    expect(splitsSurrogatePair(text, 0)).toBe(false);
  });

  it("aceita fronteiras de ponto de código", () => {
    expect(() => assertOffset(text, 0, "offset")).not.toThrow();
    expect(() => assertOffset(text, 1, "offset")).not.toThrow();
    expect(() => assertOffset(text, 3, "offset")).not.toThrow();
    expect(() => assertOffset(text, 4, "offset")).not.toThrow();
    expect(applyDelta(text, { from: 1, removed: "😀", inserted: "X" })).toBe("aXb");
    expect(applyDelta(text, { from: 1, removed: "", inserted: "😀😀" })).toBe("a😀😀😀b");
  });

  it("rejeita offset no meio do par surrogado", () => {
    try {
      validateDelta(text, { from: 2, removed: "", inserted: "x" });
      throw new Error("esperava TextDeltaError");
    } catch (err) {
      expect(err).toBeInstanceOf(TextDeltaError);
      expect((err as TextDeltaError).reason).toBe("surrogate-split");
    }
    expect(() => validateDelta(text, { from: 1, removed: "😀".slice(0, 1), inserted: "" })).toThrow(
      TextDeltaError,
    );
  });
});

describe("delta — inversão (DEC-TR-3)", () => {
  it("inverte um delta e restaura o texto original", () => {
    const before = "função com acento e emoji 😀 no meio";
    const from = before.indexOf("ão");
    const delta = { from, removed: before.slice(from, from + 5), inserted: "alidade de" };
    const after = applyDelta(before, delta);

    const inverse = invertDelta(delta);
    expect(applyDelta(after, inverse)).toBe(before);
  });

  it("inverte um Edit e restaura em dois passos (undo/redo)", () => {
    const before = "abcdef";
    const edit = { at: 2, remove: "cd", insert: "CD" };
    const after = applyEdit(before, edit);
    const inverse = invertEdit(edit);

    expect(after).toBe("abCDef");
    expect(applyEdit(after, inverse)).toBe(before);
    expect(isEmptyDelta(editToDelta(inverse))).toBe(false);
    expect(isEmptyDelta({ from: 0, removed: "", inserted: "" })).toBe(true);
  });
});

describe("delta — ponte de codificação (DEC-BUF-9)", () => {
  it("converte code units ⇄ pontos de código", () => {
    const sample = "a😀é\u{1f600}";
    expect(utf16ToCodePoints(sample)).toEqual([0x61, 0x1f600, 0xe9, 0x1f600]);
    expect(codePointsToUtf16(utf16ToCodePoints(sample))).toBe(sample);
    expect(utf16ToCodePoints(sample).length).toBeLessThan(sample.length);
  });

  it("rejeita ponto de código inválido", () => {
    expect(() => codePointsToUtf16([0xd800])).toThrow(TextDeltaError);
    expect(() => codePointsToUtf16([0x110000])).toThrow(TextDeltaError);
  });
});
