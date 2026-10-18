"""ManuDesk MCP server: four tools (list_designs, get_design, dsp_helper, check) over stdio or streamable HTTP.

    uv run manudesk                                       # stdio (a local agent launches this)
    uv run manudesk --transport http --host 0.0.0.0 --port 8765

Over HTTP, /mcp sits behind a bearer token and GET /health is open; clients send
`Authorization: Bearer $MANUDESK_TOKEN`. Tool results are compact JSON strings: agents are the
customer, so every byte is a token they pay for. POST /api/check (same token) is the plain-JSON twin of the MCP
`check` tool for edge functions; every check is logged to InsForge by `store` (fire and forget).
/api/tool/* (same token) streams the real nextpnr GUI and GTKWave live (`toolstream`).
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import threading
import time
import uuid

import anyio
import uvicorn
from dotenv import load_dotenv
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

from manudesk import checker, pcb, store, toolstream
from manudesk.designs import DEVICE, LIB, RULES, all_designs, get

INSTRUCTIONS = (
    "Hardware feedback for Verilog. Loop: get_design(name) -> edit -> check(name, verilog) -> read `reasons` and "
    "`critical_path` -> edit again. Only accepted:true results count. Each check takes about 5-15 s. "
    "PCB: pcb_parts(lpf) -> place -> pcb_check(lpf, board_w, board_h, placements) -> fix the DRC violations -> "
    "again; passed:true = routed with 0 DRC errors and 0 unconnected items (about 15-60 s per routed check)."
)

_dumps = lambda o: json.dumps(o, separators=(",", ":"))  # noqa: E731

mcp = MCPServer("manudesk", instructions=INSTRUCTIONS, version="0.1.0")
_slots = anyio.CapacityLimiter(int(os.environ.get("MANUDESK_PARALLEL", max(1, (os.cpu_count() or 2) // 2))))
_stats = {"checks": 0, "passes": 0, "started": time.time()}
_stats_lock = threading.Lock()

_RO = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)


@mcp.tool(annotations=_RO, structured_output=False)
def list_designs() -> str:
    """Every design: name, what it computes, top module, baseline_mhz, latency_budget, resource_budget."""
    return _dumps([{"name": d.name, "description": d.summary, "top": d.top, "baseline_mhz": d.baseline_mhz,
                    "latency_budget": d.latency_budget, "resource_budget": d.budgets}
                   for d in all_designs().values()])


@mcp.tool(annotations=_RO, structured_output=False)
def get_design(name: str) -> str:
    """One design: the naive starting Verilog, its budgets, the goal and the rules check() enforces."""
    try:
        d = get(name)
    except KeyError as e:
        return _dumps({"error": str(e.args[0])})
    return _dumps({"name": d.name, "description": d.summary, "top": d.top, "baseline_mhz": d.baseline_mhz,
                   "latency_budget": d.latency_budget, "resource_budget": d.budgets, "goal": d.goal,
                   "verilog": d.start, "rules": list(RULES), "device": DEVICE})


@mcp.tool(annotations=_RO, structured_output=False)
def dsp_helper() -> str:
    """Verilog source of mul18x18_reg: a fully registered 18x18 multiply (latency 2) that maps to one MULT18X18D.
    Instantiate it in your design; check() provides it, so don't paste or redefine it."""
    return LIB.read_text(encoding="utf-8")


@mcp.tool(annotations=_RO, structured_output=False)
async def check(name: str, verilog: str) -> str:
    """Run your full Verilog file through lint, the interface check, the hidden testbench, the LATENCY+1 check,
    yosys synth_ecp5, nextpnr-ecp5 (every port registered) and the resource budget, stopping at the first
    failure. Returns {accepted, stage_reached, reasons[{what, fix}], fmax_mhz, baseline_mhz, vs_baseline,
    latency, critical_path, resources, budgets, seconds}."""
    r, _ = await run_check(name, verilog, "mcp")
    return _dumps(r if "error" in r else checker.report(r, get(name)))


@mcp.tool(annotations=_RO, structured_output=False)
def pcb_parts(lpf: str = "") -> str:
    """The HDMI/LED/button add-on PCB that plugs into the ULX3S J1 header, built from your design's LPF (empty =
    the bundled example LPF). Returns the placement rules, every part with its courtyard (w, h and centre offset
    dx, dy from the origin at rotation 0) and neighbours, the nets, the J1 pin map, and a hand-template
    placement that routes DRC-clean on 70 x 56 mm. Place it smaller or better, then call pcb_check."""
    try:
        return _dumps(pcb.parts(lpf or None))
    except Exception as e:  # noqa: BLE001 - bad LPF or missing KiCad: tell the agent, don't crash
        return _dumps({"error": f"{type(e).__name__}: {e}"[:400], "tools": pcb.pipeline.available()})


async def run_pcb(lpf: str, board_w: float, board_h: float, placements: list[dict] | None, fab: bool) -> dict:
    """Shared by the MCP tool and /api/pcb: same limiter as check(), fab outputs uploaded to md-artifacts."""
    async with _slots:
        res, out = await anyio.to_thread.run_sync(
            lambda: pcb.check(lpf or None, board_w or None, board_h or None, placements, fab=fab))
    r = {k: v for k, v in res.__dict__.items() if v not in (None, [], {}) or k in ("passed", "stage")}
    if res.files:
        pid = uuid.uuid4().hex[:12]
        key = store.upload_files(f"pcb/{pid}", {v: str(out / v) for v in res.files.values()})
        r["artifact_key"] = key
        r["files"] = sorted(res.files.values())
    return r


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False), structured_output=False)
async def pcb_check(lpf: str = "", board_w: float = 0, board_h: float = 0, placements: list[dict] | None = None,
                    fab: bool = False) -> str:
    """Place, autoroute (Freerouting) and DRC (KiCad 10) the add-on board. placements: [{ref, x, y, rot}] in
    board-relative mm (parts you leave out keep the template spot); board_w/board_h in mm (0 = template 70 x 56).
    A geometry pre-check rejects overlaps/off-board parts in ms; a legal placement is routed (about 15-60 s).
    Returns {passed, stage, drc_errors, unconnected, route_score, unrouted, tracks, vias, violations[{type,
    description, items[{description, pos_mm}]}], legalizer_moves, placements, timings}. passed = 0 DRC errors and
    0 unconnected items. fab=true on a passing board also exports Gerbers, drill, BOM, positions and renders."""
    return _dumps(await run_pcb(lpf, board_w, board_h, placements, fab))


async def run_check(name: str, verilog: str, source: str, run_id: str | None = None) -> tuple[dict, str | None]:
    """Shared by the MCP tool and /api/check: limiter, stats, then queue the log (never blocks the reply).
    Returns the checker's internal result (or {"error"}) and the md_checks row id."""
    try:
        d = get(name)
    except KeyError as e:
        return {"error": str(e.args[0])}, None
    async with _slots:
        t0 = time.perf_counter()
        r = await anyio.to_thread.run_sync(checker.cached, name, verilog)
        ms = int((time.perf_counter() - t0) * 1000)
    with _stats_lock:
        _stats["checks"] += 1
        _stats["passes"] += bool(r.get("accepted"))
    return r, store.log_check(name, verilog, checker.compact(r, d), source, run_id=run_id, duration_ms=ms)


MAX_BODY = 1_000_000
API_SOURCES = ("agent", "baseline")  # `mcp` is reserved for the MCP tool


async def _read_body(receive) -> bytes | None:
    body = b""
    while True:
        msg = await receive()
        if msg["type"] == "http.disconnect":
            return None
        body += msg.get("body", b"")
        if len(body) > MAX_BODY:
            return None
        if not msg.get("more_body"):
            return body


async def api_check(scope, receive, send):
    """POST /api/check {"name","verilog","run_id"?,"source"?} -> the check dict plus `check_id` (the md_checks
    row id, null when logging is off). Logged with source `agent`, or `baseline` when the body says so."""
    if scope["method"] != "POST":
        return await BearerAuth._send(send, 405, b'{"error":"POST only"}', [(b"allow", b"POST")])
    raw = await _read_body(receive)
    try:
        req = json.loads(raw) if raw is not None else None
        name, verilog, run_id, source = req["name"], req["verilog"], req.get("run_id"), req.get("source", "agent")
        if not (isinstance(name, str) and isinstance(verilog, str) and source in API_SOURCES):
            raise TypeError
        if run_id is not None:
            run_id = str(uuid.UUID(str(run_id)))
    except (ValueError, TypeError, KeyError, AttributeError):
        return await BearerAuth._send(send, 400, b'{"error":"body must be JSON {name, verilog, run_id?, source?}"}')
    r, check_id = await run_check(name, verilog, source, run_id)
    status = 404 if "error" in r else 200
    out = r if status == 404 else {**checker.compact(r, get(name)), "check_id": check_id}
    return await BearerAuth._send(send, status, _dumps(out).encode())


async def api_pcb(scope, receive, send):
    """POST /api/pcb {"lpf"?, "board_w"?, "board_h"?, "placements"?, "fab"?} -> the pcb_check dict."""
    if scope["method"] != "POST":
        return await BearerAuth._send(send, 405, b'{"error":"POST only"}', [(b"allow", b"POST")])
    raw = await _read_body(receive)
    try:
        req = json.loads(raw) if raw else {}
        lpf, fab = req.get("lpf") or "", bool(req.get("fab"))
        bw, bh = float(req.get("board_w") or 0), float(req.get("board_h") or 0)
        placements = req.get("placements")
        if not isinstance(lpf, str) or (placements is not None and not isinstance(placements, list)):
            raise TypeError
    except (ValueError, TypeError, AttributeError):
        return await BearerAuth._send(send, 400, b'{"error":"body must be JSON {lpf?, board_w?, board_h?, placements?, fab?}"}')
    return await BearerAuth._send(send, 200, _dumps(await run_pcb(lpf, bw, bh, placements, fab)).encode())


def health_body() -> bytes:
    with _stats_lock:
        s = dict(_stats)
    return _dumps({"ok": True, "designs": len(all_designs()), "checks": s["checks"], "passes": s["passes"],
                   "uptime_s": int(time.time() - s["started"]), "pcb_tools": pcb.pipeline.available()}).encode()


class BearerAuth:
    """Pure ASGI wrapper (keeps SSE streaming intact): /health is open, everything else needs the token;
    /api/check is answered here, the rest goes to the MCP app."""

    def __init__(self, app, token: str):
        self.app, self.token = app, token.encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == "/health":
            return await self._send(send, 200, health_body())
        tools = scope["path"].startswith("/api/tool/")
        if tools and scope["method"] == "OPTIONS":   # CORS preflight carries no token
            return await toolstream.preflight(scope, receive, send)
        auth = dict(scope.get("headers") or []).get(b"authorization", b"")
        if not (auth.startswith(b"Bearer ") and hmac.compare_digest(auth[7:].strip(), self.token)):
            return await self._send(send, 401, b'{"error":"missing or bad bearer token"}',
                                    [(b"www-authenticate", b'Bearer realm="manudesk"'), *(toolstream.CORS if tools else ())])
        if scope["path"] == "/api/check":
            return await api_check(scope, receive, send)
        if scope["path"] == "/api/pcb":
            return await api_pcb(scope, receive, send)
        if tools:
            return await toolstream.handle(scope, receive, send)
        return await self.app(scope, receive, send)

    @staticmethod
    async def _send(send, status, body, extra=()):
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), *extra]})
        await send({"type": "http.response.body", "body": body})


def build_app(token: str):
    if len(token) < 16:
        raise SystemExit("MANUDESK_TOKEN must be set (16+ chars); see .env.example")
    app = mcp.streamable_http_app(
        stateless_http=True, json_response=True, host="0.0.0.0",
        # The bearer token is the access control; Host/Origin checks would block remote clients.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    return BearerAuth(app, token)


def main() -> None:
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--transport", choices=("stdio", "http"), default=os.environ.get("MANUDESK_TRANSPORT", "stdio"))
    ap.add_argument("--host", default=os.environ.get("MANUDESK_HOST_BIND", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MANUDESK_PORT", "8765")))
    a = ap.parse_args()
    if a.transport == "stdio":
        mcp.run("stdio")   # stdout is the protocol channel; nothing else may print to it
        return
    uvicorn.run(build_app(os.environ.get("MANUDESK_TOKEN", "")), host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
