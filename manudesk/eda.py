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

def lint(files: list[Path], top: str, cwd: Path, timeout: float = 60) -> list[str]:
    """Verilator lint errors (warnings are ignored)."""
    argv = [tool("verilator_bin"), "--lint-only", "-Wno-fatal", "-Wno-DECLFILENAME", "-Wno-UNUSEDSIGNAL",
            "-Wno-UNUSEDPARAM", "-Wno-WIDTH", "--top-module", top, *[f.name for f in files]]
    try:
        rc, out = run(argv, cwd, timeout)
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


# ------------------------------------------------------------------ interface

def ports(src: Path, top: str, cwd: Path, timeout: float = 60) -> tuple[dict | None, list[str]]:
    """The top module's ports {name: [direction, width]} from a parse + elaborate only (about a second, no
    synthesis). hierarchy runs without -check, so instantiated mul18x18_reg cells need no definition here."""
    script = f"read_verilog -sv {src.name}; hierarchy -top {top}; proc; write_json ports.json"
    try:
        rc, out = run([tool("yosys"), "-q", "-p", script], cwd, timeout)
    except subprocess.TimeoutExpired:
        return None, [f"yosys timed out after {timeout:g}s"]
    js = cwd / "ports.json"
    if rc != 0 or not js.exists():
        errs = [l.strip() for l in out.splitlines() if "ERROR" in l] or out.strip().splitlines()[-3:]
        return None, [e[:200] for e in errs[:4]]
    mod = json.loads(js.read_text(encoding="utf-8"))["modules"].get(top)
    if mod is None:
        return None, [f"top module `{top}` not found"]
    return {k: [v["direction"], len(v["bits"])] for k, v in mod["ports"].items()}, []


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
    clk_q_ns: float = 0.0
    setup_ns: float = 0.0
    segments: int = 0
    hops: int = 0
    cells: dict[str, int] = field(default_factory=dict)   # short kind -> count (legacy `brief`)
    labels: dict[str, int] = field(default_factory=dict)  # "CCU2C(carry)" -> count
    src: list[str] = field(default_factory=list)          # "L11" (legacy `brief`)
    sources: list[str] = field(default_factory=list)      # "design.v:11.15-11.17"

    def brief(self) -> str:
        cells = " ".join(f"{k}x{v}" for k, v in sorted(self.cells.items(), key=lambda kv: -kv[1])[:3])
        src = ",".join(self.src[:4])
        return (f"{_reg(self.start)}->{_reg(self.end)} {self.ns:.2f}ns ({self.hops} logic hops, logic "
                f"{self.logic_ns:.2f} route {self.route_ns:.2f}){' ' + cells if cells else ''}"
                f"{' @' + src if src else ''}")

    def describe(self) -> str:
        """One readable line for agents: endpoints, delay split, the cells on the path and their source lines."""
        if not self.segments:
            return ""
        cells = ", ".join(f"{k} x{v}" for k, v in sorted(self.labels.items(), key=lambda kv: -kv[1])) or "none"
        srcs = ", ".join(self.sources[:6]) or "none recorded"
        note = ""
        if self.start and not self.start.startswith("dut."):
            note = ("; it starts at the harness register on an input port, so the logic before your first "
                    "register is what is slow")
        elif self.end and not self.end.startswith("dut."):
            note = ("; it ends at the harness register on an output port, so the logic after your last "
                    "register is what is slow")
        return (f"critical path {self.start} -> {self.end}: {self.ns:.2f} ns over {self.segments} segments / "
                f"{self.hops} logic hops (logic {self.logic_ns:.2f} ns, routing {self.route_ns:.2f} ns, clk-to-q "
                f"{self.clk_q_ns:.2f}, setup {self.setup_ns:.2f}); cells on path: {cells}; Verilog sources: {srcs}"
                f"{note}")


@dataclass
class Pnr:
    ok: bool
    mhz: float = 0.0
    path: Path_ = field(default_factory=Path_)
    used: dict[str, int] = field(default_factory=dict)
    avail: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


_KINDS = ("MULT18X18D", "ALU54B", "CCU2C", "LUT4", "TRELLIS_FF", "DP16KD", "PFUMX", "L6MUX21")
_SHORT = {"LUT4": "LUT", "TRELLIS_FF": "FF", "MULT18X18D": "DSP", "CCU2C": "carry"}
_LABELS = {"carry": "CCU2C(carry)", "LUT": "LUT4(lut)", "PFUMX": "PFUMX(mux)", "L6MUX21": "L6MUX21(mux)",
           "DSP": "MULT18X18D(dsp)", "ALU54B": "ALU54B(dsp)", "DP16KD": "DP16KD(bram)", "FF": "TRELLIS_FF(ff)",
           "IO": "TRELLIS_IO(io)"}
_TYPE_KIND = {"MULT18X18D": "DSP", "ALU54B": "ALU54B", "DP16KD": "DP16KD", "TRELLIS_IO": "IO"}


_CARRY_PORTS = {"FCI", "FCO"}
_MUX_PORTS = {"OFX", "OFX0", "OFX1", "FXA", "FXB", "M"}


def _seg_kind(seg: dict, net: "_Netlist") -> str:
    """What a logic segment passes through, from the cell's routed type, its MODE and the ports used. Cell names
    are no guide: yosys names a LUT after the net it drives, so a plain LUT4 can carry "CCU2C" in its name."""
    cell = seg.get("from", {}).get("cell", "")
    typ = net.type(cell)
    if typ in _TYPE_KIND:
        return _TYPE_KIND[typ]
    ports = {seg.get("from", {}).get("port", ""), seg.get("to", {}).get("port", "")}
    if ports & _CARRY_PORTS or str(net.param(cell, "MODE")).upper().startswith("CCU2"):
        return "carry"
    if ports & _MUX_PORTS:
        return "PFUMX"
    if typ:
        return "LUT"
    return _kind(cell)


def _kind(cell: str, typ: str = "") -> str:
    if typ in _TYPE_KIND:
        return _TYPE_KIND[typ]
    if "$CCU2_COMB" in cell:
        return "carry"
    best, pos = "", -1
    for k in _KINDS:
        i = cell.rfind(k)
        if i > pos:
            best, pos = k, i
    return _SHORT.get(best, best or "logic")


def _reg_bit(cell: str) -> str:
    """dut.din_r_TRELLIS_FF_Q_13 -> dut.din_r[13]: the register a flip-flop cell belongs to."""
    m = re.match(r"(.+?)_TRELLIS_FF_Q(?:_(\d+))?$", cell)
    if not m:
        return cell
    return f"{m.group(1)}[{m.group(2)}]" if m.group(2) else m.group(1)


def _clean(name: str | None) -> bool:
    return bool(name) and not re.search(r"_(TRELLIS_|LUT4|CCU2C|PFUMX|L6MUX21)", name)


def _reg(cell: str) -> str:
    """a_r_TRELLIS_FF_Q_13 -> a_r; strip harness prefixes."""
    m = re.match(r"(.+?)_TRELLIS_FF_Q", cell)
    name = m.group(1) if m else cell.split("$")[0]
    name = re.sub(r"^dut\.", "", name)
    return name[:40]


def _src_refs(attr: str, src_name: str) -> list[str]:
    """yosys src attribute "/tmp/x/design.v:11.15-11.17|..." -> ["design.v:11.15-11.17"]. This file only:
    harness and helper-library lines are not the agent's to fix."""
    out = []
    for part in str(attr).split("|"):
        m = re.search(r"(?:^|[\\/])" + re.escape(src_name) + r":(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)$", part.strip())
        if m:
            out.append(f"{src_name}:{m.group(1)}")
    return out


class _Netlist:
    """Lookups into nextpnr's --write JSON (cell types, src attributes, Q nets). nextpnr renames the top
    module to `top` there."""

    def __init__(self, routed: dict | None):
        mods = (routed or {}).get("modules") or {}
        mod = mods.get("top") or (next(iter(mods.values())) if mods else {})
        self.cells = mod.get("cells") or {}
        self.bit_name: dict[int, str] = {}
        for name, n in (mod.get("netnames") or {}).items():
            if n.get("hide_name") or "$" in name:
                continue
            bits = n.get("bits") or []
            for i, b in enumerate(bits):
                if isinstance(b, int) and b not in self.bit_name:
                    self.bit_name[b] = name if len(bits) == 1 else f"{name}[{i}]"

    def type(self, cell: str) -> str:
        return (self.cells.get(cell) or {}).get("type", "")

    def param(self, cell: str, key: str):
        return ((self.cells.get(cell) or {}).get("parameters") or {}).get(key, "")

    def src(self, cell: str) -> str:
        return ((self.cells.get(cell) or {}).get("attributes") or {}).get("src", "")

    def q_net(self, cell: str) -> str | None:
        bits = ((self.cells.get(cell) or {}).get("connections") or {}).get("Q") or []
        return self.bit_name.get(bits[0]) if bits and isinstance(bits[0], int) else None


def parse_report(report: dict, src_name: str = "design.v", routed: dict | None = None) -> Pnr:
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
        net = _Netlist(routed)
        segs = best[1]["path"]
        p.segments = len(segs)

        def add_src(refs):
            for r in refs:
                if r not in p.sources:
                    p.sources.append(r)
                line = "L" + r.split(":")[1].split(".")[0].split("-")[0]
                if line not in p.src:
                    p.src.append(line)

        first_net = None
        for seg in segs:
            d, t = float(seg.get("delay", 0)), seg.get("type")
            p.ns += d
            if t == "logic":
                p.logic_ns += d
                p.hops += 1
                cell = seg.get("from", {}).get("cell", "")
                k = _seg_kind(seg, net)
                p.cells[k] = p.cells.get(k, 0) + 1
                label = _LABELS.get(k, k)
                p.labels[label] = p.labels.get(label, 0) + 1
                add_src(_src_refs(net.src(cell), src_name))
            elif t == "routing":
                p.route_ns += d
                first_net = first_net or seg.get("net")
                for s in seg.get("sources") or []:
                    add_src(_src_refs(s, src_name))
            elif t == "clk-to-q":
                p.clk_q_ns += d
            elif t == "setup":
                p.setup_ns += d
        c0 = segs[0].get("from", {}).get("cell", "")
        c1 = segs[-1].get("to", {}).get("cell", "")
        p.start = next((n for n in (net.q_net(c0), first_net) if _clean(n)), _reg_bit(c0))
        p.end = next((n for n in (net.q_net(c1),) if _clean(n)), _reg_bit(c1))
        for f in ("ns", "logic_ns", "route_ns", "clk_q_ns", "setup_ns"):
            setattr(p, f, round(getattr(p, f), 2))
    return Pnr(True, round(float(entry.get("achieved", 0.0)), 1), p, used, avail)


def place_and_route(netlist: Path, freq_mhz: float, cwd: Path, seed: int = 1, timeout: float = 300,
                    write_routed: bool = False) -> Pnr:
    """nextpnr-ecp5. It exits 1 whenever Fmax < --freq even though every output was written, hence
    --timing-allow-fail and parsing report.json whatever the exit code. Never ask for --routed-svg or
    --placed-svg: on the 85k part they take a check from ~3 s to 40-60 s. ``write_routed`` also saves
    routed.json: the critical-path cell types and src attributes come from it, and `nextpnr-ecp5 --gui` opens it
    already placed and routed (the live tool view)."""
    report = cwd / "report.json"
    argv = [tool("nextpnr-ecp5"), *DEVICE, "--json", netlist.name, "--freq", f"{freq_mhz:g}", "--seed", str(seed),
            "--timing-allow-fail", "--lpf-allow-unconstrained", "--report", report.name, "-q",
            *(["--write", "routed.json"] if write_routed else [])]
    try:
        rc, out = run(argv, cwd, timeout)
    except subprocess.TimeoutExpired:
        return Pnr(False, errors=[f"place and route timed out after {timeout:g}s"])
    if not report.exists():
        errs = [l.strip() for l in out.splitlines() if "ERROR" in l] or out.strip().splitlines()[-3:]
        return Pnr(False, errors=[e[:200] for e in errs[:4]])
    routed = cwd / "routed.json"
    net = json.loads(routed.read_text(encoding="utf-8")) if write_routed and routed.exists() else None
    return parse_report(json.loads(report.read_text(encoding="utf-8")), routed=net)
