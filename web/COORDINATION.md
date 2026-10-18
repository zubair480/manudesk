# Menu Desk web: coordination board

Every session and every subagent working on `web/` reads this first and updates it. **Claim before you
build**: add a line under "Claims" before touching a file, and check nobody else claimed it. Log what you
finished under "Log". Never edit a file another session owns; ask in "Questions" instead.

## Goal
`web/` is the Menu Desk frontend: a live view of a coding agent using the Menu Desk MCP. It must look exactly
like the reference `/guide` page (glass panels on a sky gradient, step rail that fills like a progress bar,
live NOW strip, feed, per-step detail cards, aurora/scan/sheen motion). Reference files, read-only:
`C:\Users\zubai\crusoe hackathon\tc\app_static\guide\{index.html,guide.js,theme.js}`, `tc\app_static\app.css`,
`tc\app_static\viewers\{floorplan.html,floorplan.js,loops.html,loops.js,viewer.css}`. Never name the
reference project, Crusoe, Nemotron, You.com or "Local" anywhere in `web/`.

Steps: **Connect** -> **Get design** -> **Check #1 (baseline)** -> **Check #2..n** -> **Best result**.
Sources (`src` tags): `agent` = "Coding agent", `menudesk` = "Menu Desk MCP", `insforge` = "InsForge",
`eda` = "Yosys + nextpnr".

## Stack
Vite 5 + `@insforge/sdk` (installed), plain JS modules, no framework. `npm run dev` (port 5175),
`npm run build` -> `web/dist`. Env in `web/.env` (gitignored): `VITE_INSFORGE_URL`, `VITE_INSFORGE_ANON_KEY`
(anon only, never the admin key). Routes: `/` = runs list, `/runs/<run_id>` = guide view (SPA; also accept
`?run=<id>` as a fallback in case the host has no SPA rewrite).

## Data contract (what the UI consumes)
`src/data.js` (owner: web-data) exports, all returning contract-shaped objects:
```
listRuns() -> [{run_id, design, n_checks, best_mhz, baseline_mhz, created_at, sample}]
loadRun(run_id) -> {run_id, design, sample: bool, design_info: {name, summary, target_mhz, baseline_mhz,
                    latency_budget, resource_budget}, checks: [Check]}
subscribeRun(run_id, onCheck) -> unsubscribe()      // realtime: onCheck(Check) per new row
loadReport(report_key) -> report.json object | null // nextpnr report for the floorplan
AB_TABLE -> rows for the Best result card
```
`Check` = `{id, run_id, design, n, accepted, stage, reasons: string[], fmax_mhz, baseline_mhz,
vs_baseline: "3.26x"|null, latency, critical_path, resources: {LUT,FF,DSP}, budgets: {LUT,FF,DSP},
seconds, verilog, report_key, created_at}`.

### What is actually in InsForge (project yc-hackathon, built by the backend agent; do NOT alter schema)
- `md_checks(id, design, source, run_id uuid, verilog_sha256, pass, stage, mhz, x, lat, path, use jsonb,
  fix jsonb, duration_ms, artifact_key, created_at)`: anon SELECT. 0 rows right now.
- `md_runs(id, design, goal, target_mhz, max_iterations, status, step, iteration, best_mhz, best_check_id, ...)`
- `md_iterations(id, run_id, n, role, model, ..., verilog, check_id, accepted, created_at)`: NO anon policy.
- `md_designs(name, top, summary, baseline_mhz, target_mhz, latency_budget, resource_budget, start_verilog)`
- Bucket `md-artifacts` (private). No `checks` table, no `reports` bucket.
web-data maps md_* onto the contract (pass->accepted, fix->reasons, mhz->fmax_mhz, x->vs_baseline,
lat->latency, path->critical_path, use->resources, duration_ms/1000->seconds, artifact_key->report_key,
budgets/baseline from md_designs). It also reads a contract `checks` table if one ever appears.
Empty or missing data -> fixture `fixtures/popcount.json` with `sample: true` (UI shows a "sample data" badge).

## Fixture numbers (from the brief, use as given)
popcount 70.0 -> 228.2 MHz (3.26x) in 4 checks, all accepted, fresh Claude Code session using only the MCP.
A/B (MHz): mac 74.4 / 135.1 / 228.4; fir8 66.4 / 142.6 / 197.5; popcount 70.0 / 183.2 / 244.0;
crc32 61.1 / FAIL / 191.1; Correct 3/4 vs 4/4; Mean speedup 2.2x vs 3.0x (start / agent alone / agent + Menu Desk).

## Ownership
| Session | Owns |
|---|---|
| main (integrator) | `package.json`, `vite.config.js`, `.env`, `COORDINATION.md` structure, final integration + deploy |
| web-guide | `index.html`, `src/main.js`, `src/guide.js`, `src/theme.js`, `src/styles.css`, `src/runs.js` (runs list) |
| web-data | `src/data.js`, `fixtures/*.json` (except report.json), realtime + test-row verification |
| web-viewers | `src/floorplan.js`, `src/fmaxchart.js`, `src/viewers.css`, `fixtures/report.json` |

Viewer API (web-viewers provides, web-guide calls):
`mountFloorplan(el, report)` -> `{update(report), destroy()}`; `mountFmaxChart(el, checks, {baseline, target})`
-> `{push(check), destroy()}`.

## Claims
- main: scaffold (done), this doc
- web-guide: index.html, src/main.js, src/guide.js, src/theme.js, src/styles.css, src/runs.js (done)
- web-data: `src/data.js`, `fixtures/popcount.json` (done)
- web-viewers: src/floorplan.js, src/fmaxchart.js, src/viewers.css, fixtures/report.json (done)

## Log
- main: Vite + @insforge/sdk installed in web/; .env written; InsForge schema surveyed (above).
- web-viewers: DONE. `src/floorplan.js` + `src/fmaxchart.js` (each imports `./viewers.css` itself, so callers
  only import the JS). API as above: `mountFloorplan(el, report)` -> `{update(report), destroy()}`,
  `mountFmaxChart(el, checks, {baseline, target})` -> `{push(check), destroy()}`. Both append into `el` and size to
  its width (put them inside a `.blk`; no own panel chrome). Floorplan: real nextpnr report.json, picks the
  reg-to-reg path on the main clock, cells per tile slot, red pulse at signal time, minimap, "full die"/"pause",
  hover/tap tooltips, collapsible segment list; `update(null)` shows "no place-and-route report" (use for checks
  rejected before routing). Chart: x = check `n`, y = `fmax_mhz`, accepted = blue dot (best = green), rejected =
  red cross at its Fmax or on the floor with its `stage`, best-so-far step line, dashed baseline/target, tooltip
  shows reasons; `push()` replaces by `id`/`n` or appends. Theme: scoped `.mdv` tokens read your `--ink/--accent/
  --ok/--bad...` with fallbacks; dark when `html[data-theme="dark"]` (or system dark without data-theme). Respects
  prefers-reduced-motion. Tested desktop + 375px, light + dark, no console errors, no horizontal scroll.
- web-viewers: `fixtures/report.json` = REAL report from `run_check('popcount', demo/popcount_fast.v, keep=True)`
  (154.2 MHz, target 105, path 6.49 ns, 23 segs). It is NOT in public/; serve it by bundling:
  `import report from '../fixtures/report.json'` in data.js (`loadReport` fallback), which Vite inlines. If you'd
  rather fetch it at runtime, ask me/main to move it to `public/fixtures/report.json`.

- web-guide: guide + runs list done. `/` runs list (newest first), `/runs/<id>` and `?run=<id>` guide; rail Connect -> Get design -> Check #1 baseline -> Check #2..n -> (live: pending Check #n+1) -> Best result. Check cards: verdict, Fmax, vs baseline, latency, reasons, critical path, resource bars vs budgets, collapsible Verilog, floorplan (when report_key) + Fmax chart; Best: summary, all-checks table, A/B from AB_TABLE. Live: existing checks render, then subscribeRun() pushes each new check into rail/NOW/feed/chart (Follow live jumps to it). Live = run.status not done/failed (else last check < 20 min); sample runs never live; "sample data" badge from data.sample. data.js + viewers loaded via import.meta.glob (missing module = message, not a blank page). Light/dark via theme.js (system default, bottom-right toggle, stored). Verified in the browser: popcount fixture end to end, injected live checks (accepted + rejected), real 0-check mac run, 375px light + desktop dark, no horizontal scroll; `npm run build` OK. Dev-only hook `window.__mdGuide.onCheck(check)` for live testing.

- web-data: DONE. `src/data.js` implements the contract against live InsForge (anon key) and was tested in node
  and in the browser on :5175. Notes for callers:
  - Reads a contract `checks` table first if it ever exists; else maps md_checks + md_designs + md_runs as above.
    Extra fields: Check has `source` (mcp/agent/baseline); loadRun returns `run: {goal, status, step, iteration}`.
    `n` = position by created_at within the run. `seconds` = duration_ms/1000 (backend currently writes 0 for some).
  - Fallback: run id `sample-popcount`, an unknown/invalid run id, no runs, or any error -> fixtures/popcount.json
    with `sample: true` (listRuns returns the sample summary only when md_runs is empty or unreachable).
  - `verilog`: tries `md-artifacts/<artifact_key>/design.v`; the bucket is private so anon gets null today.
  - `loadReport(key)`: `fixtures/...` -> bundled fixture (via `new URL('../fixtures/x', import.meta.url)`, Vite
    bundles it, verified with `vite build`); else md-artifacts `<key>/report.json` (null for anon today).
    Fixture check 4 points at `fixtures/report.json` (that report is the 154.2 MHz design; fine for a sample).
  - `AB_TABLE` = array of arrays, header row first, incl. "Correct" and "Mean speedup" rows (guide.js renders it).
  - `subscribeRun(run_id, onCheck)`: realtime on channel `md_run:<run_id>` (or `md_checks` for all when run_id is
    null/"*"), event `check_inserted`, payload = the raw md_checks row (+ `meta`, whose `channel` arrives as
    `realtime:<channel>`). Dedupes by id. Falls back to polling md_checks every 3 s if subscribe fails or the
    socket drops; one catch-up read on reconnect. No-op for `sample-popcount`.
  - Realtime SQL, applied as migration `20261018142749_md-checks-realtime.sql` (additive; no md_* schema change):
    ```sql
    INSERT INTO realtime.channels (pattern, description, enabled) VALUES
      ('md_checks', 'Menu Desk: every new md_checks row', true),
      ('md_run:%', 'Menu Desk: new md_checks rows for one run', true)
    ON CONFLICT (pattern) DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled;
    CREATE OR REPLACE FUNCTION public.md_checks_notify_insert() RETURNS TRIGGER AS $$
    DECLARE v_row jsonb := to_jsonb(NEW);
    BEGIN
      PERFORM realtime.publish('md_checks', 'check_inserted', v_row);
      IF NEW.run_id IS NOT NULL THEN
        PERFORM realtime.publish('md_run:' || NEW.run_id::text, 'check_inserted', v_row);
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, realtime;
    DROP TRIGGER IF EXISTS md_checks_notify_insert ON public.md_checks;
    CREATE TRIGGER md_checks_notify_insert AFTER INSERT ON public.md_checks
    FOR EACH ROW EXECUTE FUNCTION public.md_checks_notify_insert();
    ```
  - Verified: inserted test md_runs row 00000000-0000-4000-8000-00000000da7a (status failed) + md_checks rows on
    it via admin SQL; subscribeRun(run) and subscribeRun(null) both received the check over the websocket
    (~insert latency, ws_audience_count 1, no polling). Test md_checks/md_runs rows deleted (realtime.messages
    log rows can't be deleted by the CLI; harmless). Real backend checks are already publishing on these channels.

## Questions

- main: a shared dev server is ALREADY running on http://localhost:5175 (open in the user's Chrome for live viewing; Vite hot-reloads your edits). Do not start another on 5175; use it, or --port 5176+ for isolated tests.
- web-data: md_checks rows from the backend often have `run_id` NULL (all `source: baseline` rows, and an
  `agent` row), so a run's own baseline check isn't in loadRun(run).checks; check #1 of run b0369ab8 is already
  219.9 MHz. If the backend set run_id on the baseline check, the Check #1 (baseline) step would be real.
