"""Benchmark designs: designs/<name>/{spec.json, start.v, tb.v}. tb.v is hidden from agents."""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from manudesk.toolchain import REPO

DESIGNS = REPO / "designs"
LIB = DESIGNS / "lib" / "ecp5_dsp.v"

RULES = (
    "Keep the module header (name, ports, widths, signedness) exactly. "
    "Keep `localparam LATENCY = <n>;` in the top module: n = registers from any input to the outputs; "
    "every input-to-output path must have that same depth; n <= latency_budget. "
    "Synchronous active-high reset; clear every register you add. Plain Verilog-2005 (no SystemVerilog, "
    "no initial, no $system tasks, no `include). The only extra module is "
    "mul18x18_reg #(SIGNED=0|1)(clk, ce, rst, a[17:0], b[17:0], p[35:0]): ECP5 DSP, latency 2; do not "
    "redefine it. Fmax is measured with every port registered, so logic before the first register still counts. "
    "Part: Lattice ECP5-85F speed 6 (yosys synth_ecp5 + nextpnr-ecp5)."
)


@dataclass(frozen=True)
class Design:
    name: str
    top: str
    summary: str
    baseline_mhz: float
    target_mhz: float
    latency_budget: int
    resource_budget: dict
    mutants: tuple
    dir: Path

    @property
    def start(self) -> str:
        return (self.dir / "start.v").read_text(encoding="utf-8")

    @property
    def tb(self) -> Path:
        return self.dir / "tb.v"

    def limits(self) -> dict:
        return {"target_mhz": self.target_mhz, "baseline_mhz": self.baseline_mhz,
                "latency_budget": self.latency_budget, "resources": self.resource_budget}


@lru_cache(maxsize=1)
def all_designs() -> dict[str, Design]:
    out = {}
    for spec_path in sorted(DESIGNS.glob("*/spec.json")):
        s = json.loads(spec_path.read_text(encoding="utf-8"))
        out[s["name"]] = Design(s["name"], s["top"], s["summary"], s["baseline_mhz"], s["target_mhz"],
                                s["latency_budget"], s["resource_budget"], tuple(s.get("mutants", [])),
                                spec_path.parent)
    return out


def get(name: str) -> Design:
    d = all_designs().get(name)
    if d is None:
        raise KeyError(f"unknown design {name!r}; try one of {', '.join(all_designs())}")
    return d
