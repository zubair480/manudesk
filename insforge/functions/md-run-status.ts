// md-run-status (public read): one run, its iterations without the big prompts/Verilog, and its best check.
// GET ?run_id=<uuid>  or  POST {"run_id": "<uuid>"}. Verilog is never returned (md_iterations is private).

import { createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const fail = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep what a UI or agent needs from a role's output; drop raw replies. */
function slimOutput(role: string, o: any) {
  if (!o) return o;
  if (role === 'planner') return { done_contract: o.done_contract, target_event: o.target_event ?? null, parse_error: o.parse_error ?? null };
  if (role === 'analyst') return { bottleneck: o.bottleneck, recommendation: o.recommendation, expected_gain: o.expected_gain };
  const { raw_tail: _drop, ...rest } = o;
  return rest;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const runId = String(body?.run_id ?? url.searchParams.get('run_id') ?? '');
  if (!UUID.test(runId)) return fail(400, 'run_id_required', 'pass run_id (uuid) as ?run_id= or in the JSON body');

  const db = createAdminClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL')!, apiKey: Deno.env.get('API_KEY')! }).database;
  const { data: runs, error } = await db.from('md_runs')
    .select('id, design, goal, target_mhz, max_iterations, status, step, iteration, best_mhz, best_check_id, ' +
      'playbook_version, done_contract, error, created_at, updated_at')
    .eq('id', runId).limit(1);
  if (error) return fail(500, 'db', error.message);
  const run = runs?.[0];
  if (!run) return fail(404, 'unknown_run', `no run ${runId}`);

  const { data: its } = await db.from('md_iterations')
    .select('id, n, role, model, prompt_tokens, completion_tokens, output, check_id, accepted, created_at')
    .eq('run_id', runId).order('created_at', { ascending: true }).limit(500);
  const rows = (its ?? []) as any[];

  let bestCheck = null;
  if (run.best_check_id) {
    const { data } = await db.from('md_checks')
      .select('id, design, source, pass, stage, mhz, x, lat, path, use, fix, duration_ms, artifact_key, created_at')
      .eq('id', run.best_check_id).limit(1);
    bestCheck = data?.[0] ?? null;
  }
  const bestRow = rows.filter((r) => r.role === 'engineer' && r.accepted).at(-1);
  if (!bestCheck && bestRow?.output?.check) bestCheck = { id: null, from_iteration: bestRow.n, ...bestRow.output.check };

  const tokens = rows.reduce((t, r) => ({ prompt: t.prompt + (r.prompt_tokens ?? 0), completion: t.completion + (r.completion_tokens ?? 0) }),
    { prompt: 0, completion: 0 });
  return json({
    ok: true,
    run,
    best_check: bestCheck,
    tokens,
    iterations: rows.map((r) => ({
      id: r.id, n: r.n, role: r.role, model: r.model, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens,
      check_id: r.check_id, accepted: r.accepted, created_at: r.created_at,
      output: slimOutput(r.role, r.output),
    })),
  });
}
