"""X11 backend for manudesk.toolstream (ported from Crusoe-Forge tc/toolstream_x11.py).

Each tool gets its own Xvfb display (one window per screen, no window manager), so a frame is a grab of
that display's root window: dialogs and menus show up, nothing from other tools does. Capture uses
ImageMagick ``import``; mouse and keys go through ``xdotool`` (XTEST) on that display. The HWND stand-in is
``display_number << 32 | window_id`` (X window ids repeat across Xvfb servers), and ``DISPLAY_OF`` maps the
tool's pid to its display.

Needs: Xvfb, xdotool, ImageMagick (``import``), and Mesa for the GL canvases (nextpnr device view, KiCad GAL).
"""
from __future__ import annotations

import io
import os
import shutil
import signal
import subprocess
import threading
import time

WIN_W, WIN_H = 1600, 1000
X11_OK = all(shutil.which(x) for x in ("Xvfb", "xdotool", "import"))
FIRST_DISPLAY = int(os.environ.get("MANUDESK_TOOLSTREAM_DISPLAY", "100"))

DISPLAY_OF: dict[int, str] = {}   # tool pid -> ":N"
BBOX_OF: dict[str, tuple[int, int, int, int]] = {}   # ":N" -> area of the last frame (input maps into it)
XVFB_OF: dict[str, subprocess.Popen] = {}   # ":N" -> its Xvfb


def _x(display: str, *args: str, timeout: float = 5.0) -> subprocess.CompletedProcess:
    return subprocess.run(["xdotool", *args], env={**os.environ, "DISPLAY": display}, capture_output=True,
                          text=True, timeout=timeout)


def _dw(h) -> tuple[str | None, str]:
    """(":N", window id) from a handle made by windows_of."""
    h = int(h or 0)
    return (f":{h >> 32}" if h >> 32 else None), str(h & 0xFFFFFFFF)


_DISPLAY_LOCK = threading.Lock()


def _free_display() -> str:
    n = FIRST_DISPLAY
    while os.path.exists(f"/tmp/.X11-unix/X{n}") or os.path.exists(f"/tmp/.X{n}-lock") or f":{n}" in XVFB_OF:
        n += 1
    return f":{n}"


def _start_xvfb() -> str:
    """A new Xvfb on a display nobody else has. Tools start in parallel (the guide pre-opens all three), so
    picking and reserving the number is one locked step, and a server that exits (number taken after all)
    is retried on the next number instead of leaving two tools sharing one screen."""
    for _ in range(20):
        with _DISPLAY_LOCK:
            d = _free_display()
            xv = XVFB_OF[d] = subprocess.Popen(["Xvfb", d, "-screen", "0", f"{WIN_W}x{WIN_H}x24", "-nolisten", "tcp"],
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                               start_new_session=True)
        for _ in range(50):   # up in well under a second
            if xv.poll() is not None or os.path.exists(f"/tmp/.X11-unix/X{d[1:]}"):
                break
            time.sleep(0.1)
        time.sleep(0.2)
        if xv.poll() is None:
            return d
        XVFB_OF.pop(d, None)   # exited: that display was taken; try the next one
    raise RuntimeError("could not start Xvfb")


def launch_x11(argv: list, cwd=None, env: dict | None = None) -> dict:
    """Start a fresh Xvfb display, then the tool on it (own process group, so stop() takes its children)."""
    d = _start_xvfb()
    p = subprocess.Popen([str(a) for a in argv], cwd=cwd, env={**(env or os.environ), "DISPLAY": d},
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    DISPLAY_OF[p.pid] = d
    return {"pid": p.pid, "argv": [str(a) for a in argv], "display": d}


def stop_x11(pid: int) -> int:
    rc = 0
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        rc = 1
    d = DISPLAY_OF.pop(pid, None)
    xv = XVFB_OF.pop(d, None) if d else None
    if xv:
        xv.kill()
    BBOX_OF.pop(d, None)
    return rc


def process_tree(pid: int) -> set[int]:
    return {pid} if pid_alive(pid) else set()


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:   # a zombie (exited, not yet reaped) is not alive
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(") ", 1)[1][:1] != "Z"
    except OSError:
        return True


def is_window(h) -> bool:
    """Still there, and still the best pick: an untitled X window is dropped as soon as the app's titled main
    window exists (the session latches onto whatever was mapped first, e.g. before KiCad's frame appears)."""
    d, w = _dw(h)
    if not d or d not in XVFB_OF:
        return False
    r = _x(d, "getwindowname", w)
    if r.returncode != 0:
        return False
    if r.stdout.strip():
        return True
    return not _x(d, "search", "--onlyvisible", "--maxdepth", "1", "--name", ".").stdout.split()


def is_iconic(wid) -> bool:
    return False   # no window manager: nothing minimizes


def window_text(h) -> str:
    d, w = _dw(h)
    return _x(d, "getwindowname", w).stdout.strip() if d else ""


def rect(h) -> tuple[int, int, int, int]:
    d, w = _dw(h)
    g = dict(line.split("=", 1) for line in _x(d, "getwindowgeometry", "--shell", w).stdout.split() if "=" in line)
    x, y, w, h = (int(g.get(k, 0)) for k in ("X", "Y", "WIDTH", "HEIGHT"))
    return x, y, x + w, y + h


def windows_of(pids: set[int]) -> list[dict]:
    """Visible top-level windows on these processes' displays, largest first (one tool per display)."""
    out = []
    for d in {DISPLAY_OF[p] for p in pids if p in DISPLAY_OF}:
        ids = _x(d, "search", "--onlyvisible", "--maxdepth", "1", "--name", "").stdout.split()
        for wid in map(int, ids):
            h = (int(d[1:]) << 32) | wid
            l, t, r, b = rect(h)
            if r - l > 120 and b - t > 80:
                out.append({"hwnd": h, "pid": None, "title": window_text(h), "rect": (l, t, r, b),
                            "owned": False, "area": (r - l) * (b - t)})
    out.sort(key=lambda w: (not w["title"], -w["area"]))   # the app's titled main window before bare X windows
    return out


def place(hwnd, x: int = 0, y: int = 0, w: int = WIN_W, h: int = WIN_H, bottom: bool = False) -> None:
    """Fill the tool's own screen (its display is WIN_W x WIN_H), whatever slot the caller asked for."""
    d, wid = _dw(hwnd)
    if d:
        _x(d, "windowmove", wid, "0", "0")
        _x(d, "windowsize", wid, str(WIN_W), str(WIN_H))


def capture(h, canvas=None, screen: bool = False):
    """PIL RGB image of the tool's whole display (its window fills it; dialogs and menus included)."""
    from PIL import Image
    d, _ = _dw(h)
    if not d:
        raise RuntimeError("unknown window")
    p = subprocess.run(["import", "-display", d, "-window", "root", "-silent", "png:-"], capture_output=True,
                       timeout=10)
    if p.returncode or not p.stdout:
        raise RuntimeError(f"capture failed on {d}: {p.stderr[:200]!r}")
    img = Image.open(io.BytesIO(p.stdout)).convert("RGB")
    # Without a window manager the app may lay itself out smaller than its X window, and the rest of the
    # screen is Xvfb black: crop to what the app actually drew (menus and dialogs included).
    bb = img.convert("L").point(lambda v: 255 if v > 4 else 0).getbbox() or (0, 0, img.width, img.height)
    if (bb[2] - bb[0]) < 200 or (bb[3] - bb[1]) < 150:
        bb = (0, 0, img.width, img.height)
    BBOX_OF[d] = bb
    return img.crop(bb)


def focus_of(wid):
    return None


KEYSYM = {"Enter": "Return", "Backspace": "BackSpace", "Tab": "Tab", "Escape": "Escape", "Delete": "Delete",
          "Insert": "Insert", "Home": "Home", "End": "End", "PageUp": "Prior", "PageDown": "Next",
          "ArrowLeft": "Left", "ArrowUp": "Up", "ArrowRight": "Right", "ArrowDown": "Down", " ": "space",
          **{f"F{i}": f"F{i}" for i in range(1, 13)}}


def send_key(h, key: str = "", code: str = "", down: bool = True, text: str = "", fallback=None,
             ctrl: bool = False, shift: bool = False, alt: bool = False) -> dict:
    """Same contract as the win32 send_key: ``text`` types a string; a key acts on keydown (keyup ignored)."""
    d, wid = _dw(h)
    if not d:
        raise RuntimeError("unknown window")
    _x(d, "windowfocus", wid)
    if text:
        _x(d, "type", "--delay", "5", text)
        return {"target": int(h), "chars": len(text)}
    if not down or key in ("Shift", "Control", "Alt", "Meta"):
        return {"target": int(h), "ignored": key, "down": down}
    sym = KEYSYM.get(key) or (key if len(key) == 1 else (code[3:].lower() if code.startswith("Key") else None))
    if not sym:
        return {"target": int(h), "ignored": key}
    combo = "+".join([m for m, on in (("ctrl", ctrl), ("alt", alt), ("shift", shift and len(key) > 1)) if on] + [sym])
    _x(d, "key", combo)
    return {"target": int(h), "key": combo}


def send_input(h, fx: float, fy: float, kind: str = "click", delta: int = 0, button: str = "left",
               held: bool = False) -> dict:
    """Mouse event at a fraction (0..1) of the captured screen; same kinds as the win32 send_input."""
    d, _ = _dw(h)
    if not d:
        raise RuntimeError("unknown window")
    l, t, r, b = BBOX_OF.get(d, (0, 0, WIN_W, WIN_H))
    sx, sy = l + round(fx * (r - l)), t + round(fy * (b - t))
    b = "3" if (button == "right" or kind == "rightclick") else "1"
    move = ["mousemove", str(sx), str(sy)]
    if kind == "wheel":
        _x(d, *move, "click", "--repeat", str(max(1, abs(int(delta or -120)) // 120)), "4" if (delta or -120) > 0 else "5")
    elif kind == "down":
        _x(d, *move, "mousedown", b)
    elif kind == "move":
        _x(d, *move)
    elif kind == "up":
        _x(d, *move, "mouseup", b)
    elif kind == "dblclick":
        _x(d, *move, "click", "--repeat", "2", b)
    else:   # click / rightclick
        _x(d, *move, "click", b)
    return {"screen": [sx, sy], "client": [sx, sy], "target": int(h)}
