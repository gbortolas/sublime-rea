/**
 * Testes do handshake LSP com um **servidor fake de verdade** (processo `node -e`).
 *
 * O fake implementa o mínimo do protocolo sobre stdio (`Content-Length` framing) e
 * reproduz o comportamento real dos servidores que motivou o achado ALTO:
 *
 * > o `typescript-language-server` (e o `pyright`) derivam o suporte a diagnósticos de
 * > `capabilities.textDocument.publishDiagnostics`
 * > (`features.diagnosticsSupport = Boolean(publishDiagnostics)`) — com `capabilities: {}`
 * > o servidor **não publica diagnóstico nenhum**.
 *
 * Logo: o fake **só publica diagnóstico** se as capabilities do `initialize` trouxerem
 * `textDocument.publishDiagnostics`. Com o código antigo (`capabilities: {}`) este teste
 * falha (0 diagnósticos); com o código novo, publica (1 diagnóstico).
 *
 * O fake também devolve `textDocumentSync.change` (negociável via `initializationOptions`)
 * e ecoa o `contentChanges` recebido — é assim que se prova que, em modo incremental, o
 * cliente manda o **delta** (e não o documento inteiro).
 */
import { describe, expect, it } from "vitest";

import { LspManager } from "../lsp-manager";
import type { LspServerConfig } from "../../../shared/lsp-contract";
import type { Diagnostic } from "../lsp-protocol";

// ── Servidor LSP fake ───────────────────────────────────────────────────────────────────────

/**
 * Fonte do servidor fake (JavaScript puro, roda em `node -e`).
 * Array de linhas — evita a confusão de escapes de um template literal.
 */
const FAKE_SERVER_SOURCE: string = [
  "let buf = Buffer.alloc(0);",
  "function send(msg) {",
  "  const body = Buffer.from(JSON.stringify(msg), 'utf8');",
  "  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');",
  "  process.stdout.write(body);",
  "}",
  "function handle(msg) {",
  "  if (msg.method === 'initialize') {",
  "    const params = msg.params || {};",
  "    const caps = params.capabilities || {};",
  "    const opts = params.initializationOptions || {};",
  "    globalThis.__caps = caps;",
  "    // O servidor só publica diagnóstico se o cliente PEDIR o recurso.",
  "    globalThis.__wants = Boolean(caps.textDocument && caps.textDocument.publishDiagnostics);",
  "    const change = typeof opts.syncChange === 'number' ? opts.syncChange : 1;",
  "    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: { openClose: true, change: change } } } });",
  "    return;",
  "  }",
  "  if (msg.method === 'textDocument/didOpen') {",
  "    if (globalThis.__wants) {",
  "      const uri = msg.params.textDocument.uri;",
  "      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uri, diagnostics: [ { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'aberto', source: JSON.stringify(globalThis.__caps) } ] } });",
  "    }",
  "    return;",
  "  }",
  "  if (msg.method === 'textDocument/didChange') {",
  "    if (globalThis.__wants) {",
  "      const uri = msg.params.textDocument.uri;",
  "      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uri, diagnostics: [ { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'alterado', source: JSON.stringify(msg.params.contentChanges) } ] } });",
  "    }",
  "    return;",
  "  }",
  "  if (msg.method === 'shutdown') { send({ jsonrpc: '2.0', id: msg.id, result: null }); return; }",
  "  if (msg.method === 'exit') { process.exit(0); }",
  "}",
  "process.stdin.on('data', function (chunk) {",
  "  buf = Buffer.concat([buf, chunk]);",
  "  for (;;) {",
  "    const headerEnd = buf.indexOf('\\r\\n\\r\\n');",
  "    if (headerEnd === -1) return;",
  "    const header = buf.slice(0, headerEnd).toString('ascii');",
  "    const m = /Content-Length:\\s*(\\d+)/i.exec(header);",
  "    if (!m) return;",
  "    const len = parseInt(m[1], 10);",
  "    const bodyStart = headerEnd + 4;",
  "    if (buf.length < bodyStart + len) return;",
  "    const body = buf.slice(bodyStart, bodyStart + len).toString('utf8');",
  "    buf = buf.slice(bodyStart + len);",
  "    handle(JSON.parse(body));",
  "  }",
  "});",
].join("\n");

function fakeConfig(syncChange?: number): LspServerConfig {
  return {
    name: "Fake",
    kind: "builtin",
    languages: ["ts"],
    languageId: "typescript",
    spawn: { command: process.execPath, args: ["-e", FAKE_SERVER_SOURCE] },
    ...(syncChange !== undefined ? { initializationOptions: { syncChange } } : {}),
    enabled: true,
  };
}

/** Aguarda um valor devolvido pelo predicado (o servidor responde de forma assíncrona). */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error("timeout esperando o servidor LSP fake");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Published {
  readonly uri: string;
  readonly diagnostics: readonly Diagnostic[];
}

describe("LspManager — capabilities do cliente (handshake real)", () => {
  it("pede textDocument.publishDiagnostics ⇒ o servidor publica diagnóstico", async () => {
    const config = fakeConfig();
    const manager = new LspManager([config]);
    const published: Published[] = [];
    manager.onDiagnostics((params) => published.push(params));

    await manager.startServer(config);
    try {
      manager.openDocument("file:///test.ts", "typescript", "const x = 1;", 1);

      const received = await waitFor(() => published[0]);
      expect(received.uri).toBe("file:///test.ts");
      expect(received.diagnostics).toHaveLength(1);

      // As capabilities recebidas pelo servidor provam o pedido.
      const caps = JSON.parse(received.diagnostics[0]?.source ?? "{}") as Record<string, unknown>;
      expect(caps).toMatchObject({
        textDocument: {
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          synchronization: { didSave: true, dynamicRegistration: false, textDocumentSync: 1 },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
            },
          },
          definition: { linkSupport: true },
          codeAction: {
            resolveSupport: true,
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          foldingRange: {},
          references: {},
        },
        workspace: { workspaceFolders: true, configuration: true },
      });
    } finally {
      await manager.disconnectAll();
      manager.dispose();
    }
  });

  it("respeita textDocumentSync=1 (full): manda o documento inteiro no didChange", async () => {
    const config = fakeConfig(1);
    const manager = new LspManager([config]);
    const published: Published[] = [];
    manager.onDiagnostics((params) => published.push(params));

    await manager.startServer(config);
    try {
      manager.openDocument("file:///test.ts", "typescript", "const x = 1;", 1);
      manager.changeDocument("file:///test.ts", "const y = 2;", 2);

      const changed = await waitFor(() =>
        published.find((p) => p.diagnostics[0]?.message === "alterado"),
      );
      const changes = JSON.parse(changed.diagnostics[0]?.source ?? "[]") as readonly {
        readonly range?: { readonly start: { line: number; character: number } };
        readonly text: string;
      }[];
      expect(changes).toHaveLength(1);
      expect(changes[0]?.range).toBeUndefined();
      expect(changes[0]?.text).toBe("const y = 2;");
    } finally {
      await manager.disconnectAll();
      manager.dispose();
    }
  });

  it("respeita textDocumentSync=2 (incremental): manda o DELTA, não o documento inteiro", async () => {
    const config = fakeConfig(2);
    const manager = new LspManager([config]);
    const published: Published[] = [];
    manager.onDiagnostics((params) => published.push(params));

    const before = "const x = 1;";
    const after = "const y = 2;";

    await manager.startServer(config);
    try {
      manager.openDocument("file:///test.ts", "typescript", before, 1);
      manager.changeDocument("file:///test.ts", after, 2);

      const changed = await waitFor(() =>
        published.find((p) => p.diagnostics[0]?.message === "alterado"),
      );
      const changes = JSON.parse(changed.diagnostics[0]?.source ?? "[]") as readonly {
        readonly range?: {
          readonly start: { readonly line: number; readonly character: number };
          readonly end: { readonly line: number; readonly character: number };
        };
        readonly text: string;
      }[];
      expect(changes).toHaveLength(1);
      const change = changes[0];
      expect(change?.range).toBeDefined();
      // O delta é **menor** que o documento inteiro (1 MB no lugar de 1 byte).
      expect((change?.text.length ?? 0)).toBeLessThan(before.length);
      // E aplica certo: o range substitui exatamente o trecho trocado.
      const range = change?.range;
      expect(range).toBeDefined();
      const lines = before.split("\n");
      const offsetOf = (line: number, character: number): number =>
        lines.slice(0, line).reduce((acc, l) => acc + l.length + 1, 0) + character;
      const applied =
        before.slice(0, offsetOf(range!.start.line, range!.start.character)) +
        (change?.text ?? "") +
        before.slice(offsetOf(range!.end.line, range!.end.character));
      expect(applied).toBe(after);
    } finally {
      await manager.disconnectAll();
      manager.dispose();
    }
  });

  it("delta incremental: aplica certo em casos tricky (linhas, fim do arquivo)", async () => {
    const config = fakeConfig(2);
    const manager = new LspManager([config]);
    const published: Published[] = [];
    manager.onDiagnostics((params) => published.push(params));

    const cases: readonly (readonly [string, string])[] = [
      ["const x = 1;", "const y = 2;"],
      ["abc", "abcd"],
      ["abc", "ab"],
      ["a\nb\nc", "a\nB\nc"],
      ["a\nb", "a\nb\nc"],
      ["", "x"],
      ["x", ""],
      ["linha1\nlinha2\nlinha3", "linha1\nlinha2 alterada\nlinha3\nlinha4"],
    ];

    await manager.startServer(config);
    try {
      for (const [index, [before, after]] of cases.entries()) {
        const uri = `file:///caso-${index}.ts`;
        manager.openDocument(uri, "typescript", before, 1);
        manager.changeDocument(uri, after, 2);
      }

      const changes = await waitFor(() => {
        const found = published.filter((p) => p.diagnostics[0]?.message === "alterado");
        return found.length === cases.length ? found : undefined;
      });

      for (const [index, [before, after]] of cases.entries()) {
        const raw = JSON.parse(changes[index]?.diagnostics[0]?.source ?? "[]") as readonly {
          readonly range?: {
            readonly start: { readonly line: number; readonly character: number };
            readonly end: { readonly line: number; readonly character: number };
          };
          readonly text: string;
        }[];
        expect(raw, `caso ${index}`).toHaveLength(1);
        const range = raw[0]?.range;
        expect(range, `caso ${index} (sem range ⇒ não é incremental)`).toBeDefined();
        const lines = before.split("\n");
        const offsetOf = (line: number, character: number): number =>
          lines.slice(0, line).reduce((acc, l) => acc + l.length + 1, 0) + character;
        const applied =
          before.slice(0, offsetOf(range!.start.line, range!.start.character)) +
          (raw[0]?.text ?? "") +
          before.slice(offsetOf(range!.end.line, range!.end.character));
        expect(applied, `caso ${index}`).toBe(after);
      }
    } finally {
      await manager.disconnectAll();
      manager.dispose();
    }
  });

  /**
   * Regressão do framing do `LspStdioTransport`: o `Content-Length` do protocolo LSP é o
   * tamanho do corpo em **bytes UTF-8**. Decodificar o stdout em `string` e comparar com o
   * tamanho da string travava a mensagem com **qualquer caractere não-ASCII** (emoji, acento)
   * — e todas as mensagens seguintes ⇒ o `publishDiagnostics` nunca chegava.
   *
   * ✅ **Corrigido** (o transporte acumula `Buffer` e fatia por byte).
   */
  it(
    "delta incremental: caso não-ASCII (emoji) — o framing por byte funciona",
    async () => {
      const config = fakeConfig(2);
      const manager = new LspManager([config]);
      const published: Published[] = [];
      manager.onDiagnostics((params) => published.push(params));

      const before = "hello 🌍 world";
      const after = "hello 🌍🌎 world";

      await manager.startServer(config);
      try {
        manager.openDocument("file:///emoji.ts", "typescript", before, 1);
        manager.changeDocument("file:///emoji.ts", after, 2);

        const changed = await waitFor(
          () => published.find((p) => p.diagnostics[0]?.message === "alterado"),
          2000,
        );
        const raw = JSON.parse(changed.diagnostics[0]?.source ?? "[]") as readonly {
          readonly range?: {
            readonly start: { readonly line: number; readonly character: number };
            readonly end: { readonly line: number; readonly character: number };
          };
          readonly text: string;
        }[];
        expect(raw[0]?.range).toBeDefined();
        expect(raw[0]?.text).toBe("🌎");
      } finally {
        // ⚠️ Sem `disconnectAll`: o `shutdown` não volta (o framing está travado) e o
        // cliente ficaria 15 s esperando o timeout do request.
        manager.dispose();
      }
    },
    4000,
  );
});
