// 2D PCB editor canvas: footprints, ratsnest, tracks and vias from data/09-kicad.json (real Freerouting output).
const COL = {
  // KiCad-light: white canvas, real KiCad copper colours, mustard silkscreen / Edge.Cuts
  bg: '#ffffff', board: '#fbfaf2', edge: '#b8930f', silk: '#9a7b0a', court: 'rgba(0,0,0,.10)',
  pad: '#c9a227', padTh: '#c39a1d', drill: '#ffffff', drillRing: 'rgba(0,0,0,.35)', fcu: '#c83434', bcu: '#3b63d8', via: '#c8961e', rats: '#9ca3af',
};
const ease = (t) => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);

export function createPCB(canvas, data) {
  const ctx = canvas.getContext('2d');
  const B = data.board;
  const partOf = {};          // "x,y" of a pad -> part ref
  data.parts.forEach(p => p.pads.forEach(pd => { partOf[`${pd.x},${pd.y}`] = p.ref; }));
  const rats = data.ratsnest.map(r => ({ ...r, pa: partOf[`${r.a[0]},${r.a[1]}`], pb: partOf[`${r.b[0]},${r.b[1]}`] }));

  // tracks sorted into a left-to-right sweep, with cumulative lengths for a progressive "wipe"
  const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  const wires = data.wires.map(w => ({ ...w, L: len(w.pts), minx: Math.min(...w.pts.map(p => p[0])) }))
    .sort((a, b) => a.minx - b.minx);
  let acc = 0; const total = wires.reduce((s, w) => s + w.L, 0);
  wires.forEach(w => { w.s0 = acc / total; acc += w.L; w.s1 = acc / total; });
  const netDone = {};
  wires.forEach(w => { netDone[w.net] = Math.max(netDone[w.net] || 0, w.s1); });
  const vias = data.vias.map(v => {
    // a via appears when the first wire touching it has been drawn
    const near = wires.filter(w => w.net === v.net && w.pts.some(p => Math.hypot(p[0] - v.x, p[1] - v.y) < 0.05));
    return { ...v, at: near.length ? Math.min(...near.map(w => w.s1)) : 1 };
  });

  let R = { x: 0, y: 0, w: 1, h: 1, s: 1 }, dpr = 1, cw = 1, ch = 1;
  function layout(padX = 0) {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.max(1, r.width); ch = Math.max(1, r.height);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const m = Math.max(14, Math.min(cw, ch) * 0.035);
    const s = Math.min((cw - 2 * m - 2 * padX) / B.w, (ch - 2 * m) / B.h);
    R = { s, w: B.w * s, h: B.h * s, x: (cw - B.w * s) / 2, y: (ch - B.h * s) / 2 };
    return R;
  }

  const X = (x) => R.x + x * R.s, Y = (y) => R.y + y * R.s;

  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawPart(p, dx, dy, alpha) {
    const s = R.s;
    ctx.globalAlpha = alpha;
    const cx = X(p.x + dx), cy = Y(p.y + dy);
    if (p.kind !== 'hole') {
      ctx.strokeStyle = COL.court; ctx.lineWidth = 1;
      roundRect(cx - p.w / 2 * s - 0.35 * s, cy - p.h / 2 * s - 0.35 * s, (p.w + 0.7) * s, (p.h + 0.7) * s, 2); ctx.stroke();
    }
    for (const pd of p.pads) {
      const px = X(pd.x + dx), py = Y(pd.y + dy);
      ctx.fillStyle = pd.th ? COL.padTh : COL.pad;
      if (pd.s === 'c') { ctx.beginPath(); ctx.arc(px, py, pd.d / 2 * s, 0, 7); ctx.fill(); }
      else { roundRect(px - pd.w / 2 * s, py - pd.h / 2 * s, pd.w * s, pd.h * s, Math.min(pd.w, pd.h) * s * 0.18); ctx.fill(); }
      if (pd.drill) { ctx.fillStyle = COL.drill; ctx.strokeStyle = COL.drillRing; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, pd.drill / 2 * s, 0, 7); ctx.fill(); ctx.stroke(); }
    }
    // silkscreen
    ctx.strokeStyle = COL.silk; ctx.fillStyle = COL.silk; ctx.lineWidth = Math.max(1, 0.12 * s);
    if (p.kind === 'bga') {
      ctx.strokeRect(cx - 5 * s, cy - 5 * s, 10 * s, 10 * s);
      ctx.beginPath(); ctx.moveTo(cx - 5 * s, cy - 3.6 * s); ctx.lineTo(cx - 3.6 * s, cy - 5 * s); ctx.stroke();
    } else if (p.kind === 'header') {
      ctx.strokeRect(cx - p.w / 2 * s, cy - p.h / 2 * s, p.w * s, p.h * s);
    } else if (p.kind === 'usb' || p.kind === 'ldo' || p.kind === 'osc') {
      ctx.setLineDash([0.5 * s, 0.4 * s]); ctx.strokeRect(cx - p.w / 2 * s, cy - p.h / 2 * s, p.w * s, p.h * s); ctx.setLineDash([]);
    } else if (p.kind === 'led') {
      ctx.beginPath(); ctx.moveTo(cx - 0.8 * s, cy + 1.45 * s); ctx.lineTo(cx + 0.8 * s, cy + 1.45 * s); ctx.stroke();
    }
    const fs = Math.max(9, Math.min(15, (p.kind === 'res' || p.kind === 'led' || p.kind === 'cap' ? 0.95 : 1.3) * s));
    ctx.font = `600 ${fs}px "Geist Mono", ui-monospace, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (p.kind === 'bga') ctx.fillText('U1', cx, cy);
    else if (p.kind === 'res') ctx.fillText(p.ref, cx - 1.35 * s, cy);
    else if (p.kind === 'led') ctx.fillText(p.ref, cx - 1.45 * s, cy);
    else if (p.kind === 'cap') ctx.fillText(p.ref, cx, cy - 1.05 * s);
    else if (p.kind === 'hole') ctx.fillText(p.ref, cx, cy + 3.6 * s);
    else if (p.kind === 'header') ctx.fillText(p.ref, cx, cy - p.h / 2 * s - 1.1 * s);
    else ctx.fillText(p.ref, cx, cy - p.h / 2 * s - 0.9 * s);
    ctx.globalAlpha = 1;
  }

  function drawWire(w, frac) {
    const s = R.s;
    ctx.strokeStyle = w.layer === 'F.Cu' ? COL.fcu : COL.bcu;
    ctx.lineWidth = Math.max(1.2, w.w * s); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let left = frac * w.L;
    ctx.beginPath(); ctx.moveTo(X(w.pts[0][0]), Y(w.pts[0][1]));
    for (let i = 1; i < w.pts.length && left > 0; i++) {
      const [ax, ay] = w.pts[i - 1], [bx, by] = w.pts[i];
      const l = Math.hypot(bx - ax, by - ay), k = Math.min(1, left / (l || 1));
      ctx.lineTo(X(ax + (bx - ax) * k), Y(ay + (by - ay) * k)); left -= l;
    }
    ctx.stroke();
  }

  /** st: { bg, boardA, edge, partsA, offsets{ref:[dx,dy]}, ratsA, tracks (0..1), glowNet } */
  function draw(st) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.globalAlpha = st.bg ?? 1; ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, cw, ch);
    // fine grid
    ctx.globalAlpha = (st.bg ?? 1); ctx.fillStyle = 'rgba(0,0,0,.09)';
    const g = R.s * 2;
    for (let x = R.x % g; x < cw; x += g) for (let y = R.y % g; y < ch; y += g) ctx.fillRect(x, y, 1, 1);
    ctx.globalAlpha = 1;
    // board + Edge.Cuts
    if (st.boardA > 0) {
      ctx.globalAlpha = st.boardA; ctx.fillStyle = COL.board; roundRect(R.x, R.y, R.w, R.h, 1.5 * R.s); ctx.fill(); ctx.globalAlpha = 1;
    }
    if (st.edge > 0) {
      ctx.save(); ctx.strokeStyle = COL.edge; ctx.lineWidth = 1.8;
      const per = 2 * (R.w + R.h); ctx.setLineDash([per * st.edge, per]); roundRect(R.x, R.y, R.w, R.h, 1.5 * R.s); ctx.stroke(); ctx.restore();
    }
    // B.Cu under F.Cu
    const t = st.tracks || 0;
    if (t > 0) {
      for (const layer of ['B.Cu', 'F.Cu']) for (const w of wires) {
        if (w.layer !== layer || t <= w.s0) continue;
        drawWire(w, Math.min(1, (t - w.s0) / (w.s1 - w.s0)));
      }
    }
    // footprints
    if (st.partsA > 0) for (const p of data.parts) {
      const [dx, dy] = st.offsets?.[p.ref] || [0, 0];
      drawPart(p, dx, dy, st.partsA);
    }
    // vias
    if (t > 0) for (const v of vias) {
      if (t < v.at) continue;
      const k = ease((t - v.at) / 0.04);
      ctx.fillStyle = COL.via; ctx.beginPath(); ctx.arc(X(v.x), Y(v.y), v.d / 2 * R.s * (0.4 + 0.6 * k) + (1 - k) * 4, 0, 7); ctx.fill();
      ctx.fillStyle = COL.drill; ctx.beginPath(); ctx.arc(X(v.x), Y(v.y), 0.15 * R.s, 0, 7); ctx.fill();
    }
    // ratsnest (follows the footprints while they move)
    if (st.ratsA > 0) {
      ctx.lineWidth = 0.9; ctx.strokeStyle = COL.rats;
      for (const r of rats) {
        const fade = t > 0 ? 1 - ease((t - netDone[r.net] + 0.06) / 0.06) : 1;
        if (fade <= 0) continue;
        const [ax, ay] = st.offsets?.[r.pa] || [0, 0], [bx, by] = st.offsets?.[r.pb] || [0, 0];
        ctx.globalAlpha = st.ratsA * fade;
        ctx.beginPath(); ctx.moveTo(X(r.a[0] + ax), Y(r.a[1] + ay)); ctx.lineTo(X(r.b[0] + bx), Y(r.b[1] + by)); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  /** Live readings at track-progress t (0..1), all derived from the real wires/vias/ratsnest. */
  function stats(t) {
    let f = 0, b = 0, len = 0;
    for (const w of wires) {
      if (t >= w.s1) { if (w.layer === 'F.Cu') f++; else b++; }
      len += w.L * Math.max(0, Math.min(1, (t - w.s0) / (w.s1 - w.s0)));
    }
    const nets = Object.values(netDone);
    return { tracks: f + b, f, b, len, vias: vias.filter(v => t >= v.at).length,
      unrouted: rats.filter(r => t < netDone[r.net]).length, netsRouted: nets.filter(d => t >= d).length, netsTotal: nets.length };
  }
  return { layout, draw, stats, total, get rect() { return R; }, counts: { wires: wires.length, vias: vias.length, rats: rats.length } };
}
