/**
 * Scribe — `ExtensionAPI`: façade **fina** do núcleo para o host de plugins (DEC-IPC-6/7).
 *
 * Fonte: `docs/architecture/03-extensao-e-ipc.md` (`DEC-IPC-5/6/7/12`) e
 * `docs/architecture/06-padroes-transversais.md` §1/§3. A façade **não guarda estado próprio**: só
 * encaminha para `CommandBus` (mutação), `DocumentRegistry` (handles opacos) e `PackageResolver`
 * (recursos), exatamente como o alvo mantém o estado no núcleo (`PY-E1`/`PY-E3`).
 *
 * `createMethodHandlers` é a contraparte de servidor: o mapa que a `ExtensionBridge` despacha quando
 * recebe `call`/`notify`. Toda entrada valida **aridade** e **tipo** antes de tocar o núcleo; erro de
 * argumento vira `RpcCallError` (implementa o `RpcError` do contrato) — nunca um `TypeError` cru.
 * Handles são revalidados no `DocumentRegistry` antes do uso (DEC-TR-1).
 */
import { parseResourceUri } from "../../shared";
import type {
  CommandBus,
  CommandResult,
  Disposable,
  DocumentHandle,
  DocumentRegistry,
  ExtensionAPI,
  ExtensionBridge,
  ExtensionEventName,
  ExtensionEvents,
  ExtensionMethods,
  HandlerOf,
  PackageResolver,
  ResourceUri,
  ViewHandle,
} from "../../shared";

import { RpcCallError, type MethodHandlers } from "./bridge";

/** Dependências do núcleo injetadas nos handlers (nos testes: fakes). */
export interface MethodHandlerDeps {
  readonly commands: CommandBus;
  readonly documents: DocumentRegistry;
  readonly packages: PackageResolver;
}

/** Dependências da façade (o `bridge` fornece `version` negociada e `on`). */
export interface ExtensionApiDeps extends MethodHandlerDeps {
  readonly bridge: ExtensionBridge;
}

/**
 * Façade fina exposta ao host. Os campos `documents`/`commands`/`packages` são as **mesmas**
 * instâncias do núcleo (sem cópia, sem cache — `PY-E5`); `on` encaminha para a ponte.
 */
export function createExtensionAPI(deps: ExtensionApiDeps): ExtensionAPI {
  const { bridge } = deps;
  return {
    get version() {
      return bridge.version;
    },
    documents: deps.documents,
    commands: deps.commands,
    packages: deps.packages,
    on: <E extends ExtensionEventName>(event: E, handler: HandlerOf<ExtensionEvents[E]>): Disposable =>
      bridge.on(event, handler),
  };
}

/** Mapa de handlers que a ponte despacha (`call`/`notify`) — implementa `ExtensionMethods`. */
export function createMethodHandlers(deps: MethodHandlerDeps): MethodHandlers<ExtensionMethods> {
  const { commands, documents, packages } = deps;

  return {
    ping: withArity("ping", 0, () => "pong" as const),

    "buffer.insert": withArity(
      "buffer.insert",
      3,
      async (doc: DocumentHandle, at: number, text: string): Promise<number> => {
        const handle = requireDocumentHandle("buffer.insert", doc);
        const offset = requireIndex("buffer.insert", "at", at);
        const body = requireString("buffer.insert", "text", text);
        requireLiveDocument("buffer.insert", documents, handle);
        const result = await commands.run(
          "buffer.insert",
          { doc: handle, at: offset, text: body },
          { origin: "plugin" },
        );
        return countOf(result, "buffer.insert", body.length);
      },
    ),

    "buffer.erase": withArity(
      "buffer.erase",
      3,
      async (doc: DocumentHandle, at: number, length: number): Promise<number> => {
        const handle = requireDocumentHandle("buffer.erase", doc);
        const offset = requireIndex("buffer.erase", "at", at);
        const count = requireIndex("buffer.erase", "length", length);
        requireLiveDocument("buffer.erase", documents, handle);
        const result = await commands.run(
          "buffer.erase",
          { doc: handle, at: offset, length: count },
          { origin: "plugin" },
        );
        return countOf(result, "buffer.erase", count);
      },
    ),

    "view.scroll": withArity(
      "view.scroll",
      2,
      async (view: ViewHandle, line: number): Promise<void> => {
        const handle = requireViewHandle("view.scroll", view);
        const target = requireIndex("view.scroll", "line", line);
        await commands.run("view.scroll", { view: handle, line: target }, { origin: "plugin" });
      },
    ),

    "documents.open": withArity(
      "documents.open",
      1,
      async (path: string): Promise<DocumentHandle> => {
        const target = requireString("documents.open", "path", path);
        return documents.open(target);
      },
    ),

    "packages.resolve": withArity(
      "packages.resolve",
      1,
      (uri: string): { readonly uri: string; readonly size: number } | undefined => {
        const raw = requireString("packages.resolve", "uri", uri);
        try {
          parseResourceUri(raw);
        } catch (err) {
          throw new RpcCallError({
            code: "invalid-argument",
            message: `packages.resolve: uri fora do namespace packages:// (${describeValue(uri)})`,
            data: err instanceof Error ? err.message : undefined,
          });
        }
        const entry = packages.resolve(raw as ResourceUri);
        return entry === undefined ? undefined : { uri: entry.uri, size: entry.size };
      },
    ),
  };
}

// ── validação de argumentos ────────────────────────────────────────────────────────────────

/** Envolve o handler exigindo aridade exata (arity errada ⇒ `RpcCallError`). */
function withArity<A extends readonly unknown[], R>(
  method: string,
  arity: number,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    if (args.length !== arity) {
      throw new RpcCallError({
        code: "invalid-arity",
        message: `${method}: esperado ${arity} argumento(s), recebido ${args.length}`,
      });
    }
    return fn(...args);
  };
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function invalidArgument(method: string, name: string, expected: string, actual: unknown): RpcCallError {
  return new RpcCallError({
    code: "invalid-argument",
    message: `${method}: argumento "${name}" inválido (esperado ${expected}, recebido ${describeValue(actual)})`,
  });
}

function requireDocumentHandle(method: string, value: unknown): DocumentHandle {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidArgument(method, "doc", "DocumentHandle (int >= 0)", value);
  }
  return value as DocumentHandle;
}

function requireViewHandle(method: string, value: unknown): ViewHandle {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidArgument(method, "view", "ViewHandle (int >= 0)", value);
  }
  return value as ViewHandle;
}

function requireIndex(method: string, name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidArgument(method, name, "inteiro >= 0", value);
  }
  return value;
}

function requireString(method: string, name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidArgument(method, name, "string não vazia", value);
  }
  return value;
}

/** DEC-TR-1: o handle só vale se o registry o reconhece (geração incluída). */
function requireLiveDocument(method: string, registry: DocumentRegistry, handle: DocumentHandle): void {
  if (!registry.isValid(handle)) {
    throw new RpcCallError({
      code: "invalid-handle",
      message: `${method}: handle inválido ou de geração antiga: ${handle}`,
    });
  }
}

function countOf(result: CommandResult, method: string, fallback: number): number {
  if (!result.handled) {
    throw new RpcCallError({
      code: "command.unhandled",
      message: `${method}: comando não registrado no CommandBus`,
    });
  }
  return typeof result.value === "number" ? result.value : fallback;
}
