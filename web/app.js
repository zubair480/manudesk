// ManuDesk dashboard: plain browser JS, no build step. Reads go to InsForge with the public anon key or to the
// public edge functions, and live updates come over InsForge realtime; starting/driving a run sends the user's MANUDESK_TOKEN to md-run-start/md-run-step.
(() => {
  const C = window.MANUDESK;
  const $ = (id) => document.getElementById(id);
  const FN = (slug) => `${C.insforgeUrl}/functions/${slug}`;
  const ACTIVE = new Set(['queued', 'running']);

  const state = {
    designs: [], board: [], runs: [], selected: null, status: null,
    driving: false, driveBusy: false, timers: {},
  };

  // ------------------------------------------------------------------ helpers

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const token = () => $('f-token').value.trim();

  async function getJSON(url, opts = {}) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { ok: false, error: { message: text.slice(0, 200) } }; }
    return { status: res.status, body };
  }
  const records = (table, query) => getJSON(`${C.insforgeUrl}/api/database/records/${table}?${query}`, {
    headers: { Authorization: `Bearer ${C.anonKey}` },
  }).then((r) => (Array.isArray(r.body) ? r.body : []));

  function every(name, ms, fn) {
    clearInterval(state.timers[name]);
    state.timers[name] = ms ? setInterval(fn, ms) : null;
  }
  const soonTimers = {};
  const soon = (name, fn, ms = 250) => { clearTimeout(soonTimers[name]); soonTimers[name] = setTimeout(fn, ms); };

  // ------------------------------------------------------------------ InsForge realtime
  // Socket.IO straight to InsForge with the anon key. Triggers on md_runs / md_iterations / md_checks publish ids and
  // summary fields on md-runs, md-checks and md-run:<id>; we patch what we can in place and refetch the rest. While
  // the socket is up nothing polls; if it drops, slow polling takes over until it reconnects.

  const rt = { socket: null, live: false, run: null };

  function setLive(on, why) {
    rt.live = on;
    $('live-pill').className = `pill ${on ? 'ok' : 'warn'}`;
    $('live-text').textContent = on ? 'Live: InsForge realtime' : `Live: ${why || 'offline'}, polling`;
    schedulePolls();
  }

  function schedulePolls() {
    every('runs', rt.live ? 0 : 10000, loadRuns);
    every('board', rt.live ? 0 : 30000, loadBoard);
    const active = ACTIVE.has(state.status?.run?.status);
    every('status', rt.live ? 0 : active ? 5000 : 30000, loadStatus);
  }

  // delivered messages name their channel as "realtime:<channel>"
  const chan = (m) => String(m?.meta?.channel ?? '').replace(/^realtime:/, '');
  const rtSub = (channel) => new Promise((res) => rt.socket.emit('realtime:subscribe', { channel }, (r) => res(r)));

  function watchRun(id) {
    if (!rt.socket?.connected || rt.run === id) return;
    if (rt.run) rt.socket.emit('realtime:unsubscribe', { channel: `md-run:${rt.run}` });
    rt.run = id;
    if (id) rtSub(`md-run:${id}`);
  }

  function startRealtime() {
    if (typeof window.io !== 'function') { setLive(false, 'client not loaded'); return; }
    const s = window.io(C.insforgeUrl, { auth: { token: C.anonKey }, transports: ['websocket'], reconnectionDelayMax: 15000 });
    rt.socket = s;
    s.on('connect', async () => {
      rt.run = null;
      const acks = await Promise.all([rtSub('md-runs'), rtSub('md-checks')]);
      if (acks.some((a) => !a?.ok)) { setLive(false, acks.find((a) => !a?.ok)?.error?.message || 'subscribe failed'); return; }
      watchRun(state.selected);
      setLive(true);
      // catch up on anything that changed while we were offline
      loadRuns(); loadBoard(); loadStatus();
    });
    s.on('disconnect', (reason) => setLive(false, reason === 'io client disconnect' ? 'off' : 'reconnecting'));
    s.on('connect_error', () => setLive(false, 'unreachable'));
    s.on('realtime:error', (e) => console.warn('realtime', e?.channel, e?.code, e?.message));

    s.on('run_changed', (m) => {
      const i = state.runs.findIndex((r) => r.id === m.id);
      if (i >= 0) {
        const { meta, op, ...fields } = m;
        state.runs[i] = { ...state.runs[i], ...fields };
        renderRuns();
      } else if (chan(m) === 'md-runs') soon('runs', loadRuns);
      if (m.id === state.selected) soon('status', loadStatus);
      if (!ACTIVE.has(m.status)) soon('board', loadBoard, 500);
    });
    s.on('iteration_changed', (m) => { if (m.run_id === state.selected) soon('status', loadStatus); });
    s.on('check_added', (m) => {
      if (chan(m) === 'md-checks') soon('board', loadBoard, 500);
      if (m.run_id && m.run_id === state.selected) soon('status', loadStatus);
    });
  }

  // ------------------------------------------------------------------ checker health

  async function pingCompute() {
    const pill = $('compute-pill');
    try {
      // /health has no CORS headers, so an opaque response is all we get: it still proves the machine answered.
      await fetch(`${C.computeUrl}/health`, { mode: 'no-cors', cache: 'no-store' });
      pill.className = 'pill ok';
      $('compute-text').textContent = 'Checker online';
    } catch {
      pill.className = 'pill bad';
      $('compute-text').textContent = 'Checker unreachable';
    }
  }

  // ------------------------------------------------------------------ designs + leaderboard

  async function loadDesigns() {
    state.designs = await records('md_designs', 'select=name,summary,baseline_mhz,target_mhz,latency_budget&order=name.asc');
    const sel = $('f-design');
    const keep = sel.value || store.get('md.design') || 'mac';
    sel.innerHTML = state.designs.map((d) => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
    if (state.designs.some((d) => d.name === keep)) sel.value = keep;
    describeDesign();
  }

  function describeDesign() {
    const d = state.designs.find((x) => x.name === $('f-design').value);
    $('f-summary').textContent = d ? `${d.summary} Baseline ${num(d.baseline_mhz)} MHz, target ${num(d.target_mhz, 0)} MHz.` : '';
    $('f-target').placeholder = d ? `${num(d.target_mhz, 0)} (design target)` : 'design target';
  }

  async function loadBoard() {
    const { body } = await getJSON(FN('md-leaderboard'));
    if (!body?.ok) return;
    state.board = body.designs;
    $('board-body').innerHTML = state.board.map((r) => {
      const best = r.best_mhz;
      const top = Math.max(r.target_mhz, best ?? 0) * 1.05;
      const w = best ? Math.min(100, (best / top) * 100) : 0;
      const baseAt = Math.min(100, (r.baseline_mhz / top) * 100);
      const by = r.who ? ({ mcp: 'outside agent', agent: 'agent run', baseline: 'baseline' }[r.who] ?? r.who) : '';
      const byCell = r.run_id ? `<button class="btn link" data-run="${esc(r.run_id)}">${esc(by)}</button>` : `<span class="who">${esc(by)}</span>`;
      return `<tr>
        <td class="design">${esc(r.design)}</td>
        <td class="num">${num(r.baseline_mhz)}</td>
        <td class="num">${best ? `<b>${num(best)}</b><span class="x">${r.x != null ? `${num(r.x, 2)}×` : ''}</span>` : '—'}</td>
        <td class="num">${num(r.target_mhz, 0)}</td>
        <td><div class="bar" title="baseline ${num(r.baseline_mhz)} → best ${num(best)} / target ${num(r.target_mhz, 0)} MHz"><span class="${r.reached ? 'done' : ''}" style="width:${w}%"></span><i style="left:${baseAt}%"></i></div></td>
        <td>${byCell}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No designs yet.</td></tr>';
  }

  // ------------------------------------------------------------------ runs list

  async function loadRuns() {
    state.runs = await records('md_runs',
      'select=id,design,goal,target_mhz,status,step,iteration,max_iterations,best_mhz,created_at,updated_at&order=created_at.desc&limit=30');
    renderRuns();
    if (!state.selected) {
      const pick = new URLSearchParams(location.search).get('run') || state.runs.find((r) => ACTIVE.has(r.status))?.id || state.runs[0]?.id;
      if (pick) selectRun(pick);
    }
  }

  function renderRuns() {
    $('runs-list').innerHTML = state.runs.map((r) => `<li><button data-run="${esc(r.id)}" class="${r.id === state.selected ? 'sel' : ''}">
        <span class="run-line"><span class="run-design">${esc(r.design)}</span><span class="st ${esc(r.status)}">${esc(r.status)}</span></span>
        <span class="run-line run-meta"><span>${r.best_mhz ? `best ${num(r.best_mhz)} MHz` : 'no passing version yet'} · target ${num(r.target_mhz, 0)}</span><span>${ago(r.updated_at)}</span></span>
        <span class="run-meta">iteration ${r.iteration}/${r.max_iterations} · ${ACTIVE.has(r.status) ? `step ${esc(r.step)}` : 'finished'}</span>
      </button></li>`).join('') || '<li class="empty">No runs yet. Start one.</li>';
  }

  // ------------------------------------------------------------------ one run

  function selectRun(id) {
    if (state.selected !== id) {
      state.selected = id;
      state.status = null;
      setDrive(false);
      const u = new URL(location.href);
      u.searchParams.set('run', id);
      history.replaceState(null, '', u);
      watchRun(id);
    }
    renderRuns();
    loadStatus();
  }

  async function loadStatus() {
    const id = state.selected;
    if (!id) return;
    const { body } = await getJSON(`${FN('md-run-status')}?run_id=${encodeURIComponent(id)}`);
    if (id !== state.selected || !body?.ok) return;
    state.status = body;
    renderRun();
    schedulePolls();
  }

  function designOf(name) { return state.designs.find((d) => d.name === name) || {}; }

  function renderRun() {
    const s = state.status;
    const r = s.run;
    const d = designOf(r.design);
    $('run-empty').hidden = true;
    $('run-body').hidden = false;
    $('run-title').innerHTML = `Run · <span class="mono">${esc(r.design)}</span> <span class="st ${esc(r.status)}">${esc(r.status)}</span>`;
    const best = r.best_mhz;
    const base = Number(d.baseline_mhz) || null;
    $('run-stats').innerHTML = `
      <div class="stat"><div class="k">Best passing</div><div class="v">${best ? num(best) : '—'} <small>MHz</small></div></div>
      <div class="stat"><div class="k">Speed-up vs baseline</div><div class="v">${best && base ? `${num(best / base, 2)}×` : '—'}</div></div>
      <div class="stat"><div class="k">Target</div><div class="v">${num(r.target_mhz, 0)} <small>MHz</small></div></div>
      <div class="stat"><div class="k">Iteration</div><div class="v">${r.iteration}<small> / ${r.max_iterations}</small></div></div>
      <div class="stat"><div class="k">Model tokens</div><div class="v">${((s.tokens.prompt + s.tokens.completion) / 1000).toFixed(1)}<small>k</small></div></div>
      <div class="goal"><b>Goal:</b> ${esc(r.goal)}${r.error ? ` <span class="verdict wait">· ${esc(r.error)}</span>` : ''}</div>`;
    renderChart(s, base);
    renderTimeline(s);
    syncLive();
  }

  function engineerChecks(s) {
    return s.iterations.filter((i) => i.role === 'engineer' && i.output?.check).map((i) => ({
      n: i.n, pass: i.output.check.pass, mhz: i.output.check.mhz, accepted: i.accepted,
    }));
  }

  function renderChart(s, base) {
    const pts = engineerChecks(s);
    const target = Number(s.run.target_mhz);
    const W = 640, H = 200, L = 40, R = 12, T = 12, B = 26;
    const maxN = Math.max(s.run.max_iterations, ...pts.map((p) => p.n), 1);
    const ys = [target, base ?? 0, ...pts.map((p) => Number(p.mhz) || 0)];
    const maxY = Math.max(...ys) * 1.1 || 100;
    const x = (n) => L + ((n - 0.5) / maxN) * (W - L - R);
    const y = (v) => T + (1 - v / maxY) * (H - T - B);
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (maxY / 4) * i;
      g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
      g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`;
    }
    for (let n = 1; n <= maxN; n++) g += `<text x="${x(n)}" y="${H - 8}" text-anchor="middle">${n}</text>`;
    if (base) g += `<line x1="${L}" x2="${W - R}" y1="${y(base)}" y2="${y(base)}" stroke="var(--base)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}" stroke="var(--tgt)" stroke-width="1.5" stroke-dasharray="6 3"/>`;
    // best-so-far step line
    let best = base ?? 0, path = '';
    pts.forEach((p) => {
      if (p.accepted && p.mhz) best = Number(p.mhz);
      path += `${path ? 'L' : 'M'}${x(p.n)},${y(best)} `;
    });
    if (path) g += `<path d="${path}" fill="none" stroke="var(--pass)" stroke-width="2" opacity=".5"/>`;
    pts.forEach((p) => {
      const v = Number(p.mhz) || 0;
      g += `<circle cx="${x(p.n)}" cy="${y(v)}" r="${p.accepted ? 6 : 4.5}" fill="${p.pass ? 'var(--pass)' : 'var(--fail)'}" stroke="var(--card)" stroke-width="2"><title>iteration ${p.n}: ${p.pass ? 'pass' : 'fail'} ${num(p.mhz)} MHz${p.accepted ? ' (new best)' : ''}</title></circle>`;
    });
    if (!pts.length) g += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">No checked versions yet</text>`;
    $('chart').innerHTML = g;
  }

  const ROLE_TEXT = {
    planner: (o) => {
      const dc = o?.done_contract || {};
      const bits = [dc.target_mhz != null && `target <b>${num(dc.target_mhz, 0)} MHz</b>`, dc.max_iterations && `${dc.max_iterations} iterations`]
        .filter(Boolean).map((b) => `<span>${b}</span>`).join('');
      const note = dc.notes || dc.strategy || o?.target_event?.reason || '';
      return `${note ? `<p>${esc(note)}</p>` : ''}${bits ? `<div class="kv">${bits}</div>` : ''}${o?.parse_error ? `<p class="verdict no">${esc(o.parse_error)}</p>` : ''}`;
    },
    analyst: (o) => `${o?.bottleneck ? `<p><b>Bottleneck:</b> ${esc(o.bottleneck)}</p>` : ''}${o?.recommendation ? `<p><b>Do next:</b> ${esc(o.recommendation)}</p>` : ''}${o?.expected_gain ? `<div class="kv"><span>expected <b>${esc(o.expected_gain)}</b></span></div>` : ''}`,
    engineer: (o, it) => {
      let h = o?.rationale ? `<p>${esc(o.rationale)}</p>` : '';
      if (o?.error) h += `<p class="verdict no">${esc(o.error)}</p>`;
      const c = o?.check;
      if (c) {
        h += `<div class="kv">
          <span class="verdict ${c.pass ? 'ok' : 'no'}">${c.pass ? 'PASS' : `FAIL at ${esc(c.stage)}`}</span>
          ${c.mhz != null ? `<span><b>${num(c.mhz)}</b> MHz</span>` : ''}
          ${c.x != null ? `<span><b>${num(c.x, 2)}×</b> baseline</span>` : ''}
          ${c.lat != null ? `<span>latency <b>${c.lat}</b></span>` : ''}
          ${c.use ? `<span>LUT <b>${c.use.LUT}</b> · FF <b>${c.use.FF}</b> · DSP <b>${c.use.DSP}</b></span>` : ''}
          ${o.check_ms ? `<span>checked in ${(o.check_ms / 1000).toFixed(1)} s</span>` : ''}
          ${it.accepted ? '<span class="verdict ok">new best</span>' : ''}
        </div>`;
        if (c.path) h += `<div class="path mono">${esc(c.path)}</div>`;
        if (c.fix?.length) h += `<ul class="fix">${c.fix.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
      } else if (o?.check_status === 'check_unavailable') {
        h += `<p class="verdict wait">Checker not reachable yet (${esc(o.check_error || 'retrying')}); the next step retries.</p>`;
      } else if (!o?.error) {
        h += `<p class="verdict wait"><span class="spinner"></span> Waiting for the real check…</p>`;
      }
      h += `<div class="kv"><button class="btn link" data-code="${it.n}">View Verilog</button>`;
      if (c && c.pass) h += `<button class="btn link" data-tool="nextpnr" data-n="${it.n}">Show in tools (nextpnr)</button>`;
      if (c && c.stage !== 'static' && c.stage !== 'lint') h += `<button class="btn link" data-tool="gtkwave" data-n="${it.n}">Show waveforms (GTKWave)</button>`;
      h += '</div>';
      return h;
    },
  };

  function renderTimeline(s) {
    const r = s.run;
    const items = s.iterations.map((it) => {
      const o = it.output || {};
      const ok = it.role === 'engineer' && o.check ? (o.check.pass ? 'ok' : 'no') : '';
      return `<li class="step ${esc(it.role)} ${ok}">
        <div class="step-head"><span class="role">${esc(it.role)}${it.n ? ` · iteration ${it.n}` : ''}</span>
          <span class="step-meta">${esc(it.model || '')} · ${(it.prompt_tokens || 0) + (it.completion_tokens || 0)} tokens · ${ago(it.created_at)}</span></div>
        ${(ROLE_TEXT[it.role] || (() => ''))(o, it)}
      </li>`;
    });
    if (ACTIVE.has(r.status)) {
      const what = { plan: 'Planner is setting the goal', analyze: 'Analyst is reading the critical path', engineer: 'Engineer is writing new Verilog', check: 'Running the hidden testbench and place and route' }[r.step] || `Next: ${r.step}`;
      const how = state.driving ? 'driving live from this page' : 'the schedule advances one step a minute; turn on Drive live to go faster';
      items.push(`<li class="step live"><div class="step-head"><span class="role"><span class="spinner"></span> ${esc(what)}</span><span class="step-meta">${esc(how)}</span></div></li>`);
    }
    $('timeline').innerHTML = items.reverse().join('');
  }

  // ------------------------------------------------------------------ Verilog viewer

  function highlight(src) {
    return src.split('\n').map((line) => {
      let h = esc(line);
      const cm = h.indexOf('//');
      let tail = '';
      if (cm >= 0) { tail = `<span class="cm">${h.slice(cm)}</span>`; h = h.slice(0, cm); }
      h = h.replace(/\b(module|endmodule|input|output|wire|reg|always|posedge|negedge|begin|end|if|else|assign|localparam|parameter|case|endcase|for|generate|endgenerate|genvar|signed|integer)\b/g, '<span class="kw">$1</span>')
        .replace(/\b(\d+'[bdh][0-9a-fA-F_xz]+|\d+)\b/g, '<span class="nb">$1</span>');
      return `<span class="l">${h}${tail}</span>`;
    }).join('');
  }

  async function openCode(n) {
    const dlg = $('code-dialog');
    $('code-title').textContent = 'Loading Verilog…';
    $('code-view').innerHTML = '';
    $('code-tabs').innerHTML = '';
    dlg.showModal();
    const { body } = await getJSON(`${FN('md-run-verilog')}?run_id=${encodeURIComponent(state.selected)}`);
    if (!body?.ok) { $('code-title').textContent = 'Could not load the Verilog'; return; }
    const tabs = [{ key: 'start', label: 'start.v', src: body.start || '' },
      ...body.iterations.map((it, i, all) => {
        const tries = all.filter((x) => x.n === it.n);
        const k = tries.indexOf(it);
        return { key: it.id, n: it.n, label: `iteration ${it.n}${tries.length > 1 ? ` try ${k + 1}` : ''}${it.pass === true ? ' ✓' : it.pass === false ? ' ✗' : ''}`, src: it.verilog };
      })];
    const show = (t) => {
      $('code-title').textContent = `${body.design} · ${t.label}`;
      $('code-view').innerHTML = highlight(t.src);
      [...$('code-tabs').children].forEach((b) => b.classList.toggle('sel', b.dataset.key === t.key));
    };
    $('code-tabs').innerHTML = tabs.map((t) => `<button data-key="${esc(t.key)}">${esc(t.label)}</button>`).join('');
    $('code-tabs').onclick = (e) => { const t = tabs.find((x) => x.key === e.target.dataset?.key); if (t) show(t); };
    show(tabs.filter((t) => t.n === n).at(-1) || tabs.at(-1));
  }

  // ------------------------------------------------------------------ live tools (ported from Crusoe-Forge app.js)
  // The real nextpnr GUI / GTKWave run on the InsForge compute machine, each on its own Xvfb screen. The panel in
  // the run view opens them by itself on the run's best version (or the step you pick with "Show in tools"); we
  // poll one JPEG frame at a time (~4 fps) and post mouse and keys back, like Crusoe-Forge's toolstream viewer.

  const live = { tool: 'nextpnr', pin: null, key: null, sid: null, url: null, ready: false, starting: false };
  const toolApi = (path, opts = {}) => fetch(`${C.computeUrl}/api/tool/${path}`, {
    ...opts, cache: 'no-store', headers: { Authorization: `Bearer ${token()}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const setToolState = (cls, html) => { const el = $('tool-state'); el.className = `pill small ${cls}`; el.innerHTML = html; };

  /** Which engineer iteration the panel should show: the one you picked, else the run's best passing version,
   * else (GTKWave only) the latest version that got as far as simulation. */
  function liveIteration(s) {
    if (live.tool === 'kicad') return 0;   // the add-on board does not depend on the iteration
    const eng = s.iterations.filter((i) => i.role === 'engineer' && i.output?.check);
    if (live.pin != null && eng.some((i) => i.n === live.pin)) return live.pin;
    const best = eng.filter((i) => i.accepted && i.output.check.pass).at(-1) || eng.filter((i) => i.output.check.pass).at(-1);
    if (best) return best.n;
    if (live.tool === 'gtkwave') return eng.filter((i) => !['static', 'lint'].includes(i.output.check.stage)).at(-1)?.n ?? null;
    return null;
  }

  function stopLive() {
    const sid = live.sid;
    live.sid = null; live.key = null; live.ready = false;
    $('tool-img').removeAttribute('src');
    if (sid) toolApi(`${sid}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
  }

  /** Called on every run refresh: (re)opens the right tool on the right version, or explains why it can't yet. */
  async function syncLive() {
    const s = state.status;
    if (!s) return;
    [...$('live-tabs').children].forEach((b) => b.classList.toggle('sel', b.dataset.live === live.tool));
    const n = liveIteration(s);
    $('live-token').hidden = Boolean(token());
    if (n == null) {
      if (live.sid) stopLive();
      $('tool-empty').hidden = false;
      $('tool-empty').textContent = live.tool === 'nextpnr'
        ? 'nextpnr opens here on this run\'s first passing version (it needs a routed design). Waiting for the agents…'
        : 'GTKWave opens here on the first version that compiles and simulates. Waiting for the agents…';
      setToolState('', 'waiting for a checked version');
      return;
    }
    $('live-sub').textContent = live.tool === 'kicad'
      ? 'The actual KiCad pcbnew on the InsForge machine · the ULX3S HDMI add-on board, placed, Freerouting-routed and DRC-checked'
      : `The actual programs running on the InsForge machine · ${s.run.design}, iteration ${n}${live.pin == null ? ' (best so far, follows new bests)' : ''}`;
    if (!token()) { setToolState('warn', 'needs the access token'); $('tool-empty').hidden = false; $('tool-empty').textContent = 'Paste the access token above to open the real tools.'; return; }
    const key = live.tool === 'kicad' ? 'kicad' : `${s.run.id}|${live.tool}|${n}`;
    if (key === live.key || live.starting) return;
    stopLive();
    live.key = key; live.starting = true;
    $('tool-empty').hidden = false;
    $('tool-empty').textContent = `Opening the real ${live.tool} on iteration ${n}…`;
    setToolState('', '<span class="spinner"></span> loading this version…');
    try {
      let req = { tool: 'kicad' };
      if (live.tool !== 'kicad') {
        const { body } = await getJSON(`${FN('md-run-verilog')}?run_id=${encodeURIComponent(s.run.id)}&n=${n}`);
        const src = body?.iterations?.filter((i) => i.pass != null).at(-1)?.verilog || body?.iterations?.at(-1)?.verilog;
        if (!src) throw new Error('no Verilog for this iteration');
        req = { tool: live.tool, design: body.design, verilog: src };
      }
      const r = await toolApi('start', { method: 'POST', body: JSON.stringify(req) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error('token rejected');
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (live.key !== key) return;   // switched while starting
      live.sid = j.sid;
      setToolState('', `<span class="spinner"></span> opening the real ${live.tool}${{ nextpnr: ' (place and route + GUI, ~20–40 s)', kicad: ' (place, Freerouting, DRC + GUI, ~1–2 min)' }[live.tool] || ''}…`);
      frameLoop();
    } catch (e) {
      setToolState('bad', esc(`could not open: ${e.message || e}`));
      $('tool-empty').textContent = `Could not open ${live.tool}: ${e.message || e}`;
      live.key = null;
    } finally {
      live.starting = false;
    }
  }

  async function frameLoop() {
    while (live.sid) {
      const sid = live.sid;
      try {
        const r = await toolApi(`${sid}/frame.jpg?t=${Date.now()}`);
        if (sid !== live.sid) break;
        if (r.ok) {
          const u = URL.createObjectURL(await r.blob());
          $('tool-img').src = u;
          $('tool-empty').hidden = true;
          if (live.url) URL.revokeObjectURL(live.url);
          live.url = u;
          if (!live.ready) {
            const st = await (await toolApi('status')).json().catch(() => null);
            const ses = st?.sessions?.find((x) => x.sid === sid);
            if (ses?.ready) { live.ready = true; setToolState('ok', `live: the real ${live.tool}`); }
            else if (ses?.error) setToolState('bad', esc(ses.error));
          }
        } else if (r.status === 404) { setToolState('bad', 'the program was closed; reopening'); live.key = null; live.sid = null; syncLive(); break; }
      } catch { /* network blip: keep polling */ }
      await new Promise((res) => setTimeout(res, document.hidden ? 1000 : 240));
    }
  }

  function toolPost(o) {
    if (!live.sid) return;
    toolApi(`${live.sid}/input`, { method: 'POST', body: JSON.stringify({ x: 0, y: 0, ...o }) }).catch(() => {});
  }
  const img = $('tool-img');
  const at = (e) => { const r = img.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  let drag = null;
  img.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); img.parentElement.focus(); drag = { start: at(e), moved: false, last: 0 };
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return; const p = at(e);
    if (!drag.moved && Math.hypot((p.x - drag.start.x) * img.width, (p.y - drag.start.y) * img.height) > 4) {
      drag.moved = true; toolPost({ type: 'down', button: 'left', ...drag.start });
    }
    if (drag.moved && Date.now() - drag.last > 50) { drag.last = Date.now(); toolPost({ type: 'move', held: true, ...p }); }
  });
  document.addEventListener('mouseup', (e) => {
    if (!drag) return; const d = drag; drag = null; const p = at(e);
    toolPost(d.moved ? { type: 'up', button: 'left', ...p } : { type: 'click', ...p });
  });
  img.addEventListener('dblclick', (e) => toolPost({ type: 'click', ...at(e) }));   // 2nd click of a double
  img.addEventListener('contextmenu', (e) => { e.preventDefault(); toolPost({ type: 'rightclick', ...at(e) }); });
  img.addEventListener('wheel', (e) => { e.preventDefault(); toolPost({ type: 'wheel', ...at(e), delta: e.deltaY > 0 ? -120 : 120 }); }, { passive: false });
  let escAt = 0;
  for (const kind of ['keydown', 'keyup']) document.addEventListener(kind, (e) => {
    const wrap = document.activeElement?.closest?.('.tool-wrap');
    if (!wrap) return;
    if (kind === 'keydown' && e.key === 'Escape') { if (Date.now() - escAt < 600) { wrap.blur(); return; } escAt = Date.now(); }
    e.preventDefault(); e.stopPropagation();
    toolPost({ type: 'key', key: e.key, code: e.code, down: kind === 'keydown', ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
  }, true);

  $('live-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-live]')?.dataset.live;
    if (t && t !== live.tool) { live.tool = t; stopLive(); syncLive(); }
  });
  $('live-token-go').onclick = () => {
    const v = $('live-token-input').value.trim();
    if (!v) return;
    $('f-token').value = v; store.set('md.token', v);
    syncLive();
  };
  $('live-token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('live-token-go').click(); });

  function showInTools(toolName, n) {
    live.pin = n;
    if (toolName) live.tool = toolName;
    live.key = null;
    syncLive();
    $('live-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ------------------------------------------------------------------ start + drive

  async function startRun(e) {
    e.preventDefault();
    const msg = $('start-msg');
    if (!token()) { msg.className = 'form-msg err'; msg.textContent = 'Paste the access token first.'; return; }
    store.set('md.token', token());
    store.set('md.design', $('f-design').value);
    const body = { design: $('f-design').value, max_iterations: Number($('f-iters').value) || 6 };
    if ($('f-target').value) body.target_mhz = Number($('f-target').value);
    if ($('f-goal').value.trim()) body.goal = $('f-goal').value.trim();
    $('start-btn').disabled = true;
    msg.className = 'form-msg'; msg.textContent = 'Starting…';
    const { status, body: res } = await getJSON(FN('md-run-start'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-manudesk-token': token() }, body: JSON.stringify(body),
    }).catch((err) => ({ status: 0, body: { error: { message: String(err) } } }));
    $('start-btn').disabled = false;
    const id = res?.run_id || res?.run?.id;
    if (!id) {
      msg.className = 'form-msg err';
      msg.textContent = status === 401 ? 'Token rejected.' : `Could not start: ${res?.error?.message || status}`;
      return;
    }
    msg.textContent = 'Run started. Driving it live below.';
    await loadRuns();
    selectRun(id);
    setDrive(true);
  }

  function setDrive(on) {
    if (on && !token()) {
      $('drive').checked = false;
      const m = $('start-msg');
      m.className = 'form-msg err'; m.textContent = 'Drive live needs the access token.';
      return;
    }
    state.driving = on;
    $('drive').checked = on;
    $('drive-state').hidden = !on;
    if (on) driveLoop();
  }

  async function driveLoop() {
    if (state.driveBusy) return;
    state.driveBusy = true;
    const ds = $('drive-state');
    try {
      while (state.driving && state.selected) {
        const run = state.status?.run;
        if (run && !ACTIVE.has(run.status)) { ds.textContent = `finished: ${run.status}`; setDrive(false); break; }
        ds.className = 'pill small ok'; ds.innerHTML = `<span class="spinner"></span> stepping (${esc(run?.step || '…')})`;
        const id = state.selected;
        const { status, body } = await getJSON(FN('md-run-step'), {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-manudesk-token': token() }, body: JSON.stringify({ run_id: id }),
        }).catch((err) => ({ status: 0, body: { error: String(err) } }));
        if (id !== state.selected) break;
        if (status === 401) { ds.className = 'pill small bad'; ds.textContent = 'token rejected'; setDrive(false); break; }
        await loadStatus();
        loadRuns();
        if (status === 409) await new Promise((r) => setTimeout(r, 2500)); // the schedule is stepping it right now
        else if (body?.error && String(body.error).startsWith('check_unavailable')) await new Promise((r) => setTimeout(r, 8000));
        else if (body?.finished || (body?.status && !ACTIVE.has(body.status))) { await loadBoard(); }
      }
    } finally {
      state.driveBusy = false;
    }
  }

  // ------------------------------------------------------------------ wiring

  document.addEventListener('click', (e) => {
    const run = e.target.closest('[data-run]');
    if (run) { selectRun(run.dataset.run); return; }
    const code = e.target.closest('[data-code]');
    if (code) { openCode(Number(code.dataset.code)); return; }
    const t = e.target.closest('button[data-tool]');
    if (t) showInTools(t.dataset.tool, Number(t.dataset.n));
  });
  $('code-close').onclick = () => $('code-dialog').close();
  $('code-dialog').addEventListener('click', (e) => { if (e.target.id === 'code-dialog') e.target.close(); });
  $('f-design').onchange = describeDesign;
  $('start-form').onsubmit = startRun;
  $('drive').onchange = (e) => setDrive(e.target.checked);
  $('f-token').value = store.get('md.token') || '';
  $('f-token').onchange = () => store.set('md.token', token() || null);

  (async () => {
    pingCompute();
    await loadDesigns();
    await Promise.all([loadBoard(), loadRuns()]);
    setLive(false, 'connecting');
    startRealtime();
    every('compute', 60000, pingCompute);
  })();
})();
