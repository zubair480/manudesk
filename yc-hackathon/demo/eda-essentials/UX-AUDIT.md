# UX Audit: keeping the audience hooked (Session G)

Owner: **Session G** (viewer-experience lead). Per-scene detail comes from subagents G1–G5, each of which read the scene source and data, and the headless/in-browser frames. Timings are at 1× from the code, cross-checked against the frames. Every number cited is real (data/*.json, real/*).
> **⚠ SUPERSEDED (08:20, USER): no zoom in/out on 2D scenes.** `ctx.focus` is now a no-op unless `{essential:true}`, and camera motion is for the 3D scenes only (07, 09's 3D). Wherever a 2D fix below says `ctx.focus(...)`, do **in-place emphasis** instead: spotlight the key element (dim the rest to ~35% opacity, as 06-yosys does), enlarge or pulse the key number, or show a big centered result overlay for ~2 s. The *what* (which moment to emphasize) still stands; only the *how* changes.

Each scene has: **A** a viewer thought track, **B** issues ranked P0/P1/P2, **C** exact fixes with file/function, and **D** a caption script (≤70 chars, one idea each) to paste into `ctx.narrate`.

## TL;DR: the 8 things that lose the audience

| # | Sev | Problem | Where | Owner |
|---|---|---|---|---|
| 1 | P0 | **Fake Fmax 348.8 MHz.** The real run gives **214.96 MHz** (8.6× the 25 MHz needed). It is shown on the hero and in 11-results, and contradicts scene 07. 11-results fallbacks are also wrong: 33 LUT (real 48), 26 FF (real 41), 2 props (real 5). | index.html `.stats`, scenes/11-results/scene.js `FALLBACK` | main |
| 2 | P0 | **11-results finale breaks in a full run.** It renders 38 tiles, 30 of which are clipped (all PCB numbers). It lasts ~1.5 s, all in skim, with no hero visual. | scenes/11-results | main |
| 3 | P0 | **09 routes the board before 10 does.** 10 rewinds to 58 airwires, so its payoff is spoiled. | scenes/09-kicad | D |
| 4 | P0 | **The key moment isn't emphasized.** FAIL, 44→150, Fmax and 58→0 sit at full frame in a corner. *(Was "add ctx.focus"; per the user's 08:20 no-2D-zoom rule, use spotlight/dim, an enlarged number or a result overlay instead. Camera moves are for 3D only.)* | all scenes | A–F |
| 5 | P0 | **Captions too long and too short-lived.** 80–124 chars, some on screen for 0.3–1.6 s. Skim ×4 makes key beats (ERC/DRC, 01's whole build, 06) flash by. | all scenes | A–F |
| 6 | P1 | **Dead tails.** Most scenes end on a frozen frame for 2–6 s (the scene's own sleep + the shell's 1.8 s). Keep the hardware alive (loop the trace, keep LEDs breathing) until unmount. | 01, 02, 05, 10 | A, B, D |
| 7 | P1 | **Spoilers.** The hero's "4/4 passing" kills 02's FAIL beat. The agent bar shows "4/4 PASS" at 0 s in 05. 09 shows routed copper before 10. | index.html, core/agent.js, 09 | main, H, D |
| 8 | P1 | **No visible delta.** Each step should show what it changed: 44 → 150 cells (06), FAIL → 4/4 (02), 58 → 0 (10). These are currently static or end-only. | 02, 06, 10, 11 | A, C, D, main |

## Shell-level fixes (done by Session G: `core/story.js` + `core/story.css`)

Already loaded by index.html. Disable with `?story=0`.
1. **Chapter banner** at every scene start: a floating card at the top center (non-blocking, so the hardware keeps drawing underneath). It shows "STEP 4 OF 10 · INSPECT", the tool name, the **hook question** ("What did the circuit really do, clock by clock?"), a green **"✓ last step: result"** chip (the carry-over delta) and a 10-segment progress bar. Hold is 2.2 s on a cold start, or 1.5 s when the teaser already introduced it (scaled by playback speed).
2. **Footer step chip + story-so-far rail:** `3/10 Lint` next to the caption, plus a rail of finished steps, each carrying its headline result: `Icarus 4/4 tests pass (run 1 failed)` · `Verilator 0 lint warnings` · `Yosys 150 real ECP5 cells` · `nextpnr 215 MHz: 8.6× the 25 MHz needed` · `SymbiYosys 5/5 properties proved` · `Freerouting 0 unrouted, in 9.44 s`. Values come from live `ctx.emit` metrics, with real-data fallbacks. A new chip pops in with the tool color.
3. **Next-up teaser** during the shell's 1.8 s auto-advance gap, which is currently dead: "✓ result" chip + "NEXT · step 5 · cocotb: Can Python test the same hardware?" + a countdown bar. Wired: core.js now dispatches `wt:played`. The countdown matches the shell's 900 ms post-scene gap.

Hook questions per step (story.js `STORY`):
01 *40 lines of text. Can they become a glowing circuit board?* · 02 *Does the circuit actually behave? Run it.* · 03 *The tests pass. Is anything hiding in the code?* · 04 *What did the circuit really do, clock by clock?* · 05 *Can Python test the same hardware?* · 06 *Code is just text. What does it become as logic?* · 07 *Will it fit on the chip, and run fast enough?* · 08 *Tests try some inputs. Can we prove it for all of them?* · 09 *A chip needs a body. Can we build the board?* · 10 *58 connections to wire. By hand, or by machine?* · 11 *From 40 lines of code to a routed board. The scorecard:*

**Rule for scene owners:** the banner covers the top-center ~520×150 px for the first ~2.2 s. Don't put the scene's first key beat there, and don't repeat the hook question verbatim as the first caption (start captions ~1 s in, with the next idea).

## Shell-level asks for main (core.js, index.html, 11-results; not Session G's files)
- `core.js runScene()`: add the `wt:played` event (above).
- `core.js go()`: `$('#caption-text').textContent = entry.tool + '…'` before `loadModule`, so the stale "Press ▶ to start the walkthrough" doesn't show while a scene loads.
- `index.html .stats`: Fmax `data-count="214.96" data-dec="0"`. Replace "4/4 tests passing" with "1 bug caught on the way" (keep the FAIL suspense). `hero.css:13` uses gradient text (banned); use solid `#2563eb`.
- 11-results: see §11 (real fallbacks keyed by emitted keys, a curated 5-chapter recap, `ctx.visual()`, camera, and the 3D board as the hero).
- Tool count: there are 9 tools (Verilog is the language). Say "9 open-source tools".

---

# G1 UX audit: intro hero, 01-code, 02-iverilog

Sources: index.html, core/intro.js, core/hero.js, core/hero.css, core/core.js, core/story.js, scenes/01-code/*, scenes/02-iverilog/*, data/01-code.json, data/02-iverilog.json, real/*.log.
Frames: **frames2/** only (frames/ was invalid). Caveat: 13 pages were captured in parallel, so frame index is not wall-clock seconds (01-code captions span 20 s of perf time, but the code timing is about 6 s). The timings below are computed from the code at 1× and cross-checked against the frames.
Real numbers used: RTL 40 lines, TB 41 lines; run 1 test2 FAIL on0=51 vs duty=55 (check 53..57); run 2 PASS 51/256 in window 39..55; test1 duty=39; test3 flip at 255; 4/4; sim time 165.02 µs; 4,126 clock edges; pwm_led.vcd 217.3 KB, 8,252 timestamps; vvp real 0.065 s; Fmax **214.96 MHz** (real/nextpnr: 214.96 / 219.54), 25 MHz needed.

---

## 0. Intro hero (index.html #intro, core/intro.js, core/hero.js)

No autoplay. It waits for a click. Measured: headline words rise at 0.12–0.8 s, stats count up at 0.7–2.5 s, tags float in at 1.4–1.8 s, and the rotator swaps every 2.2 s.

### A. Thought track
- 0 s: sees a big headline and a green 3D board rising. Thinks "nice, a hardware demo". Eyes on the headline. The rotator slot is **blank** (frame t000: "Our design was ___ by ___").
- 1 s: stats count up 4/4, 0, 348.8 MHz, 0. Thinks "results already? so nothing can go wrong". The suspense is gone before the start.
- 2 s: tags appear: "25 MHz clock" floats over empty board, "8 phase-shifted PWM LEDs" sits below the LEDs. Eyes jump between the tags and the board and can't connect them.
- 2.2 / 4.4 / 6.6 s: the rotator swaps. In about 30% of frames the tool word is mid-swap and invisible (t004: "synthesized by ___").
- 3–10 s: the board sways ±0.12 rad. The LEDs read as pale white/cyan boxes on white, so "breathing" is barely visible (t004). The promise in the headline isn't seen.
- Then: the pipeline strip highlight walks along. The viewer either clicks Start or idles. There is no stake or question to pull them in.

### B. Issues
- **P0: a fake Fmax.** index.html `.stats` `data-count="348.8"` does not appear in any real log. The real value is 214.96 MHz (data/07-nextpnr*.json, story.js fallback). It contradicts scene 07 later.
- **P1: the stats spoil the story.** "4/4 tests passing" up front kills the run-1 FAIL beat in 02.
- **P1: gradient headline text** (`core/hero.css:13 #hero-h1 .acc` linear-gradient + background-clip). COORDINATION bans gradient text. The pipeline rail gradient (`hero.css:46`) is also banned.
- **P1: the LEDs don't visibly breathe** on white. The emissive range is too low, and the LED body color 0x7fd1ff with a white base reads as off. That is the headline's core image.
- **P1: no hook question.** The copy is descriptive ("One hardware design… taken through…"), so nothing tells the viewer what is at stake.
- **P2: the rotator is blank during the swap.** `swap()` hides verb and tool for 260 ms, the tool lags by 70 ms, and both are 'out' at once.
- **P2: tags aren't anchored** to the parts they name (fixed % positions while the board rotates).
- **P2: no duration cue** ("2-minute walkthrough · 10 real tools").

### C. Fixes
1. `index.html` `.stats`: replace the 348.8 block with `<b data-count="214.96" data-dec="0">0</b><em>MHz</em><small>Fmax (25 needed)</small>`. Better still, swap the "tests passing" stat for a teaser: `<b data-count="1">0</b><small>bug caught on the way</small>`, and move 4/4 to 11-results.
2. `core/hero.css:13`: `#hero-h1 .acc { color: #2563eb; }` (solid tool blue, no clip). `hero.css:46`: `.pipeline .rail i { background: #2563eb; }`.
3. `core/hero.js` LED material: use `color: 0xd1fae5, emissive: 0x10b981` (green, matching 01's LED color), `emissiveIntensity = b * 3.2`, `glow.intensity = b * 3`. Also add a dim off-state `lm.color.setHSL(.42, .5, .55 + .35*b)` so a lit LED differs from an unlit one even without bloom. Also cut the sway: `Math.sin(t * 0.25) * 0.05`, and point the camera slightly toward the LED row (`camera.lookAt(-0.6, -0.2, 1.0)`).
4. `index.html` hero-copy `<p>`: replace with a stake line: "40 lines of Verilog. 10 real open-source tools. Does it survive all the way to a routed board?" Add `<small class="dur">≈2 min · every number is real tool output</small>` under the CTA.
5. `core/intro.js` `swap()`: cross-fade instead of blanking. Set the text at 130 ms instead of 260 ms, and don't stagger the tool by 70 ms (`setTimeout(() => swap(tool…), 0)`).
6. `core/hero.css` `.tag.t3`: move it next to the oscillator, or drop the tags and let the `.stats` row carry them.

### D. Hero copy (not ctx.narrate; static)
- Eyebrow: "Real tool output, captured on this machine" (keep)
- H1: "From 40 lines of Verilog to a breathing circuit board"
- Sub: "10 open-source tools, one design. One of them catches a bug."
- CTA: "Watch it build →"

---

## 1. Scene 01-code (scenes/01-code/scene.js, data/01-code.json)

**Duration ≈ 6.4 s** (play about 4.6 s + 1.8 s teaser hold). The whole RTL appears in 0.8 s.
Timeline at 1×: shell sleep 0.125 s (skim). `visual()` is called immediately. intro 120 ms → 9 RTL blocks × 75 ms (but block 6 runs the ramp callout for 1.1 s) → 7 TB blocks × 45 ms → runLive 1.9 s in parallel with the leds callout 1.3 s → outro 0.2 s.
**The story.js chapter card (`showCard`, 1500 ms on a cold start, 86% white overlay) covers 0–1.5 s, so it hides the RTL build almost entirely.**

### A. Thought track
- 0.0 s: sees the "Step 1 of 10 · Verilog" card. "40 lines of text. Can they become a glowing circuit board?" Good hook. Eyes on the card.
- 0.1–0.9 s, **under the card**: 31 RTL lines and frame/pins/regs/clock/counters appear behind the 86% white veil. The viewer misses it.
- 0.9 s: ramp callout narration (118 chars) plus rings on pre/tick/duty/dir. The card is still fading.
- 1.5 s: the card lifts and the code is already scrolled to line ~28. Thinks "where did all that come from?" Eyes split between a 50/50 editor and circuit.
- 2.0–2.25 s: the comparators, flops and 8 LEDs (the key hardware) pop in within 225 ms. No camera, no beat.
- 2.25 s: the tab switches to tb_pwm_led.v. The caption "The testbench… checks four behaviours" (94 chars) is visible for **0.3 s**. Test pills flash for 45 ms each. Unreadable.
- 2.55 s: back to pwm_led.v, lines 30–37 go yellow, and the "8 phase-shifted LEDs" card shows for 1.3 s. The circuit goes live: the cycle counter runs and the LEDs ripple. Payoff, but it starts and ends in under 2 s.
- 3.85 s: "40 lines of RTL and a 41-line self-checking testbench. Next, Icarus simulates it."
- 4.45 s: the live replay stops at cycle 3,900, frozen with all LEDs uniformly lit (t005–t008 identical, 0–1 mutations). **Dead for about 2 s** while the teaser shows.

### B. Issues
- **P0: far too fast.** The whole design is shown in under 2.5 s. Three of five captions are unreadable (118 chars in 1.1 s, 94 chars in 0.3 s, 108 chars in 1.3 s; a viewer needs about 15 chars/s).
- **P0: the chapter card hides the build** (0–1.5 s), because `visual()` plus a 120 ms intro starts the build at 0.125 s.
- **P1: layout is 50/50** (`scene.css:116 grid-template-columns: minmax(0,1fr) minmax(0,1fr)`). That breaks the ≥75% hardware rule. Editor lines are clipped at the right ("// prescaler bits: bre"), and the circuit panel has about 90 px of empty band above its header (t004/t005).
- **P1: no camera.** Zero `ctx.focus` calls. The tick gate and the LED comparators should get pushes.
- **P1: dead ending.** `runLive` resolves at cycle 3,900 and stops the RAF, so the LEDs freeze at duty 243 (all about equally lit, which doesn't look like a ripple).
- **P1: no live side readings** besides the tiny "cycle N · µs" readout (12 px).
- **P2: the testbench beat is invisible.** Pills last 45 ms and are removed at u > 0.35 of the live run.
- **P2:** the SVG header "pwm_led.v → hardware / builds as the code appears" is at 11.5–13 px.

### C. Fixes
1. `data/01-code.json` timing: RTL `"step": 75 → 380`, TB `"step": 45 → 220`; `timing: { intro: 1500, ramp: 2600, live: 5200, ledsCallout: 3000, outro: 600 }`. The scene becomes about 17 s.
2. `scenes/01-code/scene.js play()`: don't build behind the card. Keep `ctx.visual?.()` first and set `T.intro = 1500`, narrating the hook, so the first block lands just as the card lifts. Alternative: shorten the cold-start hold for step 1 in `core/story.js showCard()`.
3. Camera, in `play()` inside the block loop:
   - `if (b.hw === 'tick') { ctx.focus(state.root.querySelector('.cz [data-p="tick"]'), { scale: 2.0 }); }`, then `ctx.unfocus()` after the ramp callout.
   - `if (b.hw === 'leds') { ctx.focus(state.root.querySelector('.hw-panel'), { scale: 1.35 }); }`
   - During `runLive`: after 600 ms, `ctx.focus(state.root.querySelector('.cz [data-p="leds"]'), { scale: 2.2 })`. Hold 2 s so the staggered ripple is visible, then `ctx.unfocus()` before the closing narrate.
4. `scenes/01-code/scene.css:116`: `grid-template-columns: minmax(300px, 30%) minmax(0, 1fr);`. Add `@container (max-width: 560px) { .sa-code .vs-side { display: none; } }` and `.sa-code .ln .tx { overflow: hidden; text-overflow: ellipsis; }`. In `buildCircuit()`, set `H = 520` and move the header to `y: 18` to kill the empty band.
5. `runLive()`: don't stop at u ≥ 1. Replace `if (u >= 1) { hw.pills([]); return resolve(); }` with `if (u >= 1 && !done) { done = true; resolve(); }`, then keep animating a slow loop. For example `k = 643 + ((now/1000*300) % 3200)|0`, with `hw.update(k, 64)` continuing until `unmount` (which already cancels `state.raf`). The last 2 s then still breathe.
6. Readings: add a stacked `.hw-reads` column inside `.hw-panel` (left edge, tabular-nums 600). Rows: `lines 0→40` (updated in `showLines`), `registers 0→4`, `comparators 0→8`, `LEDs 0→8` (updated in `reveal()`), `TB checks 0→4` (updated in `pill()`), then `cycle / µs / duty / dir` during live.
7. TB beat: in `play()` after the TB file, `await ctx.sleep(1400)` with all 4 pills visible. Make `hw.pills([])` fire only at u > 0.7.

### D. Narration script (01-code)
1. [0 s, card / first block] "40 lines of text. Watch them turn into a circuit."
2. [regs block] "Four registers: a prescaler, a brightness value, a direction, a counter."
3. [tick block + focus on the & gate] "Every 65,536 clocks, a tick nudges brightness up or down by one."
4. [cmpA/cmpB + leds] "Eight comparators, each offset by 32: that's the ripple across the LEDs."
5. [TB file open] "The testbench drives the clock and checks four behaviours."
6. [live + focus on LEDs] "Replaying the real simulation: the LEDs breathe in a staggered wave."
7. [end / cliffhanger] "Looks right. But does it actually work? Icarus is about to find out."

---

## 2. Scene 02-iverilog (scenes/02-iverilog/scene.js, data/02-iverilog.json)

**Duration ≈ 24 s.** Timeline at 1×:

| t (s) | beat |
|---|---|
| 0–0.9 | chapter card (900 ms, teaser already shown) over the stage |
| 0.1–0.6 | compile, skimmed: command, timescale warning, `iverilog exit 0` |
| 0.6–0.75 | "Run 1" + `vvp -n sim.vvp` typed (skim), then `visual()` |
| 1.0–1.5 | reset released (cycle 4, 10 cps) |
| 1.6–2.75 | ramp to cycle 643 (560 cps) → **test1 PASS duty=39** |
| 3.1–5.5 | test2 window 643→898 at 105 cps, on0 meter counting |
| 5.5–7.3 | **FAIL test2 on0=51 duty=55** + verdict "51 outside 53..57" + 1.8 s hold |
| 7.3–9.5 | test3 (1.24 s), test4, TESTS FAILED: 1, $finish, real 0.065 s |
| 9.5–10.7 | sleep 1.2 s, circuit frozen in RESET (all dark): **DEAD** |
| 10.7–13.7 | diff panel over the circuit, 3 s; circuit still frozen |
| 13.7–20.7 | run 2: same compile lines again, same ramp again, window 1.7 s, PASS 51 in 39..55, test3/4 |
| 20.7–24.3 | VCD line, "4/4 PASS", hold 1.8 + teaser 1.8 with the circuit in RESET (all LEDs off): **DEAD, 3.6 s** |

### A. Thought track
- 0 s: card: "Step 2 · Icarus · Does the circuit actually behave? Run it." Good stake.
- 1 s: the terminal fills in a blur. Eyes go to the big circuit, which sits idle in reset.
- 1.5–2.7 s: the circuit wakes up and the counters spin. "test1 PASS" pill. Thinks "OK, it works".
- 3.1 s: caption "test2 counts the cycles LED0 is on…". An orange dashed ring on LED0, and the meter at the right rail starts counting. Eyes ping-pong between LED0 (center-right) and the small meter (far right, about 11 px labels). Thinks "what am I supposed to watch?"
- 5.5 s: the meter turns red: "51 outside 53..57 → FAIL". A red pill on the timeline. **The key moment, but no zoom**, and the meter is 230 px wide at the edge. Thinks "fail? why? is the chip broken?"
- 5.6–7.3 s: the caption explains (98 chars in 1.8 s, barely readable). "The RTL is right; the check is wrong" sits in the 'What this means' box at the bottom-left.
- 7.3–9.5 s: the test3/test4 passes rush by. Fine.
- 9.5–10.7 s: nothing moves. The circuit is dark (reset).
- 10.7 s: a diff pops over the circuit: +4 −4, lines truncated ("$display("PAS…"). Thinks "lots of code, which part matters?" The visible delta (`dut.duty` → `d0`) isn't highlighted.
- 13.7 s: run 2 replays the same compile text and the same ramp. Thinks "I've seen this". Attention drops.
- 15.5–17.2 s: the window runs again. Bar green, 45/256 → 51. Satisfying.
- 18.5 s: "51 inside 39..55 → PASS". 4/4 checkpoints green.
- 20.7–24.3 s: "4/4 PASS on the second run…". The circuit is fully dark (rst=1, all LEDs off, t012). A downbeat ending for a success.

### B. Issues
- **P0: no camera push on the FAIL** (zero `ctx.focus` in the scene). The verdict lives in a 232 px side rail with 11 px labels. The scene's whole point is easy to miss.
- **P1: dead time.** 1.2 s after run 1, 3 s of diff over a frozen circuit, and a 3.6 s ending on an all-dark reset circuit (t009–t012: 0–1 mutations).
- **P1: run 2 repeats run 1's footage** (compile log reprinted, the same 643-cycle ramp). There's no visible delta except the verdict.
- **P1: the diff occludes the hardware and truncates the key lines.** The changed tokens aren't marked.
- **P1: tiny text in the hardware view.** hwsim is letterboxed (about 100 px of blank top and bottom inside `.hw`). Labels are 9–10 px at 1440×860, and the stage plus diagram take about 55% of the width (the terminal is 25%, the rail 232 px).
- **P2: checkpoint names truncated:** "direction flips at 2…", "reset clears led + …".
- **P2: transient overlapping lines** in the terminal during the run-2 command (t008: two lines drawn over each other). Likely `.fade-line` translateY(4px) plus smooth `scrollTo` while `command()` rewrites the line.
- **P2:** the stale "Press ▶ to start the walkthrough" caption shows on the blank stage while mount awaits data (t003 of both scenes). `core.js go()` should narrate `entry.tool` before `loadModule`.

### C. Fixes
1. FAIL push, in `scenes/02-iverilog/scene.js runSim()` inside `if (c === 899)`:
   - Before `await seg(ctx, WIN[1], pace.win)`, focus on LED0 plus duty:
     ```js
     const b = S.$('.hw').getBoundingClientRect(), r = S.root.getBoundingClientRect();
     ctx.focus({ x: b.left - r.left + b.width * .45, y: b.top - r.top + b.height * .12, w: b.width * .55, h: b.height * .3 }, { scale: 1.8 });
     ```
   - After `badge(2, ok)` when `!ok`: `ctx.focus(S.$('.judge'), { scale: 2.2 }); ctx.narrate('Caught: LED0 was on 51 of 256 ticks. The check expected 53..57.'); await ctx.sleep(2400); ctx.unfocus();`
   - In run 2: `ctx.focus(S.$('.judge'), { scale: 2.0 })` on PASS, hold 1.6 s.
2. Dead end, after `ALL TESTS PASSED` in `play()` step 5: `S.hw.seek(1800); S.hw.play(1800, 4100, 700 * ctx.speed, { signal: ctx.signal }).catch(() => {});` (not awaited), so the LEDs breathe through the hold and the teaser. Also replace `await ctx.sleep(1200)` after run 1 with `await ctx.sleep(500)`, and seek to cycle 880 (LEDs lit, the window just closed) before the diff.
3. Run 2 delta, in `play()` step 4: drop `for (const l of S.clog) await out(ctx, l, 50)` and print a single `out(ctx, 'iverilog exit 0', 0)`. Set `PACE[1] = { 4: 80, 643: 2400, win: 170, 4123: 5200, 4125: 20 }`. That saves about 2.5 s, and the eye goes straight to the window.
4. Diff, in `showDiff()`: shorten lines with `o.s.replace(/\$display\(.*/, '$display(…)')`, and wrap `dut.duty` (−) and `d0` (+) in `<mark class="dk">` (CSS: `.sa-ivl .dk { background: #fff1c2; border-radius: 3px; }`). In `scene.css:106`, move `.diff` over the terminal strip (`left: 14px; width: 24%`), or make it 46% wide on the left of the stage so LED0 and the meter stay visible. Cut the hold from 3000 to 2200 ms but `ctx.focus(S.$('.diff'), { scale: 1.5 })` during it.
5. Bigger hardware: `scene.css:52` `.stage { grid-template-columns: minmax(0,1fr) 200px; }`. Have hwsim fill the height (Session E says it fills when `el.clientHeight > 60`; check that `.hw-wrap`/`.hw` have `height: 100%`, since t005 shows letterboxing).
6. `data/02-iverilog.json` tests names: `"dir flips at 255"`, `"reset clears all"`, `"LED0 on-time ≈ duty"`, `"duty ramps up"`.
7. Readings: put a top KPI in `.rail`: `cycle 742 / 4,126 · 29.70 / 165.02 µs`. Read it from `onCycle(s)` (`s.cycle`, `s.t_ns`). Under it: `tests 1/4`, `run 1 of 2`.
8. Terminal overlap: in `command()` drop the `.fade-line` class on the command row, or use `t.scrollTop = t.scrollHeight` (no smooth) inside `line()`.

### D. Narration script (02-iverilog)
1. [0 s, compile] "Does the circuit actually behave? Let's run it."
2. [run 1 visual starts] "Icarus simulates every clock edge: 4,126 of them."
3. [test1 PASS] "Test 1: brightness ramps up. Pass."
4. [window opens, focus LED0] "Test 2: count how long LED0 is on over 256 ticks."
5. [FAIL, focus meter] "Caught: on 51 of 256 ticks. The check expected 53 to 57."
6. [diff] "The chip was right. The test read brightness too late. Fixed."
7. [run 2 PASS] "Run 2: 51 sits inside the real 39–55 window. 4/4 pass."
8. [end / cliffhanger] "It passes, but is the code itself clean? Verilator checks next."

---

## Cross-scene notes
- `core/story.js showCard()`: the hold of 1500/900 ms covers the first beat of every scene. Either shorten it to 900/600 ms, or have scenes start with `await ctx.sleep(1200)` in skim mode before their first visual (that costs only 0.3 s).
- Both scenes rely on captions over 90 chars. Cap them at 70 chars and keep each on screen for at least 2 s.

---

# G2 UX audit: 03-verilator + 04-gtkwave

Sources: scene.js/css, data/*.json, real/ logs. Frames: `scratchpad/frames3/` (valid run on :5180, 0 console errors; frames/ and frames2/ were dead or stalled for 03/04). Times below are seconds from scene start (the scene-title caption).
**03 ≈ 32 s. 04 ≈ 24 s.** Neither scene calls `ctx.focus` anywhere.

## Top 3 per scene (P0/P1, with file + fix)

### 03-verilator
1. **P0: 7 s of typing while the circuit is frozen (15.6→22.7 s).** `ctx.visual()` is still on, so three `command()` typings (verilator --cc, build_msvc.bat, ./Vpwm_led) run at 1× with the hwsim frozen at cycle 700. Timeline frames 19–31 show 2–12 DOM mutations each.
   Fix, in `scenes/03-verilator/scene.js` play() step 5: add `ctx.skim();` before `await command(ctx, m.steps[1].cmd, 3)`, and `ctx.visual();` just before `$('.kb-tag').textContent = 'C++ model'`. Also start `hw.play(0, T, 600*ctx.speed, {signal})` before the commands, so the circuit already ticks while the C++ builds. That cuts ~7 s to ~1.8 s.
2. **P0: the captions can't be read.** The beat captions in `data/03-verilator.json` `beats[].say` run 110–160 chars and each shows for only 1.1–1.5 s (16 rules × 170 ms + 750 ms per beat). The widths and kinds captions run ~150 chars and show for ~2 s. The jargon is heavy (WIDTHTRUNC, 8'd32·i, BLKSEQ).
   Fix: replace each `say` with ≤60 chars (script below), and raise the per-beat `ctx.sleep(750)` to 1100.
3. **P1: no camera move, and the circuit stays static for 13.5 s of lint (0.7→14.2 s).** The only change is small dashed rings and 9 px pills. The "0 warnings" verdict lands in the terminal and the 11 px kbar with no emphasis.
   Fix, in play() for each beat: `ctx.focus(S.$(sel), {scale:1.6})`, using the beat's hl target. Beat 1 uses `.hw svg g.hw-cmp` (comparator column), beats 2–3 use `g.hw-ff`, beat 4 uses `.hw-gate`, beats 5–6 cover the clk/rst boxes. At the verdict, `ctx.focus(S.$('.kbar'),{scale:2})`, then sleep 1200 and `ctx.unfocus()`. During countRun, `ctx.focus(S.$('.kbar'),{scale:1.5})`.
- Also P1:
  - Contradictions on screen. The hwsim shows a **RUN** pill, "cycle 700" and "Icarus VCD" while the caption says "No clock runs". In model mode it replays the 4,126-cycle Icarus trace next to a 50 M counter. Hide the hwsim RUN pill/timeline while `.sa-vl:not(.model)` in scene.css, and set the kb-note to "circuit: first 4,126 cycles · counters: real 50 M run".
  - Spoiler. The top agent bar (core/agent.js, owned by main) shows "✓ 0 warnings · exit 0" and "50M cycles · 3.97 M cycles/s · LED0 49.48%" from t=0. It should reveal on the scene's `ctx.emit('metric')`.
- P2: The final caption prints `24739808` raw; use `fmt(+real.led0.split(' ')[0])`. The terminal panel is ~80% empty for the first 10 s.

### 04-gtkwave
1. **P0: dead spells (frames 16–22 have 0 DOM mutations, one identical).** After the 8-period zoom, `await sleep(2600)` holds a static canvas with the cursor null, so the hwsim is frozen. The end is also dead: `sleep(600)` plus a cursor jump plus `sleep(1600)` plus the shell's 1.8 s gives ~4 s of nothing.
   Fix, in `scenes/04-gtkwave/scene.js` play(): replace `await sleep(2600)` with `await tween(2600,k=>{S.cursor=startP-4*P+k*8*P},sig,(t)=>t)` so the LEDs and readout tick. Replace the final `sleep(1600)` with a payoff: focus `.gw-hw` and play `S.hw.play(4083,4125,20*ctx.speed,{signal:sig})`, which shows duty hit 0xFF and dir flip to dimming. That also gives the missing "breathing reverses" payoff.
2. **P1: no camera push at either key moment.** The pulses widening and the 32-clock staircase both play at 1×.
   Fix: compute row rects in scene px with `const cr=S.cv.getBoundingClientRect(), rr=S.root.getBoundingClientRect(); const rows=(a,b)=>({x:cr.left-rr.left,y:cr.top-rr.top+S.RULER+a*S.rowH,w:cr.width,h:(b-a+1)*S.rowH});`. Row indices are clk0 rst1 duty2 dir3 pwm_cnt4, led0..7 = 5..12.
   - Widths beat: `ctx.focus(rows(4,6),{scale:1.8})` so the 68/85/102 labels can be read.
   - Phase beat: `ctx.focus(rows(5,12),{scale:1.35})` during the sweep.
   - Last 2 s: `ctx.unfocus()`, then `ctx.focus(S.q('hw').closest('.gw-hw'),{scale:1.5})`.
   Compute the rects while unfocused.
3. **P1: callout and story drift.**
   - `callout()` fires *after* each zoom, so the callout still shows the reveal text during the zoom (frame 12). Move each `callout(...)` above its `zoomTo(...)`.
   - The reveal callout promises "red x" and "dir flips… dim again", but neither is visible at full scale (reset is 0.03% of the run, and the dir flip sits at 163.98 µs at the right edge). Drop both from the callout, or add the dir-flip marker beat from fix 1.
   - The first caption is descriptive, not a hook.
- Also P1: The agent bar shows "12,899 edges" from t=0 (core/agent.js), which spoils the delta.
- P2:
  - At the 8-period zoom the duty bus renders as an "OOOO" hex chain. In `drawBus`, raise the dense threshold from `w < 5` to `w < 12`.
  - In the compact hwsim panel the content sits in ~540 px of a ~950 px panel, and `.gw-hw-note` is clipped ("feeding a…"). Mount with `fill:true` or drop the note in scene.css.
  - Callout text is 13 px.

## Narration scripts (paste into ctx.narrate)

### 03-verilator (step 3 of 10)
| beat (s) | caption |
|---|---|
| 0.3 open | `Tests passed. But is every wire in this circuit built right?` |
| 0.7 widths | `Verilator reads all 40 lines as hardware. No clock needed.` |
| 2.7 kinds | `Blue boxes remember (flip-flops). Amber boxes just compute.` |
| 4.8 beats 1–3 | `Every bus width matches: 8-bit counter, 8-bit duty, 8 LEDs` |
| 7.8 beats 4–6 | `One driver per wire, no latches, clean reset: 16 rules checked` |
| 14.2 verdict | `0 warnings, 0 errors, 12 ms. The code is clean.` |
| 15.6 model | `Same code, now compiled into a real C++ program` |
| ~17.5 run | `50,000,000 clock cycles in 12.6 s: 2 s of real LED time` |
| end | `It runs. Now let's see what every signal actually did.` |

Optional per-beat `say` values for data/03-verilator.json (≤60 chars):
1. `Widths: 8-bit + 8-bit into 8-bit. Nothing gets cut off.`
2. `Nothing unused, nothing undriven.`
3. `All flops updated in one clocked block.`
4. `Pure logic between flops. No hidden latch.`
5. `Reset only on the clock edge.`
6. `Ports and file name all line up.`

### 04-gtkwave (step 4 of 10)
| beat (s) | caption |
|---|---|
| 0.2 open | `4,126 clock cycles of data. Can you see the LEDs breathe?` |
| 1.9 stream | `165 µs of simulation: 12,899 signal changes, one picture` |
| 6.5 zoom 8 periods | `Zoom in: LED0's pulse grows 68, 85, 102… clocks wide` |
| ~9.6 sweep | `Wider pulse, brighter LED. That's the breathing.` |
| 12.8 one period | `One cycle is 256 clocks. Each LED starts 32 clocks after the last.` |
| ~16 sweep | `The circuit below follows the cursor, flop by flop` |
| end (dir flip) | `Duty hits 255, dir flips, the LEDs dim. Can a script prove it?` |

All the numbers come from data/04-gtkwave.json, the hw-trace markers (duty=255 @4083, dir flip @4099), the COORDINATION Log (12,899 transitions, rtl-lines 40), real/verilator.log (0 warnings, 12 ms) and real/verilator/04-run.log (50 M cycles, 12.590 s, 3,971,347 cycles/s, 2.000 s, led0 24,739,808 = 49.48%).

## Viewer thought track (condensed)

**03:**
- 0–1 s: sees a big purple circuit and a terminal line. Thinks "another checker?" The caption is jargon. Eyes go to the circuit.
- 1–4 s: width pills (9 px) and blue/amber outlines appear. Can't read the 150-char caption in 2 s.
- 5–12 s: green checks tick in the bottom-left grid and rings jump around the circuit. The circuit itself is frozen. Mildly bored, unsure what a "rule" means.
- 14 s: "lint clean: 0 warnings" appears in a small terminal box. Little sense of payoff, no push.
- 15–22 s: watches commands type out. Waiting. Bored (P0).
- 23–28 s: counters race to 50,000,000 and the LEDs light up. The best moment, and it lasts ~5 s.
- 28–32 s: caption with a raw number. No reason given to move on.

**04:**
- 0–2 s: GTKWave chrome and the signal list fills. Feels like a real tool.
- 2–6 s: the cursor sweeps and the traces draw. Pleasing. The hwsim under it ticks.
- 6–9 s: zoom. LED pulse numbers appear, but small.
- 9–12 s: nothing moves (dead).
- 12–15 s: zoom to one period, then the pink staircase. "Ah, staggered." The best moment, with no push.
- 15–20 s: the cursor sweeps and the LEDs in the circuit light in order. Good.
- 20–24 s: static. No payoff, no handoff.

---

# G3 UX audit: 05-cocotb + 06-yosys

**Sources**
- Code: `scenes/05-cocotb/scene.js` (361 lines) and `scenes/06-yosys/scene.js` (553 lines), with their `data/*.json` files.
- Captures: my own headless runs at 1440×860 on `localhost:5173`, in `scratchpad/framesG3/<id>/`.
  - `frames/06-yosys` was invalid: it showed the intro page because of connection-refused errors.
  - `frames2/05` and `frames2/06` had stalled at t012 and t000.
  - The captions' timestamps are real wall-clock time (hwsim.play is time-based, so the captures run in real time).

**Global finding for both scenes: zero `ctx.focus` / `ctx.unfocus` calls** (grep confirms; the `camera` field is empty in every frame). That breaks the 2–4 pushes per scene rule.

**Cross-scene (not my slice, but it affects 05):** the Agent bar (`core/agent.js`) shows `✓ 4/4 PASS · 305.76 µs sim 350 ms` from the first second of 05. That **spoils the scene's payoff** before test 1 runs. It also costs about 48px of stage. It should show `running…` until 05 emits `cocotb_passed`.

---

## 05-cocotb: "Testing the RTL from Python"

**Duration:** ≈ 48 s of play (captions run 3.43 s → 48.9 s, then a 2.4 s hold).

| Segment | Length |
|---|---|
| Intro | 0.5 s |
| Test 1 | 8.7 s |
| Test 2 | 9.5 s |
| Test 3 | 13.7 s |
| Test 4 | 13.0 s |
| Summary | 2.4 s, static (DOM mutations 0 from t48–t53) |

### A. Viewer thought track
- **0 s:** Blank stage, then the "Testing the RTL from Python" title flashes for 0.1 s. Eyes on the empty middle.
- **0.1 s:** The intro caption appears for **0.5 s** (`line 281`) and is overwritten by the test 1 caption at 0.53 s.
  - The viewer never reads "the same RTL, now tested from Python". They think: *"wait, is this GTKWave again? Why the same circuit?"*
  - Feels: disoriented.
  - The Agent bar already says 4/4 PASS.
- **1 s:** The full hwsim circuit fills ~75% of the screen. Duty is 255, dir is `down`, all 8 LEDs are 100% on. The ribbon shows `Clock(dut.clk, 40, unit="ns").start()` with a `WRITES dut.clk` pill.
  - Thinks: *"OK, Python code on the left, circuit on the right. Why is it already at full brightness?"* The trace is seeked to cycle 4105 for the reset test.
  - Eyes on the big green LEDs.
- **2–4 s:** The ribbon flips `dut.rst.value = 0` → `await ClockCycles(…3*STEP)` → `rst = 1`. Dashed rings jump between clk and rst.
  - Thinks: *"something is being poked."* The text is 11 px code and the ribbon statement 15 px. Readable, but it changes every ~0.5–1 s.
- **5–6 s:** RESET badge, then every LED goes dark, duty 0, `led = 0b00000000` local.
  - **This is the first real "aha"** (Python wrote rst, the hardware obeyed), but nothing pushes in. The LED column is small at the right edge.
- **6–8.7 s:** Three `assert` reads, each a 0.55–0.65 s dwell. The PASS badge lands in a 11 px cell of the bottom strip with "1.98 µs".
  - Feels: "fine". There's no emphasis on PASS.
- **8.7 s:** Test 2 caption. A seek to cycle 0, then a 1020-cycle ramp at 260 cps (3.9 s).
  - LEDs brighten one by one and the `samples[-4:] = [..]` locals tick.
  - Thinks: *"brightness climbs, that's the breathing."* Good motion.
  - Eyes split between the ribbon locals (top) and the LEDs (right): far apart.
- **13–18 s:** `steps == {1}`, the dir read and the log line. Small text, low motion (mutations 46–90/s at t18–21). Mild boredom.
- **18.2 s:** PASS 2. Test 3 caption: "watch one full 256-clock PWM period…".
- **19–21 s:** Runs 2046 cycles at 800 cps. LEDs ramp to mid brightness.
- **21–26 s:** The one-period replay at 56 cps. `clock n/256` tag, LEDs turn on in a staircase (LED0..7 rise 32 counts apart), `on = [...]` locals.
  - **The best visual of the scene**, but 8 LEDs × 30 px each at the far right edge, no zoom. The viewer sees "lights flicker" and misses that they are staggered.
- **26–28 s:** `assert phase == 0` dwell of 1.5 s, with `rise_cnt = [1, 225, 193, 161, 129, 97, 65, 33]`.
  - Thinks: *"numbers, decreasing… so?"* It's jargon with no visual tie-back to the LEDs.
- **31.7 s:** Test 4 caption. Seek to 4035, duty polls up to 255 (2 s), then dir flips `up → down`.
  - The flip is a 2-character change in a 15 px box. **The key moment is missed without a push.**
- **36–44 s:** Asserts `d_a`/`d_b` and `d_b < d_a → True` (falling duty). Small text again.
- **44.9 s:** PASS 4, then the summary caption "All 4 cocotb tests passed: 305.8 µs … in 0.35 s."
  - The ribbon shows "4/4 cocotb tests passed" in green 15 px, and a dashed "all checks pass" ring sits on the LEDs.
- **45–48 s:** A frozen frame (0 mutations). There's no big number, no count-up of the 4/4 hero and no hand-off line.
  - Feels: "...and?" Then the scene ends.

### B. Issues

**P0**
1. **The opening caption is visible for 0.5 s** (`play()` line 281, then the line 293 narrate fires immediately after `ctx.visual()`).
   - The viewer never learns *why* there's a second simulator after 02/04. That makes the whole scene look like a repeat of 02-iverilog.
2. **No camera at all.** The 3 money moments get no focus:
   - LEDs go dark on reset (≈ 5 s);
   - the LED phase staircase (≈ 21–26 s);
   - dir flips at 255 (≈ 34 s).

   The LED column and dir box are ≤ 8% of the stage.
3. **The payoff is spoiled and flat.** The Agent bar shows 4/4 PASS from 0 s. The final 4/4 is a 15 px ribbon line plus a small badge, followed by a 3 s static hold (t45–48, 0 mutations).

**P1**
4. **There's no "why it matters" / delta vs 02.**
   - Nothing says "same 4 checks as the Verilog testbench, now in 40 lines of Python, 305.8 µs of sim in 0.35 s".
   - `mean` text (line 168) is good but 12.5 px at the very bottom.
5. **Test 3 has jargon with no visual.**
   - `rise_cnt = [1,225,193,…]` and `phase = (rise_cnt[k] - 1 + 32*k) % 256` are shown as text.
   - There's no staircase overlay tying "LED k rises 32·k counts later" to the LEDs.
6. **Dwells on pure-Python asserts** (`steps == {1}` 650 ms, `d_b < d_a` 650 ms, log lines 300 ms + 260 ms gaps) add ≈ 4 s of low-motion time with only small text changing. Mutations fall to 46–90 at t7–10, t18–21 and t31–35.
7. **No live side readouts besides `cycle 4,123 · 164.94 µs` (top-right, 13 px).**
   - The readings rule wants stacked real numbers on the edges: tests passed n/4, sim time, Python reads/writes count, duty, dir.
   - The bottom strip has per-test sim times, but it isn't a live column.
8. **Test 1 opens in a confusing state** (duty 255, dir down, all LEDs 100%) with no caption saying "first, let it run, then hit reset". Right after 04 showed a ramp from 0, this reads as a glitch.

**P2**
9. The hwsim label says `tb_pwm_led.dut · Icarus VCD`, and the rst box says "driven by tb_pwm_led", while the scene claims Python drives it.
   - Honest, since it's a replay of the Icarus trace, but it contradicts the story.
   - Relabel it as "replay of the same DUT (Icarus trace)" or pass a label override.
10. The code panel (11 px) and log (11 px) are fine as a skim panel. But the ribbon `rb-tag` text (10.5 px muted, e.g. "25 MHz clock coroutine") is unreadable at a glance.
11. The ribbon statement often truncates with an ellipsis: `dut._log.info("reset: led=0b%s duty=%d dir=%d", …` and `dut._log.info(...)` steps. Skip log steps in the ribbon (keep them in the terminal only).
12. Scene title "Testing the RTL from Python" caption shows for 0.12 s (shell) before line 281 overwrites it.

### C. Fixes (all in `scenes/05-cocotb/scene.js` unless noted)

1. **Hold the hook; start visual earlier.** Replace lines 281–288 with:
   ```js
   ctx.visual();                                   // circuit is already drawn at mount
   ctx.narrate('Can plain Python test real hardware? cocotb says yes.');
   S.hw?.highlight({ clk: 'python drives', rst: 'python drives', leds: 'python reads' });
   ctx.focus(q('hw'), { scale: 1.15, ms: 900 });   // gentle push on the circuit
   ctx.skim();                                     // terminal text fast
   …typeInto env + command (unchanged)…
   await streamUntil((L) => L.msg === 'Running tests', 35);
   ctx.visual(); ctx.unfocus();
   ctx.narrate('Same 4 checks as the Verilog testbench, now written in Python.');
   await sleep(1600);
   ```
   The hook is then on screen ≥ 2 s and the delta line ≥ 1.6 s.
2. **Camera pushes.** Add an optional `focus` field to plan steps and handle it in the step loop (after `ribbon(main, st)`, line 308):
   ```js
   const hwRect = (fx, fy, fw, fh) => { const r = q('hw').getBoundingClientRect(), b = root.getBoundingClientRect();
     return { x: r.left - b.left + r.width * fx, y: r.top - b.top + r.height * fy, w: r.width * fw, h: r.height * fh }; };
   if (st.focus) ctx.focus(hwRect(...st.focus), { ms: 800 });
   if (st.unfocus) ctx.unfocus();
   ```
   Then in `buildPlan`:
   - **T1** `assert int(dut.led.value) == 0`: `focus: [0.62, 0.08, 0.38, 0.84]` (comparators, flops and LEDs). Unfocus on the `dut._log.info("reset` step.
   - **T3** `led, cnt = …` step: `focus: [0.55, 0.05, 0.45, 0.9]`. Keep it through `assert phase == 0`. Unfocus on the log step.
   - **T4** `await ClockCycles(dut.clk, 2 * STEP)` (dir flip): `focus: [0.28, 0.25, 0.3, 0.35]` (duty + dir boxes). Unfocus at `d_b`.

   That's 3 pushes, each ≥ 4 s apart.
3. **Per-test punchline captions.** Narrate after each PASS (line 324), using real data:
   ```js
   const PUNCH = ['Reset works: Python saw every LED go dark.',
     'Duty climbs exactly +1 every 16 clocks, 64 times in a row.',
     'Each LED lights 32 counts after the last: the phase shift is real.',
     'At 255 the direction flips and brightness starts falling.'];
   ctx.narrate(`PASS ${ti + 1}/4 · ${PUNCH[ti]}`);
   ```
   Also make the narrate at line 293 shorter (see the script in D).
4. **Test 3 staircase overlay.**
   - During the `led, cnt` step, add a small absolutely-positioned SVG strip over `.ct-hwbox`: 8 rows, a tick at each LED's first rise as `S.live(k)` passes `rise[i].k`.
   - The ticks form a visible 32-count diagonal staircase. Label it "LED k rises 32·k counts later".
   - `rise[]` is already computed in `buildPlan` (lines 68–69); expose it with `return Object.assign(plan, { rise })`.
5. **Cut dead dwell.** Set:
   - `assert steps == {1}` dwell 650 → 350;
   - `d_b < d_a` 650 → 450;
   - log steps 300 → 120, and skip the ribbon update for `log: true` steps (`if (!st.log) ribbon(main, st)`).

   Saves ≈ 2.5 s.
6. **Payoff (summary, lines 330–351).**
   - Add a centred overlay card over `.ct-hwbox`: `4/4 PASS` at 56 px weight 600, colored `--pass`, plus a count-up subline `305.76 µs of hardware · checked in 0.35 s` (both from `d.totals`).
   - Don't add a speed ratio unless its meaning is verified (the `ratio` field in `data/05-cocotb.json` is cocotb's ns-per-s figure, so it's easy to mislabel).
   - `ctx.focus(card, { scale: 1.6 })`, then sleep 1400 and `ctx.unfocus()`.
   - Make the final 2.4 s hold play the LEDs breathing: `S.hw.play(0, 1028, 260)` in the background instead of a frozen frame.
7. **Live readout column.** Add `<div class="ct-read">` stacked at the right edge inside `.ct-hwbox` (absolute, 12 px inset, 10 px gaps). Contents:
   - `tests 0→4 /4`;
   - `py writes n`, `py reads n` (increment in the step loop from `st.w.length` / `st.r.length`);
   - `sim time` (count up per PASS to `d.tests[ti].simTimeNs`, cumulative 1.98 → 43.06 → 135.40 → 305.76 µs);
   - `duty`, `dir` from `S.live`.

   Style: 600 for numbers, 500 for labels, tabular-nums.
8. **Test 1 context.** Change the T1 `narrate` to "First let it run, then hit reset: every LED must go dark." The first step's note becomes `'design running at full brightness'`.
9. **Label (P2).** `components/hwsim` is owned by Session E: ask for a `{ dutLabel }` option. Or override it after mount: `q('hw').querySelector('.hw-sub')` (if present) gets the text 'replay: same DUT, Icarus trace'.
10. **Agent bar (owner: Session H, `core/agent.js`).** Don't render the PASS chip until the scene's `wt:metric` `cocotb_passed` fires. Before that, show `running…`.

### D. Narration script (05)
| Beat | Caption (≤70 chars) |
|---|---|
| 0 s, circuit visible | `Can plain Python test real hardware? cocotb says yes.` |
| ~2 s, after `Running tests` | `Same 4 checks as the Verilog testbench, now written in Python.` |
| T1 start | `Test 1: let it run, then hit reset. Every LED must go dark.` |
| T1 PASS (LEDs dark, push-in) | `PASS 1/4: Python wrote reset, the flops obeyed.` |
| T2 ramp | `Test 2: brightness must climb by exactly 1, 64 times in a row.` |
| T3 staircase (push-in) | `Test 3: each LED lights 32 counts after the one before.` |
| T4 flip (push-in) | `Test 4: at full brightness, the direction must flip.` |
| Summary + cliffhanger | `4/4 PASS. The logic works. Now can it become real chip cells?` |

---

## 06-yosys: "Synthesis: turning Verilog into ECP5 logic cells"

**Duration:** ≈ 13 s of play (captions run 2.1 s → 12.1 s, then a 3.2 s hold, end at ≈ 15.3 s). **That's far too short for the most transformative step in the pipeline.**

**Real numbers** (`data/06-yosys.json`):

| Stage | Counts |
|---|---|
| RTL after `proc` | **44 generic cells**: 10 `$add`, 8 `$lt`, 10 `$sdff` + 2 `$sdffe`, 1 `$sub`, 1 `$eq`, …; 167 wire bits |
| ECP5 after `synth_ecp5` | **150 cells**: 48 LUT4, 41 TRELLIS_FF, 52 CCU2C, 6 PFUMX, 3 L6MUX21; 269 wire bits |

- **Per block, RTL → ECP5:**
  - PWM carrier 2 → 13 (4 CC, 1 LUT, 8 FF);
  - prescaler 2 → 25 (8 CC, 1 LUT, 16 FF);
  - breath control 17 → 53;
  - 8× phase compare 23 → 59 (32 CC, 19 LUT, 8 FF).
- **Running ECP5 total by morph:** 38 after ALUMACC (pwm+pre), 91 after DFFLEGALIZE (fsm), 150 after ABC9 (led).
- **Run:** 50 passes, 1374 log lines.

### A. Viewer thought track
- **0 s:** The title caption flashes for 0.1 s. "Yosys reads pwm_led.v and synthesises it for the Lattice ECP5" is up for **0.6 s**.
  - Left: the command types. Right: 4 dashed ghost blocks with labels (PWM carrier / Prescaler / Breath control / 8× phase compare) and dotted clk/rst rails.
  - Thinks: *"empty boxes, loading?"*
- **0.6 s:** The PROC caption (3.6 s). Blocks fill with indigo RTL chips one block per 280 ms (`add·8`, `sdff·8`, `lt·8`, `reduce_and·18`, …). Dashed wires `pwm_cnt · 8b`, `tick 16b`, `duty 8b` draw in. The stat dock counts to 44.
  - Thinks: *"OK, the code became boxes."* The chip labels (`sdffe`, `logic_not·8`, `reduce_bool·2`) are pure jargon.
  - Eyes wander across 44 small chips. There's no anchor.
- **4.2 s:** "ALUMACC and TECHMAP map the counters onto CCU2C carry chains and TRELLIS_FF registers" (2.4 s on screen, **15 words of jargon**).
  - PWM and prescaler morph into purple CC + orange FF + blue LUT squares. Pretty.
  - Badge `mapping to ECP5…`, but **the stat dock still says 44 RTL cells**.
  - Terminal scrolls pass names (2.5 … 2.24).
- **6.6 s:** "Flip-flops are legalised into TRELLIS_FF; the breathing control turns into…" is up for 1.8 s at 17 words. **Unreadable at that speed.**
  - Breath control becomes 53 colored chips. The viewer catches the colour change only.
- **8.4 s:** "ABC9 packs the remaining logic into 4-input LUTs" (1.6 s). The 8× phase compare becomes 8 lanes of 4 CC + FF and a LUT pool.
  - **The best image of the scene** (8 identical lanes = the 8 LEDs). It's on screen for 1.6 s with no push-in.
- **10 s:** "The final netlist: 150 ECP5 primitives, ready for place & route". The dock flips to ECP5 and counts 0 → 150 (1.1 s), with the 48/41/52/6/3 legend. Phase badge: green "ECP5 netlist · 150 cells".
  - Thinks: *"150, is that big? Was it 44 before?"* The 44 → 150 delta is never shown side by side.
- **11–13 s:** A static hold (DOM mutations 0 for t13–t18 of the capture). Wires keep their dash-flow. Eyes rest.
  - No cliffhanger to nextpnr.

### B. Issues

**P0**
1. **Far too fast and caption-dense.** 5 narrations in 10 s; three are only 1.6–2.4 s long with 9–17 words of jargon (ALUMACC, TECHMAP, TRELLIS_FF, legalised, ABC9).
   - The viewer reads none of them fully.
   - Cause: every non-figure `ctx.sleep` runs ×4 (skim), and the visual beats are only 1.3–2.8 s (`play()` lines 511, 527–528).
2. **No camera.** There's no push on the RTL → ECP5 morph or the 8-lane phase compare, and no push on the 150 number. Blocks are ~200×500 px. The chips are 20–30 px with 8 px labels ("CC", "FF", "MX5").
3. **The key delta is invisible.** The dock shows *either* 44 RTL *or* 150 ECP5, and switches only at the very end. During all 3 morphs the dock is stale at "44 cells · RTL netlist".
   - There's no running counter, so "code → real logic cells" never lands as a number.

**P1**
4. **There's no hook or "why".** Nothing says *the FPGA has no "+" or "<"; it only has LUTs, flip-flops and carry cells*. That's the single idea the scene must teach.
5. **The progress story is missing.** "Step 6 of 10" / "the code is now real logic cells" is absent. The final caption "ready for place & route" is a weak cliffhanger.
6. **The RTL chip labels are raw Yosys cell names** (`sdffe`, `logic_not·8`, `reduce_and·18`, `reduce_bool·2`). Fine as texture, but there's no legend for the 4 categories, even though `CAT_NAME` exists (line 12) and is unused on screen.
7. **No live side readouts** besides the bottom dock. Missing: running cell total, LUT/FF/CC counters per morph, passes 50/50, wire bits 167 → 269.
8. **Wires are dashed** (`.ys-wire` during draw, plus the dotted clk/rst rails). The depth rule asks for solid wires with flowing dash-offset. Blocks are flat cards; chips have only a left bar and no bevel.
9. **The end is a 3.2 s static hold** (line 545) with nothing moving except the wire flow.

**P2**
10. The terminal (11 px) scrolls 50 passes in ~2 s total. Fine as texture, but key-pass bolding is lost at that speed. The `pass n/50` badge is the only legible progress cue: keep it and make it larger.
11. In the first 0.6 s the right side is dashed ghost boxes ("waiting" feel). Fill the RTL immediately at `ctx.visual()`.
12. `callout()` at line 510 is truncated mid-sentence in the 1440 px dock? It isn't; it fits. But it changes 4× in 10 s. The callout (12.5 px) and the narration say the same thing twice.

### C. Fixes (all in `scenes/06-yosys/scene.js` → `play()` unless noted)

1. **Hook beat** (before the `typeInto` at line 482):
   ```js
   this.visual(ctx);
   ctx.narrate('An FPGA has no "+" or "<". So how does our code run on one?');
   ctx.focus(this.root.querySelector('.ys-sch'), { scale: 1.12, ms: 900 });
   await ctx.sleep(1800);
   ctx.unfocus(); this.skim(ctx);
   ```
2. **Slow the visual beats and split the jargon from the captions.**
   - PROC (lines 506–511): keep `ctx.sleep(280)` per block. Raise the post-wire hold `1700 → 2600`. Caption: see the script in D.
   - Morph block (lines 527–528): `for (const id of morphAt[p.name]) { this.morph(id); await ctx.sleep(900); } await ctx.sleep(1600);`
   - That brings the scene to ≈ 22–24 s, the right budget for the central transformation.
3. **Camera pushes** (3, ≥ 2 s apart):
   - **ALUMACC:** after `this.morph('pwm')`, call `ctx.focus(this.blocks.pwm.card, { scale: 2.0 })`. Hold ~1.4 s, `ctx.unfocus()`, then morph `pre`. Viewers then see `pwm_cnt + 1` become 4 CC + 8 FF + 1 LUT.
     - `this.blocks[id].card` exists (used in `morph`, line 383). If `card` is an SVG `<g>`, `getBoundingClientRect` works with `ctx.focus`.
   - **ABC9:** `ctx.focus(this.blocks.led.card, { scale: 1.6 })` during the led morph. Caption "8 LEDs → 8 identical carry-chain lanes". Hold 2 s.
   - **Final:** `ctx.focus(this.root.querySelector('.ys-stat'), { scale: 1.5 })` while 150 counts up, then `ctx.unfocus()` before the end.
4. **Visible delta / live counter.**
   - Add to the dock header (in `renderStat`, line 423) a persistent `<span class="ys-delta">RTL 44 → ECP5 <b class="ys-run">0</b></span>`. Tween `.ys-run` after each morph using the real block sums: `const ecpSum = id => Object.values(d.blocks.find(b => b.id === id).ecp5).reduce((a, b) => a + b, 0);`, giving 13 + 25 = 38 → +53 = 91 → +59 = 150.
   - Also call `this.renderStat(d.ecp5_stat, 'ecp5', …)` at the first morph instead of only at the end, so the LUT/FF/CC bars grow per block. The partial type sums are the block `ecp5` objects; compute running per-type totals.
5. **Live side readouts.** Add a stacked card column at the right edge inside `.ys-sch` (absolute, 12 px inset):
   - `passes 0→50`;
   - `cells 44 → 150`;
   - `LUT4 0→48`, `FF 0→41`, `CCU2C 0→52`;
   - `wire bits 167 → 269`.

   Update it alongside the badge in the pass loop and in `morph()`.
6. **Category legend for RTL chips.** Render `CAT_NAME` (line 12) as 4 coloured pills under the "RTL netlist · 44 cells" badge (adders 11, compares 9, registers 12, logic/mux 12, computed from `rtl_stat.types` via `RTL_CAT`). The jargon chip labels then have plain-word meaning.
7. **Depth and wires (`scene.css`).**
   - `.ys-wire`: solid `stroke-dasharray: none` after draw, with an overlay path `.flow` animated by dash-offset. Already partly there: line 405 sets `strokeDasharray = ''` only after the draw completes; make the initial draw a solid stroke-reveal.
   - Block cards: add `filter: drop-shadow(0 12px 14px rgba(16,24,40,.12))`.
   - Chips: a 1px lighter top stroke and a darker bottom stroke.
8. **Ending.** Replace `await ctx.sleep(3200)` (line 545) with:
   ```js
   ctx.unfocus();
   ctx.narrate('150 real cells. Next: where on the chip does each one go?');
   // pulse each type group once, in legend order
   for (const t of ECP_ORDER) { this.svg.querySelectorAll(`[data-t="${t}"]`).forEach(n => n.classList.add('pulse')); await ctx.sleep(450); }
   await ctx.sleep(1200);
   ```
   This needs `data-t` on chip rects in `drawBlock`, and a `.pulse` keyframe (opacity .6 → 1, 400 ms).
9. **Terminal** (P2): bump `.ys-passbadge` to 13 px / 600. Keep the pass list skimmed.

### D. Narration script (06)
| Beat | Caption (≤70 chars) |
|---|---|
| 0 s, hook (push on netlist) | `An FPGA has no "+" or "<". So how does our code run on one?` |
| PROC, RTL fills | `Step 6 of 10: Yosys reads the Verilog as 44 generic parts.` |
| ALUMACC, pwm morph (push-in) | `Each counter becomes a carry chain plus a row of flip-flops.` |
| DFFLEGALIZE, fsm morph | `The breathing logic turns into lookup tables and muxes.` |
| ABC9, led morph (push-in) | `8 LEDs, 8 identical lanes: one comparator chain each.` |
| Final count (push on dock) | `44 generic parts → 150 real cells: 48 LUTs, 41 FFs, 52 carry.` |
| Cliffhanger | `150 real cells. Next: where on the chip does each one go?` |

---

## Top 3 per scene
**05-cocotb (~48 s)**
1. The intro caption lives 0.5 s, so "why Python, why again" never lands. Meanwhile the Agent bar already shows 4/4 PASS.
2. There's no `ctx.focus`. The reset-dark, LED-staircase and dir-flip moments sit in the small right-edge LED column, unzoomed.
3. The payoff is weak: a 15 px "4/4 passed" line and then a 3 s frozen frame. There's no hero card, no punchline per PASS and no cliffhanger.

**06-yosys (~13 s)**
1. It's far too fast: 5 jargon captions in 10 s, three of them on screen only 1.6–2.4 s.
2. There's no camera on the morphs or the 8-lane compare.
3. The 44 → 150 delta is invisible. The dock is stale at "44 RTL" through every morph and flips only at the end, and there are no live counters.

---

# G4 UX audit: 07-nextpnr (2D + 3D) and 08-symbiyosys

## TOP 3 PER SCENE (P0/P1, with file + fix)
Note: `scenes.json` step 7 is now `07-nextpnr-3d`, so that's the scene audited. The 2D notes in §1A are legacy.

**07-nextpnr-3d**
1. **P0: the whole scene runs at 4× (~5 s of whip-pans).** `scenes/07-nextpnr-3d/scene.js` `play()` never calls `ctx.visual()`, and the RAF clock multiplies by `ctx.speed` (4 during skim). Fix: put `ctx.visual();` as the first line of `play()`, or decouple the clock in `build()` → `loop`: `s.clock += dt*1000*(s.ctx.skimming ? s.ctx.speed/4 : s.ctx.speed)`.
2. **P0: wrong Fmax.** The hero shows 348.8 MHz (`index.html:40`) and `scenes/11-results/scene.js:7` FALLBACK repeats it. Both come from the blinky reference run. The real pwm_led value is **214.96 MHz** (`real/nextpnr/nextpnr.log:180`), which is 8.6× the 25 MHz needed. Also fix the 11-results FALLBACK: props 2→5, luts 33→48, ffs 26→41.
3. **P1: no hook, no live counters, and the payoff sits in the 21% side column.** Fix in `play()`/`mount()`: (a) open with "Will it fit on the chip, and will it run fast enough?"; (b) add `cells placed /254`, `wirelength 8955→352` and `arcs routed /530` counters driven by `dropCells`, `streamLog` (regex `wirelen = (\d+)`) and `drawWires`; (c) add a hero overlay with "need 25 MHz" vs "214.96 MHz" bars and a large 8.6×, counting up from 25 rather than 0. Related fixes: `luts` overwrites 06's metric of 48 with 152, so rename it `luts_placed`; rename `util` to `utilization`; add `fmax_target`, `routed_arcs` and `bitstream_bytes`. Size numbers are inconsistent across scenes (Yosys 150 cells / 3D 152 LUT4 at 0.18% / 2D 202 LUTs at 0.24% and 254 cells). If the three.js CDN fails, `play()` returns silently.

**08-symbiyosys**
1. **P1: no `ctx.focus` at all (the rule asks for 2–4).** Fix in `scenes/08-symbiyosys/scene.js` `play()`: focus `.sy-foot` at bmc `k===4` and unfocus after the bmc loop; focus `.sy-hwA` at "Temporal induction successful"; focus `.sy-mx` after the rows-proved loop; focus `.sy-hwB` when led7 first lights; unfocus in the finale.
2. **P1: the opening captions can't be read, and there's no hook.** In skim, caption 1 is visible for ~0.5 s and caption 2 for ~1 s, at 100–115 chars each. The shell title caption flashes for 0.13 s. Fix: move `ctx.visual()` to the start of step 1 and open with "Tests checked 4 cases. Can we prove it for ALL of them?". Merge the two spec captions into one line of 70 chars or fewer.
3. **P1: jargon with no anchor, and a small payoff.** Terms like "BMC", "k-induction", "basecase", "∀", "induction 8→7→6" (which looks like it's going backwards) and "DIV=2" appear with no visual explanation. "Proved" only shows as green row text. Fix: replace `ctr('proved','∀','states')` with `'5/5','all inputs'` and add a big "5/5 PROVED" in `.sy-what`. Show induction as "k ≤ 6 is enough". Fix "a 8-cycle" → "an 8-cycle". Speed up the witness replay from `4.2` to `6` steps/s. End on a cliffhanger into KiCad.

Auditor: G4 (Session G), read-only. Sources: `scenes/07-nextpnr/scene.js`, `scenes/07-nextpnr-3d/scene.js` (+css), `scenes/08-symbiyosys/scene.js` (+css), `data/06-*.json`, `data/07-nextpnr*.json`, `data/08-symbiyosys.json`, `real/nextpnr/nextpnr.log`, `core/core.js`, `index.html`, `scenes/11-results/scene.js`.
Captures: the first set in `scratchpad/frames/` is INVALID (the dev server refused connections; 07 stuck on an unstyled page for 150 s). `frames2/` for 07, 07-3d and 08 had not landed when this was written (07-nextpnr had only t000, a blank stage). So the timings below come from the code (skim ×4 math), cross-checked against the 08 caption timestamps from the first capture, which were captured under load and so run slow. **Verify the beats against frames2 when they land.**

---

## 0. Cross-scene number audit (real values)

| Fact | Real source | Value | Where it's WRONG or inconsistent |
|---|---|---|---|
| Fmax (final, post-route) | `real/nextpnr/nextpnr.log:180` | **214.96 MHz** (PASS at 25) | **`index.html:40` hero `data-count="348.8"`** and **`scenes/11-results/scene.js:7` FALLBACK `fmax: 348.8`**. 348.80 is the *blinky* reference run (`docs/eda-tools/nextpnr-ecp5/real-run/nextpnr.log:89`), not pwm_led. **P0.** |
| Fmax (pre-route estimate) | `nextpnr.log:90` | 219.54 MHz | Both 07 scenes stream this line with a highlight *during placement*, so the viewer sees 219.54 and then 214.96. Filter it out of the stream or dim it. P2. |
| Headroom | 214.96 / 25 | **8.6×** | Correct in both 07 scenes. `core/story.js:45` also computes it correctly. |
| Critical path | `nextpnr.log:156` | 4.65 ns (duty FF → dir logic → duty CE) | OK (1/4.65 ns = 215.05; 214.96 is the reported number, so the rounding is fine). |
| Yosys cells | `data/06-yosys.json ecp5_stat` | **150** (48 LUT4, 52 CCU2C, 6 PFUMX, 3 L6MUX21, 41 FF) | — |
| LUT4s placed | 3D `data/07-nextpnr-3d.json lut4` | **152** (48 logic + 104 = 52 CCU2C×2 carry) of 83,640 = **0.18%** | The 2D scene says "**202 LUTs** … about **0.24%**" (TRELLIS_COMB 202 counts PFUMX/L6MUX too) and "**254 cells**" (cells array incl. FF + IO + gb). Three different "size" numbers in two scenes (150 / 152 / 202 / 254). Pick ONE story: **"150 Yosys cells → 152 LUT4 + 41 FF + 10 IO, 0.18% of 83,640 LUTs"**. P1. |
| Chip size | log | 83,640 LUT4 (LFE5U-**85F**) | The brief's "85k-LUT" is the part name, not the count. Say "84k LUTs" or "83,640". |
| Arcs routed | log:125 | 530 (Router1 0.21 s) | OK. |
| Wirelength | log:65–87 | random 8955 → HeAP ~132 → SA 481 → 390 → 352 | The 2D overlay shows the sequence 8955…352. Note that the SA "481" is *higher* than the HeAP "132" because HeAP's is the solved (pre-legal) figure, so the counter jumps UP. P2: show only 8955 → 352. |
| Bitstream | ecppack | 282,479 B (275.9 KB) | OK. |
| Formal | `data/08-symbiyosys.json` | 5 asserts proved, bmc depth 40, k-induction basecase 8, induction 8→7→6, 3/3 covers, first_led_on at step 35 (36-step witness), elapsed 2.61 s | **`11-results` FALLBACK `props: 2`** (should be 5), `luts: 33`, `ffs: 26` (should be 48 and 41). Stale. P1 (owner: 11-results). |
| Metrics keys | COORDINATION asks 07 to emit fmax, fmax_target, utilization, routed_arcs, bitstream_bytes | 3D emits `fmax`, **`luts`**, **`ffs`**, **`util`** | The 3D **overwrites 06's `luts` (48) with 152** under the same key, emits `util` instead of `utilization`, and drops fmax_target/routed_arcs/bitstream_bytes. P1. |

---

## 1. Scene 07-nextpnr: what `/?scene=07-nextpnr` actually plays

**`scenes/07-nextpnr/scene.js` is the OLD 2D floorplan**, which the user rejected (COORDINATION 07:37). It does not delegate. `scenes.json` still lists `07-nextpnr`, so the 3D scene (`07-nextpnr-3d`) plays **only** via `?scene=07-nextpnr-3d` (the preview fallback in `core.js:203`, which gives it a generic blue `#2563eb` tool color, not `#c026d3`).

### 1A. Old 2D (what plays today): thought track (estimated, ~14–18 s)
It never calls `ctx.visual()`, so every `ctx.sleep` and log stream runs at ×4. The canvas `anim()` tweens (place 2.6 s, legal 1.6 s, route 3.6 s, crit 1.4 s) are rAF and run in real time, so they set the pace.
- 0 s: sees a terminal on the left with the command typed instantly, an empty dot-grid floorplan, and 3 grey cards (Utilisation, Timing "pending", Bitstream "waiting"). Thinks "another log". Eyes on the caption: "nextpnr loads the Yosys netlist…".
- ~0.5 s: the log blasts past at ×4 and the util bars fill (202/83,640). The callout says "202 LUTs … 0.24%". This is unreadable at that speed.
- ~1–4 s: dots fly from random positions into a cluster (HeAP) while the wirelength counter jumps 8955 → 154 → … Thinks "something is moving". Feels mild interest.
- ~4–6 s: the canvas camera zooms into the left-edge corner (zoomTo, 2.4 s), and the wirelength counter goes UP to 481, then down to 352. Thinks "did it get worse?"
- ~6–10 s: blue routes grow over 3.6 s while the arcs counter climbs 0 → 530. The best beat.
- ~10–12 s: the critical path is highlighted, the gauge counts to 214.96, PASS appears, and the callout says "8.6× headroom". The payoff is buried in the bottom-right card and the callout text, with no camera push.
- ~12–14 s: the ecppack command, a byte counter to 282,479, "written", and a 0.75 s hold. The end has no cliffhanger.
- Verdict: a flat 2D view, never zoomed via `ctx.focus`, and all the text at ×4. The user already rejected it. **Do not ship it; swap to the 3D scene.**

### 1B. 07-nextpnr-3d (the replacement): thought track (from code)
**Critical bug: `play()` never calls `ctx.visual()`**, so the shell stays in skim and `ctx.speed` is 4. The 3D clock does `s.clock += dt*1000*ctx.speed`, so **every tween, flyTo, cell drop and wire grow ALSO runs at 4×**. Nominal choreography ≈ 2.6 + 5.2 + 5.2 + 2.6 + 4.2 ≈ **19.8 s → ~5 s real**, and each 3.6 s camera dolly becomes a 0.9 s whip.
At ×4 (as it ships now):
- 0–0.7 s: sees a big light-grey ECP5 package with a die, slowly orbiting. Label: "LFE5U-85F 83,640 LUTs". Caption (93 chars): "nextpnr-ecp5 loads the Yosys netlist onto a real LFE5U-85F…". The caption is gone before it can be read.
- 0.7–2 s: a 0.9 s whip-dolly into the corner, tiles rise, ~254 cells rain down in about 1 s, and the "152 LUT4s on an 83,640-LUT chip · 0.18% used" scale chip appears. **This is the best idea in the scene and it lasts about 1 s.** Feels "whoa, what just happened?"
- 2–3.4 s: a whip to the route view, with magenta wires growing in about 1.2 s. "rst" label.
- 3.4–4 s: the critical path turns dark magenta and Fmax counts 0 → 214.96 in 0.35 s. "8.6× headroom" sub-label.
- 4–5 s: the bitstream chip, then a pull back to the final view and orbit. Done. The viewer can't say what happened.
At ×1 (after the fix), the intended track (~20 s):
- 0–2.6 s: whole chip in orbit, eyes on the "LFE5U-85F" label, and the log streaming on the left (21% column). There is no question posed yet, so it reads as a pretty object with no stakes.
- 2.6–6 s: dolly in (3.6 s) and the region tints magenta: "pwm_led lives here". Thinks "it's tiny!"
- 4–8 s: cells drop with a settle-overshoot, IO first (10 green), then carry/LUT/FF. Labels pop: IO pins, Carry chains 104, Logic 48, Flip-flops 41. The scale chip reads "152 LUT4s on an 83,640-LUT chip, 0.18% used". **This is the "will it fit?" answer, but no one asked the question.**
- 7.8–13 s: dolly to the route view (5.2 s) and wires grow for 4.8 s. There's **no arcs counter**, so the left-side readings stay static (the Fmax panel shows 0.00 the whole time). This is a missing live reading.
- 13.6–16 s: push to the critical path (2.6 s, dist 20). Label "Critical path 4.65 ns → 214.96 MHz", and Fmax counts up. **The payoff is in the 21% side column, not on the hero.** There's no visual of 25 MHz vs 215 MHz.
- 16–20 s: the bitstream chip, a pull back, orbit, a 4.2 s hold, and the caption about ecppack. **There's no cliffhanger into formal.**
- WebGL on swiftshader can't be judged for smoothness. If the CDN import fails, `play()` returns instantly (`if (!S || !S.three) return;`). That leaves a blank error box, no captions, and the scene skips. P1.

### 1C. Issues for 07 (3D unless noted)
**P0**
1. **No `ctx.visual()` in `07-nextpnr-3d/scene.js` `play()`**, so the whole 3D animation runs at 4× (the RAF clock multiplies by `ctx.speed`). The scene is about 5 s of whip-pans.
2. **The 3D scene isn't wired.** `scenes.json` still points at `07-nextpnr`, the rejected 2D floorplan.
3. **The Fmax 348.8 MHz in the intro hero (`index.html:40`) and in `11-results` FALLBACK comes from the blinky run.** The real pwm_led value is 214.96 MHz. The intro promises one number and the scene shows another.

**P1**
4. No opening question. The scene starts with "loads the netlist" (jargon, no stakes).
5. Captions are 85–100 chars, over the 70-char limit, and have several ideas each ("arcs", "switch fabric", "LUT4s", "pip").
6. Live readings: the left column is static until timing. It needs live counters (cells placed x/254, wirelength 8955→352, arcs routed x/530) that tick with the animation.
7. The payoff (8.6× headroom) sits in the side card at 21% width. It's not on the hero, there's no 25-vs-215 visual, and there's no camera beat on it.
8. Size numbers are inconsistent across 06/07 (150 / 152 / 202 / 254), as covered above.
9. Metric keys: `luts` collides with 06; `util` should be `utilization`; fmax_target, routed_arcs and bitstream_bytes are missing.
10. The three.js CDN failure path is silent (play returns immediately).

**P2**
11. The pre-route "219.54 MHz" log line is highlighted during placement (confusing next to 214.96). `fmtLine` bolds every `Max frequency` line.
12. The Fmax count-up from 0.00 is meaningless motion. Count from 25 (the target) up to 214.96 and show the multiplier growing.
13. Jargon with no visual: "arcs", "pip", "switch fabric", "LUT4", "CCU2C" (in a label). Use "connections" and "wires".
14. Terminal at 11px in a 21% column. It's fine as texture, but don't rely on it for meaning.
15. The final 4.2 s hold plus orbit is OK for the 3D view but has no cliffhanger caption.
16. Camera: the four flyTo pushes (region/route/crit/final) satisfy the "2–4 pushes" rule. No `ctx.focus` is needed on the canvas (a CSS scale blurs WebGL). An optional `ctx.focus` on the Fmax card at the timing beat is acceptable.

### 1D. Fixes for 07
- **`scenes/07-nextpnr-3d/scene.js` `play()`**: the first line after the guard becomes `ctx.visual();` (the whole scene is a figure). The logs are already time-boxed by `streamLog(dur)`, so they keep pace. To keep the text fast, shorten `chunks[0]` to 1600 ms rather than skimming, because skim also speeds up `s.clock`. *Alternatively*, decouple the 3D clock from skim in `build()` → `loop`: `s.clock += dt*1000*(s.ctx.skimming ? s.ctx.speed/4 : s.ctx.speed)`.
- **`scenes.json`** (owner: main): change `"id": "07-nextpnr"` → `"07-nextpnr-3d"` and keep tool/color. Do NOT re-export from `scenes/07-nextpnr/scene.js`, because `core.js` sets `data-scene=entry.id` and loads `scenes/<entry.id>/scene.css`. A re-export would load the 2D CSS and break `ctx.focus`. Also check `core/story.js` / `agent.js` for hardcoded `'07-nextpnr'` ids.
- **`index.html:40`**: `data-count="214.96" data-dec="0"` (or "215"). **`scenes/11-results/scene.js` FALLBACK**: `fmax 214.96`, `luts 48` (06's Yosys LUT4) or rename, `ffs 41`, `props 5`, scene `'07-nextpnr-3d'`.
- **Hook**, in `play()` step 1: `ctx.narrate('Will it fit on the chip, and will it run fast enough?')`. Hold the orbit for about 2 s with the left Fmax card showing "? MHz" and "need 25 MHz".
- **Live counters**, in `mount()` `.n3d-stats`: add three rows above the bars: `cells placed <b id=n3d-placed>0</b>/254`, `wirelength <b id=n3d-wl>8955</b>`, `arcs routed <b id=n3d-arcs>0</b>/530`. In `dropCells()`'s per-cell tween, on `p>=1`, increment placed. In `drawWires` → `tween(dur, p => { S.wireP = p; $('#n3d-arcs').textContent = Math.round(p*d.arcs); })`. Drive wirelength from the log lines in `streamLog` (regex `/wirelen = (\d+)/` → update the element), so it ticks 8955 → 154 → … → 352 in sync with the log.
- **Payoff on the hero**: in step 4, add an overlay `#n3d-race` (bottom-centre of `.n3d-view`) with two horizontal bars: "needed 25 MHz" (short grey) and "achieved 214.96 MHz" (magenta, animates to 8.6× the length), plus a big "8.6× headroom". Count Fmax from 25 instead of 0: `countUp(el, d.fmax, 1400, 2, 25)` (add a `from` param).
- **Fmax log line**: in `fmtLine`, only bold `Max frequency` when the line contains `214.96`, or skip the line from `chunks[1]` (index 90).
- **Metrics**, at the step 5 emit: rename `luts` → `luts_placed` (keep 06's `luts`), `util` → `utilization`, and add `fmax_target 25`, `routed_arcs d.arcs`, `bitstream_bytes d.bitBytes`.
- **CDN failure**: in `play()`, `if (!S?.three) { ctx.narrate(\`Placed and routed: ${S.data.lut4.total} LUT4s, 0.18% of the chip; Fmax ${S.data.fmax} MHz\`); showScale(); countUp…; await ctx.sleep(4000); return; }`. Better still, dynamic-import `../07-nextpnr/scene.js` as the fallback.
- **Cliffhanger** at the end of step 5 (see the script).

### 1E. Narration script, 07 (3D), ≤70 chars each
| beat | caption | visual |
|---|---|---|
| 0 s (orbit) | `Will it fit on the chip, and will it run fast enough?` | whole package orbit, Fmax card "? MHz / need 25" |
| 2.5 s (dolly in) | `The FPGA: 83,640 LUTs. Our whole design lands in this corner.` | region tint, "pwm_led lives here" |
| 5 s (cells drop) | `150 Yosys cells → 152 LUTs + 41 flip-flops: 0.18% of the chip` | cell rain, placed counter, scale chip |
| 9 s (routing) | `Then nextpnr wires them: 530 connections through real routing` | wires grow, arcs counter 0→530 |
| 14 s (crit push) | `Slowest path: 4.65 ns. That means 214.96 MHz max.` | crit path glows, race bars |
| 16 s | `We need 25 MHz. That's 8.6× headroom.` | "8.6×" big, bars |
| 18 s (pull back) | `Fast enough. But is it right for every possible input?` | bitstream chip, 275.9 KB, orbit (cliffhanger into 08) |

---

## 2. Scene 08-symbiyosys

Layout: a 24% left column (sby/props/cover tabs, log, callout) and a hero holding the task chips + "on the circuit" + depth counter, two hwsim circuits (A symbolic "?", B the cover witness), and the property × depth matrix + cover goals underneath. Good structure; it meets the ≥75% rule.

### 2A. Thought track (code timing at ×1 visual; about 30–35 s. The first capture under load ran ~52 s, with captions at 3.5/3.6/4.2/6.7/18.4/19.5/22.6/27.8/38.1/48.8 s)
- 0 s: the shell title caption "Formal verification: the solver explores every hardware state" is **overwritten after 0.13 s** (frame-1 capture: 3.48 → 3.61).
- 0–0.5 s (skim): "SymbiYosys turns pwm_led into a formula: every register is an unknown…" (100 chars) shows for **~0.5 s**. Unreadable. The hwA circuit shows "?" on every register: a nice visual, but too fast to register.
- 0.5–1.4 s (skim): the props.vh tab, 5 assert lines highlight in sequence, and the caption has 115 chars ("Five assertions…duty never wraps, dir flips…, LEDs dark after reset"). The callout repeats it. **Text overload, ~1 s.** The typed `sby -f pwm_led.sby` is instant.
- 1.4–5 s (visual on): the bmc chip "running" and the 104-char caption "Bounded model check: the solver unrolls…". The depth counter goes 1, 2, 3, 4, and for each depth the 5 property rows flash and their hwsim registers highlight (5×170 ms). Thinks "it's checking each rule each cycle". Eyes on the counter at top right. Good.
- 5–9 s: depth 5→40 races (105–160 ms/step) and the matrix fills pink-green column by column. Feels progress. **No camera push**, and the matrix cells are small at 1440 width.
- ~9 s: "bmc PASS: no counterexample in any of the 40 unrolled cycles". The callout says the result is bounded, so a viewer asks "only 40?" That's good tension, but there's no zoom on the PASS.
- 10–12 s: "k-induction: first a 8-cycle basecase…" (grammar: "an 8-cycle"). Basecase cells fill 8 × 210 ms. Jargon: "basecase", "k-induction".
- 12–14 s: "Induction: if the rules hold for k cycles from any state…". The circuit shows "any" and "induction k = 8 → 7 → 6" (650 ms each). Counting **down** (8→7→6) reads like regress to a lay viewer.
- ~14.5 s: the "∀ states" counter and "All five assertions proved for every state…" (70 chars). The rows go green one by one (5×120 ms). **This is the key payoff, but there's no zoom, no "5/5" big number, and the "∀" glyph is jargon.** The hold is 1.3 s.
- 16–17 s: the cover tab, 3 cover goals tick "reached", and the second circuit fades in. Caption (101 chars): "Cover: we asked the solver to find a way to light an LED…".
- 17–26 s: the 36-step witness plays on circuit B (36/4.2 ≈ 8.6 s): rst held, duty climbs to 4, and led[7] turns on at step 35. The witness counter ticks. This is a concrete, satisfying beat, but 8.6 s is long, and the "DIV=2" note is jargon.
- 26–29 s: the result line "5/5 assertions proved · 40-cycle bmc · 3/3 cover goals". Caption (98 chars): "SymbiYosys: 5 of 5 properties proved, 40 bmc cycles…". A static 3 s hold with **no cliffhanger** into KiCad.

### 2B. Issues for 08
**P1**
1. **Zero `ctx.focus` calls** (the rule is 2–4). The PASS, PROVED and LED-on moments get no camera push.
2. **The opening captions are unreadable.** Caption 1 lives ~0.5 s and caption 2 ~1 s at skim, and both are 100+ chars. The shell title caption flashes for 0.13 s.
3. **No hook and no delta vs simulation.** It never says "4 tests checked 4 cases; this checks all of them". The tests→proof contrast is the whole reason the step exists.
4. Captions run 98–115 chars (limit 70), with 2–3 ideas each.
5. Jargon on screen with no visual anchor: "BMC", "bmc", "k-induction", "basecase", "induction 8→7→6", "∀", "unrolled ×k", "smtbmc + yices", "DIV=2", "witness", "symbolic variable".
6. The payoff moment (5/5 proved) is small: the matrix row text turns green. There's no big number on the hero.

**P2**
7. "a 8-cycle" → "an 8-cycle" (`play()` narrate in step 3; `K=8`).
8. The induction counter counting down 8→7→6 reads as regress. Show "k = 6 is enough" instead.
9. The cover witness replay takes ~8.6 s (`hwB.play(..., 4.2*ctx.speed)`). Speed it to about 6 steps/s (6 s), or skip the rst-held prefix.
10. The final 3 s hold has no motion and no cliffhanger.
11. Live readings: only the single depth counter. Add a side readout stack (props proved x/5, bmc depth, induction k, solver time 2.61 s real, covers x/3).
12. The mutant claim ("a broken copy (duty + 2) fails duty_step") is labelled in data as "checked by hand, scratch run". That's fine but unproven on screen; keep it in the callout only.
13. BMC 40 cycles at DIV=16 covers well under one PWM period, so viewers who know the design may ask why 40 is meaningful. Induction answers that, so say it: "40 cycles is not forever. Induction is."

### 2C. Fixes for 08 (`scenes/08-symbiyosys/scene.js`)
- **Hook + readable intro**, in `play()` step 1. Before `ctx.skim()`, call `ctx.narrate('Tests checked 4 cases. Can we prove it for ALL of them?')` and then `await ctx.sleep(600)` in skim (so ~2.4 s real… no: with skim ×4, sleep(2400) = 0.6 s). To keep a caption on screen ≥1.8 s, call `ctx.visual()` for those intro holds, or use `await new Promise(r=>setTimeout(r,1800/SPEED))`. Simplest: move `ctx.visual()` to the top of step 1 and keep step 1's sleeps short (2000 → 1800; the per-prop 300 → 250).
- **Merge** captions 1 and 2 into one (≤70 chars): `5 rules about the breathing LEDs. The solver must break one.`
- **Camera** (4 pushes):
  1. bmc at `k === 4`: `ctx.focus(root.querySelector('.sy-foot'), { ms: 900 })` (matrix + counter while the columns fill). `ctx.unfocus()` after the bmc loop, before the "bmc PASS" narrate.
  2. "Temporal induction successful": `ctx.focus(root.querySelector('.sy-hwA'), { scale: 1.4 })` with "∀" on the circuit. Unfocus after the rows-proved loop.
  3. After the rows-proved loop: `ctx.focus(root.querySelector('.sy-mx'), { scale: 1.6 })`, hold 1.3 s, then unfocus.
  4. In the cover replay, when `hl('ok')` first fires (led7 on): `ctx.focus(root.querySelector('.sy-hwB'), { scale: 1.5 })`. `ctx.unfocus()` in the finale.
  Respect the 1.5 s minimum spacing.
- **Payoff number**: in the finale (and at the proved moment), set the `.sy-ctr` to `ctr('proved', '5/5', 'all inputs')` instead of `'∀','states'`. Add a 34px "5/5 PROVED" badge to `.sy-what`.
- **Induction display**: `ctr('induction', it[1], 'k')` → show `k ≤ ${it[1]}`. On success: `what('prove', 'k = 6 cycles of history is enough to rule out every bad state')`.
- **Grammar**: `` `k-induction: first a ${K}-cycle basecase` `` → use `an` when K is 8/11/18 (or reword, see the script).
- **Witness speed**: `hwB.play(0, n-1, 6 * ctx.speed, …)`.
- **Live readings**: add a `.sy-reads` stack in the left column under the log, or as an overlay in the right edge of `.sy-hw`: `props proved n/5`, `bmc depth n/40`, `induction k`, `cover goals n/3`, `solver time 2.61 s (real)`. Update it where `ctr()` is called.
- **Cliffhanger**: the final caption (see the script). Shorten the hold to 2200 ms.

### 2D. Narration script, 08, ≤70 chars each
| beat | caption | visual |
|---|---|---|
| 0 s | `Tests checked 4 cases. Can we prove it for ALL of them?` | circuit A turns every register into "?" |
| 2 s | `5 rules: duty never wraps, dir flips only at the ends…` | props.vh lines highlight |
| 4 s (bmc) | `The solver tries every input, cycle by cycle, from reset` | depth counter 1→40, matrix fills (focus on matrix) |
| 9 s | `40 cycles, zero counterexamples. But 40 isn't forever.` | bmc PASS chip (unfocus) |
| 11 s (induction) | `Now start from ANY state: can one good cycle lead to a bad one?` | circuit A "any", k=6 (focus on circuit) |
| 14.5 s | `No. All 5 rules proved for every input, at any depth.` | rows go green, "5/5" big (focus on matrix) |
| 17 s (cover) | `And it's not vacuous: the solver found a path that lights an LED` | witness plays, led[7] on at step 35 (focus on circuit B) |
| 26 s | `Proven logic. Now it needs a real board to live on.` | result line, pull back (cliffhanger into 09 KiCad) |

(The 07 cliffhanger, "Fast enough. But is it right for every possible input?", lands on 08's hook, and 08's last line hands off to 09.)

---

## 3. Owner routing
- Session F: §1C 1, 4–7, 9–12, §1D (`scenes/07-nextpnr-3d/scene.js`).
- main: `scenes.json` swap to `07-nextpnr-3d`; `index.html:40` 348.8 → 214.96.
- 11-results owner: FALLBACK fmax/luts/ffs/props.
- Session C: §2C (`scenes/08-symbiyosys/scene.js`).

---

# G5 UX audit: 09-kicad, 10-freerouting, 11-results

Method: read source (scene.js, pcb2d/board3d imports, core/core.js, core/story.js), data/09-kicad.json and data/10-freerouting.json, and the valid parts of the old captures (10 and 11). **frames/ is invalid** (the dev server refused connections; 09 never left the intro), and **frames2/ for 09/10/11 was still empty** when this was written, so timings come from the source at 1× and 4× skim math. I ran a live check in the Browser pane: 09 3D/DRC stills, plus a forced 11-results run with all 34 real emitted metrics injected into sessionStorage `wt-metrics` (measured geometry at 1440×860). Story.js adds a centered chapter card for 0.9–1.5 s at every scene start, covering the first beat of each scene.

Real numbers used (data/): board 56×38 mm, 2 layers, 29 parts, 27 nets, 131 pads, 58 airwires, 116 traces (105 F.Cu + 11 B.Cu), 15 vias, 509.2 mm copper, 0 clearance violations, score 965.51 → 999.99, route passes 2.85/0.85/0.23/0.04 s, fanout 3.00/0.91/0.37/0.13 s, job 9.44 s, board.ses 20,126 bytes. Chip: Fmax 214.96 MHz vs 25 MHz target (8.6×), Yosys 48 LUT4 + 41 FF + 52 CCU2C = 150 cells, bitstream 282,479 B. Formal: 5 properties, BMC depth 40. Sim: run 1 test2 FAIL → run 2 4/4 PASS, 165.02 µs; cocotb 4/4.

---------------------------------------------------------------------------------------------------
## 09-kicad (≈28 s at 1×: play ≈26 s + 1.8 s shell tail)

### A. Viewer thought track (source timing; skim beats ×4)
- 0.0 s: the story card "A chip needs a body. Can we build the board?" covers the centre for 1.5 s. Behind it, schematic symbols are already counting up (parts 0→29). *Eyes on the card; misses the schematic's first draw.*
- 0–1.3 s: symbols fade in. Caption: "KiCad schematic: the ECP5 FPGA, a 25 MHz oscillator, 8 resistor + LED pairs, JTAG, USB and a 3.3 V regulator." (110 chars, longer than the beat). *Thinks "a parts list"; reads instead of watching.*
- 1.3–2.8 s: wires draw, nets 0→27. *A nice beat, but at full-frame size the small symbols are hard to tell apart; no zoom on the FPGA.*
- 2.8–3.7 s: labels appear. *Fine.*
- 3.7–4.1 s: ERC beat is skimmed: the "ERC complete 0 errors 0 warnings" toast is on screen for 0.43 s. *Flicker; can't read it. "ERC" is unexplained jargon (only the side callout explains it, and that changes too).*
- 4.1–5.0 s: the schematic dissolves into footprints and airwires appear. Caption: "Update PCB from Schematic: every symbol becomes a real footprint…". *A good morph; feels like magic.*
- 5.0–7.6 s: parts glide to their placed positions, and the board outline and Edge.Cuts draw. *The best 2D beat. Eyes travel with the parts.*
- 7.6–9.1 s: static. The ratsnest sits there and the side callout says "ratsnest: 58 point-to-point connections". *1.5 s dead. "Ratsnest" is explained only in a 13 px side panel the viewer isn't reading.*
- 9.1 s: caption: "The board goes out as Specctra DSN, Freerouting routes it (next scene), and the .ses session comes back in." *Jargon pile: DSN, .ses, session. Confused: "next scene… but it's routing now?"*
- 9.1–11.7 s: copper sweeps on (red F.Cu, blue B.Cu) and the rails count up to 116 tracks, 15 vias and 509.2 mm. *Satisfying, but it **spoils scene 10**: the viewer just saw the board get routed.*
- 11.7–12.9 s: static routed board. *Short pause, OK.*
- 12.9 s: switches to the 3D tab. Caption: "3D viewer: the same board, with the LEDs driven by a cycle-accurate model of pwm_led.v." The 3D fades in for 0.7 s, then a 4.6 s fly-in. *The "wow" moment: green PCB, ECP5 BGA, header pins. Eyes on the board.*
- 16.6 s: the HUD card (duty, led[7:0], 8-row scope) slides in at bottom-left. *Interesting, but small (204 px) and far from the LEDs it describes.*
- 16.6–20.8 s: the turntable sways and the LEDs breathe. *Pleasant, but the LEDs are tiny 0603 parts at this zoom, so the RTL-driven-LED payoff barely reads. A missing push-in.*
- 20.8 s: DRC (skimmed). The 6 checks tick in 0.56 s and the badge goes "0 errors". Caption: "Design rules check: clearance, widths, vias, edge clearance, connectivity and schematic parity." *A checklist flashed past; reads "0 errors" at best.*
- 21.4–25.6 s: a 4.2 s hold on 3D + DRC card. *Not dead (the 3D moves), but no new information and no cliffhanger. The final caption is still the DRC list.*
- 25.6–27.4 s: the shell tail, then cut to 10, which starts from an **unrouted** board again. *"Wait, didn't we already route this?"*

### B. Issues
- **P0. Narrative order:** 09 shows the routed copper (import of board.ses), the 3D routed board and DRC *before* scene 10 does the routing. Scene 10 then rewinds to 58 airwires, and its payoff is pre-spoiled.
- **P1. No ctx.focus at all** (the rule is 2–4 per scene). The FPGA in the schematic, the ratsnest, the LEDs in 3D and the DRC "0" are all unzoomed.
- **P1. Captions too long** (80–110 chars; the target is ≤70). Two are jargon-heavy (DSN, .ses).
- **P1. The ERC and DRC beats are unreadable.** Skim at ×4 makes the toast 0.43 s and the 6-row checklist 0.56 s. They read as glitches, not checks.
- **P1. The 3D LED payoff is too small.** "LEDs driven by pwm_led.v" is the emotional link back to the code, but the LEDs are a few px and the HUD scope sits in a far corner.
- **P2.** 1.5 s dead after placement (7.6–9.1 s); "ratsnest" is never visualized as a word on the board.
- **P2.** The story card covers the first 1.5 s while the schematic is already animating (parts 0→29 hidden).
- **P2.** No cliffhanger caption into 10; the last caption is a list.
- **P2.** DRC is labelled "KiCad" but is Freerouting's result.json (the footnote says so, fine). Keep the label honest in 11 too.

### C. Fixes (owner: Session D, scenes/09-kicad/scene.js `play()`)
1. **Fix the order (P0). Recommended: split the reveal.** In `play()`, end 09 after step 4 (placement + ratsnest) with the cliffhanger. Move "routed copper → 3D → DRC" to after Freerouting:
   - 09: `// ---------- 5.` onwards goes behind `if (!ROUTE_IN_09) { …emit…; return; }`. Emit `pcb_board_size`, `pcb_components` and `pcb_layers` here.
   - 10: its ending already says "board.ses goes back into KiCad". Let 11-results open with the 3D board (see 11 fix 3), which also gives the finale its hero.
   - Cheaper alternative if no restructure: keep 09 as is, but reword step 5 as an explicit flash-forward. `ctx.narrate('Spoiler: this is the routed board. Next: how a robot drew it.')`, and in 10 open with `ctx.narrate('Rewind: 58 connections, zero copper.')`.
2. **Camera (P1)**, all `await`ed between beats, ≥1.5 s apart:
   - After `sch.classList.add('show-wire')`: `ctx.focus(q('.sch-svg [data-ref="U1"]') || q('.sch-svg'), { scale: 1.8 })`. If schematic.js has no per-ref group, focus a rect from `SCH_POS.U1` mapped through `sheet.getBoundingClientRect()`. `ctx.unfocus()` before the morph.
   - Placement end (after the 2600 ms anim): `ctx.focus({ x, y, w, h })` on the board rect `pcb.rect` (scene px) at ~1.4×, so the 58 airwires fill the frame. Unfocus when routing starts.
   - 3D: after `gl.flyIn`, at +3 s, `ctx.focus(q('.kc9-3d'), { scale: 1.6 })` toward the LED row (or a `gl.focusLEDs()` camera dolly inside board3d.js, which is better because CSS-zooming a canvas blurs it), plus `q('.kc9-hud').classList.add('on')` together.
   - DRC: `ctx.focus(q('.kc9-drc-badge'), { scale: 2.2 })` when the badge turns "0 errors", then `ctx.unfocus()`.
3. **ERC/DRC readability:** don't `ctx.skim()` for these two beats. Keep `ctx.visual()` and shorten instead. ERC toast 1100 ms. DRC rows `await ctx.sleep(180)` each (≈1.1 s total), then a 1.2 s focus on "0 errors". Drop the final `ctx.sleep(4200)` to 2000.
4. **Dead gap after placement:** replace `await ctx.sleep(1500)` with an airwire pulse. Draw `pcbState.ratsA` 0.9→1.0→0.9 over 1200 ms via `anim()`. Have the live "Airwires 58" reading flash (`.kc9-read [data-r="rats"]` add the class `hot`). Caption it as "58 connections, still no copper".
5. **LED payoff:** in board3d.js, bump LED emissive intensity and add a bloom-like sprite halo (a THREE.Sprite with an additive radial texture) at each LED, scaled by brightness. Move `.kc9-hud` next to the LED row, or into the right rail top, while 3D is up.
6. Delay the schematic draw by the story-card hold: start `play()` with `await ctx.sleep(1200)` while in visual mode, or have story.js shorten the card to 900 ms here.

### D. Narration (≤70 chars each)
If split (recommended):
1. 0 s: "From a chip to a real board you can hold." (hook)
2. 1.3 s: "29 parts, 27 nets: the FPGA, its clock, 8 LEDs, USB, power."
3. 3.7 s: "Electrical check: 0 errors. The drawing is sound."
4. 4.2 s: "Every symbol becomes a footprint: real copper pads."
5. 7.6 s: "Parts placed. 58 grey lines = 58 connections, no copper yet."
6. end: "58 wires to route by hand, or 9 seconds by machine?" (cliffhanger)
If not split, insert after 5: "Spoiler: here it is, routed and in 3D." → "These LEDs breathe from pwm_led.v itself." → "Design rules: 0 errors. Now, how did a robot route it?"

---------------------------------------------------------------------------------------------------
## 10-freerouting (≈48 s at 1× by source; the old headless run measured ~68 s with first→last caption 2.0→64.9 s under swiftshader)

### A. Viewer thought track (source; skim beats ×4)
- 0.0 s: story card "58 connections to wire. By hand, or by machine?" (0.9–1.5 s). Board + 58 grey airwires + 10 reading cards already drawn. *Good hook; the board is visible immediately.*
- 0–1.5 s (skim): the `java -jar …` command types in 0.15 s and 3 log lines appear. Caption: "The KiCad board, exported as Specctra DSN: 29 parts, 27 nets and 58 unrouted connections (the grey airwires)." (113 chars). *It is replaced after ~2.4 s, so it can't be read; "Specctra DSN" is jargon.*
- 1.5–2.4 s: hold. *Eyes on the grey board.*
- 2.4–4.0 s: a cursor glides to the wand button. Caption: "Click the magic wand: start the autorouter." *Clear, playful; good.*
- 4.0 s: click, and the state badge reads "routing". Caption: "Stage 1, fanout: short escape traces and vias pull every used BGA ball out from under the FPGA." *"Fanout", "escape", "BGA ball" are jargon. Visually: tiny stubs under U1, too small at full frame to see. Unrouted 58→54.*
- 4.0–11.8 s: 4 fanout passes (2.6 + 0.9 + 0.5 + 0.5 s of drawing, plus 0.7/0.3 s gaps). Fanout chips tick 3.00 s / 0.91 s / 0.37 s / 0.13 s. *The changes are small and centred on U1. Passes 3–4 add ~nothing visible (passes 3: 4 pins, 4: 0 pins), so it reads as ~3 s of near-dead.*
- 11.8 s: caption: "Stage 2, autorouter: maze-routing every remaining connection on F.Cu (red) and B.Cu (blue)…" (124 chars). *Long.*
- 11.8–20.0 s: **the best part.** Red/blue copper sweeps across the board (8.2 s), and the cards climb: unrouted 35→4, nets 17→24/27, tracks 49→107/116, copper 224→458 mm. *Engaged, eyes on the board. The left/right cards are working. No zoom though.*
- 20.0–21.2 s: wait.
- 21.2 s: score 965.51; the 2 USB airwires turn amber. Caption: "Pass 1 routes all but 2 connections: the USB data pair is boxed in. Score 965.51." *A good tension beat, but the 2 lines at J2 (left edge) are thin, small and off-centre, so many viewers won't find them. Missing push-in.*
- 23.0–25.9 s: pass 2 rip-up "ghosts" fade in/out, still 2 unrouted. *A subtle tension beat; OK if zoomed, invisible if not.*
- 25.9 s: caption "Pass 3 rips up neighbours with higher costs and finds a path for the USB pair: 0 unrouted." USB traces draw (1.5 s), unrouted → **0** (green). *A payoff! But it lands at 28.6 s with no camera, no flash, and a tiny counter.*
- 28.6–33.0 s: score → 999.99, pass 4 verify (0.9 s), and the remaining vias pop. *A slow tail. "Score 999.99" is meaningless to a lay viewer.*
- 33.0–36.6 s: optimizer shimmer (1.7 s). Caption "The optimizer stops at once: score 999.99 is already within 1% of the 1000 maximum." *An anticlimax, explaining a non-event.*
- 36.6–39.0 s: the "completed" badge, and the cards go green: 0 / 27/27 / 116/116 / 15/15 / 509.2 mm / 9.44 s. Callout "All 58 airwires became copper in 9.44 s". *The real payoff, but it's split across 6 small cards plus a side callout. No single big "58 → 0 in 9.44 s" moment.*
- 39.0–42.2 s: the cursor clicks File ▸ Save .ses; the log shows "Saved board.ses (20,126 bytes)". Caption: "board.ses goes back into KiCad: every track and via lands on the real board." *Jargon (.ses); fine as a bridge.*
- 42.2–48.2 s: the import toast plus **4.2 s + 1.8 s of static** (the old capture showed 0 DOM mutations for the last frames). *Dead; the viewer is waiting.*

### B. Issues
- **P1. No ctx.focus** (0 calls). The key moments (fanout under U1, the 2 boxed-in USB airwires, unrouted→0, 9.44 s) are all at full frame on a busy screen.
- **P1. The payoff is diluted:** "58 → 0 in 9.44 s" never appears as one big number. The router-time card is bottom-right in 18 px type.
- **P1. ~6 s dead tail** after save (toast + `sleep(4200)` + shell 1800).
- **P1. Captions 80–124 chars, with jargon** (Specctra DSN, fanout, escape, BGA ball, maze-routing, .ses, optimizer score). The first caption is overwritten before it can be read (skim).
- **P2. Fanout passes 3–4 and the optimizer** (~3 s + ~3.6 s) show almost nothing changing. Compress them.
- **P2.** The log says "+31 / +2 / +4 extra vias" during fanout (37), while the Vias card says x/15 and hits 15/15 during pass 1. A careful viewer sees a contradiction. The vias at the end come from `popVia` for the remaining ones.
- **P2.** No "by hand" comparison. The hook asks "by hand or by machine?" but the answer only shows the machine.
- **P2.** The board itself is ~680 px of 1440 (≈47%). The 10 cards + the 340 px log column take the rest. The hardware rule says ≥75% hardware; zooms would compensate.

### C. Fixes (owner: Session D / D2, scenes/10-freerouting/scene.js `play()`)
1. **Camera (P1)**, 4 pushes:
   - Fanout start (after `this.click(ctx, E.wand)`): `ctx.focus(this.boardRect(U1), { scale: 2.2 })`, where `boardRect` maps the `U1` mm box (`{x0:23,x1:33,y0:10,y1:20}`) through the same transform the canvas draw uses (expose `st.view = {ox, oy, k}` from the draw/layout fn, then `{x: ox + x0*k, y: oy + y0*k, w: (x1-x0)*k, h: (y1-y0)*k}` in scene px). `ctx.unfocus()` before stage 2.
   - Pass 1 end (`this.score(r1.score…)`): focus on the J2 + held-airwire bbox (`st.held` endpoints) at ~2×, so the 2 amber lines are huge. Keep it through pass 3's `routeList(ctx, st.held, 1500)` so the viewer *sees* them connect, then `ctx.unfocus()`.
   - Completion: `ctx.focus(st.rd.un.card, { scale: 2.0 })` on the "Unrouted 0" card (or the new big stat below), then unfocus.
2. **One big payoff stat (P1):** at `setState('completed')`, overlay a centred banner over the board (an absolutely positioned `.fr-big` in `.fr-canvas-wrap`): `58 → 0 unrouted · 9.44 s · 15 vias · 0 violations`, 44 px/600, fading out after 2.5 s. Wire the "Unrouted" card to tick 58→54→…→2→2→0 (it already does). Add a red→green flash class on 0.
3. **Hand-vs-machine (P2, use only honest framing):** at the payoff, add a small line under the banner: `Router time 9.44 s (real) · by hand: hours of clicking (est.)`, labelled "estimate" per the readings rule. Or skip the estimate and say "58 connections, 9.44 s, 0 violations".
4. **Dead tail:** replace the final `await ctx.sleep(4200)` with 1500 and set the cliffhanger caption at the toast.
5. **Pace:** fanout `routeList` totals: pass 1 2600 → 2000; passes 3–4 `500` → 250 with `sleep(300)` → 100. Optimizer: `sleep(1100)+sleep(1000)` → 600 + 500, with caption "Already 99.99% optimal: optimizer stops." Saves ~4 s; the scene lands at ~42 s.
6. **First caption:** move `ctx.narrate` to *after* `ctx.visual()` (or keep it visual for 1.8 s before typing the command) so it is readable.
7. **Vias text:** trim the fanout log lines' "+N extra vias" via `trimLog`, or let the vias card show "fanout vias (temp) 37 → final 15" to avoid the mismatch.

### D. Narration (≤70 chars)
1. 0 s: "58 wires to route by hand, or 9 seconds by machine?" (hook)
2. 2.4 s: "One click starts Freerouting, a real autorouter."
3. 4.0 s: "First, short escape traces pull pins out from under the FPGA."
4. 11.8 s: "Then it maze-routes the rest: red on top, blue underneath."
5. 21.2 s: "Pass 1: 56 of 58 done. The USB pair is boxed in."
6. 25.9 s: "Pass 3 rips up neighbours and threads it through: 0 left."
7. 36.6 s: "58 → 0 in 9.44 s. 15 vias, 509 mm of copper, 0 violations."
8. 42 s: "The board is real. So what did we actually build?" (cliffhanger to 11)

---------------------------------------------------------------------------------------------------
## 11-results (standalone ≈2.7 s of motion, then it sits. Full-run version measured live: broken layout)

### A. Viewer thought track
**Standalone `?scene=11-results`** (no earlier metrics; the old capture t000–t003 is valid, no network errors there): play never calls `ctx.visual()`, so everything runs at ×4 skim.
- 0 s: header "pwm_led: verified, implemented, on a board". Pipeline checkmarks stagger in. Caption "Every stage passed. Here are the real numbers from the run." *Clean, Linear-like; OK.*
- 0–0.6 s: 8 tiles stagger in. The count-ups last 300 ms (1200/speed 4), so they're invisible. *Numbers just appear.*
- ~1.5 s: final caption "From a text file to blinking hardware, every step checked by a tool." The play button flips to ▶; the scene is over. *"That's it?" The finale is over before the applause.*
- After: 8 blue dots (LED canvas) that look **static** and all the same brightness (the canvas averages the on-fraction over a period, so the phase shift is invisible). A "READY TO FLASH" pill. *A quiet, flat ending. No board, no hardware image, no deltas.*
- The standalone tiles use **FALLBACK values that are NOT real**: Fmax **348.8** (real 214.96), LUT4 **33 "of 83,640"** (real 48), FF **26** (real 41), formal props **2** (real 5). The user's rule is REAL numbers only.

**Full run (live test: all 34 emitted metrics injected, 1440×860):**
- `ctx.metrics` keys ≠ FALLBACK keys, so `extra` appends 30 more tiles: **38 tiles**. `.res` is a flex column with `.res-grid{overflow:hidden}`, so the grid is squeezed to 311 px and **only the first 8 tiles are visible; 30 are clipped invisibly** (last tile bottom 1724 px vs viewport 860).
- Those 8 visible tiles are the *order* keys: Simulation tests 4/4, Lint 0 (fallback), Fmax 214.96, LUT4s 48, FFs 41, **"Formal properties 2" (fake fallback; 08 just showed 5/5)**, DRC 0 (fallback), Sim iterations 2.
- So **every board number (58→0 airwires, 15 vias, 509.2 mm, 9.44 s, 29 parts) is clipped**, along with props_proved 5, bitstream 282,479 B and cocotb 4/4. Duplicates also exist among the hidden tiles (Lint×2, Sim iterations×2, Simulated time×2, DRC×2).
- The audience at the very END sees: a headline, 8 tiles (2 wrong), 8 static blue dots, and a pill. No board, no journey.

### B. Issues
- **P0. Fake numbers** in FALLBACK (348.8 MHz, 33 LUT4, 26 FF, 2 props) vs the real 214.96 / 48 / 41 / 5. In a full run, "Formal properties 2" still shows next to the hidden real "Properties proved 5".
- **P0. The full-run layout clips 30 of 38 tiles**, including all PCB results. Key mismatch: FALLBACK uses `lint/props/drc/iterations`, scenes emit `lint-warnings/props_proved/pcb_drc_errors/sim-iterations`.
- **P0. No finale.** ~1.5 s from first to last caption. It runs entirely in skim (no `ctx.visual()`), the count-ups are invisible, there's no camera and no hero visual.
- **P1. No journey recap with deltas** (code → sim → proof → chip → board). The PIPE strip has tiny 11 px subtitles ("Python tests", "proved") with no numbers.
- **P1. No hardware on screen.** The final image of a hardware demo is a dashboard of text plus 8 dots; the 3D board from 09 is the obvious hero.
- **P2.** The LED canvas doesn't show the phase shift (time-averaged); it looks static. It's blue while the story is about green PCB / real LEDs.
- **P2.** "10 open-source tools" counts Verilog (a language). The real tool count is 9: Icarus, Verilator, GTKWave, cocotb, Yosys, nextpnr, SymbiYosys, KiCad, Freerouting (+ ecppack for the .bit).
- **P2.** Zeros (Lint 0, DRC 0, Unrouted 0) render as plain grey-black "0". They should read as wins (green "0 ✓").

### C. Fixes (owner: main session, scenes/11-results/scene.js + scene.css)
1. **Real fallbacks, matching keys (P0).** Replace `FALLBACK` with data-derived values in `mount()`: `const [y,n,s,b] = await Promise.all(['06-yosys','07-nextpnr','08-symbiyosys','10-freerouting'].map(ctx.data))`. Use `luts=y.ecp5_stat.types.LUT4 (48)`, `ffs=…TRELLIS_FF (41)`, `fmax=n.fmax.achieved (214.96)`, `fmax_target=25`, `bitstream_bytes=n.bitstream.bytes (282479)`, `props_proved=s.properties.length (5)`, `bmc_depth=s.bmc.depth (40)`, and the `pcb_*` values from `b.stats`/`b.job` (`incomplete 0, vias 15, trace_length_mm 509.2, elapsed 9.44, connections 58`). Key FALLBACK by the **emitted** keys (`lint-warnings`, `props_proved`, `pcb_drc_errors`, `sim-iterations`) so emitted values override instead of duplicating.
2. **Curate; never dump (P0).** Delete `const extra = …`. Render a fixed **5-chapter recap**, one column each, with a big number and a delta line. `ctx.metrics` only overrides values:
   | Code | Simulate | Prove | Chip | Board |
   |---|---|---|---|---|
   | **40** lines RTL | **FAIL → 4/4 PASS** (2 runs) | **5/5** properties, depth 40 | **214.96 MHz** vs 25 needed (8.6×) | **58 → 0** airwires |
   | 41-line testbench | 165.02 µs simulated · lint 0 | (SymbiYosys) | 48 LUT4 · 41 FF · 282,479 B .bit | 9.44 s · 15 vias · 509.2 mm · DRC 0 |
   CSS: `.res-grid{grid-template-columns:repeat(5,1fr)}`, `.tile .v{font-size:44px}`, delta line in `--pass` green, zero-wins get `.win` (green + ✓).
3. **Hero board (P1):** a left 55% / right 45% split. On the left, mount the 3D board: `const { createBoard3D } = await import('../09-kicad/board3d.js'); this.gl = await createBoard3D(el, await ctx.data('09-kicad'), { speed: () => ctx.speed })`, then `gl.start(); gl.flyIn(3000)`. On the right, the 5 chapter tiles stacked. (Cross-owner import: ask Session D. board3d.js is self-contained per its 09 usage. Dispose in `unmount()`.) If declined, at least swap the LED canvas to green and per-LED *instantaneous* PWM: `on = ((cnt + 32*i) & 255) < duty`, with a fast `cnt += 7`, so the stagger is visible.
4. **Pacing and camera (P0/P1):** call `ctx.visual()` first thing in `play()`. Sequence the 5 chapters ~2 s each: `ctx.focus(tile_i, {scale:1.6})` → count-up 900 ms → `ctx.unfocus()` (a zoom every ≥1.5 s; 3–4 pushes total: Sim FAIL→PASS, Fmax 8.6×, Board 58→0, then the final pull-back). Count-ups use `ctx.speed` *after* visual (normal speed). End with `await ctx.sleep(6000)` on the full view with the 3D board breathing and "READY TO FLASH" pulsing once.
5. Copy fix: `<p>` → "One Verilog file went through 9 open-source tools and came out as a bitstream and a routed PCB."

### D. Narration (≤70 chars)
1. 0 s: "From 40 lines of Verilog to a board you can hold." (hook/recap)
2. 2 s: "Simulation caught a bug. Fixed: 4/4 tests pass."
3. 4 s: "5 properties proved for every input, not just tests."
4. 6 s: "On the FPGA: 48 LUTs, 214.96 MHz, 8.6× faster than needed."
5. 8 s: "On the board: 58 connections routed in 9.44 s, 0 DRC errors."
6. 10 s: "Nine open-source tools, real outputs, every step checked."
7. 13 s: "pwm_led.bit is ready to flash. The LEDs are breathing." (closing)

---------------------------------------------------------------------------------------------------
## Cross-scene notes
- 09 → 10 continuity is the biggest story bug (the routed board appears before routing). Fix it in 09 (split) and give 11 the 3D hero.
- None of the three scenes calls `ctx.focus` (0 total vs a required 6–12).
- The story.js teasers/cards already carry good hooks (09 "A chip needs a body…", 10 "58 connections… By hand, or by machine?"). Scene captions should not repeat them verbatim at t=0 (it's covered by the card anyway); start captions at ~1.2 s.

---
