// md-meta: measure whether each playbook rule helped (port of Crusoe-Forge tc/meta.py, DB data only,
// deterministic, no LLM). Fills md_rule_stats with one row per (rule, playbook version, design):
//   gain_pct  mean(best_mhz / baseline_mhz - 1) * 100 over the finished runs that used that version
//   rej_rate  rejected / (accepted + rejected) engineer candidates, pooled over those runs
//   reached   share of those runs with status 'reached'
//   iters     mean iterations to target over the runs that reached it
//   n_runs    runs counted
// A rule is "available" to a run when it is in the playbook version the run used (md_runs.playbook_version).
// Rule '_playbook' is the whole-version aggregate; playbook_version 0 = runs with no playbook (control).
// The response also gives each rule's same-design with/without comparison and a category
// (benefit | harmful | neutral | unproven) from tc/meta.py's fixed thresholds.
//
// Header: x-manudesk-token: <MANUDESK_TOKEN>. POST body optional: {"dry_run": true} computes without writing.

import { createAdminClient } from 'npm:@insforge/sdk';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-manudesk-token',
};

const env = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function fail(status: number, code: string, message: string, hint?: string): Response {
  return json({ ok: false, error: { code, message, hint } }, status);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkToken(req: Request): Response | null {
  const expected = Deno.env.get('MANUDESK_TOKEN');
  if (!expected) return fail(500, 'SERVER_MISCONFIGURED', 'secret MANUDESK_TOKEN is not set');
  if (!safeEqual(req.headers.get('x-manudesk-token') ?? '', expected)) {
    return fail(401, 'UNAUTHORIZED', 'missing or invalid x-manudesk-token header');
  }
  return null;
}

async function readJson(req: Request): Promise<Record<string, any>> {
  if (req.method === 'GET') return Object.fromEntries(new URL(req.url).searchParams);
  try {
    return (await req.json()) ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- rules (same parser as md-reflect)
const FINISHED = ['reached', 'exhausted', 'failed'];
// Decision thresholds from tc/meta.py (pooled across designs, equal weight per design).
const MIN_WITH = 2, MIN_WITHOUT = 1, MIN_DESIGNS = 2, GAIN_PP = 2.0, REJ_PP = 0.10;

const norm = (s: string) =>
  s.replace(/[‐-—]/g, '-').replace(/ /g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const RULE_RE = /^\s*\d+\.\s+(?:\*\*(.+?)\*\*|([^:\n]{6,90}):)\s*(.*)$/;

function ruleId(title: string): string {
  return norm(title).replace(/\.$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'rule';
}

/** Numbered rules of a playbook body: [{id, title}]. Code blocks and seed/hand-written sections are skipped. */
function parseRules(md: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  let heading = '', inCode = false;
  for (const line of (md ?? '').split('\n')) {
    if (line.trim().startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (line.startsWith('#')) { heading = line.toLowerCase(); continue; }
    if (/seed|hand-|verified snippets/.test(heading)) continue;
    if (!/^\s*\d+\.\s/.test(line)) continue;
    const m = line.match(RULE_RE);
    const title = (m ? (m[1] ?? m[2]) : line.replace(/^\s*\d+\.\s*/, '').split(/\s+/).slice(0, 8).join(' ')).trim();
    const id = ruleId(title);
    if (!out.some((r) => r.id === id)) out.push({ id, title });
  }
  return out;
}

// ---------------------------------------------------------------- metrics
type Run = {
  id: string; design: string; version: number; status: string; iteration: number | null;
  gain: number | null; accepted: number; rejected: number; reached: boolean;
};

const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const rej = (r: Run) => (r.accepted + r.rejected ? r.rejected / (r.accepted + r.rejected) : null);
const round = (v: number | null, d = 3) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function stats(rs: Run[]) {
  const acc = rs.reduce((a, r) => a + r.accepted, 0), rj = rs.reduce((a, r) => a + r.rejected, 0);
  return {
    gain_pct: round(mean(rs.map((r) => r.gain))),
    rej_rate: round(acc + rj ? rj / (acc + rj) : null),
    reached: round(rs.length ? rs.filter((r) => r.reached).length / rs.length : null),
    iters: round(mean(rs.filter((r) => r.reached).map((r) => r.iteration))),
    n_runs: rs.length,
  };
}

/** tc/meta.py measure(): same-design with/without deltas, pooled with equal weight per design. */
function measure(has: (r: Run) => boolean, runs: Run[]) {
  const scored = runs.filter((r) => r.gain !== null && r.accepted + r.rejected > 0);
  const byDesign = new Map<string, [Run[], Run[]]>();
  for (const r of scored) {
    if (!byDesign.has(r.design)) byDesign.set(r.design, [[], []]);
    byDesign.get(r.design)![has(r) ? 0 : 1].push(r);
  }
  const matched = [...byDesign].filter(([, [a, b]]) => a.length && b.length);
  const w = matched.flatMap(([, [a]]) => a), wo = matched.flatMap(([, [, b]]) => b);
  const pooled = (f: (r: Run) => number | null) => {
    const ds: number[] = [];
    for (const [, [a, b]] of matched) {
      const ma = mean(a.map(f)), mb = mean(b.map(f));
      if (ma !== null && mb !== null) ds.push(ma - mb);
    }
    return mean(ds);
  };
  const dGain = pooled((r) => r.gain), dRej = pooled(rej), dReach = pooled((r) => (r.reached ? 1 : 0));
  let category: string;
  if (w.length < MIN_WITH || wo.length < MIN_WITHOUT || dGain === null) category = 'unproven';
  else if ((dGain >= GAIN_PP && (dRej === null || dRej <= REJ_PP)) || (dRej !== null && dRej <= -REJ_PP && dGain >= -GAIN_PP / 2)) category = 'benefit';
  else if ((dGain <= -GAIN_PP && (dRej === null || dRej >= 0)) || (dRej !== null && dRej >= REJ_PP && dGain <= 0)) category = 'harmful';
  else category = 'neutral';
  if ((category === 'benefit' || category === 'harmful') && matched.length < MIN_DESIGNS) category = 'unproven';
  return {
    n_with: w.length, n_without: wo.length, designs: matched.map(([d]) => d).sort(),
    d_gain_pp: round(dGain, 2), d_rej: round(dRej), d_reached: round(dReach), category,
  };
}

// ---------------------------------------------------------------- handler
export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const denied = checkToken(req);
  if (denied) return denied;
  const t0 = Date.now();
  const body = await readJson(req);
  const dryRun = body.dry_run === true || body.dry_run === 'true';

  let db;
  try {
    db = createAdminClient({ baseUrl: env('INSFORGE_BASE_URL'), apiKey: env('API_KEY') }).database;
  } catch (e) {
    return fail(500, 'SERVER_MISCONFIGURED', String((e as Error).message));
  }
  const dbErr = (what: string, e: any) =>
    fail(500, 'DB_ERROR', `${what}: ${e?.message ?? JSON.stringify(e)}`, 'do the md_* tables exist? (owned by the schema session)');

  const [pb, rr, ds] = await Promise.all([
    db.from('md_playbooks').select('version, body').order('version', { ascending: true }).limit(1000),
    db.from('md_runs').select('id, design, status, iteration, best_mhz, playbook_version')
      .in('status', FINISHED).order('created_at', { ascending: true }).limit(5000),
    db.from('md_designs').select('name, baseline_mhz').limit(1000),
  ]);
  if (pb.error) return dbErr('reading md_playbooks', pb.error);
  if (rr.error) return dbErr('reading md_runs', rr.error);
  if (ds.error) return dbErr('reading md_designs', ds.error);

  const finished = rr.data ?? [];
  if (!finished.length) {
    return json({ ok: true, status: 'no evidence yet', detail: 'no finished md_runs', rows_written: 0, ms: Date.now() - t0 });
  }

  // Candidate counts per run (engineer iterations judged by the checker).
  const counts = new Map<string, { a: number; r: number }>();
  const ids = finished.map((r: any) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('md_iterations').select('run_id, accepted')
      .in('run_id', ids.slice(i, i + 200)).limit(20000);
    if (error) return dbErr('reading md_iterations', error);
    for (const it of data ?? []) {
      if (it.accepted === null || it.accepted === undefined) continue;
      const c = counts.get(it.run_id) ?? { a: 0, r: 0 };
      it.accepted ? c.a++ : c.r++;
      counts.set(it.run_id, c);
    }
  }

  const baseline = new Map<string, number>((ds.data ?? []).map((d: any) => [d.name, Number(d.baseline_mhz)]));
  const runs: Run[] = finished.map((r: any) => {
    const b = baseline.get(r.design), best = r.best_mhz === null ? null : Number(r.best_mhz);
    const c = counts.get(r.id) ?? { a: 0, r: 0 };
    return {
      id: r.id, design: r.design, version: r.playbook_version ?? 0, status: r.status, iteration: r.iteration,
      gain: b && best ? (best / b - 1) * 100 : b ? 0 : null,   // nothing better than baseline = 0 % gain
      accepted: c.a, rejected: c.r, reached: r.status === 'reached',
    };
  });

  const rulesByVersion = new Map<number, { id: string; title: string }[]>(
    (pb.data ?? []).map((p: any) => [p.version, parseRules(p.body)]));
  const has = (ruleIdent: string) => (r: Run) => (rulesByVersion.get(r.version) ?? []).some((x) => x.id === ruleIdent);

  // Per (rule, version, design) rows.
  const computedAt = new Date().toISOString();
  const rows: any[] = [];
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = `${r.version}\u0000${r.design}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  for (const [k, rs] of groups) {
    const [v, design] = k.split('\u0000');
    const version = Number(v);
    const s = stats(rs);
    rows.push({ rule_id: '_playbook', playbook_version: version, design, ...s, computed_at: computedAt });
    for (const rule of rulesByVersion.get(version) ?? []) {
      rows.push({ rule_id: rule.id, playbook_version: version, design, ...s, computed_at: computedAt });
    }
  }

  // Per-rule comparison across versions (the tc/meta.py evidence line, as numbers).
  const titles = new Map<string, string>();
  for (const rs of rulesByVersion.values()) for (const r of rs) titles.set(r.id, r.title);
  const evidence = [...titles].map(([id, title]) => ({ rule_id: id, title, ...measure(has(id), runs) }));

  // playbook_version is an FK to md_playbooks: control rows (version 0, no playbook) stay in the response only.
  const storable = rows.filter((r) => rulesByVersion.has(r.playbook_version));
  let written = 0;
  if (!dryRun && storable.length) {
    // Deterministic recompute: replace the whole table.
    const del = await db.from('md_rule_stats').delete().gte('n_runs', 0);
    if (del.error) return dbErr('clearing md_rule_stats', del.error);
    for (let i = 0; i < storable.length; i += 500) {
      const ins = await db.from('md_rule_stats').insert(storable.slice(i, i + 500));
      if (ins.error) return dbErr('writing md_rule_stats', ins.error);
      written += Math.min(500, storable.length - i);
    }
  }

  const cat = (c: string) => evidence.filter((e) => e.category === c).length;
  return json({
    ok: true,
    status: 'computed',
    dry_run: dryRun,
    finished_runs: runs.length,
    scored_runs: runs.filter((r) => r.gain !== null && r.accepted + r.rejected > 0).length,
    playbook_versions: [...rulesByVersion.keys()],
    rules: titles.size,
    categories: { benefit: cat('benefit'), neutral: cat('neutral'), unproven: cat('unproven'), harmful: cat('harmful') },
    rows_written: written,
    rows: rows.length <= 50 ? rows : undefined,
    evidence,
    thresholds: { MIN_WITH, MIN_WITHOUT, MIN_DESIGNS, GAIN_PP, REJ_PP },
    ms: Date.now() - t0,
  });
}
