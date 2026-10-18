"""One-off: turn the real cocotb run (run.log + results.xml) into data/05-cocotb.json.
Usage (from demo/eda-walkthrough): python real/cocotb/log2json.py
"""
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

here = Path(__file__).resolve().parent
root = here.parent.parent
log = (here / "run.log").read_text(encoding="utf-8", errors="replace").splitlines()
xml = ET.parse(here / "results.xml").getroot()

# shorten absolute paths for display; keep everything else verbatim
def tidy(line):
    line = re.sub(r"[A-Z]:\\Users\\[^\\]+\\yc 2\.0 hackathon\\demo\\eda-walkthrough\\real\\cocotb\\", r".\\", line)
    return line.rstrip()

lines = [tidy(l) for l in log]

tests = []
for tc in xml.iter("testcase"):
    props = {p.get("name"): p.get("value") for p in tc.iter("property")}
    failed = tc.find("failure") is not None or tc.find("error") is not None
    tests.append({
        "name": tc.get("name"),
        "status": "FAIL" if failed else "PASS",
        "simTimeNs": float(props.get("sim_time_duration", 0)),
        "realTimeS": float(tc.get("time")),
        "ratio": float(props.get("sim_time_ratio", 0)),
        "line": int(props.get("line", 0)),
    })

suite = xml.find("testsuite")
summary = next((l for l in log if "TESTS=" in l), "")
m = re.search(r"TESTS=(\d+) PASS=(\d+) FAIL=(\d+) SKIP=(\d+)\s+([\d.]+)\s+([\d.]+)", summary)
ver = next((re.search(r"cocotb v([\d.]+)", l).group(1) for l in log if "Initialized cocotb v" in l), None)
sim = next((re.search(r"Running on (.+)$", l).group(1) for l in log if "Running on " in l), None)

out = {
    "source": ["real/cocotb/run.log", "real/cocotb/results.xml", "real/cocotb/test_pwm_led.py"],
    "simulated": False,
    "cocotb": ver,
    "simulator": sim.strip() if sim else None,
    "command": ".venv/Scripts/python test_pwm_led.py",
    "env": "source /c/fpga/env.sh",
    "toplevel": "pwm_led",
    "parameters": {"DIV": 4},
    "seed": int(suite.find(".//property[@name='random_seed']").get("value")),
    "tests": tests,
    "totals": {"tests": int(m[1]), "pass": int(m[2]), "fail": int(m[3]), "skip": int(m[4]),
               "simTimeNs": float(m[5]), "realTimeS": float(m[6])} if m else None,
    "log": lines,
}
(root / "data" / "05-cocotb.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
print(json.dumps({k: v for k, v in out.items() if k != "log"}, indent=1))
