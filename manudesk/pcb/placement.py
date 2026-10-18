"""Placement geometry, ported from Crusoe-Forge tc/pcb/loop.py (pure Python, no KiCad).

Coordinates the agent sees are board-relative mm: (0, 0) is the board's top-left corner, y grows down, and
each footprint is placed by its ORIGIN with a rotation in {0, 90, 180, 270} (CCW). The board spec itself is in
absolute KiCad mm with the board corner at ORIGIN.

- apply_placement: the agent's {board_w, board_h, placements} -> a spec.
- legalize: snap to the nearest overlap-free, on-board spots (global placement is the agent's, legalization is
  ours, as in a normal EDA flow).
- geometry_check: off-board, overlapping courtyards, J2 not overhanging its edge. Milliseconds, so a bad
  placement never costs a 10-60 s route. It never passes a board; only `kicad-cli pcb drc` can.
"""
from __future__ import annotations

import math

from manudesk.pcb import board

ORIGIN = (board.X0, board.Y0)  # absolute KiCad mm of the board's top-left corner
SIZE_LIMITS = {"w": (45.0, 80.0), "h": (35.0, 60.0)}
EDGE_PART = "J2"   # HDMI receptacle: must overhang the board edge on its opening side
OPENING = {0: "right", 90: "top", 180: "left", 270: "bottom"}

RULES = ("Board-relative mm: (0,0) is the board's top-left corner, x grows right, y grows DOWN. Give each part's "
         "ORIGIN (pin 1 / reference point, not its centre) and rot in {0,90,180,270} CCW; rotate the courtyard "
         "centre offset with the part. Keep every courtyard inside the board with >= 0.5 mm margin and never "
         "overlap two courtyards. J2 (HDMI) must overhang its opening edge by 1-2.5 mm: rot 0 opens right (origin "
         "x = board_w - 6.715), 90 top (origin y = 6.715), 180 left (origin x = 6.715), 270 bottom (origin y = "
         "board_h - 6.715). 2 layers, track 0.2 mm, clearance 0.15 mm, via 0.6/0.3 mm. Board size limits "
         f"{SIZE_LIMITS['w'][0]:g}-{SIZE_LIMITS['w'][1]:g} x {SIZE_LIMITS['h'][0]:g}-{SIZE_LIMITS['h'][1]:g} mm. "
         "Done = KiCad DRC with 0 errors and 0 unconnected items.")


def rotated_box(part: dict, size: dict, x: float, y: float, rot: int) -> tuple[float, float, float, float]:
    """Courtyard box (x0, y0, x1, y1) of a footprint whose origin is at (x, y), rotated `rot` deg CCW (y down)."""
    a = math.radians(rot)
    c, s = round(math.cos(a)), round(math.sin(a))
    dx, dy = size["dx"], size["dy"]
    cx, cy = x + dx * c + dy * s, y - dx * s + dy * c
    w, h = (size["w"], size["h"]) if rot % 180 == 0 else (size["h"], size["w"])
    return cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2


def geometry_check(spec: dict, sizes: dict, bw: float, bh: float, margin: float = 0.5) -> list[dict]:
    """Placement violations found without routing: off-board, overlapping courtyards, J2 not at its edge."""
    out = []
    boxes = {}
    for p in spec["parts"]:
        size = sizes[f"{p['lib']}:{p['footprint']}"]
        x, y = p["x"] - ORIGIN[0], p["y"] - ORIGIN[1]
        b = rotated_box(p, size, x, y, int(p["rot"]))
        boxes[p["ref"]] = b
        if p["ref"] == EDGE_PART:
            side = OPENING.get(int(p["rot"]) % 360)
            over = {"right": b[2] - bw, "left": -b[0], "top": -b[1], "bottom": b[3] - bh}
            if not 0.5 <= over[side] <= 3.0:
                out.append({"kind": "placement", "type": "edge_connector",
                            "description": f"J2 must overhang the {side} edge by 1-2.5 mm (rotation {p['rot']}); "
                                           f"it overhangs {over[side]:.2f} mm",
                            "items": [{"description": "J2", "pos_mm": [round(x, 2), round(y, 2)]}]})
            for k in [k for k in over if k != side and over[k] > -margin]:
                out.append({"kind": "placement", "type": "outside_board",
                            "description": f"J2 courtyard crosses the {k} edge",
                            "items": [{"description": "J2", "pos_mm": [round(x, 2), round(y, 2)]}]})
            continue
        if b[0] < margin or b[1] < margin or b[2] > bw - margin or b[3] > bh - margin:
            out.append({"kind": "placement", "type": "outside_board",
                        "description": f"{p['ref']} courtyard {tuple(round(v, 2) for v in b)} leaves the "
                                       f"{bw:g} x {bh:g} mm board (margin {margin} mm)",
                        "items": [{"description": p["ref"], "pos_mm": [round(x, 2), round(y, 2)]}]})
    refs = list(boxes)
    for i, a in enumerate(refs):
        for b_ in refs[i + 1:]:
            A, B = boxes[a], boxes[b_]
            ox = min(A[2], B[2]) - max(A[0], B[0])
            oy = min(A[3], B[3]) - max(A[1], B[1])
            if ox > 0 and oy > 0:
                out.append({"kind": "placement", "type": "courtyards_overlap",
                            "description": f"{a} and {b_} courtyards overlap by {ox:.2f} x {oy:.2f} mm",
                            "items": [{"description": a, "pos_mm": [round((A[0] + A[2]) / 2, 2), round((A[1] + A[3]) / 2, 2)]},
                                      {"description": b_, "pos_mm": [round((B[0] + B[2]) / 2, 2), round((B[1] + B[3]) / 2, 2)]}]})
    return out


def _edge_origin(rot: int, size: dict, bw: float, bh: float, x: float, y: float) -> tuple[float, float]:
    """J2 origin that puts its opening on the matching edge (template overhang: origin 6.715 mm inside)."""
    side = OPENING.get(rot % 360, "right")
    if side == "right":
        return bw - 6.715, y
    if side == "left":
        return 6.715, y
    if side == "top":
        return x, 6.715
    return x, bh - 6.715


def legalize(spec: dict, sizes: dict, gap: float = 0.4, margin: float = 0.5, step: float = 0.5
             ) -> tuple[dict, list[str], list[dict]]:
    """Snap a placement to the nearest overlap-free, on-board positions. Returns (spec, moves, violations for
    parts that cannot fit)."""
    bw, bh = spec["outline"][2], spec["outline"][3]
    parts = [dict(p) for p in spec["parts"]]
    area = lambda p: sizes[f"{p['lib']}:{p['footprint']}"]["w"] * sizes[f"{p['lib']}:{p['footprint']}"]["h"]  # noqa: E731
    order = sorted(range(len(parts)), key=lambda i: (parts[i]["ref"] != EDGE_PART, -area(parts[i])))
    placed: list[tuple[float, float, float, float]] = []
    moves, bad = [], []

    def fits(b):
        return all(min(b[2], q[2]) - max(b[0], q[0]) <= -gap or min(b[3], q[3]) - max(b[1], q[1]) <= -gap for q in placed)

    for i in order:
        p = parts[i]
        size = sizes[f"{p['lib']}:{p['footprint']}"]
        rot = int(p["rot"])
        x0, y0 = p["x"] - ORIGIN[0], p["y"] - ORIGIN[1]
        if p["ref"] == EDGE_PART:
            x0, y0 = _edge_origin(rot, size, bw, bh, x0, y0)
        w, h = (size["w"], size["h"]) if rot % 180 == 0 else (size["h"], size["w"])
        if p["ref"] != EDGE_PART and (w > bw - 2 * margin or h > bh - 2 * margin):
            bad.append({"kind": "placement", "type": "does_not_fit",
                        "description": f"{p['ref']} is {w:.2f} x {h:.2f} mm at rotation {rot}; the board is {bw:g} x {bh:g} mm. "
                                       f"Rotate it by 90 or enlarge the board.",
                        "items": [{"description": p["ref"], "pos_mm": [round(x0, 2), round(y0, 2)]}]})
            continue
        best = None
        r_max = int(max(bw, bh) / step) + 1
        for r in range(r_max + 1):  # rings of growing radius around the proposed spot
            cands = [(dx, dy) for dx in range(-r, r + 1) for dy in range(-r, r + 1) if max(abs(dx), abs(dy)) == r]
            if p["ref"] == EDGE_PART:  # slide only along its edge
                cands = [(d, 0) if OPENING.get(rot % 360) in ("top", "bottom") else (0, d) for d in range(-r, r + 1)
                         if abs(d) == r]
            for dx, dy in sorted(cands, key=lambda c: c[0] ** 2 + c[1] ** 2):
                x, y = x0 + dx * step, y0 + dy * step
                b = rotated_box(p, size, x, y, rot)
                if p["ref"] != EDGE_PART:  # shift into the board first
                    sx = max(0.0, margin - b[0]) - max(0.0, b[2] - (bw - margin))
                    sy = max(0.0, margin - b[1]) - max(0.0, b[3] - (bh - margin))
                    x, y, b = x + sx, y + sy, (b[0] + sx, b[1] + sy, b[2] + sx, b[3] + sy)
                if fits(b):
                    best = (x, y, b)
                    break
            if best:
                break
        if not best:
            bad.append({"kind": "placement", "type": "no_room",
                        "description": f"no free spot for {p['ref']} ({w:.2f} x {h:.2f} mm) on the {bw:g} x {bh:g} mm board; "
                                       f"move other parts, rotate, or enlarge the board",
                        "items": [{"description": p["ref"], "pos_mm": [round(x0, 2), round(y0, 2)]}]})
            continue
        x, y, b = best
        placed.append(b)
        d = math.hypot(x - (p["x"] - ORIGIN[0]), y - (p["y"] - ORIGIN[1]))
        if d > 0.01:
            moves.append(f"{p['ref']} moved {d:.1f} mm to ({x:.2f}, {y:.2f})")
        p["x"], p["y"] = round(ORIGIN[0] + x, 3), round(ORIGIN[1] + y, 3)
    return {**spec, "parts": parts}, moves, bad


def apply_placement(spec: dict, prop: dict) -> tuple[dict, list[str]]:
    """New spec with the proposed board size and positions (board-relative -> absolute). Returns (spec, problems)."""
    problems = []
    lo, hi = SIZE_LIMITS["w"]
    bw = min(max(float(prop.get("board_w") or spec["outline"][2]), lo), hi)
    lo, hi = SIZE_LIMITS["h"]
    bh = min(max(float(prop.get("board_h") or spec["outline"][3]), lo), hi)
    if prop.get("board_w") and (bw, bh) != (prop.get("board_w"), prop.get("board_h")):
        problems.append(f"board size clamped to {bw:g} x {bh:g} mm (limits {SIZE_LIMITS})")
    by_ref = {p["ref"]: p for p in prop.get("placements") or [] if isinstance(p, dict) and "ref" in p}
    unknown = sorted(set(by_ref) - {p["ref"] for p in spec["parts"]})
    if unknown:
        problems.append(f"unknown refs ignored: {unknown}")
    parts = []
    for p in spec["parts"]:
        q = by_ref.get(p["ref"])
        if q is None:  # not given: keep the hand template's spot for this part
            parts.append(dict(p))
            continue
        rot = int(q.get("rot") or 0) % 360
        if rot not in (0, 90, 180, 270):
            problems.append(f"{p['ref']} rotation {rot} snapped to 0")
            rot = 0
        parts.append({**p, "x": round(ORIGIN[0] + float(q["x"]), 3), "y": round(ORIGIN[1] + float(q["y"]), 3),
                      "rot": rot})
    return {**spec, "parts": parts, "outline": [ORIGIN[0], ORIGIN[1], bw, bh]}, problems


def relative(violations: list[dict]) -> list[dict]:
    """KiCad positions are absolute; the agent works board-relative."""
    out = []
    for v in violations:
        items = [{**i, "pos_mm": [round(i["pos_mm"][0] - ORIGIN[0], 2), round(i["pos_mm"][1] - ORIGIN[1], 2)]}
                 if v.get("kind") != "placement" else i for i in v.get("items", [])]
        out.append({**v, "items": items})
    return out


def placements_of(spec: dict) -> list[dict]:
    """Board-relative placements of a spec, in the shape pcb_check accepts."""
    return [{"ref": p["ref"], "x": round(p["x"] - ORIGIN[0], 3), "y": round(p["y"] - ORIGIN[1], 3), "rot": p["rot"]}
            for p in spec["parts"]]
