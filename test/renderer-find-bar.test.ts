/**
 * Scribe — testes do `FindBarModel` (find bar do renderer, P2.4c).
 *
 * Puro e determinístico: **sem DOM** e **sem relógio real**. A agenda de debounce e o relógio são
 * injetados e as respostas da ponte são `Promise`s que o teste resolve **na ordem** que quiser — é
 * assim que provamos o **descarte de resposta obsoleta** (mesmo idioma do `HighlightStore`): só a
 * requisição mais recente, do mesmo documento e de revisão não superada, vira estado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIND_DEBOUNCE_MS,
  FindBarModel,
  createDebounceScheduler,
} from "../src/renderer/find-bar";
import type { DebounceScheduler, FindBarApi, FindBarState } from "../src/renderer/find-bar";
import type {
  ReplaceAllResult,
  SearchDocumentResult,
  SearchMatch,
  SearchQuery,
} from "../src/shared";

// ---- utilidades ----------------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** `Promise` resolvível de fora (sem timer) — deixa o teste decidir **quando** a ponte responde. */
function deferred<T>(): Deferred<T> {
  let release: ((value: T) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return {
    promise,
    resolve: (value: T): void => release?.(value),
    reject: (error: unknown): void => fail?.(error),
  };
}

function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("esperava ao menos um item");
  return value;
}

function last<T>(items: readonly T[]): T {
  const value = items[items.length - 1];
  if (value === undefined) throw new Error("esperava ao menos um item");
  return value;
}

/** Resposta de `search.find` com ocorrências de comprimento 3 nos `index` dados. */
function findResult(revision: number, indices: readonly number[]): SearchDocumentResult {
  return {
    revision,
    result: {
      matches: indices.map((index) => ({ index, length: 3, line: 0, column: index })),
      truncated: false,
      scannedLength: 200,
    },
  };
}

/** Deixa as microtasks pendentes rodarem (`runSearch` é assíncrono). */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  readonly model: FindBarModel;
  readonly calls: SearchQuery[];
  readonly findDeferreds: Deferred<SearchDocumentResult>[];
  readonly replaceCalls: { query: SearchQuery; replacement: string }[];
  readonly replaceDeferreds: Deferred<ReplaceAllResult>[];
  readonly selections: SearchMatch[];
  readonly states: FindBarState[];
  readonly scheduledMs: number[];
  cancelCount(): number;
  fire(): void;
  setNow(value: number): void;
}

/** Monta o modelo com ponte falsa (promessas controladas) e agenda de debounce manual. */
function harness(): Harness {
  const calls: SearchQuery[] = [];
  const findDeferreds: Deferred<SearchDocumentResult>[] = [];
  const replaceCalls: { query: SearchQuery; replacement: string }[] = [];
  const replaceDeferreds: Deferred<ReplaceAllResult>[] = [];
  const selections: SearchMatch[] = [];
  const states: FindBarState[] = [];
  const scheduledMs: number[] = [];

  const api: FindBarApi = {
    find: (query: SearchQuery): Promise<SearchDocumentResult> => {
      calls.push(query);
      const pending = deferred<SearchDocumentResult>();
      findDeferreds.push(pending);
      return pending.promise;
    },
    replaceAll: (query: SearchQuery, replacement: string): Promise<ReplaceAllResult> => {
      replaceCalls.push({ query, replacement });
      const pending = deferred<ReplaceAllResult>();
      replaceDeferreds.push(pending);
      return pending.promise;
    },
  };

  let pending: (() => void) | undefined;
  let cancelled = 0;
  const schedule: DebounceScheduler = (callback, ms) => {
    pending = callback;
    scheduledMs.push(ms);
    return () => {
      cancelled += 1;
      if (pending === callback) pending = undefined;
    };
  };

  let now = 0;
  const model = new FindBarModel({
    api,
    schedule,
    now: () => now,
    onChange: (state) => states.push(state),
    onSelect: (match) => selections.push(match),
  });

  return {
    model,
    calls,
    findDeferreds,
    replaceCalls,
    replaceDeferreds,
    selections,
    states,
    scheduledMs,
    cancelCount: () => cancelled,
    fire: () => {
      const callback = pending;
      pending = undefined;
      callback?.();
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---- debounce ------------------------------------------------------------------------------------

describe("FindBarModel — debounce injetado", () => {
  it("coalesce a digitação e só chama a ponte depois do debounce", () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("f");
    h.model.setPattern("fo");
    h.model.setPattern("foo");

    expect(h.calls).toHaveLength(0); // nada antes do debounce disparar
    expect(h.scheduledMs).toEqual([FIND_DEBOUNCE_MS, FIND_DEBOUNCE_MS, FIND_DEBOUNCE_MS]);
    expect(h.cancelCount()).toBeGreaterThanOrEqual(2); // as agendas anteriores foram canceladas

    h.fire();
    expect(h.calls).toEqual([{ pattern: "foo" }]); // uma só busca, pelo padrão final
  });

  it("não busca com o padrão vazio (só abre a casca)", () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("");
    h.fire();
    expect(h.calls).toHaveLength(0);
    expect(h.model.state().total).toBe(0);
  });
});

describe("createDebounceScheduler", () => {
  it("dispara uma vez após o intervalo e o cancelador aborta o pendente", () => {
    vi.useFakeTimers();
    const schedule = createDebounceScheduler();
    const ticks: number[] = [];
    const cancel = schedule(() => ticks.push(1), FIND_DEBOUNCE_MS);
    cancel();
    schedule(() => ticks.push(2), FIND_DEBOUNCE_MS);
    vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
    expect(ticks).toEqual([2]);
  });
});

// ---- aplicação da resposta (atual/total) ---------------------------------------------------------

describe("FindBarModel — aplicação da resposta", () => {
  it("reflete atual/total e seleciona a primeira ocorrência", async () => {
    const h = harness();
    h.setNow(42);
    h.model.open();
    h.model.setPattern("foo");
    h.fire();
    last(h.findDeferreds).resolve(findResult(1, [0, 4, 8]));
    await drain();

    const state = h.model.state();
    expect(state.total).toBe(3);
    expect(state.current).toBe(1);
    expect(state.truncated).toBe(false);
    expect(state.searchedAt).toBe(42);
    expect(h.selections.map((match) => match.index)).toEqual([0]);
  });
});

// ---- navegação -----------------------------------------------------------------------------------

describe("FindBarModel — navegação com wrap", () => {
  it("próxima/anterior dão a volta nas pontas", async () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("foo");
    h.fire();
    last(h.findDeferreds).resolve(findResult(1, [0, 4, 8]));
    await drain();

    h.model.next();
    expect(h.model.state().current).toBe(2);
    h.model.next();
    h.model.next(); // 3 → 1
    expect(h.model.state().current).toBe(1);
    h.model.previous(); // 1 → 3
    expect(h.model.state().current).toBe(3);

    expect(h.selections.map((match) => match.index)).toEqual([0, 4, 8, 0, 8]);
  });

  it("sem ocorrências, a navegação é no-op", () => {
    const h = harness();
    h.model.open();
    h.model.next();
    h.model.previous();
    expect(h.model.state().current).toBe(0);
    expect(h.model.currentMatch()).toBeUndefined();
  });
});

// ---- descarte de resposta obsoleta ---------------------------------------------------------------

describe("FindBarModel — descarte de resposta obsoleta", () => {
  it("só a última requisição vira estado (resposta velha é descartada)", async () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("foo");
    h.fire(); // requisição 1 em voo
    h.model.setPattern("foobar");
    h.fire(); // requisição 2 em voo

    // A resposta **nova** chega primeiro e vira estado.
    last(h.findDeferreds).resolve(findResult(1, [10]));
    await drain();
    expect(h.model.state().total).toBe(1);

    // A resposta **velha** chega depois: seq superado, tem de ser descartada.
    first(h.findDeferreds).resolve(findResult(1, [0, 1, 2]));
    await drain();
    expect(h.model.state().total).toBe(1);
    expect(h.calls).toEqual([{ pattern: "foo" }, { pattern: "foobar" }]);
  });

  it("resposta do documento anterior não vira estado após trocar de documento", async () => {
    const h = harness();
    h.model.setDocument("handle:1", 1);
    h.model.open();
    h.model.setPattern("foo");
    h.fire(); // requisição do documento 1 em voo
    h.model.setDocument("handle:2", 1); // troca de documento invalida o que está em voo

    first(h.findDeferreds).resolve(findResult(1, [0, 1]));
    await drain();
    expect(h.model.state().total).toBe(0); // nada do documento anterior pinta o novo
  });

  it("resposta de revisão superada é descartada", async () => {
    const h = harness();
    h.model.setDocument("handle:1", 5);
    h.model.open();
    h.model.setPattern("foo");
    h.fire();
    last(h.findDeferreds).resolve(findResult(3, [0])); // pedido na revisão 5, resposta na 3
    await drain();
    expect(h.model.state().total).toBe(0);
  });

  it("erro da busca vira status e zera a contagem (nunca silencioso)", async () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("foo");
    h.fire();
    last(h.findDeferreds).reject(new Error("padrão inválido"));
    await drain();
    const state = h.model.state();
    expect(state.total).toBe(0);
    expect(state.status).toBe("padrão inválido");
  });

  it("erro de requisição **velha** (revisão superada) não pinta status na barra", async () => {
    const h = harness();
    h.model.setDocument("handle:1", 5);
    h.model.open();
    h.model.setPattern("foo");
    h.fire(); // pedido na revisão 5
    h.model.close(); // fecha: nada é reagendado (o `seq` do pedido em voo continua sendo o atual)
    h.model.setDocument("handle:1", 6); // a revisão avançou desde o pedido

    last(h.findDeferreds).reject(new Error("padrão inválido"));
    await drain();
    expect(h.model.state().status).toBeUndefined();
    expect(h.model.state().total).toBe(0);
  });

  it("erro do documento anterior não pinta status no novo (mesmo descarte do sucesso)", async () => {
    const h = harness();
    h.model.setDocument("handle:1", 1);
    h.model.open();
    h.model.setPattern("foo");
    h.fire(); // requisição do documento 1 em voo
    h.model.setDocument("handle:2", 1); // troca de documento invalida o que está em voo

    first(h.findDeferreds).reject(new Error("falha do documento anterior"));
    await drain();
    expect(h.model.state().status).toBeUndefined();
  });
});

// ---- fechar (Esc) --------------------------------------------------------------------------------

describe("FindBarModel — fechar", () => {
  it("close() só devolve true quando estava aberto (Esc consome uma vez)", () => {
    const h = harness();
    expect(h.model.close()).toBe(false); // já fechado: Esc não é consumido
    h.model.open();
    expect(h.model.isOpen).toBe(true);
    expect(h.model.close()).toBe(true); // aberto: fecha e consome
    expect(h.model.isOpen).toBe(false);
    expect(h.model.close()).toBe(false); // de novo fechado
  });
});

// ---- substituição --------------------------------------------------------------------------------

describe("FindBarModel — replace-all", () => {
  it("expõe o total substituído e refaz a contagem", async () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("foo");
    h.model.setReplacement("bar");
    h.fire();
    last(h.findDeferreds).resolve(findResult(1, [0, 4, 8]));
    await drain();
    expect(h.model.state().total).toBe(3);

    const replacing = h.model.replaceAll();
    expect(h.replaceCalls).toEqual([{ query: { pattern: "foo" }, replacement: "bar" }]);
    last(h.replaceDeferreds).resolve({ replaced: 3, revision: 2 });
    await replacing;
    expect(h.model.state().status).toBe("3 substituição(ões)");

    // Contagem fresca: o replace-all agenda nova busca (mesmo caminho do debounce).
    expect(h.calls).toHaveLength(1);
    h.fire();
    expect(h.calls).toHaveLength(2);
    last(h.findDeferreds).resolve(findResult(2, []));
    await drain();
    expect(h.model.state().total).toBe(0);
  });

  it("erro do replace-all vira status (nunca silencioso)", async () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("foo");
    const replacing = h.model.replaceAll();
    last(h.replaceDeferreds).reject(new Error("boom"));
    await replacing;
    expect(h.model.state().status).toBe("boom");
  });
});

// ---- getters de matches (P3.11) -------------------------------------------------------------------

describe("FindBarModel — allMatches / currentMatchIndex", () => {
  it("expõe os matches e o índice atual", async () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("foo");
    h.fire();
    last(h.findDeferreds).resolve(findResult(1, [0, 4, 8]));
    await drain();

    expect(h.model.allMatches).toHaveLength(3);
    expect(h.model.allMatches[0]).toEqual({ index: 0, length: 3, line: 0, column: 0 });
    expect(h.model.currentMatchIndex).toBe(0);

    h.model.next();
    expect(h.model.currentMatchIndex).toBe(1);
    h.model.next();
    expect(h.model.currentMatchIndex).toBe(2);
  });

  it("sem ocorrências, currentMatchIndex é -1", () => {
    const h = harness();
    h.model.open();
    expect(h.model.allMatches).toHaveLength(0);
    expect(h.model.currentMatchIndex).toBe(-1);
  });

  it("padrão vazio zera os matches e o índice", () => {
    const h = harness();
    h.model.open();
    h.model.setPattern("foo");
    h.fire();
    last(h.findDeferreds).resolve(findResult(1, [0, 4, 8]));
    h.model.setPattern("");
    expect(h.model.allMatches).toHaveLength(0);
    expect(h.model.currentMatchIndex).toBe(-1);
  });
});
