# ManuDesk

**A hardware feedback loop for coding agents.**

Coding agents can write Verilog, but they can't tell whether it works or how fast it runs, so they guess.
ManuDesk gives them the answer: an MCP server that runs a hidden testbench and real synthesis, place and
route on a Lattice ECP5 FPGA, and returns a short JSON verdict an agent can act on.

AI agents are the customer, not humans. Every tool output is compact and cheap in tokens.

## Tools

| Tool | Returns |
|---|---|
| `list_designs()` | Each design with its target and baseline MHz, latency budget and resource budget |
| `get_design(name)` | The starting Verilog and the rules `check` enforces |
| `check(name, verilog)` | `pass`, `stage`, `fix[]`, `mhz`, `x` (speedup), `lat`, `path` (slowest path), `use` (LUT/FF/DSP) |

A real `check` reply (about 270 characters):

```json
{"pass":true,"stage":"ok","fix":["correct; 74.4 MHz is below target 138: shorten the slowest path"],
 "mhz":74.4,"target":138,"base":74.4,"x":1.0,"lat":2,
 "path":"a_r->acc_r 13.43ns (48 logic hops, logic 7.35 route 5.56) carryx48 @L11,L19",
 "use":{"LUT":265,"FF":128,"DSP":4}}
```

`path` names the start and end registers, the delay split, the dominant cell type, and the source lines
(`L11`) on the path, so the agent knows exactly what to pipeline next.

## What `check` does

Cheapest gate first; the first failure returns with a `fix` list.

1. **static**: top module present, `localparam LATENCY` within budget, no `initial`, `` `include `` or system tasks (keeps the sandbox closed).
2. **lint**: Verilator.
3. **sim**: a 2,000-cycle self-checking testbench the agent never sees. If the outputs are right but shifted, it tells the agent the real latency.
4. **mutation**: re-run with `LATENCY+1`; it must fail, so a constant or undriven output can't pass.
5. **synth + ports**: Yosys `synth_ecp5`; the port list must match the original.
6. **pnr**: nextpnr-ecp5 on an LFE5U-85F-6BG381C, with every port registered by a harness, so logic before the first register can't escape timing.
7. **budget**: LUT, FF and DSP use within the design's budget.

Results are cached by exact source, so resubmitting the same file is free.

## Designs

| Design | What | Baseline | Target |
|---|---|---|---|
| `mac` | 32×32 multiply-accumulate, 64-bit | 74.4 MHz | 138 MHz |
| `fir8` | 8-tap signed FIR | 66.4 MHz | 107 MHz |
| `add64cmp` | three-operand 64-bit add + compare | 85.7 MHz | 149 MHz |
| `crc32` | CRC-32 over 64 bits per cycle | 61.1 MHz | 104 MHz |
| `popcount` | popcount of a 256-bit word | 70.0 MHz | 105 MHz |
| `mandel_step` | one Q3.14 Mandelbrot iteration | 79.1 MHz | 130 MHz |

Baselines are the starting files measured by this checker (`scripts/measure_baselines.py`).

## Connect an agent

Claude Code:

```bash
claude mcp add --transport http manudesk http://160.211.47.50:8765/mcp --header "Authorization: Bearer $MANUDESK_TOKEN"
```

Cursor and troubleshooting: [docs/CONNECT.md](docs/CONNECT.md). `scripts/connect.sh` prints both configs.

## Run it

```bash
uv sync
cp .env.example .env        # set MANUDESK_TOKEN (and CRUSOE_API_KEY for the built-in agent)
uv run python -m manudesk.server --host 0.0.0.0 --port 8765
uv run python scripts/mcp_smoke.py      # list, get, check over real MCP
uv run pytest -q
```

Needs the [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build) (yosys, nextpnr-ecp5, iverilog,
verilator). Set `MANUDESK_TOOLS` to its `bin` directory if it isn't auto-detected. Deploy to the VM with
`bash scripts/deploy.sh` (systemd unit in `deploy/`).

## Built-in agent and playbook

`manudesk.agent` is a reference engineer loop (Nemotron on Crusoe Managed Inference) that uses the same
`check` the MCP exposes. `manudesk.playbook` rewrites `playbooks/fpga.md` from measured runs; a code gate
drops any rule whose numbers aren't in the evidence. `scripts/eval.py` compares a blind arm (no feedback)
with a feedback arm on every design.

## Layout

```
manudesk/   checker.py (gates), eda.py (tool wrappers), server.py (MCP), designs.py, agent.py, playbook.py
designs/    <name>/{spec.json, start.v, tb.v (hidden)}, lib/ecp5_dsp.v
playbooks/  fpga.md (learned rules)
deploy/     systemd unit
scripts/    deploy, connect, smoke, eval, baselines
```
