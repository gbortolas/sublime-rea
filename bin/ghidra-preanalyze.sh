#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ghidra-preanalyze.sh — pré-análise Ghidra headless num projeto PERSISTENTE.
#
# Por que existe: o provider Ghidra do REA importa, analisa e DESCARTA o projeto
# em cada abertura (`-readOnly -deleteProject`, projeto "rea-project" em
# rea-agents/dist/ghidra/GhidraLauncher.js:326-381) dentro de um deadline fixo
# (DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS = 330_000 ms). Num ELF64 PIE stripped de
# ~10 MB a auto-análise estoura esse prazo e o resultado é perdido.
#
# Aqui rodamos o MESMO analyzeHeadless sem deadline, gravando num projeto
# persistente que pode ser consultado/reprocessado depois.
#
# ATENÇÃO — a rodada padrão é uma RE-ANÁLISE COMPLETA, não incremental: ela importa o
# alvo com ``-import -overwrite``, ou seja, descarta e refaz o projeto do zero, pagando
# a auto-análise inteira de novo (≈334 s neste alvo). Para consultar/reprocessar um
# projeto JÁ analisado sem reanalisar (segundos), use o projeto persistente:
#   .../support/analyzeHeadless <PROJECT_LOCATION> <PROJECT_NAME> \
#       -process sublime_text -noanalysis -postScript <dump.java>
#
# Uso:
#   bin/ghidra-preanalyze.sh            # foreground (uma rodada por vez; ver lock abaixo)
#   bin/ghidra-preanalyze.sh --help     # imprime este cabeçalho
#   nohup bin/ghidra-preanalyze.sh \
#       > /tmp/opencode/ghidra-headless-sublime.log 2>&1 &   # destacado
#
# Concorrência: um lock (flock em $LOCK_FILE) impede duas rodadas simultâneas — duas
# execuções disputariam o mesmo .gpr/.rep. A segunda falha com mensagem clara.
#
# Configuráveis: TARGET, PROJECT_NAME, LOG_DIR, LOCK_FILE, REA_TOOLS_ALIAS e
# GHIDRA_JAVA_HOME (ver abaixo).
# ---------------------------------------------------------------------------
set -euo pipefail

case "${1:-}" in
  -h | --help)
    # imprime o bloco de comentários do topo (o próprio --help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

set -a
. ./setup/env.sh
set +a

TARGET="${TARGET:-$REPO_ROOT/target/sublime_text/sublime_text}"

# Ghidra 12.1.4 exige JDK >= 21 (Ghidra/application.properties: application.java.min=21).
# O JAVA_HOME herdado do shell (~/.sdkman/candidates/java/17.0.20-zulu) é rejeitado:
#   WARNING: JAVA_HOME environment specifies unsupported java version: .../17.0.20-zulu
#   ERROR: Unable to prompt user for JDK path, no TTY detected.
export JAVA_HOME="${GHIDRA_JAVA_HOME:-$HOME/.sdkman/candidates/java/23-zulu}"

# Ghidra valida CADA elemento do path do projeto (ProjectLocator ->
# GhidraURL.checkValidProjectPath -> NamingUtilities.checkName) e aborta com
# "Path element starting with '.' is not permitted" — e $REA_TOOLS_DIR vive em
# ~/.local/share/...  O alias sem ponto abaixo (symlink) contorna isso sem
# tirar os dados de $REA_TOOLS_DIR.
TOOLS_ALIAS="${REA_TOOLS_ALIAS:-$HOME/sr-tools}"
if [[ -L "$TOOLS_ALIAS" ]]; then
  # symlink nosso: re-aponta para o $REA_TOOLS_DIR vigente
  ln -sfn "$REA_TOOLS_DIR" "$TOOLS_ALIAS"
elif [[ -e "$TOOLS_ALIAS" ]]; then
  # `ln -sfn` num diretório REAL existente cria o link DENTRO dele (silencioso) e o
  # projeto Ghidra iria para o lugar errado — melhor falhar alto.
  {
    echo "ERRO: $TOOLS_ALIAS existe e NÃO é um symlink (diretório/arquivo real)."
    echo "      'ln -sfn' criaria o link dentro dele e o projeto Ghidra iria para o lugar errado."
    echo "      Mova/remova esse caminho ou aponte o alias para outro lugar, ex.:"
    echo "        REA_TOOLS_ALIAS=\$HOME/.rea-tools $0"
  } >&2
  exit 1
else
  # caminho do alias precisa existir para o symlink ser criado
  mkdir -p "$(dirname "$TOOLS_ALIAS")"
  ln -sfn "$REA_TOOLS_DIR" "$TOOLS_ALIAS"
fi
PROJECT_LOCATION="$TOOLS_ALIAS/ghidra-projects/sublime-rea"
PROJECT_NAME="${PROJECT_NAME:-sublime_text}"

LOG_DIR="${LOG_DIR:-/tmp/opencode}"
mkdir -p "$LOG_DIR" "$PROJECT_LOCATION"

# Uma rodada por vez: duas execuções concorrentes disputariam o mesmo .gpr/.rep.
# O fd 9 fica aberto pelo processo (o `exec` abaixo herda o lock) e o flock é liberado
# quando ele termina — lock órfão de crash não trava (flock é por fd, não por arquivo).
LOCK_FILE="${LOCK_FILE:-$LOG_DIR/ghidra-preanalyze.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  {
    echo "ERRO: já existe uma pré-análise em andamento (lock: $LOCK_FILE)."
    echo "      Aguarde a rodada atual terminar (o lock some sozinho quando ela sair);"
    echo "      'fuser -v $LOCK_FILE' mostra o processo dono do lock."
  } >&2
  exit 1
fi

# Sem -analysisTimeoutPerFile: o default do Ghidra é SEM limite por arquivo
# (é justamente o que o REA não permite configurar).
# `-import ... -overwrite` = RE-ANÁLISE COMPLETA do zero (apaga o projeto anterior).
# Para reprocessar sem reanalisar, troque por
# `-process "$PROJECT_NAME" -noanalysis -postScript <script>` (incremental) — ver o cabeçalho.
exec "$GHIDRA_INSTALL_DIR/support/analyzeHeadless" \
  "$PROJECT_LOCATION" "$PROJECT_NAME" \
  -import "$TARGET" \
  -overwrite \
  -log "$LOG_DIR/ghidra-headless-sublime-ghidra.log" \
  -scriptlog "$LOG_DIR/ghidra-headless-sublime-script.log"
