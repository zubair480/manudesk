"""LPF -> placed board -> Freerouting -> routed board -> KiCad DRC gate -> fab outputs.

Ported from Crusoe-Forge tc/pcb/pipeline.py (proven there: 15 parts, 2 layers, 100% routed, DRC 0 errors in
~18-26 s). The definition of done is `kicad-cli pcb drc --severity-error --exit-code-violations --format json`
returning 0 with zero violations and zero unconnected items.

Tools (env, with the compute image's defaults):
  KICAD_BIN       folder with kicad-cli (/usr/bin)
  KICAD_PYTHON    a Python that can `import pcbnew` (/usr/bin/python3; NOT the OSS CAD Suite python3 on PATH)
  JAVA21          java >= 25 for Freerouting 2.4.1 (name kept from Crusoe-Forge)
  FREEROUTING_JAR /opt/fpga/freerouting/freerouting-2.4.1.jar
"""
from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from manudesk.pcb import board, lpf, placement
from manudesk.toolchain import new_workdir

HERE = Path(__file__).resolve().parent
DEFAULT_LPF = HERE / "hdmi_addon_ulx3s.lpf"
TOOL_TIMEOUT = 300  # KiCad steps take 3-50 s; under parallel nextpnr load DRC once exceeded 120 s
ROUTE_TIMEOUT = 300
_EXE = ".exe" if os.name == "nt" else ""
_SCORE = re.compile(r"final score: ([\d.]+) \((\d+) unrouted and (\d+) violations\)")


def _first(*cands) -> Path | None:
    return next((Path(c) for c in cands if c and Path(c).exists()), None)


def kicad_bin() -> Path:
    which = shutil.which("kicad-cli")
    return _first(os.environ.get("KICAD_BIN"), Path(which).parent if which else None, "/usr/bin") or Path("/usr/bin")


def kicad_python() -> Path:
    return _first(os.environ.get("KICAD_PYTHON"), kicad_bin() / f"python{_EXE}" if _EXE else None,
                  "/usr/bin/python3") or Path("/usr/bin/python3")


def kicad_cli() -> Path:
    return kicad_bin() / f"kicad-cli{_EXE}"


def java() -> Path:
    return _first(os.environ.get("JAVA21"), "/opt/java/bin/java", shutil.which("java")) \
        or Path("java")


def freerouting_jar() -> Path:
    return Path(os.environ.get("FREEROUTING_JAR", "/opt/fpga/freerouting/freerouting-2.4.1.jar"))


def available() -> dict:
    """Which PCB tools this machine has (for /health and a clear error instead of a stack trace)."""
    return {"kicad_cli": kicad_cli().exists(), "kicad_python": kicad_python().exists(),
            "java": java().exists() or shutil.which(str(java())) is not None, "freerouting": freerouting_jar().exists()}


@dataclass
class PcbResult:
    passed: bool = False
    stage: str = "spec"            # spec -> placement -> route -> drc -> ok
    drc_errors: int | None = None
    unconnected: int | None = None
    route_score: float | None = None
    unrouted: int | None = None
    tracks: int | None = None
    vias: int | None = None
    parts: int = 0
    nets: int = 0
    board_mm: list[float] = field(default_factory=list)
    violations: list[dict] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    legalizer_moves: list[str] = field(default_factory=list)
    placements: list[dict] = field(default_factory=list)
    ignored: list[dict] = field(default_factory=list)
    timings: dict[str, float] = field(default_factory=dict)
    files: dict[str, str] = field(default_factory=dict)
    error: str | None = None


def _run(cmd: list, timeout: float, cwd: Path | None = None, log: Path | None = None) -> subprocess.CompletedProcess:
    # Plain environment: the OSS CAD Suite PATH would put its own python3/libs in front of KiCad's.
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, timeout=timeout, cwd=cwd,
                       encoding="utf-8", errors="replace")
    if log:
        log.write_text(p.stdout + p.stderr, encoding="utf-8")
    return p


def _last_json(text: str) -> dict:
    for line in reversed(text.strip().splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError(f"no JSON line in output: {text[-500:]}")


def parse_freerouting(log: str) -> tuple[float, int, int] | None:
    """(score, unrouted, violations) from the last 'final score' line, or None."""
    hits = _SCORE.findall(log)
    return (float(hits[-1][0]), int(hits[-1][1]), int(hits[-1][2])) if hits else None


def parse_drc(report: dict) -> tuple[int, int]:
    """(error-level violations, unconnected items) from kicad-cli's JSON DRC report."""
    viol = [v for v in report.get("violations", []) if v.get("severity", "error") == "error"]
    return len(viol), len(report.get("unconnected_items", []))


def drc_details(report: dict, limit: int = 20) -> list[dict]:
    """Error-level violations + unconnected items, condensed for an agent: type, description, items, positions."""
    out = []
    for kind, lst in (("violation", report.get("violations", [])), ("unconnected", report.get("unconnected_items", []))):
        for v in lst:
            if kind == "violation" and v.get("severity", "error") != "error":
                continue
            out.append({"kind": kind, "type": v.get("type"), "description": v.get("description"),
                        "items": [{"description": (i.get("description") or "")[:120],
                                   "pos_mm": [round(i.get("pos", {}).get("x", 0), 2), round(i.get("pos", {}).get("y", 0), 2)]}
                                  for i in v.get("items", [])[:3]]})
    return out[:limit]


def write_bom(parts: list[dict], path: Path) -> None:
    rows = board.bom_rows(board.BoardSpec(parts=[board.Part(**p) for p in parts]))
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def _timed(t: dict, name: str, fn):
    s = time.perf_counter()
    try:
        return fn()
    finally:
        t[name] = round(time.perf_counter() - s, 2)


_sizes_cache: dict[str, dict] = {}


def footprint_sizes(spec: dict, work: Path) -> dict:
    """Courtyard size + centre offset per footprint, read from KiCad's own libraries (cached per process)."""
    keys = {f"{p['lib']}:{p['footprint']}" for p in spec["parts"]}
    if not keys <= _sizes_cache.keys():
        f = work / "spec_sizes.json"
        f.write_text(json.dumps(spec), encoding="utf-8")
        p = _run([kicad_python(), HERE / "kicad_fpinfo.py", f], 120)
        if p.returncode:
            raise RuntimeError(f"kicad_fpinfo failed: {(p.stdout + p.stderr)[-500:]}")
        _sizes_cache.update(_last_json(p.stdout))
    return {k: _sizes_cache[k] for k in keys}


def _template(lpf_text: str | None) -> board.BoardSpec:
    text = lpf_text if lpf_text and lpf_text.strip() else DEFAULT_LPF.read_text(encoding="utf-8")
    return board.build(lpf.assign(text))


def parts(lpf_text: str | None = None) -> dict:
    """What the agent needs to place the board: parts with courtyards, nets, the pin map and the hand-template
    placement (which routes DRC-clean on the 70 x 56 mm board)."""
    spec = _template(lpf_text).to_json()
    work = new_workdir("pcbparts")
    try:
        sizes = footprint_sizes(spec, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    neigh: dict[str, set] = {p["ref"]: set() for p in spec["parts"]}
    for nodes in spec["nets"].values():
        refs = {r for r, _ in nodes}
        for r in refs:
            neigh[r] |= refs - {r}
    return {
        "rules": placement.RULES,
        "template_board_mm": spec["outline"][2:],
        "parts": [{"ref": p["ref"], "footprint": f"{p['lib']}:{p['footprint']}", "value": p["value"],
                   "description": p["description"], "courtyard_mm": sizes[f"{p['lib']}:{p['footprint']}"],
                   "connects_to": sorted(neigh[p["ref"]])} for p in spec["parts"]],
        "nets": {n: [f"{r}.{pad}" for r, pad in nodes] for n, nodes in spec["nets"].items()},
        "template_placements": placement.placements_of(spec),
        "pin_map": spec["pin_map"], "ignored": spec["ignored"],
    }


def route_check(out: Path, res: PcbResult) -> None:
    """spec.json in `out` -> placed board -> Freerouting -> routed board -> DRC JSON. Fills res; raises on tool failure."""
    t = res.timings
    res.stage = "route"
    p = _timed(t, "gen_place", lambda: _run([kicad_python(), HERE / "kicad_gen.py", out / "spec.json", out], TOOL_TIMEOUT))
    if p.returncode:
        raise RuntimeError(f"kicad_gen failed: {(p.stdout + p.stderr)[-800:]}")
    _last_json(p.stdout)

    p = _timed(t, "freeroute", lambda: _run([java(), "-jar", freerouting_jar(), "-de", out / "board.dsn",
                                            "-do", out / "board.ses", "-mp", "100", "--gui.enabled=false"],
                                           ROUTE_TIMEOUT, cwd=out, log=out / "freerouting.log"))
    score = parse_freerouting(p.stdout + p.stderr)
    if not (out / "board.ses").exists():
        raise RuntimeError(f"Freerouting wrote no .ses (rc={p.returncode}): {(p.stdout + p.stderr)[-400:]}")
    if score:
        res.route_score, res.unrouted, _ = score

    routed = out / "board_routed.kicad_pcb"
    p = _timed(t, "ses_import", lambda: _run([kicad_python(), HERE / "kicad_ses.py", out / "board.kicad_pcb",
                                             out / "board.ses", routed], TOOL_TIMEOUT))
    if p.returncode:
        raise RuntimeError(f"SES import failed: {(p.stdout + p.stderr)[-800:]}")
    info = _last_json(p.stdout)
    res.tracks, res.vias = info["tracks"], info["vias"]

    # DRC gate: errors only, JSON, nonzero exit on any violation
    res.stage = "drc"
    drc_json = out / "drc_errors.json"
    p = _timed(t, "drc_gate", lambda: _run([kicad_cli(), "pcb", "drc", "--severity-error", "--exit-code-violations",
                                           "--format", "json", "-o", drc_json, routed], TOOL_TIMEOUT))
    if not drc_json.exists():
        raise RuntimeError(f"kicad-cli drc wrote no report (rc={p.returncode}): {(p.stdout + p.stderr)[-400:]}")
    report = json.loads(drc_json.read_text(encoding="utf-8"))
    res.drc_errors, res.unconnected = parse_drc(report)
    res.violations = placement.relative(drc_details(report))
    res.passed = p.returncode == 0 and res.drc_errors == 0 and res.unconnected == 0
    if res.passed:
        res.stage = "ok"


def export_fab(out: Path, res: PcbResult) -> None:
    """Full DRC report, Gerbers, drill, positions, renders and gerbers.zip for the routed board in `out`."""
    routed = out / "board_routed.kicad_pcb"
    fab = out / "fab"
    fab.mkdir(exist_ok=True)
    cli = kicad_cli()
    jobs = {  # independent kicad-cli calls: run them side by side (sequential took > 4 min under load)
        "drc_full": [cli, "pcb", "drc", "--severity-all", "-o", out / "drc_full.rpt", routed],
        "gerbers": [cli, "pcb", "export", "gerbers", "-o", f"{fab}/", routed],
        "drill": [cli, "pcb", "export", "drill", "-o", f"{fab}/", routed],
        "pos": [cli, "pcb", "export", "pos", "--format", "csv", "--units", "mm", "-o", out / "board_pos.csv", routed],
        "render_top": [cli, "pcb", "render", "--side", "top", "--quality", "basic", "-w", "1600",
                       "--height", "1200", "-o", out / "board_top.png", routed],
        "render_iso": [cli, "pcb", "render", "--perspective", "--rotate", "-45,0,45", "--quality", "basic",
                       "-w", "1600", "--height", "1200", "-o", out / "board_iso.png", routed],
    }
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        list(ex.map(lambda kv: _timed(res.timings, kv[0], lambda: _run(kv[1], TOOL_TIMEOUT)), jobs.items()))
    with zipfile.ZipFile(out / "gerbers.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(fab.iterdir()):
            z.write(f, f.name)
    res.files = {k: v for k, v in {
        "board": "board_routed.kicad_pcb", "drc": "drc_errors.json", "drc_full": "drc_full.rpt", "bom": "bom.csv",
        "pos": "board_pos.csv", "gerbers_zip": "gerbers.zip", "render_top": "board_top.png",
        "render_iso": "board_iso.png"}.items() if (out / v).exists()}


def check(lpf_text: str | None = None, board_w: float | None = None, board_h: float | None = None,
          placements: list[dict] | None = None, fab: bool = False, keep: bool = False) -> tuple[PcbResult, Path]:
    """One placement -> legalize -> geometry pre-check -> route -> DRC (-> fab outputs). Never raises: tool
    failures come back as res.error. Returns (result, work dir); the work dir is removed unless keep or fab."""
    res = PcbResult()
    out = new_workdir("pcb")
    t0 = time.perf_counter()
    try:
        base = _template(lpf_text)
        res.ignored = base.ignored
        spec = base.to_json()
        res.parts, res.nets = len(spec["parts"]), len(spec["nets"])
        (out / "design.lpf").write_text(lpf_text or DEFAULT_LPF.read_text(encoding="utf-8"), encoding="utf-8")

        res.stage = "placement"
        if placements or board_w or board_h:
            spec, res.problems = placement.apply_placement(spec, {"board_w": board_w, "board_h": board_h,
                                                                  "placements": placements or []})
        bw, bh = spec["outline"][2], spec["outline"][3]
        res.board_mm = [bw, bh]
        sizes = footprint_sizes(spec, out)
        spec, res.legalizer_moves, geo = placement.legalize(spec, sizes)
        geo = geo or placement.geometry_check(spec, sizes, bw, bh)
        res.placements = placement.placements_of(spec)
        (out / "spec.json").write_text(json.dumps(spec, indent=1), encoding="utf-8")
        write_bom(spec["parts"], out / "bom.csv")
        if geo:  # rejected before spending a route on it
            res.violations = geo
        else:
            route_check(out, res)
            if fab and res.passed:
                export_fab(out, res)
    except Exception as e:  # noqa: BLE001 - report, don't crash the server
        res.error = f"{type(e).__name__}: {e}"[:600]
    res.timings["total"] = round(time.perf_counter() - t0, 2)
    (out / "result.json").write_text(json.dumps(res.__dict__, indent=1, default=str), encoding="utf-8")
    if not (keep or fab):
        shutil.rmtree(out, ignore_errors=True)
    return res, out
