// hwsim.js: live hardware view of real/rtl/pwm_led.v, driven by the real Icarus VCD
// (data/hw-trace.json, made by real/hwsim/vcd2trace.mjs).
//
//   import { mountHwSim } from '../../components/hwsim/hwsim.js';
//   const hw = mountHwSim(el, { trace, color: '#ea580c', mode: 'full' });
//   await hw.play(0, 899, 120);           // cycles from..to at 120 cycles/s
//   hw.seek(643); hw.on('marker', m => ...); hw.destroy();
//
// trace: the parsed hw-trace.json object, a URL, or omitted (loads data/hw-trace.json).
// mode:  'full' (whole RTL block diagram) | 'compact' (key registers + LED row).

const NS = 'http://www.w3.org/2000/svg';
const DEFAULT_TRACE = new URL('../../data/hw-trace.json', import.meta.url).href;
const PAL = { clk: '#71717a', rst: '#ef4444', pre: '#7c3aed', cnt: '#0891b2', duty: '#2563eb', dir: '#f59e0b', on: '#10b981', onDark: '#059669' };
const OFF = '#f4f4f5';
const MARK = { pass: '#16a34a', fail: '#dc2626', event: '#f59e0b', reset: '#ef4444' };

// ---------- helpers
function h(tag, attrs = {}, parent, text) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
const bin = (v, w) => v.toString(2).padStart(w, '0');
const fmtInt = v => v.toLocaleString('en-US');
const fmtTime = ns => (ns >= 1000 ? (ns / 1000).toFixed(2) + ' µs' : ns.toFixed(0) + ' ns');
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const c = [16, 8, 0].map(s => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t));
  return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function loadTrace(src = DEFAULT_TRACE) {
  const r = await fetch(src);
  if (!r.ok) throw new Error(`hwsim: ${src} ${r.status}`);
  return r.json();
}

// Accepts the columnar file or an array of per-cycle rows {t_ns, rst, pre, pwm_cnt, duty, dir, led}.
function normalize(tr) {
  if (Array.isArray(tr)) {
    const cols = { t_ns: [], rst: [], pre: [], pwm_cnt: [], duty: [], dir: [], led: [], on0: [] };
    for (const r of tr) for (const k in cols) cols[k].push(r[k] ?? null);
    tr = { cols, n: tr.length, markers: [], windows: {}, params: { DIV: 4 } };
  }
  const c = tr.cols, n = c.duty.length;
  // prefix sums of each LED bit -> perceived brightness over any window
  const ps = Array.from({ length: 8 }, () => new Uint32Array(n + 1));
  for (let k = 0; k < n; k++) for (let i = 0; i < 8; i++) ps[i][k + 1] = ps[i][k] + ((c.led[k] >> i) & 1);
  return { ...tr, n, cols: c, ps, DIV: tr.params?.DIV ?? 4, markers: tr.markers || [], windows: tr.windows || {} };
}

function stateAt(T, k) {
  const c = T.cols, pre = c.pre[k], full = (1 << T.DIV) - 1;
  const cmp = [];
  for (let i = 0; i < 8; i++) { const sum = (c.pwm_cnt[k] + 32 * i) & 255; cmp.push({ sum, on: sum < c.duty[k] }); }
  return { cycle: k, t_ns: c.t_ns[k], rst: c.rst[k], pre, tick: pre === full ? 1 : 0, pwm_cnt: c.pwm_cnt[k], duty: c.duty[k], dir: c.dir[k], led: c.led[k], on0: c.on0?.[k] ?? null, cmp };
}

// ---------- public API
export function mountHwSim(el, opts = {}) {
  const mode = opts.mode === 'compact' ? 'compact' : 'full';
  const color = opts.color || getComputedStyle(el).getPropertyValue('--tool').trim() || '#2563eb';
  const showWidths = opts.widths !== false;
  // chrome = the RUN pill, cycle readout and timeline. chrome:false (e.g. lint / formal scenes, where no
  // clock is running) hides them; a later setChrome(true) brings back the pill + readout.
  let chrome = opts.chrome !== false;
  const showTimeline = opts.timeline ?? chrome;
  const o = { color, showTimeline, showWidths, label: opts.label, driver: opts.driver, glow: opts.glow };
  const persist = Math.max(1, opts.persistence ?? (opts.glow === 'big' ? 24 : 1));

  // Fill mode: the host has its own height (a grid cell, an absolutely positioned box) -> the SVG fills it
  // edge to edge and the full diagram re-lays itself out for the host's aspect ratio. Otherwise height
  // follows width. Detected live (hosts are often laid out after mount), unless opts.fill forces it.
  const root = document.createElement('div');
  const detectFill = () => {
    if (opts.fill != null) return !!opts.fill;
    const was = root.style.display;
    root.style.display = 'none';                       // measure the host without our own content
    const hh = el.clientHeight;
    root.style.display = was;
    return hh > 60;
  };
  let fill = opts.fill ?? el.clientHeight > 60;
  root.className = `hwsim hwsim-${mode}` + (fill ? ' hwsim-fill' : '') + (chrome ? '' : ' hw-nochrome');
  root.style.setProperty('--hw-color', color);
  el.appendChild(root);

  const listeners = {};
  const emit = (ev, ...a) => (listeners[ev] || []).forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } });

  let T = null, view = null, cur = 0, raf = 0, run = null, destroyed = false, win = 1, prev = null, hlSpec = {}, geo = null, ro = null;
  const lastPulse = new Map();
  const queue = [];

  // viewBox geometry for the full diagram from the box we have to fill
  function fitGeo() {
    if (mode !== 'full') return null;
    const w = el.clientWidth || 1100, h = el.clientHeight;
    const r = fill && h > 60 ? (w - 16) / (h - 12) : 1.9;   // minus .hwsim-fill padding
    return fullGeometry(r, showTimeline);
  }
  function build() {
    root.replaceChildren();
    geo = fitGeo();
    view = (mode === 'full' ? buildFull : buildCompact)(root, T, { ...o, geo });
    if (view.track) bindScrub(view.track);
    view.highlight(hlSpec);
  }

  const ready = (async () => {
    let tr = opts.trace;
    if (tr && typeof tr.then === 'function') tr = await tr;
    if (!tr || typeof tr === 'string' || tr instanceof URL) tr = await loadTrace(tr ? String(tr) : undefined);
    if (destroyed) return;
    T = normalize(tr);
    build();
    render(clamp(opts.startCycle ?? 0, 0, T.n - 1), true);
    if (typeof ResizeObserver !== 'undefined' && (opts.fill == null || (opts.fill && mode === 'full'))) {
      let pending = 0, trailing = 0;
      const refit = () => {
        if (destroyed) return;
        const f = detectFill();
        if (f !== fill) { fill = f; root.classList.toggle('hwsim-fill', f); }
        if (mode !== 'full') return;
        const g = fitGeo();
        if (!geo || g.tall !== geo.tall || Math.abs(g.W - geo.W) / geo.W > 0.02 || Math.abs(g.H - geo.H) / geo.H > 0.02) { build(); render(cur, true); }
      };
      // rAF for live resizes, plus a trailing check so the final size lands after a CSS size transition
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(pending); clearTimeout(trailing);
        pending = requestAnimationFrame(refit);
        trailing = setTimeout(refit, 500);
      });
      ro.observe(el);
      refit();
    }
    queue.splice(0).forEach(f => f());
  })();
  ready.catch(e => { root.textContent = String(e); console.error(e); });
  const whenReady = f => (T ? f() : queue.push(f));

  // ---- render one cycle (diffs against the last rendered state)
  function pulse(key, node, kf, ms = 420) {
    const now = performance.now();
    if (!node || now - (lastPulse.get(key) || 0) < 110) return;
    lastPulse.set(key, now);
    node.animate(kf, { duration: ms, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  function render(k, force = false) {
    k = clamp(Math.round(k), 0, T.n - 1);
    cur = k;
    const s = stateAt(T, k);
    const p = force ? null : prev;
    view.update(s, p, { win: Math.max(win, persist), T, pulse });
    if (!p || p.cycle !== s.cycle) emit('cycle', s);
    prev = s;
  }

  // ---- playback
  function stop(result = false) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (run) { const r = run; run = null; r.resolve(result); }
  }
  function play(from, to, speed = 60, { signal } = {}) {
    return new Promise(resolve => whenReady(() => {
      stop(false);
      from = clamp(from ?? cur, 0, T.n - 1);
      to = clamp(to ?? T.n - 1, 0, T.n - 1);
      const dirn = to >= from ? 1 : -1;
      let t0 = performance.now(), base = from, last = from;
      run = { resolve, speed, rebase(sp) { const now = performance.now(); base = cur; t0 = now; this.speed = sp; } };
      win = clamp(Math.round((speed / 60) * 3), 1, 256);
      signal?.addEventListener('abort', () => stop(false), { once: true });
      render(from, prev == null);
      const tick = now => {
        if (!run) return;
        let pos = base + dirn * ((now - t0) / 1000) * run.speed;
        const done = dirn > 0 ? pos >= to : pos <= to;
        if (done) pos = to;
        const k = Math.floor(pos);
        if (k !== last) {
          for (const m of T.markers) if ((dirn > 0 && m.cycle > last && m.cycle <= k) || (dirn < 0 && m.cycle < last && m.cycle >= k)) emit('marker', m);
          last = k;
          render(k);
        }
        if (done) { emit('end', stateAt(T, to)); stop(true); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }));
  }

  // ---- timeline scrubbing
  function bindScrub(track) {
    const svg = root.querySelector('svg');
    const toCycle = e => {
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
      return Math.round(((loc.x - track.x0) / (track.x1 - track.x0)) * (T.n - 1));
    };
    let drag = false;
    track.hit.addEventListener('pointerdown', e => { drag = true; track.hit.setPointerCapture(e.pointerId); stop(false); win = 1; render(toCycle(e)); emit('seek', cur); });
    track.hit.addEventListener('pointermove', e => { if (drag) { render(toCycle(e)); emit('seek', cur); } });
    track.hit.addEventListener('pointerup', () => { drag = false; });
  }

  // ---- highlight: which signals some agent (testbench, Python, solver) reads/writes
  function highlight(spec) {
    hlSpec = Array.isArray(spec) ? Object.fromEntries(spec.map(id => [id, ''])) : (spec || {});
    whenReady(() => view.highlight(hlSpec));
  }

  return {
    ready,
    get cycle() { return cur; },
    get trace() { return T; },
    get playing() { return !!run; },
    play,
    pause() { stop(false); },
    setSpeed(sp) { if (run) { run.rebase(sp); win = clamp(Math.round((sp / 60) * 3), 1, 256); } },
    seek(k) { whenReady(() => { stop(false); win = 1; render(k); }); },
    state(k) { return T ? stateAt(T, k ?? cur) : null; },
    highlight,
    // client-space point of a cycle on the timeline (to place HTML badges over it); null if hidden
    timelinePoint(cycle) {
      const svg = view?.svg, tr = view?.track;
      if (!svg || !tr || !T) return null;
      const vb = svg.viewBox.baseVal, m = svg.getScreenCTM();
      if (!m) return null;
      const pt = svg.createSVGPoint();
      pt.x = tr.x0 + (clamp(cycle, 0, T.n - 1) / (T.n - 1)) * (tr.x1 - tr.x0); pt.y = vb.height - 18;
      const q = pt.matrixTransform(m);
      return { x: q.x, y: q.y };
    },
    setChrome(on) { chrome = !!on; root.classList.toggle('hw-nochrome', !chrome); },
    // story text: label = header source text, driver = who drives clk/rst (e.g. 'driven by cocotb (Python)')
    setText({ label, driver } = {}) {
      if (label !== undefined) o.label = label;
      if (driver !== undefined) o.driver = driver;
      whenReady(() => { build(); render(cur, true); });
    },
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return () => { listeners[ev] = listeners[ev].filter(f => f !== fn); }; },
    destroy() { destroyed = true; stop(false); ro?.disconnect(); root.remove(); for (const k in listeners) delete listeners[k]; },
  };
}

// ---------- shared pieces
function textSetter(node) {
  let last;
  return v => { if (v !== last) { last = v; node.textContent = v; } };
}
function attrSetter(node, a) {
  let last;
  return v => { if (v !== last) { last = v; node.setAttribute(a, v); } };
}
function classSetter(node, c) {
  let last;
  return v => { if (v !== last) { last = v; node.classList.toggle(c, !!v); } };
}
function ledBrightness(T, k, i, win) {
  const a = Math.max(0, k + 1 - win);
  return (T.ps[i][k + 1] - T.ps[i][a]) / (k + 1 - a);
}
function clockTri(g, x, y) { return h('polygon', { class: 'hw-clktri', points: `${x},${y} ${x + 6},${y - 7} ${x + 12},${y}` }, g); }
function slash(g, x, y, label) {
  h('line', { class: 'hw-slash', x1: x - 4, y1: y + 5, x2: x + 4, y2: y - 5 }, g);
  h('text', { class: 'hw-width', x: x + 2, y: y - 8, 'text-anchor': 'middle' }, g, label);
}
function wave(g, x, y, w, hgt) {
  const q = w / 4;
  return h('path', { class: 'hw-wave', d: `M${x} ${y + hgt} h${q} v${-hgt} h${q} v${hgt} h${q} v${-hgt} h${q}` }, g);
}

function buildTimeline(svg, T, { x0, x1, y, spark = 0, color }) {
  const g = h('g', { class: 'hw-tl' }, svg);
  if (spark) {
    const pts = [];
    for (let k = 0; k < T.n; k += 8) pts.push(`${(x0 + (k / (T.n - 1)) * (x1 - x0)).toFixed(1)},${(y - 8 - (T.cols.duty[k] / 255) * spark).toFixed(1)}`);
    h('polyline', { class: 'hw-spark', points: pts.join(' ') }, g);
    h('text', { class: 'hw-tl-l', x: x0 - 8, y: y - 8 - spark / 2 + 3, 'text-anchor': 'end' }, g, 'duty');
  }
  h('rect', { class: 'hw-tl-track', x: x0, y: y - 2, width: x1 - x0, height: 4, rx: 2 }, g);
  const fill = h('rect', { class: 'hw-tl-fill', x: x0, y: y - 2, width: 0, height: 4, rx: 2 }, g);
  for (const m of T.markers) {
    const mx = x0 + (m.cycle / (T.n - 1)) * (x1 - x0);
    const t = h('line', { class: 'hw-tl-mark', x1: mx, x2: mx, y1: y - 7, y2: y + 7, stroke: MARK[m.kind] || '#a1a1aa' }, g);
    h('title', {}, t, `cycle ${fmtInt(m.cycle)}: ${m.label}`);
  }
  const head = h('circle', { class: 'hw-tl-head', cx: x0, cy: y, r: 5, fill: color }, g);
  const hit = h('rect', { class: 'hw-tl-hit', x: x0 - 6, y: y - 12 - spark, width: x1 - x0 + 12, height: 24 + spark }, g);
  const setW = attrSetter(fill, 'width'), setX = attrSetter(head, 'cx');
  return {
    g, x0, x1, hit,
    update(k) { const px = ((k / (T.n - 1)) * (x1 - x0)).toFixed(1); setW(px); setX((x0 + +px).toFixed(1)); },
  };
}

function regBox(g, { x, y, w, h: ht, title, accent, valueSize = 22 }) {
  const grp = h('g', { class: 'hw-reg' }, g);
  const box = h('rect', { class: 'hw-box', x, y, width: w, height: ht, rx: 8 }, grp);
  h('rect', { x: x + 1, y: y + 10, width: 3, height: ht - 20, rx: 1.5, fill: accent }, grp);
  h('text', { class: 'hw-title', x: x + 14, y: y + 18 }, grp, title);
  const val = h('text', { class: 'hw-val', x: x + 14, y: y + 18 + valueSize + 6, fill: accent, 'font-size': valueSize }, grp, '0');
  const sub = h('text', { class: 'hw-sub', x: x + w - 12, y: y + 18 + valueSize + 6, 'text-anchor': 'end' }, grp, '');
  const tri = clockTri(grp, x + 10, y + ht);
  const r = h('text', { class: 'hw-r', x: x + w - 10, y: y + 17, 'text-anchor': 'end' }, grp, 'R');
  return { grp, box, tri, val: textSetter(val), sub: textSetter(sub), r: classSetter(r, 'on'), geo: { x, y, w, h: ht } };
}

function makeHighlighter(svg, parts, color) {
  const layer = h('g', { class: 'hw-hl-layer' }, svg);
  return spec => {
    layer.replaceChildren();
    for (const id in parts) parts[id].grp?.classList.remove('hw-hl');
    for (const [id, label] of Object.entries(spec)) {
      const p = parts[id];
      if (!p) continue;
      p.grp?.classList.add('hw-hl');
      const { x, y, w } = p.geo;
      h('rect', { class: 'hw-hl-ring', x: x - 4, y: y - 4, width: w + 8, height: p.geo.h + 8, rx: 11, stroke: color }, layer);
      if (label) {
        const tw = label.length * 6.4 + 14;
        const lg = h('g', { class: 'hw-hl-pill fade' }, layer);
        h('rect', { x: x + w - tw, y: y - 22, width: tw, height: 16, rx: 8, fill: color }, lg);
        h('text', { x: x + w - tw / 2, y: y - 10.5, 'text-anchor': 'middle' }, lg, label);
      }
    }
  };
}

// ---------- FULL: block diagram of pwm_led.v
// Two layouts, both filling the box they're given:
//  'wide' : control path in a left column, the 8 comparator/flop/LED rows on the right (aspect >= ~1.4)
//  'tall' : control path across the top, wide rows underneath, larger type (narrow cells, aspect < ~1.4)
// The timeline always sits at x0=440, x1=W-28, y=H-18 (scenes place HTML badges on it).
const TOP = 58, PITCH_MIN = 46, PITCH_MAX = 90;
const BOTTOM = tl => (tl ? 62 : 34);   // without the timeline the legend still needs a row
const MIN_H = tl => TOP + 8 * PITCH_MIN + BOTTOM(tl);
const MAX_H = tl => TOP + 8 * PITCH_MAX + BOTTOM(tl);
const TALL_BELOW = 1.38, TALL_W = 860;

export function fullGeometry(r, showTimeline) {
  if (r < TALL_BELOW) {
    const H = clamp(TALL_W / r, 640, 1400);
    return { W: TALL_W, H: Math.round(H), tall: true };
  }
  let W = 1110, H = W / r;
  if (H < MIN_H(showTimeline)) { H = MIN_H(showTimeline); W = clamp(H * r, 1110, 1800); }
  H = Math.min(H, MAX_H(showTimeline));
  return { W: Math.round(W), H: Math.round(H), tall: false };
}

function layoutWide(W, H, tl) {
  const e = W - 1110, a = e * 0.4, b = e * 0.35, c = e * 0.25;
  const pitch = (H - TOP - BOTTOM(tl)) / 8;
  const bh = clamp(pitch - 12, 36, 56);
  const RY = i => TOP + i * pitch + (pitch - bh) / 2;
  const regH = clamp(pitch * 1.2, 62, 84), vs = regH >= 74 ? 24 : 22;
  const L = { W, H, tall: false, vs, bh, one: bh < 44, rowY: RY };
  L.cntX = 600 + a; L.dutyX = 624 + a; L.cmpX = 650 + a; L.cmpW = 180; L.ffX = 870 + a + b; L.ffW = 76; L.ledX = 1012 + a + b + c;
  L.pre = { x: 90, y: RY(0) + 6, w: 170, h: regH };
  L.gate = { x: 300, cy: L.pre.y + regH / 2 };
  const dutyY = Math.max(RY(1) + 4, L.gate.cy + 32);
  L.duty = { x: 400, y: dutyY, w: 170, h: regH };
  L.dir = { x: 400, y: dutyY + regH + clamp(pitch * 0.5, 24, 40), w: 170, h: regH - 14 };
  L.rst = { x: 24, y: RY(7) + bh - 34 };
  L.clk = { x: 24, y: L.rst.y - 58 };
  L.cnt = { x: 90, y: Math.max(L.clk.y - 26 - regH, L.pre.y + regH + 30), w: 170, h: regH };
  const gx = L.gate.x, gy = L.gate.cy;
  L.wPre = `M${L.pre.x + L.pre.w} ${gy} H${gx}`; L.preSlash = [280, gy];
  L.wTick = `M${gx + 40} ${gy} H372 V${dutyY + 18} H400`; L.tickLabel = [gx + 46, gy - 6, 'start'];
  const fbY = (dutyY + regH + L.dir.y) / 2 + 4;
  L.fb = [
    { d: `M450 ${L.dir.y} V${dutyY + regH}`, label: '±1', x: 444, y: fbY, anchor: 'end' },
    { d: `M520 ${dutyY + regH} V${L.dir.y}`, label: '==FF/00', x: 526, y: fbY, anchor: 'start' },
  ];
  const busY = clamp(L.dir.y + L.dir.h + 16, L.cnt.y + 16, L.cnt.y + regH - 12);
  const dBusY = dutyY + regH / 2;
  L.tC = Math.round(bh * 0.33); L.tD = Math.round(bh * 0.7);
  L.cntBus = `M${L.cnt.x + L.cnt.w} ${busY} H${L.cntX} M${L.cntX} ${Math.min(RY(0) + L.tC, busY)} V${Math.max(RY(7) + L.tC, busY)}`;
  L.dutyBus = `M${L.duty.x + L.duty.w} ${dBusY} H${L.dutyX} M${L.dutyX} ${Math.min(RY(0) + L.tD, dBusY)} V${Math.max(RY(7) + L.tD, dBusY)}`;
  L.cntSlash = [300, busY]; L.dutySlash = [590 + Math.min(a, 40), dBusY];
  L.heads = [
    [L.cmpX, TOP - 8, 'comparators  (pwm_cnt + 32·i) < duty'], [L.ffX, TOP - 8, 'output flops'], [L.ledX - 16, TOP - 8, 'LEDs'],
    [90, L.pre.y - 7, 'prescaler'], [400, dutyY - 7, 'brightness'], [90, L.cnt.y - 7, 'PWM carrier'],
  ];
  return L;
}

function layoutTall(W, H, tl) {
  // band A: pre, &pre, duty, dir | band B: clk/rst pins, pwm_cnt | rows below
  const regH = 78, vs = 26;
  const yA = TOP + 18, yB = yA + regH + 36, yC = yB + regH + 64;
  const pitch = clamp((H - yC - BOTTOM(tl)) / 8, 40, 120);
  const bh = clamp(pitch - 12, 34, 64);
  const RY = i => yC + i * pitch + (pitch - bh) / 2;
  const L = { W, H, tall: true, vs, bh, one: bh < 50, rowY: RY };
  L.cntX = 44; L.dutyX = 68; L.cmpX = 96; L.cmpW = 320; L.ffX = 476; L.ffW = 104; L.ledX = 656;
  L.pre = { x: 24, y: yA, w: 186, h: regH };
  L.gate = { x: 240, cy: yA + regH / 2 };
  L.duty = { x: 332, y: yA, w: 196, h: regH };
  L.dir = { x: 616, y: yA + 7, w: 196, h: regH - 14 };
  L.clk = { x: 24, y: yB + 4 };
  L.rst = { x: 24, y: yB + 48 };
  L.cnt = { x: 470, y: yB, w: 196, h: regH };
  const gx = L.gate.x, gy = L.gate.cy;
  L.wPre = `M${L.pre.x + L.pre.w} ${gy} H${gx}`; L.preSlash = [226, gy];
  L.wTick = `M${gx + 40} ${gy} H${L.duty.x}`; L.tickLabel = [gx + 46, gy - 8, 'start'];
  const dR = L.duty.x + L.duty.w, dL = L.dir.x;
  L.fb = [
    { d: `M${dL} ${yA + 26} H${dR}`, label: '±1', x: (dR + dL) / 2, y: yA + 20, anchor: 'middle' },
    { d: `M${dR} ${yA + 62} H${dL}`, label: '==FF/00', x: (dR + dL) / 2, y: yA + 80, anchor: 'middle' },
  ];
  L.tC = Math.round(bh * 0.33); L.tD = Math.round(bh * 0.7);
  // duty bus: down out of duty's bottom (between the pin tags and pwm_cnt), then left to its spine
  const dX = 420, dTurn = yC - 40, cTurn = yC - 26;
  L.dutyBus = `M${dX} ${yA + regH} V${dTurn} H${L.dutyX} M${L.dutyX} ${dTurn} V${RY(7) + L.tD}`;
  L.cntBus = `M${L.cnt.x + 60} ${L.cnt.y + regH} V${cTurn} H${L.cntX} M${L.cntX} ${cTurn} V${RY(7) + L.tC}`;
  L.cntSlash = [L.cnt.x + 60, L.cnt.y + regH + 14]; L.dutySlash = [dX, yA + regH + 30];
  L.heads = [
    [24, yA - 8, 'prescaler'], [L.duty.x, yA - 8, 'brightness'], [L.cnt.x, yB - 8, 'PWM carrier'],
    [L.cmpX, RY(0) - 8, 'comparators  (pwm_cnt + 32·i) < duty'], [L.ffX, RY(0) - 8, 'output flops'], [L.ledX - 16, RY(0) - 8, 'LEDs'],
  ];
  return L;
}

function buildFull(root, T, o) {
  const { color, showTimeline, showWidths, geo } = o;
  const W = geo?.W ?? 1110, H = geo?.H ?? Math.round(W / 1.9);
  const L = geo?.tall ? layoutTall(W, H, showTimeline) : layoutWide(W, H, showTimeline);
  const { bh, one, rowY: RY, cntX, dutyX, cmpX, cmpW, ffX, ffW, ledX, tC, tD } = L;
  const big = o.glow === 'big';

  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hw-svg' + (L.tall ? ' hw-tall' : ''), role: 'img', 'aria-label': 'pwm_led live hardware view', preserveAspectRatio: 'xMidYMid meet' });
  root.appendChild(svg);
  const parts = {};
  const wires = h('g', { class: 'hw-wires' }, svg);
  const pulses = h('g', { class: 'hw-pulses' }, svg);
  const nodes = h('g', {}, svg);
  const wire = (d, cls = '') => { const p = h('path', { class: 'hw-wire ' + cls, d }, wires); const ov = h('path', { class: 'hw-pulse', d }, pulses); return { p, o: ov }; };

  // header
  const head = h('text', { class: 'hw-head', x: 24, y: 26 }, svg);
  h('tspan', {}, head, `pwm_led #(.DIV(${T.DIV}))`);
  h('tspan', { class: 'hw-head-sub', dx: 10 }, head, o.label ?? 'tb_pwm_led.dut · Icarus VCD');
  const runPill = h('g', { class: 'hw-chrome' }, svg);
  h('rect', { x: W - 316, y: 12, width: 56, height: 21, rx: 10.5, class: 'hw-run' }, runPill);
  const runTxt = h('text', { x: W - 288, y: 26.5, 'text-anchor': 'middle', class: 'hw-run-t' }, runPill, 'RUN');
  const ro = h('text', { class: 'hw-readout hw-chrome', x: W - 24, y: 27, 'text-anchor': 'end' }, svg);
  h('tspan', {}, ro, 'cycle ');
  const roC = h('tspan', { class: 'hw-readout-c', fill: color }, ro, '0');
  const roT = h('tspan', {}, ro, ' · 0 ns');
  for (const [x, y, t] of L.heads) h('text', { class: 'hw-col', x, y }, svg, t);

  // prescaler + &pre
  const pre = regBox(nodes, { ...L.pre, title: `pre [${T.DIV - 1}:0]`, accent: PAL.pre, valueSize: L.vs });
  parts.pre = pre;
  const gx = L.gate.x, gy = L.gate.cy;
  const gate = h('path', { class: 'hw-gate', d: `M${gx} ${gy - 20} h18 a20 20 0 0 1 0 40 h-18 z` }, nodes);
  h('text', { class: 'hw-gate-t', x: gx + 18, y: gy + 5, 'text-anchor': 'middle' }, nodes, '&');
  h('text', { class: 'hw-tag', x: gx + 18, y: gy + 36, 'text-anchor': 'middle' }, nodes, '&pre');
  parts.tick = { grp: gate, geo: { x: gx, y: gy - 20, w: 40, h: 40 } };
  const wPre = wire(L.wPre);
  if (showWidths) slash(nodes, L.preSlash[0], L.preSlash[1], String(T.DIV));
  const wTick = wire(L.wTick, 'hw-tick');
  h('text', { class: 'hw-tag', x: L.tickLabel[0], y: L.tickLabel[1], 'text-anchor': L.tickLabel[2] }, nodes, 'tick');

  // duty + dir
  const duty = regBox(nodes, { ...L.duty, title: 'duty [7:0]', accent: PAL.duty, valueSize: L.vs });
  parts.duty = duty;
  const barW = L.duty.w - 28;
  const dutyBar = h('rect', { x: L.duty.x + 14, y: L.duty.y + L.duty.h - 12, width: 0, height: 3, rx: 1.5, fill: PAL.duty, opacity: 0.35 }, nodes);
  const dir = regBox(nodes, { ...L.dir, title: 'dir  (up/down FSM)', accent: PAL.dir, valueSize: L.tall ? 21 : 18 });
  parts.dir = dir;
  const dirArrow = h('path', { fill: PAL.dir, d: '' }, nodes);
  const [fbA, fbB] = L.fb.map(f => {
    const w = wire(f.d, 'hw-fb');
    h('text', { class: 'hw-tag', x: f.x, y: f.y, 'text-anchor': f.anchor }, nodes, f.label);
    return w;
  });

  // pins (net labels: every flop has the clock triangle and an R input)
  const pins = h('g', {}, nodes);
  const { x: px, y: clkY } = L.clk, rstY = L.rst.y;
  const clkPin = h('g', { class: 'hw-pin' }, pins);
  h('rect', { class: 'hw-box', x: px, y: clkY, width: 92, height: 34, rx: 8 }, clkPin);
  const clkWave = wave(clkPin, px + 10, clkY + 10, 28, 14);
  h('text', { class: 'hw-pin-t', x: px + 46, y: clkY + 22 }, clkPin, 'clk');
  const wClk = wire(`M${px + 92} ${clkY + 17} H${px + 144}`, 'hw-clk');
  h('text', { class: 'hw-tag', x: px + 150, y: clkY + 14 }, nodes, '25 MHz → every flop');
  h('text', { class: 'hw-tag hw-faint', x: px + 150, y: clkY + 28 }, nodes, `${T.clk_period_ns ?? 40} ns period`);
  parts.clk = { grp: clkPin, geo: { x: px, y: clkY, w: 92, h: 34 } };
  const rstPin = h('g', { class: 'hw-pin hw-rstpin' }, pins);
  h('rect', { class: 'hw-box', x: px, y: rstY, width: 92, height: 34, rx: 8 }, rstPin);
  const rstVal = h('text', { class: 'hw-pin-v', x: px + 14, y: rstY + 22 }, rstPin, '1');
  h('text', { class: 'hw-pin-t', x: px + 46, y: rstY + 22 }, rstPin, 'rst');
  const wRst = wire(`M${px + 92} ${rstY + 17} H${px + 144}`, 'hw-rst');
  h('text', { class: 'hw-tag', x: px + 150, y: rstY + 14 }, nodes, 'sync reset → R on every flop');
  h('text', { class: 'hw-tag hw-faint hw-driver', x: px + 150, y: rstY + 28 }, nodes, o.driver ?? 'driven by tb_pwm_led');
  parts.rst = { grp: rstPin, geo: { x: px, y: rstY, w: 92, h: 34 } };

  // pwm counter
  const cnt = regBox(nodes, { ...L.cnt, title: 'pwm_cnt [7:0]', accent: PAL.cnt, valueSize: L.vs });
  parts.pwm_cnt = cnt;
  const cntBar = h('rect', { x: L.cnt.x + 14, y: L.cnt.y + L.cnt.h - 12, width: 0, height: 3, rx: 1.5, fill: PAL.cnt, opacity: 0.35 }, nodes);

  // buses
  const wCntBus = wire(L.cntBus, 'hw-bus hw-cntbus');
  const wDutyBus = wire(L.dutyBus, 'hw-bus hw-dutybus');
  if (showWidths) { slash(nodes, L.cntSlash[0], L.cntSlash[1], '8'); slash(nodes, L.dutySlash[0], L.dutySlash[1], '8'); }

  // comparator / flop / LED rows
  const lr = clamp(bh * 0.3, 11, L.tall ? 18 : 15) * (big ? 1.3 : 1);
  const haloR = lr * (big ? 2.0 : 1.85);
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const y = RY(i), cy = y + bh / 2;
    const cg = h('g', { class: 'hw-cmp' }, nodes);
    wire(`M${cntX} ${y + tC} H${cmpX}`, 'hw-bus hw-cntbus');
    wire(`M${dutyX} ${y + tD} H${cmpX}`, 'hw-bus hw-dutybus');
    h('circle', { class: 'hw-dot', cx: cntX, cy: y + tC, r: 2.5, fill: PAL.cnt }, wires);
    h('circle', { class: 'hw-dot', cx: dutyX, cy: y + tD, r: 2.5, fill: PAL.duty }, wires);
    h('rect', { class: 'hw-box hw-cmpbox', x: cmpX, y, width: cmpW, height: bh, rx: 8 }, cg);
    const lbl = one ? (i ? `+${32 * i}` : 'cnt') : (i ? `cnt + ${32 * i}` : 'cnt');
    h('text', { class: 'hw-title', x: cmpX + 12, y: one ? cy + 4.5 : y + 16 }, cg, L.tall && one ? (i ? `cnt + ${32 * i}` : 'cnt') : lbl);
    const ct = h('text', { class: 'hw-cmp-t', x: one ? cmpX + cmpW - 32 : cmpX + 12, y: one ? cy + 6 : y + bh - 9, 'text-anchor': one ? 'end' : 'start' }, cg);
    const cs = h('tspan', {}, ct, '0'); h('tspan', { class: 'hw-lt' }, ct, ' < '); const cd = h('tspan', { fill: PAL.duty }, ct, '0');
    h('circle', { class: 'hw-cdot', cx: cmpX + cmpW - 18, cy, r: L.tall ? 6 : 5 }, cg);
    parts['cmp' + i] = { grp: cg, geo: { x: cmpX, y, w: cmpW, h: bh } };
    const wD = wire(`M${cmpX + cmpW} ${cy} H${ffX}`, 'hw-d');
    const fg = h('g', { class: 'hw-ff' }, nodes);
    h('rect', { class: 'hw-box hw-ffbox', x: ffX, y, width: ffW, height: bh, rx: 8 }, fg);
    const ffOne = L.tall && one;
    h('text', { class: 'hw-title', x: ffX + 10, y: ffOne ? cy + 4.5 : y + (one ? 13 : 16) }, fg, `led[${i}]`);
    const q = h('text', { class: 'hw-q', x: ffX + ffW - 12, y: ffOne ? cy + 6.5 : y + bh - 7, 'text-anchor': 'end' }, fg, '0');
    const ftri = clockTri(fg, ffX + 8, y + bh);
    parts['ff' + i] = { grp: fg, geo: { x: ffX, y, w: ffW, h: bh } };
    const wQ = wire(`M${ffX + ffW} ${cy} H${ledX - lr}`, 'hw-q-w');
    const lg = h('g', { class: 'hw-led' }, nodes);
    const halo = h('circle', { cx: ledX, cy, r: haloR, fill: PAL.on, opacity: 0 }, lg);
    const body = h('circle', { class: 'hw-led-b', cx: ledX, cy, r: lr, fill: OFF }, lg);
    h('circle', { cx: ledX - lr * 0.3, cy: cy - lr * 0.3, r: lr * 0.27, fill: '#fff', opacity: 0.7 }, lg);
    const lx = ledX + Math.max(lr + 16, haloR + 4);
    h('text', { class: 'hw-title', x: lx, y: cy - 2 }, lg, `LED${i}`);
    const pct = h('text', { class: 'hw-pct', x: lx, y: cy + 14 }, lg, '0%');
    parts['led' + i] = { grp: lg, geo: { x: ledX - lr - 8, y, w: lx - ledX + lr + 50, h: bh } };
    rows.push({ cs: textSetter(cs), cd: textSetter(cd), on: classSetter(cg, 'on'), q: textSetter(q), qOn: classSetter(fg, 'on'), ftri, wD, wQ, wDon: classSetter(wD.p, 'on'), wQon: classSetter(wQ.p, 'on'),
      halo: attrSetter(halo, 'opacity'), body: attrSetter(body, 'fill'), bodyS: attrSetter(body, 'stroke'), pct: textSetter(pct) });
  }
  parts.cmps = { geo: { x: cmpX, y: RY(0), w: cmpW, h: RY(7) + bh - RY(0) } };
  parts.leds = { geo: { x: ledX - lr - 8, y: RY(0), w: parts.led0.geo.w, h: RY(7) + bh - RY(0) } };

  // legend + timeline (timeline position is a contract: x0=440, x1=W-28, y=H-18)
  const tl = showTimeline ? buildTimeline(svg, T, { x0: 440, x1: W - 28, y: H - 18, spark: 26, color }) : null;
  tl?.g.classList.add('hw-chrome');
  const legend = h('g', { class: 'hw-legend' }, svg);
  const ly = H - 14;
  let lgx = 24;
  [['clk', PAL.clk], ['duty', PAL.duty], ['dir', PAL.dir], ['true / on', PAL.on], ['active', color]].forEach(([l, c]) => {
    h('circle', { cx: lgx, cy: ly - 4, r: 4, fill: c }, legend);
    h('text', { x: lgx + 9, y: ly }, legend, l);
    lgx += 9 + l.length * 6.6 + 18;
  });

  const setRun = classSetter(runPill, 'reset'), setRunT = textSetter(runTxt), setRst = textSetter(rstVal), setRstOn = classSetter(rstPin, 'on');
  const setRoC = textSetter(roC), setRoT = textSetter(roT);
  const setTick = classSetter(wTick.p, 'on'), setGate = classSetter(gate, 'on');
  const setDutyBar = attrSetter(dutyBar, 'width'), setCntBar = attrSetter(cntBar, 'width'), setArrow = attrSetter(dirArrow, 'd');
  const regs = [pre, duty, dir, cnt];
  const tris = [pre.tri, duty.tri, dir.tri, cnt.tri, ...rows.map(r => r.ftri)];
  const highlight = makeHighlighter(svg, parts, color);
  const ax = L.dir.x + (L.tall ? 84 : 70), ay = L.dir.y + L.dir.h / 2;
  const arrowUp = `M${ax} ${ay + 14} l7 -9 l7 9 z`, arrowDn = `M${ax} ${ay + 5} l7 9 l7 -9 z`;
  const haloK = big ? 0.38 : 0.22;

  const kfWire = c => [{ stroke: c, opacity: 1 }, { stroke: c, opacity: 0 }];
  const kfBox = c => [{ stroke: c, strokeWidth: 2 }, { stroke: '#e4e4e7', strokeWidth: 1 }];

  return {
    track: tl, highlight, svg,
    update(s, p, { win, T, pulse }) {
      const k = s.cycle;
      setRoC(fmtInt(k)); setRoT(' · ' + fmtTime(s.t_ns));
      setRun(s.rst); setRunT(s.rst ? 'RESET' : 'RUN');
      setRst(String(s.rst)); setRstOn(s.rst);
      regs.forEach(r => r.r(s.rst));
      pre.val(bin(s.pre, T.DIV)); pre.sub('= ' + s.pre);
      setTick(s.tick); setGate(s.tick);
      duty.val(String(s.duty)); duty.sub('0x' + hex2(s.duty));
      setDutyBar(((s.duty / 255) * barW).toFixed(1));
      dir.val(s.dir ? 'up' : 'down'); dir.sub(s.dir ? 'dir = 1' : 'dir = 0');
      setArrow(s.dir ? arrowUp : arrowDn);
      cnt.val(String(s.pwm_cnt)); cnt.sub('0x' + hex2(s.pwm_cnt));
      setCntBar(((s.pwm_cnt / 255) * (L.cnt.w - 28)).toFixed(1));
      for (let i = 0; i < 8; i++) {
        const r = rows[i], c = s.cmp[i], q = (s.led >> i) & 1;
        r.cs(String(c.sum)); r.cd(String(s.duty)); r.on(c.on); r.wDon(c.on);
        r.q(String(q)); r.qOn(q); r.wQon(q);
        const br = ledBrightness(T, k, i, win);
        r.halo((br * haloK).toFixed(3)); r.body(mix(OFF, PAL.on, br)); r.bodyS(br > 0.02 ? PAL.onDark : '#d4d4d8');
        r.pct(Math.round(br * 100) + '%');
      }
      tl?.update(k);
      if (!p) return;
      // clock-edge ripple: pin, then every flop's clock triangle, left to right
      if (s.cycle !== p.cycle) {
        pulse('clk', wClk.o, kfWire(PAL.clk), 300);
        pulse('clkw', clkWave, [{ stroke: color }, { stroke: PAL.clk }], 300);
        const now = performance.now();
        if (now - (this._lastRipple || 0) > 110) {
          this._lastRipple = now;
          tris.forEach(t => t.animate([{ fill: color }, { fill: color, offset: 0.3 }, { fill: '#d4d4d8' }],
            { duration: 420, delay: (+t.getAttribute('points').split(',')[0] / W) * 140, easing: 'ease-out' }));
        }
      }
      if (s.rst !== p.rst) pulse('rst', wRst.o, kfWire(PAL.rst), 600);
      if (s.pre !== p.pre) { pulse('pre', wPre.o, kfWire(PAL.pre)); pulse('preb', pre.box, kfBox(PAL.pre)); }
      if (s.tick && !p.tick) pulse('tick', wTick.o, kfWire(PAL.pre), 520);
      if (s.duty !== p.duty) { pulse('duty', wDutyBus.o, kfWire(PAL.duty), 520); pulse('dutyb', duty.box, kfBox(PAL.duty), 600); pulse('dd', fbA.o, kfWire(PAL.dir)); }
      if (s.dir !== p.dir) { pulse('dir', dir.box, kfBox(PAL.dir), 900); pulse('ddir', fbB.o, kfWire(PAL.dir), 900); }
      if (s.pwm_cnt !== p.pwm_cnt) { pulse('cnt', wCntBus.o, kfWire(PAL.cnt), 360); pulse('cntb', cnt.box, kfBox(PAL.cnt), 360); }
      for (let i = 0; i < 8; i++) {
        if (s.cmp[i].on !== p.cmp[i].on) pulse('d' + i, rows[i].wD.o, kfWire(PAL.on));
        if (((s.led ^ p.led) >> i) & 1) pulse('q' + i, rows[i].wQ.o, kfWire(PAL.on));
      }
    },
  };
}

// ---------- COMPACT: key registers + LED row (side panels)
function buildCompact(root, T, { color, showTimeline, label, glow }) {
  const big = glow === 'big';
  const W = 600, H = showTimeline ? 214 : 192;
  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hw-svg', role: 'img', 'aria-label': 'pwm_led live hardware view (compact)', preserveAspectRatio: 'xMidYMid meet' });
  root.appendChild(svg);
  const parts = {};
  h('text', { class: 'hw-head', x: 14, y: 20 }, svg, 'pwm_led');
  h('text', { class: 'hw-head-sub', x: 74, y: 20 }, svg, label ? '· ' + label : '· live registers');
  const ro = h('text', { class: 'hw-readout hw-chrome', x: W - 14, y: 20, 'text-anchor': 'end' }, svg);
  h('tspan', {}, ro, 'cycle ');
  const roC = h('tspan', { class: 'hw-readout-c', fill: color }, ro, '0');
  const roT = h('tspan', {}, ro, ' · 0 ns');

  const chip = (x, w, label, accent) => {
    const grp = h('g', { class: 'hw-reg hw-chip' }, svg);
    const box = h('rect', { class: 'hw-box', x, y: 32, width: w, height: 50, rx: 8 }, grp);
    h('text', { class: 'hw-title', x: x + 10, y: 49 }, grp, label);
    const v = h('text', { class: 'hw-val', x: x + 10, y: 72, fill: accent, 'font-size': 16 }, grp, '0');
    return { grp, box, val: textSetter(v), geo: { x, y: 32, w, h: 50 }, x };
  };
  const clk = chip(14, 64, 'clk', PAL.clk);
  const clkWave = wave(clk.grp, 24, 60, 40, 13);
  clk.val('');
  const rst = chip(84, 52, 'rst', PAL.rst);
  const pre = chip(142, 74, `pre [${T.DIV - 1}:0]`, PAL.pre);
  const cnt = chip(222, 96, 'pwm_cnt', PAL.cnt);
  const duty = chip(324, 152, 'duty', PAL.duty);
  const dutyBar0 = h('rect', { x: 372, y: 64, width: 94, height: 5, rx: 2.5, fill: OFF }, svg);
  const dutyBar = h('rect', { x: 372, y: 64, width: 0, height: 5, rx: 2.5, fill: PAL.duty }, svg);
  void dutyBar0;
  const dir = chip(482, 104, 'dir', PAL.dir);
  const dirArrow = h('path', { fill: PAL.dir }, svg);
  Object.assign(parts, { clk, rst, pre, pwm_cnt: cnt, duty, dir });

  const leds = [];
  h('text', { class: 'hw-tag', x: 14, y: 128 }, svg, 'led');
  h('text', { class: 'hw-tag', x: 14, y: 172 }, svg, 'cmp');
  for (let i = 0; i < 8; i++) {
    const cx = 74 + i * 70, cy = 124;
    const g = h('g', { class: 'hw-led' }, svg);
    const lr = big ? 15 : 12;
    const halo = h('circle', { cx, cy, r: big ? 32 : 22, fill: PAL.on, opacity: 0 }, g);
    const body = h('circle', { class: 'hw-led-b', cx, cy, r: lr, fill: OFF }, g);
    h('circle', { cx: cx - lr / 3, cy: cy - lr / 3, r: lr / 4, fill: '#fff', opacity: 0.7 }, g);
    h('text', { class: 'hw-title', x: cx, y: 155, 'text-anchor': 'middle' }, g, `led${i}`);
    const cg = h('g', { class: 'hw-cmp' }, svg);
    const cdot = h('circle', { class: 'hw-cdot', cx, cy: 169, r: 4 }, cg);
    void cdot;
    parts['led' + i] = { grp: g, geo: { x: cx - 26, y: cy - 26, w: 52, h: 52 } };
    parts['cmp' + i] = { grp: cg, geo: { x: cx - 8, y: 161, w: 16, h: 16 } };
    leds.push({ halo: attrSetter(halo, 'opacity'), body: attrSetter(body, 'fill'), bodyS: attrSetter(body, 'stroke'), on: classSetter(cg, 'on') });
  }
  parts.leds = { geo: { x: 48, y: 98, w: 540, h: 52 } };
  const tl = showTimeline ? buildTimeline(svg, T, { x0: 14, x1: W - 14, y: 200, color }) : null;
  tl?.g.classList.add('hw-chrome');
  const haloK = big ? 0.38 : 0.22;
  const highlight = makeHighlighter(svg, parts, color);
  const setRoC = textSetter(roC), setRoT = textSetter(roT), setBar = attrSetter(dutyBar, 'width'), setArrow = attrSetter(dirArrow, 'd'), setRstOn = classSetter(rst.grp, 'on');
  const kfBox = c => [{ stroke: c, strokeWidth: 2 }, { stroke: '#e4e4e7', strokeWidth: 1 }];

  return {
    track: tl, highlight, svg,
    update(s, p, { win, T, pulse }) {
      const k = s.cycle;
      setRoC(fmtInt(k)); setRoT(' · ' + fmtTime(s.t_ns));
      rst.val(String(s.rst)); setRstOn(s.rst);
      pre.val(bin(s.pre, T.DIV));
      cnt.val(`${s.pwm_cnt}`);
      duty.val(String(s.duty)); setBar(((s.duty / 255) * 94).toFixed(1));
      dir.val(s.dir ? 'up' : 'down');
      setArrow(s.dir ? 'M560 70 l6 -8 l6 8 z' : 'M560 62 l6 8 l6 -8 z');
      for (let i = 0; i < 8; i++) {
        const b = ledBrightness(T, k, i, win), L = leds[i];
        L.halo((b * haloK).toFixed(3)); L.body(mix(OFF, PAL.on, b)); L.bodyS(b > 0.02 ? PAL.onDark : '#d4d4d8'); L.on(s.cmp[i].on);
      }
      tl?.update(k);
      if (!p) return;
      if (s.cycle !== p.cycle) pulse('clk', clkWave, [{ stroke: color }, { stroke: PAL.clk }], 300);
      if (s.pre !== p.pre) pulse('pre', pre.box, kfBox(PAL.pre), 300);
      if (s.pwm_cnt !== p.pwm_cnt) pulse('cnt', cnt.box, kfBox(PAL.cnt), 300);
      if (s.duty !== p.duty) pulse('duty', duty.box, kfBox(PAL.duty), 500);
      if (s.dir !== p.dir) pulse('dir', dir.box, kfBox(PAL.dir), 900);
    },
  };
}
