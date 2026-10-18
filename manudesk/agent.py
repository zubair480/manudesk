"""Built-in engineer loop: an LLM rewrites a design, check() measures it, repeat.

Two arms:
  feedback=True   each iteration sees the best passing Verilog so far plus the last check() JSON.
  feedback=False  "blind": the model writes once from the spec with no tool output; we still run
                  check() on the result so the arm can be scored.

Every run is saved to runs/<run_id>/ as iter_N.v, check_N.json and summary.json.

    uv run python -m manudesk.agent mac --iters 4
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

from manudesk.designs import RULES, get
from manudesk.toolchain import REPO

RUNS = REPO / "runs"
PLAYBOOK = REPO / "playbooks" / "fpga.md"
MIN_TOKENS = 4096

SYSTEM = (
    "You are an FPGA timing engineer. Make the design pass its hidden testbench and run as fast as "
    "possible on the target part, within the latency and resource budgets. Reply with exactly ONE "
    "```verilog block holding the complete source (top module plus any helper modules you add). "
    "Keep any prose outside the block to one or two lines."
)


# ------------------------------------------------------------------ LLM

_client = None


def _openai():
    global _client
    if _client is None:
        from dotenv import load_dotenv
        from openai import OpenAI
        load_dotenv(REPO / ".env")
        key = os.environ.get("CRUSOE_API_KEY")
        if not key:
            raise RuntimeError("CRUSOE_API_KEY missing; put it in .env")
        _client = OpenAI(base_url=os.environ.get("CRUSOE_BASE_URL",
                                                 "https://api.inference.crusoecloud.com/v1"),
                         api_key=key, timeout=600, max_retries=0)
    return _client


def default_model() -> str:
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
    return os.environ.get("CRUSOE_DEFAULT_MODEL", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B")


def _status(err: Exception) -> int | None:
    return getattr(err, "status_code", None) or getattr(getattr(err, "response", None), "status_code", None)


def chat(messages: list[dict], model: str | None = None, max_tokens: int = 16384,
         temperature: float = 0.6, tries: int = 5) -> dict:
    """One chat completion. Returns {"text", "finish", "tokens"}.

    Reasoning models spend tokens before answering: if the answer is empty or cut off we retry once
    with double max_tokens. Only 429/503 are retried with backoff; anything else raises.
    """
    model = model or default_model()
    max_tokens = max(max_tokens, MIN_TOKENS)
    used = 0
    for grow in (False, True):
        resp = None
        for attempt in range(tries):
            try:
                resp = _openai().chat.completions.create(model=model, messages=messages,
                                                         max_tokens=max_tokens, temperature=temperature)
                break
            except Exception as e:  # noqa: BLE001 - classify by HTTP status
                if _status(e) not in (429, 503) or attempt == tries - 1:
                    raise
                time.sleep(min(60, 2 ** attempt * 3))
        choice = resp.choices[0]
        text = (choice.message.content or "").lstrip("\n")
        used += getattr(resp.usage, "total_tokens", 0) or 0
        if text.strip() and choice.finish_reason != "length":
            return {"text": text, "finish": choice.finish_reason, "tokens": used}
        if grow:
            return {"text": text, "finish": choice.finish_reason, "tokens": used}
        max_tokens *= 2
    raise AssertionError("unreachable")


# ------------------------------------------------------------------ pieces

_BLOCK = re.compile(r"^[ \t]*```[ \t]*([\w+-]*)[^\n]*\n(.*?)^[ \t]*```", re.S | re.M)


def extract_verilog(text: str) -> str | None:
    """The last fenced block that contains a module; prefers ```verilog blocks."""
    blocks = [((m.group(1) or "").lower(), m.group(2)) for m in _BLOCK.finditer(text or "")]
    tagged = [b for lang, b in blocks if lang in ("verilog", "v", "sv", "systemverilog") and "module" in b]
    any_ = [b for _, b in blocks if "module" in b]
    pick = (tagged or any_ or [None])[-1]
    if pick is None:
        # unterminated block (cut off) or a bare module: take from the first `module`
        i = (text or "").find("module ")
        if i < 0 or "endmodule" not in text[i:]:
            return None
        pick = text[i:text.rindex("endmodule") + len("endmodule")]
    return pick.strip() + "\n"


def load_playbook(path: Path = PLAYBOOK) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def compact(d: dict) -> str:
    return json.dumps(d, separators=(",", ":"), default=str)


def build_prompt(design, code: str, last: dict | None, playbook: str, first: bool) -> str:
    parts = [f"RULES: {RULES}",
             f"DESIGN {design.name} (top `{design.top}`): {design.summary}",
             f"LIMITS: {compact(design.limits())}"]
    if playbook:
        parts.append(f"PLAYBOOK (lessons from earlier measured runs):\n{playbook}")
    label = "STARTING VERILOG (naive baseline)" if first else "CURRENT BEST VERILOG"
    parts.append(f"{label}:\n```verilog\n{code.strip()}\n```")
    if last is not None:
        parts.append(f"LAST CHECK RESULT (hidden testbench + yosys + nextpnr-ecp5): {compact(last)}")
        parts.append("Fix what failed first; if it passed, raise Fmax further without breaking it.")
    else:
        parts.append("Rewrite it to pass the testbench and maximize Fmax. You get no test results, so be careful.")
    return "\n\n".join(parts)


def _check(name: str, verilog: str) -> dict:
    from manudesk.checker import check
    return check(name, verilog)


def _safe_check(name: str, verilog: str) -> dict:
    try:
        return _check(name, verilog)
    except Exception as e:  # noqa: BLE001 - a broken checker must not kill the run
        return {"pass": False, "stage": "error", "fix": [f"{type(e).__name__}: {str(e)[:200]}"]}


_KEEP = ("pass", "stage", "mhz", "x", "lat", "use", "fix")


def _row(i: int, c: dict) -> dict:
    return {"iter": i, **{k: c.get(k) for k in _KEEP}}


# ------------------------------------------------------------------ loop

def run(name: str, iters: int = 4, feedback: bool = True, playbook: bool = True,
        model: str | None = None, runs_dir: Path | None = None, quiet: bool = False) -> dict:
    design = get(name)
    model = model or default_model()
    arm = "feedback" if feedback else "blind"
    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{name}-{arm}-{secrets.token_hex(2)}"
    out = (runs_dir or RUNS) / run_id
    out.mkdir(parents=True, exist_ok=True)
    pb = load_playbook() if playbook else ""
    t0 = time.time()

    n = iters if feedback else 1
    best_code, best = None, None      # best passing (by mhz)
    code, last = design.start, None   # what the model sees next
    history, tokens = [], 0
    for i in range(1, n + 1):
        prompt = build_prompt(design, best_code or code, last if feedback else None, pb, first=i == 1)
        try:
            r = chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}], model)
        except Exception as e:  # noqa: BLE001
            c = {"pass": False, "stage": "llm", "fix": [f"{type(e).__name__}: {str(e)[:200]}"]}
            (out / f"check_{i}.json").write_text(json.dumps(c, indent=1), encoding="utf-8")
            history.append(_row(i, c))
            break
        tokens += r["tokens"]
        v = extract_verilog(r["text"])
        if v is None:
            c = {"pass": False, "stage": "static",
                 "fix": ["reply had no ```verilog block" + (" (cut off)" if r["finish"] == "length" else "")]}
        else:
            (out / f"iter_{i}.v").write_text(v, encoding="utf-8")
            c = _safe_check(name, v)
            code = v
            if c.get("pass") and (best is None or (c.get("mhz") or 0) > (best.get("mhz") or 0)):
                best_code, best = v, {**c, "iter": i}
        (out / f"check_{i}.json").write_text(json.dumps(c, indent=1), encoding="utf-8")
        history.append(_row(i, c))
        last = c
        if not quiet:
            print(f"[{name}/{arm}] iter {i}: {c.get('stage')} pass={c.get('pass')} "
                  f"mhz={c.get('mhz')} x={c.get('x')}", file=sys.stderr)

    final = best or (history[-1] if history else {"pass": False, "stage": "llm"})
    summary = {
        "run_id": run_id, "design": name, "arm": arm, "playbook": bool(pb), "model": model,
        "iters": len(history),
        "pass": bool(final.get("pass")), "stage": final.get("stage"),
        "mhz": final.get("mhz"), "x": final.get("x"),
        "target": design.target_mhz, "base": design.baseline_mhz,
        "lat": final.get("lat"), "use": final.get("use"),
        "best_iter": best["iter"] if best else None,
        "history": history, "tokens": tokens, "seconds": round(time.time() - t0, 1),
    }
    if best_code:
        (out / "best.v").write_text(best_code, encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m manudesk.agent", description=__doc__.splitlines()[0])
    ap.add_argument("design")
    ap.add_argument("--iters", type=int, default=4)
    ap.add_argument("--blind", action="store_true", help="no check() feedback; one write, scored at the end")
    ap.add_argument("--no-playbook", action="store_true")
    ap.add_argument("--model", default=None)
    a = ap.parse_args(argv)
    s = run(a.design, a.iters, feedback=not a.blind, playbook=not a.no_playbook, model=a.model)
    print(compact({k: s[k] for k in ("run_id", "design", "arm", "pass", "stage", "mhz", "x", "lat",
                                      "use", "best_iter", "iters", "tokens", "seconds")}))
    return 0 if s["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
