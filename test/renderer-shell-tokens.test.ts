/**
 * Scribe — auditoria da casca: tokens de cor e escala de z-index.
 *
 * Dois invariantes que a auditoria de UX violou:
 *
 * 1. **Todo `var(--token)` usado existe.** Um token inexistente faz o `var()` cair no
 *    fallback cru: `var(--bg, #1e1e1e)` no tema claro deixava o popup de code actions com
 *    fundo #1e1e1e e texto #3b3b3b — 1,06:1 de contraste (ilegível). O mesmo valia para
 *    `--s-editor`, `--s-fg-muted`, `--highlight`, `--fg-secondary`, `--fg-tertiary`, `--bg`,
 *    `--font` e `--hover-bg`.
 * 2. **Nenhum z-index solto.** A escala de z-index vive em `:root` (`--z-*`): sem ela, a
 *    paleta (z5) ficava abaixo do popup de símbolos (z6) e a find bar (z3) ficava sob a
 *    paleta — o input da busca ficava inacessível.
 *
 * O teste lê o CSS e os módulos da casca como **texto** (não precisa de DOM).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");
const RENDERER_DIR = join(REPO_ROOT, "src", "renderer");
const CSS_PATH = join(RENDERER_DIR, "index.css");

/** Módulos da casca escrevem estilo inline (o `cssText`) — todos devem seguir a escala. */
const SHELL_MODULES = [
  "command-palette.ts",
  "completions.ts",
  "debug-panel.ts",
  "document-symbols.ts",
  "find-bar.ts",
  "hover-tooltip.ts",
  "popup-geometry.ts",
  "references-popup.ts",
  "signature-help.ts",
  "snippet-choice.ts",
];

function readCss(): string {
  return readFileSync(CSS_PATH, "utf8");
}

/** Tokens **declarados** no CSS (`--nome:`). */
function declaredTokens(css: string): Set<string> {
  const tokens = new Set<string>();
  const pattern = /(--[a-zA-Z0-9_-]+)\s*:/g;
  let match = pattern.exec(css);
  while (match !== null) {
    tokens.add(match[1]!);
    match = pattern.exec(css);
  }
  return tokens;
}

/** Tokens **usados** (`var(--nome`). */
function usedTokens(source: string): Set<string> {
  const tokens = new Set<string>();
  const pattern = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    tokens.add(match[1]!);
    match = pattern.exec(source);
  }
  return tokens;
}

/** Arquivos `.ts` do renderer (o `main.ts` entra: é a casca). */
function rendererModules(): string[] {
  return readdirSync(RENDERER_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

describe("casca — tokens de cor", () => {
  it("todo `var(--token)` usado na casca está declarado em `index.css`", () => {
    const css = readCss();
    const declared = declaredTokens(css);
    const missing = new Set<string>();
    const files = [CSS_PATH, ...rendererModules().map((name) => join(RENDERER_DIR, name))];
    for (const file of files) {
      for (const token of usedTokens(readFileSync(file, "utf8"))) {
        if (!declared.has(token)) missing.add(token);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("nenhum token da casca usa fallback de cor crua (`var(--x, #hex)`)", () => {
    // O fallback cru é o que esconde o token inexistente: sem ele, o bug reaparece em
    // silêncio (fundo escuro fixo no tema claro).
    const files = [CSS_PATH, ...SHELL_MODULES.map((name) => join(RENDERER_DIR, name))];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const pattern = /var\(\s*--[a-zA-Z0-9_-]+\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\()/g;
      let match = pattern.exec(source);
      while (match !== null) {
        offenders.push(`${file}: ${match[0]}`);
        match = pattern.exec(source);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("os aliases de runtime apontam para tokens `--s-*` (o tema acompanha)", () => {
    const css = readCss();
    const aliases: ReadonlyArray<readonly [string, string]> = [
      ["--bg", "--s-bg"],
      ["--font", "--s-font-ui"],
      ["--hover-bg", "--s-hover"],
      ["--highlight", "--s-selected"],
      ["--s-highlight", "--s-selected"],
      ["--s-editor", "--s-bg"],
      ["--fg-secondary", "--s-muted"],
      ["--fg-tertiary", "--s-subtle"],
      ["--fg", "--s-fg"],
      ["--border", "--s-border"],
      ["--bg-overlay", "--s-sidebar"],
      ["--bg-input", "--s-bg"],
    ];
    for (const [alias, target] of aliases) {
      expect(css).toContain(`${alias}: var(${target});`);
    }
  });
});

describe("casca — escala de z-index", () => {
  it("a escala `--z-*` está declarada em `:root`", () => {
    const css = readCss();
    for (const token of [
      "--z-surface",
      "--z-overlay",
      "--z-minimap",
      "--z-findbar",
      "--z-panel",
      "--z-popup",
      "--z-toolbar",
      "--z-modal",
      "--z-tooltip",
    ]) {
      expect(css).toMatch(new RegExp(`${token}:\\s*\\d+;`));
    }
  });

  it("a escala é crescente (a ordem de pintura é a da fonte)", () => {
    const css = readCss();
    const values = ["--z-surface", "--z-overlay", "--z-minimap", "--z-findbar", "--z-panel", "--z-popup", "--z-toolbar", "--z-modal", "--z-tooltip"];
    const parsed = values.map((token) => {
      const match = new RegExp(`${token}:\\s*(\\d+);`).exec(css);
      return Number(match?.[1]);
    });
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i]!).toBeGreaterThan(parsed[i - 1]!);
    }
  });

  it("nenhum z-index solto no CSS nem nos módulos da casca", () => {
    const files = [CSS_PATH, ...SHELL_MODULES.map((name) => join(RENDERER_DIR, name))];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const pattern = /z-index:\s*(-?\d+)/g;
      let match = pattern.exec(source);
      while (match !== null) {
        offenders.push(`${file}: ${match[0]}`);
        match = pattern.exec(source);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("casca — a find bar não é coberta", () => {
  it("a find bar fica na escala acima do overlay e abaixo dos modais", () => {
    const css = readCss();
    const findBar = /#find-bar\s*\{[^}]*z-index:\s*var\(--z-findbar\)/s.exec(css);
    expect(findBar).not.toBeNull();
    const palette = /#command-palette\s*\{[^}]*z-index:\s*var\(--z-modal\)/s.exec(css);
    expect(palette).not.toBeNull();
  });

  it("a barra/painel de depuração têm posição própria (abaixo da find bar)", () => {
    const css = readCss();
    // O `top` da depuração vem do CSS (não inline) — é o que permite descer com a find bar.
    expect(css).toMatch(/#debug-toolbar\s*\{[^}]*top:\s*var\(--s-debug-top\)/s);
    expect(css).toMatch(/#debug-panel\s*\{[^}]*top:\s*calc\(var\(--s-debug-top\)/s);
    expect(css).toContain("#ui-overlay:has(#find-bar:not([hidden]))");
  });
});
