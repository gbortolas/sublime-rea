/**
 * Scribe — `ViewportImpl`: janela virtualizada com *damage* retangular (DEC-REN-4).
 *
 * Padrão do alvo (reimplementação nossa — **escolha nossa, não observada no alvo**): *data source*
 * + *observers* + **alvo animado** (`REN-E19`), frames agendados por um *tick* injetado (o alvo usa
 * o *tick* do toolkit; nós usamos `requestAnimationFrame` — `REN-E3`).
 *
 * Critério de visibilidade (**nosso**, pois `REN-U1` ficou em aberto): range por **índice de linha**
 * `floor(offset / lineHeight) .. + ceil(viewportHeight / lineHeight)`, mais `overscan` opcional.
 *
 * Determinismo: `now()` e `requestFrame()` são **injetados** — nada de `setInterval`, nada de relógio
 * implícito. O *damage* é **coalescido** por índice de linha: N passos de scroll geram **uma** região
 * por linha tocada (em coordenadas de conteúdo: `y = linha * lineHeight`).
 *
 * ⚠️ **Soft wrap — a deriva declarada**: o `offsetPx` é contado em **linhas lógicas**, mas o
 * desenho usa **rows visuais** (1 row por segmento de wrap). Para alinhar, injete um
 * `VisualRowMapper` (`setVisualRowMapper`): com ele o viewport passa a contar em rows visuais
 * (o `offsetPx` = rows × `lineHeight`) e `visibleLineRange()` devolve as linhas lógicas que
 * cobrem as rows visíveis. Sem o mapper, o comportamento legado (linhas lógicas) é preservado.
 */

import type { DamageRects, Rect, Viewport, ViewportObserver } from "../../shared";
import type { Disposable } from "../../shared";

/** Range de linhas (início + contagem) — metade do contrato de `visibleLineRange()`. */
export interface LineRange {
  readonly first: number;
  readonly count: number;
}

/**
 * Range de **rows visuais** (início + contagem) — a unidade da rolagem com soft wrap.
 *
 * Mesma forma de `LineRange`, outra unidade: com o `VisualRowMapper` ativo, a row é a
 * **row visual** (1 por segmento de wrap); sem ele, a row é a linha lógica (1:1).
 */
export interface RowRange {
  readonly first: number;
  readonly count: number;
}

export interface ViewportMetrics {
  readonly lineCount: number;
  readonly lineHeight: number;
  /** Altura da área visível em px lógicos. */
  readonly viewportHeight: number;
  /** Largura da área visível em px lógicos (usada na largura dos retângulos de dano). */
  readonly viewportWidth: number;
  /** Linhas extras acima/abaixo (default 0 — mantém a virtualização estrita nos testes). */
  readonly overscan?: number;
  /**
   * Total de linhas visuais (com soft wrap) para o cálculo de scroll.
   * Default: `lineCount` (sem wrap). Quando > `lineCount`, o scroll height
   * passa a considerar wraps.
   */
  readonly visualLineCount?: number;
}

/**
 * Mapa **row visual ↔ linha lógica** (injetado pelo renderer quando o soft wrap está ativo).
 *
 * ⚠️ **A deriva declarada**: sem este mapa, o viewport conta a rolagem em **linhas lógicas**
 * (`offsetPx = linha * lineHeight`) enquanto o desenho usa **rows visuais** (1 row por segmento
 * de wrap) ⇒ o texto e a barra de rolagem não batem. Com o mapa, o viewport passa a contar em
 * **rows visuais** de forma coerente:
 *
 * - `offsetPx` = nº de rows visuais × `lineHeight`;
 * - `visibleLineRange()` devolve as **linhas lógicas** que cobrem as rows visíveis;
 * - `scrollTo(linha)` rola até a **1ª row** da linha lógica.
 */
export interface VisualRowMapper {
  /** Row visual da primeira row da linha lógica `line`. */
  rowOfLine(line: number): number;
  /** Linha lógica que contém a row visual `row`. */
  lineOfRow(row: number): number;
}

export interface ViewportOptions extends ViewportMetrics {
  /** Relógio injetado (determinismo; em produção: `performance.now`). */
  readonly now: () => number;
  /** Agendador de frame injetado (em produção: `requestAnimationFrame`). */
  readonly requestFrame: (cb: (now: number) => void) => Disposable;
  /** Duração da animação de scroll (ms). `0`/ausente = salto imediato. */
  readonly scrollDurationMs?: number;
  /**
   * Modo **soft wrap**: mapa row visual ↔ linha lógica. Quando presente (e `visualLineCount`
   * informado), o viewport conta a rolagem em **rows visuais** — ver `VisualRowMapper`.
   */
  readonly visualRowMapper?: VisualRowMapper;
}

type ResolvedMetrics = Required<Omit<ViewportMetrics, "visualLineCount">> & { visualLineCount?: number };

interface AnimationState {
  readonly from: number;
  readonly to: number;
  readonly start: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class ViewportImpl implements Viewport {
  private metrics: ResolvedMetrics;
  private readonly nowFn: () => number;
  private readonly requestFrameFn: (cb: (now: number) => void) => Disposable;
  private readonly scrollDurationMs: number;
  /** Mapa row visual ↔ linha lógica (modo soft wrap). `undefined` = modo linhas lógicas. */
  private visualRowMapper: VisualRowMapper | undefined;

  private readonly observers = new Set<ViewportObserver>();
  private readonly damageLines = new Set<number>();
  private offsetPx = 0;
  private animation: AnimationState | null = null;
  private animationHandle: Disposable | undefined;
  private disposed = false;

  constructor(options: ViewportOptions) {
    this.metrics = {
      lineCount: options.lineCount,
      lineHeight: options.lineHeight,
      viewportHeight: options.viewportHeight,
      viewportWidth: options.viewportWidth,
      overscan: options.overscan ?? 0,
      ...(options.visualLineCount !== undefined ? { visualLineCount: options.visualLineCount } : {}),
    };
    this.nowFn = options.now;
    this.requestFrameFn = options.requestFrame;
    this.scrollDurationMs = options.scrollDurationMs ?? 0;
    this.visualRowMapper = options.visualRowMapper;
  }

  /**
   * Ativa/desativa o modo **soft wrap** (rows visuais).
   *
   * Com o mapa informado, o `offsetPx` passa a ser contado em **rows visuais**
   * (`row * lineHeight`) e `visibleLineRange()` devolve as linhas lógicas que cobrem as rows
   * visíveis — é o que elimina a deriva entre o texto desenhado e a barra de rolagem.
   */
  setVisualRowMapper(mapper: VisualRowMapper | undefined): void {
    this.visualRowMapper = mapper;
  }

  /** Range visível (virtualização): só estas linhas geram instâncias. */
  visibleLineRange(): LineRange {
    const { lineHeight, viewportHeight, lineCount, overscan } = this.metrics;
    if (lineCount <= 0 || lineHeight <= 0 || viewportHeight <= 0) {
      return { first: 0, count: 0 };
    }
    const visible = Math.ceil(viewportHeight / lineHeight);
    const mapper = this.visualRowMapper;
    if (mapper !== undefined) {
      // Modo soft wrap: o offset é contado em ROWS VISUAIS — as linhas lógicas a materializar
      // são as que cobrem as rows visíveis.
      const firstRow = Math.floor(this.offsetPx / lineHeight);
      const lastRow = firstRow + visible - 1;
      const first = Math.max(0, mapper.lineOfRow(firstRow) - overscan);
      const end = Math.min(lineCount, mapper.lineOfRow(lastRow) + 1 + overscan);
      return { first, count: Math.max(0, end - first) };
    }
    const firstVisible = Math.floor(this.offsetPx / lineHeight);
    const first = Math.max(0, firstVisible - overscan);
    const end = Math.min(lineCount, firstVisible + visible + overscan);
    return { first, count: Math.max(0, end - first) };
  }

  subscribe(observer: ViewportObserver): () => void {
    if (this.disposed) return () => undefined;
    this.observers.add(observer);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      this.observers.delete(observer);
    };
  }

  scrollTo(line: number, opts?: { readonly animate?: boolean }): void {
    if (this.disposed) return;
    const { lineHeight, lineCount } = this.metrics;
    const targetLine = clamp(Math.round(line), 0, Math.max(0, lineCount - 1));
    // Modo soft wrap: a linha lógica `targetLine` pode ocupar várias rows — rola até a 1ª.
    const mapper = this.visualRowMapper;
    const targetRow = mapper !== undefined ? mapper.rowOfLine(targetLine) : targetLine;
    const target = clamp(targetRow * lineHeight, 0, this.maxScrollPx());
    this.scrollToOffset(target, opts?.animate === true);
  }

  /**
   * Rola `delta` **rows visuais** (não linhas lógicas).
   *
   * ⚠️ **Por que**: com soft wrap, uma linha lógica pode ocupar N rows — rolar "3 linhas"
   * movia N×3 rows (a roda do mouse pulava o texto). Aqui a unidade é a **row**: `delta = 3`
   * move 3 rows, sempre.
   *
   * Sem o `VisualRowMapper` (modo legado), 1 row = 1 linha lógica ⇒ o comportamento
   * observado é o de sempre.
   *
   * @param delta Nº de rows (positivo = para baixo, negativo = para cima).
   * @param opts `animate: true` usa a animação de scroll configurada.
   */
  scrollByRows(delta: number, opts?: { readonly animate?: boolean }): void {
    if (this.disposed) return;
    const { lineHeight } = this.metrics;
    if (lineHeight <= 0) return;
    const steps = Math.trunc(delta);
    if (steps === 0) return;
    const currentRow = Math.round(this.offsetPx / lineHeight);
    // Teto em rows (o offset final tem de cair numa fronteira de row).
    const maxRow = Math.max(0, Math.floor(this.maxScrollPx() / lineHeight));
    const targetRow = clamp(currentRow + steps, 0, maxRow);
    this.scrollToOffset(targetRow * lineHeight, opts?.animate === true);
  }

  /**
   * Range de **rows visuais** atualmente visível (a mesma unidade do offset de rolagem).
   *
   * Com o `VisualRowMapper` ativo, a row é a row visual do soft wrap; sem ele, a row é a
   * linha lógica (1:1). É a unidade que a roda do mouse e o PageUp/PageDown devem usar.
   *
   * ⚠️ Não inclui o `overscan` (a faixa lógica já o aplica) — o `count` é exatamente o
   * número de rows que cabem na viewport (1 tela).
   */
  visibleRowRange(): RowRange {
    const { lineHeight, viewportHeight, lineCount } = this.metrics;
    if (lineCount <= 0 || lineHeight <= 0 || viewportHeight <= 0) {
      return { first: 0, count: 0 };
    }
    const first = Math.floor(this.offsetPx / lineHeight);
    const visible = Math.ceil(viewportHeight / lineHeight);
    const totalRows = this.metrics.visualLineCount ?? lineCount;
    const count = Math.max(0, Math.min(totalRows - first, visible));
    return { first, count };
  }

  /** Damage acumulado (coalescido por linha) desde o último `takeDamage()`. */
  takeDamage(): DamageRects {
    if (this.damageLines.size === 0) return [];
    const indices = [...this.damageLines].sort((a, b) => a - b);
    this.damageLines.clear();
    return indices.map((index) => this.rectForLine(index));
  }

  /** Offset de rolagem atual em px (método de conveniência; não é do contrato). */
  scrollOffsetPx(): number {
    return this.offsetPx;
  }

  /** Atualiza métricas quando o documento/canvas muda (ex.: resize, edição). */
  setMetrics(next: Partial<ViewportMetrics>): void {
    if (this.disposed) return;
    this.metrics = {
      lineCount: next.lineCount ?? this.metrics.lineCount,
      lineHeight: next.lineHeight ?? this.metrics.lineHeight,
      viewportHeight: next.viewportHeight ?? this.metrics.viewportHeight,
      viewportWidth: next.viewportWidth ?? this.metrics.viewportWidth,
      overscan: next.overscan ?? this.metrics.overscan,
      ...(next.visualLineCount !== undefined ? { visualLineCount: next.visualLineCount } : this.metrics.visualLineCount !== undefined ? { visualLineCount: this.metrics.visualLineCount } : {}),
    };
    const clamped = clamp(this.offsetPx, 0, this.maxScrollPx());
    if (clamped !== this.offsetPx) this.applyOffset(clamped);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAnimation();
    this.observers.clear();
    this.damageLines.clear();
  }

  /**
   * Teto de rolagem (px).
   *
   * Com soft wrap, `visualLineCount` é o total de **rows visuais** ⇒ o teto é contado em rows
   * visuais (coerente com o `offsetPx` quando o `VisualRowMapper` está ativo).
   */
  private maxScrollPx(): number {
    const totalLines = this.metrics.visualLineCount ?? this.metrics.lineCount;
    return Math.max(0, totalLines * this.metrics.lineHeight - this.metrics.viewportHeight);
  }

  private cancelAnimation(): void {
    this.animation = null;
    this.animationHandle?.dispose();
    this.animationHandle = undefined;
  }

  /**
   * Aplica um novo offset (em px) e notifica o dano — com animação opcional.
   *
   * O alvo é sempre um offset **já clampado** pelo chamador.
   */
  private scrollToOffset(target: number, animate: boolean): void {
    const useAnimation = animate && this.scrollDurationMs > 0;
    this.cancelAnimation();

    if (!useAnimation || Math.abs(target - this.offsetPx) < 0.5) {
      const touched = this.applyOffset(target);
      this.notify(touched);
      return;
    }

    const from = this.offsetPx;
    const start = this.nowFn();
    const animation: AnimationState = { from, to: target, start };
    this.animation = animation;
    const step = (now: number): void => {
      if (this.animation !== animation) return; // cancelada
      const t = clamp((now - start) / this.scrollDurationMs, 0, 1);
      const touched = this.applyOffset(from + (target - from) * easeInOutCubic(t));
      if (t >= 1) {
        this.animation = null;
        this.animationHandle = undefined;
        this.notify(touched);
        return;
      }
      this.notify(touched);
      this.animationHandle = this.requestFrameFn(step);
    };
    this.animationHandle = this.requestFrameFn(step);
  }

  /**
   * Aplica um novo offset e devolve as linhas **tocadas** (diferença simétrica das linhas visíveis
   * antes/depois). Linhas que apenas transladam não entram no dano — a região é reutilizada.
   */
  private applyOffset(next: number): number[] {
    const before = this.visibleLineIndices();
    this.offsetPx = clamp(next, 0, this.maxScrollPx());
    const after = this.visibleLineIndices();
    const touched: number[] = [];
    for (const index of before) {
      if (!after.has(index)) touched.push(index);
    }
    for (const index of after) {
      if (!before.has(index)) touched.push(index);
    }
    for (const index of touched) this.damageLines.add(index);
    return touched;
  }

  private visibleLineIndices(): Set<number> {
    const { first, count } = this.visibleLineRange();
    const set = new Set<number>();
    for (let i = first; i < first + count; i++) set.add(i);
    return set;
  }

  private rectForLine(index: number): Rect {
    const { lineHeight, viewportWidth } = this.metrics;
    const mapper = this.visualRowMapper;
    if (mapper !== undefined) {
      // Modo soft wrap: a linha lógica ocupa 1..N rows — o dano cobre todas elas.
      const firstRow = mapper.rowOfLine(index);
      const lastRow = Math.max(firstRow + 1, mapper.rowOfLine(index + 1));
      return {
        x: 0,
        y: firstRow * lineHeight,
        w: viewportWidth,
        h: (lastRow - firstRow) * lineHeight,
      };
    }
    return {
      x: 0,
      y: index * lineHeight,
      w: viewportWidth,
      h: lineHeight,
    };
  }

  private notify(touched: readonly number[]): void {
    if (touched.length === 0 || this.observers.size === 0) return;
    const rects: DamageRects = touched.map((index) => this.rectForLine(index));
    let firstError: unknown;
    for (const observer of [...this.observers]) {
      try {
        observer.onDamage(rects);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
