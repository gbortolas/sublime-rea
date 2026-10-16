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

E, mais importante: **ainda não decompilamos nada.** O que existe hoje é:

1. ✅ o **ambiente** instalado, configurado e verificado;
2. ✅ o **alvo** extraído e **identificado** (anatomia ELF via `inspect-binary-layout`).

A **análise de verdade está bloqueada** — ver [Bloqueio](#-bloqueio-atual).

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

## ⛔ Bloqueio atual

O provider **Ghidra do REA tem timeout fixo de 330 s** e a auto-análise deste binário
**não termina nesse prazo**. Reproduzido duas vezes (MCP e CLI):

```
START=2026-10-16T11:06:00  END=2026-10-16T11:11:31  EXIT=1
provider_timeout · timeout_ms: 330000 · operation: list_documents
```

O REA usa projeto **temporário** (`/tmp/rea-ghidra-*`) e **descarta** ao falhar — logo
`rea analyze --snapshot` também não produz snapshot algum.

**Não existe env var para o timeout de análise.** Knobs existentes no `rea-agents@6.5.0`:

- `REA_GHIDRA_DISABLED_ANALYZERS` — desliga analyzers caros (pode reduzir o tempo de análise)
- `REA_GHIDRA_SEED_FILE` — possivelmente permite semear uma análise pré-existente (não documentado)

---

## ▶️ Como retomar

```bash
cd /home/gbortolas/ai/workspaces/sublime-rea
set -a; . ./setup/env.sh; set +a          # ← obrigatório para o CLI

# 1) confirmar que o ambiente continua saudável
rea doctor --client opencode --provider ghidra --format json

# 2) recon barato do alvo (funciona, não depende do Ghidra)
rea inspect-binary-layout target/sublime_text/sublime_text --format json

# 3) ao atacar o Ghidra — escolher UMA estratégia em BACKLOG.md
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
