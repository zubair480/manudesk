// md-baselines: re-check every md_designs row's start Verilog on the compute machine and keep baseline_mhz
// current. POSTs {"name", "verilog", "source": "baseline"} to MANUDESK_COMPUTE_URL/api/check (bearer
// MANUDESK_TOKEN); the compute server logs the md_checks row. baseline_mhz is updated only on a passing
// result. Compute down or cold (it scales to zero) is reported per design as check_unavailable, never as a
// design failure, and never fails the whole run.
//
// Header: x-manudesk-token: <MANUDESK_TOKEN>. POST body optional: {"designs": ["mac"], "timeout_ms": 120000}

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

const CONCURRENCY = 3;

async function check(computeUrl: string, token: string, d: any, timeoutMs: number) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${computeUrl}/api/check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: d.name, verilog: d.start_verilog, source: 'baseline' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let out: any = null;
    try { out = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !out || typeof out !== 'object') {
      // 5xx / gateway / non-JSON = the checker did not run: unavailable, not a design failure.
      return { status: 'check_unavailable', http: res.status, detail: (out?.error ?? text).toString().slice(0, 300), ms: Date.now() - t0 };
    }
    return { status: out.pass ? 'pass' : 'fail', result: out, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error;
    return {
      status: 'check_unavailable',
      detail: err.name === 'TimeoutError' ? `compute did not answer in ${timeoutMs} ms (cold start?)` : String(err.message).slice(0, 300),
      ms: Date.now() - t0,
    };
  }
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const denied = checkToken(req);
  if (denied) return denied;
  const t0 = Date.now();
  const body = await readJson(req);
  const only: string[] | null = Array.isArray(body.designs) ? body.designs.map(String) : null;
  const timeoutMs = Math.min(300_000, Math.max(5_000, Number(body.timeout_ms) || 120_000));

  let db, computeUrl: string, token: string;
  try {
    db = createAdminClient({ baseUrl: env('INSFORGE_BASE_URL'), apiKey: env('API_KEY') }).database;
    computeUrl = env('MANUDESK_COMPUTE_URL').replace(/\/$/, '');
    token = env('MANUDESK_TOKEN');
  } catch (e) {
    return fail(500, 'SERVER_MISCONFIGURED', String((e as Error).message));
  }

  let q = db.from('md_designs').select('name, baseline_mhz, start_verilog').order('name', { ascending: true }).limit(1000);
  if (only) q = q.in('name', only);
  const { data: designs, error } = await q;
  if (error) {
    return fail(500, 'DB_ERROR', `reading md_designs: ${error.message ?? JSON.stringify(error)}`,
      'does md_designs exist and is it seeded? (owned by the schema session)');
  }
  if (!designs?.length) return json({ ok: true, status: 'no designs', results: [], ms: Date.now() - t0 });

  const results: any[] = [];
  const queue = [...designs];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      if (!d.start_verilog) {
        results.push({ design: d.name, status: 'skipped', detail: 'no start_verilog' });
        continue;
      }
      const r: any = await check(computeUrl, token, d, timeoutMs);
      const row: any = { design: d.name, status: r.status, old_mhz: d.baseline_mhz, ms: r.ms };
      if (r.status === 'pass') {
        const mhz = Number(r.result.mhz);
        row.mhz = Number.isFinite(mhz) ? mhz : null;
        row.lat = r.result.lat ?? null;
        if (row.mhz !== null) {
          const up = await db.from('md_designs').update({ baseline_mhz: row.mhz, updated_at: new Date().toISOString() }).eq('name', d.name);
          row.updated = !up.error;
          if (up.error) row.detail = `update failed: ${up.error.message ?? 'db error'}`;
        } else {
          row.updated = false;
          row.detail = 'pass without an mhz value';
        }
      } else if (r.status === 'fail') {
        row.stage = r.result.stage ?? null;
        row.fix = r.result.fix ?? null;
        row.updated = false;
      } else {
        row.http = r.http;
        row.detail = r.detail;
        row.updated = false;
      }
      results.push(row);
    }
  }));

  results.sort((a, b) => a.design.localeCompare(b.design));
  const n = (s: string) => results.filter((r) => r.status === s).length;
  return json({
    ok: true,
    status: n('check_unavailable') === results.length ? 'compute_unavailable' : 'checked',
    counts: { pass: n('pass'), fail: n('fail'), check_unavailable: n('check_unavailable'), skipped: n('skipped') },
    updated: results.filter((r) => r.updated).map((r) => r.design),
    results,
    ms: Date.now() - t0,
  });
}
