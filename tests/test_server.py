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


@pytest.mark.anyio
async def test_exactly_four_tools():
    assert sorted(t.name for t in await server.mcp.list_tools()) == ["check", "dsp_helper", "get_design",
                                                                     "list_designs"]


def test_instructions():
    assert server.INSTRUCTIONS.startswith("Hardware feedback for Verilog. Loop: get_design(name)")


def test_list_and_get_follow_the_spec():
    designs = json.loads(server.list_designs())
    assert {"popcount", "fir8", "crc32", "mac"} <= {d["name"] for d in designs}
    for d in designs:
        assert set(d) == {"name", "description", "top", "baseline_mhz", "latency_budget", "resource_budget"}
        assert {"TRELLIS_FF", "TRELLIS_COMB"} <= set(d["resource_budget"])
    d = json.loads(server.get_design("popcount"))
    assert set(d) == {"name", "description", "top", "baseline_mhz", "latency_budget", "resource_budget", "goal",
                      "verilog", "rules", "device"}
    assert "module popcount" in d["verilog"] and "x baseline" in d["goal"] and "ECP5-85F" in d["device"]
    assert d["latency_budget"] == 6 and d["resource_budget"] == {"TRELLIS_FF": 2000, "TRELLIS_COMB": 3000}
    assert any("LATENCY+1" in r for r in d["rules"]) and any("mul18x18_reg" in r for r in d["rules"])
    assert "error" in json.loads(server.get_design("nope"))


def test_testbench_never_leaks():
    out = server.list_designs() + server.get_design("popcount") + server.dsp_helper()
    assert "module tb" not in out and "MISMATCH" not in out and "$random" not in out


def test_dsp_helper_is_the_library():
    src = server.dsp_helper()
    assert "module mul18x18_reg" in src and "MULT18X18D" in src


@pytest.fixture
def anyio_backend():
    return "asyncio"
