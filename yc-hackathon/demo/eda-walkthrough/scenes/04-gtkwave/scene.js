// 04-gtkwave: a web redesign of GTKWave driven by the real Icarus dump (real/pwm_led.vcd -> data/04-gtkwave.json).
const ORDER = ['clk', 'rst', 'duty[7:0]', 'dir', 'pwm_cnt[7:0]', 'led'];   // what we pull from the SST, in order
const C = { ink: '#0a0a0a', ink2: '#3f3f46', muted: '#71717a', faint: '#a1a1aa', line: '#ececec', accent: '#2563eb', accentSoft: '#eff4ff', fail: '#ef4444',
  tool: '#059669', clk: '#71717a', rst: '#ef4444', duty: '#2563eb', dir: '#f59e0b', cnt: '#7c3aed', led: '#10b981', ann: '#db2777' };
// each signal group gets its own colour (UPDATE 2): clk grey, duty blue, dir orange, led green
const colorOf = (label) => (label === 'clk' ? C.clk : label === 'rst' ? C.rst : label.startsWith('duty') ? C.duty : label === 'dir' ? C.dir : label.startsWith('pwm_cnt') ? C.cnt : C.led);
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const MONO = '"Geist Mono", "JetBrains Mono", ui-monospace, monospace';
const ICON = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  fit: ICON('<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>'), zin: ICON('<path d="M8 3v10M3 8h10"/>'), zout: ICON('<path d="M3 8h10"/>'),
  start: ICON('<path d="M4 3v10M12 3 6 8l6 5"/>'), prev: ICON('<path d="M10 3 5 8l5 5"/>'), next: ICON('<path d="m6 3 5 5-5 5"/>'), end: ICON('<path d="M12 3v10M4 3l6 5-6 5"/>'),
};

let S = null; // per-mount state

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ease = (t) => 1 - Math.pow(1 - t, 3);
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function fmtTime(ns, step = 1) {
  if (Math.abs(ns) >= 1000 && step >= 100) return `${+(ns / 1000).toFixed(step >= 1000 ? 0 : 1)} µs`;
  if (Math.abs(ns) >= 1000) return `${+(ns / 1000).toFixed(2)} µs`;
  return `${Math.round(ns)} ns`;
}
const hex2 = (v) => (v == null ? 'xx' : v.toString(16).toUpperCase().padStart(2, '0'));

// value of a signal at time t (binary search over [t, v] changes)
function valueAt(sig, t) {
  if (sig.clock) {
    if (t < sig.clock.firstRiseNs - sig.clock.periodNs / 2) return sig.changes[0][1];
    const ph = ((t - sig.clock.firstRiseNs) % sig.clock.periodNs + sig.clock.periodNs) % sig.clock.periodNs;
    return ph < sig.clock.periodNs / 2 ? 1 : 0;
  }
  const c = sig.changes; let lo = 0, hi = c.length - 1;
  if (t < c[0][0]) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m][0] <= t) lo = m; else hi = m - 1; }
  return c[lo][1];
}
function idxAt(c, t) { let lo = 0, hi = c.length - 1; if (t < c[0][0]) return 0; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m][0] <= t) lo = m; else hi = m - 1; } return lo; }
const fmtVal = (sig, v) => (v == null ? 'x' : sig.radix === 'hex' ? hex2(v) : String(v));

function tween(ms, fn, signal, curve = ease) {
  return new Promise((res, rej) => {
    const dur = ms / (S?.ctx?.speed || 1); const t0 = performance.now();
    const step = (now) => {
      if (signal?.aborted) return rej(new DOMException('aborted', 'AbortError'));
      const k = Math.min(1, (now - t0) / dur); fn(curve(k)); S.dirty = true;
      if (k < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}

function niceStep(span, px) {
  const target = span / Math.max(4, px / 120);
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
  return 10 * p;
}

/* ------------------------------------------------------------------ DOM */
function build(root, d) {
  const dut = d.sst['tb_pwm_led.dut'];
  const tb = d.sst['tb_pwm_led'];
  const typeOf = (v) => (v.kind === 'parameter' ? 'parm' : v.kind === 'integer' ? 'int' : v.kind);
  const label = (v) => (v.width > 1 && v.kind !== 'parameter' && v.kind !== 'integer' ? `${v.name}[${v.width - 1}:0]` : v.name);
  root.innerHTML = `
  <div class="gw">
    <aside class="gw-side">
      <div class="gw-head"><div class="eyebrow"><i class="tooldot"></i>GTKWave · waveform viewer</div><h2>Reading the waveform</h2></div>
      <div class="panel window gw-termwin">
        <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title">Terminal</div></div>
        <div class="term mono" data-k="term"><span class="prompt">$ </span><span class="cmd" data-k="cmdline"></span></div>
      </div>
      <div class="callout gw-callout" data-k="callout"><h4>What this means</h4><p data-k="callout-p">GTKWave opens the dump that Icarus wrote while running our testbench, and shows every signal's value over time.</p></div>
      <div class="gw-legend"><h5>Signal colors</h5><div><i style="background:#71717a"></i><b>clk</b>25 MHz clock</div><div><i style="background:#ef4444"></i><b>rst</b>reset</div><div><i style="background:#2563eb"></i><b>duty[7:0]</b>brightness</div><div><i style="background:#f59e0b"></i><b>dir</b>ramp direction</div><div><i style="background:#7c3aed"></i><b>pwm_cnt[7:0]</b>PWM carrier</div><div><i style="background:#10b981"></i><b>led[0..7]</b>LED outputs</div></div>
    </aside>
    <div class="gw-main">
      <div class="gw-win panel window">
        <div class="titlebar">
          <div class="dots"><i></i><i></i><i></i></div>
          <div class="title"><b>GTKWave</b> — pwm_led.vcd</div>
          <div class="gw-mc mono"><span>Marker <b data-k="marker">--</b></span><span>Cursor <b data-k="cursor">--</b></span></div>
        </div>
        <div class="gw-tools">
          <div class="gw-btns">
            <button title="Zoom fit">${ICONS.fit}</button><button title="Zoom in">${ICONS.zin}</button><button title="Zoom out">${ICONS.zout}</button>
            <span class="sep"></span><button title="To start">${ICONS.start}</button><button title="Prev edge">${ICONS.prev}</button><button title="Next edge">${ICONS.next}</button><button title="To end">${ICONS.end}</button>
          </div>
          <div class="gw-range mono"><label>From</label><span data-k="from">0 ns</span><label>To</label><span data-k="to">0 ns</span></div>
          <div class="gw-status mono" data-k="status">no dump loaded</div>
        </div>
        <div class="gw-body">
          <aside class="gw-sst">
            <div class="pane-h">SST</div>
            <ul class="tree">
              <li class="scope open" data-scope="tb_pwm_led"><span class="tw">▾</span><span class="ic"></span>tb_pwm_led
                <ul><li class="scope" data-scope="tb_pwm_led.dut"><span class="tw">▸</span><span class="ic"></span>dut <em>(pwm_led)</em></li></ul>
              </li>
            </ul>
            <div class="pane-h sub"><span>Type</span><span>Signals</span></div>
            <ul class="siglist" data-k="siglist">
              ${tb.filter(v => v.kind !== 'integer').map(v => `<li class="tbsig"><span class="ty">${typeOf(v)}</span>${esc(label(v))}</li>`).join('')}
            </ul>
            <div class="gw-filter mono"><span>⌕</span><span data-k="filter"></span></div>
            <div class="gw-sstbtns"><button data-k="append">Append</button><button>Insert</button></div>
          </aside>
          <div class="gw-signals">
            <div class="pane-h">Signals</div>
            <div class="sig-time mono">Time</div>
            <div class="sig-rows" data-k="rows"></div>
          </div>
          <div class="gw-waves">
            <div class="pane-h">Waves</div>
            <canvas data-k="canvas"></canvas>
          </div>
        </div>
      </div>
      <div class="gw-hw panel">
        <div class="gw-hw-mount" data-k="hw"></div>
        <div class="gw-hw-side">
          <div class="gw-hw-h"><span>Live circuit</span><em>synced to the cursor</em></div>
          <div class="gw-kv mono">
            <div><span>time</span><b data-k="rt">--</b><i data-k="rc"></i></div>
            <div class="c-duty"><span>duty</span><b data-k="r-duty">--</b><i data-k="r-dutyd"></i></div>
            <div class="c-cnt"><span>pwm_cnt</span><b data-k="r-cnt">--</b><i data-k="r-cntd"></i></div>
            <div class="c-dir"><span>dir</span><b data-k="r-dir">--</b><i data-k="r-dirt"></i></div>
            <div class="c-led"><span>led</span><b data-k="r-led">--</b><i data-k="r-ledn"></i></div>
          </div>
          <div class="gw-hw-note">Each LED is a comparator, (pwm_cnt + 32·k) &lt; duty, feeding a flip-flop. These are the same signals the waves show.</div>
        </div>
      </div>
    </div>
  </div>`;
  const q = (k) => root.querySelector(`[data-k="${k}"]`);
  return { q, dutSigs: dut, label, typeOf };
}

/* -------------------------------------------------------------- canvas */
function setupCanvas() {
  const cv = S.q('canvas'); const g = cv.getContext('2d');
  const fit = () => {
    const r = cv.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    S.W = r.width; S.H = r.height; S.dpr = dpr;
    const rowH = Math.max(18, Math.min(40, Math.floor((S.H - S.RULER) / 13)));
    S.rowH = rowH; S.root.style.setProperty('--rowh', rowH + 'px'); S.root.style.setProperty('--ruler', S.RULER + 'px');
    S.dirty = true;
  };
  S.cv = cv; S.g = g; S.ro = new ResizeObserver(fit); S.ro.observe(cv); fit();
  g.font = '500 11px ' + MONO;
  const loop = () => { if (!S) return; if (S.dirty) { S.dirty = false; draw(); syncReadout(); } S.raf = requestAnimationFrame(loop); };
  S.raf = requestAnimationFrame(loop);
}

function draw() {
  const { g, W, H, dpr, rowH, RULER } = S;
  const t0 = S.view.t0, t1 = S.view.t1, span = t1 - t0;
  const X = (t) => ((t - t0) / span) * W;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);

  // grid + ruler
  const step = niceStep(span, W);
  g.fillStyle = '#fafafa'; g.fillRect(0, 0, W, RULER);
  g.strokeStyle = '#f0f0f1'; g.lineWidth = 1; g.beginPath();
  g.font = '500 10.5px ' + MONO; g.textBaseline = 'middle';
  g.fillStyle = C.muted;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(X(t)) + 0.5; g.moveTo(x, RULER - 7); g.lineTo(x, H);
    g.fillText(fmtTime(t, step), x + 4, RULER / 2 - 1);
  }
  g.stroke();
  g.strokeStyle = '#d4d4d8'; g.beginPath();
  for (let t = Math.ceil(t0 / (step / 5)) * (step / 5); t <= t1; t += step / 5) { const x = Math.round(X(t)) + 0.5; g.moveTo(x, RULER - 3); g.lineTo(x, RULER); }
  g.stroke();
  g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, RULER + 0.5); g.lineTo(W, RULER + 0.5); g.stroke();

  const rev = S.reveal; // traces are drawn up to this time
  const tEnd = Math.min(t1, rev, S.d.endNs);
  S.rows.forEach((row, i) => {
    const y = RULER + i * rowH; const hi = y + 6, lo = y + rowH - 6;
    const sel = S.sel.includes(row.sig.label); row.color = colorOf(row.sig.label); row.sel = sel;
    if (sel) { g.fillStyle = rgba(row.color, 0.07); g.fillRect(0, y, W, rowH); }
    if (row.flash > 0) { g.fillStyle = rgba(row.color, 0.12 * row.flash); g.fillRect(0, y, W, rowH); }
    g.strokeStyle = '#f4f4f5'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y + rowH - 0.5); g.lineTo(W, y + rowH - 0.5); g.stroke();
    if (row.alpha <= 0 || tEnd <= t0) return;
    g.globalAlpha = row.alpha;
    if (row.sig.width === 1) drawBit(row, X, t0, tEnd, hi, lo);
    else drawBus(row, X, t0, tEnd, hi, lo);
    g.globalAlpha = 1;
  });

  drawAnnotations(X);

  // leading-edge glow while revealing
  if (rev < t1 && rev > t0) {
    const x = X(rev); const gr = g.createLinearGradient(x - 80, 0, x, 0);
    gr.addColorStop(0, rgba(C.tool, 0)); gr.addColorStop(1, rgba(C.tool, 0.08));
    g.fillStyle = gr; g.fillRect(x - 80, RULER, 80, H - RULER);
  }
  // primary marker (red) and cursor (cyan)
  if (S.marker != null && S.marker >= t0 && S.marker <= t1) vline(X(S.marker), C.fail, fmtTime(S.marker), false);
  if (S.cursor != null && S.cursor >= t0 && S.cursor <= t1) vline(X(S.cursor), C.tool, fmtTime(S.cursor), true);
}

function vline(x, color, label, glow) {
  const { g, H, RULER } = S; x = Math.round(x) + 0.5;
  g.strokeStyle = color; g.lineWidth = 1; g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, H); g.stroke();
  g.font = '600 10.5px ' + MONO; const w = g.measureText(label).width + 12;
  const bx = Math.min(Math.max(2, x - w / 2), S.W - w - 2);
  g.fillStyle = color; roundRect(bx, 3, w, RULER - 8, 5); g.fill();
  g.fillStyle = '#ffffff'; g.fillText(label, bx + 6, RULER / 2 - 1);
}
function roundRect(x, y, w, h, r) { const g = S.g; g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function strokeGlow(color, w = 1.5) { const g = S.g; g.strokeStyle = color; g.lineWidth = w; g.stroke(); }

function drawBit(row, X, t0, tEnd, hi, lo) {
  const g = S.g; const sig = row.sig; const color = row.color;
  if (sig.clock) {
    const P = sig.clock.periodNs, half = P / 2, pxHalf = (half / (S.view.t1 - S.view.t0)) * S.W;
    const start = Math.max(t0, 0);
    if (pxHalf < 2.5) { // too dense to resolve: a solid band, like real GTKWave
      g.fillStyle = rgba(color, 0.18); g.fillRect(X(start), hi, X(tEnd) - X(start), lo - hi);
      g.beginPath(); g.moveTo(X(start), hi); g.lineTo(X(tEnd), hi); g.moveTo(X(start), lo); g.lineTo(X(tEnd), lo); strokeGlow(color); return;
    }
    g.beginPath(); let t = Math.floor((start - sig.clock.firstRiseNs) / half) * half + sig.clock.firstRiseNs;
    let v = valueAt(sig, Math.max(start, t + 0.1)); let x = X(start); g.moveTo(x, v ? hi : lo);
    for (t += half; t < tEnd; t += half) { x = X(t); g.lineTo(x, v ? hi : lo); v = v ? 0 : 1; g.lineTo(x, v ? hi : lo); }
    g.lineTo(X(tEnd), v ? hi : lo); strokeGlow(color); return;
  }
  const c = sig.changes; let i = idxAt(c, t0); const lvl = (v) => (v ? hi : lo);
  let v = c[i][1], xp = X(Math.max(t0, c[i][0])); const xs = []; // xs: unknown (x) spans
  g.beginPath(); if (v != null) g.moveTo(xp, lvl(v));
  for (i++; i < c.length && c[i][0] < tEnd; i++) {
    const x = X(c[i][0]), nv = c[i][1];
    if (v == null) xs.push([xp, x]); else g.lineTo(x, lvl(v));
    if (nv != null) { if (v != null) g.lineTo(x, lvl(nv)); else g.moveTo(x, lvl(nv)); }
    v = nv; xp = x;
  }
  const xe = X(tEnd);
  if (v == null) xs.push([xp, xe]); else g.lineTo(xe, lvl(v));
  strokeGlow(color, row.sel ? 2.2 : 1.5);
  for (const [a, b] of xs) xbox(a, b, hi, lo);
}
function xbox(a, b, hi, lo) { const g = S.g; const w = Math.max(1, b - a); g.fillStyle = '#fef2f2'; g.fillRect(a, hi, w, lo - hi); g.strokeStyle = C.fail; g.lineWidth = 1; g.strokeRect(a + .5, hi + .5, w - 1, lo - hi - 1); }

function drawBus(row, X, t0, tEnd, hi, lo) {
  const g = S.g; const sig = row.sig, c = sig.changes, color = row.color; const mid = (hi + lo) / 2;
  const segs = [];
  for (let i = idxAt(c, t0); i < c.length && c[i][0] < tEnd; i++) {
    const a = Math.max(t0, c[i][0]); const b = Math.min(tEnd, i + 1 < c.length ? c[i + 1][0] : S.d.endNs);
    segs.push([X(a), X(b), c[i][1], c[i][0] >= t0]);
  }
  const hexes = new Path2D(); const dense = []; const xs = []; let df = null, dt = 0;
  for (const [a, b, v, edge] of segs) {
    const w = b - a;
    if (w < 12 && v != null) { if (df == null) df = a; dt = b; continue; }
    if (df != null) { dense.push([df, dt]); df = null; }
    if (v == null) { xs.push([a, b]); continue; }
    const k = Math.min(3, w / 3), ka = edge ? k : 0;
    hexes.moveTo(a, mid); hexes.lineTo(a + ka, hi); hexes.lineTo(b - k, hi); hexes.lineTo(b, mid);
    hexes.lineTo(b - k, lo); hexes.lineTo(a + ka, lo); hexes.closePath();
  }
  if (df != null) dense.push([df, dt]);
  for (const [a, b] of dense) { g.fillStyle = rgba(color, 0.16); g.fillRect(a, hi, b - a, lo - hi); hexes.moveTo(a, hi); hexes.lineTo(b, hi); hexes.moveTo(a, lo); hexes.lineTo(b, lo); }
  g.strokeStyle = color; g.lineWidth = row.sel ? 2 : 1.4; g.stroke(hexes);
  for (const [a, b] of xs) xbox(a, b, hi, lo);
  g.font = '500 10.5px ' + MONO; g.textBaseline = 'middle'; g.fillStyle = color;
  for (const [a, b, v] of segs) {
    const w = b - a; if (v == null || w < 14) continue;
    let s = fmtVal(sig, v); if (s.length * 6.6 + 8 > w) s = s.slice(0, Math.max(1, Math.floor((w - 8) / 6.6) - 1)) + '+';
    if (s.length * 6.6 + 6 <= w) g.fillText(s, a + Math.max(5, (w - s.length * 6.6) / 2), mid + 0.5);
  }
}

function drawAnnotations(X) {
  const A = S.ann; if (!A || A.alpha <= 0) return; const g = S.g; g.globalAlpha = A.alpha;
  if (A.kind === 'widths') { // widening on-time of led[0] across PWM periods
    const row = S.rows.find(r => r.sig.label === 'led[0]'); const i = S.rows.indexOf(row); if (!row) return;
    const y = S.RULER + i * S.rowH; const c = row.sig.changes;
    g.font = '600 10px ' + MONO; g.textBaseline = 'bottom';
    for (let k = 1; k < c.length - 1; k++) if (c[k][1] === 1) {
      const a = X(c[k][0]), b = X(c[k + 1][0]); if (b < 0 || a > S.W || b - a < 22) continue;
      const clks = Math.round((c[k + 1][0] - c[k][0]) / S.d.clkPeriodNs);
      g.fillStyle = '#047857'; const s = `${clks}`; g.fillText(s, (a + b) / 2 - s.length * 3, y + 6);
      g.strokeStyle = rgba(C.led, 0.55); g.lineWidth = 1; g.beginPath(); g.moveTo(a, y + 4); g.lineTo(b, y + 4); g.stroke();
    }
  }
  if (A.kind === 'phase') { // rising edges of led[7..0] after the period start: the 32-count staircase
    const pts = []; const p0 = S.marker ?? S.view.t0;
    for (let k = 0; k < 8; k++) {
      const row = S.rows.find(r => r.sig.label === `led[${k}]`); const i = S.rows.indexOf(row);
      const c = row.sig.changes; const j = c.findIndex(([t, v]) => v === 1 && t > p0 + S.d.clkPeriodNs * 2 && t <= S.view.t1);
      if (j < 0) continue; pts.push([X(c[j][0]), S.RULER + i * S.rowH + 6, k]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    g.setLineDash([3, 4]); g.strokeStyle = C.ann; g.lineWidth = 1.3; g.beginPath();
    pts.forEach(([x, y], n) => (n ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); g.setLineDash([]);
    for (const [x, y] of pts) { g.fillStyle = '#fff'; g.strokeStyle = C.ann; g.lineWidth = 1.6; g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fill(); g.stroke(); }
    if (pts.length > 3) {
      const [x0, y0] = pts[1], [x1, y1] = pts[2];
      g.font = '500 11px ' + MONO; g.textBaseline = 'middle';
      const s = `Δ 32 clk = ${fmtTime(32 * S.d.clkPeriodNs)}`; const w = g.measureText(s).width + 14;
      const bx = Math.min(S.W - w - 6, (x0 + x1) / 2 + 14), by = (y0 + y1) / 2 + 10;
      g.fillStyle = '#fdf2f8'; roundRect(bx, by - 10, w, 20, 6); g.fill();
      g.strokeStyle = '#fbcfe8'; g.lineWidth = 1; g.stroke(); g.fillStyle = C.ann; g.fillText(s, bx + 7, by);
    }
  }
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------- readout */
function syncReadout() {
  const t = S.cursor ?? S.marker; const q = S.q;
  q('cursor').textContent = S.cursor != null ? fmtTime(S.cursor) : '--';
  q('marker').textContent = S.marker != null ? fmtTime(S.marker) : '--';
  q('from').textContent = fmtTime(S.view.t0); q('to').textContent = fmtTime(S.view.t1);
  for (const row of S.rows) {
    const v = t != null && t <= S.reveal ? valueAt(row.sig, t) : undefined;
    const s = v === undefined ? '' : fmtVal(row.sig, v);
    if (row.lastVal !== s) { row.valEl.textContent = s ? `=${s}` : ''; row.lastVal = s; }
  }
  if (t == null || t > S.reveal) return;
  const sig = (l) => S.d.signals.find(s => s.label === l);
  const duty = valueAt(sig('duty[7:0]'), t), cnt = valueAt(sig('pwm_cnt[7:0]'), t), dir = valueAt(sig('dir'), t);
  const key = `${Math.round(t)}`; if (S.lastKey === key) return; S.lastKey = key;
  q('rt').textContent = fmtTime(t);
  q('r-duty').textContent = duty == null ? 'xx' : `0x${hex2(duty)}`; q('r-dutyd').textContent = duty == null ? '' : `${duty} / 255`;
  q('r-cnt').textContent = cnt == null ? 'xx' : `0x${hex2(cnt)}`; q('r-cntd').textContent = cnt == null ? '' : `${cnt}`;
  q('r-dir').textContent = dir == null ? 'x' : dir; q('r-dirt').textContent = dir == null ? '' : dir ? 'brightening' : 'dimming';
  const bits = [0, 1, 2, 3, 4, 5, 6, 7].map(k => valueAt(sig(`led[${k}]`), t));
  q('r-led').textContent = bits.some(b => b == null) ? 'xxxxxxxx' : bits.slice().reverse().join('');
  q('r-ledn').textContent = bits.some(b => b == null) ? '' : `${bits.filter(Boolean).length} on`;
  const cyc = Math.max(0, Math.floor((t - 20) / S.d.clkPeriodNs)); // trace = one sample per rising edge at 20 + 40k ns
  q('rc').textContent = `cycle ${cyc.toLocaleString('en-US')}`;
  if (S.hw && !S.hwHold && S.hwCycle !== cyc) { S.hwCycle = cyc; S.hw.seek(Math.min(cyc, (S.hw.trace?.n || 1e9) - 1)); }
}

/* --------------------------------------------------------------- scene */
export default {
  id: '04-gtkwave',
  tool: 'GTKWave',
  title: 'Inspecting the waveforms',
  css: true,

  async mount(root, ctx) {
    const d = await ctx.data('04-gtkwave');
    const b = build(root, d);
    S = { root, ctx, d, q: b.q, b, rows: [], RULER: 28, view: { t0: 0, t1: d.endNs }, reveal: 0, cursor: null, marker: null, ann: null, sel: [], dirty: true };
    setupCanvas();
    // live circuit view (Session E's components/hwsim), locked to the GTKWave cursor
    try {
      if (!document.querySelector('link[href="components/hwsim/hwsim.css"]')) document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'components/hwsim/hwsim.css' }));
      const [{ mountHwSim }, trace] = await Promise.all([import('../../components/hwsim/hwsim.js'), ctx.data('hw-trace')]);
      if (!S || S.root !== root) return;
      const host = document.createElement('div'); host.className = 'gw-hw-host'; S.q('hw').appendChild(host);
      S.hw = mountHwSim(host, { trace, mode: 'compact', color: C.tool, fill: false });
    } catch (e) { console.warn('[04-gtkwave] hwsim unavailable', e); S.q('hw').innerHTML = '<div class="gw-hw-ph">live circuit view loading…</div>'; }
  },

  async play(ctx) {
    const { q, d } = S; const sig = ctx.signal; const sleep = ctx.sleep;
    const select = (labels) => { S.sel = labels; S.rows.forEach(r => r.el.classList.toggle('sel', labels.includes(r.sig.label))); S.dirty = true; };
    const callout = (html) => { const p = q('callout-p'); p.style.opacity = 0; setTimeout(() => { p.innerHTML = html; p.style.opacity = 1; }, 220); };

    // 1. the dump opens at once; the terminal is a fast side note (nothing waits on it)
    ctx.narrate('4,126 clock cycles of data. Can you see the LEDs breathe?');
    const term = q('term'); q('cmdline').textContent = d.command;
    d.loadLog.forEach((l, i) => term.insertAdjacentHTML('beforeend', `\n<span class="dim tl-in" style="animation-delay:${80 + i * 80}ms">${esc(l)}</span>`));
    q('status').innerHTML = `<span class="ok">●</span> ${fmtTime(d.endNs)} · ${Object.values(d.sst).flat().length} vars · ${d.timescale}`;
    const dutLi = S.root.querySelector('[data-scope="tb_pwm_led.dut"]');
    dutLi.classList.add('sel', 'open'); dutLi.querySelector('.tw').textContent = '▾';
    const list = q('siglist');
    list.innerHTML = S.b.dutSigs.map(v => `<li data-name="${v.name}"><span class="ty">${S.b.typeOf(v)}</span>${esc(S.b.label(v))}</li>`).join('');
    [...list.children].forEach((li, i) => { li.style.animationDelay = `${i * 25}ms`; li.classList.add('fade-in'); });
    q('filter').textContent = 'clk|rst|duty|dir|pwm|led';
    ctx.visual();

    // 2. signals drop into the Signals pane while the traces already stream in behind a cursor sweep
    const rowsEl = q('rows');
    const addRow = (s) => {
      const el = document.createElement('div'); el.className = 'sig-row mono'; el.style.setProperty('--c', colorOf(s.label));
      el.innerHTML = `<span class="nm">${esc(s.label)}</span><span class="vl"></span>`;
      rowsEl.appendChild(el);
      const row = { sig: s, color: C.ink, el, valEl: el.querySelector('.vl'), alpha: 0, flash: 1, lastVal: null };
      S.rows.push(row); requestAnimationFrame(() => el.classList.add('in'));
      tween(500, (k) => { row.alpha = k; row.flash = 1 - k; }, sig).catch(() => {});
      return row;
    };
    S.sel = ['duty[7:0]']; S.hw?.highlight({ duty: 'duty[7:0]' });
    callout('Across the whole run <b>duty</b> climbs to <b>0xFF</b>. At the far right <b>dir</b> drops to 0 and the LEDs start dimming.');
    let midCap = false;
    const reveal = tween(7200, (k) => {
      S.reveal = k * d.endNs; S.cursor = S.reveal;
      if (!midCap && k > 0.72) { midCap = true; ctx.narrate('Each row is one wire: clock, brightness, 8 LEDs'); }
    }, sig, (t) => t);
    for (const name of ORDER) {
      const base = name.replace(/\[.*/, '');
      const li = list.querySelector(`[data-name="${base}"]`); li.classList.add('pick');
      q('append').classList.add('press'); setTimeout(() => q('append')?.classList.remove('press'), 140);
      const from = li.getBoundingClientRect(); const to = rowsEl.getBoundingClientRect(); const toTop = to.top + S.rows.length * S.rowH;
      const ghost = Object.assign(document.createElement('div'), { className: 'gw-ghost mono', textContent: li.textContent.replace(/^\w+/, '') });
      document.body.appendChild(ghost);
      const anim = ghost.animate([
        { transform: `translate(${from.left}px, ${from.top}px)`, opacity: 1 },
        { transform: `translate(${to.left}px, ${toTop}px)`, opacity: 0.3 },
      ], { duration: 240 / ctx.speed, easing: 'cubic-bezier(.16,1,.3,1)' });
      anim.onfinish = anim.oncancel = () => ghost.remove();
      await sleep(170);
      if (base === 'led') { for (let k = 0; k < 8; k++) { addRow(d.signals.find(s => s.label === `led[${k}]`)); await sleep(30); } }
      else addRow(d.signals.find(s => s.label === name));
      li.classList.remove('pick'); li.classList.add('added');
    }
    select(['duty[7:0]']);
    ctx.narrate('165 µs of simulation: 12,899 signal changes, one picture');
    await reveal;
    S.reveal = Infinity; S.cursor = null; S.marker = d.zoom.startNs; S.dirty = true;
    await sleep(700);

    // 4. zoom: full run -> 8 PWM periods -> 1 PWM period
    const P = d.pwmPeriodNs;
    const cnt = d.signals.find(s => s.label === 'pwm_cnt[7:0]');
    const duty = d.signals.find(s => s.label === 'duty[7:0]');
    const wraps = cnt.changes.filter(([, v]) => v === 0).map(([t]) => t);
    const startP = wraps.reduce((best, t) => (Math.abs(valueAt(duty, t) - 0x60) < Math.abs(valueAt(duty, best) - 0x60) ? t : best), wraps[1]);
    const zoomTo = async (a, b, ms) => {
      const A = { ...S.view }; const la = Math.log(A.t1 - A.t0), lb = Math.log(b - a); const ca = (A.t0 + A.t1) / 2, cb = (a + b) / 2;
      await tween(ms, (k) => {
        const span = Math.exp(la + (lb - la) * k); const c = ca + (cb - ca) * k;
        S.view.t0 = c - span / 2; S.view.t1 = c + span / 2;
      }, sig, easeIO);
      S.view.t0 = a; S.view.t1 = b;
    };
    ctx.narrate("Zoom in: LED0's pulse grows 68, 85, 102… clocks wide");
    callout('The number on each <b>led[0]</b> pulse is its on-time in clocks. It widens every period: the breathing ramp that test2 checked.');
    S.marker = startP - 3 * P;
    await zoomTo(startP - 4 * P, startP + 4 * P, 2600);
    select(['led[0]']); S.hw?.highlight({ led0: 'on-time grows', duty: 'ramping' }); S.ann = { kind: 'widths', alpha: 0 }; await tween(500, (k) => { S.ann.alpha = k; }, sig);
    // P0: no dead spell, the cursor keeps sweeping so the LEDs and readout tick
    await tween(2600, (k) => { S.cursor = startP - 4 * P + k * 8 * P; }, sig, (t) => t);
    ctx.narrate("Wider pulse, brighter LED. That's the breathing.");
    await tween(1400, (k) => { S.cursor = startP + 4 * P - k * 2 * P; }, sig, easeIO);
    S.cursor = null;
    await tween(400, (k) => { S.ann.alpha = 1 - k; }, sig);

    ctx.narrate('One cycle is 256 clocks. Each LED starts 32 clocks after the last.');
    callout('Each LED switches on 32 clocks after the next (<b>(pwm_cnt + 32·k) &lt; duty</b>). The comparator dots in the live circuit fire in the same staggered order as the cursor sweeps.');
    S.marker = startP;
    await zoomTo(startP - P * 0.04, startP + P * 1.04, 2400);
    select(['led[0]', 'led[1]', 'led[2]', 'led[3]', 'led[4]', 'led[5]', 'led[6]', 'led[7]']); S.hw?.highlight({ leds: 'phase +32 clk each' }); S.ann = { kind: 'phase', alpha: 0 }; await tween(600, (k) => { S.ann.alpha = k; }, sig);

    // 5. cursor sweep across the period with live value readout
    await tween(4200, (k) => { S.cursor = startP + k * P; }, sig, easeIO);
    await sleep(600);
    S.cursor = startP + P * 0.62; S.dirty = true;

    const edges = d.signals.reduce((n, s) => n + (s.clock ? Math.floor(d.endNs / s.clock.periodNs) * 2 : s.changes.length - 1), 0);
    ctx.emit('metric', { key: 'wave_sim_time', label: 'Simulated time', value: +(d.endNs / 1000).toFixed(2), unit: 'µs' });
    ctx.emit('metric', { key: 'wave_transitions', label: 'Signal transitions inspected', value: edges, unit: '' });
    ctx.emit('metric', { key: 'wave_pwm_period', label: 'PWM period', value: +(P / 1000).toFixed(2), unit: 'µs' });
    ctx.emit('metric', { key: 'wave_led_phase', label: 'LED phase shift', value: 32, unit: 'clk' });
    S.hwHold = true; // the circuit now plays on its own; stop cursor-sync seeks
    S.hw?.highlight({ duty: 'hits 255', dir: 'flips to dimming' });
    callout('At <b>duty = 255</b> the up/down register <b>dir</b> flips to 0 and the brightness ramps back down: the LEDs breathe out.');
    ctx.narrate('Duty hits 255, dir flips, the LEDs dim. Can a script prove it?');
    if (S.hw) { try { await S.hw.play(4078, 4120, 20 * ctx.speed, { signal: sig }); } catch (e) { if (e?.name === 'AbortError') throw e; } }
    else await sleep(2100);
    await sleep(1200);
  },

  unmount() {
    if (!S) return;
    cancelAnimationFrame(S.raf); S.ro?.disconnect(); try { S.hw?.destroy(); } catch {}
    document.querySelectorAll('.gw-ghost').forEach(n => n.remove());
    S = null;
  },
};
