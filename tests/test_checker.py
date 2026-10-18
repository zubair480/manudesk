"""Checker tests. Static and harness tests are instant; the `tools` ones run the real flow (skipped when the
OSS CAD Suite is not installed)."""
from __future__ import annotations

import json

import pytest

from manudesk import checker
from manudesk.designs import all_designs, get
from manudesk.toolchain import tools_dir

try:
    tools_dir()
    HAVE_TOOLS = True
except FileNotFoundError:
    HAVE_TOOLS = False
tools = pytest.mark.skipif(not HAVE_TOOLS, reason="OSS CAD Suite not installed")


def test_designs_load():
    ds = all_designs()
    assert {"mac", "fir8", "crc32", "popcount", "add64cmp", "mandel_step"} <= set(ds)
    for d in ds.values():
        assert checker.latency_of(d.start) is not None
        assert d.tb.exists()
        assert not checker.static_problems(d.start, d), d.name


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


@tools
def test_baseline_passes_and_is_short():
    out = checker.run_check("mac", get("mac").start)
    assert out["pass"] and out["stage"] == "ok" and out["mhz"] > 50
    assert set(out) >= {"fix", "mhz", "target", "base", "x", "lat", "path", "use"}
    assert len(json.dumps(out, separators=(",", ":"))) < 600  # agents pay per token


@tools
@pytest.mark.parametrize("name", sorted(all_designs()))
def test_every_mutant_is_caught(name):
    d = get(name)
    for m in d.mutants:
        assert m["find"] in d.start, (name, m["name"])
        out = checker.run_check(name, d.start.replace(m["find"], m["replace"], 1))
        assert not out["pass"], (name, m["name"], out)


@tools
def test_wrong_latency_is_diagnosed():
    src = get("mac").start.replace("localparam LATENCY = 2;", "localparam LATENCY = 3;")
    out = checker.run_check("mac", src)
    assert out["stage"] == "sim" and "LATENCY = 2" in out["fix"][0]


@tools
def test_port_change_rejected():
    src = get("popcount").start.replace("output wire [8:0]   count", "output wire [9:0]   count") \
        .replace("reg [8:0]   count_r;", "reg [9:0]   count_r;")
    out = checker.run_check("popcount", src)
    assert not out["pass"]
