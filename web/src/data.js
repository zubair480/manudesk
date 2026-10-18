// Menu Desk data layer (owner: web-data). Reads InsForge with the anon key and returns contract-shaped
// objects (see COORDINATION.md). Prefers a contract `checks` table if one exists, else maps md_checks +
// md_designs + md_runs. Empty, missing or erroring data falls back to fixtures/popcount.json (sample: true).
import { createClient } from "@insforge/sdk";

const ENV = (import.meta && import.meta.env) || (globalThis.process && globalThis.process.env) || {};
const BASE_URL = ENV.VITE_INSFORGE_URL, ANON_KEY = ENV.VITE_INSFORGE_ANON_KEY;
const BUCKET = "md-artifacts", EVENT = "check_inserted", POLL_MS = 3000;
const SAMPLE_RUN = "sample-popcount";

let client = null;
function db() {
  if (!client && BASE_URL && ANON_KEY) client = createClient({ baseUrl: BASE_URL, anonKey: ANON_KEY });
  return client;
}

// ---------- fixtures ----------
const fixtureCache = {}, NODE_FS = "node:fs/promises";
async function fixture(name) {
  if (name in fixtureCache) return fixtureCache[name];
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  let out = null;
  try {
    if (url.protocol === "file:") { const fs = await import(/* @vite-ignore */ NODE_FS); // node tests only
      out = JSON.parse(await fs.readFile(url, "utf8")); }
    else { const r = await fetch(url); out = r.ok ? await r.json() : null; }
  } catch (e) { out = null; }
  return (fixtureCache[name] = out);
}
const clone = o => JSON.parse(JSON.stringify(o));
async function sampleRun() { const f = await fixture("popcount.json"); return f ? { ...clone(f), sample: true } : null; }
async function sampleSummary() {
  const f = await sampleRun(); if (!f) return [];
  const best = Math.max(...f.checks.filter(c => c.accepted).map(c => c.fmax_mhz));
  return [{ run_id: f.run_id, design: f.design, n_checks: f.checks.length, best_mhz: best,
    baseline_mhz: f.design_info.baseline_mhz, created_at: f.checks[0].created_at, sample: true }];
}

// ---------- low-level reads ----------
async function q(build) {
  const c = db(); if (!c) throw new Error("InsForge env missing");
  const { data, error } = await build(c.database);
  if (error) throw new Error(error.message || String(error));
  return data || [];
}
let hasChecksTable = null; // null = unknown
async function checksTable() {
  if (hasChecksTable === null) {
    try { await q(d => d.from("checks").select("id").limit(1)); hasChecksTable = true; }
    catch (e) { hasChecksTable = false; }
  }
  return hasChecksTable;
}
let designsCache = null;
async function designs() {
  if (!designsCache) {
    const rows = await q(d => d.from("md_designs").select("name, top, summary, baseline_mhz, target_mhz, latency_budget, resource_budget"));
    designsCache = Object.fromEntries(rows.map(r => [r.name, r]));
  }
  return designsCache;
}

// ---------- mapping ----------
const num = v => (v === null || v === undefined || v === "" ? null : Number(v));
const fmtX = x => (x === null || !isFinite(x) ? null : `${x.toFixed(2)}x`);
function budgetsOf(d) { const b = (d && d.resource_budget) || {}; return { LUT: num(b.LUT), FF: num(b.FF), DSP: num(b.DSP) ?? 0 }; }
function designInfo(name, d, run) {
  return { name, summary: d ? d.summary : "", target_mhz: num(run && run.target_mhz) ?? num(d && d.target_mhz),
    baseline_mhz: num(d && d.baseline_mhz), latency_budget: num(d && d.latency_budget), resource_budget: budgetsOf(d) };
}
function reasonsOf(fix) {
  if (fix === null || fix === undefined) return [];
  if (Array.isArray(fix)) return fix.map(String);
  if (typeof fix === "string") return [fix];
  return Object.values(fix).map(String);
}
// md_checks row -> Check. `n` is the 1-based position in the run.
function mapMdCheck(r, n, d) {
  const mhz = num(r.mhz), base = num(d && d.baseline_mhz), x = num(r.x);
  const u = r.use || {};
  return {
    id: r.id, run_id: r.run_id, design: r.design, n, accepted: !!r.pass, stage: r.stage,
    reasons: reasonsOf(r.fix), fmax_mhz: mhz, baseline_mhz: base,
    vs_baseline: fmtX(x ?? (mhz && base ? mhz / base : null)), latency: num(r.lat), critical_path: r.path ?? null,
    resources: { LUT: num(u.LUT), FF: num(u.FF), DSP: num(u.DSP) ?? 0 }, budgets: budgetsOf(d),
    seconds: r.duration_ms === null || r.duration_ms === undefined ? null : Math.round(r.duration_ms / 100) / 10,
    verilog: r.verilog ?? null, report_key: r.artifact_key ?? null, created_at: r.created_at, source: r.source,
  };
}
// contract `checks` row -> Check (already shaped; fill gaps)
function mapContractCheck(r, n) {
  return { resources: {}, budgets: {}, verilog: null, report_key: null, ...r, n: r.n ?? n, reasons: reasonsOf(r.reasons) };
}
const byTime = (a, b) => String(a.created_at).localeCompare(String(b.created_at));

// Candidate Verilog lives in the private md-artifacts bucket as <artifact_key>/design.v. The anon key
// usually cannot read it; any failure leaves verilog null.
async function fillVerilog(checks) {
  const c = db(); if (!c) return;
  await Promise.all(checks.filter(k => !k.verilog && k.report_key && !k.report_key.startsWith("fixtures/")).map(async k => {
    try {
      const { data, error } = await withTimeout(c.storage.from(BUCKET).download(`${k.report_key}/design.v`), 4000);
      if (!error && data) k.verilog = await data.text();
    } catch (e) { /* keep null */ }
  }));
}
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]); }

// ---------- public API ----------
export async function listRuns() {
  try {
    if (await checksTable()) {
      const rows = await q(d => d.from("checks").select("run_id, design, fmax_mhz, baseline_mhz, accepted, created_at"));
      const runs = {};
      for (const r of rows) {
        if (!r.run_id) continue;
        const o = runs[r.run_id] ||= { run_id: r.run_id, design: r.design, n_checks: 0, best_mhz: null, baseline_mhz: num(r.baseline_mhz), created_at: r.created_at, sample: false };
        o.n_checks++; if (r.accepted && num(r.fmax_mhz) > (o.best_mhz ?? -1)) o.best_mhz = num(r.fmax_mhz);
        if (r.created_at < o.created_at) o.created_at = r.created_at;
      }
      const out = Object.values(runs).sort((a, b) => byTime(b, a));
      if (out.length) return out;
    }
    const [runs, checks, ds] = await Promise.all([
      q(d => d.from("md_runs").select("id, design, best_mhz, created_at").order("created_at", { ascending: false })),
      q(d => d.from("md_checks").select("run_id, mhz, pass").not("run_id", "is", null)),
      designs(),
    ]);
    if (!runs.length) return sampleSummary();
    return runs.map(r => {
      const mine = checks.filter(c => c.run_id === r.id);
      const best = num(r.best_mhz) ?? mine.filter(c => c.pass).reduce((m, c) => Math.max(m, num(c.mhz) ?? -1), -1);
      return { run_id: r.id, design: r.design, n_checks: mine.length, best_mhz: best >= 0 ? best : null,
        baseline_mhz: num(ds[r.design] && ds[r.design].baseline_mhz), created_at: r.created_at, sample: false };
    });
  } catch (e) {
    console.warn("[data] listRuns falling back to sample:", e.message);
    return sampleSummary();
  }
}

export async function loadRun(run_id) {
  if (!run_id || run_id === SAMPLE_RUN) return sampleRun();
  try {
    let design = null, checks = [], run = null;
    if (await checksTable()) {
      const rows = await q(d => d.from("checks").select("*").eq("run_id", run_id).order("created_at", { ascending: true }));
      checks = rows.map((r, i) => mapContractCheck(r, i + 1)); design = checks[0] && checks[0].design;
    }
    const ds = await designs();
    if (!checks.length) {
      const [runs, rows] = await Promise.all([
        q(d => d.from("md_runs").select("*").eq("id", run_id).limit(1)),
        q(d => d.from("md_checks").select("*").eq("run_id", run_id).order("created_at", { ascending: true })),
      ]);
      run = runs[0] || null; design = (run && run.design) || (rows[0] && rows[0].design);
      checks = rows.map((r, i) => mapMdCheck(r, i + 1, ds[r.design]));
      await fillVerilog(checks);
    }
    if (!run && !checks.length) return sampleRun();
    return { run_id, design, sample: false, run: run && { goal: run.goal, status: run.status, step: run.step, iteration: run.iteration },
      design_info: designInfo(design, ds[design], run), checks };
  } catch (e) {
    console.warn("[data] loadRun falling back to sample:", e.message);
    return sampleRun();
  }
}

// Realtime: trigger md_checks_notify_insert publishes `check_inserted` (payload = the new md_checks row) on
// channel `md_run:<run_id>` and on `md_checks` (all rows). Pass run_id null/"*" to get every new check.
// If the socket can't subscribe, falls back to polling md_checks every 3 s. Returns unsubscribe().
export async function subscribeRun(run_id, onCheck) {
  if (run_id === SAMPLE_RUN) return () => {};
  const c = db(); if (!c) return () => {};
  const all = !run_id || run_id === "*";
  const channel = all ? "md_checks" : `md_run:${run_id}`;
  const seen = new Set(); let count = 0, stopped = false, timer = null, lastTs = new Date().toISOString();
  try {
    const existing = await q(d => { let x = d.from("md_checks").select("id, created_at"); return all ? x : x.eq("run_id", run_id); });
    for (const r of existing) { seen.add(r.id); if (r.created_at > lastTs) lastTs = r.created_at; }
    count = existing.length;
  } catch (e) { /* start from zero */ }
  let ds = {}; try { ds = await designs(); } catch (e) { }

  const deliver = r => {
    if (stopped || !r || !r.id || seen.has(r.id)) return;
    if (!all && r.run_id !== run_id) return;
    seen.add(r.id); if (r.created_at > lastTs) lastTs = r.created_at;
    const check = mapMdCheck(r, ++count, ds[r.design]);
    fillVerilog([check]).finally(() => { if (!stopped) onCheck(check); });
  };
  // meta.channel arrives as "realtime:<channel>"
  const onMsg = msg => {
    const ch = msg && msg.meta && msg.meta.channel;
    if (ch && ch.replace(/^realtime:/, "") !== channel) return;
    const { meta, ...row } = msg || {}; deliver(row);
  };

  const catchUp = async () => {
    try {
      const rows = await q(d => { let x = d.from("md_checks").select("*").gte("created_at", lastTs).order("created_at", { ascending: true }); return all ? x : x.eq("run_id", run_id); });
      rows.forEach(deliver);
    } catch (e) { }
  };
  let polling = false;
  const poll = async () => { await catchUp(); if (polling && !stopped) timer = setTimeout(poll, POLL_MS); };
  const startPolling = () => {
    if (polling || stopped) return;
    console.warn(`[data] realtime unavailable for ${channel}, polling every ${POLL_MS / 1000}s`);
    polling = true; poll();
  };
  const stopPolling = () => { polling = false; if (timer) { clearTimeout(timer); timer = null; } };

  let realtime = false;
  try {
    const res = await withTimeout(c.realtime.subscribe(channel), 8000);
    if (res && res.ok) { c.realtime.on(EVENT, onMsg); realtime = true; }
  } catch (e) { }
  if (!realtime) startPolling();
  // a dropped socket degrades to polling until socket.io reconnects (and resubscribes); then one catch-up read
  const onDisc = () => startPolling();
  const onConn = () => { if (polling) { stopPolling(); catchUp(); } };
  if (realtime) { c.realtime.on("disconnect", onDisc); c.realtime.on("connect", onConn); }

  return () => {
    stopped = true; stopPolling();
    if (realtime) { c.realtime.off(EVENT, onMsg); c.realtime.off("disconnect", onDisc); c.realtime.off("connect", onConn); try { c.realtime.unsubscribe(channel); } catch (e) { } }
  };
}

// nextpnr report for the floorplan. `fixtures/...` keys load bundled fixtures; other keys try
// md-artifacts (<key> if it ends in .json, else <key>/report.json). Returns null when unavailable.
export async function loadReport(report_key) {
  if (!report_key) return null;
  if (report_key.startsWith("fixtures/")) return fixture(report_key.slice("fixtures/".length));
  const c = db(); if (!c) return null;
  const path = report_key.endsWith(".json") ? report_key : `${report_key}/report.json`;
  try {
    const { data, error } = await withTimeout(c.storage.from(BUCKET).download(path), 6000);
    if (error || !data) return null;
    return JSON.parse(await data.text());
  } catch (e) { return null; }
}

// Best result card: header row + rows (MHz: start / agent alone / agent + Menu Desk).
export const AB_TABLE = [
  ["Design", "Start", "Agent alone", "Agent + Menu Desk"],
  ["mac", "74.4", "135.1", "228.4"],
  ["fir8", "66.4", "142.6", "197.5"],
  ["popcount", "70.0", "183.2", "244.0"],
  ["crc32", "61.1", "FAIL", "191.1"],
  ["Correct", "4/4", "3/4", "4/4"],
  ["Mean speedup", "1.0x", "2.2x", "3.0x"],
];
