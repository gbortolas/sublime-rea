/**
 * Testes do modelo puro de inspeção de depuração (DAP).
 *
 * Cobre a extração da expressão sob o cursor (usada pelo hover de valor durante a parada),
 * o modelo de expressões de observação (watch), a **matemática de coluna** (a mesma origem
 * do desenho do texto) e a normalização/mesclagem da lista de breakpoints.
 */
import { describe, expect, it } from "vitest";
import {
  DebugHoverMemo,
  DebugWatchModel,
  MAX_WATCH_EXPRESSIONS,
  MAX_WATCH_EXPRESSION_LENGTH,
  TEXT_PADDING_LEFT,
  columnFromPointerX,
  extractExpressionAt,
  isSameFilePath,
  mergeBreakpointSpecs,
  normalizeBreakpointList,
  textOriginX,
} from "../src/renderer/debug-inspect";

describe("extractExpressionAt", () => {
  it("extrai o identificador sob o cursor", () => {
    expect(extractExpressionAt("total = counter + 1", 8)).toBe("counter");
  });

  it("extrai quando o cursor está no fim da palavra", () => {
    expect(extractExpressionAt("total = counter", 14)).toBe("counter");
  });

  it("extrai caminho pontilhado", () => {
    expect(extractExpressionAt("value = obj.attr", 13)).toBe("obj.attr");
  });

  it("não inclui o ponto final", () => {
    expect(extractExpressionAt("print(obj.)", 9)).toBe("obj");
  });

  it("devolve null sobre espaço ou pontuação", () => {
    expect(extractExpressionAt("a = 1", 2)).toBeNull(); // "="
    expect(extractExpressionAt("a = 1", 3)).toBeNull(); // espaço
  });

  it("devolve o identificador quando o cursor está colado nele", () => {
    expect(extractExpressionAt("a = 1", 0)).toBe("a");
    expect(extractExpressionAt("a = 1", 1)).toBe("a");
    expect(extractExpressionAt("a = 1", 4)).toBe("1");
  });

  it("devolve null em fim de linha vazio", () => {
    expect(extractExpressionAt("", 0)).toBeNull();
  });

  it("aceita identificadores com underscore e dollar", () => {
    expect(extractExpressionAt("x = _private", 6)).toBe("_private");
    expect(extractExpressionAt("x = $var", 5)).toBe("$var");
  });

  it("aceita dígitos", () => {
    expect(extractExpressionAt("x = value2", 6)).toBe("value2");
  });

  it("coluna fora da linha é ignorada", () => {
    expect(extractExpressionAt("abc", 99)).toBe("abc");
    expect(extractExpressionAt("abc", -1)).toBeNull();
  });
});

describe("DebugHoverMemo", () => {
  it("a mesma expressão não é reavaliada (o hover não repete o roundtrip)", () => {
    // Regressão (achado de segurança do P4#27): cada movimento do mouse sobre a mesma
    // variável disparava um `evaluate` (roundtrip IPC + avaliação no debuggee).
    const memo = new DebugHoverMemo();
    expect(memo.needsEvaluation("x", 1)).toBe(true);
    memo.remember("x", 1, { value: "42", variablesReference: 0 });
    // A mesma expressão, o mesmo frame ⇒ não reavalia.
    expect(memo.needsEvaluation("x", 1)).toBe(false);
    // O valor em cache pode reposicionar o tooltip.
    expect(memo.lastResult?.value).toBe("42");
  });

  it("expressão diferente (ou frame diferente) reavalia", () => {
    const memo = new DebugHoverMemo();
    memo.remember("x", 1, { value: "42", variablesReference: 0 });
    expect(memo.needsEvaluation("y", 1)).toBe(true);
    expect(memo.needsEvaluation("x", 2)).toBe(true);
  });

  it("clear (parada acabou / mouse saiu da expressão) reabre a avaliação", () => {
    const memo = new DebugHoverMemo();
    memo.remember("x", 1, { value: "42", variablesReference: 0 });
    expect(memo.needsEvaluation("x", 1)).toBe(false);
    memo.clear();
    expect(memo.lastResult).toBeNull();
    expect(memo.needsEvaluation("x", 1)).toBe(true);
  });

  it("uma avaliação que falhou não trava o hover (reavalia na próxima vez)", () => {
    const memo = new DebugHoverMemo();
    memo.remember("x", 1, null);
    expect(memo.needsEvaluation("x", 1)).toBe(true);
  });
});

describe("DebugWatchModel", () => {
  it("começa vazio", () => {
    const model = new DebugWatchModel();
    expect(model.list()).toEqual([]);
    expect(model.size).toBe(0);
  });

  it("adiciona uma expressão aparada", () => {
    const model = new DebugWatchModel();
    expect(model.add("  x + 1  ")).toBe(true);
    expect(model.list()).toEqual(["x + 1"]);
  });

  it("recusa expressão vazia", () => {
    const model = new DebugWatchModel();
    expect(model.add("   ")).toBe(false);
    expect(model.size).toBe(0);
  });

  it("recusa duplicata", () => {
    const model = new DebugWatchModel();
    expect(model.add("x")).toBe(true);
    expect(model.add("x")).toBe(false);
    expect(model.list()).toEqual(["x"]);
  });

  it("remove uma expressão", () => {
    const model = new DebugWatchModel();
    model.add("x");
    expect(model.remove("x")).toBe(true);
    expect(model.remove("x")).toBe(false);
    expect(model.list()).toEqual([]);
  });

  it("respeita o teto de expressões", () => {
    const model = new DebugWatchModel();
    for (let i = 0; i < MAX_WATCH_EXPRESSIONS + 5; i++) {
      model.add(`e${i}`);
    }
    expect(model.size).toBe(MAX_WATCH_EXPRESSIONS);
  });

  it("trunca expressões longas", () => {
    const model = new DebugWatchModel();
    model.add("a".repeat(MAX_WATCH_EXPRESSION_LENGTH + 40));
    expect(model.list()[0]?.length).toBe(MAX_WATCH_EXPRESSION_LENGTH);
  });

  it("clear esvazia a lista", () => {
    const model = new DebugWatchModel();
    model.add("x");
    model.clear();
    expect(model.list()).toEqual([]);
  });
});

describe("columnFromPointerX (origem do texto)", () => {
  // O texto é desenhado em `gutterWidth + 8` (o mesmo padding do canvas).
  const GUTTER = 25; // 1 dígito × 9px + 16px de folga
  const CHAR_W = 8;

  it("a origem é a largura do gutter + o padding do desenho", () => {
    expect(textOriginX(GUTTER)).toBe(GUTTER + TEXT_PADDING_LEFT);
  });

  it("a primeira coluna fica exatamente na origem do texto", () => {
    // Regressão (achado na revisão do P4#27): com a origem fixa `x - 12`, o mesmo pixel
    // caía 3–4 caracteres à direita do mouse.
    expect(columnFromPointerX(GUTTER + TEXT_PADDING_LEFT, 40, GUTTER, CHAR_W)).toBe(0);
  });

  it("converte a posição do mouse na coluna correspondente", () => {
    const x = GUTTER + TEXT_PADDING_LEFT + CHAR_W * 5;
    expect(columnFromPointerX(x, 40, GUTTER, CHAR_W)).toBe(5);
  });

  it("à esquerda do texto dá a coluna 0", () => {
    expect(columnFromPointerX(0, 40, GUTTER, CHAR_W)).toBe(0);
    expect(columnFromPointerX(GUTTER, 40, GUTTER, CHAR_W)).toBe(0);
  });

  it("à direita da linha é limitado ao tamanho dela", () => {
    const x = GUTTER + TEXT_PADDING_LEFT + CHAR_W * 50;
    expect(columnFromPointerX(x, 12, GUTTER, CHAR_W)).toBe(12);
  });

  it("entrada inválida devolve a coluna 0", () => {
    expect(columnFromPointerX(Number.NaN, 10, GUTTER, CHAR_W)).toBe(0);
    expect(columnFromPointerX(100, 10, GUTTER, 0)).toBe(0);
  });

  it("o gutter mais largo empurra a coluna (origem acompanha o desenho)", () => {
    const wide = 4 * 9 + 16; // documento de 4 dígitos
    const x = wide + TEXT_PADDING_LEFT + CHAR_W * 2;
    expect(columnFromPointerX(x, 40, wide, CHAR_W)).toBe(2);
  });
});

describe("normalizeBreakpointList (preload antigo)", () => {
  it("aceita a lista antiga (só as linhas)", () => {
    // Regressão (achado na revisão do P4#27): sem normalizar, `spec.line` ficava
    // `undefined` e o painel mostrava "linha undefined".
    expect(normalizeBreakpointList([10, 20])).toEqual([{ line: 10 }, { line: 20 }]);
  });

  it("aceita specs completas e números misturados", () => {
    expect(
      normalizeBreakpointList([{ line: 10, condition: "x > 3" }, 20]),
    ).toEqual([{ line: 10, condition: "x > 3" }, { line: 20 }]);
  });

  it("descarta entradas inválidas sem quebrar a lista", () => {
    expect(normalizeBreakpointList([{ line: 0 }, "x", null, { line: 5 }])).toEqual([
      { line: 5 },
    ]);
  });

  it("lista não-array vira lista vazia", () => {
    expect(normalizeBreakpointList(undefined)).toEqual([]);
    expect(normalizeBreakpointList(42)).toEqual([]);
  });
});

describe("mergeBreakpointSpecs (espelho × main)", () => {
  it("preserva hitCondition e logMessage (o evento do main não os carrega)", () => {
    // Regressão (achado na revisão do P4#27): o espelho era reconstruído só com
    // `line`+`condition` ⇒ o próximo envio apagava os campos no main.
    const merged = mergeBreakpointSpecs(
      [{ line: 10, condition: "x > 3", hitCondition: "2", logMessage: "i={i}" }],
      [{ verified: true, line: 10, condition: "x > 3" }],
    );
    expect(merged).toEqual([
      { line: 10, condition: "x > 3", hitCondition: "2", logMessage: "i={i}" },
    ]);
  });

  it("a condição confirmada pelo main tem precedência", () => {
    const merged = mergeBreakpointSpecs(
      [{ line: 10, condition: "velha" }],
      [{ verified: true, line: 10, condition: "nova" }],
    );
    expect(merged[0]?.condition).toBe("nova");
  });

  it("um breakpoint não verificado continua no espelho", () => {
    const merged = mergeBreakpointSpecs(
      [{ line: 10, condition: "x > 3" }],
      [{ verified: false, line: 10 }],
    );
    expect(merged).toEqual([{ line: 10, condition: "x > 3" }]);
  });

  it("linhas que o main conhece e o espelho não entram na lista", () => {
    const merged = mergeBreakpointSpecs(
      [{ line: 10 }],
      [{ verified: true, line: 10 }, { verified: true, line: 30 }],
    );
    expect(merged.map((spec) => spec.line)).toEqual([10, 30]);
  });
});

describe("isSameFilePath (frame × sessão)", () => {
  it("aceita o mesmo caminho", () => {
    expect(isSameFilePath("/tmp/main.py", "/tmp/main.py")).toBe(true);
  });

  it("tolera separadores diferentes", () => {
    expect(isSameFilePath("C:\\proj\\main.py", "C:/proj/main.py")).toBe(true);
  });

  it("tolera a barra final", () => {
    expect(isSameFilePath("/tmp/dir/", "/tmp/dir")).toBe(true);
  });

  it("ignora a caixa em caminho do Windows", () => {
    expect(isSameFilePath("C:\\Proj\\Main.py", "c:/proj/main.py")).toBe(true);
  });

  it("distingue arquivos diferentes", () => {
    expect(isSameFilePath("/tmp/main.py", "/tmp/outro.py")).toBe(false);
  });

  it("distingue arquivos que só diferem na caixa em Linux", () => {
    expect(isSameFilePath("/tmp/Main.py", "/tmp/main.py")).toBe(false);
  });
});
