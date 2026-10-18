# REAL-CODE: what the EDA pipeline actually runs

Read-only survey from 2026-10-18. Every excerpt below is copied verbatim from the file and line shown. If something is not listed here, I did not find code for it.

## 1. What exists and what doesn't

**Found:**

| Repo | Role | Key files |
|---|---|---|
| `C:\Users\zubai\manudesk\` | **The only real EDA MCP server** ("ManuDesk"). Python `mcp` SDK, streamable HTTP at `/mcp`, bearer token | `manudesk\server.py`, `checker.py`, `eda.py`, `toolchain.py`, `designs.py`, `agent.py`, `scripts\mcp_smoke.py`, `deploy\manudesk.service` |
| `C:\Users\zubai\crusoe hackathon\` (Crusoe-Forge) | The full agent pipeline with sim, synth, P&R, waves, schematic, bitstream and PCB. **Not an MCP server**: it is a FastAPI app plus a CLI | `tc\tools\sim.py`, `tc\tools\synth.py`, `tc\tools\pnr.py`, `tc\tools\frames.py`, `tc\verifier.py`, `tc\visuals.py`, `tc\toolstream.py`, `tc\toolstream_x11.py`, `tc\pcb\pipeline.py`, `tc\__init__.py`, `scripts\check_toolchain.py` |
| `C:\Users\zubai\crusoe hackathon\.claude\worktrees\loving-swartz-2b4a62\` | An older worktree copy of the same `tc/` files | (no `tc/tools/sim.py` in this copy) |
| `C:\Users\zubai\yc 2.0 hackathon\plantforge-mcp\index.ts` | An MCP server, but still the mcp-use template. Its only tools are `show-app` (index.ts:47) and `say-hello` (index.ts:95). **No EDA tools** | |
| `C:\Users\zubai\yc 2.0 hackathon\fpga-flow\` | Only `fpga-mcp-pipeline.html`, a document. No code | |
| `C:\Users\zubai\yc 2.0 hackathon\demo\eda-walkthrough\real\` | One-off local captures used by the demo (logs, VCD, report.json, .bit, sby dirs, cocotb test). Not called by any MCP server | `nextpnr\command.txt`, `pcb\command.txt`, `sby\command.txt`, `cocotb\test_pwm_led.py` |

**Not found:**

- `tc/tools/sim.py` exists only at `C:\Users\zubai\crusoe hackathon\tc\tools\sim.py`. No other copy anywhere.
- No `@mcp.tool` / `FastMCP` / `server.tool(` code anywhere wraps the Crusoe-Forge `tc/` pipeline. Its sim, synth, P&R, waves and PCB steps are reachable only through FastAPI routes (`tc\app.py`, `tc\viewer_api.py`, `tc\toolstream.py`) and the agent loop.
- No code invokes **cocotb**. It is only a dependency in `crusoe hackathon\pyproject.toml:16` (`"cocotb>=2.1.0"`). The demo's `real\cocotb\` is a manual capture.
- **SymbiYosys** is never run as a flow step. The only code call is `sby --help` in a version check (`scripts\check_toolchain.py:38`).
- Nothing on the MCP path calls **GTKWave, KiCad, Freerouting, ecppack, Xvfb or netlistsvg**. They exist only in Crusoe-Forge (non-MCP).
- `C:\Users\zubai\mcp\server.js` is an unrelated MCP facade. It has no EDA terms.
- I searched `dev`, `develop`, `Desktop`, `Documents`, `Downloads` and every other folder under `C:\Users\zubai` (depth 6) for EDA tool names. Nothing turned up beyond the repos above.

## 2. The MCP server (ManuDesk)

Transport: `mcp.streamable_http_app(stateless_http=True, json_response=True, ...)`, wrapped by `BearerAuth`. `GET /health` is open (`manudesk\manudesk\server.py:112-120`, `:88-103`). Every tool returns a **compact JSON string** (`separators=(",", ":")`). Concurrency is capped by `anyio.CapacityLimiter(MANUDESK_PARALLEL or cpu/2)` (server.py:38).

`C:\Users\zubai\manudesk\manudesk\server.py:45-78`
```python
@mcp.tool(annotations=_RO, structured_output=False)
def list_designs() -> str:
    """Available designs and their limits: target/baseline MHz, latency budget (cycles), resource budget."""
    return _dumps([{"name": d.name, "what": d.summary, "target_mhz": d.target_mhz, "base_mhz": d.baseline_mhz,
                    "lat_budget": d.latency_budget, "res": d.resource_budget} for d in all_designs().values()])

@mcp.tool(annotations=_RO, structured_output=False)
def get_design(name: str) -> str:
    ...
    return _dumps({"name": d.name, "top": d.top, "what": d.summary, "limits": d.limits(), "rules": RULES,
                   "verilog": d.start})
...
async def check(name: str, verilog: str) -> str:
    async with _slots:
        out = await anyio.to_thread.run_sync(checker.check, name, verilog)
```

How it runs on the VM (`manudesk\deploy\manudesk.service`): `ExecStart=/home/ubuntu/.local/bin/uv run python -m manudesk.server --host 0.0.0.0 --port 8765`, with `MANUDESK_TOOLS=/opt/fpga/oss-cad-suite/bin` and `MANUDESK_WORK=/var/tmp/manudesk`.

How tools are found (`manudesk\manudesk\toolchain.py:24-31, 65-69`): `MANUDESK_TOOLS`, else `/opt/fpga/oss-cad-suite/bin`, `~/fpga/oss-cad-suite/bin` or `C:\fpga\oss-cad-suite\bin`. Every tool runs through this helper:
```python
def run(argv: list[str], cwd: Path, timeout: float) -> tuple[int, str]:
    """Run a tool, return (exit code, stdout+stderr). Raises subprocess.TimeoutExpired."""
    p = subprocess.run(argv, cwd=cwd, env=tool_env(), capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout, creationflags=_NO_WINDOW)
    return p.returncode, p.stdout + p.stderr
```
Each `check` gets a fresh scratch dir, `work/chk_<name>_<uuid10>`, which is deleted afterwards (`checker.py:142, 202-204`). Results are cached in an LRU keyed by sha256(name + source), 512 entries (`checker.py:209-226`).

### check() gate order (`manudesk\manudesk\checker.py:136-201`)

static → lint → sim → mutation (LATENCY+1 must FAIL) → synth → ports unchanged → harness synth → P&R → budget. The first failure returns early.

## 3. Per tool, as invoked

### Verilator (lint)

MCP path, `C:\Users\zubai\manudesk\manudesk\eda.py:25-34`:
```python
    argv = [tool("verilator_bin"), "--lint-only", "-Wno-fatal", "-Wno-DECLFILENAME", "-Wno-UNUSEDSIGNAL",
            "-Wno-UNUSEDPARAM", "-Wno-WIDTH", "--top-module", top, *[f.name for f in files]]
    try:
        rc, out = run(argv, cwd, 60)
    except subprocess.TimeoutExpired:
        return ["lint timed out"]
    errors = [_short(l) for l in out.splitlines() if l.startswith("%Error") and "Exiting due to" not in l]
    if rc != 0 and not errors:
        errors = [_short(l) for l in out.strip().splitlines()[-3:]] or [f"verilator exit {rc}"]
```
Timeout is 60 s and cwd is the scratch dir. **Warnings are discarded.** Only `%Error` lines are kept, with the `%Error:` prefix stripped by `re.sub(r"^%Error(-\w+)?:\s*", "", ...)` and cut to 200 chars (eda.py:39). Returns `list[str]`, which goes into `fix[]` with `stage:"lint"`.

Crusoe-Forge (non-MCP), `C:\Users\zubai\crusoe hackathon\tc\verifier.py:62-71`: the same flags without `-Wno-WIDTH`, timeout 120 s. It also keeps `%Warning` lines and returns them as `lint_warnings`. **Neither path uses `-Wall`.**

### Icarus iverilog + vvp (simulation)

MCP path, `C:\Users\zubai\manudesk\manudesk\eda.py:56-74`:
```python
        rc, out = run([tool("iverilog"), "-g2012", "-o", "sim.vvp", *names], cwd, timeout)
    ...
        _, out = run([tool("vvp"), "-n", "sim.vvp"], cwd, timeout)
    except subprocess.TimeoutExpired:
        return Sim(True, verdict="TIMEOUT", errors=[f"simulation timed out after {timeout:g}s"])
    verdict, mism = "", []
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("MISMATCH"):
            mism.append(s)
        elif s.startswith(("PASS", "FAIL")):
            verdict = s
    return Sim(True, verdict.startswith("PASS") and not mism, verdict, mism[:4])
```
Timeout is 60 s per step. The hidden `tb.v` comes first in `names`. Compile errors are lines containing "error" (up to 5), with the testbench path scrubbed (`_hide_tb`: `\S*tb\.v:\d+:?` → `testbench:`). Pass means the last line starting with `PASS` and zero `MISMATCH` lines. On FAIL, `_true_latency` re-simulates with LATENCY ±1, ±2, ±3 (checker.py:84-90).

Crusoe-Forge, `C:\Users\zubai\crusoe hackathon\tc\tools\sim.py:69-86`: the same commands through `run_streaming` (Popen with a kill timer, live `[tool:iverilog]` lines), timeout 120 s. Returns `SimResult{passed, compiled, verdict, mismatches, errors, seconds, log[-2000:]}`.

### Waveforms (VCD) and GTKWave. Crusoe-Forge only

`C:\Users\zubai\crusoe hackathon\tc\visuals.py:269-275`:
```python
    comp = subprocess.run([tool("iverilog"), "-g2012", "-o", "wave.vvp", "-s", "tb", "-s", "tc_dump",
                           "tb.v", "design.v", *extra, "tc_dump.v"], cwd=workdir, env=env,
                          capture_output=True, text=True, timeout=timeout)
    ...
    run = subprocess.run([tool("vvp"), "-n", "wave.vvp"], cwd=workdir, env=env, capture_output=True,
                         text=True, timeout=timeout)
```
A generated `tc_dump.v` top writes `wave.vcd` (limit 100 µs, timeout 120 s). Returns `{vcd, passed, verdict, mismatches, workdir}`, which is then rendered to SVG. GTKWave is launched only as a desktop GUI, `visuals.py:906`: `_launch([tool("gtkwave"), str(vcd), str(gtkw)], wd)`. That is a detached Popen, returning `{pid, argv}`. **The MCP server has no VCD or wave output at all.**

### Yosys (synthesis)

MCP path, `C:\Users\zubai\manudesk\manudesk\eda.py:93-105`:
```python
    script = f"read_verilog -sv {' '.join(f.name for f in files)}; synth_ecp5 -top {top} -json synth.json"
    try:
        rc, out = run([tool("yosys"), "-q", "-p", script], cwd, timeout)
    except subprocess.TimeoutExpired:
        return Synth(False, errors=[f"yosys timed out after {timeout:g}s"])
    js = cwd / "synth.json"
    if rc != 0 or not js.exists():
        errs = [l.strip() for l in out.splitlines() if "ERROR" in l] or out.strip().splitlines()[-3:]
        return Synth(False, errors=[e[:200] for e in errs[:4]])
    mods = json.loads(js.read_text(encoding="utf-8"))["modules"]
    mod = mods.get(top) or next(iter(mods.values()))
    ports = {k: [v["direction"], len(v["bits"])] for k, v in mod["ports"].items()}
```
Timeout is 180 s. Only the port map is extracted; cell counts are not. Yosys runs twice per check: once on the design, then on `manudesk_harness` (a wrapper that registers every port, checker.py:93-111, 180-181).

Crusoe-Forge, `C:\Users\zubai\crusoe hackathon\tc\tools\synth.py:157-161`, adds `stat -json` and a log file:
```python
    script = (f"read_verilog -sv {' '.join(names)}; synth_ecp5 -top {top} -json synth.json; "
              f"tee -q -o stat.json stat -json")
    ...
            rc, out = run_streaming([tool("yosys"), "-l", "yosys.log", "-p", script], workdir, "yosys", _keep_yosys,
```
Parses `num_cells_by_type` (synth.py:132-143). Returns `SynthResult{ok, json_path, cells, errors, warnings, seconds, log}`. Schematic generation (`visuals.py:497-509`): `yosys -q -p "read_verilog -sv design.v; hierarchy -check -top T; proc; opt -full; wreduce; opt_clean -purge; write_json -noscopeinfo schem.json"`, then `npx --yes netlistsvg schem.json -o schem.svg`, with a fallback to `yosys show -format svg`.

### nextpnr-ecp5 (place and route, Fmax, utilisation)

MCP path, `C:\Users\zubai\manudesk\manudesk\eda.py:17, 200-210`:
```python
DEVICE = ["--85k", "--package", "CABGA381", "--speed", "6"]
...
    argv = [tool("nextpnr-ecp5"), *DEVICE, "--json", netlist.name, "--freq", f"{freq_mhz:g}", "--seed", str(seed),
            "--timing-allow-fail", "--lpf-allow-unconstrained", "--report", report.name, "-q"]
    try:
        rc, out = run(argv, cwd, timeout)
    except subprocess.TimeoutExpired:
        return Pnr(False, errors=[f"place and route timed out after {timeout:g}s"])
    if not report.exists():
        errs = [l.strip() for l in out.splitlines() if "ERROR" in l] or out.strip().splitlines()[-3:]
        return Pnr(False, errors=[e[:200] for e in errs[:4]])
    return parse_report(json.loads(report.read_text(encoding="utf-8")))
```
`--freq` is the design's `target_mhz`, seed is 1 and the timeout is 300 s. There is no LPF, no `--write` and no SVG.

Parsing (`eda.py:160-195`):
- **Fmax** is `min(report["fmax"].items(), key=achieved)`, so the worst clock wins, rounded to 0.1 MHz.
- **Utilisation** is `{k: v["used"]}` from `report["utilization"]`.
- **Critical path** is the longest `critical_paths` entry on that clock. From it the code takes logic/routing ns, the number of logic hops and cell kinds, and source lines (`design.v:(\d+)` → `Lnn`).

The checker then maps resources to `use = {"LUT": TRELLIS_COMB, "FF": TRELLIS_FF - harness_ffs, "DSP": MULT18X18D}` (checker.py:190-191).

Crusoe-Forge, `C:\Users\zubai\crusoe hackathon\tc\tools\pnr.py:170-176`:
```python
    argv = [tool("nextpnr-ecp5"), *DEVICE_ARGS, "--json", str(netlist), "--freq", f"{freq_mhz:g}",
            "--seed", str(seed), "--timing-allow-fail", "--lpf-allow-unconstrained",
            "--report", str(report), "--write", str(routed), "-l", str(workdir / "nextpnr.log")]
    assert not any("svg" in a for a in argv)
```
Timeout is 600 s. It also computes `slack_ns = 1000/constraint - 1000/fmax`. Returns `PnrResult{ok, fmax, constraint, slack_ns, clock, path, utilization, errors, seconds, report_path, routed_path}`. The GUI launch (non-MCP) is `nextpnr-ecp5 --85k --package CABGA381 --speed 6 --json routed.json --gui` (visuals.py:913).

### ecppack (bitstream). Crusoe-Forge only

`C:\Users\zubai\crusoe hackathon\tc\tools\frames.py:338-345`:
```python
        ("yosys", ["yosys", "-q", "-l", "yosys.log", "-p",
                   f"read_verilog {names}; chparam -set N_CORES {cores} {chp} ulx3s_mandel_top; "
                   "synth_ecp5 -top ulx3s_mandel_top -json mandel.json"]),
        ("nextpnr", ["nextpnr-ecp5", "--85k", "--package", "CABGA381", "--speed", "6",
                     "--json", "mandel.json", "--lpf", "ulx3s_v20.lpf", "--textcfg", "mandel.config",
                     "--report", "report.json", "--timing-allow-fail", "-l", "nextpnr.log"]),
        ("ecppack", ["ecppack", "--compress", "mandel.config", "mandel.bit"]),
```
Runs in `C:\fpga\work\mandel_bit*` with no timeout and raises on rc≠0. This builds only the fixed `designs/mandel` engine, not per-candidate designs. **The MCP server never produces a .bit.**

### SymbiYosys (sby)

The only code is the version probe at `C:\Users\zubai\crusoe hackathon\scripts\check_toolchain.py:38`:
```python
    "sby": (["sby", "--help"], r"usage: sby"),
```
The demo capture `real\sby\command.txt` is `python make_formal.py` / `sby -f pwm_led.sby`, which was run by hand.

### cocotb

No invoking code exists. It is only a dependency (`crusoe hackathon\pyproject.toml:16`). The demo's `real\cocotb\test_pwm_led.py` and `run.log` were a manual capture.

### KiCad and Freerouting. Crusoe-Forge only

`C:\Users\zubai\crusoe hackathon\tc\pcb\pipeline.py:141-143, 159-160`:
```python
    p = step("freeroute", lambda: _run([JAVA, "-jar", FREEROUTING, "-de", out / "board.dsn",
                                        "-do", out / "board.ses", "-mp", "100", "--gui.enabled=false"],
                                       300, log=out / "freerouting.log"))
    ...
    p = step("drc_gate", lambda: _run([KICAD_CLI, "pcb", "drc", "--severity-error", "--exit-code-violations",
                                       "--format", "json", "-o", drc_json, routed], TOOL_TIMEOUT))
```
- `FREEROUTING` is `C:/fpga/freerouting/freerouting-2.4.1.jar` (pipeline.py:55). Java must be version 21 or later.
- The Freerouting score is parsed with `r"final score: ([\d.]+) \((\d+) unrouted and (\d+) violations\)"` (pipeline.py:59).
- DRC counts error-severity `violations` plus `unconnected_items`, and passes only when rc==0 and both counts are 0.
- The step before is `gen_place`, which runs `kicad_gen.py` under KiCad's Python. The step after is `ses_import` (`kicad_ses.py`).
- `export_fab` runs, in parallel: `kicad-cli pcb export gerbers|drill|pos`, `pcb render` (top and iso) and a full DRC report (pipeline.py:177-186). `TOOL_TIMEOUT` is 300.
- Returns `PcbResult` (`passed, drc_errors, unconnected, violations[], route_score, unrouted, tracks, vias, files{}, timings{}`), written to `result.json`.

### Xvfb and toolstream (GUI streaming). Crusoe-Forge only, HTTP not MCP

`C:\Users\zubai\crusoe hackathon\tc\toolstream_x11.py:50-57`:
```python
    XVFB_OF[d] = subprocess.Popen(["Xvfb", d, "-screen", "0", f"{WIN_W}x{WIN_H}x24", "-nolisten", "tcp"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    ...
    p = subprocess.Popen([str(a) for a in argv], cwd=cwd, env={**(env or os.environ), "DISPLAY": d},
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
```
- Frames are grabbed with `import -display :N -window root -silent png:-`, and input is sent with `xdotool`.
- On Windows, `tc\toolstream.py` uses win32 PrintWindow instead.
- Routes: `POST /api/tool/{run_id}/{tool}/start|stop|input`, `GET .../frame.jpg`, `GET .../stream` (MJPEG, up to 10 fps), with `tool ∈ {gtkwave, nextpnr, kicad}` (toolstream.py:37, 709-775).

### uv / Python

uv is used only as the launcher: `uv run python -m manudesk.server ...` (systemd unit) and `uv run python scripts/check_toolchain.py` (docstring). No code calls `uv` through subprocess.

## 4. Student calls MCP tool → code runs → JSON comes back

These are the **only** real EDA MCP tools: ManuDesk at `C:\Users\zubai\manudesk`.

| MCP tool (params) | Code that runs (file:line, command) | Comes back (compact JSON string) |
|---|---|---|
| `list_designs()` | `server.py:45-49` reads `designs/*/spec.json` (`designs.py:52-60`). No EDA tool | `[{"name","what","target_mhz","base_mhz","lat_budget","res":{LUT,FF,DSP}}]` |
| `get_design(name: str)` | `server.py:52-60` reads `designs/<name>/start.v`. No EDA tool | `{"name","top","what","limits":{target_mhz,baseline_mhz,latency_budget,resources},"rules","verilog"}` or `{"error"}` |
| `check(name: str, verilog: str)` → static gate | `checker.py:44-62`: regex rules (no `initial`, `` `include ``, `$tasks` other than `$signed/$unsigned/$clog2/$bits`; `localparam LATENCY` within 1..budget; 200 kB max) | `{"pass":false,"stage":"static","fix":[...],"target","base"}` |
| `check` → lint | `eda.py:25-28`: `verilator_bin --lint-only -Wno-fatal -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTH --top-module <top> design.v` (60 s) | `{"pass":false,"stage":"lint","fix":[errors],"lat",...}` |
| `check` → sim | `eda.py:56,64`: `iverilog -g2012 -o sim.vvp tb.v design.v [ecp5_dsp.v]`, then `vvp -n sim.vvp` (60 s each); latency probe ±1..3 | `{"stage":"sim","fix":["does not compile: ..."]}`, or `["logic is correct but its real latency is N ..."]`, or `["wrong outputs: MISMATCH ...", "check widths/signedness..."]` |
| `check` → mutation | `checker.py:165`: the same sim with `LATENCY+1`. It must FAIL | `{"stage":"mutation","fix":["output does not depend on LATENCY ..."]}` |
| `check` → synth / ports | `eda.py:95`: `yosys -q -p "read_verilog -sv design.v; synth_ecp5 -top <top> -json synth.json"` (180 s); ports compared with the baseline's | `{"stage":"synth"\|"ports","fix":[...]}` |
| `check` → pnr | `checker.py:180-184`: yosys on `manudesk_harness`, then `eda.py:201`: `nextpnr-ecp5 --85k --package CABGA381 --speed 6 --json synth.json --freq <target> --seed 1 --timing-allow-fail --lpf-allow-unconstrained --report report.json -q` (300 s) | `{"stage":"pnr","fix":[ERROR lines]}` |
| `check` → budget / ok | `checker.py:189-201` | `{"pass":true,"stage":"ok","fix":[maybe "below target"],"mhz","target","base","x","lat","path":"a_r->acc_r 13.43ns (48 logic hops, logic 7.35 route 5.56) carryx48 @L11,L19","use":{"LUT","FF","DSP"}}`; over budget gives `stage:"budget"` with the same speed fields |

Also: `GET /health` → `{"ok","designs","checks","passes","uptime_s"}` (server.py:81-85). The smoke client `manudesk\scripts\mcp_smoke.py:25-31` calls `list_tools`, `list_designs`, `get_design("popcount")` and `check("popcount", ...)`.

`plantforge-mcp` tools `show-app` and `say-hello` are template stubs that call no EDA code.

## 5. Gaps

**The demo shows these, but no MCP code invokes them:**

- **GTKWave / waveforms.** ManuDesk returns no VCD, no wave JSON and no image. VCD exists only in Crusoe-Forge `visuals.simulate_vcd` (HTTP `/api/runs/.../wave`, not MCP).
- **Verilator `-Wall` / lint warnings.** Neither codebase passes `-Wall`. ManuDesk drops warnings entirely and reports only `%Error`.
- **cocotb.** There is no invoking code anywhere, only a pyproject dependency.
- **SymbiYosys.** It appears only as `sby --help` in a toolchain check. No formal or cover flow exists in code.
- **ecppack / .bit.** Only Crusoe-Forge `frames.build_bit` for the fixed mandel design. Not per student design, not in MCP.
- **Yosys LUT/FF stats and schematic.** ManuDesk returns only post-P&R `use{LUT,FF,DSP}`, not `stat` output or a schematic. Schematics (netlistsvg) exist only in Crusoe-Forge.
- **nextpnr with a user LPF and `--freq 25`.** ManuDesk always uses `--lpf-allow-unconstrained` and `--freq = design target_mhz`. The demo's `real\nextpnr\command.txt` (`--lpf pwm_led.lpf --textcfg ... --freq 25`) is a manual capture.
- **KiCad, Freerouting, Xvfb/toolstream.** Crusoe-Forge only (HTTP/CLI). The demo's Freerouting run used `-mp 30 -da --router.result_json=...`, while the code uses `-mp 100` without those flags. The demo PCB DSN is hand-written by `real\pcb\gen_board.py`, not KiCad.
- **Students submitting their own design (e.g. `pwm_led`) or testbench.** ManuDesk's `check` accepts only names from `designs/*/spec.json` (mac, fir8, add64cmp, crc32, popcount, mandel_step) and always uses its **hidden** `tb.v`. There is no "upload my testbench" parameter.

**Real code paths the demo doesn't show:**

- The hidden-testbench model, with its static sandbox rules (no `initial` / `$system` / `` `include ``).
- The **mutation check** (LATENCY+1 must fail) and the automatic **true-latency diagnosis**.
- The **timing harness** that registers every port before P&R, which closes the "logic before the first register" Fmax loophole.
- Port-signature lock against the baseline, resource budgets, and speedup `x` versus baseline.
- `path` with source lines `Lnn`, so the agent knows what to pipeline.
- The result cache (sha256 LRU, 512 entries), the parallelism limiter, bearer auth and `/health` stats.
- Crusoe-Forge only: the Nemotron diff review (advisory), the latency auto-fix, the ULX3S PCB fab export (Gerbers, drill, pos, renders).
