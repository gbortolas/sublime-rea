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
IDs). Cada item vira uma seção da spec técnica abstrata. **Fase 1 FECHADA** — P1.5 entregue; o
próximo trabalho é a **Fase 2** (P2.1).

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
- [x] **P1.3 — Ponte IPC C++ ↔ Python** ✅ entregue: **lado Python** em
      [`docs/analysis/api-python.md`](analysis/api-python.md) · **lado mecanismo** em
      [`docs/analysis/ipc-plugin-host.md`](analysis/ipc-plugin-host.md) (shm POSIX + semáforos;
      canais `subl_send`/`subl_recv`/`subl_arecv`) · **lado protocolo** em
      [`docs/analysis/ipc-protocol.md`](analysis/ipc-protocol.md). Achado: framing =
      `[uint32 LE len][payload]` (sem tipo/opcode), anel em shm de `0x80000` (header `0x80`,
      índices `u64` @`0x0`/`0x40`, capacidade constante `0x7ff80`), semáforos `<canal>:r`/`:w` e
      **dispatch 100% numérico** por tabela de saltos — enums **U** (host→núcleo, **281 ids**,
      Anexo A com o mapa completo `id → api_*`) e **V** (núcleo→host, **71 ids**); 3.3 e 3.14 falam
      o **mesmo** protocolo. Ledger E1–E36 (consolida os dois relatórios). **Direção dos canais
      revisada** (`subl_send` = entrada do host) — `[INFERIDO]`, confiança média.
- [x] **P1.4 — Pipeline de render** ✅ entregue:
      [`docs/analysis/render-pipeline.md`](analysis/render-pipeline.md). Achado: toolkit **GTK3/GLib**
      + contexto **`GdkGLContext`**; base abstrata **`px_render_context`** (**31 virtuais**) com dois
      backends — **`gl_render_context`** (OpenGL ≥ 4.1, **17 programas** nomeados, instâncias em
      **texture buffer `RGBA32F`**, `MAX_GLYPH_INSTANCES=8192`, 8× supersample) e
      **`skia_render_context`** (**Skia raster estático** sobre Cairo, o **default**: setting
      `hardware_acceleration="none"`). Texto moldado/rasterizado na **CPU** (Pango/FT/Cairo) →
      **atlas `RGBA8` 1024/4096**; viewport = **data source + observers** com **`glScissor` por
      região danificada**; render na **main thread**. Ledger E1–E27. **Hipótese "Qt" refutada** e
      hipótese "Skia" **confirmada**.
- [x] **P1.5 — Ledger de evidências** ✅ entregue:
      [`docs/analysis/evidence-index.md`](analysis/evidence-index.md). Achado: os 7 ledgers da Fase 1
      somam **179 linhas** (sem lacuna de numeração), reunidas num único namespace
      (`BUF-`/`CON-`/`PY-`/`HOST-`/`IPC-`/`REN-`/`PKG-`) com `conclusão → Evidence ID → tipo →
      limites`; o índice registra **duplicatas/supersessões** (HOST-E20/E9 revisados; HOST-E21–E26 →
      IPC-E1–E17/E22–E30) e **48 incógnitas** consolidadas. **Fase 1 fechada** → começa a **Fase 2**.
- [x] **P1.6 — Modelo de empacotamento** ✅ entregue: [`docs/analysis/packaging.md`](analysis/packaging.md).
      Achado: namespace lógico **plano** — cada `<Nome>.sublime-package` é um **ZIP sem manifesto**
      exposto como `Packages/<Nome>/…`; a **extensão** define o papel; precedência **`User` >
      `Default`**; motor de sintaxe YAML (`contexts`/`patterns`). Ledger E1–E22.

---

## 📄 P2 — Fases 2 e 3 do projeto

> **Fase 2 (P2.1) ✅ fechada** (2026-10-16) — spec abstrata em [`docs/architecture/`](architecture/)
> (6 docs + README, **61 decisões `DEC-*`**). **Fase 3 (P2.2) ✅ fechada** (2026-10-16) — o scaffold
> `src/` do **Scribe** está de pé, com as costuras congeladas em `src/shared/**` e os 6 módulos de
> `src/core/**` implementados e testados
> ([`docs/scaffold/P2.2-scaffold.md`](scaffold/P2.2-scaffold.md)). **Próximo:** **P2.4** (fatia
> vertical end-to-end).

- [x] **P2.1 — Fase 2** ✅ entregue: [`docs/architecture/`](architecture/) (README + `01`–`06`).
      Síntese clean-room dos padrões em **6 docs** com **61 decisões `DEC-*`** (BUF 10 · CON 12 ·
      IPC 12 · REN 8 · PKG 12 · TR 7), cada uma com racional + Evidence IDs e **tabela de
      rastreabilidade** `conclusão (Evidence) → DEC → status`; glossário canônico de componentes e
      mapa do alvo → Electron/TS. Cada doc marca as **divergências deliberadas** e as incógnitas
      (`U*`) que o afetam.
- [x] **P2.2 — Fase 3: scaffold `src/`** ✅ entregue (2026-10-16) — doc do entregável:
      [`docs/scaffold/P2.2-scaffold.md`](scaffold/P2.2-scaffold.md) · convenções e costuras:
      [`docs/scaffold/00-convencoes-e-costuras.md`](scaffold/00-convencoes-e-costuras.md).
      Os 6 módulos de `src/core/**` foram escritos **cada um contra o seu doc da Fase 2**, com as
      costuras congeladas em `src/shared/**` (resolvendo as divergências de contrato entre docs) e a
      costura final em `src/core/editor/**` + `src/main/**`/`src/preload/**`/`src/renderer/**`:
      - [x] **`PieceTable`/`Rope` em TS (minimal-copy)** ✅ — `src/core/buffer/piece-table.ts`
            (segmentado: `original` + buffer `add` + lista de spans; `flushChunk`; coalescing de spans
            adjacentes) + `line-index.ts` (índice de linhas incremental) + `delta.ts` (delta
            UTF-16 + **inversão** para undo) + `store.ts`/`buffer.ts`/`registry.ts` (handles com
            geração anti-ABA). **Undo por delta inverso** em `src/core/command/` (`undo-stack.ts`,
            grupos/glue, soft undo).
      - [x] **Worker Threads para buffer e parsing pesado** ✅ — `src/core/concurrency/`
            (`scheduler.ts` com lanes `input|edit|layout|background` e `Atomics.waitAsync`,
            `pool.ts` sobre `worker_threads` com lanes `io|index|fileRead` e teto
            `min(setting, cpus − 1)`, `worker-entry.ts`, `counters.ts`). O texto atravessa por
            `text.register` e o resultado carrega a **`generation`** (obsoleto é descartado).
      - [x] **Canvas 2D / WebGPU com scroll virtualizado** ✅ — `src/core/render/`
            (`pipeline.ts` com as invariantes de frame e os tetos 8192/128, `canvas2d-backend.ts`,
            `webgpu-backend.ts` + WGSL, `atlas.ts` RGBA8 1024/4096, `viewport.ts` com damage
            coalescido) e `src/renderer/main.ts` (IIFE, degrada para demo sem ponte). Default de
            fábrica continua **CPU/Canvas2D**.
      - [x] **API de extensão tipada + protocolo IPC** ✅ — `src/core/extension/`
            (`ops.ts` com tabela densa + `OPS_HASH`, `bridge.ts` com request/response por `id` e
            cancelamento, `host.ts` com `utilityProcess` + handshake/FSM, `api-facade.ts`),
            `src/shared/extension-contract.ts` e `src/shared/ipc-contract.ts` (contrato
            main ↔ renderer **versionado**, `IPC_VERSION`).
- [x] **P2.3 — Nome do projeto** ✅ **decidido: `Scribe`** (2026-10-16). O editor-alvo chama-se
      **Scribe**; aplicado em `TECHNICAL_SPECIFICATION.md` ("Scribe / High-Performance Electron Text
      Editor Core"), em [`docs/architecture/`](architecture/) e no `README.md`. O repositório segue
      **`sublime-rea`** (nome do repo, não do produto).
- [ ] **P2.4 — Fase 3.2: primeira fatia vertical end-to-end** ← **próximo**. O scaffold está de pé e
      o smoke do `electron .` sobe (main loga `Scribe: MainThreadBusy`); falta o app **fazer** algo
      útil de ponta a ponta:
      - [ ] **Abrir arquivo real** sem `?file=`: argumento de linha de comando + `dialog` (hoje o
            renderer só recebe documento com `?file=` no contrato mínimo)
      - [ ] **Fiar o cancelamento**: o contrato já modela `AbortSignal`/`IpcCancel` mas nenhuma
            operação longa usa (nada a cancelar ainda)
      - [ ] **Realce de sintaxe** ponta a ponta: `PackageResolver` → gramática → tokens → `RenderPipeline`
            (o scaffold tem o consumidor de tokens, não o produtor)
      - [ ] **Undo/redo visível** (teclas + status bar) sobre o `UndoStack` já testado
      - [ ] **Busca/substituição** na lane `background` (primeiro uso real de lane não-`input`)

---

## 🧹 P3 — Housekeeping / dívidas

- [~] **P3.1 — `bin/` versionado**: o `.deb` (redundante) **já foi removido e commitado**. Falta
      decidir o `.tar.xz` (22 MB, é a fonte do alvo): `git rm --cached` + download sob demanda com
      SHA pinado no `setup.py`, ou Git LFS.
- [x] **P3.2 — Documentar em destaque** que o `rea` CLI exige `source setup/env.sh` em shells
      não-interativos ✅ **resolvido**: o `README.md` da raiz existe (10 passos, do zero ao MVP) e
      cobre isso em três lugares (pré-requisitos, Passo 3 e pegadinhas).
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
- [x] **P3.9 — `JAVA_HOME` no `setup/env.sh`** (2026-10-16): resolvido pela opção **(a)** — o
      `setup.py` detecta um JDK ≥ 21 compatível (`JAVA_HOME`, PATH, sdkman, `/usr/lib/jvm`) e escreve
      um **`export JAVA_HOME=…` ativo** no `env.sh` gerado; se só existir JDK < mínimo, gera o
      `export` comentado com o caminho detectado. Bônus: também propaga para
      `mcp.servers.rea.environment`. Verificado: `python3 setup/setup.py` **sem** `JAVA_HOME` no
      ambiente → etapa 10 `rea doctor` = **`healthy: true`**.
