# PROGRESS — sublime-rea

> **Handoff de sessão.** Atualizado em 2026-10-16.
> Specs do projeto: [`SPECIFICATION.md`](SPECIFICATION.md) · [`TECHNICAL_SPECIFICATION.md`](TECHNICAL_SPECIFICATION.md)
> Próximos passos: [`BACKLOG.md`](BACKLOG.md)

---

## Objetivo do projeto

Trabalho de pós-graduação: **clean-room reverse engineering** do Sublime Text usando a
ferramenta **REA** (MCP + Ghidra), para extrair **padrões arquiteturais abstratos**
(estrutura de buffer, concorrência, ponte IPC C++↔Python, render pipeline) e então
reimplementar um editor equivalente **do zero** em **Electron / TypeScript**.

---

## 📍 Onde estamos agora (a pergunta "o que estamos analisando?")

**Não** estamos analisando o `.deb`. O alvo é o **executável ELF** extraído do `.tar.xz`:

```
bin/sublime_text_build_4215_x64.tar.xz ──(setup, etapa 8)──▶ target/sublime_text/sublime_text
```

E, mais importante: a **análise de verdade começou** (2026-10-16). O que existe hoje é:

1. ✅ o **ambiente** instalado, configurado e verificado;
2. ✅ o **alvo** extraído e **identificado** (anatomia ELF via `inspect-binary-layout`);
3. ✅ **Track A — análise SEM Ghidra**: superfície da API Python de plugins + ponte IPC →
   [`docs/analysis/`](analysis/) (ver [Track A](#-track-a--análise-sem-ghidra));
4. ✅ **Track B**: o binário **já foi analisado por inteiro com sucesso** (headless, projeto
   persistente, ~342 s) e o *deadline* do Ghidra **não é fixo** (`REA_GHIDRA_STARTUP_TIMEOUT_MS`) —
   ver [Timeout do Ghidra](#-timeout-do-ghidra--resolvido).

### O que é cada arquivo

| Arquivo | O que é | Status |
|---|---|---|
| `bin/sublime-text_build-4215_amd64.deb` | pacote Debian do Sublime build 4215 | **não usado** (redundante com o tarball) |
| `bin/sublime_text_build_4215_x64.tar.xz` | tarball oficial do Sublime build 4215 | **fonte do alvo** |
| `target/sublime_text/sublime_text` | ELF 9,5 MB, x86-64, **PIE**, **stripped** | **alvo da análise** |
| `target/` | gerado pelo setup (gitignored) | descartável |

---

## ✅ Ambiente — PRONTO e verificado

Instalador reprodutível em `setup/` (Python + `rich`), **10 etapas**, idempotente, **sem sudo por padrão**.

```bash
python3 setup/setup.py --help          # flags: --dry-run, --install-deps, --write-rc
python3 setup/setup.py                 # instala tudo (idempotente)
```

| Verificação | Resultado |
|---|---|
| `rea doctor --client opencode --provider ghidra --format json` | **`healthy: true`** (exit 0) |
| Ghidra | 12.1.4 headless + native decompiler, em `$REA_TOOLS_DIR/ghidra_12.1.4_PUBLIC` |
| Java | `JAVA_HOME` = `~/.sdkman/candidates/java/23-zulu` (≥ 21) |
| REA | `rea-agents@6.5.0` (global via npm) |
| Provider offline pwntools | venv em `$REA_TOOLS_DIR/pwntools-venv` (pwntools 4.15.0 / pyelftools 0.33 / unicorn 2.1.2) |
| MCP `rea` no `~/.config/opencode/opencode.jsonc` | registrado **com** `GHIDRA_INSTALL_DIR` + `JAVA_HOME` + `REA_PWNTOOLS_PYTHON` |

Pins em [`setup/versions.env`](../setup/versions.env). Docs em [`setup/README.md`](../setup/README.md).

### ⚠️ Três pegadinhas operacionais (aprendidas na marra)

1. **Reiniciar o opencode** para o servidor MCP relançar com o `environment` completo
   (`REA_PWNTOOLS_PYTHON` foi escrito no jsonc *depois* da sessão subir).
2. **O `rea` CLI exige o ambiente exportado.** O `source setup/env.sh` só é feito
   automaticamente por shell **interativo** (linha no `~/.bashrc`). Scripts, cron, CI e
   shells não-interativos **precisam** de:
   ```bash
   set -a; . ./setup/env.sh; set +a     # senão: GHIDRA_INSTALL_DIR is not set
   ```
3. **`rea doctor` exige `JAVA_HOME` de um JDK ≥ 21.** Sem ele o escopo fica `healthy: false`.

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

> **Agravante:** o binário é **stripped** e é C++ com Qt. Sem símbolos, a RE depende de
> strings, padrões (vtables/RTTI) e da auto-análise do Ghidra — muito mais caro.

---

## 🔓 Timeout do Ghidra — resolvido

A auto-análise **não cabe no deadline default de 330 s** (reproduzido 2×, MCP e CLI). **Mas o
deadline não é fixo** — existe env var:

```bash
REA_GHIDRA_STARTUP_TIMEOUT_MS=3600000 rea ...        # 1 h
```

> ⚠️ **Correção:** a versão anterior deste doc afirmava *"não existe env var para o timeout de
> análise"*. Estava **errado**. O schema aceita inteiro positivo decimal até `2_147_483_647`
> (`rea-agents/dist/config/providerStartupTimeout.js:3-16`; default `330_000`).

| Env var | Efeito | Evidência (`rea-agents/dist/`) |
|---|---|---|
| `REA_GHIDRA_STARTUP_TIMEOUT_MS` | deadline de import+análise+bridge+ready | `config/providerStartupTimeout.js:3`, `config/environment.js:38` |
| `REA_GHIDRA_DISABLED_ANALYZERS` | nomes **exatos** de analyzers (case-sensitive, sem glob), `,`, ≤32 → `-preScript ReaGhidraAnalysisOptions.java`. Nome desconhecido = **erro fatal**. | `config/ghidraDisabledAnalyzers.js:9-25`, `bridge/ghidra/ReaGhidraAnalysisOptions.java:20-24` |
| `REA_GHIDRA_SEED_FILE` | **não** importa análise prévia: é um TSV de assertivas (`address<TAB>kind[<TAB>name]`, `kind ∈ function\|code\|label`, `rea-ghidra-seeds-v1`), aplicado como `-preScript` **antes** da auto-análise | `ghidra/GhidraAnalysisSeeds.js:9-24,51-91`, `ghidra/GhidraLauncher.js:402-409` |

**O REA não consome análise pré-existente.** Ele sempre faz `-import <target> -readOnly
-deleteProject` num projeto temporário `rea-project` (`ghidra/GhidraLauncher.js:326-381`); não
aceita `-process`, `.gzf` nem DB do Ghidra. O `snapshot_path=<*.json>` de
`open_binary`/`close_binary` é só *replay* de evidência do próprio REA — e exige uma análise
completa, logo não resolve o problema.

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
| **Validação ponta a ponta (P0.0)** | ✅ **`EXIT=0` em 5m54,8 s** com `REA_GHIDRA_STARTUP_TIMEOUT_MS=900000` (`rea analyze --provider ghidra`) — onde antes era `provider_timeout` aos 330 s. `evidence_id` emitido |

Ou seja: **o alvo é analisável**; o que faltava era deadline (e o default era tragicômico).

O projeto serve para reprocessamento futuro — gerar um `REA_GHIDRA_SEED_FILE` a partir dos nomes
recuperados é o único vetor real de "alimentar" o REA:

```bash
# reprocessar SEM re-analisar:
analyzeHeadless <PROJECT_LOCATION> sublime_text -process sublime_text -noanalysis -postScript <dump.java>
```

Pegadinhas: o `JAVA_HOME` do shell pode ser < 21 (Ghidra 12.1.4 exige ≥ 21 → o script força
`23-zulu`); e o `ProjectLocator` do Ghidra **recusa** componente de path iniciado por `.` — por
isso `$REA_TOOLS_DIR` (`~/.local/...`) é acessado via symlink `~/sr-tools`.

### Track A — análise SEM Ghidra

Fase 1 que **não** depende do núcleo nativo (o entregável é a spec **abstrata**), em
[`docs/analysis/`](analysis/):

| Doc | Conteúdo | Situação |
|---|---|---|
| [`api-python.md`](analysis/api-python.md) | superfície completa da API de plugins 3.14 (64 funcs de módulo, 17 enums, 25 classes, 331 métodos, 284 símbolos `sublime_api.*`) + delta vs 3.3 + 12 padrões da ponte + ledger `E1–E33` | ✅ 353 linhas |
| [`ipc-plugin-host.md`](analysis/ipc-plugin-host.md) | mecanismo da ponte C++↔Python (**memória compartilhada POSIX nomeada + semáforos**) inferido dos `plugin_host-*` | ✅ 32 KB |

Achado central do Track A: a API Python é um **facade fino** sobre o módulo nativo `sublime_api`,
com **handles opacos (int)** e callbacks Python retidos no C++ — ver os docs.

---

## ▶️ Como retomar

```bash
cd /home/gbortolas/ai/workspaces/sublime-rea
set -a; . ./setup/env.sh; set +a          # ← obrigatório para o CLI

# 1) confirmar que o ambiente continua saudável
rea doctor --client opencode --provider ghidra --format json

# 2) recon barato do alvo (funciona, não depende do Ghidra)
rea inspect-binary-layout target/sublime_text/sublime_text --format json

# 3) ao atacar o Ghidra — subir o deadline (a auto-análise leva ~10-40 min)
export REA_GHIDRA_STARTUP_TIMEOUT_MS=3600000
rea open-binary target/sublime_text/sublime_text ...

# 3b) ou consultar o projeto persistente já pré-analisado (Track B)
bin/ghidra-preanalyze.sh        # cria/atualiza o projeto; ver o header do script
```

Material de apoio: skill `reverse-engineer-anything` (+ `references/native-and-artifacts.md`).

---

## 🗂️ Estado do repositório

- Repo **git** inicializado (não era antes). 3 commits, working tree limpo.
- `.gitignore` cobre `target/`, `tools/`, `setup/env.sh`, artefatos Ghidra, venvs, etc.
- ⚠️ `bin/` (42 MB de `.deb` + `.tar.xz`) **está versionado** → `.git` com ~42 MB.
  Alternativa: `git rm --cached bin/*` + download sob demanda (ver BACKLOG).

---

## Convenções / diretórios

| Caminho | Papel |
|---|---|
| `$REA_TOOLS_DIR` = `~/.local/share/sublime-rea-tools/` | ferramentas baixadas (fora do repo) |
| `…/ghidra_12.1.4_PUBLIC/` | instalação do Ghidra |
| `…/pwntools-venv/` | venv do provider offline |
| `…/snapshots/` | destino pretendido dos snapshots de análise (vazio) |
| `target/` | alvo extraído (gitignored) |
| `setup/env.sh` | gerado; `source` obrigatório para o CLI |
