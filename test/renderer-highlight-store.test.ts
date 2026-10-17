/**
 * Scribe — guardas do `HighlightStore` do renderer (achados de revisão):
 * resposta fora de ordem (mesma revisão, range diferente), resposta **vazia** que não pode virar
 * cobertura (senão a tela fica sem realce para sempre) **com teto de tentativas**, requisição **em
 * voo** (dedupe por documento+revisão, com timeout), falha que não pode virar IPC + warn por frame e
 * — achado ALTO — a **identidade do documento** como parte da chave: `revision` reinicia em 1 por
 * arquivo, então nada do arquivo anterior pode casar com a revisão 1 do novo. Puro, sem
 * Electron/canvas: a classe é exercitada direto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_DOCUMENT_KEY,
  EMPTY_HIGHLIGHT_MAX_ATTEMPTS,
  EMPTY_HIGHLIGHT_RETRY_MS,
  EMPTY_HIGHLIGHT_RETRY_MAX_MS,
  IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS,
  HighlightStore,
  documentHighlightKey,
} from "../src/renderer/main";
import type { HighlightRequest } from "../src/renderer/main";
import { makeHandle } from "../src/shared";
import type { DocumentHighlight, HighlightSpan } from "../src/shared";

// Chaves derivadas de handles **reais** (slot nos bits baixos, geração nos bits altos) via a mesma
// função de produção: um formato de chave que colidisse entre documentos quebraria estes testes.
const DOC_A = documentHighlightKey(makeHandle<"DocumentHandle">(0, 1));
const DOC_B = documentHighlightKey(makeHandle<"DocumentHandle">(1, 1));

function spans(...scopes: string[]): readonly HighlightSpan[] {
  return scopes.map((scope, index) => ({ start: index, end: index + 1, scope }));
}

/** Resposta do main: revisão, primeira linha e as linhas (offset absoluto) cobertas. */
function response(revision: number, first: number, count: number): DocumentHighlight {
  return {
    revision,
    first,
    lines: Array.from({ length: count }, (_, index) => ({
      line: first + index,
      spans: spans("keyword.demo"),
    })),
  };
}

/** Resposta do main **antes** de as gramáticas carregarem: range pedido, nenhum span. */
function emptyResponse(revision: number, first: number, count: number): DocumentHighlight {
  return {
    revision,
    first,
    lines: Array.from({ length: count }, (_, index) => ({ line: first + index, spans: [] })),
  };
}

function request(
  docKey: string,
  revision: number,
  first: number,
  count: number,
): HighlightRequest {
  return { docKey, revision, first, count };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HighlightStore — casamento resposta ↔ requisição (fora de ordem)", () => {
  it("aceita a resposta que cobre a requisição e serve os spans", () => {
    const store = new HighlightStore();
    const req = request(DOC_A, 7, 10, 4);

    expect(store.set(response(7, 8, 10), req)).toBe(true);
    expect(store.covers(DOC_A, 7, 10, 4)).toBe(true);
    expect(store.spansFor(DOC_A, 10)?.[0]?.scope).toBe("keyword.demo");
  });

  it("descarta resposta de mesma revisão cobrindo range diferente do pedido", () => {
    const store = new HighlightStore();
    const req = request(DOC_A, 7, 100, 20);

    // Resposta de outra requisição (linha 0) chegando depois: não pode virar cobertura do range 100.
    expect(store.set(response(7, 0, 20), req)).toBe(false);
    expect(store.covers(DOC_A, 7, 100, 20)).toBe(false);
    expect(store.spansFor(DOC_A, 0)).toBeUndefined();
  });

  it("descarta resposta de revisão diferente da requisição", () => {
    const store = new HighlightStore();
    const req = request(DOC_A, 7, 0, 2);

    expect(store.set(response(8, 0, 2), req)).toBe(false);
    expect(store.covers(DOC_A, 8, 0, 2)).toBe(false);
  });

  it("descarta resposta parcial (não cobre o fim do range pedido)", () => {
    const store = new HighlightStore();
    const req = request(DOC_A, 7, 0, 10);

    expect(store.set(response(7, 0, 5), req)).toBe(false);
    expect(store.covers(DOC_A, 7, 0, 10)).toBe(false);
  });
});

describe("HighlightStore — identidade do documento (achado ALTO: revisão reinicia em 1 por arquivo)", () => {
  it("não serve os spans do arquivo anterior na revisão 1 do arquivo novo", () => {
    const store = new HighlightStore();

    expect(store.set(response(1, 0, 4), request(DOC_A, 1, 0, 4))).toBe(true);
    expect(store.spansFor(DOC_A, 0)?.[0]?.scope).toBe("keyword.demo");

    // Troca de documento: o novo também está na revisão 1 — nada do anterior pode casar.
    expect(store.spansFor(DOC_B, 0)).toBeUndefined();
    expect(store.covers(DOC_B, 1, 0, 4)).toBe(false);
    expect(store.needsRequest(DOC_B, 1, 0, 4)).toBe(true);
    expect(store.spansFor(DOC_B, 0)).toBeUndefined();
  });

  it("descarta resposta atrasada do arquivo anterior (não reativa o estado dele)", () => {
    const store = new HighlightStore();
    const lateRequest = request(DOC_A, 1, 0, 4);
    store.beginRequest(DOC_A, 1);

    // O documento troca antes de a resposta chegar (e a revisão do novo também é 1).
    expect(store.needsRequest(DOC_B, 1, 0, 4)).toBe(true);
    expect(store.set(response(1, 0, 4), lateRequest)).toBe(false);
    expect(store.spansFor(DOC_B, 0)).toBeUndefined();
    expect(store.covers(DOC_B, 1, 0, 4)).toBe(false);

    // `endRequest` atrasado do arquivo anterior não pode mexer no documento ativo.
    store.endRequest(DOC_A, 1);
    expect(store.needsRequest(DOC_B, 1, 0, 4)).toBe(true);
  });

  it("falha e retentativa do arquivo anterior não contaminam o arquivo novo", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new HighlightStore();

    store.markFailed(DOC_A, 1, new Error("gramática não compila"));
    expect(store.blocked(DOC_A, 1)).toBe(true);
    store.set(emptyResponse(1, 0, 2), request(DOC_A, 1, 0, 2));

    // Documento novo, revisão 1: nem `blocked` nem a janela de retentativa do anterior valem.
    expect(store.blocked(DOC_B, 1)).toBe(false);
    expect(store.needsRequest(DOC_B, 1, 0, 2)).toBe(true);
  });
});

describe("HighlightStore — resposta vazia e requisição em voo", () => {
  it("resposta sem nenhum span não vira cobertura; a resposta com spans que chega depois é aceita", () => {
    let clock = 0;
    const store = new HighlightStore(() => clock);
    const req = request(DOC_A, 7, 0, 3);

    // 1ª resposta antes de `syntaxReady`: range completo, mas sem spans.
    expect(store.set(emptyResponse(7, 0, 3), req)).toBe(false);
    expect(store.covers(DOC_A, 7, 0, 3)).toBe(false);
    // Janela de retentativa: nada de IPC por frame enquanto ela não passa…
    expect(store.needsRequest(DOC_A, 7, 0, 3)).toBe(false);
    clock += EMPTY_HIGHLIGHT_RETRY_MS;
    // …mas depois dela o renderer volta a perguntar (a revisão não ficou presa para sempre).
    expect(store.needsRequest(DOC_A, 7, 0, 3)).toBe(true);
    expect(store.set(response(7, 0, 3), req)).toBe(true);
    expect(store.covers(DOC_A, 7, 0, 3)).toBe(true);
    expect(store.spansFor(DOC_A, 0)?.[0]?.scope).toBe("keyword.demo");
  });

  it("esgota o teto de tentativas e bloqueia a revisão de forma definitiva (sem IPC em loop)", () => {
    let clock = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new HighlightStore(() => clock);
    const req = request(DOC_A, 5, 0, 3);

    // `EMPTY_HIGHLIGHT_MAX_ATTEMPTS - 1` respostas vazias: ainda dentro do teto, só respeita o backoff.
    for (let attempt = 1; attempt < EMPTY_HIGHLIGHT_MAX_ATTEMPTS; attempt++) {
      expect(store.needsRequest(DOC_A, 5, 0, 3)).toBe(true);
      expect(store.set(emptyResponse(5, 0, 3), req)).toBe(false);
      expect(store.blocked(DOC_A, 5)).toBe(false);
      clock += EMPTY_HIGHLIGHT_RETRY_MAX_MS; // além do backoff desta tentativa
    }

    // Última tentativa permitida: aqui a revisão entra em falha definitiva (um `warn`).
    expect(store.needsRequest(DOC_A, 5, 0, 3)).toBe(true);
    expect(store.set(emptyResponse(5, 0, 3), req)).toBe(false);
    expect(store.blocked(DOC_A, 5)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    clock += 100 * EMPTY_HIGHLIGHT_RETRY_MAX_MS;
    expect(store.needsRequest(DOC_A, 5, 0, 3)).toBe(false); // teto é definitivo

    // Um edit (revisão nova) reabre a tentativa.
    expect(store.needsRequest(DOC_A, 6, 0, 3)).toBe(true);
  });

  it("não dispara 2ª requisição enquanto uma estiver em voo para o mesmo documento+revisão", () => {
    const store = new HighlightStore();

    expect(store.needsRequest(DOC_A, 7, 0, 5)).toBe(true);
    store.beginRequest(DOC_A, 7);
    expect(store.needsRequest(DOC_A, 7, 0, 5)).toBe(false); // dedupe: os frames seguintes não re-pedem
    store.endRequest(DOC_A, 7);
    expect(store.needsRequest(DOC_A, 7, 0, 5)).toBe(true);

    // O dedupe é por documento+revisão: um edit (ou outro arquivo) pode pedir mesmo com a antiga em voo.
    store.beginRequest(DOC_A, 7);
    expect(store.needsRequest(DOC_A, 8, 0, 5)).toBe(true);
    expect(store.needsRequest(DOC_B, 7, 0, 5)).toBe(true);
  });

  it("libera o slot em voo após o timeout e trata como falha (degradação explícita)", () => {
    let clock = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new HighlightStore(() => clock);
    store.beginRequest(DOC_A, 7);

    clock += IN_FLIGHT_HIGHLIGHT_TIMEOUT_MS - 1;
    expect(store.needsRequest(DOC_A, 7, 0, 5)).toBe(false); // ainda em voo: dedupe normal
    clock += 1;
    expect(store.needsRequest(DOC_A, 7, 0, 5)).toBe(false); // slot vencido ⇒ falha (não fica preso)
    expect(store.blocked(DOC_A, 7)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    // A resposta atrasada ainda vale: o realce volta e a revisão deixa de estar bloqueada.
    expect(store.set(response(7, 0, 5), request(DOC_A, 7, 0, 5))).toBe(true);
    expect(store.spansFor(DOC_A, 0)?.[0]?.scope).toBe("keyword.demo");
    expect(store.blocked(DOC_A, 7)).toBe(false);
    expect(store.needsRequest(DOC_A, 7, 20, 5)).toBe(true); // outro range volta a ser pedido
  });
});

describe("HighlightStore — guarda de falha por documento+revisão", () => {
  it("lembra a falha da revisão e loga no máximo uma vez por documento+revisão", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new HighlightStore();

    expect(store.blocked(DOC_A, 3)).toBe(false);
    store.markFailed(DOC_A, 3, new Error("gramática não compila"));
    store.markFailed(DOC_A, 3, new Error("gramática não compila"));
    store.markFailed(DOC_A, 3);

    expect(store.blocked(DOC_A, 3)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    // Revisão nova (um edit) volta a permitir a tentativa — e um novo warn, só naquela revisão.
    expect(store.blocked(DOC_A, 4)).toBe(false);
    store.markFailed(DOC_A, 4);
    expect(warn).toHaveBeenCalledTimes(2);

    // Documento novo: nem a falha nem o "já avisei" do anterior valem para ele.
    expect(store.blocked(DOC_B, 4)).toBe(false);
    store.markFailed(DOC_B, 4);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("HighlightStore — chave de documento (`documentHighlightKey`/`DEMO_DOCUMENT_KEY`)", () => {
  it("deriva chaves distintas por handle — inclusive slot reciclado com geração nova", () => {
    const first = documentHighlightKey(makeHandle<"DocumentHandle">(0, 1));
    const other = documentHighlightKey(makeHandle<"DocumentHandle">(1, 1));
    // Mesmo slot (0) com geração nova = documento diferente (anti-ABA do registry).
    const recycled = documentHighlightKey(makeHandle<"DocumentHandle">(0, 2));

    expect(first).not.toBe(other);
    expect(first).not.toBe(recycled);
    expect(recycled).not.toBe(other);
    expect(new Set([first, other, recycled]).size).toBe(3);
  });

  it("não serve os spans do documento que ocupava o slot reciclado (geração nova, revisão 1)", () => {
    const store = new HighlightStore();
    const before = documentHighlightKey(makeHandle<"DocumentHandle">(0, 1));
    const recycled = documentHighlightKey(makeHandle<"DocumentHandle">(0, 2));

    expect(store.set(response(1, 0, 4), request(before, 1, 0, 4))).toBe(true);
    expect(store.spansFor(before, 0)?.[0]?.scope).toBe("keyword.demo");
    expect(store.spansFor(recycled, 0)).toBeUndefined();
    expect(store.covers(recycled, 1, 0, 4)).toBe(false);
    expect(store.needsRequest(recycled, 1, 0, 4)).toBe(true);
  });

  it("o pseudo-doc `demo` (sem ponte) nunca casa com um handle", () => {
    const store = new HighlightStore();
    const handleKey = documentHighlightKey(makeHandle<"DocumentHandle">(0, 1));

    expect(DEMO_DOCUMENT_KEY).not.toBe(handleKey);
    expect(store.set(response(1, 0, 2), request(DEMO_DOCUMENT_KEY, 1, 0, 2))).toBe(true);
    expect(store.spansFor(handleKey, 0)).toBeUndefined();
    expect(store.covers(handleKey, 1, 0, 2)).toBe(false);

    // Caminho inverso: ativar um handle descarta o estado do demo.
    expect(store.needsRequest(handleKey, 1, 0, 2)).toBe(true);
    expect(store.spansFor(DEMO_DOCUMENT_KEY, 0)).toBeUndefined();
  });

  it("`invalidate()` (dev-seam: troca de LineSource) descarta o estado do documento anterior", () => {
    const store = new HighlightStore();

    expect(store.set(response(1, 0, 4), request(DOC_A, 1, 0, 4))).toBe(true);
    store.invalidate();
    expect(store.spansFor(DOC_A, 0)).toBeUndefined();
    expect(store.covers(DOC_A, 1, 0, 4)).toBe(false);
    expect(store.needsRequest(DOC_A, 1, 0, 4)).toBe(true);

    // Estado novo volta a valer normalmente (a resposta adota o store).
    expect(store.set(response(1, 0, 4), request(DOC_A, 1, 0, 4))).toBe(true);
    expect(store.covers(DOC_A, 1, 0, 4)).toBe(true);
  });
});

describe("HighlightStore — backoff efetivo das retentativas", () => {
  it("agenda 250/500/1000 ms e falha na 4ª resposta vazia (o corte de 2000 ms nunca age)", () => {
    let clock = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new HighlightStore(() => clock);
    const req = request(DOC_A, 9, 0, 2);

    for (let attempt = 1; attempt < EMPTY_HIGHLIGHT_MAX_ATTEMPTS; attempt++) {
      expect(store.needsRequest(DOC_A, 9, 0, 2)).toBe(true);
      expect(store.set(emptyResponse(9, 0, 2), req)).toBe(false);
      const backoff = EMPTY_HIGHLIGHT_RETRY_MS * 2 ** (attempt - 1);
      expect(backoff).toBeLessThan(EMPTY_HIGHLIGHT_RETRY_MAX_MS); // o corte é inalcançável
      clock += backoff - 1;
      expect(store.needsRequest(DOC_A, 9, 0, 2)).toBe(false); // ainda dentro da janela
      clock += 1;
    }

    // Última tentativa: `markFailed` **antes** de agendar ⇒ o backoff nunca chega ao corte.
    expect(store.needsRequest(DOC_A, 9, 0, 2)).toBe(true);
    expect(store.set(emptyResponse(9, 0, 2), req)).toBe(false);
    expect(store.blocked(DOC_A, 9)).toBe(true);
  });
});
