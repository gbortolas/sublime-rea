/**
 * Scribe — `sticky-scroll.ts`: o **contexto de sticky scroll** (as linhas que "grudam" no topo).
 *
 * O sticky scroll (como no VS Code) mantém **visível** o cabeçalho do bloco/escopo que envolve
 * a linha do cursor: quando o cabeçalho sai da viewport, ele é **repetido** no topo, grudado.
 *
 * Este módulo é **matemática pura** (sem DOM, sem canvas, sem estado): dada a linha do caret,
 * a primeira linha visível e o texto das linhas, devolve o **intervalo** de linhas de contexto.
 * Quem **desenha** é a cena (`scene.ts`).
 *
 * Duas fontes de "envelope", nesta ordem:
 *
 * 1. **symbols do LSP** (`textDocument/documentSymbol`): o símbolo — ou a **cadeia** de símbolos
 *    aninhados — que **envolve** a linha do caret. Preciso, mas exige LSP.
 * 2. **indentação** (fallback, sempre disponível): o bloco cujo nível de indentação é **menor**
 *    que o da linha do caret (a "linha de abertura" do bloco).
 *
 * ⚠️ Quando há symbols do LSP, eles são a **única** fonte (o LSP é a autoridade): se nenhum
 * símbolo envolve a linha do caret, não há contexto (a indentação **não** é usada como
 * segundo palpite).
 */

/**
 * Contexto de sticky scroll — o bloco/escopo ("a envelope") que envolve a linha do cursor.
 */
export interface StickyContext {
  /** Linha lógica do topo do contexto (a "envelope"). */
  readonly startLine: number;
  /** Quantas linhas de contexto grudam (≤ `maxLines`). */
  readonly count: number;
}

/**
 * Um símbolo do documento (LSP) reduzido ao **intervalo de linhas** que ele cobre.
 *
 * É a forma que o renderer monta a partir de `LspDocumentSymbol`
 * (`range.startLine`/`range.endLine`).
 */
export interface StickySymbol {
  /** 1ª linha do símbolo (0-based, inclusiva). */
  readonly startLine: number;
  /** Última linha do símbolo (0-based, inclusiva). */
  readonly endLine: number;
}

/**
 * Um símbolo do LSP na forma que o **bridge** entrega (`LspDocumentSymbol`).
 *
 * Só o `range` interessa aqui (os demais campos — `name`, `kind` — são ignorados).
 */
export interface StickyLspSymbol {
  readonly range: {
    readonly startLine: number;
    readonly endLine: number;
  };
}

/** Opções de `computeStickyContext`. */
export interface StickyOptions {
  /** Linha lógica do caret (a que define o contexto). */
  readonly caretLine: number;
  /** Número de linhas de contexto a grudar. Default 5. */
  readonly maxLines?: number;
  /** Primeira linha **visível** (a partir dela o contexto aparece). */
  readonly firstVisibleLine: number;
  /** Texto das linhas (para inferir o bloco por indentação). */
  readonly lineAt: (line: number) => string;
  /** Símbolos do LSP (opcional): intervalos {startLine, endLine}. */
  readonly symbols?: readonly StickySymbol[];
}

/** Nº padrão de linhas de contexto que grudam. */
export const DEFAULT_STICKY_MAX_LINES = 5;

/** Largura de tabulação usada na medição de indentação (o fallback sem LSP). */
const DEFAULT_TAB_WIDTH = 4;

/**
 * Calcula o **contexto de sticky scroll** da linha do caret.
 *
 * O contexto é a **envelope** (o bloco/escopo) que envolve a linha do caret, e as linhas que
 * **grudam** são a parte dela que **já saiu da viewport** (acima da primeira linha visível) —
 * senão o cabeçalho ainda está na tela e não há nada para grudar.
 *
 * Regras:
 * - com symbols do LSP: a envelope é o símbolo (ou a cadeia de símbolos aninhados) que
 *   **envolve** a linha do caret ⇒ o **mais externo** deles (o topo da cadeia);
 * - sem symbols (fallback por **indentação**): a envelope é o bloco cuja indentação é
 *   **menor** que a da linha do caret ⇒ a linha de abertura do bloco;
 * - o bloco precisa **envolver** a linha do caret (ser **estritamente acima**): se o bloco é a
 *   própria linha do caret, não há contexto;
 * - `maxLines` limita quantas linhas grudam (default 5).
 *
 * @param options Ver {@link StickyOptions}.
 * @returns O contexto (topo + nº de linhas) ou `undefined` se não há contexto.
 */
export function computeStickyContext(options: StickyOptions): StickyContext | undefined {
  const maxLines = Math.max(0, Math.trunc(options.maxLines ?? DEFAULT_STICKY_MAX_LINES));
  if (maxLines === 0) return undefined;

  const caretLine = options.caretLine;
  // A 1ª linha do arquivo não tem envelope: não há nada acima dela.
  if (caretLine <= 0) return undefined;

  const envelopeStart = envelopeStartOf(options, caretLine);
  if (envelopeStart === undefined) return undefined;
  // O bloco é a **própria linha** do caret (ex.: o cabeçalho do próprio símbolo) ⇒ sem contexto.
  if (envelopeStart >= caretLine) return undefined;

  // As linhas que grudam: a parte da envelope que **já saiu** da viewport (acima da 1ª linha
  // visível), limitada a `maxLines` e ao próprio bloco (nunca passa do caret).
  const count = Math.min(
    maxLines,
    options.firstVisibleLine - envelopeStart,
    caretLine - envelopeStart + 1,
  );
  if (count <= 0) return undefined;
  return { startLine: envelopeStart, count };
}

/**
 * Topo da envelope que envolve a linha do caret.
 *
 * Com symbols do LSP (há sempre), eles são a **única** fonte; sem eles, a indentação decide.
 */
function envelopeStartOf(options: StickyOptions, caretLine: number): number | undefined {
  const symbols = options.symbols;
  if (symbols !== undefined && symbols.length > 0) {
    return envelopeStartFromSymbols(symbols, caretLine);
  }
  return envelopeStartFromIndent(options.lineAt, caretLine);
}

/**
 * Topo da envelope pelos **symbols do LSP**: o símbolo mais **externo** que envolve a linha do
 * caret (o topo da cadeia de símbolos aninhados).
 *
 * O símbolo precisa envolver a caret **estritamente** (o cabeçalho do próprio símbolo é a linha
 * do caret ⇒ não é envelope).
 */
function envelopeStartFromSymbols(
  symbols: readonly StickySymbol[],
  caretLine: number,
): number | undefined {
  let start: number | undefined;
  for (const symbol of symbols) {
    if (symbol.startLine >= caretLine) continue; // o cabeçalho é a própria linha do caret
    if (caretLine > symbol.endLine) continue; // não envolve a linha do caret
    if (start === undefined || symbol.startLine < start) start = symbol.startLine;
  }
  return start;
}

/**
 * Topo da envelope pela **indentação** (fallback sem LSP).
 *
 * Sobe da linha do caret até a **primeira linha com indentação estritamente menor** — a "linha
 * de abertura" do bloco que envolve o caret.
 *
 * Linhas **em branco** são puladas: a indentação delas é 0 e elas não abrem bloco nenhum (sem
 * o pulo, uma linha em branco viraria a "envelope" de qualquer bloco).
 */
function envelopeStartFromIndent(
  lineAt: (line: number) => string,
  caretLine: number,
): number | undefined {
  const caretIndent = indentOf(lineAt(caretLine));
  for (let line = caretLine - 1; line >= 0; line--) {
    const text = lineAt(line);
    if (text.trim().length === 0) continue; // linha em branco não abre bloco
    if (indentOf(text) < caretIndent) return line;
  }
  return undefined;
}

/**
 * Nível de indentação de uma linha (colunas).
 *
 * Espaço = 1 coluna; tab = até o próximo **stop** de tabulação (como o editor desenha).
 */
function indentOf(text: string): number {
  let indent = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      indent += 1;
      continue;
    }
    if (ch === "\t") {
      indent += DEFAULT_TAB_WIDTH - (indent % DEFAULT_TAB_WIDTH);
      continue;
    }
    break;
  }
  return indent;
}

/**
 * Expande os símbolos do LSP em **intervalos de linhas** — o formato que o sticky usa.
 *
 * ⚠️ O bridge (`lsp.documentSymbols`) entrega o **selection range** do símbolo (o *nome* dele,
 * tipicamente numa única linha) — **não** o corpo. Como o envelope é um **intervalo**, o fim do
 * bloco é deduzido pela **indentação**: a linha da declaração + as linhas seguintes até a
 * primeira com indentação **menor ou igual** (ou o fim do documento).
 *
 * Símbolos que já vêm com extensão (`endLine > startLine`) são respeitados como estão.
 *
 * @param symbols Os símbolos do LSP (do bridge).
 * @param lineAt O texto das linhas (para medir a indentação).
 * @param lineCount Nº de linhas do documento.
 * @returns Um `StickySymbol` por símbolo, na mesma ordem.
 */
export function stickySymbolsFromLsp(
  symbols: readonly StickyLspSymbol[],
  lineAt: (line: number) => string,
  lineCount: number,
): StickySymbol[] {
  const out: StickySymbol[] = [];
  for (const symbol of symbols) {
    const startLine = symbol.range.startLine;
    const endLine = symbol.range.endLine;
    if (endLine > startLine) {
      out.push({ startLine, endLine });
      continue;
    }
    out.push({ startLine, endLine: blockEndByIndent(startLine, lineAt, lineCount) });
  }
  return out;
}

/**
 * Última linha do bloco que começa em `startLine`, pela **indentação**.
 *
 * O bloco vai até a 1ª linha **não vazia** com indentação ≤ a da linha de abertura (é a
 * desindentação que fecha o bloco). Linhas em branco não fecham nada.
 */
function blockEndByIndent(
  startLine: number,
  lineAt: (line: number) => string,
  lineCount: number,
): number {
  const indent = indentOf(lineAt(startLine));
  let end = startLine;
  for (let line = startLine + 1; line < lineCount; line++) {
    const text = lineAt(line);
    if (text.trim().length === 0) continue; // linha em branco: não fecha o bloco
    if (indentOf(text) <= indent) break; // desindentou (ou voltou ao mesmo nível) ⇒ fim do bloco
    end = line;
  }
  return end;
}
