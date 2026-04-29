import { useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import { CHART_FONT, InfoTooltip } from "../ChartCard";
import type { RawBenchmarkRun } from "../../../lib/benchmarkMetrics";
import { usePostHog } from "@posthog/react";

const GRAD_ID = "entropyGrad";

interface Props {
  runs: RawBenchmarkRun[];
}

export function ConvergenceEntropyRiver({ runs }: Props) {
    const posthog = usePostHog();
  const [activeIdx, setActiveIdx] = useState(0);
  if (runs.length === 0) return null;

  const run = runs[Math.min(activeIdx, runs.length - 1)];
  const history = run.convergence_history;
  const data = history.map((h) => ({
    round: h.round_number,
    share: Number((h.dominant_answer_share * 100).toFixed(1)),
    entropy: Number(h.disagreement_entropy.toFixed(3)),
  }));

  const switchRounds = run.mechanism_trace
    .filter((t) => t.switch_reason)
    .map((t) => ({ round: t.end_round, reason: t.switch_reason ?? "" }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>
            Convergence River — Dominant Answer Share
          </span>
          <InfoTooltip text="Area chart tracking how quickly agents converged on a single answer across debate rounds. Higher = more agreement. The curve rising toward 100% means near-consensus was reached. Amber dashed reference lines mark rounds where the selector switched mechanism, with the switch reason labelled above." />
        </div>
        {runs.length > 1 && (
          <div style={{ display: "flex", gap: "4px" }}>
            {runs.map((r, i) => (
              <button
                key={i}
                onClick={(e: any) => { posthog?.capture('convergenceentropyriver_action_clicked'); const handler = () => setActiveIdx(i); if (typeof handler === 'function') (handler as any)(e); }}
                style={{
                  fontFamily: CHART_FONT, fontSize: "8px", padding: "3px 7px", borderRadius: "4px",
                  border: "1px solid var(--border-default)", cursor: "pointer",
                  background: i === activeIdx ? "var(--accent-emerald)" : "var(--bg-subtle)",
                  color: i === activeIdx ? "var(--bg-base)" : "var(--text-secondary)",
                }}
              >
                {r.category}
              </button>
            ))}
          </div>
        )}
      </div>

      <svg width="0" height="0" style={{ position: "absolute" }}>
        <defs>
          <linearGradient id={GRAD_ID} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-emerald)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--accent-rose)" stopOpacity={0.15} />
          </linearGradient>
        </defs>
      </svg>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
          <defs>
            <linearGradient id="shareGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--accent-emerald)" stopOpacity={0.4} />
              <stop offset="95%" stopColor="var(--accent-rose)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="round"
            tick={{ fontFamily: CHART_FONT, fontSize: 8, fill: "var(--text-tertiary)" }}
            axisLine={{ stroke: "var(--border-default)" }}
            tickLine={false}
            label={{ value: "Round", position: "insideBottom", offset: -2, fontFamily: CHART_FONT, fontSize: 8, fill: "var(--text-tertiary)" }}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontFamily: CHART_FONT, fontSize: 8, fill: "var(--text-tertiary)" }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip
            contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "6px", fontFamily: CHART_FONT, fontSize: "9px" }}
            labelFormatter={(v) => `Round ${v}`}
            formatter={(value, name) => {
              const numericValue = typeof value === "number" && Number.isFinite(value) ? value : 0;
              return [
                name === "share" ? `${numericValue}%` : numericValue,
                name === "share" ? "Dominant share" : "Entropy",
              ];
            }}
          />
          {switchRounds.map((sw) => (
            <ReferenceLine
              key={sw.round}
              x={sw.round}
              stroke="var(--accent-amber)"
              strokeDasharray="3 3"
              label={{ value: sw.reason.slice(0, 18) + (sw.reason.length > 18 ? "…" : ""), position: "top", fontFamily: CHART_FONT, fontSize: 7, fill: "var(--accent-amber)" }}
            />
          ))}
          <Area
            type="monotone"
            dataKey="share"
            stroke="var(--accent-emerald)"
            strokeWidth={2}
            fill="url(#shareGrad)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>

      <div style={{ display: "flex", gap: "12px", marginTop: "6px" }}>
        <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>
          Category: <span style={{ color: "var(--text-secondary)" }}>{run.category}</span>
        </span>
        <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>
          Rounds: <span style={{ color: "var(--text-secondary)" }}>{history.length}</span>
        </span>
        <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>
          Final share: <span style={{ color: "var(--accent-emerald)" }}>
            {data.length > 0 ? `${data[data.length - 1].share}%` : "n/a"}
          </span>
        </span>
      </div>
    </div>
  );
}
