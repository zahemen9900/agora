import { CHART_FONT } from "../ChartCard";
import type { MechanismTraceItem } from "../../../lib/benchmarkMetrics";

const MECH_COLORS: Record<string, string> = {
  debate: "var(--accent-amber)",
  vote: "var(--accent-emerald)",
  selector: "#818cf8",
};

function mechColor(mechanism: string): string {
  return MECH_COLORS[mechanism.toLowerCase()] ?? "var(--text-muted)";
}

interface Props {
  trace: MechanismTraceItem[];
}

export function MechanismTimeline({ trace }: Props) {
  if (trace.length === 0) return null;

  const totalRounds = Math.max(...trace.map((t) => t.end_round), 0) + 1;

  return (
    <div>
      <div style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)", marginBottom: "12px" }}>
        Mechanism Execution Timeline
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 0, borderRadius: "6px", overflow: "hidden", border: "1px solid var(--border-default)" }}>
        {trace.map((item, idx) => {
          const segRounds = item.end_round - item.start_round + 1;
          const widthPct = (segRounds / totalRounds) * 100;
          const color = mechColor(item.mechanism);
          return (
            <div
              key={idx}
              style={{
                width: `${widthPct}%`,
                minWidth: "40px",
                background: color,
                opacity: 0.82,
                position: "relative",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "10px 6px",
                borderRight: idx < trace.length - 1 ? "2px solid var(--bg-base)" : undefined,
              }}
            >
              <span style={{ fontFamily: CHART_FONT, fontSize: "8px", fontWeight: 700, color: "var(--bg-base)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {item.mechanism}
              </span>
              <span style={{ fontFamily: CHART_FONT, fontSize: "7px", color: "var(--bg-base)", opacity: 0.8, marginTop: "2px" }}>
                R{item.start_round}–{item.end_round}
              </span>
              {segRounds > 1 && (
                <span style={{
                  fontFamily: CHART_FONT, fontSize: "7px", color: "var(--bg-base)", opacity: 0.75,
                  background: "rgba(0,0,0,0.18)", borderRadius: "4px", padding: "1px 4px", marginTop: "3px",
                }}>
                  {segRounds} round{segRounds !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Switch reasons */}
      {trace.filter((t) => t.switch_reason).length > 0 && (
        <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "5px" }}>
          {trace.filter((t) => t.switch_reason).map((item, idx) => (
            <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <span style={{
                fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)",
                flexShrink: 0, paddingTop: "1px",
              }}>
                After R{item.end_round}:
              </span>
              <span style={{
                fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-secondary)",
                background: "var(--bg-subtle)", borderRadius: "5px", padding: "3px 7px",
                border: "1px solid var(--border-subtle)", lineHeight: "1.5",
              }}>
                {(item.switch_reason ?? "").slice(0, 80)}{(item.switch_reason?.length ?? 0) > 80 ? "…" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
