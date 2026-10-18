// ManuDesk on Manufact: the MCP server coding agents connect to. The four tools are thin forwards to the
// ManuDesk compute server on InsForge, which is the only place with the EDA tools (Verilator, Icarus, Yosys,
// nextpnr-ecp5). Env: MANUDESK_UPSTREAM (compute /mcp URL) and MANUDESK_TOKEN (its bearer token).
import { MCPServer } from "mcp-use";
import { z } from "zod";

const UPSTREAM =
  process.env.MANUDESK_UPSTREAM ?? "https://manudesk-d7b0a23f-d743-43f7-a33d-c4fc0d308169.fly.dev/mcp";
const TOKEN = process.env.MANUDESK_TOKEN ?? "";

const server = new MCPServer({
  name: "manudesk",
  title: "ManuDesk",
  version: "1.0.0",
  description:
    "Hardware timing feedback for Verilog on a Lattice ECP5-85F (speed 6): hidden testbench, yosys synthesis and " +
    "nextpnr place and route, so coding agents can do hardware engineering with real measurements.",
  instructions:
    "Hardware feedback for Verilog. Loop: get_design(name) -> edit -> check(name, verilog) -> read `reasons` and " +
    "`critical_path` -> edit again. Only accepted:true results count. Each check takes about 5-15 s.",
});

type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };

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

const RO = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

server.tool(
  {
    name: "list_designs",
    description:
      "Every design: name, what it computes, top module, baseline_mhz, latency_budget, resource_budget.",
    annotations: RO,
  },
  async () => forward("list_designs", {}),
);

server.tool(
  {
    name: "get_design",
    description:
      "One design: the naive starting Verilog, its budgets, the goal, the rules check() enforces, and the device.",
    inputSchema: z.object({ name: z.string().describe('Design name, e.g. "popcount"') }),
    annotations: RO,
  },
  async ({ name }) => forward("get_design", { name }),
);

server.tool(
  {
    name: "dsp_helper",
    description:
      "Verilog source of mul18x18_reg: a fully registered 18x18 multiply (latency 2) that maps to one MULT18X18D. " +
      "Instantiate it in your design; check() provides it, so don't paste or redefine it.",
    annotations: RO,
  },
  async () => forward("dsp_helper", {}),
);

server.tool(
  {
    name: "check",
    description:
      "Run your full Verilog file through lint, the interface check, the hidden testbench, the LATENCY+1 check, " +
      "yosys synth_ecp5, nextpnr-ecp5 (every port registered) and the resource budget, stopping at the first " +
      "failure. Returns {accepted, stage_reached, reasons[{what, fix}], fmax_mhz, baseline_mhz, vs_baseline, " +
      "latency, critical_path, resources, budgets, seconds}.",
    inputSchema: z.object({
      name: z.string().describe('Design name, e.g. "popcount"'),
      verilog: z.string().describe("The complete Verilog source file"),
    }),
    annotations: RO,
  },
  async ({ name, verilog }) => forward("check", { name, verilog }, 180_000),
);

export default server;
