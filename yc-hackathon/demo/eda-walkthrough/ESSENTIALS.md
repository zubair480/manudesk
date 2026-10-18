# ESSENTIALS: which tools matter for the student MCP pitch (Session I)

Pitch: *we turned the real EDA toolchain into an MCP server so students' AI agents can write HDL, run real tools, see results and iterate fast.*
Judged for the **student digital-design loop**: simulate → see waves → lint → synthesize → fit on an FPGA → timing.

> **Reality check (important for the pitch):** the only real EDA MCP server on this machine is **ManuDesk** (`C:\Users\zubai\manudesk\manudesk\server.py`, Python `mcp` SDK, streamable HTTP `/mcp`). It has three tools:
> - `list_designs()` lists the designs;
> - `get_design(name)` returns one design;
> - `check(name, verilog)` runs one gated call: static → Verilator lint → iverilog/vvp sim → mutation → Yosys `synth_ecp5` → nextpnr-ecp5 → budget. It returns `{pass, stage, fix[], mhz, target, base, x, lat, path, use:{LUT,FF,DSP}}`.
>
> What it does **not** cover:
> - no waves/VCD, cocotb, sby, ecppack, KiCad or Freerouting;
> - only the 6 built-in designs with hidden testbenches, so a student can't submit `pwm_led` today.
>
> The broader pipeline (VCD, ecppack, Freerouting, KiCad DRC, Xvfb toolstream) lives in `C:\Users\zubai\crusoe hackathon\tc\`, a FastAPI app rather than an MCP server. `plantforge-mcp/index.ts` is still the template (`show-app`, `say-hello`). The `real/` logs are one-off local captures.
>
> **For the pitch:** show `check` as the real call. The finer-grained names below (`lint`, `simulate`, `waves`, `synth`, `pnr`) are the proposed student surface, built from the same `eda.py` functions. Details are in REAL-CODE.md.

## Tier table

| Tool | Tier | Why (student MCP use case) | Real run on this machine? |
|---|---|---|---|
| Icarus `iverilog` + `vvp` | **ESSENTIAL** | The student's first step. The FAIL→fix→PASS loop (test2) is the moment they learn | Yes: `real/iverilog.log`, `vvp-run1-FAIL.log`, `vvp.log` |
| Waveforms (VCD→JSON; GTKWave UI) | **ESSENTIAL** | Students understand timing by looking at it. The MCP returns VCD/JSON; GTKWave is the familiar view | Partly: `real/gtkwave/load.log`; the scene uses `vcd2json.mjs` |
| Verilator `--lint-only -Wall` | **ESSENTIAL** | Instant feedback on width, latch and blocking mistakes; the cheapest teacher there is | Yes: `real/verilator.log` |
| Yosys `synth_ecp5` | **ESSENTIAL** | Shows that HDL becomes hardware (LUT and FF counts) | Yes: `real/yosys/` |
| nextpnr-ecp5 + ecppack | **ESSENTIAL** | Fits on a real FPGA, reports timing (Fmax ≈215 MHz vs the 25 MHz target) and produces a real `.bit` | Yes: `real/nextpnr/` (`--85k CABGA381 --freq 25`, `ecppack --compress`) |
| uv / Python | **ESSENTIAL (plumbing, no scene)** | Runtime for cocotb and the helper scripts on the VM; mention once in narration | Indirectly (a venv; no uv calls found) |
| cocotb | NICE-TO-HAVE | Python tests suit AI agents, but they repeat the Icarus beat. Use a 6 s montage | Yes: `real/cocotb/` 4/4 PASS |
| SymbiYosys `sby` | NICE-TO-HAVE | "Prove it, don't just test it" is a strong line but advanced for students. One short beat, first to cut | Yes: `real/sby/` |
| Xvfb / toolstream | NICE-TO-HAVE (infra, offscreen) | Only needed to stream GUI tools (GTKWave/KiCad) from the VM. Narration only | No code here uses it |
| KiCad | **CUT** | Board design is a different course and off the HDL loop; nothing here runs KiCad | No: `real/pcb/gen_board.py` writes the DSN by hand |
| Freerouting | **CUT** | PCB autorouting, off the digital-design path; the longest scene (~25 s) | Yes (headless java), but off-story |

## Recommended scene order (~100 s)

| # | Scene | Target s | Beat / MCP tool |
|---|---|---|---|
| 1 | 01-code | 8 | Student prompt → agent writes `pwm_led.v` + tb |
| 2 | 03-verilator | 8 | `lint`: clean, 0 warnings ("but is it correct?"). Move it before simulation; trim from ~13 s |
| 3 | 02-iverilog | 14 | `simulate`: run 1 test2 FAIL → agent fixes tb → 4/4 PASS |
| 4 | 04-gtkwave | 12 | `waves`: duty ramp + 8-LED phase staircase (now ~6 s, can grow) |
| 5 | 05-cocotb | 6 | Optional montage: "same checks in Python" |
| 6 | 06-yosys | 12 | `synth`: cell/LUT/FF stats + schematic |
| 7 | 07-nextpnr-3d **or** 07-nextpnr (keep ONE) | 14 | `pnr`: placement, Fmax 215 MHz ≥ 25 MHz PASS, `pwm_led.bit` |
| 8 | 08-symbiyosys | 8 | Optional `prove` stamp; first to cut if over time |
| 9 | 11-results | 12 | Tests, lint, LUTs, Fmax, bitstream. Use an FPGA/LED hero, not the 3D PCB |
| — | 09-kicad, 10-freerouting | 0 | **DROP** (saves ~44 s). Keep them as a post-demo "and it extends to boards" extra if wanted |

Rough current runtimes from summing `scene.js` sleeps at 1x: 02 ~10 s, 03 ~13, 04 ~6, 05 ~3, 06 ~10, 07 ~6, 07-3d ~11, 08 ~10, 09 ~19, 10 ~25, 11 ~8. Order changes go to `scenes.json`, which the main session owns.

## Student story (5 lines)
1. Student → agent: "Make 8 LEDs breathe out of phase on my ULX3S (25 MHz), and test it."
2. The agent writes `pwm_led.v` + a testbench and calls **`lint`** (Verilator `-Wall`): clean.
3. It calls **`simulate`** (iverilog/vvp). test2 FAILs; the agent reads the log, fixes the testbench timing, and the rerun passes 4/4.
4. It calls **`waves`** (VCD→JSON). The student sees the duty ramp and phase offsets, asks "why is LED3 late?", and the agent answers from the waveform.
5. It calls **`synth`** (Yosys) and **`pnr`** (nextpnr-ecp5 + ecppack): LUT counts, "215 MHz, PASS @ 25 MHz" and a `.bit` to flash. The student tweaks the period and the loop reruns in seconds.
