"""Benchmark designs: designs/<name>/{spec.json, start.v, tb.v}. tb.v is hidden from agents."""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from manudesk.toolchain import REPO

DESIGNS = REPO / "designs"
LIB = DESIGNS / "lib" / "ecp5_dsp.v"

DEVICE = "Lattice ECP5-85F (LFE5U-85F-6BG381C), speed grade 6; yosys synth_ecp5 + nextpnr-ecp5"
# Spec budget names <- spec.json short names (spec.json, md_designs and the edge functions use the short ones).
BUDGET_KEYS = {"FF": "TRELLIS_FF", "LUT": "TRELLIS_COMB", "DSP": "MULT18X18D"}

RULES = (
    "Keep the top module name and its ports (names, directions, widths) exactly the same.",
    "Declare `localparam LATENCY = <n>;` in the top module, giving the true number of cycles from input to "
    "output. A design whose output still passes with LATENCY+1 is rejected.",
    "Stay within latency_budget and resource_budget.",
    "For a registered DSP multiply, instantiate the provided `mul18x18_reg` (see dsp_helper); don't redefine it. "
    "mul18x18_reg #(.SIGNED(0|1)) (clk, ce, rst, a[17:0], b[17:0], p[35:0]) has latency 2.",
    "Fmax is measured inside a harness that registers every port, so logic before the first register still counts.",
    "Plain synthesizable Verilog-2005: no initial blocks, no $system tasks, no `include. Synchronous active-high "
    "reset; clear every register you add.",
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

    @property
    def budgets(self) -> dict:
        """resource_budget under the nextpnr cell names, e.g. {"TRELLIS_FF": 2000, "TRELLIS_COMB": 3000}."""
        return {BUDGET_KEYS.get(k, k): v for k, v in self.resource_budget.items()}

    @property
    def goal(self) -> str:
        return f"about {self.target_mhz / self.baseline_mhz:.1f}x baseline ({self.target_mhz:g} MHz or more)"


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
