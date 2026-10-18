// md-run-start: queue an agent run for one design. Auth: x-manudesk-token.
// POST {"design": "mac", "goal"?: str, "target_mhz"?: num, "max_iterations"?: int} -> {"run_id"}
// md-run-step (called by the md-tick schedule or by hand) then advances the run one step at a time.

import { createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-manudesk-token',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const fail = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

function sameToken(got: string | null, want: string | undefined): boolean {
  if (!got || !want) return false;
  const a = new TextEncoder().encode(got), b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return fail(405, 'method', 'POST a JSON body');
  if (!sameToken(req.headers.get('x-manudesk-token'), Deno.env.get('MANUDESK_TOKEN'))) {
    return fail(401, 'unauthorized', 'send header x-manudesk-token');
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'body must be JSON: {"design": "<name>", "goal"?: "..."}');
  }
  const name = typeof body?.design === 'string' ? body.design.trim() : '';
  if (!name) return fail(400, 'design_required', 'field "design" (an md_designs name) is required');

  const db = createAdminClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL')!, apiKey: Deno.env.get('API_KEY')! }).database;
  const { data: rows, error: dErr } = await db.from('md_designs')
    .select('name, target_mhz, baseline_mhz').eq('name', name).limit(1);
  const design = rows?.[0];
  if (dErr) return fail(500, 'db', `md_designs lookup failed: ${dErr.message}`);
  if (!design) return fail(404, 'unknown_design', `no design "${name}" in md_designs`);

  const target = Number(body.target_mhz ?? design.target_mhz);
  if (!Number.isFinite(target) || target <= 0) return fail(400, 'bad_target', 'target_mhz must be a positive number');
  const maxIter = Math.max(1, Math.min(20, Math.trunc(Number(body.max_iterations ?? 6)) || 6));
  const goal = typeof body.goal === 'string' && body.goal.trim()
    ? body.goal.trim().slice(0, 2000)
    : `Raise Fmax of ${name} to ${target} MHz while passing the hidden testbench.`;

  const { data: inserted, error } = await db.from('md_runs').insert([{
    design: name, goal, target_mhz: target, max_iterations: maxIter,
    status: 'queued', step: 'plan', iteration: 0,
  }]).select('id, design, goal, target_mhz, max_iterations, status, step');
  const run = (inserted as any[] | null)?.[0];
  if (error || !run) return fail(500, 'db', `md_runs insert failed: ${error?.message}`);
  return json({ ok: true, run_id: run.id, run });
}
