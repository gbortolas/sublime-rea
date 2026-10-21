/**
 * Testes do **índice de rows visuais** do renderer (soft wrap) e da mesclagem dos
 * breakpoints do DAP.
 *
 * O renderer não tem DOM no ambiente de teste (`node`): o que se testa aqui é a
 * **matemática pura** que o renderer extraiu para o `main.ts`:
 *
 * 1. {@link firstChangedLine} — a primeira linha alterada entre duas versões do texto
 *    (é o que o índice de rows usa para invalidar o mínimo possível);
 * 2. {@link DocumentLineSource} — o contador de **conteúdo** (`contentVersion`) e a
 *    primeira linha alterada: é o sinal de "o documento mudou" que invalida o índice;
 * 3. o contrato de {@link VisualRowIndex} que o renderer consome — a row **visual** de
 *    um offset (é a row em que o diagnóstico é desenhado) e a row da linha seguinte;
 * 4. {@link mergeBreakpointSpecs} — a mesclagem do espelho local com o evento do main
 *    (os campos `hitCondition`/`logMessage` que chegam do evento têm de prevalecer).
 */
import { describe, expect, it } from "vitest";

import { VisualRowIndex } from "../src/core/render";
import { mergeBreakpointSpecs } from "../src/renderer/debug-inspect";
import { DocumentLineSource, firstChangedLine } from "../src/renderer/main";

describe("firstChangedLine (mudança de conteúdo)", () => {
  it("undefined quando as linhas são iguais", () => {
    expect(firstChangedLine(["a", "b"], ["a", "b"])).toBeUndefined();
  });

  it("a linha que mudou", () => {
    expect(firstChangedLine(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
  });

  it("a linha inserida", () => {
    expect(firstChangedLine(["a", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("a linha removida", () => {
    expect(firstChangedLine(["a", "b", "c"], ["a", "c"])).toBe(1);
  });

  it("a 1ª linha quando o documento inteiro muda", () => {
    expect(firstChangedLine(["a"], ["z"])).toBe(0);
  });
});

describe("DocumentLineSource — versão do conteúdo", () => {
  it("o texto idêntico não muda a versão do conteúdo", () => {
    const source = new DocumentLineSource("a\nb", 1);
    const version = source.contentVersion;
    source.setText("a\nb", 2);
    expect(source.contentVersion).toBe(version);
    // A revisão, ao contrário, é a do documento — ela muda sozinha.
    expect(source.revision).toBe(2);
  });

  it("texto diferente muda a versão e aponta a 1ª linha alterada", () => {
    const source = new DocumentLineSource("a\nb\nc", 1);
    source.setText("a\nX\nc", 2);
    expect(source.contentVersion).toBe(1);
    expect(source.firstChangedLine).toBe(1);
    expect(source.line(1)).toBe("X");
  });

  it("a 1ª linha alterada é a da última aplicação de texto", () => {
    const source = new DocumentLineSource("a\nb", 1);
    source.setText("a\nc", 2);
    expect(source.firstChangedLine).toBe(1);
    source.setText("a\nc\nd", 3);
    expect(source.firstChangedLine).toBe(2);
  });
});

describe("VisualRowIndex — a row visual que o renderer consome", () => {
  /** Medição determinística: 10px por caractere (o wrap quebra a cada 10 chars). */
  const measure = (text: string): number => text.length * 10;
  const source = new DocumentLineSource("abcdefghijklmnopqrstuvwxyz\ncurta", 1);

  it("a row do offset é a row do segmento que o contém", () => {
    const index = new VisualRowIndex(source, 100, measure);
    // A 1ª linha tem 26 chars × 10px = 260px ⇒ 3 segmentos (rows 0, 1, 2).
    expect(index.locate(0, 0)?.row).toBe(0);
    expect(index.locate(0, 15)?.row).toBe(1);
    expect(index.locate(0, 25)?.row).toBe(2);
  });

  it("a linha seguinte começa depois de todas as rows da anterior", () => {
    const index = new VisualRowIndex(source, 100, measure);
    expect(index.rowOfLine(0)).toBe(0);
    expect(index.rowOfLine(1)).toBe(3);
    expect(index.rowCount).toBe(4);
  });

  it("sem wrap, a row visual é a própria linha lógica", () => {
    const index = new VisualRowIndex(source, 0, measure);
    expect(index.rowOfLine(1)).toBe(1);
    expect(index.locate(1, 2)?.row).toBe(1);
    expect(index.rowCount).toBe(2);
  });

  it("a invalidação preserva as rows antes da linha alterada", () => {
    const index = new VisualRowIndex(source, 100, measure);
    expect(index.rowOfLine(1)).toBe(3);
    // A 2ª linha muda: as rows da 1ª linha (0..2) continuam válidas.
    index.invalidate(1);
    expect(index.rowOfLine(0)).toBe(0);
    expect(index.rowOfLine(1)).toBe(3);
  });
});

describe("mergeBreakpointSpecs (espelho × main)", () => {
  it("os campos que chegam do evento prevalecem sobre o espelho", () => {
    const merged = mergeBreakpointSpecs(
      [{ line: 10, hitCondition: "1", logMessage: "velho" }],
      [{ verified: true, line: 10, hitCondition: "2", logMessage: "novo" }],
    );
    expect(merged).toEqual([{ line: 10, hitCondition: "2", logMessage: "novo" }]);
  });

  it("o espelho preserva os campos que o evento não traz", () => {
    const merged = mergeBreakpointSpecs(
      [{ line: 10, condition: "x > 3", hitCondition: "2", logMessage: "i={i}" }],
      [{ verified: true, line: 10, condition: "x > 3" }],
    );
    expect(merged).toEqual([
      { line: 10, condition: "x > 3", hitCondition: "2", logMessage: "i={i}" },
    ]);
  });

  it("um breakpoint que só o main conhece entra com os campos dele", () => {
    const merged = mergeBreakpointSpecs(
      [],
      [{ verified: true, line: 30, hitCondition: "3", logMessage: "oi" }],
    );
    expect(merged).toEqual([{ line: 30, hitCondition: "3", logMessage: "oi" }]);
  });
});
