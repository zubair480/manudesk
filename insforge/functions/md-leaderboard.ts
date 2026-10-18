// md-leaderboard (public read): the best passing check per design, against its baseline and target.
// GET (optional ?design=<name>). "who" is the check's source: mcp (an outside agent), agent (a run), baseline.

import { createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DSP_CEILING_MHZ = 225;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const only = new URL(req.url).searchParams.get('design');
  const db = createAdminClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL')!, apiKey: Deno.env.get('API_KEY')! }).database;

  let dq = db.from('md_designs').select('name, baseline_mhz, target_mhz').order('name', { ascending: true }).limit(200);
  if (only) dq = dq.eq('name', only);
  const { data: designs, error } = await dq;
  if (error) return json({ ok: false, error: { code: 'db', message: error.message } }, 500);

  // One small ordered query per design (index md_checks_leaderboard_idx), so we never scan every check.
  const rows = await Promise.all((designs ?? []).map(async (d: any) => {
    const { data } = await db.from('md_checks')
      .select('id, source, run_id, mhz, x, lat, use, created_at')
      .eq('design', d.name).eq('pass', true).gt('mhz', 0)
      .order('mhz', { ascending: false }).order('created_at', { ascending: true }).limit(1);
    const best = data?.[0] ?? null;
    // nextpnr cannot time the multiplier array inside an ECP5 DSP; the datasheet caps it at 225 MHz
    const eff = best ? (Number(best.use?.DSP) > 0 ? Math.min(Number(best.mhz), DSP_CEILING_MHZ) : Number(best.mhz)) : null;
    return {
      design: d.name, baseline_mhz: Number(d.baseline_mhz), target_mhz: Number(d.target_mhz),
      best_mhz: best ? Number(best.mhz) : null,
      effective_mhz: eff,
      x: best?.x != null ? Number(best.x) : null,
      reached: eff != null && eff >= Number(d.target_mhz),
      who: best?.source ?? null, run_id: best?.run_id ?? null, check_id: best?.id ?? null,
      lat: best?.lat ?? null, use: best?.use ?? null, at: best?.created_at ?? null,
    };
  }));
  return json({ ok: true, designs: rows });
}
