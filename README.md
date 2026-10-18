# ManuDesk

**A hardware feedback loop for coding agents.**

Coding agents can write Verilog, but they can't tell whether it works or how fast it runs, so they guess.
ManuDesk gives them the answer: an MCP server that runs a hidden testbench and real synthesis, place and
route on a Lattice ECP5 FPGA, and returns a short JSON verdict an agent can act on.

AI agents are the customer, not humans. Every tool output is compact and cheap in tokens.

## Tools

Exactly four MCP tools:

| Tool | Returns |
|---|---|
| `list_designs()` | Each design: name, description, top module, `baseline_mhz`, `latency_budget`, `resource_budget` |
| `get_design(name)` | The naive starting Verilog, budgets, `goal`, `rules[]` and `device` |
| `dsp_helper()` | Verilog source of `mul18x18_reg`, a fully registered 18x18 multiply that maps to one MULT18X18D |
| `check(name, verilog)` | `{accepted, stage_reached, reasons[{what, fix}], fmax_mhz, baseline_mhz, vs_baseline, latency, critical_path, resources, budgets, seconds}` |

`critical_path` is one readable line built from nextpnr's report.json and the routed netlist's cell types and
`src` attributes, for example `critical path dut.s4[3] -> dut.s5[0]: 5.27 ns over 19 segments / 8 logic hops
(logic 1.88 ns, routing 2.86 ns, clk-to-q 0.53, setup 0.00); cells on path: CCU2C(carry) x8; Verilog sources:
design.v:11.15-11.17`.

## What `check` does

Stages run in order; the first failure returns, and every reason says what failed and how to fix it.

1. **lint**: sandbox rules (no `initial`, `` `include `` or system tasks), then Verilator `--lint-only`.
2. **interface**: the top module's ports (yosys parse, no synthesis) must match the original; `localparam LATENCY` present and within budget.
3. **testbench**: a 2,000-cycle hidden testbench (random vectors plus edge cases) against a golden model delayed by LATENCY. If the outputs are right but shifted, it tells the agent the real latency.
4. **latency_check**: rerun with `LATENCY+1`; if it still passes, LATENCY is overstated and the design is rejected.
5. **synth**: Yosys `synth_ecp5`.
6. **pnr**: nextpnr-ecp5 `--85k --speed 6 --freq 300 --timing-allow-fail` on a harness that registers every port, so logic before the first register can't escape timing.
7. **resources**: TRELLIS_FF, TRELLIS_COMB and MULT18X18D within the design's budget (the harness's port registers are not counted).

Each check runs in its own temporary directory (`MANUDESK_WORK`, no spaces) under a 120 s deadline. Results
are cached by exact source, so resubmitting the same file is free. `POST /api/check` keeps the short legacy
view (`pass`, `stage`, `fix`, `mhz`, `x`, `lat`, `path`, `use`) for the edge functions and the md_checks log.

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

Local, over stdio (needs the OSS CAD Suite on this machine):

```bash
claude mcp add manudesk -- uv run --directory /path/to/ManuDesk manudesk
```

Remote, over HTTP (Claude Code):

```bash
claude mcp add --transport http manudesk http://160.211.47.50:8765/mcp --header "Authorization: Bearer $MANUDESK_TOKEN"
```

Cursor and troubleshooting: [docs/CONNECT.md](docs/CONNECT.md). `scripts/connect.sh` prints both configs.

## Run it

```bash
uv sync
cp .env.example .env        # set MANUDESK_TOKEN (and CRUSOE_API_KEY for the built-in agent)
uv run python -m manudesk.server --transport http --host 0.0.0.0 --port 8765
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
