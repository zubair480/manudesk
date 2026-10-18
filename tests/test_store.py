"""store tests: the check log is fire and forget, never raises, and only passing checks upload artifacts.
httpx is mocked with MockTransport (no network)."""
from __future__ import annotations

import json
import logging

import httpx
import pytest

from manudesk import store

PASS = {"pass": True, "stage": "ok", "fix": [], "mhz": 210.5, "target": 250, "base": 180, "x": 1.17, "lat": 3,
        "path": "a -> b", "use": {"LUT": 10, "FF": 20, "DSP": 1}}
FAIL = {"pass": False, "stage": "sim", "fix": ["wrong output"], "target": 250, "base": 180, "lat": 3}
BASE = "https://x.insforge.app"


def _client(fail=()):
    calls = []

    def handle(req: httpx.Request):
        calls.append(req)
        if any(f in req.url.path for f in fail):
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(201, json=[])

    return httpx.Client(transport=httpx.MockTransport(handle)), calls


def _job(result, run_id=None):
    return {"row": store.row("11111111-1111-1111-1111-111111111111", "mac", "module mac; endmodule", result,
                             "agent", run_id, 1234), "verilog": "module mac; endmodule", "result": result}


def test_row_maps_result():
    r = _job(PASS)["row"]
    assert r["design"] == "mac" and r["source"] == "agent" and r["pass"] is True and r["duration_ms"] == 1234
    assert r["mhz"] == 210.5 and r["use"] == {"LUT": 10, "FF": 20, "DSP": 1} and len(r["verilog_sha256"]) == 64
    assert "verilog" not in r
    f = _job(FAIL)["row"]
    assert f["mhz"] is None and f["use"] is None and f["fix"] == ["wrong output"]


def test_pass_uploads_then_inserts():
    c, calls = _client()
    store.write(c, BASE, _job(PASS))
    paths = [(q.method, q.url.path) for q in calls]
    cid = "11111111-1111-1111-1111-111111111111"
    assert paths == [("PUT", f"/api/storage/buckets/md-artifacts/objects/checks/{cid}/design.v"),
                     ("PUT", f"/api/storage/buckets/md-artifacts/objects/checks/{cid}/result.json"),
                     ("POST", "/api/database/records/md_checks")]
    body = json.loads(calls[-1].content)
    assert isinstance(body, list) and body[0]["artifact_key"] == f"checks/{cid}"


def test_fail_inserts_only():
    c, calls = _client()
    store.write(c, BASE, _job(FAIL))
    assert [q.url.path for q in calls] == ["/api/database/records/md_checks"]
    assert json.loads(calls[0].content)[0]["artifact_key"] is None


def test_upload_failure_still_logs_row_without_key():
    c, calls = _client(fail=("/api/storage",))
    store.write(c, BASE, _job(PASS))
    assert calls[-1].url.path == "/api/database/records/md_checks"
    assert json.loads(calls[-1].content)[0]["artifact_key"] is None


def test_missing_env_is_noop_with_one_warning(monkeypatch, caplog):
    monkeypatch.delenv("INSFORGE_BASE_URL", raising=False)
    monkeypatch.delenv("INSFORGE_API_KEY", raising=False)
    monkeypatch.setattr(store, "_warned", False)
    with caplog.at_level(logging.WARNING, logger="manudesk.store"):
        assert store.log_check("mac", "v", PASS, "mcp") is None
        assert store.log_check("mac", "v", PASS, "mcp") is None
    assert len([r for r in caplog.records if "not set" in r.message]) == 1


def test_log_check_never_raises_and_drains(monkeypatch):
    monkeypatch.setenv("INSFORGE_BASE_URL", BASE)
    monkeypatch.setenv("INSFORGE_API_KEY", "k")
    seen = []

    def boom(c, base, job):
        seen.append(job["row"]["id"])
        raise RuntimeError("network down")

    monkeypatch.setattr(store, "write", boom)
    monkeypatch.setattr(store, "_worker", None)
    ids = [store.log_check("mac", "v", PASS, "mcp", duration_ms=5) for _ in range(3)]
    store._q.join()
    assert all(ids) and seen == ids
    assert store.log_check("mac", "v", {"error": "unknown design"}, "mcp") is None


def test_full_queue_drops(monkeypatch):
    monkeypatch.setenv("INSFORGE_BASE_URL", BASE)
    monkeypatch.setenv("INSFORGE_API_KEY", "k")

    class Full:
        def put_nowait(self, _):
            import queue
            raise queue.Full

    class Alive:
        def is_alive(self):
            return True

    monkeypatch.setattr(store, "_q", Full())
    monkeypatch.setattr(store, "_worker", Alive())
    assert store.log_check("mac", "v", PASS, "mcp") is None


@pytest.fixture(autouse=True)
def _no_real_env(monkeypatch):
    monkeypatch.delenv("INSFORGE_BASE_URL", raising=False)
    monkeypatch.delenv("INSFORGE_API_KEY", raising=False)


def test_missing_run_retries_without_run_id():
    calls = []

    def handle(req):
        calls.append(json.loads(req.content)[0]["run_id"])
        return httpx.Response(409 if calls[-1] else 201, json=[])

    store.write(httpx.Client(transport=httpx.MockTransport(handle)), BASE,
                _job(FAIL, run_id="44444444-4444-4444-4444-444444444444"))
    assert calls == ["44444444-4444-4444-4444-444444444444", None]
