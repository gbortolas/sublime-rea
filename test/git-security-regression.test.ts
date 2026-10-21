/**
 * Scribe — regressão de segurança do painel de `git` e do `createFile` (achados do
 * `security`/`reviewer` sobre o lote que introduziu as primitivas de escrita/leitura).
 *
 * O renderer é **não confiável** (a Finding 1 do modelo de ameaça). Os 7 casos abaixo
 * travam a política de confinamento do `main`:
 *
 * 1. o `root` que vem do renderer **não** é fonte de verdade (fora da workspace ⇒ erro,
 *    e o repositório alheio fica **intacto**);
 * 2. o `git.diffText` **não** deriva a raiz do path ⇒ o conteúdo não commitado de outro
 *    repositório **não** vaza;
 * 3. o `createFile` **não** escapa por symlink (nada é criado fora);
 * 4. o `.git/config` local **não** executa script (`core.fsmonitor` / `commit.gpgsign`);
 * 5. o *pathspec magic* **não** stageia em massa;
 * 6. a mensagem de commit é **literal** (mesmo começando por `-`);
 * 7. `git.blame`/`git.diff` (já corrigidos) **continuam** funcionando.
 *
 * Os repositórios são **temporários** (`mkdtemp`) — nada do repo do usuário é tocado.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEditorCore } from "../src/core/editor";
import type { FileSystem } from "../src/core/buffer";
import { handleIpcRequest } from "../src/main/index";
import { IPC_VERSION } from "../src/shared";
import type { DocumentHandle, IpcResponse } from "../src/shared";
import { createTempGitRepo } from "./helpers/temp-git-repo";

/** FS em memória: o `git` lê o arquivo **do disco**, o conteúdo do buffer é irrelevante. */
function memoryFs(): FileSystem {
  return {
    readFile: (): Promise<string> => Promise.resolve("conteudo\n"),
    writeFile: async (): Promise<void> => undefined,
  };
}

async function invoke(
  core: ReturnType<typeof createEditorCore>,
  method: string,
  args: readonly unknown[],
  id: number,
): Promise<IpcResponse> {
  return handleIpcRequest(core, { v: IPC_VERSION, id, method, args });
}

/** Valor da resposta (`undefined` se a chamada falhou). */
function valueOf(response: IpcResponse): unknown {
  return response.ok ? response.value : undefined;
}

/** Código do erro da resposta ("" se a chamada deu certo). */
function errorCodeOf(response: IpcResponse): string {
  return response.ok ? "" : response.error.code;
}

/** Mensagem do erro da resposta ("" se a chamada deu certo). */
function errorMessageOf(response: IpcResponse): string {
  return response.ok ? "" : response.error.message;
}

/** Abre um documento (o `main` registra o path ⇒ ele vira uma raiz **conhecida**). */
async function openDocument(
  core: ReturnType<typeof createEditorCore>,
  path: string,
  id: number,
): Promise<DocumentHandle> {
  const opened = await invoke(core, "document.open", [path], id);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(`document.open falhou: ${opened.error.message}`);
  return opened.value as DocumentHandle;
}

/** Cria um script executável que grava um marcador (o "payload" do repo hostil). */
function writeMarkerScript(scriptPath: string, markerPath: string): void {
  writeFileSync(scriptPath, `#!/bin/sh\ntouch '${markerPath}'\nexit 0\n`, { mode: 0o755 });
}

describe("main — confinamento do `git` (o `root` do renderer não é fonte de verdade)", () => {
  it("git.status/stage/unstage/stageAll/commit com `root` fora da workspace são recusados", async () => {
    const workspace = createTempGitRepo("scribe-ws-");
    const alheio = createTempGitRepo("scribe-alheio-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      // O repo alheio tem **um commit** e um arquivo **não commitado** (o alvo do ataque).
      alheio.write("API_KEY=super-secret-value\n");
      alheio.git("add", "nota.txt");
      alheio.git("commit", "-qm", "init");
      alheio.write("API_KEY=super-secret-value\nalterado\n");

      // A workspace: um documento aberto ⇒ a raiz conhecida é a do repo da workspace.
      workspace.write("linha 1\n");
      workspace.git("add", "nota.txt");
      workspace.git("commit", "-qm", "init");
      await openDocument(core, workspace.file, 1);

      // O renderer comprometido aponta para o repo alheio.
      const status = await invoke(core, "git.status", [alheio.dir], 2);
      expect(status.ok).toBe(false);
      expect(errorCodeOf(status)).toBe("invalid-args");

      const stage = await invoke(core, "git.stage", ["nota.txt", alheio.dir], 3);
      expect(stage.ok).toBe(false);
      expect(errorCodeOf(stage)).toBe("invalid-args");

      const unstage = await invoke(core, "git.unstage", ["nota.txt", alheio.dir], 4);
      expect(unstage.ok).toBe(false);

      const stageAll = await invoke(core, "git.stageAll", [alheio.dir], 5);
      expect(stageAll.ok).toBe(false);

      const commit = await invoke(core, "git.commit", ["pwn", alheio.dir], 6);
      expect(commit.ok).toBe(false);
      expect(errorCodeOf(commit)).toBe("invalid-args");

      // **O repo alheio está intacto**: nenhum commit novo, nada staged, arquivo intacto.
      expect(alheio.git("rev-list", "--count", "HEAD").trim()).toBe("1");
      expect(alheio.git("diff", "--cached", "--name-only").trim()).toBe("");
      expect(alheio.git("status", "--porcelain")).toBe(" M nota.txt\n");
    } finally {
      core.dispose();
      rmSync(workspace.dir, { recursive: true, force: true });
      rmSync(alheio.dir, { recursive: true, force: true });
    }
  });

  it("o `root` **dentro** da workspace continua funcionando (o status do repo real)", async () => {
    const workspace = createTempGitRepo("scribe-ws-ok-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      workspace.write("linha 1\n");
      workspace.git("add", "nota.txt");
      workspace.git("commit", "-qm", "init");
      workspace.write("linha 1\nlinha 2\n");
      await openDocument(core, workspace.file, 1);

      const status = await invoke(core, "git.status", [workspace.dir], 2);
      expect(status.ok).toBe(true);
      const result = valueOf(status) as { branch: string | null; entries: ReadonlyArray<{ path: string }> };
      expect(result.entries.map((entry) => entry.path)).toContain("nota.txt");
    } finally {
      core.dispose();
      rmSync(workspace.dir, { recursive: true, force: true });
    }
  });

  it("`git.diffText` com path absoluto de outro repo é recusado (o segredo não vaza)", async () => {
    const workspace = createTempGitRepo("scribe-ws-diff-");
    const alheio = createTempGitRepo("scribe-alheio-diff-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      // O repo alheio tem um arquivo **não commitado** com um segredo.
      alheio.write("API_KEY=super-secret-value\n");
      alheio.git("add", "nota.txt");
      alheio.git("commit", "-qm", "init");
      alheio.write("API_KEY=super-secret-value\n");

      workspace.write("linha 1\n");
      workspace.git("add", "nota.txt");
      workspace.git("commit", "-qm", "init");
      await openDocument(core, workspace.file, 1);

      const diff = await invoke(core, "git.diffText", [alheio.file], 2);
      expect(diff.ok).toBe(false);
      expect(errorCodeOf(diff)).toBe("invalid-args");
      // O conteúdo secreto **não** aparece em lugar nenhum da resposta.
      expect(errorMessageOf(diff)).not.toContain("super-secret-value");
      expect(JSON.stringify(valueOf(diff) ?? "")).not.toContain("super-secret-value");
    } finally {
      core.dispose();
      rmSync(workspace.dir, { recursive: true, force: true });
      rmSync(alheio.dir, { recursive: true, force: true });
    }
  });
});

describe("main — o `createFile` não escapa por symlink", () => {
  it("um symlink dentro da raiz apontando para fora é recusado (nada é criado fora)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-ws-link-"));
    const fora = mkdtempSync(join(tmpdir(), "scribe-fora-"));
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const nota = join(root, "nota.txt");
      writeFileSync(nota, "x\n", { encoding: "utf8" });
      // O symlink: `ws/link` ⇒ `/tmp/fora` (o escape).
      symlinkSync(fora, join(root, "link"), "dir");
      // O documento aberto torna `root` uma raiz **conhecida**.
      await openDocument(core, nota, 1);

      const response = await invoke(core, "workspace.createFile", [join(root, "link", "evil.sh")], 2);
      expect(response.ok).toBe(false);
      expect(errorCodeOf(response)).toBe("invalid-args");
      // **Nada** foi criado fora (nem o diretório intermediário).
      expect(existsSync(join(fora, "evil.sh"))).toBe(false);
      expect(existsSync(join(fora, "link"))).toBe(false);
      // O symlink continua intacto (o `main` não apagou nada do usuário).
      expect(existsSync(join(root, "link"))).toBe(true);
    } finally {
      core.dispose();
      rmSync(root, { recursive: true, force: true });
      rmSync(fora, { recursive: true, force: true });
    }
  });

  it("um path **dentro** da raiz continua sendo criado (regressão)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-ws-ok-"));
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const nota = join(root, "nota.txt");
      writeFileSync(nota, "x\n", { encoding: "utf8" });
      await openDocument(core, nota, 1);

      const response = await invoke(core, "workspace.createFile", [join(root, "sub", "novo.txt")], 2);
      expect(response.ok).toBe(true);
      expect(existsSync(join(root, "sub", "novo.txt"))).toBe(true);
    } finally {
      core.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("main — o `.git/config` local do repo não executa script (RCE)", () => {
  it("o `core.fsmonitor=<script>` do repo NÃO é executado pelo `git.status`", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "scribe-fsm-"));
    const repo = createTempGitRepo("scribe-fsm-repo-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const marker = join(scratch, "PWNED_FSMONITOR");
      const script = join(scratch, "fsmonitor.sh");
      writeMarkerScript(script, marker);

      repo.write("linha 1\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      // O config hostil é instalado **depois** do setup (o setup também dispara o hook).
      repo.git("config", "core.fsmonitor", script);
      await openDocument(core, repo.file, 1);

      const status = await invoke(core, "git.status", [], 2);
      expect(status.ok).toBe(true);
      // **A asserção que trava a correção**: o script do `.git/config` NÃO rodou.
      expect(existsSync(marker)).toBe(false);
    } finally {
      core.dispose();
      rmSync(scratch, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("o `commit.gpgsign=true` + `gpg.program=<script>` do repo NÃO é executado pelo `git.commit`", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "scribe-gpg-"));
    const repo = createTempGitRepo("scribe-gpg-repo-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const marker = join(scratch, "PWNED_GPG");
      const script = join(scratch, "gpg.sh");
      writeMarkerScript(script, marker);

      repo.write("linha 1\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      // O config hostil (a assinatura) é instalado depois do setup.
      repo.git("config", "commit.gpgsign", "true");
      repo.git("config", "gpg.program", script);
      repo.write("linha 2\n");
      repo.git("add", "nota.txt");
      await openDocument(core, repo.file, 1);

      const commit = await invoke(core, "git.commit", ["mensagem"], 2);
      expect(commit.ok).toBe(true);
      const result = valueOf(commit) as { ok: boolean; error?: string };
      expect(result.ok).toBe(true);
      // **A asserção que trava a correção**: o "assinante" do `.git/config` NÃO rodou.
      expect(existsSync(marker)).toBe(false);
    } finally {
      core.dispose();
      rmSync(scratch, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe("main — o pathspec magic não stageia em massa", () => {
  it("`git.stage(':!x.ts')` e `git.stage(':/')` não stageiam o repositório inteiro", async () => {
    const repo = createTempGitRepo("scribe-magic-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      repo.write("a\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      writeFileSync(join(repo.dir, "nota.txt"), "a\nb\n", { encoding: "utf8" });
      writeFileSync(join(repo.dir, "outro.txt"), "c\n", { encoding: "utf8" });
      await openDocument(core, repo.file, 1);

      // A *magic* de pathspec (`:/` = tudo, `:!x` = tudo menos x) é **desativada**.
      const magic = await invoke(core, "git.stage", [":!nota.txt"], 2);
      expect(magic.ok).toBe(false);
      const tudo = await invoke(core, "git.stage", [":/"], 3);
      expect(tudo.ok).toBe(false);

      // Nada foi staged em massa.
      expect(repo.git("diff", "--cached", "--name-only").trim()).toBe("");

      // **Regressão**: o stage do arquivo pedido continua funcionando.
      const ok = await invoke(core, "git.stage", ["nota.txt"], 4);
      expect(ok.ok).toBe(true);
      expect(repo.git("diff", "--cached", "--name-only").trim()).toBe("nota.txt");
    } finally {
      core.dispose();
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe("main — a mensagem de commit é literal", () => {
  it("uma mensagem começando por `-` não vira opção e nada é executado", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "scribe-msg-"));
    const repo = createTempGitRepo("scribe-msg-repo-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      const marker = join(scratch, "PWNED_MSG");
      repo.write("linha 1\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      repo.write("linha 2\n");
      repo.git("add", "nota.txt");
      await openDocument(core, repo.file, 1);

      const mensagem = `-touch ${marker}`;
      const commit = await invoke(core, "git.commit", [mensagem], 2);
      expect(commit.ok).toBe(true);
      const result = valueOf(commit) as { ok: boolean; error?: string };
      expect(result.ok).toBe(true);
      // A mensagem é **literal** (o `-m` consome o argumento seguinte).
      expect(repo.git("log", "-1", "--format=%s").trim()).toBe(mensagem);
      // E nada foi executado.
      expect(existsSync(marker)).toBe(false);
    } finally {
      core.dispose();
      rmSync(scratch, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});

describe("main — regressão: `git.blame`/`git.diff` continuam funcionando", () => {
  it("blame e diff do documento aberto devolvem o resultado esperado", async () => {
    const repo = createTempGitRepo("scribe-reg-");
    const core = createEditorCore({ fileSystem: memoryFs(), availableParallelism: 4 });
    try {
      repo.write("linha 1\n");
      repo.git("add", "nota.txt");
      repo.git("commit", "-qm", "init");
      repo.write("linha 1\nlinha 2\n");
      const handle = await openDocument(core, repo.file, 1);

      const blame = await invoke(core, "git.blame", [handle, 0], 2);
      expect(blame.ok).toBe(true);
      const blameResult = valueOf(blame) as { commitHash: string; author: string } | null;
      expect(blameResult).not.toBeNull();
      expect(blameResult?.commitHash).toHaveLength(8);

      const diff = await invoke(core, "git.diff", [handle], 3);
      expect(diff.ok).toBe(true);
      const ranges = valueOf(diff) as ReadonlyArray<{ startLine: number; kind: string }>;
      expect(ranges.length).toBeGreaterThan(0);
      expect(ranges[0]?.startLine).toBe(1);
    } finally {
      core.dispose();
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
