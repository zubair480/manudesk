"""Board spec for the HDMI add-on: parts, placement and nets, built from an LPF.

Pure Python (no pcbnew), so it is unit-testable. `kicad_gen.py` turns the spec
JSON into a .kicad_pcb inside KiCad's own Python.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from manudesk.pcb.lpf import J1_3V3_PINS, J1_GND_PINS, PinAssignment

# Board outline (mm), same template as the proven spike (docs/pcb_pipeline_spike.md).
X0, Y0, W, H = 100.0, 100.0, 70.0, 56.0

# HDMI type A pad numbers (Molex 208658-1001 footprint): pair index -> (P, N, shield)
HDMI_PAIR_PADS = {2: ("1", "3", "2"), 1: ("4", "6", "5"), 0: ("7", "9", "8"), 3: ("10", "12", "11")}
HDMI_PAIR_NAME = {0: "D0", 1: "D1", 2: "D2", 3: "CK"}
HDMI_MISC_PADS = {"CEC": "13", "SCL": "15", "SDA": "16", "HPD": "19"}
HDMI_GND_PADS = ["2", "5", "8", "11", "17", "SH"]
HDMI_5V_PAD = "18"

_PAIR = re.compile(r"(?:hdmi|gpdi|tmds|dvi)\w*?_?d([pn])\[(\d)\]$", re.I)
_PAIR_ALT = re.compile(r"(?:hdmi|gpdi|tmds|dvi)\w*?_(d[0-2]|clk|ck)_?([pn])$", re.I)
_MISC = re.compile(r"(?:hdmi|gpdi|dvi|ddc)\w*?_(scl|sda|hpd|cec)$", re.I)
_LED = re.compile(r"^(?:led|leds)(?:\[(\d+)\]|_?(\d+))?$", re.I)
_BTN = re.compile(r"^(?:btn|button|key|sw)(?:\[(\d+)\]|_?(\d+))?$", re.I)


@dataclass
class Part:
    ref: str
    lib: str
    footprint: str
    value: str
    mpn: str
    manufacturer: str
    description: str
    x: float
    y: float
    rot: float = 0.0


@dataclass
class BoardSpec:
    parts: list[Part] = field(default_factory=list)
    nets: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    pin_map: list[dict] = field(default_factory=list)   # port -> header pin -> net, for the viewer
    ignored: list[dict] = field(default_factory=list)   # LPF ports not on J1 or with no role
    outline: tuple[float, float, float, float] = (X0, Y0, W, H)

    def to_json(self) -> dict:
        return {
            "outline": list(self.outline),
            "parts": [p.__dict__ for p in self.parts],
            "nets": {k: [list(n) for n in v] for k, v in self.nets.items()},
            "pin_map": self.pin_map,
            "ignored": self.ignored,
        }


def classify(port: str) -> tuple[str, str] | None:
    """Port name -> (role, key). Roles: tmds (key 'D0_P'...), misc ('SCL'...), led ('0'), btn ('0')."""
    if m := _PAIR.search(port):
        pol, idx = m.group(1).upper(), int(m.group(2))
        return ("tmds", f"{HDMI_PAIR_NAME[idx]}_{pol}") if idx in HDMI_PAIR_NAME else None
    if m := _PAIR_ALT.search(port):
        name = m.group(1).upper().replace("CLK", "CK")
        return "tmds", f"{name}_{m.group(2).upper()}"
    if m := _MISC.search(port):
        return "misc", m.group(1).upper()
    if m := _LED.match(port):
        return "led", m.group(1) or m.group(2) or "0"
    if m := _BTN.match(port):
        return "btn", m.group(1) or m.group(2) or "0"
    return None


def build(assignments: list[PinAssignment]) -> BoardSpec:
    spec = BoardSpec()
    nets = spec.nets
    add = lambda net, *nodes: nets.setdefault(net, []).extend(nodes)  # noqa: E731

    tmds_pad = {f"{HDMI_PAIR_NAME[i]}_{pol}": pads[k] for i, pads in HDMI_PAIR_PADS.items()
                for k, pol in ((0, "P"), (1, "N"))}
    leds: dict[str, str] = {}
    btns: dict[str, str] = {}
    for a in assignments:
        role = classify(a.port)
        if a.header_pin is None or role is None:
            reason = "site not on ULX3S J1" if a.header_pin is None else "no board role for this port"
            spec.ignored.append({"port": a.port, "site": a.site, "reason": reason})
            continue
        kind, key = role
        if kind == "tmds":
            net = f"TMDS_{key}"
            add(net, ("J1", a.header_pin), ("J2", tmds_pad[key]))
        elif kind == "misc":
            net = f"HDMI_{key}" if key in ("CEC", "HPD") else f"DDC_{key}"
            add(net, ("J1", a.header_pin), ("J2", HDMI_MISC_PADS[key]))
        elif kind == "led":
            leds[key] = a.header_pin
            net = f"LED{key}"
        else:
            btns[key] = a.header_pin
            net = f"BTN{key}"
        spec.pin_map.append({"port": a.port, "site": a.site, "ulx3s": a.ulx3s_signal,
                             "header_pin": a.header_pin, "net": net})

    if not any(n.startswith("TMDS_") for n in nets):
        raise ValueError("LPF puts no HDMI TMDS ports on ULX3S J1; nothing to build "
                         f"(ignored: {[i['port'] for i in spec.ignored]})")

    P = spec.parts
    P.append(Part("J1", "Connector_PinSocket_2.54mm", "PinSocket_2x20_P2.54mm_Vertical", "Conn_02x20",
                  "SSW-120-01-T-D", "Samtec", "2x20 2.54 mm socket to ULX3S J1", 108, 104))
    P.append(Part("J2", "Connector_Video", "HDMI_A_Molex_208658-1001_Horizontal", "HDMI_A",
                  "2086581001", "Molex", "HDMI type A receptacle, SMD", X0 + W - 5.715 - 1.0, 128))
    P.append(Part("J3", "Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical", "5V_IN",
                  "61300211121", "Wurth Elektronik", "2-pin header, external 5 V for HDMI +5V", 128, 106, 90))
    P.append(Part("C1", "Capacitor_SMD", "C_0805_2012Metric", "10uF", "GRM21BR61A106KE19L", "Murata",
                  "10 uF 10 V X5R 0805, HDMI +5V bulk", 140, 108, 90))
    P.append(Part("C2", "Capacitor_SMD", "C_0805_2012Metric", "10uF", "GRM21BR61A106KE19L", "Murata",
                  "10 uF 10 V X5R 0805, 3V3 decoupling", 118, 108, 90))

    add("+5V", ("J3", "1"), ("C1", "1"), ("J2", HDMI_5V_PAD))
    add("+3V3", *[("J1", p) for p in J1_3V3_PINS], ("C2", "1"))
    add("GND", *[("J1", p) for p in J1_GND_PINS], ("J3", "2"), ("C1", "2"), ("C2", "2"),
        *[("J2", p) for p in HDMI_GND_PADS])

    # LED: 3V3 -> R -> LED anode; cathode -> FPGA pin (active low). Up to 4, along the bottom edge.
    for i, (key, pin) in enumerate(sorted(leds.items())[:4], 1):
        x = 118 + 6 * (i - 1)
        P.append(Part(f"R{i}", "Resistor_SMD", "R_0603_1608Metric", "330", "RC0603FR-07330RL", "Yageo",
                      "330 ohm 1% 0603", x, 143, 90))
        P.append(Part(f"D{i}", "LED_SMD", "LED_0603_1608Metric", "LED", "150060GS75000", "Wurth Elektronik",
                      "green LED 0603", x, 150, 90))
        add("+3V3", (f"R{i}", "1"))
        add(f"LED{key}_RA", (f"R{i}", "2"), (f"D{i}", "2"))
        add(f"LED{key}", (f"D{i}", "1"), ("J1", pin))
    # Button: FPGA pin -> switch -> GND (FPGA pull-up). Up to 2.
    for i, (key, pin) in enumerate(sorted(btns.items())[:2], 1):
        P.append(Part(f"SW{i}", "Button_Switch_SMD", "SW_Push_1P1T_NO_CK_KMR2", "BTN", "KMR221GLFS", "C&K",
                      "tactile switch, SMD", 146 + 12 * (i - 1), 148))
        add(f"BTN{key}", ("J1", pin), (f"SW{i}", "1"))
        add("GND", (f"SW{i}", "2"))
    return spec


def bom_rows(spec: BoardSpec) -> list[dict]:
    """Grouped BOM: one row per MPN, with refs and quantity."""
    rows: dict[str, dict] = {}
    for p in spec.parts:
        r = rows.setdefault(p.mpn, {"Refs": [], "Qty": 0, "Value": p.value, "Footprint": f"{p.lib}:{p.footprint}",
                                    "Manufacturer": p.manufacturer, "MPN": p.mpn, "Description": p.description})
        r["Refs"].append(p.ref)
        r["Qty"] += 1
    return [{**r, "Refs": " ".join(r["Refs"])} for r in rows.values()]
