"""Live video + remote control of the real tools (nextpnr-ecp5 --gui, GTKWave, KiCad pcbnew), ported from Crusoe-Forge
tc/toolstream.py (its Linux/X11 path). Each tool runs on its own Xvfb screen on this machine; the page polls
JPEG frames and posts mouse and keys back (manudesk/toolstream_x11.py does the X11 work).

Unlike Crusoe-Forge there are no run folders here: a tool is opened on a (design, Verilog) pair, and this module
rebuilds the files it needs on demand with the same flow `check` uses, so it works after a restart too.

POST /api/tool/start        {"tool": "nextpnr"|"gtkwave", "design": name, "verilog": src} -> {sid, ...}
                            {"tool": "kicad", "board"?: {lpf, board_w, board_h, placements}} -> {sid, ...}
                            (KiCad opens the add-on board manudesk.pcb routes and DRC-checks; no board = template)
GET  /api/tool/{sid}/frame.jpg
POST /api/tool/{sid}/input  click | dblclick | rightclick | down | move | up | wheel | key | text
POST /api/tool/{sid}/stop
GET  /api/tool/status

All behind the server's bearer token (the dashboard fetches frames with it). CORS is open so the InsForge-hosted
dashboard can call these from the browser.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import anyio

from manudesk import eda
from manudesk.checker import _files, _ports_for, harness
from manudesk.designs import get
from manudesk.toolchain import tool, tool_env, work_root
from manudesk.toolstream_x11 import (X11_OK, capture, is_window, launch_x11, pid_alive, place, process_tree,
                                     send_input, send_key, stop_x11, window_text, windows_of)

TOOLS = ("nextpnr", "gtkwave", "kicad")
JPEG_Q = 70
MAX_W = 1280
IDLE_S = 600
FIND_TIMEOUT_S = 40
READY_TIMEOUT_S = 90
MAX_PER_TOOL = 2   # one tool window costs about a CPU; the least recently watched one is stopped beyond that
# The GL canvas of nextpnr as a fraction of the window (l, t, r, b): start waits until it has painted.
CANVAS = {"nextpnr": (0.03, 0.18, 0.69, 0.64), "kicad": (0.28, 0.16, 0.80, 0.86)}

# ---------------------------------------------------------------- frames


def region_flat(img, frac) -> bool:
    """A single colour (blank KiCad canvas that has not painted the board yet)."""
    w, h = img.size
    lo, hi = img.crop((int(w * frac[0]), int(h * frac[1]), int(w * frac[2]), int(h * frac[3]))).convert("L").getextrema()
    return hi - lo < 12


def region_black(img, frac) -> bool:
    w, h = img.size
    ex = img.crop((int(w * frac[0]), int(h * frac[1]), int(w * frac[2]), int(h * frac[3]))).convert("L").getextrema()
    return ex[1] < 8


def to_jpeg(img, max_w: int = MAX_W, quality: int = JPEG_Q) -> bytes:
    if img.width > max_w:
        img = img.resize((max_w, round(img.height * max_w / img.width)))
    b = io.BytesIO()
    img.convert("RGB").save(b, "JPEG", quality=quality)
    return b.getvalue()


def placeholder(text: str) -> bytes:
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (MAX_W, 800), (24, 26, 30))
    ImageDraw.Draw(img).text((40, 380), text, fill=(200, 205, 215))
    return to_jpeg(img)


# ---------------------------------------------------------------- tool files

_DUMP_V = """`timescale 1ns/1ps
module manudesk_dump;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, tb.dut);
    #{limit_ns} $dumpoff;
  end
endmodule
"""


def _views_dir(sid: str) -> Path:
    d = work_root() / "views" / sid
    d.mkdir(parents=True, exist_ok=True)
    return d


def prepare_nextpnr(design: str, verilog: str, wd: Path) -> list[str]:
    """Synthesize inside the port-registering harness and place and route, writing routed.json (the same
    netlist `check` times), then return the nextpnr GUI command that opens it placed and routed."""
    d = get(design)
    routed = wd / "routed.json"
    if not routed.exists():
        ports = _ports_for(d)
        files = _files(wd, verilog)
        (wd / "harness.v").write_text(harness(d.top, ports), encoding="utf-8")
        syn = eda.synthesize([*files, wd / "harness.v"], "manudesk_harness", wd)
        if not syn.ok:
            raise ValueError("synthesis failed: " + "; ".join(syn.errors[:2]))
        pnr = eda.place_and_route(syn.json_path, d.target_mhz, wd, write_routed=True)
        if not pnr.ok or not routed.exists():
            raise ValueError("place and route failed: " + "; ".join(pnr.errors[:2]))
    return [tool("nextpnr-ecp5"), *eda.DEVICE, "--json", str(routed), "--gui"]


def prepare_gtkwave(design: str, verilog: str, wd: Path, limit_ns: int = 100_000) -> list[str]:
    """Re-run the hidden testbench with a VCD dump of the design under test only (tb.dut: its ports and its
    own registers, not the testbench's reference model), plus a .gtkw that opens with the ports shown."""
    d = get(design)
    vcd = wd / "wave.vcd"
    if not vcd.exists():
        files = _files(wd, verilog)
        shutil.copyfile(d.tb, wd / "tb.v")
        (wd / "manudesk_dump.v").write_text(_DUMP_V.format(limit_ns=limit_ns), encoding="utf-8")
        rc, out = eda.run([tool("iverilog"), "-g2012", "-o", "wave.vvp", "-s", "tb", "-s", "manudesk_dump", "tb.v",
                           *[f.name for f in files], "manudesk_dump.v"], wd, 120)
        if rc != 0:
            raise ValueError("does not compile: " + eda._hide_tb(out.strip().splitlines()[-1] if out.strip() else ""))
        eda.run([tool("vvp"), "-n", "wave.vvp"], wd, 120)
        (wd / "tb.v").unlink(missing_ok=True)   # the hidden testbench never stays next to the tool's files
        if not vcd.exists():
            raise ValueError("simulation wrote no waveform")
    lines = [f'[dumpfile] "{vcd}"', "[timestart] 0"]
    for name, (_, width) in _ports_for(d).items():
        lines += ["@28", f"tb.dut.{name}"] if width == 1 else ["@22", f"tb.dut.{name}[{width - 1}:0]"]
    gtkw = wd / "wave.gtkw"
    gtkw.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return [tool("gtkwave"), str(vcd), str(gtkw)]


def prepare_kicad(design: str, board_json: str, wd: Path) -> list[str]:
    """Place, Freerouting-route and DRC the add-on board with manudesk.pcb (the same flow as pcb_check), then open
    the routed board in the real KiCad pcbnew. `board_json` is "" (the hand template) or JSON {lpf, board_w,
    board_h, placements} for an agent placement."""
    from manudesk import pcb
    routed = wd / "board_routed.kicad_pcb"
    if not routed.exists():
        b = json.loads(board_json) if board_json.strip() else {}
        res, out = pcb.check(b.get("lpf") or None, b.get("board_w") or None, b.get("board_h") or None,
                             b.get("placements"), fab=False, keep=True)  # keep: else check() deletes its work dir
        src = Path(out) / "board_routed.kicad_pcb"
        if not src.exists():
            raise ValueError(f"board did not route: {getattr(res, 'error', None) or getattr(res, 'stage', '')}")
        for f in Path(out).iterdir():   # board + project + DRC report, next to each other like KiCad expects
            if f.is_file():
                shutil.copyfile(f, wd / f.name)
    pcbnew = shutil.which("pcbnew", path=os.environ.get("KICAD_BIN", "/usr/bin")) or "pcbnew"
    return [pcbnew, str(routed)]


PREPARE = {"nextpnr": prepare_nextpnr, "gtkwave": prepare_gtkwave, "kicad": prepare_kicad}


def session_id(tool_name: str, design: str, verilog: str) -> str:
    return hashlib.sha256(f"{tool_name}\0{design}\0{verilog}".encode()).hexdigest()[:20]


# ---------------------------------------------------------------- sessions


@dataclass
class Session:
    sid: str
    tool: str
    design: str
    pid: int = 0
    started: float = field(default_factory=time.time)
    last: float = field(default_factory=time.time)
    hwnd: int | None = None
    title: str = ""
    checked: float = 0.0
    frames: int = 0
    ready: bool = False
    dragging: bool = False
    error: str = ""

    def info(self) -> dict:
        return {"sid": self.sid, "tool": self.tool, "design": self.design, "alive": bool(self.pid) and pid_alive(self.pid),
                "ready": self.ready, "error": self.error, "title": self.title, "frames": self.frames,
                "age_s": round(time.time() - self.started, 1), "idle_s": round(time.time() - self.last, 1)}


class Manager:
    """One instance per (tool, design, Verilog); a live instance is always reused, never relaunched."""

    def __init__(self):
        self.sessions: dict[str, Session] = {}
        self.lock = threading.RLock()
        self._reaper: threading.Thread | None = None

    def start(self, tool_name: str, design: str, verilog: str) -> dict:
        if tool_name not in TOOLS:
            raise ValueError(f"tool must be one of {list(TOOLS)}")
        if tool_name != "kicad":
            get(design)   # KeyError for an unknown design
        sid = session_id(tool_name, design, verilog)
        with self.lock:
            s = self.sessions.get(sid)
            if s and (not s.pid or pid_alive(s.pid)) and not s.error:
                s.last = time.time()
                return {**s.info(), "reused": True}
            same = sorted((x for x in self.sessions.values() if x.tool == tool_name and x.sid != sid), key=lambda x: x.last)
            for old in same[:max(0, len(same) - MAX_PER_TOOL + 1)]:
                self.stop(old.sid)
            s = self.sessions[sid] = Session(sid, tool_name, design)
        self._ensure_reaper()
        threading.Thread(target=self._launch, args=(s, verilog), daemon=True, name=f"toolstream-{sid}").start()
        return {**s.info(), "reused": False}

    def _launch(self, s: Session, verilog: str) -> None:
        """Build the tool's files, open it on its own Xvfb screen, then wait until the design is drawn."""
        try:
            argv = PREPARE[s.tool](s.design, verilog, _views_dir(s.sid))
            r = launch_x11(argv, _views_dir(s.sid), tool_env())
            s.pid = int(r["pid"])
            if self.find_window(s, timeout=FIND_TIMEOUT_S):
                self.wait_ready(s)
            if not s.hwnd:
                s.error = f"{s.tool} opened no window"
        except Exception as e:   # shown on the placeholder frame and in /status
            s.error = str(e)[:300]

    def wait_ready(self, s: Session, timeout: float = READY_TIMEOUT_S) -> bool:
        """nextpnr's GL device pane stays black until the routed json is drawn; GTKWave is ready at once."""
        end, canvas = time.time() + timeout, CANVAS.get(s.tool)
        while time.time() < end and pid_alive(s.pid):
            self.find_window(s)
            if s.hwnd:
                if s.tool == "kicad":   # title gains the board name, then the canvas paints; Home = zoom to fit
                    loaded = "—" in s.title or "board" in s.title.lower()
                    if loaded and not region_flat(capture(s.hwnd), canvas):
                        time.sleep(1.0)
                        send_key(s.hwnd, key="Home")
                        s.ready = True
                        break
                elif not canvas or not region_black(capture(s.hwnd), canvas):
                    s.ready = True
                    break
            time.sleep(0.7)
        if not s.ready and s.hwnd:
            s.ready = True   # show what is there rather than a placeholder forever
        return s.ready

    def find_window(self, s: Session, timeout: float = 0.0) -> int | None:
        end = time.time() + timeout
        while True:
            if s.hwnd and is_window(s.hwnd):
                s.checked, s.title = time.time(), window_text(s.hwnd)
                return s.hwnd
            ws = windows_of(process_tree(s.pid))
            if ws:
                w = ws[0]
                if w["hwnd"] != s.hwnd:
                    place(w["hwnd"])
                s.hwnd, s.title, s.checked = w["hwnd"], w["title"], time.time()
                return s.hwnd
            if time.time() >= end or not pid_alive(s.pid):
                return None
            time.sleep(0.4)

    def get(self, sid: str) -> Session:
        s = self.sessions.get(sid)
        if not s:
            raise KeyError(f"no live tool {sid}; POST /api/tool/start first")
        return s

    def frame(self, sid: str) -> bytes:
        s = self.get(sid)
        s.last = time.time()
        if s.error:
            return placeholder(f"{s.tool} could not open: {s.error}")
        if s.hwnd and (not is_window(s.hwnd) or time.time() - s.checked > 2):
            self.find_window(s)   # a dialog or a new main window may have appeared
        if not s.hwnd or not s.ready:
            what = "building the routed design" if s.tool == "nextpnr" and not s.pid else "starting"
            return placeholder(f"Opening the real {s.tool} on {s.design}: {what}...  {time.time() - s.started:.0f} s")
        s.frames += 1
        return to_jpeg(capture(s.hwnd))

    def input(self, sid: str, kind: str, x: float = 0, y: float = 0, delta: int = 0, button="left", held: bool = False,
              key: str = "", code: str = "", down: bool = True, text: str = "", ctrl: bool = False,
              shift: bool = False, alt: bool = False) -> dict:
        s = self.get(sid)
        s.last = time.time()
        if not s.hwnd:
            raise RuntimeError("no window yet")
        if kind in ("key", "text"):
            return send_key(s.hwnd, key, code, down, text, ctrl=ctrl, shift=shift, alt=alt)
        button = {0: "left", 2: "right", "0": "left", "2": "right"}.get(button, button)
        kind = {"rclick": "rightclick", "contextmenu": "rightclick"}.get(kind, kind)
        if kind == "move" and s.dragging:
            held = True
        r = send_input(s.hwnd, x, y, kind, delta, button, held)
        if kind == "down":
            s.dragging = True
        elif kind in ("up", "click", "dblclick", "rightclick"):
            s.dragging = False
        return r

    def stop(self, sid: str) -> dict:
        with self.lock:
            s = self.sessions.pop(sid, None)
        if not s:
            return {"sid": sid, "stopped": False}
        rc = stop_x11(s.pid) if s.pid else 0
        shutil.rmtree(work_root() / "views" / sid, ignore_errors=True)
        return {"sid": sid, "tool": s.tool, "stopped": True, "rc": rc}

    def reap(self) -> None:
        now = time.time()
        for s in list(self.sessions.values()):
            if now - s.last > IDLE_S or (s.pid and not pid_alive(s.pid)):
                self.stop(s.sid)

    def _ensure_reaper(self) -> None:
        if self._reaper and self._reaper.is_alive():
            return

        def loop():
            while self.sessions:
                time.sleep(15)
                self.reap()

        self._reaper = threading.Thread(target=loop, daemon=True, name="toolstream-reaper")
        self._reaper.start()


MANAGER = Manager()

# ---------------------------------------------------------------- ASGI handlers (mounted by manudesk.server)

CORS = [(b"access-control-allow-origin", b"*"), (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
        (b"access-control-allow-headers", b"authorization, content-type"), (b"access-control-max-age", b"600")]
_dumps = lambda o: json.dumps(o, separators=(",", ":"))  # noqa: E731
INPUT_KEYS = ("type", "x", "y", "delta", "button", "held", "key", "code", "down", "text", "ctrl", "shift", "alt")


async def _send(send, status: int, body: bytes, ctype: bytes = b"application/json"):
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", ctype), (b"cache-control", b"no-store"), *CORS]})
    await send({"type": "http.response.body", "body": body})


async def _json_body(receive) -> dict:
    body = b""
    while True:
        msg = await receive()
        if msg["type"] == "http.disconnect":
            return {}
        body += msg.get("body", b"")
        if len(body) > 1_000_000:
            raise ValueError("body too large")
        if not msg.get("more_body"):
            break
    return json.loads(body or b"{}")


async def preflight(scope, receive, send):
    await _send(send, 204, b"")


async def handle(scope, receive, send):
    """Everything under /api/tool (the bearer token was already checked by the server)."""
    if not X11_OK:
        return await _send(send, 501, b'{"error":"tool streaming needs Xvfb, xdotool and ImageMagick"}')
    parts = scope["path"].strip("/").split("/")[2:]   # after "api/tool"
    method = scope["method"]
    try:
        if parts == ["status"] and method == "GET":
            return await _send(send, 200, _dumps({"tools": list(TOOLS), "x11": X11_OK,
                                                  "sessions": [s.info() for s in MANAGER.sessions.values()]}).encode())
        if parts == ["start"] and method == "POST":
            b = await _json_body(receive)
            if b.get("tool") == "kicad":   # the board, not a design: template or {lpf, board_w, board_h, placements}
                b = {"tool": "kicad", "design": "board", "verilog": json.dumps(b["board"]) if b.get("board") else ""}
            if not (isinstance(b.get("design"), str) and isinstance(b.get("verilog"), str)):
                return await _send(send, 400, b'{"error":"body must be JSON {tool, design, verilog}"}')
            out = await anyio.to_thread.run_sync(MANAGER.start, str(b.get("tool", "")), b["design"], b["verilog"])
            return await _send(send, 200, _dumps(out).encode())
        if len(parts) == 2:
            sid, act = parts
            if act == "frame.jpg" and method == "GET":
                jpg = await anyio.to_thread.run_sync(MANAGER.frame, sid)
                return await _send(send, 200, jpg, b"image/jpeg")
            if act == "input" and method == "POST":
                b = await _json_body(receive)
                args = {k: b[k] for k in INPUT_KEYS if k in b}
                kind = args.pop("type", "click")
                out = await anyio.to_thread.run_sync(lambda: MANAGER.input(sid, kind, **args))
                return await _send(send, 200, _dumps(out).encode())
            if act == "stop" and method == "POST":
                return await _send(send, 200, _dumps(MANAGER.stop(sid)).encode())
        return await _send(send, 404, b'{"error":"unknown tool endpoint"}')
    except KeyError as e:
        return await _send(send, 404, _dumps({"error": str(e.args[0]) if e.args else "not found"}).encode())
    except (ValueError, TypeError) as e:
        return await _send(send, 400, _dumps({"error": str(e)}).encode())
    except RuntimeError as e:
        return await _send(send, 503, _dumps({"error": str(e)}).encode())
