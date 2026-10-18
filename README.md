# ManuDesk: real chip-design tools for AI coding agents

> **AI agents can already write software on their own, but they're locked out of hardware.**
> The tools that test and build chips (simulators, synthesis, place and route) were made for engineers
> clicking through desktop apps and reading 1,000-line logs. An agent can't use them.
>
> **ManuDesk turns those tools into an MCP server.** Any coding agent (Claude Code, Cursor, any MCP client)
> sends its Verilog with one `check` call. A few seconds later it gets back a short JSON verdict: did it pass,
> what broke, how fast the chip runs, which wire is the slowest, and how to fix it. Agents can now iterate on
> real hardware the way they iterate on software.

This README is for **humans** (judges, teammates) and **AI agents** ([§10](#10-for-ai-agents)).

**Where things live.** This `main` branch is the **core product**: the checker, the EDA tool wrappers, the MCP
server, the agent loop and the live dashboard. Two branches build on it:

| Branch | Adds on top of `main` |
|---|---|
| **`main`** (this one) | Hidden-testbench checker · Yosys/nextpnr-ecp5 wrappers · Python MCP server (`list_designs`, `get_design`, `check`) · reference agent loop and learned playbook · VM deploy · web dashboard reading InsForge |
| [`insforge-port`](https://github.com/zubair480/manudesk/tree/insforge-port) | **Manufact** MCP server (`manufact/`, mcp-use) · **InsForge** edge functions, migrations, compute Dockerfile · structured `check` output · PCB tools (KiCad + Freerouting) · live tool-window streaming |
| [`demo/eda-essentials`](https://github.com/zubair480/manudesk/tree/demo/eda-essentials) | The judge demo: a browser walkthrough plus a live Results page from InsForge |

---

## Contents

1. [What we built, in one picture](#1-what-we-built-in-one-picture)
2. [Results, from the live database](#2-results-from-the-live-database)
3. [The core on `main`: MCP server and checker](#3-the-core-on-main-mcp-server-and-checker)
4. [Manufact: how we use mcp-use and Manufact Cloud](#4-manufact-how-we-use-mcp-use-and-manufact-cloud)
5. [InsForge: how we use every part of the platform](#5-insforge-how-we-use-every-part-of-the-platform)
6. [The agent loop and the learned playbook](#6-the-agent-loop-and-the-learned-playbook)
7. [The dashboard and the judge demo](#7-the-dashboard-and-the-judge-demo)
8. [Run it / connect an agent](#8-run-it--connect-an-agent)
9. [Repository map](#9-repository-map)
10. [For AI agents](#10-for-ai-agents)
11. [Honest status and limits](#11-honest-status-and-limits)

---

## 1. What we built, in one picture

```
 ┌────────────────────────────┐
 │  Any coding agent          │  Claude Code · Cursor · any MCP client
 │  "make popcount hit 105MHz"│
 └─────────────┬──────────────┘
               │ MCP
               ▼
 ┌────────────────────────────┐  MANUFACT  (branch insforge-port: manufact/)
 │  Hosted MCP front door     │  mcp-use 2.10.1 · 6 tools · resources · prompt · check-result view
 └─────────────┬──────────────┘  deploys to Manufact Cloud; forwards every call to ↓
               │
 ┌─────────────▼──────────────────────────────────────────────────────────┐
 │  ManuDesk EDA server   ← THE CORE, on main: manudesk/                   │
 │  server.py  MCP over HTTP (/mcp, bearer token) + /health                │
 │  checker.py lint → hidden testbench → mutation → synth → P&R → budget   │
 │  eda.py     Verilator · Icarus · Yosys synth_ecp5 · nextpnr-ecp5        │
 │  Runs on: a Crusoe VM (main: deploy/, scripts/deploy.sh)                │
 │       or: InsForge Compute, Docker image (insforge-port: Dockerfile)    │
 └─────────────┬──────────────────────────────────────────────────────────┘
               │ logs every check
 ┌─────────────▼──────────────────────────────────────────────────────────┐
 │  INSFORGE  (project yc-hackathon · nden3esm.us-west.insforge.app)       │
 │  Database: md_designs · md_checks · md_runs · md_iterations · ...       │
 │  Storage: md-artifacts · Realtime: md-checks / md-runs / md-run:<id>    │
 │  9 edge functions + schedules run the autonomous agent loop             │
 │  (code: insforge-port: insforge/functions/, migrations/)                │
 └─────────────┬──────────────────────────────────────────────────────────┘
               │ public reads + realtime
 ┌─────────────▼──────────────┐
 │  Dashboards                │  main: web/ (live guide of agent runs)
 │                            │  demo/eda-essentials: judge walkthrough
 └────────────────────────────┘
```

**In plain words:**
- **`main`** is the engine: it runs the real chip tools and judges the agent's Verilog.
- **Manufact** is the front door agents connect to.
- **InsForge** is the platform around it: the hosted tool machine, the memory of every result, live
  updates, and the scheduled agent loop.

---

## 2. Results, from the live database

All numbers were read from InsForge (`md_checks`, `md_runs`, `md_iterations`) on 2026-10-18. Every check was
produced by the checker on `main`.

| Design | What it is | Starting speed | Best agent result | Speedup | Target |
|---|---|---|---|---|---|
| `popcount` | count the 1s in a 256-bit word | 70.0 MHz | **242.7 MHz** | **3.47×** | 105 ✓ |
| `fir8` | 8-tap digital filter | 66.4 MHz | **215.0 MHz** | **3.24×** | 107 ✓ |
| `mac` | 32×32 multiply-accumulate | 74.4 MHz | **234.1 MHz** | **3.15×** | 138 ✓ |
| `add64cmp` | 64-bit add + compare | 85.7 MHz | baseline | — | 149 |
| `mandel_step` | one Mandelbrot step | 79.1 MHz | baseline | — | 130 |
| `crc32` | CRC-32, 64 bits per cycle | 61.1 MHz | baseline | — | 104 |

**At the time of writing:**
- **59** MCP `check` calls and **12** agent runs. **10** runs reached their target.
- **11** failures were caught by the real tools and fed back to the agent.
- **43** agent steps, all on `claude-sonnet-5.5`.
- A full check (lint → hidden testbench → synthesis → place and route) typically takes **5–9 s**. A lint
  failure comes back in **26 ms**.
- **A real fail → fix → pass loop:** `fir8` failed lint at 14:43:52 (26 ms). The agent fixed it and passed at
  **215 MHz** at 14:44:16. The whole run, from start to target, took **61 seconds**.

---

## 3. The core on `main`: MCP server and checker

### 3.1 The MCP server (`manudesk/server.py`)

- Built with the official Python `mcp` SDK. Streamable HTTP at **`/mcp`**, behind a bearer token
  (`MANUDESK_TOKEN`); `GET /health` is open.
- Checks run in parallel up to `MANUDESK_PARALLEL` (default: half the CPU cores).
- The server sends **instructions** to every agent: *list_designs → get_design → edit → check → read `fix` and
  `path` → repeat. Never claim a design works or is faster without a check result that says so.*

| Tool | Returns |
|---|---|
| `list_designs()` | Each design with its target and baseline MHz, latency budget and resource budget |
| `get_design(name)` | The starting Verilog and the rules `check` enforces |
| `check(name, verilog)` | `pass`, `stage`, `fix[]`, `mhz`, `x` (speedup), `lat`, `path` (slowest path), `use` (LUT/FF/DSP) |

A real `check` reply (about 270 characters, so it's cheap in tokens):

```json
{"pass":true,"stage":"ok","fix":["correct; 74.4 MHz is below target 138: shorten the slowest path"],
 "mhz":74.4,"target":138,"base":74.4,"x":1.0,"lat":2,
 "path":"a_r->acc_r 13.43ns (48 logic hops, logic 7.35 route 5.56) carryx48 @L11,L19",
 "use":{"LUT":265,"FF":128,"DSP":4}}
```

`path` names the start and end registers, the delay split, the dominant cell type, and the **Verilog source
lines** (`@L11`) on the slowest path. The agent knows exactly what to pipeline next: that's the difference
between an agent guessing and an agent engineering.

### 3.2 What `check` does (`manudesk/checker.py`, `manudesk/eda.py`)

Cheapest gate first; the first failure returns with a `fix` list.

1. **static:** top module present, `localparam LATENCY` within budget, no `initial`, `` `include `` or system
   tasks (keeps the sandbox closed).
2. **lint:** Verilator.
3. **sim:** a 2,000-cycle **hidden** self-checking testbench the agent never sees. If the outputs are right but
   shifted, it tells the agent the real latency.
4. **mutation:** re-run with `LATENCY+1`. It must fail, so a constant or undriven output can't pass.
5. **synth + ports:** Yosys `synth_ecp5`; the port list must match the original.
6. **pnr:** nextpnr-ecp5 on an LFE5U-85F-6BG381C, with every port registered by a harness, so logic before
   the first register can't escape timing.
7. **budget:** LUT, FF and DSP use within the design's budget.

Results are cached by exact source, so resubmitting the same file is free.

### 3.3 Designs (`designs/<name>/{spec.json, start.v, tb.v}`)

Six benchmark designs, each with a naive starting file and a hidden testbench (`tb.v` is never returned to
agents). Baselines are measured by this checker (`scripts/measure_baselines.py`):

| Design | What | Baseline | Target |
|---|---|---|---|
| `mac` | 32×32 multiply-accumulate, 64-bit | 74.4 MHz | 138 MHz |
| `fir8` | 8-tap signed FIR | 66.4 MHz | 107 MHz |
| `add64cmp` | three-operand 64-bit add + compare | 85.7 MHz | 149 MHz |
| `crc32` | CRC-32 over 64 bits per cycle | 61.1 MHz | 104 MHz |
| `popcount` | popcount of a 256-bit word | 70.0 MHz | 105 MHz |
| `mandel_step` | one Q3.14 Mandelbrot iteration | 79.1 MHz | 130 MHz |

---

## 4. Manufact: how we use mcp-use and Manufact Cloud

Code: [`manufact/` on `insforge-port`](https://github.com/zubair480/manudesk/tree/insforge-port/manufact). It is a
TypeScript front door built on **mcp-use 2.10.1** that forwards every tool call to the core EDA server from
§3. Agents get a richer, typed, discoverable interface; the engine stays the same.

### 4.1 Why Manufact

An agent only uses a tool well if the tool is easy to discover, typed and self-explaining. mcp-use gives us
the whole MCP spec (tools, resources, resource templates, prompts, completions and MCP Apps views) in one
small file. Manufact Cloud hosts it, so every agent gets one stable URL.

### 4.2 What we used, feature by feature

| mcp-use / Manufact feature | How ManuDesk uses it |
|---|---|
| **`MCPServer`** with `name`, `title`, `version`, `description`, `instructions` | The instructions teach every agent the loop on connect, plus "only `accepted:true` counts" and "read `manudesk://playbook` first". |
| **6 tools** | `list_designs`, `get_design`, `dsp_helper`, `check`, `pcb_parts`, `pcb_check` (table below). |
| **zod `inputSchema`** | Every argument is typed and described. `pcb_check` validates placements as `{ref, x, y, rot}`, board size in mm, and a `fab` flag. |
| **zod `outputSchema` + `structuredContent`** | `check` returns typed output (`accepted`, `stage_reached`, `reasons[{what, fix}]`, `fmax_mhz`, `target_mhz`, `vs_baseline`, `critical_path`, `resources`, `budgets`, `seconds`), so agents and UIs read fields instead of parsing text. |
| **`completable()`** | The design-name argument autocompletes from the live design list. |
| **Tool annotations** | `readOnlyHint`, `idempotentHint`, `openWorldHint:false`: checks are safe to repeat and run in parallel. |
| **MCP Apps view** (`views/check-result/view.tsx`, `mcp-use/react`) | Hosts that render MCP Apps show each check as a card: pass/fail, Fmax vs target, the slowest path, and resources vs budget, in light and dark themes. |
| **Resources** | `manudesk://designs`, `manudesk://lib/mul18x18_reg.v` (the DSP helper), `manudesk://playbook` (learned rules, read live from InsForge `md_playbooks`). |
| **Resource templates** | `manudesk://designs/{name}` and `manudesk://designs/{name}/start.v`. |
| **Prompt** | `speed_up`: "Pipeline one design until check() accepts it at or above a target Fmax." |
| **Dev inspector** | `npm run dev` → `http://localhost:3000/mcp/inspector`. |
| **Manufact Cloud deploy** | `npm run deploy` (`mcp-use deploy`) publishes it, so agents connect to one hosted URL. |
| **Graceful cold starts** | If the EDA backend is asleep, the server returns `CHECKER_UNAVAILABLE` ("retry in ~30 s. This is not a verdict on your design."), so an agent never mistakes a cold machine for a broken design. |

### 4.3 The six tools

| Tool | Agent sends | Agent gets |
|---|---|---|
| `list_designs()` | nothing | designs with baselines and budgets |
| `get_design(name)` | design name | starting Verilog, budgets, goal, rules, device |
| `dsp_helper()` | nothing | `mul18x18_reg`: a registered 18×18 multiply that maps to one ECP5 DSP |
| `check(name, verilog)` | full Verilog | the structured verdict above |
| `pcb_parts(lpf)` | the design's pin file | parts, nets and a template placement for an add-on PCB for the ULX3S |
| `pcb_check(lpf, board_w, board_h, placements, fab)` | a placement | Freerouting autoroute + KiCad 10 DRC; with `fab:true`, Gerbers, drill, BOM and renders |

The first four map to the core tools on `main`. The PCB tools come from `manudesk/pcb/` on `insforge-port`.

---

## 5. InsForge: how we use every part of the platform

Project **yc-hackathon** (`https://nden3esm.us-west.insforge.app`). Every ManuDesk object is prefixed (`md_*`,
`md-*`, `md-artifacts`, `MANUDESK_*`), because the project also hosts another app. The integration code is
on [`insforge-port`](https://github.com/zubair480/manudesk/tree/insforge-port) (`insforge/functions/`,
`migrations/`, `Dockerfile`, `manudesk/store.py`, `docs/INSFORGE_PLAN.md`). The dashboard on `main` (`web/`)
already reads from it.

### 5.1 Compute: the core, hosted

- **The image:** the EDA server from `main`, packaged in one Docker image (Ubuntu 24.04). It contains:
  - OSS CAD Suite **2026-10-17** (Verilator, Icarus, Yosys, nextpnr-ecp5, ecppack, GTKWave);
  - KiCad 10, Java 25 and Freerouting 2.4.1;
  - Xvfb, xdotool and ImageMagick, to stream the real nextpnr and GTKWave windows to a browser.
- **Hosting:** runs on **InsForge Compute** and **scales to zero** when idle.
- **Endpoints:** `/mcp` (MCP) and `POST /api/check` (the same check as JSON, for the edge functions), both
  behind `MANUDESK_TOKEN`.
- **Logging:** after every check it writes an `md_checks` row, and for passing designs uploads the Verilog
  and result to storage. This is fire-and-forget, so logging never slows a check.

### 5.2 Database

| Table | Holds |
|---|---|
| `md_designs` | The 6 designs: top, summary, baseline and target MHz, budgets, starting Verilog. The hidden testbench is **never** stored. |
| `md_checks` | Every `check`: source (`mcp`, `agent` or `baseline`), pass, stage, MHz, speedup, latency, critical path, resources, fix list, duration, artifact key. |
| `md_runs` | Agent runs: goal, target, status (`queued → running → reached/exhausted/failed`), step, iteration, best MHz. |
| `md_iterations` | Each agent step: role, model, tokens, input/output, candidate Verilog, linked check, accepted. |
| `md_playbooks` | Versioned timing-closure rules learned from measurements, plus the rules that were dropped. |
| `md_rule_stats` | Per-rule speed gain, rejection rate, reached rate and iterations. |

**Row-level security:** anonymous users can read designs, checks (without Verilog), runs, playbooks and rule
stats, which powers the public leaderboard. **All writes** go through the server key.

### 5.3 Storage

Private bucket **`md-artifacts`** (108 objects at the time of writing):
- `checks/<id>/design.v` and `result.json`;
- `runs/<id>/best.v`;
- `playbooks/v<n>.md`.

### 5.4 Realtime

- A database trigger (`md_rt_checks`) publishes every new check as a `check_added` event, without the Verilog.
- **Channels:**
  - `md-checks`: every check;
  - `md-run:<run_id>`: one run;
  - `md-runs`: run status changes.
- The dashboards update the moment any agent calls `check`.

### 5.5 Edge functions

| Function | Access | Does |
|---|---|---|
| `md-run-start` | token | Validates a design and goal, queues an `md_runs` row. |
| `md-run-step` | token | Advances one run by **one** step: planner → analyst → engineer (OpenRouter, `claude-sonnet-5.5`) → check (compute `/api/check`). State lives in the DB. |
| `md-tick` | schedule | Every minute: claims queued and running runs and calls `md-run-step`, bounded so it stays inside the scheduler's limit. |
| `md-run-status` | public | A run, its slimmed iterations and its best check. |
| `md-leaderboard` | public | Best passing check per design vs baseline and target, with the ECP5 DSP datasheet cap (225 MHz). |
| `md-run-verilog` | public | The Verilog a run produced, for the code view. The testbench can't leak because it isn't stored. |
| `md-reflect` | schedule | Rewrites the playbook from measured results. A code gate drops any rule without a measured number. |
| `md-meta` | schedule | Per-rule statistics into `md_rule_stats`. |
| `md-baselines` | schedule | Re-measures each design's starting Verilog. |

Callers send `x-manudesk-token` (constant-time compare); only the public reads are open.

### 5.6 Schedules, AI and secrets

- **Schedules** (from `docs/INSFORGE_PLAN.md`):
  - `md-tick` every minute;
  - `md-reflect` at 03:00, `md-meta` at 03:30 and `md-baselines` at 04:00 daily.
- **AI:** planner, analyst, engineer and reflector call **OpenRouter** (`MANUDESK_MODEL`, default
  `anthropic/claude-sonnet-5.5`). Tokens per step are stored, so every run's cost is auditable.
- **Secrets:** `MANUDESK_TOKEN`, `MANUDESK_COMPUTE_URL` and others live in InsForge secrets, referenced as
  `${{secrets.MANUDESK_TOKEN}}`. Nothing is hard-coded.

---

## 6. The agent loop and the learned playbook

**On `main`:**
- **`manudesk/agent.py`** is a reference engineer loop that uses the same `check` the MCP exposes (Nemotron
  on Crusoe Managed Inference).
- **`manudesk/playbook.py`** rewrites `playbooks/fpga.md` from measured runs; a code gate drops any rule whose
  numbers aren't in the evidence.
- **`scripts/eval.py`** compares a **blind** arm (no tool feedback) with a **feedback** arm on every design.
  That is the experiment behind "agents need this".

**On InsForge** (`insforge-port`), the same loop runs serverless and on a schedule:

```
md-run-start ──▶ md_runs (queued)
                    │  every minute: md-tick ──▶ md-run-step
                    ▼
   planner  ── what reaching the target means
   analyst  ── reads the last critical path: "48-hop carry chain at line 11, pipeline it"
   engineer ── writes new Verilog
   check    ── real tools, hidden testbench
                    │ keep the best · feed failures back
                    ▼
   reached ──▶ nightly md-reflect ──▶ md_playbooks ──▶ manudesk://playbook (next agent starts smarter)
```

---

## 7. The dashboard and the judge demo

- **`web/` (on `main`):** a live guide of agent runs on InsForge (Vite).
  - Shows the runs list, check cards, the floorplan and Fmax per check.
  - Reads `md_runs`, `md_checks` and `md_designs` with the public anon key (`VITE_INSFORGE_URL`,
    `VITE_INSFORGE_ANON_KEY`) and subscribes to realtime.
  - Falls back to bundled sample data when offline.
- **[`demo/eda-essentials`](https://github.com/zubair480/manudesk/tree/demo/eda-essentials/demo/eda-essentials)**
  (judge demo):
  - **The walkthrough:** an agent takes an 8-LED PWM design through Verilog → Icarus (fail → fix → pass)
    → GTKWave → Yosys → a 3D nextpnr chip view (214.96 MHz against 25 MHz needed) → a 3D KiCad board.
    Every output is real and captured locally.
  - **The Results page is live:** the `md-leaderboard` function plus the realtime `md-checks` channel.

---

## 8. Run it / connect an agent

**Core server (this branch).** Needs the
[OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build); set `MANUDESK_TOOLS` to its `bin` if it isn't
auto-detected.

```bash
uv sync
cp .env.example .env        # MANUDESK_TOKEN (and CRUSOE_API_KEY for the built-in agent)
uv run python -m manudesk.server --host 0.0.0.0 --port 8765
uv run python scripts/mcp_smoke.py      # list, get, check over real MCP
uv run pytest -q
```

**Connect Claude Code:**

```bash
claude mcp add --transport http manudesk http://<host>:8765/mcp --header "Authorization: Bearer $MANUDESK_TOKEN"
```

Cursor and troubleshooting: [docs/CONNECT.md](docs/CONNECT.md). `scripts/connect.sh` prints both configs.
Deploy to the VM with `bash scripts/deploy.sh` (systemd unit in `deploy/`).

**Manufact front door** (`insforge-port` branch):

```bash
cd manufact && npm install && npm run dev     # inspector: http://localhost:3000/mcp/inspector
npm run deploy                                # Manufact Cloud
```

**Dashboard:**

```bash
cd web && npm install && npm run dev          # set VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY in web/.env
```

---

## 9. Repository map

**On `main`:**

```
manudesk/   server.py (MCP) · checker.py (gates) · eda.py (tool wrappers) · designs.py · toolchain.py
            agent.py (reference loop) · playbook.py (learned rules)
designs/    <name>/{spec.json, start.v, tb.v (hidden)}, lib/ecp5_dsp.v
playbooks/  fpga.md (learned rules)
scripts/    deploy · bootstrap_vm · connect · mcp_smoke · eval · measure_baselines · capture_demo
deploy/     systemd unit
docs/       CONNECT.md
web/        live dashboard on InsForge
tests/      checker and server tests
```

**Added on `insforge-port`:** `manufact/` · `insforge/functions/` · `migrations/` · `Dockerfile` ·
`manudesk/store.py` · `manudesk/pcb/` · `manudesk/toolstream*.py` · `docs/INSFORGE_PLAN.md`.
**Added on `demo/eda-essentials`:** `demo/eda-essentials/`.

---

## 10. For AI agents

1. Connect to the `manudesk` MCP server. If you're on the Manufact server, read `manudesk://playbook` first.
2. `list_designs()`, then `get_design(name)`. Keep the port list identical to the starting file.
3. Edit, then `check(name, verilog)`. Only a passing result (`pass: true` on the core server, `accepted:
   true` on Manufact) counts. Never claim a design works or is faster without a check that says so.
4. On failure, read `fix` / `reasons[].fix`. On success below target, fix the lines named in `path` /
   `critical_path` (usually: pipeline the long carry chain, register the multiplier), then `check` again.
5. Respect `LATENCY` and the resource budgets: the hidden testbench and the `LATENCY+1` check catch cheats.
6. `CHECKER_UNAVAILABLE` means the backend is waking up. Retry in about 30 s; it is not a verdict.

---

## 11. Honest status and limits

- **Designs:** `check` scores the 6 built-in designs, because each needs a hidden testbench. Arbitrary designs
  are next.
- **Not merged yet:** the Manufact server, InsForge functions and PCB tools are on `insforge-port`, not on
  `main` yet.
- **Cold starts:** InsForge Compute scales to zero; the first call after idle can take about 30 s.
- **DSP speed cap:** nextpnr can't time the multiplier inside an ECP5 DSP, so the leaderboard caps DSP designs
  at the 225 MHz datasheet limit.
- **Demo vs live:** the judge walkthrough replays real captures made locally. Its Results page is live.

Built at the YC hackathon, 2026-10-18.
