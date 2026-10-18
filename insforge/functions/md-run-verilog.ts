// md-run-verilog (public read): the Verilog an agent run produced, for the dashboard's code view.
// GET ?run_id=<uuid>[&n=<iteration>] -> {start, iterations: [{n, id, verilog, accepted, mhz, pass}]}.
// Candidate Verilog is the agent's own work, so it is fine to show; the hidden testbench (tb.v) is never in
// the database, so it can't leak from here.

import { createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const fail = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const runId = url.searchParams.get('run_id') ?? '';
  if (!UUID.test(runId)) return fail(400, 'run_id_required', 'pass ?run_id=<uuid>');
  const n = url.searchParams.get('n');

  const db = createAdminClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL')!, apiKey: Deno.env.get('API_KEY')! }).database;
  const { data: runs, error } = await db.from('md_runs').select('id, design').eq('id', runId).limit(1);
  if (error) return fail(500, 'db', error.message);
  const run = runs?.[0];
  if (!run) return fail(404, 'unknown_run', `no run ${runId}`);

  const { data: designs } = await db.from('md_designs').select('start_verilog').eq('name', run.design).limit(1);

  let q = db.from('md_iterations').select('id, n, verilog, accepted, output, created_at')
    .eq('run_id', runId).eq('role', 'engineer').order('created_at', { ascending: true }).limit(200);
  if (n != null && /^\d+$/.test(n)) q = q.eq('n', Number(n));
  const { data: rows, error: iErr } = await q;
  if (iErr) return fail(500, 'db', iErr.message);

  return json({
    ok: true,
    design: run.design,
    start: designs?.[0]?.start_verilog ?? null,
    iterations: (rows ?? []).filter((r: any) => r.verilog).map((r: any) => ({
      id: r.id, n: r.n, verilog: r.verilog, accepted: r.accepted, created_at: r.created_at,
      pass: r.output?.check?.pass ?? null, mhz: r.output?.check?.mhz ?? null,
    })),
  });
}
