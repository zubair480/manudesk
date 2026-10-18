// KiCad-style schematic for the pwm_led carrier board, drawn as one SVG.
// viewBox is 1200 x 814 so it has the same aspect as the 56 x 38 mm board (the morph relies on it).
export const VB = { w: 1200, h: 814 };
const OY = 40; // vertical offset of the whole drawing inside the sheet

let si = 0, wi = 0, li = 0;
const S = (body) => `<g class="sym" style="--i:${si++}">${body}</g>`;
const L = (body) => `<g class="lbl" style="--i:${li++}">${body}</g>`;
const wire = (...pts) => `<polyline class="wire" pathLength="1" style="--i:${wi++}" points="${pts.map(p => p.join(',')).join(' ')}"/>`;
const dot = (x, y) => `<circle class="junc" cx="${x}" cy="${y}" r="3.6"/>`;
const t = (x, y, s, cls = '', anchor = 'start', extra = '') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${extra}>${s}</text>`;
const box = (x, y, w, h) => `<rect class="body" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`;

// pin from the connection point (x1,y1) to the body edge (x2,y2); name drawn inside the body
function pin(x1, y1, x2, y2, name, num) {
  const horiz = y1 === y2;
  let nm = '', nb = '';
  if (horiz) {
    const inward = x2 > x1 ? 1 : -1;
    nm = t(x2 + inward * 7, y2 + 4.5, name, 'pname', inward > 0 ? 'start' : 'end');
    nb = t((x1 + x2) / 2, y1 - 4, num, 'pnum', 'middle');
  } else {
    const inward = y2 > y1 ? 1 : -1;
    nm = t(x2, y2 + inward * 16 + (inward > 0 ? 0 : 8), name, 'pname', 'middle');
    nb = t(x1 + 5, (y1 + y2) / 2 + 4, num, 'pnum', 'start');
  }
  return `<line class="pin" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>${name ? nm : ''}${num ? nb : ''}`;
}
const gnd = (x, y) => `<g class="pwr"><line x1="${x}" y1="${y}" x2="${x}" y2="${y + 8}"/><polyline points="${x - 10},${y + 8} ${x + 10},${y + 8} ${x},${y + 18} ${x - 10},${y + 8}"/></g>`;
const pwr = (x, y, name = '+3V3') => `<g class="pwr"><line x1="${x}" y1="${y}" x2="${x}" y2="${y - 10}"/><line x1="${x - 9}" y1="${y - 10}" x2="${x + 9}" y2="${y - 10}"/>${t(x, y - 16, name, 'pwrname', 'middle')}</g>`;
const netlabel = (x, y, name, anchor = 'start') => t(x, y - 5, name, 'netlbl', anchor);
const nc = (x, y) => `<g class="nc"><line x1="${x - 5}" y1="${y - 5}" x2="${x + 5}" y2="${y + 5}"/><line x1="${x - 5}" y1="${y + 5}" x2="${x + 5}" y2="${y - 5}"/></g>`;

// schematic centre of every symbol, in viewBox units, used by the schematic → PCB morph
export const SCH_POS = {};
const at = (ref, x, y) => { SCH_POS[ref] = [x, y + OY]; };

export function buildSchematic() {
  si = wi = li = 0;
  const out = [];

  // ---------- U1: ECP5 ----------
  at('U1', 540, 350);
  const ledY = (i) => 180 + i * 40;
  let u = box(430, 140, 220, 420) + t(430, 131, 'U1', 'ref') + t(430, 580, 'LFE5U-85F-6BG381C (used balls only)', 'val')
    + t(540, 345, 'ECP5', 'chipname', 'middle') + t(540, 368, 'Lattice · CABGA381', 'chipsub', 'middle');
  u += pin(400, 200, 430, 200, 'CLK', 'B1');
  u += pin(400, 250, 430, 250, 'USB_DN', 'E1') + pin(400, 280, 430, 280, 'USB_DP', 'F1');
  ['TCK', 'TDI', 'TMS', 'TDO', 'RST'].forEach((n, i) => { u += pin(400, 380 + i * 30, 430, 380 + i * 30, n, ['B8', 'C8', 'D8', 'E8', 'F8'][i]); });
  for (let i = 0; i < 8; i++) u += pin(680, ledY(i), 650, ledY(i), `LED${i}`, `H${i + 1}`);
  u += pin(500, 110, 500, 140, 'VCCIO', 'C3') + pin(580, 110, 580, 140, 'VCC', 'F6');
  u += pin(520, 590, 520, 560, 'GND', 'D4') + pin(560, 590, 560, 560, 'GND', 'E5');
  out.push(S(u));

  // ---------- Y1: 25 MHz oscillator ----------
  at('Y1', 275, 180);
  out.push(S(box(230, 150, 90, 60) + t(230, 142, 'Y1', 'ref') + t(275, 228 + 20, '25 MHz', 'val', 'middle')
    + `<path class="sine" d="M255,186 q5,-10 10,0 t10,0 t10,0 t10,0"/>`
    + pin(350, 180, 320, 180, 'OUT', '3') + pin(200, 180, 230, 180, 'EN', '1')
    + pin(275, 125, 275, 150, '', '4') + pin(275, 230, 275, 210, '', '2')));

  // ---------- J2: micro-USB ----------
  at('J2', 110, 290);
  out.push(S(box(70, 235, 80, 115) + t(70, 227, 'J2', 'ref') + t(70, 368, 'USB_Micro-B', 'val')
    + pin(180, 250, 150, 250, 'D-', '2') + pin(180, 280, 150, 280, 'D+', '3') + pin(180, 310, 150, 310, 'VBUS', '1')
    + pin(180, 325, 150, 325, 'ID', '4') + pin(180, 340, 150, 340, 'GND', '5')));

  // ---------- J1: JTAG header ----------
  at('J1', 275, 440);
  let j = box(230, 360, 90, 160) + t(230, 352, 'J1', 'ref') + t(230, 538, 'JTAG 2×05', 'val');
  ['TCK', 'TDI', 'TMS', 'TDO', 'RST'].forEach((n, i) => { j += pin(350, 380 + i * 30, 320, 380 + i * 30, n, String(3 + i)); });
  j += pin(200, 390, 230, 390, 'VREF', '1') + pin(200, 480, 230, 480, 'GND', '2');
  out.push(S(j));

  // ---------- U2: LDO ----------
  at('U2', 280, 620);
  out.push(S(box(230, 590, 100, 60) + t(230, 582, 'U2', 'ref') + t(280, 690, 'AMS1117-3.3', 'val', 'middle')
    + pin(200, 610, 230, 610, 'VI', '3') + pin(360, 610, 330, 610, 'VO', '2') + pin(280, 670, 280, 650, '', '1')));

  // ---------- R1..R8, D1..D8 ----------
  for (let i = 0; i < 8; i++) {
    const y = ledY(i);
    at(`R${i + 1}`, 755, y); at(`D${i + 1}`, 850, y);
    out.push(S(`<line class="pin" x1="720" y1="${y}" x2="730" y2="${y}"/><rect class="body" x="730" y="${y - 7}" width="50" height="14" rx="1.5"/><line class="pin" x1="780" y1="${y}" x2="790" y2="${y}"/>`
      + t(755, y - 12, `R${i + 1}`, 'ref sm', 'middle') + t(755, y + 4.5, '330', 'val xs', 'middle')));
    out.push(S(`<line class="pin" x1="830" y1="${y}" x2="842" y2="${y}"/><polygon class="body led" points="842,${y - 9} 842,${y + 9} 858,${y}"/><line class="pin bar" x1="858" y1="${y - 9}" x2="858" y2="${y + 9}"/><line class="pin" x1="858" y1="${y}" x2="870" y2="${y}"/>`
      + `<g class="rays"><path d="M852,${y - 12} l6,-7 M858,${y - 10} l6,-7"/></g>` + t(850, y - 13, `D${i + 1}`, 'ref sm', 'end')));
  }
  out.push(L(t(755, 160, 'R1–R8 330 Ω', 'note', 'middle') + t(850, 160, 'D1–D8 green', 'note', 'start', 'dx="-12"')));

  // ---------- decoupling C1..C4 ----------
  const cx = [790, 860, 930, 1000];
  cx.forEach((x, k) => {
    at(`C${k + 1}`, x, 95);
    out.push(S(`<line class="pin" x1="${x}" y1="60" x2="${x}" y2="89"/><line class="plate" x1="${x - 12}" y1="89" x2="${x + 12}" y2="89"/><line class="plate" x1="${x - 12}" y1="99" x2="${x + 12}" y2="99"/><line class="pin" x1="${x}" y1="99" x2="${x}" y2="130"/>`
      + t(x + 16, 90, `C${k + 1}`, 'ref sm') + t(x + 16, 106, '100n', 'val xs')));
  });

  // ---------- mounting holes ----------
  [0, 1, 2, 3].forEach(k => {
    const x = 1010 + k * 50, y = 330;
    at(`H${k + 1}`, x, y);
    out.push(S(`<circle class="body" cx="${x}" cy="${y}" r="13"/><circle class="hole" cx="${x}" cy="${y}" r="6"/>` + t(x, y + 32, `H${k + 1}`, 'ref sm', 'middle')));
  });
  out.push(L(t(1085, 380, 'MountingHole_3.2mm_M3', 'note', 'middle')));

  // ---------- wires ----------
  const W = [];
  W.push(wire([350, 180], [380, 180], [380, 200], [400, 200]));                 // CLK25
  W.push(wire([200, 180], [200, 135], [275, 135]));                             // EN tied high
  W.push(wire([180, 250], [400, 250])); W.push(wire([180, 280], [400, 280]));    // USB D-/D+
  for (let i = 0; i < 5; i++) W.push(wire([350, 380 + i * 30], [400, 380 + i * 30])); // JTAG
  for (let i = 0; i < 8; i++) {
    const y = ledY(i);
    W.push(wire([680, y], [720, y])); W.push(wire([790, y], [830, y])); W.push(wire([870, y], [920, y]));
  }
  W.push(wire([920, ledY(0)], [920, 490]));                                     // LED cathode GND bus
  W.push(wire([760, 60], [1000, 60])); W.push(wire([790, 130], [1020, 130]));    // decoupling rails
  W.push(wire([180, 310], [205, 310])); W.push(wire([180, 340], [195, 340], [195, 352]));
  out.push(`<g class="wires">${W.join('')}</g>`);

  // ---------- junctions, power symbols, labels ----------
  let p = '';
  for (let i = 1; i < 8; i++) p += dot(920, ledY(i));
  p += dot(275, 135) + [860, 930].map(x => dot(x, 60)).join('') + [860, 930, 1000].map(x => dot(x, 130)).join('');
  p += pwr(275, 125) + gnd(275, 230) + pwr(500, 110) + pwr(580, 110) + gnd(520, 590) + gnd(560, 590)
    + gnd(195, 352) + pwr(200, 390) + gnd(200, 480) + gnd(280, 670) + pwr(360, 610) + gnd(920, 490)
    + pwr(760, 60) + gnd(1020, 130) + nc(180, 325);
  p += netlabel(207, 310, 'VBUS') + netlabel(198, 610, 'VBUS', 'end') + netlabel(352, 200, 'CLK25')
    + netlabel(188, 250, 'USB_DN') + netlabel(188, 280, 'USB_DP');
  for (let i = 0; i < 8; i++) p += netlabel(684, ledY(i), `LED${i}`);
  out.push(L(p));

  // ---------- sheet frame + title block ----------
  const frame = `<rect class="frame" x="8" y="8" width="1184" height="798" rx="3"/>`
    + [1, 2, 3, 4, 5, 6].map(k => t(k * 200 - 100, 22, k, 'tick', 'middle')).join('')
    + `<g class="tblock"><rect x="900" y="724" width="284" height="74"/><line x1="900" y1="748" x2="1184" y2="748"/><line x1="900" y1="772" x2="1184" y2="772"/>`
    + t(912, 741, 'pwm_led carrier', 'tbt') + t(912, 765, 'Drawn from real/pcb/gen_board.py (no .kicad_sch)', 'tbs')
    + t(912, 789, 'Rev A · 2026-10-18 · KiCad E.D.A. 9.0', 'tbs') + `</g>`;

  return `<svg class="sch-svg" viewBox="0 0 ${VB.w} ${VB.h}" preserveAspectRatio="none">
    <defs><pattern id="kc9-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".9" class="griddot"/></pattern></defs>
    <rect class="paper" x="0" y="0" width="${VB.w}" height="${VB.h}"/><rect x="0" y="0" width="${VB.w}" height="${VB.h}" fill="url(#kc9-grid)"/>
    ${frame}<g transform="translate(0,${OY})">${out.join('')}</g></svg>`;
}
export const counts = () => ({ symbols: si, wires: wi });
