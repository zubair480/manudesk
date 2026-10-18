"""Checker tests. The rejection paths run on a faked tool flow (instant, no OSS CAD Suite); the `tools` ones run
the real flow (skipped when the OSS CAD Suite is not installed)."""
from __future__ import annotations

import json

import pytest

from manudesk import checker, eda
from manudesk.designs import all_designs, get
from manudesk.toolchain import tools_dir

try:
    tools_dir()
    HAVE_TOOLS = True
except FileNotFoundError:
    HAVE_TOOLS = False
tools = pytest.mark.skipif(not HAVE_TOOLS, reason="OSS CAD Suite not installed")

POP = get("popcount")
POP_PORTS = {"clk": ["input", 1], "rst": ["input", 1], "din": ["input", 256], "count": ["output", 9]}
REPORT_KEYS = {"accepted", "stage_reached", "reasons", "fmax_mhz", "baseline_mhz", "vs_baseline", "latency",
               "critical_path", "resources", "budgets", "seconds"}


def test_designs_load():
    ds = all_designs()
    assert {"mac", "fir8", "crc32", "popcount", "add64cmp", "mandel_step"} <= set(ds)
    for d in ds.values():
        assert checker.latency_of(d.start) is not None
        assert d.tb.exists()
        assert not checker.static_problems(d.start, d), d.name


def test_popcount_seed_matches_the_spec():
    assert checker.latency_of(POP.start) == 2 and POP.latency_budget == 6
    assert POP.budgets == {"TRELLIS_FF": 2000, "TRELLIS_COMB": 3000} and 60 <= POP.baseline_mhz <= 75


@pytest.mark.parametrize("src,needle", [
    ("module mac(input clk); localparam LATENCY = 2; initial $display(1); endmodule", "initial"),
    ("module mac(input clk); localparam LATENCY = 2; wire x = $fopen(\"f\"); endmodule", "$fopen"),
    ("`include \"tb.v\"\nmodule mac(input clk); localparam LATENCY = 2; endmodule", "include"),
    ("module mac(input clk); endmodule", "LATENCY"),
    ("module mac(input clk); localparam LATENCY = 99; endmodule", "outside"),
    ("module other(input clk); localparam LATENCY = 2; endmodule", "top module"),
    ("module mac(input clk); localparam LATENCY = 2; endmodule\nmodule tb; endmodule", "reserved"),
])
def test_static_rejects(src, needle):
    probs = checker.static_problems(src, get("mac"))
    assert any(needle in p for p in probs), probs


def test_comments_do_not_count():
    src = get("mac").start.replace("localparam LATENCY = 2;", "// localparam LATENCY = 2;\n/* $system */")
    probs = checker.static_problems(src, get("mac"))
    assert any("LATENCY" in p for p in probs) and not any("$system" in p for p in probs)


def test_harness_registers_every_port():
    h = checker.harness("mac", {"clk": ["input", 1], "a": ["input", 32], "acc": ["output", 64]})
    assert "a_q <= a_i" in h and "acc_o <= acc_w" in h and "mac dut(" in h


# ---------------------------------------------------------------- faked flow: every rejection path

class Flow:
    """Stand-ins for the EDA tools. `sim(src)` decides whether the testbench passes for a candidate source."""

    def __init__(self):
        self.ports = dict(POP_PORTS)
        self.sim = lambda src: checker.latency_of(src) == 2   # popcount's start.v is right at LATENCY 2
        self.used = {"TRELLIS_FF": 300 + 266, "TRELLIS_COMB": 900, "TRELLIS_IO": 268, "DCCA": 1}
        self.mhz = 231.4
        self.calls: list[str] = []


@pytest.fixture
def flow(monkeypatch, tmp_path):
    f = Flow()
    monkeypatch.setenv("MANUDESK_WORK", str(tmp_path))
    monkeypatch.setattr(checker, "_ports_for", lambda d: dict(POP_PORTS))

    def lint(files, top, cwd, timeout=60):
        f.calls.append("lint")
        return []

    def ports(src, top, cwd, timeout=60):
        f.calls.append("ports")
        return dict(f.ports), []

    def simulate(files, tb, cwd, timeout=60):
        f.calls.append("sim")
        ok = f.sim(files[0].read_text(encoding="utf-8"))
        return eda.Sim(True, ok, "PASS" if ok else "FAIL errors=12",
                       [] if ok else ["MISMATCH cycle 3: count=17 ref=18"])

    def synthesize(files, top, cwd, timeout=180):
        f.calls.append("synth")
        return eda.Synth(True, cwd / "synth.json", dict(f.ports))

    def place_and_route(netlist, freq, cwd, seed=1, timeout=300, write_routed=False):
        f.calls.append("pnr")
        path = eda.Path_(start="dut.s1[0]", end="dut.s2[3]", ns=4.3, logic_ns=1.9, route_ns=1.9, clk_q_ns=0.5,
                         segments=9, hops=4, labels={"LUT4(lut)": 4}, sources=["design.v:14.9-14.20"])
        return eda.Pnr(True, f.mhz, path, dict(f.used))

    for name, fn in [("lint", lint), ("ports", ports), ("simulate", simulate), ("synthesize", synthesize),
                     ("place_and_route", place_and_route)]:
        monkeypatch.setattr(checker.eda, name, fn)
    return f


def _report(src):
    return checker.report(checker.run_check("popcount", src), POP)


def test_accepted_report_has_every_field(flow):
    out = _report(POP.start)
    assert set(out) == REPORT_KEYS
    assert out["accepted"] and out["stage_reached"] == "done" and out["reasons"] == []
    assert out["fmax_mhz"] == 231.4 and out["vs_baseline"] == f"{231.4 / POP.baseline_mhz:.2f}x"
    assert out["latency"] == 2 and out["budgets"] == POP.budgets
    # the harness's 266 port registers are not counted against the design
    assert out["resources"] == {"TRELLIS_FF": 300, "TRELLIS_COMB": 900, "MULT18X18D": 0, "TRELLIS_IO": 268,
                                "DCCA": 1}
    assert out["critical_path"].startswith("critical path dut.s1[0] -> dut.s2[3]: 4.30 ns over 9 segments / 4 logic hops")
    assert "design.v:14.9-14.20" in out["critical_path"]
    assert flow.calls == ["lint", "ports", "sim", "sim", "synth", "pnr"]


def test_reject_wrong_ports(flow):
    flow.ports["count"] = ["output", 10]
    out = _report(POP.start)
    assert not out["accepted"] and out["stage_reached"] == "interface"
    assert "count" in out["reasons"][0]["what"] and "header" in out["reasons"][0]["fix"]
    assert "sim" not in flow.calls  # stops before the testbench


def test_reject_missing_port(flow):
    del flow.ports["rst"]
    out = _report(POP.start)
    assert out["stage_reached"] == "interface" and "`rst`" in out["reasons"][0]["what"]


def test_reject_missing_latency(flow):
    out = _report(POP.start.replace("localparam LATENCY = 2;", ""))
    assert not out["accepted"] and out["stage_reached"] == "interface"
    assert "LATENCY" in out["reasons"][0]["what"] and "declare" in out["reasons"][0]["fix"]
    assert "sim" not in flow.calls


def test_reject_latency_over_budget(flow):
    out = _report(POP.start.replace("localparam LATENCY = 2;", "localparam LATENCY = 7;"))
    assert out["stage_reached"] == "interface" and "latency_budget" in out["reasons"][0]["what"]


def test_reject_overstated_latency(flow):
    flow.sim = lambda src: True  # a constant-looking output: passes with LATENCY and with LATENCY+1
    out = _report(POP.start)
    assert not out["accepted"] and out["stage_reached"] == "latency_check"
    assert "LATENCY is overstated" in out["reasons"][0]["what"]
    assert "synth" not in flow.calls


def test_reject_testbench_failure(flow):
    flow.sim = lambda src: False
    out = _report(POP.start)
    assert not out["accepted"] and out["stage_reached"] == "testbench"
    assert "wrong outputs" in out["reasons"][0]["what"] and out["reasons"][0]["fix"]
    assert "synth" not in flow.calls


def test_testbench_diagnoses_the_true_latency(flow):
    flow.sim = lambda src: checker.latency_of(src) == 3
    out = _report(POP.start.replace("localparam LATENCY = 2;", "localparam LATENCY = 4;"))
    assert out["stage_reached"] == "testbench" and out["reasons"][0]["fix"] == "set LATENCY = 3"


def test_reject_over_budget(flow):
    flow.used["TRELLIS_COMB"] = 3412
    out = _report(POP.start)
    assert not out["accepted"] and out["stage_reached"] == "resources"
    assert out["reasons"][0]["what"] == "TRELLIS_COMB 3412 > budget 3000" and out["reasons"][0]["fix"]
    assert out["fmax_mhz"] == 231.4  # the speed is still reported


def test_reject_lint_sandbox(flow):
    out = _report(POP.start.replace("integer k;", "integer k; initial k = 0;"))
    assert out["stage_reached"] == "lint" and "initial" in out["reasons"][0]["what"]
    assert flow.calls == []


def test_compact_view_keeps_the_legacy_keys(flow):
    r = checker.run_check("popcount", POP.start)
    c = checker.compact(r, POP)
    assert c["pass"] and c["stage"] == "ok" and c["mhz"] == 231.4 and c["use"] == {"LUT": 900, "FF": 300, "DSP": 0}
    r = checker.run_check("popcount", POP.start.replace("localparam LATENCY = 2;", ""))
    assert checker.compact(r, POP)["stage"] == "static"


# ---------------------------------------------------------------- report.json parsing

def test_critical_path_from_report_and_routed_netlist():
    report = {"fmax": {"$glbnet$clk": {"achieved": 151.2, "constraint": 300}},
              "utilization": {"TRELLIS_FF": {"used": 10, "available": 83640}},
              "critical_paths": [{"from": "posedge $glbnet$clk", "to": "posedge $glbnet$clk", "path": [
                  {"type": "clk-to-q", "delay": 0.53, "from": {"cell": "ffa", "port": "Q"}, "to": {"cell": "ffa"}},
                  {"type": "routing", "delay": 1.2, "net": "dut.s4[3]", "sources": ["/w/design.v:11.15-11.17"],
                   "from": {"cell": "ffa"}, "to": {"cell": "c1"}},
                  {"type": "logic", "delay": 0.4, "from": {"cell": "c1"}, "to": {"cell": "c1"}},
                  {"type": "routing", "delay": 0.9, "net": "n2", "sources": [], "from": {"cell": "c1"},
                   "to": {"cell": "c2"}},
                  {"type": "logic", "delay": 0.3, "from": {"cell": "c2"}, "to": {"cell": "c2"}},
                  {"type": "routing", "delay": 0.4, "net": "n3", "sources": [], "from": {"cell": "c2"},
                   "to": {"cell": "ffb"}},
                  {"type": "setup", "delay": 0.0, "from": {"cell": "ffb"}, "to": {"cell": "ffb"}}]}]}
    routed = {"modules": {"top": {
        "cells": {"ffa": {"type": "TRELLIS_FF", "connections": {"Q": [5]}},
                  "c1": {"type": "TRELLIS_COMB", "attributes": {"src": "/w/design.v:12.3-12.9|/share/x.v:1.1-1.2"}},
                  "c2": {"type": "MULT18X18D", "attributes": {"src": "/w/harness.v:3.1-3.4"}},
                  "ffb": {"type": "TRELLIS_FF", "connections": {"Q": [9]}}},
        "netnames": {"dut.s4": {"bits": [2, 3, 4, 5], "hide_name": 0},
                     "dut.s5": {"bits": [9, 10], "hide_name": 0}}}}}
    pnr = eda.parse_report(report, routed=routed)
    assert pnr.ok and pnr.mhz == 151.2
    s = pnr.path.describe()
    assert s.startswith("critical path dut.s4[3] -> dut.s5[0]: 3.73 ns over 7 segments / 2 logic hops "
                        "(logic 0.70 ns, routing 2.50 ns, clk-to-q 0.53, setup 0.00)")
    assert "cells on path: " in s and "MULT18X18D(dsp) x1" in s
    assert "Verilog sources: design.v:11.15-11.17, design.v:12.3-12.9" in s and "harness" not in s


def test_harness_port_start_is_called_out():
    p = eda.Path_(start="din_q[7]", end="dut.count_r[0]", ns=3.0, segments=3, hops=1)
    assert "input port" in p.describe()


# ---------------------------------------------------------------- real flow

@tools
def test_baseline_is_accepted():
    out = checker.report(checker.run_check("popcount", POP.start), POP)
    assert out["accepted"] and out["stage_reached"] == "done" and out["fmax_mhz"] > 40
    assert out["critical_path"].startswith("critical path ") and "design.v:" in out["critical_path"]
    assert out["seconds"] < 120
    assert len(json.dumps(out, separators=(",", ":"))) < 1500  # agents pay per token


@tools
@pytest.mark.parametrize("name", sorted(all_designs()))
def test_every_mutant_is_caught(name):
    d = get(name)
    for m in d.mutants:
        assert m["find"] in d.start, (name, m["name"])
        out = checker.run_check(name, d.start.replace(m["find"], m["replace"], 1))
        assert not out["accepted"], (name, m["name"], out)


@tools
def test_wrong_latency_is_diagnosed():
    src = get("mac").start.replace("localparam LATENCY = 2;", "localparam LATENCY = 3;")
    out = checker.run_check("mac", src)
    assert out["stage_reached"] == "testbench" and out["reasons"][0]["fix"] == "set LATENCY = 2"


@tools
def test_port_change_rejected():
    src = POP.start.replace("output wire [8:0]   count", "output wire [9:0]   count") \
        .replace("reg [8:0]   count_r;", "reg [9:0]   count_r;")
    out = checker.run_check("popcount", src)
    assert not out["accepted"] and out["stage_reached"] == "interface"
