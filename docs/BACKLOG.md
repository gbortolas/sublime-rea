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
IDs). Cada item vira uma seção da spec técnica abstrata. **Fase 1 FECHADA** — P1.5 entregue.
*(Fases 2 e 3 também já fechadas; o trabalho corrente é a **Fase 3.2 / P2.4** — ver §P2 abaixo.)*

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
- [x] **P2.4 — Fase 3.2: primeira fatia vertical end-to-end** ✅ **fechada** (2026-10-17) — as **5
      frentes** estão provadas ponta a ponta (abrir arquivo, cancelamento, undo/redo, realce de sintaxe
      e **busca/substituição** em lane de background):
      - [x] **Abrir arquivo real** sem `?file=` ✅ — arg de linha de comando + `dialog.showOpenDialog`
            (IPC `document.openDialog`); `Ctrl/Cmd+O` abre **pós-boot** também. (`04096ae`)
      - [x] **Fiar o cancelamento** ✅ — registro `signalId → AbortController` no `main`, `IpcCancel` no
            mesmo canal, abort vira erro tipado `cancelled` (sem stack); `Esc`/troca de arquivo aborta a
            abertura em voo. (`04096ae`)
      - [x] **Undo/redo visível** ✅ — `EditorCore.undoDocument`/`redoDocument`/`undoStateOf` + IPC
            `editor.undo|redo|undoState` + atalhos (`Ctrl/Cmd+Z`, `+Shift+Z`, `+Y`) e status bar.
            (`04096ae`)
      - [x] **Realce de sintaxe** ponta a ponta ✅ — `src/core/syntax/**` (YAML de subconjunto +
            gramática + tokenizer + theme + registry), `syntax.highlight` no IPC e coloração por escopo
            em `buildInstances`; fixture **nossa** `assets/grammars/scribe-demo.sublime-syntax`.
            Achados de revisão → **corrigidos** em **P2.4b** ✅. (`2a169be` + P2.4b)
      - [x] **Busca/substituição** na lane `background` ✅ — `TaskKind` novo `search` no `TaskPool` (lane
            `index`) disparado por `scheduler.post("background", …)` (**primeiro uso real** da lane de
            fundo), contrato novo `src/shared/search-contract.ts`, IPC `search.find`/`search.replaceAll` e
            **find bar** no renderer (`Ctrl/Cmd+F`). Detalhes, decisões e follow-ups em **P2.4c** (abaixo).

- [x] **P2.4b — Corrigir achados de revisão da Slice D** ✅ **fechado** (2026-10-17). Os **2 blockers +
      1 risco** do reviewer **foram corrigidos** (4 rodadas de `fixer` + re-revisões independentes que
      acharam e fecharam 1 bug **alto** adicional). Gates finais: `typecheck`/`lint`/`build` exit 0 e
      **348 testes / 40 arquivos** (baseline da Slice D: 319). O que foi feito:
      - **cache de destaque** — chave = `revision` + **identidade da gramática** (`editor-core.ts`);
            resposta vazia (pré-`syntaxReady`) **não** conta como cobertura.
      - **guarda de falha** — `blocked`/`failed` por revisão com **1 warn** (não 1 por frame), dedupe de
            requisição **em voo** e timeout do slot (10 s).
      - **tokenização** — teto por linha `MAX_TOKENIZE_LINE_LENGTH = 4096` com marcador explícito
            `text.unparsed.syntax-limit` (sem selector no tema ⇒ cor default, degradação visível);
            prefixo truncado **neutraliza** o estado (não propaga construto cortado).
      - **renderer** — `HighlightStore` chaveado por **documento + revisão** (invalida na troca; `revision`
            reinicia em 1 por documento — *bug alto* pego na re-revisão), teto de retentativas
            (4, backoff 250/500/1000 ms) e `highlight` **opcional** no `readBridge`.
      - **sintaxe** — `visiting` copiado por ramo (corte de ciclo preservado), escopo do **contexto do
            topo** no fallback, captura para grupo inexistente vira `warn` único, re-registro recomputa
            `byExtension` na ordem de registro, warn de teto por **instância** de gramática.
      - **ABERTO (residual declarado)** — o teto é **por linha**, não por documento: `highlightDocument`
            tokeniza do estado inicial até a linha visível **absoluta** (custo O(`end`)), então *deep
            scroll* + keystroke em documento grande re-tokeniza o prefixo inteiro a cada revisão, e regex
            catastrófica **dentro** do prefixo de 4096 code units segue um vetor de *freeze*
            (`src/core/editor/editor-core.ts`, `MAX_TOKENIZE_LINE_LENGTH` em `src/core/syntax/tokenizer.ts`).
            Correção de verdade = cap de `end` **ou** tokenização em worker com prazo (novo `TaskKind`).

- [x] **P2.4c — Busca/substituição na lane `background`** ✅ **fechado** (2026-10-17). Primeira fatia a
      exercitar o `TaskPool` e a lane `background` do `Scheduler` de verdade. Gates finais:
      `typecheck`/`lint`/`build` exit 0 e **423 testes / 43 arquivos** (baseline anterior: 348). Entregue:
      - **contrato** — `src/shared/search-contract.ts`: `SearchQuery`/`SearchMatch`/`SearchResult`,
        caps (`SEARCH_DEFAULT_MAX_MATCHES = 2000`, `SEARCH_MAX_MATCHES = 20000`,
        `SEARCH_MAX_PATTERN_LENGTH = 512`, `SEARCH_MAX_TEXT_LENGTH = 64 MiB`), `SearchInputError` com
        `code ∈ {search.pattern, search.tooLarge, search.tooManyMatches, search.emptyPattern}`,
        `normalizeSearchQuery` e `scanText` (varredura **linear**, `index/length/line/column` em
        **UTF-16**, `truncated`, matches de comprimento zero descartados). **Regex é opt-in**
        (`regex=false` ⇒ padrão literal escapado) — sem ReDoS por acidente.
      - **task** — `TaskKind: "search"` (`TaskResultMap`/`TaskSpecByKind`), lane padrão `index`; o texto
        chega ao worker pelo idioma existente `pool.registerText(handle, revision, text)`; geração
        obsoleta ⇒ `StaleGenerationError`; `TaskError` genérico preserva `name`/`code` até o IPC. Teto de
        texto checado **antes** de registrar/enviar (e de novo no worker, defesa em profundidade).
      - **serviço** — `EditorCore.searchDocument` (via `scheduler.post("background", () => pool.run(…))`)
        e `EditorCore.replaceAll`, que **recusa** resultado `truncated` (nada de substituição parcial
        silenciosa), aplica tudo num **único `EditScope`** (um Ctrl+Z desfaz o replace-all inteiro) com
        substituição **literal**, em ordem crescente com delta acumulado, e **coalesce** o fan-out de
        `document.changed` (1 evento por lote em vez de 1 por delta — sem isso, 2000 substituições
        geravam GB de IPC; insert/undo/redo seguem notificando a cada mudança).
      - **IPC + UI** — `search.find` / `search.replaceAll` no padrão de `syntax.highlight`; **find bar**
        (`Ctrl/Cmd+F`, `Enter`/`Shift+Enter` com wrap, `Esc` fecha antes do Esc de cancelar abertura,
        contador `atual/total`, replace-all) com `FindBarModel` puro (debounce injetado, descarte por
        documento+revisão+seq) + fiação DOM em `src/renderer/main.ts`.
      - **paridade do worker** — o `worker-entry.ts` **replica** a varredura (o `eval` do vitest não
        resolve `../../shared`); a equivalência é travada por teste de paridade contra o **worker real**
        (25 casos + 2 de erro) **verificado por mutação** (mutar `wholeWord`, o escape do literal ou o
        default de `maxMatches` no worker **quebra** a paridade). → **P3.10** elimina a duplicação.
      - **follow-ups declarados** — **P3.11** (pintar as ocorrências no canvas; hoje só move caret +
        scroll) · **P3.10** (bundlar o worker no build) · **P3.12** (assinatura
        `bridge.onDocumentChanged` do find bar não amarrada a `dispose`) · o guard de geração do pool é
        **por consistência** (a garantia de "resultado fresco" é do chamador comparar `revision`) — a doc
        foi corrigida para não prometer mais do que ele entrega.

- [x] **P2.5 — Salvar arquivo (`Ctrl/Cmd+S` + estado *dirty*)** ✅ **fechado** (2026-10-17) — fecha o item #1 do README
      ("abrir / editar / **salvar** — o mínimo inegociável"). Implementação ponta a ponta:
      - `document.save` + `document.isDirty` no IPC contract, main handler, preload bridge
      - `EditorCore.saveDocument(handle, signal?)` que materializa o texto (`buffer.text()`, O(n))
        e grava via `pool.run({kind:"writeFile", …}, {lane:"io"})` — **segundo** uso real de lane (`io`)
      - **Escrita atômica** no worker: tmp + rename (mkdtemp → writeFile tmp → rename) — não corrompe
        o arquivo em caso de falha
      - **Dirty tracking completo**: `runInsert`, `runHistory` (undo/redo), `replaceAll` e `openDocument`
        marcam/limpam `dirty` corretamente via `registry.setDirty`/`setSavedRevision`
      - **Guarda dirty**: `saveDocument` recusa gravar se `isDirty === false`
      - **savedRevision**: arquivos abertos do disco começam com `savedRevision = buffer.revision`,
        undo/redo comparam revisão atual com salva para recalcular dirty
      - **UI**: `#status-dirty` na status bar ("● modificado" laranja), atualizado via `onDocumentChanged`
      - **Atalho**: `Ctrl/Cmd+S` no listener de teclado do canvas
      - Gates: typecheck/lint/build exit 0 · **423 testes / 43 arquivos** (baseline 423)

---

## 🧹 P3 — Housekeeping / dívidas

- [x] **P3.10 — Bundlar o worker de `TaskPool` no build (matar a duplicação do scanner de busca)** ✅
      **fechado** (2026-10-17): a duplicata de `scanText`/`normalizeSearchQuery` no worker-entry.ts
      **morreu**. Agora o worker importa direto de `../../shared/search-contract` e o bundler
      (esbuild) resolve tudo numa saída CJS. Implementação:
      - `worker-entry.ts` — removeu 237 linhas de código duplicado (`LocalSearchInputError`,
        `escapeRegExpLocal`, `normalizeSearchQueryLocal`, `scanTextLocal`, `searchDocument`);
        `import { normalizeSearchQuery, scanText }` do shared; case `"search"` inline
      - `scripts/build.mjs` — etapa 3.5 adicionada: esbuild bundle do worker (CJS, node20,
        sem external) → `dist/core/concurrency/worker-entry.js` (9,5 kB)
      - `pool.ts` — fallback eval trocou `ts.transpileModule` por `esbuild.buildSync` com
        `bundle:true`, que resolve imports de verdade; `loadTypeScript()` removida
      - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)
      - Paridade worker↔shared mantida: 25 casos + 2 de erro no `pool.test.ts`
- [x] **P3.11 — Pintar as ocorrências da busca no canvas** ✅ **fechado** (2026-10-17): agora o
      canvas destaca visualmente as ocorrências (rects de fundo amarelo) e o match "atual" ganha cor
      magenta. Implementação:
      - **`SearchHighlight`** interface em `src/core/render/scene.ts` com `matches` + `currentIndex`
      - `buildInstances` recebe parâmetro opcional `searchHighlight?` e pinta `RectInstance` para cada
        match no range visível — posicionamento exato (incluindo tabs) calculado pelo mesmo walk do
        texto que o loop de glifos
      - `ScribeRenderer.setSearchMatches()` recebe os matches do find bar e repassa ao render loop
      - `FindBarModel` expõe `allMatches` (getter) e `currentMatchIndex` (getter) para o renderer
      - **Fiação completa**: `attachFindBar` empurra `SearchHighlight` pro renderer via `onChange`
        + `renderer.start()` — ao fechar a barra os destaques somem
      - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 423)
      - Decisões de design: overlay de rects em vez de modificar a cor de glifos (retrocompatível com
        sintaxe highlight); posicionamento exato (não aproximado por coluna) para lidar com tabs;
        cores exportadas para testes
- [x] **P3.12 — Ciclo de vida das assinaturas do renderer** ✅ **fechado** (2026-10-17): a
      assinatura `bridge.onDocumentChanged` fiada pelo find bar (`src/renderer/find-bar.ts`)
      agora é amarrada a `dispose()`:
      - `FindBarBinding` ganhou método `dispose()` que chama `model.dispose()` + o unsubscribe
        retornado por `onDocumentChanged`
      - `attachFindBar` guarda o unsubscribe e o invoca em `dispose()`
      - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P3.1 — `bin/` versionado** ✅ **resolvido** (2026-10-17) — o `.deb` (redundante) já tinha sido
      removido; o **`.tar.xz` do alvo (22 MB) saiu do git** (`git rm --cached`, arquivo preservado no
      disco) e o `setup.py` agora **baixa sob demanda** com **SHA-256 pinado** (`setup/versions.env`):
      download atômico (`.part` → valida → `os.replace`), **fail-closed** (hash divergente = erro fatal
      `code=4`, sem extrair e sem sobrescrever), e **sem rede** quando o arquivo já está presente com
      hash correto. `.gitignore` ganhou a entrada explícita (sem ignorar `bin/` inteiro — o
      `ghidra-preanalyze.sh` segue versionado); `setup/README.md` documenta rede/exit codes/troubleshooting.
      Evidência: URL oficial `HTTP 200` com `content-length: 22300732` e SHA `c153f418…43e88d9` batendo
      1:1 com o arquivo local; verificado nos 3 cenários (ausente, pin adulterado, offline).
- [x] **P3.2 — Documentar em destaque** que o `rea` CLI exige `source setup/env.sh` em shells
      não-interativos ✅ **resolvido**: o `README.md` da raiz existe (10 passos, do zero ao MVP) e
      cobre isso em três lugares (pré-requisitos, Passo 3 e pegadinhas).
- [x] **P3.3 — `setup/setup.sh` (bash) legacy** ✅ **resolvido** (2026-10-17) — **congelado com trava**: o
      script agora **recusa** rodar sem `SCRIBE_ALLOW_LEGACY_SETUP=1` (aviso em stderr explicando que o
      canônico é `python3 setup/setup.py` e que o legacy tem 9 etapas / não detecta `JAVA_HOME` ⇒
      `env.sh` sem o export ⇒ `rea doctor` = `healthy: false`), header marcado **DEPRECATED** e
      `setup/README.md` atualizado. Verificado: `bash setup/setup.sh` → **exit 2** + aviso ·
      `SCRIBE_ALLOW_LEGACY_SETUP=1 bash -n setup/setup.sh` → sintaxe ok · `--help` segue funcionando.
- [x] **P3.4 — `main.py`** ✅ **resolvido** (2026-10-17): boilerplate do PyCharm **removido**
      (`git rm main.py`); grep confirmou **zero** referências em código/setup/scripts (só o texto desta
      linha do BACKLOG e um `.idea/workspace.xml` gitignored).
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
