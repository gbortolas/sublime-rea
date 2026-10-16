# HANDOFF — sublime-rea

> **Documento de handoff entre sessões** (leia antes de retomar). Atualizado em **2026-10-16**.
> Specs do projeto: [`SPECIFICATION.md`](SPECIFICATION.md) · [`TECHNICAL_SPECIFICATION.md`](TECHNICAL_SPECIFICATION.md)
> Backlog vivo: [`BACKLOG.md`](BACKLOG.md)

---

## ⚡ COMECE AQUI

> 🚀 **Sessão nova?** O gatilho é a frase do usuário — **“pode continuar os trabalhos!”** (ou
> equivalente) — e o **bootstrap** vive em [`../AGENTS.md`](../AGENTS.md), que manda **ler este
> HANDOFF primeiro** (ele é o **ponto de entrada**) e então pegar o próximo item aberto do
> [`BACKLOG.md`](BACKLOG.md). Não peça contexto: ele está todo em `docs/`.

**Estado em uma linha:** ambiente ✅ · binário-alvo **100% analisável** ✅ · Track A (API Python +
IPC) ✅ · **FASE 1 FECHADA** (P1.1 buffer ✅ · P1.2 concorrência ✅ · P1.3 IPC ✅ · P1.4 render ✅ ·
P1.5 ledger consolidado ✅ · P1.6 empacotamento ✅) · **FASE 2 FECHADA** (P2.1: `docs/architecture/`,
6 docs + README, **61 decisões `DEC-*`**) · **falta** o codinome (**P2.3**) e a Fase 3 (o editor em
Electron/TS, **P2.2**).

**✅ Passo operacional resolvido (2026-10-16).** O `setup.py` foi rodado e o MCP `rea` foi relançado
**já com `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000`** (confirmado em `/proc/*/environ`) — **não** é mais
preciso reiniciar o opencode manualmente. Para reproduzir numa máquina nova:

```bash
cd /home/gbortolas/ai/workspaces/sublime-rea
python3 setup/setup.py        # idempotente: reescreve setup/env.sh + environment do MCP rea
```

Sem o deadline maior, `open_binary`/`analyze` **via MCP** volta a estourar os 330 s (a análise leva
~355 s).

**Próxima tarefa recomendada:** **P2.3 — decidir o codinome** (hoje *Arcane*, provisório) e então
**P2.2 — Fase 3**: criar o scaffold `src/` (Electron + TypeScript) **seguindo a spec da Fase 2**
([`docs/architecture/`](architecture/) — 6 docs, **61 decisões `DEC-*`** com rastreabilidade
`conclusão (Evidence) → DEC → status`). A Fase 3 é **escrita de código do zero**, não análise — o
insumo arquitetural está pronto nesta pasta. Ordem: P2.3 (decisão de 1 minuto, bloqueia o nome dos
pacotes) → P2.2 (buffer/`TextStore` → workers → render → API de extensão).

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
bin/sublime_text_build_4215_x64.tar.xz ──(setup, etapa 8)──▶ target/sublime_text/sublime_text
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
| `bin/sublime_text_build_4215_x64.tar.xz` | tarball oficial do Sublime build 4215 | **fonte do alvo** (22 MB, versionado) |
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
Codinome **Arcane** é provisório (**P2.3** pendente).

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
- `.gitignore` cobre `target/`, `tools/`, `setup/env.sh`, artefatos Ghidra, venvs, etc.
- ⚠️ `bin/sublime_text_build_4215_x64.tar.xz` (22 MB) **está versionado** (o `.deb` já foi removido).
  Avaliar `git rm --cached` + download sob demanda com SHA pinado (ver P3.1 no BACKLOG).
- ⚠️ `.serena/` aparece como untracked (cache do LSP Serena) — falta cobrir no `.gitignore` (P3.8).

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
