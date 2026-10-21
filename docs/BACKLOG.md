# BACKLOG — sublime-rea

> Backlog vivo do projeto. Estado atual e handoff: [`HANDOFF.md`](HANDOFF.md).
> Contexto: clean-room RE do Sublime Text via REA → reimplementação em Electron/TS.

Legenda: **P0** = destrava a fase atual · **P1** = próximo · **P2** = depois · **P3** = housekeeping.

---

## ✅ P0 — Destravar a análise (CONCLUÍDO) — Rizin também ✅

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
      - ~~**ABERTO (residual declarado)** — o teto é **por linha**, não por documento: `highlightDocument`
            tokeniza do estado inicial até a linha visível **absoluta** (custo O(`end`)), então *deep
            scroll* + keystroke em documento grande re-tokeniza o prefixo inteiro a cada revisão, e regex
            catastrófica **dentro** do prefixo de 4096 code units segue um vetor de *freeze*
            (`src/core/editor/editor-core.ts`, `MAX_TOKENIZE_LINE_LENGTH` em `src/core/syntax/tokenizer.ts`).
            Correção de verdade = cap de `end` **ou** tokenização em worker com prazo (novo `TaskKind`).~~ ✅
            **RESOLVIDO em 2026-10-18**: tokenização em worker com deadline (`TaskKind: "syntax"`,
            `SerializedGrammar`, `SYNC_SYNTAX_THRESHOLD=50`, deadline via `Atomics` a cada 50 linhas).

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

### 🎯 P1 da ROADMAP — Seleção de texto (P1#1)

- [x] **P1#1 — Seleção de texto** ✅ **fechado** (2026-10-17). Nova feature: estado de seleção (anchor + active), highlight visual no canvas (rects azuis), operações com seleção (delete/substituir ao digitar), navegação com setas (com/sem Shift para estender/colapsar), clique e drag do mouse, Shift+click. Implementação:
  - **shared** — `src/shared/selection-contract.ts`: tipo `Selection` + `SelectionOps.collapsed/isCollapsed/normalized`; `DocumentUndoState` ganha `selection`
  - **core** — `src/core/editor/editor-core.ts`: `CoreState.selection`, `UndoTarget.selection/setSelection`, `runInsert` substitui seleção não-colapsada, `undoStateOf` expõe selection
  - **undo** — `src/core/command/undo-stack.ts`: guarda/restaura `selectionBefore/selectionAfter` em cada step
  - **scene** — `src/core/render/scene.ts`: `buildInstances` aceita `selection` e pinta rects `SELECTION_COLOR` (0x264f78) entre anchor e active; `LineSource.positionAt` adicionado
  - **renderer** — `src/renderer/main.ts`: `DocumentSession.selection`, eventos mouse (click/drag/Shift+click), setas com/sem Shift, Backspace/Delete com seleção (insere vazio no start = deleta), `ScribeRenderer.setSelection` → `buildInstances`
  - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P1#2 — Gutter com números de linha** ✅ **fechado** (2026-10-17). Faixa à esquerda do canvas com números de linha (1-based, direita-alinhados), fundo do gutter separado (#2b2d30), linha atual destacada, separador vertical, largura dinâmica pelo número de dígitos. Implementação:
  - **scene** — `LineLayout.gutterWidth/gutterBackground/gutterColor`; `buildInstances` pinta fundo do gutter, números (glyphs) por linha visível, highlight da linha atual e separador vertical
  - **renderer** — `renderOnce` computa `gutterWidth = dígitos * 9 + 16`, ajusta `paddingLeft` dinamicamente; `COLORS.gutterFg` (#6e6e6e)
  - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P1#3 — Scrollbar proporcional** ✅ **fechado** (2026-10-17). Barra de rolagem vertical à direita do canvas, thumb proporcional ao documento, click no track para navegar. Implementação:
  - **scene** — `LineLayout.scrollbarWidth/scrollbarTrack/scrollbarThumb`; `buildInstances` pinta track + thumb proporcional (altura = viewportH × (viewportH / totalPx))
  - **renderer** — `renderOnce` passa scrollbar (width=10px), `lightenColor()` helper; mousedown no track scrolla para a posição proporcional
  - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P1#4 — Find & Replace UI visual** ✅ **fechado** (2026-10-17). Botões de toggle: case-sensitive (Aa), regex (.*), whole word (\b). Implementação:
  - **find-bar** — `FindBarState.caseSensitive/regex/wholeWord`; `FindBarModel` com toggles + getters + `query()` propaga flags; `close()` reseta estado
  - **index.html+CSS** — botões `.find-toggle` com `.active` state, CSS hover/active
  - **renderer** — `attachFindBar` fia click listeners e atalhos `Ctrl+Alt+C/R/W`
  - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P2#7 — Drag & drop de arquivo** ✅ **fechado** (2026-10-17). Arrastar arquivo do SO sobre o canvas abre ele (`dragover` + `drop` usando `File.path` do Electron).
- Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P2#6 — Abas/múltiplos documentos** ✅ **fechado** (2026-10-17). Tabs no topo do canvas, troca de documento ativo, fechar (click + middle-click), dirty state por tab, Ctrl+Tab/Ctrl+Shift+Tab pra navegar. Implementação:
  - **index.html+CSS** — `<div id="tab-bar">` + estilos completos (32px, scroll, hover/active/close)
  - **main.ts** — `DocumentController` refatorado: `sessions: TabSession[]`, `activate()`, `close()`, `renderTabBar()` (DOM), dirty tracking por sessão, `resize()` desconta 32px, Ctrl+Tab navigation
  - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P2#8 — Temas (cores configuráveis)** ✅ **fechado** (2026-10-17). Troca entre tema escuro (Scribe Dark) e claro (Scribe Light) por clique na status bar ou Ctrl+Shift+T, persistido em sessionStorage. Implementação:
  - **shared** — `theme-contract.ts` (interface `EditorTheme` com paleta completa) + `themes.ts` (DARK_THEME + LIGHT_THEME + BUILTIN_THEMES)
  - **scene** — `LineLayout.searchMatchColor/searchCurrentColor/selectionColor` em vez de constantes globais
  - **renderer** — `loadTheme/saveTheme` com sessionStorage; `THEME.current` substitui `COLORS`; `rgbToCss()` para body; toggle por click/Ctrl+Shift+T
  - **index.html+CSS** — botão `#status-theme` (🌙/☀️) com estilo `.clickable`
  - Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P3#12 — Go to line** ✅ **fechado** (2026-10-17). Ctrl+G → prompt → navega caret e scroll para a linha digitada.
- Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P3#13 — Auto-pair** ✅ **fechado** (2026-10-17). Auto-fechamento de `()`, `[]`, `{}`, `""`, `''`, `` `` ``; skip de fechamento existente; backspace inteligente deleta par vazio.
- Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **P3#14 — Bracket matching** ✅ **fechado** (2026-10-17). Quando cursor está num bracket, destaca o par correspondente com underline amarelo no canvas. Scan bidirecional com contagem de profundidade.
- Gates: typecheck/lint/build exit 0 · **430 testes / 43 arquivos** (baseline 430)

- [x] **Infra — GitHub repo + CI/Release** ✅ **fechado** (2026-10-17). Repositório `gbortolas/sublime-rea` criado e público; workflows CI (typecheck+test+build) e Release (Linux AppImage + Windows nsis); electron-builder configurado; ícone placeholder 256x256.

- [x] **Infra — PyCharm run configurations** ✅ **fechado** (2026-10-17). 6 Node.js run configs em `.idea/runConfigurations/`: typecheck, test, build, start, dist, lint.

## 🐛 UX — Issues reportadas (v0.3.1)

Problemas identificados ao testar o AppImage pela primeira vez:

- [x] **P0 — Demo text pouco convidativo**: substituído por **welcome screen** com logo Scribe, atalhos (Ctrl+O, Ctrl+N, Ctrl+S, Ctrl+F, Ctrl+Shift+T) e hint de drag & drop. ✅ (2026-10-17)
- [x] **P0 — Sem menu bar**: adicionado menu nativo do Electron em `src/main/index.ts` com File (Open/Save/Quit), Edit (Undo/Redo/Cut/Copy/Paste/Select All), Selection (Select All), Find (Find/Next/Previous), View (Toggle Theme). Ações enviadas ao renderer via IPC `scribe:menu:action`. ✅ (2026-10-17)
- [x] **P0 — Aparência "Sublime" genérica**: janela titulada "Scribe" com `show: false` → `ready-to-show`; ícone SVG+PNG em `build/icon.svg`/`build/icon.png` (logo "S" azul); `electron-builder.yml` configurado para Linux/Windows/macOS. ✅ (2026-10-17)
- [x] **P1 — Performance dos menus lentos**: menus nativos do Electron com muitos itens podem estar causando lentidão. Investigar e simplificar.
  ✅ **Fechado (2026-10-17)**: A "lentidão" era UX falsa: 3 ações (Cut/Copy/Paste) eram **no-ops** — clicar e nada acontecer. E o menu **Selection** (só Select All) duplicava o Edit. Fix:
  - Removeu menu Selection (redundante)
  - Implementou Cut/Copy/Paste via `navigator.clipboard` (antes eram `break` vazio)
  - Menu passou de 5 para 4 seções: File, Edit, Find, View
  - Gates: typecheck/test/build passam (449 testes, 44 arquivos)
  - Commit: `5392724`
- [x] **P1 — Sem indicação de como abrir arquivo**: welcome screen exibe atalhos (Ctrl+O, Ctrl+N) e hint "Arraste um arquivo para abrir". Status bar mostra "Nenhum arquivo aberto". ✅ (2026-10-17)

## 🎨 UX — Repaginação do design (2026-10-17, pedido do usuário)

> Pedido: *"o app tá meio capenga, temos que trabalhar o design, deixar mais elegante e moderno"*.
> Direção escolhida pelo usuário: **moderno tipo VS Code** (activity bar, breadcrumbs, densidade, ícones de linha).

- [x] **Casca VS Code-like** ✅ — grid `#workbench` = [rail de atividades | painel lateral | área do
      editor] + status bar; **breadcrumbs** com o último segmento destacado; find bar em **duas linhas**
      (Buscar/Substituir); **ícones SVG inline** (herdam `currentColor`, acompanham o tema sem JS);
      abas com close + estado `dirty`; undo/redo da status bar viraram **botões reais** (antes eram
      enfeite sem handler); rail só com o que existe de fato (Explorer `Ctrl+B`, Search, Palette, tema).
      Painel colapsado devolve a largura ao editor (`grid-template-columns: … auto minmax(0,1fr)`).
- [x] **Tema como fonte única** ✅ — `EditorTheme` (já dono das "cores da UI") virou a **fonte única** e é
      espelhado em CSS custom properties `--s-*` por `applyChromeTheme()`; estados (hover/pressed/muted/
      selecionado/ring) derivados com `color-mix(in srgb, var(--s-fg) N%, transparent)` — sem token por
      combinação; paletas Dark/Light Modern (casca `#18191b`/`#f8f8f8`, accent `#3794ff`/`#005fb8`);
      **minimap** passou a receber as cores do tema; `loadTheme` persiste só `{name,kind}` e reidrata o
      builtin (paleta velha não congela no `sessionStorage`); tema de **sintaxe** claro próprio
      (`createLightTheme`), senão o par escuro (cores claras) sumiria sobre fundo branco.
- [x] **3 bugs reais achados/corrigidos no caminho** ✅ — detalhados em **HANDOFF §Fase 3.4**:
      (1) `Canvas2DBackend` **nunca tingia** os glifos (atlas é tinta branca; só `globalAlpha` era
      aplicado) ⇒ coloração de sintaxe nunca aparecia no backend **default** e o tema claro ficava com
      texto invisível; (2) o realce era pedido com a `source` **do boot** (revisão 0) em vez da sessão
      ativa (revisão 1) ⇒ toda resposta descartada e re-pedida para sempre; (3) `packageRoots` apontava
      para `assets/grammars`, que o scanner **ignora** (raiz = contentor de pacotes) ⇒ gramática de
      brinde nunca registrada e `syntax.highlight` sempre sem spans.
- [x] **Verificação** ✅ — `typecheck`/`lint`/`build` exit 0 · **449 testes / 44 arquivos** (baseline
      443; +6 novos: `usedHeight`, 4 de tingimento no `canvas2d`, 1 de regressão de raiz de pacote) ·
      validação visual por **CDP** (`Page.captureScreenshot`, sem window manager): layout exato
      (rail 48 / painel 240 / status h22), colapso do painel devolvendo `x48 w976`, troca de tema
      (casca + canvas + minimap juntos) e **cores de sintaxe** confirmadas por histograma
      (`#926C95` keyword, `#94715F` string, `#99B9D0` variável, `#008000`/`#6a9955` comentário).

## 🧹 P3 — Housekeeping / dívidas

- [x] **P3#10 — Plugin host** (extensão isolada via `utilityProcess`) ✅ **fechado** (2026-10-17). A infra `ExtensionHostImpl` + `createMethodHandlers` + bridge existiam em `src/core/extension/` mas **nunca rodaram com uma extensão real**. Agora:
  - **`plugin-host-entry.ts`** — entry bundlado do `utilityProcess`: recebe bootstrap (port transfer), cria bridge do lado host, faz handshake com `ready`/`opsHash`, mantém o processo vivo
  - **`EditorCore.startPluginHost(entry, opts)`** — cria `ExtensionHostImpl` sob demanda, spawna o processo com `createMethodHandlers`, gerencia sessão (tracking + cleanup)
  - **`forwardChangedToHosts`** — a cada `document.changed`, envia `emit { kind: "emit", event: "changed", payload: {handle, delta} }` para todas as sessões `ready`
  - **`startMainProcess`** — no boot, spawna `dist/core/extension/plugin-host-entry.js` com nome `scribe-plugin-host`
  - **Build** — etapa 3.6: esbuild CJS do entry (18.4 kB)
  - **3 testes** de integração: handshake com fake process, bridge `emit` core→host, forwarding de `changed`
  - Gates: typecheck/test/build passam (452 testes, 45 arquivos)
  - Commit: `d079b1f`

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
- [x] **P3.5 — Provisionar Rizin** ✅ **fechado** (2026-10-18). Rizin v0.9.1 instalado como
      provider de análise nativa do REA:
      - **Static binary** (~137 MB) baixado de `github.com/rizinorg/rizin/releases/tag/v0.9.1`,
        SHA-256 pinado em `setup/versions.env`
      - Extraído em `$REA_TOOLS_DIR/rizin-v0.9.1/`, `REA_RIZIN_COMMAND` aponta para
        `bin/rizin` no diretório de instalação
      - **`setup.py`** — nova **etapa 7/12** (`step_rizin`) com download atômico, validação SHA-256,
        extração via `tar -xJf` e permissões de execução
      - **`env.sh`** — exporta `REA_RIZIN_COMMAND` (provider nativo Rizin)
      - **MCP** — `REA_RIZIN_COMMAND` propagado para `mcp.servers.rea.environment` no
        `opencode.jsonc`
      - **Verificado:** `rea execute-rizin-command` → `exit_code: 0`, `completion_status: complete`,
        provider `rizin` analisando o binário alvo (`iI` revela arch, bits, bintype, relro, nx, pie)
      - **Setup roda em 12 etapas** (sem quebras; dry-run e execução real validados)
- [x] **P3.5b — Análise via Rizin** ✅ **fechado** (2026-10-18). Primeira análise real do binário
      via Rizin, confirmando independentemente os achados da Fase 1 (Ghidra):
      - **13.312 funções** catalogadas com `aac` (Rizin v0.9.1, binário stripped)
      - **76.042 strings** extraídas com `izz`
      - **Shaders GLSL reais** extraídos do `.rodata`: vertex shader (959 B, `0xcf8a5`) com
        suporte a `TEXTURED`/`ROUNDED`/`BORDERED`/`REPEAT` e fragment shader sólido (82 B, `0xcfc64`)
      - **433 imports** confirmados: GTK+GLib (50+), OpenGL (60+), pthreads (30+), POSIX IPC,
        X11, jemalloc, Skia estática
      - **17 evidências RZ-E1–E17** documentadas em `docs/analysis/rizin-analysis.md`
      - Pipeline de render (P1.4), concorrência (P1.2), IPC (P1.3), empacotamento (P1.6) —
        **todos confirmados**
- [x] **⚡ P2.4b — Tokenização em worker com deadline** ✅ **fechado** (2026-10-18). A dívida declarada
      do O(end) da tokenização de sintaxe foi resolvida:
      - `TaskKind: "syntax"` adicionado ao `TaskPool`
      - `SerializedGrammar` — gramática compilada convertida para formato serializável
        (patterns com `{ match: string, matchFlags: string }` em vez de RegExp)
      - `tokenizeSyntaxTask()` no worker — importa `tokenizeCompiledLine` direto,
        deadline via `Atomics.load()` a cada 50 linhas, retorna `truncated` se estourou
      - `extendHighlightCacheSmart()` — delega pro pool se `needLines > SYNC_SYNTAX_THRESHOLD(50)`,
        continua síncrono para pedidos pequenos (evita overhead de IPC)
      - `highlightDocument()` agora é async
      - 5 testes de paridade sync vs worker no `pool.test.ts`
      - Gates: typecheck/test/build exit 0 · **543 testes / 50 arquivos** (baseline 520)
- [x] **🎯 Minimap Avançado** ✅ **fechado** (2026-10-18). Três melhorias no minimap:
      - **Syntax colorida no canvas**: cada linha do minimap agora exibe barras com as cores
        reais de syntax highlighting, dividindo a barra horizontal em segmentos proporcionais
        aos spans de cada escopo (`minimap.ts` paint() + HighlightStore.spansFor)
      - **Search match markers**: marcadores na borda direita do minimap indicando a posição
        dos resultados de busca (match atual em amarelo, demais em semi-transparente)
      - **Diagnostic markers**: marcadores na borda direita (à esquerda dos de busca) com
        cores por severidade (error=vermelho, warning=laranja, info=azul)
      - Todos os novos campos são **opcionais** (retrocompatível)
      - Gates: `typecheck`/`test`/`build` exit 0 · **520 testes / 50 arquivos** (mesmo baseline)
- [x] **P3.6 — Snapshot de análise do REA** ✅ **fechado** (2026-10-18). Snapshot gerado com o REA
      (provider ghidra) após análise `binary_overview` + `inspect_binary_layout` + `list_strings` +
      `list_procedures`. O snapshot contém:
      - **3 evidence records** (layout, overview, strings) + **1 workflow entry** (combined)
      - **8.87 MB** em `docs/analysis/snapshot.json`
      - Pode ser carregado em sessões futuras com `rea open-binary --snapshot-path
        docs/analysis/snapshot.json` para reuso de evidências sem re-analisar
      - **OBS**: o Ghidra sempre re-analisa o binário (a análise é ~355s), mas as ferramentas MCP
        (layout, strings, overview) são servidas do cache do snapshot
- [x] **Input latency — Fase A (resultado rico do `document.insert`)** ✅ **fechado** (2026-10-18).
      Cada caractere digitado fazia **3 IPC roundtrips** (insert + text + undoState). Agora o
      `document.insert` devolve `{revision, text, canUndo, canRedo}` de uma vez — **1 roundtrip
      apenas** (redução de 66%). Elimina as chamadas de `bridge.text()` e `refreshUndoStatus()`
      após cada tecla, e pula o `document.changed` redundante. **520 testes / 50 arquivos**.
- [x] **Input latency — Fase B (batching de teclas)** ✅ **fechado** (2026-10-18).
      Keystrokes são aplicados localmente via splice de string (latência zero) e acumulados num
      buffer. No próximo `requestAnimationFrame`, o lote é enviado ao main via `document.batchInsert`
      como transação única (1 revisão, 1 `document.changed`). Flush automático antes de operações
      que precisam de estado consistente (replaceText, undo/redo, save, open, close, activate,
      snippet). **520 testes / 50 arquivos** (mesmo baseline).
- [x] **P2#9b — Minimap Hover Preview** ✅ **fechado** (2026-10-18). Tooltip com código real
      e syntax highlighting ao passar o mouse no minimap. Usa `bridge.highlight()` para obter
      spans, `syntaxTheme.styleFor()` para resolver cores, renderiza como `<span style="color:">`
      em tooltip DOM. Debounce de 100ms, cache do último range. Fallback para texto puro enquanto
      a requisição não chega. **520 testes / 50 arquivos**.
- [x] **P3.7 — `~/sr-tools` (symlink)** ✅ **fechado** (2026-10-17): o symlink `~/sr-tools → $REA_TOOLS_DIR`
      agora é criado/manutenido pelo `setup.py` (não só pelo `ghidra-preanalyze.sh`). O Ghidra
      recusa path com `.`, e `$REA_TOOLS_DIR` vive em `~/.local/…` — o symlink contorna isso.
      Implementação:
      - Nova função `step_symlink` (etapa 7/11): cria/atualiza o symlink com tratamento para 3
        cenários (já é symlink → re-aponta; existe como dir/file real → erro claro; não existe →
        cria)
      - `Ctx.rea_tools_alias` em `Ctx.__init__` (lê `REA_TOOLS_ALIAS` do env ou default
        `~/sr-tools`)
      - `env.sh` exporta `REA_TOOLS_ALIAS` (consumido por `ghidra-preanalyze.sh`)
      - `os.environ["REA_TOOLS_ALIAS"]` setado em `step_env` para propagação ao doctor
      - Pipeline renumerada de 10→11 etapas
      - Gates: typecheck/lint/test passam · dry-run exibe etapa 7/11 corretamente
- [x] **P3.8 — `.serena/` untracked**: cache do LSP Serena; adicionado ao `.gitignore`.
- [x] **P3.9 — `JAVA_HOME` no `setup/env.sh`** (2026-10-16): resolvido pela opção **(a)** — o
      `setup.py` detecta um JDK ≥ 21 compatível (`JAVA_HOME`, PATH, sdkman, `/usr/lib/jvm`) e escreve
      um **`export JAVA_HOME=…` ativo** no `env.sh` gerado; se só existir JDK < mínimo, gera o
      `export` comentado com o caminho detectado. Bônus: também propaga para
      `mcp.servers.rea.environment`. Verificado: `python3 setup/setup.py` **sem** `JAVA_HOME` no
      ambiente → etapa 10 `rea doctor` = **`healthy: true`**.

---

## 🧩 P4 — Language features (próximo roadmap)

> Features de linguagem baseadas em LSP. Com P4#16 fechado, o pipeline LSP está completo
> (transporte + cliente + manager + fiação + UI). Os itens abaixo expandem o que já existe.

- [x] **P4#16 — LSP Client** ✅ **fechado** (2026-10-18). Conexão a servidores LSP para
      TypeScript e Python com diagnóstico, completação e hover. Entregue:
      - `src/core/lsp/` — protocolo, transporte stdio, cliente JSON-RPC, manager
      - `src/shared/lsp-contract.ts` — contratos de fronteira + servidores builtin
      - Fiação completa: main (startup), preload (bridge), renderer (UI + squiggly)
      - **519 testes / 50 arquivos** (baseline 449; +70: 4 testes LSP com 55 + 15 integração)
      - **Limitações conhecidas**: servidores precisam estar no `$PATH`; full document sync;
        sem signatureHelp / documentSymbol / references / definition / codeAction
- [x] **P4#17 — Diagnósticos no gutter** ✅ **fechado** (2026-10-18). Ícones de severidade
      no gutter (faixa de números de linha) para diagnósticos LSP:
      - **Error** — círculo vermelho com X
      - **Warning** — triângulo âmbar com !
      - **Info** — círculo azul com "i"
      - **Hint** — bolinha cinza
      - Agrupa por linha (mostra o ícone da maior severidade)
      - Implementado como extensão de `renderDiagnostics()` — mesmo overlay Canvas 2D
        que desenha os squiggly underlines
      - Gates: typecheck/lint/test/build exit 0 · 519 testes / 50 arquivos (mesmo baseline)
- [x] **P4#18 — Ir para definição** ✅ **fechado** (2026-10-18). Navegação para definição via
      `textDocument/definition` do LSP:
      - **F12** ou **Ctrl+click** — navega caret e scrola para a definição (mesmo arquivo)
      - Cross-file: expansão futura (abrir o arquivo alvo)
- [x] **P4#19 — Signature help** ✅ **fechado** (2026-10-18). Popup de assinatura de função
      ao digitar `(`:
      - Tipos no protocolo (SignatureHelpParams, SignatureInformation, ParameterInformation)
      - Tipos no contrato compartilhado (LspSignatureHelp, LspSignatureInfo, LspParameterInfo)
      - `src/renderer/signature-help.ts` — popup DOM com label, documentação, parâmetros
      - Parâmetro ativo destacado (cor do accent), contador de assinaturas
      - Trigger automático ao digitar `(` (posicionado no cursor)
- [x] **P4#20 — Document symbols** ✅ **fechado** (2026-10-18). Lista e navegação de símbolos
      do documento via `textDocument/documentSymbol`:
      - **Ctrl+Shift+O** abre popup com filtro incremental
      - Ícones SVG por tipo (class, method, function, variable, enum, etc.)
      - Navegação por setas/Enter/Esc
      - Seleção navega caret + scroll para o símbolo
      - `src/renderer/document-symbols.ts` — popup DOM com input e lista
      - Árvore de símbolos achatada com indentação por profundidade

## 🧩 P5 — LSP expandido (2026-10-18)

> Expandindo o LSP Client além do baseline (completion, hover, definition, signature help, document symbols).

- [x] **P5#21 — Code Actions** ✅ **fechado** (2026-10-18). Ctrl+. dispara popup com ações de código
      do servidor LSP (organize imports, quick fix, refactoring):
      - `LspCodeAction`, `LspWorkspaceEdit`, `LspRange` em `lsp-contract.ts`
      - `CodeActionParams`, `CodeAction`, `WorkspaceEdit`, `Command` em `lsp-protocol.ts`
      - `LspManager.requestCodeActions()` → `textDocument/codeAction`
      - `EditorCore.requestCodeActions()` com conversão de tipos
      - IPC `lsp.codeActions` (main dispatch + preload + renderer bridge)
      - Popup DOM com título + kind tag; aplica TextEdits via `controller.replaceText()`
      - Gatilho: Ctrl+.
      - 20 novos testes (14 protocolo + 6 manager)
- [x] **P5#22 — Find References** ✅ **fechado** (2026-10-18). Ctrl+Shift+F12 lista referências
      do símbolo sob o cursor:
      - `ReferenceParams` em `lsp-protocol.ts`
      - `LspManager.requestReferences()` → `textDocument/references`
      - `EditorCore.requestReferences()` com `convertLocation()`
      - IPC `lsp.references` (main dispatch + preload + renderer bridge)
      - Popup `references-popup.ts` com filtro incremental, navegação setas/Enter/Esc
      - Gatilho: Ctrl+Shift+F12
      - 5 novos testes (2 protocolo + 3 manager)
- [x] **P5#23 — Rename Symbol** ✅ **fechado** (2026-10-18). F2 renomeia símbolo via LSP:
      - `RenameParams`, `PrepareRenameParams` em `lsp-protocol.ts`
      - `LspManager.requestRename()` + `prepareRename()` → `textDocument/rename`
      - `LspRenameResult` em `lsp-contract.ts`
      - IPC `lsp.rename` (main dispatch + preload + renderer bridge)
      - `showRenameInput()` (dialog) + `applyRenameEdits()` aplica TextEdits
      - Gatilho: F2
      - 4 novos testes (2 protocolo + 2 manager)

## 🧩 P4#24 — LSP Formatting (2026-10-18)

- [x] **P4#24 — Formatting** ✅ **fechado** (2026-10-18). Formata documento via `textDocument/formatting` com Ctrl+Shift+I:
  - `DocumentFormattingParams`, `FormattingOptions` em `lsp-protocol.ts`
  - `LspTextEdit` em `lsp-contract.ts`
  - `LspManager.requestFormatting()` com defaults tabSize=2, insertSpaces=true
  - `EditorCore.requestFormatting()` com conversão para `LspTextEdit[]`
  - IPC `lsp.formatting` (main dispatch + preload + renderer bridge)
  - Keybinding `Ctrl+Shift+I` + `applyFormattingEdits()` (aplica edits do fim p/ começo)
  - Gates: typecheck/lint/test/build passam (543 testes, 50 arquivos)

## 🧩 P4#25 — Folding (2026-10-18)

- [x] **P4#25 — Folding** ✅ **fechado** (2026-10-18). Dobramento de blocos via `textDocument/foldingRange`:
  - `FoldingRange`, `FoldingRangeKind`, `FoldingRangeParams` em `lsp-protocol.ts`
  - `LspFoldingRange` em `lsp-contract.ts`
  - `FoldRange`, `FoldingState` em `src/core/render/scene.ts` com `isCollapsed`
  - `buildInstances` — pula linhas colapsadas, desenha `▾`/`▸` no gutter
  - Estado de folding por handle no renderer
  - Gutter click → toggle `isCollapsed` + re-render
  - Fetch automático ao abrir/ativar documento
  - Gates: typecheck/lint/test/build passam (543 testes, 50 arquivos)

## 🧩 P4#26 — Inlay Hints (2026-10-18)

- [x] **P4#26 — Inlay Hints** ✅ **fechado** (2026-10-18). Dicas inline de tipo/parâmetro via `textDocument/inlayHint`:
  - `InlayHint`, `InlayHintKind`, `InlayHintParams`, `InlayHintLabelPart` em `lsp-protocol.ts`
  - `LspInlayHint` em `lsp-contract.ts`
  - `RenderInlayHint` em `src/core/render/scene.ts` com posições px
  - `buildInstances` — desenha labels com 60% opacidade da cor default
  - `fetchInlayHints()` — busca hints pro range visível, converte posições px
  - Refresh ao scroll (debounce 200ms), abrir/ativar/editar documento
  - Gates: typecheck/lint/test/build passam (543 testes, 50 arquivos)

## 🌐 Multi-root workspace (2026-10-18)

- [x] **Multi-root workspace** ✅ **fechado** (2026-10-18). Workspace folders para servidores LSP:
  - `WorkspaceFolder` interface no protocolo LSP
  - `LspManager.setWorkspaceFolders()` com notificação `didChangeWorkspaceFolders`
  - Detecta workspace root a partir do CWD (`.git`, `package.json`, `pyproject.toml`)
  - `rootUri` e `workspaceFolders` enviados no handshake `initialize`
  - Gates: typecheck/lint/test/build passam (543 testes, 50 arquivos)

## 🐙 Git integration (2026-10-18)

- [x] **Git blame na status bar** ✅ **fechado** (2026-10-18). Mostra autor + tempo relativo ao clicar numa linha:
  - `git blame -L` via `child_process.execSync` no main dispatch
  - IPC `git.blame` + preload bridge + renderer bridge
  - Elemento `#status-blame` na status bar
  - `timeAgoStr()` formatando em português
  - Atualizado ao mover caret (clique, setas, troca de documento)
  - Gates: typecheck/lint/test/build passam (543 testes, 50 arquivos)

- [x] **Git diff indicators no gutter** ✅ **fechado** (2026-10-18). Barras coloridas na borda do gutter:
  - `GitDiffRange` type em `scene.ts`
  - `git diff HEAD --unified=0` no main dispatch, parseia hunks `@@`
  - Barras de 3px no gutter (verde=added, azul=modified, vermelho=deleted)
  - Fetch automático ao abrir/ativar documento
  - Gates: typecheck/lint/test/build passam (543 testes, 50 arquivos)

## 🧩 DAP — Debug Adapter Protocol (2026-10-20)

- [x] **DAP — depuração de arquivo único** ✅ **fechado** (2026-10-20). Feature finalizada (estava
      WIP não commitado: core/main/preload prontos, renderer sem fiação, zero testes). Entregue:
  - `src/core/dap/` — protocolo (subconjunto DAP), transporte stdio (framing `Content-Length`),
    cliente JSON-RPC (correlação por `request_seq`, timeout 15 s, requisições reversas respondem
    `success: false`), manager (handshake `initialize` → `launch` → `initialized` →
    breakpoints → `configurationDone`, uma sessão por vez)
  - `src/shared/dap-contract.ts` — contratos de fronteira + `BUILTIN_DAP_SERVERS`
    (**Python via debugpy**; ausente no PATH = warn, nunca fatal)
  - **main** — dispatch `dap.*` (15 métodos), menu **Debug** (F5/Shift+F5/F9/F10/F11/Shift+F11),
    broadcast dos eventos `dap.state/stopped/output/breakpoints`
  - **preload** — 19 métodos/escutas `dap*` na ponte
  - **renderer** — `createDebugView()` fiado (toolbar + painel com pilha/variáveis/saída),
    `ScribeBridge` com métodos `dap*` opcionais, F5 contextual (parado ⇒ continuar), F9 toggle
    de breakpoint no caret, **bolinha de breakpoint no gutter** (`scene.ts`, `#E51400`),
    fetch ao abrir/ativar documento
  - **44 testes novos** (5 protocolo + 10 transporte + 15 cliente + 14 manager, com
    auto-responder de handshake — mata a race de respostas órfãs)
  - Contrato travado: `Event<T>` devolve **Disposable** (objeto), não `() => void` — fakes de
    transporte devem conformar (o teste de `dispose()` pega isso)
  - **Limitações**: só Python embutido (Node adiado); sem conditional breakpoints/watch;
    parada não move o caret para o frame
  - Gates: typecheck/lint/build exit 0 · **587 testes / 54 arquivos** (baseline 543/50)

## 📝 Snippets avançados — P4#18b (2026-10-20, tarde)

- [x] **P4#18b — Snippets avançados** ✅ **fechado** (2026-10-20). Expansão do P4#18:
      placeholders aninhados, ciclagem de tab stops, espelhos ao vivo e transformações.
      Entregue:
  - `src/renderer/snippets.ts` (reescrito) — AST com **aninhamento** (`}` balanceado,
    `\}`), **escolhas** `${1|a,b,c|}` (default = 1ª, sem dropdown), **transformações**
    `${1/regex/format/flags}` (split nos 1º/último `/` não-escapados; regex inválida
    degrada com 1 `warn`), `$$`/`$0`/multi-dígito, `${FOO}` literal; **espelhos renderizados
    na expansão inicial** + `occurrences` (`id`/`parentId`/`isPrimary`/`transform`) e
    `visitOrder`
  - `src/renderer/snippet-session.ts` (novo) — sessão **pura** e imutável: `nextTabStop`/
    `previousTabStop` (Tab/Shift+Tab, `$0` encerra), `applyEdit` deslocando offsets e
    re-renderizando **espelhos + ancestrais** (aninhamento por cadeia `parentId`) com
    `updates` na ordem de aplicação
  - `src/renderer/main.ts` — `snippetSession` na sessão do documento; parada atual
    **selecionada** (usa o highlight de seleção existente); Esc/clique-fora/troca-aberta/
    undo-redo encerram; `insertText` com sessão usa caminho IPC imediato (coerência dos
    espelhos); `propagateSnippetEdit()` aplica espelhos e ajusta o caret
  - **39 testes novos** (20 parser + 19 sessão) → **626 testes / 56 arquivos**
    (baseline 587/54) · gates typecheck/lint/test/build **exit 0**
  - **E2E por CDP** (`/tmp/opencode/cdp-snippet.mjs`): **8/8** no app real (espelhos
    renderizados, espelho ao vivo, `$2`, fim em `$0`, Shift+Tab retrocede, Esc encerra)
  - **Follow-ups declarados**: dropdown de escolhas · variáveis TM · snippets de pacotes
    (`.sublime-snippet` via `PackageResolver`) · snippets LSP (`insertTextFormat: 2`) no
    popup de completação

## 🏠 P3 — Housekeeping (2026-10-20, bootstrap)

- [x] **P3.13 — 3 bugs do `setup.py`** ✅ **fechado** (2026-10-20, achados ao rodar o bootstrap
      numa máquina "limpa"; todos corrigidos no `setup.py`):
      - **Rizin flat**: o tarball `rizin-v0.9.1-static-x86_64.tar.xz` extrai `bin/` na **raiz**
        (sem wrapper `rizin-v0.9.1/`); o fallback escolhia `candidates[0]` (ordem alfabética =
        `bin`) e instalava os binários soltos → `rizin-v0.9.1/bin/rizin` nunca existia. Agora a
        busca é pelo diretório que **contém `bin/rizin`** (raiz do tmp ou wrapper).
      - **Schema novo do `opencode.jsonc`**: servidores ficaram em `mcp.<nome>` (sem
        `mcp.servers.`) → a gravação do `environment` silenciava com warn; pior, o
        `_MCP_ENV_HINTS` **não tinha a chave `REA_RIZIN_COMMAND`** → `KeyError` derrubava a
        etapa 11 e o `rea doctor` (12) nunca rodava. Agora: helper `_jsonc_rea_server_span`
        aceita **ambos** os schemas, validação de escrita alinhada e a hint existe.
      - **`env.sh` sem `PATH`**: com o default do nvm em v14, `rea`/`npm` não existiam em
        shells não-interativos (o bootstrap do AGENTS.md falhava com `command not found`).
        O `env.sh` gerado agora **prepende o bin do Node detectado** na etapa 4.
      - Verificado: `python3 setup/setup.py` → **12/12 ✓** · `rea doctor` = `healthy: true`
        em shell limpo (`env -i PATH=/usr/bin:/bin`) · `setup/env.sh` idempotente.
