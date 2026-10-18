// md-tick: called every minute by the md-tick schedule. Picks up to N queued/running md_runs (oldest
// first, skipping runs touched in the last ~20 s), claims each one by bumping updated_at, and calls
// md-run-step for it. Bounded: it answers within wait_ms (the scheduler cuts calls off at ~30 s); steps
// still running then are reported as pending and left to finish.
//
// POST body (all optional): {"limit": 3, "skip_seconds": 20, "wait_ms": 20000, "step_timeout_ms": 90000}
// Header: x-manudesk-token: <MANUDESK_TOKEN>

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

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const denied = checkToken(req);
  if (denied) return denied;

  const t0 = Date.now();
  const body = await readJson(req);
  const limit = clamp(body.limit, 1, 10, 3);
  const skipSeconds = clamp(body.skip_seconds, 0, 600, 20);
  const stepTimeout = clamp(body.step_timeout_ms, 1000, 120_000, 90_000);
  const waitMs = clamp(body.wait_ms, 1000, 27_000, 20_000);

  let base: string, apiKey: string, token: string;
  try {
    base = env('INSFORGE_BASE_URL').replace(/\/$/, '');
    apiKey = env('API_KEY');
    token = env('MANUDESK_TOKEN');
  } catch (e) {
    return fail(500, 'SERVER_MISCONFIGURED', String((e as Error).message));
  }
  const db = createAdminClient({ baseUrl: base, apiKey }).database;

  const cutoff = new Date(Date.now() - skipSeconds * 1000).toISOString();
  const { data: candidates, error } = await db
    .from('md_runs')
    .select('id, design, status, step, iteration, updated_at')
    .in('status', ['queued', 'running'])
    .lt('updated_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) {
    return fail(500, 'DB_ERROR', `reading md_runs failed: ${error.message ?? JSON.stringify(error)}`,
      'does the md_runs table exist? (owned by the schema session)');
  }

  const skipped: { run_id: string; why: string }[] = [];
  const claimed: any[] = [];
  for (const r of candidates ?? []) {
    // Optimistic claim: only one tick wins a run, even if two ticks overlap.
    const { data: won, error: cerr } = await db
      .from('md_runs')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', r.id)
      .eq('updated_at', r.updated_at)
      .select('id');
    if (cerr) skipped.push({ run_id: r.id, why: `claim failed: ${cerr.message ?? 'db error'}` });
    else if (!won?.length) skipped.push({ run_id: r.id, why: 'claimed by another tick' });
    else claimed.push(r);
  }

  const steps = claimed.map(async (r) => {
    const s0 = Date.now();
    const before = { status: r.status, step: r.step, iteration: r.iteration };
    try {
      const res = await fetch(`${base}/functions/md-run-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-manudesk-token': token },
        body: JSON.stringify({ run_id: r.id }),
        signal: AbortSignal.timeout(stepTimeout),
      });
      const text = await res.text();
      let out: any = null;
      try { out = JSON.parse(text); } catch { out = { raw: text.slice(0, 500) }; }
      const run = out?.run ?? out;
      return {
        run_id: r.id, design: r.design, http: res.status, ok: res.ok && out?.ok !== false, before,
        after: { status: run?.status ?? null, step: run?.step ?? null, iteration: run?.iteration ?? null },
        error: res.ok ? undefined : (out?.error ?? out),
        ms: Date.now() - s0,
      };
    } catch (e) {
      const err = e as Error;
      return {
        run_id: r.id, design: r.design, http: null, ok: false, before,
        error: err.name === 'TimeoutError' ? `md-run-step did not answer in ${stepTimeout} ms` : String(err.message),
        ms: Date.now() - s0,
      };
    }
  });

  // The scheduler gives up on a call after ~30 s, but an engineer step can take ~60 s. Wait at most waitMs,
  // then answer; slower steps are not aborted (md-run-step keeps working) and are reported as pending.
  const pendingAfter = (r: any) => new Promise((resolve) => setTimeout(() => resolve({
    run_id: r.id, design: r.design, ok: true, pending: true,
    detail: `md-run-step still working after ${waitMs} ms; not aborted`,
  }), Math.max(0, waitMs - (Date.now() - t0))));
  const advanced = await Promise.all(steps.map((p, i) => Promise.race([p, pendingAfter(claimed[i])])));

  return json({
    ok: true,
    picked: claimed.length,
    advanced,
    skipped,
    limit,
    skip_seconds: skipSeconds,
    ms: Date.now() - t0,
    note: claimed.length ? undefined : 'no queued/running run older than skip_seconds',
  });
}
