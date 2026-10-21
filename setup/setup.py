#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""setup.py — instalador idempotente (10 etapas) do ambiente do projeto sublime-rea.

Porta 1:1 de ``setup/setup.sh`` (mantido como legacy) para Python 3.10+, com saída
colorida via `rich` e as MESMAS garantias de segurança/idempotência:

* sem flags, NUNCA usa ``sudo`` e NUNCA altera o rc do shell;
* SHA-256 do Ghidra verificado **antes** de extrair;
* o tarball do alvo (Sublime) **não é versionado**: é baixado sob demanda da URL
  oficial pinada e tem o SHA-256 verificado **antes** de extrair (fail-closed);
* download atômico (``.part`` -> ``mv``), lock de instalação e cleanup garantido;
* dependências base só instaladas com ``--install-deps``;
* provisiona o provider offline ``pwntools-elf`` (venv dedicado + pinos) e propaga
  ``REA_PWNTOOLS_PYTHON`` para o ``setup/env.sh`` e para o registro MCP do opencode.

Uso::

    python3 setup/setup.py --help
    python3 setup/setup.py --dry-run          # plano, sem efeitos colaterais
    python3 setup/setup.py                    # pipeline completo (sem sudo/rc)
    python3 setup/setup.py --install-deps --write-rc

Bootstrap: se o `rich` não estiver disponível, o script cria ``setup/.venv``,
instala ``rich==RICH_VERSION`` e se re-executa; se não conseguir obter o `rich`
de jeito nenhum, cai para uma saída de texto simples (fallback plain).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from contextlib import contextmanager
from pathlib import Path

# ---------------------------------------------------------------------------
# Constantes base
# ---------------------------------------------------------------------------
TOTAL_STEPS = 12
PROJECT_NAME = "sublime-rea"
RICH_VERSION_FALLBACK = "13.9.4"
BOOTSTRAP_ENV = "SUBLIME_REA_RICH_BOOTSTRAPPED"

# Códigos de saída (paridade com o setup.sh).
EXIT_USAGE = 2
EXIT_GHIDRA = 3
EXIT_TARGET = 4
EXIT_MCP = 5
EXIT_PWNTOOLS = 6

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
VERSIONS_FILE = SCRIPT_DIR / "versions.env"
ENV_FILE = SCRIPT_DIR / "env.sh"
RC_FILE = Path(os.path.expanduser("~/.bashrc"))
VENV_DIR = SCRIPT_DIR / ".venv"

# ---------------------------------------------------------------------------
# rich: import opcional (nunca fatal)
# ---------------------------------------------------------------------------
try:  # pragma: no cover - depende do ambiente
    import rich  # noqa: F401
    from rich.console import Console
    from rich.panel import Panel
    from rich.progress import (
        BarColumn,
        DownloadColumn,
        Progress,
        SpinnerColumn,
        TextColumn,
        TimeRemainingColumn,
        TransferSpeedColumn,
    )
    from rich.table import Table
    from rich.text import Text

    RICH_AVAILABLE = True
except ImportError:  # pragma: no cover
    RICH_AVAILABLE = False


# ---------------------------------------------------------------------------
# versions.env: parser (fonte única dos pins)
# ---------------------------------------------------------------------------
_ENV_ASSIGN = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
_ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")


def _strip_inline_comment(text: str) -> str:
    """Remove comentário ``#`` não-aspeado (fora de ``'...'``/``"..."``)."""
    quote = ""
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = ""
        elif char in "\"'":
            quote = char
        elif char == "#":
            # `#` inicia comentário no começo da linha ou após whitespace.
            if index == 0 or text[index - 1].isspace():
                return text[:index]
    return text


def load_versions(path: Path) -> dict[str, str]:
    """Parseia um arquivo estilo ``KEY=VALUE`` (comentários ``#`` e ``$VAR``)."""
    raw: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _ENV_ASSIGN.match(line)
        if not match:
            continue
        key, value = match.group(1), match.group(2).strip()
        value = _strip_inline_comment(value).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        raw[key] = value

    memo: dict[str, str] = {}

    def resolve(key: str, seen: frozenset[str] = frozenset()) -> str:
        if key in memo:
            return memo[key]
        if key not in raw:
            return os.environ.get(key, "")
        if key in seen:
            return ""
        nxt = seen | {key}

        def repl(match: re.Match[str]) -> str:
            return resolve(match.group(1) or match.group(2), nxt)

        memo[key] = _ENV_REF.sub(repl, raw[key])
        return memo[key]

    return {key: resolve(key) for key in raw}


# ---------------------------------------------------------------------------
# Bootstrap do rich (venv local + re-exec); fallback plain sempre disponível
# ---------------------------------------------------------------------------
def _plain_notice(message: str) -> None:
    sys.stderr.write(f"[setup] {message}\n")


def _create_venv(venv_dir: Path) -> bool:
    try:
        import venv as venv_mod
    except ImportError:  # python3-venv ausente
        return False
    # O módulo `venv` faz `sys.exit(1)` (SystemExit, NÃO Exception) quando o
    # `ensurepip` falta; por isso capturamos também SystemExit e caímos para
    # `with_pip=False` (o pip é obtido depois via ensurepip/get-pip.py).
    for with_pip in (True, False):
        try:
            venv_mod.EnvBuilder(with_pip=with_pip, clear=False).create(str(venv_dir))
            break
        except (Exception, SystemExit):  # noqa: BLE001 - ensurepip indisponível, etc.
            continue
    return (venv_dir / "bin" / "python").is_file()


def _python_has_rich(python: Path | str) -> bool:
    try:
        return (
            subprocess.run(
                [str(python), "-c", "import rich"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
            ).returncode
            == 0
        )
    except Exception:  # noqa: BLE001
        return False


def _pip_install_rich(python: Path | str, version: str) -> bool:
    spec = f"rich=={version}"
    cmd = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-q", spec]

    def pip() -> subprocess.CompletedProcess[str]:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    try:
        result = pip()
        blob = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0 and "No module named pip" in blob:
            subprocess.run(
                [str(python), "-m", "ensurepip", "--upgrade"],
                capture_output=True,
                text=True,
                timeout=300,
            )
            result = pip()
        if result.returncode != 0:
            _plain_notice(f"pip install rich falhou: {(result.stderr or '').strip()[-300:]}")
            return False
    except Exception as exc:  # noqa: BLE001
        _plain_notice(f"pip install rich falhou: {exc}")
        return False
    return _python_has_rich(python)


def bootstrap_rich(script_dir: Path, rich_version: str, dry_run: bool) -> None:
    """Garante o `rich`; se faltar, cria o venv local e re-executa o script.

    Em ``--dry-run`` o bootstrap é **pulado** para preservar o contrato de
    "zero efeitos colaterais" (não cria ``setup/.venv`` nesta máquina).
    """
    if RICH_AVAILABLE or os.environ.get(BOOTSTRAP_ENV) == "1":
        return
    if dry_run:
        _plain_notice("rich ausente (bootstrap pulado em --dry-run; usando saída plain)")
        return

    venv_dir = script_dir / ".venv"
    venv_python = venv_dir / "bin" / "python"
    _plain_notice(f"rich ausente — tentando bootstrap em {venv_dir} ...")

    if not venv_python.is_file() and not _create_venv(venv_dir):
        _plain_notice("não foi possível criar o venv (instale python3-venv?); usando saída plain")
        return
    if not _python_has_rich(venv_python) and not _pip_install_rich(venv_python, rich_version):
        _plain_notice("não foi possível instalar o rich; usando saída plain")
        return

    os.environ[BOOTSTRAP_ENV] = "1"
    script = Path(__file__).resolve()
    try:
        os.execv(str(venv_python), [str(venv_python), str(script), *sys.argv[1:]])
    except OSError as exc:  # pragma: no cover
        _plain_notice(f"re-exec com o venv falhou ({exc}); usando saída plain")


# ---------------------------------------------------------------------------
# Camada de UI (duas implementações: rich e plain)
# ---------------------------------------------------------------------------
class UI:
    """Interface comum; guarda o estado das etapas para o sumário final."""

    def __init__(self, dry_run: bool = False) -> None:
        self.dry_run = dry_run
        self.results: dict[int, tuple[str, str]] = {}
        self.titles: dict[int, str] = {}

    def mark(self, step: int, status: str, detail: str = "") -> None:
        self.results[step] = (status, detail)

    # -- métodos obrigatórios -------------------------------------------------
    def header(self, pins: list[tuple[str, str]], dry_run: bool) -> None: ...
    def step(self, step: int, title: str) -> None: ...
    def ok(self, message: str) -> None: ...
    def warn(self, message: str) -> None: ...
    def err(self, message: str) -> None: ...
    def info(self, message: str) -> None: ...
    def show(self, message: str) -> None: ...
    def dry(self, message: str) -> None: ...
    def status(self, message: str): ...
    def download_start(self, total: int, label: str = "baixando Ghidra") -> None: ...
    def download_update(self, done: int, total: int) -> None: ...
    def download_end(self) -> None: ...
    def summary(self) -> None: ...
    def error_panel(self, title: str, lines: list[str]) -> None: ...
    def raw_stderr(self, text: str) -> None: ...
    def banner(self, message: str, kind: str = "ok") -> None: ...


class PlainUI(UI):
    """Fallback sem `rich`: texto simples, colorido apenas se TTY."""

    _ICONS = {"ok": "✓", "warn": "!", "err": "✗", "dry": "→"}

    def __init__(self, dry_run: bool = False) -> None:
        super().__init__(dry_run)
        self.color = sys.stderr.isatty() and not os.environ.get("NO_COLOR")

    def _c(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def header(self, pins: list[tuple[str, str]], dry_run: bool) -> None:
        print(self._c("1", f"== {PROJECT_NAME} — setup =="))
        for key, value in pins:
            print(f"   {key}: {value}")
        if dry_run:
            print(self._c("33;1", "== MODO DRY-RUN: nada será baixado, instalado ou alterado =="))

    def step(self, step: int, title: str) -> None:
        self.titles[step] = title
        print()
        print(self._c("1", f"[{step}/{TOTAL_STEPS}] {title}"))

    def ok(self, message: str) -> None:
        print(f"  {self._c('32', '✓')} {message}")

    def warn(self, message: str) -> None:
        print(f"  {self._c('33', '!')} {message}", file=sys.stderr)

    def err(self, message: str) -> None:
        print(f"  {self._c('31', '✗')} {message}", file=sys.stderr)

    def info(self, message: str) -> None:
        print(f"  {self._c('36', '→')} {message}")

    def show(self, message: str) -> None:
        print(f"     {self._c('2', '[dry-run]')} {message}")

    def dry(self, message: str) -> None:
        print(f"     {self._c('2', '[dry-run]')} {message}")

    @contextmanager
    def status(self, message: str):
        print(f"     {message} ...", file=sys.stderr)
        yield None

    def download_start(self, total: int, label: str = "baixando Ghidra") -> None:
        self._dl_total = total
        self._dl_label = label
        self._dl_last_pct = -1
        self._dl_last_time = time.monotonic()

    def download_update(self, done: int, total: int) -> None:
        total = total or self._dl_total
        pct = int(done * 100 / total) if total else 0
        now = time.monotonic()
        if pct != self._dl_last_pct and (pct % 2 == 0 or now - self._dl_last_time > 3):
            self._dl_last_pct = pct
            self._dl_last_time = now
            print(f"     {self._dl_label}... {pct:3d}% ({done} bytes)", file=sys.stderr)

    def download_end(self) -> None:
        print("     download concluído", file=sys.stderr)

    def summary(self) -> None:
        print()
        print("Sumário:")
        for step in range(1, TOTAL_STEPS + 1):
            status, detail = self.results.get(step, ("", ""))
            icon = self._ICONS.get(status, "–")
            title = self.titles.get(step, "")
            print(f"  {icon} [{step}/{TOTAL_STEPS}] {title}" + (f" — {detail}" if detail else ""))

    def error_panel(self, title: str, lines: list[str]) -> None:
        print()
        print(self._c("31;1", f"ERRO: {title}"), file=sys.stderr)
        for line in lines:
            print(f"  {line}", file=sys.stderr)

    def raw_stderr(self, text: str) -> None:
        if text.strip():
            print("--- stderr ---", file=sys.stderr)
            sys.stderr.write(text if text.endswith("\n") else text + "\n")

    def banner(self, message: str, kind: str = "ok") -> None:
        print()
        code = "33;1" if kind == "dry" else "32;1"
        print(self._c(code, message))


class RichUI(UI):
    """UI colorida via `rich` (só é instanciada quando `rich` está disponível)."""

    _STYLES = {
        "ok": ("✓", "green"),
        "warn": ("!", "yellow"),
        "err": ("✗", "red"),
        "dry": ("→", "cyan"),
    }

    def __init__(self, dry_run: bool = False) -> None:
        super().__init__(dry_run)
        self.console = Console()
        self.err_console = Console(stderr=True)
        self._progress: Progress | None = None
        self._task = None
        self._dl_last = 0

    def header(self, pins: list[tuple[str, str]], dry_run: bool) -> None:
        body = Text()
        for key, value in pins:
            body.append(f"{key:<10}", style="dim")
            body.append(f"{value}\n", style="bold")
        body.rstrip()  # muta in-place (RETORNA None em algumas versões do rich)
        subtitle = "modo dry-run (sem efeitos colaterais)" if dry_run else "REA + Ghidra + alvo"
        self.console.print(
            Panel(
                body,
                title=f"[bold]{PROJECT_NAME}[/bold] · setup",
                subtitle=f"[dim]{subtitle}[/dim]",
                border_style="cyan",
                padding=(0, 2),
            )
        )

    def step(self, step: int, title: str) -> None:
        self.titles[step] = title
        self.console.print()
        self.console.rule(
            f"[bold cyan][{step}/{TOTAL_STEPS}][/bold cyan] {title}", style="cyan", align="left"
        )

    def ok(self, message: str) -> None:
        self.console.print(f"  [green]✓[/green] {message}")

    def warn(self, message: str) -> None:
        self.err_console.print(f"  [yellow]![/yellow] {message}")

    def err(self, message: str) -> None:
        self.err_console.print(f"  [red]✗[/red] {message}")

    def info(self, message: str) -> None:
        self.console.print(f"  [cyan]→[/cyan] {message}")

    def show(self, message: str) -> None:
        self.console.print(f"     [dim cyan][dry-run][/dim cyan] [dim]{message}[/dim]")

    def dry(self, message: str) -> None:
        self.console.print(f"     [dim cyan][dry-run][/dim cyan] [dim]{message}[/dim]")

    @contextmanager
    def status(self, message: str):
        with self.console.status(f"[cyan]{message}...[/cyan]", spinner="dots"):
            yield None

    def download_start(self, total: int, label: str = "baixando Ghidra") -> None:
        self._dl_last = 0
        self._progress = Progress(
            SpinnerColumn(),
            TextColumn("[bold cyan]{task.description}[/bold cyan]"),
            BarColumn(),
            DownloadColumn(),
            TransferSpeedColumn(),
            TimeRemainingColumn(),
            console=self.console,
        )
        self._progress.start()
        self._task = self._progress.add_task(label, total=total or None)

    def download_update(self, done: int, total: int) -> None:
        if self._progress is None:
            return
        try:
            self._progress.update(self._task, advance=done - self._dl_last, total=total or None)
            self._dl_last = done
        except Exception:  # noqa: BLE001 - progresso nunca deve derrubar o download
            pass

    def download_end(self) -> None:
        if self._progress is not None:
            self._progress.stop()
            self._progress = None

    def summary(self) -> None:
        table = Table(
            title="Sumário", title_style="bold", border_style="cyan", header_style="bold cyan"
        )
        table.add_column("#", justify="right", style="dim")
        table.add_column("", justify="center")
        table.add_column("Etapa")
        table.add_column("Resultado", style="dim")
        for step in range(1, TOTAL_STEPS + 1):
            status, detail = self.results.get(step, ("", ""))
            icon, style = self._STYLES.get(status, ("–", "dim"))
            table.add_row(
                f"{step}/{TOTAL_STEPS}",
                f"[{style}]{icon}[/{style}]",
                self.titles.get(step, ""),
                detail,
            )
        self.console.print()
        self.console.print(table)

    def error_panel(self, title: str, lines: list[str]) -> None:
        body = "\n".join(lines) if lines else title
        self.err_console.print()
        self.err_console.print(
            Panel(body, title=f"[bold red]{title}[/bold red]", border_style="red", padding=(0, 2))
        )

    def raw_stderr(self, text: str) -> None:
        if text.strip():
            self.err_console.print("[dim]--- stderr do comando ---[/dim]")
            self.err_console.print(text.rstrip())

    def banner(self, message: str, kind: str = "ok") -> None:
        self.console.print()
        color = "cyan" if kind == "dry" else "green"
        self.console.print(f"[bold {color}]{message}[/bold {color}]")


def make_ui(dry_run: bool) -> UI:
    if RICH_AVAILABLE:
        return RichUI(dry_run)
    if not dry_run and os.environ.get(BOOTSTRAP_ENV) != "1":
        _plain_notice("rich indisponível; seguindo com saída plain")
    return PlainUI(dry_run)


# ---------------------------------------------------------------------------
# Utilidades de sistema
# ---------------------------------------------------------------------------
class SetupFailure(Exception):
    """Falha controlada: encerra o script com um código e um painel de erro."""

    def __init__(
        self, code: int, title: str, lines: list[str] | None = None, stderr: str = ""
    ) -> None:
        super().__init__(title)
        self.code = code
        self.title = title
        self.lines = lines or []
        self.stderr = stderr


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def proc(args: list, *, timeout: int = 120, **kwargs) -> subprocess.CompletedProcess:
    """Executa SEMPRE (útil para checagens read-only, mesmo em dry-run)."""
    kwargs.setdefault("encoding", "utf-8")
    kwargs.setdefault("errors", "replace")
    return subprocess.run(
        [str(a) for a in args], capture_output=True, text=True, timeout=timeout, **kwargs
    )


def run(ui: UI, args: list, *, check: bool = True, env: dict | None = None):
    """Executa (ou apenas imprime, em dry-run) um comando externo."""
    flat = [str(a) for a in args]
    if ui.dry_run:
        ui.dry(" ".join(flat))
        return subprocess.CompletedProcess(flat, 0, "", "")
    return subprocess.run(flat, check=check, env=env)


def ensure_dir(ui: UI, path: Path) -> None:
    """``mkdir -p`` dry-aware."""
    if ui.dry_run:
        ui.dry(f"mkdir -p {path}")
    else:
        path.mkdir(parents=True, exist_ok=True)


def _write_atomic(path: Path, text: str) -> None:
    """Escreve ``path`` atomicamente (temp no mesmo dir + ``os.replace``)."""
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def sha256_of(path: Path, ui: UI) -> str:
    digest = hashlib.sha256()
    with ui.status(f"calculando SHA-256 de {path.name}"), path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(
    url: str,
    dest: Path,
    ui: UI,
    *,
    retries: int = 3,
    retry_delay: int = 2,
    expected_size: int = 0,
    exit_code: int = EXIT_GHIDRA,
    label: str = "Ghidra",
    hint: str = "",
) -> None:
    """Download via urllib com retry/backoff e barra de progresso.

    Valida o tamanho baixado contra o ``Content-Length`` (e contra
    ``expected_size``, quando informado) **dentro** do loop de retry, para que um
    truncamento seja retentado em vez de só ser detectado no SHA-256 (que aborta).

    Genérico para qualquer artefato pinado: ``exit_code``/``label``/``hint``
    ajustam o erro final (Ghidra por default; o alvo passa ``EXIT_TARGET``).
    """
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": f"{PROJECT_NAME}-setup"})
            with urllib.request.urlopen(request, timeout=60) as response, dest.open("wb") as fh:
                total = int(response.headers.get("Content-Length") or 0)
                ui.download_start(total, f"baixando {label}")
                done = 0
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    ui.download_update(done, total)
                ui.download_end()

            expected = expected_size or total
            if expected and done != expected:
                raise OSError(
                    f"tamanho baixado inesperado: {done} bytes "
                    f"(esperado {expected}{' pelo Content-Length' if not expected_size else ''})"
                )
            return
        except Exception as exc:  # noqa: BLE001 - retry cobre rede/HTTP/truncamento
            last_error = exc
            ui.download_end()
            dest.unlink(missing_ok=True)
            if attempt < retries:
                ui.warn(f"download falhou (tentativa {attempt}/{retries}): {exc}")
                time.sleep(retry_delay)
    lines = [str(last_error)]
    if hint:
        lines.append(hint)
    raise SetupFailure(exit_code, f"falha no download do {label}", lines)


# ---------------------------------------------------------------------------
# Contexto (variáveis derivadas dos pins)
# ---------------------------------------------------------------------------
class Ctx:
    def __init__(self, versions: dict[str, str]) -> None:
        self.versions = versions

        def v(key: str) -> str:
            value = versions.get(key)
            if value is None or not value.strip():
                raise SetupFailure(
                    EXIT_USAGE,
                    f"pin ausente (ou vazio) em versions.env: {key}",
                    [f"ajuste {VERSIONS_FILE.name}: defina {key}=\"<valor>\""],
                )
            return value

        self.rea_package = v("REA_PACKAGE")
        self.rea_version = v("REA_VERSION")
        self.ghidra_version = v("GHIDRA_VERSION")
        self.ghidra_url = v("GHIDRA_URL")
        self.ghidra_sha256 = v("GHIDRA_ZIP_SHA256")
        self.ghidra_zip_size = v("GHIDRA_ZIP_SIZE_BYTES")
        self.ghidra_zip_filename = v("GHIDRA_ZIP_FILENAME")
        self.ghidra_extracted_dirname = v("GHIDRA_EXTRACTED_DIRNAME")
        self.ghidra_jdk_min = v("GHIDRA_JDK_MIN_MAJOR")
        self.ghidra_jdk_url = v("GHIDRA_JDK_URL")
        self.sublime_build = v("SUBLIME_BUILD")
        self.sublime_tarball = v("SUBLIME_TARBALL")
        self.sublime_tarball_url = v("SUBLIME_TARBALL_URL")
        self.sublime_tarball_sha256 = v("SUBLIME_TARBALL_SHA256")
        self.sublime_tarball_size = v("SUBLIME_TARBALL_SIZE_BYTES")
        self.sublime_target_bin = v("SUBLIME_TARGET_BIN")
        self.node_min = v("NODE_MIN_MAJOR")
        self.rich_version = versions.get("RICH_VERSION") or RICH_VERSION_FALLBACK

        self.pwntools_version = v("PWNTOOLS_VERSION")
        self.pyelftools_version = v("PYELFTOOLS_VERSION")
        self.unicorn_version = v("UNICORN_VERSION")
        self.setuptools_version = v("SETUPTOOLS_VERSION")
        self.pwntools_venv_dirname = (
            versions.get("REA_PWNTOOLS_VENV_DIRNAME") or "pwntools-venv"
        )
        self.get_pip_url = versions.get("GET_PIP_URL") or "https://bootstrap.pypa.io/get-pip.py"

        default_tools = versions.get("REA_TOOLS_DIR_DEFAULT") or str(
            Path("~/.local/share/sublime-rea-tools").expanduser()
        )
        self.rea_tools_dir = Path(os.environ.get("REA_TOOLS_DIR") or default_tools).expanduser()
        self.rea_tools_alias = Path(
            os.environ.get("REA_TOOLS_ALIAS") or "~/sr-tools"
        ).expanduser()
        self.ghidra_zip_path = self.rea_tools_dir / self.ghidra_zip_filename
        self.ghidra_install_dir = self.rea_tools_dir / self.ghidra_extracted_dirname
        self.pwntools_venv_dir = self.rea_tools_dir / self.pwntools_venv_dirname
        self.pwntools_python = self.pwntools_venv_dir / "bin" / "python"
        self.rizin_version = v("RIZIN_VERSION")
        self.rizin_url = v("RIZIN_STATIC_URL")
        self.rizin_sha256 = v("RIZIN_STATIC_SHA256")
        self.rizin_static_size = v("RIZIN_STATIC_SIZE_BYTES")
        self.rizin_static_filename = v("RIZIN_STATIC_FILENAME")
        self.rizin_extracted_dirname = v("RIZIN_EXTRACTED_DIRNAME")
        self.rizin_tarball_path = self.rea_tools_dir / self.rizin_static_filename
        self.rizin_install_dir = self.rea_tools_dir / self.rizin_extracted_dirname
        self.rizin_bin = self.rizin_install_dir / "bin" / "rizin"
        self.tarball = REPO_ROOT / self.sublime_tarball
        self.target_bin = REPO_ROOT / self.sublime_target_bin
        self.target_dir = REPO_ROOT / "target"

        # Preenchidos pela etapa 3 (step_java); consumidos pela etapa 7 (env.sh) e pelo MCP.
        self.java_home = ""  # JDK compatível detectado → `export JAVA_HOME` ativo no env.sh
        self.java_hint = ""  # melhor JDK detectado (< mínimo) → linha comentada no env.sh

    def pins(self) -> list[tuple[str, str]]:
        return [
            ("REA", f"{self.rea_package} {self.rea_version}"),
            ("Ghidra", f"{self.ghidra_version} (JDK >= {self.ghidra_jdk_min})"),
            ("Rizin", f"{self.rizin_version} (estático, Linux x86_64)"),
            ("pwntools", f"{self.pwntools_version} + pyelftools {self.pyelftools_version}"
                         f" + unicorn {self.unicorn_version}"),
            ("Node", f">= {self.node_min}"),
            ("Alvo", f"Sublime Text build {self.sublime_build}"),
            ("rich", self.rich_version),
        ]


# ---------------------------------------------------------------------------
# Etapa 1 — SO / arquitetura
# ---------------------------------------------------------------------------
def step_os(ctx: Ctx, ui: UI) -> None:
    ui.step(1, "Sistema e arquitetura")
    os_name = platform.system() or "?"
    arch = platform.machine() or "?"
    if os_name == "Linux" and arch == "x86_64":
        ui.ok("Linux x86_64")
        ui.mark(1, "ok", "Linux x86_64")
    else:
        ui.warn(
            f"ambiente '{os_name}/{arch}': Ghidra/REA foram validados em Linux x86_64; "
            "prossiga por sua conta e risco."
        )
        ui.mark(1, "warn", f"{os_name}/{arch}")


# ---------------------------------------------------------------------------
# Etapa 2 — dependências base
# ---------------------------------------------------------------------------
def step_deps(ctx: Ctx, ui: UI, install_deps: bool) -> None:
    ui.step(2, "Dependências base")
    missing: list[str] = []
    missing_pkgs: list[str] = []

    def check(cmd: str, pkg: str) -> None:
        if have(cmd):
            ui.ok(cmd)
        else:
            ui.warn(f"faltando: {cmd} (pacote: {pkg})")
            missing.append(cmd)
            missing_pkgs.append(pkg)

    # O script baixa via `urllib` (sem `curl`) e extrai zips via `zipfile` (sem `unzip`),
    # então essas ferramentas não são mais exigidas.
    for cmd, pkg in (
        ("tar", "tar"),
        ("xz", "xz-utils"),
        ("python3", "python3"),
        ("git", "git"),
    ):
        check(cmd, pkg)

    def node_missing(reason: str) -> None:
        ui.warn(reason)
        missing.append(f"node>={ctx.node_min}")
        missing_pkgs.append("nodejs")

    if have("node"):
        try:
            node_ver = proc(["node", "-v"]).stdout.strip().lstrip("v")
            node_major = int(node_ver.split(".")[0])
        except Exception:  # noqa: BLE001
            node_ver, node_major = "?", -1
        if node_major >= int(ctx.node_min):
            ui.ok(f"node {node_ver}")
        else:
            node_missing(
                f"node {node_ver} < {ctx.node_min} (preferir nvm/nodesource a 'apt install nodejs')"
            )
    else:
        node_missing("faltando: node (preferir nvm/nodesource a 'apt install nodejs')")

    check("npm", "npm")

    if missing:
        ui.warn(f"dependências faltando: {' '.join(missing)}")
        if install_deps:
            ui.info("instalando via gerenciador de pacotes (precisa de sudo)...")
            run(ui, ["sudo", "apt-get", "update"])
            run(ui, ["sudo", "apt-get", "install", "-y", *missing_pkgs])
            ui.warn(
                f"para Node nativo 'apt', confirme que a versão >= {ctx.node_min}; "
                "se não, use nvm/nodesource."
            )
        else:
            ui.warn("reexecute com --install-deps para instalar (ou instale manualmente).")
        ui.mark(2, "warn", f"faltando: {' '.join(missing)}")
    else:
        ui.ok("todas as dependências base presentes")
        ui.mark(2, "ok", "todas presentes")


# ---------------------------------------------------------------------------
# Etapa 3 — Java vs mínimo do Ghidra (avisar, NUNCA instalar)
# ---------------------------------------------------------------------------
def _java_major(java_bin: str) -> tuple[str, str]:
    try:
        first_line = proc([java_bin, "-version"]).stderr.splitlines()[:1]
    except Exception:  # noqa: BLE001
        first_line = []
    version_line = first_line[0] if first_line else ""
    match = re.search(r'version "([0-9][0-9.]*)"', version_line)
    if not match:
        return "", version_line
    java_num = match.group(1)
    major = java_num.split(".")[0]
    if major == "1":
        major = java_num.split(".")[1] if "." in java_num else ""
    return major, version_line


def _jdk_home_from_bin(java_bin: Path) -> Path | None:
    """Deriva o home do JDK a partir de ``…/bin/java``, validando pelo arquivo ``release``.

    Tenta primeiro sem resolver symlinks (preserva nomes estáveis, ex.:
    ``~/.sdkman/candidates/java/23-zulu``) e só depois o caminho totalmente resolvido.
    """
    for base in (java_bin, java_bin.resolve()):
        home = base.parent.parent
        if (home / "release").is_file():
            return home
    return None


def _java_candidate_homes() -> list[Path]:
    """Candidatos a home de JDK, em ordem de preferência, sem duplicatas.

    Fontes: ``JAVA_HOME`` do ambiente, ``java`` do PATH e os diretórios comuns
    (sdkman e ``/usr/lib/jvm``). O setup NÃO instala nada — só procura.
    """
    homes: list[Path] = []
    env_home = os.environ.get("JAVA_HOME", "")
    if env_home and (Path(env_home) / "bin" / "java").is_file():
        homes.append(Path(env_home))
    java_on_path = shutil.which("java")
    if java_on_path:
        home = _jdk_home_from_bin(Path(java_on_path))
        if home is not None:
            homes.append(home)
    for root in (Path("~/.sdkman/candidates/java").expanduser(), Path("/usr/lib/jvm")):
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if (entry / "bin" / "java").is_file() and (entry / "release").is_file():
                homes.append(entry)
    seen: set[str] = set()
    unique: list[Path] = []
    for home in homes:
        key = str(home.resolve())
        if key not in seen:
            seen.add(key)
            unique.append(home)
    return unique


def _java_major_of(home: Path) -> tuple[int, str]:
    """``(major, linha-de-versão)`` do JDK em ``home``; major -1 se não souber."""
    major, version_line = _java_major(str(home / "bin" / "java"))
    try:
        return int(major), version_line
    except ValueError:
        return -1, version_line


def step_java(ctx: Ctx, ui: UI) -> None:
    ui.step(3, f"Java (Ghidra {ctx.ghidra_version} exige JDK >= {ctx.ghidra_jdk_min})")
    candidates = _java_candidate_homes()

    if not candidates:
        ctx.java_home = ""
        ctx.java_hint = ""
        ui.warn("Java não encontrado (JAVA_HOME, PATH, sdkman nem /usr/lib/jvm).")
        ui.warn(f"instale um JDK {ctx.ghidra_jdk_min}+ (Temurin/Corretto): {ctx.ghidra_jdk_url}")
        ui.warn("o setup NÃO instala JDK automaticamente.")
        ui.mark(3, "warn", "Java ausente")
        return

    # Um único passeio: guarda o melhor candidato no geral e o melhor compatível.
    best_any: tuple[int, Path, str] | None = None
    best_compat: tuple[int, Path, str] | None = None
    for home in candidates[:8]:  # teto de sondagens: `java -version` é um subprocess
        major, version_line = _java_major_of(home)
        if best_any is None or major > best_any[0]:
            best_any = (major, home, version_line)
        if major >= int(ctx.ghidra_jdk_min) and (best_compat is None or major > best_compat[0]):
            best_compat = (major, home, version_line)

    if best_compat is not None:
        major, home, _ = best_compat
        ctx.java_home = str(home)
        ui.ok(f"Java {major} em {home / 'bin' / 'java'} (>= {ctx.ghidra_jdk_min}, compatível)")
        ui.mark(3, "ok", f"Java {major}")
    else:
        assert best_any is not None  # candidatos não vazios ⇒ best_any preenchido
        major, home, version_line = best_any
        ctx.java_hint = str(home)
        ui.warn(f"Java detectado ({major if major > 0 else '?'}) < {ctx.ghidra_jdk_min}: "
                f"{version_line} em {home}")
        ui.warn(f"instale um JDK {ctx.ghidra_jdk_min}+ (Temurin/Corretto): {ctx.ghidra_jdk_url}")
        ui.mark(3, "warn", f"Java {major if major > 0 else '?'} < {ctx.ghidra_jdk_min}")


# ---------------------------------------------------------------------------
# Etapa 4 — REA (rea-agents): global se o prefix do npm for gravável, senão npx
# ---------------------------------------------------------------------------
def step_rea(ctx: Ctx, ui: UI) -> list[str]:
    ui.step(4, f"REA ({ctx.rea_package}@{ctx.rea_version})")
    rea_cmd: list[str] = []
    via_npx = False
    rea_ready = False

    if have("rea"):
        try:
            out = proc(["rea", "--version"]).stdout
        except Exception:  # noqa: BLE001
            out = ""
        match = re.search(r"[0-9]+\.[0-9]+\.[0-9]+", out)
        cur_rea = match.group(0) if match else ""
        if cur_rea == ctx.rea_version:
            ui.ok(f"rea {cur_rea} já instalado globalmente")
            rea_ready = True
        else:
            ui.warn(
                f"rea global encontrado ({cur_rea or '?'}) != {ctx.rea_version}; será reinstalado"
            )

    if rea_ready:
        rea_cmd = ["rea"]
        ui.mark(4, "ok", f"rea {ctx.rea_version} global")
    else:
        npm_prefix = ""
        if have("npm"):
            try:
                npm_prefix = proc(["npm", "config", "get", "prefix"]).stdout.strip()
            except Exception:  # noqa: BLE001
                npm_prefix = ""
        else:
            ui.warn("npm não encontrado no PATH; sem instalação global (fallback npx)")

        if npm_prefix and os.access(npm_prefix, os.W_OK):
            ui.info(
                f"npm prefix gravável ({npm_prefix}) -> npm i -g {ctx.rea_package}@{ctx.rea_version}"
            )
            run(ui, ["npm", "install", "-g", f"{ctx.rea_package}@{ctx.rea_version}"])
            rea_cmd = ["rea"]
            ui.mark(4, "ok", f"npm i -g {ctx.rea_package}@{ctx.rea_version}")
        else:
            ui.warn(
                f"npm prefix não gravável ({npm_prefix or 'vazio'}); usando fallback efêmero via npx"
            )
            rea_cmd = ["npx", "-y", f"{ctx.rea_package}@{ctx.rea_version}"]
            via_npx = True
            ui.mark(4, "warn", f"npx -y {ctx.rea_package}@{ctx.rea_version}")

    if via_npx:
        ui.info("REA será invocado via npx efêmero (nada instalado globalmente)")

    return rea_cmd


# ---------------------------------------------------------------------------
# Etapa 5 — Ghidra: mkdir -> lock -> download .part -> SHA -> mv atômico
# ---------------------------------------------------------------------------
def step_ghidra(ctx: Ctx, ui: UI) -> None:
    ui.step(5, f"Ghidra {ctx.ghidra_version} (provider de análise)")
    launch_props = ctx.ghidra_install_dir / "support" / "launch.properties"

    # Só considera instalado com evidência real (extração interrompida deixa lixo).
    if launch_props.is_file():
        ui.ok(f"Ghidra já extraído: {ctx.ghidra_install_dir}")
        ui.mark(5, "ok", "já extraído")
        return

    if ui.dry_run:
        _ghidra_plan(ctx, ui)
        ui.mark(5, "dry", "plano impresso")
        return

    lock_dir = ctx.rea_tools_dir / ".lock"
    extract_tmp: Path | None = None
    acquired_lock = False

    # o diretório precisa existir ANTES do lock e do download
    ensure_dir(ui, ctx.rea_tools_dir)
    try:
        try:
            os.mkdir(lock_dir)
            acquired_lock = True
        except FileExistsError as exc:
            raise SetupFailure(
                EXIT_GHIDRA,
                "lock de instalação em uso",
                [f"{lock_dir} já existe (outra execução? remova se stale)"],
            ) from exc

        if not _zip_sha_ok(ctx, ui):
            if ctx.ghidra_zip_path.is_file():
                ui.warn("zip presente mas SHA-256 diverge; baixando novamente")
                ctx.ghidra_zip_path.unlink()

            size_mib = _mib(ctx.ghidra_zip_size)
            ui.info(
                f"baixando Ghidra {ctx.ghidra_version} (~{ctx.ghidra_zip_size} bytes / ~{size_mib} MiB)..."
            )
            ui.info(f"URL: {ctx.ghidra_url}")
            part = ctx.ghidra_zip_path.with_name(ctx.ghidra_zip_path.name + ".part")
            # download atômico: grava em .part e só promove após sucesso
            download(
                ctx.ghidra_url,
                part,
                ui,
                expected_size=_int_or_zero(ctx.ghidra_zip_size),
            )
            os.replace(part, ctx.ghidra_zip_path)

            if not _zip_sha_ok(ctx, ui):
                raise SetupFailure(
                    EXIT_GHIDRA,
                    "SHA-256 do download não confere com o pin",
                    [f"esperado: {ctx.ghidra_sha256}", "abortando sem extrair."],
                )
            ui.ok("SHA-256 OK")
        else:
            ui.ok("zip já presente e SHA-256 confere")

        ui.info(f"extraindo em {ctx.rea_tools_dir} (via diretório temporário, mv atômico)...")
        extract_tmp = Path(tempfile.mkdtemp(prefix=".extract.", dir=str(ctx.rea_tools_dir)))
        with ui.status("extraindo o zip do Ghidra"):
            _extract_zip(ctx.ghidra_zip_path, extract_tmp)

        src_dir = extract_tmp / ctx.ghidra_extracted_dirname
        if not (src_dir / "support" / "launch.properties").is_file():
            candidates = sorted(p for p in extract_tmp.glob("ghidra_*_PUBLIC") if p.is_dir())
            if candidates:
                src_dir = candidates[0]
            else:
                raise SetupFailure(
                    EXIT_GHIDRA,
                    "diretório extraído do Ghidra não encontrado",
                    [f"nada em {extract_tmp}"],
                )

        _swap_dir(ctx.ghidra_install_dir, src_dir)

        if not launch_props.is_file():
            raise SetupFailure(
                EXIT_GHIDRA,
                "instalação do Ghidra inválida",
                [f"{launch_props} ausente após a extração."],
            )

        for rel in ("ghidraRun", "support/analyzeHeadless"):
            candidate = ctx.ghidra_install_dir / rel
            if candidate.exists():
                try:
                    candidate.chmod(
                        candidate.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
                    )
                except OSError:
                    pass

        ui.ok(f"Ghidra instalado em {ctx.ghidra_install_dir}")
        ui.mark(5, "ok", f"instalado em {ctx.ghidra_install_dir}")
    finally:
        if acquired_lock:
            shutil.rmtree(lock_dir, ignore_errors=True)
        if extract_tmp is not None:
            shutil.rmtree(extract_tmp, ignore_errors=True)
        ctx.ghidra_zip_path.with_name(ctx.ghidra_zip_path.name + ".part").unlink(missing_ok=True)


def _int_or_zero(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _extract_zip(zip_path: Path, dest_dir: Path) -> None:
    """Extrai o zip com a stdlib, rejeitando membros absolutos ou com ``..``.

    Substitui o antigo ``unzip`` externo: além de não depender do binário, valida
    path traversal e preserva o modo (bit de execução) dos membros. Symlinks só são
    criados quando o alvo é relativo e não escapa de ``dest_dir``.
    """
    try:
        archive = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise SetupFailure(
            EXIT_GHIDRA, "zip do Ghidra inválido ou ilegível", [str(exc)]
        ) from exc

    with archive:
        for member in archive.infolist():
            name = member.filename
            normalized = name.replace("\\", "/")
            if os.path.isabs(normalized) or normalized.startswith("/"):
                raise SetupFailure(
                    EXIT_GHIDRA, "entrada com caminho absoluto no zip do Ghidra", [name]
                )
            if ".." in normalized.split("/"):
                raise SetupFailure(
                    EXIT_GHIDRA, "path traversal detectado no zip do Ghidra", [name]
                )
            try:
                target = dest_dir / normalized
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    link_target = archive.read(member).decode("utf-8", "surrogateescape")
                    joined = os.path.normpath(
                        os.path.join(os.path.dirname(normalized), link_target)
                    )
                    if os.path.isabs(link_target) or joined.startswith(".."):
                        raise SetupFailure(
                            EXIT_GHIDRA,
                            "symlink apontando para fora do diretório no zip do Ghidra",
                            [f"{name} -> {link_target}"],
                        )
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.is_symlink() or target.exists():
                        target.unlink()
                    os.symlink(link_target, target)
                    continue
                archive.extract(member, dest_dir)
                if mode and not member.is_dir():
                    os.chmod(target, mode & 0o7777)
            except SetupFailure:
                raise
            except (OSError, zipfile.BadZipFile) as exc:
                raise SetupFailure(
                    EXIT_GHIDRA, "falha ao extrair o zip do Ghidra", [f"{name}: {exc}"]
                ) from exc


def _swap_dir(destination: Path, new_dir: Path) -> None:
    """Troca ``destination`` por ``new_dir`` sem destruir a instalação anterior.

    Move a instalação antiga para ``.old.<pid>`` e só a remove depois do ``move``
    do novo diretório dar certo; em falha, a antiga é restaurada.
    """
    backup = destination.with_name(f"{destination.name}.old.{os.getpid()}")
    shutil.rmtree(backup, ignore_errors=True)
    had_previous = destination.exists()
    if had_previous:
        shutil.move(str(destination), str(backup))
    try:
        shutil.move(str(new_dir), str(destination))
    except Exception:
        if had_previous and not destination.exists():
            shutil.move(str(backup), str(destination))
        raise
    else:
        shutil.rmtree(backup, ignore_errors=True)


def _ghidra_plan(ctx: Ctx, ui: UI) -> None:
    """Imprime a ordem exata do plano do Ghidra em dry-run."""
    part = ctx.ghidra_zip_path.with_name(ctx.ghidra_zip_path.name + ".part")
    ensure_dir(ui, ctx.rea_tools_dir)  # imprime: mkdir -p
    ui.show(f"mkdir {ctx.rea_tools_dir}/.lock  # lock de instalação")
    if not _zip_sha_ok(ctx, ui):
        if ctx.ghidra_zip_path.is_file():
            ui.show(f"rm -f {ctx.ghidra_zip_path}  # SHA-256 diverge")
        size_mib = _mib(ctx.ghidra_zip_size)
        ui.info(
            f"baixando Ghidra {ctx.ghidra_version} (~{ctx.ghidra_zip_size} bytes / ~{size_mib} MiB)..."
        )
        ui.info(f"URL: {ctx.ghidra_url}")
        ui.dry(
            "download (urllib, .part, retry/backoff, valida o tamanho vs Content-Length "
            "e barra de progresso)"
        )
        ui.dry(f"mv -f {part} {ctx.ghidra_zip_path}")
        ui.dry(f"verificar SHA-256 == {ctx.ghidra_sha256} (antes de extrair)")
    else:
        ui.ok("zip já presente e SHA-256 confere")
    ui.info(f"extraindo em {ctx.rea_tools_dir} (via diretório temporário, mv atômico)...")
    ui.dry("mkdir (tempfile.mkdtemp('.extract.', dir=$REA_TOOLS_DIR))")
    ui.dry(
        f"extrair {ctx.ghidra_zip_path} via zipfile (stdlib), rejeitando caminhos "
        "absolutos/'..' e preservando o modo"
    )
    ui.dry(f"mv {ctx.ghidra_install_dir} {ctx.ghidra_install_dir}.old.<pid>  # backup")
    ui.dry(f"mv .extract.*/{ctx.ghidra_extracted_dirname} {ctx.ghidra_install_dir}  # atômico")
    ui.dry(f"rm -rf {ctx.ghidra_install_dir}.old.<pid>  # só após o mv dar certo")


def _zip_sha_ok(ctx: Ctx, ui: UI) -> bool:
    if not ctx.ghidra_zip_path.is_file():
        return False
    return sha256_of(ctx.ghidra_zip_path, ui) == ctx.ghidra_sha256


def _mib(size_bytes: str) -> str:
    try:
        return str(round(int(size_bytes) / 1024 / 1024))
    except (TypeError, ValueError):
        return "?"


# ---------------------------------------------------------------------------
# Etapa 6 — provider offline pwntools (inspect_binary_layout)
#   O REA NUNCA instala Python/pacotes: ele exige um interpretador apontado por
#   REA_PWNTOOLS_PYTHON com pwntools/pyelftools/unicorn PINADOS. Aqui criamos um
#   venv dedicado em $REA_TOOLS_DIR/<dir> e instalamos os 3 pacotes exatos.
# ---------------------------------------------------------------------------
_PWNTOOLS_PROBE = (
    "import importlib.metadata as m, json;"
    "import pwn, elftools, unicorn, pkg_resources;"  # noqa: F401
    "print(json.dumps({k: m.version(k) for k in "
    "('pwntools', 'pyelftools', 'unicorn', 'setuptools')}))"
)


def _pwntools_versions(python: Path | str, ctx: Ctx) -> dict | None:
    """Retorna as versões instaladas (importando os módulos) ou ``None``."""
    try:
        result = proc([str(python), "-c", _PWNTOOLS_PROBE], timeout=300)
    except Exception:  # noqa: BLE001 - venv ausente/exec falhou
        return None
    if result.returncode != 0:
        return None
    try:
        return json.loads((result.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None


def _pwntools_env_ok(python: Path | str, ctx: Ctx) -> bool:
    """True se os 3 pacotes estão presentes nas versões PINADAS."""
    data = _pwntools_versions(python, ctx)
    if not data:
        return False
    return (
        data.get("pwntools") == ctx.pwntools_version
        and data.get("pyelftools") == ctx.pyelftools_version
        and data.get("unicorn") == ctx.unicorn_version
        and data.get("setuptools") == ctx.setuptools_version
    )


def _pip_install_pwntools(python: Path | str, ctx: Ctx) -> bool:
    specs = [
        f"pwntools=={ctx.pwntools_version}",
        f"pyelftools=={ctx.pyelftools_version}",
        f"unicorn=={ctx.unicorn_version}",
        # `unicorn` 2.1.2 importa `pkg_resources` (fornecido pelo setuptools<81); em
        # venvs criados sem `ensurepip` (via get-pip.py) ele não vem por padrão.
        f"setuptools=={ctx.setuptools_version}",
    ]
    cmd = [str(python), "-m", "pip", "install", "--disable-pip-version-check", *specs]

    def pip() -> subprocess.CompletedProcess[str]:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=1800)

    try:
        result = pip()
        blob = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0 and "No module named pip" in blob:
            subprocess.run(
                [str(python), "-m", "ensurepip", "--upgrade"],
                capture_output=True,
                text=True,
                timeout=600,
            )
            result = pip()
        if result.returncode != 0:
            raise SetupFailure(
                EXIT_PWNTOOLS,
                "falha ao instalar os pacotes do pwntools",
                [(result.stderr or result.stdout or "").strip()[-500:]],
            )
    except subprocess.TimeoutExpired as exc:
        raise SetupFailure(
            EXIT_PWNTOOLS, "timeout instalando os pacotes do pwntools", [str(exc)]
        ) from exc
    return _pwntools_env_ok(python, ctx)


def _python_has_pip(python: Path | str) -> bool:
    try:
        return (
            proc([str(python), "-m", "pip", "--version"], timeout=120).returncode == 0
        )
    except Exception:  # noqa: BLE001
        return False


@contextmanager
def _suppress_output():
    """Silencia fd 1 e fd 2.

    O módulo ``venv`` faz ``print(...)`` (stdout) + ``sys.exit(1)`` quando o
    ``ensurepip`` falta; sem isso o usuário veria um "falhou" enganoso mesmo
    quando recuperamos o venv em seguida.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open(os.devnull, os.O_WRONLY)
    saved_out = os.dup(1)
    saved_err = os.dup(2)
    try:
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        yield
    finally:
        # Flush AINDA com os fds redirecionados: um `print()` bufferizado dentro
        # do bloco sairia no fd 1 real depois do restore.
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(devnull)
        os.close(saved_out)
        os.close(saved_err)


def _bootstrap_pip(python: Path | str, ctx: Ctx, ui: UI) -> bool:
    """Garante ``pip`` no venv SEM sudo.

    Ordem: ``pip`` já presente → ``ensurepip`` → bootstrapper oficial ``get-pip.py``
    (necessário em Debian/Ubuntu sem ``python3-venv``).
    """
    if _python_has_pip(python):
        return True
    try:
        subprocess.run(
            [str(python), "-m", "ensurepip", "--upgrade"],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except Exception:  # noqa: BLE001 - ensurepip indisponível
        pass
    if _python_has_pip(python):
        return True

    ui.info("pip ausente no venv; baixando o bootstrapper oficial (get-pip.py)...")
    tmp = Path(tempfile.mkstemp(prefix=".get-pip.", suffix=".py", dir=str(ctx.rea_tools_dir))[1])
    try:
        request = urllib.request.Request(
            ctx.get_pip_url, headers={"User-Agent": f"{PROJECT_NAME}-setup"}
        )
        with urllib.request.urlopen(request, timeout=60) as response, tmp.open("wb") as fh:
            shutil.copyfileobj(response, fh)
        result = subprocess.run(
            [str(python), str(tmp), "--disable-pip-version-check", "--no-warn-script-location"],
            capture_output=True,
            text=True,
            timeout=900,
        )
        if result.returncode != 0:
            ui.warn(f"get-pip.py falhou: {(result.stderr or result.stdout or '').strip()[-300:]}")
            return False
    except Exception as exc:  # noqa: BLE001
        ui.warn(f"não foi possível baixar/rodar o get-pip.py: {exc}")
        return False
    finally:
        tmp.unlink(missing_ok=True)
    return _python_has_pip(python)


def step_pwntools(ctx: Ctx, ui: UI) -> None:
    ui.step(6, "Provider offline pwntools (inspect_binary_layout)")
    venv_python = ctx.pwntools_python
    # Exporta para o processo: o `rea setup` (etapa 9) herda este ambiente.
    os.environ["REA_PWNTOOLS_PYTHON"] = str(venv_python)

    if ui.dry_run:
        ui.info(f"REA_PWNTOOLS_PYTHON={venv_python}")
        ui.show(f"python3 -m venv {ctx.pwntools_venv_dir}  # apenas se ausente")
        ui.show(
            f"{venv_python} -m pip install pwntools=={ctx.pwntools_version} "
            f"pyelftools=={ctx.pyelftools_version} unicorn=={ctx.unicorn_version} "
            f"setuptools=={ctx.setuptools_version}"
        )
        ui.mark(6, "dry", "plano impresso")
        return

    if _pwntools_env_ok(venv_python, ctx):
        ui.ok(f"venv já pronto e pinado: {ctx.pwntools_venv_dir}")
        ui.info(f"REA_PWNTOOLS_PYTHON={venv_python}")
        ui.mark(6, "ok", "já instalado")
        return

    if not venv_python.is_file():
        try:
            import venv as venv_mod  # noqa: F401
        except ImportError as exc:  # python3-venv ausente
            raise SetupFailure(
                EXIT_PWNTOOLS,
                "módulo 'venv' do Python indisponível",
                [
                    f"não foi possível importar 'venv': {exc}",
                    "instale o suporte a venv (Debian/Ubuntu: sudo apt-get install python3-venv) "
                    "e rode o setup novamente.",
                    f"venv alvo: {ctx.pwntools_venv_dir}",
                ],
            ) from exc

        ensure_dir(ui, ctx.rea_tools_dir)
        ui.info(f"criando venv em {ctx.pwntools_venv_dir} ...")
        with _suppress_output():
            created = _create_venv(ctx.pwntools_venv_dir)
        if not created or not venv_python.is_file():
            raise SetupFailure(
                EXIT_PWNTOOLS,
                "falha ao criar o venv do pwntools",
                [
                    f"'{venv_python}' não pôde ser criado com 'python3 -m venv'.",
                    "instale python3-venv (Debian/Ubuntu: sudo apt-get install python3-venv) "
                    "e rode o setup novamente.",
                ],
            )
        ui.ok(f"venv criado: {ctx.pwntools_venv_dir}")

    if not _bootstrap_pip(venv_python, ctx, ui):
        raise SetupFailure(
            EXIT_PWNTOOLS,
            "pip indisponível no venv do pwntools",
            [
                "não consegui obter 'pip' no venv (ensurepip e get-pip.py falharam).",
                "instale python3-venv (Debian/Ubuntu: sudo apt-get install python3-venv) "
                "e rode o setup novamente.",
                f"venv: {ctx.pwntools_venv_dir}",
            ],
        )

    ui.info(
        "instalando pacotes pinados: "
        f"pwntools=={ctx.pwntools_version}, pyelftools=={ctx.pyelftools_version}, "
        f"unicorn=={ctx.unicorn_version} ..."
    )
    if not _pip_install_pwntools(venv_python, ctx):
        raise SetupFailure(
            EXIT_PWNTOOLS,
            "pacotes do pwntools ausentes/incorretos após a instalação",
            [
                "esperado: "
                f"pwntools=={ctx.pwntools_version}, pyelftools=={ctx.pyelftools_version}, "
                f"unicorn=={ctx.unicorn_version}",
                f"confira manualmente: {venv_python} -m pip list",
            ],
        )

    ui.ok(
        f"pwntools {ctx.pwntools_version} + pyelftools {ctx.pyelftools_version} + "
        f"unicorn {ctx.unicorn_version} prontos em {ctx.pwntools_venv_dir}"
    )
    ui.mark(6, "ok", f"venv em {ctx.pwntools_venv_dir}")


# ---------------------------------------------------------------------------
# Etapa 7 — Rizin (provider de análise nativa mais leve que Ghidra)
#   Download do tarball estático (xz) → SHA-256 → extração → REA_RIZIN_COMMAND
#   O REA faz spawn("rizin") do PATH, ou usa REA_RIZIN_COMMAND quando setado.
# ---------------------------------------------------------------------------
def step_rizin(ctx: Ctx, ui: UI) -> None:
    ui.step(7, f"Rizin {ctx.rizin_version} (provider de análise nativa)")
    rizin_bin = ctx.rizin_bin

    # Já instalado?
    if rizin_bin.is_file():
        ui.ok(f"Rizin já extraído: {rizin_bin}")
        ui.mark(7, "ok", "já extraído")
        return

    if ui.dry_run:
        _rizin_plan(ctx, ui)
        ui.mark(7, "dry", "plano impresso")
        return

    # Tarball ausente ou SHA-256 divergente → baixar .part
    if not _rizin_tarball_ok(ctx, ui):
        if ctx.rizin_tarball_path.is_file():
            ui.warn("tarball presente mas SHA-256 diverge; baixando novamente")
            ctx.rizin_tarball_path.unlink()

        size_mib = _mib(ctx.rizin_static_size)
        ui.info(
            f"baixando Rizin {ctx.rizin_version} "
            f"(~{ctx.rizin_static_size} bytes / ~{size_mib} MiB)..."
        )
        ui.info(f"URL: {ctx.rizin_url}")
        ensure_dir(ui, ctx.rea_tools_dir)
        part = ctx.rizin_tarball_path.with_name(ctx.rizin_tarball_path.name + ".part")
        part.unlink(missing_ok=True)
        download(
            ctx.rizin_url,
            part,
            ui,
            expected_size=_int_or_zero(ctx.rizin_static_size),
            exit_code=EXIT_GHIDRA,  # reusa o código genérico de download
            label=f"Rizin {ctx.rizin_version}",
        )
        # Valida SHA-256 ANTES de promover
        got = sha256_of(part, ui)
        if got != ctx.rizin_sha256:
            raise SetupFailure(
                EXIT_GHIDRA,
                "SHA-256 do Rizin não confere com o pin",
                [
                    f"esperado: {ctx.rizin_sha256}",
                    f"obtido:   {got}",
                    "abortando SEM extrair.",
                ],
            )
        os.replace(part, ctx.rizin_tarball_path)
        ui.ok("SHA-256 OK")
    else:
        ui.ok("tarball já presente e SHA-256 confere")

    # Extrair para o diretório de instalação
    ui.info(f"extraindo em {ctx.rizin_install_dir} ...")
    ensure_dir(ui, ctx.rea_tools_dir)
    extract_tmp = Path(tempfile.mkdtemp(prefix=".extract.", dir=str(ctx.rea_tools_dir)))
    try:
        with ui.status("extraindo o xz do Rizin"):
            run(ui, ["tar", "-xJf", ctx.rizin_tarball_path, "-C", extract_tmp])

        src_dir = extract_tmp / ctx.rizin_extracted_dirname
        if not (src_dir / "bin" / "rizin").is_file():
            # O tarball pode ser "flat" (bin/ na raiz, sem diretório wrapper)
            # ou ter um wrapper (<nome>/bin/rizin). Escolher por ordem alfabética
            # pega "bin" e instala os binários soltos na raiz — por isso a busca
            # é pelo diretório que de fato contém bin/rizin.
            candidates = [extract_tmp, *sorted(p for p in extract_tmp.iterdir() if p.is_dir())]
            match = next((d for d in candidates if (d / "bin" / "rizin").is_file()), None)
            if match is None:
                raise SetupFailure(
                    EXIT_GHIDRA,
                    "diretório extraído do Rizin não encontrado",
                    [f"nenhum diretório com bin/rizin em {extract_tmp}"],
                )
            src_dir = match

        _swap_dir(ctx.rizin_install_dir, src_dir)

        if not rizin_bin.is_file():
            raise SetupFailure(
                EXIT_GHIDRA,
                "instalação do Rizin inválida",
                [f"{rizin_bin} ausente após a extração."],
            )

        # Garante permissão de execução
        for binary in ctx.rizin_install_dir.rglob("bin/*"):
            if binary.is_file():
                try:
                    binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                except OSError:
                    pass

        ui.ok(f"Rizin instalado em {ctx.rizin_install_dir}")
        ui.mark(7, "ok", f"instalado em {ctx.rizin_install_dir}")
    finally:
        shutil.rmtree(extract_tmp, ignore_errors=True)
        ctx.rizin_tarball_path.with_name(ctx.rizin_tarball_path.name + ".part").unlink(missing_ok=True)


def _rizin_tarball_ok(ctx: Ctx, ui: UI) -> bool:
    """True se o tarball estático existe e SHA-256 bate com o pin."""
    if not ctx.rizin_tarball_path.is_file():
        return False
    return sha256_of(ctx.rizin_tarball_path, ui) == ctx.rizin_sha256


def _rizin_plan(ctx: Ctx, ui: UI) -> None:
    """Imprime o plano do Rizin em dry-run."""
    part = ctx.rizin_tarball_path.with_name(ctx.rizin_tarball_path.name + ".part")
    ensure_dir(ui, ctx.rea_tools_dir)
    if not _rizin_tarball_ok(ctx, ui):
        if ctx.rizin_tarball_path.is_file():
            ui.show(f"rm -f {ctx.rizin_tarball_path}  # SHA-256 diverge")
        size_mib = _mib(ctx.rizin_static_size)
        ui.info(
            f"baixando Rizin {ctx.rizin_version} "
            f"(~{ctx.rizin_static_size} bytes / ~{size_mib} MiB)..."
        )
        ui.info(f"URL: {ctx.rizin_url}")
        ui.dry("download (urllib, .part, retry/backoff, valida tamanho e SHA-256)")
        ui.dry(f"mv -f {part} {ctx.rizin_tarball_path}")
        ui.dry(f"verificar SHA-256 == {ctx.rizin_sha256}")
    else:
        ui.ok("tarball já presente e SHA-256 confere")
    ui.info(f"extraindo em {ctx.rea_tools_dir} (via dir temporário, mv atômico)...")
    ui.dry(f"mkdir <tmpdir>/ && tar -xJf {ctx.rizin_tarball_path} -C <tmpdir>/")
    ui.dry(f"mv {ctx.rizin_install_dir} {ctx.rizin_install_dir}.old.<pid>  # backup")
    ui.dry(
        f"mv <tmpdir>/[<wrapper>/]  # wrapper se existir, senão o próprio <tmpdir> "
        f"(tarball flat) — sempre o dir com bin/rizin → {ctx.rizin_install_dir}"
    )
    ui.dry(f"rm -rf {ctx.rizin_install_dir}.old.<pid>")


# ---------------------------------------------------------------------------
# Etapa 8 — Symlink ~/sr-tools → REA_TOOLS_DIR (Ghidra recusa "." no path)
# ---------------------------------------------------------------------------
def step_symlink(ctx: Ctx, ui: UI) -> None:
    ui.step(8, f"Symlink {ctx.rea_tools_alias} → {ctx.rea_tools_dir}")
    if ui.dry_run:
        ui.show(f"mkdir -p {ctx.rea_tools_alias.parent}")
        ui.show(f"ln -sfn {ctx.rea_tools_dir} {ctx.rea_tools_alias}")
        ui.mark(8, "dry", "plano impresso")
        return

    alias = ctx.rea_tools_alias
    target = ctx.rea_tools_dir

    if alias.is_symlink():
        # Symlink nosso: re-aponta para o $REA_TOOLS_DIR vigente.
        alias.unlink()
        alias.symlink_to(target)
        ui.ok(f"symlink atualizado: {alias} → {target}")
        ui.mark(8, "ok", "atualizado")
    elif alias.exists():
        # `symlink_to` num diretório REAL existente criaria o link DENTRO dele
        # e o projeto Ghidra iria para o lugar errado.
        raise SetupFailure(
            EXIT_USAGE,
            f"{alias} existe e NÃO é um symlink (diretório/arquivo real).",
            [
                f"O symlink aponta para {target} e é usado pelo Ghidra "
                f"(que recusa '.' no path).",
                f"Mova ou remova: mv {alias} {alias}.bak",
            ],
        )
    else:
        # Caminho não existe: cria o diretório pai e o symlink.
        alias.parent.mkdir(parents=True, exist_ok=True)
        alias.symlink_to(target)
        ui.ok(f"symlink criado: {alias} → {target}")
        ui.mark(8, "ok", "criado")


# ---------------------------------------------------------------------------
# Etapa 8 — GHIDRA_INSTALL_DIR -> setup/env.sh (e, opcionalmente, ~/.bashrc)
# ---------------------------------------------------------------------------
RC_MARKER = "sublime-rea setup"


def step_env(ctx: Ctx, ui: UI, write_rc: bool) -> None:
    ui.step(
        9,
        f"Variáveis de ambiente (GHIDRA_INSTALL_DIR, {OPENCODE_PWNTOOLS_KEY}, "
        f"{GHIDRA_STARTUP_TIMEOUT_KEY}, REA_RIZIN_COMMAND)",
    )
    # O env do usuário tem precedência sobre os defaults (ver _ghidra_startup_timeout_ms).
    startup_timeout_ms = _ghidra_startup_timeout_ms(ui)
    os.environ["GHIDRA_INSTALL_DIR"] = str(ctx.ghidra_install_dir)
    os.environ["REA_TOOLS_DIR"] = str(ctx.rea_tools_dir)
    os.environ["REA_TOOLS_ALIAS"] = str(ctx.rea_tools_alias)
    os.environ["REA_PWNTOOLS_PYTHON"] = str(ctx.pwntools_python)
    os.environ[GHIDRA_STARTUP_TIMEOUT_KEY] = startup_timeout_ms
    if ctx.java_home:
        # P3.9: o CLI `rea` herda JAVA_HOME do ambiente; sem ele o doctor fica
        # `healthy: false` em shells não-interativos. A etapa 10 (doctor) roda como
        # subprocess e herda este os.environ — por isso setamos aqui, antes dela.
        os.environ["JAVA_HOME"] = ctx.java_home
    ui.info(f"GHIDRA_INSTALL_DIR={ctx.ghidra_install_dir}")
    ui.info(f"REA_TOOLS_ALIAS={ctx.rea_tools_alias}")
    ui.info(f"{OPENCODE_PWNTOOLS_KEY}={ctx.pwntools_python}")
    ui.info(f"{GHIDRA_STARTUP_TIMEOUT_KEY}={startup_timeout_ms} (deadline do provider Ghidra)")
    ui.info(f"REA_RIZIN_COMMAND={ctx.rizin_bin} (provider nativo Rizin)")
    if ctx.java_home:
        ui.info(f"JAVA_HOME={ctx.java_home} (detectado na etapa 3; exportado no env.sh)")

    if ui.dry_run:
        ui.show(f"escrever {ENV_FILE} (atômico: temp + rename)")
    else:
        # `env.sh` é reescrito inteiro (temp + rename), então é idempotente por construção:
        # reexecutar não duplica linhas. O `~/.bashrc` usa o RC_MARKER abaixo pelo mesmo motivo.
        if ctx.java_home:
            java_line = (
                f'export JAVA_HOME="{ctx.java_home}"  '
                f"# detectado pelo setup.py (JDK >= {ctx.ghidra_jdk_min}); ajuste p/ forçar outro\n"
            )
        elif ctx.java_hint:
            java_line = (
                f'# export JAVA_HOME="{ctx.java_hint}"  '
                f"# detectado, mas < JDK {ctx.ghidra_jdk_min}; troque por um compatível e descomente\n"
            )
        else:
            java_line = (
                f'# export JAVA_HOME="/caminho/do/jdk-{ctx.ghidra_jdk_min}"  '
                "# descomente se precisar forçar um JDK\n"
            )
        # `rea` e `node` (>= 20) são globais no bin do Node detectado na etapa 4; shells
        # não-interativos (scripts, CI, agentes) não herdam o PATH do nvm — por isso o
        # env.sh também predispõe esse bin. Idempotente: o arquivo é reescrito por inteiro.
        path_line = ""
        for cmd in ("rea", "node"):
            found = shutil.which(cmd)
            if found:
                bindir = str(Path(found).parent)
                path_line = (
                    f'export PATH="{bindir}:$PATH"  # {cmd} detectado pelo setup '
                    "(Node >= 20 + CLI rea)\n"
                )
                break
        _write_atomic(
            ENV_FILE,
            "# Gerado por setup/setup.py — 'source' este arquivo para exportar o ambiente do sublime-rea.\n"
            + path_line
            + f'export REA_TOOLS_DIR="{ctx.rea_tools_dir}"\n'
            f'export REA_TOOLS_ALIAS="{ctx.rea_tools_alias}"\n'
            f'export GHIDRA_INSTALL_DIR="{ctx.ghidra_install_dir}"\n'
            f'export {OPENCODE_PWNTOOLS_KEY}="{ctx.pwntools_python}"\n'
            f'export {GHIDRA_STARTUP_TIMEOUT_KEY}="{startup_timeout_ms}"  '
            f"# deadline (ms) do provider Ghidra; aumente p/ alvos com auto-análise longa\n"
            f'export REA_RIZIN_COMMAND="{ctx.rizin_bin}"  '
            f"# provider de análise nativa Rizin (estático)\n"
            + java_line,
        )
        ui.ok(f"escrito {ENV_FILE}")

    if write_rc:
        existing = (
            RC_FILE.read_text(encoding="utf-8", errors="replace") if RC_FILE.is_file() else ""
        )
        if RC_MARKER in existing:
            ui.ok(f"{RC_FILE} já contém o bloco do sublime-rea")
        elif ui.dry_run:
            ui.show(f"anexar 'source {ENV_FILE}' em {RC_FILE}")
        else:
            with RC_FILE.open("a", encoding="utf-8") as fh:
                fh.write(
                    f"\n# >>> {RC_MARKER} >>>\n"
                    f'[ -f "{ENV_FILE}" ] && . "{ENV_FILE}"\n'
                    f"# <<< {RC_MARKER} <<<\n"
                )
            ui.ok(f"bloco adicionado em {RC_FILE}")
    else:
        ui.info("rc não alterado (use --write-rc para persistir no ~/.bashrc)")

    ui.mark(9, "ok", "env.sh escrito" if not ui.dry_run else "dry-run")


# ---------------------------------------------------------------------------
# Etapa 8 — extrair o alvo (Sublime Text) em target/
# ---------------------------------------------------------------------------
def step_target(ctx: Ctx, ui: UI) -> None:
    ui.step(10, f"Extraindo alvo (Sublime Text build {ctx.sublime_build})")
    if _target_bin_valid(ctx.target_bin):
        ui.ok(f"alvo já extraído: {ctx.target_bin}")
        ui.mark(10, "ok", "já extraído")
        return

    rel_bin = ctx.target_bin.relative_to(ctx.target_dir)

    if ui.dry_run:
        _target_plan(ctx, ui)
        ui.mark(10, "dry", "plano impresso")
        return

    # O tarball não é mais versionado: garante presença + SHA-256 (baixa sob
    # demanda se faltar; offline OK se já estiver em bin/ com o SHA correto).
    _ensure_tarball(ctx, ui)

    ensure_dir(ui, ctx.target_dir)
    tmp_dir = Path(tempfile.mkdtemp(prefix=".extract.", dir=str(ctx.target_dir)))
    try:
        try:
            run(ui, ["tar", "-xJf", ctx.tarball, "-C", tmp_dir])
        except FileNotFoundError as exc:
            raise SetupFailure(
                EXIT_TARGET,
                "ferramenta de extração ausente",
                [f"{exc}", "instale 'tar' e 'xz-utils' (ou rode com --install-deps)."],
            ) from exc
        except subprocess.CalledProcessError as exc:
            raise SetupFailure(
                EXIT_TARGET, "extração do alvo falhou", [f"tar retornou {exc.returncode}"]
            ) from exc

        if not _target_bin_valid(tmp_dir / rel_bin):
            raise SetupFailure(
                EXIT_TARGET,
                "extração do alvo falhou",
                [f"{tmp_dir / rel_bin} ausente/truncado após o tar."],
            )

        # só promove depois de validar: o dir anterior é preservado até o mv dar certo
        for entry in sorted(tmp_dir.iterdir()):
            final = ctx.target_dir / entry.name
            if final.exists() or final.is_symlink():
                _swap_dir(final, entry)
            else:
                shutil.move(str(entry), str(final))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    if not _target_bin_valid(ctx.target_bin):
        raise SetupFailure(
            EXIT_TARGET, "extração do alvo falhou", [f"{ctx.target_bin} inválido após o tar."]
        )
    ui.ok(f"extraído: {ctx.target_bin}")
    ui.mark(10, "ok", str(ctx.target_bin))


def _tarball_sha_ok(ctx: Ctx, ui: UI) -> bool:
    """True se ``bin/<tarball>`` existe e bate com o SHA-256 pinado."""
    if not ctx.tarball.is_file():
        return False
    return sha256_of(ctx.tarball, ui) == ctx.sublime_tarball_sha256


def _ensure_tarball(ctx: Ctx, ui: UI) -> None:
    """Garante que ``bin/<tarball>`` existe e tem o SHA-256 pinado.

    * arquivo presente + SHA-256 OK → **não** toca na rede (funciona offline);
    * ausente **ou** SHA-256 divergente → baixa da URL pinada para ``.part``,
      **valida o SHA-256 ANTES de promover** (``os.replace`` atômico). SHA-256
      divergente = erro fatal: nada é extraído e o arquivo existente é preservado.
    """
    if ctx.tarball.is_file():
        if _tarball_sha_ok(ctx, ui):
            ui.ok("tarball do alvo já presente e SHA-256 confere")
            return
        ui.warn("tarball do alvo presente mas SHA-256 diverge; baixando novamente")

    size_mib = _mib(ctx.sublime_tarball_size)
    ui.info(
        f"baixando alvo build {ctx.sublime_build} "
        f"(~{ctx.sublime_tarball_size} bytes / ~{size_mib} MiB)..."
    )
    ui.info(f"URL: {ctx.sublime_tarball_url}")
    ensure_dir(ui, ctx.tarball.parent)
    part = ctx.tarball.with_name(ctx.tarball.name + ".part")
    part.unlink(missing_ok=True)
    try:
        # download atômico: grava em .part e só promove após validar o SHA-256
        download(
            ctx.sublime_tarball_url,
            part,
            ui,
            expected_size=_int_or_zero(ctx.sublime_tarball_size),
            exit_code=EXIT_TARGET,
            label=f"alvo (build {ctx.sublime_build})",
            hint=(
                "sem rede? coloque o tarball manualmente em "
                f"{ctx.tarball} (SHA-256 pinado em setup/versions.env)."
            ),
        )
        got = sha256_of(part, ui)
        if got != ctx.sublime_tarball_sha256:
            raise SetupFailure(
                EXIT_TARGET,
                "SHA-256 do tarball do alvo não confere com o pin",
                [
                    f"esperado: {ctx.sublime_tarball_sha256}",
                    f"obtido:   {got}",
                    "abortando SEM extrair e SEM sobrescrever o arquivo existente.",
                ],
            )
        os.replace(part, ctx.tarball)
        ui.ok("SHA-256 OK")
    finally:
        part.unlink(missing_ok=True)


def _target_plan(ctx: Ctx, ui: UI) -> None:
    """Imprime o plano do alvo em dry-run (download incluído quando necessário)."""
    rel_bin = ctx.target_bin.relative_to(ctx.target_dir)
    top_name = rel_bin.parts[0]
    if ctx.tarball.is_file() and _tarball_sha_ok(ctx, ui):
        ui.ok("tarball do alvo já presente e SHA-256 confere")
    else:
        if ctx.tarball.is_file():
            ui.warn("tarball do alvo presente mas SHA-256 diverge; baixaria novamente")
        ui.info(f"baixando alvo build {ctx.sublime_build} de {ctx.sublime_tarball_url}")
        ui.dry(
            "download (urllib, .part, retry/backoff, valida o tamanho vs Content-Length "
            "e barra de progresso)"
        )
        ui.dry(f"mv -f {ctx.tarball}.part {ctx.tarball}")
        ui.dry(f"verificar SHA-256 == {ctx.sublime_tarball_sha256} (antes de extrair)")
    ui.show(f"mkdir -p {ctx.target_dir}  # extração atômica num dir temporário")
    ui.show(f"mkdir <tmp> && tar -xJf {ctx.tarball} -C <tmp>")
    ui.show("validar o alvo (tamanho > 1 MiB e magic ELF) ANTES de promover")
    ui.show(f"mv <tmp>/{top_name} {ctx.target_dir}/  # atômico, preservando o anterior")


ELF_MAGIC = b"\x7fELF"
TARGET_BIN_MIN_BYTES = 1024 * 1024


def _target_bin_valid(path: Path) -> bool:
    """Existe, tem tamanho plausível (> 1 MiB) e magic ELF (detecta tar truncado)."""
    try:
        if not path.is_file() or path.stat().st_size <= TARGET_BIN_MIN_BYTES:
            return False
        with path.open("rb") as fh:
            return fh.read(4) == ELF_MAGIC
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Etapa 11 — registrar MCP no opencode (rea setup) + propagar env do REA
# ---------------------------------------------------------------------------
OPENCODE_PWNTOOLS_KEY = "REA_PWNTOOLS_PYTHON"
# Deadline (ms) da auto-análise do provider Ghidra quando o REA sobe o target.
# O default do REA é 330000 ms (330 s) e ESTE alvo mede ~342 s no headless (auto-análise:
# 334 s) — ou seja, estourava o default por 4 s (!) e o resultado era descartado.
GHIDRA_STARTUP_TIMEOUT_KEY = "REA_GHIDRA_STARTUP_TIMEOUT_MS"
DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS = "900000"  # 15 min (~2,6× o medido)


# O REA valida esse valor com ``^[1-9]\d*$`` limitado a int32
# (rea-agents/dist/config/providerStartupTimeout.js:14-17). Um typo propagado para o
# ``env.sh`` E para o ``environment`` do MCP faz o zod lançar no boot do servidor `rea` —
# derrubando TODAS as tools REA. Então validamos aqui e caímos no default.
GHIDRA_STARTUP_TIMEOUT_MAX_MS = 2147483647


def _ghidra_startup_timeout_ms(ui: UI | None = None) -> str:
    """Valor a gravar: ``REA_GHIDRA_STARTUP_TIMEOUT_MS`` do ambiente, senão o default.

    É o override disponível ao usuário — ex.:
    ``REA_GHIDRA_STARTUP_TIMEOUT_MS=7200000 python3 setup/setup.py``.

    Valor inválido (mesmo contrato do REA: ``^[1-9]\\d*$``, ``1..2147483647``) não é
    propagado: com ``ui``, avisa e devolve o default (nunca levanta exceção).
    """
    raw = os.environ.get(GHIDRA_STARTUP_TIMEOUT_KEY)
    if not raw:
        return DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS
    if re.fullmatch(r"[1-9]\d*", raw) and int(raw) <= GHIDRA_STARTUP_TIMEOUT_MAX_MS:
        return raw
    if ui is not None:
        ui.warn(
            f"{GHIDRA_STARTUP_TIMEOUT_KEY}={raw!r} inválido (esperado inteiro positivo "
            f"até {GHIDRA_STARTUP_TIMEOUT_MAX_MS}, igual ao REA); usando o default "
            f"{DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS}"
        )
    return DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS


# Casamento de chaves JSON/JSONC: "chave" seguida de ':'.
_JSONC_KEY_RE = re.compile(r'"((?:[^"\\]|\\.)*)"\s*:')


def _opencode_config_path() -> Path:
    """Config do opencode: honra ``OPENCODE_CONFIG``, senão ``XDG_CONFIG_HOME``."""
    override = os.environ.get("OPENCODE_CONFIG")
    if override:
        return Path(override).expanduser()
    base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")) / "opencode"
    for name in ("opencode.jsonc", "opencode.json"):
        candidate = base / name
        if candidate.is_file():
            return candidate
    return base / "opencode.jsonc"


def _jsonc_match_brace(text: str, open_index: int) -> int | None:
    """Índice do ``}``/``]`` que fecha o ``{``/``[`` em ``open_index`` (string-aware)."""
    depth = 0
    in_str = False
    esc = False
    i = open_index
    while i < len(text):
        char = text[i]
        if in_str:
            if esc:
                esc = False
            elif char == "\\":
                esc = True
            elif char == '"':
                in_str = False
        elif char == '"':
            in_str = True
        elif char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _jsonc_key_object(text: str, key: str, start: int = 0) -> tuple[int, int] | None:
    """Span ``(open``, ``close)`` do objeto-valor de ``key`` a partir de ``start``."""
    for match in _JSONC_KEY_RE.finditer(text, start):
        if match.group(1) != key:
            continue
        index = match.end()
        while index < len(text) and text[index] in " \t\r\n":
            index += 1
        if index < len(text) and text[index] == "{":
            close = _jsonc_match_brace(text, index)
            if close is not None:
                return index, close
    return None


def _line_indent(text: str, index: int) -> str:
    line_start = text.rfind("\n", 0, index) + 1
    end = line_start
    while end < len(text) and text[end] in " \t":
        end += 1
    return text[line_start:end]


def _jsonc_line_comment_start(line: str) -> int | None:
    """Índice do ``//`` de um comentário de linha (fora de string), ou ``None``."""
    in_str = False
    esc = False
    for i, char in enumerate(line):
        if in_str:
            if esc:
                esc = False
            elif char == "\\":
                esc = True
            elif char == '"':
                in_str = False
            continue
        if char == '"':
            in_str = True
        elif char == "/" and line[i : i + 2] == "//":
            return i
    return None


def _jsonc_env_value_span(
    text: str, env_open: int, env_close: int, key: str
) -> tuple[int, int, object] | None:
    """Span ``(start``, ``end``, ``valor)`` do key ``key`` dentro do objeto ``environment``.

    Aceita valor de **qualquer tipo JSON/JSONC** (string, número, ``true``/``false``/``null``):
    um ``"K": 900000`` (número — plausível para um ``*_MS``) precisa ser reconhecido, senão
    a inserção criaria uma **chave duplicada** no JSONC (o ``json.loads`` ficaria com a última
    e o assert passaria, mas o arquivo sairia com a chave duas vezes).
    """
    decoder = json.JSONDecoder()
    for match in _JSONC_KEY_RE.finditer(text, env_open, env_close):
        if match.group(1) != key:
            continue
        i = match.end()
        while i < env_close and text[i] in " \t\r\n":
            i += 1
        if i >= env_close:
            continue
        try:
            value, end = decoder.raw_decode(text, i)
        except ValueError:
            continue
        if end > env_close:
            continue
        return i, end, value
    return None


def _jsonc_rea_server_span(
    text: str, mcp: tuple[int, int] | None
) -> tuple[int, int] | None:
    """Span do objeto do servidor ``rea`` dentro de ``mcp``.

    O opencode já não aninha servidores em ``mcp.servers``: o schema vigente é
    ``mcp.<nome>`` direto. Aceitamos **ambos** — ``mcp.servers.rea`` (legado) e
    ``mcp.rea`` (atual) — senão a gravação do env silencia com warn e o registro
    do MCP fica sem as variáveis.
    """
    if not mcp:
        return None
    servers = _jsonc_key_object(text, "servers", mcp[0])
    if servers:
        rea = _jsonc_key_object(text, "rea", servers[0])
        if rea:
            return rea
    return _jsonc_key_object(text, "rea", mcp[0])


def _jsonc_rea_env_value(text: str, key: str) -> object | None:
    """Valor atual de ``mcp[.servers].rea.environment[key]`` (ou None)."""
    mcp = _jsonc_key_object(text, "mcp")
    rea = _jsonc_rea_server_span(text, mcp)
    env = _jsonc_key_object(text, "environment", rea[0]) if rea else None
    if not env:
        return None
    span = _jsonc_env_value_span(text, env[0], env[1], key)
    return span[2] if span else None


def _jsonc_set_rea_env(text: str, key: str, value: str) -> tuple[str | None, bool]:
    """Insere/atualiza ``key=value`` em ``mcp[.servers].rea.environment``.

    Edição **cirúrgica por texto** (preserva comentários/formatação do JSONC);
    retorna ``(novo_texto, mudou)`` ou ``(None, False)`` se a estrutura não existe.
    """
    mcp = _jsonc_key_object(text, "mcp")
    rea = _jsonc_rea_server_span(text, mcp)
    if not rea:
        return None, False
    rea_open, rea_close = rea
    env = _jsonc_key_object(text, "environment", rea_open)
    if env is not None:
        env_open, env_close = env
        span = _jsonc_env_value_span(text, env_open, env_close, key)
        if span is not None:
            if span[2] == value:
                return text, False
            return text[: span[0]] + json.dumps(value) + text[span[1] :], True
        indent = _line_indent(text, env_open) + "  "
        close_indent = _line_indent(text, env_open)
        trimmed = text[:env_close].rstrip()
        entry = f"{indent}{json.dumps(key)}: {json.dumps(value)}"
        if trimmed.endswith(("{", ",")):
            new_before = f"{trimmed}\n{entry}"
        else:
            # A vírgula tem de seguir o último valor ANTES de um comentário de linha:
            # em ``"A": "1" // fim`` o ``,`` depois do comentário viraria texto do
            # comentário (``// fim,``) e o JSONC ficaria inválido — o wiring do env
            # então não era gravado. Com o comentário na mesma linha, a vírgula entra
            # antes dele (``"A": "1", // fim``).
            last_line_start = trimmed.rfind("\n") + 1
            comment = _jsonc_line_comment_start(trimmed[last_line_start:])
            if comment is None:
                new_before = f"{trimmed},\n{entry}"
            else:
                comment_at = last_line_start + comment
                head = trimmed[:comment_at].rstrip()
                tail = trimmed[comment_at + 2 :]
                new_before = f"{head}, //{tail}\n{entry}"
        return new_before + "\n" + close_indent + text[env_close:], True
    # servidor sem bloco `environment`: cria um
    indent = _line_indent(text, rea_open) + "  "
    block = (
        f'{indent}"environment": {{\n'
        f"{indent}  {json.dumps(key)}: {json.dumps(value)}\n"
        f"{indent}}}"
    )
    sep = ",\n" if text[rea_open + 1 : rea_close].strip() else "\n"
    return (
        text[:rea_close] + f"{sep}{block}\n" + _line_indent(text, rea_open) + text[rea_close:],
        True,
    )


def _strip_jsonc(text: str) -> str:
    """Remove comentários ``//`` ``/* */`` e vírgulas finais (para validação via json)."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_str = False
    esc = False
    while i < n:
        char = text[i]
        if in_str:
            out.append(char)
            if esc:
                esc = False
            elif char == "\\":
                esc = True
            elif char == '"':
                in_str = False
            i += 1
            continue
        if char == '"':
            in_str = True
            out.append(char)
            i += 1
            continue
        if char == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] not in "\r\n":
                i += 1
            continue
        if char == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(char)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def _ensure_opencode_env(ctx: Ctx, ui: UI, key: str, value: str) -> bool:
    """Garante ``key=value`` no ``environment`` do servidor rea do opencode.

    ``rea setup`` NÃO propaga essas variáveis (o provider offline pwntools não expõe
    ``registrationEnvironment`` e o deadline do Ghidra não é registrado pelo CLI); porém,
    ao reescrever o documento, o REA **preserva** chaves explícitas já presentes no bloco.
    Então gravamos cada chave uma vez (edição cirúrgica, com backup + validação JSON) e o
    ``rea setup`` a mantém depois. Um valor já presente no JSONC é sobrescrito pelo ``value``
    vigente (mesmo comportamento de ``REA_PWNTOOLS_PYTHON``); para outro valor, ajuste o
    JSONC/ambiente e reexecute o setup.
    """
    path = _opencode_config_path()

    if ui.dry_run:
        ui.show(f"garantir {key}={value} em {path}")
        return True
    if not path.is_file():
        ui.warn(f"config do opencode não encontrado ({path}); registre {key} manualmente")
        return False

    original = path.read_text(encoding="utf-8", errors="replace")
    new_text, changed = _jsonc_set_rea_env(original, key, value)
    if new_text is None:
        ui.warn(f"não encontrei 'mcp[.servers].rea.environment' em {path}; ajuste {key} manualmente")
        return False
    if not changed:
        ui.ok(f"{key} já consta em {path}")
        return True

    try:
        data = json.loads(_strip_jsonc(new_text))
        mcp = data["mcp"]
        servers = mcp.get("servers")
        rea = (servers.get("rea") if isinstance(servers, dict) else None) or mcp.get("rea")
        assert rea["environment"][key] == value
    except Exception as exc:  # noqa: BLE001 - nunca gravar jsonc inválido
        ui.warn(f"edição do jsonc não validou ({exc}); mantendo o original")
        return False

    backup = path.with_name(path.name + ".bak")
    shutil.copy2(path, backup)
    _write_atomic(path, new_text)
    ui.ok(f"{key} gravado em {path} (backup: {backup.name})")
    return True


# Aviso por chave quando o registro MCP não puder recebê-la.
_MCP_ENV_HINTS = {
    "REA_RIZIN_COMMAND": (
        "o provider nativo Rizin ficará inacessível até você adicioná-la ao "
        "environment do servidor rea (REA_RIZIN_COMMAND)"
    ),
    OPENCODE_PWNTOOLS_KEY: (
        "a ferramenta inspect_binary_layout seguirá indisponível na sessão do agente até você "
        "adicioná-la ao `environment` do servidor rea (opencode.jsonc)"
    ),
    GHIDRA_STARTUP_TIMEOUT_KEY: (
        "o provider Ghidra usará o deadline default (330 s) e pode falhar em alvos com "
        "auto-análise longa até você adicioná-la ao `environment` do servidor rea (opencode.jsonc)"
    ),
    "JAVA_HOME": (
        "o provider Ghidra dependerá do JAVA_HOME herdado do shell; adicione um JDK >= 21 "
        "ao `environment` do servidor rea (opencode.jsonc) para o MCP funcionar em qualquer ambiente"
    ),
}


def _mcp_env_entries(ctx: Ctx, ui: UI | None = None) -> list[tuple[str, str]]:
    """Pares ``(chave, valor)`` que devem existir em ``mcp.servers.rea.environment``.

    ``ui`` é repassado para que um deadline inválido no ambiente seja avisado também
    aqui (o valor que vai ao MCP é sempre o validado/default).
    """
    entries = [
        ("REA_RIZIN_COMMAND", str(ctx.rizin_bin)),
        (OPENCODE_PWNTOOLS_KEY, str(ctx.pwntools_python)),
        (GHIDRA_STARTUP_TIMEOUT_KEY, _ghidra_startup_timeout_ms(ui)),
    ]
    if ctx.java_home:  # P3.9: só entra no registro se um JDK compatível foi detectado
        entries.append(("JAVA_HOME", ctx.java_home))
    return entries


def step_mcp(ctx: Ctx, ui: UI, rea_cmd: list[str]) -> None:
    ui.step(11, "Registrando MCP no opencode (rea setup --client opencode)")
    cmd = [*rea_cmd, "setup", "--client", "opencode", "--yes"]
    if ui.dry_run:
        # repassa --dry-run ao REA quando o próprio script está em dry-run
        ui.dry(" ".join([*cmd, "--dry-run"]))
        for key, value in _mcp_env_entries(ctx, ui):
            _ensure_opencode_env(ctx, ui, key, value)
        ui.mark(11, "dry", "plano impresso")
        return
    # `REA_PWNTOOLS_PYTHON` já está em os.environ (etapa 6), herdado pelo subprocess.
    result = run(ui, cmd, check=False)
    if result.returncode != 0:
        raise SetupFailure(
            EXIT_MCP, "'rea setup --client opencode' falhou", [f"exit code {result.returncode}"]
        )
    ui.ok("MCP registrado para o client 'opencode'")

    for key, value in _mcp_env_entries(ctx, ui):
        try:
            current = _jsonc_rea_env_value(_opencode_config_path().read_text(encoding="utf-8"), key)
        except OSError:
            current = None
        if current == value:
            ui.ok(f"rea setup preservou {key} no registro")
        elif not _ensure_opencode_env(ctx, ui, key, value):
            ui.warn(f"{key} NÃO está no registro MCP; {_MCP_ENV_HINTS[key]}")
    ui.mark(11, "ok", "registrado")


# ---------------------------------------------------------------------------
# Etapa 10 — verificação final: rea doctor (preserva o diagnóstico)
# ---------------------------------------------------------------------------
def _parse_last_json_object(text: str) -> dict:
    """Extrai o último objeto JSON do stdout, tolerando ruído antes dele.

    ``npx``/``rea`` podem imprimir avisos/warnings antes do JSON; ``json.loads``
    no stdout cru quebra com isso. Aqui tentamos ``raw_decode`` a partir de cada
    ``{`` e ficamos com o último objeto decodificado.
    """
    decoder = json.JSONDecoder()
    found: dict | None = None
    index = text.find("{")
    while index != -1:
        try:
            value, end = decoder.raw_decode(text[index:])
        except ValueError:
            index = text.find("{", index + 1)
            continue
        if isinstance(value, dict):
            found = value
        # pula o objeto inteiro: objetos aninhados não devem "ganhar" do externo
        index = text.find("{", index + max(end, 1))
    if found is None:
        raise ValueError("nenhum objeto JSON encontrado na saída do comando")
    return found


def step_doctor(ctx: Ctx, ui: UI, rea_cmd: list[str]) -> None:
    ui.step(12, "Verificação final (rea doctor)")
    cmd = [*rea_cmd, "doctor", "--client", "opencode", "--provider", "ghidra", "--format", "json"]

    if ui.dry_run:
        ui.dry(" ".join(cmd))
        ui.mark(12, "dry", "plano impresso")
        return

    result = proc(cmd, timeout=600)
    stderr = result.stderr or ""
    try:
        data = _parse_last_json_object(result.stdout or "")
    except ValueError as exc:
        raise SetupFailure(
            1,
            "não foi possível interpretar a saída do 'rea doctor'",
            [str(exc)],
            stderr=stderr,
        ) from exc

    # Gate no campo ESCOPADO ('healthy'): veredito do que foi pedido
    # (--client opencode --provider ghidra). 'environment_healthy' é um flag
    # GLOBAL que inclui 'informational_checks' (engines opcionais hopper/ida/jadx
    # e registro em outros clients), então é false em qualquer máquina real.
    if data.get("healthy"):
        ui.ok("rea doctor: ambiente OK (healthy: true)")

        informational = [
            check
            for check in data.get("informational_checks", [])
            if not check.get("ok", True)
        ]
        if informational:
            ui.warn(
                f"rea doctor: {len(informational)} checagem(ns) informacional(is) fora do escopo "
                "(engines opcionais e/ou registro em outros clients) — AVISO, "
                "não afeta o veredito"
            )
            for check in informational:
                name = check.get("name", "?")
                cls = check.get("classification", "")
                detail = check.get("detail") or check.get("remediation") or ""
                ui.warn(f"opcional (esperado): {name} [{cls}]: {detail}")

        ui.mark(12, "ok", "healthy: true")
        return

    reasons = ["healthy: false"]
    for check in data.get("scope_checks", []):
        if check.get("ok", True):
            continue
        name = check.get("name", "?")
        cls = check.get("classification", "")
        detail = check.get("detail") or check.get("remediation") or ""
        reasons.append(f"{name} [{cls}]: {detail}")
    raise SetupFailure(
        1,
        "rea doctor: healthy: false",
        reasons,
        stderr=stderr,
    )


# ---------------------------------------------------------------------------
# Orquestração
# ---------------------------------------------------------------------------
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="setup.py",
        description=(
            "setup.py — ambiente reproduzível do projeto sublime-rea "
            "(REA + Ghidra + alvo). Sem flags: NUNCA usa sudo e NUNCA altera o rc."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Flags:\n"
            "  --dry-run        Imprime o plano SEM executar (sem download, sem sudo, sem escrita).\n"
            "  --install-deps   Só com esta flag instala deps de sistema via apt/sudo.\n"
            "  --write-rc       Só com esta flag anexa 'source setup/env.sh' ao ~/.bashrc.\n"
            "\n"
            "Exemplo completo numa máquina nova:\n"
            "  python3 setup/setup.py --install-deps --write-rc\n"
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="imprime o plano e sai")
    parser.add_argument(
        "--install-deps", action="store_true", help="instala deps faltantes (sudo/apt)"
    )
    parser.add_argument("--write-rc", action="store_true", help="persiste o ambiente no ~/.bashrc")
    return parser.parse_args(argv)


def run_all(ctx: Ctx, ui: UI, args: argparse.Namespace) -> int:
    ui.header(ctx.pins(), args.dry_run)
    step_os(ctx, ui)
    step_deps(ctx, ui, args.install_deps)
    step_java(ctx, ui)
    rea_cmd = step_rea(ctx, ui)
    step_ghidra(ctx, ui)
    step_pwntools(ctx, ui)
    step_rizin(ctx, ui)
    step_symlink(ctx, ui)
    step_env(ctx, ui, args.write_rc)
    step_target(ctx, ui)
    step_mcp(ctx, ui, rea_cmd)
    step_doctor(ctx, ui, rea_cmd)
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    ui: UI | None = None
    steps_started = False

    def resolve_ui() -> UI:
        """UI para erros/interrupções que acontecem antes de `make_ui`."""
        nonlocal ui
        if ui is None:
            ui = make_ui("--dry-run" in argv)
        return ui

    try:
        if not VERSIONS_FILE.is_file():
            sys.stderr.write(f"erro: {VERSIONS_FILE} não encontrado\n")
            return EXIT_USAGE
        try:
            versions = load_versions(VERSIONS_FILE)
        except OSError as exc:
            sys.stderr.write(f"erro: não foi possível ler {VERSIONS_FILE}: {exc}\n")
            return EXIT_USAGE

        rich_version = versions.get("RICH_VERSION") or RICH_VERSION_FALLBACK
        wants_help = any(a in ("-h", "--help") for a in argv)
        if not wants_help:
            bootstrap_rich(SCRIPT_DIR, rich_version, dry_run=("--dry-run" in argv))

        args = parse_args(argv)
        ui = make_ui(args.dry_run)
        ctx = Ctx(versions)

        steps_started = True
        run_all(ctx, ui, args)
    except SetupFailure as failure:
        active = resolve_ui()
        if steps_started:
            active.summary()
        active.error_panel(failure.title, failure.lines)
        if failure.stderr:
            active.raw_stderr(failure.stderr)
        return failure.code
    except KeyboardInterrupt:
        resolve_ui().error_panel("interrompido pelo usuário (Ctrl-C)", [])
        return 130
    except Exception as exc:  # noqa: BLE001 - nunca deixar traceback cru
        resolve_ui().error_panel("erro inesperado", [f"{type(exc).__name__}: {exc}"])
        return 1

    ui = resolve_ui()
    ui.summary()
    if args.dry_run:
        ui.banner("dry-run concluído — nada foi baixado, instalado ou alterado.", kind="dry")
    else:
        ui.banner("Setup concluído com sucesso.", kind="ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
