// 10-freerouting: the real Freerouting v2.4.1 headless run on our carrier board.
// Board, pads, airwires, routed traces and vias are the real DSN/SES geometry (data/10-freerouting.json).
// KiCad-light palette on a white canvas
const COL = {
  bg: '#fafafa', board: '#ffffff', edge: '#b8930f', grid: 'rgba(10,10,10,.045)',
  F: '#c83434', B: '#3b63d8', pad: '#c9a227', padDim: 'rgba(201,162,39,.45)', via: '#c8961e',
  drill: '#3f3f46', body: 'rgba(184,147,15,.55)', silk: '#b8930f', hole: '#a1a1aa', rat: '#9ca3af', warn: '#d97706',
};
const HELD = ['USB_DN', 'USB_DP'];          // illustrative: the real log reports 2 unrouted after pass #1 but not which nets
const U1 = { x0: 23, x1: 33, y0: 10, y1: 20 };

const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt2 = v => v.toFixed(2);

const ICON = {
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.5 3.5L5 5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5"/><circle cx="8" cy="8" r="4.3"/>',
  wand: '<path d="M2.4 13.6l8.2-8.2M9.2 4l2.8 2.8"/><path d="M12.6 1.4v2.4M11.4 2.6h2.4M14.2 6.2v1.6M13.4 7h1.6M4.6 1.8v1.8M3.7 2.7h1.8"/>',
  stop: '<circle cx="8" cy="8" r="5.6"/><path d="M4 4l8 8"/>',
  trash: '<path d="M2.8 4.4h10.4M6 4.4V2.8h4v1.6M4.4 4.4l.7 9h5.8l.7-9"/>',
  undo: '<path d="M5.2 3.6L2.4 6.4l2.8 2.8M2.4 6.4h7.4a3.3 3.3 0 010 6.6H7.4"/>',
  redo: '<path d="M10.8 3.6l2.8 2.8-2.8 2.8M13.6 6.4H6.2a3.3 3.3 0 000 6.6h2.4"/>',
  incomplete: '<path d="M8 1.8l1.9 4.1 4.4.5-3.3 3 .9 4.4L8 11.6l-3.9 2.2.9-4.4-3.3-3 4.4-.5z"/><path d="M8 5.2v3.2"/>',
  violations: '<path d="M2.2 3.8l1.1 1.1L5.4 2.8M2.2 8.6l1.1 1.1 2.1-2.1M7.6 4h6.2M7.6 8.8h6.2M7.6 13.4h6.2M2.4 13.4h3"/>',
  zin: '<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14M5 7h4M7 5v4"/>',
  zout: '<circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14M5 7h4"/>',
};
const ico = (k) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

let st = null;

function polyMeta(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { cum, len: cum[cum.length - 1] };
}

function trimLog(line) {
  let s = line.replace(/^(\d\d:\d\d:\d\d)\.\d+\s+INFO\s+/, '$1  ');
  s = s.replace(/ \(\d+ SMD pins still to check.*?\)\./, '.');
  s = s.replace(/, using [\d.]+ (total )?CPU seconds.*$/, '.');
  s = s.replace(/'[A-Z]:\\.*?\\(real\\pcb\\[^']+)'/, "'$1'");
  return s;
}

export default {
  id: '10-freerouting', tool: 'Freerouting', title: 'Autorouting the board', css: true,

  async mount(root, ctx) {
    const d = await ctx.data('10-freerouting');
    st = { d, ctx, root, tweens: [], raf: 0, alive: true, shimmer: -1, ratA: 1, tip: null, tipT: 0, xyText: '' };
    const P = d.passes;
    const rd = (k, label, v, sub) => `<div class="rd" data-r="${k}"><label>${label}</label><b>${v}</b><small>${sub}</small></div>`;
    const chip = (kind, p, label) => `<div class="fr-chip" data-k="${kind}${p.n ?? ''}"><b>${label}</b><span>✓ ${p.secs != null ? fmt2(p.secs) + 's' : ''}${kind === 'o' ? ' · stopped early' : ''}</span></div>`;
    root.innerHTML = `
    <div class="fr10">
      <div class="glass window fr-win">
        <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div>
          <div class="title"><b>board.dsn</b> · Freerouting v2.4.1</div><span class="badge fr-state">idle</span></div>
        <div class="fr-menu">${['File', 'Appearance', 'Settings', 'Rules', 'Info', 'Help'].map(m => `<span data-m="${m}">${m}</span>`).join('')}
          <em class="fr-phase">${esc(d.board.name)} · ${d.board.w}×${d.board.h} mm · ${d.board.layers.length} layers</em>
          <div class="fr-drop"><div><span>Open…</span><kbd>Ctrl+O</kbd></div><div class="hl"><span>Save as…</span><kbd>Ctrl+S</kbd></div><div><span>Exit</span><kbd>Alt+F4</kbd></div></div>
        </div>
        <div class="fr-tools">
          <div class="fr-seg"><span class="on">Route</span><span>Drag</span></div>
          <i class="sep"></i>
          <button class="tb" title="Settings">${ico('gear')}</button>
          <button class="tb fr-wand" title="Start autorouter">${ico('wand')}</button>
          <button class="tb fr-stop" title="Stop">${ico('stop')}</button>
          <button class="tb" title="Delete all tracks">${ico('trash')}</button>
          <i class="sep"></i>
          <button class="tb" title="Undo">${ico('undo')}</button>
          <button class="tb" title="Redo">${ico('redo')}</button>
          <i class="sep"></i>
          <button class="tb" title="Incompletes">${ico('incomplete')}</button>
          <button class="tb" title="Violations">${ico('violations')}</button>
          <i class="sep"></i>
          <button class="tb" title="Zoom in">${ico('zin')}</button>
          <button class="tb" title="Zoom out">${ico('zout')}</button>
          <div class="fr-legend"><span><i style="background:${COL.F}"></i>F.Cu</span><span><i style="background:${COL.B}"></i>B.Cu</span><span><i class="dot" style="background:${COL.via}"></i>via</span><span><i class="air"></i>airwire</span></div>
          <div class="fr-unit"><small>Unit</small><div class="fr-seg"><span>mil</span><span>in</span><span class="on">mm</span><span>um</span></div></div>
        </div>
        <div class="fr-canvas">
          <canvas></canvas>
          <div class="fr-banner"><b>${d.stats.connections} → ${d.stats.incomplete} unrouted</b><span>${d.job.elapsed} s · ${d.stats.vias} vias · ${d.stats.clearance_violations} violations</span></div>
          <div class="fr-rd left">
            ${rd('un', 'Unrouted', d.stats.connections, `of ${d.stats.connections} connections`)}
            ${rd('nets', 'Nets routed', `0<i>/${d.stats.nets}</i>`, `${d.stats.pads} pads · ${d.stats.components} parts`)}
            ${rd('trk', 'Tracks drawn', `0<i>/${d.stats.traces}</i>`, 'F.Cu 0 · B.Cu 0')}
            ${rd('via', 'Vias placed', `0<i>/${d.stats.vias}</i>`, `final ${d.stats.vias} · fanout extras rerouted`)}
            ${rd('brd', 'Board', `${d.board.w}×${d.board.h}<i> mm</i>`, `${d.board.layers.length} layers · track ${d.board.rules.track} mm`)}
          </div>
          <div class="fr-rd right">
            ${rd('cu', 'Copper drawn', `0.0<i> mm</i>`, `of ${d.stats.trace_length_mm} mm`)}
            ${rd('pass', 'Current pass', 'idle', 'fanout · router · optimizer')}
            ${rd('score', 'Score', '–', 'max 1000')}
            ${rd('drc', 'Clearance violations', d.stats.clearance_violations, `${d.board.rules.clearance} mm rule`)}
            ${rd('time', 'Router time', `0.00<i> s</i>`, 'sum of real pass times')}
          </div>
        </div>
        <div class="fr-status">
          <span class="cnt"><i class="e">✕</i><b class="fr-err">0</b></span>
          <span class="cnt"><i class="w">!</i><b class="fr-warnc">0</b></span>
          <span class="fr-msg">Loading board.dsn…</span>
          <span class="fr-pass"></span>
          <span class="fr-layer">F.Cu</span>
          <span class="fr-xy mono">X 0.00  Y 0.00</span>
          <span class="mono dim">mm</span>
        </div>
      </div>

      <div class="fr-side">
        <div class="glass window fr-logwin">
          <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>freerouting</b> · headless</div></div>
          <div class="term fr-term"><span class="prompt">$ </span><span class="cmd fr-cmdtext"></span><div class="fr-log"></div></div>
        </div>
        <div class="glass fr-passes">
          <div class="fr-row"><label>Fanout</label><div>${P.fanout.map(p => chip('f', p, '#' + p.n)).join('')}</div></div>
          <div class="fr-row"><label>Autorouter</label><div>${P.route.map(p => chip('r', p, '#' + p.n)).join('')}</div></div>
          <div class="fr-row"><label>Optimizer</label><div class="one">${chip('o', { secs: d.optimizer.secs }, 'pass')}</div></div>
        </div>
        <div class="glass fr-toast">
          <div class="ok">✓</div>
          <div><b>Imported into KiCad</b><small>File › Import › Specctra Session…</small>
          <em>${d.stats.traces} tracks · ${d.stats.vias} vias · board.ses</em></div>
        </div>
        <div class="callout fr-call"><h4>What's happening</h4><p>KiCad's <span class="mono">board.dsn</span> has ${d.stats.connections} airwires (grey). Freerouting must turn each into copper on 2 layers, keeping ${d.board.rules.clearance} mm clearance.</p></div>
      </div>
      <div class="fr-cursor"><svg viewBox="0 0 20 20" width="20" height="20"><path d="M3 2l13 8.2-6 .9 3.4 6.4-2.2 1.1-3.4-6.4L3.6 16z" fill="#0a0a0a" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg><i></i></div>
    </div>`;

    const $ = s => root.querySelector(s);
    st.el = {
      win: $('.fr-win'), canvasWrap: $('.fr-canvas'), cv: $('canvas'), msg: $('.fr-msg'), pass: $('.fr-pass'), xy: $('.fr-xy'),
      state: $('.fr-state'), term: $('.fr-term'), log: $('.fr-log'), cmd: $('.fr-cmdtext'), wand: $('.fr-wand'), cursor: $('.fr-cursor'), phase: $('.fr-phase'), toast: $('.fr-toast'),
      drop: $('.fr-drop'), file: $('[data-m="File"]'), call: $('.fr-call p'), callH: $('.fr-call h4'), layer: $('.fr-layer'),
    };
    st.g = st.el.cv.getContext('2d');
    st.rd = {};
    for (const c of root.querySelectorAll('.rd')) st.rd[c.dataset.r] = { card: c, v: c.querySelector('b'), sub: c.querySelector('small') };
    st.rdMemo = {}; st.trk = { F: 0, B: 0 }; st.netsDone = 0; st.time = { v: 0 };
    st.tool = (getComputedStyle(root).getPropertyValue('--tool') || '').trim();
    if (!/^(#|rgb)/.test(st.tool)) st.tool = '#dc2626';
    this.buildModel(d);
    st.ro = new ResizeObserver(() => this.fit());
    st.ro.observe(st.el.canvasWrap);
    this.fit();
    const loop = () => { if (!st || !st.alive) return; this.tick(); st.raf = requestAnimationFrame(loop); };
    st.raf = requestAnimationFrame(loop);
  },

  buildModel(d) {
    const inU1 = p => p[0] >= U1.x0 && p[0] <= U1.x1 && p[1] >= U1.y0 && p[1] <= U1.y1;
    const wires = d.wires.map((w, i) => {
      const m = polyMeta(w.pts);
      return { ...w, ...m, i, p: 0, vias: [], color: w.layer === 'B.Cu' ? COL.B : COL.F };
    });
    const fan = [], route = [], held = [];
    for (const w of wires) {
      const any = w.pts.some(inU1), all = w.pts.every(inU1);
      if (any && (all || w.len <= 6)) fan.push(w);
      else if (HELD.includes(w.net)) held.push(w);
      else route.push(w);
    }
    const order = [...fan, ...route, ...held];
    const vias = d.vias.map(v => ({ ...v, s: 0, shown: false }));
    for (const v of vias) {
      const w = order.find(w => w.net === v.net && w.pts.some(p => Math.hypot(p[0] - v.x, p[1] - v.y) < 0.06));
      if (w) w.vias.push(v); else v.orphan = true;
    }
    const air = d.ratsnest.map(r => ({ ...r, alpha: 1, gone: false, warn: 0 }));
    const netAir = {}, netWires = {}, netDone = {};
    for (const a of air) (netAir[a.net] ||= []).push(a);
    for (const w of wires) { netWires[w.net] = (netWires[w.net] || 0) + 1; netDone[w.net] = 0; }
    // order airwires of a net by distance from U1 so fades sweep outward
    Object.assign(st, { wires, order, fan, route, held, vias, air, netAir, netWires, netDone, ghosts: [], viaCount: 0, unrouted: air.length });
  },

  fit() {
    const { cv, canvasWrap } = st.el;
    const r = canvasWrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(50, r.width), H = Math.max(50, r.height);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const b = st.d.board, pad = 12;
    const side = W > 760 ? Math.min(176, W * .17) : 0;
    const s = Math.min((W - pad * 2 - side * 2) / b.w, (H - pad * 2) / b.h);
    st.view = { W, H, dpr, s, ox: (W - b.w * s) / 2, oy: (H - b.h * s) / 2 };
  },

  tween(obj, key, to, ms, ease = easeOut, done, onUpdate) {
    const t = { obj, key, from: obj[key], to, t0: performance.now(), dur: Math.max(1, ms / st.ctx.speed), ease, done, onUpdate };
    st.tweens.push(t);
    return t;
  },

  tick() {
    const t = performance.now();
    if (st.tweens.length) {
      const list = st.tweens; st.tweens = [];
      for (const tw of list) {
        const p = Math.min(1, Math.max(0, (t - tw.t0) / tw.dur));
        tw.obj[tw.key] = tw.from + (tw.to - tw.from) * tw.ease(p);
        tw.onUpdate?.(tw.obj[tw.key]);
        if (p >= 1) tw.done?.(); else st.tweens.push(tw);
      }
    }
    this.draw(t);
    let cu = 0; for (const w of st.wires) if (w.p > 0) cu += w.len * Math.min(1, w.p);
    this.rdSet('cu', `${cu.toFixed(1)}<i> mm</i>`, null, cu >= st.d.stats.trace_length_mm - .05 ? 'good' : '');
    if (st.tip && t - st.tipT > 60) {
      st.tipT = t;
      const s = `X ${st.tip[0].toFixed(2)}  Y ${st.tip[1].toFixed(2)}`;
      if (s !== st.xyText) { st.xyText = s; st.el.xy.textContent = s; }
    }
  },

  draw(t) {
    const g = st.g, v = st.view, d = st.d, b = d.board;
    if (!v) return;
    const { s, ox, oy, dpr } = v;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = COL.bg; g.fillRect(0, 0, v.W, v.H);
    // grid: 1 mm dots, 5 mm lines (screen space aligned to board)
    const gs = s * (s > 9 ? 1 : 2);
    const gx0 = ox - Math.ceil(ox / gs) * gs, gy0 = oy - Math.ceil(oy / gs) * gs;
    g.strokeStyle = COL.grid; g.lineWidth = 1; g.beginPath();
    for (let x = gx0; x < v.W; x += gs) { const X = Math.round(x) + .5; g.moveTo(X, 0); g.lineTo(X, v.H); }
    for (let y = gy0; y < v.H; y += gs) { const Y = Math.round(y) + .5; g.moveTo(0, Y); g.lineTo(v.W, Y); }
    g.stroke();

    g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    // board
    g.beginPath(); g.roundRect(0, 0, b.w, b.h, 1.6);
    g.fillStyle = COL.board; g.fill();
    g.lineWidth = 1.5 / s; g.strokeStyle = COL.edge; g.stroke();

    // part outlines (silkscreen)
    g.lineWidth = 1.1 / s; g.strokeStyle = COL.body;
    for (const p of d.parts) {
      if (p.kind === 'hole') continue;
      g.strokeRect(p.x - p.w / 2 - .25, p.y - p.h / 2 - .25, p.w + .5, p.h + .5);
      if (p.kind === 'bga') { g.beginPath(); g.moveTo(p.x - p.w / 2 - .25, p.y - p.h / 2 + 1.2); g.lineTo(p.x - p.w / 2 + 1.2, p.y - p.h / 2 - .25); g.stroke(); }
    }
    // pads
    for (const p of d.parts) for (const pd of p.pads) {
      g.fillStyle = pd.net || p.kind === 'hole' ? COL.pad : COL.padDim;
      if (pd.s === 'r') g.fillRect(pd.x - pd.w / 2, pd.y - pd.h / 2, pd.w, pd.h);
      else { g.beginPath(); g.arc(pd.x, pd.y, pd.d / 2, 0, 7); g.fill(); }
      if (pd.th && pd.drill) { g.fillStyle = COL.drill; g.beginPath(); g.arc(pd.x, pd.y, pd.drill / 2, 0, 7); g.fill(); }
    }

    // traces: B.Cu under F.Cu
    g.lineCap = 'round'; g.lineJoin = 'round';
    st.tip = st.tip || null;
    let tip = null;
    for (const layer of ['B.Cu', 'F.Cu']) {
      g.globalAlpha = layer === 'B.Cu' ? .85 : .93;
      for (const w of st.wires) {
        if (w.layer !== layer || w.p <= 0) continue;
        g.strokeStyle = w.color; g.lineWidth = Math.max(w.w, 1.4 / s);
        const end = this.path(g, w, w.p);
        g.stroke();
        if (w.p < 1 && end) tip = { end, w };
      }
    }
    g.globalAlpha = 1;
    // ghost (rip-up) attempts
    for (const gh of st.ghosts) {
      if (gh.p <= 0) continue;
      g.setLineDash([.6, .5]); g.strokeStyle = COL.warn; g.lineWidth = Math.max(gh.w, 1.4 / s);
      g.globalAlpha = .65; this.path(g, gh, gh.p); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    }
    // optimizer shimmer
    if (st.shimmer >= 0) {
      const x = st.shimmer * b.w;
      g.globalAlpha = .05; g.fillStyle = st.tool; g.fillRect(0, 0, x, b.h);
      g.globalAlpha = .7; g.strokeStyle = st.tool; g.lineWidth = 1.5 / s;
      g.beginPath(); g.moveTo(x, -.6); g.lineTo(x, b.h + .6); g.stroke(); g.globalAlpha = 1;
    }
    // vias
    for (const vi of st.vias) {
      if (vi.s <= 0) continue;
      const r = (vi.d / 2) * vi.s;
      g.fillStyle = COL.via; g.beginPath(); g.arc(vi.x, vi.y, r, 0, 7); g.fill();
      g.fillStyle = COL.drill; g.beginPath(); g.arc(vi.x, vi.y, r * .5, 0, 7); g.fill();
    }
    // airwires
    g.lineWidth = 1 / s;
    for (const a of st.air) {
      const al = a.alpha * st.ratA;
      if (al <= .01) continue;
      g.globalAlpha = al;
      g.strokeStyle = a.warn ? COL.warn : COL.rat;
      if (a.warn) { g.lineWidth = 1.5 / s; g.setLineDash([3 / s, 2.5 / s]); }
      g.beginPath(); g.moveTo(a.a[0], a.a[1]); g.lineTo(a.b[0], a.b[1]); g.stroke();
      if (a.warn) { g.lineWidth = 1 / s; g.setLineDash([]); }
      g.globalAlpha = 1;
    }
    // drawing heads
    if (tip) {
      const [x, y] = tip.end;
      g.fillStyle = tip.w.color;
      g.beginPath(); g.arc(x, y, Math.max(tip.w.w * .9, 2.2 / s), 0, 7); g.fill();
      st.tip = [x, y];
    }

    // silk refs (screen space for crisp text)
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fs = Math.max(8.5, Math.min(13, s * .95));
    g.font = `600 ${fs}px 'Geist Mono', ui-monospace, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const p of d.parts) {
      let x = p.x, y;
      if (p.kind === 'hole') { y = p.y; g.fillStyle = COL.hole; }
      else {
        g.fillStyle = COL.silk;
        if (p.kind === 'led' || p.kind === 'ldo') y = p.y + p.h / 2 + 1.05;
        else if (p.kind === 'cap') { y = p.y; x = p.x + (p.x < 28 ? -1.9 : 1.9); }
        else y = p.y - p.h / 2 - 1.0;
      }
      g.fillText(p.ref, ox + x * s, oy + y * s);
    }
  },

  // builds a partial polyline path; returns the end point
  path(g, w, p) {
    const target = w.len * Math.min(1, p), pts = w.pts;
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    let end = pts[0];
    for (let i = 1; i < pts.length; i++) {
      if (w.cum[i] <= target) { g.lineTo(pts[i][0], pts[i][1]); end = pts[i]; continue; }
      const seg = w.cum[i] - w.cum[i - 1], f = seg > 0 ? (target - w.cum[i - 1]) / seg : 0;
      end = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      g.lineTo(end[0], end[1]);
      break;
    }
    return end;
  },

  // board mm -> scene px rect (camera-independent) for ctx.focus
  boardRect(x0, y0, x1, y1) {
    const cam = st.root._cam || { s: 1 }, rr = st.root.getBoundingClientRect(), rc = st.el.canvasWrap.getBoundingClientRect(), v = st.view;
    return { x: (rc.left - rr.left) / cam.s + v.ox + x0 * v.s, y: (rc.top - rr.top) / cam.s + v.oy + y0 * v.s, w: (x1 - x0) * v.s, h: (y1 - y0) * v.s };
  },
  heldRect() {
    const a = st.air.filter(a => !a.gone);
    if (!a.length) return this.boardRect(0, 0, st.d.board.w, st.d.board.h);
    const xs = a.flatMap(r => [r.a[0], r.b[0]]), ys = a.flatMap(r => [r.a[1], r.b[1]]);
    return this.boardRect(Math.min(...xs) - 3, Math.min(...ys) - 3, Math.max(...xs) + 3, Math.max(...ys) + 3);
  },
  // ---------- state helpers ----------
  // live reading cards on the canvas edges
  rdSet(k, html, sub, cls) {
    const r = st.rd[k]; if (!r) return;
    const key = html + '|' + (sub ?? '') + '|' + (cls ?? '');
    if (st.rdMemo[k] === key) return; st.rdMemo[k] = key;
    r.v.innerHTML = html; if (sub != null) r.sub.textContent = sub;
    if (cls != null) r.card.className = 'rd ' + cls;
  },
  setUnrouted() { this.rdSet('un', String(st.unrouted), null, st.unrouted === 0 ? 'good' : ''); },
  popVia(v) {
    if (v.shown) return; v.shown = true;
    this.tween(v, 's', 1, 450, easeOut);
    st.viaCount++; this.rdSet('via', `${st.viaCount}<i>/${st.d.stats.vias}</i>`, null, st.viaCount === st.d.stats.vias ? 'good' : '');
  },
  wireDone(w) {
    for (const v of w.vias) this.popVia(v);
    const n = w.net; st.netDone[n]++;
    st.trk[w.layer === 'B.Cu' ? 'B' : 'F']++;
    const td = st.trk.F + st.trk.B, D = st.d.stats;
    this.rdSet('trk', `${td}<i>/${D.traces}</i>`, `F.Cu ${st.trk.F} · B.Cu ${st.trk.B}`, td === D.traces ? 'good' : '');
    if (st.netDone[n] === st.netWires[n]) { st.netsDone++; this.rdSet('nets', `${st.netsDone}<i>/${D.nets}</i>`, null, st.netsDone === D.nets ? 'good' : ''); }
    const list = st.netAir[n] || [], k = list.length, m = st.netWires[n];
    list.forEach((a, j) => {
      if (!a.gone && st.netDone[n] >= Math.ceil((j + 1) * m / k)) {
        a.gone = true; a.warn = 0; st.unrouted--; this.setUnrouted();
        this.tween(a, 'alpha', 0, 450, easeOut);
      }
    });
  },
  drawWire(w, ms) {
    return this.tween(w, 'p', 1, ms, easeInOut, () => this.wireDone(w));
  },
  async routeList(ctx, list, totalMs) {
    if (!list.length) return;
    const step = totalMs / list.length;
    for (const w of list) {
      this.drawWire(w, Math.min(1100, 260 + w.len * 38));
      await ctx.sleep(step);
    }
  },
  log(i, cls = '') {
    const line = st.d.log[i]; if (line == null) return;
    const div = document.createElement('div');
    const s = trimLog(line);
    const m = s.match(/^(\d\d:\d\d:\d\d)\s+(.*)$/);
    div.className = 'fr-ln ' + cls;
    div.innerHTML = m ? `<span class="dim">${m[1]}</span> ${esc(m[2])}` : esc(s);
    st.el.log.appendChild(div);
    st.el.term.scrollTo({ top: st.el.term.scrollHeight, behavior: 'smooth' });
  },
  chip(k, state) {
    const P = st.d.passes, n = +k.slice(1);
    const pass = k[0] === 'f' ? P.fanout[n - 1] : k[0] === 'r' ? P.route[n - 1] : { secs: st.d.optimizer.secs };
    const name = k[0] === 'f' ? `Fanout #${n}` : k[0] === 'r' ? `Router #${n}` : 'Optimizer';
    if (state === 'run') this.rdSet('pass', name, k[0] === 'f' ? `${pass.pins} SMD pins` : k[0] === 'r' ? `of ${P.route.length} router passes` : 'score already ≥ 99%', 'live');
    if (state === 'done' && pass) {
      this.tween(st.time, 'v', st.time.v + pass.secs, 600, easeOut, null, v => this.rdSet('time', `${v.toFixed(2)}<i> s</i>`));
      if (k[0] === 'r') this.rdSet('drc', String(pass.violations), `${st.d.board.rules.clearance} mm rule`, pass.violations ? '' : 'good');
    }
    const c = st.root.querySelector(`.fr-chip[data-k="${k}"]`); if (!c) return;
    c.classList.remove('run', 'done'); if (state) c.classList.add(state);
  },
  status(msg, pass = '') { st.el.msg.textContent = msg; st.el.pass.textContent = pass; },
  setState(text, cls = '') { const b = st.el.state; b.textContent = text; b.className = 'badge fr-state ' + cls; },
  phase(text) { st.el.phase.textContent = text; },
  score(to, ms = 900) {
    const o = st.scoreObj ||= { v: 0 };
    this.tween(o, 'v', to, ms, easeOut, null, v => { this.rdSet('score', fmt2(v), to >= 999 ? 'max 1000 · within 1%' : 'max 1000', to >= 999 ? 'good' : ''); });
  },
  callout(h, p) {
    const c = st.root.querySelector('.fr-call'); c.classList.add('swap');
    setTimeout(() => { if (!st) return; st.el.callH.textContent = h; st.el.call.innerHTML = p; c.classList.remove('swap'); }, 220);
  },
  async moveCursor(ctx, el, ms = 900) {
    const cur = st.el.cursor, r0 = st.root.querySelector('.fr10').getBoundingClientRect(), r = el.getBoundingClientRect();
    cur.style.transitionDuration = `${ms / ctx.speed}ms`;
    cur.style.transform = `translate(${r.left - r0.left + r.width * .55}px, ${r.top - r0.top + r.height * .55}px)`;
    await ctx.sleep(ms + 60);
  },
  async click(ctx, el) {
    const cur = st.el.cursor;
    cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click');
    el.classList.add('press'); await ctx.sleep(180); el.classList.remove('press');
  },

  async play(ctx) {
    const d = st.d, P = d.passes, E = st.el;
    // --- 1. command + board load (text beat: skimmed; board + airwires are already on screen)
    ctx.skim?.();
    this.setState('board loaded', 'info');
    this.status(`${d.stats.connections} incomplete connections to route`);
    this.phase(`${d.stats.components} parts · ${d.stats.pads} pads · ${d.stats.nets} nets · ${d.stats.connections} airwires`);
    await ctx.typeInto(E.cmd, d.command, 150);
    await ctx.sleep(250);
    this.log(0); await ctx.sleep(300);
    this.log(1); await ctx.sleep(300);
    this.log(2);
    await ctx.sleep(400);

    // visual from here on: the board, the wand click, routing, optimizer and save
    ctx.visual?.();
    ctx.narrate('One click starts Freerouting, a real autorouter.');
    await ctx.sleep(900);

    // --- 2. start the autorouter
    E.cursor.classList.add('on');
    E.cursor.style.transitionDuration = '0ms';
    const r0 = st.root.querySelector('.fr10').getBoundingClientRect(), rc = E.canvasWrap.getBoundingClientRect();
    E.cursor.style.transform = `translate(${rc.left - r0.left + rc.width * .5}px, ${rc.top - r0.top + rc.height * .55}px)`;
    await ctx.sleep(60);
    E.wand.classList.add('hint');
    await this.moveCursor(ctx, E.wand, 1000);
    await ctx.sleep(500);
    await this.click(ctx, E.wand);
    E.wand.classList.remove('hint'); E.wand.classList.add('active');
    E.cursor.classList.remove('on');
    this.setState('routing', 'info');

    // --- 3. fanout
    this.log(3);
    ctx.narrate('First, short escape traces pull pins out from under the FPGA.');
    ctx.focus?.(this.boardRect(U1.x0 - 2, U1.y0 - 2, U1.x1 + 2, U1.y1 + 2), { scale: 2.2, ms: 900 });
    const F = st.fan, tot = P.fanout.reduce((a, p) => a + p.pins, 0) || 1;
    let off = 0;
    for (const [i, p] of P.fanout.entries()) {
      const n = i === P.fanout.length - 1 ? F.length - off : Math.round(F.length * p.pins / tot);
      const part = F.slice(off, off + n); off += n;
      this.chip('f' + p.n, 'run');
      this.status('Auto-router is running…', `Fanout pass #${p.n}`);
      this.phase(`Fanout pass #${p.n} · ${p.pins} SMD pins`);
      await this.routeList(ctx, part, i === 0 ? 2600 : i === 1 ? 900 : 400);
      await ctx.sleep(i < 2 ? 700 : 200);
      this.log(4 + i);
      this.chip('f' + p.n, 'done');
    }
    this.log(8);
    ctx.unfocus?.({ ms: 800 });
    await ctx.sleep(700);

    // --- 4. autorouter passes
    this.log(9);
    ctx.narrate('Then it maze-routes the rest: red on top, blue underneath.');
    const [r1, r2, r3, r4] = P.route;
    this.chip('r1', 'run'); this.status('Auto-router is running…', 'Auto-router pass #1'); this.phase('Auto-router pass #1');
    await this.routeList(ctx, st.route, 8200);
    await ctx.sleep(1200);
    this.log(10); this.chip('r1', 'done');
    this.score(r1.score, 1100);
    for (const a of st.air) if (!a.gone) a.warn = 1;
    this.status(`${st.unrouted} unrouted · score ${fmt2(r1.score)}`, 'Auto-router pass #1');
    ctx.narrate(`Pass 1: ${d.stats.connections - r1.unrouted} of ${d.stats.connections} done. 2 connections are boxed in.`);
    ctx.focus?.(this.heldRect(), { scale: 2, ms: 900 });
    await ctx.sleep(1800);

    // pass 2: rip-up and retry, still 2 unrouted
    this.chip('r2', 'run'); this.status('Auto-router is running…', 'Auto-router pass #2 · ripped: 2, failed: 2'); this.phase('Auto-router pass #2 · rip-up & retry');
    st.ghosts = st.held.filter(w => w.len > 3).map(w => ({ ...w, p: 0 }));
    for (const gh of st.ghosts) this.tween(gh, 'p', .6, 1300, easeOut, () => this.tween(gh, 'p', 0, 800, easeOut));
    E.warnC = st.root.querySelector('.fr-warnc'); E.warnC.textContent = String(r2.unrouted);
    await ctx.sleep(2200);
    this.log(11); this.chip('r2', 'done');
    this.status(`${r2.unrouted} unrouted · score ${fmt2(r2.score)}`, 'Auto-router pass #2');
    await ctx.sleep(700);

    // pass 3: the last two connect
    this.chip('r3', 'run'); this.status('Auto-router is running…', 'Auto-router pass #3'); this.phase('Auto-router pass #3');
    ctx.narrate(`Pass 3 rips up neighbours and threads it through: ${r3.unrouted} left.`);
    st.ghosts = [];
    await this.routeList(ctx, st.held, 1500);
    await ctx.sleep(1200);
    E.warnC.textContent = '0';
    this.log(12); this.chip('r3', 'done');
    this.score(r3.score, 1200);
    this.status(`${r3.unrouted} unrouted · score ${fmt2(r3.score)}`, 'Auto-router pass #3');
    await ctx.sleep(900);
    ctx.unfocus?.({ ms: 800 });
    await ctx.sleep(400);
    this.chip('r4', 'run'); this.status('Auto-router is running…', 'Auto-router pass #4'); this.phase('Auto-router pass #4 · verify');
    await ctx.sleep(900);
    for (const v of st.vias) if (!v.shown) this.popVia(v);
    this.log(13); this.chip('r4', 'done');
    this.log(14);
    this.status(`${r4.unrouted} unrouted · score ${fmt2(r4.score)}`, 'Auto-router pass #4');
    await ctx.sleep(400);

    // --- 5. optimizer
    this.chip('o', 'run'); this.log(15);
    this.status('Optimizer is running…', 'Optimizer pass #1'); this.phase('Optimizer');
    st.shimmer = 0;
    this.tween(st, 'shimmer', 1, 1000, easeInOut, () => { st.shimmer = -1; });
    await ctx.sleep(600);
    this.log(16, 'hl');
    await ctx.sleep(500);
    this.log(17); this.chip('o', 'done');
    this.log(18, 'ok');
    this.setState('completed', 'pass');
    this.rdSet('pass', 'Completed', `${d.passes.fanout.length} fanout · ${d.passes.route.length} router · 1 optimizer`, 'good');
    this.tween(st.time, 'v', d.job.elapsed, 600, easeOut, null, v => this.rdSet('time', `${v.toFixed(2)}<i> s</i>`, 'job elapsed (real)'));
    st.tip = null;
    this.status(`Postroute completed · 0 unrouted · Via count ${d.stats.vias} · Trace length ${d.stats.trace_length_mm} mm`, '');
    this.phase(`${d.stats.traces} traces · ${d.stats.vias} vias · ${d.stats.trace_length_mm} mm · 0 violations`);
    this.callout('What happened', `All ${d.stats.connections} airwires became copper in <b>${d.job.elapsed} s</b>: ${d.stats.f_wires} F.Cu + ${d.stats.b_wires} B.Cu traces, ${d.stats.vias} vias, ${d.stats.clearance_violations} violations. KiCad re-checks it with DRC.`);
    ctx.emit('metric', { key: 'pcb_nets_routed', label: 'Nets routed', value: `${d.stats.nets}/${d.stats.nets}` });
    ctx.emit('metric', { key: 'pcb_vias', label: 'Vias', value: d.stats.vias });
    ctx.emit('metric', { key: 'pcb_unrouted', label: 'Unrouted', value: d.stats.incomplete });
    ctx.emit('metric', { key: 'pcb_route_time', label: 'Autoroute time', value: Math.round(d.job.elapsed * 10) / 10, unit: 's' });
    ctx.emit('metric', { key: 'pcb_trace_length', label: 'Trace length', value: d.stats.trace_length_mm, unit: 'mm' });
    ctx.narrate(`${d.stats.connections} → 0 in ${d.job.elapsed} s. ${d.stats.vias} vias, ${Math.round(d.stats.trace_length_mm)} mm of copper, ${d.stats.clearance_violations} violations.`);
    const banner = st.root.querySelector('.fr-banner');
    banner.classList.add('on');
    await ctx.sleep(2500);
    banner.classList.remove('on');
    const un = st.rd.un?.card;
    if (un) { ctx.focus?.(un, { scale: 1.8, ms: 800 }); await ctx.sleep(1500); ctx.unfocus?.({ ms: 700 }); await ctx.sleep(750); }

    // --- 6. save + import
    E.cursor.classList.add('on');
    await this.moveCursor(ctx, E.file, 900);
    await this.click(ctx, E.file);
    E.file.classList.add('open'); E.drop.classList.add('open');
    await ctx.sleep(500);
    await this.moveCursor(ctx, E.drop.querySelector('.hl'), 500);
    await this.click(ctx, E.drop.querySelector('.hl'));
    E.drop.classList.remove('open'); E.file.classList.remove('open');
    E.cursor.classList.remove('on');
    const bytes = (d.log.join('\n').match(/\((\d+) bytes\)/) || [])[1];
    this.status('Saving board.ses…');
    this.log(19); await ctx.sleep(600);
    this.log(20, 'ok');
    this.status(`Saved board.ses${bytes ? ` (${(+bytes).toLocaleString()} bytes)` : ''} · 0 unrouted · Via count ${d.stats.vias} · Trace length ${d.stats.trace_length_mm} mm`);
    ctx.narrate('The board is real. So what did we actually build?');
    await ctx.sleep(600);
    E.toast.classList.add('on');
    await ctx.sleep(1500);
  },

  unmount() {
    if (!st) return;
    st.root.style.transform = ''; st.root._cam = null;
    st.alive = false;
    cancelAnimationFrame(st.raf);
    st.ro?.disconnect();
    st.tweens = [];
    st = null;
  },
};
