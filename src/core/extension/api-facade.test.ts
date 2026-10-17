import { describe, expect, it } from "vitest";

import type {
  CommandBus,
  Disposable,
  DocumentHandle,
  DocumentRegistry,
  EditOrigin,
  ExtensionBridge,
  PackageResolver,
  ResourceUri,
} from "../../shared";

import { createExtensionAPI, createMethodHandlers } from "./api-facade";
import { RpcCallError } from "./bridge";

interface RecordedRun {
  readonly name: string;
  readonly args: unknown;
  readonly opts: { readonly group?: string; readonly origin?: EditOrigin } | undefined;
}

function makeCommands(value: unknown = 7): { commands: CommandBus; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  const commands = {
    run: async (
      name: string,
      args?: unknown,
      opts?: { readonly group?: string; readonly origin?: EditOrigin },
    ) => {
      runs.push({ name, args, opts });
      return { name, handled: true, value };
    },
    register: (): Disposable => ({ dispose: () => undefined }),
    dispatch: async (): Promise<void> => undefined,
    subscribe: (): Disposable => ({ dispose: () => undefined }),
    openEditScope: (): never => {
      throw new Error("openEditScope não usado no teste");
    },
    glueMarkedGroups: (): void => undefined,
    softUndo: (): void => undefined,
    softRedo: (): void => undefined,
  } as unknown as CommandBus;
  return { commands, runs };
}

function makeDocuments(valid = true): DocumentRegistry {
  return {
    isValid: () => valid,
    open: async (): Promise<DocumentHandle> => 1 as DocumentHandle,
  } as unknown as DocumentRegistry;
}

function makePackages(size = 3): PackageResolver {
  return {
    resolve: (uri: ResourceUri) => ({ uri, size }) as never,
  } as unknown as PackageResolver;
}

function makeHandlers(overrides: { commands?: CommandBus; documents?: DocumentRegistry; packages?: PackageResolver } = {}) {
  const { commands } = makeCommands();
  return createMethodHandlers({
    commands: overrides.commands ?? commands,
    documents: overrides.documents ?? makeDocuments(),
    packages: overrides.packages ?? makePackages(),
  });
}

const DOC = 1 as DocumentHandle;

describe("createMethodHandlers — roteamento e validação", () => {
  it("buffer.insert roteia pelo CommandBus com origin 'plugin'", async () => {
    const { commands, runs } = makeCommands(7);
    const handlers = makeHandlers({ commands });

    await expect(handlers["buffer.insert"](DOC, 0, "hi")).resolves.toBe(7);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.name).toBe("buffer.insert");
    expect(runs[0]?.opts?.origin).toBe("plugin");
    expect(runs[0]?.args).toEqual({ doc: DOC, at: 0, text: "hi" });
  });

  it("buffer.erase roteia pelo CommandBus com origin 'plugin'", async () => {
    const { commands, runs } = makeCommands(5);
    const handlers = makeHandlers({ commands });

    await expect(handlers["buffer.erase"](DOC, 2, 3)).resolves.toBe(5);
    expect(runs[0]?.name).toBe("buffer.erase");
    expect(runs[0]?.opts?.origin).toBe("plugin");
  });

  it("arity errada → RpcCallError('invalid-arity')", () => {
    const handlers = makeHandlers();
    const call = handlers["buffer.insert"] as unknown as (...args: unknown[]) => unknown;

    try {
      call(DOC, 0);
      throw new Error("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcCallError);
      expect((err as RpcCallError).code).toBe("invalid-arity");
    }
  });

  it("tipo errado → RpcCallError('invalid-argument')", async () => {
    const handlers = makeHandlers();
    const call = handlers["buffer.insert"] as unknown as (...args: unknown[]) => Promise<unknown>;

    await expect(call("nao-e-handle", 0, "hi")).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("handle morto → RpcCallError('invalid-handle') (DEC-TR-1)", async () => {
    const handlers = makeHandlers({ documents: makeDocuments(false) });
    const call = handlers["buffer.insert"] as unknown as (...args: unknown[]) => Promise<unknown>;

    await expect(call(DOC, 0, "hi")).rejects.toMatchObject({ code: "invalid-handle" });
  });

  it("packages.resolve devolve {uri,size} e valida o namespace", async () => {
    const handlers = makeHandlers({ packages: makePackages(9) });

    expect(handlers["packages.resolve"]("packages://Default/a.sublime-settings")).toEqual({
      uri: "packages://Default/a.sublime-settings",
      size: 9,
    });

    try {
      handlers["packages.resolve"]("nao-e-uri");
      throw new Error("deveria ter lançado");
    } catch (err) {
      expect((err as RpcCallError).code).toBe("invalid-argument");
    }
  });

  it("documents.open encaminha para o registry", async () => {
    const handlers = makeHandlers();
    await expect(handlers["documents.open"]("C:/tmp/a.txt")).resolves.toBe(1);
  });
});

describe("createExtensionAPI — façade fina", () => {
  it("delega sem manter estado próprio", () => {
    const { commands } = makeCommands();
    const documents = makeDocuments();
    const packages = makePackages();
    const bridge = {
      version: "1.2",
      on: (): Disposable => ({ dispose: () => undefined }),
    } as unknown as ExtensionBridge;

    const api = createExtensionAPI({ bridge, commands, documents, packages });

    expect(api.version).toBe("1.2");
    expect(api.documents).toBe(documents);
    expect(api.commands).toBe(commands);
    expect(api.packages).toBe(packages);
    expect(typeof api.on("ready", () => undefined).dispose).toBe("function");
  });
});
