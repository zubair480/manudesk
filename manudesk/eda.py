"""Thin wrappers over the open-source FPGA flow: Verilator lint, Icarus simulation, Yosys synthesis
(synth_ecp5) and nextpnr-ecp5 place and route on a Lattice ECP5-85F, speed grade 6.

Testbenches print one verdict line (`PASS ...` or `FAIL ...`) plus `MISMATCH ...` lines for the first
wrong cycles.
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from manudesk.toolchain import run, tool

DEVICE = ["--85k", "--package", "CABGA381", "--speed", "6"]
PART = "LFE5U-85F-6BG381C"


# ------------------------------------------------------------------ lint

def lint(files: list[Path], top: str, cwd: Path) -> list[str]:
    """Verilator lint errors (warnings are ignored)."""
    argv = [tool("verilator_bin"), "--lint-only", "-Wno-fatal", "-Wno-DECLFILENAME", "-Wno-UNUSEDSIGNAL",
            "-Wno-UNUSEDPARAM", "-Wno-WIDTH", "--top-module", top, *[f.name for f in files]]
    try:
        rc, out = run(argv, cwd, 60)
    except subprocess.TimeoutExpired:
        return ["lint timed out"]
    errors = [_short(l) for l in out.splitlines() if l.startswith("%Error") and "Exiting due to" not in l]
    if rc != 0 and not errors:
        errors = [_short(l) for l in out.strip().splitlines()[-3:]] or [f"verilator exit {rc}"]
    return errors


def _short(line: str) -> str:
    # "%Error: design.v:12:5: msg" -> "design.v:12:5: msg"
    return re.sub(r"^%Error(-\w+)?:\s*", "", line.strip())[:200]


# ------------------------------------------------------------------ simulation

@dataclass
class Sim:
    compiled: bool
    passed: bool = False
    verdict: str = ""
    mismatches: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def simulate(files: list[Path], tb: Path, cwd: Path, timeout: float = 60) -> Sim:
    names = [tb.name if tb.parent == cwd else str(tb)] + [f.name for f in files]
    try:
        rc, out = run([tool("iverilog"), "-g2012", "-o", "sim.vvp", *names], cwd, timeout)
    except subprocess.TimeoutExpired:
        return Sim(False, errors=["iverilog timed out"])
    if rc != 0:
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        errs = [l for l in lines if "error" in l.lower()] or lines
        return Sim(False, errors=[_hide_tb(e) for e in errs[:5]])
    try:
        _, out = run([tool("vvp"), "-n", "sim.vvp"], cwd, timeout)
    except subprocess.TimeoutExpired:
        return Sim(True, verdict="TIMEOUT", errors=[f"simulation timed out after {timeout:g}s"])
    verdict, mism = "", []
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("MISMATCH"):
            mism.append(s)
        elif s.startswith(("PASS", "FAIL")):
            verdict = s
    return Sim(True, verdict.startswith("PASS") and not mism, verdict, mism[:4])


def _hide_tb(line: str) -> str:
    """Never leak the hidden testbench's path or contents in error text."""
    return re.sub(r"\S*tb\.v:\d+:?", "testbench:", line)[:200]


# ------------------------------------------------------------------ synthesis

@dataclass
class Synth:
    ok: bool
    json_path: Path | None = None
    ports: dict[str, list] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


def synthesize(files: list[Path], top: str, cwd: Path, timeout: float = 180) -> Synth:
    script = f"read_verilog -sv {' '.join(f.name for f in files)}; synth_ecp5 -top {top} -json synth.json"
    try:
        rc, out = run([tool("yosys"), "-q", "-p", script], cwd, timeout)
    except subprocess.TimeoutExpired:
        return Synth(False, errors=[f"yosys timed out after {timeout:g}s"])
    js = cwd / "synth.json"
    if rc != 0 or not js.exists():
        errs = [l.strip() for l in out.splitlines() if "ERROR" in l] or out.strip().splitlines()[-3:]
        return Synth(False, errors=[e[:200] for e in errs[:4]])
    mods = json.loads(js.read_text(encoding="utf-8"))["modules"]
    mod = mods.get(top) or next(iter(mods.values()))
    ports = {k: [v["direction"], len(v["bits"])] for k, v in mod["ports"].items()}
    return Synth(True, js, ports)


# ------------------------------------------------------------------ place and route

@dataclass
class Path_:
    start: str = ""
    end: str = ""
    ns: float = 0.0
    logic_ns: float = 0.0
    route_ns: float = 0.0
    hops: int = 0
    cells: dict[str, int] = field(default_factory=dict)
    src: list[str] = field(default_factory=list)

    def brief(self) -> str:
        cells = " ".join(f"{k}x{v}" for k, v in sorted(self.cells.items(), key=lambda kv: -kv[1])[:3])
        src = ",".join(self.src[:4])
        return (f"{self.start}->{self.end} {self.ns:.2f}ns ({self.hops} logic hops, logic {self.logic_ns:.2f} "
                f"route {self.route_ns:.2f}){' ' + cells if cells else ''}{' @' + src if src else ''}")


@dataclass
class Pnr:
    ok: bool
    mhz: float = 0.0
    path: Path_ = field(default_factory=Path_)
    used: dict[str, int] = field(default_factory=dict)
    avail: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


_KINDS = ("MULT18X18D", "ALU54B", "CCU2C", "LUT4", "TRELLIS_FF", "DP16KD", "PFUMX", "L6MUX21")


def _kind(cell: str) -> str:
    if "$CCU2_COMB" in cell or "CCU2C" in cell:
        return "carry"
    best, pos = "", -1
    for k in _KINDS:
        i = cell.rfind(k)
        if i > pos:
            best, pos = k, i
    return {"LUT4": "LUT", "TRELLIS_FF": "FF", "MULT18X18D": "DSP"}.get(best, best or "logic")


def _reg(cell: str) -> str:
    """a_r_TRELLIS_FF_Q_13 -> a_r; strip harness prefixes."""
    m = re.match(r"(.+?)_TRELLIS_FF_Q", cell)
    name = m.group(1) if m else cell.split("$")[0]
    name = re.sub(r"^dut\.", "", name)
    return name[:40]


def parse_report(report: dict, src_name: str = "design.v") -> Pnr:
    fmax = report.get("fmax") or {}
    util = report.get("utilization") or {}
    used = {k: v.get("used", 0) for k, v in util.items() if v.get("used")}
    avail = {k: v.get("available", 0) for k, v in util.items()}
    if not fmax:
        return Pnr(False, used=used, avail=avail, errors=["no clocked logic found (is clk connected?)"])
    clock, entry = min(fmax.items(), key=lambda kv: kv[1].get("achieved", 0.0))
    best = None
    for cp in report.get("critical_paths", []):
        if clock in cp.get("from", "") and clock in cp.get("to", ""):
            d = sum(x.get("delay", 0) for x in cp["path"])
            if best is None or d > best[0]:
                best = (d, cp)
    p = Path_()
    if best:
        segs = best[1]["path"]
        for seg in segs:
            d, t = float(seg.get("delay", 0)), seg.get("type")
            p.ns += d
            if t == "logic":
                p.logic_ns += d
                p.hops += 1
                k = _kind(seg.get("from", {}).get("cell", ""))
                p.cells[k] = p.cells.get(k, 0) + 1
            elif t == "routing":
                p.route_ns += d
                for s in seg.get("sources") or []:
                    s = s.split("|")[0]
                    m = re.search(re.escape(src_name) + r":(\d+)", s)
                    if m and f"L{m.group(1)}" not in p.src:
                        p.src.append(f"L{m.group(1)}")
        p.start = _reg(segs[0].get("from", {}).get("cell", ""))
        p.end = _reg(segs[-1].get("to", {}).get("cell", ""))
        p.ns, p.logic_ns, p.route_ns = round(p.ns, 2), round(p.logic_ns, 2), round(p.route_ns, 2)
    return Pnr(True, round(float(entry.get("achieved", 0.0)), 1), p, used, avail)


def place_and_route(netlist: Path, freq_mhz: float, cwd: Path, seed: int = 1, timeout: float = 300) -> Pnr:
    """nextpnr-ecp5. Never ask for SVG output here: on the 85k part it is hundreds of MB."""
    report = cwd / "report.json"
    argv = [tool("nextpnr-ecp5"), *DEVICE, "--json", netlist.name, "--freq", f"{freq_mhz:g}", "--seed", str(seed),
            "--timing-allow-fail", "--lpf-allow-unconstrained", "--report", report.name, "-q"]
    try:
        rc, out = run(argv, cwd, timeout)
    except subprocess.TimeoutExpired:
        return Pnr(False, errors=[f"place and route timed out after {timeout:g}s"])
    if not report.exists():
        errs = [l.strip() for l in out.splitlines() if "ERROR" in l] or out.strip().splitlines()[-3:]
        return Pnr(False, errors=[e[:200] for e in errs[:4]])
    return parse_report(json.loads(report.read_text(encoding="utf-8")))
