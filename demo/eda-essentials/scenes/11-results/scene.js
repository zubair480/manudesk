// 11-results (essentials copy): LIVE ManuDesk MCP results from InsForge. Read-only.
// - leaderboard: public edge function md-leaderboard, polled every 3 s (no key needed)
// - live feed: realtime channel `md-checks`, event `check_added` (trigger md_rt_checks) (same as manudesk/web), anon key from
//   config.local.json (untracked). Falls back to the snapshot in data/insforge-results.json if offline.
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const hhmmss = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const POLL_MS = 3000;
let stop = () => {};

export default {
  id: '11-results', tool: 'Results', title: 'Live: the agent loop on InsForge', css: true,
  async mount(root, ctx) {
    const snap = await ctx.data('insforge-results');
    this.snap = snap;
    root.innerHTML = `
      <div class="ir">
        <div class="ir-head">
          <div class="eyebrow"><span class="live"></span><span class="status">Connecting to InsForge…</span></div>
          <h1>Agents calling real EDA tools over MCP: <span class="hx">up to ${Math.max(...snap.designs.map(x => x.x)).toFixed(2)}× faster hardware.</span></h1>
        </div>
        <div class="ir-kpis">
          <div class="k"><b class="n-checks">${snap.totals.checks}</b><small>MCP <code>check</code> calls</small></div>
          <div class="k"><b class="n-new">0</b><small>new since this page opened</small></div>
          <div class="k bad"><b class="n-fail">${snap.totals.checks_failed}</b><small>failures caught by real tools</small></div>
          <div class="k"><b class="n-reached">–</b><small>designs past target</small></div>
          <div class="k"><b class="n-med">–</b><small>median full check (lint → sim → synth → P&amp;R)</small></div>
        </div>
        <div class="ir-body">
          <section class="ir-designs">
            <div class="ir-h"><span>Fmax per design · baseline → best agent result · dashed = target</span><span class="lb-ts"></span></div>
            <div class="rows"></div>
          </section>
          <section class="ir-loop">
            <div class="ir-h"><span>Live MCP <code>check</code> feed</span><span class="feed-mode"></span></div>
            <ol class="feed"></ol>
            <p class="src">InsForge yc-hackathon · md-leaderboard + realtime md-checks · read-only</p>
          </section>
        </div>
      </div>`;
    this.root = root;
    this.durations = [];
    this.renderRows(snap.designs.map(x => ({ design: x.name, summary: x.summary, baseline_mhz: x.baseline, target_mhz: x.target,
      best_mhz: x.best ?? x.baseline, x: x.x, who: x.via, reached: x.best ? x.best >= x.target : false })));
    snap.loop.slice().reverse().forEach(c => this.addFeed({ ...c, created_at: null, at: c.at, duration_ms: c.ms }, false));
    this.connect();
  },

  renderRows(rows) {
    const sig = JSON.stringify(rows.map(r => [r.design, r.best_mhz, r.baseline_mhz, r.target_mhz]));
    if (sig === this.sig) return;                 // only redraw when the leaderboard actually changes
    const changed = this.sig != null; this.sig = sig;
    const sum = Object.fromEntries((this.snap?.designs || []).map(x => [x.name, x.summary]));
    rows = rows.slice().sort((a, b) => (b.x || 1) - (a.x || 1));
    const max = Math.max(...rows.map(r => Math.max(r.best_mhz || 0, r.target_mhz || 0))) * 1.04;
    const box = this.root.querySelector('.ir-designs .rows');
    if (changed) box.classList.add('pulse'), setTimeout(() => box.classList.remove('pulse'), 1500);
    box.innerHTML = rows.map((r, i) => {
      const improved = r.best_mhz > r.baseline_mhz + 0.05;
      return `<div class="row" style="--i:${i}">
        <div class="nm"><b>${esc(r.design)}</b><small>${esc(r.summary || sum[r.design] || '')}</small></div>
        <div class="bar">
          <i class="base" style="--w:${(r.baseline_mhz / max) * 100}%"></i>
          ${improved ? `<i class="best" style="--w:${(r.best_mhz / max) * 100}%"></i>` : ''}
          <i class="tgt" style="left:${(r.target_mhz / max) * 100}%"></i>
        </div>
        <div class="val">${improved
          ? `<b>${r.best_mhz.toFixed(1)}</b> MHz <em>${(r.x || r.best_mhz / r.baseline_mhz).toFixed(2)}×</em><small>from ${r.baseline_mhz} · by ${esc(r.who)}${r.reached ? ' · target ✓' : ''}</small>`
          : `<span>${r.baseline_mhz} MHz</span><small>baseline · target ${r.target_mhz}</small>`}</div>
      </div>`;
    }).join('');
    const reached = rows.filter(r => r.reached).length;
    this.root.querySelector('.n-reached').textContent = `${reached}/${rows.length}`;
    const bestX = Math.max(...rows.map(r => r.x || 1));
    this.root.querySelector('.hx').textContent = `up to ${bestX.toFixed(2)}× faster hardware.`;
  },

  addFeed(c, fresh = true) {
    const ol = this.root.querySelector('.feed');
    const li = document.createElement('li');
    li.className = (c.pass ? 'ok' : 'fail') + (fresh ? ' fresh' : '');
    const when = c.created_at ? hhmmss(c.created_at) : c.at;
    li.innerHTML = `<span class="t">${esc(when)}</span><span class="d">${esc(c.design)}</span>
      <span class="s">${c.pass ? `✓ ${Number(c.mhz).toFixed(1)} MHz` : `✕ ${esc(c.stage)} FAIL`}</span>
      <span class="ms">${fmtMs(c.duration_ms)}</span>`;
    ol.prepend(li);
    while (ol.children.length > 9) ol.lastElementChild.remove();
    if (c.duration_ms > 1000) {
      this.durations.push(c.duration_ms);
      const s = this.durations.slice().sort((a, b) => a - b);
      this.root.querySelector('.n-med').textContent = fmtMs(s[Math.floor(s.length / 2)]);
    }
  },

  setStatus(text, mode) {
    this.root.querySelector('.status').textContent = text;
    this.root.querySelector('.ir-head .live').className = `live ${mode}`;
  },

  async connect() {
    let stopped = false, timer = 0, sub = null, client = null, newCount = 0;
    const seen = new Set();
    stop = () => { stopped = true; clearTimeout(timer); try { sub?.(); } catch {} };

    // 1) leaderboard: public function, polled
    const cfg = await fetch('config.local.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
    const base = cfg?.baseUrl || 'https://nden3esm.us-west.insforge.app';
    const poll = async () => {
      try {
        const r = await fetch(`${base}/functions/md-leaderboard`, { cache: 'no-store' }).then(r => r.json());
        if (stopped) return;
        if (r.ok) {
          this.renderRows(r.designs);
          this.root.querySelector('.lb-ts').textContent = `updated ${hhmmss(new Date().toISOString())}`;
          if (!sub) this.setStatus('Live · InsForge leaderboard (polling every 3 s)', 'on');
        }
      } catch { if (!stopped && !sub) this.setStatus('Offline · showing the InsForge snapshot', 'off'); }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    poll();

    // 2) live feed: realtime md_checks (anon key from config.local.json)
    if (!cfg?.anonKey) { this.root.querySelector('.feed-mode').textContent = 'snapshot (no key)'; return; }
    try {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@insforge/sdk@1.5.2/+esm');
      client = createClient({ baseUrl: base, anonKey: cfg.anonKey });
      const res = await Promise.race([client.realtime.subscribe('md-checks'), new Promise(r => setTimeout(() => r(null), 8000))]);
      if (stopped) return;
      if (res && res.ok) {
        const onMsg = (msg) => {
          const { meta, ...row } = msg || {};
          if (meta?.channel && meta.channel.replace(/^realtime:/, '') !== 'md-checks') return;
          if (!row.id || seen.has(row.id)) return;
          seen.add(row.id);
          this.addFeed(row, true);
          this.root.querySelector('.n-new').textContent = ++newCount;
          const n = this.root.querySelector('.n-checks'); n.textContent = Number(n.textContent) + 1;
          if (!row.pass) { const f = this.root.querySelector('.n-fail'); f.textContent = Number(f.textContent) + 1; }
        };
        client.realtime.on('check_added', onMsg);
        sub = () => { client.realtime.off('check_added', onMsg); client.realtime.unsubscribe('md-checks'); };
        this.root.querySelector('.feed-mode').innerHTML = '<i class="dot"></i>realtime';
        this.setStatus('Live · InsForge realtime · ManuDesk MCP check', 'on');
      } else {
        this.root.querySelector('.feed-mode').textContent = 'snapshot (realtime unavailable)';
      }
    } catch (e) {
      console.warn('[results] realtime unavailable', e);
      this.root.querySelector('.feed-mode').textContent = 'snapshot (realtime unavailable)';
    }
  },

  async play(ctx) {
    ctx.visual?.();
    const root = this.root;
    root.querySelector('.ir').classList.add('go');
    ctx.narrate('Live from InsForge: every check an agent runs through the ManuDesk MCP lands here.');
    await ctx.sleep(2200);
    ctx.narrate('One MCP call runs lint, simulation, synthesis and place-and-route, and returns a verdict in seconds.');
    ctx.focus?.(root.querySelector('.ir-designs'), { scale: 1.2, ms: 800, pad: 20 });
    await ctx.sleep(3200);
    ctx.unfocus?.({ ms: 700 });
    ctx.narrate('Failures are caught by real tools, and the agent fixes them on the next call.');
    ctx.focus?.(root.querySelector('.ir-loop'), { scale: 1.3, ms: 800, pad: 20 });
    await ctx.sleep(3200);
    ctx.unfocus?.({ ms: 700 });
    ctx.narrate('Spec → HDL → real tools over MCP → results → fix → ship. Live.');
    await ctx.sleep(2500);
  },
  unmount() { stop(); },
};
