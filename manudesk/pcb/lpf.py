"""LPF parsing and the ULX3S J1 header map: design port -> FPGA site -> header pin.

The HDMI add-on board plugs into the ULX3S J1 GPIO header, so its nets are
decided by the design's LPF: every `LOCATE COMP "<port>" SITE "<site>";` whose
site is on J1 becomes a connection from that header pin to the right pin of the
HDMI connector, LED or button.

Header map sources (fetched 2026-10-17 via You.com):
  - sites: https://github.com/emard/ulx3s/blob/master/doc/constraints/ulx3s_v20.lpf
    (gp[n]/gn[n] -> SITE)
  - pin numbers: https://libre-soc.org/HDL_workflow/ECP5_FPGA/ (J1 pins 1-8 table:
    1,2 = 3.3V; 3,4 = GND; gn[n] on odd pin 5+2n, gp[n] on even pin 6+2n), and the
    ULX3S manual's J1 layout (3.3V/GND rows again at 21-24 and 37-40, gp/gn 8-13 on
    25-36). Pins 1-8 are cross-checked; the rest follow the documented rhythm.
    Check schematics_v308.pdf before sending a board to fab.
  - "J1/J2 PIN number 1-40 is for FEMALE 90° ANGLED header. For MALE VERTICAL
    header, SWAP EVEN and ODD pin numbers." Our socket uses the same numbering.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_LOCATE = re.compile(r'LOCATE\s+COMP\s+"([^"]+)"\s+SITE\s+"([^"]+)"\s*;', re.I)

# ULX3S gp[n]/gn[n] -> FPGA site, J1 only (n = 0..13), from ulx3s_v20.lpf.
ULX3S_J1_SITES: dict[int, tuple[str, str]] = {
    0: ("B11", "C11"), 1: ("A10", "A11"), 2: ("A9", "B10"), 3: ("B9", "C10"),
    4: ("A7", "A8"), 5: ("C8", "B8"), 6: ("C6", "C7"), 7: ("A6", "B6"),
    8: ("A4", "A5"), 9: ("A2", "B1"), 10: ("C4", "B4"), 11: ("F4", "E3"),
    12: ("G3", "F3"), 13: ("H4", "G5"),
}
# gp/gn 8-13 are true differential pairs (bank 7); 0-7 are single-ended (bank 0).
ULX3S_DIFF_PAIRS = range(8, 14)
# The ULX3S ties these together on its side; the add-on only needs to draw 3V3 from pins 1-2.
# (Netting all six boxed the inner-row pins in and left 1 unrouted connection on the first run.)
J1_3V3_PINS = ["1", "2"]
J1_3V3_ALL = ["1", "2", "21", "22", "37", "38"]
J1_GND_PINS = ["3", "4", "23", "24", "39", "40"]


def j1_pin(n: int, positive: bool) -> str:
    """Header pin number for gp[n] (positive) or gn[n] on ULX3S J1."""
    if 0 <= n <= 7:
        base = 5 + 2 * n
    elif 8 <= n <= 13:
        base = 25 + 2 * (n - 8)
    else:
        raise ValueError(f"gp/gn[{n}] is on J2, not J1")
    return str(base + 1 if positive else base)


def site_to_j1() -> dict[str, tuple[str, str]]:
    """FPGA site -> (header pin, ULX3S signal name) for every J1 GPIO."""
    out = {}
    for n, (sp, sn) in ULX3S_J1_SITES.items():
        out[sp] = (j1_pin(n, True), f"gp[{n}]")
        out[sn] = (j1_pin(n, False), f"gn[{n}]")
    return out


def parse_lpf(text: str) -> dict[str, str]:
    """Return {port: site} for every LOCATE COMP line (comments stripped)."""
    text = "\n".join(line.split("#", 1)[0] for line in text.splitlines())
    return {m.group(1): m.group(2).upper() for m in _LOCATE.finditer(text)}


@dataclass
class PinAssignment:
    port: str
    site: str
    header_pin: str | None  # None when the site is not on J1 (e.g. the onboard GPDI)
    ulx3s_signal: str | None


def assign(lpf_text: str) -> list[PinAssignment]:
    table = site_to_j1()
    out = []
    for port, site in parse_lpf(lpf_text).items():
        pin, sig = table.get(site, (None, None))
        out.append(PinAssignment(port, site, pin, sig))
    return out


def load(path: str | Path) -> list[PinAssignment]:
    return assign(Path(path).read_text(encoding="utf-8"))
