"""Offline tests for the agent loop, the playbook reflector and the eval table (no network, no EDA)."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from manudesk import agent, playbook

GOOD = "```verilog\nmodule mac(input clk); localparam LATENCY = 4; endmodule\n```"


def ok(mhz, **kw):
    return {"pass": True, "stage": "ok", "fix": [], "mhz": mhz, "x": round(mhz / 73.9, 2), "lat": 4,
            "use": {"LUT": 100, "FF": 200, "DSP": 4}, "path": "a_r -> acc_r", **kw}


def bad(stage="sim", fix=("acc wrong at cycle 3",)):
    return {"pass": False, "stage": stage, "fix": list(fix), "mhz": None, "x": None}


@pytest.fixture
def fake(monkeypatch, tmp_path):
    """Script the LLM replies and check() results; record the prompts."""
    st = SimpleNamespace(replies=[], checks=[], prompts=[], checked=[])

    def chat(messages, model=None, **kw):
        st.prompts.append(messages[-1]["content"])
        return {"text": st.replies.pop(0), "finish": "stop", "tokens": 10}

    def check(name, v):
        st.checked.append(v)
        return st.checks.pop(0)

    monkeypatch.setattr(agent, "chat", chat)
    monkeypatch.setattr(agent, "_check", check)
    monkeypatch.setattr(agent, "default_model", lambda: "test-model")
    st.runs = tmp_path
    return st


# ------------------------------------------------------------------ extraction

def test_extract_prefers_last_verilog_block():
    text = "plan\n```text\nnot code\n```\n```verilog\nmodule a; endmodule\n```\n```verilog\nmodule b; endmodule\n```"
    assert agent.extract_verilog(text).startswith("module b")


def test_extract_untagged_and_unterminated():
    assert "module c" in agent.extract_verilog("```\nmodule c; endmodule\n```")
    assert agent.extract_verilog("```verilog\nmodule d; endmodule\n").startswith("module d")
    assert agent.extract_verilog("sorry, no code") is None


# ------------------------------------------------------------------ loop

def test_feedback_loop_keeps_best_passing_and_saves(fake):
    fake.replies = [GOOD] * 4
    fake.checks = [bad(), ok(120.0), ok(150.5), ok(140.0)]
    s = agent.run("mac", iters=4, runs_dir=fake.runs, quiet=True)
    assert s["pass"] and s["mhz"] == 150.5 and s["best_iter"] == 3 and s["arm"] == "feedback"
    assert [h["stage"] for h in s["history"]] == ["sim", "ok", "ok", "ok"]
    d = fake.runs / s["run_id"]
    assert (d / "iter_4.v").exists() and (d / "check_1.json").exists() and (d / "best.v").exists()
    assert json.loads((d / "summary.json").read_text())["mhz"] == 150.5
    # iteration 2 saw the failing check JSON; iteration 4 saw the best (iter 3) code's result chain
    assert '"stage":"sim"' in fake.prompts[1] and "acc wrong at cycle 3" in fake.prompts[1]
    assert "CURRENT BEST VERILOG" in fake.prompts[3]
    assert "STARTING VERILOG" in fake.prompts[0]


def test_failed_run_reports_last_stage(fake):
    fake.replies = [GOOD, GOOD]
    fake.checks = [bad("lint", ["syntax error line 3"]), bad("pnr", ["no fit"])]
    s = agent.run("mac", iters=2, runs_dir=fake.runs, quiet=True)
    assert not s["pass"] and s["stage"] == "pnr" and s["best_iter"] is None


def test_blind_arm_writes_once_without_feedback(fake):
    fake.replies = [GOOD]
    fake.checks = [ok(99.0)]
    s = agent.run("mac", iters=4, feedback=False, runs_dir=fake.runs, quiet=True)
    assert s["arm"] == "blind" and s["iters"] == 1 and s["pass"] and s["mhz"] == 99.0
    assert len(fake.prompts) == 1 and "LAST CHECK RESULT" not in fake.prompts[0]


def test_missing_block_skips_check(fake):
    fake.replies = ["I would pipeline it.", GOOD]
    fake.checks = [ok(130.0)]
    s = agent.run("mac", iters=2, runs_dir=fake.runs, quiet=True)
    assert s["history"][0]["stage"] == "static" and len(fake.checked) == 1 and s["pass"]


def test_playbook_toggle(fake, monkeypatch):
    monkeypatch.setattr(agent, "load_playbook", lambda path=None: "1. SECRET RULE 42")
    fake.replies = [GOOD, GOOD]
    fake.checks = [ok(100.0), ok(100.0)]
    agent.run("mac", iters=1, runs_dir=fake.runs, quiet=True)
    agent.run("mac", iters=1, playbook=False, runs_dir=fake.runs, quiet=True)
    assert "SECRET RULE" in fake.prompts[0] and "SECRET RULE" not in fake.prompts[1]


def test_checker_exception_is_contained(fake, monkeypatch):
    monkeypatch.setattr(agent, "_check", lambda n, v: 1 / 0)
    fake.replies = [GOOD]
    s = agent.run("mac", iters=1, runs_dir=fake.runs, quiet=True)
    assert s["stage"] == "error" and "ZeroDivisionError" in s["history"][0]["fix"][0]


# ------------------------------------------------------------------ chat() retries

class FakeAPIError(Exception):
    def __init__(self, code):
        super().__init__(f"http {code}")
        self.status_code = code


def _resp(content, finish="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content),
                                                    finish_reason=finish)],
                           usage=SimpleNamespace(total_tokens=7))


def _client(script, seen):
    def create(**kw):
        seen.append(kw)
        item = script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def test_chat_doubles_tokens_when_cut_off(monkeypatch):
    seen = []
    c = _client([_resp("", "length"), _resp("\n\nhi")], seen)
    monkeypatch.setattr(agent, "_openai", lambda: c)
    r = agent.chat([{"role": "user", "content": "x"}], "m", max_tokens=1000)
    assert r["text"] == "hi" and r["tokens"] == 14
    assert [k["max_tokens"] for k in seen] == [4096, 8192]  # floor of 4096, then doubled


def test_chat_retries_only_429_503(monkeypatch):
    monkeypatch.setattr(agent.time, "sleep", lambda s: None)
    seen = []
    c = _client([FakeAPIError(429), FakeAPIError(503), _resp("ok")], seen)
    monkeypatch.setattr(agent, "_openai", lambda: c)
    assert agent.chat([], "m")["text"] == "ok" and len(seen) == 3
    c = _client([FakeAPIError(400), _resp("ok")], [])
    monkeypatch.setattr(agent, "_openai", lambda: c)
    with pytest.raises(FakeAPIError):
        agent.chat([], "m")


# ------------------------------------------------------------------ playbook

SUMMARIES = [
    {"design": "mac", "arm": "feedback", "pass": True, "mhz": 141.37, "x": 1.91, "base": 73.9,
     "target": 138, "lat": 6, "use": {"DSP": 4}, "history": [{"stage": "sim", "mhz": None, "fix": ["lat"]},
                                                             {"stage": "ok", "mhz": 141.37, "fix": []}]},
    {"design": "mac", "arm": "blind", "pass": False, "stage": "sim", "mhz": None, "x": None,
     "history": [{"stage": "sim", "mhz": None, "fix": ["acc wrong"]}]},
]


def test_gate_drops_unmeasured_numbers():
    allowed = playbook.numbers(playbook.evidence(SUMMARIES))
    keep, drop = playbook.gate([
        "Split the 32x32 multiply into DSP limbs: mac reached 141.4 MHz (1.91x).",  # 141.4 ~ 141.37
        "Pipelining always gives 300 MHz.",                                           # invented
        "Be careful with latency.",                                                   # no number
    ], allowed | {"32"})
    assert keep == ["Split the 32x32 multiply into DSP limbs: mac reached 141.4 MHz (1.91x)."]
    assert len(drop) == 2


def test_reflect_writes_and_archives(monkeypatch, tmp_path):
    pb = tmp_path / "fpga.md"
    pb.write_text("# old\n1. Use mul18x18_reg (latency 2).\n", encoding="utf-8")
    monkeypatch.setattr(playbook, "ARCHIVE", tmp_path / "arch")
    reply = "\n".join(["1. Use mul18x18_reg limbs; mac hit 141.37 MHz at latency 6.",
                       "2. Invented: crc32 reached 999 MHz.",
                       *[f"{i}. Keep latency 2 multipliers registered{'!' * i}" for i in range(3, 12)]])
    monkeypatch.setattr(agent, "chat", lambda *a, **k: {"text": reply, "finish": "stop", "tokens": 1})
    r = playbook.reflect(SUMMARIES, path=pb)
    text = pb.read_text(encoding="utf-8")
    assert "999" not in text and "141.37" in text and r["changed"]
    assert len(playbook.parse_rules(text)) == playbook.MAX_RULES
    arch = sorted(p.name for p in (tmp_path / "arch").iterdir())
    assert any("seed" in n for n in arch) and any(n.endswith("-v.md") for n in arch)


def test_reflect_keeps_playbook_when_nothing_survives(monkeypatch, tmp_path):
    pb = tmp_path / "fpga.md"
    pb.write_text("# old\n1. rule 2\n", encoding="utf-8")
    monkeypatch.setattr(playbook, "ARCHIVE", tmp_path / "arch")
    monkeypatch.setattr(agent, "chat", lambda *a, **k: {"text": "1. Always 777 MHz.", "finish": "stop", "tokens": 1})
    r = playbook.reflect(SUMMARIES, path=pb)
    assert not r["changed"] and pb.read_text(encoding="utf-8") == "# old\n1. rule 2\n"


def test_seed_playbook_is_short():
    rules = playbook.parse_rules(agent.load_playbook())
    assert 1 <= len(rules) <= playbook.MAX_RULES


# ------------------------------------------------------------------ eval

def test_eval_table(monkeypatch, tmp_path, fake):
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("evalmod", Path(__file__).parent.parent / "scripts" / "eval.py")
    ev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ev)

    def run(d, iters, feedback=True, **kw):
        if feedback:
            return {"design": d, "arm": "feedback", "pass": True, "stage": "ok", "mhz": 150.0, "x": 2.03}
        return {"design": d, "arm": "blind", "pass": d != "mac", "stage": "sim", "mhz": 80.0, "x": 1.08}

    monkeypatch.setattr(ev.agent, "run", run)
    out = tmp_path / "eval.json"
    assert ev.main(["mac", "popcount", "-n", "2", "--out", str(out)]) == 0
    rep = json.loads(out.read_text())
    assert rep["totals"]["feedback"]["correct"] == 4 and rep["totals"]["blind"]["wrong"] == 2
    assert rep["designs"]["mac"]["blind"]["mhz_med"] is None
    assert rep["designs"]["popcount"]["feedback"]["x_med"] == 2.03
