// md-reflect: rewrite the FPGA playbook from what finished runs actually measured (port of Crusoe-Forge
// tc/reflector.py). Evidence = finished md_runs not yet reflected on, their accepted/rejected engineer
// iterations and their md_checks. The AI gateway (OpenRouter) proposes the next playbook; then a CODE gate
// drops every rule that has no measured number, has a number not in the evidence or the previous playbook,
// has under 60% of its key words in the evidence, or names a design. Code blocks are stripped (general mode:
// the learned playbook with design-specific snippets hurt on held-out designs in Crusoe-Forge's eval).
// Writes md_playbooks v<n+1> (body, evidence, dropped) and md-artifacts playbooks/v<n+1>.md.
// No new version when there is no new evidence or the gated playbook is unchanged.
//
// Header: x-manudesk-token: <MANUDESK_TOKEN>. POST body optional: {"dry_run": true, "max_runs": 30}

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

function fail(status: number, code: string, message: string, hint?: string, extra?: object): Response {
  return json({ ok: false, error: { code, message, hint, ...extra } }, status);
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

const FINISHED = ['reached', 'exhausted', 'failed'];
const TITLE = '# FPGA timing-closure playbook';
const MAX_CHARS = 6000;
const MAX_EVIDENCE_CHARS = 40_000;

const SYSTEM = `You maintain the team playbook of an FPGA timing-closure agent (ECP5-85F speed 6, Yosys + nextpnr).
An RTL engineer reads it before every change on designs it has never seen. Rewrite the playbook using the
new training evidence:
- Keep it short: at most 6 numbered rules, under 5000 characters. No Verilog code blocks or snippets.
- Format every rule as one line: "N. **Short title** - text".
- Every rule must be general (about a kind of logic: multipliers, wide adders, compare chains, XOR trees,
  bit counting, accumulators, pipeline latency bookkeeping, lint/width errors...) and backed by a measured
  number (MHz before/after, latency in cycles, rejection count) from the evidence or the existing playbook.
  Write the number in the rule, exactly as it appears in the evidence.
- Add rules for mistakes that got candidates REJECTED (lint errors, wrong LATENCY, port changes) so the
  engineer avoids them next time.
- Remove or correct rules the evidence contradicts. Keep correct existing rules.
- Never invent measurements. Never name a specific design.
Return ONLY the new playbook as Markdown, starting with the line '${TITLE}'.`;

// ---------------------------------------------------------------- code gate (tc/analyst.py claim_supported)
const STOP = new Set(('the a an of for and or to in on with by is are be at as from this that its it per using use used ' +
  'provides specifies typical maximum minimum value values ecp5 lattice fpga').split(' '));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is the claim backed by the evidence text? All must hold:
 *  - it has at least one significant number (>= 10, or a small number with a unit: 4x, 2 cycles);
 *  - every significant number is in the text (decimals may be rounded: 134.8 matches 134.84; integers exact);
 *  - at least 60% of its key words are in the text (a true number can't carry an invented clause). */
function claimSupported(claim: string, page: string): [boolean, string] {
  const text = page.toLowerCase().split(/\s+/).join(' ');
  const missing: string[] = [];
  let numbers = 0;
  for (const m of claim.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(x|×|mhz|ghz|ns|ps|%|bits?|cycles?)?/g)) {
    const [, n, unit] = m;
    if (parseFloat(n) < 10 && !unit) continue;   // bare small numbers prove nothing
    numbers++;
    const re = new RegExp(`(?<![\\d.])${escapeRe(n)}${n.includes('.') ? '' : '(?![\\d])'}`);
    if (!re.test(text)) missing.push(n + (unit ?? ''));
  }
  if (!numbers) return [false, 'no measured number in the rule'];
  if (missing.length) return [false, `numbers not in evidence: ${missing.join(', ')}`];
  const words = (claim.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2);
  if (!words.length) return [false, 'rule has nothing checkable'];
  const hit = words.filter((w) => text.includes(w)).length;
  const ok = hit / words.length >= 0.6;
  return [ok, `${hit}/${words.length} key words in evidence${ok ? '' : ' (below 60%)'}`];
}

/** Drop unsupported numbered rules and anything naming a design; strip code blocks. */
function gate(playbook: string, page: string, designNames: string[]): { body: string; dropped: { rule: string; why: string }[] } {
  const out: string[] = [], dropped: { rule: string; why: string }[] = [];
  const names = designNames.length
    ? new RegExp(`\\b(${designNames.map(escapeRe).join('|')})\\b`, 'i') : null;
  let inCode = false;
  for (const line of playbook.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (!inCode) dropped.push({ rule: '(code block)', why: 'general mode: no code snippets' });
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (/^\s*\d+\.\s/.test(line)) {
      const claim = line.replace(/^\s*\d+\.\s*/, '').replace(/[*`]/g, '');
      const named = names?.exec(claim);
      if (named) { dropped.push({ rule: claim, why: `names design ${named[1]}` }); continue; }
      const [ok, why] = claimSupported(claim, page);
      if (!ok) { dropped.push({ rule: claim, why }); continue; }
    }
    out.push(line);
  }
  // Renumber the surviving rules 1..n.
  let n = 0;
  const body = out.map((l) => (/^\s*\d+\.\s/.test(l) ? l.replace(/^\s*\d+\./, `${++n}.`) : l)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { body, dropped };
}

// ---------------------------------------------------------------- evidence
const fmt = (v: unknown) => (v === null || v === undefined ? 'n/a' : String(v));
const clip = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s : s === null || s === undefined ? '' : JSON.stringify(s);
  return t.length > n ? t.slice(0, n) + '...' : t;
};

function rationale(output: any): string {
  if (!output || typeof output !== 'object') return clip(output, 300);
  return clip(output.rationale ?? output.change ?? output.summary ?? output.plan ?? output.reason ?? '', 300);
}

function fixText(fix: any): string {
  if (!fix) return '';
  if (Array.isArray(fix)) return fix.map((f) => (typeof f === 'string' ? f : f?.message ?? f?.hint ?? JSON.stringify(f))).join('; ');
  return typeof fix === 'string' ? fix : JSON.stringify(fix);
}

function runEvidence(run: any, design: any, its: any[], checks: Map<string, any>, runChecks: any[]): string {
  const lines = [`## Run ${run.id} on design \`${run.design}\`: baseline ${fmt(design?.baseline_mhz)} MHz -> best ` +
    `${fmt(run.best_mhz)} MHz, target ${fmt(run.target_mhz)} MHz, status ${run.status}, iterations ${fmt(run.iteration)}` +
    `${run.playbook_version ? `, playbook v${run.playbook_version}` : ''}${run.error ? `, error: ${clip(run.error, 200)}` : ''}`];
  const used = new Set<string>();
  for (const it of its.filter((i) => i.role === 'engineer' && i.accepted !== null && i.accepted !== undefined)
    .sort((a, b) => a.n - b.n)) {
    const c = it.check_id ? checks.get(it.check_id) : null;
    if (c) used.add(c.id);
    if (it.accepted) {
      lines.push(`- iter ${it.n} ACCEPTED ${fmt(c?.mhz)} MHz, latency ${fmt(c?.lat)}${c?.x ? `, x ${c.x}` : ''}` +
        `${c?.path ? `, critical path ${clip(c.path, 160)}` : ''}: ${rationale(it.output)}`);
    } else {
      lines.push(`- iter ${it.n} REJECTED at ${fmt(c?.stage)}${c?.mhz ? ` (${c.mhz} MHz)` : ''}: ${rationale(it.output)}` +
        ` | ${clip(fixText(c?.fix), 400)}`);
    }
  }
  for (const c of runChecks.filter((c) => !used.has(c.id))) {
    lines.push(`- check ${c.pass ? 'PASS' : 'FAIL'} at ${fmt(c.stage)}: ${fmt(c.mhz)} MHz, latency ${fmt(c.lat)}` +
      `${c.pass ? '' : ` | ${clip(fixText(c.fix), 300)}`}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- AI gateway
async function askModel(current: string, evidence: string): Promise<{ text: string; model: string; usage: any }> {
  const key = env('OPENROUTER_API_KEY');
  const model = Deno.env.get('MANUDESK_REFLECT_MODEL') ?? Deno.env.get('OPENROUTER_CHAT_MODEL') ?? 'anthropic/claude-sonnet-5.5';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Existing playbook:\n\`\`\`markdown\n${current || '(empty)'}\n\`\`\`\n\nNew training evidence:\n${evidence}\n\nWrite the updated playbook.` },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AI gateway ${res.status}: ${clip(out?.error ?? out, 300)}`);
  return { text: String(out?.choices?.[0]?.message?.content ?? ''), model: out?.model ?? model, usage: out?.usage ?? null };
}

// ---------------------------------------------------------------- handler
export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const denied = checkToken(req);
  if (denied) return denied;
  const t0 = Date.now();
  const body = await readJson(req);
  const dryRun = body.dry_run === true || body.dry_run === 'true';
  const maxRuns = Math.min(50, Math.max(1, Number(body.max_runs) || 30));

  let client;
  try {
    client = createAdminClient({ baseUrl: env('INSFORGE_BASE_URL'), apiKey: env('API_KEY') });
  } catch (e) {
    return fail(500, 'SERVER_MISCONFIGURED', String((e as Error).message));
  }
  const db = client.database;
  const dbErr = (what: string, e: any) =>
    fail(500, 'DB_ERROR', `${what}: ${e?.message ?? JSON.stringify(e)}`, 'do the md_* tables exist? (owned by the schema session)');

  const latest = await db.from('md_playbooks').select('version, body, evidence, created_at')
    .order('version', { ascending: false }).limit(1);
  if (latest.error) return dbErr('reading md_playbooks', latest.error);
  const prev = latest.data?.[0] ?? null;
  const prevVersion: number = prev?.version ?? 0;
  const current: string = prev?.body ?? '';
  const seen = new Set<string>(Array.isArray(prev?.evidence?.run_ids) ? prev.evidence.run_ids : []);

  let q = db.from('md_runs').select('id, design, goal, target_mhz, status, iteration, best_mhz, best_check_id, playbook_version, error, updated_at')
    .in('status', FINISHED).order('updated_at', { ascending: true }).limit(maxRuns + seen.size);
  if (prev?.created_at) q = q.gt('updated_at', prev.created_at);
  const rr = await q;
  if (rr.error) return dbErr('reading md_runs', rr.error);
  const runs = (rr.data ?? []).filter((r: any) => !seen.has(r.id)).slice(0, maxRuns);
  if (!runs.length) {
    return json({ ok: true, status: 'no evidence yet', detail: `no finished md_runs since playbook v${prevVersion}`,
      playbook_version: prevVersion, ms: Date.now() - t0 });
  }

  const ids = runs.map((r: any) => r.id);
  const [ds, it, ck] = await Promise.all([
    db.from('md_designs').select('name, baseline_mhz, target_mhz').limit(1000),
    db.from('md_iterations').select('run_id, n, role, accepted, output, check_id').in('run_id', ids).limit(5000),
    db.from('md_checks').select('id, run_id, pass, stage, mhz, x, lat, path, fix').in('run_id', ids).limit(5000),
  ]);
  if (ds.error) return dbErr('reading md_designs', ds.error);
  if (it.error) return dbErr('reading md_iterations', it.error);
  if (ck.error) return dbErr('reading md_checks', ck.error);

  const designs = new Map<string, any>((ds.data ?? []).map((d: any) => [d.name, d]));
  const checks = new Map<string, any>((ck.data ?? []).map((c: any) => [c.id, c]));
  const judged = (it.data ?? []).filter((i: any) => i.role === 'engineer' && i.accepted !== null && i.accepted !== undefined);
  if (!judged.length && !(ck.data ?? []).length) {
    return json({ ok: true, status: 'no evidence yet', detail: `${runs.length} finished run(s) but no judged iterations or checks`,
      playbook_version: prevVersion, ms: Date.now() - t0 });
  }

  let evidence = runs.map((r: any) => runEvidence(r, designs.get(r.design), (it.data ?? []).filter((i: any) => i.run_id === r.id),
    checks, (ck.data ?? []).filter((c: any) => c.run_id === r.id))).join('\n\n');
  if (evidence.length > MAX_EVIDENCE_CHARS) evidence = evidence.slice(0, MAX_EVIDENCE_CHARS) + '\n(evidence truncated)';

  let ai;
  try {
    ai = await askModel(current, evidence);
  } catch (e) {
    return fail(502, 'AI_GATEWAY_ERROR', String((e as Error).message), 'no playbook version written; retry later');
  }
  let text = ai.text.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n').replace(/```\s*$/, '').trim();
  const at = text.indexOf(TITLE);
  if (at < 0) {
    return fail(502, 'BAD_MODEL_OUTPUT', 'the model did not return a playbook', 'no playbook version written',
      { model: ai.model, output: clip(text, 500) });
  }

  const { body: gated, dropped } = gate(text.slice(at), `${current}\n${evidence}`, [...designs.keys()]);
  const newBody = gated.slice(0, MAX_CHARS) + '\n';
  const kept = (newBody.match(/^\s*\d+\.\s/gm) ?? []).length;
  const result = {
    run_ids: ids, n_runs: ids.length, n_iterations: judged.length, n_checks: (ck.data ?? []).length,
    since_version: prevVersion, model: ai.model, usage: ai.usage, rules_kept: kept, rules_dropped: dropped.length,
  };

  if (newBody.trim() === current.trim()) {
    return json({ ok: true, status: 'unchanged', detail: 'gated playbook equals the current one; no new version',
      playbook_version: prevVersion, evidence: result, dropped, ms: Date.now() - t0 });
  }
  if (dryRun) {
    return json({ ok: true, status: 'dry_run', next_version: prevVersion + 1, body: newBody, evidence: result, dropped, ms: Date.now() - t0 });
  }

  const version = prevVersion + 1;
  const key = `playbooks/v${version}.md`;
  const up = await client.storage.from('md-artifacts').upload(key, new Blob([newBody], { type: 'text/markdown' }));
  const artifact = up.error ? { key, error: up.error.message ?? String(up.error) } : { key: up.data?.key ?? key, url: up.data?.url ?? null };
  const ins = await db.from('md_playbooks').insert([{ version, body: newBody, evidence: { ...result, artifact }, dropped }]).select('version, created_at');
  if (ins.error) return dbErr(`writing md_playbooks v${version}`, ins.error);

  return json({
    ok: true, status: 'new_version', playbook_version: version, previous_version: prevVersion,
    rules_kept: kept, dropped, artifact, evidence: result, body: newBody, ms: Date.now() - t0,
  });
}
