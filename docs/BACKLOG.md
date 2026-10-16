# BACKLOG — sublime-rea

> Backlog vivo do projeto. Estado atual e handoff: [`HANDOFF.md`](HANDOFF.md).
> Contexto: clean-room RE do Sublime Text via REA → reimplementação em Electron/TS.

Legenda: **P0** = destrava a fase atual · **P1** = próximo · **P2** = depois · **P3** = housekeeping.

---

## ✅ P0 — Destravar a análise (CONCLUÍDO)

O "bloqueio" era **falso**: o deadline do Ghidra **é configurável** (`REA_GHIDRA_STARTUP_TIMEOUT_MS`,
máx 2^31−1). Fatos descobertos no `dist/` do `rea-agents@6.5.0` — detalhes e evidências em
[HANDOFF.md](HANDOFF.md):

- **`REA_GHIDRA_STARTUP_TIMEOUT_MS`** existe (`config/providerStartupTimeout.js:3`). **Era o fix.**
- **`REA_GHIDRA_SEED_FILE`** ≠ análise pré-existente: é um TSV de assertivas
  (`address<TAB>kind[<TAB>name]`, `kind ∈ function|code|label`). O REA **não** consome projeto/DB do
  Ghidra — ele sempre re-analisa (`-import -readOnly -deleteProject`).
- **`REA_GHIDRA_DISABLED_ANALYZERS`** aceita **nomes exatos** de analyzers do Ghidra
  (case-sensitive, sem glob), `,`-separados, ≤32; nome inválido = erro fatal.

- [x] **P0.0 — Validado ponta a ponta** ✅ — `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000` +
  `rea analyze --provider ghidra` no alvo: **`EXIT=0` em 5m54,8 s** (antes: `provider_timeout` a
  330 s). Cabeados no `setup/`: default `900000` (15 min) validado contra o schema do REA.
- [x] **P0.1 — `REA_GHIDRA_DISABLED_ANALYZERS`** — semântica esclarecida (nomes exatos de classes do
  Ghidra, `setAnalysisOption(nome,"false")`). Não é mais *plano A*; fica como knob de tuning.
- [x] **P0.2 — Pré-análise headless** — `bin/ghidra-preanalyze.sh` + projeto persistente
  (`$REA_TOOLS_DIR/ghidra-projects/sublime-rea`). **Rodou com sucesso**: 334 s de auto-análise,
  171 MB. Serve para medir o tempo e para reprocessar sem re-analisar.
- [x] **P0.3 — Rotas do REA que NÃO usam Ghidra** — é o **Track A**, entregue:
  `docs/analysis/api-python.md` + `docs/analysis/ipc-plugin-host.md`.
- [x] **P0.4 — Pivotar para Rizin/Cutter** — **descartado**: o caminho era maior que o payoff. O REA
  **não empacota** o binário `rizin` (só wrappers JS; faz `spawn("rizin")` do PATH) e não há nenhum
  instalado. Só valeria a pena se o Ghidra não tivesse destravado (ver P3.5).
- [x] **P0.5 — Estratégia escolhida e registrada** (Track A agora + Track B em background).

### ✅ P0.6 — Operacional (CONCLUÍDO)

- [x] **P0.6 — `setup.py` rodado + MCP `rea` com o deadline novo** ✅ (2026-10-16). O `setup.py`
  reescreveu `setup/env.sh` e o `environment` do MCP `rea`; o processo `rea mcp` foi relançado **já
  com `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000`** (confirmado em `/proc/*/environ`) — **não** foi
  preciso reiniciar o opencode manualmente.
  ```bash
  python3 setup/setup.py     # idempotente (escreve setup/env.sh + environment do MCP rea)
  ```

---

## 📐 P1 — Fase 1 (conteúdo da análise) — **em curso**

Dividir por pergunta (o skill recomenda decompor em escopos independentes, com ledger de Evidence
IDs). Cada item vira uma seção da spec técnica abstrata. **O binário está destravado** — P1.3
(opcodes/framing) e P1.4 (render) podem ser atacados direto.

- [x] **P1.1 — Estrutura de buffer** ✅ entregue: [`docs/analysis/buffer-structure.md`](analysis/buffer-structure.md).
      Achado: classe **`TextBuffer`** (facade, RTTI) delega a um objeto interno **anônimo** com
      **múltiplos buffers de heap + array de registros** → família **piece-table/segmentado
      [INFERIDO]**; **não** há Gap Buffer nem Rope nomeados. Edição por **comandos delta**
      (`insert`/`append`/`…_delete`); **undo por grupos** (com *glue* e *soft* undo/redo); linha por
      **scan com cache**. Ledger E1–E14.
- [x] **P1.2 — Modelo de concorrência** ✅ entregue: [`docs/analysis/concurrency.md`](analysis/concurrency.md).
      Achado: núcleo **GTK3/GLib single-main-thread** (`gtk_main` + `g_idle_add`/`g_source_add_unix_fd`)
      que delega a **threads POSIX próprias** (`pthread_create`, stack 2 MiB, nomeadas via
      `prctl(PR_SET_NAME)`); **pool de I/O de N threads** (`io_worker`, N = setting `io_workers`;
      **o tamanho N** é **[INFERIDO]**) e **pool on-demand limitado a 2** (`file_read_thread`);
      retorno ao main thread pelo **`px_main_thread_scheduler`** **[INFERIDO]**; o `plugin_host` é
      **processo**, não thread. Ledger E1–E21.
- [~] **P1.3 — Ponte IPC C++ ↔ Python**: **lado Python ✅** (`api-python.md`) · **lado IPC ✅**
      (`ipc-plugin-host.md`: shm POSIX + semáforos; canais `subl_send`/`subl_recv`/`subl_arecv`).
      **Falta:** mapear os opcodes de `handle_protocol_message` e o framing de
      `read_message`/`write_message` (precisa do núcleo → agora desbloqueado).
- [ ] **P1.4 — Pipeline de render**: indícios de GPU/OpenGL/Skia; virtualização de viewport.
      Hipótese "Qt" **já refutada** pelo P1.2 — toolkit confirmado **GTK3/GLib**, render provavelmente
      **Skia** via `libGL`/`libX11`.
- [ ] **P1.5 — Ledger de evidências**: tabela `conclusão → Evidence ID → tipo → limites`
      (consolidando os ledgers parciais já existentes em `docs/analysis/`).
- [x] **P1.6 — Modelo de empacotamento** ✅ entregue: [`docs/analysis/packaging.md`](analysis/packaging.md).
      Achado: namespace lógico **plano** — cada `<Nome>.sublime-package` é um **ZIP sem manifesto**
      exposto como `Packages/<Nome>/…`; a **extensão** define o papel; precedência **`User` >
      `Default`**; motor de sintaxe YAML (`contexts`/`patterns`). Ledger E1–E22.

---

## 📄 P2 — Fases 2 e 3 do projeto

- [ ] **P2.1 — Fase 2:** escrever `docs/architecture/*.md` sintetizando os padrões (design patterns)
      achados, **sem** copiar código do binário (princípio clean-room).
- [ ] **P2.2 — Fase 3:** scaffold `src/` Electron + TypeScript:
      - [ ] `PieceTable`/`Rope` em TS (zero-copy/minimal-copy)
      - [ ] Worker Threads para operações de buffer e parsing pesado
      - [ ] Renderização por Canvas 2D / WebGPU com scroll virtualizado
      - [ ] API de extensão tipada + protocolo IPC
- [ ] **P2.3 — Alinhar o nome do projeto:** `TECHNICAL_SPECIFICATION.md:4` chama de **"Arcane"**; a
      outra spec não nomeia. Decidir o nome antes de virar código.

---

## 🧹 P3 — Housekeeping / dívidas

- [~] **P3.1 — `bin/` versionado**: o `.deb` (redundante) **já foi removido e commitado**. Falta
      decidir o `.tar.xz` (22 MB, é a fonte do alvo): `git rm --cached` + download sob demanda com
      SHA pinado no `setup.py`, ou Git LFS.
- [ ] **P3.2 — Documentar em destaque** que o `rea` CLI exige `source setup/env.sh` em shells
      não-interativos (não há README na raiz).
- [ ] **P3.3 — `setup/setup.sh` (bash) legacy**: decidir entre remover ou congelar; está com 9
      etapas (desatualizado em relação ao `setup.py` de 10). Risco de divergência.
- [ ] **P3.4 — `main.py`**: boilerplate do PyCharm na raiz; remover ou repurpor.
- [ ] **P3.5 — Provisionar Rizin** (só se P0.4 voltar à mesa): o REA faz `spawn("rizin")` do PATH e
      não há nenhum instalado.
- [ ] **P3.6 — Snapshot de análise do REA**: baixa prioridade. O `snapshot_path=<*.json>` só faz
      *replay* de ferramentas em cache e exige análise completa; o projeto Ghidra persistente cobre
      melhor o caso.
- [ ] **P3.7 — `~/sr-tools` (symlink)**: o Ghidra recusa path com componente iniciado por `.`, então
      `bin/ghidra-preanalyze.sh` usa o symlink `~/sr-tools → $REA_TOOLS_DIR` (hoje criado
      idempotentemente pelo próprio script, com erro claro se o caminho já for um diretório real).
      Formalizar/documentar no `setup.py`.
- [x] **P3.8 — `.serena/` untracked**: cache do LSP Serena; adicionado ao `.gitignore`.
