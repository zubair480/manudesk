"""Runs inside KiCad's bundled Python (it imports pcbnew). Ported from the spike's gen_board.py.

  <kicad>/bin/python.exe kicad_gen.py spec.json out_dir
Writes out_dir/board.kicad_pcb (+ .kicad_pro) and out_dir/board.dsn, prints one JSON line.
"""
import json
import os
import sys
import time

import pcbnew

from kicad_rules import apply_rules  # same directory: these scripts run as files under KiCad's Python

# KICAD_FOOTPRINTS env, else KiCad's own variable, else share/kicad/footprints next to this KiCad's bin/python.
FP = (os.environ.get("KICAD_FOOTPRINTS") or os.environ.get("KICAD10_FOOTPRINT_DIR") or os.environ.get("KICAD9_FOOTPRINT_DIR")
      or os.path.join(os.path.dirname(os.path.dirname(sys.executable)), "share", "kicad", "footprints"))


def main(spec_path, out):
    spec = json.load(open(spec_path, encoding="utf-8"))
    os.makedirs(out, exist_ok=True)
    t0 = time.perf_counter()
    board = pcbnew.CreateEmptyBoard()
    board.SetCopperLayerCount(2)
    apply_rules(board)

    fps = {}
    for p in spec["parts"]:
        fp = pcbnew.FootprintLoad(f"{FP}/{p['lib']}.pretty", p["footprint"])
        if fp is None:
            raise SystemExit(f"footprint not found: {p['lib']}:{p['footprint']}")
        fp.SetReference(p["ref"]); fp.SetValue(p["value"])
        fp.SetFPID(pcbnew.LIB_ID(p["lib"], p["footprint"]))
        fp.SetPosition(pcbnew.VECTOR2I_MM(p["x"], p["y"]))
        fp.SetOrientationDegrees(p["rot"])
        board.Add(fp); fps[p["ref"]] = fp

    pad_net = {}
    for net_name, nodes in spec["nets"].items():
        ni = pcbnew.NETINFO_ITEM(board, net_name); board.Add(ni)
        for ref, pad in nodes:
            pad_net[(ref, pad)] = ni
    for ref, fp in fps.items():
        for pad in fp.Pads():
            ni = pad_net.get((ref, pad.GetNumber()))
            if ni:
                pad.SetNet(ni)
    missing = [k for k in pad_net if k[0] not in fps or not any(p.GetNumber() == k[1] for p in fps[k[0]].Pads())]
    if missing:
        raise SystemExit(f"nodes with no such pad: {missing}")

    x0, y0, w, h = spec["outline"]
    rect = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_RECTANGLE)
    rect.SetStart(pcbnew.VECTOR2I_MM(x0, y0)); rect.SetEnd(pcbnew.VECTOR2I_MM(x0 + w, y0 + h))
    rect.SetLayer(pcbnew.Edge_Cuts); rect.SetWidth(pcbnew.FromMM(0.1))
    board.Add(rect)
    build_s = time.perf_counter() - t0

    pcb = os.path.join(out, "board.kicad_pcb")
    pcbnew.SaveBoard(pcb, board)
    ok = pcbnew.ExportSpecctraDSN(board, os.path.join(out, "board.dsn"))
    print(json.dumps({"ok": bool(ok), "parts": len(fps), "nets": len(spec["nets"]),
                      "build_s": round(build_s, 3), "pcb": pcb}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
