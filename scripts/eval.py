"""Blind vs feedback: does the check() loop make designs correct and fast?

For each design run N blind attempts (one write, no tool output, scored afterwards) and N feedback runs
(iterate on check() results). Prints one row per design and writes runs/eval.json.

    uv run python scripts/eval.py                      # all designs, N=2, 4 iters
    uv run python scripts/eval.py mac popcount -n 3 --jobs 2
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from manudesk import agent  # noqa: E402
from manudesk.designs import all_designs  # noqa: E402

ARMS = ("blind", "feedback")


def arm_stats(runs: list[dict]) -> dict:
    ok = [r for r in runs if r["pass"]]
    mhz = [r["mhz"] for r in ok if r.get("mhz")]
    xs = [r["x"] for r in ok if r.get("x")]
    return {"n": len(runs), "ok": len(ok),
            "mhz_best": max(mhz) if mhz else None,
            "mhz_med": round(statistics.median(mhz), 1) if mhz else None,
            "x_med": round(statistics.median(xs), 2) if xs else None,
            "fail_stages": sorted({r.get("stage") for r in runs if not r["pass"]} - {None})}


def _fmt(v, nd=1):
    return "-" if v is None else f"{v:.{nd}f}"


def table(results: dict) -> str:
    head = f"{'design':<12} {'blind ok':>8} {'MHz':>7} {'x':>5}   {'tools ok':>8} {'MHz':>7} {'x':>5}"
    rows = [head, "-" * len(head)]
    for d, arms in results.items():
        b, f = arms["blind"], arms["feedback"]
        rows.append(f"{d:<12} {b['ok']:>4}/{b['n']:<3} {_fmt(b['mhz_med']):>7} {_fmt(b['x_med'], 2):>5}   "
                    f"{f['ok']:>4}/{f['n']:<3} {_fmt(f['mhz_med']):>7} {_fmt(f['x_med'], 2):>5}")
    return "\n".join(rows)


def totals(results: dict) -> dict:
    out = {}
    for arm in ARMS:
        n = sum(r[arm]["n"] for r in results.values())
        ok = sum(r[arm]["ok"] for r in results.values())
        xs = [r[arm]["x_med"] for r in results.values() if r[arm]["x_med"]]
        out[arm] = {"runs": n, "correct": ok, "wrong": n - ok,
                    "designs_all_correct": sum(r[arm]["ok"] == r[arm]["n"] > 0 for r in results.values()),
                    "x_mean_of_medians": round(statistics.mean(xs), 2) if xs else None}
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("designs", nargs="*", help="default: all")
    ap.add_argument("-n", type=int, default=2, help="runs per arm per design")
    ap.add_argument("--iters", type=int, default=4, help="feedback iterations")
    ap.add_argument("--jobs", type=int, default=1, help="runs in parallel")
    ap.add_argument("--no-playbook", action="store_true")
    ap.add_argument("--model", default=None)
    ap.add_argument("--out", default=str(agent.RUNS / "eval.json"))
    a = ap.parse_args(argv)

    names = a.designs or list(all_designs())
    jobs = [(d, arm) for d in names for arm in ARMS for _ in range(a.n)]
    t0 = time.time()

    def go(job):
        d, arm = job
        return agent.run(d, a.iters, feedback=arm == "feedback", playbook=not a.no_playbook,
                         model=a.model, quiet=True)

    with ThreadPoolExecutor(max(1, a.jobs)) as ex:
        runs = list(ex.map(go, jobs))

    raw: dict[str, dict[str, list]] = {d: {arm: [] for arm in ARMS} for d in names}
    for s in runs:
        raw[s["design"]][s["arm"]].append(s)
    results = {d: {arm: arm_stats(raw[d][arm]) for arm in ARMS} for d in names}
    tot = totals(results)

    print(table(results))
    for arm in ARMS:
        t = tot[arm]
        print(f"{arm}: {t['correct']}/{t['runs']} correct, {t['designs_all_correct']}/{len(names)} designs "
              f"always correct, mean speedup {_fmt(t['x_mean_of_medians'], 2)}x")

    keep = ("run_id", "pass", "stage", "mhz", "x", "lat", "use", "iters", "best_iter", "tokens", "seconds")
    report = {"when": time.strftime("%Y-%m-%dT%H:%M:%S"), "model": a.model or agent.default_model(),
              "n": a.n, "iters": a.iters, "playbook": not a.no_playbook,
              "seconds": round(time.time() - t0, 1), "totals": tot, "designs": results,
              "runs": {d: {arm: [{k: s.get(k) for k in keep} for s in raw[d][arm]] for arm in ARMS}
                       for d in names}}
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
