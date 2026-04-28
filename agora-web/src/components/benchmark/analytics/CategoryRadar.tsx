import { useState } from "react";
import { ChartCard, CHART_FONT } from "../ChartCard";
import type { CategoryRadarRow } from "../../../lib/benchmarkMetrics";

const AXES = ["Accuracy", "Cost Eff.", "Speed", "Thinking", "Coverage"] as const;
const AXIS_KEYS: (keyof CategoryRadarRow)[] = ["accuracy", "costEfficiency", "speed", "thinkingRatio", "coverage"];
const N = AXES.length;
const CX = 150;
const CY = 140;
const R = 105;
const SVG_W = 300;
const SVG_H = 290;

const CATEGORY_COLORS = [
  "#10b981",
  "#818cf8",
  "#fb923c",
  "#38bdf8",
  "#f472b6",
  "#a78bfa",
];

function axisPoint(axisIdx: number, r: number): [number, number] {
  const angle = (axisIdx / N) * 2 * Math.PI - Math.PI / 2;
  return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
}

function valuePath(row: CategoryRadarRow): string {
  return AXIS_KEYS.map((key, i) => {
    const v = row[key] as number;
    const [x, y] = axisPoint(i, (v / 100) * R);
    return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ") + " Z";
}

interface TooltipState {
  x: number;
  y: number;
  row: CategoryRadarRow;
  color: string;
}

interface Props {
  data: CategoryRadarRow[];
}

export function CategoryRadar({ data }: Props) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const gridLevels = [0.25, 0.5, 0.75, 1.0];

  return (
    <ChartCard
      title="CATEGORY RADAR"
      subtitle="5-axis quality profile per benchmark domain. Hover to inspect."
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", position: "relative" }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: "100%", maxHeight: SVG_H, overflow: "visible" }}
          onMouseLeave={() => { setTooltip(null); setHovered(null); }}
        >
          {/* Grid polygons */}
          {gridLevels.map((level) => {
            const pts = Array.from({ length: N }, (_, i) => {
              const [x, y] = axisPoint(i, level * R);
              return `${x.toFixed(2)},${y.toFixed(2)}`;
            }).join(" ");
            return (
              <polygon
                key={level}
                points={pts}
                fill="none"
                stroke="var(--border-subtle)"
                strokeWidth={1}
              />
            );
          })}

          {/* Axis lines */}
          {Array.from({ length: N }, (_, i) => {
            const [x, y] = axisPoint(i, R);
            return (
              <line key={i} x1={CX} y1={CY} x2={x.toFixed(2)} y2={y.toFixed(2)}
                stroke="var(--border-default)" strokeWidth={1} />
            );
          })}

          {/* Axis labels */}
          {AXES.map((label, i) => {
            const [x, y] = axisPoint(i, R + 16);
            const anchor = x < CX - 2 ? "end" : x > CX + 2 ? "start" : "middle";
            return (
              <text key={label} x={x.toFixed(2)} y={y.toFixed(2)} textAnchor={anchor}
                fontFamily={CHART_FONT} fontSize={8} fill="var(--text-tertiary)" dominantBaseline="middle">
                {label}
              </text>
            );
          })}

          {/* Data polygons — dimmed ones first, hovered on top */}
          {data.map((row, idx) => {
            const color = CATEGORY_COLORS[idx % CATEGORY_COLORS.length];
            const isHov = hovered === row.category;
            const isDimmed = hovered !== null && !isHov;
            return (
              <path
                key={row.category}
                d={valuePath(row)}
                fill={color}
                fillOpacity={isDimmed ? 0.04 : isHov ? 0.28 : 0.13}
                stroke={color}
                strokeWidth={isHov ? 2.5 : 1.5}
                strokeOpacity={isDimmed ? 0.3 : 0.9}
                style={{ cursor: "pointer", transition: "fill-opacity 0.15s, stroke-opacity 0.15s, stroke-width 0.1s" }}
                onMouseEnter={(e) => {
                  const rect = (e.target as SVGPathElement).getBoundingClientRect();
                  setHovered(row.category);
                  setTooltip({ x: rect.left + rect.width / 2, y: rect.top, row, color });
                }}
              />
            );
          })}

          {/* Dot markers at each axis intersection for hovered category */}
          {hovered && data.map((row, idx) => {
            if (row.category !== hovered) return null;
            const color = CATEGORY_COLORS[idx % CATEGORY_COLORS.length];
            return AXIS_KEYS.map((key, i) => {
              const v = row[key] as number;
              const [x, y] = axisPoint(i, (v / 100) * R);
              return (
                <circle key={key} cx={x.toFixed(2)} cy={y.toFixed(2)} r={3}
                  fill={color} stroke="var(--bg-elevated)" strokeWidth={1.5} />
              );
            });
          })}
        </svg>

        {/* Legend */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", justifyContent: "center", marginTop: "4px" }}>
          {data.map((row, idx) => (
            <div
              key={row.category}
              style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", opacity: hovered && hovered !== row.category ? 0.4 : 1, transition: "opacity 0.15s" }}
              onMouseEnter={() => setHovered(row.category)}
              onMouseLeave={() => setHovered(null)}
            >
              <span style={{
                width: "8px", height: "8px", borderRadius: "50%",
                background: CATEGORY_COLORS[idx % CATEGORY_COLORS.length],
                display: "inline-block", flexShrink: 0,
              }} />
              <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-secondary)" }}>{row.category}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Fixed-position tooltip */}
      {tooltip && (
        <div style={{
          position: "fixed",
          left: tooltip.x,
          top: tooltip.y - 8,
          transform: "translate(-50%, -100%)",
          background: "var(--bg-elevated)",
          border: `1px solid ${tooltip.color}44`,
          borderRadius: "8px",
          padding: "10px 14px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          pointerEvents: "none",
          zIndex: 9999,
          minWidth: "170px",
        }}>
          <div style={{ fontFamily: CHART_FONT, fontSize: "10px", color: tooltip.color, fontWeight: 700, marginBottom: "8px" }}>
            {tooltip.row.category}
          </div>
          {AXES.map((label, i) => {
            const val = tooltip.row[AXIS_KEYS[i]] as number;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "4px" }}>
                <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-tertiary)" }}>{label}</span>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <div style={{ width: "48px", height: "4px", background: "var(--bg-subtle)", borderRadius: "2px", overflow: "hidden" }}>
                    <div style={{ width: `${val}%`, height: "100%", background: tooltip.color, borderRadius: "2px", transition: "width 0.2s" }} />
                  </div>
                  <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-primary)", minWidth: "28px", textAlign: "right" }}>{val.toFixed(0)}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}
