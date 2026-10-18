// Silicon Walkthrough shell: stepper, playback, transitions, and the scene API (see COORDINATION.md).
const $ = (s, r = document) => r.querySelector(s);
const params = new URLSearchParams(location.search);
const single = params.get('scene');          // ?scene=<id> plays just that scene (dev mode)
const SPEEDS = [1.25, 1.5, 2, 1];

const state = {
  scenes: [], index: -1, playing: false, speedIdx: 0,
  current: null, abort: null, metrics: loadMetrics(),
};
window.__walkthrough = state; // debugging aid

function loadMetrics() {
  try { return JSON.parse(sessionStorage.getItem('wt-metrics') || '{}'); } catch { return {}; }
}
function saveMetrics() {
  try { sessionStorage.setItem('wt-metrics', JSON.stringify(state.metrics)); } catch {}
}

// Pacing: text (typing, log streaming, intro waits) is skimmed fast; figures play at normal speed.
// Every scene starts in skim mode; ctx.visual() switches to normal speed when the figures begin.
const SKIM = 6;   // text-phase speed multiplier
const TYPE_CPS = 900; // typeInto floor speed, characters per second

function makeCtx(scene, signal) {
  let skim = true;
  const speed = () => SPEEDS[state.speedIdx] * (skim ? SKIM : 1);
  const sleep = (ms) => new Promise((res, rej) => {
    if (signal.aborted) return rej(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(res, ms / speed());
    signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
  return {
    get speed() { return speed(); },
    signal,
    sleep,
    // Camera: smoothly zoom the whole scene onto an element (or a {x,y,w,h} rect in scene px), then back.
    // ctx.focus(el, { scale: 1.7, ms: 900 }); ... ctx.unfocus();
    // USER: no zooming on 2D scenes. focus() is a no-op unless a scene passes { essential: true }
    // for a moment that truly needs it. 3D scenes move their own three.js cameras instead.
    focus(target, { scale, ms = 900, pad = 40, essential = false } = {}) {
      if (!essential) return;
      const root = document.querySelector(`#stage .scene[data-scene="${scene.id}"]`);
      if (!root || !target) return;
      const cam = root._cam || (root._cam = { s: 1, tx: 0, ty: 0 });
      const W = root.clientWidth, H = root.clientHeight, base = root.getBoundingClientRect();
      let r;
      if (target instanceof Element) {
        const b = target.getBoundingClientRect(); // includes the current camera transform; undo it
        r = { x: (b.left - base.left) / cam.s, y: (b.top - base.top) / cam.s, w: b.width / cam.s, h: b.height / cam.s };
        // base already includes tx/ty because the transform is on root itself
      } else r = target;
      const s = scale || Math.min(2.4, Math.max(1.15, Math.min(W / (r.w + pad * 2), H / (r.h + pad * 2))));
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const tx = Math.min(0, Math.max(W - W * s, W / 2 - cx * s));
      const ty = Math.min(0, Math.max(H - H * s, H / 2 - cy * s));
      Object.assign(cam, { s, tx, ty });
      root.style.transformOrigin = '0 0';
      root.style.transition = `transform ${ms / SPEEDS[state.speedIdx]}ms cubic-bezier(.65,0,.35,1)`;
      root.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    },
    unfocus({ ms = 800 } = {}) {
      const root = document.querySelector(`#stage .scene[data-scene="${scene.id}"]`);
      if (!root) return;
      root._cam = { s: 1, tx: 0, ty: 0 };
      root.style.transition = `transform ${ms / SPEEDS[state.speedIdx]}ms cubic-bezier(.65,0,.35,1)`;
      root.style.transform = 'translate(0px, 0px) scale(1)';
    },
    skim() { skim = true; },      // text phase: everything ×4
    visual() { skim = false; },   // figures/hardware phase: normal speed
    get skimming() { return skim; },
    data: (name) => fetch(`data/${name}.json`).then(r => { if (!r.ok) throw new Error(`data/${name}.json ${r.status}`); return r.json(); }),
    text: (path) => fetch(path).then(r => { if (!r.ok) throw new Error(`${path} ${r.status}`); return r.text(); }),
    async typeInto(el, text, cps = 60) {
      // typing is always fast: write in chunks per frame instead of one char per timer tick
      const rate = Math.max(cps * SKIM, TYPE_CPS) * SPEEDS[state.speedIdx];
      let i = 0, last = performance.now();
      while (i < text.length) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        await new Promise(r => requestAnimationFrame(r));
        const now = performance.now();
        const n = Math.max(1, Math.round(((now - last) / 1000) * rate));
        el.textContent += text.slice(i, i + n); i += n; last = now;
      }
    },
    narrate(text) {
      const c = $('#caption-text'); c.style.opacity = 0;
      setTimeout(() => { c.textContent = text; c.style.opacity = 1; }, 180);
    },
    emit(type, payload) {
      if (type === 'metric' && payload?.key) {
        state.metrics[payload.key] = { ...payload, scene: scene.id };
        saveMetrics();
      }
      window.dispatchEvent(new CustomEvent('wt:' + type, { detail: payload }));
    },
    get metrics() { return state.metrics; },
  };
}

function renderStepper() {
  const nav = $('#stepper'); nav.innerHTML = '';
  state.scenes.forEach((s, i) => {
    if (i) nav.appendChild(Object.assign(document.createElement('span'), { className: 'step-sep' }));
    const b = document.createElement('button');
    b.className = 'step' + (i === state.index ? ' active' : i < state.index ? ' done' : '');
    b.style.setProperty('--tool', s.color || 'var(--accent)');
    b.innerHTML = `<span class="n">${i < state.index ? '✓' : i + 1}</span>${s.tool}`;
    b.onclick = () => go(i, true);
    nav.appendChild(b);
  });
  nav.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  $('#progress i').style.width = `${((state.index + 1) / state.scenes.length) * 100}%`;
}

async function loadModule(entry) {
  try {
    const mod = await import(`../scenes/${entry.id}/scene.js?v=${Date.now()}`);
    const scene = mod.default;
    if (scene.css) {
      // always load the scene's current CSS (cache-busted) so new JS never runs against stale styles
      document.querySelectorAll(`link[data-scene-css="${entry.id}"]`).forEach(l => l.remove());
      const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `scenes/${entry.id}/scene.css?v=${Date.now()}` });
      l.dataset.sceneCss = entry.id;
      document.head.appendChild(l);
      await new Promise(r => { l.onload = l.onerror = r; });
    }
    return scene;
  } catch (err) {
    console.warn(`[walkthrough] scene ${entry.id} not ready:`, err.message);
    return pendingScene(entry);
  }
}

function pendingScene(entry) {
  return {
    id: entry.id, tool: entry.tool, title: `${entry.tool}: being built`,
    mount(root) {
      root.innerHTML = `<div class="scene-pending"><div class="card glass"><div class="spinner"></div>
        <div class="eyebrow">${entry.group}</div><h2>${entry.tool}</h2>
        <p>This scene is still being built by its session. It will appear here automatically on reload.</p></div></div>`;
    },
    async play(ctx) { ctx.narrate(`${entry.tool}: scene in progress`); await ctx.sleep(2500); },
    unmount() {},
  };
}

async function go(i, userInitiated = false) {
  if (i < 0 || i >= state.scenes.length) return;
  state.abort?.abort();
  try { state.current?.unmount?.(); } catch (e) { console.error(e); }
  const stage = $('#stage');
  const old = stage.querySelector('.scene');
  if (old) { old.classList.remove('in'); old.classList.add('out'); setTimeout(() => old.remove(), 550); }

  state.index = i; renderStepper();
  const entry = state.scenes[i];
  document.getElementById('caption-text').textContent = entry.tool;
  window.dispatchEvent(new CustomEvent('wt:scene', { detail: { index: i, entry, prev: state.scenes[i - 1] || null, next: state.scenes[i + 1] || null } }));
  const scene = await loadModule(entry);
  if (state.index !== i) return; // user navigated away while loading
  const root = document.createElement('section');
  root.className = 'scene'; root.dataset.scene = entry.id;
  root.style.setProperty('--tool', entry.color || 'var(--accent)');
  document.documentElement.style.setProperty('--tool', entry.color || 'var(--accent)');
  stage.appendChild(root);
  const ac = new AbortController(); state.abort = ac;
  const ctx = makeCtx(scene, ac.signal);
  state.current = scene;
  try { await scene.mount(root, ctx); } catch (e) { console.error(`[walkthrough] mount ${entry.id}`, e); }
  requestAnimationFrame(() => root.classList.add('in'));
  if (scene.title) ctx.narrate(scene.title);
  if (state.playing || userInitiated) runScene(scene, ctx, ac, i);
}

async function runScene(scene, ctx, ac, i) {
  if (!state.playing) setPlaying(true);
  try {
    await ctx.sleep(250);
    await scene.play(ctx);
    window.dispatchEvent(new CustomEvent('wt:played', { detail: { index: i } }));
    await ctx.sleep(900);
    if (!ac.signal.aborted && state.playing && !single && i + 1 < state.scenes.length) go(i + 1);
    else if (!ac.signal.aborted && (single || i + 1 >= state.scenes.length)) setPlaying(false);
  } catch (e) {
    if (e.name !== 'AbortError') console.error(`[walkthrough] play ${scene.id}`, e);
  }
}

function setPlaying(p) { state.playing = p; $('#play').textContent = p ? '❚❚' : '▶'; }

function togglePlay() {
  if (state.index < 0) return start();
  if (state.playing) { setPlaying(false); state.abort?.abort(); }
  else go(state.index, true); // restart the current scene
}

function start() {
  $('#intro').classList.add('gone');
  state.metrics = {}; saveMetrics();
  setPlaying(true);
  go(0, true);
}

async function boot() {
  const list = await fetch('scenes.json').then(r => r.json());
  state.scenes = single ? list.filter(s => s.id === single) : list;
  // ?scene=<id> works for scenes not yet listed in scenes.json (previews of new builds)
  if (single && !state.scenes.length) state.scenes = [{ id: single, tool: single.replace(/^\d+-/, ''), group: 'Preview', color: '#2563eb' }];
  renderStepper();
  $('#start').onclick = start;
  $('#play').onclick = togglePlay;
  $('#prev').onclick = () => go(state.index - 1, true);
  $('#next').onclick = () => go(state.index + 1, true);
  $('#speed').onclick = () => { state.speedIdx = (state.speedIdx + 1) % SPEEDS.length; $('#speed').textContent = SPEEDS[state.speedIdx] + '×'; };
  addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowRight') go(state.index + 1, true);
    if (e.key === 'ArrowLeft') go(state.index - 1, true);
  });
  if (single || params.has('autoplay')) { $('#intro').classList.add('gone'); setPlaying(true); go(0, true); }
}
boot();
