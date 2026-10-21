/**
 * Scribe — modelo puro de inspeção de depuração (DAP).
 *
 * Peças **sem DOM e sem I/O** (para testar direto):
 *
 * 1. {@link extractExpressionAt} — extrai a expressão sob o cursor (identificador ou
 *    caminho pontilhado como `obj.attr`), usada pelo **hover de variável** durante uma
 *    parada: o texto sob o mouse é avaliado pelo adaptador.
 * 2. {@link DebugWatchModel} — a lista de **expressões de observação** (watch): o que o
 *    usuário quer reavaliar a cada parada.
 * 3. {@link columnFromPointerX} — a **matemática de coluna**: converte a posição do mouse
 *    numa coluna de texto usando a **mesma origem** do desenho (gutter + padding).
 * 4. {@link normalizeBreakpointList} / {@link mergeBreakpointSpecs} — a normalização e a
 *    mesclagem da lista de breakpoints (tolera preload antigo; preserva os campos).
 * 5. {@link isSameFilePath} — comparação tolerante de caminhos (o frame vem do adaptador).
 * 6. {@link DebugHoverMemo} — o memo do hover de valor (a mesma expressão não é
 *    reavaliada a cada movimento do mouse).
 *
 * Ficar fora do `debug-panel.ts` (que é um widget "burro" de DOM) mantém a lógica
 * testável sem DOM e evita re-render do painel por tecla digitada.
 */
import { normalizeBreakpointSpecs } from "../core/dap/dap-breakpoints";
import type { DapBreakpoint, DapBreakpointSpec, DapEvaluation } from "../shared";

/** Teto de expressões de observação (o painel mostra no máximo isso). */
export const MAX_WATCH_EXPRESSIONS = 20;

/** Teto do tamanho de uma expressão de observação. */
export const MAX_WATCH_EXPRESSION_LENGTH = 200;

/**
 * Padding entre a borda do gutter e o primeiro caractere do texto.
 *
 * É o **mesmo** do desenho no canvas (`paddingLeft = gutterWidth + 8`) — a coluna do mouse
 * tem de sair da mesma origem, senão o hover/clique cai 3–4 caracteres ao lado.
 */
export const TEXT_PADDING_LEFT = 8;

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * Extrai a expressão sob a posição `col` da linha.
 *
 * Regras:
 * - devolve o **identificador** (`x`, `_priv`, `value2`) ou o **caminho pontilhado**
 *   (`obj.attr`, `a.b.c`) que contém a posição;
 * - `col` é a posição do caret (entre caracteres): se o caractere à esquerda é
 *   identificador, a palavra é recortada terminando **na** posição;
 * - devolve `null` quando não há identificador sob o cursor (espaço, pontuação, fim de linha).
 */
export function extractExpressionAt(line: string, col: number): string | null {
  if (typeof line !== "string" || !Number.isFinite(col) || col < 0) return null;
  const at = Math.min(Math.trunc(col), line.length);

  // Recorte à esquerda: identificadores e pontos (caminho pontilhado).
  let start = at;
  while (start > 0 && isExpressionChar(line[start - 1]!)) start--;
  // Recorte à direita: só identificadores (o ponto final fica de fora).
  let end = at;
  while (end < line.length && IDENTIFIER_CHAR.test(line[end]!)) end++;

  // Se o caret está logo **depois** de um identificador, a posição `at` é o fim da palavra.
  if (end === start && start > 0 && IDENTIFIER_CHAR.test(line[start - 1]!)) {
    end = start;
    while (start > 0 && isExpressionChar(line[start - 1]!)) start--;
  }

  if (start >= end) return null;
  const expression = line.slice(start, end).replace(/\.+$/, "");
  return expression.length > 0 ? expression : null;
}

/**
 * Modelo das expressões de observação.
 *
 * Imutável por fora: cada operação devolve o estado novo (a UI re-renderiza).
 */
export class DebugWatchModel {
  private expressions: string[] = [];

  /** Expressões cadastradas (na ordem de inserção). */
  list(): readonly string[] {
    return this.expressions;
  }

  /** Quantidade de expressões cadastradas. */
  get size(): number {
    return this.expressions.length;
  }

  /**
   * Cadastra uma expressão. Devolve `false` se for vazia, duplicada ou se o teto foi
   * atingido (nenhum estado é alterado nesses casos).
   */
  add(raw: string): boolean {
    const expression = raw.trim().slice(0, MAX_WATCH_EXPRESSION_LENGTH);
    if (expression.length === 0) return false;
    if (this.expressions.includes(expression)) return false;
    if (this.expressions.length >= MAX_WATCH_EXPRESSIONS) return false;
    this.expressions = [...this.expressions, expression];
    return true;
  }

  /** Remove uma expressão. Devolve `false` se ela não existia. */
  remove(raw: string): boolean {
    const expression = raw.trim();
    if (!this.expressions.includes(expression)) return false;
    this.expressions = this.expressions.filter((e) => e !== expression);
    return true;
  }

  /** Limpa a lista. */
  clear(): void {
    this.expressions = [];
  }
}

/** Caractere válido dentro de uma expressão (identificador ou ponto). */
function isExpressionChar(ch: string): boolean {
  return IDENTIFIER_CHAR.test(ch) || ch === ".";
}

// ── Geometria do texto (origem da coluna do mouse) ──────────────────────────────────────────

/**
 * Origem horizontal do texto (px) — a **mesma** do desenho no canvas.
 *
 * O texto é desenhado em `gutterWidth + TEXT_PADDING_LEFT`; a coluna do mouse tem de ser
 * medida a partir daqui (e não de uma origem fixa): com uma origem fixa, a expressão sob
 * o mouse sai 3–4 caracteres à direita do cursor.
 */
export function textOriginX(gutterWidth: number): number {
  const gutter = Number.isFinite(gutterWidth) ? Math.max(0, gutterWidth) : 0;
  return gutter + TEXT_PADDING_LEFT;
}

/**
 * Converte a posição horizontal do mouse numa **coluna de texto**.
 *
 * A origem é a do desenho ({@link textOriginX}); a coluna é limitada ao tamanho da linha.
 * Retorna `0` para entradas inválidas (posição negativa, largura de caractere <= 0).
 */
export function columnFromPointerX(
  x: number,
  textLength: number,
  gutterWidth: number,
  charWidth: number,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(charWidth) || charWidth <= 0) return 0;
  const max = Number.isFinite(textLength) ? Math.max(0, Math.trunc(textLength)) : 0;
  const col = Math.round((x - textOriginX(gutterWidth)) / charWidth);
  return Math.max(0, Math.min(col, max));
}

// ── Hover de valor (memo da expressão) ──────────────────────────────────────────────────────

/**
 * Memo do **hover de valor**: a mesma expressão não é reavaliada.
 *
 * Sem isto, cada movimento do mouse sobre a mesma variável dispara um `evaluate` (um
 * roundtrip IPC **e** uma avaliação real no debuggee). O valor só muda quando o programa
 * volta a rodar — e aí a parada termina, que é quando o memo é limpo.
 *
 * O memo é **por expressão e por frame**: trocar de frame invalida (o mesmo nome pode
 * valer outra coisa noutro frame).
 */
export class DebugHoverMemo {
  private expression: string | null = null;
  private frameId: number | null = null;
  private result: DapEvaluation | null = null;

  /**
   * `true` quando a expressão **precisa** ser avaliada (primeira vez, expressão nova ou
   * frame novo). `false` quando é a mesma expressão do mesmo frame — nesse caso, use
   * {@link DebugHoverMemo.lastResult} para reusar o valor sem novo roundtrip.
   */
  needsEvaluation(expression: string, frameId: number): boolean {
    if (this.expression === expression && this.frameId === frameId && this.result !== null) {
      return false;
    }
    return true;
  }

  /** Último valor avaliado (para reposicionar o tooltip sem novo roundtrip). */
  get lastResult(): DapEvaluation | null {
    return this.result;
  }

  /** Registra o resultado da avaliação (chamar depois que a resposta chegou). */
  remember(expression: string, frameId: number, result: DapEvaluation | null): void {
    this.expression = expression;
    this.frameId = frameId;
    this.result = result;
  }

  /** Limpa o memo (a parada acabou, o frame mudou ou o mouse saiu da expressão). */
  clear(): void {
    this.expression = null;
    this.frameId = null;
    this.result = null;
  }
}

// ── Breakpoints (normalização e mesclagem) ──────────────────────────────────────────────────

/**
 * Normaliza a lista de breakpoints vinda da ponte.
 *
 * Tolera um **preload antigo**, que devolvia só as linhas (números) — sem normalizar,
 * `spec.line` ficava `undefined` e o painel mostrava "linha undefined".
 * Entradas inválidas são descartadas (a lista inteira não quebra).
 */
export function normalizeBreakpointList(raw: unknown): DapBreakpointSpec[] {
  return normalizeBreakpointSpecs(raw);
}

/**
 * Mescla a lista **desejada** (espelho do renderer) com a lista **verificada** (evento do
 * main).
 *
 * Regras:
 * - a linha continua sendo a fonte da verdade do espelho (um breakpoint não verificado
 *   **não** pode desaparecer — senão o próximo envio o apagaria do main, condição junto);
 * - a condição confirmada pelo main tem precedência sobre a desejada;
 * - `hitCondition` e `logMessage` são **preservados** (o evento do main não os carrega —
 *   perdê-los faria o próximo envio apagá-los no adaptador);
 * - linhas que o main conhece e o espelho não entram na lista.
 */
export function mergeBreakpointSpecs(
  current: readonly DapBreakpointSpec[],
  returned: readonly DapBreakpoint[],
): DapBreakpointSpec[] {
  const merged: DapBreakpointSpec[] = current.map((spec) => {
    const found = returned.find((bp) => bp.line === spec.line);
    const condition = found?.condition ?? spec.condition;
    return {
      line: spec.line,
      ...(condition !== undefined ? { condition } : {}),
      ...(spec.hitCondition !== undefined ? { hitCondition: spec.hitCondition } : {}),
      ...(spec.logMessage !== undefined ? { logMessage: spec.logMessage } : {}),
    };
  });
  for (const bp of returned) {
    if (merged.some((spec) => spec.line === bp.line)) continue;
    merged.push({
      line: bp.line,
      ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
    });
  }
  merged.sort((a, b) => a.line - b.line);
  return merged;
}

// ── Comparação de caminhos ──────────────────────────────────────────────────────────────────

/**
 * Compara dois caminhos de arquivo de forma **tolerante**.
 *
 * O caminho do frame vem do adaptador de depuração (pode usar `\` ou outra caixa) e o da
 * sessão é o do editor: uma comparação literal rejeitaria o mesmo arquivo e o caret não
 * seguiria a parada. No Windows (sistema de arquivos case-insensitive) a caixa é ignorada.
 */
export function isSameFilePath(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (/^[A-Za-z]:\//.test(na) && /^[A-Za-z]:\//.test(nb)) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return false;
}
