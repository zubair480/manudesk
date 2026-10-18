"""Re-measure every design's start.v with the checker and write baseline_mhz into its spec.json."""
import json
from concurrent.futures import ThreadPoolExecutor

from manudesk.checker import run_check
from manudesk.designs import all_designs


def one(d):
    r = run_check(d.name, d.start)
    return d, r


with ThreadPoolExecutor(3) as ex:
    for d, r in ex.map(one, all_designs().values()):
        p = d.dir / "spec.json"
        spec = json.loads(p.read_text())
        if r["accepted"]:
            spec["baseline_mhz"] = r["fmax_mhz"]
            p.write_text(json.dumps(spec, indent=2) + "\n")
        print(d.name, r["accepted"], r["fmax_mhz"], r["resources"], r["reasons"], r["critical_path"])
