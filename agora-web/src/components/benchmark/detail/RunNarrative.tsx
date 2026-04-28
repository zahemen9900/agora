import { CHART_FONT } from "../ChartCard";
import type { RawBenchmarkRun } from "../../../lib/benchmarkMetrics";

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "3px",
      background: "var(--bg-base)", border: "1px solid var(--border-subtle)",
      borderRadius: "4px", padding: "2px 7px",
      fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-secondary)",
    }}>
      <span style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{value}</span>
    </span>
  );
}

interface Props {
  run: RawBenchmarkRun;
}

export function RunNarrative({ run }: Props) {
  const borderColor = run.correct ? "var(--accent-emerald)" : "var(--accent-rose)";
  const resultIcon = run.correct ? "✓" : "✗";
  const resultColor = run.correct ? "var(--accent-emerald)" : "var(--accent-rose)";

  const agentCount = run.agent_models_used.length;
  const switchNote = run.switches > 0 ? `, switched ${run.switches}×` : "";
  const narrative = `Selector chose ${run.mechanism_used} for ${run.category} → ${agentCount} agent${agentCount !== 1 ? "s" : ""}, ${run.rounds} round${run.rounds !== 1 ? "s" : ""}${switchNote} → `;

  return (
    <div style={{
      background: "var(--bg-subtle)", borderRadius: "8px",
      borderLeft: `3px solid ${borderColor}`,
      padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: "8px",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "4px", flexWrap: "wrap" }}>
        <span style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-secondary)" }}>
          {narrative}
        </span>
        <span style={{ fontFamily: CHART_FONT, fontSize: "10px", fontWeight: 700, color: resultColor }}>
          {resultIcon} {run.correct ? "correct" : "incorrect"}
        </span>
      </div>

      {run.selector_reasoning && (
        <p style={{
          margin: 0, fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "11px",
          color: "var(--text-tertiary)", fontStyle: "italic", lineHeight: "1.5",
        }}>
          "{run.selector_reasoning.slice(0, 140)}{run.selector_reasoning.length > 140 ? "…" : ""}"
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
        <StatPill label="tokens" value={run.tokens_used.toLocaleString()} />
        <StatPill label="thinking" value={run.thinking_tokens_used.toLocaleString()} />
        <StatPill label="latency" value={`${(run.latency_ms / 1000).toFixed(1)}s`} />
        <StatPill label="cost" value={`$${run.estimated_cost_usd.toFixed(4)}`} />
        {run.switches > 0 && <StatPill label="switches" value={String(run.switches)} />}
        {run.confidence > 0 && <StatPill label="confidence" value={`${(run.confidence * 100).toFixed(0)}%`} />}
      </div>
    </div>
  );
}
