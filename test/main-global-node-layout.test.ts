/**
 * Scribe — descoberta do node global (achado MÉDIO da auditoria com runtime).
 *
 * **O bug:** o fallback do AppImage só varria `~/.nvm/versions/node/*` ⇒ se o `npm -g` do
 * usuário estivesse em outro prefixo (pnpm/volta/asdf/npm do sistema), o app ficava **sem
 * LSP nenhum** (o spawn dos servidores falhava com ENOENT).
 *
 * **A correção:** além do nvm, o `main` pergunta ao **npm real** do usuário
 * (`npm config get prefix`; fallback `npm bin -g` para npm < 9) — **sem shell**
 * (`execFileSync` com array de args) e com orçamento de tempo.
 */
import { describe, expect, it } from "vitest";

import { detectGlobalNodeLayout, nvmNodeLayout } from "../src/main/index";

describe("main — layout global do node", () => {
  it("usa o prefixo do `npm config get prefix`", () => {
    const calls: Array<[string, readonly string[]]> = [];
    const run = (file: string, args: readonly string[]): string | undefined => {
      calls.push([file, args]);
      return file === "npm" && args[0] === "config" ? "/opt/node-22\n" : undefined;
    };

    const layout = detectGlobalNodeLayout(["npm"], run);
    expect(layout.binDirs).toEqual(["/opt/node-22/bin"]);
    expect(layout.moduleRoots).toEqual(["/opt/node-22/lib/node_modules"]);
    // Sem shell: o `npm` é chamado com array de args.
    expect(calls[0]).toEqual(["npm", ["config", "get", "prefix"]]);
  });

  it("cai para `npm bin -g` (npm < 9) quando `config get prefix` falha", () => {
    const run = (_file: string, args: readonly string[]): string | undefined =>
      args[0] === "bin" ? "/usr/local/bin\n" : undefined;

    const layout = detectGlobalNodeLayout(["npm"], run);
    expect(layout.binDirs).toEqual(["/usr/local/bin"]);
    // O `bin` devolvido é o **diretório de binários** ⇒ o `node_modules` é o irmão dele.
    expect(layout.moduleRoots).toEqual(["/usr/local/lib/node_modules"]);
  });

  it("tenta os candidatos do npm em ordem (o do PATH primeiro)", () => {
    const tried: string[] = [];
    const run = (file: string, args: readonly string[]): string | undefined => {
      tried.push(file);
      if (file !== "/home/u/.nvm/versions/node/v22.2.0/bin/npm") return undefined;
      return args[0] === "config" ? "/home/u/.nvm/versions/node/v22.2.0" : undefined;
    };

    const layout = detectGlobalNodeLayout(
      ["npm", "/home/u/.nvm/versions/node/v22.2.0/bin/npm"],
      run,
    );
    expect(tried[0]).toBe("npm");
    expect(tried).toContain("/home/u/.nvm/versions/node/v22.2.0/bin/npm");
    expect(layout.binDirs).toEqual(["/home/u/.nvm/versions/node/v22.2.0/bin"]);
    expect(layout.moduleRoots).toEqual([
      "/home/u/.nvm/versions/node/v22.2.0/lib/node_modules",
    ]);
  });

  it("sem npm (nem resposta) ⇒ layout vazio (o app segue sem LSP, não quebra)", () => {
    const layout = detectGlobalNodeLayout(["npm"], () => undefined);
    expect(layout.binDirs).toEqual([]);
    expect(layout.moduleRoots).toEqual([]);
  });

  it("layout do nvm: bin e node_modules, do mais novo para o mais antigo", () => {
    const layout = nvmNodeLayout(
      "/home/u/.nvm/versions/node",
      () => ["v20.1.0", "v22.2.0"],
      (path) => path.endsWith("/bin"),
    );
    expect(layout.binDirs).toEqual([
      "/home/u/.nvm/versions/node/v22.2.0/bin",
      "/home/u/.nvm/versions/node/v20.1.0/bin",
    ]);
    expect(layout.moduleRoots).toEqual([
      "/home/u/.nvm/versions/node/v22.2.0/lib/node_modules",
      "/home/u/.nvm/versions/node/v20.1.0/lib/node_modules",
    ]);
  });

  it("sem nvm ⇒ layout vazio (sem exceção)", () => {
    const layout = nvmNodeLayout(
      "/home/u/.nvm/versions/node",
      () => {
        throw new Error("ENOENT");
      },
      () => true,
    );
    expect(layout.binDirs).toEqual([]);
    expect(layout.moduleRoots).toEqual([]);
  });
});
