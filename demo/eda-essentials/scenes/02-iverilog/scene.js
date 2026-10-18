// Scene 02-iverilog: Icarus compiles + simulates. The live circuit (components/hwsim, real VCD) is the star;
// the terminal strip releases each vvp line when circuit playback crosses that checkpoint's cycle.
// Run 1 fails test2 (on-time 51 vs duty read late = 55), the testbench is fixed, run 2 passes 4/4.
import { highlight, splitLines, esc } from '../01-code/verilog.js';
import { mountHwSim } from '../../components/hwsim/hwsim.js';

const TOOL = '#ea580c';
const C = { pass: '#1a7f37', fail: '#cf222e', on: '#10b981', duty: '#2563eb' };
// which trace cycle releases which vvp line
const CYC = [[/reset released/, 4], [/test1/, 643], [/test2/, 899], [/test3/, 4123], [/test4/, 4125]];
const WIN = [643, 898];
// cycles/second (×ctx.speed) to reach each checkpoint; run 2 jumps through the long ramp faster
const PACE = [
  { 4: 10, 643: 560, win: 105, 4123: 2600, 4125: 12 },
  { 4: 40, 643: 1400, win: 150, 4123: 4200, 4125: 12 },
];

let S = null;

export default {
  id: '02-iverilog',
  tool: 'Icarus',
  title: 'Simulating with Icarus Verilog',
  css: true,

  async mount(root, ctx) {
    // hwsim.css is loaded globally by index.html; add it only if missing (e.g. standalone preview)
    if (![...document.styleSheets].some((x) => /hwsim\.css/.test(x.href || ''))) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = 'components/hwsim/hwsim.css';
      document.head.appendChild(l);
    }
    const d = await ctx.data('02-iverilog');
    const [clog, log1, log2, tb1, tb2] = await Promise.all([
      ctx.text(d.compile.log), ctx.text(d.iterations[0].log), ctx.text(d.iterations[1].log),
      ctx.text(d.iterations[0].tb), ctx.text(d.iterations[1].tb),
    ]);
    root.innerHTML = `
      <div class="sa-ivl">
        <div class="strip">
          <div class="term-win panel window">
            <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div>
              <div class="title"><b>Icarus Verilog</b> · ${esc(d.cwd)}</div>
              <span class="iter-chip">run 1</span></div>
            <div class="term-body"><div class="out"></div></div>
          </div>
          <div class="note callout"><h4>What this means</h4><p class="note-p"></p></div>
        </div>
        <div class="stage">
          <div class="hw-wrap"><div class="hw"></div><div class="pins"></div></div>
          <div class="rail"></div>
        </div>
        <div class="diff panel"></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const hw = mountHwSim($('.hw'), { color: TOOL, mode: 'full' });
    S = { root, $, d, hw, offs: [], clog: splitLines(clog), logs: [splitLines(log1), splitLines(log2)], tb1: splitLines(tb1), tb2: splitLines(tb2) };
    // test2 numbers straight from the real logs
    const f = S.logs[0].join('\n').match(/FAIL test2 on0=(\d+) duty=(\d+)/);
    const p = S.logs[1].join('\n').match(/on-time (\d+)\/256 within duty window (\d+)\.\.(\d+)/);
    S.t2 = { on0: +f[1], late: +f[2], d0: +p[2], d1: +p[3] };
    await hw.ready;
    if (!S) return;
    buildRail();
    S.offs.push(hw.on('cycle', onCycle));
    // re-place the pins only when the stage really changes size (rAF-debounced; pins live outside hwsim's subtree)
    let raf = 0, lastW = 0, lastH = 0;
    S.ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect;
      if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 1) return;
      lastW = w; lastH = h;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => requestAnimationFrame(() => S && placeBadges()));
    });
    S.ro.observe($('.hw-wrap'));
    note(d.explain.compile, 'amber');
  },

  async play(ctx) {
    const { d, hw } = S;
    const t0 = performance.now();
    // 1. compile (text phase, skimmed); the circuit is already on stage, held in reset at cycle 0
    ctx.skim?.();
    ctx.narrate("Does the circuit actually behave? Let's run it.");
    setIter(1);
    await command(ctx, d.compile.cmd);
    for (const l of S.clog) await out(ctx, l, 90);
    await command(ctx, d.run.cmd);
    ctx.visual?.();
    await ctx.sleep(1300);

    // 2. run 1: circuit plays, terminal lines land on their checkpoint cycles
    ctx.narrate('Icarus simulates every clock edge: 4,126 of them.');
    note(d.explain.run, 'tool');
    await runSim(ctx, 0);
    await ctx.sleep(500);

    // 3. the fix (compact diff over the comparators, ~3 s)
    ctx.narrate('The chip was right. The test read brightness too late. Fixed.');
    note(d.explain.fix, 'tool');
    showDiff(S.tb1, S.tb2);
    await ctx.sleep(3000);
    S.$('.diff').classList.remove('on');

    // 4. run 2
    ctx.skim?.();
    ctx.narrate('Run 2: same circuit, corrected testbench.');
    setIter(2);
    resetRun();
    line('&nbsp;');
    await command(ctx, `${d.compile.cmd} && ${d.run.cmd}`);
    for (const l of S.clog) if (/exit \d+$/.test(l)) await out(ctx, l, 50);
    ctx.visual?.();
    await runSim(ctx, 1);

    // 5. VCD + metrics
    await outHTML(`<span class="vcd-line">VCD written: <b>${d.artifacts.vcd.name}</b> <span class="dim">${fmtBytes(d.artifacts.vcd.bytes)} · ${d.artifacts.vcd.timestamps.toLocaleString()} timestamps</span></span>`);
    note(d.explain.pass, 'pass');
    ctx.narrate('It passes, but is the code itself clean? Verilator checks next.');
    ctx.emit('metric', { key: 'tests', label: 'Simulation tests', value: '4/4', unit: 'pass' });
    ctx.emit('metric', { key: 'sim-iterations', label: 'Sim iterations', value: 2, unit: 'runs' });
    ctx.emit('metric', { key: 'sim-time', label: 'Simulated time', value: d.simTimeUs, unit: 'µs' });
    await ctx.sleep(1800);
    S && (S.duration = performance.now() - t0);
    window.__ivlDuration = S?.duration;
  },

  unmount() {
    if (!S) return;
    S.offs.forEach((f) => f());
    S.ro?.disconnect();
    S.hw.destroy();
    S.root.innerHTML = '';
    S = null;
  },
};

/* ---------------- camera ---------------- */

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function focusEls(ctx, els, scale) {
  if (!ctx.focus || !els.length) return;
  const root = S.root.closest('.scene') || S.root, base = root.getBoundingClientRect();
  const k = base.width / (root.clientWidth || base.width) || 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) { const b = e.getBoundingClientRect(); x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom); }
  ctx.focus({ x: (x0 - base.left) / k, y: (y0 - base.top) / k, w: (x1 - x0) / k, h: (y1 - y0) / k }, { scale });
}

/* ---------------- circuit sync ---------------- */

const abortErr = () => new DOMException('aborted', 'AbortError');

async function seg(ctx, to, cps) {
  if (ctx.signal.aborted) throw abortErr();
  if (S.hw.cycle >= to) return;
  await S.hw.play(S.hw.cycle, to, cps * ctx.speed, { signal: ctx.signal });
  if (ctx.signal.aborted || !S) throw abortErr();
}

async function runSim(ctx, run) {
  const pace = PACE[run];
  S.hw.seek(0);
  await ctx.sleep(250);
  for (const l of S.logs[run]) {
    if (!l.trim()) continue;
    const hit = CYC.find(([re]) => re.test(l));
    if (hit) {
      const c = hit[1];
      if (c === 899) {
        // test2: watch the 256-cycle window with the on-time meter, then judge
        meterArm(run);
        ctx.narrate('Test 2: count how long LED0 is on over 256 ticks.');
        S.hw.highlight({ led0: 'tb counts on0', duty: 'duty ramps' });
        if (run === 0) { await nextFrame(); focusEls(ctx, [...S.$('.hw').querySelectorAll('.hw-hl-ring')], 1.8); }
        await seg(ctx, WIN[1], pace.win);
        const ok = judge(run);
        await seg(ctx, 899, 30);
        await out(ctx, l, 0);
        badge(2, ok);
        if (!ok) {
          ctx.narrate(`Caught: on ${S.t2.on0} of 256 ticks. The check expected ${S.t2.late - 2} to ${S.t2.late + 2}.`);
          note(S.d.explain.fail, 'fail');
          ctx.focus?.(S.$('.judge'), { scale: 2.2 });
          await ctx.sleep(2400);
          ctx.unfocus?.();
        } else {
          ctx.narrate(`Run 2: ${S.t2.on0} sits inside the real ${S.t2.d0}–${S.t2.d1} window. 4/4 pass.`);
          note(`<b>${S.t2.on0}</b> is inside <code>${S.t2.d0}..${S.t2.d1}</code>, the range duty swept during the window. <b>PASS</b>.`, 'pass');
          ctx.focus?.(S.$('.judge'), { scale: 2.0 });
          await ctx.sleep(1600);
          ctx.unfocus?.();
        }
        S.hw.highlight({});
        continue;
      }
      await seg(ctx, c, pace[c]);
      await out(ctx, l, 0);
      const m = l.match(/^(PASS|FAIL) test(\d)/);
      if (m) badge(+m[2], m[1] === 'PASS');
      await ctx.sleep(c === 643 ? 350 : 120);
      continue;
    }
    if (/ALL TESTS PASSED|TESTS FAILED/.test(l)) {
      await seg(ctx, 4125, 20);
      await out(ctx, l, 0);
      const ok = /ALL/.test(l);
      const ch = S.$('.iter-chip');
      ch.textContent = ok ? `run 2 · 4/4 PASS` : `run 1 · 1 FAIL`;
      ch.className = `iter-chip ${ok ? 'ok' : 'bad'}`;
      // the ending keeps the LEDs breathing instead of a dark reset circuit (fire-and-forget)
      if (ok) S.hw.play(1800, 4100, 700 * ctx.speed, { signal: ctx.signal });
      await ctx.sleep(300);
      continue;
    }
    await out(ctx, l, /^(real|user|sys)\s/.test(l) ? 30 : 80);
  }
}

function onCycle(s) {
  const M = S.meter;
  if (!M || !M.armed || s.cycle < WIN[0] || s.cycle > WIN[1]) return;
  const on0 = s.on0 ?? 0;
  M.setOn(on0);
  M.setDuty(s.duty);
  M.prog.textContent = `window cycle ${s.cycle - WIN[0]} / 256`;
}

/* ---------------- test2 judge + checkpoints (right rail of the stage) ---------------- */

function buildRail() {
  const t = S.t2, R = S.$('.rail');
  R.innerHTML = `
    <div class="cp panel"><div class="r-head"><span>Checkpoints</span><b class="cp-sum">0/4</b></div>
      ${S.d.tests.map((x) => `<div class="cp-row" data-t="${x.id}"><i></i><b>test${x.id}</b><span>${esc(x.name)}</span><em>@${[0, 643, 899, 4123, 4125][x.id].toLocaleString()}</em></div>`).join('')}
    </div>
    <div class="judge panel idle">
      <div class="r-head"><span>test2 · LED0 on-time vs duty</span><b class="j-run">run 1</b></div>
      <div class="j-nums">
        <div><label>on0 · LED0 on</label><div class="j-big j-on"><span class="v">0</span><small>/256</small></div></div>
        <div><label>duty · tb reads</label><div class="j-big j-duty"><span class="v">–</span></div></div>
      </div>
      <div class="j-scale">
        <div class="j-bandl"></div>
        <div class="j-track"><div class="j-band"></div><div class="j-sweep"></div><div class="j-bar"></div><div class="j-dm"></div></div>
        <div class="j-ticks">${[0, 16, 32, 48, 64].map((v) => `<span style="left:${(v / 64) * 100}%">${v}</span>`).join('')}</div>
      </div>
      <div class="j-verdict"></div>
      <div class="j-why"></div>
      <div class="j-prog">waiting for the window (cycle ${WIN[0]})</div>
    </div>`;
  const q = (s) => R.querySelector(s);
  const pct = (v) => `${(Math.max(0, Math.min(64, v)) / 64) * 100}%`;
  S.meter = {
    pct, armed: false, el: q('.judge'), run: q('.j-run'), prog: q('.j-prog'), verdict: q('.j-verdict'), why: q('.j-why'),
    band: q('.j-band'), bandL: q('.j-bandl'), bar: q('.j-bar'),
    setOn(v) { q('.j-on .v').textContent = v; q('.j-bar').style.width = pct(v); },
    setDuty(v) {
      q('.j-duty .v').textContent = v; q('.j-dm').style.left = pct(v);
      const sw = q('.j-sweep'); sw.style.left = pct(t.d0); sw.style.width = `${(Math.max(0, v - t.d0) / 64) * 100}%`;
    },
    reset() {
      this.armed = false; this.el.className = 'judge panel idle';
      this.setOn(0); q('.j-duty .v').textContent = '–'; q('.j-dm').style.left = '0%';
      q('.j-sweep').style.width = '0'; this.band.style.width = '0'; this.bandL.textContent = '';
      this.verdict.textContent = ''; this.why.textContent = '';
      this.prog.textContent = `waiting for the window (cycle ${WIN[0]})`;
    },
  };
  S.meter.reset();
}

function meterArm(run) {
  const M = S.meter;
  M.reset();
  M.armed = true;
  M.run.textContent = `run ${run + 1}`;
  M.el.className = 'judge panel live';
}

function judge(run) {
  const M = S.meter, t = S.t2;
  M.armed = false;
  M.setOn(t.on0);
  M.setDuty(t.late);
  M.prog.textContent = `window closed at cycle ${WIN[1]}`;
  let lo, hi, ok;
  if (run === 0) {
    lo = t.late - 2; hi = t.late + 2; ok = t.on0 >= lo && t.on0 <= hi;
    M.bandL.textContent = `expects ${t.late} ± 2`;
    M.verdict.innerHTML = `<b>${t.on0}</b> outside ${lo}..${hi} → FAIL`;
    M.why.textContent = `duty was read after the window, when it had already ramped to ${t.late}.`;
    S.hw.highlight({ led0: `on0 = ${t.on0}`, duty: `read late: ${t.late}` });
  } else {
    lo = t.d0 - 2; hi = t.d1 + 2; ok = t.on0 >= lo && t.on0 <= hi;
    M.bandL.textContent = `window ${t.d0}..${t.d1} ± 2`;
    M.verdict.innerHTML = `<b>${t.on0}</b> inside ${t.d0}..${t.d1} → PASS`;
    M.why.textContent = `d0 = ${t.d0} is snapshotted when the window opens.`;
    S.hw.highlight({ led0: `on0 = ${t.on0}`, duty: `d0 ${t.d0} … ${t.d1}` });
  }
  M.band.style.left = M.pct(lo);
  M.band.style.width = `${((hi - lo) / 64) * 100}%`;
  M.bandL.style.left = M.pct((lo + hi) / 2);
  M.el.className = `judge panel judged ${ok ? 'ok' : 'bad'}`;
  return ok;
}

/* checkpoint badges: HTML pills placed over the circuit timeline (hwsim re-lays its SVG on resize) */
function badgePos(c) {
  const svg = S.$('.hw svg');
  if (!svg) return null;
  const vb = svg.viewBox.baseVal, T = S.hw.trace;
  const x0 = 440, x1 = vb.width - 28, y = vb.height - 18;
  const pt = svg.createSVGPoint();
  pt.x = x0 + (c / (T.n - 1)) * (x1 - x0); pt.y = y;
  const m = svg.getScreenCTM();
  if (!m) return null;
  const pins = S.$('.pins'), p = pt.matrixTransform(m), r = pins.getBoundingClientRect();
  const k = r.width / (pins.offsetWidth || r.width) || 1;
  return { x: (p.x - r.left) / k, y: (p.y - r.top) / k };
}

function placeBadges() {
  S.$('.pins').querySelectorAll('.ivl-pin').forEach((b) => {
    const p = badgePos(+b.dataset.c);
    if (p) { b.style.left = `${p.x}px`; b.style.top = `${p.y}px`; }
  });
}

function badge(id, ok) {
  const c = [0, 643, 899, 4123, 4125][id];
  const b = document.createElement('div');
  b.className = `ivl-pin ${ok ? 'ok' : 'bad'} a${id}`;
  b.dataset.c = c;
  b.textContent = `test${id} ${ok ? 'PASS' : 'FAIL'}`;
  S.$('.pins').appendChild(b);
  const p = badgePos(c);
  if (p) { b.style.left = `${p.x}px`; b.style.top = `${p.y}px`; }
  const r = S.$(`.cp-row[data-t="${id}"]`);
  r.className = `cp-row ${ok ? 'ok' : 'bad'}`;
  S.$('.cp-sum').textContent = `${S.root.querySelectorAll('.cp-row.ok').length}/4`;
}

/* ---------------- terminal ---------------- */

const fmtBytes = (b) => (b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);

function line(html, cls = '') {
  const e = document.createElement('div');
  e.className = `tl ${cls}`;
  e.innerHTML = html;
  const t = S.$('.out');
  t.appendChild(e);
  t.scrollTop = t.scrollHeight;
  return e;
}

const prompt = () => `<span class="prompt">${esc(S.d.cwd)} $</span> `;

async function command(ctx, cmd) {
  const e = line(prompt() + '<span class="cmd"></span><span class="cur"></span>');
  const c = e.querySelector('.cmd');
  const tick = Math.max(1, Math.round(cmd.length / 30));
  for (let i = 0; i < cmd.length; i += tick) {
    c.innerHTML = colorCmd(cmd.slice(0, i + tick));
    await ctx.sleep(22);
  }
  c.innerHTML = colorCmd(cmd);
  await ctx.sleep(200);
  e.querySelector('.cur').remove();
}

function colorCmd(s) {
  return esc(s).replace(/(^|&amp;&amp; )(iverilog|vvp)\b/g, '$1<span class="bin">$2</span>')
    .replace(/(\s)(-[\w]+)/g, '$1<span class="flag">$2</span>');
}

function classify(l) {
  if (/^PASS|ALL TESTS PASSED/.test(l)) return 'ok';
  if (/^FAIL|TESTS FAILED/.test(l)) return 'bad';
  if (/warning:/.test(l)) return 'warn';
  if (/^\S+:\d+: \.\.\./.test(l)) return 'warn2';
  if (/exit \d+$|^(real|user|sys)\s|\$finish/.test(l)) return 'dim';
  if (/^VCD info/.test(l)) return 'info';
  return '';
}

function render(l) {
  let h = esc(l);
  h = h.replace(/^(\S+\.v:\d+:)/, '<span class="loc">$1</span>');
  h = h.replace(/^(PASS|FAIL)( test\d)/, '<span class="ivl-tag $1">$1</span>$2');
  h = h.replace(/(\d+\/256|duty=\d+|\.\.\d+|\(4\/4\))/g, '<span class="num">$1</span>');
  if (/exit 0$/.test(l)) h = h.replace(/exit 0$/, '<span class="exit">exit 0</span>');
  return h;
}

async function out(ctx, l, delay) {
  if (!l) { line('&nbsp;'); return; }
  line(render(l), classify(l) + ' fade-line');
  if (delay) await ctx.sleep(delay);
}

async function outHTML(html) { line(html, 'fade-line'); }

function setIter(n) {
  const ch = S.$('.iter-chip');
  ch.textContent = `run ${n}`;
  ch.className = 'iter-chip';
}

function resetRun() {
  S.meter.reset();
  S.$('.pins').replaceChildren();
  S.root.querySelectorAll('.cp-row').forEach((r) => { r.className = 'cp-row'; });
  S.$('.cp-sum').textContent = '0/4';
  S.hw.seek(0);
}

function note(html, tone) {
  const n = S.$('.note');
  n.className = `note callout tone-${tone}`;
  void n.offsetWidth;
  n.classList.add('pulse');
  S.$('.note-p').innerHTML = html;
}

/* ---------------- diff ---------------- */

function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: ' ', s: a[i], ai: i + 1, bi: j + 1 }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) { ops.push({ t: '+', s: b[j], bi: j + 1 }); j++; }
    else { ops.push({ t: '-', s: a[i], ai: i + 1 }); i++; }
  }
  return ops;
}

// <mark> the change: the check now uses the snapshot d0 instead of dut.duty read late
function mark(html, t) {
  if (t !== '+') return html;
  return html.replace(/(^|[^\w>])(d0)(?![\w])/g, '$1<mark>$2</mark>').replace(/>d0</g, '><mark>d0</mark><');
}

function showDiff(a, b) {
  const ops = lcsDiff(a, b);
  const keep = new Set();
  ops.forEach((o, k) => { if (o.t !== ' ') keep.add(k); });
  let html = '', prev = -2, adds = 0, dels = 0, n = 0;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== prev + 1) html += `<div class="hunk">@@ line ${o.bi || o.ai} @@</div>`;
    prev = k;
    if (o.t === '+') adds++; if (o.t === '-') dels++;
    const cls = o.t === '+' ? 'add' : 'del';
    html += `<div class="dl ${cls}" style="animation-delay:${(n++) * 0.04}s"><span class="nb">${o.bi || o.ai}</span><span class="sg">${o.t}</span><span class="code">${mark(highlight(o.s.replace(/^ {4}/, '')), o.t)}</span></div>`;
  });
  const e = S.$('.diff');
  e.innerHTML = `<div class="d-head"><b>tb_pwm_led.v</b><span class="dim">run 1 → run 2 · testbench only, RTL unchanged</span>
      <span class="grow"></span><span class="st add">+${adds}</span><span class="st del">−${dels}</span></div>
    <div class="d-body">${html}</div>`;
  void e.offsetWidth;
  e.classList.add('on');
}
