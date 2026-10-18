"""Server tests: bearer auth and the tool surface, over the real ASGI app (no network)."""
from __future__ import annotations

import json

import httpx
import pytest

from manudesk import server

TOKEN = "t" * 32


@pytest.fixture
def app():
    return server.build_app(TOKEN)


async def _req(app, method, path, **kw):
    # auth is decided before the MCP app runs, so no session manager is needed here
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x") as c:
        return await c.request(method, path, **kw)


@pytest.mark.anyio
async def test_health_is_open(app):
    r = await _req(app, "GET", "/health")
    assert r.status_code == 200 and r.json()["ok"]


@pytest.mark.anyio
@pytest.mark.parametrize("auth", [None, "Bearer wrong", "Basic abc", f"bearer{TOKEN}"])
async def test_mcp_needs_token(app, auth):
    headers = {"authorization": auth} if auth else {}
    r = await _req(app, "POST", "/mcp", headers=headers, json={})
    assert r.status_code == 401


def test_short_token_refused():
    with pytest.raises(SystemExit):
        server.build_app("short")


def test_tools_are_compact():
    designs = json.loads(server.list_designs())
    assert len(designs) >= 6 and all({"name", "target_mhz", "lat_budget"} <= set(d) for d in designs)
    d = json.loads(server.get_design("mac"))
    assert "module mac" in d["verilog"] and "tb" not in d and "LATENCY" in d["rules"]
    assert "error" in json.loads(server.get_design("nope"))


@pytest.fixture
def anyio_backend():
    return "asyncio"
