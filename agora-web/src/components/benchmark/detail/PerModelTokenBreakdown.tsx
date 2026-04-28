import { useState } from "react";
import { CHART_FONT } from "../ChartCard";
import type { ModelTelemetryEntry } from "../../../lib/benchmarkMetrics";
import { providerFromModel } from "../../../lib/modelProviders";
import { ProviderGlyph } from "../../ProviderGlyph";

function shortModelName(model: string): string {
  return model.replace(/^.*\//g, "").replace(/-\d{8}$/, "").slice(0, 28);
}

interface SegTip { x: number; y: number; label: string; tokens: number }

interface Props {
  telemetry: Record<string, ModelTelemetryEntry>;
}

export function PerModelTokenBreakdown({ telemetry }: Props) {
  const [tip, setTip] = useState<SegTip | null>(null);
  const entries = Object.entries(telemetry).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
  const maxTokens = Math.max(...entries.map(([, e]) => e.total_tokens), 1);

  if (entries.length === 0) return null;

  return (
    <div>
      <div style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)", marginBottom: "14px" }}>
        Per-Model Token Breakdown
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", position: "relative" }}>
        {entries.map(([model, e]) => {
          const barW = e.total_tokens / maxTokens;
          const inputW = e.total_tokens > 0 ? e.input_tokens / e.total_tokens : 0;
          const thinkingW = e.total_tokens > 0 ? e.thinking_tokens / e.total_tokens : 0;
          const outputW = e.total_tokens > 0 ? e.output_tokens / e.total_tokens : 0;
          return (
            <div key={model} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <ProviderGlyph provider={providerFromModel(model)} size={18} />
              <span style={{
                fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-secondary)",
                width: "130px", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {shortModelName(model)}
              </span>
              <div style={{ flex: 1, height: "12px", background: "var(--bg-subtle)", borderRadius: "3px", overflow: "hidden", display: "flex" }}>
                {[
                  { w: inputW * barW, color: "var(--text-muted)", label: "Input", tokens: e.input_tokens },
                  { w: thinkingW * barW, color: "var(--accent-amber)", label: "Thinking", tokens: e.thinking_tokens },
                  { w: outputW * barW, color: "var(--accent-emerald)", label: "Output", tokens: e.output_tokens },
                ].map((seg) => (
                  <div
                    key={seg.label}
                    style={{ width: `${seg.w * 100}%`, height: "100%", background: seg.color, cursor: "crosshair" }}
                    onMouseEnter={(ev) => {
                      const rect = ev.currentTarget.getBoundingClientRect();
                      setTip({ x: rect.left + rect.width / 2, y: rect.top, label: seg.label, tokens: seg.tokens });
                    }}
                    onMouseLeave={() => setTip(null)}
                  />
                ))}
              </div>
              <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)", flexShrink: 0, minWidth: "44px", textAlign: "right" }}>
                {(e.latency_ms / 1000).toFixed(1)}s
              </span>
              <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)", flexShrink: 0, minWidth: "48px", textAlign: "right" }}>
                ${e.estimated_cost_usd.toFixed(4)}
              </span>
            </div>
          );
        })}
        {tip && (
          <div style={{
            position: "fixed", left: tip.x, top: tip.y - 36, transform: "translateX(-50%)",
            background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
            borderRadius: "6px", padding: "4px 8px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            pointerEvents: "none", zIndex: 9999,
            fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-primary)", whiteSpace: "nowrap",
          }}>
            {tip.label}: {tip.tokens.toLocaleString()} tokens
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: "14px", marginTop: "12px" }}>
        {[
          { color: "var(--text-muted)", label: "Input" },
          { color: "var(--accent-amber)", label: "Thinking" },
          { color: "var(--accent-emerald)", label: "Output" },
        ].map((item) => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
            <span style={{ width: "7px", height: "7px", borderRadius: "2px", background: item.color, display: "inline-block" }} />
            <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
