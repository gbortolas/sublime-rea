/**
 * Scribe — testes do popup de escolha de snippet (`${1|a,b,c|}`).
 *
 * O ambiente de teste do projeto roda em **Node** (`environment: "node"`, sem jsdom), então o
 * DOM não é testável aqui: o que se testa é a **lógica pura** do popup (índice inicial,
 * movimento com setas, limites), o **contrato** da API pública (funções presentes, no-op
 * seguro quando não há DOM), o **contexto de variáveis TM** montado pelo renderer e a
 * **sequência de aplicação** da escolha (primária → espelhos → sessão nova), simulada sem DOM.
 */
import { describe, expect, it, vi } from "vitest";

import {
  hideSnippetChoice,
  initialChoiceIndex,
  isSnippetChoiceVisible,
  moveChoiceIndex,
  showSnippetChoice,
} from "../src/renderer/snippet-choice";
import {
  chooseSnippetOption,
  createSnippetSession,
  currentChoice,
  currentStop,
} from "../src/renderer/snippet-session";
import { parseSnippet } from "../src/renderer/snippets";
import {
  DocumentLineSource,
  buildSnippetVariableContext,
  snippetChoiceAnchor,
} from "../src/renderer/main";

describe("popup de escolha — lógica pura", () => {
  it("o índice inicial é a 1ª opção (-1 sem opções)", () => {
    expect(initialChoiceIndex(3)).toBe(0);
    expect(initialChoiceIndex(1)).toBe(0);
    expect(initialChoiceIndex(0)).toBe(-1);
  });

  it("as setas movem a seleção com clamp nos limites", () => {
    expect(moveChoiceIndex(0, 1, 3)).toBe(1);
    expect(moveChoiceIndex(1, 1, 3)).toBe(2);
    expect(moveChoiceIndex(2, 1, 3)).toBe(2); // não passa do fim
    expect(moveChoiceIndex(1, -1, 3)).toBe(0);
    expect(moveChoiceIndex(0, -1, 3)).toBe(0); // não passa do início
  });

  it("sem opções o índice é -1 (nada a selecionar)", () => {
    expect(moveChoiceIndex(0, 1, 0)).toBe(-1);
    expect(moveChoiceIndex(-1, -1, 0)).toBe(-1);
  });
});

describe("popup de escolha — contrato da API (sem DOM)", () => {
  it("showSnippetChoice sem DOM é um no-op seguro (não lança)", () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    expect(() => showSnippetChoice({ choices: ["a", "b"], onPick, onCancel })).not.toThrow();
    expect(isSnippetChoiceVisible()).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("hideSnippetChoice sem popup é um no-op seguro", () => {
    expect(() => hideSnippetChoice()).not.toThrow();
    expect(isSnippetChoiceVisible()).toBe(false);
  });
});

describe("contexto de variáveis TM — a partir do documento ativo", () => {
  it("deriva arquivo, diretório, linha, palavra e índice da linha", () => {
    const source = new DocumentLineSource("const foo = 1;\nconst bar = 2;");
    const ctx = buildSnippetVariableContext({
      document: source,
      path: "/home/user/projeto/notas.md",
      caret: 6,
      selection: { anchor: 6, active: 6 },
    });
    expect(ctx.fileName).toBe("notas.md");
    expect(ctx.fileNameBase).toBe("notas");
    expect(ctx.filePath).toBe("/home/user/projeto/notas.md");
    expect(ctx.directory).toBe("/home/user/projeto");
    expect(ctx.currentLine).toBe("const foo = 1;");
    expect(ctx.currentWord).toBe("foo");
    expect(ctx.lineIndex).toBe(0);
  });

  it("o texto selecionado vira TM_SELECTED_TEXT (seleção vazia → ausente)", () => {
    const source = new DocumentLineSource("abc def ghi");
    const selected = buildSnippetVariableContext({
      document: source,
      path: undefined,
      caret: 0,
      selection: { anchor: 0, active: 7 },
    });
    expect(selected.selectedText).toBe("abc def");
    const collapsed = buildSnippetVariableContext({
      document: source,
      path: undefined,
      caret: 4,
      selection: { anchor: 4, active: 4 },
    });
    expect(collapsed.selectedText).toBeUndefined();
  });

  it("sem caminho não há arquivo/diretório (a variável fica literal)", () => {
    const source = new DocumentLineSource("texto\n--");
    const ctx = buildSnippetVariableContext({
      document: source,
      path: undefined,
      caret: 0,
      selection: { anchor: 0, active: 0 },
    });
    expect(ctx.fileName).toBeUndefined();
    expect(ctx.fileNameBase).toBeUndefined();
    expect(ctx.filePath).toBeUndefined();
    expect(ctx.directory).toBeUndefined();
    expect(ctx.currentLine).toBe("texto");
    expect(ctx.currentWord).toBe("texto");
    // Caret numa linha sem palavra → TM_CURRENT_WORD ausente.
    const punctuation = buildSnippetVariableContext({
      document: source,
      path: undefined,
      caret: 7,
      selection: { anchor: 7, active: 7 },
    });
    expect(punctuation.currentLine).toBe("--");
    expect(punctuation.currentWord).toBeUndefined();
    expect(punctuation.lineIndex).toBe(1);
  });
});

describe("âncora do dropdown — mesma origem do desenho do texto", () => {
  it("posiciona abaixo do caret, na coluna do caret", () => {
    const anchor = snippetChoiceAnchor({
      canvasLeft: 100,
      canvasTop: 50,
      line: 3,
      column: 7,
      scrollOffsetPx: 0,
      gutterWidth: 25,
      lineHeight: 21,
      charWidth: 9,
    });
    // x = canvas + gutter + padding (8) + coluna * largura do caractere
    expect(anchor.x).toBe(100 + 25 + 8 + 7 * 9);
    // y = canvas + paddingTop (8) + (linha + 1) * altura − scroll
    expect(anchor.y).toBe(50 + 8 + 4 * 21);
  });

  it("o scroll vertical desloca o dropdown junto com o texto", () => {
    const anchor = snippetChoiceAnchor({
      canvasLeft: 0,
      canvasTop: 0,
      line: 0,
      column: 0,
      scrollOffsetPx: 42,
      gutterWidth: 25,
      lineHeight: 21,
      charWidth: 9,
    });
    expect(anchor.y).toBe(8 + 21 - 42);
  });
});

describe("fluxo da parada com escolha — simulação do renderer (sem DOM)", () => {
  /** Aplica uma edição num texto (mesma semântica do `replaceOne` da ponte). */
  const replace = (text: string, at: number, remove: number, insert: string): string =>
    text.slice(0, at) + insert + text.slice(at + remove);

  it("a 1ª parada com escolha expõe as opções; a escolha troca o texto e os espelhos", () => {
    const expansion = parseSnippet("let ${1|foo,bar,baz|} = ${1};");
    const session = createSnippetSession(expansion, 0);
    // A parada atual é a escolha: o dropdown abre com as 3 opções.
    const stop = currentStop(session);
    expect(stop?.choices).toEqual(["foo", "bar", "baz"]);
    const choice = currentChoice(session);
    expect(choice?.index).toBe(1);
    expect(choice?.selected).toBe(0);
    expect(choice?.choices).toEqual(["foo", "bar", "baz"]);

    // O usuário escolhe a 2ª opção ("bar").
    const next = chooseSnippetOption(session!, 1, 1);
    expect(next).not.toBeNull();
    const field = session!.fields.find((f) => f.index === 1 && f.isPrimary)!;
    // 1) o texto da primária passa a ser a opção escolhida.
    let text = replace(expansion.text, field.start, field.end - field.start, "bar");
    expect(text).toBe("let bar = foo;");
    // 2) os espelhos re-renderizados, na ordem da lista.
    for (const update of next!.updates) {
      text = replace(text, update.start, update.end - update.start, update.newText);
    }
    expect(text).toBe("let bar = bar;");
    // 3) a sessão nova: a opção escolhida e os offsets já ajustados.
    expect(currentChoice(next!)?.selected).toBe(1);
    const chosen = next!.fields.find((f) => f.index === 1 && f.isPrimary)!;
    expect(text.slice(chosen.start, chosen.end)).toBe("bar");
  });

  it("uma escolha sem espelho só troca o texto da primária", () => {
    const expansion = parseSnippet("${1|red,green,blue|};");
    const session = createSnippetSession(expansion, 0);
    const next = chooseSnippetOption(session, 1, 2);
    expect(next).not.toBeNull();
    expect(next!.updates).toHaveLength(0);
    const field = session.fields.find((f) => f.index === 1 && f.isPrimary)!;
    const text = replace(expansion.text, field.start, field.end - field.start, "blue");
    expect(text).toBe("blue;");
  });
});
