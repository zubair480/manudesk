"""Fire-and-forget check log on InsForge: one `md_checks` row per check, and for passing checks the Verilog and
result in bucket `md-artifacts` under `checks/<id>/`.

Env: INSFORGE_BASE_URL + INSFORGE_API_KEY (admin key; compute only). Missing env -> one warning, then no-op.
A single daemon thread drains a bounded queue, so logging never raises into a check and never slows it down.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import threading
import uuid

import httpx

log = logging.getLogger("manudesk.store")

BUCKET = "md-artifacts"
_COLS = ("mhz", "x", "lat", "path", "use")
_dumps = lambda o: json.dumps(o, separators=(",", ":"))  # noqa: E731

_q: queue.Queue = queue.Queue(maxsize=256)
_lock = threading.Lock()
_worker: threading.Thread | None = None
_warned = False


def _env() -> tuple[str, str] | None:
    base, key = os.environ.get("INSFORGE_BASE_URL", "").rstrip("/"), os.environ.get("INSFORGE_API_KEY", "")
    return (base, key) if base and key else None


def row(check_id: str, design: str, verilog: str, result: dict, source: str, run_id: str | None,
        duration_ms: int) -> dict:
    r = {"id": check_id, "design": design, "source": source, "run_id": run_id,
         "verilog_sha256": hashlib.sha256(verilog.encode()).hexdigest(), "pass": bool(result.get("pass")),
         "stage": result.get("stage"), "fix": result.get("fix") or [], "duration_ms": int(duration_ms),
         "artifact_key": None}
    r.update({k: result.get(k) for k in _COLS})
    return r


def write(c: httpx.Client, base: str, job: dict) -> None:
    """Upload artifacts (passing checks only), then insert the row; artifact_key is set only if both uploads
    landed, so a row never points at a missing object."""
    r, verilog, result = job["row"], job["verilog"], job["result"]
    if r["pass"]:
        prefix = f"checks/{r['id']}"
        try:
            for name, body, mime in (("design.v", verilog, "text/plain"),
                                     ("result.json", _dumps(result), "application/json")):
                c.put(f"{base}/api/storage/buckets/{BUCKET}/objects/{prefix}/{name}",
                      files={"file": (name, body.encode(), mime)}).raise_for_status()
            r = {**r, "artifact_key": prefix}
        except httpx.HTTPError as e:
            log.warning("artifact upload failed for %s: %s", r["id"], e)
    res = c.post(f"{base}/api/database/records/md_checks", json=[r])
    if res.is_error and r["run_id"]:  # run_id is an FK: keep the check even if the run row is missing
        log.warning("md_checks insert with run_id %s failed (%s); retrying without", r["run_id"], res.status_code)
        res = c.post(f"{base}/api/database/records/md_checks", json=[{**r, "run_id": None}])
    res.raise_for_status()


def _run(base: str, key: str) -> None:
    with httpx.Client(headers={"Authorization": f"Bearer {key}"}, timeout=20) as c:
        while True:
            job = _q.get()
            try:
                write(c, base, job)
            except Exception as e:  # noqa: BLE001 - logging must never take the worker down
                log.warning("md_checks insert failed for %s: %s", job["row"]["id"], e)
            finally:
                _q.task_done()


def upload_files(prefix: str, files: dict[str, str]) -> str | None:
    """Fire and forget: upload local files to md-artifacts under `prefix/` (PCB fab outputs). Returns the prefix,
    or None when logging is off."""
    env = _env()
    if env is None:
        return None
    base, key = env

    def go():
        try:
            with httpx.Client(headers={"Authorization": f"Bearer {key}"}, timeout=60) as c:
                for name, path in files.items():
                    with open(path, "rb") as f:
                        c.put(f"{base}/api/storage/buckets/{BUCKET}/objects/{prefix}/{name}",
                              files={"file": (name, f.read())}).raise_for_status()
        except Exception as e:  # noqa: BLE001 - an upload failure never fails the check
            log.warning("artifact upload to %s failed: %s", prefix, e)

    threading.Thread(target=go, name="manudesk-upload", daemon=True).start()
    return prefix


def log_check(design: str, verilog: str, result: dict, source: str, run_id: str | None = None,
              duration_ms: int = 0) -> str | None:
    """Queue one check for logging; returns its md_checks id, or None when logging is off or the queue is full."""
    global _worker, _warned
    env = _env()
    if env is None:
        if not _warned:
            _warned = True
            log.warning("INSFORGE_BASE_URL/INSFORGE_API_KEY not set: checks are not logged")
        return None
    if "error" in result:
        return None
    check_id = str(uuid.uuid4())
    try:
        with _lock:
            if _worker is None or not _worker.is_alive():
                _worker = threading.Thread(target=_run, args=env, name="manudesk-store", daemon=True)
                _worker.start()
        _q.put_nowait({"row": row(check_id, design, verilog, result, source, run_id, duration_ms),
                       "verilog": verilog, "result": result})
    except Exception as e:  # noqa: BLE001 - queue full or thread start failure: drop the log, keep the check
        log.warning("check log dropped: %s", e)
        return None
    return check_id
