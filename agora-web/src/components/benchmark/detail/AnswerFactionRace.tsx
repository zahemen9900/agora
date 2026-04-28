import { useState } from "react";
import { CHART_FONT, InfoTooltip } from "../ChartCard";
import type { ConvergenceHistoryItem } from "../../../lib/benchmarkMetrics";

const FACTION_COLORS = [
  "var(--accent-emerald)",
  "#818cf8",
  "#fb923c",
  "#38bdf8",
  "#f472b6",
  "#a78bfa",
  "var(--accent-amber)",
  "var(--accent-rose)",
];

interface SegTip { x: number; y: number; faction: string; share: number }

interface Props {
  history: ConvergenceHistoryItem[];
  category: string;
}

export function AnswerFactionRace({ history, category }: Props) {
  const [tip, setTip] = useState<SegTip | null>(null);

  if (history.length === 0) return null;

  // Collect stable faction index across all rounds
  const factionIndex = new Map<string, number>();
  history.forEach((h) => {
    Object.keys(h.answer_distribution).forEach((faction) => {
      if (!factionIndex.has(faction)) {
        factionIndex.set(faction, factionIndex.size);
      }
    });
  });

  const allFactions = Array.from(factionIndex.keys());

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>
            Answer Faction Race — {category}
          </span>
          <InfoTooltip text="Each row is one deliberation round. The stacked bar shows how model votes are distributed across unique answer factions (color-coded by faction). The dominant faction gets an emerald outline. H= is the Shannon entropy — higher means more disagreement among agents that round." />
        </div>
        <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>
          {history.length} round{history.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "3px", position: "relative" }}>
        {history.map((h) => {
          const total = Object.values(h.answer_distribution).reduce((s, v) => s + v, 0) || 1;
          const dominantFaction = Object.entries(h.answer_distribution)
            .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
          return (
            <div key={h.round_number} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)", flexShrink: 0, width: "28px", textAlign: "right" }}>
                R{h.round_number}
              </span>
              <div style={{
                flex: 1, height: "16px", background: "var(--bg-subtle)", borderRadius: "3px",
                overflow: "hidden", display: "flex", position: "relative",
              }}>
                {allFactions.map((faction) => {
                  const count = h.answer_distribution[faction] ?? 0;
                  const pct = (count / total) * 100;
                  if (pct < 0.5) return null;
                  const colorIdx = factionIndex.get(faction) ?? 0;
                  const isDominant = faction === dominantFaction;
                  return (
                    <div
                      key={faction}
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: FACTION_COLORS[colorIdx % FACTION_COLORS.length],
                        opacity: 0.75,
                        outline: isDominant ? "1.5px solid var(--accent-emerald)" : undefined,
                        outlineOffset: isDominant ? "-1px" : undefined,
                        cursor: "crosshair",
                        position: "relative",
                      }}
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setTip({ x: rect.left + rect.width / 2, y: rect.top, faction, share: pct });
                      }}
                      onMouseLeave={() => setTip(null)}
                    />
                  );
                })}
              </div>
              <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)", flexShrink: 0, width: "36px", textAlign: "right" }}>
                H={h.disagreement_entropy.toFixed(2)}
              </span>
            </div>
          );
        })}

        {tip && (
          <div style={{
            position: "fixed", left: tip.x, top: tip.y - 38, transform: "translateX(-50%)",
            background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
            borderRadius: "6px", padding: "5px 9px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            pointerEvents: "none", zIndex: 9999, maxWidth: "220px",
            fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-primary)",
          }}>
            <div style={{ marginBottom: "2px", wordBreak: "break-word" }}>{tip.faction.slice(0, 60)}{tip.faction.length > 60 ? "…" : ""}</div>
            <div style={{ color: "var(--text-tertiary)" }}>{tip.share.toFixed(1)}% share</div>
          </div>
        )}
      </div>
    </div>
  );
}
