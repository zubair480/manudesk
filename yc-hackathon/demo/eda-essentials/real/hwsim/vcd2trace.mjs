// vcd2trace.mjs: one-off parser, real/pwm_led.vcd (Icarus) -> data/hw-trace.json
// Usage (from demo/eda-walkthrough): node real/hwsim/vcd2trace.mjs
//
// One sample per rising clk edge k. Register values are the values AFTER the edge
// (nonblocking updates land in the same VCD timestamp). `rst` is the value the DUT
// SAW at that edge (the value just before the edge), so sample k reads as
// "at edge k the flops saw rst=r and became {pre, pwm_cnt, duty, dir, led}".
// The run is only 4,126 edges (165 us at 25 MHz, DIV=4), so every cycle is kept
// (columnar arrays); `windows` marks the high-detail regions scenes should zoom on.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'real/pwm_led.vcd';
const OUT = 'data/hw-trace.json';
const text = readFileSync(SRC, 'utf8');

// ---- header: map id codes -> names under tb_pwm_led / tb_pwm_led.dut
const ids = {};
const scope = [];
for (const m of text.matchAll(/\$scope\s+\w+\s+(\S+)\s+\$end|\$upscope\s+\$end|\$var\s+\w+\s+\d+\s+(\S+)\s+(\S+)(?:\s+\[[^\]]+\])?\s+\$end/g)) {
  if (m[1]) scope.push(m[1]);
  else if (m[0].startsWith('$upscope')) scope.pop();
  else (ids[m[2]] ||= []).push(scope.join('.') + '.' + m[3]);
}
const idOf = full => Object.keys(ids).find(k => ids[k].includes(full));
const ID = {
  clk: idOf('tb_pwm_led.dut.clk'), rst: idOf('tb_pwm_led.dut.rst'),
  pre: idOf('tb_pwm_led.dut.pre'), pwm_cnt: idOf('tb_pwm_led.dut.pwm_cnt'),
  duty: idOf('tb_pwm_led.dut.duty'), dir: idOf('tb_pwm_led.dut.dir'),
  led: idOf('tb_pwm_led.dut.led'), on0: idOf('tb_pwm_led.on0'),
  t: idOf('tb_pwm_led.t'), d0: idOf('tb_pwm_led.d0'), div: idOf('tb_pwm_led.dut.DIV'),
};
for (const [k, v] of Object.entries(ID)) if (!v) throw new Error('missing var ' + k);
const byId = {}; for (const [k, v] of Object.entries(ID)) byId[v] = k;

// ---- body
const body = text.slice(text.indexOf('$enddefinitions'));
const cur = { clk: 0, rst: 1, pre: 0, pwm_cnt: 0, duty: 0, dir: 1, led: 0, on0: null, t: null, d0: null, div: 4 };
const toNum = s => (/[xz]/i.test(s) ? null : parseInt(s, 2));
const S = { t_ns: [], rst: [], pre: [], pwm_cnt: [], duty: [], dir: [], led: [], on0: [] };

let time = 0, clkBefore = 0, rstBefore = 1;
const flush = () => {
  if (clkBefore === 0 && cur.clk === 1) {
    S.t_ns.push(time / 1000);
    S.rst.push(rstBefore);
    for (const k of ['pre', 'pwm_cnt', 'duty', 'dir', 'led']) S[k].push(cur[k] ?? 0);
    S.on0.push(cur.on0);
  }
  clkBefore = cur.clk; rstBefore = cur.rst;
};
for (const line of body.split(/\r?\n/)) {
  const l = line.trim();
  if (!l || l.startsWith('$')) continue;
  if (l[0] === '#') { flush(); time = Number(l.slice(1)); continue; }
  let val, id;
  if (l[0] === 'b') { const sp = l.indexOf(' '); val = toNum(l.slice(1, sp)); id = l.slice(sp + 1); }
  else { val = toNum(l[0]); id = l.slice(1); }
  const name = byId[id];
  if (name) cur[name] = val;
}
flush();

const n = S.t_ns.length;
const first = (pred, from = 0) => { for (let i = from; i < n; i++) if (pred(i)) return i; return -1; };

// ---- landmarks, read from the trace itself (tb_pwm_led.v sequence)
// The tb resumes on @(posedge clk) BEFORE the NBA updates, so a check made at edge E
// reads the post-edge values of sample E-1.
const rel = first(i => S.rst[i] === 0);                         // first edge with rst low
const test1 = rel - 1 + 640;                                    // edge where test1 is checked
const t2s = test1, t2e = test1 + 255;                           // samples counted by the 256-edge LED0 loop
const duty255 = first(i => S.duty[i] === 255);
const flip = first(i => S.dir[i] === 0, duty255);
const test3 = duty255 + 40;
const rst2 = first(i => S.rst[i] === 1, rel);
let on0 = 0; for (let i = t2s; i <= t2e; i++) on0 += S.led[i] & 1;

const markers = [
  { cycle: 0, kind: 'reset', label: 'rst=1 (testbench holds reset)' },
  { cycle: rel, kind: 'event', label: 'reset released [140000]' },
  { cycle: test1, kind: 'pass', label: `PASS test1 duty ramping up: duty=${S.duty[test1 - 1]}` },
  { cycle: t2e + 1, kind: 'pass', label: `PASS test2 led0 on-time ${on0}/256 within duty window ${S.duty[t2s - 1]}..${S.duty[t2e]}`,
    run1: `FAIL test2 on0=${on0} duty=${S.duty[t2e]}` },
  { cycle: duty255, kind: 'event', label: 'duty reaches 255' },
  { cycle: flip, kind: 'event', label: 'dir flips 1 -> 0' },
  { cycle: test3, kind: 'pass', label: 'PASS test3 direction reversed at duty=255' },
  { cycle: n - 1, kind: 'pass', label: 'PASS test4 reset clears led and duty' },
];

const out = {
  source: 'real/pwm_led.vcd', simulator: 'Icarus Verilog (vvp)', top: 'tb_pwm_led', dut: 'tb_pwm_led.dut',
  rtl: 'real/rtl/pwm_led.v', params: { DIV: cur.div ?? 4 }, clk_period_ns: 40, clk_mhz: 25,
  simulated: false, n,
  note: 'One sample per rising clk edge. Registers are post-edge values; rst is the value the DUT saw at that edge. Columnar arrays; led is a byte (bit i = led[i]). on0 is the testbench LED0 on-time counter (null outside test2).',
  cols: S,
  windows: {
    reset:  [0, rel + 40],
    ramp:   [rel, rel + 16 * 24],
    test2:  [t2s, t2e],
    pwm3:   [t2s, t2s + 3 * 256 - 1],
    flip:   [duty255 - 48, Math.min(n - 1, flip + 48)],
    end:    [rst2 - 24, n - 1],
  },
  markers,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`edges=${n} release=${rel} test1=${test1} test2=${t2s}..${t2e} on0=${on0} duty255=${duty255} flip=${flip} rst2=${rst2} bytes=${JSON.stringify(out).length}`);
