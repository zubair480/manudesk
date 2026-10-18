"""Runs inside KiCad's bundled Python. Ported from the spike's import_ses.py.

  <kicad>/bin/python.exe kicad_ses.py board.kicad_pcb board.ses board_routed.kicad_pcb
Prints one JSON line with track/via counts.
"""
import json
import sys

import pcbnew

from kicad_rules import apply_rules  # same directory: run as a file under KiCad's Python


def main(pcb, ses, out):
    board = pcbnew.LoadBoard(pcb)
    apply_rules(board)   # the reloaded board may have lost them (no .kicad_pro written on Linux)
    ok = pcbnew.ImportSpecctraSES(board, ses)
    pcbnew.SaveBoard(out, board)
    tracks = list(board.GetTracks())
    vias = sum(1 for t in tracks if t.GetClass() == "PCB_VIA")
    print(json.dumps({"ok": bool(ok), "tracks": len(tracks) - vias, "vias": vias, "pcb": out}))


if __name__ == "__main__":
    main(*sys.argv[1:4])
