/**
 * Scribe — testes das correções da **auditoria do renderer** (o lote de achados).
 *
 * O renderer não tem DOM no ambiente de teste (`node`): o que se testa aqui é a
 * **matemática pura** que o renderer extraiu para o `main.ts` + o comportamento do
 * **core** (grupos de undo, `replaceOne` com seleções).
 *
 * 1. **Caret na posição real** (achado 1, CRÍTICO): o caret é o `active` da seleção
 *    primária — a mesma linha/coluna que a status bar mostra. Antes, a barra era desenhada
 *    na **1ª linha visível, coluna 0** (o cursor real nunca chegava ao canvas).
 * 2. **Hit-test do clique** (achado 10): a âncora vertical é o **centro do texto** — o topo
 *    da linha pertence à própria linha (antes caía na anterior).
 * 3. **Bracket matching limitado** (achado 9): o par é procurado só na **vizinhança** do
 *    caret (o caminho legado materializava o documento inteiro a cada frame).
 * 4. **Delta externo** (achado 4/5): o caret e as seleções andam com a edição externa
 *    (o texto recarregado sozinho deixava o cursor no offset antigo ⇒ texto corrompido).
 * 5. **Grupos de undo** (achado 8): digitação, backspace e insert de extensão são passos
 *    **distintos** — só a digitação consecutiva funde.
 * 6. **`replaceOne` com seleções** (achado 6): o undo devolve a **seleção**, não um cursor
 *    colapsado.
 * 7. **Rolagem em rows** (achado 2): `scrollByRows` move rows, não linhas lógicas.
 */
import { describe, expect, it } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { GlyphAtlas, ViewportImpl } from "../src/core/render";
import { buildInstances } from "../src/core/render/scene";
import type { LineLayout, LineSource } from "../src/core/render/scene";
import type { TextStyle } from "../src/shared";
import {
  DocumentLineSource,
  applyDeltaToSelections,
  caretPlacement,
  diffText,
  findMatchingBracketNear,
  rowAtCanvasY,
} from "../src/renderer/main";

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

const TEXT_STYLE: TextStyle = { family: "monospace", sizePx: 15, weight: 400, italic: false };

/** Layout mínimo para o `buildInstances` (sem gutter, sem scrollbar, sem wrap). */
function layoutOf(scrollOffsetPx = 0): LineLayout {
  return {
    lineHeight: 20,
    paddingLeft: 8,
    paddingTop: 8,
    tabWidth: 4,
    scrollOffsetPx,
    viewport: { x: 0, y: 0, w: 400, h: 200 },
    background: 0x1e1f22ff,
    defaultColor: 0xd4d4d4ff,
    gutterWidth: 0,
    gutterBackground: 0x2b2d30ff,
    gutterColor: 0x6e6e6eff,
    scrollbarWidth: 0,
    scrollbarTrack: 0x00000000,
    scrollbarThumb: 0x00000000,
    searchMatchColor: 0xffff0044,
    searchCurrentColor: 0xff880088,
    selectionColor: 0x264f78ff,
    bracketMatchColor: 0xffffffff,
    wrapWidth: 0,
  };
}

/** `LineSource` mínimo (a `DocumentLineSource` do renderer já serve). */
function sourceOf(text: string): LineSource {
  return new DocumentLineSource(text, 1);
}

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      if (text === undefined) {
        return Promise.reject(new Error(`ENOENT: ${path}`));
      }
      return Promise.resolve(text);
    },
    writeFile: async (_path: string, _data: string): Promise<void> => {
      // mock em memória — o teste só edita em memória.
    },
  };
}

// ── 1. caret na posição real (achado 1) ─────────────────────────────────────────────────────

describe("caret — a posição real (achado 1)", () => {
  it("o caret é o `active` da seleção primária (a mesma linha/coluna da status bar)", () => {
    const source = new DocumentLineSource("alpha\nbeta\ngamma", 1);
    // O cursor primário está na linha 1, coluna 3 (offset 9).
    const selections = [{ anchor: 8, active: 9 }];
    const place = caretPlacement(source, selections);
    expect(place.offset).toBe(9);
    expect(place.line).toBe(1);
    expect(place.column).toBe(3);
    // A status bar mostra `positionAt(session.caret)` — o mesmo offset.
    expect(source.positionAt(place.offset)).toEqual({ line: 1, column: 3 });
  });

  it("a barra do cursor é desenhada na row do cursor (não na 1ª linha visível)", () => {
    const source = sourceOf("linha 0\nlinha 1\nlinha 2\nlinha 3");
    const atlas = new GlyphAtlas();
    // A "1ª linha visível" é a linha 2 (o range começa nela) — o caret está na linha 3.
    const range = { first: 2, count: 2 };
    const selections = [{ anchor: 27, active: 28 }]; // linha 3, coluna 4
    const place = caretPlacement(source, selections);
    expect(place.line).toBe(3);
    expect(place.column).toBe(4);

    const scene = buildInstances(
      source,
      layoutOf(),
      atlas,
      TEXT_STYLE,
      range,
      { line: place.line, column: place.column, color: 0xffffffff, width: 2 },
    );
    const caretRect = scene.rects.find((r) => r.color === 0xffffffff);
    // row 3 ⇒ y = paddingTop (8) + 3 * lineHeight (20) = 68.
    expect(caretRect?.rect.y).toBe(68);
    // E **não** na 1ª linha visível (row 2 ⇒ y = 48).
    expect(caretRect?.rect.y).not.toBe(48);
    // A coluna também é a real: o x avança com o texto antes do caret (e **não** é 0).
    const spaceAdvance = atlas.resolveGlyph(" ", TEXT_STYLE).advance;
    expect(caretRect?.rect.x).toBeCloseTo(8 + 4 * spaceAdvance, 5);
    expect(caretRect?.rect.x).toBeGreaterThan(8);
  });

  it("sem seleção, o caret fica no início do documento", () => {
    const source = sourceOf("abc\ndef");
    const place = caretPlacement(source, undefined);
    expect(place).toEqual({ offset: 0, line: 0, column: 0 });
  });
});

// ── 2. hit-test do clique (achado 10) ───────────────────────────────────────────────────────

describe("hit-test do clique (achado 10)", () => {
  const lineHeight = 21;
  const paddingTop = 8;

  it("o topo da linha pertence à própria linha (antes caía na anterior)", () => {
    // O 1º pixel da 1ª linha (y = paddingTop) ⇒ linha 0.
    expect(rowAtCanvasY(paddingTop, 0, lineHeight, paddingTop)).toBe(0);
    // O centro da 1ª linha ⇒ linha 0.
    expect(rowAtCanvasY(paddingTop + lineHeight / 2, 0, lineHeight, paddingTop)).toBe(0);
    // O topo da 2ª linha ⇒ linha 1.
    expect(rowAtCanvasY(paddingTop + lineHeight, 0, lineHeight, paddingTop)).toBe(1);
  });

  it("com rolagem, a âncora continua na linha certa", () => {
    const scroll = 3 * lineHeight;
    // O topo da 1ª linha visível (a 4ª do documento) ⇒ row 3.
    expect(rowAtCanvasY(paddingTop, scroll, lineHeight, paddingTop)).toBe(3);
  });

  it("o texto da linha (a faixa central) é o da própria linha", () => {
    // A faixa de 15px do texto (o font) dentro da banda de 21px: o centro manda.
    for (const dy of [0, 4, 7, 10]) {
      const row = rowAtCanvasY(paddingTop + dy, 0, lineHeight, paddingTop);
      expect(row).toBe(0);
    }
  });
});

// ── 3. bracket matching limitado (achado 9) ─────────────────────────────────────────────────

describe("bracket matching limitado (achado 9)", () => {
  it("acha o par na vizinhança (o mesmo resultado do scan completo)", () => {
    const source = new DocumentLineSource("function f() {\n  const x = 1;\n}\n", 1);
    // O `{` está no offset 13.
    const open = source.text.indexOf("{");
    const found = findMatchingBracketNear(source, open);
    expect(found).toBe(source.text.indexOf("}"));
  });

  it("acha o par para trás (o fechamento)", () => {
    const source = new DocumentLineSource("function f() {\n  const x = 1;\n}\n", 1);
    const close = source.text.indexOf("}");
    const found = findMatchingBracketNear(source, close);
    expect(found).toBe(source.text.indexOf("{"));
  });

  it("devolve undefined fora da janela (sem varrer o documento inteiro)", () => {
    // O par está a 300 linhas de distância ⇒ fora da janela de 20 linhas.
    const lines = ["(" + "x".repeat(10)];
    for (let i = 0; i < 300; i++) lines.push("linha " + i);
    lines.push(")".repeat(1));
    const source = new DocumentLineSource(lines.join("\n"), 1);
    const open = source.text.indexOf("(");
    expect(findMatchingBracketNear(source, open, 20)).toBeUndefined();
    // Com a janela grande, o par aparece.
    expect(findMatchingBracketNear(source, open, 400)).toBe(source.text.lastIndexOf(")"));
  });

  it("ignora o que não é bracket", () => {
    const source = new DocumentLineSource("const x = 1;", 1);
    expect(findMatchingBracketNear(source, 0)).toBeUndefined();
  });
});

// ── 4. delta externo (achados 4/5) ─────────────────────────────────────────────────────────

describe("delta externo — o caret e as seleções andam com a edição (achado 4)", () => {
  it("um insert externo **antes** do cursor desloca o cursor (e os demais)", () => {
    // Reprodução do achado: "2 cursores + scribe.insert(H, 0, 'XY') + digitar" corrompia o
    // texto porque o cursor ficava no offset antigo.
    const before = "zoo bar";
    const after = "XY" + before;
    const delta = diffText(before, after);
    expect(delta).toEqual({ at: 0, remove: "", insert: "XY" });

    const selections = [
      { anchor: 0, active: 0 },
      { anchor: 4, active: 4 },
    ];
    const moved = applyDeltaToSelections(selections, delta);
    expect(moved[0]).toEqual({ anchor: 2, active: 2 });
    expect(moved[1]).toEqual({ anchor: 6, active: 6 });
  });

  it("um append no fim desloca o cursor do fim", () => {
    const before = "linha dois";
    const after = "linha doiss";
    const delta = diffText(before, after);
    const moved = applyDeltaToSelections([{ anchor: 10, active: 10 }], delta);
    // O cursor estava no fim (10) ⇒ passa a 11 (depois do "s" inserido).
    expect(moved[0]).toEqual({ anchor: 11, active: 11 });
  });

  it("uma edição **dentro** da seleção colapsa o cursor no fim do trecho inserido", () => {
    const delta = diffText("abcdef", "abXYef");
    const moved = applyDeltaToSelections([{ anchor: 2, active: 4 }], delta);
    expect(moved[0]).toEqual({ anchor: 4, active: 4 });
  });

  it("textos iguais ⇒ delta vazio (o cursor não se move)", () => {
    const delta = diffText("abc", "abc");
    expect(delta).toEqual({ at: 0, remove: "", insert: "" });
    const moved = applyDeltaToSelections([{ anchor: 1, active: 2 }], delta);
    expect(moved[0]).toEqual({ anchor: 1, active: 2 });
  });
});

// ── 5/6. grupos de undo e `replaceOne` com seleções (achados 6/8) ──────────────────────────

describe("grupos de undo por tipo (achado 8)", () => {
  it("digitação, backspace e insert de extensão são passos **distintos**", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/a.txt": "" }),
      availableParallelism: 4,
    });
    try {
      const h = await core.openDocument("/a.txt");
      await core.insertText(h, 0, "abc", "user"); // digitação
      await core.replaceOne(h, 2, 1, ""); // backspace (apagamento)
      expect(core.documentText(h)).toBe("ab");

      // O 1º `Ctrl+Z` desfaz **só** o apagamento (antes desfazia a digitação também).
      await core.undoDocument(h);
      expect(core.documentText(h)).toBe("abc");
      // O 2º desfaz a digitação.
      await core.undoDocument(h);
      expect(core.documentText(h)).toBe("");
    } finally {
      core.dispose();
    }
  });

  it("o insert de extensão não funde com a digitação", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/b.txt": "" }),
      availableParallelism: 4,
    });
    try {
      const h = await core.openDocument("/b.txt");
      await core.insertText(h, 0, "X", "user");
      await core.insertText(h, 0, "P", "plugin");
      expect(core.documentText(h)).toBe("PX");
      // O `Ctrl+Z` desfaz **só** o insert do plugin.
      await core.undoDocument(h);
      expect(core.documentText(h)).toBe("X");
    } finally {
      core.dispose();
    }
  });

  it("só a digitação consecutiva funde (o apagamento é um `Ctrl+Z` por operação)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/d.txt": "ab" }),
      availableParallelism: 4,
    });
    try {
      const h = await core.openDocument("/d.txt");
      await core.replaceOne(h, 1, 1, ""); // apaga o "b"
      await core.replaceOne(h, 0, 1, ""); // apaga o "a"
      expect(core.documentText(h)).toBe("");
      // O 1º `Ctrl+Z` desfaz **só** o último apagamento.
      await core.undoDocument(h);
      expect(core.documentText(h)).toBe("a");
      await core.undoDocument(h);
      expect(core.documentText(h)).toBe("ab");
    } finally {
      core.dispose();
    }
  });

  it("a digitação consecutiva funde (as teclas viram 1 passo de undo)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/e.txt": "" }),
      availableParallelism: 4,
    });
    try {
      const h = await core.openDocument("/e.txt");
      await core.insertText(h, 0, "a", "user");
      await core.insertText(h, 1, "b", "user");
      expect(core.documentText(h)).toBe("ab");
      // As 2 teclas de digitação foram **um** passo ⇒ 1 `Ctrl+Z` desfaz as duas.
      await core.undoDocument(h);
      expect(core.documentText(h)).toBe("");
    } finally {
      core.dispose();
    }
  });

  it("o `replaceOne` com seleções devolve a seleção no undo (achado 6)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/c.txt": "hello" }),
      availableParallelism: 4,
    });
    try {
      const h = await core.openDocument("/c.txt");
      await core.replaceOne(h, 0, 5, "X", [{ anchor: 0, active: 5 }]);
      expect(core.documentText(h)).toBe("X");
      const after = await core.undoDocument(h);
      expect(core.documentText(h)).toBe("hello");
      // A **seleção** volta (antes o core gravava um cursor único e o caret colapsava).
      expect(after.selections).toEqual([{ anchor: 0, active: 5 }]);
    } finally {
      core.dispose();
    }
  });
});

// ── 7. rolagem em rows (achado 2) ───────────────────────────────────────────────────────────

describe("rolagem em rows visuais (achado 2)", () => {
  it("`scrollByRows` move rows (não linhas lógicas) com soft wrap", () => {
    const viewport = new ViewportImpl({
      lineCount: 3,
      lineHeight: 10,
      viewportHeight: 30,
      viewportWidth: 100,
      now: (): number => 0,
      requestFrame: () => ({ dispose: (): void => undefined }),
    });
    // 3 linhas lógicas × 3 rows cada = 9 rows.
    viewport.setVisualRowMapper({
      rowOfLine: (line: number): number => line * 3,
      lineOfRow: (row: number): number => Math.floor(row / 3),
    });
    viewport.setMetrics({ visualLineCount: 9 });

    viewport.scrollByRows(3);
    // 3 rows × 10px = 30px (a linha lógica 1 inteira = 30px ⇒ a "linha" pularia 9 rows).
    expect(viewport.scrollOffsetPx()).toBe(30);
    expect(viewport.visibleRowRange().first).toBe(3);
    // A 1ª linha lógica visível é a 2ª (rows 3..5).
    expect(viewport.visibleLineRange().first).toBe(1);
  });
});
