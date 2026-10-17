# HANDOFF — sublime-rea

> **Documento de handoff entre sessões** (leia antes de retomar). Atualizado em **2026-10-17**.
> Status: P1#2 (Gutter) concluído. Próxima tarefa: P1#3 — Scrollbar proporcional.

---

## ⚡ COMECE AQUI

> 🚀 **Sessão nova?** O gatilho é a frase do usuário — **“pode continuar os trabalhos!”** (ou
> equivalente) — e o **bootstrap** vive em [`../AGENTS.md`](../AGENTS.md), que manda **ler este
> HANDOFF primeiro** (ele é o **ponto de entrada**) e então pegar o próximo item aberto do
> [`BACKLOG.md`](BACKLOG.md). Não peça contexto: ele está todo em `docs/`.

**Estado em uma linha:** ambiente ✅ · binário-alvo **100% analisável** ✅ · Track A (API Python +
IPC) ✅ · **FASE 1 FECHADA** · **FASE 2 FECHADA** · **FASE 3 FECHADA** · P2.4/Slices A-D ✅ ·
P2.4b/c ✅ · P2.5 (salvar) ✅ · P3.10/11/12 (dívidas) ✅ · P1#1 (seleção) ✅ · **P1#2 (gutter) ✅** ·
**próximo: P1#3 — Scrollbar proporcional**

**✅ Passo operacional resolvido (2026-10-16).** O `setup.py` foi rodado e o MCP `rea` foi relançado
**já com `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000`** (confirmado em `/proc/*/environ`) — **não** é mais
preciso reiniciar o opencode manualmente. Para reproduzir numa máquina nova:

```bash
cd /home/gbortolas/ai/workspaces/sublime-rea
python3 setup/setup.py        # idempotente: reescreve setup/env.sh + environment do MCP rea
```

Sem o deadline maior, `open_binary`/`analyze` **via MCP** volta a estourar os 330 s (a análise leva
~355 s).

**Próxima tarefa recomendada:** **P1#3 — Scrollbar proporcional** ([`docs/ROADMAP.md`](ROADMAP.md)). Barra de rolagem à direita com thumb proporcional ao documento, drag do thumb. Esforço **P** (pequeno) — mexe no `Viewport` + `buildInstances`/render do scrollbar track + thumb. Depois: find bar visual (P1#4) — todos independentes.

> ✅ **Pegadinha resolvida (2026-10-16, P3.9):** o `setup.py` agora **detecta** um JDK ≥ 21
> compatível (`JAVA_HOME`, PATH, sdkman, `/usr/lib/jvm`) e escreve um **`export JAVA_HOME=…` ativo**
> no `env.sh` gerado — **não** é mais preciso exportar manualmente. Basta rodar
> `python3 setup/setup.py` (idempotente) e depois `set -a; . ./setup/env.sh; set +a`. Verificar com
> `rea doctor --client opencode --provider ghidra --format json` → espera `healthy: true`
> (verificado em 2026-10-16 sem nenhum export manual).

**Ambiente do CLI (obrigatório):** `set -a; . ./setup/env.sh; set +a`.

---

## Objetivo do projeto

Trabalho de pós-graduação: **clean-room reverse engineering** do Sublime Text usando a ferramenta
**REA** (MCP + Ghidra), para extrair **padrões arquiteturais abstratos** (estrutura de buffer,
concorrência, ponte IPC C++↔Python, render pipeline) e então reimplementar um editor equivalente
**do zero** em **Electron / TypeScript**. Princípio inegociável: **não copiar código do binário** —
só conceitos e especificações abstratas.

---

## 📍 Onde estamos

**Não** analisamos o `.deb`. O alvo é o **executável ELF** extraído do `.tar.xz`:

```
bin/sublime_text_build_4215_x64.tar.xz ──(setup, etapa 8: baixa+valida SHA-256)──▶ target/sublime_text/sublime_text
```

A análise **começou de verdade** em 2026-10-16:

1. ✅ **ambiente** instalado, configurado e verificado;
2. ✅ **alvo** extraído e identificado (anatomia ELF via `inspect-binary-layout`);
3. ✅ **Track A — análise SEM Ghidra**: API Python de plugins + ponte IPC → [`docs/analysis/`](analysis/);
4. ✅ **Track B — o binário foi analisado por inteiro** (headless + rota nativa do REA validada) —
   ver [Timeout do Ghidra](#-timeout-do-ghidra--resolvido).

### O que é cada arquivo

| Arquivo | O que é | Status |
|---|---|---|
| `bin/sublime_text_build_4215_x64.tar.xz` | tarball oficial do Sublime build 4215 | **fonte do alvo** (22 MB, **fora do git**: baixado sob demanda pelo setup, SHA-256 pinado) |
| `bin/sublime-text_build-4215_amd64.deb` | pacote Debian do mesmo build | **removido do git** (redundante) |
| `target/sublime_text/sublime_text` | ELF 9,5 MiB, x86-64, **PIE**, **stripped** | **alvo da análise** |
| `target/sublime_text/Lib/python314/` | API de plugins em Python puro | ✅ analisado (Track A) |
| `target/sublime_text/plugin_host-3.14` / `-3.3` | processos que hospedam o Python | ✅ analisado (Track A) |
| `target/` | gerado pelo setup (gitignored) | descartável |

---

## ✅ Ambiente — PRONTO e verificado

Instalador reprodutível em `setup/` (Python + `rich`), **10 etapas**, idempotente, **sem sudo por padrão**.

```bash
python3 setup/setup.py --help      # flags: --dry-run, --install-deps, --write-rc
python3 setup/setup.py             # instala tudo (idempotente)
```

| Verificação | Resultado |
|---|---|
| `rea doctor --client opencode --provider ghidra --format json` | **`healthy: true`** (exit 0) |
| Ghidra | 12.1.4 headless + native decompiler, em `$REA_TOOLS_DIR/ghidra_12.1.4_PUBLIC` |
| Java | `JAVA_HOME` = `~/.sdkman/candidates/java/23-zulu` (≥ 21) |
| REA | `rea-agents@6.5.0` (global via npm) |
| Provider offline pwntools | venv em `$REA_TOOLS_DIR/pwntools-venv` (pwntools 4.15.0 / pyelftools 0.33 / unicorn 2.1.2) |
| MCP `rea` no `~/.config/opencode/opencode.jsonc` | `GHIDRA_INSTALL_DIR` + `JAVA_HOME` + `REA_PWNTOOLS_PYTHON` + **`REA_GHIDRA_STARTUP_TIMEOUT_MS`** *(este último: só entra após rodar o setup — ver [COMECE AQUI](#-comece-aqui))* |

Pins em [`setup/versions.env`](../setup/versions.env). Docs em [`setup/README.md`](../setup/README.md).

### ⚠️ Pegadinhas operacionais (aprendidas na marra)

1. **O `env.sh` só é escrito (e a var do MCP só entra no jsonc) quando o `setup.py` roda.** Um
   restart do opencode sozinho **não** propaga variáveis novas. Ordem correta: `setup.py` →
   reiniciar o opencode.
2. **O `rea` CLI exige o ambiente exportado.** O `source setup/env.sh` só é feito automaticamente
   por shell **interativo** (linha no `~/.bashrc`). Scripts, cron, CI e shells não-interativos
   **precisam** de:
   ```bash
   set -a; . ./setup/env.sh; set +a     # senão: GHIDRA_INSTALL_DIR is not set
   ```
3. **`rea doctor` exige `JAVA_HOME` de um JDK ≥ 21.** Sem ele o escopo fica `healthy: false`.
    *(Desde P3.9, 2026-10-16, o `env.sh` gerado já exporta o `JAVA_HOME` detectado — verificado.)*
4. **O `ProjectLocator` do Ghidra recusa path com componente iniciado por `.`** — por isso
   `$REA_TOOLS_DIR` (`~/.local/...`) é acessado via symlink `~/sr-tools` (ver P3.7 no BACKLOG).
5. **O scaffold (`src/`) exige Node ≥ 20 + npm** — o `setup.py` cuida só do lado Python/Ghidra. Rode
   `npm install` uma vez; depois `npm run typecheck | test | lint | build | start`. Sem display, use
   `npm run start:headless` (`xvfb-run`).

---

## 🔬 Alvo — fatos observados (Evidence)

Obtidos com `rea inspect-binary-layout` (provider offline `pwntools-elf`):

| Campo | Valor |
|---|---|
| `sha256` | `8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92` |
| Formato | ELF64 x86-64 little-endian, **ET_DYN (PIE)**, execução dinâmica |
| Entry point | `0x4b4920` |
| Estrutura | **33 sections / 12 segments / 444 symbols / 34.534 relocations** |
| Símbolos | **STRIPPED** — sem `.symtab`, só `.dynsym` |
| Mitigations | PIE=true · NX=true · exec-stack=false · canary=false · RELRO=Partial |

> **Agravante:** o binário é **stripped** — a RE depende de strings, padrões (RTTI/vtables) e da
> auto-análise do Ghidra.
>
> ⚠️ **Hipótese "Qt" — refutada** ✅ **(confirmada em 2026-10-16, P1.2).** A versão anterior deste
> doc afirmava "C++ **com Qt**". A verificação independente (P1.2) mostra o contrário: `NEEDED` com
> `libglib-2.0`/`libgobject-2.0`/`libGL`/`libX11` (e `libgtk-3.so` carregada em runtime), strings
> `gtk_main`/`g_idle_add`/`g_source_add_unix_fd`/`prctl`, e **zero** referências a Qt. Ou seja: o
> toolkit é **GTK3/GLib** (**não** Qt) e o render aparenta ser **Skia** via `libGL`/`libX11` — o que
> **encaminha o P1.4** (render). A lista `libssl`/`libcrypto`/`libsqlite3`/`libpython3.14` citada
> antes é a do `plugin_host`/API Python (outro contexto) e **não** conflita com isso. Não assuma
> vtables/sinais de Qt antes de checar.
>
> ✅ **Confirmado no P1.4 (2026-10-16):** o render é **Skia raster (CPU) via Cairo** *e* um backend
> **OpenGL 4.1** próprio (`px_render_context` com `skia_render_context`/`gl_render_context`; default
> de fábrica = CPU). Ver [`docs/analysis/render-pipeline.md`](analysis/render-pipeline.md).

---

## 🔓 Timeout do Ghidra — resolvido

A auto-análise **não cabe no deadline default de 330 s**. **Mas o deadline não é fixo**:

```bash
REA_GHIDRA_STARTUP_TIMEOUT_MS=900000 rea ...        # 900 s = 15 min
```

> ⚠️ **Correção:** versões anteriores deste doc afirmavam *"não existe env var para o timeout de
> análise"*. **Errado.** Schema: inteiro positivo decimal, máx `2_147_483_647`
> (`rea-agents/dist/config/providerStartupTimeout.js:3-16`; default `330_000`).

| Env var | Efeito | Evidência (`rea-agents/dist/`) |
|---|---|---|
| `REA_GHIDRA_STARTUP_TIMEOUT_MS` | deadline de import+análise+bridge+ready | `config/providerStartupTimeout.js:3`, `config/environment.js:38` |
| `REA_GHIDRA_DISABLED_ANALYZERS` | nomes **exatos** de analyzers (case-sensitive, sem glob), `,`, ≤32 → `-preScript ReaGhidraAnalysisOptions.java`. Nome desconhecido = **erro fatal**. | `config/ghidraDisabledAnalyzers.js:9-25`, `bridge/ghidra/ReaGhidraAnalysisOptions.java:20-24` |
| `REA_GHIDRA_SEED_FILE` | **não** importa análise prévia: é um TSV de assertivas (`address<TAB>kind[<TAB>name]`, `kind ∈ function\|code\|label`, `rea-ghidra-seeds-v1`), aplicado como `-preScript` **antes** da auto-análise | `ghidra/GhidraAnalysisSeeds.js:9-24,51-91`, `ghidra/GhidraLauncher.js:402-409` |

**O REA não consome análise pré-existente.** Ele sempre faz `-import <target> -readOnly
-deleteProject` num projeto temporário (`ghidra/GhidraLauncher.js:326-381`); não aceita `-process`,
`.gzf` nem DB do Ghidra. O `snapshot_path=<*.json>` de `open_binary`/`close_binary` é só *replay* de
evidência do próprio REA — e exige análise completa, logo não resolve nada.

### Track B — pré-análise headless — ✅ **análise completa bem-sucedida**

[`bin/ghidra-preanalyze.sh`](../bin/ghidra-preanalyze.sh) roda o **mesmo** `analyzeHeadless` sem
deadline e grava num projeto persistente
(`$REA_TOOLS_DIR/ghidra-projects/sublime-rea/sublime_text.gpr`).

**Resultado (2026-10-16):** `Analysis succeeded` + `Save succeeded` + `Import succeeded`.

| Métrica | Valor |
|---|---|
| Auto-análise (relatório do `AutoAnalysisManager`) | **334 s** |
| Wall clock (import → fim) | **~342 s** (11:42:36 → 11:48:18) |
| Projeto persistente | `sublime_text.rep` + `sublime_text.gpr`, **171 MB** |
| Default do REA | `330 s` → **a análise estourava por ~4 s** e o REA descartava tudo |
| **Validação ponta a ponta** | ✅ **`EXIT=0` em 5m54,8 s** com `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000` (`rea analyze --provider ghidra`) — onde antes era `provider_timeout` aos 330 s |

Ou seja: **o alvo é analisável**; o que faltava era deadline (e o default era tragicômico).

O projeto persistente serve para reprocessamento futuro — gerar um `REA_GHIDRA_SEED_FILE` a partir
dos nomes recuperados é o único vetor real de "alimentar" o REA:

```bash
# reprocessar SEM re-analisar:
analyzeHeadless <PROJECT_LOCATION> sublime_text -process sublime_text -noanalysis -postScript <dump.java>
```

### Track A — análise SEM Ghidra

Fase 1 que **não** depende do núcleo nativo, em [`docs/analysis/`](analysis/):

| Doc | Conteúdo | Situação |
|---|---|---|
| [`api-python.md`](analysis/api-python.md) | superfície da API de plugins 3.14 (64 funcs de módulo, 17 enums, 24 classes, 331 métodos, 284 símbolos `sublime_api.*`) + delta vs 3.3 + 12 padrões da ponte + ledger `E1–E33` | ✅ 353 linhas |
| [`ipc-plugin-host.md`](analysis/ipc-plugin-host.md) | ponte C++↔Python (**memória compartilhada POSIX nomeada + semáforos nomeados**; canais `subl_send`/`subl_recv`/`subl_arecv`) inferida dos `plugin_host-*`, com disassembly | ✅ 502 linhas |
| [`ipc-protocol.md`](analysis/ipc-protocol.md) | **wire protocol** do IPC (P1.3): framing `[uint32 len][payload]`, anel em shm (`0x80000`), `shm_channel`/`shm_bundle`, semáforos `<canal>:r`/`:w` e **dispatch numérico** com os enums **U** (281 ids, Anexo A) e **V** (71 ids) | ✅ 797 linhas |
| [`packaging.md`](analysis/packaging.md) | **empacotamento de recursos** (P1.6): `.sublime-package` (ZIPs **sem manifesto**) + `.sublime-syntax`; namespace lógico plano, extensão = contrato, precedência `User` > `Default` | ✅ 370 linhas |

Achados centrais: (a) a API Python é um **facade fino** sobre o módulo nativo `sublime_api`, com
**handles opacos (int)** e callbacks Python retidos no C++; (b) o núcleo **cria** os canais e faz
`fork/exec` do `plugin_host`, que os **abre** — nome = `<id>:subl_<canal>-<versão>`.

### P1.1 — estrutura de buffer (Fase 1, via Ghidra)

[`docs/analysis/buffer-structure.md`](analysis/buffer-structure.md) (275 linhas, ledger E1–E14): o
buffer é a classe C++ **`TextBuffer`** (facade, RTTI em `.rodata`) que delega o texto a um objeto
interno **anônimo** com **múltiplos buffers de heap + array de registros** → família
**piece-table/segmentado [INFERIDO]** (sem Gap Buffer nem Rope nomeados); edição por **comandos
delta**; **undo por grupos** (*glue*/*soft*); linha por **scan com cache**.

### P1.2 — modelo de concorrência (Fase 1, via Ghidra)

[`docs/analysis/concurrency.md`](analysis/concurrency.md) (371 linhas, ledger E1–E21): o núcleo é um
processo **GTK3/GLib single-main-thread** (**`gtk_main`** + `g_idle_add`/`g_source_add_unix_fd`
**[OBSERVADO]**) que delega trabalho a **threads POSIX próprias** (`pthread_create`, stack de
**2 MiB**, nomeadas via `prctl(PR_SET_NAME)` **[OBSERVADO]**), com **pool de I/O de N threads**
(`io_worker`, N = setting `io_workers`; **o tamanho N** é **[INFERIDO]**) e **pool on-demand
limitado a 2** (`file_read_thread` **[OBSERVADO]**); o retorno ao main thread passa por
**`px_main_thread_scheduler`** **[INFERIDO]**. O `plugin_host` **é processo separado**
(`posix_spawn`/`execvp` + shm/sem), **não** thread.

### P1.3 — wire protocol do IPC (Fase 1, via `objdump`/`readelf`)

[`docs/analysis/ipc-protocol.md`](analysis/ipc-protocol.md) (797 linhas, ledger E1–E36 — consolida os
ledgers dos dois relatórios de P1.3): o transporte é um **anel circular em shm** de `0x80000` B
(header `0x80`, índices `u64` @`0x0`/`0x40`, dados @`0x80`, capacidade **constante** `0x7ff80`) e a
mensagem é `[uint32 LE len][payload]`, **sem** campo de tipo/opcode; o **opcode é o 1º `uint32` do
payload** e o dispatch é **numérico por tabela de saltos densa**, com **dois enums**: **U**
(host→núcleo, **281 ids** `1..281`, tabela `.rodata 0x104a70`, **Anexo A** com o mapa completo
`id → api_*`) e **V** (núcleo→host, **71 ids** `1..71`, `.rodata 0x81e28`). O 1º parâmetro
`unsigned long` de `handle_protocol_message` é o **índice do bundle**, não o opcode; `data[0] == 0` é
o ***escape*** para o motor de requisições pendentes (resposta assíncrona). Os semáforos são
`<canal>:r` / `<canal>:w`. **3.3 e 3.14 falam o mesmo protocolo** (U=281, V=71) — a diferença é
*surface* Python (`lib_path` a mais no 3.14). ⚠️ Achado que **contradiz** a tabela de §1 do doc irmão:
o **sentido** dos canais é o inverso do que se supunha (`subl_send` = **entrada do host**, nomes
relativos ao núcleo) **[INFERIDO], confiança média** — registrado como revisão, sem apagar a
afirmação antiga. Ficam `[DESCONHECIDO]`: padding do header do anel (`0x8..0x40`, `0x48..0x80`),
uso de `subl_arecv` por thread não-main, `shm_channel+0x50`, modo síncrono vs assíncrono por id /
geração do `req_id`, quais ids bloqueiam o app e sub-códigos de `data[0] == 0`.

### P1.4 — pipeline de render (Fase 1, via Ghidra + recon offline)

[`docs/analysis/render-pipeline.md`](analysis/render-pipeline.md) (ledger E1–E27): toolkit
**GTK3/GLib** (em runtime, via `dlsym`), contexto de GPU pelo **`GdkGLContext`** e blit
`gdk_cairo_draw_from_gl` **[INFERIDO]**. O desenho é a **base abstrata `px_render_context`
(interface de 31 virtuais)** com **duas implementações**: **`gl_render_context`** (OpenGL ≥ 4.1,
GLSL `#version 410`) e **`skia_render_context`** (**Skia raster estático** sobre
`cairo_image_surface`) — escolhidas pelo setting **`hardware_acceleration`** (default **`"none"`** =
CPU; modo `"opengl"`). O backend GL **compila 17 programas nomeados** (`filled_rect*`, `rect_rounded*`,
`bezier_line*`, `glyph_*`) e desenha **instanciado**: as instâncias vão num **texture buffer
`RGBA32F`** lido por `texelFetch` (`gl_InstanceID * N + k`, **N ∈ {2,3,4,5}**), com tetos
**`MAX_GLYPH_INSTANCES=8192`** e **`MAX_STENCIL_QUAD_INSTANCES=128`**, AA por *feather* (`0.5`) e
rounded por **8× supersample**. **Texto é moldado/rasterizado na CPU** (Pango/FreeType/Cairo) e sobe
como **atlas de glifos `RGBA8` 1024/4096** (`glTexSubImage2D`, BGRA). Viewport = **portal**
(`viewport_control`/`scroll_area_control`/`scroll_data_source` + observers + alvo animado) com
**`glScissor` por região danificada**; render na **main/GTK thread** (sem thread de render).
Falha ao iniciar GL = **diálogo modal**, não fallback silencioso. `[DESCONHECIDO]`: função exata do
range de linhas visíveis, política de flush do batch, queda automática para software após falha de GL,
formato de pixel/sRGB.

### P1.5 — ledger de evidências consolidado (Fase 1)

[`docs/analysis/evidence-index.md`](analysis/evidence-index.md) (422 linhas): reuniu os **7 ledgers**
da Fase 1 num único índice navegável por namespace — `BUF-` (14) · `CON-` (21) · `PY-` (33) ·
`HOST-` (26) · `IPC-` (36) · `REN-` (27) · `PKG-` (22) = **179 linhas**, sem lacuna de numeração —
com as colunas **`conclusão → Evidence ID → tipo → limites`** (IDs originais preservados; fontes
heterogêneas normalizadas: `ipc-plugin-host.md` não usava prefixo `E`; `render-pipeline.md` põe
"fonte" antes de "conclusão"; confiança → `limites`). Registra **duplicatas/supersessões** por
citação explícita (HOST-E21–E26 → IPC-E1–E17/E22–E30; **HOST-E20** revisada quanto à direção dos
canais; **HOST-E9** revisada — enum numérico) e **48 incógnitas** consolidadas (`PY-U*` 10, `BUF-U*` 5,
`CON-U*` 6, `HOST-U*` 6, `IPC-U*` 6, `REN-U*` 6, `PKG-U*` 9), cada uma com "o que fecharia". É o
**insumo direto da Fase 2**. Método: extração mecânica, **sem** análise nativa nova.

### Fase 2 (P2.1) — spec abstrata

[`docs/architecture/`](architecture/) — **6 docs + README**, **61 decisões `DEC-*`** (`BUF` 10 ·
`CON` 12 · `IPC` 12 · `REN` 8 · `PKG` 12 · `TR` 7). Cada doc: *padrão observado (com Evidence IDs) →
decisões de arquitetura (racional + evidência) → contratos TypeScript (do NOSSO código) →
divergências deliberadas → rastreabilidade → incógnitas que o afetam*. Índice
[`docs/architecture/README.md`](architecture/README.md): arquitetura em um olhar (**3 fronteiras** do
alvo → mapeamento **Electron/TS**), **glossário canônico** de componentes (`Buffer`/`TextStore`/
`DocumentHandle`/`CommandBus`/`Scheduler`/`TaskPool`/`ExtensionHost`/`ExtensionBridge`/`RenderPipeline`/
`Viewport`/`PackageResolver`/`PropertySystem`) e rastreabilidade global Fase 1 → Fase 2. Docs: `01` buffer ·
`02` concorrência · `03` extensão/IPC · `04` render · `05` empacotamento · `06` padrões transversais.
**Clean-room**: nenhum bloco/assembly/pseudocódigo do alvo — só contratos e decisões nossas (marcadas).
Codinome **Scribe** (decidido em **P2.3** ✅).

### Fase 3 (P2.2) — scaffold `src/` do **Scribe** (Electron + TypeScript)

Doc do entregável: [`docs/scaffold/P2.2-scaffold.md`](scaffold/P2.2-scaffold.md) · regras e costuras:
[`docs/scaffold/00-convencoes-e-costuras.md`](scaffold/00-convencoes-e-costuras.md).

**Escrita de código do zero** (não é análise). Cada módulo de `src/core/**` foi escrito **contra o seu
doc da Fase 2**, importando **apenas** `src/shared/**` — a costura entre módulos foi feita **depois**,
de propósito:

| Diretório | Papel | Doc dono |
|---|---|---|
| `src/shared/**` | **costuras congeladas** (handles, descarte, eventos, async + os 7 contratos) | `DEC-TR-*` |
| `src/core/buffer/**` | `PieceTable` segmentada (minimal-copy), índice de linhas incremental, delta + inversão, `Buffer`, `DocumentRegistry` (handles com geração) | `DEC-BUF-*` |
| `src/core/command/**` | `CommandBus`, `EditScope` aninhável, undo/redo por **delta inverso** com grupos/glue/soft | `DEC-BUF-*` |
| `src/core/concurrency/**` | `Scheduler` (lanes + `Atomics.waitAsync`), `TaskPool` sobre `worker_threads`, `worker-entry`, contadores SAB | `DEC-CON-*` |
| `src/core/render/**` | `RenderPipeline` + `Canvas2DBackend`/`WebGPUBackend` (WGSL), atlas RGBA8, `Viewport` virtualizada com damage | `DEC-REN-*` |
| `src/core/packages/**` | `PackageResolver` (namespace plano, camadas `user>app>os`, ZIP mínimo, glob) | `DEC-PKG-*` |
| `src/core/properties/**` | `PropertySystem` + `defineProperty` + merge por camada, JSONC | `DEC-PKG-*`/`DEC-TR-*` |
| `src/core/extension/**` | `OPS` denso + `OPS_HASH`, `ExtensionBridge` (request por `id`, cancel), `ExtensionHost` (`utilityProcess` + handshake/FSM), `ExtensionAPI` | `DEC-IPC-*` |
| `src/core/editor/**` | **costura**: `EditorCore` monta registry + bus (fila de escrita única) + scheduler/pool dimensionados pelo `PropertySystem` + resolver | `DEC-TR-*` |
| `src/main` · `src/preload` · `src/renderer` | processo Node (IPC versionado), ponte `contextBridge` mínima (`sandbox: true`), boot do render (default **CPU/Canvas2D**) | `DEC-IPC-*`/`DEC-REN-*` |

**Decisões de contrato que o digest da Fase 2 deixou em aberto** (shapes conflitantes entre docs) foram
resolvidas no código e estão tabeladas em
[`docs/scaffold/00-convencoes-e-costuras.md`](scaffold/00-convencoes-e-costuras.md) §3 — ex.:
`TextStore` síncrono (`01`) × assíncrono (`02`) → fronteira assíncrona + `PieceTable` interna; camadas
`platform/installed/packages/user` (`06`) × `os/app/user` (`05`) → **`os`/`app`/`user`**.

**Build** (`scripts/build.mjs`, não é só `tsc`): o `tsc` preserva a árvore em `dist/` porque o
`TaskPool` resolve o worker por `path.join(__dirname, "worker-entry.js")`; o **renderer** vai por
esbuild em **IIFE** (CommonJS não roda em `<script>`) e o **preload** em bundle **self-contained**
(sandbox não deixa `require` de arquivo irmão); HTML/CSS por cópia explícita.

**Gates medidos (2026-10-16):** `npm run lint` exit 0 · `tsc -p tsconfig.json --noEmit` exit 0 ·
**250 testes / 31 arquivos** verdes · `npm run build` ok · smoke `electron .` **sobe** (main loga
`Scribe: MainThreadBusy {...}` e o processo permanece vivo; encerrado por timeout). Auditoria
independente das regras do scaffold (10 itens: imports cruzados, `any`, `catch` mudo, `Atomics.wait`,
polling, validação de handle, clean-room) → **aderente**, sem bloqueadores.

**Pré-requisito novo de ambiente:** **Node ≥ 20 + npm** (o scaffold usa Node 24) — o `setup.py` **não**
instala Node. `npm install` traz `electron@38`, `typescript`, `vitest`, `eslint` e `esbuild`.

### Fase 3.2 (P2.4) — primeira fatia vertical end-to-end

**Slice A/B/C** (`04096ae`) — **abrir arquivo real** (arg de CLI + `dialog.showOpenDialog` via
`document.openDialog`), **undo/redo visível** (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y` +
elementos `#status-undo`/`#status-redo`) e **cancelamento end-to-end** (registro `signalId →
AbortController` no `main`, `IpcCancel` no mesmo canal, `Esc`/troca de arquivo aborta a abertura em
voo). Novos testes: `test/document-path.test.ts`, `test/ipc-cancel.test.ts`. Gates: typecheck/test/lint/
build verdes (**263 testes / 33 arquivos**).

**Slice D** (`2a169be`) — **realce de sintaxe ponta a ponta**: contrato novo
`src/shared/syntax-contract.ts`; módulo novo `src/core/syntax/**` (leitor de subconjunto YAML,
compilador de gramática com `main`/`prototype`/`include`/`extends`, tokenizer de máquina de estados,
`ThemeResolver` por especificidade de escopo, `GrammarRegistry`); costura em `buildInstances`
(`src/core/render/scene.ts`) + `EditorCore.highlightDocument` (cache por revisão); IPC `syntax.highlight`
(`ipc-contract.ts`/`main`/`preload`); fixture **nossa** em `assets/grammars/scribe-demo.sublime-syntax`.
Gates: typecheck/test/lint/build verdes (**319 testes / 39 arquivos**).

**Slice D — correções de revisão (`P2.4b`)** — ✅ **fechado em 2026-10-17**, em **4 rodadas de `fixer`
com re-revisões independentes** (a re-revisão pegou um **bug alto** que os fixers anteriores não viram).
Entregue: cache de destaque com **identidade da gramática** + resposta vazia não conta como cobertura;
guarda de falha com **1 warn** por revisão, dedupe de requisição em voo e timeout de 10 s;
**teto por linha** na tokenização (`MAX_TOKENIZE_LINE_LENGTH = 4096`) com marcador explícito
`text.unparsed.syntax-limit` (degrada em cor default) e **estado neutralizado** após truncamento;
`HighlightStore` do renderer chaveado por **documento + revisão** (o *bug alto*: `revision` reinicia em 1
por documento, então spans do arquivo anterior eram servidos ao novo) com teto de retentativas
(4, backoff 250/500/1000 ms) e `highlight` **opcional** no `readBridge`; no `syntax/**`, `visiting`
copiado por ramo, escopo do **contexto do topo** no fallback, captura para grupo inexistente vira `warn`
único, re-registro recomputa `byExtension` na ordem de registro e warn de teto por **instância**.
Gates finais: typecheck/lint/build exit 0 · **348 testes / 40 arquivos** (baseline 319).
⚠️ **Residual declarado e aberto:** o teto é **por linha**, não por documento — `highlightDocument`
tokeniza do estado inicial até a linha visível **absoluta** (O(`end`)), então *deep scroll* + keystroke em
documento grande re-tokeniza o prefixo inteiro a cada revisão e regex catastrófica **dentro** do prefixo
segue vetor de *freeze*. Correção real = cap de `end` **ou** tokenização em worker com prazo — casa com a
infra de `TaskPool` agora **provada** em P2.4c (ver [`BACKLOG.md`](BACKLOG.md) §P2.4b, último bullet).

### Fase 3.3 (P2.4c) — busca/substituição na lane `background`

**Primeira fatia que usa `TaskPool` + a lane `background` do `Scheduler` de verdade.** Contrato novo
`src/shared/search-contract.ts` (`SearchQuery`/`SearchMatch`/`SearchResult`, caps de padrão/matches/texto,
`SearchInputError` tipado, `normalizeSearchQuery`, `scanText` — varredura linear com `line/column` em
UTF-16 e `truncated`); `TaskKind:"search"` no pool (lane `index`) com o texto chegando pelo idioma
existente `registerText(handle, revision, text)`; `EditorCore.searchDocument` disparando por
**`scheduler.post("background", …)`**; `EditorCore.replaceAll` (recusa `truncated`, substituição
**literal**, **um** `EditScope` ⇒ um Ctrl+Z desfaz tudo, e **coalescência** de `document.changed`: 1
evento por lote em vez de 1 por delta); IPC `search.find`/`search.replaceAll`; **find bar**
(`Ctrl/Cmd+F`, `Enter`/`Shift+Enter` com wrap, `Esc` fecha antes do cancelamento de abertura, contador
`atual/total`) com `FindBarModel` puro e testável. **Regex é opt-in** (default literal) e o scan roda no
worker — regex patológico não congela a UI.
Gates: typecheck/lint/build exit 0 · **423 testes / 43 arquivos** (baseline 348).
Decisões, digests e follow-ups: §P2.4c no [`BACKLOG.md`](BACKLOG.md) — inclui o **teste de paridade** que
trava a duplicação do scanner no `worker-entry.ts` (o `eval` do vitest não resolve `../../shared`; a
duplicação morre em **P3.10**), **P3.11** (pintar os matches no canvas), **P3.12** (ciclo de vida das
assinaturas) e a correção de doc: o guard de geração do pool é **por consistência** — quem garante
"resultado fresco" é o chamador comparar `revision`.

---

## ▶️ Como retomar

```bash
cd /home/gbortolas/ai/workspaces/sublime-rea
set -a; . ./setup/env.sh; set +a          # ← obrigatório para o CLI

# 1) confirmar que o ambiente continua saudável
rea doctor --client opencode --provider ghidra --format json

# 2) recon barato do alvo (funciona, não depende do Ghidra)
rea inspect-binary-layout target/sublime_text/sublime_text --format json

# 3) atacar o Ghidra pela rota nativa do REA (a análise leva ~355 s)
export REA_GHIDRA_STARTUP_TIMEOUT_MS=900000
rea open-binary target/sublime_text/sublime_text ...

# 3b) ou consultar o projeto persistente já pré-analisado (Track B)
bin/ghidra-preanalyze.sh        # cria/atualiza o projeto; ver o header do script
```

Material de apoio: skill `reverse-engineer-anything` (+ `references/native-and-artifacts.md`).

---

## 🗂️ Estado do repositório

- Repo **git** inicializado (não era antes). Working tree limpo (`git log --oneline` para o histórico).
- `.gitignore` cobre `target/`, `tools/`, `setup/env.sh`, artefatos Ghidra, venvs, `dist/`,
  `node_modules/`, caches de IDE e `.serena/`.
- **Stack do scaffold (Fase 3):** `package.json` + `package-lock.json` versionados; `dist/` e
  `node_modules/` **não**; `npm install` reconstrói o ambiente Node. Scripts: `typecheck`, `test`,
  `lint`, `build`, `start` (+ `start:headless`).
- ✅ `bin/sublime_text_build_4215_x64.tar.xz` (22 MB) **não é mais versionado** (P3.1, 2026-10-17): o
  `setup.py` o **baixa sob demanda** de `download.sublimetext.com` e **valida o SHA-256** contra o pin em
  `setup/versions.env` **antes** de extrair (download atômico `.part` → SHA → `os.replace`; hash
  divergente = erro fatal, sem extrair e sem sobrescrever; com o arquivo já presente e SHA ok, **não**
  toca a rede). `.gitignore` cobre o tarball (mas **não** `bin/` inteiro — `ghidra-preanalyze.sh` segue
  versionado). Verificado: ausente ⇒ baixa/valida/extrai · pin adulterado ⇒ `code=4`, nada extraído ·
  offline com arquivo presente ⇒ ok.

---

## Convenções / diretórios

| Caminho | Papel |
|---|---|
| `$REA_TOOLS_DIR` = `~/.local/share/sublime-rea-tools/` | ferramentas baixadas (fora do repo) |
| `…/ghidra_12.1.4_PUBLIC/` | instalação do Ghidra |
| `…/pwntools-venv/` | venv do provider offline |
| `…/ghidra-projects/sublime-rea/` | projeto Ghidra persistente (171 MB, gerado pelo Track B) |
| `~/sr-tools` | symlink → `$REA_TOOLS_DIR` (o Ghidra recusa `.` no path) |
| `target/` | alvo extraído (gitignored) |
| `setup/env.sh` | gerado; `source` obrigatório para o CLI |
| `docs/analysis/` | evidências da Fase 1 (Track A + Track B) |
| `docs/architecture/` | **spec abstrata da Fase 2** (padrões + decisões `DEC-*` do editor-alvo) |
| `docs/scaffold/` | **Fase 3**: convenções/costuras (`00-…`) + doc do entregável P2.2 |
| `src/shared/` | costuras congeladas (handles, descarte, eventos, async, contratos) |
| `src/core/` | módulos do Scribe (buffer, command, concurrency, render, packages, properties, extension, editor) |
| `src/main`, `src/preload`, `src/renderer` | processo Node (IPC), ponte `contextBridge`, boot do render |
| `test/` | testes de integração da costura |
| `scripts/build.mjs` | pipeline de build (tsc + esbuild + assets) |
| `dist/` | artefato de build (gitignored) |
| `docs/HANDOFF.md` · `docs/BACKLOG.md` | este doc · backlog vivo |

---

## 📤 Protocolo de handoff (como fechar a sessão)

Resumo do protocolo do [`../AGENTS.md`](../AGENTS.md) — é o que mantém a próxima sessão **limpa e
barata**. Ao terminar um item:

1. **Atualize este `HANDOFF.md`** — a “Estado em uma linha”, a **“Próxima tarefa recomendada”** e os
   achados novos (inclusive o que ficou `[DESCONHECIDO]`).
2. **Atualize o [`BACKLOG.md`](BACKLOG.md)** — marque `[x]` o item entregue e ajuste o “próximo”.
3. **Evidência nova** → `docs/analysis/<tema>.md`, no padrão dos existentes (header com sha256 e
   ranges, “Achado central”, seções e **ledger de evidências** `E<n>`).
4. **`git commit`** no padrão `feat(analysis): P<id> — <tema> + integração docs`.
5. **Working tree limpo** — é isso que permite a próxima sessão começar sem arrastar contexto.

> Protocolo completo (bootstrap de sessão + regras invioláveis + economia de contexto):
> [`../AGENTS.md`](../AGENTS.md).
