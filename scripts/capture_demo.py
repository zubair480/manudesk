"""Run the real flow on popcount (baseline, a wrong first try, the fixed fast version) and save every tool's
output to demo/data.json for the web walkthrough. Nothing in the page is made up: it all comes from here.

    uv run python scripts/capture_demo.py
"""
from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path

from manudesk import checker, eda
from manudesk.designs import get
from manudesk.toolchain import REPO, new_workdir, run, tool

D = get("popcount")
FAST = (REPO / "demo" / "popcount_fast.v").read_text(encoding="utf-8")
WRONG = FAST.replace("localparam LATENCY = 5;", "localparam LATENCY = 4;")
OUT = REPO / "demo" / "data.json"

DUMP = """module manudesk_dump;
initial begin $dumpfile("wave.vcd"); $dumpvars(1, tb.dut); #(10*26) $dumpoff; end
endmodule
"""


def parse_vcd(text: str, want: list[str]) -> dict:
    ids, widths, vals, t = {}, {}, {}, 0
    for m in re.finditer(r"\$var\s+\w+\s+(\d+)\s+(\S+)\s+(\S+)", text):
        w, ident, name = int(m.group(1)), m.group(2), m.group(3)
        if name in want and ident not in ids:
            ids[ident], widths[name] = name, w
            vals[name] = []
    body = text.split("$enddefinitions", 1)[1]
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        if line[0] == "#":
            t = int(line[1:])
        elif line[0] in "01xz" and line[1:] in ids:
            vals[ids[line[1:]]].append([t, line[0]])
        elif line[0] == "b":
            v, ident = line[1:].split()
            if ident in ids:
                h = hex(int(v, 2))[2:] if set(v) <= {"0", "1"} else "x"
                vals[ids[ident]].append([t, h])
    return {"width": widths, "changes": vals}


def sim_wave(src: str) -> dict:
    wd = new_workdir("demo_sim")
    (wd / "design.v").write_text(src, encoding="utf-8")
    (wd / "dump.v").write_text(DUMP, encoding="utf-8")
    shutil.copyfile(D.tb, wd / "tb.v")
    t0 = time.time()
    rc, out = run([tool("iverilog"), "-g2012", "-o", "sim.vvp", "-s", "tb", "-s", "manudesk_dump",
                   "tb.v", "design.v", "dump.v"], wd, 60)
    rc, out = run([tool("vvp"), "-n", "sim.vvp"], wd, 60)
    secs = round(time.time() - t0, 2)
    wave = parse_vcd((wd / "wave.vcd").read_text(), ["clk", "rst", "din", "count", "din_r", "count_r"])
    lines = [l.strip() for l in out.splitlines() if l.strip().startswith(("PASS", "FAIL", "MISMATCH"))]
    return {"lines": lines, "wave": wave, "seconds": secs, "cmd": "iverilog -g2012 tb.v design.v && vvp -n sim.vvp"}


def lint(src: str) -> dict:
    wd = new_workdir("demo_lint")
    (wd / "design.v").write_text(src, encoding="utf-8")
    t0 = time.time()
    errs = eda.lint([wd / "design.v"], D.top, wd)
    return {"errors": errs, "seconds": round(time.time() - t0, 2),
            "cmd": "verilator --lint-only --top-module popcount design.v"}


def synth_stats(src: str) -> dict:
    wd = new_workdir("demo_syn")
    (wd / "design.v").write_text(src, encoding="utf-8")
    t0 = time.time()
    run([tool("yosys"), "-q", "-p", f"read_verilog -sv design.v; synth_ecp5 -top {D.top}; "
         "tee -q -o stat.json stat -json"], wd, 180)
    st = json.loads((wd / "stat.json").read_text())
    mods = st.get("modules", {})
    cells = next(iter(mods.values()))["num_cells_by_type"] if mods else st["design"]["num_cells_by_type"]
    return {"cells": cells, "seconds": round(time.time() - t0, 2),
            "cmd": "yosys -p 'read_verilog design.v; synth_ecp5 -top popcount; stat'"}


def pnr(src: str) -> dict:
    """Synthesize inside the port-register harness and place and route, keeping placement for the floorplan."""
    wd = new_workdir("demo_pnr")
    (wd / "design.v").write_text(src, encoding="utf-8")
    syn = eda.synthesize([wd / "design.v"], D.top, wd)
    (wd / "harness.v").write_text(checker.harness(D.top, syn.ports), encoding="utf-8")
    hs = eda.synthesize([wd / "design.v", wd / "harness.v"], "manudesk_harness", wd)
    t0 = time.time()
    run([tool("nextpnr-ecp5"), *eda.DEVICE, "--json", hs.json_path.name, "--freq", f"{D.target_mhz:g}",
         "--seed", "1", "--timing-allow-fail", "--lpf-allow-unconstrained", "--report", "report.json",
         "--write", "routed.json", "-q"], wd, 300)
    secs = round(time.time() - t0, 2)
    rep = json.loads((wd / "report.json").read_text())
    parsed = eda.parse_report(rep)
    routed = json.loads((wd / "routed.json").read_text())
    cells = []
    for name, c in routed["modules"]["top"]["cells"].items():
        bel = c.get("attributes", {}).get("NEXTPNR_BEL", "")
        m = re.match(r"X(\d+)/Y(\d+)/(\w+)", bel)
        if m:
            kind = "ff" if c["type"] == "TRELLIS_FF" else "carry" if c["type"] == "CCU2C" else \
                "lut" if c["type"] in ("TRELLIS_COMB", "LUT4") else "io" if "IO" in c["type"] else "other"
            cells.append([int(m.group(1)), int(m.group(2)), kind])
    clock, _ = min(rep["fmax"].items(), key=lambda kv: kv[1].get("achieved", 0))
    crit = max((cp for cp in rep["critical_paths"] if clock in cp["from"] and clock in cp["to"]),
               key=lambda cp: sum(s["delay"] for s in cp["path"]))
    path = []
    for s in crit["path"]:
        loc = s.get("from", {}).get("loc")
        path.append({"type": s["type"], "delay": round(s["delay"], 3), "loc": loc,
                     "to": s.get("to", {}).get("loc")})
    return {"mhz": parsed.mhz, "path_brief": parsed.path.brief(), "path": path, "cells": cells,
            "used": parsed.used, "avail": {k: parsed.avail.get(k, 0) for k in parsed.used},
            "seconds": secs, "part": eda.PART,
            "cmd": "nextpnr-ecp5 --85k --package CABGA381 --speed 6 --freq 105 --report report.json"}


def main() -> None:
    t0 = time.time()
    data = {
        "design": {"name": D.name, "summary": D.summary, "limits": D.limits(), "rules": None},
        "baseline": {"verilog": D.start, "check": checker.run_check(D.name, D.start),
                     "synth": synth_stats(D.start), "pnr": pnr(D.start)},
        "try1": {"verilog": WRONG, "check": checker.run_check(D.name, WRONG), "sim": sim_wave(WRONG)},
        "fast": {"verilog": FAST, "lint": lint(FAST), "sim": sim_wave(FAST), "synth": synth_stats(FAST),
                 "pnr": pnr(FAST), "check": checker.run_check(D.name, FAST)},
        "captured": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB) in {time.time() - t0:.0f}s")
    for k in ("baseline", "try1", "fast"):
        print(k, json.dumps(data[k]["check"]))


if __name__ == "__main__":
    main()
