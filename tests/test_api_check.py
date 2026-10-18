"""POST /api/check: bearer auth, body validation, and the shared check path (checker and store mocked)."""
from __future__ import annotations

import json

import httpx
import pytest

from manudesk import checker, server
from manudesk.designs import get

TOKEN = "t" * 32
# the checker's internal result for an accepted check
OK = {"accepted": True, "stage_reached": "done", "reasons": [], "fmax_mhz": 200.0, "latency": 2,
      "critical_path": "critical path dut.a_r[0] -> dut.acc_r[3]: 5.00 ns", "seconds": 4.2, "_path": "a_r->acc_r 5.00ns",
      "resources": {"TRELLIS_FF": 20, "TRELLIS_COMB": 10, "MULT18X18D": 1, "TRELLIS_IO": 100, "DCCA": 1}}


@pytest.fixture
def app(monkeypatch):
    logged = []
    monkeypatch.setattr(server.checker, "cached", lambda name, v: dict(OK))
    monkeypatch.setattr(server.store, "log_check",
                        lambda *a, **kw: logged.append((a, kw)) or "22222222-2222-2222-2222-222222222222")
    a = server.build_app(TOKEN)
    a.logged = logged
    return a


async def _req(app, method, path, **kw):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x") as c:
        return await c.request(method, path, **kw)


AUTH = {"authorization": f"Bearer {TOKEN}"}


@pytest.mark.anyio
@pytest.mark.parametrize("auth", [None, "Bearer wrong", "Basic abc", f"bearer{TOKEN}"])
async def test_needs_token(app, auth):
    headers = {"authorization": auth} if auth else {}
    r = await _req(app, "POST", "/api/check", headers=headers, json={"name": "mac", "verilog": "x"})
    assert r.status_code == 401 and not app.logged


@pytest.mark.anyio
async def test_check_ok_logs_agent(app):
    rid = "33333333-3333-3333-3333-333333333333"
    r = await _req(app, "POST", "/api/check", headers=AUTH, json={"name": "mac", "verilog": "v", "run_id": rid})
    assert r.status_code == 200
    j = r.json()
    assert j["pass"] and j["mhz"] == 200.0 and j["check_id"] == "22222222-2222-2222-2222-222222222222"
    assert j["use"] == {"LUT": 10, "FF": 20, "DSP": 1}
    (args, kw), = app.logged
    assert args[:4] == ("mac", "v", checker.compact(OK, get("mac")), "agent")
    assert kw["run_id"] == rid and kw["duration_ms"] >= 0


@pytest.mark.anyio
@pytest.mark.parametrize("body", [b"not json", b"[]", b'{"name":"mac"}', b'{"name":1,"verilog":"v"}',
                                  b'{"name":"mac","verilog":"v","run_id":"nope"}',
                                  b'{"name":"mac","verilog":"v","source":"mcp"}'])
async def test_bad_body(app, body):
    r = await _req(app, "POST", "/api/check", headers={**AUTH, "content-type": "application/json"}, content=body)
    assert r.status_code == 400 and not app.logged


@pytest.mark.anyio
async def test_baseline_source(app):
    r = await _req(app, "POST", "/api/check", headers=AUTH, json={"name": "mac", "verilog": "v", "source": "baseline"})
    assert r.status_code == 200
    (args, _), = app.logged
    assert args[3] == "baseline"


@pytest.mark.anyio
async def test_unknown_design(app):
    r = await _req(app, "POST", "/api/check", headers=AUTH, json={"name": "nope", "verilog": "v"})
    assert r.status_code == 404 and "error" in r.json() and not app.logged


@pytest.mark.anyio
async def test_get_not_allowed(app):
    r = await _req(app, "GET", "/api/check", headers=AUTH)
    assert r.status_code == 405


@pytest.mark.anyio
async def test_mcp_check_logs_mcp(app):
    out = json.loads(await server.check("mac", "v"))
    assert out["accepted"] and out["vs_baseline"] == f"{200.0 / get('mac').baseline_mhz:.2f}x" and "_path" not in out
    (args, _), = app.logged
    assert args[3] == "mcp"


@pytest.mark.anyio
async def test_health_still_open(app):
    r = await _req(app, "GET", "/health")
    assert r.status_code == 200 and r.json()["ok"]


@pytest.fixture
def anyio_backend():
    return "asyncio"
