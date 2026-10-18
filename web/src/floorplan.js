// Floorplan: the critical path from a nextpnr report.json drawn on the LFE5U-85F tile grid.
// mountFloorplan(el, report) -> {update(report), destroy()}. Segment `loc` = [x, y] tile; a red pulse runs the
// path start -> end at "signal time" (in proportion to each segment's delay). update() glides the view to the
// new path while the old one fades out, then the new path draws itself in.
import './viewers.css';

const DIE = [126, 96];                       // LFE5U-85F tile grid as nextpnr reports it (I/O ring included)
const KIND = {FF: 'FF', LUT: 'LUT', CARRY: 'carry', DSP: 'DSP', IO: 'I/O'};
const LAP = 3200, REVEAL = 900, GLIDE = 750;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const ease = u => (u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

function kindOf(cell, port) {
  if (/\$CCU2_COMB\d$/.test(cell)) return 'CARRY';
  if (/\$tr_io$|TRELLIS_IO/.test(cell)) return 'IO';
  if (/MULT18X18D|ALU54B|\$mul/i.test(cell)) return 'DSP';
  if (/TRELLIS_FF_Q(_\d+)?$/.test(cell)) return 'FF';
  if (/LUT4|\$LUT|TRELLIS_COMB/.test(cell)) return 'LUT';
  return ['Q', 'DI', 'M', 'CE', 'LSR'].includes(port) ? 'FF' : 'LUT';
}
// "dut.count_r_TRELLIS_FF_Q_8_DI_CCU2C_..$CCU2_COMB1" @ [68,35] -> "count_r carry X68/Y35"
const shortCell = e => {
  const n = (e.cell || '').replace(/^dut\./, ''), base = n.split(/_TRELLIS_|_LUT4|\$/)[0] || n;
  return `${base} ${KIND[kindOf(e.cell || '', e.port)]}${e.loc ? ` X${e.loc[0]}/Y${e.loc[1]}` : ''}`;
};

// The register-to-register path on the main clock; fall back to the longest path in the report.
export function parseReport(report) {
  if (!report || !Array.isArray(report.critical_paths) || !report.critical_paths.length) return null;
  const tot = p => p.path.reduce((a, s) => a + (s.delay || 0), 0);
  const reg = report.critical_paths.filter(p => /edge/.test(p.from || '') && /edge/.test(p.to || '') && p.path?.length);
  const pick = (reg.length ? reg : report.critical_paths.filter(p => p.path?.length)).sort((a, b) => tot(b) - tot(a))[0];
  if (!pick) return null;
  const clocks = Object.entries(report.fmax || {});
  const [clock, fm] = clocks.find(([k]) => (pick.from || '').includes(k)) || clocks[0] || ['', {}];
  const segs = pick.path.map(s => ({type: s.type, delay: +s.delay || 0, net: s.net || '', from: s.from || {}, to: s.to || {}}));
  const sum = t => segs.filter(s => t(s.type)).reduce((a, s) => a + s.delay, 0);
  let gx = DIE[0], gy = DIE[1];
  for (const s of segs) for (const e of [s.from, s.to]) if (e.loc) { gx = Math.max(gx, e.loc[0] + 1); gy = Math.max(gy, e.loc[1] + 1); }
  const util = report.utilization || {};
  return {
    clock: clock.replace(/^\$glbnet\$/, '').replace(/\$TRELLIS_IO_IN$/, ''),
    fmax: fm.achieved ?? null, constraint: fm.constraint ?? null, segs,
    path_ns: tot(pick), routing_ns: sum(t => t === 'routing'), logic_ns: sum(t => t === 'logic'),
    clkq_ns: sum(t => t === 'clk-to-q'), grid: [gx, gy],
    lut: util.TRELLIS_COMB?.used, ff: util.TRELLIS_FF?.used, dsp: util.MULT18X18D?.used,
  };
}

// Each distinct cell gets its own slot in its tile (4 x 2, like the slices' LUT/FF pairs), so a carry chain
// inside one tile still reads as a chain instead of a single dot.
function geometry(P) {
  const cells = new Map(), perTile = new Map();
  const place = e => {
    if (cells.has(e.cell)) return cells.get(e.cell);
    const L = e.loc || [0, 0], key = L.join(','), k = perTile.get(key) || 0; perTile.set(key, k + 1);
    const c = {name: e.cell, x: L[0], y: L[1], kind: kindOf(e.cell, e.port), slot: k};
    c.px = L[0] + .16 + (k % 4) * .227; c.py = L[1] + .3 + (Math.floor(k / 4) % 2) * .4;
    cells.set(e.cell, c); return c;
  };
  const pts = [];
  P.segs.forEach((s, i) => [s.from, s.to].forEach(e => {
    const c = place(e), last = pts[pts.length - 1];
    if (!last || last.c !== c) pts.push({x: c.px, y: c.py, c, i}); else last.i = i;
  }));
  let acc = 0; const cum = P.segs.map(s => (acc += s.delay));
  pts.forEach(p => { p.t = cum[p.i] ?? 0; });
  pts[0].t = 0;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = 7;                             // never zoom in closer than ~7 tiles so the die still reads as a grid
  if (x1 - x0 < span) { const m = (x0 + x1) / 2; x0 = m - span / 2; x1 = m + span / 2; }
  if (y1 - y0 < span) { const m = (y0 + y1) / 2; y0 = m - span / 2; y1 = m + span / 2; }
  return {cells: [...cells.values()], pts, total: acc || 1, bbox: [x0 - 1.5, y0 - 1.5, x1 + 1.5, y1 + 1.5]};
}

export function mountFloorplan(el, report, opts = {}) {
  const root = document.createElement('div');
  root.className = 'mdv mdv-fp';
  root.innerHTML = `
    <div class="mdv-head">
      <span class="mdv-big" data-r="fmax">…</span>
      <span class="mdv-sub" data-r="info"></span>
      <span class="mdv-tools">
        <button type="button" class="mdv-btn" data-r="die" aria-pressed="false" title="Show the whole LFE5U-85F die">full die</button>
        <button type="button" class="mdv-btn" data-r="play" aria-pressed="false" title="Pause or play the signal pulse">pause</button>
      </span>
    </div>
    <div class="mdv-stage" data-r="stage" role="img" aria-label="Critical path on the ECP5 floorplan">
      <canvas></canvas><div class="mdv-tip" data-r="tip"></div><div class="mdv-empty" data-r="empty" hidden></div>
    </div>
    <div class="mdv-legend" data-r="legend"></div>
    <details class="mdv-segs"><summary data-r="sum">Critical path segments</summary><div data-r="segs"></div></details>`;
  el.appendChild(root);
  const $ = k => root.querySelector(`[data-r="${k}"]`);
  const stage = $('stage'), cv = stage.querySelector('canvas'), ctx = cv.getContext('2d'), tip = $('tip');

  let P = null, G = null, prev = null;        // parsed report, geometry; prev = {G, t0} fading out
  let view = {s: 4, x: 0, y: 0}, glide = null, revealT0 = 0, t0 = performance.now();
  let playing = !reduce(), dieMode = false, hover = null, hoverSeg = -1, raf = 0, visible = true, tok = null, frame = 0;
  let shownFmax = null, numAnim = 0, numGuard = 0;
  const W = () => stage.clientWidth, H = () => stage.clientHeight;

  function tokens() {
    const cs = getComputedStyle(root), v = n => cs.getPropertyValue(n).trim();
    tok = {ink: v('--v-ink'), muted: v('--v-muted'), line: v('--v-line'), tile: v('--v-tile'), die: v('--v-die'),
      bad: v('--v-bad'), halo: v('--v-halo'), mono: v('--v-mono') || 'monospace',
      kind: {FF: v('--v-ok'), LUT: v('--v-accent'), CARRY: v('--v-accent2'), DSP: v('--v-warn'), IO: v('--v-io')}};
  }
  function fitTo(b) {
    const [x0, y0, x1, y1] = b, w = W(), h = H(), s = Math.min(w / (x1 - x0), h / (y1 - y0));
    return {s, x: (w - (x1 - x0) * s) / 2 - x0 * s, y: (h - (y1 - y0) * s) / 2 - y0 * s};
  }
  const target = () => (dieMode || !G ? [-1, -1, (P?.grid[0] ?? DIE[0]) + 1, (P?.grid[1] ?? DIE[1]) + 1] : G.bbox);
  function glideTo(ms = GLIDE) {
    const to = fitTo(target());
    if (reduce() || ms <= 0) { view = to; glide = null; } else glide = {from: {...view}, to, t0: performance.now(), ms};
    kick();
  }
  const X = x => view.x + x * view.s, Y = y => view.y + y * view.s;

  function polyline(pts, upto) {   // path through pts up to fractional index `upto`
    ctx.beginPath(); ctx.moveTo(X(pts[0].x), Y(pts[0].y));
    const n = Math.floor(upto);
    for (let i = 1; i <= Math.min(n, pts.length - 1); i++) ctx.lineTo(X(pts[i].x), Y(pts[i].y));
    if (n < pts.length - 1) { const a = pts[n], b = pts[n + 1], u = upto - n; ctx.lineTo(X(a.x + (b.x - a.x) * u), Y(a.y + (b.y - a.y) * u)); }
  }
  function drawPath(g, alpha, reveal, now) {
    const P2 = g.pts, s = view.s; if (!P2.length) return;
    ctx.save(); ctx.globalAlpha = alpha; ctx.lineJoin = ctx.lineCap = 'round';
    const lw = Math.max(2, Math.min(4, s * .12));
    const upto = reveal * (P2.length - 1);
    ctx.strokeStyle = tok.halo; ctx.lineWidth = lw + 4; polyline(P2, upto); ctx.stroke();
    ctx.strokeStyle = tok.bad; ctx.globalAlpha = alpha * .45; ctx.lineWidth = lw; ctx.stroke(); ctx.globalAlpha = alpha;
    // cells on the path
    for (const c of g.cells) {
      const r = Math.max(3, Math.min(s * .13, 8)), cx = X(c.px), cy = Y(c.py);
      ctx.fillStyle = tok.kind[c.kind]; ctx.shadowColor = tok.kind[c.kind]; ctx.shadowBlur = 8;
      roundRect(cx - r, cy - r, 2 * r, 2 * r, Math.min(3, r / 2)); ctx.fill();
      ctx.shadowBlur = 0;
      if (c === hover) { ctx.strokeStyle = tok.ink; ctx.lineWidth = 2; roundRect(cx - r - 2, cy - r - 2, 2 * r + 4, 2 * r + 4, 4); ctx.stroke(); }
    }
    if (hoverSeg >= 0 && G === g) {
      const seg = P.segs[hoverSeg], a = g.cells.find(c => c.name === seg.from.cell), b = g.cells.find(c => c.name === seg.to.cell);
      if (a && b) { ctx.strokeStyle = tok.ink; ctx.lineWidth = lw + 1.5; ctx.beginPath(); ctx.moveTo(X(a.px), Y(a.py)); ctx.lineTo(X(b.px), Y(b.py)); ctx.stroke();
        ctx.fillStyle = tok.ink; [a, b].forEach(c => { ctx.beginPath(); ctx.arc(X(c.px), Y(c.py), lw + 2, 0, 7); ctx.fill(); }); }
    }
    if (reveal >= 1 && g === G) {   // the pulse travels start -> end at signal time
      const f = playing ? ((now - t0) % LAP) / LAP : 1, tt = f * g.total;
      let k = 0; while (k < P2.length - 1 && P2[k + 1].t < tt) k++;
      const ta = P2[k].t, nb = Math.min(k + 1, P2.length - 1), tb = P2[nb].t, u = tb > ta ? (tt - ta) / (tb - ta) : 1;
      const hx = X(P2[k].x + (P2[nb].x - P2[k].x) * u), hy = Y(P2[k].y + (P2[nb].y - P2[k].y) * u);
      ctx.strokeStyle = tok.bad; ctx.lineWidth = lw + .5; polyline(P2, k + u); ctx.stroke();
      const gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, 15);
      gr.addColorStop(0, '#fff'); gr.addColorStop(.3, tok.bad); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(hx, hy, 15, 0, 7); ctx.fill();
      label(`${tt.toFixed(2)} ns`, hx + 13, hy - 10, tok.ink);
    } else if (reveal < 1) {
      ctx.strokeStyle = tok.bad; ctx.lineWidth = lw + .5; polyline(P2, upto); ctx.stroke();
    }
    if (reveal >= 1) [[P2[0], 'START'], [P2[P2.length - 1], 'END']].forEach(([p, t], i) => {
      ctx.strokeStyle = tok.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 8, 0, 7); ctx.stroke();
      label(t, X(p.x) + (i ? 11 : -11), Y(p.y) + 19, tok.ink, i ? 'left' : 'right');
    });
    ctx.restore();
  }
  function label(t, x, y, col, align = 'left') {
    ctx.font = `700 11px ${tok.mono}`; ctx.textAlign = align; ctx.lineWidth = 3.5; ctx.strokeStyle = tok.halo;
    ctx.strokeText(t, x, y); ctx.fillStyle = col; ctx.fillText(t, x, y);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw(now) {
    raf = 0;
    if (!tok || frame++ % 30 === 0) tokens();
    const dpr = devicePixelRatio || 1, w = W(), h = H();
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    if (glide) {
      const u = Math.min(1, (now - glide.t0) / glide.ms), e = ease(u), a = glide.from, b = glide.to;
      view = {s: a.s + (b.s - a.s) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e};
      if (u >= 1) glide = null;
    }
    const [gw, gh] = P ? P.grid : DIE, s = view.s;
    // die + tile grid
    ctx.fillStyle = tok.die; ctx.strokeStyle = tok.line; ctx.lineWidth = 1;
    roundRect(X(0), Y(0), gw * s, gh * s, Math.min(10, s)); ctx.fill(); ctx.stroke();
    ctx.save(); roundRect(X(0), Y(0), gw * s, gh * s, Math.min(10, s)); ctx.clip();
    if (s > 5) {
      ctx.strokeStyle = tok.tile; ctx.beginPath();
      const xa = Math.max(0, Math.floor(-view.x / s)), xb = Math.min(gw, Math.ceil((w - view.x) / s));
      const ya = Math.max(0, Math.floor(-view.y / s)), yb = Math.min(gh, Math.ceil((h - view.y) / s));
      for (let x = xa; x <= xb; x++) { ctx.moveTo(Math.round(X(x)) + .5, Y(ya)); ctx.lineTo(Math.round(X(x)) + .5, Y(yb)); }
      for (let y = ya; y <= yb; y++) { ctx.moveTo(X(xa), Math.round(Y(y)) + .5); ctx.lineTo(X(xb), Math.round(Y(y)) + .5); }
      ctx.stroke();
      if (s > 16) {   // tile coordinates along the top/left edges of the view
        ctx.fillStyle = tok.muted; ctx.font = `600 9px ${tok.mono}`; ctx.textAlign = 'center';
        const step = s > 40 ? 1 : s > 24 ? 2 : 4;
        for (let x = xa; x < xb; x++) if (x % step === 0) ctx.fillText(`X${x}`, X(x + .5), Math.max(Y(0), 0) + 11);
        ctx.textAlign = 'left';
        for (let y = ya; y < yb; y++) if (y % step === 0) ctx.fillText(`Y${y}`, Math.max(X(0), 0) + 4, Y(y + .5) + 3);
      }
    } else {   // whole die: faint I/O ring hint
      ctx.strokeStyle = tok.tile; ctx.lineWidth = Math.max(1, s * 1.5);
      ctx.strokeRect(X(.75), Y(.75), (gw - 1.5) * s, (gh - 1.5) * s);
    }
    ctx.restore();
    let busy = !!glide;
    if (prev) {
      const u = Math.min(1, (now - prev.t0) / (GLIDE * .8));
      drawPath(prev.G, 1 - u, 1, now);
      if (u >= 1) prev = null; else busy = true;
    }
    if (G) {
      const r = reduce() ? 1 : Math.min(1, Math.max(0, (now - revealT0) / REVEAL));
      if (r < 1) busy = true; else if (playing) busy = true;
      drawPath(G, 1, ease(r), now);
    }
    if (G && !dieMode) minimap(gw, gh);
    if (busy && visible && !document.hidden) raf = requestAnimationFrame(draw);
  }
  function minimap(gw, gh) {
    const mw = Math.min(96, W() * .26), ms = mw / gw, mh = gh * ms, mx = W() - mw - 10, my = 10;
    ctx.save(); ctx.globalAlpha = .95;
    ctx.fillStyle = tok.halo; roundRect(mx - 4, my - 4, mw + 8, mh + 8, 7); ctx.fill();
    ctx.strokeStyle = tok.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = tok.die; ctx.fillRect(mx, my, mw, mh); ctx.strokeRect(mx + .5, my + .5, mw - 1, mh - 1);
    ctx.fillStyle = tok.bad;
    for (const c of G.cells) ctx.fillRect(mx + c.x * ms - 1, my + c.y * ms - 1, 2.5, 2.5);
    const vx = -view.x / view.s, vy = -view.y / view.s, vw = W() / view.s, vh = H() / view.s;
    ctx.strokeStyle = tok.ink; ctx.lineWidth = 1.2;
    ctx.strokeRect(mx + Math.max(0, vx) * ms, my + Math.max(0, vy) * ms, Math.min(gw, vw) * ms, Math.min(gh, vh) * ms);
    ctx.fillStyle = tok.muted; ctx.font = `700 8.5px ${tok.mono}`; ctx.textAlign = 'right'; ctx.fillText('LFE5U-85F', mx + mw, my + mh + 12);
    ctx.restore();
  }
  function kick() { if (!raf && visible) raf = requestAnimationFrame(draw); }

  function setNumber(v) {
    const big = $('fmax');
    clearTimeout(numGuard);
    if (v == null) { big.innerHTML = '— <small>MHz</small>'; shownFmax = null; return; }
    const from = shownFmax ?? v, t1 = performance.now(); shownFmax = v; cancelAnimationFrame(numAnim);
    const step = now => {
      const u = reduce() ? 1 : Math.min(1, (now - t1) / 700), x = from + (v - from) * ease(u);
      big.innerHTML = `${x.toFixed(1)} <small>MHz</small>`; if (u < 1) numAnim = requestAnimationFrame(step);
    };
    numAnim = requestAnimationFrame(step);
    clearTimeout(numGuard);
    numGuard = setTimeout(() => { cancelAnimationFrame(numAnim); big.innerHTML = `${v.toFixed(1)} <small>MHz</small>`; }, 800);
  }
  function side() {
    const n = x => (x ?? 0).toFixed(2);
    $('info').innerHTML = P ? `critical path <b>${n(P.path_ns)} ns</b> = clk→q ${n(P.clkq_ns)} + logic ${n(P.logic_ns)} + routing ${n(P.routing_ns)}`
      + ` · ${P.segs.length} segments` + (P.constraint ? ` · target ${P.constraint} MHz` : '') : 'no routed design';
    const kinds = G ? [...new Set(G.cells.map(c => c.kind))] : [];
    $('legend').innerHTML = kinds.map(k => `<span><i style="background:${tok?.kind[k] || 'currentColor'}"></i>${KIND[k]} ${G.cells.filter(c => c.kind === k).length}</span>`).join('')
      + (G ? `<span><i class="ln" style="background:${tok?.bad || 'red'}"></i>critical path</span>` : '')
      + (P?.lut != null ? `<span>design: ${P.lut} LUT · ${P.ff} FF · ${P.dsp ?? 0} DSP</span>` : '');
    $('sum').textContent = P ? `Critical path segments (${P.segs.length})` : 'Critical path segments';
    $('segs').innerHTML = P ? P.segs.map((s, i) => `<div class="mdv-seg${s.delay ? '' : ' r'}" data-i="${i}" title="${esc(s.net || s.to.cell)}">`
      + `<span>${esc(s.type)}</span><span>${esc(shortCell(s.to))}${s.to.port ? '.' + esc(s.to.port) : ''}</span><span class="d">${s.delay.toFixed(3)}</span></div>`).join('') : '';
  }

  function set(report, animate) {
    const next = parseReport(report);
    if (G && animate) prev = {G, t0: performance.now()};
    P = next; G = P ? geometry(P) : null; hover = null; hoverSeg = -1;
    $('empty').hidden = !!P;
    $('empty').textContent = P ? '' : (opts.emptyText || 'No place-and-route report for this check (rejected before routing).');
    tokens(); side(); setNumber(P?.fmax ?? null);
    revealT0 = performance.now() + (animate && prev ? GLIDE * .45 : 0); t0 = revealT0 + REVEAL;
    if (animate) glideTo(); else { view = fitTo(target()); kick(); }
  }

  // interaction: hover/tap a cell for its name and tile, hover a segment row to highlight it
  function pick(e) {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    hover = null;
    if (G) { let best = 14 * 14; for (const c of G.cells) { const d = (X(c.px) - mx) ** 2 + (Y(c.py) - my) ** 2; if (d < best) { best = d; hover = c; } } }
    if (hover) {
      const on = P.segs.filter(s => s.from.cell === hover.name || s.to.cell === hover.name);
      const nets = [...new Set(on.map(s => s.net).filter(Boolean))].slice(0, 2);
      tip.textContent = `${hover.name.replace(/^dut\./, '')}\n${KIND[hover.kind]} @ X${hover.x}/Y${hover.y}` + (nets.length ? `\nnet ${nets.join(', ')}` : '');
      tip.style.display = 'block';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.max(4, Math.min(mx + 14, W() - tw - 4)) + 'px';
      tip.style.top = Math.max(4, my + 14 + th > H() ? my - th - 10 : my + 14) + 'px';
    } else tip.style.display = 'none';
    kick();
  }
  cv.addEventListener('pointermove', pick);
  cv.addEventListener('pointerdown', pick);
  cv.addEventListener('pointerleave', () => { tip.style.display = 'none'; hover = null; kick(); });
  $('segs').addEventListener('pointerover', e => { const d = e.target.closest('.mdv-seg'); hoverSeg = d ? +d.dataset.i : -1; kick(); });
  $('segs').addEventListener('pointerleave', () => { hoverSeg = -1; kick(); });
  $('die').onclick = () => { dieMode = !dieMode; $('die').setAttribute('aria-pressed', dieMode); $('die').textContent = dieMode ? 'fit path' : 'full die'; glideTo(); };
  $('play').onclick = () => { playing = !playing; t0 = performance.now(); $('play').setAttribute('aria-pressed', !playing); $('play').textContent = playing ? 'pause' : 'play'; kick(); };
  if (!playing) { $('play').setAttribute('aria-pressed', 'true'); $('play').textContent = 'play'; }

  const ro = new ResizeObserver(() => { if (!glide) view = fitTo(target()); kick(); });
  ro.observe(stage);
  const io = new IntersectionObserver(es => { visible = es[0].isIntersecting; kick(); });
  io.observe(stage);
  const onVis = () => kick();
  document.addEventListener('visibilitychange', onVis);
  const mq = matchMedia('(prefers-color-scheme: dark)'), onScheme = () => { tokens(); side(); kick(); };
  mq.addEventListener('change', onScheme);
  const mo = new MutationObserver(onScheme);
  mo.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'style', 'class']});

  set(report, false);
  return {
    update(r) { set(r, true); },
    destroy() {
      cancelAnimationFrame(raf); cancelAnimationFrame(numAnim); clearTimeout(numGuard); ro.disconnect(); io.disconnect(); mo.disconnect();
      mq.removeEventListener('change', onScheme); document.removeEventListener('visibilitychange', onVis); root.remove();
    },
  };
}
