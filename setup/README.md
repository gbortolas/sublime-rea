# setup/ — ambiente reproduzível do sublime-rea

Instalador em **Python 3.10+** (com saída colorida via `rich`) que prepara, de forma
**idempotente**, tudo que o projeto precisa para o reverse engineering do Sublime Text
com a ferramenta **REA** (MCP) + **Ghidra**:

- **REA** (`rea-agents@6.5.0`) — cliente MCP de engenharia reversa.
- **Ghidra 12.1.4** — provider de análise profunda exigido pelo REA (pinado).
- **Alvo** Sublime Text build 4215 — extraído do bundle local `bin/`.
- **Registro MCP** no client `opencode`.
- **Verificação** final com `rea doctor`.

O instalador canônico é **`setup/setup.py`**. O antigo `setup/setup.sh` (bash) permanece
no disco apenas como **legacy** — não é mais o recomendado.

## Arquivos

| Arquivo | Papel |
|---|---|
| `setup.py` | Instalador Python idempotente (**o único que você executa**). |
| `setup.sh` | Instalador bash antigo — **legacy**, mantido só por referência. |
| `versions.env` | Versões, URLs e SHA-256 pinados (fonte única de verdade). |
| `env.sh` | **Gerado** pelo `setup.py`; `source` para exportar o ambiente. Ignorado pelo git. |
| `.venv/` | **Gerado** pelo bootstrap do `rich` (só quando o `rich` falta no `python3`). Ignorado pelo git. |
| `README.md` | Este documento. |

## Requisitos

- **SO:** Linux x86_64 (validado em pop 22.04).
- **Deps base:** `tar`, `xz`, `python3`, `node >= 20`, `npm` (o download usa `urllib` e a
  extração usa `zipfile` da stdlib — **não** precisa de `curl` nem `unzip`). `git` é
  apenas **checado** (opcional: útil só para clonar/atualizar o repo), nunca obrigatório
  para o setup rodar.
- **Python:** 3.10+ (o próprio `python3` das deps base). O `rich` é opcional — o script
  se vira para obtê-lo (ver *Bootstrap do `rich`*).
- **Java:** JDK **>= 21** (ver seção *Java/JDK*). O script **não** instala JDK.
- **Rede:** acesso a `github.com` (~543 MiB de download do Ghidra) e ao registry npm.
- **Disco:** ~1,5 GiB livres para o Ghidra extraído em `$REA_TOOLS_DIR`.

## Uso

```bash
# Ver a ajuda
python3 setup/setup.py --help

# Simulação: NÃO baixa, NÃO usa sudo, NÃO altera arquivos
python3 setup/setup.py --dry-run

# Instalação completa numa máquina nova (pede sudo p/ deps e grava ~/.bashrc)
python3 setup/setup.py --install-deps --write-rc

# Já tenho as deps e não quero mexer no rc
python3 setup/setup.py
```

### Flags

| Flag | Efeito |
|---|---|
| `--help`, `-h` | Mostra a ajuda (e **pula** o bootstrap do `rich`). |
| `--dry-run` | Imprime o plano sem executar nada (sem download, sem sudo, sem escrita). |
| `--install-deps` | **Só com esta flag** usa o gerenciador de pacotes (sudo/apt) para as deps faltantes. |
| `--write-rc` | **Só com esta flag** anexa `source setup/env.sh` ao `~/.bashrc`. |

> Sem flags: **nunca** usa sudo e **nunca** altera o rc do shell.

### Bootstrap do `rich`

O `rich` **nunca** é fatal: se não estiver disponível, o script continua funcionando.

1. Se o `python3` atual já tem `rich`, usa direto.
2. Senão, cria um venv local em `setup/.venv`, instala `rich==$RICH_VERSION` (pin em
   `versions.env`) e **se re-executa** dentro do venv (`pip` ausente → tenta `ensurepip`).
3. Se não der para criar o venv/instalar o `rich`, cai num **fallback plain** (texto
   simples, cor só em TTY) e segue normalmente.

Em `--dry-run` e `--help` o bootstrap é **pulado** — o contrato de "zero efeitos
colaterais" inclui **não** criar o `setup/.venv`.

## O que o script faz (passo a passo)

1. **SO/arch** — confere Linux x86_64; avisa (sem abortar) em outros ambientes.
2. **Deps base** — checa `tar xz python3 git node>=20 npm`; lista o que falta; instala
   **apenas** com `--install-deps` (`apt-get update` + `apt-get install`). O `git` é só
   **checado** (recomendado, não essencial); `curl`/`unzip` **não** são exigidos
   (urllib + `zipfile`).
3. **Java** — acha o `java` via `JAVA_HOME/bin` ou PATH e compara a versão com o mínimo
   do Ghidra (**21**); avisa/instrutura, **nunca** instala.
4. **REA** — reusa o `rea` global se `rea --version` já for `6.5.0`; senão instala
   `rea-agents@6.5.0` globalmente **se o `npm prefix` for gravável**, caso contrário cai
   para `npx -y rea-agents@6.5.0` (efêmero).
5. **Ghidra 12.1.4** — só considera instalado com evidência real
   (`support/launch.properties`). Ordem: `mkdir` do `$REA_TOOLS_DIR` → **lock**
   (`.lock`) → download atômico em `.part` (urllib, retry/backoff, **confere o tamanho
   baixado contra o `Content-Length`/pin dentro do retry**) → `mv` → **verifica o
   SHA-256 ANTES de extrair** (aborta se divergir) → extração atômica num diretório
   temporário (`tempfile.mkdtemp(".extract.", dir=$REA_TOOLS_DIR)`) via `zipfile`
   (stdlib), **rejeitando membros com caminho absoluto ou `..`** e preservando o modo
   → `mv` final (o Ghidra anterior é guardado em `.old.<pid>` e só removido após o novo
   dir estar no lugar; restaurado se o `mv` falhar) → valida `support/launch.properties`.
   Lock, `.part` e o dir temporário são limpos sempre (cleanup garantido).
6. **`GHIDRA_INSTALL_DIR`** — (re)escreve **sempre** `setup/env.sh` (com `REA_TOOLS_DIR` e
   `GHIDRA_INSTALL_DIR`); o `~/.bashrc` só com `--write-rc`, num bloco idempotente
   (não duplica se o bloco já existir).
7. **Alvo** — extrai `bin/sublime_text_build_4215_x64.tar.xz` **num diretório temporário**
   e só então faz o `mv` para `target/` (extração atômica: um `tar` interrompido não
   sobrescreve o alvo válido). Valida o binário (`target/sublime_text/sublime_text`):
   tamanho > 1 MiB e magic **ELF** (`\x7fELF`). Idempotente por essa validação.
8. **MCP** — `rea setup --client opencode --yes` (repassa `--dry-run`).
9. **Verificação** — roda `rea doctor --client opencode --provider ghidra --format json`,
   **tolera ruído** (`npx`/avisos) antes do JSON (extrai o último objeto JSON do stdout)
   e **falha com exit != 0** se o campo **escopado `healthy`** for `false`, mostrando os
   motivos (`scope_checks` com `ok: false`).
   O gate **não** usa `environment_healthy`: esse é um flag **global** que inclui
   `informational_checks` (engines opcionais — hopper/ida/jadx — e registro em **outros**
   clients: `claude_code`, `dsh`, `hermes`, `omp`, `pi`, `vscode`, `windsurf`) e por isso é
   `false` em praticamente qualquer máquina. Quando `healthy` é `true`, essas pendências
   informacionais são impressas apenas como **avisos** (não contam como erro nem mudam o
   exit code).

### Códigos de saída

| Código | Significado |
|---|---|
| `0` | Sucesso (em `--dry-run`, nenhum efeito colateral). |
| `1` | `rea doctor` com `healthy: false` (escopo pedido não saudável) ou erro inesperado. |
| `2` | Uso/config: `versions.env` ausente, ilegível ou com pin faltando/**vazio** (`CHAVE=`). |
| `3` | Ghidra: lock em uso, falha de download, SHA-256 divergente, extração inválida. |
| `4` | Alvo: tarball ausente, `tar`/`xz` ausentes ou extração sem o binário ELF esperado. |
| `5` | `rea setup --client opencode` falhou. |
| `130` | Interrompido com Ctrl-C. |

## Diretórios e variáveis

| Variável | Default | Descrição |
|---|---|---|
| `REA_TOOLS_DIR` | `~/.local/share/sublime-rea-tools` | Onde o Ghidra é baixado/extraído (fora do repo). |
| `GHIDRA_INSTALL_DIR` | `$REA_TOOLS_DIR/ghidra_12.1.4_PUBLIC` | Diretório do Ghidra extraído; exportado para o REA. |

Para persistir em novas sessões: `source setup/env.sh` (ou use `--write-rc` uma vez).

## Java / JDK

**Ghidra 12.1.x exige, no mínimo, JDK 21** — não 25. (O JDK 25 só passou a ser
exigido a partir do **Ghidra 12.2**.) Fontes oficiais:

- *Getting Started (Ghidra 12.1)*: "Java 21 64-bit Runtime and Development Kit (JDK)".
  <https://ghidradocs.com/12.1_PUBLIC/GettingStarted.html>
- *What's New in Ghidra 12.1*: "IMPORTANT: Ghidra 12.1 requires, at minimum, JDK 21 to run."
- REA (*provider-evaluation.md*): "Current 12.1 releases require JDK 21 or newer and
  set no maximum. The bridge is verified with Ghidra 12.1.4 and JDK 21."

Portanto qualquer **JDK 21+** (21, 23, 24…) é compatível; pin do mínimo em
`GHIDRA_JDK_MIN_MAJOR`. Se faltar Java, instale um JDK 21+ (Temurin/Corretto):
<https://adoptium.net/temurin/releases/?version=21>. O `setup.py` apenas detecta e
instrui — nunca instala JDK.

## Como reproduzir numa máquina nova

```bash
git clone <repo> sublime-rea && cd sublime-rea        # bin/ já traz o alvo
python3 setup/setup.py --dry-run                      # confira o plano
python3 setup/setup.py --install-deps --write-rc      # instala
source setup/env.sh                                   # (ou abra um shell novo)
```

## Como verificar

```bash
python3 setup/setup.py --dry-run                      # exit 0; mostra mkdir → lock → .part → mv
sha256sum "$REA_TOOLS_DIR"/ghidra_12.1.4_PUBLIC_*.zip # bate com versions.env
rea doctor --client opencode --provider ghidra --format json | python3 -m json.tool
ls -l target/sublime_text/sublime_text                # ELF do alvo extraído
```

O próprio `setup.py` já executa o gate do `rea doctor` no fim e retorna exit != 0
quando o campo escopado `healthy` for `false` (o campo global `environment_healthy`
não é usado como gate — veja a etapa 9 acima).

## Troubleshooting

- **`rea doctor` com `healthy: false` por `ghidra`** — `GHIDRA_INSTALL_DIR`
  não está exportado na sessão. Rode `source setup/env.sh` (ou reabra o shell após `--write-rc`).
  (Avisos de `environment_healthy`/`informational_checks` — engines opcionais e outros
  clients — são **esperados** e não indicam problema.)
- **SHA-256 do Ghidra divergente** — download corrompido/proxy. O script apaga o zip e
  rebaixa; se persistir, baixe manualmente de `GHIDRA_URL` e confira contra `versions.env`.
- **`lock de instalação em uso`** — existe `$REA_TOOLS_DIR/.lock` (outra execução ou lock
  stale de uma execução interrompida). Confirme que ninguém está rodando e remova o diretório.
- **`npm prefix` não gravável** — o script usa `npx -y rea-agents@6.5.0` automaticamente;
  para instalar global, ajuste o prefix (`npm config set prefix ~/.local`) ou use nvm.
- **`node < 20`** — prefira nvm/nodesource; o `nodejs` do apt em distros antigas costuma ser antigo.
- **Extraído mas não achou o alvo** — confirme `bin/sublime_text_build_4215_x64.tar.xz`
  presente; o tarball contém `sublime_text/sublime_text`.
- **Rebaixar/reextrair Ghidra à força** — remova `$GHIDRA_INSTALL_DIR` (ou o zip) e rode de novo.
- **Saída feia/sem cor** — o `rich` não foi obtido e o script caiu no fallback plain.
  Confira `python3 -c "import rich"`; se preferir instalar à mão: `python3 -m pip install rich`.

## Notas de design

- **Idempotência:** cada etapa detecta o estado atual e só age se preciso (SHA válido,
  `launch.properties` presente, `rea --version` correto, alvo já extraído, bloco do rc presente).
- **Segurança por padrão:** sem flags, zero `sudo` e zero alteração de rc; `--dry-run` não
  tem efeitos colaterais.
- **Downloads atômicos e verificados:** `.part` → `mv`; SHA-256 do Ghidra conferido **antes**
  da extração; lock de instalação e cleanup garantido por `try/finally`. `setup/env.sh` é
  escrito atomicamente (temp + `rename`) e o Ghidra antigo só é removido após o novo dir
  estar no lugar.
- **`rich` opcional:** dependência de *conforto* (UI), nunca de corretude — se faltar, o
  bootstrap tenta o venv local e há fallback plain.
