"""check(name, verilog): the hardware feedback an agent cannot get on its own.

Stages, in order; the first failure stops the check:
  lint        sandbox rules (no initial, $system tasks, `include) + Verilator lint
  interface   top module and ports unchanged (yosys parse, no synthesis), LATENCY declared and within budget
  testbench   the hidden testbench: random vectors + edge cases against a golden model delayed by LATENCY
  latency_check  rerun with LATENCY+1: if it still passes, LATENCY is overstated
  synth       yosys synth_ecp5
  pnr         nextpnr-ecp5 --85k --speed 6 inside a harness that registers every port
  resources   use within the design's budget

Every reason says what failed and how to fix it. The whole check runs in its own temporary directory under a
~120 s deadline. `report()` is the MCP view; `compact()` is the short legacy view that /api/check, the md_checks
log and the edge functions read.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
from collections import OrderedDict
from pathlib import Path

from manudesk import eda
from manudesk.designs import LIB, Design, get
from manudesk.toolchain import new_workdir

MAX_SOURCE = 200_000
CHECK_TIMEOUT = float(os.environ.get("MANUDESK_CHECK_TIMEOUT", "120"))
# nextpnr's --freq: well above any design's reach, so timing-driven placement always pushes as hard as it can.
PNR_FREQ = float(os.environ.get("MANUDESK_PNR_FREQ", "300"))
LATENCY_RE = re.compile(r"localparam\s+(?:integer\s+)?LATENCY\s*=\s*(\d+)\s*;")
# Anything that could touch the host filesystem or the testbench from inside a simulation.
_ALLOWED_SYS = {"$signed", "$unsigned", "$clog2", "$bits"}
_SYS_RE = re.compile(r"\$[A-Za-z_]\w*")
_FORBIDDEN = [(re.compile(r"`\s*include\b"), "`include is not allowed", "inline what you need in this one file"),
              (re.compile(r"\binitial\b"), "initial blocks are not allowed",
               "give registers their start value through the synchronous rst instead"),
              (re.compile(r"\bmodule\s+(tb|mul18x18_reg|manudesk_harness)\b"), "a reserved module name is defined",
               "rename that module; mul18x18_reg is provided and must not be redefined")]
RESOURCE_KEYS = ("TRELLIS_FF", "TRELLIS_COMB", "MULT18X18D", "TRELLIS_IO", "DCCA")
_LEGACY_STAGE = {"lint": "lint", "interface": "ports", "testbench": "sim", "latency_check": "mutation",
                 "synth": "synth", "pnr": "pnr", "resources": "budget", "done": "ok"}
_LEGACY_USE = {"TRELLIS_COMB": "LUT", "TRELLIS_FF": "FF", "MULT18X18D": "DSP"}


class _Deadline:
    def __init__(self, seconds: float):
        self.t0 = time.monotonic()
        self.end = self.t0 + seconds

    def left(self) -> float:
        return max(1.0, self.end - time.monotonic())

    def spent(self) -> float:
        return round(time.monotonic() - self.t0, 1)


def R(what: str, fix: str) -> dict:
    return {"what": what, "fix": fix}


def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def latency_of(src: str) -> int | None:
    m = LATENCY_RE.search(_strip_comments(src))
    return int(m.group(1)) if m else None


def sandbox_problems(src: str) -> list[dict]:
    code = _strip_comments(src)
    out = []
    if len(src) > MAX_SOURCE:
        out.append(R(f"source too large ({len(src)} > {MAX_SOURCE} chars)", "submit one Verilog file under the limit"))
    for rx, what, fix in _FORBIDDEN:
        if rx.search(code):
            out.append(R(what, fix))
    bad = sorted({s for s in _SYS_RE.findall(code) if s not in _ALLOWED_SYS})
    if bad:
        out.append(R(f"system tasks not allowed: {', '.join(bad[:5])}",
                     "remove them; only $signed, $unsigned, $clog2 and $bits are allowed"))
    return out


def latency_problems(src: str, d: Design) -> list[dict]:
    lat = latency_of(src)
    if lat is None:
        return [R(f"`localparam LATENCY = <n>;` is missing from module {d.top}",
                  f"declare it inside module {d.top}, n = clock cycles from an input to the output it produces")]
    if lat < 1 or lat > d.latency_budget:
        return [R(f"LATENCY = {lat} is outside 1..{d.latency_budget} (latency_budget)",
                  f"use between 1 and {d.latency_budget} register stages from input to output")]
    return []


def static_problems(src: str, d: Design) -> list[str]:
    """Every check that needs no tools, as text (sandbox, top module present, LATENCY)."""
    probs = sandbox_problems(src)
    if not re.search(rf"\bmodule\s+{re.escape(d.top)}\b", _strip_comments(src)):
        probs.append(R(f"top module `{d.top}` missing", f"keep `module {d.top}` with its original ports"))
    probs += latency_problems(src, d)
    return [f"{p['what']}: {p['fix']}" for p in probs]


def port_diff(want: dict, got: dict) -> list[dict]:
    fix = "restore the original module header exactly (names, directions, widths); change only the inside"
    out = []
    for n, (dirn, w) in want.items():
        if n not in got:
            out.append(R(f"port `{n}` ({dirn} [{w - 1}:0]) is missing", fix))
        elif got[n] != [dirn, w]:
            out.append(R(f"port `{n}` is {got[n][0]} [{got[n][1] - 1}:0], the original is {dirn} [{w - 1}:0]", fix))
    for n in got:
        if n not in want:
            out.append(R(f"port `{n}` was added", fix))
    return out


def _files(dirpath: Path, src: str) -> list[Path]:
    p = dirpath / "design.v"
    p.write_text(src, encoding="utf-8")
    files = [p]
    if "mul18x18_reg" in src:
        shutil.copyfile(LIB, dirpath / LIB.name)
        files.append(dirpath / LIB.name)
    return files


def _sim(src: str, d: Design, wd: Path, timeout: float = 60) -> eda.Sim:
    wd.mkdir(parents=True, exist_ok=True)
    return eda.simulate(_files(wd, src), d.tb, wd, timeout=timeout)


def _with_latency(src: str, n: int) -> str:
    return LATENCY_RE.sub(f"localparam LATENCY = {n};", src, count=1)


def _true_latency(src: str, declared: int, d: Design, wd: Path, dl: _Deadline) -> int | None:
    """If the testbench passes with another LATENCY, the datapath is right and only the declared number is wrong."""
    for delta in (1, -1, 2, -2, 3, -3):
        n = declared + delta
        if dl.end - time.monotonic() < 10:
            return None
        if n >= 1 and _sim(_with_latency(src, n), d, wd / f"lat{n}", min(30, dl.left())).passed:
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


_baseline_ports: dict[str, dict] = {}
_ports_lock = threading.Lock()


def _ports_for(d: Design) -> dict:
    with _ports_lock:
        if d.name not in _baseline_ports:
            wd = new_workdir(f"ports_{d.name}")
            try:
                got, errs = eda.ports(_files(wd, d.start)[0], d.top, wd)
            finally:
                shutil.rmtree(wd, ignore_errors=True)
            if got is None:
                raise RuntimeError(f"cannot read the ports of the original {d.name}: {errs}")
            _baseline_ports[d.name] = got
        return _baseline_ports[d.name]


def run_check(name: str, verilog: str, keep: bool = False) -> dict:
    """The internal result: report()/compact() turn it into what clients see."""
    d = get(name)
    dl = _Deadline(CHECK_TIMEOUT)
    r = {"accepted": False, "stage_reached": "lint", "reasons": [], "fmax_mhz": None, "latency": latency_of(verilog),
         "critical_path": None, "resources": None, "seconds": 0.0, "_path": None}

    def stop(stage: str, reasons: list[dict]) -> dict:
        r.update(stage_reached=stage, reasons=reasons[:4], seconds=dl.spent())
        return r

    probs = sandbox_problems(verilog)
    if probs:
        return stop("lint", probs)
    if not re.search(rf"\bmodule\s+{re.escape(d.top)}\b", _strip_comments(verilog)):
        return stop("interface", [R(f"top module `{d.top}` missing", f"keep `module {d.top}` with its original ports")])
    wd = new_workdir(f"chk_{name}")
    try:
        files = _files(wd, verilog)
        # a. lint and parse
        errs = eda.lint(files, d.top, wd, timeout=min(60, dl.left()))
        if errs:
            return stop("lint", [R(e, "fix this line; the file must be plain synthesizable Verilog-2005")
                                 for e in errs])

        # b. interface: ports, LATENCY present and within budget
        got, errs = eda.ports(files[0], d.top, wd, timeout=min(60, dl.left()))
        if got is None:
            return stop("lint", [R(e, "fix the parse error at that line") for e in errs])
        diff = port_diff(_ports_for(d), got)
        if diff:
            return stop("interface", diff)
        probs = latency_problems(verilog, d)
        if probs:
            return stop("interface", probs)
        lat = r["latency"]

        # c. hidden testbench
        sim = _sim(verilog, d, wd / "sim", min(60, dl.left()))
        if not sim.compiled:
            return stop("testbench", [R("does not compile in simulation: " + e,
                                        "fix that construct; plain Verilog-2005 only") for e in sim.errors[:3]])
        if not sim.passed:
            true = _true_latency(verilog, lat, d, wd, dl)
            if true is not None:
                fix = f"set LATENCY = {true}"
                if true > d.latency_budget:
                    fix += f", then remove {true - d.latency_budget} register stage(s) to fit latency_budget"
                return stop("testbench", [R(f"outputs are correct but arrive {true} cycles after the input, "
                                            f"not LATENCY = {lat}", fix)])
            if sim.verdict == "TIMEOUT":
                return stop("testbench", [R("simulation timed out", "remove combinational loops or runaway logic")])
            what = "wrong outputs: " + ("; ".join(sim.mismatches[:2]) or sim.verdict or "no verdict")
            return stop("testbench", [R(what, "check widths, signedness and reset values, and that every input "
                                              "reaches the output through exactly LATENCY registers")])

        # d. latency mutation
        mut = _sim(_with_latency(verilog, lat + 1), d, wd / "mut", min(60, dl.left()))
        if mut.passed:
            return stop("latency_check", [R(f"LATENCY is overstated: the output still passes with LATENCY = {lat + 1}",
                                            "drive the output from the datapath (not a constant or a held value) "
                                            "and declare the true input-to-output cycle count")])

        # e. synthesis (yosys synth_ecp5 of the design inside its harness: one run covers both) and
        # f. place and route
        hd = wd / "pnr"
        hd.mkdir()
        hfiles = _files(hd, verilog)
        (hd / "harness.v").write_text(harness(d.top, got), encoding="utf-8")
        hsyn = eda.synthesize([*hfiles, hd / "harness.v"], "manudesk_harness", hd, timeout=dl.left())
        if not hsyn.ok:
            return stop("synth", [R(e, "make that construct synthesizable for yosys synth_ecp5") for e in hsyn.errors])
        pnr = eda.place_and_route(hsyn.json_path, PNR_FREQ, hd, timeout=dl.left(), write_routed=True)
        if not pnr.ok:
            return stop("pnr", [R(e, "reduce the design so it places and routes on the ECP5-85F")
                                for e in pnr.errors])

        # g. resources: the harness's own port registers are not the agent's
        harness_ffs = sum(w for n, (_, w) in got.items() if n != "clk")
        use = {k: pnr.used.get(k, 0) for k in RESOURCE_KEYS}
        use["TRELLIS_FF"] = max(0, use["TRELLIS_FF"] - harness_ffs)
        r.update(fmax_mhz=pnr.mhz, critical_path=pnr.path.describe() or None, resources=use, _path=pnr.path.brief())
        over = [R(f"{k} {use[k]} > budget {lim}", _over_fix(k)) for k, lim in d.budgets.items() if use.get(k, 0) > lim]
        if over:
            return stop("resources", over)
        r["accepted"] = True
        return stop("done", [])
    finally:
        if not keep:
            shutil.rmtree(wd, ignore_errors=True)


def _over_fix(key: str) -> str:
    return {"TRELLIS_FF": "drop pipeline registers you do not need, or narrow the ones you keep",
            "TRELLIS_COMB": "share logic, narrow intermediate widths, or move multiplies onto mul18x18_reg",
            "MULT18X18D": "use fewer multiplies (share one, or do small ones in logic)"}.get(key, "use fewer of them")


def report(r: dict, d: Design) -> dict:
    """The MCP check result."""
    x = round(r["fmax_mhz"] / d.baseline_mhz, 2) if r.get("fmax_mhz") else None
    return {"accepted": r["accepted"], "stage_reached": r["stage_reached"], "reasons": r["reasons"],
            "fmax_mhz": r["fmax_mhz"], "baseline_mhz": d.baseline_mhz, "vs_baseline": f"{x:.2f}x" if x else None,
            "latency": r["latency"], "critical_path": r["critical_path"], "resources": r["resources"],
            "budgets": d.budgets, "seconds": r["seconds"]}


def compact(r: dict, d: Design) -> dict:
    """The short legacy view: {pass, stage, fix[], mhz, target, base, x, lat, path, use}."""
    stage = _LEGACY_STAGE[r["stage_reached"]]
    if r["stage_reached"] == "interface" and any("LATENCY" in x["what"] or "top module" in x["what"]
                                                 for x in r["reasons"]):
        stage = "static"
    out = {"pass": r["accepted"], "stage": stage, "fix": [f"{x['what']}: {x['fix']}" for x in r["reasons"]],
           "target": d.target_mhz, "base": d.baseline_mhz}
    if r["latency"] is not None and stage not in ("static", "lint"):
        out["lat"] = r["latency"]
    if r.get("fmax_mhz"):
        use = r["resources"] or {}
        out.update(mhz=r["fmax_mhz"], x=round(r["fmax_mhz"] / d.baseline_mhz, 2), path=r["_path"],
                   use={short: use.get(k, 0) for k, short in _LEGACY_USE.items()})
        if r["accepted"] and r["fmax_mhz"] < d.target_mhz:
            out["fix"] = [f"correct; {r['fmax_mhz']} MHz is below target {d.target_mhz}: shorten the slowest path"]
    return out


# ---------------------------------------------------------------- cache

_CACHE: OrderedDict[str, dict] = OrderedDict()
_CACHE_MAX = 512
_cache_lock = threading.Lock()


def cached(name: str, verilog: str) -> dict:
    """run_check, cached by (design, exact source): agents often resubmit the same file."""
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


def check(name: str, verilog: str) -> dict:
    """Legacy compact view (built-in agent, /api/check)."""
    return compact(cached(name, verilog), get(name))


def main() -> int:
    import sys
    name, path = sys.argv[1], sys.argv[2]
    print(json.dumps(report(cached(name, Path(path).read_text(encoding="utf-8")), get(name)), indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
