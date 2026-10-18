// 06-yosys: real `synth_ecp5` of pwm_led. Passes stream in on the left; on the right the RTL
// netlist (PROC) appears block by block and then morphs into ECP5 primitives, and the real
// `stat` table fills the dock. All numbers come from data/06-yosys.json (real/yosys/).
const NS = 'http://www.w3.org/2000/svg';
const TYPE_COLOR = { LUT4: '#2563eb', TRELLIS_FF: '#f59e0b', CCU2C: '#7c3aed', PFUMX: '#0891b2', L6MUX21: '#db2777' };
const TYPE_ABBR = { LUT4: 'LUT', TRELLIS_FF: 'FF', CCU2C: 'CC', PFUMX: 'MX5', L6MUX21: 'MX6' };
const TYPE_NOTE = { CCU2C: 'carry chain', LUT4: '4-input LUT', TRELLIS_FF: 'flip-flop', PFUMX: 'LUT5 mux', L6MUX21: 'LUT6 mux' };
const ECP_ORDER = ['LUT4', 'TRELLIS_FF', 'CCU2C', 'PFUMX', 'L6MUX21'];
// RTL (generic) cells: one soft indigo ramp, by category
const RTL_CAT = (t) => /\$(add|sub)/.test(t) ? 'arith' : /\$(lt|eq)/.test(t) ? 'cmp' : /\$sdff/.test(t) ? 'ff' : 'logic';
const CAT_COLOR = { arith: '#4338ca', cmp: '#6366f1', ff: '#818cf8', logic: '#a5b4fc' };
const CAT_NAME = { arith: 'adders', cmp: 'compares', ff: 'registers', logic: 'logic / mux' };
// which RTL category an ECP5 primitive "comes from" (for the morph flight path only)
const SRC_CAT = { CCU2C: ['arith', 'cmp'], TRELLIS_FF: ['ff'], LUT4: ['logic', 'cmp', 'arith'], PFUMX: ['logic'], L6MUX21: ['logic'] };
const KEY_PASSES = new Set(['PROC', 'OPT', 'FSM', 'ALUMACC', 'TECHMAP', 'DFFLEGALIZE', 'ABC9', 'HIERARCHY', 'AUTONAME', 'SYNTH_LATTICE']);
const EASE = 'cubic-bezier(.16,1,.3,1)';

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let timers = [];
let alive = false;
const later = (fn, ms) => timers.push(setTimeout(() => alive && fn(), ms));

// best-fit grid of n chips of aspect `a` (w/h) inside an iw×ih box, centred
function fitGrid(x, y, iw, ih, n, a, maxW, gap) {
  iw = Math.max(iw, n * 4 + gap * n); ih = Math.max(ih, 12 + gap * n);
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let cw = Math.min((iw - gap * (cols - 1)) / cols, maxW);
    let ch = Math.min((ih - gap * (rows - 1)) / rows, maxW / a);
    ch = Math.min(ch, cw / a); cw = ch * a;
    if (ch <= 0) continue;
    if (!best || cw * ch > best.cw * best.ch) best = { cols, rows, cw, ch };
  }
  const { cols, rows, cw, ch } = best;
  const uw = cols * cw + (cols - 1) * gap, uh = rows * ch + (rows - 1) * gap;
  const x0 = x + (iw - uw) / 2, y0 = y + (ih - uh) / 2;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols;
    const rx = x0 + (uw - (inRow * cw + (inRow - 1) * gap)) / 2; // centre a short last row
    return { x: rx + (i % cols) * (cw + gap), y: y0 + r * (ch + gap), w: cw, h: ch };
  });
}

// pack groups of squares (each group starts a new row) into the box; returns cells + chain links
function packGroups(x, y, iw, ih, groups) {
  const total = groups.reduce((s, g) => s + g.n, 0);
  let s = 36, gap, gg, layout;
  for (; s > 6; s -= .5) {
    gap = Math.max(2, s * .16); gg = s * .45;
    const cols = Math.max(1, Math.floor((iw + gap) / (s + gap)));
    const h = groups.reduce((acc, g) => acc + Math.ceil(g.n / cols) * (s + gap) - gap, 0) + gg * (groups.length - 1);
    if (h <= ih && (cols >= Math.min(total, 4))) { layout = { cols, h }; break; }
  }
  if (!layout) layout = { cols: Math.max(1, Math.floor((iw + gap) / (s + gap))), h: ih };
  const cells = [], links = [];
  let cy = y + (ih - layout.h) / 2;
  for (const g of groups) {
    const rows = Math.ceil(g.n / layout.cols);
    for (let r = 0; r < rows; r++) {
      const inRow = Math.min(layout.cols, g.n - r * layout.cols);
      const rw = inRow * s + (inRow - 1) * gap, rx = x + (iw - rw) / 2;
      for (let c = 0; c < inRow; c++) {
        const k = cells.length;
        cells.push({ t: g.types[r * layout.cols + c], x: rx + c * (s + gap), y: cy + r * (s + gap), w: s, h: s });
        if (g.chain && c > 0 && cells[k].t === 'CCU2C' && cells[k - 1].t === 'CCU2C') links.push([k - 1, k]);
      }
    }
    cy += rows * (s + gap) - gap + gg;
  }
  return { cells, links, s };
}

// the 8 LED comparators: 8 lanes of a 4-CCU2C carry chain + its TRELLIS_FF, plus the shared LUT4 pool
function packLanes(x, y, iw, ih, e) {
  const lanes = 8, per = Math.round((e.CCU2C || 0) / lanes), luts = e.LUT4 || 0, ffs = e.TRELLIS_FF || 0;
  let s = 34, gap, res;
  for (; s > 6; s -= .5) {
    gap = Math.max(2, s * .16);
    const laneH = lanes * (s + gap) - gap;
    const labW = 16, laneW = labW + per * (s + gap) + s * .7 + s;
    const prow = Math.max(1, Math.floor((ih + gap) / (s + gap)));
    const pcols = Math.ceil(luts / prow);
    const poolW = pcols * (s + gap) - gap;
    if (laneH <= ih && laneW + s * 1.2 + poolW <= iw) { res = { laneH, labW, laneW, prow, pcols, poolW }; break; }
  }
  if (!res) return null;
  const cells = [], links = [], labels = [];
  const totalW = res.laneW + s * 1.2 + res.poolW, x0 = x + (iw - totalW) / 2, y0 = y + (ih - res.laneH) / 2;
  for (let l = 0; l < lanes; l++) {
    const ly = y0 + l * (s + gap);
    labels.push({ x: x0 + res.labW - 6, y: ly + s / 2, t: String(l) });
    for (let c = 0; c < per; c++) {
      const k = cells.length;
      cells.push({ t: 'CCU2C', x: x0 + res.labW + c * (s + gap), y: ly, w: s, h: s });
      if (c > 0) links.push([k - 1, k]);
    }
    if (l < ffs) {
      const k = cells.length;
      cells.push({ t: 'TRELLIS_FF', x: x0 + res.labW + per * (s + gap) + s * .7 - gap, y: ly, w: s, h: s });
      links.push([k - 1, k]);
    }
  }
  const px = x0 + res.laneW + s * 1.2, rowsUsed = Math.ceil(luts / res.pcols);
  const py = y + (ih - (rowsUsed * (s + gap) - gap)) / 2;
  for (let i = 0; i < luts; i++) cells.push({ t: 'LUT4', x: px + (i % res.pcols) * (s + gap), y: py + Math.floor(i / res.pcols) * (s + gap), w: s, h: s });
  return { cells, links, labels, s, pool: { x: px, y: py, w: res.poolW } };
}

export default {
  id: '06-yosys',
  tool: 'Yosys',
  title: 'Synthesis: turning Verilog into ECP5 logic cells',
  css: true,

  async mount(root, ctx) {
    alive = true;
    this.d = await ctx.data('06-yosys');
    const d = this.d;
    this.ver = 'Yosys 0.70+145';
    this.state = { blocks: { pwm: 'ghost', pre: 'ghost', fsm: 'ghost', led: 'ghost' }, wires: false };
    root.innerHTML = `
    <div class="ys-grid">
      <div class="glass window ys-win ys-term-win">
        <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>yosys</b> · synth_ecp5</div><span class="ys-badge ys-passbadge">pass 0/${d.passes.length}</span></div>
        <div class="ys-progress"><i></i></div>
        <div class="term ys-term"></div>
      </div>
      <div class="glass window ys-win ys-sch-win">
        <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="title"><b>Netlist viewer</b> · pwm_led</div>
          <span class="ys-badge ys-phase">reading pwm_led.v</span></div>
        <div class="ys-sch"><svg preserveAspectRatio="xMidYMid meet"></svg></div>
        <div class="ys-dock">
          <div class="ys-stat"></div>
          <div class="callout ys-callout"><h4>What this means</h4><div class="ys-callout-body">Yosys reads our Verilog and rebuilds it from the parts an ECP5 FPGA actually has.</div></div>
        </div>
      </div>
    </div>`;
    this.root = root;
    this.term = root.querySelector('.ys-term');
    this.sch = root.querySelector('.ys-sch');
    this.svg = root.querySelector('svg');
    this.k = 1;
    this.buildSchematic();
    this.renderStat(d.rtl_stat, 'rtl', { pending: true });
    let rt;
    this.ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (!alive || !this.L) return;
        const w = Math.max(480, this.sch.clientWidth), h = Math.max(260, this.sch.clientHeight);
        if (Math.abs(w - this.L.W) > 2 || Math.abs(h - this.L.H) > 2) this.buildSchematic(); // only on a real size change
      }, 150);
    });
    this.ro.observe(this.sch);
  },

  // ---------- geometry ----------
  layout() {
    const W = Math.max(480, this.sch.clientWidth), H = Math.max(260, this.sch.clientHeight);
    const pad = 14, pinW = 58, outW = 112, busH = 30;
    const x0 = pad + pinW + 34, x1 = W - pad - outW;
    const gx = clamp(W * .055, 54, 88);
    const avail = x1 - x0 - 2 * gx;
    const c1 = avail * .25, c2 = avail * .33, c3 = avail - c1 - c2;
    const y0 = pad, y1 = H - pad - busH, Ht = y1 - y0, gy = 14;
    const hp = (Ht - gy) * .44;
    const fy = y0 + clamp(Ht * .17, 46, 120);
    const G = {
      pwm: { x: x0, y: y0, w: c1, h: hp },
      pre: { x: x0, y: y0 + hp + gy, w: c1, h: Ht - hp - gy },
      fsm: { x: x0 + c1 + gx, y: fy, w: c2, h: y1 - fy },
      led: { x: x0 + c1 + gx + c2 + gx, y: y0, w: c3, h: Ht },
    };
    return { W, H, pad, x0, x1, y0, y1, gx, G, busY: H - pad - 8 };
  },

  buildSchematic() {
    const svg = this.svg, d = this.d, L = this.L = this.layout();
    svg.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`);
    svg.replaceChildren();
    const defs = el('defs', {}, svg);
    defs.innerHTML = `<marker id="ys-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--tool)"/></marker>`;
    const gRails = el('g', { class: 'ys-rails' }, svg);
    this.gWires = el('g', { class: 'ys-wires' }, svg);
    const gBlocks = el('g', {}, svg);
    const G = L.G;

    // I/O pins
    const pins = el('g', {}, svg);
    const pin = (x, y, label, right) => {
      el('path', { d: `M${x},${y - 9} h16 l9,9 l-9,9 h-16 z`, class: 'ys-pinshape' }, pins);
      el('text', { x: right ? x + 31 : x - 7, y: y + 4, 'text-anchor': right ? 'start' : 'end', class: 'ys-pinlabel' }, pins).textContent = label;
    };
    const px = L.pad + 30;
    const clkY = G.pwm.y + G.pwm.h * .62, rstY = G.pre.y + G.pre.h * .5;
    pin(px, clkY, 'clk'); pin(px, rstY, 'rst');
    const outX = L.x1 + 18, outY = G.led.y + G.led.h * .5;
    pin(outX, outY, 'led[7:0]', true);
    el('text', { x: outX + 31, y: outY + 20, class: 'ys-pinsub' }, pins).textContent = '8 bits';

    // clk / rst rails to every flip-flop
    const xr = L.x0 - 20, xr2 = L.x0 - 12;
    const tip = px + 25;
    const bus1 = L.busY - 6, bus2 = L.busY;
    const r = [];
    r.push(`M${tip},${clkY} H${xr} V${bus1} H${G.led.x + 28}`);
    r.push(`M${tip},${rstY} H${xr2} V${bus2} H${G.led.x + 36}`);
    for (const id of ['pwm', 'pre']) { const g = G[id]; r.push(`M${xr},${g.y + g.h - 16} H${g.x}`, `M${xr2},${g.y + g.h - 9} H${g.x}`); }
    for (const id of ['fsm', 'led']) { const g = G[id]; r.push(`M${g.x + 28},${bus1} V${g.y + g.h}`, `M${g.x + 36},${bus2} V${g.y + g.h}`); }
    el('path', { d: r.join(' '), class: 'ys-rail' }, gRails);
    const ffs = d.ecp5_stat.types.TRELLIS_FF;
    el('text', { x: (G.fsm.x + G.led.x) / 2 + 20, y: bus2 + 0.5, 'text-anchor': 'middle', class: 'ys-raillabel', 'dominant-baseline': 'middle' }, gRails)
      .textContent = `clk · rst → all ${ffs} flip-flops`;

    // data-flow wires (real block-to-block connectivity from the mapped netlist)
    const pwmWireY = G.pwm.y + Math.min(G.pwm.h * .32, (G.fsm.y - G.pwm.y) / 2);
    const route = {
      'pwm>led': [[G.pwm.x + G.pwm.w, pwmWireY], [G.led.x, pwmWireY]],
      'pre>fsm': [[G.pre.x + G.pre.w, G.pre.y + G.pre.h * .45], [G.fsm.x, G.pre.y + G.pre.h * .45]],
      'fsm>led': [[G.fsm.x + G.fsm.w, G.fsm.y + G.fsm.h * .5], [G.led.x, G.fsm.y + G.fsm.h * .5]],
      'led>out:led': [[G.led.x + G.led.w, outY], [outX - 1, outY]],
    };
    const names = { 'pwm>led': 'pwm_cnt', 'pre>fsm': 'tick', 'fsm>led': 'duty', 'led>out:led': '' };
    this.wires = [];
    for (const e of d.edges) {
      const key = `${e.from}>${e.to}`, rr = route[key]; if (!rr) continue;
      const [[x1, y1], [x2, y2]] = rr, mx = (x1 + x2) / 2;
      const p = el('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`, class: 'ys-wire' }, this.gWires);
      const len = p.getTotalLength();
      const t = el('text', { x: mx, y: Math.min(y1, y2) - 7, class: 'ys-wirelabel', 'text-anchor': 'middle' }, this.gWires);
      if (!names[key]) t.style.display = 'none';
      else if (x2 - x1 > 130) t.textContent = `${names[key]} · ${e.bits}b`;
      else {
        el('tspan', { x: mx, dy: '-1.15em', class: 'nm' }, t).textContent = names[key];
        el('tspan', { x: mx, dy: '1.15em' }, t).textContent = `${e.bits}b`;
      }
      if (!this.state.wires) { p.style.strokeDasharray = len; p.style.strokeDashoffset = len; }
      else { p.classList.add('flow'); p.setAttribute('marker-end', 'url(#ys-arrow)'); t.classList.add('in'); }
      this.wires.push({ p, t, len });
    }

    // blocks
    this.blocks = {};
    for (const b of d.blocks) {
      const g = G[b.id];
      const gb = el('g', { class: 'ys-block' }, gBlocks);
      const card = el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 10, class: 'ys-card' }, gb);
      el('text', { x: g.x + 14, y: g.y + 22, class: 'ys-btitle' }, gb).textContent = b.label;
      const sub = el('text', { x: g.x + 14, y: g.y + 38, class: 'ys-bsub' }, gb); sub.textContent = b.rtl;
      const foot = el('text', { x: g.x + 14, y: g.y + g.h - 11, class: 'ys-bfoot' }, gb);
      const tag = el('text', { x: g.x + g.w - 14, y: g.y + 22, class: 'ys-btag', 'text-anchor': 'end' }, gb);
      const chips = el('g', {}, gb);
      const area = { x: g.x + 12, y: g.y + 50, w: g.w - 24, h: g.h - 50 - 26 };
      const B = { b, g, gb, card, chips, foot, tag, area, rtlPos: [], rtlChips: [] };
      this.blocks[b.id] = B;
      this.drawBlock(B, this.state.blocks[b.id], false);
    }
  },

  // hide the header tag when the block is too narrow for title + tag
  fitTag(B) {
    B.tag.style.display = '';
    try {
      const tw = B.gb.querySelector('.ys-btitle').getComputedTextLength(), gw = B.tag.getComputedTextLength();
      if (tw + gw + 40 > B.g.w) B.tag.style.display = 'none';
    } catch (e) { /* not rendered yet */ }
  },

  rtlItems(B) {
    const ord = { arith: 0, cmp: 1, ff: 2, logic: 3 };
    return [...B.b.rtl_cells].sort((a, b) => ord[RTL_CAT(a.t)] - ord[RTL_CAT(b.t)] || a.t.localeCompare(b.t));
  },

  rtlLayout(B) {
    const items = this.rtlItems(B), a = B.area;
    const pos = fitGrid(a.x, a.y, a.w, a.h, items.length, 3.3, 124, 6);
    return items.map((c, i) => ({ ...pos[i], c, cat: RTL_CAT(c.t), cx: pos[i].x + pos[i].w / 2, cy: pos[i].y + pos[i].h / 2 }));
  },

  ecpLayout(B) {
    const e = B.b.ecp5, a = B.area;
    if (B.b.id === 'led') { const r = packLanes(a.x, a.y, a.w, a.h, e); if (r) return r; }
    const groups = [];
    const push = (types, chain) => { const n = types.length; if (n) groups.push({ n, types, chain }); };
    const fewLuts = (e.LUT4 || 0) <= 2; // a lone LUT4 sits at the end of the carry-chain row
    push([...Array(e.CCU2C || 0).fill('CCU2C'), ...(fewLuts ? Array(e.LUT4 || 0).fill('LUT4') : [])], true);
    if (!fewLuts) push(Array(e.LUT4 || 0).fill('LUT4'));
    push([...Array(e.PFUMX || 0).fill('PFUMX'), ...Array(e.L6MUX21 || 0).fill('L6MUX21')]);
    push(Array(e.TRELLIS_FF || 0).fill('TRELLIS_FF'));
    return { ...packGroups(a.x, a.y, a.w, a.h, groups), labels: [] };
  },

  // draw a block in state 'ghost' | 'rtl' | 'ecp5'; animate=true plays the entry transition
  drawBlock(B, mode, animate) {
    B.chips.replaceChildren();
    B.rtlChips = [];
    const k = this.k;
    if (mode === 'ghost' || mode === 'rtl') {
      const pos = this.rtlLayout(B);
      B.rtlPos = pos;
      pos.forEach((p, i) => {
        if (mode === 'ghost') { el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 5, class: 'ys-ghost' }, B.chips); return; }
        const g = el('g', { class: 'ys-rchip' }, B.chips);
        el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 5, class: 'ys-rbox' }, g);
        el('rect', { x: p.x, y: p.y + 3, width: 3, height: p.h - 6, rx: 1.5, fill: CAT_COLOR[p.cat] }, g);
        const label = `${p.c.t.replace('$', '')}${p.c.w > 1 ? '·' + p.c.w : ''}`;
        const fs = Math.min(11.5, p.h * .46, (p.w - 12) / (label.length * .62));
        el('text', { x: p.x + p.w / 2 + 1.5, y: p.y + p.h / 2 + fs * .36, 'text-anchor': 'middle', style: `font-size:${fs}px` }, g).textContent = label;
        if (animate) {
          g.style.opacity = 0; g.style.transform = 'translateY(8px)';
          g.style.transition = `opacity ${450 * k}ms ${EASE} ${i * 28 * k}ms, transform ${600 * k}ms ${EASE} ${i * 28 * k}ms`;
        }
        B.rtlChips.push(g);
      });
      const n = pos.length;
      B.foot.textContent = mode === 'ghost' ? '' : `${n} RTL cell${n > 1 ? 's' : ''}`;
      B.tag.textContent = mode === 'ghost' ? '' : 'generic RTL';
      B.card.classList.toggle('live', mode === 'rtl');
      this.fitTag(B);
      if (animate) requestAnimationFrame(() => requestAnimationFrame(() => B.rtlChips.forEach(g => { g.style.opacity = 1; g.style.transform = 'none'; })));
      return;
    }
    // ecp5
    const L = this.ecpLayout(B);
    const nodes = [];
    for (const lb of L.labels) el('text', { x: lb.x, y: lb.y + 3.5, class: 'ys-lane', 'text-anchor': 'end' }, B.chips).textContent = lb.t;
    const gl = el('g', { class: 'ys-links' }, B.chips);
    for (const [a, b] of L.links) {
      const A = L.cells[a], C = L.cells[b];
      el('line', { x1: A.x + A.w, y1: A.y + A.h / 2, x2: C.x, y2: C.y + C.h / 2, stroke: C.t === 'TRELLIS_FF' ? '#d4d4d8' : TYPE_COLOR.CCU2C }, gl);
    }
    L.cells.forEach((c) => {
      const g = el('g', { class: 'ys-echip' }, B.chips);
      el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: Math.min(5, c.w * .18), fill: TYPE_COLOR[c.t] }, g);
      if (c.w >= 22) {
        const fs = Math.min(10.5, c.w * .32);
        el('text', { x: c.x + c.w / 2, y: c.y + c.h / 2 + fs * .36, 'text-anchor': 'middle', style: `font-size:${fs}px` }, g).textContent = TYPE_ABBR[c.t];
      }
      nodes.push({ g, c });
    });
    const e = B.b.ecp5, mux = (e.PFUMX || 0) + (e.L6MUX21 || 0), total = L.cells.length;
    B.foot.textContent = [e.CCU2C && `${e.CCU2C} CCU2C`, e.LUT4 && `${e.LUT4} LUT4`, mux && `${mux} MUX`, e.TRELLIS_FF && `${e.TRELLIS_FF} FF`].filter(Boolean).join(' · ');
    B.tag.textContent = `${B.b.rtl_cells.length} → ${total} cells`;
    B.card.classList.add('live');
    this.fitTag(B);
    if (B.b.id === 'led' && L.pool) el('text', { x: L.pool.x + L.pool.w / 2, y: L.pool.y - 7, 'text-anchor': 'middle', class: 'ys-lane' }, B.chips).textContent = 'LUT4s';
    if (!animate) return;
    // flight: every primitive starts at the RTL cell it implements and settles into place
    const src = B.rtlPos;
    const used = {};
    const stagger = Math.min(16, 640 / Math.max(1, nodes.length));
    gl.style.opacity = 0;
    gl.style.transition = `opacity ${500 * k}ms ${EASE} ${(nodes.length * stagger + 350) * k}ms`;
    nodes.forEach(({ g, c }, i) => {
      let s = null;
      if (src.length) {
        const cands = src.filter(p => SRC_CAT[c.t].includes(p.cat));
        const pool = cands.length ? cands : src;
        const j = (used[c.t] = (used[c.t] || 0) + 1) - 1;
        s = pool[j % pool.length];
      }
      const dx = s ? s.cx - (c.x + c.w / 2) : 0, dy = s ? s.cy - (c.y + c.h / 2) : 0;
      g.style.transformBox = 'fill-box'; g.style.transformOrigin = 'center';
      g.style.transform = `translate(${dx}px, ${dy}px) scale(.3)`; g.style.opacity = 0;
      const dl = (120 + i * stagger) * k;
      g.style.transition = `transform ${760 * k}ms ${EASE} ${dl}ms, opacity ${380 * k}ms ${EASE} ${dl}ms`;
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      nodes.forEach(({ g }) => { g.style.transform = 'none'; g.style.opacity = 1; });
      gl.style.opacity = 1;
    }));
  },

  showRtl(id) {
    const B = this.blocks[id];
    this.state.blocks[id] = 'rtl';
    this.drawBlock(B, 'rtl', true);
  },

  morph(id) {
    const B = this.blocks[id], k = this.k;
    this.state.blocks[id] = 'ecp5';
    B.card.classList.add('hot');
    // RTL chips dissolve while the primitives fly out of them
    const old = B.rtlChips.slice();
    const ghost = el('g', {}, B.gb);
    old.forEach((g, i) => {
      ghost.appendChild(g);
      g.style.transformBox = 'fill-box'; g.style.transformOrigin = 'center';
      g.style.transition = `opacity ${320 * k}ms ${EASE} ${i * 10 * k}ms, transform ${420 * k}ms ${EASE} ${i * 10 * k}ms`;
    });
    this.drawBlock(B, 'ecp5', true);
    B.gb.appendChild(ghost);
    requestAnimationFrame(() => old.forEach(g => { g.style.opacity = 0; g.style.transform = 'scale(.82)'; }));
    later(() => ghost.remove(), (600 + old.length * 10) * k);
    later(() => B.card.classList.remove('hot'), 1300 * k);
  },

  drawWires() {
    this.state.wires = true;
    const k = this.k;
    this.wires.forEach((w, i) => {
      w.p.style.transition = `stroke-dashoffset ${900 * k}ms ${EASE} ${i * 160 * k}ms`;
      requestAnimationFrame(() => { w.p.style.strokeDashoffset = 0; });
      later(() => { w.p.style.strokeDasharray = ''; w.p.setAttribute('marker-end', 'url(#ys-arrow)'); w.p.classList.add('flow'); w.t.classList.add('in'); }, (900 + i * 160) * k);
    });
  },

  // ---------- stat dock ----------
  renderStat(stat, kind, { pending = false, dur = 900 } = {}) {
    const box = this.root.querySelector('.ys-stat');
    let entries;
    if (kind === 'rtl') {
      const ord = { arith: 0, cmp: 1, ff: 2, logic: 3 };
      entries = Object.entries(stat.types).map(([t, n]) => ({ t, n, c: CAT_COLOR[RTL_CAT(t)], cat: RTL_CAT(t) }))
        .sort((a, b) => ord[a.cat] - ord[b.cat] || b.n - a.n);
    } else {
      entries = ECP_ORDER.filter(t => stat.types[t]).map(t => ({ t, n: stat.types[t], c: TYPE_COLOR[t], note: TYPE_NOTE[t] }));
    }
    const tot = stat.cells;
    box.className = `ys-stat ${kind}${pending ? ' pending' : ''}`;
    box.innerHTML = `
      <div class="ys-stat-h"><span class="ys-stat-k">stat</span><span class="ys-stat-which">${kind === 'rtl' ? 'RTL netlist · after proc' : 'ECP5 netlist · after synth_ecp5'}</span>
        <span class="ys-stat-tot"><b class="ys-total">${pending ? tot : 0}</b> cells · ${stat.wire_bits} wire bits</span></div>
      <div class="ys-sbar">${entries.map(e => `<i style="background:${e.c}" data-w="${(e.n / tot) * 100}"></i>`).join('')}</div>
      <div class="ys-sgrid">${entries.map((e, i) => `
        <div class="ys-si" style="transition-delay:${i * 40}ms"><i style="background:${e.c}"></i><span class="t">${esc(e.t)}</span><b data-n="${e.n}">${pending ? e.n : 0}</b>${e.note ? `<span class="note">${e.note}</span>` : ''}</div>`).join('')}</div>`;
    const segs = box.querySelectorAll('.ys-sbar i');
    if (pending) { segs.forEach(s => (s.style.width = s.dataset.w + '%')); box.querySelectorAll('.ys-si').forEach(s => s.classList.add('in')); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      segs.forEach(s => (s.style.width = s.dataset.w + '%'));
      box.querySelectorAll('.ys-si').forEach(s => s.classList.add('in'));
    }));
    box.querySelectorAll('.ys-si b').forEach(n => this.tweenEl(n, +n.dataset.n, dur));
    this.tweenEl(box.querySelector('.ys-total'), tot, dur);
  },

  tweenEl(node, to, dur) {
    const t0 = performance.now();
    const step = (t) => {
      const q = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - q, 3);
      node.textContent = Math.round(to * e);
      if (q < 1 && alive) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  // ---------- terminal ----------
  line(html, cls = '') {
    const div = document.createElement('div');
    div.className = 'ys-line ' + cls; div.innerHTML = html;
    this.term.appendChild(div);
    while (this.term.children.length > 220) this.term.firstChild.remove();
    this.term.scrollTop = this.term.scrollHeight;
    return div;
  },

  setPhase(text, cls = '') { const p = this.root.querySelector('.ys-phase'); p.textContent = text; p.className = 'ys-badge ys-phase ' + cls; },
  callout(html) {
    const b = this.root.querySelector('.ys-callout-body');
    b.style.opacity = 0; b.style.transform = 'translateY(4px)';
    later(() => { b.innerHTML = html; b.style.opacity = 1; b.style.transform = 'none'; }, 220);
  },

  // switch to figure speed: ctx.sleep runs at normal speed; CSS/RAF durations scale with ctx.speed
  visual(ctx) { ctx.visual(); this.k = 1 / ctx.speed; },
  skim(ctx) { ctx.skim(); },

  // ---------- live ECP5 counter (running total as blocks map) ----------
  updateLive(ids, dur) {
    const d = this.d, box = this.root.querySelector('.ys-stat'), fin = d.ecp5_stat;
    const types = {}; let cells = 0;
    for (const b of d.blocks) if (ids.includes(b.id)) for (const [t, n] of Object.entries(b.ecp5)) { types[t] = (types[t] || 0) + n; cells += n; }
    if (!box.classList.contains('live')) {
      const entries = ECP_ORDER.filter(t => fin.types[t]);
      box.className = 'ys-stat ecp5 live';
      box.innerHTML = `
        <div class="ys-stat-h"><span class="ys-stat-k">stat</span><span class="ys-stat-which">ECP5 cells mapped so far</span>
          <span class="ys-stat-tot"><b class="ys-total" data-v="0">0</b> / ${fin.cells} cells · from ${d.rtl_stat.cells} RTL</span></div>
        <div class="ys-sbar">${entries.map(t => `<i data-t="${t}" style="background:${TYPE_COLOR[t]}"></i>`).join('')}</div>
        <div class="ys-sgrid">${entries.map(t => `
          <div class="ys-si in"><i style="background:${TYPE_COLOR[t]}"></i><span class="t">${t}</span><b data-t="${t}" data-v="0">0</b><span class="note">${TYPE_NOTE[t]}</span></div>`).join('')}</div>`;
    }
    requestAnimationFrame(() => box.querySelectorAll('.ys-sbar i').forEach(s => { s.style.width = `${((types[s.dataset.t] || 0) / fin.cells) * 100}%`; }));
    box.querySelectorAll('.ys-si b').forEach(n => this.tweenTo(n, types[n.dataset.t] || 0, dur));
    this.tweenTo(box.querySelector('.ys-total'), cells, dur);
  },
  tweenTo(node, to, dur) {
    const from = +node.dataset.v || 0; node.dataset.v = to;
    if (from === to) return;
    node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
    const t0 = performance.now();
    const step = (t) => {
      const q = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - q, 3);
      node.textContent = Math.round(from + (to - from) * e);
      if (q < 1 && alive) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  // captions stay up >= 2.4 s (playback-speed scaled) before the next one replaces them
  async say(ctx, text) {
    const pb = ctx.skimming ? ctx.speed / 4 : ctx.speed;
    if (this.capAt) {
      const wait = 2400 / pb - (performance.now() - this.capAt);
      if (wait > 0) await new Promise((res, rej) => {
        const t = setTimeout(res, wait);
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
    }
    ctx.narrate(text); this.capAt = performance.now();
  },
  // camera target in untransformed scene px (offset chain + SVG coords are 1:1 with .ys-sch px)
  sceneRect(el, box) {
    let x = 0, y = 0, n = el;
    while (n && n !== this.root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    if (n !== this.root) { const r = this.root.getBoundingClientRect(), q = el.getBoundingClientRect(); x = q.left - r.left; y = q.top - r.top; }
    return box ? { x: x + box.x, y: y + box.y, w: box.w, h: box.h } : { x, y, w: el.offsetWidth, h: el.offsetHeight };
  },
  focusRect(ctx, r, max = 1.8, pad = 28) {
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const scale = Math.max(1.1, Math.min(max, W / (r.w + pad * 2), H / (r.h + pad * 2)));
    ctx.focus?.(r, { scale, ms: 900, pad });
  },
  // camera push (core makes focus a no-op on 2D scenes unless essential) + a spotlight that dims the other blocks
  focusBlock(ctx, id, max = 1.8) { this.focusRect(ctx, this.sceneRect(this.sch, this.blocks[id].g), max); this.spot(id); },
  spot(id) { for (const k in this.blocks) this.blocks[k].gb.classList.toggle('dim', !!id && k !== id); },

  async play(ctx) {
    const d = this.d;
    // reset to the mounted state (play may be re-run)
    this.state = { blocks: { pwm: 'ghost', pre: 'ghost', fsm: 'ghost', led: 'ghost' }, wires: false };
    this.k = 1; this.capAt = 0;
    this.buildSchematic();
    this.renderStat(d.rtl_stat, 'rtl', { pending: true });
    this.setPhase('reading pwm_led.v');
    this.term.replaceChildren();
    ctx.skim();

    await this.say(ctx, 'An FPGA has no "+" or "<". So how does our code run on one?');
    const cmdLine = this.line('<span class="prompt">real/yosys $</span> <span class="cmd"></span><span class="caret"></span>');
    await ctx.typeInto(cmdLine.querySelector('.cmd'), d.command.replace(' -l yosys.log', ''), 110);
    cmdLine.querySelector('.caret').remove();
    this.line(`<span class="dim">${this.ver} (git sha1 a31d95ea0, Release)</span>`);
    this.line(`<span class="ys-desc">1. Executing Verilog-2005 frontend: ../rtl/pwm_led.v</span>`);
    await ctx.sleep(200);

    const badge = this.root.querySelector('.ys-passbadge');
    const bar = this.root.querySelector('.ys-progress i');
    const total = d.passes.length;
    const morphAt = { ALUMACC: ['pwm', 'pre'], DFFLEGALIZE: ['fsm'], ABC9: ['led'] };
    const mapped = [];
    const done = new Set();
    let rtlShown = false;
    for (let i = 0; i < total; i++) {
      const p = d.passes[i];
      badge.textContent = `pass ${i + 1}/${total}`;
      bar.style.width = `${((i + 1) / total) * 100}%`;
      const key = KEY_PASSES.has(p.name) || !!morphAt[p.name];
      this.line(`<span class="ys-num">${p.num}</span> <span class="ys-pname ${key ? 'key' : ''}">${esc(p.name)}</span> <span class="ys-desc">${esc(p.desc)}</span>`, key ? 'key' : '');
      if (key) for (const s of p.sample.slice(0, 2)) this.line(`<span class="ys-sample">   ${esc(s)}</span>`, 'sample');

      if (p.name === 'PROC' && !rtlShown) {
        rtlShown = true;
        this.visual(ctx);
        await this.say(ctx, `Yosys reads the Verilog as ${d.rtl_stat.cells} generic parts.`);
        this.setPhase(`RTL netlist · ${d.rtl_stat.cells} cells`, 'on');
        this.renderStat(d.rtl_stat, 'rtl', { dur: 1100 * this.k });
        for (const id of ['pwm', 'pre', 'fsm', 'led']) { this.showRtl(id); await ctx.sleep(280); }
        this.drawWires();
        this.callout(`PROC rewrote our <b>always @(posedge clk)</b> block as <b>${d.rtl_stat.cells} generic cells</b>: ${d.rtl_stat.types.$add} adders, ${d.rtl_stat.types.$lt} less-than compares and ${d.rtl_stat.types.$sdff + d.rtl_stat.types.$sdffe} register groups. Nothing chip-specific yet.`);
        await ctx.sleep(1500);
        this.skim(ctx);
      }
      if (morphAt[p.name] && !done.has(p.name)) {
        done.add(p.name);
        this.visual(ctx);
        if (p.name === 'ALUMACC') {
          await this.say(ctx, 'Each counter becomes a carry chain plus a row of flip-flops.');
          this.setPhase('mapping to ECP5…', 'warn');
          this.callout('Each counter becomes a <b>CCU2C carry chain</b> (2 bits per cell) feeding a row of <b>TRELLIS_FF</b> registers: 4 cells for the 8-bit PWM counter, 8 for the 16-bit prescaler.');
        }
        if (p.name === 'DFFLEGALIZE') {
          await this.say(ctx, 'The breathing logic turns into lookup tables and muxes.');
          this.callout('The duty ramp and direction flip become <b>LUT4</b> lookup tables, <b>PFUMX / L6MUX21</b> muxes, an 8-cell carry chain for duty ± 1 and 9 flip-flops.');
        }
        if (p.name === 'ABC9') {
          await this.say(ctx, '8 LEDs, 8 identical lanes: one comparator chain each.');
          this.callout('Each of the eight <b>phase comparators</b> <code>(pwm_cnt + 32·i) &lt; duty</code> becomes its own <b>4-cell carry chain</b> and one flip-flop, sharing a pool of LUT4s.');
        }
        const ids = morphAt[p.name];
        for (let j = 0; j < ids.length; j++) {
          const id = ids[j];
          this.focusBlock(ctx, id, 1.8);
          await ctx.sleep(750);                      // camera arrives
          this.morph(id);
          mapped.push(id);
          this.updateLive(mapped, 1100 * this.k);
          await ctx.sleep(j < ids.length - 1 ? 1300 : (id === 'led' ? 2000 : 1500));
        }
        ctx.unfocus?.({ ms: 700 });
        this.spot(null);
        await ctx.sleep(500);
        this.skim(ctx);
      }
      await ctx.sleep(key ? 200 : 90);
    }
    this.line('<span class="ok">✔ JSON netlist written: pwm_led.json</span>');
    this.line(`<span class="ok">✔ stat: ${d.ecp5_stat.cells} cells</span> <span class="dim">· End of script, ${d.log_lines} log lines</span>`);
    this.visual(ctx);
    const t = d.ecp5_stat.types;
    await this.say(ctx, `${d.rtl_stat.cells} generic parts → ${d.ecp5_stat.cells} real cells: ${t.LUT4} LUTs, ${t.TRELLIS_FF} FFs, ${t.CCU2C} carry.`);
    this.setPhase(`ECP5 netlist · ${d.ecp5_stat.cells} cells`, 'pass');
    const st = this.root.querySelector('.ys-stat');
    st.querySelector('.ys-stat-which').textContent = 'ECP5 netlist · after synth_ecp5';
    st.querySelector('.ys-stat-tot').innerHTML = `<b class="ys-total bump">${d.ecp5_stat.cells}</b> cells · ${d.ecp5_stat.wire_bits} wire bits · from ${d.rtl_stat.cells} RTL`;
    this.callout(`Our design is now <b>${t.LUT4} LUT4s</b>, <b>${t.TRELLIS_FF} flip-flops</b> and <b>${t.CCU2C} CCU2C</b> carry cells. The <b>8× phase compare</b> block is the largest: ${d.blocks.find(b => b.id === 'led').ecp5.CCU2C} of the carry cells are its comparators.`);
    ctx.emit('metric', { key: 'luts', label: 'LUT4s', value: t.LUT4, unit: '' });
    ctx.emit('metric', { key: 'ffs', label: 'Flip-flops', value: t.TRELLIS_FF, unit: '' });
    ctx.emit('metric', { key: 'carry', label: 'CCU2C carry cells', value: t.CCU2C, unit: '' });
    ctx.emit('metric', { key: 'cells', label: 'ECP5 cells', value: d.ecp5_stat.cells, unit: '' });
    this.focusRect(ctx, this.sceneRect(st), 1.7, 20);
    await ctx.sleep(2500);
    ctx.unfocus?.({ ms: 800 });
    await this.say(ctx, `${d.ecp5_stat.cells} real cells. Next: where on the chip does each one go?`);
    await ctx.sleep(1500);
  },

  unmount() {
    timers.forEach(clearTimeout); timers = [];
    this.ro?.disconnect();
    this.capAt = 0;
    alive = false;
  },
};
