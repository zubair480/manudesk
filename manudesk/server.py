"""ManuDesk MCP server: streamable HTTP at /mcp behind a bearer token; GET /health is open.

    uv run python -m manudesk.server --host 0.0.0.0 --port 8765

Clients send `Authorization: Bearer $MANUDESK_TOKEN`. Tool results are compact JSON strings: agents are the
customer, so every byte is a token they pay for.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import threading
import time

import anyio
import uvicorn
from dotenv import load_dotenv
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

from manudesk import checker
from manudesk.designs import RULES, all_designs, get

INSTRUCTIONS = (
    "Hardware feedback loop for Verilog on a real FPGA flow (Lattice ECP5-85F, yosys + nextpnr). "
    "Workflow: list_designs -> get_design(name) -> edit -> check(name, verilog) -> read `fix` and `path` -> repeat. "
    "check runs a hidden testbench and real place and route; only `pass: true` means correct. "
    "`mhz` is the measured clock speed, `path` the slowest path (fix that one next), `use` the resources. "
    "Never claim a design works or is faster without a check result that says so."
)

_dumps = lambda o: json.dumps(o, separators=(",", ":"))  # noqa: E731

mcp = MCPServer("manudesk", instructions=INSTRUCTIONS, version="0.1.0")
_slots = anyio.CapacityLimiter(int(os.environ.get("MANUDESK_PARALLEL", max(1, (os.cpu_count() or 2) // 2))))
_stats = {"checks": 0, "passes": 0, "started": time.time()}
_stats_lock = threading.Lock()

_RO = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)


@mcp.tool(annotations=_RO, structured_output=False)
def list_designs() -> str:
    """Available designs and their limits: target/baseline MHz, latency budget (cycles), resource budget."""
    return _dumps([{"name": d.name, "what": d.summary, "target_mhz": d.target_mhz, "base_mhz": d.baseline_mhz,
                    "lat_budget": d.latency_budget, "res": d.resource_budget} for d in all_designs().values()])


@mcp.tool(annotations=_RO, structured_output=False)
def get_design(name: str) -> str:
    """Starting Verilog for a design plus the rules check() enforces."""
    try:
        d = get(name)
    except KeyError as e:
        return _dumps({"error": str(e.args[0])})
    return _dumps({"name": d.name, "top": d.top, "what": d.summary, "limits": d.limits(), "rules": RULES,
                   "verilog": d.start})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False),
          structured_output=False)
async def check(name: str, verilog: str) -> str:
    """Run the hidden testbench plus real synthesis, place and route on your full Verilog file. Returns
    {pass, stage, fix[], mhz, target, base, x (speedup vs baseline), lat, path (slowest path, with source
    lines Lnn), use {LUT, FF, DSP}}. Takes ~10-60 s."""
    try:
        get(name)
    except KeyError as e:
        return _dumps({"error": str(e.args[0])})
    async with _slots:
        out = await anyio.to_thread.run_sync(checker.check, name, verilog)
    with _stats_lock:
        _stats["checks"] += 1
        _stats["passes"] += bool(out.get("pass"))
    return _dumps(out)


def health_body() -> bytes:
    with _stats_lock:
        s = dict(_stats)
    return _dumps({"ok": True, "designs": len(all_designs()), "checks": s["checks"], "passes": s["passes"],
                   "uptime_s": int(time.time() - s["started"])}).encode()


class BearerAuth:
    """Pure ASGI wrapper (keeps SSE streaming intact): /health is open, everything else needs the token."""

    def __init__(self, app, token: str):
        self.app, self.token = app, token.encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == "/health":
            return await self._send(send, 200, health_body())
        auth = dict(scope.get("headers") or []).get(b"authorization", b"")
        if not (auth.startswith(b"Bearer ") and hmac.compare_digest(auth[7:].strip(), self.token)):
            return await self._send(send, 401, b'{"error":"missing or bad bearer token"}',
                                    [(b"www-authenticate", b'Bearer realm="manudesk"')])
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
    ap.add_argument("--host", default=os.environ.get("MANUDESK_HOST_BIND", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("MANUDESK_PORT", "8765")))
    a = ap.parse_args()
    uvicorn.run(build_app(os.environ.get("MANUDESK_TOKEN", "")), host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
