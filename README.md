# sublime-rea — do zero ao MVP 🚀

> **Leia isto primeiro.** É a porta de entrada do repositório: explica o que é o projeto, o que
> significa "pronto", e o **passo a passo em ordem** para sair do zero e chegar ao MVP.
> Quando este README e os outros documentos divergirem, a fonte viva é
> [`docs/HANDOFF.md`](docs/HANDOFF.md) + [`docs/BACKLOG.md`](docs/BACKLOG.md).

Este é um **trabalho de pós-graduação**: fazemos **engenharia reversa clean-room** do
**Sublime Text build 4215** (executável ELF nativo, C++, *stripped*) com a ferramenta **REA** +
**Ghidra**, para extrair **padrões arquiteturais abstratos** (estrutura de buffer, concorrência,
ponte IPC C++↔Python, pipeline de render) e então **reimplementar do zero** um editor equivalente
em **Electron + TypeScript** (Canvas 2D / WebGPU + Worker Threads).

> ⚠️ **Princípio inegociável:** **nenhuma linha de código do binário é copiada.** Só conceitos e
> especificações abstratas. Ver [Ética / clean-room](#-ética--clean-room).

> 📝 **Nome do projeto: Scribe.** O codinome do editor-alvo é **Scribe** (decidido em **P2.3**; ver
> [`docs/TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md)). O repositório continua
> **sublime-rea**.

---

## 🎯 O objetivo final: o que é "o MVP"

O MVP é **um editor de texto funcional escrito do zero**, com a arquitetura **inspirada** (não
copiada) no que for descoberto na Fase 1. Nada mais, nada menos.

### ✅ Core do MVP (é isto que define "pronto")

| # | Requisito | Observação |
|---|---|---|
| 1 | **Abrir / editar / salvar** arquivo de texto | o mínimo inegociável |
| 2 | **Buffer de texto performático** | estrutura tipo *Piece Table* / *Rope* em TS, com insert/remove eficientes. **Qual delas o Sublime usa é justamente a pergunta P1.1** — a decisão de projeto vem da Fase 2 |
| 3 | **Render de viewport** | Canvas 2D ou WebGPU, com **scroll virtualizado** (desenha só as linhas visíveis, nada de um nó DOM por linha) |
| 4 | **Syntax highlighting** | tokenização fora da main thread (Worker) |
| 5 | **Undo / redo** | histórico com footprint controlado |
| 6 | **Paleta de comandos** | o "Ctrl+Shift+P" — descoberta/ação de comandos |
| 7 | **Extensibilidade básica** | API de extensão tipada + protocolo de mensagens entre processos |

### ⏳ Depois do MVP (não bloqueiam o "pronto")

Busca/regex, indexação de workspace, *go to definition*, LSP, temas, gerenciador de pacotes,
`.sublime-package` compatível, editores de coluna/múltiplos cursores, etc.

> Os requisitos técnicos de cada item estão detalhados em
> [`docs/TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md) §3.

---

## 🧭 Como o projeto funciona

O fluxo conceitual tem **3 fases**. O diagrama (adaptado de
[`TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md) §2.1):

```
  bin/sublime_text_build_4215_x64.tar.xz        ← tarball oficial (baixado sob demanda; fora do git)
                │  setup, etapa 8 (verifica SHA-256 + extração)
                ▼
   target/sublime_text/sublime_text             ← o ALVO: ELF64, PIE, STRIPPED, ~9,5 MiB
                │
                │  FASE 1 — Análise (REA via MCP ◄──► Ghidra headless)
                ▼
   docs/analysis/*.md                           ← EVIDÊNCIAS (com Evidence IDs)
                │
                │  FASE 2 — Síntese de padrões abstratos
                ▼
   docs/architecture/*.md                       ← SPEC ABSTRATA (zero código do binário)
                │
                │  FASE 3 — Reimplementação do zero
                ▼
   src/  (Electron + TypeScript)                ← MVP funcional
```

**Em linguagem leiga, fase por fase:**

1. **Fase 1 — Análise ("abrir a caixa preta").** O binário é *stripped* (sem nomes de funções),
   então usamos o Ghidra para ele recuperar funções/estruturas, e o REA como **camada de mediação**
   (o agente de IA pergunta via MCP, o REA consulta o Ghidra). O produto da fase é
   **evidência documentada**: "acho que o buffer é X, e a prova está no arquivo tal, linha tal".
   Enquanto estamos aqui, tudo é **hipótese com evidência**, não verdade revelada.
2. **Fase 2 — Síntese ("escrever a receita").** Pegamos as evidências soltas e escrevemos a
   **spec abstrata** dos padrões: como o buffer funciona, quem fala com quem, quantas threads
   existem, como o texto chega à tela. Ainda **sem código**: é um documento de arquitetura.
3. **Fase 3 — Reimplementação ("cozinhar a receita").** Construímos o editor novo em
   Electron/TypeScript seguindo **só** a spec da Fase 2. É onde o MVP do topo desta página nasce.

> 🤖 **Sessões novas seguem o [`AGENTS.md`](AGENTS.md)** — bootstrap (ler o
> [`docs/HANDOFF.md`](docs/HANDOFF.md) → pegar o próximo item do
> [`docs/BACKLOG.md`](docs/BACKLOG.md)) + protocolo de handoff, para começar com contexto limpo e
> barato.

---

## 🧰 Pré-requisitos de ambiente

O ambiente é **reproduzível por script** — você não precisa instalar nada na mão (exceto um JDK).

| Requisito | Versão / nota | Quem provê |
|---|---|---|
| **SO** | Linux **x86_64** (validado em pop 22.04) | você |
| **Java (JDK)** | **≥ 21**. O Ghidra 12.1.x exige **no mínimo JDK 21** (o JDK 25 só passou a ser exigido no Ghidra 12.2). O setup **detecta e instrui**, nunca instala | você ([Temurin 21](https://adoptium.net/temurin/releases/?version=21)) |
| **Node / npm** | `node >= 20` + npm — **obrigatório para o scaffold (Fase 3)**: `npm install` na raiz traz Electron/TS/vitest/eslint/esbuild | você |
| **Python** | 3.10+ (o `rich` é opcional, o script se vira) | você |
| **REA** | `rea-agents@6.5.0` (global via npm, ou `npx` efêmero) | **setup** |
| **Ghidra** | **12.1.4** headless + native decompiler (~543 MiB de download) | **setup** |
| **pwntools-elf** | provider offline em venv (pwntools 4.15.0 / pyelftools 0.33 / unicorn 2.1.2) | **setup** |
| **Alvo** | `bin/sublime_text_build_4215_x64.tar.xz` — **baixado sob demanda** (fora do git, SHA-256 pinado em `setup/versions.env`) | **setup** (baixa + valida + extrai) |
| Rede / disco | acesso a `github.com`, `download.sublimetext.com`, registry npm e `pypi.org`; **~1,5 GiB** livres | você |

> ✅ **O REA precisa do `JAVA_HOME` (JDK ≥ 21)** — desde P3.9 o `setup.py` detecta um JDK
> compatível (env, PATH, sdkman, `/usr/lib/jvm`) e escreve o `export JAVA_HOME=…` ativo no
> `env.sh` gerado: **sem export manual**. Se só existir JDK antigo, o setup avisa com o caminho
> detectado.
> As versões ficam pinadas em [`setup/versions.env`](setup/versions.env) (fonte única de verdade).
> Detalhes completos: [`setup/README.md`](setup/README.md).

---

## ▶️ Passo a passo: do ZERO ao MVP

Os passos abaixo são **sequenciais**. Cada um tem **objetivo**, **comando** e **pronto quando…**.
Sem `sudo` em nenhum momento (a não ser que você peça `--install-deps` explicitamente).

### Passo 1 — Clonar o repositório e ver o plano 📥

**Objetivo:** ter o repo no disco (o tarball do alvo **não** vem no repo: o setup o **baixa** na primeira execução e valida o SHA-256) e entender o que o setup faria.

```bash
git clone <repo> sublime-rea && cd sublime-rea
python3 setup/setup.py --help        # flags disponíveis
python3 setup/setup.py --dry-run     # imprime o plano SEM baixar, SEM sudo, SEM escrever nada
```

**Pronto quando:** o `--dry-run` termina com **exit 0** e mostra a sequência
`mkdir → lock → .part → mv` do download do Ghidra, sem nenhum efeito colateral.

---

### Passo 2 — Rodar o instalador 🔧

**Objetivo:** instalar REA, Ghidra, o venv de pwntools e extrair o alvo. O script é **idempotente**:
rodar de novo só age onde falta.

```bash
# Máquina nova: só aqui ele toca em sudo (deps) e no ~/.bashrc
python3 setup/setup.py --install-deps --write-rc

# Já tem as deps e não quer mexer no rc:
python3 setup/setup.py
```

**Pronto quando:** o script termina com **exit 0** e a **etapa 10** (gate do `rea doctor`) passa com
`healthy: true`. Ele já roda a verificação sozinho.

> 💡 **As 10 etapas** (SO → deps → Java → REA → Ghidra → pwntools → `env.sh` → alvo → MCP →
> verificação) estão detalhadas em [`setup/README.md`](setup/README.md).
> Códigos de saída: `1`=doctor unhealthy · `3`=problema no Ghidra · `4`=problema no alvo · `6`=pwntools.

---

### Passo 3 — Exportar o ambiente (**obrigatório em shell não-interativo**) ⚠️

**Objetivo:** o `rea` CLI **exige** as variáveis (`GHIDRA_INSTALL_DIR`, `REA_PWNTOOLS_PYTHON`, …)
no ambiente. Em shell **interativo** o `~/.bashrc` faz isso sozinho (se você usou `--write-rc`);
**scripts, cron, CI e shells não-interativos precisam fazer na mão**:

```bash
set -a; . ./setup/env.sh; set +a
```

Sem isso, o sintoma é `GHIDRA_INSTALL_DIR is not set`. É a pegadinha nº 1 do projeto.

**Pronto quando:** `echo "$GHIDRA_INSTALL_DIR"` imprime um caminho de verdade (o symlink `~/sr-tools`
existe porque o Ghidra **recusa paths com componente iniciado por `.`** — ver P3.7 no backlog).

---

### Passo 4 — Validar que o ambiente está saudável 🩺

**Objetivo:** ter a certeza de que Ghidra + Java + REA estão de pé **antes** de gastar minutos de análise.

```bash
rea doctor --client opencode --provider ghidra --format json
```

**Pronto quando:** o campo **escopado `healthy`** é `true` (exit 0).
> 👍 `environment_healthy: false` é **esperado** na maioria das máquinas: é um flag **global** que
> inclui engines opcionais (hopper/ida/jadx) e registro em outros clients. O setup também usa
> `healthy`, não `environment_healthy`.

---

### Passo 5 — Garantir o deadline do Ghidra no MCP `rea` ✅

**Objetivo:** garantir que o **MCP `rea`** do opencode use o deadline de **15 min**
(`REA_GHIDRA_STARTUP_TIMEOUT_MS=900000`) e não os **330 s** default. O **Passo 2** já cuida disso:
o `setup.py` escreve a variável **tanto** no `setup/env.sh` **quanto** no `environment` do MCP
`rea` em `~/.config/opencode/opencode.jsonc`.

```bash
python3 setup/setup.py        # idempotente: reescreve setup/env.sh + environment do MCP rea
# se o opencode já estava aberto antes do setup: reinicie-o para o MCP relançar com o novo environment
```

**Pronto quando:** o bloco `mcp.servers.rea.environment` do `~/.config/opencode/opencode.jsonc`
contém `REA_GHIDRA_STARTUP_TIMEOUT_MS` e, após (re)iniciar o opencode, `open_binary`/`analyze` via
MCP não estouram o deadline.

> Item **P0.6** — **resolvido** (verificado em 2026-10-16: a variável está no `env.sh` e no jsonc,
> e o processo `rea mcp` foi relançado já com ela). Na prática, se você seguiu o Passo 2, este
> passo já está feito — ele fica aqui só para explicar *por que* o deadline importa.

---

### Passo 6 — Reconhecer o alvo (barato, não usa Ghidra) 🔬

**Objetivo:** saber exatamente **o que** vamos analisar. O alvo extraído é:

```
target/sublime_text/sublime_text
```

e o reconhecimento roda no provider **offline `pwntools-elf`** (por isso o venv da etapa 6 do setup):

```bash
rea inspect-binary-layout target/sublime_text/sublime_text --format json
```

**Pronto quando:** o JSON descreve o binário. Valores esperados (fatos já observados):

| Campo | Valor |
|---|---|
| `sha256` | `8b105b1839d7809f60ec186b6c6dcb2d107e22ad23f42c5f8ba7dec67ab43d92` |
| Formato | ELF64 x86-64 little-endian, **ET_DYN (PIE)** |
| Entry point | `0x4b4920` |
| Estrutura | 33 sections / 12 segments / 444 symbols / 34.534 relocations |
| Símbolos | **STRIPPED** (sem `.symtab`, só `.dynsym`) |

> Se a resposta for `provider_unavailable`, o `REA_PWNTOOLS_PYTHON` não chegou ao REA → volte ao
> Passo 3 (e confira a chave em `mcp.servers.rea.environment` no `opencode.jsonc`).

---

### Passo 7 — A pegadinha do **deadline do Ghidra** ⏱️

**Objetivo:** não perder 6 minutos de análise por causa de 4 segundos.

O REA importa, analisa e **descarta** o projeto a cada abertura, dentro de um deadline **fixo** cujo
default é **330 s**. Neste alvo, a auto-análise leva **~334 s** (wall clock import→fim ~342 s;
validação ponta a ponta do REA: **5m54,8 s**). Ou seja: com o default, **estoura por ~4 s** e o
resultado é jogado fora.

O deadline **é configurável**:

```bash
export REA_GHIDRA_STARTUP_TIMEOUT_MS=900000     # 900 s = 15 min (default do projeto)
```

No setup, esse valor **já é o default** (gravado no `setup/env.sh` e no registro MCP — por isso o
Passo 5). Valores relacionados, todos válidos: é inteiro decimal positivo até `2147483647`.

> 🧠 **Não desperdice a análise:** existem duas rotas.
> **(a) Rota nativa do REA** — ele sempre re-analisa:
> ```bash
> export REA_GHIDRA_STARTUP_TIMEOUT_MS=900000
> rea open-binary target/sublime_text/sublime_text      # análise: ~355 s (veja --help p/ demais flags)
> ```
> **(b) Projeto Ghidra persistente** — pré-analisa **uma vez**, sem deadline, e permite
> **reprocessar sem reanalisar**:
> ```bash
> bin/ghidra-preanalyze.sh        # ver o cabeçalho do script; sala em $REA_TOOLS_DIR/ghidra-projects/sublime-rea
> ```
> O REA **não** consome projeto/DB do Ghidra — o único vetor real de alimentar o REA é gerar um
> `REA_GHIDRA_SEED_FILE` (TSV `address<TAB>kind[<TAB>name]`) a partir dos nomes recuperados.

---

### Passo 8 — FASE 1: as perguntas da análise (o checklist) 📊

**Objetivo:** transformar "analisar o binário" (vago e infinito) numa **lista de perguntas
respondíveis**, cada uma virando uma seção da spec da Fase 2. Uma pergunta = um escopo
independente + um **ledger de Evidence IDs** (conclusão → evidence ID → tipo → limites).

| # | Pergunta | Item | Status | Onde está a evidência |
|---|---|---|---|---|
| 1 | **Como o buffer é estruturado?** Piece Table / Gap Buffer / Rope? Como faz insert/remove, undo/redo e indexação de linha? | P1.1 | ✅ concluído | [`docs/analysis/buffer-structure.md`](docs/analysis/buffer-structure.md) |
| 2 | **Qual o modelo de concorrência?** O que roda na thread principal vs. nas de background (I/O, indexação, highlight, regex)? | P1.2 | ✅ concluído | [`docs/analysis/concurrency.md`](docs/analysis/concurrency.md) |
| 3 | **Como funciona a ponte IPC C++↔Python?** | P1.3 | ✅ concluído | [`docs/analysis/api-python.md`](docs/analysis/api-python.md) · [`docs/analysis/ipc-plugin-host.md`](docs/analysis/ipc-plugin-host.md) · [`docs/analysis/ipc-protocol.md`](docs/analysis/ipc-protocol.md) |
| 4 | **Como é o pipeline de render?** GPU/OpenGL/Skia? Como o viewport é virtualizado? | P1.4 | ✅ concluído | [`docs/analysis/render-pipeline.md`](docs/analysis/render-pipeline.md) |
| 5 | **Como o editor empacota e resolve recursos?** (`.sublime-package`, `.sublime-syntax`) | P1.6 | ✅ concluído | [`docs/analysis/packaging.md`](docs/analysis/packaging.md) |
| 6 | **Consolidar o ledger de evidências** de tudo acima | P1.5 | ✅ concluído | [`docs/analysis/evidence-index.md`](docs/analysis/evidence-index.md) |

**Pronto quando:** cada pergunta tem uma resposta escrita em `docs/analysis/` (ou em
`docs/architecture/`, na Fase 2), com **evidência rastreável** (`arquivo:linha` ou evidence ID) e
com os **limites** da conclusão declarados. Conclusão sem evidência = hipótese, e deve estar
marcada como tal.

> 🧠 **Dica:** os itens **sem Ghidra** (baratos) já foram feitos — **P1.6** (empacotamento) e boa
> parte do **P1.3** (Track A: API Python + IPC). A **Fase 1 está fechada**: o **P1.5** consolidou
> todas as 179 linhas de evidência num índice único `conclusão → Evidence ID → tipo → limites`
> ([`docs/analysis/evidence-index.md`](docs/analysis/evidence-index.md)), **sem** análise nativa nova.
> Agora começa a **Fase 2** (síntese em `docs/architecture/`).
> Ferramenta de apoio: a skill `reverse-engineer-anything` (+ `references/native-and-artifacts.md`).

---

### Passo 9 — FASE 2: sintetizar os padrões 📐 ✅

**Objetivo:** escrever a **spec abstrata** do editor — a "receita" que a Fase 3 segue.
Um documento por componente em [`docs/architecture/`](docs/architecture/), sintetizando as
evidências da Fase 1 em **design patterns e contratos** (estrutura de dados, invariantes,
complexidade esperada, interfaces).

Item: **P2.1** — ✅ **concluído**. Índice: [`docs/architecture/README.md`](docs/architecture/README.md).

| Doc | Tema | Decisões |
|---|---|---|
| [`01-buffer-e-edicao.md`](docs/architecture/01-buffer-e-edicao.md) | Buffer & edição | `DEC-BUF-1…10` |
| [`02-concorrencia-e-scheduling.md`](docs/architecture/02-concorrencia-e-scheduling.md) | Concorrência & scheduling | `DEC-CON-1…12` |
| [`03-extensao-e-ipc.md`](docs/architecture/03-extensao-e-ipc.md) | Extensão & IPC | `DEC-IPC-1…12` |
| [`04-render-e-ui.md`](docs/architecture/04-render-e-ui.md) | Render & UI | `DEC-REN-1…8` |
| [`05-empacotamento-e-recursos.md`](docs/architecture/05-empacotamento-e-recursos.md) | Empacotamento & recursos | `DEC-PKG-1…12` |
| [`06-padroes-transversais.md`](docs/architecture/06-padroes-transversais.md) | Padrões transversais | `DEC-TR-1…7` |

Regra da casa: **zero código do binário** — pseudocódigo próprio e diagramas, sim.

**Pronto quando:** existe `docs/architecture/*.md` cobrindo os componentes-núcleo (buffer,
concorrência, IPC/extensão, render, empacotamento) e cada afirmação aponta para a evidência que a
sustenta (ou está marcada explicitamente como hipótese/decisão de projeto nossa). ✅ — **61 decisões
`DEC-*`**, todas com racional + Evidence IDs.

---

### Passo 10 — FASE 3: scaffold `src/` (Electron + TypeScript) 🏗️ ✅

**Objetivo:** começar o editor de verdade em `src/`, seguindo a spec da Fase 2. Item **P2.2** —
**entregue em 2026-10-16** ([`docs/scaffold/P2.2-scaffold.md`](docs/scaffold/P2.2-scaffold.md)).

- [x] **`PieceTable` em TS** — `src/core/buffer/piece-table.ts` (segmentada, minimal-copy) + índice de
      linhas incremental (`line-index.ts`), delta UTF-16 com **inversão** para undo (`delta.ts`)
- [x] **Worker Threads** (`worker_threads`) — `src/core/concurrency/` (`scheduler.ts` com lanes e
      `Atomics.waitAsync`, `pool.ts` com lanes `io`/`index`/`fileRead`, `worker-entry.ts`)
- [x] **Render Canvas 2D / WebGPU** — `src/core/render/` (`pipeline.ts`, `canvas2d-backend.ts`,
      `webgpu-backend.ts`, `atlas.ts`, `viewport.ts` com damage coalescido) — **default CPU/Canvas2D**,
      scroll virtualizado, nada de DOM por linha
- [x] **API de extensão tipada + protocolo IPC** — `src/core/extension/` (`ops.ts` com tabela densa +
      `OPS_HASH`, `bridge.ts`, `host.ts` com `utilityProcess` + handshake) e `src/shared/ipc-contract.ts`

Estrutura dos processos (de [`TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md) §3.2):
main process (Node: ciclo de vida, FS, IPC) · renderer (Chromium: apresentação) ·
workers (`worker_threads`: varredura de linhas, indexação, I/O).

```bash
npm install                  # Electron 38 + TS + vitest + eslint + esbuild
npm run typecheck && npm test && npm run lint
npm run start                # ou start:headless, sem display
```

**Estado:** o scaffold **compila, testa e sobe** (`electron .` boota e loga
`Scribe: MainThreadBusy {...}`) e a **fatia vertical** (P2.4) provou **as 5 frentes** ponta a ponta:
**abrir arquivo real** (CLI + `dialog`), **undo/redo visível**, **cancelamento**, **realce de sintaxe**
(P2.4b ✅) e **busca/substituição na lane `background`** (P2.4c ✅ — `Ctrl/Cmd+F`, com `TaskPool`/
`Scheduler` usados de verdade). **Próximo:** **salvar arquivo** (`Ctrl/Cmd+S` + estado *dirty*, §P2.5) —
ver [`docs/BACKLOG.md`](docs/BACKLOG.md).

---

## 📍 Onde estamos agora

**Estado em uma linha:** ambiente ✅ (`healthy: true`) · binário-alvo **100% analisável** ✅ ·
Track A (API Python + IPC) ✅ · **Fase 1 FECHADA** (P1.1–P1.6 ✅) · **Fase 2 ✅** (P2.1: 6 docs de arquitetura, 61 decisões) · **Fase 3 ✅** (P2.2: scaffold `src/` do **Scribe** — compila, testa e sobe) · **P2.4 ✅ fechada** (fatia vertical end-to-end: abrir · editar · undo/redo · cancelamento · realce · **busca/replace** em lane de background) · **próximo: P2.5** (salvar arquivo).

| Frente | Status |
|---|---|
| **Ambiente** (REA 6.5.0 + Ghidra 12.1.4 + JDK + venv pwntools + MCP) | ✅ pronto e verificado (`healthy: true`) |
| **Alvo** extraído e identificado (`inspect-binary-layout`) | ✅ |
| **Track B** — o binário foi analisado **por inteiro** | ✅ (334 s de auto-análise; projeto persistente de 171 MB) |
| **Track A** — análise **sem** Ghidra: API de plugins + ponte IPC | ✅ (`docs/analysis/api-python.md`, `ipc-plugin-host.md`) |
| **P1.2** — modelo de concorrência (threads/pools, GTK/GLib, handoff main↔bg) | ✅ (`docs/analysis/concurrency.md`) |
| **P1.4** — pipeline de render (GTK3 + GL 4.1 instanciado / Skia-Cairo, atlas de glifos, scissor por damage) | ✅ (`docs/analysis/render-pipeline.md`) |
| **P1.6** — empacotamento de recursos | ✅ (`docs/analysis/packaging.md`) |
| **P1.5** — ledger de evidências consolidado | ✅ (`docs/analysis/evidence-index.md`: 179 linhas + 48 incógnitas) |
| **P0.6** — deadline do Ghidra no MCP | ✅ resolvido (setup rodado; MCP relançado com a var) |
| **Fase 1** — buffer, concorrência, IPC/opcodes, render, empacotamento, ledger | ✅ **fechada** (P1.1 ✅ · P1.2 ✅ · P1.3 ✅ · P1.4 ✅ · P1.5 ✅ · P1.6 ✅) |
| **Fase 2** — spec abstrata (`docs/architecture/`) | ✅ **fechada** (P2.1 ✅: `01`–`06` + README; 61 decisões `DEC-*`) |
| **P2.3** — nome do projeto **Scribe** | ✅ decidido (aplicado nas specs e em `docs/architecture/`) |
| **Fase 3** — o editor em Electron/TS (`src/`) | ✅ **scaffold entregue** (P2.2 ✅: 6 módulos de core + costura main↔core↔renderer + build; `electron .` sobe) · ✅ **P2.4 fechada**: fatia vertical end-to-end (abrir arquivo · undo/redo · cancelamento · realce de sintaxe · busca/substituição em lane de background) — **próximo**: P2.5 **salvar arquivo** (`Ctrl/Cmd+S` + `dirty`) |
| **Housekeeping** | ✅ P3.1 (tarball de 22 MB **fora do git**: download sob demanda + SHA-256 pinado) · P3.3 (script legacy travado) · P3.4 (boilerplate removido) · P3.9 (`JAVA_HOME` no `env.sh`) — pendentes: P3.10 (bundlar o worker) · P3.11 (pintar matches) · P3.12 |

> 🔄 **Fontes vivas:** [`docs/HANDOFF.md`](docs/HANDOFF.md) (como retomar, pegadinhas operacionais) e
> [`docs/BACKLOG.md`](docs/BACKLOG.md) (fases P0/P1/P2/P3 e status de cada item). Este README é um
> retrato; o backlog é o placar.

---

## 🗺️ Mapa de documentos

| Documento | Para que serve |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **Instruções do projeto / bootstrap de sessão** — o gatilho "pode continuar os trabalhos!" manda ler o HANDOFF e pegar o próximo item do BACKLOG |
| [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) | **Visão de pesquisa** (pt-BR): objetivos, ferramentas, requisitos técnicos e diretrizes éticas/legais |
| [`docs/TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md) | **Spec técnica** (en): metodologia clean-room, componentes-núcleo, arquitetura-alvo no Electron. É a spec que nomeia o produto como **Scribe** |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | **Como retomar**: estado atual, pegadinhas operacionais, timeout do Ghidra, fatos observados do alvo |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | **Placar vivo**: itens P0 (destravar), P1 (Fase 1), P2 (Fases 2–3), P3 (housekeeping) |
| [`setup/README.md`](setup/README.md) | O **instalador reproduzível**: 10 etapas, flags, variáveis, troubleshooting, códigos de saída |
| [`docs/analysis/api-python.md`](docs/analysis/api-python.md) | Evidência — **API Python de plugins**: superfície pública (3.14), delta vs 3.3, padrões da ponte, ledger `E1–E33` |
| [`docs/analysis/ipc-plugin-host.md`](docs/analysis/ipc-plugin-host.md) | Evidência — **ponte C++↔Python**: shm POSIX nomeada + semáforos, canais `subl_send`/`subl_recv`/`subl_arecv` |
| [`docs/analysis/packaging.md`](docs/analysis/packaging.md) | Evidência — **empacotamento de recursos**: `.sublime-package` (ZIP sem manifesto), resolução de caminho lógico |
| [`docs/analysis/concurrency.md`](docs/analysis/concurrency.md) | Evidência — **modelo de concorrência**: main thread GTK/GLib, fábrica de threads POSIX, pools (`io_worker`/`file_read_thread`), scheduler de retorno ao main thread, ledger `E1–E21` |
| [`docs/analysis/render-pipeline.md`](docs/analysis/render-pipeline.md) | Evidência — **pipeline de render**: `px_render_context` (31 virtuais) + backends `gl_render_context` (OpenGL 4.1, 17 programas, instâncias em texture buffer `RGBA32F`) e `skia_render_context` (Skia raster sobre Cairo); atlas de glifos; `glScissor` por damage; ledger `E1–E27` |
| [`docs/analysis/evidence-index.md`](docs/analysis/evidence-index.md) | **Índice consolidado de evidências (P1.5)**: as **179 linhas** dos 7 ledgers da Fase 1 num único namespace (`BUF-`/`CON-`/`PY-`/`HOST-`/`IPC-`/`REN-`/`PKG-`), com `conclusão → Evidence ID → tipo → limites`, duplicatas/supersessões e **48 incógnitas** consolidadas |
| [`docs/architecture/README.md`](docs/architecture/README.md) | **Índice da Fase 2 (P2.1)**: arquitetura em um olhar (3 fronteiras do alvo → mapeamento Electron/TS), glossário canônico de componentes, registro de **61 decisões `DEC-*`** e rastreabilidade global Fase 1 → Fase 2 |
| [`docs/architecture/01-buffer-e-edicao.md`](docs/architecture/01-buffer-e-edicao.md) · [`02-concorrencia-e-scheduling.md`](docs/architecture/02-concorrencia-e-scheduling.md) · [`03-extensao-e-ipc.md`](docs/architecture/03-extensao-e-ipc.md) · [`04-render-e-ui.md`](docs/architecture/04-render-e-ui.md) · [`05-empacotamento-e-recursos.md`](docs/architecture/05-empacotamento-e-recursos.md) · [`06-padroes-transversais.md`](docs/architecture/06-padroes-transversais.md) | **Spec abstrata (Fase 2)**: buffer · concorrência · extensão/IPC · render · empacotamento · padrões transversais — cada afirmação cita Evidence IDs; escolhas nossas marcadas |
| [`docs/scaffold/`](docs/scaffold/) | **Scaffold `src/` (Fase 3 / P2.2)**: convenções, donos e costuras congeladas ([`00-convencoes-e-costuras.md`](docs/scaffold/00-convencoes-e-costuras.md)) + doc do entregável ([`P2.2-scaffold.md`](docs/scaffold/P2.2-scaffold.md)) — estrutura, rastreabilidade `DEC-*` → código e gates medidos |
| [`bin/ghidra-preanalyze.sh`](bin/ghidra-preanalyze.sh) | Pré-análise headless em projeto persistente (sem deadline) — o "reprocessar sem reanalisar" |
| [`setup/versions.env`](setup/versions.env) | Versões, URLs e SHA-256 **pinados** (fonte única de verdade do setup) |

---

## ⚖️ Ética / clean-room

Escopo **exclusivamente acadêmico** — o objetivo é compreender conceitos de engenharia de software e
arquitetura de sistemas, não redistribuir nem derivar o produto analisado.

- **Clean-room:** **nenhum** código do binário original é copiado diretamente. Toda a implementação
  em Electron deve ser **escrita do zero**, baseada apenas nos conceitos e especificações técnicas
  abstratas documentadas na Fase 2.
- **Sem colar assembly/pseudocódigo do alvo no repositório.** Documentos de evidência citam
  **nomes, assinaturas, contagens, campos, endereços e `arquivo:linha`** — o suficiente para
  fundamentar uma conclusão, não para reconstruir o original.
- **Hipótese ≠ fato.** Onde a evidência não fecha, escreva **"hipótese (a confirmar)"** — e registre
  no ledger de evidências (P1.5) os **limites** da conclusão. Exemplo vivo: a hipótese de que o alvo
  seria "C++ **com Qt**" foi **refutada** no P1.2 — o toolkit é **GTK3/GLib** (strings
  `gtk_main`/`g_idle_add`/`g_source_add_unix_fd`; `NEEDED` com `libglib-2.0`/`libGL`/`libX11`; e
  **zero** referências a Qt), e o render é **Skia (raster, CPU) + OpenGL 4.1** — confirmado no P1.4.

> Fonte: seção *Diretrizes Éticas e Legais* de [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) e
> §5 *Compliance & Clean-Room Boundaries* de [`docs/TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md).
