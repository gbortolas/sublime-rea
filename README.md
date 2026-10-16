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

> 📝 **Nome do projeto: a definir.** [`docs/TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md)
> chama o alvo de **"Arcane"**; o repositório se chama **sublime-rea**. Decidir o nome é o item
> **P2.3** do backlog — até lá, este README usa "sublime-rea" só como nome do repo.

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
  bin/sublime_text_build_4215_x64.tar.xz        ← tarball oficial (versionado no repo)
                │  setup, etapa 8 (extração)
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
| **Node / npm** | `node >= 20` + npm | você |
| **Python** | 3.10+ (o `rich` é opcional, o script se vira) | você |
| **REA** | `rea-agents@6.5.0` (global via npm, ou `npx` efêmero) | **setup** |
| **Ghidra** | **12.1.4** headless + native decompiler (~543 MiB de download) | **setup** |
| **pwntools-elf** | provider offline em venv (pwntools 4.15.0 / pyelftools 0.33 / unicorn 2.1.2) | **setup** |
| **Alvo** | `bin/sublime_text_build_4215_x64.tar.xz` — **já está versionado no repo** | **setup** (extrai) |
| Rede / disco | acesso a `github.com`, registry npm e `pypi.org`; **~1,5 GiB** livres | você |

> ⚠️ **O REA precisa do `JAVA_HOME`.** Se o Java não estiver exportado (ou for < 21), o
> `rea doctor` responde `healthy: false` e a análise nunca começa.
> As versões ficam pinadas em [`setup/versions.env`](setup/versions.env) (fonte única de verdade).
> Detalhes completos: [`setup/README.md`](setup/README.md).

---

## ▶️ Passo a passo: do ZERO ao MVP

Os passos abaixo são **sequenciais**. Cada um tem **objetivo**, **comando** e **pronto quando…**.
Sem `sudo` em nenhum momento (a não ser que você peça `--install-deps` explicitamente).

### Passo 1 — Clonar o repositório e ver o plano 📥

**Objetivo:** ter o repo no disco (o `bin/` já traz o tarball do alvo) e entender o que o setup faria.

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
| 3 | **Como funciona a ponte IPC C++↔Python?** | P1.3 | 🟡 lado Python ✅ + transporte ✅; falta mapear opcodes e framing | [`docs/analysis/api-python.md`](docs/analysis/api-python.md) · [`docs/analysis/ipc-plugin-host.md`](docs/analysis/ipc-plugin-host.md) |
| 4 | **Como é o pipeline de render?** GPU/OpenGL/Skia? Como o viewport é virtualizado? | P1.4 | ⬜ aberto | *(hipótese "Qt" **refutada** no P1.2 — toolkit = GTK3/GLib)* |
| 5 | **Como o editor empacota e resolve recursos?** (`.sublime-package`, `.sublime-syntax`) | P1.6 | ✅ concluído | [`docs/analysis/packaging.md`](docs/analysis/packaging.md) |
| 6 | **Consolidar o ledger de evidências** de tudo acima | P1.5 | ⬜ aberto | consolidar `docs/analysis/` |

**Pronto quando:** cada pergunta tem uma resposta escrita em `docs/analysis/` (ou em
`docs/architecture/`, na Fase 2), com **evidência rastreável** (`arquivo:linha` ou evidence ID) e
com os **limites** da conclusão declarados. Conclusão sem evidência = hipótese, e deve estar
marcada como tal.

> 🧠 **Dica:** os itens **sem Ghidra** (baratos) já foram feitos — **P1.6** (empacotamento) e boa
> parte do **P1.3** (Track A: API Python + IPC). Os que faltam (**P1.3** opcodes, **P1.4** render,
> **P1.5** ledger) exigem a análise nativa, que é mais lenta (~355 s por sessão).
> Para o prato principal, comece por **P1.3** (opcodes/framing), que reaproveita a sessão do binário
> já aberta.
> Ferramenta de apoio: a skill `reverse-engineer-anything` (+ `references/native-and-artifacts.md`).

---

### Passo 9 — FASE 2: sintetizar os padrões 📐

**Objetivo:** escrever a **spec abstrata** do editor — a "receita" que a Fase 3 vai seguir.
Um documento por componente, em `docs/architecture/` (ex.: `buffer.md`, `concurrency.md`,
`ipc.md`, `render.md`), sintetizando as evidências da Fase 1 em **design patterns e contratos**
(estrutura de dados, invariantes, complexidade esperada, interfaces).

Itens: **P2.1**. Regra da casa: **zero código do binário** — pseudocódigo próprio e diagramas, sim.

**Pronto quando:** existe `docs/architecture/*.md` cobrindo os 4 componentes-núcleo (buffer,
concorrência, IPC/extensão, render) e cada afirmação aponta para a evidência que a sustenta
(ou está marcada explicitamente como hipótese/decisão de projeto nossa).

---

### Passo 10 — FASE 3: scaffold `src/` (Electron + TypeScript) 🏗️

**Objetivo:** começar o editor de verdade em `src/`, seguindo a spec da Fase 2. Item **P2.2**.

- [ ] **`PieceTable` / `Rope` em TS** — estrutura de buffer com mutação mínima (qual das duas só
      depois da Fase 2; hoje é hipótese aberta em P1.1)
- [ ] **Worker Threads** (`worker_threads`) — operações de buffer e parsing pesado **fora** da main thread
- [ ] **Render Canvas 2D / WebGPU** — com **scroll virtualizado** (linhas `K` a `K+N`, nada de DOM por linha)
- [ ] **API de extensão tipada + protocolo IPC** — contratos em TypeScript, isolamento dos plugins

Estrutura alvo dos processos (de [`TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md) §3.2):
main process (Node: ciclo de vida, menus, FS) · renderer (Chromium: apresentação) ·
workers (tokenização, diffing, recálculo do buffer).

**Pronto quando:** `src/` compila e roda um editor que satisfaz o **Core do MVP** (abrir → editar →
salvar, com as 7 caixas do topo desta página marcadas ✅). 🎉

---

## 📍 Onde estamos agora

**Estado em uma linha:** ambiente ✅ · binário-alvo **100% analisável** ✅ ·
Track A (API Python + IPC) ✅ · **Fase 1 em andamento**.

| Frente | Status |
|---|---|
| **Ambiente** (REA 6.5.0 + Ghidra 12.1.4 + JDK + venv pwntools + MCP) | ✅ pronto e verificado (`healthy: true`) |
| **Alvo** extraído e identificado (`inspect-binary-layout`) | ✅ |
| **Track B** — o binário foi analisado **por inteiro** | ✅ (334 s de auto-análise; projeto persistente de 171 MB) |
| **Track A** — análise **sem** Ghidra: API de plugins + ponte IPC | ✅ (`docs/analysis/api-python.md`, `ipc-plugin-host.md`) |
| **P1.2** — modelo de concorrência (threads/pools, GTK/GLib, handoff main↔bg) | ✅ (`docs/analysis/concurrency.md`) |
| **P1.6** — empacotamento de recursos | ✅ (`docs/analysis/packaging.md`) |
| **P0.6** — deadline do Ghidra no MCP | ✅ resolvido (setup rodado; MCP relançado com a var) |
| **Fase 1** — buffer, concorrência, opcodes do IPC, render | 🟡 em andamento (P1.1 ✅ buffer · P1.2 ✅ concorrência · P1.6 ✅ empacotamento) |
| **Fases 2 e 3** — spec abstrata e o editor em si | ⬜ não começaram |

> 🔄 **Fontes vivas:** [`docs/HANDOFF.md`](docs/HANDOFF.md) (como retomar, pegadinhas operacionais) e
> [`docs/BACKLOG.md`](docs/BACKLOG.md) (fases P0/P1/P2/P3 e status de cada item). Este README é um
> retrato; o backlog é o placar.

---

## 🗺️ Mapa de documentos

| Documento | Para que serve |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **Instruções do projeto / bootstrap de sessão** — o gatilho "pode continuar os trabalhos!" manda ler o HANDOFF e pegar o próximo item do BACKLOG |
| [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) | **Visão de pesquisa** (pt-BR): objetivos, ferramentas, requisitos técnicos e diretrizes éticas/legais |
| [`docs/TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md) | **Spec técnica** (en): metodologia clean-room, componentes-núcleo, arquitetura-alvo no Electron. É aqui que o projeto aparece como **"Arcane"** |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | **Como retomar**: estado atual, pegadinhas operacionais, timeout do Ghidra, fatos observados do alvo |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | **Placar vivo**: itens P0 (destravar), P1 (Fase 1), P2 (Fases 2–3), P3 (housekeeping) |
| [`setup/README.md`](setup/README.md) | O **instalador reproduzível**: 10 etapas, flags, variáveis, troubleshooting, códigos de saída |
| [`docs/analysis/api-python.md`](docs/analysis/api-python.md) | Evidência — **API Python de plugins**: superfície pública (3.14), delta vs 3.3, padrões da ponte, ledger `E1–E33` |
| [`docs/analysis/ipc-plugin-host.md`](docs/analysis/ipc-plugin-host.md) | Evidência — **ponte C++↔Python**: shm POSIX nomeada + semáforos, canais `subl_send`/`subl_recv`/`subl_arecv` |
| [`docs/analysis/packaging.md`](docs/analysis/packaging.md) | Evidência — **empacotamento de recursos**: `.sublime-package` (ZIP sem manifesto), resolução de caminho lógico |
| [`docs/analysis/concurrency.md`](docs/analysis/concurrency.md) | Evidência — **modelo de concorrência**: main thread GTK/GLib, fábrica de threads POSIX, pools (`io_worker`/`file_read_thread`), scheduler de retorno ao main thread, ledger `E1–E21` |
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
  **zero** referências a Qt), e o render **aparenta** ser Skia (P1.4 no backlog).

> Fonte: seção *Diretrizes Éticas e Legais* de [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) e
> §5 *Compliance & Clean-Room Boundaries* de [`docs/TECHNICAL_SPECIFICATION.md`](docs/TECHNICAL_SPECIFICATION.md).
