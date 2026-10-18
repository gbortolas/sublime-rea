/**
 * Scribe — `SoftWrapUtil`: quebra visual de linha (P3#15).
 *
 * O soft wrap **não** modifica o texto no buffer — só muda como ele é exibido.
 * Cada linha de documento pode gerar N "segmentos visuais" (wrap segments),
 * cada um cabendo dentro de `wrapWidth` px.
 *
 * Uso:
 * ```ts
 * const segments = wrapLine(text, wrapWidth, measureText);
 * for (const seg of segments) { /* desenha seg.text na posição y += seg.y * lineHeight *\/ }
 * ```
 *
 * A medição de texto é injetada — o `GlyphAtlas.resolveGlyph(rune, style).advance`
 * é quem responde, mas o soft wrap só precisa de `textWidth(text): number`.
 */


/** Um segmento de linha quebrada: sub-string + largura em px. */
export interface WrapSegment {
  /** Offset inicial no texto original (code units UTF-16). */
  readonly start: number;
  /** Offset final (exclusive). */
  readonly end: number;
  /** O texto do segmento (substring). */
  readonly text: string;
  /** Largura em px. */
  readonly width: number;
}

/**
 * Quebra visual: divide o `texto` em segmentos que cabem em `maxWidth` px.
 *
 * Regras:
 * - Se um segmento couber inteiro, não quebra.
 * - A quebra é **oportunista**: tenta quebrar no último espaço antes de estourar.
 * - Sem espaço antes do estouro, quebra no caractere (glifo a glifo).
 * - Palavras mais largas que `maxWidth` **ultrapassam** (padrão Web: overflow).
 *
 * @param text Texto da linha do documento.
 * @param maxWidth Largura máxima em px (wrapWidth). `≤ 0` = sem quebra.
 * @param measureWidth Largura em px de um trecho de texto (deve bater com o atlas).
 * @returns Array de segmentos (`[]` se texto vazio, `[texto]` se maxWidth ≤ 0 ou couber).
 */
export function wrapLine(
  text: string,
  maxWidth: number,
  measureWidth: (text: string) => number,
): WrapSegment[] {
  if (text.length === 0 || maxWidth <= 0) {
    return [{ start: 0, end: text.length, text, width: measureWidth(text) }];
  }

  const segments: WrapSegment[] = [];
  let start = 0;

  while (start < text.length) {
    // Encontra o maior prefixo que cabe em maxWidth
    const rest = text.slice(start);
    const fullWidth = measureWidth(rest);
    if (fullWidth <= maxWidth) {
      // Cabe tudo
      segments.push({ start, end: text.length, text: rest, width: fullWidth });
      break;
    }

    // Busca binária: maior offset que ainda cabe
    let lo = 1;
    let hi = rest.length;
    let fit = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const w = measureWidth(rest.slice(0, mid));
      if (w <= maxWidth) {
        fit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (fit <= 0) {
      // Mesmo um caractere não cabe? overflow: pega 1 caractere (ou o espaço `maxWidth` não
      // é maior que o glifo mais largo — situação rara mas possível com fontes decorativas).
      fit = 1;
    }

    // Tenta quebrar em espaço (oportunista): volta para o último espaço em `fit`.
    // A quebra em espaço só é considerada se tiver espaço no segmento e se o espaço
    // não é o primeiro caractere.
    let breakAt = fit;
    const lastSpace = rest.lastIndexOf(" ", fit - 1);
    if (lastSpace > 0) {
      // Verifica se quebrar no espaço reduz a largura significativamente
      // (só quebra se não for a última palavra do segmento)
      if (fit - lastSpace <= 20) {
        breakAt = lastSpace; // quebra antes do espaço
      }
    }

    // Se `breakAt` for 0, avança 1 para evitar loop infinito
    if (breakAt <= 0) breakAt = 1;

    const segmentText = rest.slice(0, breakAt);
    segments.push({
      start,
      end: start + breakAt,
      text: segmentText,
      width: measureWidth(segmentText),
    });

    start += breakAt;
    // Pula espaços no início do próximo segmento (exceto se for o único conteúdo)
    while (start < text.length && text[start] === " ") {
      start += 1;
    }
  }

  return segments;
}

/**
 * Contagem total de linhas visuais para um `LineSource`.
 * Usado pelo viewport para calcular a altura de scroll correta.
 */
export function visualLineCount(
  lineCount: number,
  lineAt: (index: number) => string,
  maxWidth: number,
  measureWidth: (text: string) => number,
): number {
  if (maxWidth <= 0) return lineCount;
  let count = 0;
  for (let i = 0; i < lineCount; i++) {
    count += wrapLine(lineAt(i), maxWidth, measureWidth).length;
  }
  return count;
}

/**
 * Mapeia uma linha visual (índice absoluto entre todas as linhas visuais)
 * para a linha de documento + segmento de wrap correspondente.
 * Útil para caret navigation, scroll, gutter.
 */
export interface VisualLineRef {
  readonly docLine: number;
  readonly segmentIndex: number;
  readonly segment: WrapSegment;
  /** Offset inicial do segmento no texto original (code units UTF-16). */
  readonly startOffset: number;
}

/**
 * Encontra a linha visual `visualIndex` (0-based, absoluta) no documento.
 * Percorre as linhas de documento até acumular `visualIndex` segmentos.
 * Retorna `undefined` se o índice estiver fora do range.
 */
export function resolveVisualLine(
  visualIndex: number,
  lineCount: number,
  lineAt: (index: number) => string,
  maxWidth: number,
  measureWidth: (text: string) => number,
): VisualLineRef | undefined {
  if (visualIndex < 0) return undefined;
  let accumulated = 0;
  for (let docLine = 0; docLine < lineCount; docLine++) {
    const segments = wrapLine(lineAt(docLine), maxWidth, measureWidth);
    if (visualIndex < accumulated + segments.length) {
      const segIdx = visualIndex - accumulated;
      const seg = segments[segIdx]!;
      return { docLine, segmentIndex: segIdx, segment: seg, startOffset: seg.start };
    }
    accumulated += segments.length;
  }
  return undefined;
}