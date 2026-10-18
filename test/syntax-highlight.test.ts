/**
 * Scribe — integração **de ponta a ponta** do realce de sintaxe (Slice D).
 *
 * Prova o caminho completo sem display: `PackageResolver` acha a `.sublime-syntax` → o
 * `GrammarRegistry` compila → o `EditorCore` tokeniza as linhas → `buildInstances` gera glifos
 * coloridos por escopo (via `ThemeResolver`). Nada de Electron, nada de canvas real.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { GlyphAtlas, buildInstances, type LineLayout } from "../src/core/render";
import { createDefaultTheme } from "../src/core/syntax";
import type { ResourceScanner, ScannedResource } from "../src/core/packages";
import { IPC_VERSION } from "../src/shared";
import type { DocumentHandle, ResourceLayer } from "../src/shared";
import { handleIpcRequest, packageRoots } from "../src/main/index";

const FIXTURE = readFileSync(resolve(process.cwd(), "assets/grammars/scribe-demo.sublime-syntax"), "utf8");

const DEFAULT_COLOR = 0xd4d4d4ff;
const KEYWORD_COLOR = 0xc586c0ff;

function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path: string): Promise<string> => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(text);
    },
    writeFile: async (_path: string, _data: string): Promise<void> => {
      // mock em memória
    },
  };
}

/** Scanner fake: devolve a gramática de brinquedo como recurso `kind:"syntax"` da camada `app`. */
class FixtureScanner implements ResourceScanner {
  constructor(private readonly text: string) {}

  async scan(_roots: Partial<Record<ResourceLayer, readonly string[]>>): Promise<readonly ScannedResource[]> {
    return [
      {
        packageName: "Demo",
        layer: "app",
        path: "scribe-demo.sublime-syntax",
        size: this.text.length,
        handle: "scribe-demo",
      },
    ];
  }

  async load(handle: unknown): Promise<Uint8Array> {
    if (handle !== "scribe-demo") throw new Error("handle desconhecido");
    return new TextEncoder().encode(this.text);
  }
}

function coreWithDemoGrammar(text: string): ReturnType<typeof createEditorCore> {
  return createEditorCore({
    fileSystem: memoryFs({ "/notas.demo": text }),
    availableParallelism: 4,
    packageRoots: { app: ["/packages"] },
    packageScanner: new FixtureScanner(FIXTURE),
  });
}

function layout(): LineLayout {
  return {
    lineHeight: 20,
    paddingLeft: 8,
    paddingTop: 4,
    tabWidth: 4,
    scrollOffsetPx: 0,
    viewport: { x: 0, y: 0, w: 400, h: 100 },
    background: 0x1e1f22ff,
    defaultColor: DEFAULT_COLOR,
    gutterWidth: 0,
    gutterBackground: 0x2b2d30ff,
    gutterColor: 0x6e6e6eff,
    scrollbarWidth: 0,
    scrollbarTrack: 0x00000000,
    scrollbarThumb: 0x00000000,
    searchMatchColor: 0xffff0044,
    searchCurrentColor: 0xff880088,
    selectionColor: 0x264f78ff,
  bracketMatchColor: 0xffffffff,
    wrapWidth: 0,
  };
}

describe("realce de sintaxe de ponta a ponta (PackageResolver → gramática → tokens → cena)", () => {
  it("resolve a gramática pela extensão do documento", async () => {
    const core = coreWithDemoGrammar("const x = 1;\n");
    try {
      await core.syntaxReady;
      const handle = await core.openDocument("/notas.demo");
      expect(core.grammarForDocument(handle)?.name).toBe("Scribe Demo");
      expect(core.grammarForDocument(handle)?.fileExtensions).toEqual(["demo"]);
    } finally {
      core.dispose();
    }
  });

  it("recomputa o destaque quando a gramática chega depois (cache não fica preso na revisão)", async () => {
    const core = coreWithDemoGrammar("const z = 3;\n");
    try {
      // Pede o destaque **antes** de `syntaxReady`: ainda não há gramática (spans vazios).
      const handle = await core.openDocument("/notas.demo");
      const revision = core.revisionOf(handle);
      const before = await core.highlightDocument(handle, 0, 1);
      expect(before.revision).toBe(revision);
      expect(before.lines[0]?.spans).toEqual([]);

      await core.syntaxReady;

      // Mesma revisão, mas a gramática agora existe: a chave do cache inclui a identidade dela,
      // então o texto é retokenizado (sem isto, os spans vazios ficariam presos para sempre).
      const after = await core.highlightDocument(handle, 0, 1);
      expect(after.revision).toBe(revision);
      expect(after.lines[0]?.spans.some((span) => span.scope === "keyword.control.demo")).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it("retokeniza só a partir da linha editada quando o cache incremental pega (O(end) mitigado)", async () => {
    const core = coreWithDemoGrammar("const a = 1;\nconst b = 2;\nconst c = 3;\n");
    try {
      await core.syntaxReady;
      const handle = await core.openDocument("/notas.demo");
      const rev0 = core.revisionOf(handle);

      // 1) Tokeniza TODAS as 3 linhas — enche o cache.
      const full0 = await core.highlightDocument(handle, 0, 3);
      expect(full0.revision).toBe(rev0);
      expect(full0.lines).toHaveLength(3);
      // Linha 0 é keyword
      expect(full0.lines[0]?.spans.some((s) => s.scope === "keyword.control.demo")).toBe(true);
      // Linha 1 também
      expect(full0.lines[1]?.spans.some((s) => s.scope === "keyword.control.demo")).toBe(true);

      // 2) Edita a linha 1 (insere "X" no offset que cai nela).
      const rev1 = await core.insertText(handle, "const ".length, "X", "user");
      expect(rev1.revision).toBeGreaterThan(rev0);

      // 3) Pede destaque de novo — linhas 0 e 1 agora visíveis (2 linhas).
      {
        const partial = await core.highlightDocument(handle, 0, 2);
        expect(partial.revision).toBe(rev1.revision);

        // Linha 0 NÃO foi tocada → spans originais preservados (cache incremental).
        expect(partial.lines[0]?.spans.some((s) => s.scope === "keyword.control.demo")).toBe(true);
        expect(partial.lines[0]?.spans.some((s) => s.scope === "constant.numeric.demo")).toBe(true);
        // Linha 1 foi editada → spans foram recalculados; "Xconst b = 2" ainda é keyword.
        expect(partial.lines[1]?.spans.some((s) => s.scope === "keyword.control.demo")).toBe(true);
      }

      // 4) Garante que linha 2 (agora fora do range 0..2) continua sem spans corrompidos
      //    quando o cache for estendido depois.
      const full1 = await core.highlightDocument(handle, 0, 3);
      expect(full1.lines[2]?.spans.some((s) => s.scope === "keyword.control.demo")).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it("tokeniza as linhas e colore os glifos por escopo (≠ cor default)", async () => {
    const core = coreWithDemoGrammar('const total = 1;\n// fim\n');
    try {
      await core.syntaxReady;
      const handle = await core.openDocument("/notas.demo");
      const revision = core.revisionOf(handle);
      const highlight = await core.highlightDocument(handle, 0, 2);

      expect(highlight.revision).toBe(revision);
      expect(highlight.lines.map((line) => line.line)).toEqual([0, 1]);
      const firstSpans = highlight.lines[0]?.spans ?? [];
      expect(firstSpans.some((span) => span.scope === "keyword.control.demo")).toBe(true);
      expect(firstSpans.some((span) => span.scope === "constant.numeric.demo")).toBe(true);
      expect(highlight.lines[1]?.spans[0]?.scope).toBe("comment.line.double-slash.demo");

      const lines = ["const total = 1;", "// fim"];
      const scene = buildInstances(
        {
          lineCount: (): number => lines.length,
          line: (index: number): string => lines[index] ?? "",
          positionAt(offset: number): { line: number; column: number } {
            let remaining = offset;
            for (let i = 0; ; i++) {
              const len = this.line(i).length;
              if (remaining <= len) return { line: i, column: remaining };
              remaining -= len + 1;
            }
          },
        },
        layout(),
        new GlyphAtlas(),
        { family: "mono", sizePx: 16, weight: 400, italic: false },
        { first: 0, count: 2 },
        undefined,
        {
          spansFor: (line) => highlight.lines.find((entry) => entry.line === line)?.spans,
          theme: createDefaultTheme(),
        },
      );

      const colors = scene.glyphs.map((glyph) => glyph.color);
      expect(colors[0]).toBe(KEYWORD_COLOR); // 'c' de "const"
      expect(colors).toContain(DEFAULT_COLOR); // algum trecho sem escopo
      expect(colors.some((color) => color !== DEFAULT_COLOR)).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it("documento sem gramática devolve spans vazios (degrada na cor default)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/nota.txt": "x" }),
      availableParallelism: 4,
    });
    try {
      await core.syntaxReady;
      const handle = await core.openDocument("/nota.txt");
      expect(core.grammarForDocument(handle)).toBeUndefined();
      const highlight = await core.highlightDocument(handle, 0, 1);
      expect(highlight.lines).toEqual([{ line: 0, spans: [] }]);
    } finally {
      core.dispose();
    }
  });

  it("despacha `syntax.highlight` pelo contrato de IPC (main, sem Electron)", async () => {
    const core = coreWithDemoGrammar("const y = 2;\n");
    try {
      await core.syntaxReady;
      const handle = (await core.openDocument("/notas.demo")) as DocumentHandle;
      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 1,
        method: "syntax.highlight",
        args: [handle, 0, 1],
      });
      expect(response.ok).toBe(true);
      if (response.ok) {
        const value = response.value as { lines: { spans: { scope: string }[] }[] };
        expect(value.lines[0]?.spans.some((span) => span.scope === "keyword.control.demo")).toBe(true);
      }
    } finally {
      core.dispose();
    }
  });

  it("rejeita args inválidos com falha estruturada (nunca silencioso)", async () => {
    const core = coreWithDemoGrammar("x\n");
    try {
      await core.syntaxReady;
      const response = await handleIpcRequest(core, {
        v: IPC_VERSION,
        id: 2,
        method: "syntax.highlight",
        args: ["não é handle", 0, 1],
      });
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe("invalid-args");
    } finally {
      core.dispose();
    }
  });
});

describe("realce — raízes de pacote do app", () => {
  /**
   * O scanner só desce em **diretórios**: cada raiz é um contentor de pacotes. A gramática de
   * brinde mora em `assets/grammars/`, então a raiz do app tem de ser `assets/` — apontar para
   * `assets/grammars` faz o scanner ignorar o arquivo e o realce nunca liga (regressão real,
   * achada com o app aberto: `syntax.highlight` respondia sempre sem spans).
   */
  it("a raiz do app registra a gramática de brinde (assets/ é contentor de pacotes)", async () => {
    const core = createEditorCore({
      fileSystem: memoryFs({ "/notas.demo": "const a = 1;\n" }),
      availableParallelism: 4,
      packageRoots: packageRoots(process.cwd(), "/userData"),
    });
    try {
      await core.syntaxReady;
      const handle = await core.openDocument("/notas.demo");
      expect(core.grammarForDocument(handle)?.name).toBe("Scribe Demo");
      const highlight = await core.highlightDocument(handle, 0, 1);
      expect(highlight.lines[0]?.spans.some((span) => span.scope === "keyword.control.demo")).toBe(true);
    } finally {
      core.dispose();
    }
  });
});
