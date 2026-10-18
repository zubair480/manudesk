# ManuDesk on InsForge: shared contract

Every parallel session builds against this file. If you need to change a name here, say so in your report
instead of silently diverging.

InsForge project: **yc-hackathon** (`d7b0a23f-d743-43f7-a33d-c4fc0d308169`, host
`https://nden3esm.us-west.insforge.app`). ManuDesk is already linked (`.insforge/project.json`).

## Ground rules

- **Nothing runs locally.** No local Docker, no `uv run`, no `pytest`, no local servers. The only local
  actions are editing files in this repo and `npx @insforge/cli ...` commands that act on InsForge.
  Verify by invoking deployed functions, querying the InsForge DB, or calling the compute URL.
- **This project also hosts another app** (plant maintenance: tables `incidents`, `quotes`, `assets`, ...,
  14 edge functions like `escalate-safety`, secrets like `AGENT_API_TOKEN`). Never modify, drop or
  redeploy any of those. Every ManuDesk object is prefixed: tables `md_*`, functions `md-*`, bucket
  `md-artifacts`, secrets `MANUDESK_*`.
- Don't commit or push; leave changes in the working tree. Touch only the files your session owns.
- Inspiration: `C:\AI\Projects\Crusoe-Forge` (read-only). The agent loop there is `tc/loop.py`
  (planner -> analyst -> engineer -> verifier, keep best passing version), `tc/planner.py`,
  `tc/analyst.py`, `tc/engineer.py`, `tc/reflector.py` (rewrites playbooks/fpga.md from evidence; code
  gate drops rules with no measured numbers), `tc/meta.py` (per-rule effect stats), `playbooks/`.

## Architecture

```
Agent (Claude Code, Cursor) --MCP--> compute: manudesk server (EDA tools)  --logs--> md_checks, md-artifacts
User / UI --> md-run-start (edge fn) --> md_runs (queued)
schedule md-tick (every minute) --> md-run-step: one agent step per call, state in DB
      planner -> analyst -> engineer (AI gateway) -> POST compute /api/check -> md_iterations
schedule nightly --> md-reflect (playbook from evidence) / md-meta (rule stats) / md-baselines
```

The compute machine is the only place with yosys/nextpnr. Everything else is edge functions + DB.
Compute endpoint: `https://manudesk-d7b0a23f-d743-43f7-a33d-c4fc0d308169.fly.dev` (scales to zero; first
call after idle is slow). Until compute is running, a check call fails: record that as
`status = 'check_unavailable'`, never as a design failure.

## Database (owner: schema session)

| Table | Key columns |
|---|---|
| `md_designs` | `name` text PK, `top`, `summary`, `baseline_mhz`, `target_mhz`, `latency_budget` int, `resource_budget` jsonb, `start_verilog` text, `updated_at` |
| `md_checks` | `id` uuid PK, `design` text FK, `source` text (`mcp`, `agent`, `baseline`), `run_id` uuid null, `verilog_sha256` text, `pass` bool, `stage` text, `mhz` numeric null, `x` numeric null, `lat` int null, `path` text null, `use` jsonb null, `fix` jsonb, `duration_ms` int, `artifact_key` text null, `created_at` |
| `md_runs` | `id` uuid PK, `design` text FK, `goal` text, `target_mhz` numeric, `max_iterations` int default 6, `status` text (`queued`, `running`, `reached`, `exhausted`, `failed`), `step` text (`plan`, `analyze`, `engineer`, `check`, `done`), `iteration` int, `best_mhz` numeric null, `best_check_id` uuid null, `playbook_version` int null, `done_contract` jsonb null, `error` text null, `created_at`, `updated_at` |
| `md_iterations` | `id` uuid PK, `run_id` uuid FK, `n` int, `role` text (`planner`, `analyst`, `engineer`), `model` text, `prompt_tokens` int, `completion_tokens` int, `input` jsonb, `output` jsonb, `verilog` text null, `check_id` uuid null, `accepted` bool null, `created_at` |
| `md_playbooks` | `version` int PK, `body` text (markdown rules), `evidence` jsonb, `dropped` jsonb (rules the code gate removed), `created_at` |
| `md_rule_stats` | `rule_id` text, `playbook_version` int, `design` text, `gain_pct` numeric, `rej_rate` numeric, `reached` numeric, `iters` numeric, `n_runs` int, `computed_at`; PK (`rule_id`, `playbook_version`, `design`) |

RLS on: anon can read `md_designs`, `md_checks` (no `verilog`), `md_runs`, `md_playbooks`,
`md_rule_stats` for a public leaderboard; all writes go through the API key / functions only.
Seed `md_designs` from `designs/*/spec.json` + `start.v` (never `tb.v`: the testbench stays hidden).

## Storage (owner: schema session)

Private bucket `md-artifacts`. Keys: `checks/<check_id>/design.v`, `checks/<check_id>/result.json`,
`runs/<run_id>/best.v`, `playbooks/v<version>.md`.

## Compute server additions (owner: server session; files `manudesk/server.py`, new `manudesk/store.py`)

- `POST /api/check` JSON `{"name","verilog","run_id"?}` behind the same bearer token, returns the same
  dict as the MCP `check` tool. This is what edge functions call.
- After every check (MCP or `/api/check`), write an `md_checks` row and, for `pass: true`, upload the
  Verilog and result to `md-artifacts`. Use the InsForge REST API with `INSFORGE_BASE_URL` and
  `INSFORGE_API_KEY` from env. Logging failures must never fail or slow the check (fire and forget).
- Env on compute: `MANUDESK_TOKEN`, `INSFORGE_BASE_URL`, `INSFORGE_API_KEY`.

## Edge functions

| Slug | Owner | Does |
|---|---|---|
| `md-run-start` | agents session | Validate design, insert `md_runs` (queued), return run id |
| `md-run-step` | agents session | Advance one queued/running run by one step; planner/analyst/engineer via the InsForge AI gateway; check via compute `/api/check` |
| `md-run-status` | agents session | Run + iterations + best check, for a UI/agent |
| `md-leaderboard` | agents session | Best passing check per design (mhz, x, who) |
| `md-tick` | schedules session | Called by the minute schedule; picks runs and calls `md-run-step` (bounded per tick) |
| `md-reflect` | schedules session | Reflector: new `md_playbooks` version from finished runs; drop rules with no measured numbers |
| `md-meta` | schedules session | Fill `md_rule_stats` (gain, rej_rate, reached, iters) per rule |
| `md-baselines` | schedules session | Re-check every design's start Verilog via compute, store as `source = 'baseline'` |

Function auth: callers send header `x-manudesk-token: <MANUDESK_TOKEN>` (constant-time compare), except
`md-leaderboard` and `md-run-status`, which are public reads. Secrets for functions: `MANUDESK_TOKEN`,
`MANUDESK_COMPUTE_URL`. Function source lives in `insforge/functions/<slug>.ts`, one self-contained file
per function.

## Schedules (owner: schedules session)

| Name | Cron | Calls |
|---|---|---|
| `md-tick` | `1 minute` (pg_cron interval) | `md-tick` |
| `md-reflect` | `0 3 * * *` | `md-reflect` |
| `md-meta` | `30 3 * * *` | `md-meta` |
| `md-baselines` | `0 4 * * *` | `md-baselines` |

Headers reference secrets with `${{secrets.MANUDESK_TOKEN}}`.
