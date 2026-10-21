/**
 * Regressão do **deadlock do servidor** (bug ALTO): requests servidor→cliente sem resposta.
 *
 * O `pyright` envia `workspace/configuration` (server→client) e **fica bloqueado** esperando
 * a resposta. Com o cliente ignorando todo request do servidor, o servidor inteiro travava:
 * `textDocument/documentSymbol` não voltava (timeout de 15 s) e nenhum diagnóstico era
 * publicado ⇒ Outline e Problems ficavam vazios em `.py`.
 *
 * Este teste usa um **servidor fake de verdade** (processo `node -e`, stdio com framing
 * `Content-Length`) que reproduz exatamente esse comportamento: ele **só** responde ao
 * `documentSymbol` **depois** de receber a resposta do `workspace/configuration`.
 *
 * Sem a correção ⇒ `requestDocumentSymbols` estoura `LSP_TIMEOUT`.
 * Com a correção ⇒ os símbolos voltam **e** as respostas chegam com o conteúdo certo.
 */
import { describe, expect, it } from "vitest";

import { LspManager } from "../lsp-manager";
import type { LspServerConfig } from "../../../shared/lsp-contract";
import type { Diagnostic } from "../lsp-protocol";

// ── Servidor LSP fake (bloqueia até o cliente responder) ────────────────────────────────────

const FAKE_SERVER_SOURCE: string = [
  "let buf = Buffer.alloc(0);",
  "let configAnswered = false;",
  "let foldersAnswered = false;",
  "let configAnswer = null;",
  "let foldersAnswer = null;",
  "function send(msg) {",
  "  const body = Buffer.from(JSON.stringify(msg), 'utf8');",
  "  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');",
  "  process.stdout.write(body);",
  "}",
  "function handle(msg) {",
  "  // Respostas do cliente aos nossos requests.",
  "  if (msg.id === 'cfg-1') { configAnswered = true; configAnswer = msg.result; return; }",
  "  if (msg.id === 'folders-1') { foldersAnswered = true; foldersAnswer = msg.result; return; }",
  "  if (msg.method === 'initialize') {",
  "    // O pyright pergunta a configuração e fica esperando a resposta.",
  "    send({ jsonrpc: '2.0', id: 'cfg-1', method: 'workspace/configuration', params: { items: [ { scopeUri: 'file:///test.py', section: 'python' } ] } });",
  "    send({ jsonrpc: '2.0', id: 'folders-1', method: 'workspace/workspaceFolders' });",
  "    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { documentSymbolProvider: true } } });",
  "    return;",
  "  }",
  "  if (msg.method === 'textDocument/didOpen') {",
  "    if (configAnswered && foldersAnswered) {",
  "      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: msg.params.textDocument.uri, diagnostics: [ { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'ok', source: JSON.stringify({ config: configAnswer, folders: foldersAnswer }) } ] } });",
  "    }",
  "    return;",
  "  }",
  "  if (msg.method === 'textDocument/documentSymbol') {",
  "    // Ainda bloqueado (o cliente não respondeu) ⇒ o servidor NÃO responde.",
  "    if (!configAnswered) return;",
  "    send({ jsonrpc: '2.0', id: msg.id, result: [ { name: 'simbolo', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } } ] });",
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

const FAKE_CONFIG: LspServerConfig = {
  name: "FakePython",
  kind: "builtin",
  languages: ["py"],
  languageId: "python",
  spawn: { command: process.execPath, args: ["-e", FAKE_SERVER_SOURCE] },
  enabled: true,
};

/** Aguarda um valor devolvido pelo predicado (o servidor responde de forma assíncrona). */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
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

describe("LspManager — requests servidor→cliente (servidor real, stdio)", () => {
  it(
    "responde workspace/configuration ⇒ o servidor destrava e devolve os símbolos",
    async () => {
      const manager = new LspManager([FAKE_CONFIG]);
      const published: { readonly uri: string; readonly diagnostics: readonly Diagnostic[] }[] = [];
      manager.onDiagnostics((params) => published.push(params));

      manager.setWorkspaceFolders([{ uri: "file:///proj", name: "proj" }]);

      await manager.startServer(FAKE_CONFIG);
      try {
        // O servidor só publica diagnóstico **depois** de receber as duas respostas.
        manager.openDocument("file:///test.py", "python", "def f():\n    pass\n", 1);

        const received = await waitFor(() => published[0]);
        const payload = JSON.parse(received.diagnostics[0]?.source ?? "{}") as {
          config: unknown;
          folders: unknown;
        };

        // `workspace/configuration` ⇒ array com uma entrada por item pedido.
        expect(payload.config).toEqual([null]);
        // `workspace/workspaceFolders` ⇒ as pastas conhecidas pelo gerente.
        expect(payload.folders).toEqual([{ uri: "file:///proj", name: "proj" }]);

        // O servidor destravou ⇒ os símbolos voltam (antes: LSP_TIMEOUT de 15 s).
        const symbols = await manager.requestDocumentSymbols("file:///test.py");
        expect(symbols).toHaveLength(1);
        expect(symbols[0]?.name).toBe("simbolo");
      } finally {
        await manager.disconnectAll();
        manager.dispose();
      }
    },
    25000,
  );
});
