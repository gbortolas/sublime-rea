/**
 * Scribe — sessão de snippet (P4#18): ciclagem de tab stops, espelhos ao vivo e fim da sessão.
 *
 * Estado **puro** (sem DOM/IPC): ranges absolutos no documento, índice atual na ordem de visita
 * e um *snapshot* do conteúdo da expansão. Toda transição é imutável — `nextTabStop`/
 * `previousTabStop`/`applyEdit` devolvem sessão nova ou `null` (fim da sessão), e os
 * espelhos/ancestrais a re-renderizar saem em `session.updates` para o chamador aplicar via
 * ponte (1 roundtrip por espelho, **na ordem da lista**: cada `start/end` já é válido no
 * documento no momento exato daquela aplicação, porque o snapshot interno evolui na mesma
 * sequência).
 *
 * Aninhamento usa a estrutura da árvore de parse (`id`/`parentId` das ocorrências), **não** a
 * sobreposição de ranges — dois campos irmãos podem encostar no mesmo offset e ranges planos
 * não os distinguem de um ancestral verdadeiro.
 *
 * **Escolhas**: uma parada declarada como `${N|a,b,c|}` carrega a lista de opções
 * (`SnippetField.choices`) e a opção escolhida (`choiceIndex`); `currentChoice` expõe o estado
 * da parada atual e `chooseSnippetOption` troca a opção (re-renderizando espelhos/ancestrais
 * como um `applyEdit`).
 *
 * Testado direto em `test/renderer-snippet-session.test.ts`.
 */
import { renderTransform } from "./snippets";
import type { SnippetExpansion, SnippetOccurrence, SnippetTransform } from "./snippets";

export { renderTransform };

/** Campo da expansão no documento (primária ou espelho), com offsets **absolutos**. */
export interface SnippetField {
  /** `id` da ocorrência de origem (identidade estável entre deslocamentos). */
  readonly id: number;
  /** `id` do campo contêiner (aninhamento), ou `-1` na raiz. */
  readonly parentId: number;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly isPrimary: boolean;
  readonly transform?: SnippetTransform;
  /** Opções da escolha (`${1|a,b,c|}`) — ausente quando o campo não é uma escolha. */
  readonly choices?: readonly string[];
  /** Índice da opção **escolhida** (0-based) — presente só em campos com `choices`. */
  readonly choiceIndex?: number;
}

/** Substituição a aplicar via ponte (espelho/ancestral re-renderizado). */
export interface SnippetReplacement {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

export interface SnippetSession {
  /** Offset absoluto onde começa a expansão. */
  readonly base: number;
  /** Offset absoluto do fim da expansão (`base + text.length`). */
  readonly end: number;
  /** Snapshot do conteúdo atual da expansão (a verdade do documento fica no chamador). */
  readonly text: string;
  /** Todos os campos (primárias + espelhos), em ordem do documento. */
  readonly fields: readonly SnippetField[];
  /** Índices na ordem de visita (ascendente, `$0` por último). */
  readonly visitOrder: readonly number[];
  /** Posição atual em `visitOrder` (a parada selecionada na criação é a 0). */
  readonly current: number;
  /** Espelhos/ancestrais a aplicar, gerados pelo último `applyEdit` (vazio nos demais casos). */
  readonly updates: readonly SnippetReplacement[];
}

/** Parada de tabulação selecionável (intervalo absoluto). */
export interface SnippetStop {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  /** Opções quando a parada é uma **escolha** (`${1|a,b,c|}`). */
  readonly choices?: readonly string[];
  /** Índice da opção escolhida (0-based). */
  readonly choiceIndex?: number;
}

/** Estado de "esta tab stop é uma escolha" (opções + opção escolhida). */
export interface SnippetChoice {
  /** Índice do tab stop (`$N`) da escolha. */
  readonly index: number;
  /** Opções declaradas no template. */
  readonly choices: readonly string[];
  /** Índice da opção **escolhida** (0-based). */
  readonly selected: number;
  /** Intervalo absoluto do campo (primária) da escolha. */
  readonly start: number;
  readonly end: number;
}

/** Resultado da navegação: sessão já avançada + parada a selecionar. */
export interface SnippetStopTarget {
  readonly session: SnippetSession;
  readonly stop: SnippetStop;
}

/** Intervalo absoluto (edição ou clique). */
export interface SnippetEditRange {
  readonly start: number;
  readonly end: number;
}

function fieldOf(occ: SnippetOccurrence, base: number): SnippetField {
  return {
    id: occ.id,
    parentId: occ.parentId,
    index: occ.index,
    start: base + occ.start,
    end: base + occ.end,
    isPrimary: occ.isPrimary,
    ...(occ.transform !== undefined ? { transform: occ.transform } : {}),
    ...(occ.choices !== undefined ? { choices: occ.choices, choiceIndex: occ.choiceIndex ?? 0 } : {}),
  };
}

/**
 * Cria a sessão para uma expansão recém-aplicada em `base` (offset absoluto do 1º caractere).
 * A parada atual é a primeira da ordem de visita; `updates` começa vazio.
 */
export function createSnippetSession(expansion: SnippetExpansion, base: number): SnippetSession {
  return {
    base,
    end: base + expansion.text.length,
    text: expansion.text,
    fields: expansion.occurrences.map((o) => fieldOf(o, base)),
    visitOrder: expansion.visitOrder,
    current: 0,
    updates: [],
  };
}

/** Intervalo completo da expansão no documento (checagem de cliques). */
export function sessionRange(s: SnippetSession): { readonly start: number; readonly end: number } {
  return { start: s.base, end: s.end };
}

/** Parada selecionada agora (`null` se a ordem de visita acabou ou o campo primário sumiu). */
export function currentStop(s: SnippetSession): SnippetStop | null {
  const index = s.visitOrder[s.current];
  if (index === undefined) return null;
  const field = s.fields.find((f) => f.index === index && f.isPrimary);
  if (field === undefined) return null;
  return {
    index: field.index,
    start: field.start,
    end: field.end,
    ...(field.choices !== undefined ? { choices: field.choices, choiceIndex: field.choiceIndex ?? 0 } : {}),
  };
}

function targetFor(s: SnippetSession, position: number): SnippetStopTarget | null {
  const index = s.visitOrder[position];
  if (index === undefined) return null;
  const field = s.fields.find((f) => f.index === index && f.isPrimary);
  if (field === undefined) return null;
  return {
    session: { ...s, current: position },
    stop: {
      index: field.index,
      start: field.start,
      end: field.end,
      ...(field.choices !== undefined
        ? { choices: field.choices, choiceIndex: field.choiceIndex ?? 0 }
        : {}),
    },
  };
}

/**
 * Avança para a próxima parada. `null` = fim da sessão: passou do último **ou** o próximo
 * alvo é `$0` (o chamador então posiciona seleção no campo `$0` de `s.fields`, se houver, e
 * descarta a sessão).
 */
export function nextTabStop(s: SnippetSession): SnippetStopTarget | null {
  const next = s.current + 1;
  const index = s.visitOrder[next];
  if (index === undefined || index === 0) return null;
  return targetFor(s, next);
}

/** Retrocede para a parada anterior. `null` = fim da sessão (já está na primeira). */
export function previousTabStop(s: SnippetSession): SnippetStopTarget | null {
  if (s.current === 0) return null;
  const index = s.visitOrder[s.current - 1];
  if (index === undefined) return null;
  return targetFor(s, s.current - 1);
}

/** O campo `f` contém a edição inteira (inserção exatamente num limite zero-width também). */
function contains(f: SnippetField, edit: SnippetEditRange): boolean {
  return f.start <= edit.start && edit.end <= f.end;
}

/**
 * Desloca todos os campos para uma edição já aplicada ao texto.
 *
 * Ordem importa: o campo editado e os ancestrais **estuturais** (cadeia `parentId`) estendem o
 * `end`; depois vêm os que começam no/after da edição (deslocam) e os que terminam antes
 * (inalterados). Um irmão que encosta no limite da edição cai na regra de deslocamento — é
 * aqui que a informação de aninhamento (e não o range) decide certo.
 */
function shiftFields(
  fields: readonly SnippetField[],
  edit: SnippetEditRange,
  delta: number,
  edited: SnippetField | undefined,
  ancestorIds: ReadonlySet<number>,
): SnippetField[] {
  return fields.map((f) => {
    if (edited !== undefined && f === edited) return { ...f, end: f.end + delta };
    if (ancestorIds.has(f.id)) return { ...f, end: f.end + delta };
    if (f.start >= edit.end) return { ...f, start: f.start + delta, end: f.end + delta };
    return f; // termina antes da edição: inalterado
  });
}

/**
 * Registra uma edição aplicada ao documento.
 *
 * - Edição **fora** da expansão → `null` (fim da sessão).
 * - Edição que **engole** um campo ou **atravessa** a fronteira de outro → `null` (dado derivado
 *   ficaria inconsistente — limitação declarada).
 * - Edição cujo campo mais interno é um **espelho** → `null` (espelho é derivado da primária;
 *   editar à mão assume controle manual — limitação declarada).
 * - Caso contrário: desloca os campos, re-renderiza os **espelhos do índice editado** e dos
 *   **ancestrais** (índices cuja primária contém a edição — aninhamento), aplicando `transform`
 *   quando houver, e devolve a sessão nova com `updates` na ordem em que devem ser aplicados.
 * - Edição dentro da expansão mas **fora de qualquer campo** só desloca os offsets: a sessão
 *   continua viva (mesma leitura do clique, via `sessionRange`).
 */
export function applyEdit(
  s: SnippetSession,
  edit: SnippetEditRange,
  newText: string,
): SnippetSession | null {
  if (edit.end < edit.start) return null;
  if (edit.start < s.base || edit.end > s.end) return null; // fora da expansão → fim

  // Campo que atravessa a fronteira da edição (nem contém nem é contido) → fim.
  for (const f of s.fields) {
    const overlaps = f.start < edit.end && edit.start < f.end;
    if (overlaps && !contains(f, edit) && !(f.start >= edit.start && f.end <= edit.end)) {
      return null;
    }
  }

  // Campo editado = o mais interno que contém a edição (menor range; empate → mais à esquerda).
  const innermost = s.fields
    .filter((f) => contains(f, edit))
    .sort((a, b) => {
      const sa = a.end - a.start;
      const sb = b.end - b.start;
      if (sa !== sb) return sa - sb;
      return a.start - b.start;
    })[0];
  if (innermost !== undefined && !innermost.isPrimary) return null; // espelho → fim
  const edited = innermost;

  // Campos engolidos pela edição (exceto o campo editado, substituído integralmente).
  if (edit.start < edit.end) {
    for (const f of s.fields) {
      if (f === edited) continue;
      if (f.start >= edit.start && f.end <= edit.end) return null;
    }
  }

  // Cadeia de ancestrais estruturais (do mais interno para o externo).
  const ancestorIds = new Set<number>();
  if (edited !== undefined) {
    const byId = new Map(s.fields.map((f) => [f.id, f]));
    let cursor = byId.get(edited.parentId);
    while (cursor !== undefined) {
      ancestorIds.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
  }

  const delta = newText.length - (edit.end - edit.start);
  let text = s.text.slice(0, edit.start - s.base) + newText + s.text.slice(edit.end - s.base);
  let fields = shiftFields(s.fields, edit, delta, edited, ancestorIds);

  const updates: SnippetReplacement[] = [];
  if (edited !== undefined) {
    // Espelhos do índice editado primeiro; depois os dos ancestrais (de dentro para fora),
    // porque o valor do ancestral só estabiliza depois que os espelhos internos mudaram.
    const chain: SnippetField[] = [];
    let cursor: SnippetField | undefined = edited;
    const byId = new Map(fields.map((f) => [f.id, f]));
    while (cursor !== undefined) {
      chain.push(cursor);
      cursor = byId.get(cursor.parentId);
    }

    for (const field of chain) {
      // Re-resolve a primária e os espelhos a cada iteração: os splice anteriores podem ter
      // deslocado ranges (os objetos do `fields` são novos a cada atualização).
      const primary = fields.find((f) => f.id === field.id) ?? field;
      const content = text.slice(primary.start - s.base, primary.end - s.base);
      const mirrorIds = fields
        .filter((f) => f.index === field.index && !f.isPrimary)
        .sort((a, b) => a.start - b.start)
        .map((f) => f.id);
      for (const id of mirrorIds) {
        const mirror = fields.find((f) => f.id === id);
        if (mirror === undefined) continue;
        const t = mirror.transform;
        const fresh = t !== undefined
          ? renderTransform(content, t.regex, t.format, t.flags)
          : content;
        const current = text.slice(mirror.start - s.base, mirror.end - s.base);
        if (fresh === current) continue; // nada mudou → sem roundtrip
        updates.push({ start: mirror.start, end: mirror.end, newText: fresh });
        const mdelta = fresh.length - (mirror.end - mirror.start);
        text = text.slice(0, mirror.start - s.base) + fresh + text.slice(mirror.end - s.base);
        if (mdelta !== 0) {
          const m = mirror;
          fields = fields.map((f) => {
            if (f === m || contains(f, { start: m.start, end: m.end })) {
              return { ...f, end: f.end + mdelta };
            }
            if (f.start >= m.end) return { ...f, start: f.start + mdelta, end: f.end + mdelta };
            return f;
          });
        }
      }
    }
  }

  return {
    base: s.base,
    end: s.base + text.length,
    text,
    fields,
    visitOrder: s.visitOrder,
    current: s.current,
    updates,
  };
}

// ---- escolhas ---------------------------------------------------------------------------------------

/**
 * Estado de escolha da parada **atual** (`null` se a parada atual não é uma escolha).
 *
 * Uma parada é escolha quando o template declarou `${N|a,b,c|}` — a **primária** do índice carrega
 * a lista de opções e o índice da opção escolhida (a 1ª é o default da expansão).
 */
export function currentChoice(s: SnippetSession): SnippetChoice | null {
  const stop = currentStop(s);
  if (stop === null || stop.choices === undefined) return null;
  return {
    index: stop.index,
    choices: stop.choices,
    selected: stop.choiceIndex ?? 0,
    start: stop.start,
    end: stop.end,
  };
}

/**
 * Troca a **opção escolhida** de uma tab stop que é uma escolha (`${1|a,b,c|}`).
 *
 * O texto do campo (primária) passa a ser a opção escolhida e os offsets são ajustados **como
 * num `applyEdit`** (delta + re-render dos espelhos/ancestrais). A sessão é **imutável**: devolve
 * uma sessão nova; `null` quando a parada não é escolha, o índice da opção é inválido ou a troca
 * engoliria outro campo.
 *
 * O chamador deve **aplicar no documento** a troca do campo primário
 * (`[start, end)` → texto da opção) **antes** de aplicar `session.updates` — a mesma sequência
 * de `propagateSnippetEdit`.
 */
export function chooseSnippetOption(
  s: SnippetSession,
  index: number,
  optionIndex: number,
): SnippetSession | null {
  const field = s.fields.find((f) => f.index === index && f.isPrimary);
  if (field === undefined || field.choices === undefined) return null;
  const text = field.choices[optionIndex];
  if (text === undefined) return null;
  const next = applyEdit(s, { start: field.start, end: field.end }, text);
  if (next === null) return null;
  const fields = next.fields.map((f) =>
    f.id === field.id ? { ...f, choiceIndex: optionIndex } : f,
  );
  return { ...next, fields };
}
