"""check(name, verilog): the hardware feedback an agent cannot get on its own.

Gates, cheapest first: static rules -> Verilator lint -> hidden testbench -> mutation check (LATENCY+1 must
fail, so the testbench really depends on this candidate's output) -> synthesis + ports unchanged -> place and
route inside a harness that registers every port -> resource budget.

Output is a short JSON-able dict, built for agents to read cheaply.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
from collections import OrderedDict
from pathlib import Path

from manudesk import eda
from manudesk.designs import LIB, Design, get
from manudesk.toolchain import new_workdir

MAX_SOURCE = 200_000
LATENCY_RE = re.compile(r"localparam\s+(?:integer\s+)?LATENCY\s*=\s*(\d+)\s*;")
# Anything that could touch the host filesystem or the testbench from inside a simulation.
_ALLOWED_SYS = {"$signed", "$unsigned", "$clog2", "$bits"}
_SYS_RE = re.compile(r"\$[A-Za-z_]\w*")
_FORBIDDEN = [(re.compile(r"`\s*include\b"), "`include is not allowed"),
              (re.compile(r"\binitial\b"), "initial blocks are not allowed"),
              (re.compile(r"\bmodule\s+(tb|mul18x18_reg|manudesk_harness)\b"), "reserved module name")]
_BUDGET_KEYS = {"DSP": "MULT18X18D", "FF": "TRELLIS_FF", "LUT": "TRELLIS_COMB"}


def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def latency_of(src: str) -> int | None:
    m = LATENCY_RE.search(_strip_comments(src))
    return int(m.group(1)) if m else None


def static_problems(src: str, d: Design) -> list[str]:
    code = _strip_comments(src)
    out = []
    if len(src) > MAX_SOURCE:
        out.append(f"source too large ({len(src)} > {MAX_SOURCE} chars)")
    if not re.search(rf"\bmodule\s+{re.escape(d.top)}\b", code):
        out.append(f"top module `{d.top}` missing")
    for rx, msg in _FORBIDDEN:
        if rx.search(code):
            out.append(msg)
    bad = sorted({s for s in _SYS_RE.findall(code) if s not in _ALLOWED_SYS})
    if bad:
        out.append(f"system tasks not allowed: {', '.join(bad[:5])}")
    lat = latency_of(src)
    if lat is None:
        out.append("missing `localparam LATENCY = <n>;` in the top module")
    elif lat < 1 or lat > d.latency_budget:
        out.append(f"LATENCY={lat} outside 1..{d.latency_budget}")
    return out


def _files(dirpath: Path, src: str) -> list[Path]:
    p = dirpath / "design.v"
    p.write_text(src, encoding="utf-8")
    files = [p]
    if "mul18x18_reg" in src:
        shutil.copyfile(LIB, dirpath / LIB.name)
        files.append(dirpath / LIB.name)
    return files


def _sim(src: str, d: Design, wd: Path) -> eda.Sim:
    wd.mkdir(parents=True, exist_ok=True)
    return eda.simulate(_files(wd, src), d.tb, wd)


def _with_latency(src: str, n: int) -> str:
    return LATENCY_RE.sub(f"localparam LATENCY = {n};", src, count=1)


def _true_latency(src: str, declared: int, d: Design, wd: Path) -> int | None:
    """If the testbench passes with another LATENCY, the datapath is right and only the declared number is wrong."""
    for delta in (1, -1, 2, -2, 3, -3):
        n = declared + delta
        if n >= 1 and _sim(_with_latency(src, n), d, wd / f"lat{n}").passed:
            return n
    return None


def harness(top: str, ports: dict) -> str:
    """Register every input and output so all logic is timed register to register. Without this, logic placed
    before the first register is an unconstrained I/O path that nextpnr leaves out of Fmax."""
    decl, body, conns = [], [], []
    for name, (direction, width) in ports.items():
        rng = f"[{width - 1}:0] " if width > 1 else ""
        if name == "clk":
            decl.append("input wire clk")
            conns.append(".clk(clk)")
        elif direction == "input":
            decl.append(f"input wire {rng}{name}_i")
            body.append(f"reg {rng}{name}_q; always @(posedge clk) {name}_q <= {name}_i;")
            conns.append(f".{name}({name}_q)")
        else:
            decl.append(f"output reg {rng}{name}_o")
            body.append(f"wire {rng}{name}_w; always @(posedge clk) {name}_o <= {name}_w;")
            conns.append(f".{name}({name}_w)")
    return (f"module manudesk_harness({', '.join(decl)});\n" + "\n".join(body) +
            f"\n{top} dut({', '.join(conns)});\nendmodule\n")


def _result(d: Design, stage: str, fix: list[str], **kw) -> dict:
    out = {"pass": False, "stage": stage, "fix": fix[:4]}
    out.update(kw)
    out.setdefault("target", d.target_mhz)
    out.setdefault("base", d.baseline_mhz)
    return out


_baseline_ports: dict[str, dict] = {}
_ports_lock = threading.Lock()


def _ports_for(d: Design) -> dict:
    with _ports_lock:
        if d.name not in _baseline_ports:
            wd = new_workdir(f"ports_{d.name}")
            syn = eda.synthesize(_files(wd, d.start), d.top, wd)
            _baseline_ports[d.name] = syn.ports
            shutil.rmtree(wd, ignore_errors=True)
        return _baseline_ports[d.name]


def run_check(name: str, verilog: str, keep: bool = False) -> dict:
    d = get(name)
    probs = static_problems(verilog, d)
    if probs:
        return _result(d, "static", probs)
    lat = latency_of(verilog)
    wd = new_workdir(f"chk_{name}")
    try:
        files = _files(wd, verilog)
        errs = eda.lint(files, d.top, wd)
        if errs:
            return _result(d, "lint", errs, lat=lat)

        sim = _sim(verilog, d, wd / "sim")
        if not sim.compiled:
            return _result(d, "sim", ["does not compile: " + e for e in sim.errors[:3]], lat=lat)
        if not sim.passed:
            fix = []
            true = _true_latency(verilog, lat, d, wd)
            if true is not None:
                fix.append(f"logic is correct but its real latency is {true}, not {lat}: set LATENCY = {true}"
                           + ("" if true <= d.latency_budget else f" (over budget {d.latency_budget}: drop a stage)"))
            elif sim.verdict == "TIMEOUT":
                fix.append("simulation timed out")
            else:
                fix.append("wrong outputs: " + ("; ".join(sim.mismatches[:2]) or sim.verdict or "no PASS line"))
                fix.append("check widths/signedness, reset values, and that every path has LATENCY registers")
            return _result(d, "sim", fix, lat=lat)

        mut = _sim(_with_latency(verilog, lat + 1), d, wd / "mut")
        if mut.passed:
            return _result(d, "mutation", ["output does not depend on LATENCY (constant or undriven output?)"],
                           lat=lat)

        syn = eda.synthesize(files, d.top, wd)
        if not syn.ok:
            return _result(d, "synth", syn.errors, lat=lat)
        want = _ports_for(d)
        if syn.ports != want:
            return _result(d, "ports", [f"ports changed: want {want}, got {syn.ports}"], lat=lat)

        hd = wd / "pnr"
        hd.mkdir()
        hfiles = _files(hd, verilog)
        (hd / "harness.v").write_text(harness(d.top, syn.ports), encoding="utf-8")
        hsyn = eda.synthesize([*hfiles, hd / "harness.v"], "manudesk_harness", hd)
        if not hsyn.ok:
            return _result(d, "synth", hsyn.errors, lat=lat)
        pnr = eda.place_and_route(hsyn.json_path, d.target_mhz, hd)
        if not pnr.ok:
            return _result(d, "pnr", pnr.errors, lat=lat)

        # resources: subtract the harness's own port registers from the FF count
        harness_ffs = sum(w for n, (_, w) in syn.ports.items() if n != "clk")
        use = {"LUT": pnr.used.get("TRELLIS_COMB", 0), "FF": max(0, pnr.used.get("TRELLIS_FF", 0) - harness_ffs),
               "DSP": pnr.used.get("MULT18X18D", 0)}
        over = [f"{k} {use[k]} > budget {lim}" for k, lim in d.resource_budget.items() if use.get(k, 0) > lim]
        speed = {"mhz": pnr.mhz, "x": round(pnr.mhz / d.baseline_mhz, 2), "lat": lat, "path": pnr.path.brief(),
                 "use": use}
        if over:
            return _result(d, "budget", ["over resource budget: " + ", ".join(over)], **speed)
        fix = []
        if pnr.mhz < d.target_mhz:
            fix.append(f"correct; {pnr.mhz} MHz is below target {d.target_mhz}: shorten the slowest path")
        return {"pass": True, "stage": "ok", "fix": fix, "mhz": pnr.mhz, "target": d.target_mhz,
                "base": d.baseline_mhz, **{k: v for k, v in speed.items() if k != "mhz"}}
    finally:
        if not keep:
            shutil.rmtree(wd, ignore_errors=True)


# ---------------------------------------------------------------- cache

_CACHE: OrderedDict[str, dict] = OrderedDict()
_CACHE_MAX = 512
_cache_lock = threading.Lock()


def check(name: str, verilog: str) -> dict:
    """Cached by (design, exact source): agents often resubmit the same file."""
    key = hashlib.sha256(f"{name}\0{verilog}".encode()).hexdigest()
    with _cache_lock:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return dict(_CACHE[key])
    out = run_check(name, verilog)
    with _cache_lock:
        _CACHE[key] = out
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return dict(out)


def main() -> int:
    import sys
    name, path = sys.argv[1], sys.argv[2]
    print(json.dumps(check(name, Path(path).read_text(encoding="utf-8")), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
