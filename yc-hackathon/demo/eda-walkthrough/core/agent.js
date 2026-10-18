// Session H (thesis) owns this file.
// Agent lane: a 48px strip under the top bar showing the MCP tool call that drives each scene.
// Data: data/agent-calls.json. Listens to the shell's `wt:scene` window event; never touches scenes.
const SPEEDS = [1, 1.5, 2, 0.5];
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const speed = () => SPEEDS[window.__walkthrough?.speedIdx || 0];
const fmtT = (c) => (c.est ? '~' : '') + fmtS(c.ms || 0);
const fmtS = (ms) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;

let DATA = null, gen = 0, specShown = false;
const done = [];          // calls completed so far: {tool, status, ms, color, scene}
const lane = document.createElement('div');
lane.id = 'agent-lane';
lane.innerHTML = `
  <div class="ag-id" title="An AI agent drives every tool through MCP tool calls">
    <span class="ag-dot"></span>
    <div><b>Agent</b><small>MCP · <span class="ag-host">eda-tools</span></small></div>
  </div>
  <div class="ag-main">
    <div class="ag-call"><span class="ag-code"></span><span class="ag-pill"></span></div>
    <div class="ag-why"></div>
  </div>
  <div class="ag-trail" title="Every MCP call so far"></div>
  <div class="ag-stats">
    <div><b class="ag-n-calls">0</b><small>calls</small></div>
    <div><b class="ag-n-iter">0</b><small>fix loops</small></div>
    <div><b class="ag-n-time">0 s</b><small>tool time</small></div>
  </div>
  <button class="ag-log-btn" title="Show the agent's call log">Log</button>
  <div class="ag-log" hidden><div class="ag-log-h">MCP call log</div><ol></ol></div>`;

function mount() {
  document.body.appendChild(lane);
  document.body.classList.add('has-agent');
  lane.querySelector('.ag-log-btn').onclick = (e) => { e.stopPropagation(); toggleLog(); };
  document.addEventListener('click', (e) => { if (!lane.contains(e.target)) toggleLog(false); });
}
function toggleLog(force) {
  const log = $('.ag-log', lane);
  const open = force ?? log.hidden;
  log.hidden = !open;
  lane.classList.toggle('log-open', open);
  if (open) renderLog();
}

// ---- caption sync: a call can wait until the scene's caption matches a regex ----
const captionWaiters = new Set();
function watchCaption() {
  const c = $('#caption-text'); if (!c) return;
  new MutationObserver(() => {
    const t = c.textContent;
    for (const w of [...captionWaiters]) if (w.re.test(t)) { captionWaiters.delete(w); w.res(true); }
  }).observe(c, { childList: true, characterData: true, subtree: true });
}
function waitCaption(re, timeout, g) {
  const c = $('#caption-text');
  if (c && re.test(c.textContent)) return Promise.resolve(true);
  return new Promise(res => {
    const w = { re, res };
    captionWaiters.add(w);
    setTimeout(() => { if (captionWaiters.delete(w)) res(false); }, timeout / speed());
    const iv = setInterval(() => { if (g !== gen) { clearInterval(iv); captionWaiters.delete(w); res(false); } }, 200);
  });
}
const sleep = (ms, g) => new Promise((res, rej) => setTimeout(() => (g === gen ? res() : rej('stale')), ms / speed()));

// ---- rendering ----
function fmtArgs(args) {
  // compact JS-ish object literal, syntax-colored
  const v = (x) => Array.isArray(x) ? `[${x.map(v).join(', ')}]`
    : typeof x === 'string' ? `<i class="s">"${esc(x)}"</i>`
    : typeof x === 'object' && x ? `{ ${Object.entries(x).map(([k, y]) => `<i class="k">${esc(k)}</i>: ${v(y)}`).join(', ')} }`
    : `<i class="n">${esc(x)}</i>`;
  return v(args || {});
}
function setCall(call, color) {
  lane.style.setProperty('--ag', color);
  $('.ag-code', lane).innerHTML = `<span class="fn">${esc(call.tool)}</span>(${fmtArgs(call.args)})` +
    (call.tag ? ` <span class="ag-tag">${esc(call.tag)}</span>` : '');
  const code = $('.ag-code', lane);
  code.classList.remove('in'); void code.offsetWidth; code.classList.add('in');
}
function setPill(kind, html) {
  const p = $('.ag-pill', lane);
  p.className = `ag-pill ${kind}`;
  p.innerHTML = html;
}
function setWhy(text) {
  const w = $('.ag-why', lane);
  w.classList.remove('in'); void w.offsetWidth;
  w.innerHTML = text ? `<span class="arrow">↳</span>${esc(text)}` : '';
  w.classList.add('in');
}
function renderStats() {
  const ms = done.reduce((a, c) => a + (c.ms || 0), 0);
  window.__agent = { calls: done.length, fixLoops: done.filter(c => c.status === 'fail').length, toolMs: ms, log: done.slice() };
  window.dispatchEvent(new CustomEvent('wt:agent', { detail: window.__agent }));
  $('.ag-n-calls', lane).textContent = done.length;
  $('.ag-n-iter', lane).textContent = done.filter(c => c.status === 'fail').length;
  $('.ag-n-time', lane).textContent = fmtS(ms);
  $('.ag-trail', lane).innerHTML = done.map(c =>
    `<i class="${c.status}" style="--c:${c.color}" title="${esc(c.tool)} · ${fmtT(c)}"></i>`).join('');
}
function renderLog() {
  $('.ag-log ol', lane).innerHTML = done.map((c, i) => `
    <li class="${c.status}" style="--c:${c.color}">
      <span class="i">${String(i + 1).padStart(2, '0')}</span>
      <span class="t">${esc(c.tool)}</span>
      <span class="r">${esc(c.result)}</span>
      <span class="ms">${fmtT(c)}</span>
    </li>`).join('') || '<li class="empty">No calls yet</li>';
}

// ---- playback ----
function callsFor(id) { return DATA?.scenes?.[id]?.calls || []; }
function colorOf(id) { return (window.__walkthrough?.scenes || []).find(s => s.id === id)?.color || '#2563eb'; }

function rebuildDone(index) {
  // deterministic counters when the viewer jumps around: everything before this scene is "done"
  done.length = 0;
  (window.__walkthrough?.scenes || []).slice(0, index).forEach(s =>
    callsFor(s.id).forEach(c => done.push({ ...c, ms: c.ms, color: colorOf(s.id), scene: s.id })));
  renderStats();
}

// Scene-event gates: a result is revealed only when the scene gets there.
let sceneIndex = -1, played = false, metricSeq = 0;
addEventListener('wt:played', (e) => { if (e.detail?.index === sceneIndex) played = true; });
addEventListener('wt:metric', () => { metricSeq++; });
function waitScene(g, { caption, metric } = {}) {
  const seq0 = metricSeq;
  const re = caption ? new RegExp(caption, 'i') : null;
  return new Promise(res => {
    const iv = setInterval(() => {
      const t = $('#caption-text')?.textContent || '';
      if (g !== gen || played || (re && re.test(t)) || (metric && metricSeq > seq0)) { clearInterval(iv); res(); }
    }, 100);
  });
}

async function runCall(call, color, g, scene, next) {
  if (call.startOn) await waitScene(g, { caption: call.startOn });
  if (g !== gen) throw 'stale';
  setCall(call, color);
  setPill('req', 'request');
  if (call.reason_before) setWhy(call.reason_before);
  await sleep(380, g);
  lane.classList.add('running');
  const t0 = performance.now();
  const shown = Math.min(Math.max(call.ms || 300, 350), 1600);  // animate the real time, compressed
  setPill('run', `<span class="spin"></span>running <b class="clock">0 ms</b>`);
  const clock = $('.ag-pill .clock', lane);
  await new Promise((res, rej) => {
    const tick = () => {
      if (g !== gen) return rej('stale');
      const k = Math.min(1, (performance.now() - t0) * speed() / shown);
      clock.textContent = fmtS((call.ms || 0) * k);
      k < 1 ? requestAnimationFrame(tick) : res();
    };
    tick();
  });
  // reveal gate: own caption cue, else the next call's start cue, else the scene's first metric; wt:played always ends it
  if (call.waitFor) await waitScene(g, { caption: call.waitFor });
  else if (next?.startOn) await waitScene(g, { caption: next.startOn });
  else await waitScene(g, { metric: true });
  if (g !== gen) throw 'stale';
  lane.classList.remove('running');
  const ok = call.status !== 'fail';
  setPill(ok ? 'ok' : 'fail', `${ok ? '✓' : '✕'} ${esc(call.result)} <b>${fmtT(call)}</b>`);
  if (call.reason) setWhy(call.reason);
  done.push({ ...call, color, scene });
  renderStats();
  if (!$('.ag-log', lane).hidden) renderLog();
}

async function showSpec(g) {
  const s = DATA.spec; if (!s) return;
  const card = document.createElement('div');
  card.id = 'agent-spec';
  card.innerHTML = `
    <div class="sp-eyebrow"><span class="ag-dot"></span>Agent received a spec</div>
    <h3>${esc(s.title)}</h3>
    <p>${esc(s.text)}</p>
    <ul>${(s.constraints || []).map(c => `<li>${esc(c)}</li>`).join('')}</ul>
    <div class="sp-loop">${(DATA.loop || []).map((x, i) => `<span style="--d:${i * 90}ms">${esc(x)}</span>`).join('<em>→</em>')}</div>`;
  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add('in'));
  setWhy(s.reason || 'Reading the spec and planning the RTL');
  try { await sleep(DATA.specMs || 3600, g); } catch {}
  card.classList.remove('in'); card.classList.add('out');
  setTimeout(() => card.remove(), 600);
}

function showSummary() {
  const tools = new Set(done.map(c => c.tool));
  const ms = done.reduce((a, c) => a + (c.ms || 0), 0);
  const fails = done.filter(c => c.status === 'fail').length;
  lane.style.setProperty('--ag', '#16a34a');
  $('.ag-code', lane).innerHTML = `<span class="fn">shipped</span> <span class="sum">${done.length} MCP calls · ${tools.size} tools · ${fails} fail → fix loop${fails === 1 ? '' : 's'} · ${fmtS(ms)} total tool time</span>`;
  setPill('ok', '✓ all green');
  setWhy(DATA.summaryReason || 'Spec met: tests pass, timing closes, board routes clean. Handing back the bitstream and Gerbers.');
}

async function onScene(e) {
  if (!DATA) return;
  const { index, entry } = e.detail;
  const g = ++gen;
  sceneIndex = index; played = false;
  lane.classList.remove('running', 'idle');
  rebuildDone(index);
  const sc = DATA.scenes?.[entry.id];
  const color = entry.color || '#2563eb';
  try {
    if (index === 0 && !specShown && !new URLSearchParams(location.search).get('scene')) {
      specShown = true;
      await showSpec(g);
    }
    if (sc?.summary) { showSummary(); return; }
    const calls = sc?.calls || [];
    if (!calls.length) { setCall({ tool: 'idle', args: {} }, color); setPill('', ''); setWhy(''); return; }
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (!played) await sleep(Math.min(c.at ?? 250, 250), g);
      await runCall(c, color, g, entry.id, calls[i + 1]);
    }
    if (sc.after) { await sleep(900, g); setWhy(sc.after); }
  } catch (err) { if (err !== 'stale') console.error('[agent]', err); }
}

async function boot() {
  try {
    DATA = await fetch(`data/agent-calls.json?v=${Date.now()}`).then(r => r.json());
  } catch (err) { console.warn('[agent] no data/agent-calls.json', err); return; }
  mount();
  if (DATA.host) $('.ag-host', lane).textContent = DATA.host;
  watchCaption();
  setCall({ tool: 'connect', args: { server: DATA.server || 'eda-tools' } }, '#2563eb');
  setPill('ok', `✓ ${DATA.toolCount || 0} tools`);
  setWhy('Connected over MCP (ManuDesk check + proposed eda-tools). Waiting for a spec.');
  addEventListener('wt:scene', onScene);
  // If the shell already started before this module loaded, catch up.
  const st = window.__walkthrough;
  if (st && st.index >= 0) onScene({ detail: { index: st.index, entry: st.scenes[st.index] } });
}
boot();
