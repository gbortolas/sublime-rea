/**
 * Scribe — `tokenizer.ts`: o **motor de execução** da gramática (DEC-PKG-8).
 *
 * Recebe a forma compilada (`CompiledGrammar`, produzida por `grammar.ts`) e casa uma linha por
 * vez, empilhando/desempilhando contextos. O vocabulário é o do formato (§2.3): `match`, `scope`,
 * `captures`, `include`, `push`, `set`, `pop`.
 *
 * Invariantes (provadas no teste):
 * - **puro e determinístico**: a mesma linha + o mesmo estado ⇒ os mesmos spans;
 * - os spans são **não sobrepostos** e **cobrem a linha inteira**; o trecho sem regra fica com o
 *   escopo-base da **gramática dona do contexto do topo** da pilha;
 * - `captures` recorta o casamento: a captura **mais interna** vence no seu range;
 * - casamento de **comprimento zero** é ignorado (avança um code unit) — evita laço infinito;
 * - `include` circulares não travam (o conjunto `visiting` corta a recursão, por **ramo**);
 * - linhas acima de `MAX_TOKENIZE_LINE_LENGTH` são tokenizadas **só no prefixo**, a cauda volta com
 *   `TOKENIZE_LIMIT_SCOPE` e o estado devolvido é **neutralizado** (prefixo cortado não propaga
 *   estado parcial — degradação explícita, ver comentário das constantes).
 *
 * Escolhas nossas (a spec deixava em aberto): o estado é a pilha de contextos; spans planos (sem
 * aninhamento) resolvidos por "captura mais interna vence"; `^`/`\A` de Oniguruma não são emulados
 * (usamos `RegExp` com as flags `d` e `y`).
 */
import { GrammarParseError } from "../../shared";
import type { HighlightSpan, Scope } from "../../shared";

/** Captura compilada: grupo numerado (`group >= 0`) ou nomeado (`name !== null`). */
export interface CompiledCapture {
  readonly group: number;
  readonly name: string | null;
  readonly scope: Scope;
}

/** Regra compilada: ou casa por regex, ou inclui outro contexto (`include`). */
export interface CompiledPattern {
  readonly matcher: RegExp | null;
  readonly scope: Scope | null;
  readonly captures: readonly CompiledCapture[];
  readonly include: string | null;
  readonly push: string | null;
  readonly set: string | null;
  readonly pop: boolean;
}

/** Gramática compilada: tabela de contextos + metadados. */
export interface CompiledGrammar {
  readonly logicalName: string;
  readonly name: string;
  readonly scope: Scope;
  readonly fileExtensions: readonly string[];
  readonly contexts: ReadonlyMap<string, readonly CompiledPattern[]>;
  /**
   * Escopo-base da gramática **dona** de cada contexto (o `include` de outra gramática funde os
   * contextos dela nesta tabela). O trecho sem regra herda o escopo da gramática do contexto do
   * topo, não o da gramática-raiz (ver `baseScopeOf`).
   */
  readonly contextScopes: ReadonlyMap<string, Scope>;
}

const INITIAL_CONTEXT = "main";

/**
 * Teto de **mitigação de custo** da tokenização.
 *
 * Contexto: a regex vem de uma gramática carregada em runtime e é aplicada a **texto do usuário**,
 * de forma **síncrona no processo `main`** — uma regex com quantificador aninhado (`(a+)+$`) pode
 * fazer o motor de backtracking explodir e **congelar a app**. Não há timeout por regex (decisão
 * explícita: `RegExp` do JS não é interrompível), então limitamos o **insumo**: só tokenizamos o
 * prefixo da linha. Acima do teto, a cauda volta com `TOKENIZE_LIMIT_SCOPE` — degradação
 * **explícita e determinística**, nunca spans parcialmente errados apresentados como certos.
 *
 * Valores (escolha nossa, não observada no alvo): `4096` code units UTF-16 é ~4 KB, muito acima de
 * qualquer linha escrita à mão e abaixo do tamanho típico de arquivos minificados, que passam a ser
 * realçados só no prefixo.
 *
 * **O teto é por LINHA, não por documento.** Nada aqui limita quantas linhas o consumidor pede: o
 * `highlightDocument` do `core/editor` tokeniza do estado inicial até a **linha visível absoluta**
 * pedida (custo O(`end`) por chamada, `src/core/editor/editor-core.ts:549`). Vetor residual
 * conhecido: *deep scroll* + keystroke em documento grande re-tokenizam o prefixo inteiro a cada
 * revisão — registrado como risco **aberto** em `docs/BACKLOG.md` §P2.4b.
 *
 * Limite declarado: o teto limita o **insumo por linha**, não é prova contra backtracking
 * catastrófico dentro do prefixo — barrar isso de verdade exigiria analisar a regex no compile-time
 * ou rodar o motor num worker com prazo, ambos fora do escopo desta mitigação.
 */
export const MAX_TOKENIZE_LINE_LENGTH = 4096;

/**
 * Escopo-marcador da cauda **não tokenizada** (linha acima de `MAX_TOKENIZE_LINE_LENGTH`). É um
 * escopo próprio de propósito: aparece nos spans (assertável em teste) e **não** casa nenhum
 * selector do tema default, logo cai na cor default do layout — o usuário vê texto sem destaque,
 * não um destaque inventado.
 */
export const TOKENIZE_LIMIT_SCOPE: Scope = "text.unparsed.syntax-limit";

/**
 * Aviso de degradação: **uma vez por gramática** (não a cada linha acima do teto). O estado é por
 * **instância** compilada (`WeakSet`, morre com a gramática): nada de `Set` global por nome lógico,
 * que suprimiria o aviso de outra gramática (outro registry/teste) com o mesmo nome.
 */
const limitWarned = new WeakSet<CompiledGrammar>();

function warnLineLimit(grammar: CompiledGrammar): void {
  if (limitWarned.has(grammar)) return;
  limitWarned.add(grammar);
  console.warn(
    `Scribe: linha acima de ${MAX_TOKENIZE_LINE_LENGTH} code units em "${grammar.logicalName}" — ` +
      `tokenizando só o prefixo (cauda com escopo "${TOKENIZE_LIMIT_SCOPE}")`,
  );
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly scope: Scope;
}

interface MatchHit {
  readonly pattern: CompiledPattern;
  readonly match: RegExpExecArray;
  readonly end: number;
}

/** Tokeniza uma linha. `state` é opaco na fronteira; aqui é `{ stack: readonly string[] }`. */
export function tokenizeCompiledLine(
  grammar: CompiledGrammar,
  line: string,
  state: unknown,
): { readonly spans: readonly HighlightSpan[]; readonly state: unknown } {
  const stack = resolveStack(grammar, state);
  const segments: Segment[] = [];
  // Teto de insumo (ver `MAX_TOKENIZE_LINE_LENGTH`): o motor só roda sobre o prefixo limitado.
  const bounded = line.length > MAX_TOKENIZE_LINE_LENGTH ? line.slice(0, MAX_TOKENIZE_LINE_LENGTH) : line;
  const length = bounded.length;
  let position = 0;

  while (position < length) {
    const top = stack[stack.length - 1] ?? INITIAL_CONTEXT;
    const hit = matchInContext(grammar, top, bounded, position, new Set());
    if (hit === null || hit.end <= position) {
      segments.push({ start: position, end: position + 1, scope: baseScopeOf(grammar, top) });
      position += 1;
      continue;
    }
    emitMatch(segments, position, hit.end, hit, baseScopeOf(grammar, top));
    position = hit.end;
    applyActions(stack, hit.pattern);
  }

  if (bounded.length < line.length) {
    warnLineLimit(grammar);
    segments.push({ start: bounded.length, end: line.length, scope: TOKENIZE_LIMIT_SCOPE });
    // Estado **neutralizado**: a pilha veio de um prefixo cortado no meio de um construto (uma `"`
    // ou um `/*` partido ao meio), então propagá-la coloriria o resto do documento errado **em
    // silêncio**. Voltar ao contexto inicial é degradação declarada: a linha seguinte é tokenizada
    // do zero, nunca a partir de um estado parcial.
    return { spans: mergeSegments(segments), state: { stack: [INITIAL_CONTEXT] } };
  }

  return { spans: mergeSegments(segments), state: { stack } };
}

/** Escopo do trecho sem regra: o da gramática dona do contexto do topo (fallback: a raiz). */
function baseScopeOf(grammar: CompiledGrammar, context: string): Scope {
  return grammar.contextScopes.get(context) ?? grammar.scope;
}

function resolveStack(grammar: CompiledGrammar, state: unknown): string[] {
  if (state === undefined || state === null) return [INITIAL_CONTEXT];
  const raw = readStack(state);
  if (raw === null) {
    throw new GrammarParseError(grammar.logicalName, "estado de tokenização inválido");
  }
  // Nomes desconhecidos (ex.: gramática recompilada) são descartados; pilha vazia reinicia em `main`.
  const known = raw.filter((name) => grammar.contexts.has(name));
  return known.length > 0 ? [...known] : [INITIAL_CONTEXT];
}

function readStack(state: unknown): string[] | null {
  if (typeof state !== "object" || state === null) return null;
  const stack = (state as { stack?: unknown }).stack;
  if (!Array.isArray(stack)) return null;
  const out: string[] = [];
  for (const entry of stack) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/** Primeiro casamento na ordem do contexto, seguindo `include` (o `visiting` corta ciclos). */
function matchInContext(
  grammar: CompiledGrammar,
  name: string,
  line: string,
  position: number,
  visiting: ReadonlySet<string>,
): MatchHit | null {
  const patterns = grammar.contexts.get(name);
  if (patterns === undefined) return null;
  for (const pattern of patterns) {
    if (pattern.include !== null) {
      if (visiting.has(pattern.include)) continue;
      // `visiting` é o caminho de recursão **deste ramo** (cópia por ramo): mutar o conjunto do
      // chamador suprimiria includes legítimos de ramos seguintes que passaram pelo mesmo contexto.
      const branch = new Set(visiting);
      branch.add(pattern.include);
      const nested = matchInContext(grammar, pattern.include, line, position, branch);
      if (nested !== null) return nested;
      continue;
    }
    const matcher = pattern.matcher;
    if (matcher === null) continue;
    matcher.lastIndex = position;
    const match = matcher.exec(line);
    if (match === null) continue;
    const text = match[0];
    if (text.length === 0) continue;
    return { pattern, match, end: position + text.length };
  }
  return null;
}

function emitMatch(
  segments: Segment[],
  start: number,
  end: number,
  hit: MatchHit,
  baseScope: Scope,
): void {
  const matchScope = hit.pattern.scope ?? baseScope;
  const captures = hit.pattern.captures;
  if (captures.length === 0) {
    segments.push({ start, end, scope: matchScope });
    return;
  }
  const ranges: { readonly start: number; readonly end: number; readonly scope: Scope; readonly size: number }[] = [];
  const boundaries = new Set<number>([start, end]);
  for (const capture of captures) {
    const range = captureRange(hit.match, capture);
    if (range === null) continue;
    const [from, to] = range;
    if (from < start || to > end || to <= from) continue;
    ranges.push({ start: from, end: to, scope: capture.scope, size: to - from });
    boundaries.add(from);
    boundaries.add(to);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index] ?? start;
    const to = points[index + 1] ?? end;
    let best: { readonly scope: Scope; readonly size: number } | null = null;
    for (const range of ranges) {
      if (range.start <= from && range.end >= to && (best === null || range.size < best.size)) {
        best = { scope: range.scope, size: range.size };
      }
    }
    segments.push({ start: from, end: to, scope: best?.scope ?? matchScope });
  }
}

function captureRange(match: RegExpExecArray, capture: CompiledCapture): readonly [number, number] | null {
  const indices = match.indices;
  if (indices === undefined) return null;
  if (capture.name !== null) {
    const named = indices.groups?.[capture.name];
    return named === undefined ? null : [named[0], named[1]];
  }
  const group = indices[capture.group];
  return group === undefined ? null : [group[0], group[1]];
}

function applyActions(stack: string[], pattern: CompiledPattern): void {
  if (pattern.pop) stack.pop();
  if (pattern.set !== null) {
    stack.pop();
    stack.push(pattern.set);
  } else if (pattern.push !== null) {
    stack.push(pattern.push);
  }
  if (stack.length === 0) stack.push(INITIAL_CONTEXT);
}

function mergeSegments(segments: readonly Segment[]): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (const segment of segments) {
    if (segment.end <= segment.start) continue;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end === segment.start && last.scope === segment.scope) {
      spans[spans.length - 1] = { start: last.start, end: segment.end, scope: last.scope };
      continue;
    }
    spans.push({ start: segment.start, end: segment.end, scope: segment.scope });
  }
  return spans;
}
