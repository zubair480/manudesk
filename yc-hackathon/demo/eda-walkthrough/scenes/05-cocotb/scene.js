// 05-cocotb (rev2): real cocotb 2.1.0 run of real/cocotb/test_pwm_led.py on Icarus (data/05-cocotb.json),
// with every key await / assignment mirrored on the live circuit (components/hwsim, real Icarus trace of pwm_led).
let S = null;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const KW = new Set('import from as def async await return for in while if else elif not and or is assert with class try except finally raise lambda yield pass break continue global'.split(' '));
const BI = new Set('int str range set zip sorted len print float list dict tuple min max abs True False None'.split(' '));
const abortErr = () => new DOMException('aborted', 'AbortError');

// tiny GitHub-light Python highlighter; tracks triple-quoted strings across lines
function highlight(lines) {
  let inDoc = false;
  return lines.map((line) => {
    let out = '', i = 0;
    while (i < line.length) {
      if (inDoc) {
        const j = line.indexOf('"""', i);
        const end = j < 0 ? line.length : j + 3;
        out += `<span class="tk-str">${esc(line.slice(i, end))}</span>`; i = end; if (j >= 0) inDoc = false; continue;
      }
      const rest = line.slice(i); let m;
      if (rest.startsWith('"""')) { const j = line.indexOf('"""', i + 3); const end = j < 0 ? line.length : j + 3; out += `<span class="tk-str">${esc(line.slice(i, end))}</span>`; if (j < 0) inDoc = true; i = end; continue; }
      if ((m = rest.match(/^#.*/))) { out += `<span class="tk-com">${esc(m[0])}</span>`; i += m[0].length; continue; }
      if ((m = rest.match(/^f?(["'])(?:\\.|(?!\1).)*\1/))) { out += `<span class="tk-str">${esc(m[0])}</span>`; i += m[0].length; continue; }
      if ((m = rest.match(/^@[\w.]+/))) { out += `<span class="tk-dec">${esc(m[0])}</span>`; i += m[0].length; continue; }
      if ((m = rest.match(/^\d[\d_]*(\.\d+)?/))) { out += `<span class="tk-num">${m[0]}</span>`; i += m[0].length; continue; }
      if ((m = rest.match(/^[A-Za-z_]\w*/))) {
        const w = m[0]; const prev = /def\s*$/.test(line.slice(0, i));
        out += KW.has(w) ? `<span class="tk-kw">${w}</span>` : BI.has(w) ? `<span class="tk-bi">${w}</span>` : prev ? `<span class="tk-fn">${w}</span>` : (line[i + w.length] === '(' ? `<span class="tk-call">${w}</span>` : w);
        i += w.length; continue;
      }
      out += esc(line[i]); i++;
    }
    return out || ' ';
  });
}

// split one real cocotb log line into columns
function parseLog(raw) {
  const m = raw.match(/^\s*(-\.--ns|[\d.]+ns)\s+(\w+)\s+(\S+)\s+(.*)$/);
  if (m) return { kind: 'log', time: m[1], level: m[2], logger: m[3], msg: m[4].replace(/^\.\.\S+\s+in \S+\s+/, '') };
  const t = raw.trim();
  if (t.startsWith('**')) return { kind: 'table', msg: t };
  return { kind: 'cont', msg: t };
}

const fmtNs = (ns) => (ns >= 1000 ? `${(ns / 1000).toFixed(2)} µs` : `${ns.toFixed(0)} ns`);
const shortT = (t) => (t === '-.--ns' ? '–' : t.replace(/\.00ns$/, 'ns'));

function countUp(el, to, fmt, ms) {
  const ctx = S?.ctx; if (!el || !ctx) return;
  const t0 = performance.now(); const dur = ms / Math.max(0.25, ctx.speed);
  const step = (now) => {
    if (!S || ctx.signal.aborted) return;
    const k = Math.min(1, (now - t0) / dur); const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- the walk-through: each test's key awaits / assignments, what Python writes and reads, and the trace window it maps to.
// Trace windows were checked against data/hw-trace.json cols (rst=1 at 0..3 and 4124..4125, duty=255 @4083, dir flip @4099).
const arr = (a) => `[${a.join(', ')}]`;
function buildPlan(T) {
  const duty = (k) => T?.cols.duty[k] ?? 0;
  const c = T?.cols;
  // test_led_phase_shift replay: on-time and first rise of each LED over 256 clocks after cycle 2052
  const P0 = 2052, rise = new Array(8).fill(null);
  if (c) for (let k = P0 + 1; k <= P0 + 256; k++) for (let i = 0; i < 8; i++) if (rise[i] == null && ((c.led[k] >> i) & 1) && !((c.led[k - 1] >> i) & 1)) rise[i] = { k, cnt: c.pwm_cnt[k] };
  const onCount = (k) => (T ? T.ps.map((p) => p[Math.min(k, P0 + 256) + 1] - p[P0 + 1]) : []);
  return [
    { name: 'test_reset_clears', narrate: 'Test 1: let it run, then hit reset. Every LED must go dark.',
      tip: 'Python <b>writes</b> <code>rst</code> and drives <code>clk</code>, then <b>reads</b> <code>led</code>, <code>duty</code> and <code>dir</code> back out of the simulated flops.',
      steps: [
        { src: 'Clock(dut.clk, 40', w: ['clk'], hl: { clk: 'py drives' }, seek: 4105, play: [4105, 4108, 6], note: '25 MHz clock coroutine' },
        { src: 'dut.rst.value = 0', w: ['rst'], hl: { rst: 'py writes 0' }, dwell: 450 },
        { src: 'await ClockCycles(dut.clk, 3 * STEP)', w: ['clk'], hl: { clk: 'await 48 clks' }, play: [4108, 4123, 14], note: 'let it run first' },
        { src: 'dut.rst.value = 1', w: ['rst'], hl: { rst: 'py writes 1' }, dwell: 500 },
        { src: 'await ClockCycles(dut.clk, 2)', w: ['clk'], hl: { clk: 'await 2 clks', rst: 'rst = 1' }, play: [4123, 4125, 1.6], note: 'reset hits every flop' },
        { src: 'assert int(dut.led.value) == 0', r: ['led'], hl: { leds: 'py reads' }, loc: () => 'led = 0b00000000', dwell: 250, cam: 'leds' },
        { src: 'assert int(dut.duty.value) == 0', r: ['duty'], hl: { duty: 'py reads' }, loc: () => 'duty = 0', dwell: 550 },
        { src: 'assert int(dut.dir.value) == 1', r: ['dir'], hl: { dir: 'py reads' }, loc: () => 'dir = 1', dwell: 550 },
        { src: 'dut._log.info("reset', log: true, hl: {}, dwell: 300 },
      ] },
    { name: 'test_duty_ramp', narrate: 'Test 2: brightness must climb by exactly 1, 64 times in a row.',
      tip: 'Every <code>await ClockCycles</code> hands control to Icarus for 16 clocks; <code>int(dut.duty.value)</code> then <b>reads</b> the live register. 64 samples, all steps +1.',
      steps: [
        { src: 'await start(dut)', w: ['clk', 'rst'], hl: { clk: 'py drives', rst: 'py writes 1→0' }, seek: 0, play: [0, 8, 5], note: 'clock on, reset 4 clocks' },
        { src: 'samples.append(int(dut.duty.value))', also: ['for _ in range(64)', 'await ClockCycles(dut.clk, STEP)'], r: ['duty'], w: ['clk'], hl: { clk: 'await 16 clks', duty: 'py reads' }, play: [8, 1028, 260],
          tag: (k) => `iter ${Math.min(64, Math.max(1, Math.ceil((k - 4) / 16)))}/64`,
          live: (k) => { const n = Math.min(64, Math.max(1, Math.floor((k - 4) / 16))); const s = []; for (let i = Math.max(1, n - 3); i <= n; i++) s.push(duty(4 + 16 * i)); return `samples[-${s.length}:] = ${arr(s)}`; } },
        { src: 'assert steps == {1}', loc: () => 'steps = {1}', hl: {}, dwell: 650, note: 'pure Python, no DUT access' },
        { src: 'assert int(dut.dir.value) == 1', r: ['dir'], hl: { dir: 'py reads' }, loc: () => 'dir = 1', dwell: 550 },
        { src: 'dut._log.info("duty ramp', log: true, hl: {}, dwell: 300 },
      ] },
    { name: 'test_led_phase_shift', narrate: 'Test 3: each LED lights 32 counts after the one before.',
      tip: 'Python <b>reads</b> <code>led</code> and <code>pwm_cnt</code> on every clock edge. LED k must rise exactly <b>32·k</b> counts after LED 0: the comparators\' phase offset.',
      steps: [
        { src: 'await start(dut)', w: ['clk', 'rst'], hl: { clk: 'py drives', rst: 'py writes 1→0' }, seek: 0, play: [0, 6, 6] },
        { src: 'await ClockCycles(dut.clk, 128 * STEP)', w: ['clk'], hl: { clk: 'await 2048 clks' }, play: [6, 2052, 800], note: 'ramp to mid brightness' },
        { src: 'duty0 = int(dut.duty.value)', r: ['duty'], hl: { duty: 'py reads' }, loc: () => `duty0 = ${duty(2052)}`, dwell: 600 },
        { src: 'led, cnt = int(dut.led.value)', also: ['for _ in range(PERIOD)', 'await RisingEdge(dut.clk)', 'await FallingEdge(dut.clk)'], r: ['led', 'pwm_cnt'], w: ['clk'], hl: { clk: 'RisingEdge', pwm_cnt: 'py reads', leds: 'py reads' }, play: [2052, 2308, 56],
          tag: (k) => `clock ${Math.min(256, Math.max(0, k - P0))}/256`,
          live: (k) => `on = ${arr(onCount(k))}` },
        { src: 'assert phase == 0', also: ['phase = (rise_cnt[k] - 1 + 32 * k) % 256'], hl: { cmps: '32·k offset', leds: 'rise_cnt' }, dwell: 300, cam: 'stair',
          loc: () => `rise_cnt = ${arr(rise.map((r) => (r ? r.cnt : '–')))}`, note: 'LED k rises 32·k counts early' },
        { src: 'dut._log.info("rise at', log: true, hl: {}, dwell: 300 },
      ] },
    { name: 'test_direction_reverses', narrate: 'Test 4: at full brightness, the direction must flip.',
      tip: 'Python polls <code>duty</code> until it hits 255, then <b>reads</b> <code>dir</code>: the up/down FSM flipped to 0 and the next <code>duty</code> read is lower.',
      steps: [
        { src: 'await start(dut)', w: ['clk', 'rst'], hl: { clk: 'py drives', rst: 'py writes 1→0' }, seek: 0, play: [0, 6, 8] },
        { src: 'while int(dut.duty.value) != 255:', also: ['await ClockCycles(dut.clk, STEP)'], r: ['duty'], w: ['clk'], hl: { duty: 'py reads', clk: 'await 16 clks' }, seek: 4035, play: [4035, 4083, 24],
          live: (k) => `duty = ${duty(k)}`, note: 'polling' },
        { src: 'await ClockCycles(dut.clk, 2 * STEP)', w: ['clk'], hl: { clk: 'await 32 clks', dir: 'watch' }, play: [4083, 4100, 11], note: 'dir flips at the top' },
        { src: 'assert int(dut.dir.value) == 0', r: ['dir'], hl: { dir: 'py reads' }, loc: () => 'dir = 0', dwell: 250, cam: 'dir' },
        { src: 'd_a = int(dut.duty.value)', r: ['duty'], hl: { duty: 'py reads' }, loc: () => `d_a = ${duty(4100)}`, dwell: 550 },
        { src: 'await ClockCycles(dut.clk, 8 * STEP)', w: ['clk'], hl: { clk: 'await 128 clks' }, play: [4100, 4123, 11] },
        { src: 'd_b = int(dut.duty.value)', r: ['duty'], hl: { duty: 'py reads' }, loc: () => `d_b = ${duty(4123)}`, dwell: 550 },
        { src: 'assert d_b < d_a', loc: () => `${duty(4123)} < ${duty(4100)}  → True`, hl: {}, dwell: 650 },
        { src: 'dut._log.info("peak', log: true, hl: {}, dwell: 300 },
      ] },
  ];
}

export default {
  id: '05-cocotb',
  tool: 'cocotb',
  title: 'Testing the RTL from Python',
  css: true,

  async mount(root, ctx) {
    const [d, src] = await Promise.all([ctx.data('05-cocotb'), ctx.text('real/cocotb/test_pwm_led.py')]);
    const lines = src.replace(/\r/g, '').replace(/\n$/, '').split('\n');
    const hl = highlight(lines);
    const short = (n) => n.replace(/^test_/, '');
    root.innerHTML = `
    <div class="ct">
      <div class="ct-side">
        <div class="panel window ct-ed">
          <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>test_pwm_led.py</b></div><span class="ct-tb mono">py</span></div>
          <div class="ct-code mono" data-k="code">${hl.map((h, i) => `<div class="cl" data-n="${i + 1}"><span class="ln">${i + 1}</span><span class="cx">${h}</span></div>`).join('')}</div>
        </div>
        <div class="panel window ct-term">
          <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>cocotb ${esc(d.cocotb)}</b> · Icarus</div><span class="ct-tb mono" data-k="state">idle</span></div>
          <div class="ct-out mono" data-k="out"></div>
        </div>
      </div>
      <div class="panel window ct-main">
        <div class="titlebar ct-main-tb"><div class="dots"><i></i><i></i><i></i></div>
          <div class="title"><b>pwm_led</b> driven from Python <span class="ct-sub">· circuit: real Icarus trace of pwm_led (DIV=${d.parameters?.DIV ?? 4})</span></div>
          <span class="ct-pill mono" data-k="pill">idle</span></div>
        <div class="ct-rib" data-k="rib">
          <div class="rb-l"><span class="rb-ln mono" data-k="rln">py</span><span class="rb-tag mono" data-k="rtag"></span></div>
          <div class="rb-stmt mono" data-k="stmt"><span class="rb-ph">cocotb is starting the simulator…</span></div>
          <div class="rb-chips" data-k="chips"></div>
          <div class="rb-loc mono" data-k="loc"></div>
        </div>
        <div class="ct-hwbox"><div class="ct-hwmount" data-k="hw"></div><div class="ct-final" data-k="final"></div></div>
        <div class="ct-strip" data-k="strip">
          ${d.tests.map((t, i) => `<div class="cell" data-i="${i}" style="--i:${i}">
            <div class="c-h"><span class="c-n mono">${i + 1}</span><span class="c-name mono">${esc(short(t.name))}</span></div>
            <div class="c-b"><span class="st mono">queued</span><span class="c-sim mono" data-k="sim${i}"></span></div></div>`).join('')}
          <div class="cell tot" style="--i:4">
            <div class="c-h"><span class="c-name">Total</span></div>
            <div class="c-b"><span class="st mono" data-k="totst">${d.tests.length} tests</span><span class="c-sim mono" data-k="totsim"></span></div></div>
        </div>
        <div class="ct-mean"><span class="m-k">What this means</span><span class="m-v" data-k="mean">cocotb runs the real Verilog in Icarus and lets plain Python coroutines poke and probe it: every <code>await</code> hands time to the simulator.</span></div>
      </div>
    </div>`;
    const q = (k) => root.querySelector(`[data-k="${k}"]`);
    S = { root, ctx, d, q, lines, hw: null, T: null, live: null, unsub: null };
    [...root.querySelectorAll('.cl')].forEach((el, i) => { el.style.animationDelay = `${Math.min(i, 46) * 12}ms`; el.classList.add('in'); });

    // live circuit (Session E): full block diagram of pwm_led driven by the real Icarus trace
    try {
      const href = 'components/hwsim/hwsim.css';
      if (!document.querySelector(`link[href="${href}"]`)) {
        const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
        document.head.appendChild(l);
        await new Promise((r) => { l.onload = l.onerror = r; setTimeout(r, 1500); });
      }
      const [{ mountHwSim }, trace] = await Promise.all([import('../../components/hwsim/hwsim.js'), ctx.data('hw-trace')]);
      if (!S || S.root !== root) return;
      const color = getComputedStyle(root).getPropertyValue('--tool').trim() || '#0891b2';
      const hw = mountHwSim(q('hw'), { trace, mode: 'full', color, startCycle: 4105 });
      S.hw = hw;
      await hw.ready;
      if (!S || S.hw !== hw) return;
      if (!hw.trace) throw new Error('hwsim trace not loaded');
      S.T = hw.trace;
      S.unsub = hw.on('cycle', (s) => { if (S?.live) S.live(s.cycle); });
    } catch (e) {
      console.warn('[05-cocotb] live circuit unavailable:', e?.message || e);
      if (S && S.root === root) {
        try { S.hw?.destroy(); } catch {}
        S.hw = null;
        q('hw').innerHTML = '<div class="ct-ph"><b>Live circuit view unavailable</b><span>The Python tests still run below; the circuit replay needs components/hwsim.</span></div>';
      }
    }
  },

  async play(ctx) {
    if (!S) return;
    const { q, d, root, lines } = S;
    const sleep = ctx.sleep; const out = q('out'); const code = q('code');
    const codeLines = [...code.children];
    const cells = [...root.querySelectorAll('.ct-strip .cell[data-i]')];
    const alive = () => { if (!S || ctx.signal.aborted) throw abortErr(); };

    // ---- terminal
    const tline = (html, cls = '') => { const el = document.createElement('div'); el.className = 'tl ' + cls; el.innerHTML = html; out.appendChild(el); out.scrollTo({ top: out.scrollHeight, behavior: 'smooth' }); return el; };
    const logLine = (L) => {
      const run = L.msg.match(/^running test_pwm_led\.(\w+) \((\d+)\/(\d+)\)/);
      const pass = L.msg.match(/^test_pwm_led\.(\w+) (passed|failed)/);
      const user = L.logger === 'cocotb.pwm_led';
      const sys = L.logger === 'gpi' || L.logger === 'pygpi';
      const cls = run ? 'run' : pass ? (pass[2] === 'passed' ? 'pass' : 'fail') : user ? 'user' : sys ? 'sys' : 'info';
      let msg = esc(L.msg);
      if (run) msg = `running <b>${esc(run[1])}</b> <span class="dim">(${run[2]}/${run[3]})</span>`;
      if (pass) msg = `<span class="tag ${pass[2] === 'passed' ? 'PASS' : 'FAIL'}">${pass[2] === 'passed' ? 'PASS' : 'FAIL'}</span>${esc(pass[1])}`;
      return tline(`<span class="t">${shortT(L.time)}</span><span class="m">${msg}</span>`, cls);
    };
    const logs = d.log.map(parseLog);
    let li = 0;
    // stream log lines up to (and including) the first one matching pred
    const streamUntil = async (pred, gap = 70) => {
      while (li < logs.length) {
        const L = logs[li++];
        if (L.kind === 'cont') { if (L.msg) tline(`<span class="t"></span><span class="m doc">${esc(L.msg)}</span>`, 'cont'); }
        else if (L.kind === 'table' || L.msg.startsWith('**')) { const m = L.msg.match(/TESTS=.*?(?=\s{2,}|\*\*$)/); if (m) tline(`<span class="t"></span><span class="m">${esc(m[0].trim())}</span>`, 'sum'); }
        else logLine(L);
        await sleep(gap);
        if (pred(L)) return L;
      }
      return null;
    };

    // ---- code panel
    const defAt = (name) => lines.findIndex((l) => l.includes(`async def ${name}(`));
    const fnEnd = (at) => { let e = at + 1; while (e < lines.length && !/^(@|def |async def |if __name__)/.test(lines[e])) e++; while (e > at && !lines[e - 1].trim()) e--; return e; };
    let fnRange = [0, lines.length];
    const findLine = (s) => { for (let i = fnRange[0]; i < fnRange[1]; i++) if (lines[i].includes(s)) return i; return -1; };
    const scrollToLine = (i, frac = 0.38) => { const el = codeLines[i]; if (el) code.scrollTo({ top: Math.max(0, el.offsetTop - code.clientHeight * frac), behavior: 'smooth' }); };
    const focusFn = (name) => {
      const at = defAt(name); if (at < 0) return;
      const start = lines[at - 1]?.startsWith('@') ? at - 1 : at; fnRange = [start, fnEnd(at)];
      codeLines.forEach((el, i) => { el.classList.toggle('mute', i < fnRange[0] || i >= fnRange[1]); el.classList.remove('cur', 'cur2', 'ran'); });
      scrollToLine(start, 0.06);
    };
    let lastCur = [];
    const markLines = (main, also = []) => {
      lastCur.forEach((i) => { codeLines[i]?.classList.remove('cur', 'cur2'); codeLines[i]?.classList.add('ran'); });
      lastCur = [main, ...also].filter((i) => i >= 0);
      also.forEach((i) => codeLines[i]?.classList.add('cur2'));
      if (main >= 0) { codeLines[main].classList.add('cur'); scrollToLine(main); }
    };

    // ---- ribbon
    const hlOne = (s) => highlight([s])[0];
    const chip = (kind, sig, i) => `<span class="chip ${kind}" style="--d:${i * 60}ms"><i>${kind === 'w' ? 'writes' : 'reads'}</i>dut.${sig}</span>`;
    const ribbon = (lineIdx, st) => {
      const rib = q('rib'); rib.classList.remove('swap'); void rib.offsetWidth; rib.classList.add('swap');
      q('rln').textContent = `line ${lineIdx + 1}`;
      q('stmt').innerHTML = hlOne(lines[lineIdx].trim());
      const ch = [...(st.w || []).map((s, i) => chip('w', s, i)), ...(st.r || []).map((s, i) => chip('r', s, i + (st.w?.length || 0)))];
      q('chips').innerHTML = ch.length ? ch.join('') : '<span class="chip none">python only</span>';
      q('rtag').textContent = st.note || '';
      q('loc').innerHTML = st.loc ? `<span class="lk">locals</span>${esc(st.loc())}` : '';
    };
    const setMean = (html) => { const m = q('mean'); m.classList.remove('in'); void m.offsetWidth; m.innerHTML = html; m.classList.add('in'); };

    // ---- circuit playback (falls back to a timed wait without the circuit)
    const runHw = async ([from, to, cps]) => {
      const sp = cps * ctx.speed;
      if (S.hw) { await S.hw.play(from, to, sp, { signal: ctx.signal }); alive(); }
      else await sleep(((to - from) / cps) * 1000);
    };

    // ---- camera: zoom onto parts of the live circuit (scene px rects from the SVG)
    const camRect = (els) => {
      const base = root.getBoundingClientRect(); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const el of els) { const b = el.getBoundingClientRect(); if (!b.width) continue; x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom); }
      return x1 > x0 ? { x: x0 - base.left, y: y0 - base.top, w: x1 - x0, h: y1 - y0 } : null;
    };
    const camTarget = (kind) => {
      const hw = q('hw'); if (!hw) return null;
      if (kind === 'leds') return camRect(hw.querySelectorAll('.hw-led'));
      if (kind === 'stair') return camRect([...hw.querySelectorAll('.hw-cmp'), ...hw.querySelectorAll('.hw-led')]);
      if (kind === 'dir') { const g = [...hw.querySelectorAll('.hw-reg')].find((n) => /up\/down/.test(n.textContent)); return g ? camRect([g]) : null; }
      return null;
    };
    const camera = async (kind) => {
      const r = camTarget(kind); if (!r || !ctx.focus) return;
      ctx.focus(r, { scale: 1.8, ms: 800, pad: 24 }); await sleep(800 + 1500);
      ctx.unfocus({ ms: 700 }); await sleep(700);
    };

    // ================= intro: the real command (skimmed)
    ctx.narrate('Can plain Python test real hardware? cocotb says yes.');
    const p1 = tline(`<span class="prompt">$</span> <span class="cmd"></span>`, 'cmdl'); await ctx.typeInto(p1.querySelector('.cmd'), d.env, 55);
    const p2 = tline(`<span class="prompt">$</span> <span class="cmd"></span>`, 'cmdl'); await ctx.typeInto(p2.querySelector('.cmd'), d.command, 40);
    q('state').textContent = 'running'; q('state').classList.add('on');
    await streamUntil((L) => L.msg === 'Running tests', 35);

    // ================= tests (normal speed: the circuit carries this part)
    ctx.visual();
    ctx.narrate('Same 4 checks as the Verilog testbench, now written in Python.');
    await sleep(2200);
    const plan = buildPlan(S.T);
    for (let ti = 0; ti < plan.length; ti++) {
      alive();
      const P = plan[ti]; const t = d.tests[ti]; const cell = cells[ti];
      ctx.narrate(P.narrate);
      await streamUntil((L) => L.msg.startsWith('running test_pwm_led.'));
      // docstring continuation line
      if (logs[li]?.kind === 'cont') await streamUntil(() => true);
      cells.forEach((c, i) => c.classList.toggle('cur', i === ti));
      cell.querySelector('.st').outerHTML = '<span class="st mono running"><i></i>running</span>';
      q('pill').textContent = `test ${ti + 1}/${plan.length}`; q('pill').classList.add('on');
      focusFn(P.name); setMean(P.tip);
      await sleep(350);

      for (const st of P.steps) {
        alive();
        const main = findLine(st.src);
        const also = (st.also || []).map(findLine);
        markLines(main, also);
        ribbon(main, st);
        S.hw?.highlight(st.hl || {});
        S.live = st.live || st.tag ? (k) => {
          if (st.live) q('loc').innerHTML = `<span class="lk">locals</span>${esc(st.live(k))}`;
          if (st.tag) q('rtag').textContent = st.tag(k);
        } : null;
        if (st.seek != null) S.hw?.seek(st.seek);
        if (st.log) await streamUntil((L) => L.logger === 'cocotb.pwm_led' && logs[li]?.logger !== 'cocotb.pwm_led', 260);
        if (st.play) await runHw(st.play);
        S.live = null;
        await sleep(st.dwell ?? 380);
        if (st.cam) await camera(st.cam);
      }

      // passed: lands when the playback ends
      await streamUntil((L) => /^test_pwm_led\.\w+ (passed|failed)/.test(L.msg), 120);
      S.hw?.highlight({});
      cell.querySelector('.st').outerHTML = `<span class="badge ${t.status === 'PASS' ? 'pass' : 'fail'} st">${t.status}</span>`;
      cell.classList.add('done');
      countUp(q(`sim${ti}`), t.simTimeNs, fmtNs, 700);
      await sleep(650);
    }

    // ================= summary
    alive();
    markLines(-1); codeLines.forEach((el) => el.classList.remove('mute', 'ran'));
    cells.forEach((c) => c.classList.remove('cur'));
    await streamUntil(() => false, 40);
    const T = d.totals;
    q('state').textContent = `exit 0`; q('state').classList.replace('on', 'ok');
    q('pill').textContent = `${T.pass}/${T.tests} passed`; q('pill').classList.replace('on', 'ok');
    q('totst').outerHTML = `<span class="badge pass st">${T.pass}/${T.tests} PASS</span>`;
    countUp(q('totsim'), T.simTimeNs, fmtNs, 900);
    root.querySelector('.ct-strip').classList.add('final');
    q('rln').textContent = 'done'; q('rtag').textContent = `${T.realTimeS.toFixed(2)} s wall time`;
    q('stmt').innerHTML = `<span class="rb-done">${T.pass}/${T.tests} cocotb tests passed</span>`;
    q('chips').innerHTML = ''; q('loc').innerHTML = `<span class="lk">sim</span>${fmtNs(T.simTimeNs)} of hardware time`;
    S.hw?.highlight({ leds: 'all checks pass' });
    ctx.narrate(`All ${T.tests} cocotb tests passed: ${(T.simTimeNs / 1000).toFixed(1)} µs of simulated hardware checked from Python in ${T.realTimeS.toFixed(2)} s.`);
    setMean(`<b>${T.pass}/${T.tests} PASS.</b> Python agrees with the Verilog testbench: reset, the +1 duty ramp, the 32-count LED phase shift and the direction flip all behave as designed.`);

    const fin = q('final');
    if (fin) {
      fin.innerHTML = `<div class="f-big"><span class="f-n">${T.pass}/${T.tests}</span><span class="f-p">PASS</span></div><div class="f-sub">${fmtNs(T.simTimeNs)} simulated in ${T.realTimeS.toFixed(2)} s · cocotb ${esc(d.cocotb)} on Icarus</div>`;
      fin.classList.add('in');
    }
    if (S.hw) S.hw.play(2052, 2820, 110 * ctx.speed, { signal: ctx.signal }).catch(() => {});
    await sleep(500);
    if (fin && ctx.focus) ctx.focus(fin, { scale: 1.5, ms: 900, pad: 60 });
    ctx.emit('metric', { key: 'cocotb_passed', label: 'cocotb tests passed', value: T.pass, unit: `/ ${T.tests}` });
    ctx.emit('metric', { key: 'cocotb_sim_time', label: 'cocotb simulated time', value: +(T.simTimeNs / 1000).toFixed(2), unit: 'µs' });
    ctx.emit('metric', { key: 'cocotb_wall_time', label: 'cocotb wall time', value: T.realTimeS, unit: 's' });
    await sleep(2400);
    ctx.narrate('4/4 PASS. The logic works. Now can it become real chip cells?');
    await sleep(2200);
    ctx.unfocus?.({ ms: 700 });
    await sleep(600);
  },

  unmount() {
    if (!S) return;
    try { S.unsub?.(); } catch {}
    try { S.hw?.destroy(); } catch {}
    S.live = null; S.hw = null;
    S = null;
  },
};
