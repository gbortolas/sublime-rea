#!/usr/bin/env bash
#
# setup.sh — instalador idempotente do ambiente do projeto sublime-rea.
#
# Instala/pina: REA (rea-agents), Ghidra (provider de análise), extrai o alvo
# Sublime Text, registra o MCP no opencode e valida tudo com `rea doctor`.
#
# Por padrão NUNCA usa sudo e NUNCA altera o rc do shell. Use --install-deps para
# instalar dependências de sistema (sudo) e --write-rc para persistir o export no
# ~/.bashrc. Idempotente: reexecutar não rebaixa/reextrai o que já existe.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Localização / configuração base
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSIONS_FILE="${SCRIPT_DIR}/versions.env"
ENV_FILE="${SCRIPT_DIR}/env.sh"
RC_FILE="${HOME}/.bashrc"

if [ ! -f "${VERSIONS_FILE}" ]; then
  echo "erro: ${VERSIONS_FILE} não encontrado" >&2
  exit 2
fi
# shellcheck source=versions.env
# shellcheck disable=SC1091
source "${VERSIONS_FILE}"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
DRY_RUN=0
INSTALL_DEPS=0
WRITE_RC=0
TOTAL_STEPS=9

usage() {
  cat <<'EOF'
setup.sh — ambiente reproduzível do projeto sublime-rea (REA + Ghidra + alvo)

Uso:
  bash setup/setup.sh [opções]

Opções:
  -h, --help        Mostra esta ajuda e sai.
      --dry-run     Imprime o que seria feito, SEM executar (não baixa nada,
                    não usa sudo, não altera arquivos).
      --install-deps
                    Instala dependências de sistema faltantes via gerenciador
                    de pacotes (use com cautela: requer sudo / apt).
      --write-rc    Anexa um bloco `source setup/env.sh` ao ~/.bashrc para
                    persistir GHIDRA_INSTALL_DIR nas novas sessões de shell.

Sem flags o script não usa sudo e não altera o rc do shell.
Exemplo completo numa máquina nova:
  bash setup/setup.sh --install-deps --write-rc
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)        usage; exit 0 ;;
    --dry-run)        DRY_RUN=1 ;;
    --install-deps)   INSTALL_DEPS=1 ;;
    --write-rc)       WRITE_RC=1 ;;
    *) echo "opção desconhecida: $1" >&2; echo; usage >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Cores + logging
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

log()  { printf '%s %s\n' "${C_BLUE}==>${C_RESET}" "$*"; }
ok()   { printf '%s %s\n' "${C_GREEN} ok${C_RESET}" "$*"; }
warn() { printf '%s %s\n' "${C_YELLOW}warn${C_RESET}" "$*" >&2; }
err()  { printf '%s %s\n' "${C_RED}erro${C_RESET}" "$*" >&2; }
step() { printf '\n%s\n' "${C_BOLD}[$1/${TOTAL_STEPS}] $2${C_RESET}"; }
have() { command -v "$1" >/dev/null 2>&1; }

# run: executa (ou apenas imprime, em dry-run). Nunca faz sudo em dry-run.
run() {
  if [ "${DRY_RUN}" = 1 ]; then
    printf '     %s[dry-run]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"
  else
    "$@"
  fi
}
show() { printf '     %s[dry-run]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"; }

# ---------------------------------------------------------------------------
# Variáveis derivadas (não sobrescreve um REA_TOOLS_DIR vindo do ambiente)
# ---------------------------------------------------------------------------
REA_TOOLS_DIR="${REA_TOOLS_DIR:-${REA_TOOLS_DIR_DEFAULT}}"
GHIDRA_ZIP_PATH="${REA_TOOLS_DIR}/${GHIDRA_ZIP_FILENAME}"
GHIDRA_INSTALL_DIR="${REA_TOOLS_DIR}/${GHIDRA_EXTRACTED_DIRNAME}"
TARBALL="${REPO_ROOT}/${SUBLIME_TARBALL}"
TARGET_BIN="${REPO_ROOT}/${SUBLIME_TARGET_BIN}"

if [ "${DRY_RUN}" = 1 ]; then
  printf '%s\n' "${C_YELLOW}${C_BOLD}== MODO DRY-RUN: nada será baixado, instalado ou alterado ==${C_RESET}"
fi

# helper: valida o SHA-256 do zip do Ghidra (retorna != 0 se ausente/divergente)
verify_zip_sha() {
  [ -f "${GHIDRA_ZIP_PATH}" ] || return 1
  local actual
  actual="$(sha256sum "${GHIDRA_ZIP_PATH}" | awk '{print $1}')"
  [ "${actual}" = "${GHIDRA_ZIP_SHA256}" ]
}

# ---------------------------------------------------------------------------
# 1. SO / arquitetura
# ---------------------------------------------------------------------------
step 1 "Sistema e arquitetura"
os="$(uname -s)"; arch="$(uname -m)"
if [ "${os}" = "Linux" ] && [ "${arch}" = "x86_64" ]; then
  ok "Linux x86_64"
else
  warn "ambiente '${os}/${arch}': Ghidra/REA foram validados em Linux x86_64; prossiga por sua conta e risco."
fi

# ---------------------------------------------------------------------------
# 2. Dependências base
# ---------------------------------------------------------------------------
step 2 "Dependências base"
MISSING=()
MISSING_PKGS=()
check_dep() {
  local cmd="$1" pkg="$2"
  if have "${cmd}"; then
    ok "${cmd}"
  else
    warn "faltando: ${cmd} (pacote: ${pkg})"
    MISSING+=("${cmd}")
    MISSING_PKGS+=("${pkg}")
  fi
}
check_dep curl    curl
check_dep unzip   unzip
check_dep tar     tar
check_dep xz      xz-utils
check_dep python3 python3
check_dep git     git

if have node; then
  node_ver="$(node -v | sed 's/^v//')"
  node_major="${node_ver%%.*}"
  if [ "${node_major}" -ge "${NODE_MIN_MAJOR}" ] 2>/dev/null; then
    ok "node ${node_ver}"
  else
    warn "node ${node_ver} < ${NODE_MIN_MAJOR} (preferir nvm/nodesource a 'apt install nodejs')"
    MISSING+=("node>=${NODE_MIN_MAJOR}")
    MISSING_PKGS+=("nodejs")
  fi
else
  warn "faltando: node (preferir nvm/nodesource a 'apt install nodejs')"
  MISSING+=("node>=${NODE_MIN_MAJOR}")
  MISSING_PKGS+=("nodejs")
fi
check_dep npm npm

if [ "${#MISSING[@]}" -gt 0 ]; then
  warn "dependências faltando: ${MISSING[*]}"
  if [ "${INSTALL_DEPS}" = 1 ]; then
    log "instalando via gerenciador de pacotes (precisa de sudo)..."
    run sudo apt-get update
    run sudo apt-get install -y "${MISSING_PKGS[@]}"
    warn "para Node nativo 'apt', confirme que a versão >= ${NODE_MIN_MAJOR}; se não, use nvm/nodesource."
  else
    warn "reexecute com --install-deps para instalar (ou instale manualmente)."
  fi
else
  ok "todas as dependências base presentes"
fi

# ---------------------------------------------------------------------------
# 3. Java vs mínimo do Ghidra (avisar, NÃO instalar)
# ---------------------------------------------------------------------------
step 3 "Java (Ghidra ${GHIDRA_VERSION} exige JDK >= ${GHIDRA_JDK_MIN_MAJOR})"
java_bin=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/java" ]; then
  java_bin="${JAVA_HOME}/bin/java"
elif have java; then
  java_bin="$(command -v java)"
fi

if [ -z "${java_bin}" ]; then
  warn "Java não encontrado no PATH nem em JAVA_HOME."
  warn "instale um JDK ${GHIDRA_JDK_MIN_MAJOR}+ (Temurin/Corretto): ${GHIDRA_JDK_URL}"
  warn "o setup NÃO instala JDK automaticamente."
else
  java_ver_line="$("${java_bin}" -version 2>&1 | head -n1)"
  java_num="$(printf '%s' "${java_ver_line}" | sed -n 's/.*version "\([0-9][0-9.]*\).*/\1/p')"
  java_major="${java_num%%.*}"
  if [ "${java_major}" = "1" ]; then
    java_major="$(printf '%s' "${java_num}" | cut -d. -f2)"
  fi
  if [ -n "${java_major}" ] && [ "${java_major}" -ge "${GHIDRA_JDK_MIN_MAJOR}" ] 2>/dev/null; then
    ok "Java ${java_major} em ${java_bin} (>= ${GHIDRA_JDK_MIN_MAJOR}, compatível)"
  else
    warn "Java detectado (${java_major:-?}) < ${GHIDRA_JDK_MIN_MAJOR}: ${java_ver_line}"
    warn "instale um JDK ${GHIDRA_JDK_MIN_MAJOR}+ (Temurin/Corretto): ${GHIDRA_JDK_URL}"
  fi
fi

# ---------------------------------------------------------------------------
# 4. REA (rea-agents) — global se o prefix do npm for gravável, senão npx
# ---------------------------------------------------------------------------
step 4 "REA (${REA_PACKAGE}@${REA_VERSION})"
REA_CMD=()
REA_VIA_NPX=0
rea_ready=0

if have rea; then
  # extrai major.minor.patch de formatos como "6.5.0" ou "rea-agents 6.5.0"
  cur_rea="$(rea --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
  if [ "${cur_rea}" = "${REA_VERSION}" ]; then
    ok "rea ${cur_rea} já instalado globalmente"
    rea_ready=1
  else
    warn "rea global encontrado (${cur_rea:-?}) != ${REA_VERSION}; será reinstalado"
  fi
fi

if [ "${rea_ready}" = 1 ]; then
  REA_CMD=(rea)
else
  npm_prefix=""
  if have npm; then
    npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  else
    warn "npm não encontrado no PATH; sem instalação global (fallback npx)"
  fi
  if [ -n "${npm_prefix}" ] && [ -w "${npm_prefix}" ]; then
    log "npm prefix gravável (${npm_prefix}) -> npm i -g ${REA_PACKAGE}@${REA_VERSION}"
    run npm install -g "${REA_PACKAGE}@${REA_VERSION}"
    REA_CMD=(rea)
  else
    warn "npm prefix não gravável (${npm_prefix:-vazio}); usando fallback efêmero via npx"
    REA_CMD=(npx -y "${REA_PACKAGE}@${REA_VERSION}")
    REA_VIA_NPX=1
  fi
fi

if [ "${REA_VIA_NPX}" = 1 ]; then
  log "REA será invocado via npx efêmero (nada instalado globalmente)"
fi

# ---------------------------------------------------------------------------
# 5. Ghidra — download + SHA-256 + extração (idempotente)
# ---------------------------------------------------------------------------
step 5 "Ghidra ${GHIDRA_VERSION} (provider de análise)"
ghidra_extracted=0
# só considera instalado se houver evidência real (extração interrompida deixa a pasta pela metade)
if [ -f "${GHIDRA_INSTALL_DIR}/support/launch.properties" ]; then
  ok "Ghidra já extraído: ${GHIDRA_INSTALL_DIR}"
  ghidra_extracted=1
fi

if [ "${ghidra_extracted}" = 0 ]; then
  gh_extract_tmp="${REA_TOOLS_DIR}/.extract.$$"
  # o diretório de ferramentas precisa existir ANTES do curl -o e do lock
  run mkdir -p "${REA_TOOLS_DIR}"
  # lock simples: impede duas execuções simultâneas; só entra no cleanup depois de adquirido
  if [ "${DRY_RUN}" = 1 ]; then
    show "mkdir ${REA_TOOLS_DIR}/.lock  # lock de instalação"
  elif ! mkdir "${REA_TOOLS_DIR}/.lock" 2>/dev/null; then
    err "lock de instalação em uso: ${REA_TOOLS_DIR}/.lock (outra execução? remova se stale)"
    exit 3
  fi
  if [ "${DRY_RUN}" = 0 ]; then
    # limpeza em qualquer saída (sucesso ou falha) enquanto a etapa 5 não concluir
    trap 'rm -rf "${REA_TOOLS_DIR}/.lock" "${REA_TOOLS_DIR}/.extract.$$" "${GHIDRA_ZIP_PATH}.part"' EXIT
  fi

  if verify_zip_sha; then
    ok "zip já presente e SHA-256 confere"
  else
    if [ -f "${GHIDRA_ZIP_PATH}" ]; then
      warn "zip presente mas SHA-256 diverge; baixando novamente"
      run rm -f "${GHIDRA_ZIP_PATH}"
    fi
    log "baixando Ghidra ${GHIDRA_VERSION} (~${GHIDRA_ZIP_SIZE_BYTES} bytes / ~543 MiB)..."
    log "URL: ${GHIDRA_URL}"
    # download atômico: grava em .part e só promove o nome final após sucesso
    run curl -L --fail --retry 3 --retry-delay 2 -o "${GHIDRA_ZIP_PATH}.part" "${GHIDRA_URL}"
    run mv -f "${GHIDRA_ZIP_PATH}.part" "${GHIDRA_ZIP_PATH}"
    if [ "${DRY_RUN}" = 0 ]; then
      if verify_zip_sha; then
        ok "SHA-256 OK"
      else
        err "SHA-256 do download NÃO confere com o pin (${GHIDRA_ZIP_SHA256}). Abortando."
        exit 3
      fi
    fi
  fi

  log "extraindo em ${REA_TOOLS_DIR} (via diretório temporário, mv atômico)..."
  run mkdir -p "${gh_extract_tmp}"
  run unzip -q -o "${GHIDRA_ZIP_PATH}" -d "${gh_extract_tmp}"

  if [ "${DRY_RUN}" = 0 ]; then
    src_dir="${gh_extract_tmp}/${GHIDRA_EXTRACTED_DIRNAME}"
    if [ ! -f "${src_dir}/support/launch.properties" ]; then
      found="$(find "${gh_extract_tmp}" -maxdepth 1 -type d -name 'ghidra_*_PUBLIC' | head -n1 || true)"
      if [ -n "${found}" ]; then
        src_dir="${found}"
      else
        err "diretório extraído do Ghidra não encontrado em ${gh_extract_tmp}. Abortando."
        exit 3
      fi
    fi
    rm -rf "${GHIDRA_INSTALL_DIR}"
    mv "${src_dir}" "${GHIDRA_INSTALL_DIR}"
    rm -rf "${gh_extract_tmp}"
    if [ ! -f "${GHIDRA_INSTALL_DIR}/support/launch.properties" ]; then
      err "instalação do Ghidra inválida: ${GHIDRA_INSTALL_DIR}/support/launch.properties ausente. Abortando."
      exit 3
    fi
    chmod +x "${GHIDRA_INSTALL_DIR}/ghidraRun" \
             "${GHIDRA_INSTALL_DIR}/support/analyzeHeadless" 2>/dev/null || true
    rm -rf "${REA_TOOLS_DIR}/.lock"
    trap - EXIT
    ok "Ghidra instalado em ${GHIDRA_INSTALL_DIR}"
  fi
fi

# ---------------------------------------------------------------------------
# 6. GHIDRA_INSTALL_DIR -> setup/env.sh (e, opcionalmente, ~/.bashrc)
# ---------------------------------------------------------------------------
step 6 "Variáveis de ambiente (GHIDRA_INSTALL_DIR)"
export GHIDRA_INSTALL_DIR
export REA_TOOLS_DIR
log "GHIDRA_INSTALL_DIR=${GHIDRA_INSTALL_DIR}"

if [ "${DRY_RUN}" = 1 ]; then
  show "escrever ${ENV_FILE}"
else
  {
    printf '%s\n' "# Gerado por setup/setup.sh — 'source' este arquivo para exportar o ambiente do sublime-rea."
    printf 'export REA_TOOLS_DIR="%s"\n' "${REA_TOOLS_DIR}"
    printf 'export GHIDRA_INSTALL_DIR="%s"\n' "${GHIDRA_INSTALL_DIR}"
    printf '%s\n' "# export JAVA_HOME=\"/caminho/do/jdk-${GHIDRA_JDK_MIN_MAJOR}\"  # descomente se precisar forçar um JDK"
  } > "${ENV_FILE}"
  ok "escrito ${ENV_FILE}"
fi

if [ "${WRITE_RC}" = 1 ]; then
  if grep -q "sublime-rea setup" "${RC_FILE}" 2>/dev/null; then
    ok "${RC_FILE} já contém o bloco do sublime-rea"
  elif [ "${DRY_RUN}" = 1 ]; then
    show "anexar 'source ${ENV_FILE}' em ${RC_FILE}"
  else
    {
      printf '\n# >>> sublime-rea setup >>>\n'
      printf '[ -f "%s" ] && . "%s"\n' "${ENV_FILE}" "${ENV_FILE}"
      printf '# <<< sublime-rea setup <<<\n'
    } >> "${RC_FILE}"
    ok "bloco adicionado em ${RC_FILE}"
  fi
else
  log "rc não alterado (use --write-rc para persistir no ~/.bashrc)"
fi

# ---------------------------------------------------------------------------
# 7. Extrair o alvo (Sublime Text) em target/ (gitignored)
# ---------------------------------------------------------------------------
step 7 "Extraindo alvo (Sublime Text build ${SUBLIME_BUILD})"
if [ -f "${TARGET_BIN}" ]; then
  ok "alvo já extraído: ${TARGET_BIN}"
else
  if [ ! -f "${TARBALL}" ]; then
    if [ "${DRY_RUN}" = 1 ]; then
      warn "tarball do alvo ausente: ${TARBALL} (dry-run: apenas reporta)"
    else
      err "tarball do alvo ausente: ${TARBALL}"
      exit 4
    fi
  fi
  run mkdir -p "${REPO_ROOT}/target"
  run tar -xJf "${TARBALL}" -C "${REPO_ROOT}/target"
  if [ "${DRY_RUN}" = 0 ]; then
    if [ -f "${TARGET_BIN}" ]; then
      ok "extraído: ${TARGET_BIN}"
    else
      err "extração falhou: ${TARGET_BIN} não existe"
      exit 4
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 8. Registrar MCP no opencode
# ---------------------------------------------------------------------------
step 8 "Registrando MCP no opencode (rea setup --client opencode)"
if [ "${DRY_RUN}" = 1 ]; then
  show "${REA_CMD[*]} setup --client opencode --yes"
else
  if "${REA_CMD[@]}" setup --client opencode --yes; then
    ok "MCP registrado para o client 'opencode'"
  else
    err "'rea setup --client opencode' falhou"
    exit 5
  fi
fi

# ---------------------------------------------------------------------------
# 9. Verificação final: rea doctor (escopo opencode + ghidra)
#    Checa environment_healthy; mostra os motivos em caso de falha.
# ---------------------------------------------------------------------------
step 9 "Verificação final (rea doctor)"
DOCTOR_CMD=("${REA_CMD[@]}" doctor --client opencode --provider ghidra --format json)

if [ "${DRY_RUN}" = 1 ]; then
  show "${DOCTOR_CMD[*]}"
  printf '\n%s\n' "${C_GREEN}${C_BOLD}dry-run concluído — nada foi baixado, instalado ou alterado.${C_RESET}"
  exit 0
fi

doctor_tmp="$(mktemp)"
doctor_err="$(mktemp)"
trap 'rm -f "${doctor_tmp}" "${doctor_err}"' EXIT
"${DOCTOR_CMD[@]}" > "${doctor_tmp}" 2> "${doctor_err}" || true

if python3 - "${doctor_tmp}" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print(f"erro: não foi possível interpretar a saída do 'rea doctor': {exc}")
    sys.exit(1)

if data.get("environment_healthy"):
    print("environment_healthy: true")
    sys.exit(0)

print("environment_healthy: false")
for check in data.get("scope_checks", []):
    if check.get("ok", True):
        continue
    name = check.get("name", "?")
    cls = check.get("classification", "")
    detail = check.get("detail") or check.get("remediation") or ""
    print(f"  - {name} [{cls}]: {detail}")
sys.exit(1)
PY
then
  ok "rea doctor: ambiente OK (environment_healthy: true)"
  printf '\n%s\n' "${C_GREEN}${C_BOLD}Setup concluído com sucesso.${C_RESET}"
else
  if [ -s "${doctor_err}" ]; then
    printf '%s\n' "${C_DIM}--- stderr do 'rea doctor' ---${C_RESET}" >&2
    cat "${doctor_err}" >&2
  fi
  err "rea doctor reportou environment_healthy: false (veja os motivos acima)."
  exit 1
fi
