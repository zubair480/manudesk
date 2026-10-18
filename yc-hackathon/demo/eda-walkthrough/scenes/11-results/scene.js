// 11-results: the finale. Five chapters, each a real result, keyed by the metric keys scenes emit
// (ctx.metrics). Fallbacks are the real values from real/ + data/ so a direct ?scene=11-results
// load shows the same numbers a full run produces.
const REAL = {
  'rtl-lines': 40, 'tb-lines': 41, 'sim-iterations': 2, tests: '4/4', 'lint-warnings': 0,
  'verilator-cps': 3970000, cocotb_passed: 4, props_proved: 5, bmc_depth: 40,
  fmax: 214.96, fmax_target: 25, luts: 48, carry: 52, ffs: 41, bitstream_bytes: 282479,
  pcb_unrouted: 0, pcb_vias: 15, pcb_route_time: 9.4, pcb_drc_errors: 0, pcb_trace_length: 509.2,
};
const val = (m, k) => (m[k] && m[k].value != null && m[k].value !== '' ? m[k].value : REAL[k]);
const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v)));

function chapters(m) {
  const fmax = num(val(m, 'fmax')), tgt = num(val(m, 'fmax_target')) || 25;
  return [
    { tool: 'Verilog', color: '#2563eb', title: 'Designed', big: `${val(m, 'rtl-lines')}`, unit: 'lines of RTL',
      rows: [['Testbench', `${val(m, 'tb-lines')} lines`], ['LEDs', '8, phase-shifted'], ['Clock', '25 MHz']] },
    { tool: 'Simulate', color: '#ea580c', title: 'Caught a bug, then passed', big: `${val(m, 'tests')}`, unit: 'tests passing',
      rows: [['Run 1', 'FAIL · test2'], ['Run 2', 'PASS · 4/4'], ['Lint warnings', `${val(m, 'lint-warnings')}`], ['cocotb', `${val(m, 'cocotb_passed')}/4 PASS`]], win: ['Lint warnings'] },
    { tool: 'Prove', color: '#db2777', title: 'Formally proved', big: `${val(m, 'props_proved')}/${val(m, 'props_proved')}`, unit: 'properties proved',
      rows: [['BMC depth', `${val(m, 'bmc_depth')} cycles`], ['bmc / prove / cover', 'PASS'], ['Verilator model', `${(num(val(m, 'verilator-cps')) / 1e6).toFixed(2)} M cycles/s`]] },
    { tool: 'Chip', color: '#c026d3', title: 'Fits the FPGA with headroom', big: fmax.toFixed(2), unit: `MHz · ${(fmax / tgt).toFixed(1)}× the ${tgt} MHz needed`,
      rows: [['LUT4', `${val(m, 'luts')} of 83,640`], ['Carry cells', `${val(m, 'carry')}`], ['Flip-flops', `${val(m, 'ffs')}`], ['Bitstream', `${(num(val(m, 'bitstream_bytes')) / 1024).toFixed(1)} KB`]] },
    { tool: 'Board', color: '#16a34a', title: 'Routed and rule-clean', big: `${val(m, 'pcb_drc_errors')}`, unit: 'clearance violations (Freerouting check)',
      rows: [['Unrouted', `58 → ${val(m, 'pcb_unrouted')}`], ['Autoroute', `${val(m, 'pcb_route_time')} s`], ['Vias', `${val(m, 'pcb_vias')}`], ['Copper', `${val(m, 'pcb_trace_length')} mm`]], win: ['Unrouted'] },
  ];
}

let raf = 0;
export default {
  id: '11-results', tool: 'Results', title: 'What the agent shipped', css: true,
  async mount(root, ctx) {
    const ch = chapters(ctx.metrics || {});
    root.innerHTML = `
      <div class="res">
        <div class="res-head">
          <div class="eyebrow">Pipeline complete · 9 open-source tools · every number from a real run</div>
          <h1>pwm_led: <span>simulated, proved, on silicon, on a board.</span></h1>
        </div>
        <div class="res-chapters">${ch.map((c, i) => `
          <section class="chap" style="--c:${c.color};--i:${i}" data-i="${i}">
            <div class="chap-top"><b>${String(i + 1).padStart(2, '0')}</b><span>${c.tool}</span><i class="ok">✓</i></div>
            <div class="chap-title">${c.title}</div>
            <div class="chap-big" data-v="${c.big}">${c.big}</div>
            <div class="chap-unit">${c.unit}</div>
            <dl>${c.rows.map(([k, v]) => `<div class="${(c.win || []).includes(k) ? 'win' : ''}"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
          </section>`).join('')}
        </div>
        <div class="res-foot">
          <div class="board"><canvas id="res-leds" width="640" height="70"></canvas><span>The same 8 phase-shifted LEDs, breathing on the PWM logic from the RTL</span></div>
          <div class="verdict"><span class="badge pass">● Ready to flash</span><span class="mono dim">pwm_led.bit · ULX3S ECP5-85F</span></div>
        </div>
      </div>`;
    this.root = root;
  },
  async play(ctx) {
    ctx.visual?.();
    const root = this.root, res = root.querySelector('.res');
    ctx.narrate('One spec, nine tools, zero hand-holding. Here is everything the agent proved.');
    res.classList.add('go');
    await ctx.sleep(2200);
    const caps = [
      'Designed: 40 lines of Verilog for an 8-LED breathing driver.',
      'Simulation caught a real testbench bug. One fix later, 4/4 passed.',
      'Formal tools proved 5 properties for every reachable state.',
      'On the FPGA: 214.96 MHz, 8.6× faster than the board needs.',
      'On the PCB: 58 connections autorouted to zero, with zero rule violations.',
    ];
    const chaps = [...root.querySelectorAll('.chap')];
    for (let i = 0; i < chaps.length; i++) {
      const c = chaps[i];
      c.classList.add('on');
      countUp(c.querySelector('.chap-big'), ctx);
      ctx.focus?.(c, { scale: 1.35, ms: 700, pad: 24 });
      ctx.narrate(caps[i]);
      await ctx.sleep(2100);
      c.classList.add('done');
    }
    await ctx.sleep(800);
    ctx.unfocus?.({ ms: 800 });
    this.leds(root.querySelector('#res-leds'));
    root.querySelector('.res').classList.add('final');
    ctx.narrate('From a text file to a board that breathes, every step checked by a real tool, driven by an agent.');
    await ctx.sleep(4200);
  },
  leds(cv) {
    const g = cv.getContext('2d'); let duty = 0, dir = 1;
    const draw = () => {
      duty += dir * 2.2; if (duty >= 255) { duty = 255; dir = -1; } if (duty <= 0) { duty = 0; dir = 1; }
      g.clearRect(0, 0, cv.width, cv.height);
      for (let i = 0; i < 8; i++) {
        let on = 0; for (let c = 0; c < 256; c += 8) on += ((c + 32 * i) & 255) < duty ? 1 : 0;
        const b = on / 32, x = 40 + i * 80, y = 35;
        const grd = g.createRadialGradient(x, y, 2, x, y, 28);
        grd.addColorStop(0, `rgba(22,163,74,${b * 0.35})`); grd.addColorStop(1, 'rgba(22,163,74,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, 28, 0, 7); g.fill();
        g.strokeStyle = '#d4d4d8'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, 10, 0, 7); g.stroke();
        g.fillStyle = `rgba(22,163,74,${0.1 + b * 0.9})`; g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
  },
  unmount() { cancelAnimationFrame(raf); },
};

function countUp(el, ctx) {
  const raw = el.dataset.v, m = raw.match(/^(\d+(?:\.\d+)?)(.*)$/);
  if (!m) return;
  const target = parseFloat(m[1]), rest = m[2], dec = (m[1].split('.')[1] || '').length;
  const t0 = performance.now(), dur = 1100 / (ctx.speed || 1);
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * e).toFixed(dec) + rest;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
