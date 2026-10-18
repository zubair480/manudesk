// ManuDesk on Manufact: the MCP server coding agents connect to. The six tools are thin forwards to the
// ManuDesk compute server on InsForge, which is the only place with the EDA tools (Verilator, Icarus, Yosys,
// nextpnr-ecp5, KiCad, Freerouting). On top of them: resources (designs, specs, the learned playbook), a
// `speed_up` prompt, and a check-result view (views/check-result) for hosts that render MCP Apps.
// Env: MANUDESK_UPSTREAM (compute /mcp URL), MANUDESK_TOKEN (its bearer token), INSFORGE_URL and
// INSFORGE_ANON_KEY (public read of md_designs / md_playbooks).
import { MCPServer, completable } from "mcp-use";
import { z } from "zod";

const UPSTREAM =
  process.env.MANUDESK_UPSTREAM ?? "https://manudesk-d7b0a23f-d743-43f7-a33d-c4fc0d308169.fly.dev/mcp";
const TOKEN = process.env.MANUDESK_TOKEN ?? "";
const INSFORGE_URL = process.env.INSFORGE_URL ?? "https://nden3esm.us-west.insforge.app";
const INSFORGE_ANON_KEY = process.env.INSFORGE_ANON_KEY ?? "";

const INSTRUCTIONS =
  "Hardware feedback for Verilog on a Lattice ECP5-85F. Loop: get_design(name) -> edit -> check(name, verilog) -> " +
  "read `reasons` and `critical_path` -> edit again. Only accepted:true results count; the goal is fmax_mhz >= " +
  "target_mhz. Each check takes about 5-15 s. Read manudesk://playbook first: measured timing-closure rules. " +
  "PCB: pcb_parts(lpf) -> place -> pcb_check(lpf, board_w, board_h, placements) -> fix the DRC violations -> " +
  "again; passed:true = routed with 0 DRC errors and 0 unconnected items (about 15-60 s per routed check).";

const server = new MCPServer({
  name: "manudesk",
  title: "ManuDesk",
  version: "1.1.0",
  description:
    "Hardware timing feedback for Verilog on a Lattice ECP5-85F (speed 6): hidden testbench, yosys synthesis and " +
    "nextpnr place and route, plus KiCad DRC for an add-on PCB, so coding agents can do hardware engineering " +
    "with real measurements.",
  instructions: INSTRUCTIONS,
});

// ---------------------------------------------------------------- upstream

type Text = { type: "text"; text: string };
type ToolText = { content: Text[]; isError?: boolean };

/** Call one tool on the compute server and return its raw MCP result (content is one compact JSON string). */
async function forward(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolText> {
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let raw = await res.text();
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}: ${raw.slice(0, 200)}`);
    if (/^\s*(event|data):/.test(raw)) {
      raw = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    }
    const msg = JSON.parse(raw);
    if (msg.error) throw new Error(`upstream error: ${JSON.stringify(msg.error).slice(0, 300)}`);
    return { content: msg.result.content, isError: msg.result.isError };
  } catch (e) {
    // The compute machine scales to zero, so the first call after idle can be slow or fail: say so plainly.
    const text = JSON.stringify({
      error: { code: "CHECKER_UNAVAILABLE", message: String((e as Error).message ?? e),
               hint: "the EDA backend may be waking up; retry in ~30 s. This is not a verdict on your design." },
    });
    return { content: [{ type: "text", text }], isError: true };
  }
}

/** forward() and parse the JSON text; `{error}` objects (unknown design, bad LPF) count as failures. */
async function forwardJson(name: string, args: Record<string, unknown>, timeoutMs?: number) {
  const r = await forward(name, args, timeoutMs);
  const text = r.content?.[0]?.text ?? "";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const ok = !r.isError && data !== undefined && !(data && typeof data === "object" && "error" in data);
  return { r, text, data, ok };
}

let designNames: string[] | undefined;
async function listDesignNames(): Promise<string[]> {
  if (!designNames) {
    const { data, ok } = await forwardJson("list_designs", {});
    if (ok && Array.isArray(data)) designNames = data.map((d: { name: string }) => d.name);
  }
  return designNames ?? [];
}

let targets: Record<string, number> | undefined;
/** target_mhz per design from InsForge md_designs (public read); the check result itself does not carry it. */
async function targetMhz(name: string): Promise<number | null> {
  if (!targets) {
    try {
      const res = await fetch(`${INSFORGE_URL}/api/database/records/md_designs?select=name,target_mhz`, {
        headers: { Authorization: `Bearer ${INSFORGE_ANON_KEY}` }, signal: AbortSignal.timeout(10_000),
      });
      const rows = (await res.json()) as { name: string; target_mhz: number }[];
      if (res.ok && Array.isArray(rows)) targets = Object.fromEntries(rows.map((r) => [r.name, Number(r.target_mhz)]));
    } catch {
      // fall through: the goal string from get_design carries the same number
    }
  }
  if (targets?.[name] !== undefined) return targets[name];
  const { data, ok } = await forwardJson("get_design", { name });
  const m = ok ? /([\d.]+) MHz or more/.exec(String(data.goal ?? "")) : null;
  return m ? Number(m[1]) : null;
}

const designArg = (desc = 'Design name, e.g. "popcount"') =>
  completable(z.string().describe(desc), async (v) => (await listDesignNames()).filter((n) => n.startsWith(v)));

const RO = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

// ---------------------------------------------------------------- tools

server.tool(
  {
    name: "list_designs",
    title: "List designs",
    description:
      "Every design: [{name, description, top, baseline_mhz, latency_budget, resource_budget}]. resource_budget " +
      "uses the nextpnr cell names (TRELLIS_FF, TRELLIS_COMB, MULT18X18D).",
    annotations: RO,
  },
  async () => forward("list_designs", {}),
);

server.tool(
  {
    name: "get_design",
    title: "Get design",
    description:
      "One design: {name, description, top, baseline_mhz, latency_budget, resource_budget, goal (\"about 1.9x " +
      "baseline (138 MHz or more)\"), verilog (the naive starting file), rules[] (what check() enforces), device}.",
    inputSchema: z.object({ name: designArg() }),
    annotations: RO,
  },
  async ({ name }) => forward("get_design", { name }),
);

server.tool(
  {
    name: "dsp_helper",
    title: "DSP multiply helper",
    description:
      "Verilog source of mul18x18_reg: a fully registered 18x18 multiply (latency 2) that maps to one MULT18X18D. " +
      "Instantiate it in your design; check() provides it, so don't paste or redefine it.",
    annotations: RO,
  },
  async () => forward("dsp_helper", {}),
);

const CheckOutput = z.looseObject({
  accepted: z.boolean(),
  stage_reached: z.string(),
  reasons: z.array(z.object({ what: z.string(), fix: z.string() })),
  fmax_mhz: z.number().nullable(),
  target_mhz: z.number().nullable(),
  baseline_mhz: z.number(),
  vs_baseline: z.string().nullable(),
  latency: z.number().nullable(),
  critical_path: z.string().nullable(),
  resources: z.record(z.string(), z.number()).nullable(),
  budgets: z.record(z.string(), z.number()),
  seconds: z.number(),
});

// Exported so views/check-result gets the typed output (mcp-env.d.ts registers this module's ToolRefs).
export const checkTool = server.tool(
  {
    name: "check",
    title: "Check Verilog on the FPGA",
    description:
      "Run your full Verilog file through lint, the interface check, the hidden testbench, the LATENCY+1 check, " +
      "yosys synth_ecp5, nextpnr-ecp5 (every port registered) and the resource budget, stopping at the first " +
      "failure. Returns {accepted, stage_reached (lint|interface|testbench|latency_check|synth|pnr|resources|done), " +
      "reasons[{what, fix}], fmax_mhz, target_mhz, baseline_mhz, vs_baseline (\"1.00x\"), latency, critical_path " +
      "(slowest path: endpoints, ns, cells, Verilog source lines), resources {TRELLIS_FF, TRELLIS_COMB, MULT18X18D, " +
      "TRELLIS_IO, DCCA}, budgets, seconds}. fmax_mhz and resources are null when it stops before place and route. " +
      "Results are cached per exact source.",
    inputSchema: z.object({
      name: designArg(),
      verilog: z.string().describe("The complete Verilog source file"),
    }),
    outputSchema: CheckOutput,
    annotations: RO,
    view: {
      name: "check-result",
      description: "Pass/fail, Fmax against the target, the slowest path and resource use of one ManuDesk check.",
      prefersBorder: true,
    },
  },
  async ({ name, verilog }) => {
    const [{ r, data, ok }, target] = await Promise.all([forwardJson("check", { name, verilog }, 180_000),
                                                         targetMhz(name)]);
    if (!ok) return { ...r, isError: true };
    const out = { ...data, target_mhz: target };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  },
);

server.tool(
  {
    name: "pcb_parts",
    title: "PCB parts",
    description:
      "The HDMI/LED/button add-on PCB that plugs into the ULX3S J1 header, built from your design's LPF (empty = " +
      "the bundled example LPF). Returns {rules, template_board_mm [w, h], parts[{ref, footprint, value, " +
      "description, courtyard_mm {w, h, dx, dy}, connects_to[]}], nets, J1 pin map, template placement} where the " +
      "template routes DRC-clean on 70 x 56 mm. Place it smaller or better, then call pcb_check.",
    inputSchema: z.object({ lpf: z.string().default("").describe("Your design's .lpf file; empty = example LPF") }),
    annotations: RO,
  },
  async ({ lpf }) => forward("pcb_parts", { lpf }, 90_000),
);

server.tool(
  {
    name: "pcb_check",
    title: "Route and DRC the PCB",
    description:
      "Place, autoroute (Freerouting) and DRC (KiCad 10) the add-on board. A geometry pre-check rejects " +
      "overlaps/off-board parts in ms; a legal placement is routed (about 15-60 s). Returns {passed, stage, " +
      "drc_errors, unconnected, route_score, unrouted, tracks, vias, violations[{type, description, " +
      "items[{description, pos_mm}]}], legalizer_moves, placements, timings} (empty fields are omitted), plus " +
      "artifact_key and files when fab=true. passed = 0 DRC errors and 0 unconnected items.",
    inputSchema: z.object({
      lpf: z.string().default("").describe("Your design's .lpf file; empty = example LPF"),
      board_w: z.number().default(0).describe("Board width in mm (45-80); 0 = template 70"),
      board_h: z.number().default(0).describe("Board height in mm (35-60); 0 = template 56"),
      placements: z
        .array(z.object({ ref: z.string(), x: z.number(), y: z.number(), rot: z.number() }))
        .optional()
        .describe("[{ref, x, y, rot}] in board-relative mm, y down, rot in {0,90,180,270}; omitted parts keep " +
                  "the template spot"),
      fab: z.boolean().default(false).describe("On a passing board, also export Gerbers, drill, BOM, positions, renders"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => forward("pcb_check", args, 240_000),
);

// ---------------------------------------------------------------- resources

const json = (uri: URL, text: string) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text }] });

server.resource(
  {
    name: "designs",
    uri: "manudesk://designs",
    title: "Benchmark designs",
    description: "Every design with its baseline Fmax, latency budget and resource budget (same as list_designs).",
    mimeType: "application/json",
  },
  async (uri) => json(uri, (await forward("list_designs", {})).content[0].text),
);

server.resourceTemplate(
  {
    name: "design",
    uriTemplate: "manudesk://designs/{name}",
    title: "Design spec and rules",
    description: "One design's spec: budgets, goal, device, the rules check() enforces and the starting Verilog.",
    mimeType: "application/json",
    complete: { name: async (v: string) => (await listDesignNames()).filter((n) => n.startsWith(v)) },
  },
  async (uri, { name }) => json(uri, (await forward("get_design", { name: String(name) })).content[0].text),
);

server.resourceTemplate(
  {
    name: "design-start",
    uriTemplate: "manudesk://designs/{name}/start.v",
    title: "Starting Verilog",
    description: "The naive starting Verilog of one design, as a plain file.",
    mimeType: "text/x-verilog",
    complete: { name: async (v: string) => (await listDesignNames()).filter((n) => n.startsWith(v)) },
  },
  async (uri, { name }) => {
    const { data, ok, text } = await forwardJson("get_design", { name: String(name) });
    return { contents: [{ uri: uri.href, mimeType: "text/x-verilog", text: ok ? data.verilog : `// ${text}` }] };
  },
);

server.resource(
  {
    name: "dsp-helper",
    uri: "manudesk://lib/mul18x18_reg.v",
    title: "mul18x18_reg (DSP helper)",
    description: "The registered 18x18 DSP multiply check() links in for you (latency 2).",
    mimeType: "text/x-verilog",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/x-verilog", text: (await forward("dsp_helper", {})).content[0].text }],
  }),
);

server.resource(
  {
    name: "playbook",
    uri: "manudesk://playbook",
    title: "FPGA timing-closure playbook",
    description:
      "The current playbook: numbered timing-closure rules a reflector rewrites from measured ManuDesk runs. Every " +
      "rule cites a measured number. Read it before your first check.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    let text = "# FPGA playbook\nNo playbook is published yet.";
    try {
      const res = await fetch(
        `${INSFORGE_URL}/api/database/records/md_playbooks?select=version,body,created_at&order=version.desc&limit=1`,
        { headers: { Authorization: `Bearer ${INSFORGE_ANON_KEY}` }, signal: AbortSignal.timeout(10_000) },
      );
      const rows = (await res.json()) as { version: number; body: string; created_at: string }[];
      if (res.ok && rows[0]) text = `${rows[0].body.trim()}\n\n_Version ${rows[0].version}, ${rows[0].created_at}._\n`;
    } catch (e) {
      text += ` (InsForge unreachable: ${String((e as Error).message ?? e)})`;
    }
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
  },
);

// ---------------------------------------------------------------- prompts

server.prompt(
  {
    name: "speed_up",
    title: "Speed up a design",
    description: "Pipeline one design until check() accepts it at or above a target Fmax.",
    schema: z.object({
      design: designArg("Design name, e.g. \"mac\""),
      target_mhz: z.string().optional().describe("Target Fmax in MHz; empty = the design's own target"),
    }),
  },
  async ({ design, target_mhz }) => {
    const target = target_mhz?.trim() || String((await targetMhz(design)) ?? "the design's target");
    const text =
      `Speed up the ManuDesk design \`${design}\` to ${target} MHz or more on the ECP5-85F.\n\n` +
      `1. Read manudesk://playbook and call get_design("${design}") for the starting Verilog, budgets and rules.\n` +
      `2. Call check("${design}", <starting Verilog>) once to see the baseline Fmax and the critical_path.\n` +
      `3. Edit to shorten the slowest path (pipeline registers, balanced trees, mul18x18_reg for multiplies), keep ` +
      `the ports, and set \`localparam LATENCY\` to the true input-to-output cycle count within latency_budget.\n` +
      `4. check() the full file after each change. On a rejection, apply \`reasons[].fix\`; on a pass below ` +
      `target, read critical_path and attack that path.\n` +
      `5. Stop when accepted is true and fmax_mhz >= ${target}. Report the final Fmax, latency, resources and ` +
      `what each change bought, with the measured numbers.`;
    return { messages: [{ role: "user", content: { type: "text", text } }] };
  },
);

export default server;
