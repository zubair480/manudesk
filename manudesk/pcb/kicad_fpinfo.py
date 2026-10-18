"""Runs inside KiCad's bundled Python: courtyard/body size of each footprint in a spec, for the placer.

  <kicad>/bin/python.exe kicad_fpinfo.py spec.json
Prints one JSON line {"<lib>:<fp>": {"w": mm, "h": mm, "dx": mm, "dy": mm}} where (dx, dy) is the
bounding-box centre relative to the footprint origin, at rotation 0.
"""
import json
import os
import sys

import pcbnew

# KICAD_FOOTPRINTS env, else KiCad's own variable, else share/kicad/footprints next to this KiCad's bin/python.
FP = (os.environ.get("KICAD_FOOTPRINTS") or os.environ.get("KICAD10_FOOTPRINT_DIR") or os.environ.get("KICAD9_FOOTPRINT_DIR")
      or os.path.join(os.path.dirname(os.path.dirname(sys.executable)), "share", "kicad", "footprints"))


def main(spec_path):
    spec = json.load(open(spec_path, encoding="utf-8"))
    out = {}
    for p in spec["parts"]:
        key = f"{p['lib']}:{p['footprint']}"
        if key in out:
            continue
        fp = pcbnew.FootprintLoad(f"{FP}/{p['lib']}.pretty", p["footprint"])
        fp.SetPosition(pcbnew.VECTOR2I(0, 0))
        bb = fp.GetCourtyard(pcbnew.F_CrtYd).BBox() if fp.GetCourtyard(pcbnew.F_CrtYd).OutlineCount() else \
            fp.GetBoundingBox(False)
        out[key] = {"w": round(pcbnew.ToMM(bb.GetWidth()), 2), "h": round(pcbnew.ToMM(bb.GetHeight()), 2),
                    "dx": round(pcbnew.ToMM(bb.GetCenter().x), 2), "dy": round(pcbnew.ToMM(bb.GetCenter().y), 2)}
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1])
