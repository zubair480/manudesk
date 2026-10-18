// runs.js — the runs list at `/`: every run a coding agent made through Menu Desk MCP, newest first.
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mhzTxt = v => v == null || v === "" || isNaN(+v) ? "—" : (+v).toFixed(1);
const when = t => { const d = new Date(t); return isNaN(d) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); };

export function mountRuns(api) {
  const m = document.querySelector("#wfInner");
  let gone = false;
  document.title = "Runs · Menu Desk";
  document.querySelector("#wfRun").textContent = "";
  document.querySelector("#wfMeta").innerHTML = "";
  m.innerHTML = `<p class="empty"><span class="wait"></span>Loading runs…</p>`;
  (async () => {
    let runs = [], err = null;
    try { runs = (await api.data.listRuns()) || []; } catch (e) { err = e && e.message || String(e); }
    if (gone) return;
    runs = runs.slice().sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
    api.setSample(runs.length > 0 && runs.every(r => r.sample));
    const best = runs.reduce((a, r) => r.best_mhz && r.baseline_mhz && (!a || r.best_mhz / r.baseline_mhz > a.best_mhz / a.baseline_mhz) ? r : a, null);
    m.innerHTML = `<div class="eyebrow">Menu Desk runs</div><h1 class="wf-h1">Every run, newest first</h1>
      <p class="lead">Each run is a coding agent using only the Menu Desk MCP: it gets a design, submits Verilog, and every candidate is checked by a hidden testbench and measured by real place and route.</p>
      <div class="tags"><span class="tag agent">Coding agent</span><span class="tag menudesk">Menu Desk MCP</span><span class="tag eda">Yosys + nextpnr</span><span class="tag insforge">InsForge</span></div>
      ${runs.length ? `<div class="result" style="margin-bottom:22px">
        <section class="blk"><div class="lbl">Runs</div><div class="big" style="margin-top:6px">${runs.length}</div></section>
        <section class="blk"><div class="lbl">Checks</div><div class="big" style="margin-top:6px">${runs.reduce((a, r) => a + (+r.n_checks || 0), 0)}</div></section>
        <section class="blk"><div class="lbl">Best speed-up</div><div class="big ok" style="margin-top:6px">${best ? (best.best_mhz / best.baseline_mhz).toFixed(2) + "×" : "—"}</div><p class="muted" style="font-size:12.5px;margin:6px 0 0">${best ? esc(best.design) : ""}</p></section>
        <section class="blk"><div class="lbl">Best Fmax</div><div class="big" style="margin-top:6px">${mhzTxt(Math.max(0, ...runs.map(r => +r.best_mhz || 0)) || null)}<small>MHz</small></div></section></div>` : ""}
      <section class="blk"><h3><span>Runs</span><span class="muted" style="font:500 11px var(--mono)">${runs.length} total</span></h3>
        ${err ? `<p class="empty">Could not load runs: ${esc(err)}</p>` : !runs.length ? `<p class="empty">No runs yet. Connect a coding agent to Menu Desk MCP and its checks show up here live.</p>`
        : `<div style="overflow-x:auto"><table class="runs"><thead><tr><th>Design</th><th style="text-align:right">Checks</th><th style="text-align:right" class="hide-s">Baseline</th><th style="text-align:right">Best Fmax</th><th style="text-align:right" class="hide-s">Speed-up</th><th class="hide-s">Started</th></tr></thead><tbody>
          ${runs.map(r => `<tr data-href="/runs/${encodeURIComponent(r.run_id)}"><td><a href="/runs/${encodeURIComponent(r.run_id)}" data-route><b>${esc(r.design || "—")}</b></a>${r.sample ? ` <span class="sample-badge sm">sample</span>` : ""}<div class="mono muted run-id">${esc(String(r.run_id).slice(0, 8))}</div></td>
            <td style="text-align:right">${r.n_checks ?? "—"}</td><td style="text-align:right" class="hide-s">${mhzTxt(r.baseline_mhz)}</td>
            <td style="text-align:right" class="${r.best_mhz && r.baseline_mhz && r.best_mhz > r.baseline_mhz ? "ok" : ""}"><b>${mhzTxt(r.best_mhz)}</b> <span class="muted">MHz</span></td>
            <td style="text-align:right" class="hide-s">${r.best_mhz && r.baseline_mhz ? (r.best_mhz / r.baseline_mhz).toFixed(2) + "×" : "—"}</td><td class="hide-s">${when(r.created_at)}</td></tr>`).join("")}</tbody></table></div>`}
      </section>`;
    m.classList.add("enter"); setTimeout(() => m.classList.remove("enter"), 950);
  })();
  const onDown = e => { if (e.button !== 0 || !e.target.closest || e.target.closest("a")) return; const tr = e.target.closest("tr[data-href]"); if (tr) api.navigate(tr.dataset.href); };
  document.addEventListener("click", onDown);
  return () => { gone = true; document.removeEventListener("click", onDown); };
}
