import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip } from "recharts";
import { ChartCard, CHART_FONT } from "../ChartCard";
import type { EnhancedParetoPoint } from "../../../lib/benchmarkMetrics";

function formatUsd(v: number | null): string {
  if (v == null) return "n/a";
  if (v < 0.001) return `$${(v * 1000).toFixed(3)}m`;
  return `$${v.toFixed(4)}`;
}

function ParetoTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: EnhancedParetoPoint }>;
}) {
  const pt = payload?.[0]?.payload;
  if (!active || !pt) return null;
  return (
    <div style={{
      background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
      borderRadius: "8px", padding: "10px 14px", boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
      minWidth: "180px",
    }}>
      <div style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-primary)", fontWeight: 700, marginBottom: "6px" }}>
        {pt.mechanism}
        {pt.frontier && (
          <span style={{ marginLeft: "6px", fontSize: "8px", color: "var(--accent-emerald)" }}>★ FRONTIER</span>
        )}
      </div>
      <div style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-secondary)", display: "grid", gap: "3px" }}>
        <span>Quality: {pt.accuracy == null ? "n/a" : `${pt.accuracy.toFixed(1)}%`}</span>
        <span>Avg cost: {formatUsd(pt.avgCostUsd)}</span>
        <span>Avg latency: {pt.avgLatencyMs > 0 ? `${(pt.avgLatencyMs / 1000).toFixed(1)}s` : "n/a"}</span>
        <span>Thinking: {(pt.thinkingRatio * 100).toFixed(0)}% of tokens</span>
        <span>Scored runs: {pt.scoredRunCount}</span>
      </div>
    </div>
  );
}

interface Props {
  data: EnhancedParetoPoint[];
}

export function CostLatencyBubble({ data }: Props) {
  const maxLatency = Math.max(...data.map((d) => d.avgLatencyMs), 1);

  const mapped = data
    .filter((d) => d.accuracy != null && d.avgCostUsd != null && d.avgCostUsd > 0)
    .map((d) => ({
      ...d,
      x: d.avgCostUsd as number,
      y: d.accuracy as number,
      z: 4 + Math.round((d.avgLatencyMs / maxLatency) * 16),
    }));

  const frontierData = mapped.filter((d) => d.frontier);
  const dominatedData = mapped.filter((d) => !d.frontier);

  return (
    <ChartCard
      title="COST · LATENCY · QUALITY"
      subtitle="Bubble size = latency. Frontier points dominate on both cost and quality."
    >
      <ResponsiveContainer width="100%" height={260}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <XAxis
            dataKey="x"
            type="number"
            name="cost"
            tickFormatter={(v) => `$${v.toFixed(4)}`}
            tick={{ fontFamily: CHART_FONT, fontSize: 9, fill: "var(--text-tertiary)" }}
            axisLine={{ stroke: "var(--border-default)" }}
            tickLine={false}
            label={{ value: "Avg Cost (USD)", position: "insideBottom", offset: -12, fontFamily: CHART_FONT, fontSize: 9, fill: "var(--text-tertiary)" }}
          />
          <YAxis
            dataKey="y"
            type="number"
            name="accuracy"
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontFamily: CHART_FONT, fontSize: 9, fill: "var(--text-tertiary)" }}
            axisLine={{ stroke: "var(--border-default)" }}
            tickLine={false}
          />
          <ZAxis dataKey="z" range={[40, 400]} />
          <Tooltip content={<ParetoTooltip />} cursor={false} />
          <Scatter
            data={dominatedData}
            fill="var(--text-muted)"
            fillOpacity={0.45}
            stroke="var(--border-strong)"
            strokeWidth={1}
          />
          <Scatter
            data={frontierData}
            fill="var(--accent-emerald)"
            fillOpacity={0.7}
            stroke="var(--accent-emerald)"
            strokeWidth={1}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
