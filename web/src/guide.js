// guide.js — one Menu Desk run, step by step: Connect -> Get design -> Check #1 (baseline) -> Check #2..n -> Best result.
// Every number comes from data.js (the run's real check rows, or the fixture when data.sample is true).
// Live: existing checks render first, then subscribeRun() animates each new check into the rail, NOW strip, feed and chart.

const SRC_LABEL = { agent: "Coding agent", menudesk: "Menu Desk MCP", insforge: "InsForge", eda: "Yosys + nextpnr" };
const GROUPS = [
  { k: "connect", t: "Connect" },
  { k: "design", t: "Get design" },
  { k: "baseline", t: "Baseline" },
  { k: "iterate", t: "Iterate" },
  { k: "best", t: "Best result" },
];
const LIVE_WINDOW = 20 * 60;   // a run with a check in the last 20 min is treated as live

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = s => s == null || isNaN(s) ? "—" : s < 60 ? `${s < 10 ? (+s).toFixed(1) : Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
const clockFmt = s => s == null ? "--:--" : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}` : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const now = () => Date.now() / 1000;
const tsOf = c => { const t = Date.parse(c && c.created_at); return isNaN(t) ? null : t / 1000; };
const mhz = v => v == null || v === "" || isNaN(+v) ? null : +v;
const mhzTxt = v => mhz(v) == null ? "—" : (+v).toFixed(1);
const xTxt = v => v == null || v === "" ? "—" : String(v).replace(/x$/i, "×");
const clockTime = t => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function mountGuide(runId, api) {
  const S = { run: runId, data: null, info: {}, checks: [], sample: false, feed: [], lastAct: null, live: false, startT: null, lastT: null, err: null };
  let view = null, booted = false, unsub = null, viewers = [], ticker = null, gone = false;
  const OPEN = new Set(), FRESH = new Set();   // FRESH: check ids that arrived live and still need their chart push animated

  const following = () => { const f = $("#wfFollow"); return !f || f.checked; };
  const setFollow = v => { const f = $("#wfFollow"); if (f) f.checked = v; };
  const base = () => mhz(S.info.baseline_mhz) ?? mhz(S.checks[0] && (S.checks[0].baseline_mhz ?? S.checks[0].fmax_mhz));
  const target = () => mhz(S.info.target_mhz);
  const bestCheck = () => S.checks.filter(c => c.accepted && mhz(c.fmax_mhz) != null).reduce((a, c) => !a || +c.fmax_mhz > +a.fmax_mhz ? c : a, null);
  const isLive = () => S.live && !S.sample && (S.lastT == null || now() - S.lastT < LIVE_WINDOW);

  // ---- steps: one rail segment per step, grouped like the stages of the original rail
  function steps() {
    const out = [{ k: "connect", g: "connect", t: "Connect" }, { k: "design", g: "design", t: "Get design" }];
    S.checks.forEach((c, i) => out.push({ k: `check:${c.n}`, g: i == 0 ? "baseline" : "iterate", t: i == 0 ? `Check #${c.n} · baseline` : `Check #${c.n}`, check: c }));
    if (isLive()) { const n = (S.checks.at(-1)?.n || 0) + 1; out.push({ k: "next", g: S.checks.length ? "iterate" : "baseline", t: `Check #${n}`, pending: n }); }
    out.push({ k: "best", g: "best", t: "Best result" });
    return out;
  }
  const stepOf = k => steps().find(s => s.k == k);
  const curKey = () => { const all = steps(); return all.some(s => s.k == view) ? view : (isLive() ? "next" : "best"); };
  function stepState(s) {
    if (s.k == "next") return "now";
    if (s.k == "best") return isLive() ? "next" : "done";
    return "done";
  }

  // ---- feed: every check, in plain words, tagged by where it ran
  function feedFor(c) {
    const t1 = tsOf(c) ?? now(), t0 = t1 - (+c.seconds || 0), k = `check:${c.n}`, lines = String(c.verilog || "").split("\n").filter(l => l.trim()).length;
    const out = [{ t: t0, k, src: "agent", text: `Submitted candidate #${c.n} through check()${lines ? ` · ${lines} lines of Verilog` : ""}` }];
    const why = (c.reasons || []).filter(Boolean);
    out.push({ t: t0 + Math.min(1, (+c.seconds || 0) * .3), k, src: "menudesk", text: c.accepted ? `Hidden testbench passed${c.stage && c.stage != "ok" ? ` (${c.stage})` : ""}` : `Rejected${c.stage ? ` at ${c.stage}` : ""}${why[0] ? `: ${why[0]}` : ""}` });
    if (mhz(c.fmax_mhz) != null) out.push({ t: t1 - .2, k, src: "eda", text: `Placed and routed on ECP5: ${mhzTxt(c.fmax_mhz)} MHz${c.vs_baseline ? ` (${xTxt(c.vs_baseline)} baseline)` : ""}${c.critical_path ? ` · critical path ${c.critical_path}` : ""}` });
    out.push({ t: t1, k, src: "insforge", text: `Check #${c.n} stored${c.report_key ? " with its placement report" : ""}` });
    return out;
  }
  function rebuildFeed() {
    const c0 = S.checks[0], t0 = c0 ? (tsOf(c0) ?? now()) - (+c0.seconds || 0) : (S.createdT ?? now()), d = S.info;
    S.feed = [
      { t: t0, k: "connect", src: "agent", text: "Opened an MCP session with Menu Desk (HTTP, bearer token): tools get_design and check" },
      { t: t0, k: "design", src: "menudesk", text: `get_design → ${S.data.design || d.name || "design"}${target() ? `: target ${target()} MHz` : ""}${base() ? `, baseline ${mhzTxt(base())} MHz` : ""}` },
      ...S.checks.flatMap(feedFor)];
    S.startT = t0; S.lastT = S.checks.length ? tsOf(S.checks.at(-1)) : S.createdT ?? null;
    S.lastAct = S.feed.at(-1);
  }

  // ---- rail as a progress timeline: remember when each step first turned done/live, so redraws continue its fill
  const RAIL_AT = new Map(); let railFirst = true;
  function railDelay(i, k, st) { const key = `${k}:${st}`, t = performance.now();
    if (!RAIL_AT.has(key)) RAIL_AT.set(key, t + (railFirst && st == "done" ? 250 + i * 450 : 0));
    return Math.round(RAIL_AT.get(key) - t); }
  function renderMeta() { const live = isLive(), b = base(), best = bestCheck(), tg = target();
    const end = live ? now() : (S.lastT ?? S.startT), el = S.startT != null && end != null ? Math.max(0, end - S.startT) : null;
    $("#wfMeta").innerHTML = S.data ? `<span class="state ${live ? "live" : ""}"><span class="dot"></span><span class="st-word">${live ? "live" : "finished"} · </span><b>${clockFmt(el)}</b></span>
      <span class="kpi">Target <b>${tg ?? "—"}</b></span><span class="kpi">Start <b class="${b && tg && b < tg ? "warn" : ""}">${mhzTxt(b)}</b></span><span class="kpi">Best <b class="${best && b && +best.fmax_mhz > b ? "ok" : ""}">${best ? mhzTxt(best.fmax_mhz) : "—"}</b> MHz</span>` : ""; }
  function renderRail() { const all = steps(), cur = curKey(), live = isLive();
    document.body.dataset.state = live ? "live" : "done";
    const ndone = all.filter(s => stepState(s) == "done").length;
    let i = 0;
    $("#wfSteps").innerHTML = `<div class="track" style="min-width:${Math.max(520, all.length * 104)}px">${GROUPS.map(g => { const ns = all.filter(s => s.g == g.k); if (!ns.length) return "";
        const isNow = live && ns.some(s => s.k == "next"), note = groupNote(g.k, ns);
        return `<div class="tg ${isNow ? "now" : ""}" style="flex:${ns.length} 1 0"><div class="tgl"><span>${esc(g.t)}</span>${note ? `<em>${esc(note)}</em>` : ""}</div><div class="segs">` + ns.map(s => { const st = stepState(s), n = ++i;
          return `<button class="seg ${st} ${st == "now" && live ? "live" : ""} ${s.k == cur ? "view" : ""} ${s.check && !s.check.accepted ? "rej" : ""}" data-k="${esc(s.k)}" style="--d:${railDelay(n, s.k, st)}ms" title="${n} · ${esc(s.t)}"><i></i><span><b>${n}</b>${esc(s.t)}</span></button>`; }).join("") + `</div></div>`; }).join("")}</div>
      <div class="tsum"><b>${ndone}</b>/${all.length}</div>`;
    railFirst = false;
    const bar = $("#wfSteps"), v = bar.querySelector(".seg.view");   // keep the step being shown in sight when the track scrolls
    if (v && bar.scrollWidth > bar.clientWidth) { const l = v.offsetLeft - bar.offsetLeft, r = l + v.offsetWidth; if (l < bar.scrollLeft + 24) bar.scrollLeft = l - 24; else if (r > bar.scrollLeft + bar.clientWidth - 24) bar.scrollLeft = r - bar.clientWidth + 24; } }
  function groupNote(g, ns) {
    if (g == "iterate") { const cs = ns.filter(s => s.check).map(s => s.check); return cs.length ? `${cs.filter(c => c.accepted).length}/${cs.length} accepted` : ""; }
    if (g == "baseline") { const c = ns[0] && ns[0].check; return c ? `${mhzTxt(c.fmax_mhz)} MHz` : "waiting"; }
    if (g == "best") { const b = bestCheck(); return b ? `${mhzTxt(b.fmax_mhz)} MHz` : ""; }
    return "";
  }

  // ---- shared panels
  function hero(s, lead, tags) { const all = steps(), i = all.findIndex(x => x.k == s.k);
    return `<div class="eyebrow">Step ${i + 1} of ${all.length}</div><h1 class="wf-h1">${esc(s.title || s.t)}</h1><p class="lead">${esc(lead)}</p>${tags.length ? `<div class="tags">${tags.map(([c, l]) => `<span class="tag ${c}">${esc(l)}</span>`).join("")}</div>` : ""}`; }
  function nowStrip() { if (!isLive()) return "";
    const a = S.lastAct, gap = a ? now() - a.t : null;
    const what = a && gap < 8 ? `<span class="tag ${a.src}">${SRC_LABEL[a.src]}</span> <span class="txt">${esc(a.text)}</span>`
      : `<span class="txt">Waiting for ${esc(waitingOn())}<span class="muted gap">${gap != null ? ` · ${fmt(gap)} since the last update` : ""}</span></span>`;
    return `<div class="now-strip"><b><span class="dot"></span>NOW</b>${what}</div>`; }
  function waitingOn() { return S.checks.length ? "the coding agent's next candidate (it calls check() on Menu Desk MCP, then Yosys + nextpnr measure it)" : "the coding agent to submit its first candidate through Menu Desk MCP"; }
  function feedPanel(keys, title) { const all = S.feed.filter(f => !keys || keys.includes(f.k)), items = all.slice(-80); if (!items.length) return "";
    return `<section class="blk"><h3><span>${esc(title || "What happened, step by step")}</span><span class="muted" style="font:500 11px var(--mono)">${all.length} events</span></h3>
      <div class="feed" id="wfFeed">${items.map(f => `<div><time>${clockTime(f.t)}</time><span class="tag ${f.src}">${SRC_LABEL[f.src]}</span><span>${esc(f.text)}</span></div>`).join("")}</div></section>`; }
  function navBtns() { const all = steps(), i = all.findIndex(s => s.k == curKey());
    const p = all[i - 1], n = all[i + 1];
    return `<div class="navbtns"><button class="ghost" data-go="-1" ${p ? "" : "disabled"}>← ${p ? `${i} · ${esc(p.t)}` : ""}</button><button class="ghost" data-go="1" ${n ? "" : "disabled"}>${n ? `${i + 2} · ${esc(n.t)}` : ""} →</button></div>`; }
  const chartPanel = () => S.checks.length ? `<section class="blk"><h3><span>Fmax across checks</span><span class="tag eda">Yosys + nextpnr</span></h3><div class="viewer" data-viewer="chart"><p class="empty">Loading the chart…</p></div></section>` : "";
  const kv = rows => `<dl class="kv">${rows.filter(r => r[1] != null && r[1] !== "").map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  const budgetTxt = b => b == null ? null : typeof b == "object" ? Object.entries(b).map(([k, v]) => `${k} ${v}`).join(" · ") : String(b);
  function resBars(c) { const R = c.resources || {}, B = c.budgets || S.info.resource_budget || {};
    const keys = ["LUT", "FF", "DSP", ...Object.keys(R).filter(k => !["LUT", "FF", "DSP"].includes(k))].filter(k => R[k] != null || B[k] != null);
    if (!keys.length) return `<p class="empty">No resource numbers for this check.</p>`;
    const mx = Math.max(1, ...keys.map(k => +R[k] || 0));
    return `<div class="rbars">${keys.map(k => { const u = +R[k], b = +B[k], has = R[k] != null, over = has && b && u > b, pct = !has ? 0 : b ? Math.min(100, 100 * u / b) : 100 * u / mx;
      return `<span class="rb-k">${esc(k)}</span><span class="rb-bar ${over ? "over" : ""}"><i style="width:${pct.toFixed(1)}%"></i></span><span class="rb-v">${has ? u.toLocaleString("en-US") : "—"}${b ? ` <span class="muted">/ ${b.toLocaleString("en-US")}</span>` : ""}</span>`; }).join("")}</div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">${keys.some(k => R[k] != null && +B[k] && +R[k] > +B[k]) ? "Over budget: Menu Desk rejects a candidate that uses more than the design allows." : "Used / budget from the design spec. Over budget is a rejection."}</p>`; }
  function verilogBlock(c, key) { const v = String(c.verilog || ""); if (!v.trim()) return "";
    return `<details data-key="${key}"><summary>Candidate Verilog (${v.split("\n").length} lines)</summary><pre class="code">${esc(v)}</pre></details>`; }

  // ---- views
  function connectView(s) {
    const left = `<section class="blk"><h3><span>MCP session</span><span class="tag menudesk">Menu Desk MCP</span></h3>
      <div class="lbl">The agent gets tools, not answers</div><div class="big" style="margin-top:6px">2<small>tools</small></div>
      ${kv([["Agent's goal", S.goal], ["Transport", "HTTP, bearer token"], ["Tools", "get_design · check"], ["Run", S.run], ["Design", S.data.design || S.info.name]])}
      <pre>${esc(`{
  "mcpServers": {
    "menudesk": {
      "type": "http",
      "url": "https://<menu-desk-host>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}`)}</pre></section>`;
    return hero(s, "A coding agent connects to the Menu Desk MCP server. It can ask for a design and submit Verilog for checking, but it never sees the testbench.", [["agent", "Coding agent"], ["menudesk", "Menu Desk MCP · HTTP + bearer"]])
      + `<div class="cols">${left}<div>${feedPanel(["connect"])}</div></div>` + navBtns(); }
  function designView(s) { const d = S.info, b = base(), tg = target();
    return hero(s, "The agent calls get_design and receives the spec: what the module must do, the clock to beat and the budgets it has to stay inside. The hidden testbench stays on the server.", [["menudesk", "Menu Desk MCP · get_design"], ["insforge", "InsForge · design spec"]])
      + `<div class="result"><section class="blk"><div class="lbl">Design</div><div class="big" style="margin-top:6px;font-size:26px">${esc(d.name || S.data.design || "—")}</div></section>
         <section class="blk"><div class="lbl">Baseline</div><div class="big" style="margin-top:6px">${mhzTxt(b)}<small>MHz</small></div></section>
         <section class="blk"><div class="lbl">Target</div><div class="big" style="margin-top:6px">${tg ?? "—"}<small>MHz</small></div></section>
         <section class="blk"><div class="lbl">Latency budget</div><div class="big" style="margin-top:6px">${esc(d.latency_budget ?? "—")}<small>cycles</small></div></section></div>
       <div class="cols" style="margin-top:22px"><section class="blk"><h3><span>The spec the agent reads</span><span class="tag menudesk">get_design</span></h3>
         <div style="font-size:15.5px;line-height:1.6">${esc(d.summary || "No summary for this design.")}</div>
         ${kv([["Resource budget", budgetTxt(d.resource_budget)], ["Latency budget", d.latency_budget], ["Target clock", tg ? `${tg} MHz` : null], ["Baseline clock", b ? `${mhzTxt(b)} MHz` : null]])}</section>
         <div>${feedPanel(["design"])}</div></div>` + navBtns(); }
  function checkView(s) { const c = s.check, b = base(), first = S.checks[0] === c, ok = !!c.accepted, why = (c.reasons || []).filter(Boolean);
    const lead = ok ? `Accepted: the hidden testbench passed and Yosys + nextpnr placed and routed it on the ECP5 at ${mhzTxt(c.fmax_mhz)} MHz${first ? ". This is the baseline every later check is measured against." : c.vs_baseline ? `, ${xTxt(c.vs_baseline)} the baseline.` : "."}`
      : `Rejected${c.stage ? ` at ${c.stage}` : ""}: ${why[0] || "the candidate failed the check"}. The agent gets the reasons back and tries again.`;
    s.title = first ? `Check #${c.n} · baseline` : `Check #${c.n}`;
    return hero(s, lead, [["agent", "Coding agent · candidate"], ["menudesk", "Menu Desk MCP · hidden testbench"], ["eda", "Yosys + nextpnr · ECP5"], ["insforge", "InsForge · stored"]])
      + `<div class="result">
          <section class="blk"><div class="lbl">Verdict</div><div class="big ${ok ? "ok" : "bad"}" style="margin-top:6px">${ok ? "Accepted" : "Rejected"}</div><p class="muted" style="font-size:12.5px;margin:6px 0 0">${esc(c.stage && c.stage != "ok" ? c.stage : ok ? "hidden testbench + place and route" : "")}</p></section>
          <section class="blk"><div class="lbl">Fmax</div><div class="big ${ok && b && +c.fmax_mhz > b ? "ok" : ""}" style="margin-top:6px">${mhzTxt(c.fmax_mhz)}<small>MHz</small></div><p class="muted" style="font-size:12.5px;margin:6px 0 0">${target() ? `target ${target()} MHz` : ""}</p></section>
          <section class="blk"><div class="lbl">vs baseline</div><div class="big" style="margin-top:6px">${first ? "1.00×" : xTxt(c.vs_baseline)}</div><p class="muted" style="font-size:12.5px;margin:6px 0 0">baseline ${mhzTxt(c.baseline_mhz ?? b)} MHz</p></section>
          <section class="blk"><div class="lbl">Latency</div><div class="big" style="margin-top:6px">${esc(c.latency ?? "—")}<small>cycles</small></div><p class="muted" style="font-size:12.5px;margin:6px 0 0">${S.info.latency_budget != null ? `budget ${esc(S.info.latency_budget)}` : ""}</p></section></div>
        <div class="cols" style="margin-top:22px"><div>
          <section class="blk"><h3><span>What Menu Desk told the agent</span><span class="tag menudesk">Menu Desk MCP</span></h3>
            ${why.length ? `<ul class="reasons">${why.map((r, i) => `<li class="${i ? "hint" : ok ? "ok" : "bad"}">${esc(r)}</li>`).join("")}</ul>` : `<p class="empty">${ok ? "Hidden testbench passed, design inside its budgets." : "No reasons recorded."}</p>`}
            ${kv([["Stage", c.stage == "ok" ? "passed every stage" : c.stage], ["Critical path", c.critical_path], ["Check took", c.seconds != null ? fmt(+c.seconds) : null], ["Stored", c.created_at ? new Date(c.created_at).toLocaleString() : null]])}
            ${verilogBlock(c, `v-${c.n}`)}</section>
          <section class="blk"><h3><span>Resources vs budget</span><span class="tag eda">Yosys + nextpnr</span></h3>${resBars(c)}</section></div>
          <div>${chartPanel()}${feedPanel([s.k], `Check #${c.n}, step by step`)}</div></div>
        ${c.report_key ? `<section class="blk"><h3><span>Floorplan on the ECP5, critical path highlighted</span><span class="tag eda">nextpnr report</span></h3><div class="viewer" data-viewer="floorplan" data-report="${esc(c.report_key)}"><p class="empty">Loading the placement report…</p></div></section>` : ""}`
      + navBtns(); }
  function nextView(s) { const since = S.lastT ? now() - S.lastT : null;
    s.title = s.t;
    return hero(s, S.checks.length ? "The agent is reading the last check's reasons and critical path and writing its next candidate. It appears here the moment Menu Desk stores the result." : "Waiting for the agent's first candidate. Check #1 is the baseline every later check is measured against.", [["agent", "Coding agent"], ["menudesk", "Menu Desk MCP · check"], ["eda", "Yosys + nextpnr"]])
      + nowStrip()
      + `<div class="cols"><div><section class="blk"><div class="lbl">Waiting on the agent</div><div class="timer" id="wfSince">${since != null ? fmt(since) : "—"}</div><div class="prog"><i style="width:${Math.min(95, 100 * (since || 0) / 240).toFixed(1)}%"></i></div>
          <div class="muted" style="font-size:12px">since the last check was stored · checks so far ${S.checks.length}</div></section>${chartPanel()}</div>
        <div>${feedPanel(null, "Everything so far")}</div></div>` + navBtns(); }
  function bestView(s) { const b = base(), bc = bestCheck(), acc = S.checks.filter(c => c.accepted).length, rej = S.checks.length - acc;
    const x = bc && b ? +bc.fmax_mhz / b : null, total = S.checks.reduce((a, c) => a + (+c.seconds || 0), 0);
    s.title = x && x > 1.005 ? `${x.toFixed(2)}× faster` : bc ? "No speed-up yet" : "No accepted check yet";
    const lead = bc ? `${S.data.design || S.info.name}: ${mhzTxt(b)} → ${mhzTxt(bc.fmax_mhz)} MHz in ${S.checks.length} check${S.checks.length == 1 ? "" : "s"}, ${rej ? `${acc} accepted and ${rej} rejected by the hidden testbench` : "all accepted"}.` : "The best result appears here once a check is accepted.";
    const ab = abTable();
    return hero(s, lead, [["agent", "Coding agent"], ["menudesk", "Menu Desk MCP"], ["eda", "Yosys + nextpnr"], ["insforge", "InsForge"]])
      + (isLive() ? nowStrip() : "")
      + `<div class="result"><section class="blk"><div class="lbl">Before → after</div><div class="big" style="margin-top:6px">${mhzTxt(b)} → <span class="${bc && +bc.fmax_mhz > b ? "ok" : ""}">${bc ? mhzTxt(bc.fmax_mhz) : "—"}</span><small>MHz</small></div></section>
         <section class="blk"><div class="lbl">Checks</div><div class="big" style="margin-top:6px">${acc}<small>accepted</small></div><p class="muted" style="font-size:12.5px;margin:6px 0 0">${rej} wrong or over-budget candidates caught</p></section>
         <section class="blk"><div class="lbl">Best check</div><div class="big" style="margin-top:6px">${bc ? `#${bc.n}` : "—"}</div><p class="muted" style="font-size:12.5px;margin:6px 0 0">${bc ? `${xTxt(bc.vs_baseline)} baseline · latency ${esc(bc.latency ?? "—")}` : ""}</p></section>
         <section class="blk"><div class="lbl">Check time</div><div class="big" style="margin-top:6px">${fmt(total)}</div><p class="muted" style="font-size:12.5px;margin:6px 0 0">testbench + Yosys + nextpnr, all checks</p></section></div>
       <div class="cols" style="margin-top:22px"><section class="blk"><h3><span>Every check</span><span class="tag insforge">InsForge</span></h3>
         <div style="overflow-x:auto"><table class="checks"><thead><tr><th>#</th><th>Verdict</th><th style="text-align:right">Fmax</th><th style="text-align:right">vs base</th><th class="hide-s">Latency</th><th class="hide-s">LUT / FF / DSP</th></tr></thead><tbody>
         ${S.checks.map(c => `<tr data-k="check:${c.n}" class="${bc === c ? "best" : ""}"><td>${c.n}</td><td class="${c.accepted ? "ok" : "bad"}">${c.accepted ? "✓ accepted" : "✗ rejected"}</td><td style="text-align:right">${mhzTxt(c.fmax_mhz)}</td><td style="text-align:right">${S.checks[0] === c ? "1.00×" : xTxt(c.vs_baseline)}</td><td class="hide-s">${esc(c.latency ?? "—")}</td><td class="hide-s mono">${["LUT", "FF", "DSP"].map(k => (c.resources || {})[k] ?? "—").join(" / ")}</td></tr>`).join("")}</tbody></table></div>
         ${bc ? verilogBlock(bc, "v-best") : ""}</section>
         <div>${chartPanel()}</div></div>
       ${ab ? `<section class="blk"><h3><span>A/B: same designs, three ways</span><span class="tag eda">Fmax, MHz</span></h3>${ab}</section>` : ""}`
      + navBtns(); }
  function abTable() { const T = S.ab; if (!Array.isArray(T) || !T.length) return "";
    const rows = T.map(r => Array.isArray(r) ? r : r), obj = !Array.isArray(rows[0]);
    const cols = obj ? Object.keys(rows[0]) : rows[0], body = obj ? rows.map(r => cols.map(c => r[c])) : rows.slice(1);
    const label = c => String(c).replace(/_/g, " ").replace(/\bmhz\b/i, "MHz").replace(/^./, m => m.toUpperCase());
    return `<div style="overflow-x:auto"><table class="ab"><thead><tr>${cols.map((c, i) => `<th style="${i ? "text-align:right" : ""}">${esc(label(c))}</th>`).join("")}</tr></thead><tbody>
      ${body.map(r => `<tr>${r.map((v, i) => `<td class="${/fail/i.test(v) ? "bad" : i == r.length - 1 && i ? "ok" : ""}" style="${i ? "text-align:right" : ""}">${esc(v ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; }

  // ---- viewers (web-viewers' floorplan + Fmax chart); remounted after each full render
  function destroyViewers() { viewers.forEach(v => { try { v.destroy && v.destroy(); } catch (e) { } }); viewers = []; }
  async function mountViewers() {
    for (const el of document.querySelectorAll("#wfInner [data-viewer]")) {
      const kind = el.dataset.viewer;
      if (kind == "chart") {
        const m = await api.module("fmaxchart"); if (!el.isConnected) return;
        if (!m || !m.mountFmaxChart) { el.innerHTML = `<p class="empty">Chart viewer not available yet.</p>`; continue; }
        const fresh = S.checks.filter(c => FRESH.has(c.id)), shown = S.checks.filter(c => !FRESH.has(c.id));
        el.innerHTML = ""; const h = m.mountFmaxChart(el, shown, { baseline: base(), target: target() }); viewers.push(h);
        fresh.forEach((c, i) => setTimeout(() => { if (el.isConnected && h && h.push) h.push(c); }, REDUCED ? 0 : 450 + i * 300));
      }
      if (kind == "floorplan") {
        const [m, rep] = await Promise.all([api.module("floorplan"), api.data.loadReport ? Promise.resolve(api.data.loadReport(el.dataset.report)).catch(() => null) : null]);
        if (!el.isConnected) return;
        if (!m || !m.mountFloorplan) { el.innerHTML = `<p class="empty">Floorplan viewer not available yet.</p>`; continue; }
        if (!rep) { el.innerHTML = `<p class="empty">No placement report stored for this check.</p>`; continue; }
        el.innerHTML = ""; viewers.push(m.mountFloorplan(el, rep));
      }
    }
    FRESH.clear();
  }

  // ---- motion: entrance + count-up only when the step changes
  let lastScene = null, sceneT = 0, firstPaint = true;
  function motion(scene) {
    document.documentElement.style.setProperty("--now", `${Math.round(performance.now())}ms`);
    if (firstPaint) { firstPaint = false; const t = $("#wfSteps"); if (t && !REDUCED) { t.classList.add("intro"); setTimeout(() => t.classList.remove("intro"), 1800); } }
    const m = $("#wfInner"), fresh = scene !== lastScene; if (fresh) { lastScene = scene; sceneT = performance.now(); }
    const age = performance.now() - sceneT; if (REDUCED || age > 900) { m.classList.remove("enter"); return; }
    m.classList.add("enter"); m.style.setProperty("--age", `-${age}ms`);
    if (fresh) setTimeout(() => m.classList.remove("enter"), 950);
    textFx(m, age);
    m.querySelectorAll(".big,.wf-h1,.timer").forEach(el => countUp(el, age));
  }
  function splitWords(el, cls, gap, base0) { if (!el || el.dataset.split) return; el.dataset.split = 1;
    const words = el.textContent.split(/(\s+)/); el.textContent = "";
    let i = 0; for (const w of words) { if (!w) continue; if (/^\s+$/.test(w)) { el.append(" "); continue; }
      const o = document.createElement("span"); o.className = cls; const inn = document.createElement("span"); inn.textContent = w;
      o.style.setProperty("--d", `${base0 + i++ * gap}ms`); o.append(inn); el.append(o); } }
  const NOISE = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789#/<>_-+*";
  function decode(el, delay) { if (!el) return; const src = el.__src || (el.__src = el.textContent); if (!src.trim()) return;
    const D = 520, run = () => { if (!el.isConnected) return; const t = performance.now() - sceneT - delay;
      if (t >= D) { el.textContent = src; return; }
      const k = Math.max(0, Math.floor(src.length * t / D));
      el.textContent = src.slice(0, k) + src.slice(k).replace(/\S/g, () => NOISE[(Math.random() * NOISE.length) | 0]);
      requestAnimationFrame(run); };
    run(); }
  function textFx(m) {
    splitWords(m.querySelector(".wf-h1"), "tw", 70, 40);
    splitWords(m.querySelector(".lead"), "lw", 22, 180);
    const leafs = [...m.querySelectorAll(".eyebrow, .blk h3>span:first-child, .blk>.lbl:first-child, th")].filter(e => !e.children.length);
    leafs.forEach((e, i) => decode(e, 60 + Math.min(i, 10) * 45));
  }
  let nowTxt = "", nowT = 0;
  function typeNow() { const el = document.querySelector(".now-strip .txt"); if (!el || REDUCED) return; const full = el.textContent;
    if (full !== nowTxt) { nowTxt = full; nowT = performance.now(); }
    const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); while (w.nextNode()) nodes.push([w.currentNode, w.currentNode.nodeValue]);
    const run = () => { if (!el.isConnected) return; let n = Math.floor((performance.now() - nowT) / 14);
      for (const [node, v] of nodes) { node.nodeValue = v.slice(0, Math.max(0, n)); n -= v.length; }
      if (n < 0) requestAnimationFrame(run); };
    run(); }
  function countUp(el, age) {
    const nodes = [], walk = n => { for (const c of n.childNodes) { if (c.nodeType == 3) { if (/\d/.test(c.textContent)) { c.__orig = c.__orig || c.textContent; nodes.push(c); } } else if (c.nodeType == 1) walk(c); } };
    walk(el); if (!nodes.length) return;
    const D = 900, tick = () => { const t = Math.min(1, (performance.now() - sceneT) / D), e = 1 - Math.pow(1 - t, 3);
      for (const c of nodes) c.textContent = c.__orig.replace(/\d+(?:\.\d+)?/g, x => { const dec = (x.split(".")[1] || "").length; return (parseFloat(x) * e).toFixed(dec); });
      if (t < 1 && el.isConnected) requestAnimationFrame(tick); else for (const c of nodes) c.textContent = c.__orig; };
    if (age < D) tick(); }

  // ---- render
  function render() { if (!booted || gone) return;
    renderMeta(); renderRail(); destroyViewers();
    const m = $("#wfInner"), k = curKey(), s = stepOf(k);
    let h;
    if (S.err) h = `<div class="eyebrow">Run</div><h1 class="wf-h1">Could not load this run</h1><p class="lead">${esc(S.err)}</p><a class="btn ghost" href="/" data-route>← All runs</a>`;
    else if (k == "connect") h = connectView(s);
    else if (k == "design") h = designView(s);
    else if (k == "next") h = nextView(s);
    else if (k == "best") h = bestView(s);
    else h = checkView(s);
    m.innerHTML = h; motion(k); typeNow();
    m.querySelectorAll("details[data-key]").forEach(d => { if (OPEN.has(d.dataset.key)) d.open = true; });
    const fl = $("#wfFeed"); if (fl) fl.scrollTop = fl.scrollHeight;
    mountViewers();
  }
  function tick() { if (gone) return; renderMeta();   // cheap 1 s update: the clock, the NOW gap and the wait timer only
    const g = document.querySelector(".now-strip .gap"); if (g && S.lastAct) g.textContent = ` · ${fmt(now() - S.lastAct.t)} since the last update`;
    const w = $("#wfSince"); if (w && S.lastT) w.textContent = fmt(now() - S.lastT);
    if (S.live && !S.sample && S.lastT && now() - S.lastT >= LIVE_WINDOW && !tick.ended) { tick.ended = true; render(); } }
  function show(k, follow) { view = k; if (follow != null) setFollow(follow); render(); scrollTo(0, 0); }
  function go(d) { const all = steps(), i = all.findIndex(s => s.k == curKey()), n = all[Math.max(0, Math.min(all.length - 1, i + d))]; show(n.k, false); }

  function onCheck(c) { if (gone || !c) return;
    if (S.checks.some(x => (x.id != null && x.id == c.id) || (x.n == c.n && x.created_at == c.created_at))) return;
    if (c.n == null) c.n = S.checks.length + 1;
    S.checks.push(c); S.checks.sort((a, b) => a.n - b.n); FRESH.add(c.id);
    const f = feedFor(c); S.feed.push(...f); S.lastAct = { ...f.at(-1), t: now() }; S.lastT = tsOf(c) ?? now(); S.live = true; tick.ended = false;
    if (following()) view = `check:${c.n}`;
    render();
  }

  // ---- wiring (acts on press like the original, so a redraw between press and release never loses a click)
  const onDown = e => { if (e.button !== 0 || !e.target.closest) return;
    const sb = e.target.closest("#wfSteps button[data-k]"); if (sb) { e.preventDefault(); show(sb.dataset.k, false); return; }
    const nb = e.target.closest("button[data-go]"); if (nb && !nb.disabled) { e.preventDefault(); go(+nb.dataset.go); return; }
    const tr = e.target.closest("tr[data-k]"); if (tr) { e.preventDefault(); show(tr.dataset.k, false); } };
  const onToggle = e => { const d = e.target; if (d.tagName == "DETAILS" && d.dataset.key) { d.open ? OPEN.add(d.dataset.key) : OPEN.delete(d.dataset.key); } };
  const onFollow = e => { if (e.target.checked) { view = isLive() ? "next" : (S.checks.length ? `check:${S.checks.at(-1).n}` : "best"); render(); } };
  if (import.meta.env.DEV) window.__mdGuide = { S, onCheck, render };   // dev only: lets a test push a check by hand
  document.addEventListener("pointerdown", onDown);
  document.addEventListener("toggle", onToggle, true);
  $("#wfFollow")?.addEventListener("change", onFollow);

  (async () => {
    $("#wfRun").textContent = runId;
    $("#wfInner").innerHTML = `<p class="empty"><span class="wait"></span>Loading run ${esc(runId)}…</p>`;
    try {
      const d = await api.data.loadRun(runId); if (gone) return;
      if (!d) throw new Error(`No run with id ${runId}.`);
      S.data = d; S.info = d.design_info || {}; S.sample = !!d.sample; S.ab = api.data.AB_TABLE;
      S.checks = (d.checks || []).slice().sort((a, b) => (a.n ?? 0) - (b.n ?? 0) || (tsOf(a) ?? 0) - (tsOf(b) ?? 0));
      S.checks.forEach((c, i) => { if (c.n == null) c.n = i + 1; });
      rebuildFeed();
      const st = d.run && d.run.status; S.goal = d.run && d.run.goal;
      S.live = !S.sample && (st ? !/^(done|finish|complete|fail|cancel|error|stop|ended)/i.test(st) : (!S.checks.length || (S.lastT != null && now() - S.lastT < LIVE_WINDOW)));
      if (!S.checks.length && api.data.listRuns) Promise.resolve(api.data.listRuns()).then(rs => { const r = (rs || []).find(x => x.run_id == runId), t = r && Date.parse(r.created_at);
        if (t && !gone && !S.checks.length) { S.createdT = t / 1000; rebuildFeed(); render(); } }).catch(() => { });
      $("#wfRun").textContent = `${S.data.design || S.info.name || ""} · ${runId}`;
      document.title = `${S.data.design || S.info.name || "Run"} · Menu Desk`;
      api.setSample(S.sample);
    } catch (e) { S.err = e && e.message || String(e); }
    booted = true; render();
    ticker = setInterval(() => { if (!document.hidden) tick(); }, 1000);
    if (!S.err && api.data.subscribeRun) {
      try { const u = await api.data.subscribeRun(runId, onCheck); if (gone) { typeof u == "function" && u(); } else unsub = u; } catch (e) { console.warn("subscribeRun failed", e); }
    }
  })();

  return function destroy() { gone = true; clearInterval(ticker); destroyViewers();
    try { typeof unsub == "function" && unsub(); } catch (e) { }
    document.removeEventListener("pointerdown", onDown); document.removeEventListener("toggle", onToggle, true);
    $("#wfFollow")?.removeEventListener("change", onFollow); };
}
