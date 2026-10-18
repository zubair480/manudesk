// One ManuDesk check, drawn for hosts that render MCP Apps: verdict, Fmax against the target, the slowest
// path and resource use against the budgets. Reads the `check` tool's structuredContent.
import { useToolContext, useViewTheme } from "mcp-use/react";

const STAGES = ["lint", "interface", "testbench", "latency_check", "synth", "pnr", "resources", "done"];
const RES_LABEL: Record<string, string> = { TRELLIS_FF: "FF", TRELLIS_COMB: "LUT", MULT18X18D: "DSP" };

const PALETTE = {
  light: { bg: "#ffffff", fg: "#1a1d21", muted: "#626b75", line: "#e3e6ea", track: "#eef0f3",
           pass: "#1f7a4d", passBg: "#e6f4ec", fail: "#b3261e", failBg: "#fbe9e7", warn: "#9a6100", bar: "#3b6fd8" },
  dark: { bg: "#16181c", fg: "#e8eaed", muted: "#9aa3ad", line: "#2c3036", track: "#24282e",
          pass: "#5cc98f", passBg: "#173426", fail: "#f28b82", failBg: "#3a1c1a", warn: "#e6b35c", bar: "#7aa2f7" },
};

export default function CheckResult() {
  const view = useToolContext<"check">();
  const c = PALETTE[useViewTheme()];
  const box = { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: 13, color: c.fg, background: c.bg,
                padding: 14, lineHeight: 1.45 };

  if (view.status === "pending") {
    return <div style={{ ...box, color: c.muted }}>Running {view.toolInput?.name ?? "the design"} through
      lint, the hidden testbench, yosys and nextpnr…</div>;
  }
  if (view.status === "error") {
    return <div style={{ ...box, color: c.fail }}>Check did not run: {view.error.message}</div>;
  }

  const r = view.toolOutput;
  const name = view.toolInput?.name ?? "design";
  const meets = r.accepted && r.fmax_mhz != null && r.target_mhz != null && r.fmax_mhz >= r.target_mhz;
  const tone = !r.accepted ? c.fail : meets ? c.pass : c.warn;
  const verdict = !r.accepted ? `Rejected at ${r.stage_reached}` : meets ? "Accepted, target met" : "Accepted, below target";
  const scale = Math.max(r.fmax_mhz ?? 0, r.target_mhz ?? 0, r.baseline_mhz) * 1.1;
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const reached = STAGES.indexOf(r.stage_reached);

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{name}</span>
        <span style={{ color: tone, background: r.accepted ? (meets ? c.passBg : c.track) : c.failBg,
                       padding: "2px 8px", borderRadius: 999, fontWeight: 600, fontSize: 12 }}>{verdict}</span>
        <span style={{ color: c.muted, marginLeft: "auto" }}>{r.seconds.toFixed(1)} s</span>
      </div>

      <div style={{ display: "flex", gap: 3, margin: "10px 0 12px" }}>
        {STAGES.slice(0, -1).map((s, i) => {
          const failed = !r.accepted && i === reached;
          const done = r.accepted || i < reached;
          return <div key={s} title={s} style={{ flex: 1, height: 4, borderRadius: 2,
            background: failed ? c.fail : done ? c.pass : c.track }} />;
        })}
      </div>

      {r.fmax_mhz != null && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 26, fontWeight: 650, color: tone }}>{r.fmax_mhz.toFixed(1)}</span>
            <span style={{ color: c.muted }}>MHz</span>
            <span style={{ color: c.muted }}>
              {r.target_mhz != null && <>target {r.target_mhz} · </>}baseline {r.baseline_mhz} · {r.vs_baseline}
            </span>
          </div>
          <div style={{ position: "relative", height: 8, background: c.track, borderRadius: 4, marginTop: 6 }}>
            <div style={{ width: pct(r.fmax_mhz), height: "100%", background: tone, borderRadius: 4 }} />
            {r.target_mhz != null && <div title={`target ${r.target_mhz} MHz`} style={{ position: "absolute",
              left: pct(r.target_mhz), top: -3, width: 2, height: 14, background: c.fg }} />}
            <div title={`baseline ${r.baseline_mhz} MHz`} style={{ position: "absolute", left: pct(r.baseline_mhz),
              top: -3, width: 2, height: 14, background: c.muted }} />
          </div>
        </div>
      )}

      {r.reasons.length > 0 && (
        <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          {r.reasons.map((x, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              <span>{x.what}</span><br /><span style={{ color: c.muted }}>Fix: {x.fix}</span>
            </li>
          ))}
        </ul>
      )}

      {r.critical_path && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: c.muted, fontSize: 12, marginBottom: 3 }}>Slowest path</div>
          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12,
                        border: `1px solid ${c.line}`, borderRadius: 6, padding: 8, overflowWrap: "anywhere" }}>
            {r.critical_path}
          </div>
        </div>
      )}

      {r.resources && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
          {Object.entries(r.budgets).map(([k, lim]) => {
            const used = r.resources?.[k] ?? 0;
            const over = used > lim;
            return (
              <div key={k}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span>{RES_LABEL[k] ?? k}</span>
                  <span style={{ color: over ? c.fail : c.muted }}>{used} / {lim}</span>
                </div>
                <div style={{ height: 6, background: c.track, borderRadius: 3, marginTop: 3 }}>
                  <div style={{ width: `${Math.min(100, (used / lim) * 100)}%`, height: "100%", borderRadius: 3,
                                background: over ? c.fail : c.bar }} />
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 12, color: c.muted, alignSelf: "end" }}>latency {r.latency ?? "?"} cycles</div>
        </div>
      )}
    </div>
  );
}
