// Session G (UX) owns this file: cross-scene story strip, carry-over metrics, next-scene teasers.
// Listens to the shell's window events only ('wt:scene', 'wt:metric', optional 'wt:played'); never touches scene DOM.
//   1. Chapter card: at each scene start, "Step N of 10" + the tool + the hook question + what the last step proved.
//   2. Footer step chip + "story so far" rail: one chip per finished step, carrying its headline result.
//   3. Next-up teaser: when a scene finishes (wt:played), a card with the next step's question and a countdown bar.
// Disable with ?story=0.

const params = new URLSearchParams(location.search);
const ENABLED = params.get('story') !== '0';
const SPEEDS = [1.25, 1.5, 2, 1]; // mirrors core.js
const W = () => window.__walkthrough || { scenes: [], index: -1, metrics: {}, speedIdx: 0 };
const spd = () => SPEEDS[W().speedIdx || 0] || 1;
const m = (k) => W().metrics?.[k]?.value;
const n = (v, d = 0) => (v == null || v === '' || isNaN(+v) ? null : (+v).toLocaleString('en-US', { maximumFractionDigits: d }));

// One entry per scene: the viewer's question going in, and the headline result coming out.
// Results read live metrics first and fall back to the real captured values (for ?scene= dev mode).
const STORY = {
  '01-code': {
    stage: 'Design', q: '40 lines of text. Can they become a glowing circuit board?',
    win: () => `${n(m('rtl-lines')) ?? 40} lines of Verilog`,
  },
  '02-iverilog': {
    stage: 'Simulate', q: 'Does the circuit actually behave? Run it.',
    win: () => `${m('tests') ?? '4/4'} tests pass (run 1 failed)`,
  },
  '03-verilator': {
    stage: 'Lint', q: 'The tests pass. Is anything hiding in the code?',
    win: () => `${n(m('lint-warnings')) ?? 0} lint warnings`,
  },
  '04-gtkwave': {
    stage: 'Inspect', q: 'What did the circuit really do, clock by clock?',
    win: () => `${n(m('wave_transitions')) ?? '12,899'} transitions seen`,
  },
  '05-cocotb': {
    stage: 'Verify', q: 'Can Python test the same hardware?',
    win: () => `${m('cocotb_passed') ?? 4}/4 Python tests pass`,
  },
  '06-yosys': {
    stage: 'Synthesize', q: 'Code is just text. What does it become as logic?',
    win: () => `${n(m('cells')) ?? 150} real ECP5 cells`,
  },
  '07-nextpnr': {
    stage: 'Place & route', q: 'Will it fit on the chip, and run fast enough?',
    win: () => { const f = +(m('fmax') ?? 214.96); return `${n(f, 0)} MHz: ${(f / 25).toFixed(1)}× the 25 MHz needed`; },
  },
  '08-symbiyosys': {
    stage: 'Prove', q: 'Tests try some inputs. Can we prove it for all of them?',
    win: () => { const p = m('props_proved') ?? 5; return `${p}/${p} properties proved`; },
  },
  '09-kicad': {
    stage: 'Board', q: 'A chip needs a body. Can we build the board?',
    win: () => `Board laid out, ${n(m('pcb_drc_errors')) ?? 0} rule violations`, // Freerouting's check; KiCad DRC never ran
  },
  '10-freerouting': {
    stage: 'Route', q: '58 connections to wire. By hand, or by machine?',
    win: () => `${n(m('pcb_unrouted')) ?? 0} unrouted, in ${m('pcb_route_time') ?? 9.4} s`,
  },
  '11-results': {
    stage: 'Ship', q: 'From 40 lines of code to a routed board. The scorecard:',
    win: () => 'Ready to fabricate',
  },
};
STORY['07-nextpnr-3d'] = STORY['07-nextpnr'];

let order = [];                       // full scene order (from scenes.json), so ?scene= still numbers steps right
const done = new Map();               // id -> {tool, color, text}
let cur = null, cardTimer = 0, teaserShownFor = null;

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toolSteps = () => order.filter(s => s.id !== '11-results');
const stepOf = (id) => { const i = toolSteps().findIndex(s => s.id === id); return i < 0 ? null : i + 1; };
const entryOf = (id) => order.find(s => s.id === id) || W().scenes.find(s => s.id === id);

// ---------- DOM ----------
let chip, rail, card, teaser;
function build() {
  const cap = document.getElementById('caption');
  const text = document.getElementById('caption-text');
  chip = el('span', 'st-chip'); chip.hidden = true;
  cap.insertBefore(chip, text);
  rail = el('div', 'st-rail'); rail.setAttribute('aria-label', 'Story so far');
  cap.insertBefore(rail, document.getElementById('progress'));
  card = el('div', 'st-card'); card.setAttribute('aria-live', 'polite');
  teaser = el('div', 'st-teaser');
  const stage = document.getElementById('stage');
  stage.after(card); stage.after(teaser);
}

function renderChip(entry) {
  const step = stepOf(entry.id), total = toolSteps().length;
  chip.style.setProperty('--c', entry.color || 'var(--accent)');
  chip.innerHTML = step ? `<b>${step}</b><i>/${total}</i>${esc(STORY[entry.id]?.stage || entry.group || '')}` : `<b>✓</b>${esc(STORY[entry.id]?.stage || 'Finale')}`;
  chip.hidden = false;
}

function renderRail(fresh) {
  rail.innerHTML = '';
  const items = [...done.entries()];
  const shown = items.slice(-4);
  if (items.length > shown.length) rail.appendChild(el('span', 'st-more', `+${items.length - shown.length}`));
  for (const [id, d] of shown) {
    const c = el('span', 'st-done' + (id === fresh ? ' fresh' : ''), `<i></i><em>${esc(d.tool)}</em>${esc(d.text)}`);
    c.style.setProperty('--c', d.color);
    c.title = `${d.tool}: ${d.text}`;
    rail.appendChild(c);
  }
}

function showCard(entry, prevId) {
  const s = STORY[entry.id]; if (!s) return;
  const step = stepOf(entry.id), total = toolSteps().length;
  const prev = prevId && done.get(prevId);
  card.style.setProperty('--c', entry.color || 'var(--accent)');
  card.innerHTML = `
    <div class="st-card-in">
      <div class="st-eyebrow">${step ? `Step ${step} of ${total}` : 'Finale'} · ${esc(s.stage)}</div>
      <div class="st-tool">${esc(entry.tool)}</div>
      <div class="st-q">${esc(s.q)}</div>
      ${prev ? `<div class="st-prev"><span>✓</span>${esc(prev.tool)}: ${esc(prev.text)}</div>` : ''}
      <div class="st-dots">${toolSteps().map(t => `<i class="${done.has(t.id) ? 'd' : ''}${t.id === entry.id ? ' a' : ''}" style="--c:${t.color}"></i>`).join('')}</div>
    </div>`;
  card.classList.remove('out'); card.classList.add('on');
  clearTimeout(cardTimer);
  // short when the teaser already introduced this step, longer on a cold start
  const hold = (teaserShownFor === entry.id ? 1500 : 2200) / spd();
  cardTimer = setTimeout(() => { card.classList.add('out'); card.classList.remove('on'); }, hold);
}

function showTeaser(nextEntry, finishedId) {
  const s = STORY[nextEntry.id]; if (!s) return;
  const step = stepOf(nextEntry.id);
  const d = done.get(finishedId);
  teaser.style.setProperty('--c', nextEntry.color || 'var(--accent)');
  teaser.style.setProperty('--dur', `${850 / spd()}ms`); // matches core.js's 900 ms post-scene gap
  teaser.innerHTML = `
    ${d ? `<div class="st-got" style="--c:${d.color}"><span>✓</span>${esc(d.text)}</div>` : ''}
    <div class="st-next"><div class="st-eyebrow">Next${step ? ` · step ${step}` : ''} · ${esc(nextEntry.tool)}</div><div class="st-q">${esc(s.q)}</div><div class="st-bar"><i></i></div></div>`;
  teaser.classList.remove('on'); void teaser.offsetWidth; teaser.classList.add('on');
  teaserShownFor = nextEntry.id;
}
function hideTeaser() { teaser.classList.remove('on'); }

function complete(id) {
  if (!id || done.has(id) || !STORY[id] || id === '11-results') return;
  const e = entryOf(id) || { tool: id, color: 'var(--accent)' };
  done.set(id, { tool: e.tool, color: e.color || 'var(--accent)', text: STORY[id].win() });
  renderRail(id);
}

// ---------- events ----------
function onScene(ev) {
  const { entry, index } = ev.detail;
  // Forward step: the scene we leave counts as done (its metrics were emitted by now).
  if (cur && cur.index < index) complete(cur.id);
  // Jumping backwards drops later chips so the rail always tells a true story.
  if (cur && index < cur.index) for (const id of [...done.keys()]) { const i = order.findIndex(s => s.id === id); const j = order.findIndex(s => s.id === entry.id); if (i >= j) done.delete(id); }
  const prevId = cur?.id;
  cur = { id: entry.id, index };
  hideTeaser();
  renderChip(entry); renderRail();
  // the finale's dashboard recaps everything; give its closing caption the full footer width
  rail.hidden = entry.id === '11-results';
  showCard(entry, prevId && index > 0 ? prevId : null);
  teaserShownFor = null;
}

function onMetric() {
  // Results arrive during a scene; refresh the text of chips already on the rail.
  if (!cur) return;
  for (const [id, d] of done) d.text = STORY[id].win();
}

function onPlayed(ev) {
  const i = ev.detail?.index ?? W().index;
  const entry = W().scenes[i]; if (!entry) return;
  complete(entry.id);
  const next = W().scenes[i + 1];
  if (next) showTeaser(next, entry.id);
}

async function boot() {
  if (!ENABLED) return;
  try { order = await fetch('scenes.json').then(r => r.json()); } catch { order = []; }
  build();
  addEventListener('wt:scene', onScene);
  addEventListener('wt:metric', onMetric);
  addEventListener('wt:played', onPlayed);
  // If the shell already started (e.g. ?scene= autoplay raced us), sync to it.
  const s = W(); if (s.index >= 0 && s.scenes[s.index]) onScene({ detail: { entry: s.scenes[s.index], index: s.index } });
}
boot();
