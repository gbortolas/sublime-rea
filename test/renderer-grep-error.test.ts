/**
 * Scribe — testes do **erro da busca em todos os arquivos** (o painel do grep).
 *
 * ⚠️ **O bug**: a rejeição da busca fazia `setResults(EMPTY_GREP_RESULT)` + `console.warn`
 * ⇒ o painel mostrava "Nenhum resultado" e a mensagem real (ex.: "padrão regex
 * potencialmente catastrófico (quantificador aninhado) — a busca foi cancelada para não
 * travar o editor") ficava **só no console** ⇒ o usuário não sabia por que a busca parou.
 *
 * O teste monta o painel de verdade (o `main.ts` do renderer) contra o **DOM falso**
 * do repo (`test/helpers/fake-dom.ts`) e prova que a mensagem da falha chega à **linha
 * de status** do painel — e que um resultado **vazio sem erro** continua "Nenhum
 * resultado".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GrepResult } from "../src/core/workspace/grep";
import {
  createWorkspaceSearchController,
  describeSearchFailure,
  WORKSPACE_SEARCH_DEBOUNCE_MS,
} from "../src/renderer/main";
import {
  FakeElement,
  firstByClass,
  installFakeDom,
  uninstallFakeDom,
} from "./helpers/fake-dom";

/** O tipo da ponte (a interface do `main.ts` não é exportada). */
type SearchBridge = Parameters<typeof createWorkspaceSearchController>[0]["bridge"];

/** A mensagem que o `grep` do core recusa (o padrão regex catastrófico). */
const CATASTROPHIC =
  "padrão regex potencialmente catastrófico (quantificador aninhado) — a busca foi cancelada para não travar o editor";

/** O erro que o `main` devolve (com os prefixos técnicos do IPC e do core). */
const REMOTE_ERROR = `Scribe IPC[dispatch-failed]: SearchInputError[search.pattern]: ${CATASTROPHIC}`;

/** Um elemento que sabe responder `querySelector` (o falso DOM do repo não tem). */
class QueryElement extends FakeElement {
  querySelector(selector: string): FakeElement | null {
    const className = selector.startsWith(".") ? selector.slice(1) : selector;
    return firstByClass(this, className) ?? null;
  }
}

/**
 * Instala o DOM falso com o que o painel do grep precisa: o host
 * (`#search-panel-host`), o `getElementById` e o `body`.
 */
function installSearchDom(): { host: FakeElement } {
  const doc = installFakeDom();
  const host = new QueryElement("div");
  const byId = new Map<string, FakeElement>([["search-panel-host", host]]);
  Object.assign(doc, {
    getElementById: (id: string): FakeElement | null => byId.get(id) ?? null,
    body: new FakeElement("body"),
  });
  // Todo elemento criado pelo `document` também sabe o `querySelector`.
  doc.createElement = (tagName: string): FakeElement => {
    const element = new QueryElement(tagName);
    element.ownerDocument = doc;
    return element;
  };
  // O `instanceof` do painel (`HTMLElement`/`HTMLInputElement`) — o Node não os tem.
  const globals = globalThis as { HTMLElement?: unknown; HTMLInputElement?: unknown };
  globals.HTMLElement = FakeElement;
  globals.HTMLInputElement = FakeElement;
  return { host };
}

describe("a mensagem do erro da busca (puro)", () => {
  it("a mensagem real do `grep` aparece **sem** os prefixos técnicos", () => {
    expect(describeSearchFailure(new Error(REMOTE_ERROR))).toBe(CATASTROPHIC);
  });

  it("sem `Error:` cru e sem stack (1 linha)", () => {
    const error = new Error(REMOTE_ERROR);
    const message = describeSearchFailure(error);
    expect(message).not.toContain("Error:");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("at ");
  });

  it("uma falha sem mensagem vira o texto genérico", () => {
    expect(describeSearchFailure(new Error(""))).toBe("falha na busca em todos os arquivos");
    expect(describeSearchFailure(undefined)).toBe("falha na busca em todos os arquivos");
  });
});

describe("o painel da busca — a falha chega à UI", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
    uninstallFakeDom();
    const globals = globalThis as { HTMLElement?: unknown; HTMLInputElement?: unknown };
    delete globals.HTMLElement;
    delete globals.HTMLInputElement;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Digita a query no painel e deixa a busca rodar (o debounce é de 300 ms).
   *
   * @param searchFiles A busca (resolve ou rejeita).
   */
  async function search(searchFiles: () => Promise<GrepResult>): Promise<FakeElement> {
    const { host } = installSearchDom();
    const controller = createWorkspaceSearchController({
      bridge: {
        nextSignalId: () => 1,
        cancel: () => {},
        searchFiles: searchFiles as unknown as SearchBridge,
      } as unknown as SearchBridge,
      onOpen: () => {},
      focusEditor: () => {},
    });
    controller.open();
    const input = firstByClass(host, "search-panel-input");
    expect(input).toBeDefined();
    input!.value = "(a+)+";
    input!.dispatch("input");
    await vi.advanceTimersByTimeAsync(WORKSPACE_SEARCH_DEBOUNCE_MS);
    await Promise.resolve();
    const status = firstByClass(host, "search-panel-status");
    expect(status).toBeDefined();
    return status!;
  }

  it("a falha mostra a mensagem real na status do painel (não 'Nenhum resultado')", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const status = await search(async () => {
      throw new Error(REMOTE_ERROR);
    });
    expect(status.textContent).toBe(CATASTROPHIC);
    expect(status.textContent).not.toBe("Nenhum resultado");
  });

  it("a falha continua no console (o log não se perde)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await search(async () => {
      throw new Error(REMOTE_ERROR);
    });
    expect(warn).toHaveBeenCalled();
  });

  it("um resultado VAZIO (sem erro) continua 'Nenhum resultado'", async () => {
    const status = await search(async () => ({
      matches: [],
      truncated: false,
      filesScanned: 12,
    }));
    expect(status.textContent).toBe("Nenhum resultado");
  });
});
