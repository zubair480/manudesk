// Scene 03-verilator (Session A / A3). The circuit is the star: Verilator's -Wall lint is shown as what it
// inspects in the hardware (bit widths, clocked vs combinational logic, drivers), then the same RTL is
// compiled into a real cycle-accurate C++ model (real/verilator/*.log) that runs 50 M cycles.
import { mountHwSim } from '../../components/hwsim/hwsim.js';

const TOOL = '#7c3aed';
const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v) => Math.round(v).toLocaleString('en-US');
let S = null;

export default {
  id: '03-verilator',
  tool: 'Verilator',
  title: 'Linting with Verilator',
  css: true,

  async mount(root, ctx) {
    if (!document.querySelector('link[data-hwsim-css]') && !document.querySelector('link[href="components/hwsim/hwsim.css"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = 'components/hwsim/hwsim.css'; l.dataset.hwsimCss = '';
      document.head.appendChild(l);
    }
    const d = await ctx.data('03-verilator');
    const m = d.model;
    const [lint, cc, run] = await Promise.all([ctx.text(d.log), ctx.text(m.steps[1].log), ctx.text(m.steps[3].log)]);
    const lines = (t) => t.replace(/\r/g, '').trim().split('\n');
    const all = lint;
    const stats = {
      modules: +(all.match(/in (\d+) modules/) || [])[1] || 0,
      wall: parseFloat((all.match(/Walltime ([\d.]+) s/) || [])[1] || 0),
      exit: +(all.match(/exit (\d+)/) || [])[1] || 0,
      warnings: (all.match(/%Warning/g) || []).length,
      errors: (all.match(/%Error/g) || []).length,
    };
    const runL = lines(run);
    const rv = (k) => (runL.find((l) => l.startsWith(k)) || '').slice(k.length).trim();
    const real = { cycles: parseInt(rv('cycles '), 10), wall: parseFloat(rv('wall_s')), cps: parseInt(rv('cycles_per_s'), 10), led0: rv('led0_on') };

    root.innerHTML = `
      <div class="sa-vl">
        <div class="strip">
          <div class="term-win panel window">
            <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div>
              <div class="title"><b>Verilator</b> 5.053 · ${esc(d.cwd)}</div><span class="chip mode">-Wall</span></div>
            <div class="term-body"><div class="out"></div></div>
          </div>
          <div class="rules panel">
            <div class="r-head"><span>-Wall rule classes</span><span class="r-count">0 / ${d.rules.length}</span></div>
            <div class="r-grid">${d.rules.map((r, i) => `<div class="rule" data-id="${r.id}" title="${esc(r.desc)}"><i class="chk"></i>${r.id}</div>`).join('')}</div>
          </div>
        </div>
        <div class="stage panel window">
          <div class="titlebar">
            <div class="title"><b>pwm_led</b> · what lint inspects in the hardware</div>
            <div class="legend">
              <span class="lg lg-seq"><i></i>always @(posedge clk) register</span>
              <span class="lg lg-comb"><i></i>combinational logic</span>
              <span class="lg lg-w"><i></i>bit width</span>
              <span class="lg lg-rule"><i></i>rule scope</span>
            </div>
          </div>
          <div class="hw"></div>
          <div class="kbar">
            <div class="kb-mode"><span class="kb-tag">lint</span></div>
            <div class="k"><b data-k="a">–</b><span data-l="a">warnings</span></div>
            <div class="k"><b data-k="b">0</b><span data-l="b">rules checked</span></div>
            <div class="k"><b data-k="c">–</b><span data-l="c">modules</span></div>
            <div class="k"><b data-k="d">–</b><span data-l="d">walltime</span></div>
            <div class="kb-note"></div>
          </div>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const hw = mountHwSim($('.hw'), { color: TOOL, mode: 'full', widths: true });
    S = { root, $, d, m, hw, stats, real, lint: lines(lint), cc: lines(cc), runL, raf: 0, offs: [], mo: null };
    await hw.ready;
    if (!S) return;
    hw.seek(700);
    decorate();
    // hwsim rebuilds its SVG on resize; re-apply the overlay whenever that happens
    // re-decorate after hwsim rebuilds its SVG, debounced and with the observer paused while we
    // write, so our own overlay can never retrigger it (this loop froze the tab)
    let pend = 0;
    S.mo = new MutationObserver(() => {
      clearTimeout(pend);
      pend = setTimeout(() => { if (!S) return; S.mo.disconnect(); decorate(); S.mo.observe(S.$('.hw .hwsim'), { childList: true }); }, 250);
    });
    S.mo.observe($('.hw .hwsim'), { childList: true });
  },

  async play(ctx) {
    const { d, m, hw, stats, real, $ } = S;
    const sv = $('.sa-vl');
    const focus = (sel, o) => { const el = typeof sel === 'string' ? $(sel) : sel; if (el) ctx.focus?.(el, o); };
    ctx.skim?.();
    ctx.narrate('Tests passed. But is every wire in this circuit built right?');
    await command(ctx, d.cmd);
    line(`<span class="dim">elaborating pwm_led · ${d.rules.length} rule classes</span>`);

    // 1. bit widths on every register and wire
    ctx.visual?.();
    sv.classList.add('show-w');
    await ctx.sleep(2200);
    ctx.narrate('Verilator reads all 40 lines as hardware. No clock needed.');
    await ctx.sleep(2000);

    // 2. clocked vs combinational
    sv.classList.add('show-kind');
    ctx.narrate('Blue boxes remember (flip-flops). Amber boxes just compute.');
    await ctx.sleep(2100);

    // 3. rule classes tick, each highlighting (and zooming to) what it inspects
    const pinGroup = $('.hw .hw-rstpin')?.parentNode;
    const targets = [$('.hw g.hw-cmp'), $('.hw g.hw-ff'), $('.hw g.hw-ff'), $('.hw .hw-gate'), pinGroup, pinGroup];
    let n = 0;
    for (const [bi, b] of d.beats.entries()) {
      let hl = b.hl;
      if (b.rules[0] === 'WIDTHTRUNC') {
        const st = hw.state();
        hl = { ...hl, cmp7: `${st.pwm_cnt} + 224 = ${st.pwm_cnt + 224} → ${(st.pwm_cnt + 224) & 255} (8-bit wrap)` };
      }
      hw.highlight(hl);
      if (targets[bi]) focus(targets[bi], { scale: 1.6 });
      ctx.narrate(b.say);
      for (const id of b.rules) {
        const el = $(`.rule[data-id="${id}"]`);
        el.classList.add('checking');
        await ctx.sleep(170);
        el.classList.remove('checking'); el.classList.add('ok');
        n++;
        $('.r-count').textContent = `${n} / ${d.rules.length}`;
        setK('b', String(n));
      }
      line(`<span class="ok">ok</span> <span class="rid">${b.rules.join(' ')}</span>`);
      await ctx.sleep(Math.max(1100, 2050 - b.rules.length * 170));
    }
    hw.highlight({});
    ctx.unfocus?.();
    ctx.narrate(`One driver per wire, no latches, clean reset: ${d.rules.length} rules checked`);
    await ctx.sleep(2000);

    // 4. the real lint report and the verdict
    for (const l of S.lint) {
      const exit = /exit 0$/.test(l);
      line(exit ? esc(l).replace(/exit 0$/, '<span class="ok b">exit 0</span>') : hlReport(l), exit ? 'dim' : 'rep');
      await ctx.sleep(140);
    }
    line(`<span class="verdict">lint clean: ${stats.warnings} warnings, ${stats.errors} errors</span>`);
    setK('a', String(stats.warnings)); $('[data-k="a"]').classList.add('pass');
    setK('c', String(stats.modules)); setK('d', `${Math.round(stats.wall * 1000)} ms`);
    $('.kb-note').innerHTML = 'real/verilator.log';
    ctx.emit('metric', { key: 'lint-warnings', label: 'Lint warnings (-Wall)', value: stats.warnings, unit: 'warnings' });
    ctx.narrate(`${stats.warnings} warnings, ${stats.errors} errors, ${Math.round(stats.wall * 1000)} ms. The code is clean.`);
    focus('.kbar', { scale: 2 });
    await ctx.sleep(1200);
    ctx.unfocus?.();
    await ctx.sleep(900);

    // 5. the same RTL as a real cycle-accurate C++ model; the circuit ticks while it builds
    sv.classList.remove('show-kind');
    sv.classList.add('clock');
    const T = hw.trace.n - 1;
    hw.play(0, T, 600 * ctx.speed, { signal: ctx.signal });
    ctx.narrate('Same code, now compiled into a real C++ program');
    const t6 = performance.now();
    line('');
    ctx.skim?.();
    await command(ctx, m.steps[1].cmd, 3);
    for (const l of S.cc.slice(1, 3)) { line(hlReport(l), 'rep'); await ctx.sleep(110); }
    await command(ctx, 'build_msvc.bat  # cl /O2, make is not installed', 3);
    line(`<span class="dim">${m.ccFiles} C++ files + verilated.cpp →</span> <b>Vpwm_led.exe</b> <span class="dim">· ${m.compileSeconds} s</span>`);
    await ctx.sleep(300);
    await command(ctx, `./Vpwm_led ${m.cycles}`, 3);
    const live = line('<span class="dim">running…</span>');

    ctx.visual?.();
    const left = 2000 - (performance.now() - t6);
    if (left > 0) await ctx.sleep(left);
    $('.kb-tag').textContent = 'C++ model';
    sv.classList.add('model');
    setK('a', '0', 'cycles'); setK('b', '0', 'cycles / s'); setK('c', '0.00 s', 'wall time'); setK('d', '0.000 s', '25 MHz hardware time');
    $('[data-k="a"]').classList.remove('pass');
    $('.kb-note').innerHTML = `circuit: first ${fmt(T + 1)} cycles · counters: real ${fmt(real.cycles / 1e6)} M run, ${(real.wall / 4.2).toFixed(1)}× replay`;
    ctx.narrate(`${fmt(real.cycles)} clock cycles in ${real.wall.toFixed(1)} s: ${(real.cycles / 25e6).toFixed(0)} s of real LED time`);
    focus('.kbar', { scale: 1.5 });
    const dur = 4200;
    const pHw = hw.play(0, T, (T / (dur / 1000)) * ctx.speed, { signal: ctx.signal });
    await countRun(ctx, dur, (e) => {
      const c = real.cycles * e, w = real.wall * e;
      setK('a', fmt(c)); setK('b', fmt(e > 0.02 ? real.cps : real.cps * e * 50)); setK('c', `${w.toFixed(2)} s`); setK('d', `${(c / 25e6).toFixed(3)} s`);
      live.innerHTML = `<span class="dim">cycle</span> <b>${fmt(c)}</b>`;
    });
    await pHw;
    ctx.unfocus?.();
    live.remove();
    for (const l of S.runL.slice(1)) {
      const ok = /^exit 0/.test(l);
      line(ok ? '<span class="ok b">exit 0</span>' : hlRun(l), 'rep');
      await ctx.sleep(90);
    }
    $('[data-k="b"]').classList.add('pass');
    $('.kb-note').innerHTML = `LED0 on ${fmt(parseInt(real.led0, 10))} cycles (${real.led0.match(/\(([\d.]+%)/)?.[1] || ''}) · rerun identical`;
    ctx.emit('metric', { key: 'verilator-cps', label: 'Verilator C++ model speed', value: real.cps, unit: 'cycles/s' });
    ctx.narrate("It runs. Now let's see what every signal actually did.");
    hw.play(400, 4000, 900 * ctx.speed, { signal: ctx.signal });
    await ctx.sleep(2400);
  },

  unmount() {
    if (!S) return;
    cancelAnimationFrame(S.raf);
    S.mo?.disconnect();
    S.hw?.destroy();
    S.root.innerHTML = '';
    S = null;
  },
};

// ---------- terminal
function line(html, cls = '') {
  const el = document.createElement('div');
  el.className = `tl fade-line ${cls}`;
  el.innerHTML = html || '&nbsp;';
  const t = S.$('.out');
  t.appendChild(el);
  t.scrollTop = t.scrollHeight;
  return el;
}
async function command(ctx, cmd, step = 2) {
  const el = line(`<span class="prompt">$</span> <span class="cmd"></span><span class="cur"></span>`);
  const c = el.querySelector('.cmd');
  for (let i = 1; i <= cmd.length; i += step) { c.innerHTML = colorCmd(cmd.slice(0, i)); S.$('.out').scrollTop = 1e6; await ctx.sleep(18); }
  c.innerHTML = colorCmd(cmd);
  await ctx.sleep(160);
  el.querySelector('.cur')?.remove();
}
const colorCmd = (s) => esc(s)
  .replace(/^(verilator_bin|build_msvc\.bat|\.\/Vpwm_led)/, '<span class="bin">$1</span>')
  .replace(/(\s)(-[-\w]+)/g, '$1<span class="flag">$2</span>')
  .replace(/(#.*)$/, '<span class="dim">$1</span>');
function hlReport(l) {
  return esc(l)
    .replace(/^- (V e r i l a t i o n {3}R e p o r t:|Verilator:)/, '<span class="dim">- $1</span>')
    .replace(/(\d+(?:\.\d+)? (?:MB|s)\b|\d+ modules|\d+ C\+\+ files)/g, '<b>$1</b>');
}
function hlRun(l) {
  const m = l.match(/^(\S+)\s+(.*)$/);
  if (!m) return esc(l);
  return `<span class="dim">${esc(m[1].padEnd(12))}</span> <b class="${m[1] === 'cycles_per_s' ? 'tool' : ''}">${esc(m[2])}</b>`;
}

// ---------- KPI bar under the circuit
function setK(k, v, label) {
  const el = S.$(`[data-k="${k}"]`);
  if (el.textContent !== v) el.textContent = v;
  if (label) S.$(`[data-l="${k}"]`).textContent = label;
}
function countRun(ctx, ms, fn) {
  const dur = ms / ctx.speed;
  return new Promise((res) => {
    const t0 = performance.now();
    const tick = (now) => {
      if (!S || ctx.signal.aborted) return res();
      const p = Math.min(1, (now - t0) / dur);
      fn(p);
      if (p >= 1) return res();
      S.raf = requestAnimationFrame(tick);
    };
    S.raf = requestAnimationFrame(tick);
  });
}

// ---------- SVG overlay on the hwsim diagram: widths + clocked/combinational outlines
function decorate() {
  if (!S) return;
  const svg = S.$('.hw svg.hw-svg');
  if (!svg || svg.querySelector('.vl-ov')) return;
  const W = S.d.widths;
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'vl-ov');
  svg.appendChild(g);
  const el = (tag, a, parent = g, text) => {
    const n = document.createElementNS(NS, tag);
    for (const k in a) n.setAttribute(k, a[k]);
    if (text != null) n.textContent = text;
    parent.appendChild(n);
    return n;
  };
  const outline = (bb, kind, i) => el('rect', { class: `vl-out vl-${kind}`, x: bb.x - 3, y: bb.y - 3, width: bb.width + 6, height: bb.height + 6, rx: 10, style: `transition-delay:${i * 40}ms` });
  const pill = (x, y, text, i, anchor = 'end') => {
    const w = text.length * 6.1 + 12;
    const x0 = anchor === 'end' ? x - w : x;
    const pg = el('g', { class: 'vl-w', style: `transition-delay:${i * 90}ms` });
    el('rect', { x: x0, y: y - 12, width: w, height: 16, rx: 8 }, pg);
    el('text', { x: x0 + w / 2, y: y - 0.5, 'text-anchor': 'middle' }, pg, text);
    return pg;
  };
  let wi = 0, oi = 0;
  // registers
  for (const r of svg.querySelectorAll('g.hw-reg')) {
    const title = r.querySelector('.hw-title')?.textContent || '';
    const box = r.querySelector('rect.hw-box');
    if (!box) continue;
    const bb = box.getBBox();
    const key = title.startsWith('pre') ? 'pre' : title.startsWith('pwm_cnt') ? 'pwm_cnt' : title.startsWith('duty') ? 'duty' : title.startsWith('dir') ? 'dir' : null;
    if (!key) continue;
    outline(bb, 'seq', oi++);
    const txt = key === 'pre' ? '16-bit · tb: 4' : W[key].split('·').pop().trim();
    pill(bb.x + bb.width, bb.y - 4, txt, wi++);
  }
  // output flops
  [...svg.querySelectorAll('g.hw-ff rect.hw-ffbox')].forEach((box, i) => {
    const bb = box.getBBox();
    outline(bb, 'seq', oi++);
    el('text', { class: 'vl-wt', x: bb.x + bb.width - 6, y: bb.y + 13, 'text-anchor': 'end', style: `transition-delay:${(wi + i) * 50}ms` }, g, '1b');
  });
  // comparators (8-bit add + compare) and the &pre gate
  const cmps = [...svg.querySelectorAll('g.hw-cmp rect.hw-cmpbox')];
  cmps.forEach((box, i) => {
    const bb = box.getBBox();
    outline(bb, 'comb', oi++);
    el('text', { class: 'vl-wt', x: bb.x + bb.width + 7, y: bb.y + bb.height / 2 - 5, style: `transition-delay:${(wi + i) * 50}ms` }, g, '1b');
  });
  const gate = svg.querySelector('.hw-gate');
  if (gate) outline(gate.getBBox(), 'comb', oi++);

}
