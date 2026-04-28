import { useState } from "react";
import { ChartCard, CHART_FONT } from "../ChartCard";
import type { PerModelCostRow } from "../../../lib/benchmarkMetrics";
import { providerFromModel } from "../../../lib/modelProviders";
import { ProviderGlyph } from "../../ProviderGlyph";

function shortModelName(model: string): string {
  return model.replace(/^.*\//g, "").replace(/-\d{8}$/, "").slice(0, 28);
}

interface SegmentTooltip {
  x: number;
  y: number;
  label: string;
  tokens: number;
}

interface Props {
  data: PerModelCostRow[];
}

export function PerModelCostBreakdown({ data }: Props) {
  const [tooltip, setTooltip] = useState<SegmentTooltip | null>(null);
  const maxTokens = Math.max(...data.map((d) => d.totalTokens), 1);

  return (
    <ChartCard
      title="PER-MODEL COST BREAKDOWN"
      subtitle="Token spend across all benchmark runs, split by input / thinking / output."
      tooltip="Cumulative token spend per model across all runs, split into input tokens (muted), thinking/reasoning tokens (amber), and output tokens (teal). Bar width scales relative to the highest-spending model. Hover a bar segment to see the exact token count. Cost chips show the total estimated USD spend per model."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", position: "relative" }}>
        {data.map((row) => {
          const barW = row.totalTokens / maxTokens;
          const inputW = row.totalTokens > 0 ? row.inputTokens / row.totalTokens : 0;
          const thinkingW = row.totalTokens > 0 ? row.thinkingTokens / row.totalTokens : 0;
          const outputW = row.totalTokens > 0 ? row.outputTokens / row.totalTokens : 0;
          return (
            <div key={row.model} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <ProviderGlyph provider={providerFromModel(row.model)} size={20} />
              <span style={{
                fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-secondary)",
                width: "140px", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {shortModelName(row.model)}
              </span>
              <div style={{ flex: 1, height: "14px", background: "var(--bg-subtle)", borderRadius: "3px", overflow: "hidden", position: "relative", display: "flex" }}>
                {[
                  { w: inputW * barW, color: "var(--text-muted)", label: "Input", tokens: row.inputTokens },
                  { w: thinkingW * barW, color: "var(--accent-amber)", label: "Thinking", tokens: row.thinkingTokens },
                  { w: outputW * barW, color: "var(--accent-emerald)", label: "Output", tokens: row.outputTokens },
                ].map((seg) => (
                  <div
                    key={seg.label}
                    style={{ width: `${seg.w * 100}%`, height: "100%", background: seg.color, cursor: "crosshair" }}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTooltip({ x: rect.left + rect.width / 2, y: rect.top, label: seg.label, tokens: seg.tokens });
                    }}
                    onMouseLeave={() => setTooltip(null)}
                  />
                ))}
              </div>
              <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-tertiary)", flexShrink: 0, minWidth: "52px", textAlign: "right" }}>
                ${row.totalCostUsd < 0.0001 ? row.totalCostUsd.toExponential(2) : row.totalCostUsd.toFixed(4)}
              </span>
            </div>
          );
        })}

        {tooltip && (
          <div style={{
            position: "fixed", left: tooltip.x, top: tooltip.y - 38, transform: "translateX(-50%)",
            background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
            borderRadius: "6px", padding: "5px 9px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            pointerEvents: "none", zIndex: 9999,
            fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-primary)", whiteSpace: "nowrap",
          }}>
            {tooltip.label}: {tooltip.tokens.toLocaleString()} tokens
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: "14px", marginTop: "14px" }}>
        {[
          { color: "var(--text-muted)", label: "Input" },
          { color: "var(--accent-amber)", label: "Thinking" },
          { color: "var(--accent-emerald)", label: "Output" },
        ].map((item) => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: item.color, display: "inline-block" }} />
            <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>{item.label}</span>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}
