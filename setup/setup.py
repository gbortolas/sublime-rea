#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""setup.py — instalador idempotente do ambiente do projeto sublime-rea.

Porta 1:1 de ``setup/setup.sh`` (mantido como legacy) para Python 3.10+, com saída
colorida via `rich` e as MESMAS garantias de segurança/idempotência:

* sem flags, NUNCA usa ``sudo`` e NUNCA altera o rc do shell;
* SHA-256 do Ghidra verificado **antes** de extrair;
* download atômico (``.part`` -> ``mv``), lock de instalação e cleanup garantido;
* dependências base só instaladas com ``--install-deps``.

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
TOTAL_STEPS = 9
PROJECT_NAME = "sublime-rea"
RICH_VERSION_FALLBACK = "13.9.4"
BOOTSTRAP_ENV = "SUBLIME_REA_RICH_BOOTSTRAPPED"

# Códigos de saída (paridade com o setup.sh).
EXIT_USAGE = 2
EXIT_GHIDRA = 3
EXIT_TARGET = 4
EXIT_MCP = 5

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
    try:
        venv_mod.EnvBuilder(with_pip=True, clear=False).create(str(venv_dir))
        return True
    except Exception:  # noqa: BLE001 - ensurepip indisponível, etc.
        try:
            venv_mod.EnvBuilder(with_pip=False, clear=False).create(str(venv_dir))
        except Exception:  # noqa: BLE001
            return False
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
    def download_start(self, total: int) -> None: ...
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

    def download_start(self, total: int) -> None:
        self._dl_total = total
        self._dl_last_pct = -1
        self._dl_last_time = time.monotonic()

    def download_update(self, done: int, total: int) -> None:
        total = total or self._dl_total
        pct = int(done * 100 / total) if total else 0
        now = time.monotonic()
        if pct != self._dl_last_pct and (pct % 2 == 0 or now - self._dl_last_time > 3):
            self._dl_last_pct = pct
            self._dl_last_time = now
            print(f"     baixando Ghidra... {pct:3d}% ({done} bytes)", file=sys.stderr)

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

    def download_start(self, total: int) -> None:
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
        self._task = self._progress.add_task("baixando Ghidra", total=total or None)

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
) -> None:
    """Download via urllib com retry/backoff e barra de progresso.

    Valida o tamanho baixado contra o ``Content-Length`` (e contra
    ``expected_size``, quando informado) **dentro** do loop de retry, para que um
    truncamento seja retentado em vez de só ser detectado no SHA-256 (que aborta).
    """
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": f"{PROJECT_NAME}-setup"})
            with urllib.request.urlopen(request, timeout=60) as response, dest.open("wb") as fh:
                total = int(response.headers.get("Content-Length") or 0)
                ui.download_start(total)
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
    raise SetupFailure(
        EXIT_GHIDRA,
        "falha no download do Ghidra",
        [str(last_error)],
    )


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
        self.sublime_target_bin = v("SUBLIME_TARGET_BIN")
        self.node_min = v("NODE_MIN_MAJOR")
        self.rich_version = versions.get("RICH_VERSION") or RICH_VERSION_FALLBACK

        default_tools = versions.get("REA_TOOLS_DIR_DEFAULT") or str(
            Path("~/.local/share/sublime-rea-tools").expanduser()
        )
        self.rea_tools_dir = Path(os.environ.get("REA_TOOLS_DIR") or default_tools).expanduser()
        self.ghidra_zip_path = self.rea_tools_dir / self.ghidra_zip_filename
        self.ghidra_install_dir = self.rea_tools_dir / self.ghidra_extracted_dirname
        self.tarball = REPO_ROOT / self.sublime_tarball
        self.target_bin = REPO_ROOT / self.sublime_target_bin
        self.target_dir = REPO_ROOT / "target"

    def pins(self) -> list[tuple[str, str]]:
        return [
            ("REA", f"{self.rea_package} {self.rea_version}"),
            ("Ghidra", f"{self.ghidra_version} (JDK >= {self.ghidra_jdk_min})"),
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


def step_java(ctx: Ctx, ui: UI) -> None:
    ui.step(3, f"Java (Ghidra {ctx.ghidra_version} exige JDK >= {ctx.ghidra_jdk_min})")
    java_home = os.environ.get("JAVA_HOME", "")
    java_bin = ""
    if java_home and os.access(Path(java_home) / "bin" / "java", os.X_OK):
        java_bin = str(Path(java_home) / "bin" / "java")
    elif have("java"):
        java_bin = shutil.which("java") or ""

    if not java_bin:
        ui.warn("Java não encontrado no PATH nem em JAVA_HOME.")
        ui.warn(f"instale um JDK {ctx.ghidra_jdk_min}+ (Temurin/Corretto): {ctx.ghidra_jdk_url}")
        ui.warn("o setup NÃO instala JDK automaticamente.")
        ui.mark(3, "warn", "Java ausente")
        return

    major, version_line = _java_major(java_bin)
    try:
        ok_java = bool(major) and int(major) >= int(ctx.ghidra_jdk_min)
    except ValueError:
        ok_java = False
    if ok_java:
        ui.ok(f"Java {major} em {java_bin} (>= {ctx.ghidra_jdk_min}, compatível)")
        ui.mark(3, "ok", f"Java {major}")
    else:
        ui.warn(f"Java detectado ({major or '?'}) < {ctx.ghidra_jdk_min}: {version_line}")
        ui.warn(f"instale um JDK {ctx.ghidra_jdk_min}+ (Temurin/Corretto): {ctx.ghidra_jdk_url}")
        ui.mark(3, "warn", f"Java {major or '?'} < {ctx.ghidra_jdk_min}")


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
# Etapa 6 — GHIDRA_INSTALL_DIR -> setup/env.sh (e, opcionalmente, ~/.bashrc)
# ---------------------------------------------------------------------------
RC_MARKER = "sublime-rea setup"


def step_env(ctx: Ctx, ui: UI, write_rc: bool) -> None:
    ui.step(6, "Variáveis de ambiente (GHIDRA_INSTALL_DIR)")
    os.environ["GHIDRA_INSTALL_DIR"] = str(ctx.ghidra_install_dir)
    os.environ["REA_TOOLS_DIR"] = str(ctx.rea_tools_dir)
    ui.info(f"GHIDRA_INSTALL_DIR={ctx.ghidra_install_dir}")

    if ui.dry_run:
        ui.show(f"escrever {ENV_FILE} (atômico: temp + rename)")
    else:
        _write_atomic(
            ENV_FILE,
            "# Gerado por setup/setup.py — 'source' este arquivo para exportar o ambiente do sublime-rea.\n"
            f'export REA_TOOLS_DIR="{ctx.rea_tools_dir}"\n'
            f'export GHIDRA_INSTALL_DIR="{ctx.ghidra_install_dir}"\n'
            f'# export JAVA_HOME="/caminho/do/jdk-{ctx.ghidra_jdk_min}"  '
            "# descomente se precisar forçar um JDK\n",
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

    ui.mark(6, "ok", "env.sh escrito" if not ui.dry_run else "dry-run")


# ---------------------------------------------------------------------------
# Etapa 7 — extrair o alvo (Sublime Text) em target/
# ---------------------------------------------------------------------------
def step_target(ctx: Ctx, ui: UI) -> None:
    ui.step(7, f"Extraindo alvo (Sublime Text build {ctx.sublime_build})")
    if _target_bin_valid(ctx.target_bin):
        ui.ok(f"alvo já extraído: {ctx.target_bin}")
        ui.mark(7, "ok", "já extraído")
        return

    rel_bin = ctx.target_bin.relative_to(ctx.target_dir)
    top_name = rel_bin.parts[0]

    if ui.dry_run:
        if not ctx.tarball.is_file():
            ui.warn(f"tarball do alvo ausente: {ctx.tarball} (dry-run: apenas reporta)")
        ui.show(f"mkdir -p {ctx.target_dir}  # extração atômica num dir temporário")
        ui.show(f"mkdir <tmp> && tar -xJf {ctx.tarball} -C <tmp>")
        ui.show("validar o alvo (tamanho > 1 MiB e magic ELF) ANTES de promover")
        ui.show(f"mv <tmp>/{top_name} {ctx.target_dir}/  # atômico, preservando o anterior")
        ui.mark(7, "dry", "plano impresso")
        return

    if not ctx.tarball.is_file():
        raise SetupFailure(EXIT_TARGET, "tarball do alvo ausente", [str(ctx.tarball)])

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
    ui.mark(7, "ok", str(ctx.target_bin))


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
# Etapa 8 — registrar MCP no opencode
# ---------------------------------------------------------------------------
def step_mcp(ctx: Ctx, ui: UI, rea_cmd: list[str]) -> None:
    ui.step(8, "Registrando MCP no opencode (rea setup --client opencode)")
    cmd = [*rea_cmd, "setup", "--client", "opencode", "--yes"]
    if ui.dry_run:
        # repassa --dry-run ao REA quando o próprio script está em dry-run
        ui.dry(" ".join([*cmd, "--dry-run"]))
        ui.mark(8, "dry", "plano impresso")
        return
    result = run(ui, cmd, check=False)
    if result.returncode == 0:
        ui.ok("MCP registrado para o client 'opencode'")
        ui.mark(8, "ok", "registrado")
    else:
        raise SetupFailure(
            EXIT_MCP, "'rea setup --client opencode' falhou", [f"exit code {result.returncode}"]
        )


# ---------------------------------------------------------------------------
# Etapa 9 — verificação final: rea doctor (preserva o diagnóstico)
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
    ui.step(9, "Verificação final (rea doctor)")
    cmd = [*rea_cmd, "doctor", "--client", "opencode", "--provider", "ghidra", "--format", "json"]

    if ui.dry_run:
        ui.dry(" ".join(cmd))
        ui.mark(9, "dry", "plano impresso")
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

    if data.get("environment_healthy"):
        ui.ok("rea doctor: ambiente OK (environment_healthy: true)")
        ui.mark(9, "ok", "environment_healthy: true")
        return

    reasons = ["environment_healthy: false"]
    for check in data.get("scope_checks", []):
        if check.get("ok", True):
            continue
        name = check.get("name", "?")
        cls = check.get("classification", "")
        detail = check.get("detail") or check.get("remediation") or ""
        reasons.append(f"{name} [{cls}]: {detail}")
    raise SetupFailure(
        1,
        "rea doctor: environment_healthy: false",
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
