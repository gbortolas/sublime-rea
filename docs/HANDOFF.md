# HANDOFF — sublime-rea

> **Documento de handoff entre sessões** (leia antes de retomar). Atualizado em **2026-10-21**.
> Status: **🐛 varredura ✅ · ✨ 3+5 features ✅ · 🎨 design system ✅ · ✨ 3 features de última geração ✅ · 🐛 LSP de verdade ✅**<br>
> Versão: **0.6.0** (AppImage gerado e verificado) · **1176 testes / 94 arquivos**<br>
> Próximo: **fila aberta no BACKLOG** (DAP salvar-antes-de-depurar · snippets LSP · regex no grep ·
> split editor · test explorer)

---

## ⚡ COMECE AQUI

> 🚀 **Sessão nova?** O gatilho é a frase do usuário — **“pode continuar os trabalhos!”** (ou
> equivalente) — e o **bootstrap** vive em [`../AGENTS.md`](../AGENTS.md), que manda **ler este
> HANDOFF primeiro** (ele é o **ponto de entrada**) e então pegar o próximo item aberto do
> [`BACKLOG.md`](BACKLOG.md). Não peça contexto: ele está todo em `docs/`.

**Estado em uma linha:** ambiente ✅ · binário-alvo **100% analisável** ✅ · Track A (API Python +
IPC) ✅ · **FASE 1 FECHADA** · **FASE 2 FECHADA** · **FASE 3 FECHADA** · **App 0.6.0 pronto pra uso**
(varredura de usabilidade · design system · 11 features · LSP/DAP/plugins sadios) · P2.4/Slices A-D ✅ ·
P2.4b/c ✅ · P2.5 (salvar) ✅ · P3.10/11/12 (dívidas) ✅ · P1#1 (seleção) ✅ · P1#2 (gutter) ✅ ·
**P1#3 (scrollbar) ✅ · P1#4 (find bar toggles) ✅ · P2#5 (múltiplos cursores) ✅** ·
**P2#7 (drag & drop) ✅ · Infra (GitHub repo + CI/Release) ✅ · P2#6 (abas) ✅ · P2#8 (temas) ✅** ·
**P3#12 (go to line) ✅ · P3#13 (auto-pair) ✅ · P3#14 (bracket matching) ✅ · PyCharm ✅** ·
**🐛 UX: welcome screen ✅ · menu bar ✅ · branding/ícone ✅ · dica abrir arquivo ✅** ·
**P3#11 Command Palette ✅** · **P2#9 Minimap ✅** · **P3#15 Indentation Guides ✅** · **cursor line highlight ✅** · **smooth mouse wheel ✅** · **P4#18 Snippets ✅** · **🎨 repaginação do design (casca VS Code-like + tema como fonte única + sintaxe clara) ✅** · **🐛 3 bugs de render/realce (tint do `canvas2d`, revisão do realce, raiz de pacote) ✅** · **🐛 P1 — Performance dos menus (Cut/Copy/Paste implementados, menu simplificado) ✅** · **P3#10 — Plugin host (entry point + wiring + bridging) ✅** · **P3#15 — Soft wrap (wrap de linha visual, quebra oportunista) ✅** · **P4#16 — LSP Client (servidores builtin: TypeScript, Python; diagnóstico, completação, hover) ✅** · **P3.6 — Snapshot de análise REA (8.87 MB, 3 evidências) ✅** · **P4#17 — Diagnósticos no gutter (ícones de severidade na faixa de linha) ✅** · **P4#18 — Go-to-definition (F12/Ctrl+click) ✅** · **P4#19 — Signature help (popup ao digitar `(`) ✅** · **P4#20 — Document symbols (Ctrl+Shift+O, popup com filtro) ✅** ·
**🐛 LSP TypeScript: initializationOptions.tsserver.path injetado no boot ✅** ·
**🐛 Plugin host UnhandledPromiseRejection: try/catch no postMessage + .catch() órfão ✅** ·
**⚡ Tokenização: cache incremental (diff de linhas, trunca só da 1ª alterada) ✅** ·
**📊 Performance profiling: startup 203ms, render 280 FPS, memória 15.4 MB, zero leaks ✅** ·
**⚡ Input latency: resultado rico do `document.insert` elimina 2/3 IPC roundtrips por tecla ✅** -
(insert retorna `{revision, text, canUndo, canRedo}` — mata `bridge.text()` e `refreshUndoStatus()`) ·
**⚡ Batching de teclas (Fase B): keystrokes aplicados localmente (0 latência) e enviados como
lote no próximo rAF — transação única, 1 revisão, 1 `document.changed` ✅** ·
**🔍 Minimap Hover Preview: tooltip com código real e syntax highlighting ao passar o mouse
no minimap — "lupa" estilo VS Code ✅** ·
**🎯 Minimap Avançado — syntax colorida no canvas + marcadores de busca + diagnóstico ✅** ·
**🔧 P3.5 — Rizin provisionado ✅ · 🔬 Análise via Rizin concluída ✅** ·
**⚡ P2.4b — Tokenização em worker com deadline (TaskKind syntax, SerializedGrammar, SYNC_SYNTAX_THRESHOLD=50) ✅** ·
**🧩 P5 — Code Actions (Ctrl+.) ✅ · P5 — Find References (Ctrl+Shift+F12) ✅ · P5 — Rename Symbol (F2) ✅ · P4#24 — LSP Formatting (Ctrl+Shift+I) ✅ · P4#25 — Folding ✅ · P4#26 — Inlay Hints ✅ · 🌐 Multi-root workspace ✅ · 🐙 Git blame na status bar ✅ · 🐙 Git diff indicators no gutter ✅** ·
**🧩 DAP (Debug Adapter Protocol) — sessão de depuração Python (debugpy), breakpoints no gutter, painel de pilha/variáveis/saída, F5/F9/F10/F11 ✅** ·
**📝 Snippets avançados (P4#18b) — placeholders aninhados, ciclagem de tab stops (Tab/Shift+Tab), espelhos ao vivo e transformações `${N/re/fm/fl}` ✅** ·
**🧩 DAP — expansões (P4#27): breakpoint condicional (`condition`), watch expressions, hover de valor na parada e caret seguindo a parada ✅** ·
**🐛 3 bugs de contrato (paleta de comandos vazia, deadlock do `launch` no DAP, LSP quebrando a abertura de arquivos) ✅**<br>

**✅ Passo operacional resolvido (2026-10-16).** O `setup.py` foi rodado e o MCP `rea` foi relançado
**já com `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000`** (confirmado em `/proc/*/environ`) — **não** é mais
preciso reiniciar o opencode manualmente. Para reproduzir numa máquina nova:

```bash
cd /home/gbortolas/ai/workspaces/sublime-rea
python3 setup/setup.py        # idempotente: reescreve setup/env.sh + environment do MCP rea
```

Sem o deadline maior, `open_binary`/`analyze` **via MCP** volta a estourar os 330 s (a análise leva
~355 s).

**Próximas tarefas:**

> A sessão de 2026-10-21 (dia + noite) fechou: **varredura de usabilidade** (7 bugs + o crash que
> matava o app), **3 features** (lupa colorida, multi-cursor com undo por cursor, snippets com
> escolhas + variáveis TM), **5 features** (undo por documento, logpoints/hitCondition, soft wrap em
> rows visuais, Ctrl+D, snippets de pacote), uma **auditoria com 5 agentes** (16 bugs corrigidos,
> incluindo um **RCE** via `git diff`), o **design system** da casca (contraste AA, tema claro com
> degraus) e **3 features de última geração** (⌘P/Quick Open, sticky scroll, grep na workspace) —
> e, no caminho, o **LSP de verdade** (o TypeScript estava **sem diagnóstico nenhum**).
> Detalhes: [§🐛 Varredura](#-varredura-de-usabilidade-2026-10-21), [§✨ 5 features](#-5-features-2026-10-21-madrugada),
> [§🎨 Design system](#-design-system--3-features-de-última-geração-2026-10-21-noite).

1. **🧩 DAP — salvar antes de depurar** — o debuggee roda o arquivo **do disco**: com buffer não
   salvo, o depurador para em código diferente do que o editor mostra (sem aviso).
   `src/core/dap/dap-manager.ts` (`buildLaunchArgs`).
2. **🧩 DAP — adaptador Node** (`vscode-js-debug`) — exige download/empacotamento; **decidir antes**.
3. **📝 Snippets** — expansão de snippets **LSP** (`insertTextFormat: 2`) no popup de completação;
   ler `scope` do formato Sublime; `.sublime-completions` (hoje só `.sublime-snippet`).
4. **🔍 Grep** — hoje é **literal** e insensível a acento só na forma pré-composta; falta **regex**
   (o contrato `SearchQuery` já tem), a opção de ignorar binários por padrão e a busca em
   arquivos **não versionados**.
5. **⌘P** — a "workspace" é a pasta dos documentos abertos até a raiz `.git`; falta usar a pasta
   do **projeto aberto** (multi-root) e o fuzzy com **path completo** na pontuação.
6. **🖥️ Folding × soft wrap** — o `VisualRowIndex` não conhece linhas colapsadas ⇒ uma linha
   dobrada que quebra desalinha a contagem de rows (limitação declarada).
7. **🪟 Split editor** (⌘\) — dois grupos de abas lado a lado (ainda não existe).
8. **🧪 Test explorer** — rodar testes via LSP (`workspace/executeCommand` + `testing/*`).

> ✅ **Pegadinha resolvida (2026-10-16, P3.9):** o `setup.py` agora **detecta** um JDK ≥ 21
> compatível (`JAVA_HOME`, PATH, sdkman, `/usr/lib/jvm`) e escreve um **`export JAVA_HOME=…` ativo**
> no `env.sh` gerado — **não** é mais preciso exportar manualmente. Basta rodar
> `python3 setup/setup.py` (idempotente) e depois `set -a; . ./setup/env.sh; set +a`. Verificar com
> `rea doctor --client opencode --provider ghidra --format json` → espera `healthy: true`
> (verificado em 2026-10-16 sem nenhum export manual).

> ⚠️ **Pegadinha desta sessão (2026-10-21):** o **AppImage só é confiável se for testado com
> `env` limpo** (`env -i PATH=/usr/bin:/bin HOME=$HOME xvfb-run -a ./release/Scribe-*.AppImage
> --no-sandbox`) — no shell do dev o `PATH` tem o nvm e **esconde** bugs de boot (foi assim que
> passou um `ReferenceError` de zona morta temporal e o LSP "sem diagnóstico" — o primeiro só
> apareceu no AppImage, o segundo só com um **arquivo com acento/emoji**).

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

## 🎨 Fase 3.4 — Repaginação da UI + 3 bugs de render/realce (2026-10-17)

**Pedido do usuário:** *"o app tá meio capenga, temos que trabalhar o design, deixar mais elegante e
moderno"* → direção escolhida por ele: **moderno tipo VS Code**. Escopo aceito: mexer no DOM/layout.

### O que mudou (design)

- **Casca VS Code-like**: `#app` = grid [workbench | status bar]; `#workbench` = [activity bar 48 |
  painel lateral 240 | área do editor]; `#editor-area` = [tabs | breadcrumbs | stack do editor].
  Painel colapsado **devolve a largura** ao editor (`grid-template-columns: var(--s-activitybar-w) auto
  minmax(0, 1fr)` + `#editor-area { grid-column: 3 }` + canvas absoluto — era o bug de `w736` fixo).
- **`EditorTheme` = fonte única** das cores da UI, espelhada em custom properties `--s-*` por
  `applyChromeTheme()` (`src/renderer/main.ts`); estados derivados por `color-mix(in srgb, var(--s-fg)
  N%, transparent)`; paletas **Dark/Light Modern** (`src/shared/themes.ts` + 5 chaves novas em
  `theme-contract.ts`: `accent`, `activityBar`, `sidebar`, `statusBar`, `border`).
- **`loadTheme()`** persiste só `{name, kind}` e reidrata o builtin (paleta velha não congela no
  `sessionStorage`). Ícones **SVG inline** (herdam `currentColor`; não são atingidos pela CSP).
  **Minimap** recebe as cores do tema (`MinimapDeps.colors()`). Undo/redo da status bar viraram
  **botões reais** (`handleMenuAction("edit.undo"/"edit.redo")` — antes eram enfeite sem handler).
- Rail só com o que existe de fato: Explorer (`Ctrl+B`), Search, Palette, toggle de tema
  (`#theme-toggle`, saiu da status bar).

### Os 3 bugs (todos pré-existentes, todos com efeito visível)

1. **`Canvas2DBackend` nunca tingia os glifos** — `atlas.ts` guarda **tinta branca + alpha** ("o backend
   aplica a cor") mas `drawGlyph` só aplicava `globalAlpha`; o RGB da instância era ignorado. Efeito:
   **toda** a coloração de sintaxe invisível no backend **default** (`DEFAULT_RENDER_BACKEND =
   "canvas2d"`) e texto **invisível** no tema claro (branco sobre branco). Correção: interface
   `GlyphTinter` injetada (`canvas2d-backend.ts`) + `createAtlasTinter()` no renderer (1 cópia tingida
   por RGB, recortada à faixa viva `atlas.usedHeight` em blocos de 256 px, `source-in` preserva o
   alpha); `clear()` no toggle de tema.
2. **Realce pedido com a `source` do boot** — o closure de `requestHighlight` lia
   `source.revision` (fonte da demo, revisão **0**) enquanto a sessão aberta tem a fonte da sessão
   (revisão **1**, reinicia por documento): `HighlightStore.set()` descartava **toda** resposta por
   revisão diferente e re-pedia para sempre (o teto de retentativas nunca contava). Correção:
   `activeSource()` = `controller?.current?.source ?? source` (`src/renderer/main.ts`).
3. **`packageRoots` apontava para `assets/grammars`** — o `FileSystemResourceScanner` só desce em
   **diretórios** (cada raiz é um *contentor de pacotes*) e ignora arquivos soltos na raiz ⇒ a
   gramática de brinde **nunca era registrada** e `syntax.highlight` respondia sempre sem spans
   (degradação silenciosa: tudo na cor default). Correção: raiz = `join(appPath, "assets")` ⇐ pacote
   `grammars` (`src/main/index.ts`; função **exportada** para teste de regressão).

### Verificação

- Gates: `typecheck`/`lint`/`build` exit 0 · **449 testes / 44 arquivos** (baseline 443; +6: `usedHeight`,
  4 de tingimento no `canvas2d`, 1 de regressão da raiz de pacote em `test/syntax-highlight.test.ts`).
- **Visual por CDP** (`Page.captureScreenshot`, sem window manager): layout exato (rail `48`, painel
  `240`, status `h22`, dpr 1.25), colapso do painel → `editor-area x48 w976`, troca de tema mudando
  casca + canvas + minimap juntos, e **cores de sintaxe** confirmadas por histograma do canvas
  (`#926C95` keyword, `#94715F` string, `#99B9D0` variável, `#6a9955`/`#008000` comentário) nos dois temas.
- Script de verificação: `/tmp/opencode/cdp4.mjs` (aceita porta e caminho do arquivo; abre `?file=`,
  fotografa dark/light). App: `electron . --no-sandbox --remote-debugging-port=9333` (a porta 9222 é
  do Chrome do usuário).

### Residual declarado (para a próxima sessão)

- **Não reservamos largura do minimap** (fora de escopo) — o texto passa por baixo dele.
- O **modo demo** (sem `?file=`) não tem gramática nem sessão ⇒ sem realce, por construção.
- A gramática de brinde só cobre a extensão **`.demo`** (`assets/grammars/scribe-demo.sublime-syntax`) —
  abrir um `.ts` **não** tem realce (não é bug, é a gramática de brinquedo).
- `MAX_TOKENIZE_LINE_LENGTH = 4096` e o custo O(`end`) da tokenização continuam como já documentado
  (§P2.4b residual): o teto é por linha, não por documento.
- **Pendência de git**: nada foi commitado — a árvore mistura o trabalho desta sessão com WIP do
  usuário (ver **🗂️ Estado do repositório**).

### P1 — Performance dos menus (2026-10-17)

**Diagnóstico:** a "lentidão" reportada era **UX falsa** — o menu tinha:
- 3 ações **no-op** (Cut/Copy/Paste): clicar e nada acontecer → sensação de "travado"
- Menu **Selection** inteiro redundante (só `Select All`, já presente no Edit)

**O que foi feito:**
- **Implementou Cut/Copy/Paste** via `navigator.clipboard.writeText/readText` com fallback silencioso
- **Removeu o menu Selection** (4 seções: File, Edit, Find, View)
- Copy: lê a seleção do `session.source.text` e escreve na clipboard
- Cut: copy + deleta a seleção via `controller.replaceText`
- Paste: lê da clipboard e insere na posição do caret (ou substitui a seleção)

**Verificação:** typecheck/test/build exit 0 · **449 testes / 44 arquivos** · commit `5392724`

---

## 🗃️ P3.6 — Snapshot de análise do REA (2026-10-18)

Gerado snapshot da análise do binário alvo com o REA (provider ghidra) após rodar as ferramentas
MCP: `binary_overview`, `inspect_binary_layout`, `list_strings` e `list_procedures`.

**Resultado:** snapshot de **8.87 MB** em `docs/analysis/snapshot.json` contendo **3 evidence records**
(layout, overview, strings) + **1 workflow entry**. Pode ser reutilizado em sessões futuras:

```bash
rea open-binary target/sublime_text/sublime_text --snapshot-path docs/analysis/snapshot.json
```

**Limitações conhecidas:** o Ghidra sempre re-analisa o binário (análise leva ~355 s) — o snapshot só
acelera as ferramentas MCP (layout, strings, overview). O projeto Ghidra persistente (171 MB, Track B)
continua sendo o melhor método para evitar re-análise completa.

---

## 🎯 P4#17 — Diagnósticos no gutter (2026-10-18)

Após a implementação do LSP Client (P4#16), os diagnósticos já apareciam como *squiggly underlines*
no texto. Agora também aparecem **ícones de severidade na faixa do gutter** (à esquerda dos números
de linha), no estilo de IDEs modernas (VS Code, IntelliJ).

### O que foi feito

Modificação no `renderDiagnostics()` em `src/renderer/main.ts`:
- Agrupa diagnósticos por linha e exibe o ícone da **maior severidade**
- **Error** → círculo vermelho com X (⊖)
- **Warning** → triângulo âmbar com !
- **Info** → círculo azul com "i"
- **Hint** → bolinha cinza
- Posicionamento centralizado verticalmente no gutter, à esquerda dos números de linha
- Extrai o helper `diagColor()` para evitar repetição do switch/case

### Verificação

- Gates: `typecheck`/`lint`/`build` exit 0 · **519 testes / 50 arquivos**
- Baseline de testes inalterado (só mudança de render, sem nova lógica testável isoladamente)

---

## 🗃️ P3.6 — Snapshot de análise do REA (2026-10-18)

Gerado snapshot da análise do binário alvo com o REA (provider ghidra) após rodar as ferramentas
MCP: `binary_overview`, `inspect_binary_layout`, `list_strings` e `list_procedures`.

**Resultado:** snapshot de **8.87 MB** em `docs/analysis/snapshot.json` contendo **3 evidence records**
(layout, overview, strings) + **1 workflow entry**. Pode ser reutilizado em sessões futuras:

```bash
rea open-binary target/sublime_text/sublime_text --snapshot-path docs/analysis/snapshot.json
```

**Limitações conhecidas:** o Ghidra sempre re-analisa o binário (análise leva ~355 s) — o snapshot só
acelera as ferramentas MCP (layout, strings, overview). O projeto Ghidra persistente (171 MB, Track B)
continua sendo o melhor método para evitar re-análise completa.

---

## 🧩 P4#16 — LSP Client (2026-10-18)

**Pedido do usuário:** continuar os trabalhos no Scribe — a próxima fronteira natural era conectar
a servidores LSP (Language Server Protocol) para oferecer **diagnósticos, completação e hover**
para TypeScript e Python.

### O que foi entregue

**Módulo `src/core/lsp/`** (novo, 4 arquivos + 4 testes):

| Arquivo | Papel |
|---|---|
| `lsp-protocol.ts` | Tipos JSON-RPC 2.0 + LSP (subconjunto mínimo: Position, Range, Diagnostic, CompletionItem, Hover, InitializeParams, ServerCapabilities, guards de tipo) |
| `lsp-transport.ts` | Transporte stdio com framing `Content-Length`, `MessageBuffer` (lida com chunks fracionados, múltiplas mensagens, cabeçalhos extras), ciclo de vida do processo (SIGTERM → SIGKILL 3s) |
| `lsp-client.ts` | Cliente JSON-RPC: `connect` (initialize/initialized handshake), `sendRequest` (correlação id→deferred com timeout de 15s), `sendNotification`, `onNotification` handler, `onDiagnostics` evento canônico, `disconnect` (shutdown+exit) |
| `lsp-manager.ts` | Gerente de ciclo de vida: `startServer(config)` cria transporte+cliente+handshake, roteia operações de documento (open/change/close) e pedidos de linguagem (completion/hover) pelo servidor adequado por extensão |

**Contratos compartilhados** (`src/shared/lsp-contract.ts` novo):

- `LspServerConfig` — comando, args, env, languageId, languages (extensões)
- `BUILTIN_LSP_SERVERS` — **TypeScript** (`typescript-language-server --stdio`) e **Python** (`pyright-langserver --stdio`)
- `LspDiagnostic` / `LspCompletionItem` / `LspHoverResult` — resultados simplificados que cruzam o IPC
- `LspConnectionState` / `LspSettings` — estado de conexão e configuração futura

**Fiação no editor** (`src/core/editor/editor-core.ts`):

- `attachLsp(manager)` — associa o LspManager e reabre todos os documentos já abertos
- `requestCompletions` / `requestHover` — delega ao manager com conversão de tipos internos → contratos
- `documentDiagnostics` — cache de diagnósticos por URI
- `findHandleByUri` — resolve URI `file://` para handle do documento
- Notificações LSP automáticas: insert → `didChange`, replaceText → `didChange`, undo/redo → `didChange`, openDocument → `didOpen`, replaceAll → `didChange`

**Main process** (`src/main/index.ts`):

- Cria `LspManager` com `BUILTIN_LSP_SERVERS`
- Inicia cada servidor em paralelo com `Promise.allSettled` + try/catch (servidor ausente = warn, não crash)
- Broadcast de diagnósticos: `onDiagnostics` → resolve handle → `IpcEventEnvelope<"lsp.diagnostics">`
- Associa o manager ao core **após** todos os servidores tentarem iniciar

**Preload** (`src/preload/index.ts`):

- `completions(handle, line, col)` → `lsp.completions`
- `hover(handle, line, col)` → `lsp.hover`
- `onDiagnostics(callback)` → escuta `lsp.diagnostics` event

**Renderer** (`src/renderer/`):

- `completions.ts` (novo) — Popup DOM com ícones por kind (method/função/variável/propriedade/keyword/snippet/classe/módulo/interface/enum), navegação setas/Enter/Tab/Esc, fallback silencioso
- `hover-tooltip.ts` (novo) — Tooltip com formatação markdown (code/bold/italic), posicionamento adaptativo, auto-hide 8s, fallback silencioso
- `main.ts` — Squiggly underlines por severidade (error=red, warning=amber, info=blue, hint=gray); **Ctrl+Space** → popup de completação posicionado no cursor; **Ctrl+hover** → tooltip de hover com debounce de 300ms; diagnóstico ativo por handle; fallback de widgets LSP se DOM ausente
- `index.html` — Elementos `#completion-popup` + `#hover-tooltip`
- `index.css` — Estilos completos (borda, sombra, cores do tema via `--s-*`, radius, spacing)

**IPC contract** (`src/shared/ipc-contract.ts`):

- Métodos novos: `lsp.completions`, `lsp.hover`, `lsp.diagnostics`
- Evento novo: `lsp.diagnostics`

### Limitações declaradas

- Servidores LSP precisam estar no `$PATH` — se ausentes, são ignorados com warn
- Completação envia o **texto inteiro** do documento (`full document sync`), não incremental
- O squiggly underline é um zig-zag simples (não uma ondulação real tipo wavy)
- Hover tooltip não tem suporte a links clicáveis nem syntax highlighting no markdown
- Diagnósticos não aparecem no gutter (só squiggly no texto)
- Não há suporte a `textDocument/signatureHelp`, `textDocument/documentSymbol`, `textDocument/references`, `textDocument/definition`, `textDocument/codeAction` — só completion e hover

### Verificação

- Gates: `typecheck`/`lint`/`build` exit 0 · **519 testes / 50 arquivos** (baseline 449; +70: 4 arquivos de teste LSP com 55 testes, +15 de integração)
- Os 4 novos test files (`lsp-protocol.test.ts` 16 testes, `lsp-transport.test.ts` 14, `lsp-client.test.ts` 10, `lsp-manager.test.ts` 15) cobrem: guards de tipo JSON-RPC, framing Content-Length (mensagens completas/fracionadas/múltiplas/cabeçalhos extras), connect/send/disconnect, request/response correlação, timeout, notificações, handler com disposable, `onDiagnostics`, shutdown/exit, manager com 2 servidores, roteamento de operações de documento, completion/hover routing

---

## ⚡ Input latency — Fase A: resultado rico do `document.insert` (2026-10-18)

**Diagnóstico (confirmado por análise de fluxo):** cada tecla imprimível fazia **3 IPC
roundtrips** (insert → text → undoState), cada um lendo o buffer inteiro via JSON serialization.
Em documentos grandes, isso explica os 16.5 ms/tecla.

**O que foi feito:** o `document.insert` e `document.replaceOne` agora devolvem um resultado
rico (`DocumentInsertResult`) contendo `{revision, text, canUndo, canRedo}` em vez de só revision:

- **Antes:** `insert` (IPC #1) → `text` (IPC #2) → `undoState` (IPC #3) = **3 roundtrips**
- **Depois:** `insert` (IPC #1, retorna tudo) = **1 roundtrip** (redução de 66%)

**Alterações pontuais:**

| Camada | Mudança |
|---|---|
| `src/shared/ipc-contract.ts` | Novo `DocumentInsertResult` + `DocumentChangedEvent.origin?` |
| `src/core/editor/editor-core.ts` | `runInsert`/`runReplaceOne` retornam `DocumentInsertResult` com texto+undo |
| `src/main/index.ts` | Dispatch passa resultado rico (tipo flui) |
| `src/preload/index.ts` | `insert()`/`replaceOne()` retornam `DocumentInsertResult` |
| `src/renderer/main.ts` | `insertText`: usa `result.text` → elimina `bridge.text()`; usa `result.canUndo/Redo` → elimina `refreshUndoStatus()`. `onDocumentChanged`: pula revisão já aplicada (`source.revision >= event.revision`). **Todas** as chamadas de `replaceText` (snippet, backspace/delete) também usam resultado rico. |

### Verificação

- Gates: `typecheck`/`lint`/`build` exit 0 · **520 testes / 50 arquivos** (baseline 519)
- Retoques nos testes que comparavam `insertText` como número (`after.revision`)

### ✅ Fase B — Batching de teclas (2026-10-18)

**Antes (mesmo com Fase A):** cada caractere digitado fazia 1 IPC roundtrip (`document.insert`).
Em digitação rápida (>60 keystrokes/s), o roundtrip acumulado podia travar.

**Depois:** keystrokes são **aplicados localmente** via splice de string (zero IPC, latência zero)
e acumulados num buffer. No próximo `requestAnimationFrame`, o buffer é enviado como lote único
via `document.batchInsert` — o main aplica tudo como **transação única** (1 revisão, 1 evento
`document.changed`, 1 passo de undo).

**Alterações pontuais:**

| Camada | Mudança |
|---|---|
| `src/shared/ipc-contract.ts` | `document.batchInsert` no `IpcMethods` |
| `src/core/editor/editor-core.ts` | `runBatchInsert` com `coalesceDocumentChanges`; interface + implementação |
| `src/main/index.ts` | Dispatch para `document.batchInsert` |
| `src/preload/index.ts` | `batchInsert()` na ponte |
| `src/renderer/main.ts` | `DocumentController.pendingBatch` + `flushBatch()` + `scheduleBatchFlush()`. `insertText` aplica splice local e acumula. Flush automático antes de: `replaceText`, `runHistory` (undo/redo), `save`, `open`, `close`, `activate`, snippet expansion. |

### Verificação

- Gates: `typecheck`/`build` exit 0 · **520 testes / 50 arquivos** (mesmo baseline)
- Auto-pair continua enviando par como uma entrada do lote (2 chars, 1 posição)
- Navegação local (setas, home/end, pgup/dn) não é afetada
- Fallback em caso de falha do batch: lê o documento inteiro para recuperar consistência

### Resumo da latência de digitação (antes → depois)

| Fase | IPC/tecla | Latência estimada | Técnica |
|---|---|---|---|
| Original | **3 roundtrips** | ~16.5 ms | insert + text + undoStatus |
| Fase A | **1 roundtrip** | ~5.5 ms | resultado rico do insert |
| **Fase B** | **0 roundtrips*** | **~0 ms** | aplicação local + batching em rAF |

*Zero roundtrips durante a digitação. O lote é enviado no próximo frame de rAF, que tipicamente
acontece ~16 ms depois — mas não bloqueia a tecla seguinte. A latência *percebida* cai para virtualmente zero. O main reconcilia em background.

---

## 🔍 Minimap Hover Preview (2026-10-18)

**O que é:** ao passar o mouse sobre o minimap, um tooltip aparece mostrando o código-fonte
real em **tamanho legível com syntax highlighting** — tipo a "lupa" do VS Code.

**Como funciona:**

1. `mousemove` no canvas do minimap → calcula a linha sob o cursor
2. Mostra preview **imediato** com texto puro (sem realce, latência zero)
3. Dispara requisição `syntax.highlight` (debounce de 100 ms) para o range de ~7 linhas
4. Quando a resposta chega, substitui o tooltip com **HTML colorido** (`<span style="color:#xxx">`)
5. Cacheia o resultado — se o mouse volta para o mesmo range, usa cache

**Arquivos alterados:**

| Arquivo | Mudança |
|---|---|
| `src/renderer/minimap.ts` | `attachMinimapHover()` — tooltip DOM com posicionamento, `buildColoredContent()` com `rgbaToHex()`, debounce, cache |
| `src/renderer/main.ts` | Fiação: cria `attachMinimapHover` com `bridge.highlight`, `syntaxTheme`, `TEXT_STYLE` |

**Limitações declaradas:**
- Preview sem realce enquanto a requisição de highlight não chega (~100ms debounce + IPC)
- O tooltip não segue o mouse verticalmente depois de mostrado (fica fixo até próximo hover)
- Sem suporte a teclas de atalho para fixar o preview

---

---

## 🧩 DAP — Debug Adapter Protocol (2026-10-20, feature finalizada)

A feature estava **WIP não commitado** no working tree (core + main + preload prontos, renderer
sem fiação, zero testes). Esta sessão a **finalizou ponta a ponta**.

### O que é

Depuração de arquivo único no Scribe via **DAP** (padrão da Microsoft, *não* observado no alvo —
escolha nossa, escopo fora do RE). Adaptador embutido: **Python via debugpy**
(`python3 -m debugpy.adapter`); ausente no PATH ⇒ warn, nunca fatal.

### O que já existia (WIP) vs. o que esta sessão entregou

| Camada | WIP (já pronto) | Esta sessão |
|---|---|---|
| `src/core/dap/` | protocolo, transporte stdio, cliente, manager (4 arquivos) | **4 arquivos de teste** (44 testes) |
| `src/main/index.ts` | dispatch `dap.*`, menu Debug, broadcast de eventos | — |
| `src/preload/index.ts` | 19 métodos/escutas `dap*` | — |
| `src/shared/dap-contract.ts` | contratos + `BUILTIN_DAP_SERVERS` | — |
| `src/renderer/debug-panel.ts` | painel "burro" (toolbar + pilha + variáveis + saída) | fix TS6133 |
| `src/renderer/main.ts` | **nada** | **fiação completa** |
| `src/core/render/scene.ts` | — | **bolinha de breakpoint no gutter** (`breakpointLines`, `●` vermelho `#E51400`) |

### Fiação do renderer (`src/renderer/main.ts`)

- `ScribeBridge` ganhou 15 métodos + 4 escutas `dap*` (**todos opcionais** — preload antigo
  simplesmente não expõe, padrão de `highlight`/`blame`).
- `ScribeRenderer.setBreakpointLines()` — bolinhas no gutter, repintadas ao abrir/ativar
  documento (`fetchDebugBreakpoints`, chamada em `openDocument` e `activate`, como o git diff).
- **`createDebugView()`** fiado: `onAction` → chamadas IPC; `onScopesRequest`/`onVariablesRequest`
  → carga on-demand das variáveis; eventos `dap.state`/`dap.stopped`/`dap.output`/`dap.breakpoints`
  → atualiza painel, `debugThreadId` (do último `stopped`, fallback `dapThreads()[0]`) e espelho
  local de breakpoints (`debugBreakpoints`, **fonte da verdade no main** — persiste entre sessões).
- **`handleDebugAction("start")` é contextual (F5):** parado ⇒ continuar; inativo/terminado/erro
  ⇒ nova sessão para o documento ativo.
- `handleMenuAction`: cases `debug.start/continue/pause/stop/stepOver/stepInto/stepOut/toggleBreakpoint`.
- **F9** toggle de breakpoint na linha do caret (via menu; `dapSetBreakpoints` persiste no main).

### 🐛 Contrato travado pelo teste (achado)

`DapClient.dispose()` **quebrava** com um transporte fake que devolvia a função de unsubscribe
crua (`item.dispose is not a function`). **Conclusão:** o `Event<T>` do Scribe
(`src/shared/events.ts`) devolve um **Disposable** (objeto com `.dispose()`), não `() => void` —
fakes de transporte devem conformar a esse contrato. O código de produção estava correto; o
teste é que foi alinhado (e agora trava o contrato).

### Limitações declaradas

- Só **Python/debugpy** embutido (Node dependente de `vscode-js-debug` no PATH — adiado).
- Uma **sessão por vez** (`DAP_SESSION_ACTIVE`).
- Sem *conditional breakpoints*, *watch*, *hover-inspect* de variáveis, *hot reload*.
- Requisições reversas do adaptador (`runInTerminal`) respondem `success: false` explicitamente.
- Parada de execução não move o caret para a linha do frame (navegação via painel apenas).

### Verificação

- Gates: `typecheck`/`lint`/`build` exit 0 · **587 testes / 54 arquivos** (baseline 543/50; +44
  DAP: protocolo 5 · transporte 10 · cliente 15 · manager 14, com **auto-responder** de handshake
  no teste do manager — elimina a race de respostas órfãs).
- `package-lock.json` sincronizado com o bump 0.4.0 (ficara pendente do release); `graft/`
  (cache do grafo de código) ignorado no `.gitignore`.

---

## 📝 Snippets avançados — P4#18b (2026-10-20, tarde)

Expansão do P4#18 existente (que só tinha `$N`, `${N:default}` e caret no 1º tabstop).

### O que mudou

| Camada | Entrega |
|---|---|
| `src/renderer/snippets.ts` (**reescrito**, puro) | AST com **aninhamento** (`}` balanceado, `\}`), **escolhas** `${N\|a,b,c\|}` (default = 1ª), **transformações** `${N/regex/format/flags}` (split nos 1º e último `/` não-escapados, regex inválida degrada com 1 `warn`), `$$`/`$0`/multi-dígito, `${FOO}` → literal; **espelhos renderizados na expansão inicial** (antes saíam vazios); saída `occurrences` (com `id`/`parentId`/`isPrimary`/`transform`) + `visitOrder` |
| `src/renderer/snippet-session.ts` (**NOVO**, puro) | Sessão imutável: `createSnippetSession`, `nextTabStop`/`previousTabStop` (Tab/Shift+Tab; `$0` encerra), `applyEdit` → desloca offsets + re-renderiza **espelhos** e **ancestrais** (aninhamento via cadeia `parentId`, não por sobreposição de ranges) devolvendo `updates` (1 roundtrip por espelho, **ordem = ordem de aplicação**) |
| `src/renderer/main.ts` | `snippetSession` no `DocumentSession`; Tab com sessão cicla e **seleciona** a parada; Esc/mousedown fora/troca-aberta/undo-redo encerram; `insertText` com sessão **bypassa o splice local** (caminho IPC imediato — coerência dos espelhos > latência zero, só dentro de sessão); `propagateSnippetEdit()` em `replaceText` aplica os `updates` e ajusta o caret por espelho anterior |
| Testes | `test/renderer-snippets.test.ts` (20) + `test/renderer-snippet-session.test.ts` (19) |

### Verificação

- Gates: `typecheck`/`lint`/`test`/`build` exit 0 · **626 testes / 56 arquivos** (baseline 587/54).
- **E2E real via CDP** (`/tmp/opencode/cdp-snippet.mjs`, `xvfb-run` + `Input.dispatchKeyEvent`):
  **8/8 expectativas** no app aberto — expansão com espelhos (`i`×3), espelho ao vivo (`j`),
  edit do `$2`, encerramento em `$0`, 2ª sessão, substituição de parada, **Shift+Tab retrocede**,
  **Esc** encerra e a tecla seguinte é texto normal.

### Limitações declaradas

- Sem dropdown de escolhas (usa a 1ª); sem variáveis TM (`$FOO` fica literal); sem modificadores
  de caso no format; edição manual dentro de um **espelho** encerra a sessão; mudanças externas
  (LSP/extensão) durante a sessão não rastreadas; seleção multi-cursor não realinhada quando um
  espelho anterior desloca o caret.

### Achados de ambiente desta sessão (já corrigidos no `setup.py`)

- **`node` do nvm era v14** (default) → `npm`/`rea` não existiam no shell não-interativo; o
  `env.sh` agora **exporta o `PATH` do bin detectado** (idempotente).
- **Tarball do Rizin é "flat"** (`bin/` na raiz, sem wrapper `rizin-v0.9.1/`) → o fallback
  antigo pegava `candidates[0]` = `bin` (ordem alfabética) e instalava os binários soltos; agora
  a busca é pelo diretório que **contém `bin/rizin`**.
- **`opencode.jsonc` tem schema novo** (`mcp.rea`, sem `mcp.servers.`) → `_jsonc_set_rea_env`
  silenciava com warn e o **`_MCP_ENV_HINTS` sem a chave `REA_RIZIN_COMMAND` derrubava a etapa
  com `KeyError`** (o `rea doctor` nunca rodava). Agora aceita ambos os schemas.
- Para rodar `npm`/`rea` manualmente: `set -a; . ./setup/env.sh; set +a` **já basta** (passa a
  incluir o `PATH` do node 24).

---

## 🧩 DAP — expansões (P4#27, 2026-10-20, noite)

O item #1 do backlog anterior. Fecha três das limitações declaradas na entrega do DAP
(*conditional breakpoints*, *watch expressions*, *hover-inspect de variável parada*) e **corrige
3 bugs de contrato** que o E2E expôs.

### O que foi entregue

| Camada | Entrega |
|---|---|
| `src/shared/dap-contract.ts` | `DapBreakpointSpec` (`line` + `condition`/`hitCondition`/`logMessage`), `DapEvaluation`, `DapEvaluationContext`; `DapBreakpoint` ganhou `condition?` |
| `src/core/dap/dap-breakpoints.ts` (**novo**, puro) | `normalizeBreakpointSpecs()` (aceita números **ou** specs; descarta linha inválida/duplicata; tetos: 500 bps, condição 512, hitCondition 64, logMessage 512) e `toSourceBreakpoints()` (protocolo) |
| `src/core/dap/dap-protocol.ts` | `DapSourceBreakpoint`, `DapEvaluateResponseBody` |
| `src/core/dap/dap-manager.ts` | guarda **specs** (não só linhas); `evaluate(expressão, frameId, contexto)` com **cadeia de fallback** (pedido → `watch` → `repl`); handshake do `launch` corrigido (abaixo) |
| `src/main/index.ts` | `dap.setBreakpoints` aceita números **ou** specs; `dap.breakpoints` devolve **specs**; `dap.evaluate` **novo** (falha ⇒ `null`, nunca derruba a UI) |
| `src/preload/index.ts` | `dapSetBreakpoints(specs)`, `dapBreakpoints() → specs`, `dapEvaluate()` |
| `src/renderer/debug-panel.ts` | seções **Breakpoints** (campo de condição por linha, persistente — não perde o foco) e **Observação** (watch: input + valores + remover + reavaliar) + **tooltip de valor** (`#debug-value-tooltip`) |
| `src/renderer/debug-inspect.ts` (**novo**, puro) | `extractExpressionAt()` (identificador/caminho pontilhado sob o cursor) e `DebugWatchModel` (lista de observações: dedupe, teto 20, teto 200 chars) |
| `src/renderer/main.ts` | watch reavaliado a cada parada; **hover de valor** (contexto `hover`); **caret segue a linha da parada**; painel sincroniza os breakpoints ao abrir; comandos `debug.*` na paleta |
| `src/core/editor/editor-core.ts` | 5 comandos `debug.*` na paleta de comandos (caminho testável + UX) |
| `src/core/lsp/lsp-manager.ts` | **bug**: servidor que falha no start sai do registro; notificações de documento não derrubam a edição |

### 🐛 3 bugs de contrato (achados no caminho)

1. **Paleta de comandos abria vazia** — o `main` devolvia o **array** puro em `command.list`, mas o
   contrato (`CommandListResult`) declara `{ commands: [...] }` ⇒ a palette lia `result.commands`
   = `undefined`. O tipo não pegou porque o retorno do dispatch é frouxo.
2. **Deadlock do handshake DAP** — o `start()` **aguardava** a resposta do `launch` **antes** de
   mandar o `configurationDone`; o debugpy responde ao `launch` só **depois** que o debuggee sobe
   (que é no `configurationDone`) ⇒ a sessão ficava presa em `starting` (30 s de timeout).
   Agora o `launch` vai sem espera, com **janela de tolerância** de 2 s para a resposta.
3. **LSP quebrava a abertura de arquivos** — cliente que **falhou** no start continuava no
   registro ⇒ `didOpen` jogava `LSP_NOT_CONNECTED` e o `document.open` **rejeitava** (arquivo
   `.py`/`.ts` não abria sem o pyright/tsserver instalado).

### Verificação

- Gates: `typecheck`/`lint`/`test`/`build` exit 0 · **709 testes / 59 arquivos** (baseline 626/56).
- Testes novos: `src/core/dap/__tests__/dap-breakpoints.test.ts` (18) · manager (+7: condição
  enviada ao adaptador, `evaluate`, fallback de contexto, regressão do handshake, warn da falha
  tardia) · `test/renderer-debug-inspect.test.ts` (43: parser de expressão, watch model,
  matemática de coluna, normalização de preload velho, merge, path tolerante) ·
  `test/ipc-handlers.test.ts` (+2: contrato do `command.list` e teto do `dap.evaluate`).
- **🔒 Correção de segurança (achado do `security`)** — `git.blame`/`git.diff` interpolavam o
  path do documento numa **string de shell** (`"${path}"` ⇒ `$(...)`/backtick expandem ⇒ abrir um
  arquivo chamado `$(id).txt` executava código no processo principal). Agora o path vai como
  **argumento** (`execFileSync("git", [...])`, sem shell) e o teste de regressão
  `test/git-shell-injection.test.ts` prova que o marcador **não** é criado.
- **E2E com o debugpy REAL** (`/tmp/opencode/cdp-dap.mjs`, `xvfb-run` + CDP): **9/9** no app
  aberto — breakpoint condicional **respeitado** (`i == 2` ⇒ parou em `i == 2`, não em `i == 0`),
  condição persistida no `main`, watch = `2`, **caret movido** para a linha 4, **tooltip de
  hover** (`n = 3 : int`).
- **E2E do core com debugpy** (`/tmp/opencode/dap-e2e.cjs`): handshake, condição, `evaluate` nos
  contextos `watch`/`hover`/`repl`, pilha, escopos e variáveis.
- **📦 AppImage**: `npm run dist` → `release/Scribe-0.4.0.AppImage` (117 MB), **aberto e testado**
  (`xvfb-run -a ./release/Scribe-0.4.0.AppImage --no-sandbox` ⇒ sobe e loga o boot).

### 🔁 Rodada de revisão (Reviewer + Security) e correções

A feature passou por **revisão estática** (Reviewer) com veredito *"aprovado com reservas"*: **14
achados** (2 altos, 3 médios, 9 baixos) — **todos corrigidos** e a re-revisão rodada depois:

| # | Sev | Achado | Correção |
|---|---|---|---|
| 1 | **alto** | hover/click/arrasto calculavam a coluna com origem fixa `x-12`, mas o texto é desenhado em `gutterWidth + 8` ⇒ avaliava 3–4 caracteres ao lado | origem única (`textOriginX`/`columnFromPointerX`, função **pura e testável** em `debug-inspect.ts`) nos 4 pontos |
| 2 | **alto** | a lista de condições do painel não estava amarrada a um documento ⇒ editar a condição do arquivo A gravava no B | o painel segue o **documento ativo** (`onActiveDocumentChanged` → ressincroniza) |
| 3 | médio | rejeição tardia do `launch` (depois da janela de 2 s) era engolida em silêncio | 1 `warn` no `DapManager` |
| 4 | médio | o merge de `onDapBreakpoints` perdia `hitCondition`/`logMessage` | `mergeBreakpointSpecs()` preserva os campos |
| 5 | médio | timer do hover não era cancelado quando a expressão virava `null` | cancelado + guarda de geração |
| 6 | baixo | `toggleDebugPanel` não tolerava preload velho (números) | `normalizeBreakpointList()` nos 2 caminhos |
| 7 | baixo | `dap.evaluate` sem teto de expressão | `MAX_EVALUATION_LENGTH = 512` (acima ⇒ `null` + warn) |
| 8 | baixo | cliente LSP que falhava no handshake não era descartado (processo vivo) | cliente + transporte descartados |
| 9 | baixo | `conditionInputs` do painel crescia sem limite e reusava input velho | entradas das linhas removidas são apagadas |
| 10 | baixo | `dapSetBreakpoints` falhando era engolido ⇒ renderer e main divergiam | 1 `warn` |
| 11 | baixo | `moveCaretToFrame` comparava path exato e ignorava a coluna | `isSameFilePath()` tolerante + coluna do frame |
| 12 | baixo | contrato IPC de `dap.setBreakpoints` não aceitava número | `readonly (number \| DapBreakpointSpec)[]` |
| 13 | baixo | F5 duplicado na paleta | "Continuar" ficou sem acelerador |
| 14 | baixo | watch avaliava em série; hover não cancelava requisições em voo | avaliação paralela + guarda de geração |

### Limitações declaradas

- `hitCondition` e `logMessage` existem no contrato e chegam ao adaptador, mas **não têm UI**
  (só `condition`).
- As expressões de observação são reavaliadas **na parada** e sob demanda (⟳) — não a cada tecla.
- O hover avalia a expressão **sob o mouse** (identificador ou caminho pontelhado); se o
  adaptador recusar a expressão, o tooltip **some** (sem mensagem de erro).
- Watch expressions vivem **na sessão do renderer** (não persistem entre janelas).
- Condição **cross-file** não é suportada (o `condition` é avaliado no contexto do frame).

### Nota de operação (E2E)

Os **aceleradores de menu** (F5/F9/Ctrl+Shift+D) vivem na camada nativa do Electron: o CDP
`Input.dispatchKeyEvent` **não** os dispara. Para E2E, use a **paleta de comandos**
(Ctrl+Shift+P → digita → Enter) — ela é manipulada pelo renderer e funciona via CDP.

---

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

## 🐛 Varredura de usabilidade (2026-10-21, noite)

O usuário reportou: *"acabei de abrir o scribe, e sinceramente tá uma zona completa e total. Nada
funciona, não dá nem pra ler o arquivo de texto que eu abri. Não dá pra editar tb. Tem popups
sobrepostos em todo lugar. Tem menus e labels com fontes estranhas em estilo frankenstein."*

**Reprodução** (CDP + screenshot, `/tmp/opencode/cdp-doctor.mjs`): o app abria com o **painel de
depuração e o popup de referências por cima do texto**, as **linhas quebradas se sobrepunham**
(texto ilegível), o **minimap** era uma coluna de **blocos cinzas**, e os **botões caíam no Arial
13.33px do UA**.

### Os 7 bugs (todos corrigidos)

| # | Sev | Bug | Causa | Correção |
|---|---|---|---|---|
| 1 | **crítico** | linhas quebradas **por cima** do texto | `scene.ts`: Y = `docLine*lh + segIdx*lh` ⇒ a continuação caía na row da linha seguinte | **rows visuais acumuladas** (`scene.ts`) + `wrapLine` canônico (early-exit "cabe tudo") |
| 2 | **crítico** | **não dava pra editar** | o teclado vive no `<canvas>` e o foco **não voltava** ao abrir/trocar documento | `focusEditorSurface()` ao abrir/ativar/fechar find bar/painel |
| 3 | **crítico** | **o app morria** ao fechar o painel de depuração | o "×" chamava `close()` → no escopo do painel resolve para o **`window.close()` global** ⇒ janela fecha ⇒ app sai (exit 0) | `openPanel()`/`closePanel()` locais |
| 4 | alto | painel de depuração + popup de referências **abertos no boot** | `display:flex` **inline** vencia o `[hidden]` do UA | `[hidden]{display:none!important}` global + `hidden` como fonte da verdade |
| 5 | alto | **fontes frankenstein** | sem `font: inherit` ⇒ UA aplica Arial 13.33px; token `--s-font` inexistente | 1 família + 1 escala para toda a casca |
| 6 | alto | minimap em **blocos cinzas** | `lineH = h/lineCount` (altura escalava) + barra de largura total | altura **fixa** (3px) + largura **proporcional** à linha |
| 7 | médio | texto por baixo do minimap; popups coexistindo; code-actions órfão | largura útil não desconta o minimap; nenhum popup fecha o outro | helper de largura útil; `closeContextPopups()`; remoção do órfão |

**Bônus** (achados no caminho): o **plugin host nunca subia** (`utilityProcess.postMessage` **não
clona** `MessagePortMain` ⇒ "An object could not be cloned" em todo boot) — o transporte passou ao
**canal nativo** (`process.parentPort`); a janela foi de 1024×768 para **1280×820**; e o
`resize()`/`paint()` do minimap pararam de **reatribuir `canvas.width`** a cada quadro (realocar o
backing store derrubava o raster).

### Verificação

- Gates: `typecheck`/`lint`/`test`/`build` exit 0 · **824 testes / 64 arquivos**.
- **E2E por CDP** (`/tmp/opencode/cdp-usable.mjs`): **10/10** — nenhum overlay indevido no boot,
  **zero** controles em Arial, digitar funciona **sem clicar antes** (o bug #2), o texto é
  pixelado no canvas, e o app **sobrevive** ao fechar o painel de depuração
  (`/tmp/opencode/cdp-panel.mjs`).

---

## ✨ 3 features (2026-10-21, noite)

### 1. 🔍 Lupa de código no minimap (o "zoom colorido" do usuário)

`src/renderer/code-loupe.ts` (novo, puro) + `minimap.ts`: ao passar o mouse sobre o minimap, um
painel flutuante **à esquerda** dele mostra **~14 linhas × 2.5×** com **cores de sintaxe**, a linha
sob o cursor destacada e o marcador do caret; **arrastar** move a lupa e rola o documento. O
minimap passou a ser **colorido** de verdade: a janela dele é o **range visível** (o mesmo que o
`HighlightStore` cobre) ⇒ os spans existem. 23 testes das funções puras.

### 2. 🖱️ Multi-cursor de verdade + undo/redo por cursor

- **shared** — `advanceSelections(selections, edits)` (regra cumulativa, **fonte única** core↔renderer);
  os 3 métodos de edição do IPC ganharam `selections?: SelectionSet` (o conjunto **antes** da
  edição) e o lote ganhou `remove?: string` por entrada.
- **core** — o `CommandBus` grava `selectionsBefore/After` no passo de undo (o `UndoStack` já
  suportava, mas **ninguém preenchia**); o `applyEdits` desloca cursores e caret; o ramo
  multi-cursor do `runInsert` foi removido (a edição passou a ser **explícita**).
- **renderer** — `insertText`/Backspace/Delete com N cursores geram N edits (ordem **descendente**
  ⇒ offsets válidos), o splice local e o lote seguem a mesma ordem, e o `runHistory` **restaura o
  conjunto de cursores** (clampado) em vez de colapsar para 1.
- 16 testes no renderer + 7 no core (round-trip undo/redo com 2 cursores).

### 3. 📝 Snippets — dropdown de escolhas + variáveis TM

`${1|a,b,c|}` passa a produzir uma **escolha** (o popup `src/renderer/snippet-choice.ts` já
existe, com setas/Enter/Esc) e `$TM_FILENAME`, `$TM_FILENAME_BASE`, `$TM_DIRECTORY`,
`$TM_SELECTED_TEXT`, `$TM_CURRENT_LINE`, `$TM_CURRENT_WORD`, `$TM_LINE_INDEX` são resolvidas na
expansão (variável desconhecida ou sem contexto fica **literal**). 29 testes novos.

> ⚠️ **Pendente:** a **fiação no renderer** (o `main.ts` ainda não chama `showSnippetChoice`).

### 3b. 📝 Fiação do dropdown no renderer (2026-10-21, noite) ✅

O `main.ts` agora monta o `SnippetVariableContext` na expansão, abre o
`showSnippetChoice` ao entrar numa parada **com escolhas**, aplica a opção escolhida
(`chooseSnippetOption` → primária → `updates` → sessão nova) e **fecha o popup** em todos os fins
de sessão (Esc, clique fora, troca de documento, undo/redo, `$0`). Dois snippets embutidos novos
tornam o caminho alcançável: `const` (com `${1|let,const,var|}`) e `file` (com `$TM_FILENAME`).

**E2E por CDP** (`/tmp/opencode/cdp-choice.mjs`): digitar `const` + Tab expande para
`const let name = value;` e abre o dropdown com `["let","const","var"]`; **seta + Enter** troca
para `const const name = value;` e o popup sai do DOM ✓.

---

## ✨ 5 features (2026-10-21, madrugada)

| # | Feature | Onde | Testes |
|---|---|---|---|
| 1 | **🗃️ Pilha de undo por documento** — a pilha era global (desfazer na aba B corrompia a A) | `core/command/undo-stack.ts` (`scopeId`, `undoDepthFor`), `command-bus.ts`, `core/editor/editor-core.ts` | +12 |
| 2 | **🧩 DAP: logpoints + hitCondition** — 3 campos editáveis no painel, badge "log", `logMessage` chega ao adaptador | `shared/dap-contract.ts`, `core/dap/*`, `renderer/debug-panel.ts` | +25 |
| 3 | **🖥️ Soft wrap em rows visuais** — caret/seleção/busca/gutter/diagnósticos na row certa; scroll em rows | `core/render/soft-wrap.ts` (`VisualRowIndex`), `scene.ts`, `viewport.ts`, `renderer/main.ts` | +40 |
| 4 | **⌨️ Ctrl+D / Alt+Shift+↑↓ / Ctrl+Shift+L** — multi-cursor estilo VS Code | NOVO `renderer/multi-cursor-ops.ts`, `renderer/main.ts` | +26 |
| 5 | **📦 Snippets de pacote** — `.sublime-snippet` dos pacotes (`user > app > os`) | NOVO `core/packages/package-snippets.ts`, `shared/snippet-contract.ts`, IPC `snippets.list` | +19 |

**Gates:** `typecheck`/`lint`/`test`/`build` exit 0 · **958 testes / 70 arquivos** · E2E de
usabilidade **TUDO OK** (o app continua íntegro depois de tudo).

**Limitações declaradas:** o `VisualRowIndex` não conhece **linhas colapsadas** (folding) ⇒ uma
linha dobrada que quebra em N rows desalinha a contagem em N−1; a busca do Ctrl+D é
**case-sensitive**; o `scope` do formato Sublime não é lido; a lista de snippets de pacote só muda
quando o índice de pacotes é reconstruído.

### 🐛 LSP no AppImage (achado no caminho)

O AppImage abria **sem LSP** (sem diagnóstico/completecão/hover): o `PATH` do launcher do desktop não
tem o `bin` do nvm ⇒ `spawn` falhava com ENOENT. Três correções: (1) o main **acrescenta** o `bin`
do node gerenciado ao `PATH` (o mais novo primeiro — o `unshift` em laço punha o **Node 14** na
frente, e os servidores exigem Node ≥ 18); (2) o `tsserver.path` injetado no `initialize` só é
usado **se existir em disco** (no AppImage o `node_modules` do projeto não existe) — senão cai no
TypeScript **global**, e o `setup` passa a fixar o `typescript@5` (o **7+/tsgo não tem
`lib/tsserver.js`**); (3) o **stderr** do servidor LSP deixou de ser descartado (o sintoma era só
"timeout de 15 s") e agora é logado quando o handshake falha.

**Verificado** com o AppImage e um **env limpo** (`env -i PATH=/usr/bin:/bin`): os **dois**
servidores LSP iniciam ✓.

---

## 🐛 Auditoria de bugs (2026-10-21, tarde) — 5 auditores em paralelo

5 auditores (edição/render/casca/LSP-DAP-segurança) rodaram o app via CDP e caçaram **20+ achados**;
**16 foram corrigidos** (o resto é follow-up). O mais grave:

| Sev | Achado | Correção |
|---|---|---|
| **crítico** | **o caret nunca era desenhado na posição real** — a barra azul ficava no topo-esquerdo da viewport (o `primaryCaret` era a *primeira linha visível*) | o caret passou a ser a posição real e o "destaque de linha atual" virou o parâmetro `activeLine` (verificado por leitura de pixels: y=71px, antes y=8px) |
| **alto** | **RCE via `git diff`**: o repo do documento era lido com o ambiente do usuário ⇒ `diff.external` executava comando arbitrário | env sanificado (`GIT_*` descartados, `GIT_CONFIG_GLOBAL=/dev/null`), `--no-ext-diff --no-textconv`, `core.pager`/`hooksPath` neutralizados + teste de regressão |
| **alto** | **salvar falhava fora do mesmo filesystem** (EXDEV) | o tmp passa a nascer no diretório do destino (com fallback) |
| **alto** | **edi��ão externa (plugin/LSP) não reconciliava caret/seleções** ⇒ a digitação seguinte corrompia o texto | o delta é aplicado às seleções; a reconciliação aguarda o flush do lote |
| **alto** | roda/PageUp/PageDown rolavam em **linhas lógicas** (6 rows em vez de 3) | `viewport.scrollByRows()` (delta em rows) |
| **alto** | clicar na **aba já ativa** deixava o editor mudo (foco no botão) | `activate()` sempre devolve o foco ao canvas |
| **alto** | **tema claro ilegível**: 31 elementos reprovavam AA (`--bg`, `--font`, `--highlight`, `--s-editor` não existiam) | tokens virados alias dos `--s-*` + escala de contraste (texto pequeno 3.58:1 → 5.85:1) |
| **médio** | `git blame` nunca funcionava (cwd do app) e o **main bloqueava** durante o diff | `cwd: dirname(path)` + `execFile` assíncrono |
| **médio** | abrir um **FIFO** travava o IPC | o registry exige arquivo regular |
| **médio** | paleta/find bar/painel/popups **se sobrepunham** | escala única de z-index + geometria do painel abaixo da find bar |
| **médio** | o minimap usava só **13%** da faixa | passo vertical ampliado (`fill`) — a faixa virou um overview do que se vê |

**Também**: `window.open` remoto bloqueado; `broadcast` em janela morta; `dirname` de verdade; hit-test
off-by-5px; documento inteiro montado a cada frame (30 FPS com 200k linhas); guias de indentação em
índice lógico; mensagem de erro crua na UI; `Ln/Col` duplicado; `aria-pressed` nos toggles da busca;
menu nativo com `Ctrl+W`/DevTools/Zoom.

**Gates:** `typecheck`/`lint`/`test`/`build` exit 0 · **1039 testes / 79 arquivos** · E2E de
usabilidade **TUDO OK**.

---

## 🎨 Design system + 3 features de última geração (2026-10-21, noite)

### Design (spec de um designer, com medição de contraste e screenshots)

- **Contraste AA em toda a casca**: `--s-muted` 62%→80%, `--s-subtle` 40%→72%, novo
  `--s-disabled`; o texto pequeno saiu de **3,58:1 → 5,85:1** no tema claro; "desabilitado"
  1,47:1 → 3,01:1; ícones da rail 2,13:1 → 10,1:1.
- **O tema claro deixou de ser um vazio branco**: degraus de superfície (rail/sidebar/abas/status/
  aba ativa) + bordas próprias nos 2 temas.
- **Estados com hierarquia**: anel de foco 2px (`:focus-visible`, antes 1px *inside*),
  `--s-selected` 14% + **barra de acento** de 2px (em vez do bloco azul), "×" da find bar sem
  chip acidental, `aria-pressed` nos 3 toggles, desabilitado legível.
- **Superfícies flutuantes** (`--s-surface-raised` + `--s-border-strong`) — o popup sumia no branco.
- **Escala tipográfica com degraus** (13px UI / 12px status / 11px rótulos / 15px paleta) —
  o 13px era um degrau morto.
- **A lupa de código** no sistema (zoom 1.8, 320px sem estourar a janela, z-index da escala).
- Alvos de clique ≥ 24px · `kbd` com cara de tecla · cores semânticas · grade de espaçamento.

### 3 features

| # | Feature | Módulos | Como se usa |
|---|---|---|---|
| 1 | **⌘P — Quick Open** (fuzzy de arquivos + comandos + recentes, com prévia) | `src/core/workspace/file-index.ts`, `src/renderer/quick-open.ts` | `Ctrl/Cmd+P` |
| 2 | **📌 Sticky scroll** (a "envelope" do código gruda no topo) | `src/core/render/sticky-scroll.ts`, `scene.ts` | automático ao rolar |
| 3 | **🔍 Grep na workspace** (resultados agrupados por arquivo na lateral) | `src/core/workspace/grep.ts`, `src/renderer/search-panel.ts` | `Ctrl/Cmd+Shift+F` (ou o botão novo da rail) |

### 🐛 LSP de verdade (o TypeScript estava **sem diagnóstico nenhum**)

- **capabilities vazias** ⇒ o servidor zerava o `publishDiagnostics` ⇒ **zero** diagnóstico;
- **framing em string** ⇒ o `Content-Length` (bytes) nunca casava com acento/emoji ⇒ mensagem travada;
- o popup de Document Symbols **lançava** com símbolo plano;
- o broadcast de diagnósticos saía **1 evento atrasado**;
- `didClose` nunca saía; `didChange` mandava o documento inteiro; o `tsserver.path` do AppImage
  apontava para um arquivo inexistente; o `npm` fora do nvm não era achado; o `HostSession.pid`.

**Gates:** `typecheck`/`lint`/`test`/`build` exit 0 · **1176 testes / 94 arquivos** ·
E2E de usabilidade **TUDO OK** · E2E das features **21/21**.

---

## 🗂️ Estado do repositório

- ✅ **Working tree LIMPO na abertura desta sessão** (2026-10-20) — a pendência de 2026-10-17
  (repaginação + WIP) já tinha sido resolvida pelos commits posteriores (`git log --oneline`).
- ⚠️ **A sessão de 2026-10-20 (noite) NÃO commitou** a feature P4#27 — o HANDOFF afirmava
  "working tree limpo", mas o `git log` mostrava o último commit em `50eff3e` (P4#18b) e a
  P4#27 inteira (core + renderer + docs + o fix de shell-injection) estava **uncommitted**.
  Corrigido em 2026-10-20 (sessão seguinte): gates revalidados (709 testes / 59 arquivos) e tudo
  commitado — ver `git log --oneline -1`.
  **Lição:** o passo "commit + working tree limpo" do protocolo precisa ser conferido com
  `git status --short` **antes** de encerrar a sessão, não assumido.
- ✅ **Working tree limpo ao fim desta sessão** (2026-10-21, noite) — **6 commits**:
  `cbbc4e4` (fix do boot do AppImage) · `b625ecf` (design system + 3 features + LSP de verdade) ·
  `2ef0e42` (minimap/diagnósticos/foco da find bar) · `36a0565` (auditoria: 16 bugs) ·
  `be14f29` (5 features) · `7d5a12b` (LSP no AppImage) — ver `git log --oneline -8`.
- ✅ **📦 AppImage 0.6.0** — `release/Scribe-0.6.0.AppImage` (117 MB), **gerado e testado com
  `env` limpo**: sobe, **os 2 servidores LSP iniciam**, plugin host pronto (pid real no log).
- ✅ **Servidores LSP instalados** — `typescript-language-server` + `typescript@5` + `pyright`
  (**etapa 13/13** do `setup/setup.py`; opcional — sem eles o app funciona, mas fica sem
  diagnóstico/completecão). ⚠️ O `typescript` precisa ser o **5.x**: o 7+ (tsgo) **não tem**
  `lib/tsserver.js` ⇒ o LSP do TypeScript não funciona com ele.
- ✅ **Harness de verificação** (reutilizável na próxima sessão): `/tmp/opencode/cdp-usable.mjs`
  (usabilidade), `cdp-panel.mjs` (painel de depuração), `cdp-choice.mjs` (dropdown de snippets),
  `cdp-doctor.mjs` (diagnóstico geral), `cdp-mm-toggle.mjs` (minimap) — todos via CDP com
  `xvfb-run`; o padrão está em `cdp-panel.mjs`.
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
