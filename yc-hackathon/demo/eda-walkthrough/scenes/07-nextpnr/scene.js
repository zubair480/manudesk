// 07-nextpnr: real place & route of pwm_led on an LFE5U-85F (ULX3S). Cells move from a random
// start to their real BEL locations, real routed tiles are drawn as wires, then timing, utilisation
// and the bitstream. Data: data/07-nextpnr.json (extracted from real/nextpnr/routed.json + report.json)
const INK = '#0a0a0a', ACCENT = '#2563eb';
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ease = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
const lerp = (a, b, k) => a + (b - a) * k;

let alive = false;
let timers = [];

function mst(pts) {
  if (pts.length < 2) return [];
  const inside = [pts[0]], rest = pts.slice(1), segs = [];
  while (rest.length) {
    let best = null;
    for (const a of inside) rest.forEach((b, j) => {
      const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      if (!best || d < best[0]) best = [d, a, j];
    });
    const b = rest.splice(best[2], 1)[0];
    segs.push([best[1][0], best[1][1], b[0], b[1]]); inside.push(b);
  }
  return segs;
}

export default {
  id: '07-nextpnr',
  tool: 'nextpnr',
  title: 'Place & route: putting every cell on the real ECP5 die',
  css: true,

  async mount(root, ctx) {
    alive = true;
    const [d, log] = await Promise.all([ctx.data('07-nextpnr'), ctx.text('real/nextpnr/nextpnr.log')]);
    this.d = d;
    this.log = log.split(/\r?\n/);
    root.innerHTML = `
    <div class="np-grid">
      <div class="window panel np-term-win">
        <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>nextpnr-ecp5</b> · 0.11.1</div><span class="badge np-stage">idle</span></div>
        <div class="term np-term"></div>
      </div>
      <div class="np-right"><div class="np-main">
        <div class="window panel np-fp-win">
          <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>Floorplan</b> · ${d.device} · ${d.package}</div><span class="np-hud mono"></span></div>
          <div class="np-fp"><canvas></canvas>
            <div class="np-overlay">
              <div class="np-metric"><span class="l">wirelength</span><span class="v mono np-wl">–</span></div>
              <div class="np-metric"><span class="l">arcs routed</span><span class="v mono np-arcs">0 / ${d.arcs}</span></div>
            </div>
            <div class="np-legend"><span><i class="lg-lut"></i>logic LUT</span><span><i class="lg-carry"></i>carry LUT</span><span><i class="lg-ff"></i>flip-flop</span><span><i class="lg-io"></i>I/O pin</span><span><i class="lg-crit"></i>critical path</span></div>
          </div>
        </div>
        <div class="np-cards">
          <div class="panel np-card np-util"><div class="np-card-h">Utilisation <span class="mono">${d.device}</span></div><div class="np-bars"></div></div>
          <div class="panel np-card np-timing"><div class="np-card-h">Timing <span class="badge np-tbadge">pending</span></div>
            <div class="np-gauge"><svg viewBox="0 0 200 116"><path class="np-arc-bg" d="M14,104 A86,86 0 0 1 186,104"/><path class="np-arc" d="M14,104 A86,86 0 0 1 186,104"/><line class="np-tick" x1="0" y1="0" x2="0" y2="0"/><text class="np-tick-l" x="0" y="0"></text></svg>
              <div class="np-fmax"><span class="v np-fv">0.0</span><span class="u">MHz Fmax</span><span class="c">target ${d.fmax.constraint} MHz</span></div></div></div>
          <div class="panel np-card np-bit"><div class="np-card-h">Bitstream <span class="badge np-bbadge">waiting</span></div>
            <div class="np-bitbody"><div class="np-file mono">pwm_led.bit</div><div class="np-bytes mono">–</div><div class="np-bitbar"><i></i></div><div class="np-bitnote">ecppack --compress</div></div></div>
        </div></div>
        <div class="callout np-callout"><h4>What this means</h4><div class="np-cbody">nextpnr decides where on the chip each of the 254 cells lives, then connects them through the FPGA's routing fabric.</div></div>
      </div>
    </div>`;
    this.root = root;
    this.term = root.querySelector('.np-term');
    this.canvas = root.querySelector('canvas');
    this.g = this.canvas.getContext('2d');
    this.prepare();
    this.buildBars();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas.parentElement);
    this.resize();
    const loop = () => { if (!alive) return; this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  },

  prepare() {
    const d = this.d;
    // deterministic pseudo-random start positions (the "random placement" nextpnr begins with)
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.cells = d.cells.map(c => {
      const carry = /CCU2/.test(c.n);
      const isIo = c.t === 'TRELLIS_IO';
      let fx = c.x + .5, fy = c.y + .5;
      if (c.t === 'TRELLIS_COMB' || c.t === 'TRELLIS_FF') {
        const slice = Math.floor(c.k / 4), sub = c.k % 4;
        fx = c.x + .14 + slice * .19 + .02; fy = c.y + .12 + sub * .19 + .02;
      } else if (isIo) { fx = c.x + .5; fy = c.y + .14 + c.k * .19 + .02; }
      return { ...c, carry, fx, fy, sx: rnd() * d.grid.w, sy: rnd() * d.grid.h, delay: isIo || c.t === 'DCCA' ? 0 : rnd() * .55 };
    });
    // routed nets: segments between real routed tiles (MST), clock net drawn as its own tree
    this.segs = [];
    for (const n of d.nets) {
      const segs = n.glob ? mst(n.pts) : n.segs;
      for (const s of segs) this.segs.push({ s, glob: n.glob, net: n.n });
    }
    // interleave so wires appear all over the cluster, not net by net
    this.segs.sort((a, b) => ((a.s[0] * 7 + a.s[1] * 13) % 17) - ((b.s[0] * 7 + b.s[1] * 13) % 17));
    const cp = d.critical_path;
    this.crit = cp.map(p => p.loc);
    this.critNs = cp.reduce((a, p) => a + p.delay, 0);
    this.state = { place: 0, legal: 0, route: 0, crit: 0, show: 0 };
    this.cam = { x0: -2, y0: -2, x1: d.grid.w + 2, y1: d.grid.h + 2 };
    this.camFrom = null;
  },

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.W = r.width; this.H = r.height;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  zoomTo(box, ms) { this.camFrom = { ...this.cam }; this.camTo = box; this.camT0 = performance.now(); this.camMs = ms; },
  anim(key, to, ms) {
    const from = this.state[key], t0 = performance.now();
    return new Promise(res => {
      const step = (t) => {
        if (!alive) return res();
        const k = Math.min(1, (t - t0) / ms); this.state[key] = lerp(from, to, ease(k));
        if (k < 1) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  },

  view() {
    if (this.camFrom) {
      const k = ease((performance.now() - this.camT0) / this.camMs);
      for (const p of ['x0', 'y0', 'x1', 'y1']) this.cam[p] = lerp(this.camFrom[p], this.camTo[p], k);
      if (k >= 1) this.camFrom = null;
    }
    const { x0, y0, x1, y1 } = this.cam;
    const s = Math.min(this.W / (x1 - x0), this.H / (y1 - y0));
    const ox = (this.W - (x1 - x0) * s) / 2 - x0 * s, oy = (this.H - (y1 - y0) * s) / 2 - y0 * s;
    return { s, X: (x) => ox + x * s, Y: (y) => oy + y * s };
  },

  draw() {
    const g = this.g, W = this.W, H = this.H, d = this.d;
    if (!W) return;
    const v = this.view(), s = v.s;
    g.clearRect(0, 0, W, H);
    // die outline + tile lattice
    g.fillStyle = '#fbfbfb'; g.strokeStyle = '#e4e4e7'; g.lineWidth = 1;
    const dx0 = v.X(0), dy0 = v.Y(0), dw = d.grid.w * s, dh = d.grid.h * s;
    g.fillRect(dx0, dy0, dw, dh); g.strokeRect(dx0 + .5, dy0 + .5, dw, dh);
    const tx0 = Math.max(0, Math.floor(this.cam.x0)), tx1 = Math.min(d.grid.w, Math.ceil(this.cam.x1));
    const ty0 = Math.max(0, Math.floor(this.cam.y0)), ty1 = Math.min(d.grid.h, Math.ceil(this.cam.y1));
    if (s > 9) {
      g.fillStyle = '#f1f1f3';
      const pad = Math.max(1, s * .06);
      for (let x = tx0; x < tx1; x++) for (let y = ty0; y < ty1; y++) {
        if (x === 0 || y === 0 || x === d.grid.w - 1 || y === d.grid.h - 1) continue;
        g.fillRect(v.X(x) + pad, v.Y(y) + pad, s - pad * 2, s - pad * 2);
      }
    } else {
      g.fillStyle = '#e4e4e7';
      const step = s < 3 ? 2 : 1;
      for (let x = tx0; x < tx1; x += step) for (let y = ty0; y < ty1; y += step) g.fillRect(v.X(x + .5) - .5, v.Y(y + .5) - .5, 1, 1);
    }
    // I/O ring
    g.strokeStyle = '#d4d4d8'; g.lineWidth = Math.max(1, s * .08);
    g.strokeRect(v.X(.5), v.Y(.5), (d.grid.w - 1) * s, (d.grid.h - 1) * s);

    // routes
    const nR = Math.floor(this.state.route * this.segs.length);
    if (nR > 0) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (let i = 0; i < nR; i++) {
        const { s: [x1, y1, x2, y2], glob } = this.segs[i];
        const fresh = i > nR - 40 && this.state.route < 1;
        g.strokeStyle = glob ? 'rgba(10,10,10,.22)' : fresh ? ACCENT : 'rgba(37,99,235,.38)';
        g.lineWidth = glob ? Math.max(.8, s * .05) : Math.max(.9, s * (fresh ? .09 : .06));
        g.setLineDash(glob ? [Math.max(2, s * .2), Math.max(2, s * .2)] : []);
        g.beginPath(); g.moveTo(v.X(x1 + .5), v.Y(y1 + .5)); g.lineTo(v.X(x2 + .5), v.Y(y1 + .5)); g.lineTo(v.X(x2 + .5), v.Y(y2 + .5)); g.stroke();
      }
      g.setLineDash([]);
    }

    // cells
    const pk = this.state.place, lk = this.state.legal, show = this.state.show;
    if (show > 0) {
      const cs = Math.max(1.6, s * .15);
      for (const c of this.cells) {
        const k = ease((pk - c.delay) / .45);
        // global placement converges near the target, legalisation snaps onto the BEL
        const jx = (1 - lk) * Math.sin(c.sx * 3.1) * 1.4, jy = (1 - lk) * Math.cos(c.sy * 2.7) * 1.4;
        const x = lerp(c.sx, c.fx + jx, k), y = lerp(c.sy, c.fy + jy, k);
        const px = v.X(x), py = v.Y(y);
        g.globalAlpha = show;
        if (c.t === 'TRELLIS_FF') { g.fillStyle = '#fff'; g.strokeStyle = INK; g.lineWidth = Math.max(.7, cs * .14); g.fillRect(px, py, cs, cs); g.strokeRect(px, py, cs, cs); }
        else if (c.t === 'TRELLIS_IO') { g.fillStyle = INK; g.beginPath(); g.arc(px, py + cs / 2, Math.max(2, s * .12), 0, 7); g.fill(); }
        else if (c.t === 'DCCA') { g.fillStyle = '#71717a'; g.fillRect(px - cs / 2, py, cs * 1.5, cs); }
        else { g.fillStyle = c.carry ? '#52525b' : INK; g.fillRect(px, py, cs, cs); }
      }
      g.globalAlpha = 1;
    }

    // critical path
    if (this.state.crit > 0) {
      const pts = this.crit; const n = Math.max(2, Math.ceil(this.state.crit * pts.length));
      g.strokeStyle = ACCENT; g.lineWidth = Math.max(2, s * .14); g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      pts.slice(0, n).forEach((p, i) => { const x = v.X(p[0] + .5), y = v.Y(p[1] + .5); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
      g.fillStyle = ACCENT;
      for (const p of [pts[0], pts[n - 1]]) { g.beginPath(); g.arc(v.X(p[0] + .5), v.Y(p[1] + .5), Math.max(3, s * .16), 0, 7); g.fill(); }
      if (this.state.crit > .98) {
        const p = pts[0];
        g.font = '500 12px Geist, Inter, sans-serif'; g.fillStyle = ACCENT;
        g.fillText(`critical path · ${this.critNs.toFixed(2)} ns`, v.X(p[0] + 1.3), v.Y(p[1] - .6));
      }
    }
    // labels for pins when zoomed in
    if (s > 12 && show > .9) {
      g.font = '500 11px "Geist Mono", monospace'; g.fillStyle = '#71717a';
      const byTile = new Map();
      for (const c of this.cells) if (c.t === 'TRELLIS_IO') {
        const k = c.x + ',' + c.y; if (!byTile.has(k)) byTile.set(k, { c, names: [] });
        byTile.get(k).names.push(c.n.replace('$tr_io', ''));
      }
      for (const { c, names } of byTile.values()) {
        if (c.y >= this.cam.y1 - 1) continue;
        const bits = names.map(n => n.match(/\[(\d+)\]/)).filter(Boolean).map(m => m[1]).sort();
        const nm = bits.length ? `led[${bits.join(',')}]` : names.join(' ');
        g.fillText(nm, v.X(c.x) - 6 - g.measureText(nm).width, v.Y(c.y + .5) + 4);
      }
    }
    this.root.querySelector('.np-hud').textContent = `${Math.round(this.cam.x1 - this.cam.x0)}×${Math.round(this.cam.y1 - this.cam.y0)} tiles`;
  },

  buildBars() {
    const u = this.d.utilization;
    const rows = [['TRELLIS_COMB', 'LUT4 + carry'], ['TRELLIS_FF', 'Flip-flops'], ['TRELLIS_IO', 'I/O pins'], ['DCCA', 'Clock buffers']];
    this.root.querySelector('.np-bars').innerHTML = rows.map(([k, l]) => {
      const r = u[k]; const pct = (r.used / r.available) * 100;
      return `<div class="np-bar" data-pct="${pct}">
        <div class="np-bar-t"><span>${l}</span><span class="mono"><b data-n="${r.used}">0</b> / ${r.available.toLocaleString()} · ${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%</span></div>
        <div class="np-track"><i></i></div></div>`;
    }).join('');
  },

  fillBars() {
    this.root.querySelectorAll('.np-bar').forEach((b, i) => {
      const pct = +b.dataset.pct;
      timers.push(setTimeout(() => {
        b.classList.add('in');
        b.querySelector('i').style.width = Math.max(.6, pct) + '%';
        this.count(b.querySelector('b'), +b.querySelector('b').dataset.n, 900);
      }, i * 120));
    });
  },

  count(node, to, ms, dec = 0, suffix = '') {
    const t0 = performance.now();
    const step = (t) => {
      if (!alive) return;
      const k = ease((t - t0) / ms); node.textContent = (to * k).toFixed(dec) + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  gauge() {
    const svg = this.root.querySelector('.np-gauge svg');
    const arc = svg.querySelector('.np-arc'), len = arc.getTotalLength();
    const max = 250, f = this.d.fmax.achieved, c = this.d.fmax.constraint;
    arc.style.strokeDasharray = len; arc.style.strokeDashoffset = len;
    // constraint tick
    const a = Math.PI * (1 - c / max), cx = 100, cy = 104, r1 = 76, r2 = 96;
    const tick = svg.querySelector('.np-tick');
    tick.setAttribute('x1', cx + r1 * Math.cos(a)); tick.setAttribute('y1', cy - r1 * Math.sin(a));
    tick.setAttribute('x2', cx + r2 * Math.cos(a)); tick.setAttribute('y2', cy - r2 * Math.sin(a));
    const tl = svg.querySelector('.np-tick-l'); tl.setAttribute('x', cx + 100 * Math.cos(a) - 2); tl.setAttribute('y', cy - 100 * Math.sin(a) - 2); tl.setAttribute('text-anchor', 'end'); tl.textContent = `${c}`;
    arc.classList.add('go');
    requestAnimationFrame(() => { arc.style.strokeDashoffset = len * (1 - Math.min(1, f / max)); });
    this.count(this.root.querySelector('.np-fv'), f, 1400, 2);
  },

  line(text, cls = '') {
    const div = document.createElement('div');
    div.className = 'np-line ' + cls; div.innerHTML = text;
    this.term.appendChild(div);
    while (this.term.children.length > 160) this.term.firstChild.remove();
    this.term.scrollTop = this.term.scrollHeight;
  },
  stage(t, cls = '') { const b = this.root.querySelector('.np-stage'); b.textContent = t; b.className = 'badge np-stage ' + cls; },
  callout(html) { const b = this.root.querySelector('.np-cbody'); b.style.opacity = 0; timers.push(setTimeout(() => { b.innerHTML = html; b.style.opacity = 1; }, 220)); },

  // stream log lines from `from` until a line matching `until` (inclusive)
  async stream(ctx, until, ms = 26) {
    while (this.li < this.log.length) {
      const l = this.log[this.li++];
      if (!l.trim()) continue;
      if (/:\s+0\/\s*\d+\s+0%/.test(l) || /Defined in:|cells_map_trellis|\.\.\/rtl\/pwm_led\.v:\d/.test(l) || /RAMW? LUTs/.test(l) || /^Info: \[ *\d+,|Slack histogram|legend:|represents/.test(l)) continue;
      const t = esc(l.replace(/^Info: ?/, ''));
      const cls = /PASS|complete|successful|finished normally/.test(l) ? 'ok' : /Max frequency|Routing \d+ arcs|wirelen/.test(l) ? 'hl' : '';
      this.line(cls === 'ok' ? `<span class="ok">${t}</span>` : t, cls);
      await ctx.sleep(ms);
      if (until && until.test(l)) return l;
    }
  },

  async play(ctx) {
    const d = this.d;
    this.li = 0; this.term.replaceChildren();
    this.state = { place: 0, legal: 0, route: 0, crit: 0, show: 0 };
    this.cam = { x0: -2, y0: -2, x1: d.grid.w + 2, y1: d.grid.h + 2 }; this.camFrom = null;
    const wl = this.root.querySelector('.np-wl'), arcsEl = this.root.querySelector('.np-arcs');

    this.line('<span class="prompt">real/nextpnr $</span> <span class="cmd"></span><span class="caret"></span>');
    const cmd = this.term.lastChild;
    ctx.narrate('nextpnr loads the Yosys netlist and the ULX3S pin constraints');
    await ctx.typeInto(cmd.querySelector('.cmd'), d.command[0].replace(' -l nextpnr.log', ''), 140);
    cmd.querySelector('.caret').remove();
    this.stage('packing');
    await this.stream(ctx, /Device utilisation/, 30);
    await this.stream(ctx, /TRELLIS_COMB/, 30);
    this.fillBars();
    this.callout(`The whole design needs <b>202 LUTs</b> and <b>41 flip-flops</b> out of 83,640 each: about <b>0.24%</b> of the chip. The 10 I/O cells are pinned to the ULX3S clock, button and LED pads.`);

    // --- placement
    this.stage('placing', 'info');
    ctx.narrate('Placement starts from random positions, then the analytic HeAP placer pulls connected cells together');
    wl.textContent = '8955';
    this.anim('show', 1, 500);
    await this.stream(ctx, /Creating initial analytic placement/, 40);
    const placing = this.anim('place', 1, 2600);
    const heap = d.heap;
    const wlSeq = [8955, 154, 135, 132, 149, ...heap.map(h => h[3])];
    let wi = 0;
    const wlTimer = setInterval(() => { if (wi < wlSeq.length) wl.textContent = wlSeq[wi++]; }, 2600 / wlSeq.length);
    timers.push(wlTimer);
    await this.stream(ctx, /HeAP Placer Time/, 120);
    await placing; clearInterval(wlTimer);
    const hT = 17, wT = Math.max(hT, hT * (this.W / this.H));
    this.zoomTo({ x0: -5.5, y0: 31.5, x1: -5.5 + wT, y1: 31.5 + hT }, 2400);
    ctx.narrate('Simulated annealing refines it: wirelength drops from 481 to 352');
    const legal = this.anim('legal', 1, 1600);
    for (const s of d.sa) { await this.stream(ctx, /at iteration #\d+: temp/, 200); wl.textContent = s[2]; }
    await legal;
    await this.stream(ctx, /PASS at/, 30);
    this.callout('Every LUT and flip-flop now sits in a real <b>SLICE</b> on the die, clustered next to the left-edge I/O bank where the LED pins are. The die is a <b>126 × 96</b> grid of tiles; we use a corner of it.');
    await ctx.sleep(600);

    // --- routing
    this.stage('routing', 'info');
    ctx.narrate(`The router connects ${d.arcs} arcs through the real switch fabric; the clock rides the global network`);
    await this.stream(ctx, /Routing \d+ arcs/, 40);
    const t0 = performance.now(), rMs = 3600;
    const arcTimer = setInterval(() => { const k = Math.min(1, (performance.now() - t0) / rMs); arcsEl.textContent = `${Math.round(k * d.arcs)} / ${d.arcs}`; }, 50);
    timers.push(arcTimer);
    const routing = this.anim('route', 1, rMs);
    await this.stream(ctx, /Routing complete/, 260);
    await routing; clearInterval(arcTimer); arcsEl.textContent = `${d.arcs} / ${d.arcs}`;
    this.callout('Each blue line is a net, drawn through the actual routing tiles nextpnr used (the dashed tree is the global clock). The long wire entering from the bottom is <b>rst</b>, from button pad R1 at the far edge of the die.');

    // --- timing
    this.stage('timing', 'info');
    ctx.narrate('Static timing analysis finds the slowest register-to-register path');
    await this.stream(ctx, /1\.51 ns logic/, 70);
    this.anim('crit', 1, 1400);
    await this.stream(ctx, /Max frequency for clock.*214/, 22);
    this.gauge();
    const tb = this.root.querySelector('.np-tbadge'); tb.textContent = 'PASS'; tb.className = 'badge pass np-tbadge';
    this.callout(`The worst path is <b>${this.critNs.toFixed(2)} ns</b>: from a <b>duty</b> flip-flop through the direction logic and back. That allows <b>${d.fmax.achieved} MHz</b>; the ULX3S clock is ${d.fmax.constraint} MHz, so we have <b>${(d.fmax.achieved / d.fmax.constraint).toFixed(1)}×</b> headroom.`);
    ctx.narrate(`Fmax ${d.fmax.achieved} MHz: PASS at ${d.fmax.constraint} MHz`);
    await this.stream(ctx, /finished normally/, 14);
    await ctx.sleep(900);

    // --- bitstream
    this.stage('ecppack', 'info');
    this.line('<span class="prompt">real/nextpnr $</span> <span class="cmd"></span><span class="caret"></span>');
    const c2 = this.term.lastChild;
    await ctx.typeInto(c2.querySelector('.cmd'), d.command[1], 60);
    c2.querySelector('.caret').remove();
    const bit = this.root.querySelector('.np-bit');
    bit.classList.add('go');
    this.count(bit.querySelector('.np-bytes'), d.bitstream.bytes, 1400, 0, ' bytes');
    await ctx.sleep(1500);
    bit.querySelector('.np-bytes').textContent = `${d.bitstream.bytes.toLocaleString()} bytes`;
    const bb = this.root.querySelector('.np-bbadge'); bb.textContent = 'written'; bb.className = 'badge pass np-bbadge';
    this.line(`<span class="ok">bitstream written: pwm_led.bit (${d.bitstream.bytes.toLocaleString()} bytes)</span>`);
    this.stage('done', 'pass');
    ctx.narrate('Bitstream written: pwm_led.bit is ready to flash onto the ULX3S');
    const u = d.utilization;
    ctx.emit('metric', { key: 'fmax', label: 'Fmax', value: d.fmax.achieved, unit: 'MHz' });
    ctx.emit('metric', { key: 'fmax_target', label: 'Clock target', value: d.fmax.constraint, unit: 'MHz' });
    ctx.emit('metric', { key: 'utilization', label: 'LUT utilisation', value: +((u.TRELLIS_COMB.used / u.TRELLIS_COMB.available) * 100).toFixed(2), unit: '%' });
    ctx.emit('metric', { key: 'routed_arcs', label: 'Routed arcs', value: d.arcs, unit: '' });
    ctx.emit('metric', { key: 'bitstream_bytes', label: 'Bitstream', value: d.bitstream.bytes, unit: 'bytes' });
    await ctx.sleep(3000);
  },

  unmount() {
    alive = false;
    timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers = [];
    this.ro?.disconnect();
  },
};
