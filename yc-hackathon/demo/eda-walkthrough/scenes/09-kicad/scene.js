// Scene 09: KiCad. Schematic → PCB (placement + ratsnest) → routed board → 3D viewer with breathing LEDs → DRC.
// Board geometry and copper come from data/09-kicad.json (real Freerouting run, see real/pcb/).
import { buildSchematic, SCH_POS, VB } from './schematic.js';
import { createPCB } from './pcb2d.js';

const easeIO = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

let S = null; // per-mount state

/** RAF tween that scales with ctx.speed and rejects on abort. A timer backs up RAF so a throttled
 *  (occluded/background) window can never stall the scene. */
function anim(ctx, ms, fn) {
  return new Promise((res, rej) => {
    if (ctx.signal.aborted) return rej(new DOMException('aborted', 'AbortError'));
    const dur = ms / ctx.speed, t0 = performance.now();
    let id = 0, to = 0, done = false;
    const stop = () => { cancelAnimationFrame(id); clearTimeout(to); };
    const onAbort = () => { done = true; stop(); rej(new DOMException('aborted', 'AbortError')); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const step = () => {
      if (done) return;
      stop();
      const t = clamp01((performance.now() - t0) / dur);
      fn(t);
      if (t < 1) { id = requestAnimationFrame(step); to = setTimeout(step, 64); }
      else { done = true; ctx.signal.removeEventListener('abort', onAbort); res(); }
    };
    id = requestAnimationFrame(step); to = setTimeout(step, 64);
  });
}

const STEPS = [
  ['sch', 'Schematic capture', 'symbols + nets'],
  ['erc', 'Electrical rules check', 'not run'],
  ['upd', 'Update PCB from schematic', 'F8'],
  ['place', 'Placement · ratsnest', 'airwires'],
  ['route', 'Routed copper', 'Freerouting .ses'],
  ['3d', '3D viewer', 'raytrace-style'],
  ['drc', 'Rules check', 'Freerouting'],
];

export default {
  id: '09-kicad',
  tool: 'KiCad',
  title: 'KiCad: schematic → PCB → 3D board',
  css: true,

  async mount(root, ctx) {
    const data = await ctx.data('09-kicad');
    const st = data.stats;
    root.innerHTML = `
    <div class="kc9">
      <div class="kc9-win window glass">
        <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div>
          <div class="title"><b>pwm_led_carrier</b> — <span class="kc9-app">Schematic Editor</span> · KiCad 9.0</div><div class="kc9-tb-r mono">.kicad_pro</div></div>
        <div class="kc9-tools">
          <div class="kc9-tabs"><span data-tab="sch" class="on">Schematic</span><span data-tab="pcb">PCB</span><span data-tab="3d">3D Viewer</span></div>
          <div class="kc9-tool-r">
            <span class="kc9-chip" data-chip="erc">ERC</span><span class="kc9-chip" data-chip="upd">Update PCB</span><span class="kc9-chip" data-chip="drc">Rules</span>
            <span class="kc9-layer mono"><i></i>F.Cu</span>
          </div>
        </div>
        <div class="kc9-view">
          <div class="kc9-sheet">${buildSchematic()}</div>
          <canvas class="kc9-pcb"></canvas>
          <div class="kc9-3d"></div>
          <div class="kc9-toast"></div>
          <div class="kc9-rail l">
            <div class="kc9-read"><h5>Board</h5><dl>
              <dt>Outline</dt><dd><b data-r="size">${data.board.w.toFixed(1)} × ${data.board.h.toFixed(1)}</b> mm</dd>
              <dt>Copper layers</dt><dd><b>${data.board.layers.length}</b> F.Cu · B.Cu</dd>
              <dt>Symbols / footprints</dt><dd><b data-r="parts">0</b> / ${data.parts.length}</dd>
              <dt>Nets</dt><dd><b data-r="nets">0</b> / ${data.nets.length}</dd>
              <dt>Pads</dt><dd><b data-r="pads">0</b> / ${data.parts.reduce((n, p) => n + p.pads.length, 0)}</dd>
              <dt>Airwires</dt><dd><b data-r="rats">–</b></dd>
            </dl></div>
            <div class="kc9-hud">
              <div class="kc9-hud-h"><b>pwm_led.v</b><span class="kc9-live"><i></i>live model</span></div>
              <div class="kc9-hud-duty mono"><span>duty</span><b class="kc9-duty">0x00</b><span class="kc9-dir">↑</span><div class="kc9-bar"><i></i></div></div>
              <div class="kc9-ledrow mono"><span>led[7:0]</span><b class="kc9-bits">00000000</b><span class="kc9-cnt">@0x00</span></div>
              <canvas class="kc9-scope"></canvas>
              <div class="kc9-hud-f mono">(pwm_cnt + 32·i) &lt; duty · 25 MHz · breath ${(2 * 256 * 65536 / 25e6).toFixed(2)} s</div>
            </div>
          </div>
          <div class="kc9-rail r">
            <div class="kc9-read"><h5>Routing</h5><dl>
              <dt>Tracks</dt><dd><b data-r="tracks">0</b> / ${data.wires.length}</dd>
              <dt>F.Cu · B.Cu</dt><dd><b data-r="fb">0 · 0</b></dd>
              <dt>Vias</dt><dd><b data-r="vias">0</b> / ${data.vias.length}</dd>
              <dt>Copper length</dt><dd><b data-r="len">0.0</b> mm</dd>
              <dt>Nets routed</dt><dd><b data-r="netsr">0</b> / ${data.nets.length}</dd>
            </dl></div>
            <div class="kc9-read kc9-read-checks"><h5>Checks</h5><dl>
              <dt>ERC errors</dt><dd><b data-r="erc">–</b></dd>
              <dt>Unrouted</dt><dd><b data-r="unr">–</b></dd>
              <dt>Clearance viol.</dt><dd><b data-r="clr">–</b></dd>
              <dt>Rule violations</dt><dd><b data-r="drc">–</b></dd>
            </dl></div>
            <div class="kc9-drc">
              <div class="kc9-drc-h"><b>Rules check</b><span class="badge kc9-drc-badge">running…</span></div>
              <div class="kc9-prog"><i></i></div>
              <ul class="kc9-checks"></ul>
              <div class="kc9-drc-f"></div>
            </div>
          </div>
        </div>
        <div class="kc9-status mono"><span class="kc9-st-l">Ready</span><span class="kc9-st-r">grid 0.5 mm · Z fit</span></div>
      </div>
      <aside class="kc9-side">
        <div class="glass kc9-steps">
          <div class="eyebrow">Board flow</div>
          <ol>${STEPS.map(([k, a, b]) => `<li data-step="${k}"><span class="kc9-dot"></span><span class="kc9-sl">${a}</span><span class="kc9-sr mono">${b}</span></li>`).join('')}</ol>
        </div>
        <div class="callout kc9-callout"><h4>What this means</h4><p></p></div>
      </aside>
    </div>`;

    const q = (s) => root.querySelector(s);
    const view = q('.kc9-view'), canvas = q('.kc9-pcb'), sheet = q('.kc9-sheet');
    const pcb = createPCB(canvas, data);

    // final position minus the schematic position (mapped into board mm) = where each footprint starts
    const startOff = {};
    for (const p of data.parts) {
      const sp = SCH_POS[p.ref];
      // mounting holes are big copper rings: fade them in where they belong instead of flying them in a bunch
      startOff[p.ref] = sp && p.kind !== 'hole' ? [sp[0] / VB.w * data.board.w - p.x, sp[1] / VB.h * data.board.h - p.y] : [0, 0];
    }
    const pcbState = { bg: 0, boardA: 0, edge: 0, partsA: 0, offsets: {}, ratsA: 0, tracks: 0 };

    const layout = () => {
      const rail = q('.kc9-rail')?.offsetWidth || 0;
      // keep the rails clear of the board, but never let them squeeze it below ~70% of the view width
      const padX = rail ? Math.min(rail + 12, view.clientWidth * 0.15) : 0;
      const R = pcb.layout(padX);
      Object.assign(sheet.style, { left: `${R.x}px`, top: `${R.y}px`, width: `${R.w}px`, height: `${R.h}px` });
      S?.gl?.setFill(R.h, rail + 24);
      if (S) S.railPad = rail + 24;
      pcb.draw(pcbState);
    };
    const ro = new ResizeObserver(layout);
    S = { data, root, q, view, pcb, pcbState, startOff, ro, layout, gl: null, glPromise: null, disposed: false };
    ro.observe(view); layout();

    // load three.js + build the 3D board in the background while the 2D part plays
    const hud = q('.kc9-scope');
    S.glPromise = import('./board3d.js').then(m => m.createBoard3D(q('.kc9-3d'), data, {
      speed: () => ctx.skimming ? ctx.speed / 4 : ctx.speed,   // the 3D is a figure: never skimmed
      onFrame: (pwm, lvl) => drawScope(hud, pwm, lvl, q),
    })).then(gl => {
      if (S?.disposed) { gl.dispose(); return null; }
      S.gl = gl; gl.setFill(pcb.rect.h, S.railPad || 0); gl.renderOnce(); return gl;
    }).catch(err => { console.warn('[09-kicad] 3D viewer unavailable:', err.message); return null; });

    q('.kc9-callout p').textContent = 'The circuit is drawn as symbols and wires. Each wire is a net: an electrical connection the PCB must honour.';
    S.stats = st;
  },

  async play(ctx) {
    const { q, data, pcb, pcbState, startOff, view } = S;
    const step = (k) => {
      let seen = false;
      S.root.querySelectorAll('.kc9-steps li').forEach(li => {
        const me = li.dataset.step === k; if (me) seen = true;
        li.classList.toggle('on', me); li.classList.toggle('done', !me && !seen);
      });
    };
    const say = (t) => { q('.kc9-callout p').textContent = t; q('.kc9-callout').classList.remove('pulse'); void q('.kc9-callout').offsetWidth; q('.kc9-callout').classList.add('pulse'); };
    const status = (l, r) => { q('.kc9-st-l').textContent = l; if (r) q('.kc9-st-r').textContent = r; };
    const toast = async (html, ms = 1800) => {
      const t = q('.kc9-toast'); t.innerHTML = html; t.classList.add('on');
      await ctx.sleep(ms); t.classList.remove('on');
    };
    const tab = (k, app) => {
      S.root.querySelectorAll('.kc9-tabs span').forEach(s => s.classList.toggle('on', s.dataset.tab === k));
      q('.kc9-app').textContent = app;
    };
    const chip = (k, on = true) => q(`[data-chip="${k}"]`).classList.toggle('on', on);
    const draw = () => pcb.draw(pcbState);
    const rd = (k, v) => { const el = S.root.querySelector(`[data-r="${k}"]`); if (el && el.textContent !== String(v)) el.textContent = v; };
    const countTo = (k, to, ms) => anim(ctx, ms, (t) => rd(k, Math.round(easeOut(t) * to)));
    const routed = (t) => {
      const r = pcb.stats(t);
      rd('tracks', r.tracks); rd('fb', `${r.f} · ${r.b}`); rd('vias', r.vias); rd('len', r.len.toFixed(1));
      rd('netsr', r.netsRouted); rd('rats', r.unrouted); rd('unr', r.unrouted);
    };

    // ---------- 1. schematic (a figure: normal speed) ----------
    ctx.visual?.();
    step('sch'); status('Schematic view of the netlist in real/pcb/gen_board.py', 'sheet A4 · grid 1.27 mm');
    ctx.narrate('The schematic: one FPGA, a 25 MHz clock and 8 LEDs to breathe.');
    const sch = q('.sch-svg');
    sch.classList.add('show-sym'); await countTo('parts', data.parts.length, 1300);
    sch.classList.add('show-wire');
    ctx.focus?.(sch.querySelector('.sym'), { scale: 1.6, ms: 900 });   // U1, the ECP5
    await countTo('nets', data.nets.length, 1500);
    ctx.unfocus?.({ ms: 700 });
    sch.classList.add('show-lbl'); await ctx.sleep(900);

    // ---------- 2. ERC ----------
    step('erc'); chip('erc');
    say('KiCad would run ERC here (pins driven, no shorted outputs). KiCad is not installed on this machine, so ERC was not run; the netlist comes straight from gen_board.py.');
    status('Inspect ▸ Electrical Rules Checker', `${data.nets.length} nets · ${data.parts.length} symbols`);
    rd('erc', 'not run');
    await toast(`<b>ERC</b> <span class="badge">not run</span> <span class="mono">KiCad not installed · netlist from gen_board.py</span>`, 1300);
    chip('erc', false);

    // ---------- 3. update PCB: schematic morphs into footprints ----------
    ctx.visual?.();
    step('upd'); chip('upd');
    ctx.narrate('Each symbol becomes a real footprint with copper pads.');
    say('Symbols become footprints, the physical land patterns, and nets carry over as airwires (the ratsnest) that still need copper.');
    const pads = data.parts.reduce((n, p) => n + p.pads.length, 0);
    for (const p of data.parts) pcbState.offsets[p.ref] = [...startOff[p.ref]];
    pcbState.ratsA = 0.0; pcbState.partsA = 0;
    await anim(ctx, 900, (t) => {
      const e = easeOut(t);
      sch.style.opacity = String(1 - e);
      pcbState.bg = e; pcbState.partsA = e; pcbState.ratsA = e * 0.9;
      rd('pads', Math.round(e * pads)); rd('rats', Math.round(e * data.ratsnest.length)); rd('unr', Math.round(e * data.ratsnest.length));
      draw();
    });
    sch.style.visibility = 'hidden';
    tab('pcb', 'PCB Editor'); chip('upd', false);
    status('Update PCB from Schematic: 29 footprints added, 27 nets', 'F.Cu · grid 0.5 mm');

    // ---------- 4. placement + ratsnest ----------
    step('place');
    const parts = data.parts;
    await anim(ctx, 2600, (t) => {
      parts.forEach((p, i) => {
        const k = easeIO(clamp01((t - (i / parts.length) * 0.35) / 0.65));
        const [sx, sy] = startOff[p.ref];
        pcbState.offsets[p.ref] = [sx * (1 - k), sy * (1 - k)];
      });
      pcbState.boardA = easeOut(clamp01((t - 0.35) / 0.5));
      pcbState.edge = easeIO(clamp01((t - 0.4) / 0.6));
      draw();
    });
    status(`Placement done · ${data.ratsnest.length} unrouted connections`, '56.0 × 38.0 mm · 2 layers');
    say(`Parts are placed. The thin lines are the ratsnest: ${data.ratsnest.length} point-to-point connections from the netlist, still without copper.`);
    ctx.narrate(`${data.ratsnest.length} wires to route by hand, or 9 seconds by machine?`);
    const rw = S.root.querySelector('[data-r="rats"]')?.closest('dd'); rw?.classList.add('flash');
    await anim(ctx, 900, (t) => { pcbState.ratsA = 0.9 + 0.1 * Math.sin(t * Math.PI * 4); draw(); });
    rw?.classList.remove('flash');

    // ---------- 5. routed copper (import of the real Freerouting session) ----------
    step('route');
    ctx.narrate('Spoiler: here is the routed board. Next: how a robot drew it.');
    const tp = toast(`<span class="mono">File ▸ Import ▸ Specctra Session…</span> <b>board.ses</b>`, 2400);
    await anim(ctx, 2600, (t) => { pcbState.tracks = easeIO(t); draw(); routed(pcbState.tracks); });
    routed(1); rd('clr', data.stats.clearance_violations);
    await tp;
    status(`Unrouted 0 · ${data.wires.length} tracks · ${data.vias.length} vias · ${data.stats.trace_length_mm} mm of copper`, 'F.Cu red · B.Cu blue');
    say(`All ${data.ratsnest.length} connections are now copper: ${data.stats.f_wires} tracks on the top layer, ${data.stats.b_wires} on the bottom, and ${data.vias.length} vias between them.`);
    await ctx.sleep(1200);

    // ---------- 6. 3D viewer ----------
    const gl = await S.glPromise;
    if (gl) {
      step('3d'); tab('3d', '3D Viewer');
      ctx.narrate('In 3D, the LEDs breathe from the same logic as pwm_led.v.');
      say('The LEDs breathe from the RTL logic itself: duty climbs 0→255→0, one step every 2¹⁶ clocks. The 8 PWM carriers are phase-shifted by 32 counts, so they never all switch at once.');
      status('View ▸ 3D Viewer (Alt+3)', 'ECP5 BGA · 8× LED 0603 · 25 MHz XO');
      gl.start();
      await ctx.sleep(80);
      
      await anim(ctx, 700, (t) => { q('.kc9-3d').style.opacity = String(easeOut(t)); });
      gl.flyIn(4600 / ctx.speed);
      await ctx.sleep(3000);
      q('.kc9-hud').classList.add('on');
      gl.dolly(1, 1600 / ctx.speed);           // push in on the breathing LED row
      await ctx.sleep(3600);
      gl.dolly(0, 1400 / ctx.speed);
      await ctx.sleep(900);
    } else {
      say('3D viewer could not load (offline?). The routed 2D board above is the same data.');
      ctx.narrate(`${data.ratsnest.length} wires to route by hand, or 9 seconds by machine?`);
    const rw = S.root.querySelector('[data-r="rats"]')?.closest('dd'); rw?.classList.add('flash');
    await anim(ctx, 900, (t) => { pcbState.ratsA = 0.9 + 0.1 * Math.sin(t * Math.PI * 4); draw(); });
    rw?.classList.remove('flash');
    }

    // ---------- 7. DRC ----------
    step('drc'); chip('drc');
    ctx.narrate('Rules check on the routed copper: clearance, widths, connections.');
    q('.kc9-read-checks').classList.add('gone');
    const drc = q('.kc9-drc'); drc.classList.add('on');
    const w = data.wires, minW = Math.min(...w.map(x => x.w)), r = data.board.rules;
    // closest copper (tracks, vias, pads) to the board edge, from the real geometry
    const BW = data.board.w, BH = data.board.h, edge = (x, y, h) => Math.min(x, y, BW - x, BH - y) - h;
    const edgeMin = Math.min(
      ...w.flatMap(x => x.pts.map(([px, py]) => edge(px, py, x.w / 2))),
      ...data.vias.map(v => edge(v.x, v.y, v.d / 2)),
      ...data.parts.flatMap(p => p.pads.map(pd => edge(pd.x, pd.y, pd.s === 'c' ? pd.d / 2 : Math.max(pd.w, pd.h) / 2))));
    const checks = [
      [`Clearance ≥ ${r.clearance}`, `${data.stats.clearance_violations}`],
      [`Track ${r.track} mm`, `${w.filter(x => x.w < r.track).length} necked ${minW.toFixed(2)}`, w.some(x => x.w < r.track) ? 'warn' : 'ok'],
      [`Via ${r.via_d}/${r.via_drill} mm`, `${data.vias.length}`],
      ['Copper–edge (min)', `${edgeMin.toFixed(2)} mm`],
      ['Unconnected', `${data.stats.incomplete}`],
      ['Schematic parity', `${data.parts.length}/${data.parts.length}`],
    ];
    const ul = q('.kc9-checks'); ul.innerHTML = checks.map(([a, b, k]) => `<li data-k="${k || 'ok'}"><span class="ck"></span><span>${a}</span><span class="mono">${b}</span></li>`).join('');
    const items = [...ul.children];
    await ctx.sleep(450);
    for (let i = 0; i < items.length; i++) {
      q('.kc9-prog i').style.width = `${((i + 1) / items.length) * 100}%`;
      items[i].classList.add(items[i].dataset.k === 'warn' ? 'warn' : 'ok');
      await ctx.sleep(180);
    }
    const errors = data.drc.errors + data.stats.clearance_violations;
    rd('drc', errors);
    const badge = q('.kc9-drc-badge'); badge.textContent = `${errors} violations`; badge.classList.add(errors ? 'fail' : 'pass');
    q('.kc9-drc-f').innerHTML = `<span><b>${errors}</b> violations</span><span><b>${data.stats.incomplete}</b> unconnected</span><em>Freerouting clearance + connectivity (board.result.json) and geometry from board.ses. KiCad DRC (kicad-cli pcb drc) not run here.</em>`;
    q('.kc9-drc-f').classList.add('on');
    status(`Rules check: ${errors} violations · ${data.stats.incomplete} unconnected (Freerouting result)`, 'KiCad DRC not run');
    say('Zero rule violations: Freerouting found every clearance holding and every net connected. A real tape-out would still run KiCad DRC (kicad-cli pcb drc).');
    step('drc-done');
    S.root.querySelector('[data-step="drc"]').classList.add('done');

    ctx.visual?.();
    ctx.emit('metric', { key: 'pcb_board_size', label: 'Board size', value: `${data.board.w} × ${data.board.h}`, unit: 'mm' });
    ctx.emit('metric', { key: 'pcb_components', label: 'Components', value: data.parts.length });
    ctx.emit('metric', { key: 'pcb_layers', label: 'Copper layers', value: data.board.layers.length });
    ctx.emit('metric', { key: 'pcb_drc_errors', label: 'Rule violations (Freerouting check)', value: errors });
    ctx.focus?.(q('.kc9-drc'), { scale: 1.5, ms: 800 });
    await ctx.sleep(1400);
    ctx.unfocus?.({ ms: 700 });
    await ctx.sleep(2000);
  },

  unmount() {
    if (!S) return;
    S.disposed = true; S.ro.disconnect();
    S.gl?.dispose();
    S = null;
  },
};

/** HUD oscilloscope: the eight PWM carriers over one 256-count frame at the current duty. */
function drawScope(cv, pwm, lvl, q) {
  if (!cv.isConnected) return;
  const r = cv.getBoundingClientRect(); if (!r.width) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = r.width, h = r.height;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const rowH = h / 8, x0 = 26, ww = w - x0 - 4;
  g.font = '500 9.5px "Geist Mono", ui-monospace, monospace'; g.textBaseline = 'middle';
  for (let i = 0; i < 8; i++) {
    const yb = i * rowH + rowH * 0.78, yt = i * rowH + rowH * 0.22;
    g.fillStyle = '#a1a1aa'; g.fillText(`[${i}]`, 0, i * rowH + rowH / 2);
    g.strokeStyle = i % 2 ? '#16a34a' : '#15803d'; g.lineWidth = 1.2; g.beginPath();
    let prev = null;
    for (let c = 0; c <= 256; c++) {
      const on = pwm.bit(i, c % 256), x = x0 + (c / 256) * ww, y = on ? yt : yb;
      if (prev === null) g.moveTo(x, y); else if (prev !== y) { g.lineTo(x, prev); g.lineTo(x, y); } else g.lineTo(x, y);
      prev = y;
    }
    g.stroke();
  }
  const c = Math.floor(performance.now() / 70) & 255;
  let bits = ''; for (let i = 7; i >= 0; i--) bits += pwm.bit(i, c) ? '1' : '0';
  q('.kc9-bits').textContent = bits; q('.kc9-cnt').textContent = '@0x' + c.toString(16).toUpperCase().padStart(2, '0');
  q('.kc9-duty').textContent = '0x' + pwm.duty.toString(16).toUpperCase().padStart(2, '0');
  q('.kc9-dir').textContent = pwm.dir ? '↑' : '↓';
  q('.kc9-bar i').style.width = `${(pwm.duty / 255) * 100}%`;
}
