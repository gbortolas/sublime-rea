/**
 * Scribe — snippets de **pacote** (`.sublime-snippet`) lidos do `PackageResolver`.
 *
 * O `PackageResolver` (doc 05) expõe os recursos empacotados no namespace lógico
 * `packages://<Nome>/<caminho>`, em camadas (`user > app > os`). Um pacote traz snippets em
 * arquivos `.sublime-snippet` — **JSON** com `prefix` (o trigger), `body` (o texto) e
 * `description` opcional. Este módulo:
 *
 * - coleta os recursos `kind:"snippet"` (o `byKind` já devolve a **vencedora** de cada
 *   caminho lógico ⇒ a precedência de *arquivo* é a do resolver);
 * - parseia o JSON (corpo como **string** ou **array** de strings; prefixo como **string** ou
 *   **array**) e devolve uma definição por prefixo;
 * - **ignora** (com `warn`, nunca crash) arquivo inválido: JSON quebrado, sem `prefix`, sem
 *   `body`;
 * - resolve o **conflito de trigger** pela precedência de **camada** (`user` > `app` > `os`)
 *   — o mesmo critério que o resolver usa para as gramáticas;
 * - aplica **tetos** (nº de definições e tamanho do corpo): pacote é entrada **não
 *   confiável** (vem de um `.sublime-package` instalado pelo usuário).
 *
 * Módulo **puro** (sem DOM/IPC): o `main` é quem o chama (no `dispatchIpc` do método
 * `snippets.list`) e o renderer recebe só o resultado.
 *
 * Clean-room: nada aqui deriva de código do alvo — o formato do arquivo é o
 * `.sublime-snippet` **público** (JSON com `prefix`/`body`/`description`).
 */
import {
  MAX_PACKAGE_SNIPPETS,
  MAX_PACKAGE_SNIPPET_BODY_BYTES,
  RESOURCE_LAYER_PRECEDENCE,
} from "../../shared";
import type {
  PackageResolver,
  PackageSnippetDefinition,
  ResourceLayer,
} from "../../shared";

/** Opções do coletor (tetos + canal de aviso — injetável para teste). */
export interface PackageSnippetOptions {
  /** Teto de definições devolvidas (default `MAX_PACKAGE_SNIPPETS`). */
  readonly maxDefinitions?: number;
  /** Teto do corpo em bytes (default `MAX_PACKAGE_SNIPPET_BODY_BYTES`). */
  readonly maxBodyBytes?: number;
  /** Canal de aviso (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

/** Resultado da leitura de um arquivo `.sublime-snippet`. */
export type SnippetFileParse =
  | { readonly ok: true; readonly definitions: readonly PackageSnippetDefinition[] }
  | { readonly ok: false; readonly reason: string };

/** Precedência da camada (menor índice = maior precedência — `RESOURCE_LAYER_PRECEDENCE`). */
function precedenceOf(layer: ResourceLayer): number {
  const index = RESOURCE_LAYER_PRECEDENCE.indexOf(layer);
  return index < 0 ? RESOURCE_LAYER_PRECEDENCE.length : index;
}

/**
 * Lê o campo `body`: **string** ou **array** de strings (o array é unido com `\n`).
 * `undefined` = campo ausente ou com item que não é string.
 */
function readBody(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    parts.push(item);
  }
  return parts.join("\n");
}

/**
 * Lê o campo `prefix`: **string** (um trigger) ou **array** de strings (um trigger por
 * entrada). Entradas vazias/brancas são descartadas; duplicatas são removidas.
 *
 * O prefixo **não** é quebrado por vírgula: um trigger pode conter vírgula.
 */
function readPrefixes(value: unknown): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const trigger = raw.trim();
    if (trigger.length === 0) return;
    if (out.includes(trigger)) return;
    out.push(trigger);
  };
  if (typeof value === "string") {
    push(value);
    return out;
  }
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item === "string") push(item);
  }
  return out;
}

/**
 * Parseia o conteúdo de um `.sublime-snippet` (JSON) e devolve as definições.
 *
 * `source` é o caminho lógico de origem (entra em cada definição). O parse **não** lança:
 * arquivo inválido volta como `{ ok: false, reason }` e o chamador decide o `warn`.
 */
export function parseSnippetFile(text: string, source: string): SnippetFileParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `JSON inválido (${messageOf(error)})` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "conteúdo não é um objeto JSON" };
  }
  const record = raw as Record<string, unknown>;
  const body = readBody(record["body"]);
  if (body === undefined) {
    return { ok: false, reason: "campo 'body' ausente ou inválido" };
  }
  if (body.length === 0) {
    return { ok: false, reason: "campo 'body' vazio" };
  }
  const prefixes = readPrefixes(record["prefix"]);
  if (prefixes.length === 0) {
    return { ok: false, reason: "campo 'prefix' ausente ou inválido" };
  }
  const rawDescription = record["description"];
  const description = typeof rawDescription === "string" ? rawDescription : undefined;
  return {
    ok: true,
    definitions: prefixes.map((trigger) => ({
      trigger,
      body,
      ...(description !== undefined ? { description } : {}),
      source,
    })),
  };
}

/**
 * Coleta os snippets de **todos** os pacotes indexados pelo `resolver`.
 *
 * Precedência: o `byKind("snippet")` do resolver já devolve a vencedora de cada caminho
 * lógico (a camada `user` substitui a `app` no **mesmo** arquivo); entre arquivos
 * **diferentes** com o mesmo trigger, vale a precedência de **camada** (`user > app > os`) —
 * dentro da mesma camada, o **primeiro** encontrado vence.
 */
export async function collectPackageSnippets(
  resolver: PackageResolver,
  options: PackageSnippetOptions = {},
): Promise<readonly PackageSnippetDefinition[]> {
  const maxDefinitions = options.maxDefinitions ?? MAX_PACKAGE_SNIPPETS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_PACKAGE_SNIPPET_BODY_BYTES;
  const warn = options.warn ?? ((message: string): void => { console.warn(message); });

  // trigger (lowercased) → { definition, layer }
  const byTrigger = new Map<string, { readonly definition: PackageSnippetDefinition; readonly layer: ResourceLayer }>();
  let capped = false;

  for (const entry of resolver.byKind("snippet")) {
    if (capped) break;
    let text: string;
    try {
      // Sem `maxSize`: o teto do **corpo** é conferido depois do parse (o arquivo carrega
      // o overhead do JSON). O `load` já tem o teto default do resolver (16 MiB).
      const bytes = await resolver.load(entry.uri);
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      warn(`Scribe: snippet de pacote ilegível (${entry.uri}) — ignorado: ${messageOf(error)}`);
      continue;
    }
    const parsed = parseSnippetFile(text, entry.uri);
    if (!parsed.ok) {
      warn(`Scribe: snippet de pacote ignorado (${entry.uri}): ${parsed.reason}`);
      continue;
    }
    for (const definition of parsed.definitions) {
      if (new TextEncoder().encode(definition.body).byteLength > maxBodyBytes) {
        warn(
          `Scribe: snippet de pacote ignorado (${entry.uri}): corpo acima de ${maxBodyBytes} bytes`,
        );
        continue;
      }
      const key = definition.trigger.toLowerCase();
      const existing = byTrigger.get(key);
      if (existing !== undefined) {
        // Mesmo trigger: vence a camada de maior precedência (dentro da camada, o 1º vence).
        if (precedenceOf(entry.layer) < precedenceOf(existing.layer)) {
          byTrigger.set(key, { definition, layer: entry.layer });
        }
        continue;
      }
      if (byTrigger.size >= maxDefinitions) {
        capped = true;
        warn(
          `Scribe: teto de ${maxDefinitions} snippets de pacote atingido — os demais foram ignorados`,
        );
        break;
      }
      byTrigger.set(key, { definition, layer: entry.layer });
    }
  }

  return [...byTrigger.values()].map((entry) => entry.definition);
}

/** Mensagem de um erro desconhecido (sem `any`, sem `catch` mudo). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
