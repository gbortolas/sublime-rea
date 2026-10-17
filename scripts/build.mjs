/**
 * Scribe — pipeline de build (Fase 3 / P2.2).
 *
 * Por que não é só `tsc`:
 *
 * 1. **main + core** precisam da **árvore preservada** em `dist/`: o `TaskPool` resolve o entry do
 *    worker por `path.join(__dirname, "worker-entry.js")`, então `dist/core/concurrency/worker-entry.js`
 *    tem que existir ao lado do resto. Isso é exatamente o que o `tsc` faz → etapa 1.
 * 2. **renderer** roda no Chromium como `<script src="./main.js">`: CommonJS com `require` não
 *    funciona sem loader. Bundle **IIFE** resolve → etapa 2 (sobrescreve o `.js` do `tsc`).
 * 3. **preload** roda com `sandbox: true`: um preload em sandbox **não pode** `require` arquivo
 *    irmão (só `electron` e poucos builtins). Bundle **CJS self-contained** com `electron`
 *    external inlina o que vier de `src/shared/**` → etapa 3.
 * 4. HTML/CSS não são código: cópia explícita → etapa 4.
 *
 * Uso: `node scripts/build.mjs` (é o que o `npm run build` chama).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

/** Executa um comando e deixa stdout/stderr fluírem (falha alto se o exit != 0).
 * Usa `shell: true` no Windows porque `npx` é `npx.cmd` e `spawnSync` sem shell
 * não encontra executáveis `.cmd` nativos do npm. */
function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  // 1) main + core (+ shared): árvore preservada, CJS, `worker-entry.js` no lugar certo.
  run("npx", ["tsc", "-p", "tsconfig.build.json"]);

  // 2) renderer: IIFE para o <script> do index.html (o `tsc` já emitiu um .js CJS — sobrescrevemos).
  await esbuild({
    entryPoints: [resolve(root, "src/renderer/main.ts")],
    outfile: resolve(dist, "renderer/main.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome124", // Chromium do Electron 38
    sourcemap: true,
    logLevel: "info",
  });

  // 3) preload: self-contained, só `electron` fica de fora (sandbox: true).
  await esbuild({
    entryPoints: [resolve(root, "src/preload/index.ts")],
    outfile: resolve(dist, "preload/index.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  });

  // 3.5) worker: bundle CJS que resolve imports do shared (sem external — tudo inline).
  await esbuild({
    entryPoints: [resolve(root, "src/core/concurrency/worker-entry.ts")],
    outfile: resolve(dist, "core/concurrency/worker-entry.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: true,
    logLevel: "info",
  });

  // 4) assets do renderer.
  await cp(resolve(root, "src/renderer/index.html"), resolve(dist, "renderer/index.html"));
  await cp(resolve(root, "src/renderer/index.css"), resolve(dist, "renderer/index.css"));

  // 5) guarda-corpo: o worker do TaskPool é resolvido por caminho em runtime.
  const workerEntry = resolve(dist, "core/concurrency/worker-entry.js");
  if (!existsSync(workerEntry)) {
    throw new Error(`build: árvore incompleta, esperava ${workerEntry}`);
  }

  process.stdout.write("build ok → dist/\n");
}

main().catch((err) => {
  process.stderr.write(`build falhou: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
