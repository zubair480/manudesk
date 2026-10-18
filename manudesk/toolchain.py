"""Where the chip tools live and how to run them.

Set MANUDESK_TOOLS to the OSS CAD Suite `bin` directory (on the VM: /opt/fpga/oss-cad-suite/bin).
Scratch builds go under MANUDESK_WORK (default <system temp>/manudesk), one fresh directory per check; EDA
tools break on spaces in paths, so a root with a space is refused.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

_CANDIDATES = [
    "/opt/fpga/oss-cad-suite/bin",
    str(Path.home() / "fpga" / "oss-cad-suite" / "bin"),
    r"C:\fpga\oss-cad-suite\bin",
]


def tools_dir() -> Path:
    env = os.environ.get("MANUDESK_TOOLS")
    if env:
        return Path(env)
    for c in _CANDIDATES:
        if Path(c).is_dir():
            return Path(c)
    raise FileNotFoundError("OSS CAD Suite not found; set MANUDESK_TOOLS to its bin directory")


def tool_env() -> dict[str, str]:
    bin_dir = tools_dir()
    root = bin_dir.parent
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(bin_dir), str(root / "lib"), env.get("PATH", "")])
    env.setdefault("VERILATOR_ROOT", str(root / "share" / "verilator"))
    return env


def tool(name: str) -> str:
    exe = shutil.which(name, path=tool_env()["PATH"])
    if not exe:
        raise FileNotFoundError(f"{name} not found in {tools_dir()}")
    return exe


def work_root() -> Path:
    root = Path(os.environ.get("MANUDESK_WORK") or Path(tempfile.gettempdir()) / "manudesk")
    if " " in str(root):
        raise RuntimeError(f"work dir {root} contains a space; set MANUDESK_WORK to a path without spaces")
    root.mkdir(parents=True, exist_ok=True)
    return root


def new_workdir(prefix: str) -> Path:
    d = work_root() / f"{prefix}_{uuid.uuid4().hex[:10]}"
    d.mkdir(parents=True)
    return d


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run(argv: list[str], cwd: Path, timeout: float) -> tuple[int, str]:
    """Run a tool, return (exit code, stdout+stderr). Raises subprocess.TimeoutExpired."""
    p = subprocess.run(argv, cwd=cwd, env=tool_env(), capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout, creationflags=_NO_WINDOW)
    return p.returncode, p.stdout + p.stderr
