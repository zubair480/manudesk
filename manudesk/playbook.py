"""Reflector: rewrite playbooks/fpga.md from measured run summaries.

The LLM proposes at most 8 numbered, general rules, each citing a measured number. A code gate then
drops any rule that cites no number, or cites a number not found in the evidence or the previous
playbook, so the playbook cannot drift into invented results. Every version is archived under
runs/playbooks/.

    uv run python -m manudesk.playbook              # all runs/*/summary.json
    uv run python -m manudesk.playbook a.json b.json --dry
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from manudesk import agent

MAX_RULES = 8
ARCHIVE = agent.RUNS / "playbooks"
HEADER = "# FPGA playbook (ECP5-85F, speed 6)"

SYSTEM = (
    "You maintain a short playbook of FPGA timing-closure rules for an AI engineer. Write at most 8 "
    "numbered rules (`1. ...`), each one line, general enough to help on other designs, and each citing "
    "at least one measured number copied exactly from the evidence (Fmax MHz, speedup x, latency, "
    "resource count). Keep rules from the previous playbook that the evidence does not contradict. "
    "No other text."
)

_NUM = re.compile(r"(?<![\w.])\d+(?:\.\d+)?")
_RULE = re.compile(r"^\s*(\d+)[.)]\s+(.+?)\s*$")


def evidence(summaries: list[dict]) -> str:
    """One compact line per run: what was tried and what was measured."""
    lines = []
    for s in summaries:
        hist = " ".join(f"{h.get('stage')}:{h.get('mhz')}" for h in s.get("history", []))
        last_fix = next((h.get("fix") for h in reversed(s.get("history", [])) if h.get("fix")), None)
        lines.append(agent.compact({
            "design": s.get("design"), "arm": s.get("arm"), "pass": s.get("pass"), "mhz": s.get("mhz"),
            "x": s.get("x"), "base": s.get("base"), "target": s.get("target"), "lat": s.get("lat"),
            "use": s.get("use"), "iters": hist, "fix": (last_fix or [])[:3]}))
    return "\n".join(lines)


def _norm(tok: str) -> set[str]:
    """A number and its harmless spellings (138 == 138.0; 141.37 also matches 141.4)."""
    f = float(tok)
    out = {tok, f"{f:g}", f"{f:.1f}", f"{f:.2f}"}
    if f.is_integer():
        out.add(str(int(f)))
    return out


def numbers(text: str) -> set[str]:
    out: set[str] = set()
    for t in _NUM.findall(text):
        out |= _norm(t)
    return out


def parse_rules(text: str) -> list[str]:
    return [m.group(2) for line in (text or "").splitlines() if (m := _RULE.match(line))]


def gate(rules: list[str], allowed: set[str]) -> tuple[list[str], list[str]]:
    """Keep rules whose every cited number is in `allowed` (and that cite at least one)."""
    keep, drop = [], []
    for r in rules:
        cited = _NUM.findall(r)
        ok = bool(cited) and all(_norm(t) & allowed for t in cited)
        (keep if ok else drop).append(r)
    return keep[:MAX_RULES], drop + keep[MAX_RULES:]


def render(rules: list[str], n_runs: int) -> str:
    body = "\n".join(f"{i}. {r}" for i, r in enumerate(rules, 1))
    return f"{HEADER}\nMeasured rules from {n_runs} ManuDesk runs ({time.strftime('%Y-%m-%d')}).\n\n{body}\n"


def _archive(text: str, tag: str) -> Path:
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    p = ARCHIVE / f"fpga-{time.strftime('%Y%m%d-%H%M%S')}-{tag}.md"
    p.write_text(text, encoding="utf-8")
    return p


def reflect(summaries: list[dict], path: Path = agent.PLAYBOOK, model: str | None = None,
            write: bool = True) -> dict:
    prev = agent.load_playbook(path)
    ev = evidence(summaries)
    prompt = f"PREVIOUS PLAYBOOK:\n{prev or '(none)'}\n\nEVIDENCE (one run per line):\n{ev}"
    r = agent.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}], model,
                   temperature=0.3)
    keep, drop = gate(parse_rules(r["text"]), numbers(ev) | numbers(prev))
    result = {"kept": keep, "dropped": drop, "changed": False}
    if not keep:
        return result  # nothing survived the gate: leave the playbook alone
    text = render(keep, len(summaries))
    result.update(changed=text.strip() != prev.strip(), text=text)
    if write and result["changed"]:
        if prev and not any(ARCHIVE.glob("fpga-*.md")):
            _archive(prev + "\n", "seed")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        result["archived"] = str(_archive(text, "v"))
    return result


def load_summaries(paths: list[str] | None = None) -> list[dict]:
    files = [Path(p) for p in paths] if paths else sorted(agent.RUNS.glob("*/summary.json"))
    return [json.loads(f.read_text(encoding="utf-8")) for f in files]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m manudesk.playbook", description=__doc__.splitlines()[0])
    ap.add_argument("summaries", nargs="*", help="summary.json files (default: runs/*/summary.json)")
    ap.add_argument("--dry", action="store_true", help="print, do not write")
    ap.add_argument("--model", default=None)
    a = ap.parse_args(argv)
    s = load_summaries(a.summaries)
    if not s:
        print("no run summaries found", file=sys.stderr)
        return 1
    r = reflect(s, model=a.model, write=not a.dry)
    print(r.get("text") or "(no rule survived the gate; playbook unchanged)")
    if r["dropped"]:
        print(f"dropped {len(r['dropped'])} rule(s) citing unmeasured numbers", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
