// md-run-step: advance ONE agent run by ONE step. All state lives in md_runs / md_iterations, so any call
// (the md-tick schedule, a person, an agent) can pick a run up where the last one left it.
// Auth: x-manudesk-token. POST {"run_id"?: uuid}; without run_id the least recently touched active run is used.
//
//   plan      planner (LLM) turns goal + spec into done_contract, clamped to the spec, DSP ceiling applied
//   analyze   analyst (LLM) diagnoses the critical path of the current best version from the last check's
//             path/use, with the latest md_playbooks body
//   engineer  engineer (LLM) writes a whole new Verilog file
//   check     POST MANUDESK_COMPUTE_URL/api/check; keep it if it passes and beats the best so far;
//             stop at the target or max_iterations, else next iteration
//
// Every LLM call goes through the InsForge Model Gateway (the project's OpenRouter key) and is recorded in
// md_iterations with model and token counts. Compute unreachable -> the engineer row gets
// check_status "check_unavailable" and the run stays at step "check" so the next call retries it. Infra
// errors never mark a run failed.

import { createAdminClient } from 'npm:@insforge/sdk';

// ------------------------------------------------------------------ config

const MODEL = Deno.env.get('MANUDESK_MODEL') ?? 'anthropic/claude-sonnet-5.5';
const LLM_TIMEOUT_MS = 115_000; // the response streams, so only the platform wall clock (>160 s measured) bounds a step
const CHECK_TIMEOUT_MS = 110_000;
const DSP_CEILING_MHZ = 225;
const DSP_TARGET_MARGIN = 0.92; // aim a little under the hard ceiling so the loop has a reachable goal
const DSP_CEILING_SOURCE = 'https://static6.arrow.com/aropdfconversion/2beddaa15206c0bf1b59c250d0a95b9c979f950f/' +
  'fpga-ds-02012-3-2-ecp5-ecp5g-family-data-sheet.pdf';
const DSP_CEILING_REASON = 'ECP5 sysDSP 18x18 multiplier with input/pipeline/output registers is specified to ' +
  '225 MHz at speed grade 6; nextpnr does not time the multiplier array inside the DSP, so a reported Fmax above ' +
  'that is not achievable on silicon.';

const RULES = 'Keep the module header (name, ports, widths, signedness) exactly. ' +
  'Keep `localparam LATENCY = <n>;` in the top module: n = registers from any input to the outputs; ' +
  'every input-to-output path must have that same depth; n <= latency_budget. ' +
  'Synchronous active-high reset; clear every register you add. Plain Verilog-2005 (no SystemVerilog, ' +
  'no initial, no $system tasks, no `include). The only extra module is ' +
  'mul18x18_reg #(SIGNED=0|1)(clk, ce, rst, a[17:0], b[17:0], p[35:0]): ECP5 DSP, latency 2; do not ' +
  'redefine it. Fmax is measured with every port registered, so logic before the first register still counts. ' +
  'Part: Lattice ECP5-85F speed 6 (yosys synth_ecp5 + nextpnr-ecp5).';

const LATENCY_CONVENTION = 'Testbench latency convention: the testbench compares every output with a reference ' +
  'model delayed by dut.LATENCY cycles. Inputs applied before clock edge n must appear on the outputs right after ' +
  'edge n+LATENCY-1. Count EVERY register stage from the input ports to the output ports, including the 2 internal ' +
  'stages of mul18x18_reg, and set `localparam LATENCY` to exactly that number.';

const PLANNER_SYSTEM = `You are the planner of an FPGA timing-closure agent for a Lattice ECP5-85F, speed grade 6,
using Yosys + nextpnr. You do not write RTL. You turn the user's goal and the design spec into a
machine-checkable definition of done. Rules:
- target_mhz is the clock the user asked for (or the spec's target if they gave none). Do not lower it
  yourself; a deterministic datasheet check does that.
- latency_budget_cycles is the spec's latency_budget (extra pipeline stages are allowed up to it).
- resource_budget keys are the spec's (LUT, FF, DSP); never exceed the spec's budget.
- freeze_ports is true unless the user explicitly allows interface changes.
- success_criteria: short checkable statements (testbench PASS, Fmax >= target, ports unchanged, ...).
Answer with ONE JSON object only:
{"target_mhz": number, "max_iterations": int, "latency_budget_cycles": int, "resource_budget": {..},
 "freeze_ports": bool, "success_criteria": [str], "notes": str}`;

const ANALYST_SYSTEM = `You are the timing analyst of an FPGA timing-closure agent (Lattice ECP5-85F speed grade 6,
Yosys synth_ecp5 + nextpnr-ecp5). You read the measured critical path and explain, concretely, what limits
Fmax and which RTL change would shorten it (pipelining, splitting a carry chain, using DSP registers,
retiming, reducing fan-out). You never write the RTL yourself. Prefer playbook rules that carry measured
numbers. Final answer: ONE JSON object:
{"bottleneck": str, "recommendation": str, "expected_gain": str, "playbook_rules_used": [str]}`;

const ENGINEER_SYSTEM = `You are the RTL engineer of an FPGA timing-closure agent. Target: Lattice ECP5-85F speed
grade 6, synthesized with Yosys synth_ecp5 and placed/routed with nextpnr-ecp5. You get the current best
Verilog, the measured critical path, an analyst's diagnosis and the team playbook. You return a COMPLETE new
Verilog file that is functionally identical at the ports but has a shorter critical path.

Hard rules (a hidden testbench and a checker enforce every one):
${RULES}
${LATENCY_CONVENTION}

Answer format: start your reply with the \`\`\`verilog fenced block holding the whole file (no prose or
deliberation before it, keep comments short), then one line starting with RATIONALE: describing the change
in one sentence.`;

// ------------------------------------------------------------------ http helpers

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

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ LLM (InsForge Model Gateway)

type Llm = {
  text: string; model: string; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; finish: string;
};

/** reasoningTokens bounds the model's hidden thinking so it cannot eat the whole answer budget (measured:
 *  unbounded, the engineer used all 12000 tokens and returned no Verilog). */
async function chat(system: string, user: string, maxTokens: number, temperature = 0.3, reasoningTokens = 1024): Promise<Llm> {
  const key = Deno.env.get('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY not set (InsForge Model Gateway key)');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'ManuDesk' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, temperature,
      reasoning: { max_tokens: reasoningTokens, exclude: true },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 200)}`);
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    model: body.model ?? MODEL,
    prompt_tokens: body.usage?.prompt_tokens ?? 0,
    completion_tokens: body.usage?.completion_tokens ?? 0,
    reasoning_tokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    finish: choice?.finish_reason ?? '',
  };
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

function extractVerilog(text: string): string | null {
  const blocks = [...text.matchAll(/```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => ({ lang: (m[1] || '').toLowerCase(), code: m[2] }))
    .filter((b) => /\bmodule\b/.test(b.code) && /\bendmodule\b/.test(b.code));
  const tagged = blocks.filter((b) => ['verilog', 'v', 'sv', 'systemverilog'].includes(b.lang));
  const pick = (tagged.length ? tagged : blocks).sort((a, b) => b.code.length - a.code.length)[0]?.code;
  if (pick) return pick.slice(0, pick.lastIndexOf('endmodule') + 'endmodule'.length).trim() + '\n';
  const m = text.match(/(module\b[\s\S]*endmodule)/);
  return m ? m[1].trim() + '\n' : null;
}

const extractRationale = (text: string) => (text.match(/RATIONALE:\s*(.+)/i)?.[1] ?? '').trim().slice(0, 400);

// ------------------------------------------------------------------ domain rules

/** Datasheet ceiling: any design using MULT18X18D (use.DSP > 0) cannot run above 225 MHz. */
function applyCeiling(done: any, use: any): any | null {
  if (!(Number(use?.DSP) > 0)) return null;
  const requested = Number(done.requested_target_mhz ?? done.target_mhz);
  if (requested <= DSP_CEILING_MHZ || done.target_lowered) return null;
  const lowered = Math.round(DSP_CEILING_MHZ * DSP_TARGET_MARGIN);
  done.requested_target_mhz = requested;
  done.target_mhz = lowered;
  done.target_lowered = true;
  const ev = {
    requested_mhz: requested, target_mhz: lowered, ceiling_mhz: DSP_CEILING_MHZ, source: DSP_CEILING_SOURCE,
    reason: `Requested ${requested} MHz exceeds the ${DSP_CEILING_MHZ} MHz DSP ceiling. ${DSP_CEILING_REASON} ` +
      `Lowering the target to ${lowered} MHz (~${Math.round(DSP_TARGET_MARGIN * 100)}% of the ceiling).`,
  };
  done.target_events = [...(done.target_events ?? []), ev];
  return ev;
}

/** Fmax that counts: nextpnr cannot see inside the DSP, so cap it at the datasheet ceiling. */
const effectiveMhz = (mhz: number, use: any) => (Number(use?.DSP) > 0 ? Math.min(mhz, DSP_CEILING_MHZ) : mhz);

/** The LLM may only tighten the contract, never loosen it. */
function clampContract(raw: any, design: any, run: any): any {
  const budget: Record<string, number> = { ...(design.resource_budget ?? {}) };
  for (const [k, v] of Object.entries(raw?.resource_budget ?? {})) {
    if (k in budget && Number.isFinite(Number(v))) budget[k] = Math.min(Math.trunc(Number(v)), budget[k]);
  }
  return {
    target_mhz: Number(run.target_mhz),
    requested_target_mhz: Number(run.target_mhz),
    max_iterations: run.max_iterations,
    latency_budget_cycles: Number(design.latency_budget),
    resource_budget: budget,
    freeze_ports: true,
    success_criteria: Array.isArray(raw?.success_criteria) ? raw.success_criteria.slice(0, 8).map(String) : [],
    notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 600) : '',
  };
}

// ------------------------------------------------------------------ step context

type Ctx = { db: any; run: any; design: any; playbook: { version: number; body: string } | null };

async function latestPlaybook(db: any) {
  const { data } = await db.from('md_playbooks').select('version, body').order('version', { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

async function iterations(db: any, runId: string) {
  const { data, error } = await db.from('md_iterations')
    .select('id, n, role, output, verilog, check_id, accepted, created_at')
    .eq('run_id', runId).order('created_at', { ascending: true }).limit(500);
  if (error) throw new Error(`md_iterations read: ${error.message}`);
  return (data ?? []) as any[];
}

/** Current best passing Verilog of this run (start_verilog until an engineer version is accepted). */
function bestVersion(its: any[], design: any) {
  const acc = its.filter((r) => r.role === 'engineer' && r.accepted && r.verilog).at(-1);
  return acc ? { verilog: acc.verilog, check: acc.output?.check ?? null, n: acc.n }
    : { verilog: design.start_verilog, check: null, n: 0 };
}

async function baselineCheck(db: any, design: string) {
  const { data } = await db.from('md_checks').select('id, mhz, x, lat, path, use, stage, created_at')
    .eq('design', design).eq('pass', true).eq('source', 'baseline').order('created_at', { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

async function record(db: any, row: any) {
  const { data, error } = await db.from('md_iterations').insert([row]).select('id');
  if (error) throw new Error(`md_iterations insert: ${error.message}`);
  return data?.[0]?.id as string;
}

// ------------------------------------------------------------------ steps
// Each returns the md_runs patch to apply (or throws on an infra error, leaving the run where it was).

async function stepPlan({ db, run, design, playbook }: Ctx) {
  const spec = {
    name: design.name, top: design.top, summary: design.summary, baseline_mhz: design.baseline_mhz,
    target_mhz: Number(run.target_mhz), latency_budget: design.latency_budget, resource_budget: design.resource_budget,
  };
  const prompt = `User goal: ${run.goal}\n\nDesign spec:\n${JSON.stringify(spec, null, 2)}\n\n` +
    `Iteration budget: ${run.max_iterations}. Produce done.json.`;
  const r = await chat(PLANNER_SYSTEM, prompt, 3000, 0.2);
  let raw: any = {};
  let parseError: string | null = null;
  try { raw = extractJson(r.text); } catch (e) { parseError = errText(e); }
  const done = clampContract(raw, design, run);
  // Deterministic ceiling: the baseline's resources, or the spec's DSP budget if the goal says to use DSPs.
  const base = await baselineCheck(db, design.name);
  const ev = applyCeiling(done, base?.use);
  await record(db, {
    run_id: run.id, n: 0, role: 'planner', model: r.model, prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens, input: { system: PLANNER_SYSTEM, prompt },
    output: { raw: parseError ? r.text.slice(0, 4000) : raw, parse_error: parseError, done_contract: done, target_event: ev },
  });
  return {
    status: 'running', step: 'analyze', iteration: 1, done_contract: done, target_mhz: done.target_mhz,
    playbook_version: playbook?.version ?? null, error: null,
  };
}

async function stepAnalyze({ db, run, design, playbook }: Ctx) {
  const its = await iterations(db, run.id);
  const best = bestVersion(its, design);
  const done = run.done_contract ?? {};
  // Measured data: the best version's own check, else the latest baseline check of the design.
  const measured = best.check ?? (await baselineCheck(db, design.name));
  const lastFail = its.filter((r) => r.role === 'engineer' && r.output?.check && !r.output.check.pass).at(-1);
  const parts = [
    `Design ${design.name} (top \`${design.top}\`): ${design.summary}`,
    `Target: ${done.target_mhz ?? run.target_mhz} MHz. Latency budget ${done.latency_budget_cycles ?? design.latency_budget} ` +
      `cycles. Resource budget ${JSON.stringify(done.resource_budget ?? design.resource_budget)}.`,
    measured
      ? `Measured on the current best version: ${JSON.stringify({ mhz: measured.mhz, x: measured.x, lat: measured.lat,
        path: measured.path, use: measured.use })}`
      : `No measurement of the current version yet (baseline ${design.baseline_mhz} MHz); reason from the RTL.`,
  ];
  if (lastFail) parts.push(`Last rejected attempt: stage ${lastFail.output.check.stage}: ${JSON.stringify(lastFail.output.check.fix ?? []).slice(0, 600)}`);
  if (playbook?.body) parts.push(`Team playbook v${playbook.version} (lessons from earlier designs):\n${playbook.body}`);
  parts.push(`Current RTL:\n\`\`\`verilog\n${best.verilog}\`\`\``);
  const prompt = parts.join('\n\n');
  const r = await chat(ANALYST_SYSTEM, prompt, 3500, 0.2);
  let out: any;
  try { out = extractJson(r.text); } catch { out = { bottleneck: r.text.trim().slice(0, 800), recommendation: '' }; }
  await record(db, {
    run_id: run.id, n: run.iteration, role: 'analyst', model: r.model, prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens, input: { system: ANALYST_SYSTEM, prompt, measured_from: best.check ? `iteration ${best.n}` : 'baseline' },
    output: out,
  });
  return { step: 'engineer', error: null };
}

async function stepEngineer({ db, run, design, playbook }: Ctx) {
  const its = await iterations(db, run.id);
  const best = bestVersion(its, design);
  const done = run.done_contract ?? {};
  const analysis = its.filter((r) => r.role === 'analyst').at(-1)?.output ?? {};
  const engineerRows = its.filter((r) => r.role === 'engineer');
  const history = engineerRows.slice(-6).map((r) => {
    const c = r.output?.check;
    const verdict = !c ? (r.output?.error ?? 'not checked') : c.pass
      ? `PASS ${c.mhz} MHz${r.accepted ? ' (new best)' : ' (not better than best)'}` : `REJECTED at ${c.stage}`;
    return `iter ${r.n}: ${r.output?.rationale || '(no rationale)'} -> ${verdict}`;
  });
  const last = engineerRows.at(-1);
  const feedback: string[] = last?.output?.check && !last.output.check.pass ? (last.output.check.fix ?? []).map(String)
    : last?.output?.error ? [String(last.output.error)] : [];
  const measured = best.check ?? (await baselineCheck(db, design.name));
  const task = [
    `RULES: ${RULES}`,
    `Design: ${design.name} (top module \`${design.top}\`). ${design.summary}`,
    `Goal: reach ${done.target_mhz ?? run.target_mhz} MHz. Latency budget: ${done.latency_budget_cycles ?? design.latency_budget} ` +
      `cycles. Resource budget: ${JSON.stringify(done.resource_budget ?? design.resource_budget)}.`,
  ];
  if (playbook?.body) task.push(`Team playbook (follow it unless the measurements say otherwise):\n${playbook.body}`);
  if (measured) task.push(`Measured on the current best version: ${JSON.stringify({ mhz: measured.mhz, lat: measured.lat, path: measured.path, use: measured.use })}`);
  if (analysis.bottleneck || analysis.recommendation) {
    task.push(`Analyst:\nBottleneck: ${analysis.bottleneck ?? ''}\nRecommendation: ${analysis.recommendation ?? ''}`);
  }
  if (history.length) task.push(`Earlier attempts in this run:\n${history.map((h) => `- ${h}`).join('\n')}`);
  if (feedback.length) {
    task.push(`Your previous attempt was REJECTED by the checker:\n${feedback.slice(0, 8).map((f) => `- ${f}`).join('\n')}\n` +
      `Fix exactly these problems.`);
  }
  task.push(`Current best passing version:\n\`\`\`verilog\n${best.verilog}\`\`\`\nReturn the complete new file.`);
  const prompt = task.join('\n\n');
  const r = await chat(ENGINEER_SYSTEM, prompt, 10000, 0.3, 3000);
  const verilog = extractVerilog(r.text);
  const rationale = extractRationale(r.text);
  const out: any = { rationale, based_on_iteration: best.n, finish: r.finish, reasoning_tokens: r.reasoning_tokens };
  if (!verilog) out.error = `reply had no complete \`\`\`verilog module${r.finish === 'length' ? ' (cut off)' : ''}`;
  await record(db, {
    run_id: run.id, n: run.iteration, role: 'engineer', model: r.model, prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens, input: { system: ENGINEER_SYSTEM, prompt },
    output: verilog ? out : { ...out, raw_tail: r.text.slice(-1500) }, verilog,
  });
  if (verilog) return { step: 'check', error: null };
  // No code: a used-up attempt, like a rejection.
  return finishIteration(run, false, null, null);
}

async function stepCheck(ctx: Ctx) {
  const { db, run, design } = ctx;
  const its = await iterations(db, run.id);
  const row = its.filter((r) => r.role === 'engineer' && r.n === run.iteration && r.verilog).at(-1);
  if (!row) return { step: 'engineer', error: `no engineer Verilog for iteration ${run.iteration}; re-running engineer` };

  const base = (Deno.env.get('MANUDESK_COMPUTE_URL') ?? '').replace(/\/+$/, '');
  const t0 = Date.now();
  let check: any = null;
  let unavailable: string | null = null;
  if (!base) unavailable = 'MANUDESK_COMPUTE_URL not set';
  else {
    try {
      const res = await fetch(`${base}/api/check`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${Deno.env.get('MANUDESK_TOKEN')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: design.name, verilog: row.verilog, run_id: run.id }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) unavailable = `compute HTTP ${res.status}: ${text.slice(0, 200)}`;
      else {
        try { check = JSON.parse(text); } catch { unavailable = `compute returned non-JSON: ${text.slice(0, 200)}`; }
        if (check && typeof check.pass !== 'boolean') { unavailable = `compute reply has no "pass": ${text.slice(0, 200)}`; check = null; }
        // stage "error" = the checker itself crashed: an infra problem, not a verdict on the design
        else if (check?.stage === 'error') { unavailable = `checker error: ${JSON.stringify(check.fix ?? []).slice(0, 200)}`; check = null; }
      }
    } catch (e) {
      unavailable = `compute unreachable: ${errText(e)}`;
    }
  }
  const ms = Date.now() - t0;

  if (unavailable) {
    // Infra problem, not a design verdict: note it on the iteration and stay at step "check".
    const attempts = (row.output?.check_attempts ?? 0) + 1;
    const { error: uErr } = await db.from('md_iterations').update({
      output: { ...row.output, check_status: 'check_unavailable', check_error: unavailable, check_attempts: attempts, check_ms: ms },
    }).eq('id', row.id);
    if (uErr) throw new Error(`md_iterations update: ${uErr.message}`);
    return { step: 'check', error: `check_unavailable: ${unavailable}` };
  }

  // md_checks is written by the compute server, fire and forget: the id it returns may not be committed yet.
  // Link it only once the row exists (FKs on md_iterations.check_id / md_runs.best_check_id).
  const sha = await sha256(row.verilog);
  const reported: string | null = check.check_id ?? check.id ?? null;
  let checkId: string | null = null;
  for (let i = 0; i < 4 && !checkId; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    const { data } = reported
      ? await db.from('md_checks').select('id').eq('id', reported).limit(1)
      : await db.from('md_checks').select('id').eq('run_id', run.id).eq('verilog_sha256', sha)
        .order('created_at', { ascending: false }).limit(1);
    checkId = data?.[0]?.id ?? null;
  }

  const kept = { pass: check.pass, stage: check.stage, mhz: check.mhz ?? null, x: check.x ?? null, lat: check.lat ?? null,
    path: check.path ?? null, use: check.use ?? null, fix: check.fix ?? [], target: check.target ?? null };
  const bestMhz = run.best_mhz != null ? Number(run.best_mhz) : Number(design.baseline_mhz);
  const eff = check.pass && check.mhz != null ? effectiveMhz(Number(check.mhz), check.use) : null;
  const accepted = Boolean(check.pass && eff != null && eff > bestMhz + 0.01);
  const done = { ...(run.done_contract ?? {}) };
  const ev = accepted ? applyCeiling(done, check.use) : null;
  const { error: uErr } = await db.from('md_iterations').update({
    check_id: checkId, accepted,
    output: { ...row.output, check: kept, effective_mhz: eff, check_status: 'checked', check_error: null, check_ms: ms, target_event: ev,
      compute_check_id: reported, verilog_sha256: sha },
  }).eq('id', row.id);
  if (uErr) throw new Error(`md_iterations update: ${uErr.message}`);
  const patch: any = finishIteration({ ...run, done_contract: done, target_mhz: done.target_mhz ?? run.target_mhz },
    accepted, accepted ? eff : null, checkId);
  if (ev) { patch.done_contract = done; patch.target_mhz = done.target_mhz; }
  return patch;
}

/** After an attempt: record a new best, then stop (target / budget) or start the next iteration. */
function finishIteration(run: any, accepted: boolean, eff: number | null, checkId: string | null) {
  const patch: any = { error: null };
  let best = run.best_mhz != null ? Number(run.best_mhz) : null;
  if (accepted && eff != null) {
    best = eff;
    patch.best_mhz = eff;
    patch.best_check_id = checkId;
  }
  const target = Number(run.done_contract?.target_mhz ?? run.target_mhz);
  if (best != null && best >= target) return { ...patch, status: 'reached', step: 'done' };
  if (run.iteration >= run.max_iterations) return { ...patch, status: 'exhausted', step: 'done' };
  // A new best gets a fresh diagnosis; a rejection goes straight back to the engineer with the checker's feedback.
  return { ...patch, iteration: run.iteration + 1, step: accepted ? 'analyze' : 'engineer' };
}

// ------------------------------------------------------------------ handler

const COLS = 'id, design, goal, target_mhz, max_iterations, status, step, iteration, best_mhz, best_check_id, ' +
  'playbook_version, done_contract, error, updated_at';
const LEASE_MS = 150_000; // a claimed step older than this is presumed dead and may be taken over

type Out = { status: number; body: any };
const out = (body: any, status = 200): Out => ({ status, body });

async function advance(body: any): Promise<Out> {
  const db = createAdminClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL')!, apiKey: Deno.env.get('API_KEY')! }).database;
  let q = db.from('md_runs').select(COLS);
  q = body?.run_id ? q.eq('id', body.run_id) : q.in('status', ['queued', 'running']).order('updated_at', { ascending: true });
  const { data: runs, error: rErr } = await q.limit(1);
  if (rErr) return out({ ok: false, error: { code: 'db', message: `md_runs read: ${rErr.message}` } }, 500);
  const run = runs?.[0];
  if (!run) return body?.run_id ? out({ ok: false, error: { code: 'unknown_run', message: `no run ${body.run_id}` } }, 404)
    : out({ ok: true, idle: true });
  if (!['queued', 'running'].includes(run.status)) {
    return out({ ok: true, run_id: run.id, status: run.status, step: run.step, finished: true });
  }
  // Lock: a unique claim token in md_runs.error ("stepping: <step> since <iso> #<id>"). Other writers (md-tick
  // bumps updated_at) don't touch it, so the final write is conditional on the token, not on updated_at.
  const held = String(run.error ?? '').match(/^stepping: \w+ since (\S+)/);
  if (held && Date.now() - Date.parse(held[1]) < LEASE_MS) {
    return out({ ok: false, run_id: run.id, busy: true, message: `another md-run-step holds this run (${run.error})` }, 409);
  }
  const token = `stepping: ${run.step} since ${new Date().toISOString()} #${crypto.randomUUID().slice(0, 8)}`;
  const { data: claimed } = await db.from('md_runs').update({ error: token })
    .eq('id', run.id).eq('updated_at', run.updated_at).select('id');
  if (!claimed?.length) return out({ ok: false, run_id: run.id, busy: true, message: 'another md-run-step claimed this run' }, 409);

  const { data: designs } = await db.from('md_designs')
    .select('name, top, summary, baseline_mhz, target_mhz, latency_budget, resource_budget, start_verilog')
    .eq('name', run.design).limit(1);
  const design = designs?.[0];
  if (!design) {
    await db.from('md_runs').update({ status: 'failed', step: 'done', error: `design ${run.design} no longer exists` }).eq('id', run.id);
    return out({ ok: false, error: { code: 'unknown_design', message: `design ${run.design} no longer exists` } }, 404);
  }
  const playbook = await latestPlaybook(db);
  const ctx: Ctx = { db, run: { ...run, error: null }, design, playbook };

  const t0 = Date.now();
  const from = run.step;
  let patch: any;
  try {
    patch = from === 'plan' ? await stepPlan(ctx)
      : from === 'analyze' ? await stepAnalyze(ctx)
      : from === 'engineer' ? await stepEngineer(ctx)
      : from === 'check' ? await stepCheck(ctx)
      : { status: 'running', step: 'analyze' };
  } catch (e) {
    // LLM gateway / DB hiccup: leave the step as it is so the next call retries it.
    patch = { error: `${from}: ${errText(e)}` };
  }
  if (!('error' in patch)) patch.error = null; // always release the claim
  if (run.status === 'queued' && !patch.status) patch.status = 'running';

  const { data: saved, error: wErr } = await db.from('md_runs').update(patch)
    .eq('id', run.id).eq('error', token).select(COLS);
  if (wErr) {
    // release the claim so the next call can retry this step
    await db.from('md_runs').update({ error: `${from}: md_runs update failed: ${wErr.message}`.slice(0, 500) })
      .eq('id', run.id).eq('error', token);
    return out({ ok: false, error: { code: 'db', message: `md_runs update: ${wErr.message}` } }, 500);
  }
  if (!saved?.length) return out({ ok: false, run_id: run.id, busy: true, message: 'run changed while this step ran; result discarded' }, 409);
  const s = saved[0];
  return out({
    ok: !patch.error, run_id: run.id, from_step: from, step: s.step, status: s.status, iteration: s.iteration,
    best_mhz: s.best_mhz, target_mhz: s.target_mhz, error: s.error, ms: Date.now() - t0,
  });
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return fail(405, 'method', 'POST {"run_id"?: "<uuid>"}');
  if (!sameToken(req.headers.get('x-manudesk-token'), Deno.env.get('MANUDESK_TOKEN'))) {
    return fail(401, 'unauthorized', 'send header x-manudesk-token');
  }
  const body: any = await req.json().catch(() => ({}));
  // A step can take longer than the 30 s the function gateway waits for a first byte (and a timed-out request is
  // retried, which would run the step twice). So stream: a space every 5 s, then the JSON result. Leading
  // whitespace is valid JSON. The HTTP status is always 200 here; read "ok" / "busy" / "error" in the body.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const beat = setInterval(() => { try { c.enqueue(enc.encode(' ')); } catch { /* closed */ } }, 5000);
      c.enqueue(enc.encode(' '));
      let r: Out;
      try { r = await advance(body); } catch (e) { r = out({ ok: false, error: { code: 'internal', message: errText(e) } }, 500); }
      clearInterval(beat);
      c.enqueue(enc.encode(JSON.stringify({ ...r.body, http_status: r.status }, null, 2)));
      c.close();
    },
  });
  return new Response(stream, { headers: { ...cors, 'Content-Type': 'application/json' } });
}
