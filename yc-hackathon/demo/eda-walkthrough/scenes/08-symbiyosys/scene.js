// 08-symbiyosys: real formal runs of pwm_led with SymbiYosys (smtbmc + yices), shown on the hardware.
//  1. bmc   : the solver unrolls the circuit 0..39 cycles (step counts from the real sby.log); every
//             register is symbolic; each property is checked on the registers it constrains, per depth.
//  2. prove : k-induction (real log: basecase 8 steps, induction 8 -> 7 -> 6, successful) from ANY state.
//  3. cover : a real cover run (real/sby/pwm_led_cover.sby, DIV reduced to 2) -> the solver's own witness
//             trace (engine_0/trace2.vcd) plays on the circuit until the first LED switches on.
// Data: data/08-symbiyosys.json (real/sby/tools/extract.py + extract_cover.py), real/sby/sby.log, cover.log.
import { mountHwSim } from '../../components/hwsim/hwsim.js';

const TOOL = '#db2777';
const PAL = { pre: '#7c3aed', cnt: '#0891b2', duty: '#2563eb', dir: '#f59e0b', rst: '#ef4444', on: '#10b981' };
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs, parent, text) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  parent?.appendChild(n);
  return n;
};
let timers = [];

// which registers each assertion constrains (hwsim highlight ids, full mode)
const PROP_HL = {
  duty_no_wrap_up: { duty: 'duty_no_wrap_up' },
  duty_no_wrap_down: { duty: 'duty_no_wrap_down' },
  dir_flip_at_ends: { dir: 'dir_flip_at_ends', duty: 'reads duty' },
  duty_step: { duty: 'duty_step  ±1' },
  leds_off_after_rst: { rst: 'after rst', leds: 'leds_off_after_rst' },
};
const UNION_HL = { duty: 'wrap ×2 · step', dir: 'flip_at_ends', rst: 'after rst', leds: 'leds_off' };
const SHORT = { duty_no_wrap_up: 'no wrap 255→0', duty_no_wrap_down: 'no wrap 0→255', dir_flip_at_ends: 'flip only at ends', duty_step: 'step ≤ 1 per clk', leds_off_after_rst: 'dark after reset' };

function hlSby(src) {
  return src.trim().split('\n').map(l => {
    if (/^\[.*\]$/.test(l)) return `<span class="sb-sec">${esc(l)}</span>`;
    if (/^#/.test(l)) return `<span class="sb-com">${esc(l)}</span>`;
    const m = l.match(/^(\w+:)?\s*(\w+)(\s+)(.*)$/);
    if (m) return `${m[1] ? `<span class="sb-task">${m[1]}</span> ` : ''}<span class="sb-key">${esc(m[2])}</span>${m[3]}<span class="sb-val">${esc(m[4])}</span>`;
    return esc(l);
  }).join('\n');
}
function hlVerilog(src) {
  return src.trimEnd().split('\n').map((l, i) => {
    const h = esc(l)
      .replace(/(\/\/.*)$/, '<span class="sb-com">$1</span>')
      .replace(/\b(always|if|begin|end|reg|assume|assert|cover|posedge)\b(?![^<]*<\/span>)/g, '<span class="sb-kw">$1</span>')
      .replace(/(`\w+)/g, '<span class="sb-dir">$1</span>')
      .replace(/(\$past)/g, '<span class="sb-fn">$1</span>');
    const name = (l.match(/(\w+):\s*(?:assert|cover)/) || [])[1];
    return `<div class="sb-ln${name ? ' prop' : ''}"${name ? ` data-prop="${name}"` : ''}><span class="n">${i + 1}</span><span class="c">${h || ' '}</span></div>`;
  }).join('');
}

export default {
  id: '08-symbiyosys',
  tool: 'SymbiYosys',
  title: 'Formal verification: the solver explores every hardware state',
  css: true,

  async mount(root, ctx) {
    if (!document.querySelector('link[href="components/hwsim/hwsim.css"]')) {
      document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'components/hwsim/hwsim.css' }));
    }
    const [d, log, clog] = await Promise.all([ctx.data('08-symbiyosys'), ctx.text('real/sby/sby.log'), ctx.text('real/sby/cover.log')]);
    this.d = d;
    this.log = log.split(/\r?\n/).filter(l => l.startsWith('SBY'));
    this.clog = clog.split(/\r?\n/).filter(l => l.startsWith('SBY'));
    const props = d.properties, cv = d.cover;
    const B = d.bmc.depth, K = d.prove.basecase_steps, IND = d.prove.induction_steps;
    this.dims = { B, K, IND };

    const cell = (g, i) => `<i data-g="${g}" data-i="${i}"></i>`;
    const mxRow = (p) => `
      <div class="mx-row" data-prop="${p.name}">
        <div class="mx-name"><span class="mono">${p.name}</span><span class="mx-ds">${SHORT[p.name] || ''}</span></div>
        <div class="mx-cells bmc">${Array.from({ length: B }, (_, i) => cell('b', i)).join('')}</div>
        <div class="mx-cells base">${Array.from({ length: K }, (_, i) => cell('k', i)).join('')}</div>
        <div class="mx-cells ind">${IND.map((s, i) => cell('n', i)).join('')}<i class="all" data-g="all"></i></div>
        <div class="mx-st">pending</div>
      </div>`;

    root.innerHTML = `
    <div class="sy">
      <aside class="sy-side">
        <div class="window panel sy-files">
          <div class="titlebar"><div class="sb-tabs">
            <span class="sb-tab on" data-t="sby">pwm_led.sby</span><span class="sb-tab" data-t="vh">props.vh</span><span class="sb-tab" data-t="cov">cover.sby</span>
          </div></div>
          <div class="sb-code">
            <pre class="sb-pane sby on mono">${hlSby(d.sby)}</pre>
            <div class="sb-pane vh mono">${hlVerilog(d.props_file)}</div>
            <div class="sb-pane cov mono"><pre class="sb-pre">${hlSby(cv.sby)}</pre><div class="sb-sub">pwm_led_cover.vh</div>${hlVerilog(cv.props_file)}</div>
          </div>
        </div>
        <div class="window panel sy-log">
          <div class="titlebar"><div class="title"><b>sby</b> · SymbiYosys</div><span class="badge sb-state">idle</span></div>
          <div class="term sb-term"></div>
        </div>
        <div class="callout sy-callout"><h4>What this means</h4><div class="sb-cbody">Simulation checks the cases we thought of. A formal solver checks <b>every</b> input sequence the hardware could ever see.</div></div>
      </aside>

      <main class="panel sy-hero">
        <header class="sy-strip">
          <div class="sy-tasks">
            <div class="sy-chip" data-task="bmc"><b>bmc</b><span>depth ${B}</span><em>queued</em></div>
            <div class="sy-chip" data-task="prove"><b>prove</b><span>k-induction</span><em>queued</em></div>
            <div class="sy-chip" data-task="cover"><b>cover</b><span>${cv.covers.length} goals</span><em>queued</em></div>
          </div>
          <div class="sy-what"><span class="sy-what-k">on the circuit</span><span class="sy-what-v">the design, before the solver starts</span></div>
          <div class="sy-ctr"><span class="k">depth</span><span class="v">0</span><span class="of">/ ${B}</span></div>
        </header>
        <div class="sy-hw">
          <div class="sy-hwA sym"></div>
          <div class="sy-hwB"></div>
        </div>
        <footer class="sy-foot">
          <div class="sy-mx">
            <div class="mx-row mx-head">
              <div class="mx-name"><span class="mx-h">assertion</span></div>
              <div class="mx-g">bmc · cycles 0–${B - 1} from reset</div>
              <div class="mx-g">base case · ${K} cycles</div>
              <div class="mx-g">induction · k ≤ ${IND[IND.length - 1]}</div>
              <div class="mx-st mx-h">result</div>
            </div>
            ${props.map(mxRow).join('')}
          </div>
          <div class="sy-cov">
            <div class="sy-cov-h">cover goals <span class="mono">solver must reach</span></div>
            ${cv.covers.map(c => `<div class="cv-row" data-cov="${c.name}"><span class="dot"></span><span class="mono nm">${c.name}</span><span class="mono stp">step ${c.step}</span><span class="st">…</span></div>`).join('')}
          </div>
        </footer>
      </main>
    </div>`;
    this.root = root;
    this.term = root.querySelector('.sb-term');
    const $ = (s) => root.querySelector(s);

    // A: the bmc/prove model (DIV=16, as in pwm_led.sby) drawn symbolically; B: the cover witness (DIV=2)
    const symTrace = {
      params: { DIV: 16 }, clk_period_ns: 40, n: B + 1, markers: [], windows: {},
      cols: { t_ns: Array.from({ length: B + 1 }, (_, k) => 20 + 40 * k), rst: Array(B + 1).fill(0), pre: Array(B + 1).fill(0), pwm_cnt: Array(B + 1).fill(0), duty: Array(B + 1).fill(0), dir: Array(B + 1).fill(1), led: Array(B + 1).fill(0), on0: Array(B + 1).fill(null) },
    };
    const wit = cv.covers[cv.covers.length - 1];  // the deepest goal: first_led_on (trace2.vcd)
    this.wit = wit;
    this.hwA = mountHwSim($('.sy-hwA'), { trace: symTrace, color: TOOL, mode: 'full', timeline: false });
    this.hwB = mountHwSim($('.sy-hwB'), { trace: cv.traces[wit.trace], color: TOOL, mode: 'full' });
    await Promise.all([this.hwA.ready, this.hwB.ready]);
    if (!this.root) return;
    const subB = root.querySelector('.sy-hwB .hw-head-sub');
    if (subB) subB.textContent = `· solver witness ${wit.trace}.vcd · smtbmc + yices`;
    this.offA = this.hwA.on('cycle', () => this.applyOverlay());
    this.sym('step 0');
  },

  // ---------- symbolic overlay: "?" twins injected next to hwsim A's own value texts (same coordinate
  // system, so it follows hwsim's adaptive layout); re-applied whenever hwsim rebuilds its SVG.
  applyOverlay() {
    const svg = this.root?.querySelector('.sy-hwA svg');
    if (!svg || svg.querySelector('.sy-ovt')) return;
    const twin = (src, txt, cls = '') => {
      const n = src.cloneNode(false);
      n.setAttribute('class', `${src.getAttribute('class')} sy-ovt ${cls}`);
      if (txt != null) n.textContent = txt;
      src.after(n);
      return n;
    };
    svg.querySelectorAll('.hw-val').forEach(v => twin(v, '?'));
    svg.querySelectorAll('.hw-sub').forEach(v => twin(v, '', 'sy-ovs'));
    svg.querySelectorAll('.hw-cmp-t').forEach(v => {
      const n = twin(v, null); n.replaceChildren();
      [['?', PAL.cnt], [' < ', '#a1a1aa'], ['?', PAL.duty]].forEach(([t, f]) => svgEl('tspan', { fill: f }, n, t));
    });
    svg.querySelectorAll('.hw-q').forEach(v => twin(v, '?'));
    svg.querySelectorAll('.hw-pct').forEach(v => twin(v, 'sym'));
    svg.querySelectorAll('.hw-pin-v').forEach(v => twin(v, '?', 'sy-ovr'));
    const ro = svg.querySelector('.hw-readout');
    if (ro) { const n = twin(ro, '', 'sy-ovh'); n.setAttribute('fill', TOOL); }
    this.symState && this.paintSym();
  },
  paintSym() {
    const svg = this.root?.querySelector('.sy-hwA svg');
    if (!svg) return;
    svg.querySelectorAll('.sy-ovs').forEach(n => { n.textContent = this.symState.sub; });
    const h = svg.querySelector('.sy-ovh'); if (h) h.textContent = this.symState.head;
  },
  sym(sub, head = '') {
    this.root.querySelector('.sy-hwA').classList.add('sym');
    this.symState = { sub, head };
    this.applyOverlay();
    this.paintSym();
  },

  // ---------- small UI helpers
  tab(t) {
    this.root.querySelectorAll('.sb-tab').forEach(e => e.classList.toggle('on', e.dataset.t === t));
    this.root.querySelectorAll('.sb-pane').forEach(e => e.classList.toggle('on', e.classList.contains(t)));
  },
  state(t, cls = '') { const b = this.root.querySelector('.sb-state'); b.textContent = t; b.className = 'badge sb-state ' + cls; },
  chip(task, t, cls = '') { const c = this.root.querySelector(`.sy-chip[data-task="${task}"]`); c.className = 'sy-chip ' + cls; c.querySelector('em').textContent = t; },
  what(k, v) { const w = this.root.querySelector('.sy-what'); w.querySelector('.sy-what-k').textContent = k; w.querySelector('.sy-what-v').innerHTML = v; w.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' }); },
  ctr(k, v, of) { const c = this.root.querySelector('.sy-ctr'); c.querySelector('.k').textContent = k; c.querySelector('.v').textContent = v; c.querySelector('.of').textContent = of; },
  callout(html) { const b = this.root.querySelector('.sb-cbody'); b.style.opacity = 0; timers.push(setTimeout(() => { b.innerHTML = html; b.style.opacity = 1; }, 200)); },
  line(html, cls = '') {
    const div = document.createElement('div'); div.className = 'sb-line ' + cls; div.innerHTML = html;
    this.term.appendChild(div);
    while (this.term.children.length > 80) this.term.firstChild.remove();
    this.term.scrollTop = this.term.scrollHeight;
  },
  fmt(l) {
    let t = l.replace(/^SBY\s+\d+:\d+:\d+\s+/, '').replace(/'?C:\\[^' ]*\\([^\\' ]+)'?/g, '$1');
    t = t.replace(/starting process "cd ([^&]+)& (yosys-smtbmc|yosys) ([^"]{0,30})[^"]*"/, 'starting $2 $3…');
    t = t.replace(/##\s+0:00:0\d\s+/, '');
    const m = t.match(/^\[(pwm_led_\w+)\] (.*)$/);
    if (!m) return esc(t);
    const task = m[1].replace('pwm_led_', '');
    let body = esc(m[2]);
    if (/DONE \(PASS|passed|pass$|successful|Reached cover/.test(m[2])) body = `<span class="ok">${body}</span>`;
    return `<span class="sb-tag ${task}">${task}</span> ${body}`;
  },
  cells(g, i) { return [...this.root.querySelectorAll(`.mx-cells i[data-g="${g}"][data-i="${i}"]`)]; },
  cellOf(prop, g, i) { return this.root.querySelector(`.mx-row[data-prop="${prop}"] i[data-g="${g}"][data-i="${i}"]`); },
  colCursor(g, i) {
    this.root.querySelectorAll('.mx-cells i.cur').forEach(e => e.classList.remove('cur'));
    if (g != null) this.cells(g, i).forEach(e => e.classList.add('cur'));
  },

  async play(ctx) {
    const d = this.d, { B, K, IND } = this.dims, props = d.properties.map(p => p.name);
    const root = this.root, hwA = this.hwA, hwB = this.hwB;
    this.term.replaceChildren();
    root.querySelector('.sy-hwB').classList.remove('on'); root.querySelector('.sy-hwA').classList.remove('off');
    root.querySelectorAll('.mx-cells i').forEach(e => { e.className = e.classList.contains('all') ? 'all' : ''; });
    root.querySelectorAll('.mx-row.proved').forEach(r => { r.classList.remove('proved'); r.querySelector('.mx-st').textContent = 'pending'; });
    root.querySelectorAll('.cv-row.ok').forEach(r => { r.classList.remove('ok'); r.querySelector('.st').textContent = '…'; });
    root.querySelectorAll('.sb-ln.hl, .sb-ln.ok').forEach(l => l.classList.remove('hl', 'ok'));
    ['bmc', 'prove', 'cover'].forEach(t => this.chip(t, 'queued'));
    hwA.highlight({}); hwB.seek(0); hwB.highlight({});
    this.sym('step 0');

    // ---- 1. hook + spec (visual from the start: the circuit is already on stage)
    ctx.visual?.();
    this.tab('sby'); this.state('editing');
    this.what('on the circuit', 'every register becomes a <b>symbolic variable</b>, not a number');
    ctx.narrate('Tests checked 4 cases. Can we prove it for ALL of them?');
    await ctx.sleep(2200);
    this.tab('vh');
    ctx.narrate('5 rules: duty never wraps, dir flips only at the ends…');
    for (const l of root.querySelectorAll('.sb-pane.vh .sb-ln.prop')) { l.classList.add('hl'); await ctx.sleep(380); }
    this.callout('Each <b>assert</b> is a rule about the registers: <b>duty</b> never jumps 255 ↔ 0, <b>dir</b> flips only at an end, duty moves at most ±1 per clock, the LEDs are dark after <b>rst</b>.');
    this.line('<span class="prompt">real/sby $</span> <span class="cmd"></span><span class="caret"></span>');
    const c = this.term.lastChild;
    await ctx.typeInto(c.querySelector('.cmd'), d.command[d.command.length - 1], 40);
    c.querySelector('.caret').remove();
    this.state('running', 'info');

    // ---- 2. bmc: unroll 0..39, check every property on the registers it constrains
    ctx.visual?.();
    this.chip('bmc', 'running', 'run');
    this.what('bmc · from reset', 'the solver unrolls the circuit cycle by cycle; <b>rst is a free input</b> at every step');
    ctx.narrate('The solver tries every input, cycle by cycle, from reset');
    const bmcLines = this.log.filter(l => /\[pwm_led_bmc\]/.test(l));
    let shown = 0;
    for (const l of bmcLines) {
      const st = l.match(/engine_0: ##.*Checking assertions in step (\d+)/);
      if (!st) {
        if (/Checking assumptions|Removing directory|Copy '|Elapsed process|did not produce/.test(l)) continue;
        this.line(this.fmt(l), /DONE/.test(l) ? 'done' : '');
        if (/DONE \(PASS/.test(l)) { this.chip('bmc', 'PASS', 'pass'); }
        else if (shown++ < 6) await ctx.sleep(60);
        continue;
      }
      const k = +st[1];
      this.ctr('depth', String(k + 1), `/ ${B} cycles`);
      this.sym(`step ${k}`, `unrolled ×${k + 1}`);
      this.colCursor('b', k);
      if (k % 5 === 4 || k === B - 1) this.line(this.fmt(l), 'stp');
      if (k < 4) {
        // slow at first: each assertion lights up the registers it constrains
        for (const p of props) {
          hwA.highlight(PROP_HL[p]);
          this.cellOf(p, 'b', k)?.classList.add('chk');
          root.querySelector(`.mx-row[data-prop="${p}"]`).classList.add('act');
          await ctx.sleep(170);
          root.querySelector(`.mx-row[data-prop="${p}"]`).classList.remove('act');
          this.cellOf(p, 'b', k)?.classList.replace('chk', 'ok');
        }
      } else {
        if (k === 4) { hwA.highlight(UNION_HL); ctx.focus?.(root.querySelector('.sy-foot'), { scale: 1.45, ms: 900, pad: 24 }); }
        this.cells('b', k).forEach(e => e.classList.add('ok'));
        await ctx.sleep(k < 10 ? 160 : 105);
      }
    }
    this.colCursor(null);
    hwA.highlight({});
    ctx.unfocus?.({ ms: 800 });
    this.callout(`<b>bmc PASS</b>: no input sequence breaks any assertion in the first ${B} cycles after reset. That bounds the search; it doesn't cover cycle ${B + 1} and beyond.`);
    ctx.narrate(`${B} cycles, zero counterexamples. But ${B} isn't forever.`);
    await ctx.sleep(1800);

    // ---- 3. prove: k-induction from ANY state
    this.chip('prove', 'from reset', 'run');
    this.what('prove · k-induction', 'registers start from an <b>arbitrary state</b>, not from reset');
    const pLines = this.log.filter(l => /\[pwm_led_prove\]/.test(l));
    let indI = 0;
    for (const l of pLines) {
      const st = l.match(/basecase: ##.*Checking assertions in step (\d+)/);
      if (st) {
        const k = +st[1];
        this.ctr('base case', String(k + 1), `/ ${K} cycles`);
        this.sym(`step ${k}`, `base case ×${k + 1}`);
        this.colCursor('k', k);
        this.cells('k', k).forEach(e => e.classList.add('ok'));
        this.line(this.fmt(l), 'stp');
        await ctx.sleep(210);
        continue;
      }
      if (/Checking assumptions|Removing directory|Copy '|Elapsed process|did not produce/.test(l)) continue;
      const it = l.match(/Trying induction in step (\d+)/);
      if (it) {
        if (indI === 0) {
          this.chip('prove', 'induction', 'run');
          this.what('prove · induction step', 'from <b>any</b> state where the rules held, can the next cycle break one?');
          ctx.narrate('Now start from ANY state: can one good cycle lead to a bad one?');
          hwA.highlight(UNION_HL);
        }
        this.sym('any', 'induction · any state');
        this.ctr('induction', '…', 'solving');
        this.colCursor('n', indI);
        this.cells('n', indI).forEach(e => e.classList.add('chk'));
        this.line(this.fmt(l));
        await ctx.sleep(650);
        this.cells('n', indI).forEach(e => e.classList.replace('chk', 'ok'));
        indI++;
        continue;
      }
      this.line(this.fmt(l), /DONE/.test(l) ? 'done' : '');
      if (/Temporal induction successful/.test(l)) {
        this.colCursor(null);
        root.querySelectorAll('.mx-cells i.all').forEach(e => e.classList.add('ok'));
        this.ctr('induction', `k ≤ ${IND[IND.length - 1]}`, 'is enough');
        this.sym('any', 'no state breaks a rule');
        ctx.focus?.(root.querySelector('.sy-hwA'), { scale: 1.3, ms: 900, pad: 20 });
        await ctx.sleep(1200);
      }
      if (/DONE \(PASS/.test(l)) this.chip('prove', 'PROVED', 'pass');
      await ctx.sleep(/successful|DONE/.test(l) ? 260 : 40);
    }
    hwA.highlight({});
    const rows = [...root.querySelectorAll('.sy-mx .mx-row[data-prop]')];
    for (const r of rows) {
      r.classList.add('proved'); r.querySelector('.mx-st').textContent = 'proved';
      root.querySelector(`.sb-pane.vh .sb-ln[data-prop="${r.dataset.prop}"]`)?.classList.add('ok');
      await ctx.sleep(120);
    }
    this.state('PASS', 'pass');
    ctx.emit('metric', { key: 'props_proved', label: 'Properties proved', value: rows.length, unit: `of ${rows.length}` });
    ctx.emit('metric', { key: 'bmc_depth', label: 'BMC depth', value: B, unit: 'cycles' });
    this.callout(`<b>Proved</b> by k-induction: the five rules hold in <b>every</b> reachable state, forever. Sanity check: a broken copy (duty + 2) fails <b>duty_step</b>.`);
    this.ctr('proved', `${rows.length}/${rows.length}`, 'all inputs');
    this.what('result', `<span class="sy-big">${rows.length}/${rows.length} PROVED</span> for every input, at any depth`);
    ctx.narrate('No. All 5 rules proved for every input, at any depth.');
    ctx.focus?.(root.querySelector('.sy-mx'), { scale: 1.4, ms: 900, pad: 24 });
    await ctx.sleep(2400);
    ctx.unfocus?.({ ms: 800 });

    // ---- 4. cover: the solver's own witness trace, played on the real circuit
    const cv = d.cover, wit = this.wit;
    this.tab('cov');
    this.chip('cover', 'searching', 'run');
    this.line('<span class="prompt">real/sby $</span> <span class="cmd">' + esc(cv.command[cv.command.length - 1]) + '</span>');
    for (const l of this.clog) {
      if (/Reached cover statement/.test(l)) {
        this.line(this.fmt(l));
        const name = l.match(/at pwm_led: (\w+)/)?.[1];
        const r = root.querySelector(`.cv-row[data-cov="${name}"]`);
        if (r) { r.classList.add('ok'); r.querySelector('.st').textContent = 'reached'; }
        await ctx.sleep(180);
      } else if (/DONE \(/.test(l)) this.line(this.fmt(l), 'done');
    }
    this.chip('cover', `${cv.covers.length}/${cv.covers.length} reached`, 'pass');
    root.querySelector('.sy-hwB').classList.add('on'); root.querySelector('.sy-hwA').classList.add('off');
    this.what('cover · solver witness', `a real path the solver found to <b>${wit.name}</b> (${wit.trace}.vcd), prescaler cut to ${cv.div} bits to fit ${cv.depth} cycles`);
    ctx.narrate("And it's not vacuous: the solver found a path that lights an LED");
    this.callout(`Proofs are only useful if the hardware still does something. <b>cover</b> asks the solver for a concrete path: here it holds <b>rst</b>, releases it, and lets <b>duty</b> climb until <b>led[7]</b> switches on at step ${wit.step}.`);
    const T = cv.traces[wit.trace], n = T.n;
    const dutyHit = T.cols.duty.findIndex(v => v === 4);
    let hlKey = '';
    const hl = (key, spec) => { if (key !== hlKey) { hlKey = key; hwB.highlight(spec); } };
    const offs = [hwB.on('cycle', s => {
      this.ctr('witness', String(s.cycle), `/ ${n - 1} steps`);
      if (s.rst) hl('rst', { rst: 'solver: rst = 1' });
      else if (s.cycle < dutyHit) hl('d', { duty: 'goal: duty == 4', pre: 'counts' });
      else if (!(s.led & 128)) hl('l', { duty: 'duty_reaches_4 ✓', led7: 'goal: led[7]', cmp7: 'cnt+224 < duty ?' });
      else { if (hlKey !== 'ok') ctx.focus?.(root.querySelector('.sy-hwB'), { scale: 1.3, ms: 800, pad: 20 }); hl('ok', { led7: 'first_led_on ✓', ff7: 'led[7] = 1', cmp7: 'true' }); }
    })];
    this.offs = offs;
    hwB.seek(0);
    await ctx.sleep(500);
    await hwB.play(0, n - 1, 6 * ctx.speed, { signal: ctx.signal });
    if (ctx.signal.aborted) return;

    // ---- 5. finale
    offs.forEach(f => f());
    this.offs = [];
    this.what('result', `<b>${props.length}/${props.length}</b> assertions proved · <b>${B}</b>-cycle bmc · <b>${cv.covers.length}/${cv.covers.length}</b> cover goals reached`);
    ctx.unfocus?.({ ms: 800 });
    ctx.narrate('Proven logic. Now it needs a real board to live on.');
    await ctx.sleep(2200);
  },

  unmount() {
    timers.forEach(clearTimeout); timers = [];
    this.offs?.forEach(f => f()); this.offs = [];
    this.offA?.();
    this.hwA?.destroy(); this.hwB?.destroy();
    this.hwA = this.hwB = null; this.root = null;
  },
};
