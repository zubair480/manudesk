# ManuDesk: real chip-design tools for AI coding agents

> **AI agents can already write software on their own, but they're locked out of hardware.**
> The tools that test and build chips (simulators, synthesis, place and route, PCB routers) were made for
> engineers clicking through desktop apps and reading 1,000-line logs. An agent can't use them.
>
> **ManuDesk turns those tools into an MCP server.** Any coding agent (Claude Code, Cursor, ChatGPT…) sends its
> Verilog with one `check` call. A few seconds later it gets back a short JSON verdict: did it pass, what
> broke, how fast the chip runs, which wire is the slowest, and how to fix it. Agents can now iterate on real
> hardware the way they iterate on software.

This README is written for **humans** (judges, teammates) and **AI agents** (see
[§10, For AI agents](#10-for-ai-agents)).

---

## Contents

1. [What we built, in one picture](#1-what-we-built-in-one-picture)
2. [Results, from the live database](#2-results-from-the-live-database)
3. [Manufact: how we use mcp-use and Manufact Cloud](#3-manufact-how-we-use-mcp-use-and-manufact-cloud)
4. [InsForge: how we use every part of the platform](#4-insforge-how-we-use-every-part-of-the-platform)
5. [What one `check` call actually does](#5-what-one-check-call-actually-does)
6. [The autonomous agent loop (runs on InsForge)](#6-the-autonomous-agent-loop-runs-on-insforge)
7. [The demo in this branch](#7-the-demo-in-this-branch)
8. [Run it / connect an agent](#8-run-it--connect-an-agent)
9. [Repository map and branches](#9-repository-map-and-branches)
10. [For AI agents](#10-for-ai-agents)
11. [Honest status and limits](#11-honest-status-and-limits)

---

## 1. What we built, in one picture

```
 ┌────────────────────────────┐
 │  Any coding agent          │  Claude Code · Cursor · ChatGPT · any MCP client
 │  "make popcount hit 105MHz"│
 └─────────────┬──────────────┘
               │ MCP (tools, resources, prompt, view)
               ▼
 ┌────────────────────────────┐   MANUFACT
 │  ManuDesk MCP server       │   built with mcp-use 2.10.1 (TypeScript), deployable to Manufact Cloud
 │  manufact/index.ts         │   6 tools · 5 resources · 1 prompt · 1 MCP-App view (check-result)
 └─────────────┬──────────────┘
               │ forwards each tool call (bearer token) to the EDA backend
               ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │  INSFORGE  (project yc-hackathon · https://nden3esm.us-west.insforge.app)                │
 │                                                                                          │
 │  Compute ── ManuDesk EDA server (Docker, Ubuntu 24.04), scales to zero                   │
 │             OSS CAD Suite 2026-10-17: Verilator · Icarus · Yosys · nextpnr-ecp5 ·        │
 │             ecppack · GTKWave │ KiCad 10 · Freerouting 2.4.1 │ Xvfb tool-window streaming │
 │      │ logs every check                                                                  │
 │      ▼                                                                                   │
 │  Database ── md_designs · md_checks · md_runs · md_iterations · md_playbooks ·           │
 │              md_rule_stats   (RLS: public read, writes only via server key)              │
 │  Storage ─── md-artifacts bucket: passing Verilog, results, best designs, playbooks      │
 │  Realtime ── md-checks · md-runs · md-run:<id>   (DB triggers publish every new check)   │
 │  Functions ─ 9 edge functions: run-start · run-step · run-status · leaderboard · tick ·  │
 │              reflect · meta · baselines · run-verilog                                    │
 │  Schedules ─ md-tick every minute; reflect / meta / baselines nightly                    │
 │  AI ──────── OpenRouter (claude-sonnet-5.5) for planner / analyst / engineer / reflector  │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
               │ public reads + realtime
               ▼
 ┌────────────────────────────┐
 │  Dashboards                │  web/ (ManuDesk live guide) · demo/eda-essentials (judge demo)
 └────────────────────────────┘
```

**In plain words:**
- **Manufact (mcp-use)** is the front door agents talk to.
- **InsForge** is everything behind it: the machine with the chip tools, the database that remembers every
  result, the storage for designs, the realtime feed, the scheduled agent loop and the AI calls.

---

## 2. Results, from the live database

All numbers below were read from the InsForge database (`md_checks`, `md_runs`, `md_iterations`) on
2026-10-18. Nothing here is made up or estimated.

| Design | What it is | Starting speed | Best agent result | Speedup | Target |
|---|---|---|---|---|---|
| `popcount` | count the 1s in a 256-bit word | 70.0 MHz | **242.7 MHz** | **3.47×** | 105 ✓ |
| `fir8` | 8-tap digital filter | 66.4 MHz | **215.0 MHz** | **3.24×** | 107 ✓ |
| `mac` | 32×32 multiply-accumulate | 74.4 MHz | **234.1 MHz** | **3.15×** | 138 ✓ |
| `add64cmp` | 64-bit add + compare | 85.7 MHz | baseline | — | 149 |
| `mandel_step` | one Mandelbrot step | 79.1 MHz | baseline | — | 130 |
| `crc32` | CRC-32, 64 bits per cycle | 61.1 MHz | baseline (agent still failing sim) | — | 104 |

**At the time of writing:**
- **59** MCP `check` calls and **12** agent runs. **10** runs reached their target.
- **11** failures were caught by the real tools and fed back to the agent.
- **43** agent steps (planner, analyst and engineer), all on `claude-sonnet-5.5`.
- A full check (lint → hidden testbench → synthesis → place and route) typically takes **5–9 s**. A lint
  failure comes back in **26 ms**.
- **A real fail → fix → pass loop:** `fir8` failed lint at 14:43:52 (26 ms). The agent fixed it and passed at
  **215 MHz** at 14:44:16 (7.2 s check). The whole run, from start to target, took **61 seconds**.

---

## 3. Manufact: how we use mcp-use and Manufact Cloud

Code: [`manufact/`](https://github.com/zubair480/manudesk/tree/insforge-port/manufact) on the `insforge-port` branch.

### 3.1 Why Manufact

An agent only uses a tool well if the tool is easy to discover, typed and self-explaining. mcp-use gives us
all of the MCP spec (tools, resources, resource templates, prompts, completions and MCP Apps views) in one
small TypeScript file. Manufact Cloud then hosts it, so every agent gets one stable URL.

### 3.2 What we used, feature by feature

| mcp-use / Manufact feature | How ManuDesk uses it |
|---|---|
| **`MCPServer`** with `name`, `title`, `version`, `description`, `instructions` | The `instructions` string teaches every agent the loop the moment it connects: `get_design → edit → check → read reasons and critical_path → edit again`, plus "only `accepted:true` counts" and "read `manudesk://playbook` first". |
| **6 tools** (`server.tool`) | `list_designs`, `get_design`, `dsp_helper`, `check`, `pcb_parts`, `pcb_check` (see the table below). |
| **zod `inputSchema`** | Every argument is typed and described. `pcb_check` validates placements as `{ref, x, y, rot}`, board size in mm, and a `fab` flag. |
| **zod `outputSchema` + `structuredContent`** | `check` returns typed, structured output (`accepted`, `stage_reached`, `reasons[]`, `fmax_mhz`, `target_mhz`, `vs_baseline`, `critical_path`, `resources`, `budgets`, `seconds`). Agents and UIs read fields instead of parsing text. |
| **`completable()` argument completion** | The design-name argument autocompletes from the live design list (`list_designs` upstream), so agents and humans can't mistype a design. |
| **Tool annotations** | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` tell clients that checks are safe to call repeatedly and in parallel. |
| **MCP Apps view** (`views/check-result/view.tsx`, `mcp-use/react`) | Hosts that render MCP Apps show each check as a card: pass/fail, Fmax vs target, the slowest path, and resource use vs budget. It uses `useToolContext` and `useViewTheme` and has light and dark palettes. |
| **Resources** | `manudesk://designs` (all designs), `manudesk://lib/mul18x18_reg.v` (the DSP helper), `manudesk://playbook` (the learned timing-closure rules, read live from InsForge `md_playbooks`). |
| **Resource templates** | `manudesk://designs/{name}` (spec) and `manudesk://designs/{name}/start.v` (starting Verilog). |
| **Prompt** | `speed_up`: "Pipeline one design until check() accepts it at or above a target Fmax." One click and an agent runs the whole loop. |
| **Dev inspector** | `npm run dev` → `http://localhost:3000/mcp/inspector` to try every tool by hand. |
| **Manufact Cloud deploy** | `npm run deploy` (`mcp-use deploy`) publishes the server, so agents connect to one hosted URL instead of our VM. |
| **Graceful cold starts** | The EDA backend on InsForge scales to zero. If the first call times out, the server returns `CHECKER_UNAVAILABLE` with "retry in ~30 s. This is not a verdict on your design.", so an agent never mistakes a cold machine for a broken design. |

### 3.3 The six tools

| Tool | What the agent sends | What it gets back |
|---|---|---|
| `list_designs()` | nothing | each design: name, description, top module, baseline MHz, latency and resource budgets |
| `get_design(name)` | a design name | starting Verilog, budgets, goal, rules and device |
| `dsp_helper()` | nothing | Verilog for `mul18x18_reg`, a fully registered 18×18 multiply that maps to one ECP5 DSP block |
| `check(name, verilog)` | the full Verilog file | `{accepted, stage_reached, reasons[{what, fix}], fmax_mhz, target_mhz, baseline_mhz, vs_baseline, latency, critical_path, resources, budgets, seconds}` |
| `pcb_parts(lpf)` | the design's pin file | parts, footprints, nets and a template placement for an add-on PCB that plugs into the ULX3S board |
| `pcb_check(lpf, board_w, board_h, placements, fab)` | a part placement | Freerouting autoroute + KiCad 10 DRC: `{passed, drc_errors, unconnected, vias, violations[]…}`. With `fab:true` it also exports Gerbers, drill, BOM and renders. |

**Why this matters for agents:** `critical_path` is one readable line, for example
`dut.s4[3] -> dut.s5[0]: 5.27 ns … cells on path: CCU2C(carry) x8; Verilog sources: design.v:11`.
It names the exact Verilog line to fix next. That's the difference between an agent guessing and an agent
engineering.

---

## 4. InsForge: how we use every part of the platform

Project **yc-hackathon** (`https://nden3esm.us-west.insforge.app`). Every ManuDesk object is prefixed
(`md_*` tables, `md-*` functions, `md-artifacts` bucket, `MANUDESK_*` secrets), because the same project also
hosts another app and nothing collides.

### 4.1 Compute: the machine with the chip tools

- **One Docker image** (`Dockerfile`, Ubuntu 24.04) contains the entire toolchain:
  - **Simulation and synthesis:** OSS CAD Suite build **2026-10-17** (Verilator, Icarus iverilog/vvp, Yosys,
    nextpnr-ecp5, ecppack, GTKWave).
  - **PCB:** KiCad 10 (`kicad-cli` for DRC, Gerbers and renders), Java 25 and Freerouting 2.4.1.
  - **Tool-window streaming:** Xvfb, xdotool and ImageMagick, so the real nextpnr GUI and GTKWave windows
    can be streamed to a browser (`manudesk/toolstream_x11.py`).
- Runs on **InsForge Compute** at `manudesk-d7b0a23f-….fly.dev`. It **scales to zero** when idle, so it costs
  nothing between demos; `/health` answers 200.
- **Endpoints:**
  - `/mcp` speaks MCP over streamable HTTP. The Manufact server forwards to this, and agents can also
    connect directly.
  - `POST /api/check` is the same check as plain JSON, used by the edge functions.
  - Both sit behind a bearer token (`MANUDESK_TOKEN`).
- **After every check**, compute writes an `md_checks` row and, for passing designs, uploads the Verilog and
  result to storage. This is fire-and-forget, so logging never slows a check (`manudesk/store.py`).

### 4.2 Database: every result, remembered

| Table | Holds |
|---|---|
| `md_designs` | The 6 benchmark designs: top module, summary, baseline MHz, target MHz, latency and resource budgets, starting Verilog. The hidden testbench is **never** stored here. |
| `md_checks` | Every `check` ever run: source (`mcp`, `agent` or `baseline`), pass, stage, MHz, speedup, latency, critical path, LUT/FF/DSP use, fix list, duration, artifact key. |
| `md_runs` | Autonomous agent runs: goal, target, status (`queued → running → reached/exhausted/failed`), current step, iteration, best MHz. |
| `md_iterations` | Each agent step: role (planner, analyst or engineer), model, prompt and completion tokens, input/output, candidate Verilog, linked check, accepted or not. |
| `md_playbooks` | Versioned timing-closure rules the system learned from its own measurements, plus the rules that were dropped and why. |
| `md_rule_stats` | Per-rule effect: speed gain, rejection rate, reached rate and iterations, per design. |

- **Row-level security:** anonymous users can **read** designs, checks (without Verilog), runs, playbooks and
  rule stats, which powers the public leaderboard. **All writes** go through the server key in compute and
  the edge functions.
- **Triggers:** `md_checks_realtime`, `md_runs_realtime` and `md_iterations_realtime` publish to realtime;
  `*_updated_at` triggers keep timestamps.

### 4.3 Storage: the artifacts

Private bucket **`md-artifacts`** (108 objects at the time of writing):
- `checks/<check_id>/design.v`, `checks/<check_id>/result.json`: every passing design and its result;
- `runs/<run_id>/best.v`: the best design of each agent run;
- `playbooks/v<version>.md`: each learned playbook.

### 4.4 Realtime: watch agents work, live

- **What publishes:** a database trigger (`md_rt_checks`) publishes every new check as a `check_added` event,
  with summary fields only (no Verilog).
- **Channels:**
  - `md-checks`: every check, from every agent;
  - `md-run:<run_id>`: one run's checks and iterations;
  - `md-runs`: run status changes.
- **Who listens:** the ManuDesk web dashboard and our judge demo's Results page
  (`demo/eda-essentials/scenes/11-results`). New checks slide in the moment an agent anywhere calls `check`.

### 4.5 Edge functions: the agent platform, serverless

| Function | Access | What it does |
|---|---|---|
| `md-run-start` | token | Validates a design and goal, inserts a queued `md_runs` row, returns the run id. |
| `md-run-step` | token | Advances one run by **one** step (planner → analyst → engineer → check). It calls the LLM through OpenRouter (`claude-sonnet-5.5`) and the EDA tools through compute `POST /api/check`. All state lives in the database, so a step can never get lost. |
| `md-tick` | schedule | Every minute: picks queued and running runs, claims each, calls `md-run-step`. Bounded so it always answers inside the scheduler's time limit. |
| `md-run-status` | public | One run, its iterations (slimmed, without prompts) and its best check, for UIs and agents. |
| `md-leaderboard` | public | Best passing check per design against baseline and target, including the ECP5 DSP datasheet cap (225 MHz) so results stay honest. |
| `md-run-verilog` | public | The Verilog an agent run produced, for the dashboard's code view. The hidden testbench can't leak because it isn't in the database. |
| `md-reflect` | schedule | Rewrites the playbook from what finished runs **measured**. A code gate drops any rule without a measured number, with numbers not in the evidence, or naming a specific design. |
| `md-meta` | schedule | Computes per-rule statistics into `md_rule_stats`. |
| `md-baselines` | schedule | Re-measures every design's starting Verilog through compute (`source = 'baseline'`). |

Callers authenticate with an `x-manudesk-token` header, compared in constant time; only the public reads are
open.

### 4.6 Schedules

As specified in `docs/INSFORGE_PLAN.md`:

| Schedule | When | Calls |
|---|---|---|
| `md-tick` | every minute | advances all live agent runs |
| `md-reflect` | 03:00 daily | learns a new playbook version |
| `md-meta` | 03:30 daily | refreshes rule statistics |
| `md-baselines` | 04:00 daily | re-measures baselines |

### 4.7 AI

Planner, analyst, engineer and reflector all call **OpenRouter** (`MANUDESK_MODEL`, default
`anthropic/claude-sonnet-5.5`). Token counts per step are stored in `md_iterations`, so every run's cost is
auditable.

### 4.8 Secrets

Function secrets (`MANUDESK_TOKEN`, `MANUDESK_COMPUTE_URL`, and optionally `MANUDESK_MODEL`) live in InsForge
secrets, and schedules reference them as `${{secrets.MANUDESK_TOKEN}}`. Nothing is hard-coded.

---

## 5. What one `check` call actually does

Stages run cheapest first; the first failure returns with a reason and a fix.

1. **lint:** sandbox rules (no `initial`, `` `include `` or system tasks), then Verilator `--lint-only`.
2. **interface:** the top module's ports must match the original; `localparam LATENCY` present and within
   budget.
3. **testbench:** a **hidden** 2,000-cycle testbench (random vectors plus edge cases) against a golden model.
   The agent never sees it, so it can't cheat. If outputs are right but late, it tells the agent the real
   latency.
4. **latency_check:** re-run with `LATENCY+1`. It must fail, so a constant or undriven output can't pass.
5. **synth:** Yosys `synth_ecp5`.
6. **pnr:** nextpnr-ecp5 on a Lattice **LFE5U-85F** (speed 6), with a harness that registers every port, so
   no logic escapes timing. (In our earlier Crusoe-Forge pipeline, the same harness exposed a claimed 804.5 MHz that was really 66.6 MHz.)
7. **resources:** LUT, FF and DSP use within the design's budget.

Each check runs in its own temp directory under a 120 s deadline. Results are cached by exact source, so
resubmitting the same file is free.

---

## 6. The autonomous agent loop (runs on InsForge)

```
md-run-start ──▶ md_runs (queued)
                    │  every minute: md-tick ──▶ md-run-step
                    ▼
   planner  ── "done contract": what reaching the target means
   analyst  ── reads the last check's critical path: "carry chain of 48 hops at line 11, pipeline it"
   engineer ── writes new Verilog
   check    ── compute /api/check: real tools, hidden testbench
                    │ accepted? keep best · rejected? feed the reason back
                    ▼
   reached / exhausted ──▶ nightly md-reflect learns rules ──▶ md_playbooks ──▶ manudesk://playbook
```

The system **learns from its own measurements**. The next agent that connects reads the playbook (an MCP
resource) and starts smarter.

---

## 7. The demo in this branch

`demo/eda-essentials/` is a browser walkthrough for judges.

- **The walkthrough:** an agent receives a spec ("8 breathing LEDs on a ULX3S, 25 MHz"), writes Verilog, and
  drives the real tools through MCP calls, shown live in an agent lane at the top:
  **Verilog → Icarus** (test fails → agent patches → 4/4 pass) **→ GTKWave → Yosys → nextpnr 3D chip** (214.96 MHz
  against 25 MHz needed) **→ KiCad 3D board → Results.**
- **Every tool output is real**, captured with OSS CAD Suite (`demo/eda-essentials/real/`).
- **The Results page is live from InsForge.** The leaderboard comes from the public `md-leaderboard` function,
  refreshed every 3 s. The check feed is subscribed to realtime `md-checks`.

```bash
cd demo/eda-essentials && python -m http.server 5174     # open http://localhost:5174/
```

For the live feed, add `demo/eda-essentials/config.local.json` (untracked):
`{"baseUrl":"https://nden3esm.us-west.insforge.app","anonKey":"<public anon key>"}`.

---

## 8. Run it / connect an agent

**Through Manufact (mcp-use):**

```bash
cd manufact && npm install
npm run dev          # inspector at http://localhost:3000/mcp/inspector
npm run deploy       # publish to Manufact Cloud
```

Env: `MANUDESK_UPSTREAM` (compute `/mcp` URL), `MANUDESK_TOKEN`, `INSFORGE_URL`, `INSFORGE_ANON_KEY`.

**Direct to the EDA backend (Claude Code):**

```bash
claude mcp add --transport http manudesk <compute-url>/mcp --header "Authorization: Bearer $MANUDESK_TOKEN"
```

**Locally, with the OSS CAD Suite installed:**

```bash
uv sync && cp .env.example .env
uv run python -m manudesk.server --transport http --host 0.0.0.0 --port 8765
uv run python scripts/mcp_smoke.py
```

---

## 9. Repository map and branches

| Branch | What's there |
|---|---|
| `main` | Core: hidden-testbench checker, ECP5 place and route, Python MCP server, agent loop, web guide |
| `insforge-port` | **Manufact server** (`manufact/`), **InsForge** edge functions (`insforge/functions/`), migrations (`migrations/`), Dockerfile for compute, PCB pipeline (`manudesk/pcb/`), toolstream, `docs/INSFORGE_PLAN.md` |
| `demo/eda-essentials` | This README and the judge demo (`demo/eda-essentials/`) |

```
manudesk/     checker.py (gates) · eda.py (tool wrappers) · server.py (MCP) · store.py (InsForge logging)
              pcb/ (KiCad + Freerouting) · toolstream*.py (live tool windows) · agent.py · playbook.py
manufact/     index.ts (mcp-use server) · views/check-result/view.tsx (MCP App view)
insforge/     functions/md-*.ts (9 edge functions)
migrations/   schema, seed designs + playbook, realtime feed
designs/      <name>/{spec.json, start.v, tb.v (hidden)}
demo/         eda-essentials/ (judge walkthrough, live results)
```

---

## 10. For AI agents

If you are an agent reading this:

1. Connect to the `manudesk` MCP server. Read `manudesk://playbook` first.
2. `list_designs()`, then `get_design(name)`. Start from the given Verilog; keep the port list identical.
3. Edit, then `check(name, verilog)`. Only `accepted: true` counts. Never claim a design works or is faster
   without a check result that says so.
4. On failure, read `reasons[].fix`. On success below target, fix the line named in `critical_path`
   (usually: pipeline the long carry chain, register the multiplier with `dsp_helper()`), then `check` again.
5. Respect `LATENCY` and the resource budgets; the hidden testbench and the `LATENCY+1` check will catch cheats.
6. `CHECKER_UNAVAILABLE` means the backend is waking up. Retry in about 30 s; it is not a verdict.
7. For boards: `pcb_parts(lpf)`, then place, then `pcb_check(...)` until `passed: true` (0 DRC errors, 0
   unconnected), then `fab: true` for manufacturing files.

---

## 11. Honest status and limits

- **Designs:** `check` scores the 6 built-in designs, because each needs a hidden testbench. Arbitrary user
  designs are next.
- **Demo vs live service:** the walkthrough demo in this branch replays real captures made locally. The
  Results page and leaderboard are live.
- **Cold starts:** compute scales to zero, so the first call after idle can take about 30 s.
- **DSP speed cap:** nextpnr can't time the multiplier inside an ECP5 DSP, so the leaderboard caps
  DSP designs at the 225 MHz datasheet limit.
- **Formal verification and cocotb** (shown in our longer demo) aren't part of the MCP yet; they're roadmap.

Built at the YC hackathon, 2026-10-18.
