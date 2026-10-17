# setup/ — ambiente reproduzível do sublime-rea

Instalador em **Python 3.10+** (com saída colorida via `rich`) que prepara, de forma
**idempotente**, tudo que o projeto precisa para o reverse engineering do Sublime Text
com a ferramenta **REA** (MCP) + **Ghidra**:

- **REA** (`rea-agents@6.5.0`) — cliente MCP de engenharia reversa.
- **Ghidra 12.1.4** — provider de análise profunda exigido pelo REA (pinado).
- **pwntools-elf** — provider offline (venv Python dedicado) usado por `inspect_binary_layout`.
- **Alvo** Sublime Text build 4215 — tarball baixado **sob demanda** (URL + SHA-256
  pinados em `versions.env`) e extraído para `target/`.
- **Registro MCP** no client `opencode` (inclui `REA_PWNTOOLS_PYTHON`).
- **Verificação** final com `rea doctor`.

O instalador canônico é **`setup/setup.py`**. O antigo `setup/setup.sh` (bash) permanece
no disco apenas como **legacy** — não é mais o recomendado e **recusa rodar** por padrão.
Ele só tem **9 etapas** e **não detecta o `JAVA_HOME`** (o `env.sh` gerado pode sair sem
esse export, deixando o `rea doctor` em `healthy: false`); para executá-lo de todo é
**obrigatório** definir a variável de escape `SCRIBE_ALLOW_LEGACY_SETUP=1`.

## Arquivos

| Arquivo | Papel |
|---|---|
| `setup.py` | Instalador Python idempotente (**o único que você executa**). |
| `setup.sh` | Instalador bash antigo — **legacy/deprecated**, mantido só por referência. **Recusa rodar** sem `SCRIBE_ALLOW_LEGACY_SETUP=1` (9 etapas; sem detecção de `JAVA_HOME`). |
| `versions.env` | Versões, URLs e SHA-256 pinados (fonte única de verdade). |
| `env.sh` | **Gerado** pelo `setup.py`; `source` para exportar o ambiente. Ignorado pelo git. |
| `.venv/` | **Gerado** pelo bootstrap do `rich` (só quando o `rich` falta no `python3`). Ignorado pelo git. |
| `$REA_TOOLS_DIR/pwntools-venv/` | **Gerado** pela etapa 6: venv com `pwntools`/`pyelftools`/`unicorn` pinados, apontado por `REA_PWNTOOLS_PYTHON` (fora do repo). |
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
- **Rede:** acesso a `github.com` (~543 MiB de download do Ghidra), a
  `download.sublimetext.com` (~22 MiB do tarball do alvo — só na 1ª vez, ver
  *Alvo (tarball)*) e ao registry npm.
- **Disco:** ~1,5 GiB livres para o Ghidra extraído em `$REA_TOOLS_DIR`.
- **pwntools (offline):** a etapa 6 cria um venv Python em `$REA_TOOLS_DIR/pwntools-venv`
  e instala `pwntools`/`pyelftools`/`unicorn` (pinados). Precisa do módulo `venv` do Python;
  se faltar `ensurepip`/`python3-venv`, o script obtém o `pip` via **`get-pip.py`** (sem
  sudo). Custa ~1–2 min e alguns **~200 MiB** adicionais em `$REA_TOOLS_DIR`; requer rede
  a `pypi.org` (e a `bootstrap.pypa.io` no fallback).

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

## O que o script faz (10 etapas)

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
6. **pwntools (offline)** — cria um venv Python em `$REA_TOOLS_DIR/pwntools-venv` (via
   `python3 -m venv`; se faltar `ensurepip`/`python3-venv`, obtém o `pip` com o
   `get-pip.py` oficial, **sem sudo**) e instala os pinos `pwntools==4.15.0`,
   `pyelftools==0.33`, `unicorn==2.1.2` (+ `setuptools==80.9.0`, exigido pelo import do
   `unicorn`). Idempotente: se o venv já tem os pacotes nas versões exatas, **não
   reinstala** (valida importando e checando as versões). Exporta `REA_PWNTOOLS_PYTHON`
   para o processo.
7. **`GHIDRA_INSTALL_DIR` / `REA_PWNTOOLS_PYTHON` / `REA_GHIDRA_STARTUP_TIMEOUT_MS`** —
   (re)escreve **sempre** `setup/env.sh`
   (com `REA_TOOLS_DIR`, `GHIDRA_INSTALL_DIR`, `REA_PWNTOOLS_PYTHON` e
   `REA_GHIDRA_STARTUP_TIMEOUT_MS`); o `~/.bashrc` só
   com `--write-rc`, num bloco idempotente (não duplica se o bloco já existir).
8. **Alvo** — garante o tarball `bin/sublime_text_build_4215_x64.tar.xz`: se **já
   existir** com o SHA-256 pinado, usa direto (**não** toca na rede — funciona
   offline); se **ausente** (ou com SHA-256 divergente), baixa da `SUBLIME_TARBALL_URL`
   para `bin/….tar.xz.part` (urllib, retry/backoff, valida o tamanho vs
   `Content-Length`/pin) e **verifica o SHA-256 ANTES de promover** o `.part` (SHA
   divergente ⇒ erro fatal, **nada** é extraído nem o arquivo existente é
   sobrescrito). Depois extrai **num diretório temporário** e só então faz o `mv` para
   `target/` (extração atômica: um `tar` interrompido não sobrescreve o alvo válido).
   Valida o binário (`target/sublime_text/sublime_text`): tamanho > 1 MiB e magic
   **ELF** (`\x7fELF`). Idempotente por essa validação.
9. **MCP** — `rea setup --client opencode --yes` (repassa `--dry-run`) e, em seguida,
   garante `REA_PWNTOOLS_PYTHON` e `REA_GHIDRA_STARTUP_TIMEOUT_MS` no bloco `environment`
   do servidor `rea` do
   `opencode.jsonc`: o `rea setup` **não** propaga essas variáveis sozinho (o provider
   offline não expõe `registrationEnvironment`), então o script faz uma edição
   **cirúrgica** por texto (com backup `.bak` e validação do JSON), que o `rea setup`
   passa a **preservar** nas execuções seguintes.
10. **Verificação** — roda `rea doctor --client opencode --provider ghidra --format json`,
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
| `4` | Alvo: falha/hash errado no **download** do tarball, tarball inválido, `tar`/`xz` ausentes ou extração sem o binário ELF esperado. |
| `5` | `rea setup --client opencode` falhou. |
| `6` | pwntools: falha ao criar o venv, obter o `pip` ou instalar os pacotes pinados. |
| `130` | Interrompido com Ctrl-C. |

## Alvo (tarball do Sublime Text)

O tarball do alvo (`bin/sublime_text_build_4215_x64.tar.xz`, ~22 MiB) **não é mais
versionado no git**. Ele é baixado **sob demanda** pela etapa 8, com a URL e o SHA-256
**pinados** em `setup/versions.env` (`SUBLIME_TARBALL_URL`, `SUBLIME_TARBALL_SHA256`,
`SUBLIME_TARBALL_SIZE_BYTES`) — a mesma disciplina do Ghidra.

- **1ª execução / arquivo ausente:** baixa da URL oficial para `bin/….tar.xz.part`
  (atômico), valida o SHA-256 e **só então** promove para `bin/….tar.xz`.
- **Execuções seguintes:** com o arquivo já presente e o SHA-256 correto, **nenhum
  download** é feito (idempotente).
- **Offline:** se você já tem `bin/….tar.xz` com o SHA-256 correto, o setup **não**
  acessa a rede. Sem o arquivo e sem rede, a etapa 8 falha com exit `4` e uma dica para
  colocá-lo manualmente em `bin/`.
- **Fail-closed:** SHA-256 divergente (arquivo corrompido **ou** pin adulterado) ⇒ erro
  fatal (exit `4`): **nada** é extraído e o arquivo existente **não** é sobrescrito.
- `--install-deps` **não** muda nada disso (ele só trata deps de sistema via apt/sudo);
  o download do alvo **nunca** usa `sudo` e só depende de `urllib` (stdlib).

> O deb do Sublime (`bin/sublime-text_build-4215_amd64.deb`) também está no `.gitignore`
> — nenhuma etapa do setup o baixa; é apenas um pin residual em `versions.env`.

## Diretórios e variáveis

| Variável | Default | Descrição |
|---|---|---|
| `REA_TOOLS_DIR` | `~/.local/share/sublime-rea-tools` | Onde o Ghidra é baixado/extraído (fora do repo). |
| `GHIDRA_INSTALL_DIR` | `$REA_TOOLS_DIR/ghidra_12.1.4_PUBLIC` | Diretório do Ghidra extraído; exportado para o REA. |
| `REA_PWNTOOLS_PYTHON` | `$REA_TOOLS_DIR/pwntools-venv/bin/python` | Interpretador com `pwntools`/`pyelftools`/`unicorn` pinados; exportado para o REA e gravado no registro MCP. |
| `REA_PWNTOOLS_VENV_DIRNAME` | `pwntools-venv` | Nome do subdiretório do venv (pin em `versions.env`). |
| `REA_GHIDRA_STARTUP_TIMEOUT_MS` | `900000` (15 min) | Deadline em ms da auto-análise do provider Ghidra (o default do REA é `330000`; neste alvo a análise mede ~334 s). Exportado no `env.sh` e gravado no registro MCP. |
| `PWNTOOLS_VERSION` / `PYELFTOOLS_VERSION` / `UNICORN_VERSION` | `4.15.0` / `0.33` / `2.1.2` | Versões exigidas pelo provider offline `pwntools-elf` (pin em `versions.env`). |

Para persistir em novas sessões: `source setup/env.sh` (ou use `--write-rc` uma vez).

## Provider offline pwntools (`REA_PWNTOOLS_PYTHON`)

A ferramenta `inspect_binary_layout` usa o provider **offline `pwntools-elf`**. Ele **não**
é um binário: o REA executa um interpretador **Python fornecido pelo usuário** e exige as
versões exatas `pwntools 4.15.0`, `pyelftools 0.33` e `Unicorn 2.1.2` (o REA **nunca**
instala Python nem pacotes). Sem isso, a ferramenta responde `provider_unavailable`.

Por isso a **etapa 6** do `setup.py` cria um **venv dedicado** em
`$REA_TOOLS_DIR/<REA_PWNTOOLS_VENV_DIRNAME>` (default `.../pwntools-venv`) e faz o
`pip install` dos pinos (`+ setuptools==80.9.0`, exigido pelo `import unicorn`). Esse
caminho é exportado como:

- `REA_PWNTOOLS_PYTHON="$REA_TOOLS_DIR/pwntools-venv/bin/python"` em `setup/env.sh`; e
- a mesma chave dentro de `mcp.servers.rea.environment` no `opencode.jsonc` — é assim que
  o **agente** (via MCP lançado pelo opencode) enxerga a variável.

O `rea setup` **não** propaga `REA_PWNTOOLS_PYTHON` sozinho; o `setup.py` grava a chave
com uma edição cirúrgica do JSONC (backup `.bak` + validação), que o `rea setup` passa a
**preservar**. Para trocar o diretório do venv, ajuste `REA_PWNTOOLS_VENV_DIRNAME` em
`versions.env` (ou remova o venv e rode o setup de novo para recriá-lo).

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
git clone <repo> sublime-rea && cd sublime-rea        # alvo NÃO vem no repo (é baixado)
python3 setup/setup.py --dry-run                      # confira o plano
python3 setup/setup.py --install-deps --write-rc      # instala (baixa o alvo na 1ª vez)
source setup/env.sh                                   # (ou abra um shell novo)
```

## Como verificar

```bash
python3 setup/setup.py --dry-run                      # exit 0; mostra mkdir → lock → .part → mv
sha256sum "$REA_TOOLS_DIR"/ghidra_12.1.4_PUBLIC_*.zip # bate com versions.env
sha256sum bin/sublime_text_build_4215_x64.tar.xz      # bate com SUBLIME_TARBALL_SHA256
rea doctor --client opencode --provider ghidra --format json | python3 -m json.tool
ls -l target/sublime_text/sublime_text                # ELF do alvo extraído
source setup/env.sh                                   # exporta REA_PWNTOOLS_PYTHON
rea inspect-binary-layout target/sublime_text/sublime_text --format json | python3 -m json.tool
```

O próprio `setup.py` já executa o gate do `rea doctor` no fim e retorna exit != 0
quando o campo escopado `healthy` for `false` (o campo global `environment_healthy`
não é usado como gate — veja a etapa 10 acima).

## Troubleshooting

- **`rea doctor` com `healthy: false` por `ghidra`** — `GHIDRA_INSTALL_DIR`
  não está exportado na sessão. Rode `source setup/env.sh` (ou reabra o shell após `--write-rc`).
  (Avisos de `environment_healthy`/`informational_checks` — engines opcionais e outros
  clients — são **esperados** e não indicam problema.)
- **`inspect_binary_layout` retorna `provider_unavailable`** — `REA_PWNTOOLS_PYTHON` não
  está disponível para o REA. Rode `source setup/env.sh` (ou reabra o shell) e confirme a
  chave em `mcp.servers.rea.environment` no `opencode.jsonc`: o agente só enxerga a
  variável pelo **registro MCP** (reinicie o opencode após o setup).
- **venv do pwntools quebrado / pacotes ausentes ou em versão errada** — remova o
  diretório `$REA_TOOLS_DIR/pwntools-venv` e rode o setup novamente (ele recria o venv e
  reinstala os pinos). Para inspecionar: `"$REA_TOOLS_DIR/pwntools-venv/bin/python" -m pip list`.
- **`ensurepip`/`python3-venv` ausente** — o setup contorna baixando o `get-pip.py` oficial
  (**sem sudo**). Se não houver rede para `bootstrap.pypa.io`/`pypi.org`, instale
  `python3-venv` (`sudo apt-get install python3-venv`) e rode de novo.
- **SHA-256 do Ghidra divergente** — download corrompido/proxy. O script apaga o zip e
  rebaixa; se persistir, baixe manualmente de `GHIDRA_URL` e confira contra `versions.env`.
- **`lock de instalação em uso`** — existe `$REA_TOOLS_DIR/.lock` (outra execução ou lock
  stale de uma execução interrompida). Confirme que ninguém está rodando e remova o diretório.
- **`npm prefix` não gravável** — o script usa `npx -y rea-agents@6.5.0` automaticamente;
  para instalar global, ajuste o prefix (`npm config set prefix ~/.local`) ou use nvm.
- **`node < 20`** — prefira nvm/nodesource; o `nodejs` do apt em distros antigas costuma ser antigo.
- **Extraído mas não achou o alvo** — o setup baixa `bin/sublime_text_build_4215_x64.tar.xz`
  sozinho se faltar (confira o SHA-256 nas mensagens); o tarball contém
  `sublime_text/sublime_text`.
- **`SHA-256 do tarball do alvo não confere`** — o arquivo baixado (ou o local) não bate
  com `SUBLIME_TARBALL_SHA256`. O setup **não** extrai nada: apague o arquivo (ou o
  `.part`) e rode de novo; se persistir, o pin ou o arquivo estão adulterados — confira
  contra `versions.env` / a URL oficial antes de prosseguir.
- **Sem rede na 1ª execução** — baixe o tarball oficial manualmente
  (`SUBLIME_TARBALL_URL`) para `bin/sublime_text_build_4215_x64.tar.xz`, confira o
  SHA-256 contra `versions.env` e rode o setup (ele **não** tentará baixar de novo).
- **Rebaixar/reextrair Ghidra à força** — remova `$GHIDRA_INSTALL_DIR` (ou o zip) e rode de novo.
- **Saída feia/sem cor** — o `rich` não foi obtido e o script caiu no fallback plain.
  Confira `python3 -c "import rich"`; se preferir instalar à mão: `python3 -m pip install rich`.

## Notas de design

- **Idempotência:** cada etapa detecta o estado atual e só age se preciso (SHA válido,
  `launch.properties` presente, `rea --version` correto, tarball do alvo presente com
  SHA-256 correto, alvo já extraído, bloco do rc presente).
- **Segurança por padrão:** sem flags, zero `sudo` e zero alteração de rc; `--dry-run` não
  tem efeitos colaterais.
- **Downloads atômicos e verificados:** `.part` → `mv`; SHA-256 do Ghidra **e** do tarball
  do alvo conferidos **antes** de extrair (fail-closed); lock de instalação e cleanup
  garantido por `try/finally`. `setup/env.sh` é
  escrito atomicamente (temp + `rename`) e o Ghidra antigo só é removido após o novo dir
  estar no lugar.
- **`rich` opcional:** dependência de *conforto* (UI), nunca de corretude — se faltar, o
  bootstrap tenta o venv local e há fallback plain.
