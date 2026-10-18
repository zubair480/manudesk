// Scene 01-code: the real RTL and testbench appear in fast blocks in a VS Code-style editor,
// while the circuit they describe builds up beside them, block by block. At the end the circuit
// comes alive, replaying the real Icarus trace (data/hw-trace.json) so the LEDs start breathing.
import { highlight, splitLines, esc } from './verilog.js';

const LH = 19;            // editor line height (px), must match scene.css (.ln height)
const NS = 'http://www.w3.org/2000/svg';
const PAL = { clk: '#71717a', rst: '#ef4444', pre: '#7c3aed', cnt: '#0891b2', duty: '#2563eb', dir: '#f59e0b', on: '#10b981', onDark: '#059669' };
const OFF = '#f4f4f5';

const ICONS = {
  files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.3-4.3"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
};
const icon = (p, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

let state = null;

export default {
  id: '01-code',
  tool: 'Verilog',
  title: 'Writing the design',
  css: true,

  async mount(root, ctx) {
    const [data, trace] = await Promise.all([ctx.data('01-code'), ctx.data('hw-trace').catch(() => null)]);
    const sources = {};
    for (const f of data.files) {
      const raw = await ctx.text(f.path);
      sources[f.name] = { lines: splitLines(raw), crlf: raw.includes('\r\n') };
    }
    root.innerHTML = `
      <div class="sa-code">
        <div class="vs glass window">
          <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div>
            <div class="title"><b class="t-file">pwm_led.v</b> — ${esc(data.workspace)} — Visual Studio Code</div>
            <div class="t-spacer"></div></div>
          <div class="vs-body">
            <nav class="vs-act">
              <span class="on">${icon(ICONS.files)}</span><span>${icon(ICONS.search)}</span>
              <span>${icon(ICONS.branch)}</span><span>${icon(ICONS.chip)}</span><span>${icon(ICONS.play)}</span>
              <span class="grow"></span><span>${icon(ICONS.gear)}</span>
            </nav>
            <aside class="vs-side">
              <div class="side-h">Explorer</div>
              <div class="side-ws">⌄ ${esc(data.workspace)}</div>
              <div class="tree">${data.tree.map((n) => `
                <div class="node${n.dir ? ' dir' : ''}${n.ghost ? ' ghost' : ''}" data-file="${n.file || ''}" style="--d:${n.depth}">
                  <span class="chev">${n.dir ? (n.closed ? '›' : '⌄') : ''}</span>
                  <span class="ico ${n.dir ? 'i-dir' : 'i-v'}">${n.dir ? '' : 'V'}</span>${esc(n.name)}
                </div>`).join('')}
              </div>
              <div class="side-h outline-h">Outline</div>
              <div class="outline"></div>
            </aside>
            <main class="vs-main">
              <div class="tabs"></div>
              <div class="crumbs"></div>
              <div class="ed-wrap"><div class="ed-scroll"><div class="ed-lines"></div></div></div>
            </main>
          </div>
          <footer class="vs-status">
            <span class="st-l">⎇ main</span><span class="st-prob">⊘ 0 &nbsp;⚠ 0</span>
            <span class="grow"></span>
            <span class="st-pos">Ln 1, Col 1</span><span>Spaces: 4</span><span>UTF-8</span><span class="st-eol">LF</span><span class="st-lang">{ } Verilog</span>
          </footer>
        </div>
        <section class="hw-panel">
          <div class="hw-stage"></div>
          <div class="hw-cards"></div>
        </section>
      </div>`;
    const $ = (s) => root.querySelector(s);
    state = { root, data, sources, $, timers: [], raf: 0, trace, offset: 0 };
    state.hw = buildCircuit($('.hw-stage'), trace);
  },

  async play(ctx) {
    const { data, sources } = state;
    const T = data.timing || {}, C = data.captions || {};
    ctx.visual?.();            // the circuit builds from the very first block, so play at normal speed
    ctx.narrate(C.intro);
    await ctx.sleep(T.intro ?? 900);

    for (const f of data.files) {
      openFile(f.name, sources[f.name]);
      if (f.role === 'testbench') reveal('tb');
      const lines = sources[f.name].lines;
      for (const b of f.blocks) {
        showLines(lines, b.lines[0], b.lines[1]);
        if (b.hw) reveal(b.hw);
        if (b.tb && data.tbChecks?.[b.tb]) pill(data.tbChecks[b.tb]);
        await ctx.sleep(f.step);
        if (b.callout === 'ramp') {
          ctx.focus?.(state.hw.el('tick'), { scale: T.focusTick ?? 2, ms: 700 });
          await callout(ctx, data.callouts.ramp, T.ramp ?? 2000, false, C.ramp);
          ctx.unfocus?.({ ms: 600 });
        }
      }
      setCaret(lines.length - 1);
      markSaved();
    }

    const rtl = sources['pwm_led.v'].lines.length, tb = sources['tb_pwm_led.v'].lines.length;
    ctx.emit('metric', { key: 'rtl-lines', label: 'RTL lines', value: rtl, unit: 'lines' });
    ctx.emit('metric', { key: 'tb-lines', label: 'Testbench lines', value: tb, unit: 'lines' });

    // the circuit comes alive: replay the real simulation trace while the LED callout explains it,
    // with pwm_led.v back in front so the highlighted comparator lines match the circuit
    const live = runLive(ctx, T.live ?? 4200);
    const rtlLines = sources['pwm_led.v'].lines;
    openFile('pwm_led.v', sources['pwm_led.v']);
    showLines(rtlLines, 1, rtlLines.length, true);
    const zoom = (async () => {
      await ctx.sleep(T.focusLedsAt ?? 600);
      ctx.focus?.(state.hw.el('cmps+leds'), { scale: T.focusLeds ?? 2.2, ms: 800 });
      await ctx.sleep(T.focusLedsHold ?? 2000);
      ctx.unfocus?.({ ms: 700 });
    })();
    await callout(ctx, data.callouts.leds, T.ledsCallout ?? 2200, true, C.leds);
    ctx.narrate(C.live);
    await Promise.all([live, zoom]);
    ctx.narrate(C.outro);
    loopLive();                // keep the circuit breathing after the scene finishes (stopped by unmount)
    await ctx.sleep(T.outro ?? 1800);
  },

  unmount() {
    if (!state) return;
    cancelAnimationFrame(state.raf);
    state.timers.forEach(clearTimeout);
    state.root.innerHTML = '';
    state = null;
  },
};

/* ---------------- editor ---------------- */

function openFile(name, src) {
  const { $, root } = state;
  root.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
  let tab = root.querySelector(`.tab[data-f="${name}"]`);
  if (!tab) {
    tab = document.createElement('div');
    tab.className = 'tab fade-in is-dirty';
    tab.dataset.f = name;
    tab.innerHTML = `<span class="ico i-v">V</span>${esc(name)}<span class="dirty">●</span>`;
    $('.tabs').appendChild(tab);
  }
  tab.classList.add('on');
  root.querySelectorAll('.node').forEach((n) => n.classList.toggle('sel', n.dataset.file === name));
  $('.t-file').textContent = name;
  $('.crumbs').innerHTML = `rtl <i>›</i> <span class="ico i-v">V</span> ${esc(name)} <i>›</i> <span class="crumb-mod"></span>`;
  $('.st-eol').textContent = src.crlf ? 'CRLF' : 'LF';
  $('.ed-lines').innerHTML = '';
  $('.outline').innerHTML = '';
  state.rows = [];
  scrollTo(0, true);
}

function showLines(lines, a, b, instant) {
  const box = state.$('.ed-lines');
  const frag = document.createDocumentFragment();
  state.rows.at(-1)?.querySelector('.cur')?.remove();
  for (let i = a - 1; i < b && i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = instant ? 'ln' : 'ln rv';
    row.style.animationDelay = `${(i - a + 1) * 14}ms`;
    row.innerHTML = `<span class="no">${i + 1}</span><span class="tx">${highlight(lines[i])}</span>`;
    frag.appendChild(row);
    state.rows.push(row);
    outline(lines[i]);
  }
  box.appendChild(frag);
  const last = Math.min(b, lines.length);
  state.$('.st-pos').textContent = `Ln ${last}, Col ${lines[last - 1].length + 1}`;
  const vh = state.$('.ed-scroll').clientHeight;
  scrollTo(Math.max(0, (last + 1.5) * LH + 6 - vh));
}

function setCaret(i) {
  const tx = state.rows[i]?.querySelector('.tx');
  if (tx && !tx.querySelector('.cur')) tx.insertAdjacentHTML('beforeend', '<span class="cur"></span>');
}

function scrollTo(y, instant) {
  const el = state.$('.ed-lines');
  state.offset = y;
  el.style.transition = instant ? 'none' : '';
  el.style.transform = `translateY(${-y}px)`;
}

function markSaved() {
  const tab = state.root.querySelector('.tab.on');
  if (!tab) return;
  tab.classList.remove('is-dirty');
  tab.classList.add('saved');
  state.timers.push(setTimeout(() => tab.classList.remove('saved'), 900));
}

function outline(text) {
  const m = text.match(/^\s*(module)\s+(\w+)|^\s*(reg|wire|integer|input|output)\b[^;]*?(\w+)\s*[;,=]/);
  if (!m) return;
  const name = m[2] || m[4];
  const kind = m[1] ? 'mod' : 'sig';
  const el = document.createElement('div');
  el.className = `ol ${kind} fade-in`;
  el.innerHTML = `<span>${kind === 'mod' ? '⬡' : '◇'}</span>${esc(name)}`;
  state.$('.outline').appendChild(el);
  if (kind === 'mod') state.$('.crumb-mod').textContent = name;
}

/* ---------------- callouts (small cards on the circuit + highlighted code lines) ---------------- */

async function callout(ctx, c, ms, keepLines, caption) {
  const [a, b] = c.range;
  const vh = state.$('.ed-scroll').clientHeight;
  const maxOff = Math.max(0, state.rows.length * LH + 12 - vh);
  scrollTo(Math.min(maxOff, Math.max(0, (a - 1) * LH - vh * 0.3)));
  state.rows.forEach((r, i) => r.classList.toggle('hl', i + 1 >= a && i + 1 <= b));
  state.hw.ring(c.parts);

  const card = document.createElement('div');
  card.className = 'hc';
  card.innerHTML = `<h4>${esc(c.title)}</h4><p>${c.body}</p>`;
  const layer = state.$('.hw-cards');
  layer.appendChild(card);
  const [x, y] = state.hw.toPx(c.anchor[0], c.anchor[1]);
  const lw = layer.clientWidth, lh = layer.clientHeight;
  card.style.left = `${Math.max(8, Math.min(x, lw - card.offsetWidth - 8))}px`;
  card.style.top = `${Math.max(8, Math.min(y, lh - card.offsetHeight - 8))}px`;
  if (caption) ctx.narrate(caption);
  await ctx.sleep(ms);
  card.classList.add('out');
  state.timers.push(setTimeout(() => card.remove(), 350));
  state.hw.ring([]);
  if (!keepLines) state.rows.forEach((r) => r.classList.remove('hl'));
}

function reveal(part) { state.hw.reveal(part); }
function pill(chk) { state.hw.pill(chk.part, chk.label); }

/* ---------------- live replay of the real trace ---------------- */

function runLive(ctx, ms) {
  const T = state.trace;
  const hw = state.hw;
  if (!T) return ctx.sleep(ms);
  hw.goLive(T);
  const n = T.cols.duty.length;
  const from = 4, to = Math.min(n - 1, 3900);
  const dur = ms / (ctx.speed || 1);
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = from;
    const step = (now) => {
      if (!state || ctx.signal.aborted) return resolve();
      const u = Math.min(1, (now - t0) / dur);
      const k = Math.round(from + (to - from) * u * u);        // starts slow (ripple visible), ends fast (breathing)
      const rate = Math.max(1, k - last) * 60;                 // ~cycles per second right now
      hw.update(k, Math.max(1, Math.min(256, Math.round(rate / 20))));
      hw.cycle = k;
      last = k;
      if (u >= 1) { hw.pills([]); return resolve(); }
      if (u > 0.35) hw.pills([]);
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  });
}

function loopLive() {
  const T = state?.trace;
  if (!T) return;
  const n = T.cols.duty.length;
  let pos = state.hw.cycle ?? 3900, last = performance.now();
  const step = (now) => {
    if (!state) return;
    pos += ((now - last) / 1000) * 700;          // 700 cycles/s: a calm breath
    last = now;
    if (pos > n - 1) pos = 4;                     // wrap past test4's reset back to reset release
    state.hw.update(Math.floor(pos), 64);
    state.raf = requestAnimationFrame(step);
  };
  cancelAnimationFrame(state.raf);
  state.raf = requestAnimationFrame(step);
}

/* ---------------- the circuit (SVG that builds up block by block) ---------------- */

function buildCircuit(host, trace) {
  const W = 680, H = 560;
  const s = (tag, attrs = {}, parent, text) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    parent?.appendChild(n);
    return n;
  };
  // widen the viewBox to the panel's aspect so the circuit fills it edge to edge (content stays centred)
  const asp = host.clientWidth && host.clientHeight ? host.clientWidth / host.clientHeight : W / H;
  const VW = Math.round(Math.min(Math.max(W, H * asp), W * 1.6)), dx = (VW - W) / 2;
  const svg = s('svg', { viewBox: `${-dx} 0 ${VW} ${H}`, class: 'cz', preserveAspectRatio: 'xMidYMin meet', role: 'img', 'aria-label': 'pwm_led circuit' }, host);
  const layers = { base: s('g', {}, svg), wires: s('g', {}, svg), nodes: s('g', {}, svg), over: s('g', {}, svg) };
  const groups = {};
  const G = (name, layer = 'nodes') => (groups[name + layer] ||= s('g', { class: 'hp', 'data-p': name }, layers[layer]));
  const parts = {};
  const wire = (part, d, cls = '') => {
    const p = s('path', { class: 'cw ' + cls, d }, G(part, 'wires'));
    p.style.setProperty('--len', Math.ceil(p.getTotalLength() + 2));   // for the draw-on animation
    return p;
  };
  const label = (part, x, y, t, cls = 'ct', anchor = 'start') => s('text', { class: cls, x, y, 'text-anchor': anchor }, G(part), t);
  const tri = (g, x, y) => s('polygon', { class: 'ctri', points: `${x},${y} ${x + 5},${y - 6} ${x + 10},${y}` }, g);

  // header (always visible)
  s('text', { class: 'cz-h', x: 8 - dx, y: 22 }, svg, 'pwm_led.v → hardware');
  const sub = s('text', { class: 'cz-sub', x: 172 - dx, y: 22 }, svg, 'builds as the code appears');
  const ro = s('text', { class: 'cz-ro', x: W - 8 + dx, y: 22, 'text-anchor': 'end' }, svg, '');

  // frame: the module boundary
  s('rect', { class: 'cframe', x: 56, y: 50, width: 568, height: 478, rx: 12 }, G('frame', 'base'));
  label('frame', 72, 74, 'module pwm_led', 'ct-mod');
  label('frame', 178, 74, '#(DIV = 16)', 'ct-par');

  // pins
  const pin = (y, t, side) => {
    const g = G('pins');
    s('rect', { class: 'cpin', x: side ? 618 : 50, y: y - 6, width: 12, height: 12, rx: 2 }, g);
    if (t) s('text', { class: 'ct-pin', x: side ? 640 : 42, y: y + 4, 'text-anchor': side ? 'start' : 'end' }, g, t);
  };
  pin(464, 'clk'); pin(506, 'rst');
  const RY = (i) => 92 + i * 54;
  for (let i = 0; i < 8; i++) pin(RY(i) + 20, '', 1);
  label('pins', 670, 86, 'led[7:0]', 'ct-pin', 'end');
  parts.rst = { el: G('pins'), box: [36, 494, 30, 24] };
  parts.clk = { el: G('pins'), box: [36, 452, 30, 24] };

  // registers
  const reg = (key, x, y, w, h, title, accent, vs = 18) => {
    const g = G('regs');
    const box = s('rect', { class: 'cbox', x, y, width: w, height: h, rx: 8 }, g);
    s('rect', { x: x + 1, y: y + 9, width: 3, height: h - 18, rx: 1.5, fill: accent }, g);
    s('text', { class: 'ct-t', x: x + 13, y: y + 17 }, g, title);
    const val = s('text', { class: 'ct-v', x: x + 13, y: y + 17 + vs + 4, fill: accent, 'font-size': vs }, g, '0');
    const sub2 = s('text', { class: 'ct-s', x: x + w - 10, y: y + 17 + vs + 4, 'text-anchor': 'end' }, g, '');
    const ck = G('clock');
    tri(ck, x + 8, y + h);
    s('text', { class: 'ct-r', x: x + w - 9, y: y + 15, 'text-anchor': 'end' }, ck, 'R');
    parts[key] = { el: g, box: [x, y, w, h], val, sub: sub2, rect: box };
    return parts[key];
  };
  reg('pre', 90, 100, 150, 58, 'pre [15:0]', PAL.pre);
  reg('duty', 90, 206, 150, 58, 'duty [7:0]', PAL.duty);
  const dutyBar = s('rect', { x: 103, y: 254, width: 0, height: 3, rx: 1.5, fill: PAL.duty, opacity: 0.4 }, G('regs'));
  reg('dir', 90, 292, 150, 46, 'dir', PAL.dir, 15);
  reg('pwm_cnt', 90, 370, 150, 58, 'pwm_cnt [7:0]', PAL.cnt);
  const cntBar = s('rect', { x: 103, y: 418, width: 0, height: 3, rx: 1.5, fill: PAL.cnt, opacity: 0.4 }, G('regs'));
  parts.dir.val.textContent = 'up';

  // clock + reset rails into every register
  wire('clock', 'M62 464 H72 V129 H90 M72 235 H90 M72 315 H90 M72 399 H90', 'cw-clk');
  wire('clock', 'M62 506 H81 V112 H90 M81 218 H90 M81 302 H90 M81 382 H90', 'cw-rst');
  label('clock', 100, 512, 'clk → every flop · synchronous reset', 'ct-n');

  // counters: +1 feedback loops
  wire('count', 'M200 100 V88 H130 V100', 'cw-pre');
  wire('count', 'M200 370 V358 H130 V370', 'cw-cnt');
  s('rect', { class: 'cplus', x: 151, y: 81, width: 28, height: 14, rx: 7 }, G('count'));
  label('count', 165, 92, '+1', 'ct-plus', 'middle');
  s('rect', { class: 'cplus', x: 151, y: 351, width: 28, height: 14, rx: 7 }, G('count'));
  label('count', 165, 362, '+1', 'ct-plus', 'middle');

  // &pre tick gate, duty/dir feedback
  const gate = s('path', { class: 'cgate', d: 'M262 109 h16 a20 20 0 0 1 0 40 h-16 z' }, G('tick'));
  label('tick', 278, 133, '&', 'ct-gate', 'middle');
  wire('tick', 'M240 129 H262', 'cw-pre');
  const tickW = wire('tick', 'M298 129 H312 V190 H165 V206', 'cw-tick');
  label('tick', 318, 168, 'tick', 'ct-n');
  wire('tick', 'M130 264 V292', 'cw-fb');
  wire('tick', 'M200 264 V292', 'cw-fb');
  label('tick', 125, 282, '±1', 'ct-n', 'end');
  label('tick', 206, 282, '==FF / ==00', 'ct-n');
  parts.tick = { el: G('tick'), box: [258, 105, 46, 48] };

  // comparators, output flops, LEDs
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const part = i < 4 ? 'cmpA' : 'cmpB';
    const y = RY(i);
    wire(part, `M340 ${y + 13} H390`, 'cw-cnt');
    wire(part, `M360 ${y + 27} H390`, 'cw-duty');
    s('circle', { cx: 340, cy: y + 13, r: 2.4, fill: PAL.cnt }, G(part, 'wires'));
    s('circle', { cx: 360, cy: y + 27, r: 2.4, fill: PAL.duty }, G(part, 'wires'));
    const g = G(part);
    const cg = s('g', { class: 'ccmp' }, g);
    s('rect', { class: 'cbox ccmpbox', x: 390, y, width: 168, height: 40, rx: 8 }, cg);
    s('text', { class: 'ct-t', x: 401, y: y + 15 }, cg, i ? `cnt + ${32 * i}` : 'cnt');
    const ct = s('text', { class: 'ct-c', x: 401, y: y + 32 }, cg);
    const cs = s('tspan', {}, ct, '·'); s('tspan', { class: 'ct-lt' }, ct, ' < '); const cd = s('tspan', { fill: PAL.duty }, ct, 'duty');
    s('circle', { class: 'cdot', cx: 544, cy: y + 20, r: 4.5 }, cg);
    wire(part, `M558 ${y + 20} H572`, 'cw-d');
    const fg = s('g', { class: 'cff' }, g);
    s('rect', { class: 'cbox', x: 572, y: y + 6, width: 34, height: 28, rx: 6 }, fg);
    const q = s('text', { class: 'ct-q', x: 589, y: y + 25, 'text-anchor': 'middle' }, fg, 'Q');
    tri(fg, 575, y + 34);
    wire(part, `M606 ${y + 20} H618`, 'cw-d');
    // LED (its own part, lit at the end)
    const lg = G('leds');
    wire('leds', `M630 ${y + 20} H642`, 'cw-d');
    const halo = s('circle', { cx: 652, cy: y + 20, r: 17, fill: PAL.on, opacity: 0 }, lg);
    const body = s('circle', { class: 'cled', cx: 652, cy: y + 20, r: 9.5, fill: OFF }, lg);
    s('circle', { cx: 649, cy: y + 17, r: 2.6, fill: '#fff', opacity: 0.75 }, lg);
    rows.push({ cg, cs, cd, fg, q, halo, body, last: {} });
    parts['led' + i] = { el: lg, box: [638, y + 6, 28, 28] };
  }
  // buses (part of the first comparator block)
  wire('cmpA', `M240 399 H340 V${RY(0) + 13} M340 399 V${RY(7) + 13}`, 'cw-cnt cw-bus');
  wire('cmpA', `M240 235 H360 V${RY(0) + 27} M360 235 V${RY(7) + 27}`, 'cw-duty cw-bus');
  label('cmpA', 390, 86, '(pwm_cnt + 32·i) < duty', 'ct-n');
  parts.cmps = { el: G('cmpA'), box: [386, RY(0) - 4, 224, RY(7) + 48 - RY(0)] };
  parts.leds = { el: G('leds'), box: [634, RY(0) + 2, 36, RY(7) + 36 - RY(0)] };

  // testbench wrapper
  s('rect', { class: 'ctb', x: 4 - dx, y: 36, width: VW - 8, height: H - 40, rx: 14 }, G('tb', 'over'));
  s('text', { class: 'ct-tb', x: 16 - dx, y: H - 12 }, G('tb', 'over'), 'tb_pwm_led · DIV = 4 · drives clk, rst · checks duty, led, dir');
  const pillLayer = s('g', {}, layers.over);
  const ringLayer = s('g', {}, layers.over);
  const focusRect = s('rect', { fill: 'none', stroke: 'none', 'pointer-events': 'none' }, layers.over);

  const bbox = (id) => {
    const p = parts[id];
    if (!p) return null;
    const [x, y, w, h] = p.box;
    return { x, y, w, h };
  };

  // live state
  let ps = null, setup = false;
  const mix = (a, b, t) => {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    return '#' + [16, 8, 0].map((sh) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t).toString(16).padStart(2, '0')).join('');
  };

  return {
    el(id) {
      if (id === 'tick') return gate;
      const b = id === 'cmps+leds' ? { x: 386, y: RY(0) - 4, w: 284, h: RY(7) + 48 - RY(0) } : bbox(id);
      if (!b) return null;
      focusRect.setAttribute('x', b.x); focusRect.setAttribute('y', b.y);
      focusRect.setAttribute('width', b.w); focusRect.setAttribute('height', b.h);
      return focusRect;
    },
    reveal(part) {
      svg.querySelectorAll(`.hp[data-p="${part}"]`).forEach((g) => g.classList.add('in'));
    },
    toPx(x, y) {
      const r = svg.getBoundingClientRect(), hr = host.getBoundingClientRect();
      const k = Math.min(r.width / VW, r.height / H);
      const ox = r.left - hr.left + (r.width - VW * k) / 2, oy = r.top - hr.top;
      return [ox + (x + dx) * k, oy + y * k];
    },
    ring(ids) {
      ringLayer.replaceChildren();
      for (const id of ids) {
        const b = bbox(id);
        if (b) s('rect', { class: 'cring', x: b.x - 5, y: b.y - 5, width: b.w + 10, height: b.h + 10, rx: 11 }, ringLayer);
      }
    },
    pill(id, text) {
      const b = bbox(id);
      if (!b) return;
      const tw = text.length * 6.1 + 14;
      const g = s('g', { class: 'cpill' }, pillLayer);
      const px = Math.min(W + dx - tw - 4, Math.max(4, b.x + b.w / 2 - tw / 2));
      const py = id === 'rst' ? b.y + b.h + 4 : b.y - 19;
      s('rect', { x: px, y: py, width: tw, height: 15, rx: 7.5 }, g);
      s('text', { x: px + tw / 2, y: py + 10.8, 'text-anchor': 'middle' }, g, text);
    },
    pills(list) { if (!list.length) pillLayer.querySelectorAll('.cpill').forEach((p) => p.classList.add('out')); },
    goLive(T) {
      if (setup) return;
      setup = true;
      svg.classList.add('live');
      sub.textContent = 'live · real Icarus trace (tb, DIV = 4)';
      parts.pre.el.querySelector('.ct-t').textContent = 'pre [3:0]';
      const c = T.cols, n = c.duty.length;
      ps = Array.from({ length: 8 }, () => new Uint32Array(n + 1));
      for (let k = 0; k < n; k++) for (let i = 0; i < 8; i++) ps[i][k + 1] = ps[i][k] + ((c.led[k] >> i) & 1);
      this.T = T;
    },
    update(k, win) {
      const c = this.T.cols;
      const duty = c.duty[k], cnt = c.pwm_cnt[k];
      ro.textContent = `cycle ${k.toLocaleString('en-US')} · ${(c.t_ns[k] / 1000).toFixed(2)} µs`;
      parts.pre.val.textContent = String(c.pre[k]);
      parts.pre.sub.textContent = c.pre[k] === 15 ? 'tick' : '';
      gate.classList.toggle('on', c.pre[k] === 15);
      tickW.classList.toggle('on', c.pre[k] === 15);
      parts.duty.val.textContent = String(duty);
      parts.duty.sub.textContent = '0x' + duty.toString(16).toUpperCase().padStart(2, '0');
      dutyBar.setAttribute('width', ((duty / 255) * 124).toFixed(1));
      parts.dir.val.textContent = c.dir[k] ? 'up' : 'down';
      parts.pwm_cnt.val.textContent = String(cnt);
      parts.pwm_cnt.sub.textContent = '0x' + cnt.toString(16).toUpperCase().padStart(2, '0');
      cntBar.setAttribute('width', ((cnt / 255) * 124).toFixed(1));
      for (let i = 0; i < 8; i++) {
        const r = rows[i], sum = (cnt + 32 * i) & 255, on = sum < duty, q = (c.led[k] >> i) & 1;
        r.cs.textContent = String(sum);
        r.cd.textContent = String(duty);
        if (r.last.on !== on) { r.cg.classList.toggle('on', on); r.last.on = on; }
        if (r.last.q !== q) { r.fg.classList.toggle('on', !!q); r.q.textContent = String(q); r.last.q = q; }
        const a = Math.max(0, k + 1 - win);
        const b = (ps[i][k + 1] - ps[i][a]) / (k + 1 - a);
        r.halo.setAttribute('opacity', (b * 0.25).toFixed(3));
        r.body.setAttribute('fill', mix(OFF, PAL.on, Math.min(1, b * 1.6)));
        r.body.setAttribute('stroke', b > 0.02 ? PAL.onDark : '#d4d4d8');
      }
    },
  };
}
