// Intro screen motion: word reveal, the rotating "was <verb> by <tool>" line, count-up stats,
// the autonomous pipeline strip, and the 3D hero board. Purely decorative; core.js owns navigation.
import { mountHero } from './hero.js';

const intro = document.getElementById('intro');

// 1. headline: split into words, each rises out of a mask with a stagger
const h1 = document.getElementById('hero-h1');
const words = h1.textContent.trim().split(/\s+/);
h1.innerHTML = words.map((w, i) => {
  const accent = /Verilog|breathing/.test(w) ? ' class="acc"' : '';
  return `<span class="w"><span${accent} style="animation-delay:${120 + i * 70}ms">${w}</span></span>`;
}).join(' ');

// 2. rotating tool line, each tool in its own color
const ROT = [
  ['simulated', 'Icarus Verilog', '#ea580c'], ['linted', 'Verilator', '#7c3aed'], ['inspected', 'GTKWave', '#059669'],
  ['tested in Python', 'cocotb', '#0891b2'], ['synthesized', 'Yosys', '#4f46e5'], ['placed & routed', 'nextpnr', '#c026d3'],
  ['formally proved', 'SymbiYosys', '#db2777'], ['laid out', 'KiCad', '#16a34a'], ['autorouted', 'Freerouting', '#dc2626'],
];
const verb = document.getElementById('rot-verb'), tool = document.getElementById('rot-tool');
let ri = 0;
const swap = (el, text, color) => {
  el.classList.add('out');
  setTimeout(() => { el.textContent = text; if (color) el.style.color = color; el.classList.remove('out'); el.classList.add('in'); setTimeout(() => el.classList.remove('in'), 450); }, 160);
};
tool.style.color = ROT[0][2];
const rotTimer = setInterval(() => {
  if (intro.classList.contains('gone')) return;
  ri = (ri + 1) % ROT.length;
  swap(verb, ROT[ri][0]); swap(tool, ROT[ri][1], ROT[ri][2]);
  setActive(ri + 1);
}, 2200);

// 3. stats count up
setTimeout(() => {
  document.querySelectorAll('.stats b').forEach((b, i) => {
    const target = Number(b.dataset.count), dec = Number(b.dataset.dec || 0);
    const t0 = performance.now() + i * 120, dur = 1400;
    const step = (t) => {
      const p = Math.max(0, Math.min(1, (t - t0) / dur)), e = 1 - Math.pow(1 - p, 4);
      b.textContent = (target * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}, 700);

// 4. pipeline strip: built from scenes.json; a highlight travels along it in sync with the rotator
const strip = document.getElementById('intro-tools');
let setActive = () => {};
fetch('scenes.json').then(r => r.json()).then(list => {
  strip.innerHTML = `<div class="rail"><i></i></div>` + list.map((s, i) =>
    `<div class="node" style="--c:${s.color};animation-delay:${600 + i * 60}ms"><span class="d"></span><b>${s.tool}</b><small>${s.group}</small></div>`).join('');
  const nodes = [...strip.querySelectorAll('.node')], rail = strip.querySelector('.rail i');
  setActive = (k) => {
    nodes.forEach((n, i) => { n.classList.toggle('on', i === k); n.classList.toggle('past', i < k); });
    rail.style.width = `${(k / (nodes.length - 1)) * 100}%`;
  };
  setActive(1);
});

// 5. 3D hero board
let unmountHero = null;
// skip the 3D hero entirely when the intro is bypassed (?scene=… or ?autoplay) so scenes load instantly
const qs = new URLSearchParams(location.search);
if (!qs.has('scene') && !qs.has('autoplay')) {
  try { unmountHero = mountHero(document.getElementById('hero-3d')); } catch (e) { console.warn('[intro] 3D hero unavailable', e); }
}
new MutationObserver(() => {
  if (intro.classList.contains('gone') && unmountHero) {
    setTimeout(() => { unmountHero?.(); unmountHero = null; clearInterval(rotTimer); }, 700);
  }
}).observe(intro, { attributes: true, attributeFilter: ['class'] });
