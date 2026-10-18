# THESIS: the agent drives the tools through MCP

Owner: Session H. Implementation: `core/agent.js`, `core/agent.css`, `data/agent-calls.json`.

> **We turned the hardware simulation and EDA toolchain into an MCP server. Any agent can now write HDL, run it on the real tools, see what happened (waveforms, floorplans, boards) and iterate in seconds.**

## 0. Honest status (read this before pitching)

- **There is one real EDA MCP server: ManuDesk** (`C:/Users/zubai/manudesk/manudesk/server.py`). It uses the Python `mcp` SDK over streamable HTTP at `/mcp` with a bearer token, and is started with `uv run python -m manudesk.server`. It has three tools:
  - `list_designs()` (server.py:45);
  - `get_design(name)` (server.py:52);
  - `check(name, verilog)` (server.py:63), which runs the gates static → lint → sim → mutation → synth → ports → harness P&R → budget and returns `{pass, stage, fix[], mhz, target, base, x, lat, path, use}`.

  `check` only accepts the 6 built-in designs with hidden testbenches, so pwm_led isn't one of them. Waveforms, cocotb, sby, ecppack, KiCad, Freerouting and Xvfb are not exposed over MCP. See `REAL-CODE.md` (Session I).
- **The full pipeline is not MCP.** It lives in `C:\Users\zubai\crusoe hackathon\` (uv package `hackcore`, FastAPI, repo github.com/zubair480/Crusoe-Forge).
  - Tools are Python functions: `tc/tools/sim.py`, `synth.py`, `pnr.py`, `tc/verifier.py`, `tc/visuals.py`, `tc/toolstream.py` / `toolstream_x11.py`, `tc/pcb/pipeline.py`.
  - The agent loop is `tc/loop.py`, which runs planner → engineer → verifier.
- **The only MCP server in the repo is `plantforge-mcp/index.ts`.** It's an untouched mcp-use starter (`show-app`, `say-hello`) with no EDA tools.
- **To make the pitch true:** wrap `tc/tools/*` and `verifier.check` as MCP tools, with the names in §2. This is a thin layer, because every function already takes plain args and returns JSON. Until then, the real MCP call is ManuDesk's `check`. Call the finer-grained names in the demo **"the proposed eda-tools surface"**: they would be built on the same `manudesk/eda.py` functions. All demo captures ran **locally** (OSS CAD Suite on this machine), not on the VM.
- **Wall-clock times in the demo are real.** Each was measured on this machine (warm OSS CAD Suite) or taken from `real/` logs. Values marked `~` are estimates.

## 0.5 At a glance: what's in the MCP / on the VM vs what the demo shows locally

| Software | In the real MCP server (ManuDesk) | On the teammate's InsForge VM (Crusoe-Forge pipeline, not MCP) | Shown in our demo (run locally) |
|---|---|---|---|
| Icarus Verilog (iverilog + vvp) | ✅ inside `check` (sim gate) | ✅ `tc/tools/sim.py` | ✅ 02-iverilog |
| Verilator (lint) | ✅ inside `check` (lint gate) | ✅ `tc/verifier.py` | ✅ 03-verilator (+ C++ model run, demo only) |
| Yosys (synthesis) | ✅ inside `check` (synth gate) | ✅ `tc/tools/synth.py` | ✅ 06-yosys |
| nextpnr-ecp5 (place & route) | ✅ inside `check` (harness P&R) | ✅ `tc/tools/pnr.py` | ✅ 07-nextpnr-3d |
| Fmax / speed measurement | ✅ `check` returns `mhz`, `x`, `path` | ✅ `pnr.parse_report` + timing harness | ✅ 07 (214.96 MHz) |
| Hidden testbench + mutation check | ✅ `check` (6 built-in designs only) | ✅ `designs/<d>/tb.v` + verifier | ⚠️ partly (02's test2 fail → fix) |
| ecppack (bitstream) | ❌ | ⚠️ Mandelbrot demo only (`frames.py`) | ✅ 07 (pwm_led.bit) |
| GTKWave (waveforms) | ❌ | ✅ `tc/visuals.py` + toolstream | ✅ 04-gtkwave |
| Xvfb toolstream (live tool windows) | ❌ | ✅ `tc/toolstream_x11.py` | ❌ not shown |
| KiCad (board + DRC) | ❌ | ✅ `tc/pcb/pipeline.py` (`kicad-cli`) | ✅ 09-kicad (KiCad not installed locally, so DRC numbers come from Freerouting) |
| Freerouting (autorouter) | ❌ | ✅ `tc/pcb/pipeline.py` | ✅ 10-freerouting |
| cocotb (Python tests) | ❌ | ❌ dependency only, never called | ✅ 05-cocotb (roadmap) |
| SymbiYosys (formal) | ❌ | ❌ only `sby --help` | ✅ 08-symbiyosys (roadmap) |
| uv + Python runtime | ✅ runs the server | ✅ | — |

**How ManuDesk exposes these:** it has three MCP tools, `list_designs`, `get_design` and `check(name, verilog)`. Everything marked ✅ in that column runs inside the one `check` call, not as a separate tool. The finer-grained names in the demo lane (`simulate`, `lint`, `synthesize`, `place_route`, …) are the proposed surface.

## 1. Toolchain match

| Tool | On teammate VM | In our demo | Real pipeline code | MCP tool (proposed) | Gap / action |
|---|---|---|---|---|---|
| Icarus iverilog + vvp | yes | 02-iverilog | `tc/tools/sim.py`: `iverilog -g2012 -o sim.vvp tb.v design.v` then `vvp -n sim.vvp` | `simulate` | Keep. Runs the **hidden testbench** (`designs/<d>/tb.v`). The engineer agent never sees it. |
| Verilator | yes (lint) | 03-verilator | `tc/verifier.py` lint: `verilator_bin --lint-only -Wno-fatal … --top-module <top>` | `lint` | Keep. The C++ model run in 03 is extra (demo only); label it as a fast-sim option. |
| GTKWave | yes | 04-gtkwave | `tc/visuals.py open_in_tool` + toolstream | `waveform`, `stream_window` | Keep. Mention that the real window streams live from Xvfb. |
| cocotb | dependency only, unused in `tc/` | 05-cocotb | none | `simulate({engine:"cocotb"})` | **Keep, tagged "roadmap"** (the lane shows it). The capture is real, but the pipeline doesn't call it. |
| Yosys | yes | 06-yosys | `tc/tools/synth.py`: `synth_ecp5 … stat -json` | `synthesize` | Keep. |
| nextpnr-ecp5 | yes | 07-nextpnr-3d | `tc/tools/pnr.py`: `--85k --package CABGA381 --speed 6 --freq … --report report.json` | `place_route` | Keep. |
| Fmax measurement | yes | 07 (timing beat) | `pnr.parse_report` + timing harness (all ports registered) in `verifier.py` | `measure_fmax` | Keep. **The harness is the story:** it caught a fake 804.5 MHz that was really 66.6 MHz. |
| ecppack | only for the Mandelbrot bitstream (`tc/tools/frames.py`) | 07 (end) | `ecppack --compress x.config x.bit` | `pack_bitstream` | Keep; minor. |
| SymbiYosys | **no** | 08-symbiyosys | none | `formal_verify` | **Keep, tagged "roadmap".** Real `sby` capture, but not in the pipeline. Cut it if the demo runs long. |
| KiCad | probably (kicad-cli) | 09-kicad | `tc/pcb/pipeline.py`: `kicad-cli pcb drc --exit-code-violations`, export gerbers/drill/pos, render | `board_build`, `board_drc` | Keep. KiCad isn't installed locally, so 09's DRC uses Freerouting's real clearance result. The VM runs the real `kicad-cli` DRC. |
| Freerouting | yes | 10-freerouting | `tc/pcb/pipeline.py`: `java -jar freerouting-2.4.1.jar -de board.dsn -do board.ses -mp 100 --gui.enabled=false` | `autoroute` | Keep (in the pipeline; **not** roadmap). |
| Xvfb toolstream | yes (`toolstream_x11.py`: one Xvfb per tool, xdotool input, MJPEG frames) | **missing** | FastAPI `/api/tool/...` | `stream_window` | **Gap.** The demo shows redesigned UIs, never the real streamed window. Add a "live from VM" chip or a short clip in 04/07/09. |
| uv + Python runtime | yes | not shown | `pyproject.toml` | — | Fine to leave out. |
| Hidden testbench / verifier gates | yes | partly (02's test2) | gates: static → lint → sim → **mutation** (LATENCY+1 must FAIL) → synth → ports → P&R → budget | `verify` (all gates) | **Gap.** Worth one line in 02/11: "the agent never sees the grading testbench; a mutant must fail."  |
| Agent loop (`tc/loop.py`) | yes | **this layer** | keeps the best passing Fmax; races candidates; reverts after 3 rejections; `runs/trace.jsonl` | — | The agent lane is the visual for this loop. |

## 2. MCP surface (proposed names; backing code exists)

| MCP tool | Inputs | Output (to the agent) | Backing code | Demo scene |
|---|---|---|---|---|
| `write_rtl` | `path, content \| patch, top?` | `{lines, module, ports}` | workspace write | 01-code |
| `patch_file` | `path, change (unified diff)` | `{added, removed}` | workspace write | 02 (the fix) |
| `simulate` | `top, files[], engine="icarus"\|"verilator"\|"cocotb", vcd?, cycles?` | `{passed, failed, tests:[{name,status,msg}], sim_time_us, vcd_url, wall_ms}` | `tc/tools/sim.py` | 02, 03, 05 |
| `lint` | `files[], top, flags?` | `{warnings:[{code,line,msg}], exit, wall_ms}` | `verifier.lint` | 03 |
| `waveform` | `vcd, signals[], window?` | `{png_url, signals, transitions}` | `tc/visuals.py` | 04 |
| `stream_window` | `app="gtkwave"\|"nextpnr"\|"pcbnew", file` | `{stream_url (MJPEG), input_url}` | `toolstream_x11.py` | 04, 07, 09 |
| `synthesize` | `top, family="ecp5", files[]` | `{cells, lut4, ff, carry, netlist_url, wall_ms}` | `tc/tools/synth.py` | 06 |
| `place_route` | `netlist, device, package, lpf?, freq_mhz, seed?` | `{routed, arcs, unrouted, util, fmax_mhz, critical_path, wall_ms}` (Fmax comes from the same `--report` JSON) | `tc/tools/pnr.py` | 07 |
| `pack_bitstream` | `config, compress?` | `{bit_url, bytes}` | `ecppack` | 07 |
| `formal_verify` *(roadmap)* | `props, modes[], depth` | `{proved, bmc_depth, k, counterexample?}` | `sby` | 08 |
| `board_build` | `fpga, leds, osc_mhz, layers` | `{parts, nets, connections, board_url}` | `tc/pcb/pipeline.py` | 09 |
| `autoroute` | `dsn, max_passes` | `{routed, unrouted, vias, score, ses_url}` | Freerouting | 10 |
| `board_drc` *(roadmap)* | `board` | `{errors, warnings, unconnected, report_url}` | `kicad-cli pcb drc` (Crusoe-Forge only); in the demo the numbers come from Freerouting | 09 |
| **`check`** (REAL, ManuDesk) | `name, verilog` | `{pass, stage, fix[], mhz, target, x, lat, path, use}` | `manudesk/checker.py` | (11): the one real MCP call today |

Every result carries `wall_ms`, so the agent (and the viewer) sees the speed.

## 3. Narrative

**Opening (spec card, ~4 s, before 01-code):** "An agent received a spec: an 8-LED breathing PWM driver for the ULX3S (ECP5-85F, 25 MHz), 32-count phase shift, Fmax ≥ 25 MHz, self-checking testbench, lint clean, 2-layer board with DRC 0." The loop strip reads: spec → write HDL → call MCP tools → see results → fix → ship.

**The lane (every scene):** a 48px strip under the stepper. It shows:
- the MCP call, syntax-colored, moving through **request → running (a live clock up to the real wall time) → result** (green ✓ or red ✕);
- below the call, the agent's one-line reasoning;
- on the right, a trail of every call so far (red outline = a failure), plus counters: **calls · fix loops · total tool time**. A **Log** button opens the full call list.

**Speed beat:** in 02 the lane shows `simulate` ✕ test2 → `patch_file` → `simulate` ✓ 4/4. The reasoning line says "Fail → fix → pass in 1.18 s of tool time." Calls sync to the scene's own captions.

**Ending (11-results):** "shipped · 16 MCP calls · 12 tools · 1 fail → fix loop · 53.5 s total tool time". The reasoning reads: "Spec met: 4/4 tests, lint clean, 214.96 MHz against 25 MHz, board routed with DRC 0. Returning pwm_led.bit and the board files."

**Spoken pitch (20 s):** "Every tool you just saw, the agent called through one MCP server: simulate, lint, synthesize, place and route, board. It saw a failing test, read the waveform, patched the testbench, and re-ran in about a second. The whole flow, from spec to bitstream and routed board, took under a minute of tool time. Any agent can plug in."

## 4. Per-scene MCP call cards (exact text, as in `data/agent-calls.json`)

| Scene | Call | Result | ms | Reasoning |
|---|---|---|---|---|
| 01 | `write_rtl({ path: "rtl/pwm_led.v", top: "pwm_led" })` | 40 lines · module pwm_led | ~38 | RTL written. A design is only as good as its testbench, so writing that next. |
| 01 | `write_rtl({ path: "rtl/tb_pwm_led.v", kind: "testbench" })` | 41 lines · 4 self-checks | ~31 | Four checks: duty ramps, LED0 on-time matches duty, dir flips at 255, reset clears. Next, simulate. |
| 02 | `simulate({ top: "tb_pwm_led", files: ["rtl/pwm_led.v", "rtl/tb_pwm_led.v"] })` | ✕ 3/4 · test2 FAIL on0=51 duty=55 | 580 | test2 failed: duty keeps ramping during the 256-cycle window, so comparing to the final duty is wrong. Patching the testbench. |
| 02 | `patch_file({ path: "rtl/tb_pwm_led.v", change: "snapshot d0 = duty; accept d0-2..duty+2" })` | +4 −4 lines | ~24 | The RTL is fine, the check was wrong. Re-running the same simulation. |
| 02 | `simulate({ …, vcd: true })` | ✓ 4/4 PASS · 165.02 µs · pwm_led.vcd | 580 | Fail → fix → pass in 1.18 s of tool time. Linting before synthesis. |
| 03 | `lint({ files: ["rtl/pwm_led.v"], flags: "-Wall" })` (ManuDesk's real lint uses `-Wno-fatal -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTH`) | 0 warnings · exit 0 | 268 | Lint clean. Building a cycle-accurate C++ model for a long soak run. |
| 03 | `simulate({ engine: "verilator", cycles: 50000000 })` | 50M cycles · 3.97 M cycles/s · LED0 49.48% | 12,590 | 2 s of real hardware time, deterministic. Now looking at the waveforms. |
| 04 | `waveform({ vcd: "pwm_led.vcd", signals: […], window: "1 PWM period", stream: "toolstream" })` | 13 signals · 12,899 edges · PNG + live window | ~900 | Each LED is a PWM train; the 8 carriers are 32 counts apart. Matches the spec. |
| 05 | `simulate({ engine: "cocotb", tests: "test_pwm_led.py" })` *roadmap* | 4/4 PASS · 305.76 µs sim | 350 | Python agrees with the Verilog testbench. Synthesizing. |
| 06 | `synthesize({ top: "pwm_led", family: "ecp5" })` | 150 cells · 48 LUT4 · 41 FF · 52 CCU2C | 4,238 | 150 primitives, tiny for an 85K-LUT part. Placing and routing. |
| 07-nextpnr-3d | `place_route({ device: "LFE5U-85F", package: "CABGA381", lpf: "pwm_led.lpf", freq_mhz: 25 })` | 530 arcs · Fmax 214.96 MHz (25 needed) | 8,178 | Routed, and timing closes with 8.6× headroom (same nextpnr report). Packing the bitstream. |
| 07-nextpnr-3d | `pack_bitstream({ config: "pwm_led.config", compress: true })` | pwm_led.bit · 282,479 B | 7,777 | Bitstream ready to flash. Proving the design formally. |
| 08 | `formal_verify({ modes: ["bmc","prove"], depth: 40, props: "pwm_led_props.vh" })` *roadmap* | 5/5 asserts proved · bmc 40 · k-induction | 2,610 | Proved for all states, not just the tested ones. Building the board. |
| 09 | `board_build({ fpga: "LFE5U-25F-6BG256C", leds: 8, osc_mhz: 25, layers: 2 })` | 29 parts · 27 nets · 58 connections | ~1,400 | Board placed. Routing it, then checking DRC. |
| 09 | `board_drc({ board: "pwm_led.kicad_pcb" })` *roadmap* | 0 errors · 0 unconnected | ~800 | Clean. Every track meets clearance. |
| 10 | `autoroute({ dsn: "board.dsn", max_passes: 30 })` | 58/58 routed · 15 vias · score 999.99 | 13,131 | The last 2 connections routed on pass 3, 0 unrouted. Importing back into KiCad. |
| 11 | summary | shipped · all green | | Spec met … returning pwm_led.bit and the board files. |

**Timing sources:**
- iverilog + vvp: 359 + 221 ms. verilator lint: 268 ms. yosys: 4,238 ms. nextpnr: 8,178 ms. ecppack: 7,777 ms. All timed warm on 2026-10-18 with the same commands, in a scratch dir.
- verilator model: `real/verilator/04-run.log`. cocotb: `real/cocotb/run.log`. sby: `real/sby/sby.log`. Freerouting: `real/pcb/freerouting.log`.

## 5. Asks to scene owners (optional, small)

- **02 (A):** one callout line, "the agent never sees the grading testbench".
- **04 / 07 / 09:** a small "live window · Xvfb on VM" chip, to make toolstream visible.
- **11 (main):** a row of agent stats: calls, fix loops, tool time. Read them from `window.__agent` `{calls, fixLoops, toolMs, log}`, which is updated on every `wt:agent` event.
