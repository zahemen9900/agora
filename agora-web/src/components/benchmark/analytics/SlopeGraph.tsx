import { useEffect, useRef } from "react";
import { ChartCard, CHART_FONT } from "../ChartCard";

export interface SlopeDataPoint {
  category: string;
  pre: number;
  post: number;
  delta: number;
  saturated: boolean;
}

const W = 420;
const H = 260;
const LEFT = 90;
const RIGHT = W - 90;
const TOP = 20;
const BOT = H - 30;

function yPos(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return TOP + ((100 - clamped) / 100) * (BOT - TOP);
}

const CATEGORY_COLORS = [
  "var(--accent-emerald)",
  "#818cf8",
  "#fb923c",
  "#38bdf8",
  "#f472b6",
  "#a78bfa",
];

function avoidOverlap(ys: number[], minGap = 11): number[] {
  const items = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let j = 1; j < items.length; j++) {
    if (items[j].y - items[j - 1].y < minGap) items[j].y = items[j - 1].y + minGap;
  }
  for (let j = items.length - 2; j >= 0; j--) {
    if (items[j + 1].y - items[j].y < minGap) items[j].y = items[j + 1].y - minGap;
  }
  const out = new Array<number>(ys.length);
  items.forEach(({ y, i }) => { out[i] = y; });
  return out;
}

interface Props {
  data: SlopeDataPoint[];
}

export function SlopeGraph({ data }: Props) {
  const linesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    if (!linesRef.current) return;
    const paths = linesRef.current.querySelectorAll<SVGPathElement>("path[data-animate]");
    paths.forEach((path) => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      path.style.transition = "stroke-dashoffset 600ms ease-out";
      requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; });
    });
  }, [data]);

  return (
    <ChartCard
      title="PRE → POST ACCURACY SHIFT"
      subtitle="Per-category accuracy before and after bandit learning."
      tooltip="Each line connects a category's accuracy before bandit learning (Pre) to its accuracy after learning (Post). Teal lines indicate improvement, rose lines indicate regression, muted lines mean no change. A dashed line means the category was already saturated at 100% before learning. The delta badge mid-line shows the exact percentage-point change."
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxHeight: H, overflow: "visible" }}>
        {/* Axis labels */}
        <text x={LEFT} y={TOP - 6} textAnchor="middle" fontFamily={CHART_FONT} fontSize={9} fill="var(--text-tertiary)">PRE</text>
        <text x={RIGHT} y={TOP - 6} textAnchor="middle" fontFamily={CHART_FONT} fontSize={9} fill="var(--text-tertiary)">POST</text>

        {/* Gridlines */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={LEFT - 8} x2={RIGHT + 8} y1={yPos(v)} y2={yPos(v)} stroke="var(--border-subtle)" strokeWidth={1} />
            <text x={LEFT - 12} y={yPos(v) + 3} textAnchor="end" fontFamily={CHART_FONT} fontSize={8} fill="var(--text-tertiary)">{v}%</text>
          </g>
        ))}

        {/* Left and right axis lines */}
        <line x1={LEFT} x2={LEFT} y1={TOP} y2={BOT} stroke="var(--border-default)" strokeWidth={1} />
        <line x1={RIGHT} x2={RIGHT} y1={TOP} y2={BOT} stroke="var(--border-default)" strokeWidth={1} />

        <g ref={linesRef}>
          {(() => {
            const leftLabelYs = avoidOverlap(data.map(d => yPos(d.pre)));
            const rightLabelYs = avoidOverlap(data.map(d => yPos(d.post)));
            return data.map((d, i) => {
              const color = d.delta > 0 ? "var(--accent-emerald)" : d.delta < 0 ? "var(--accent-rose)" : "var(--text-muted)";
              const y1 = yPos(d.pre);
              const y2 = yPos(d.post);
              const midX = (LEFT + RIGHT) / 2;
              const midY = (y1 + y2) / 2;
              const dotColor = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
              const labelY1 = leftLabelYs[i];
              const labelY2 = rightLabelYs[i];
              return (
                <g key={d.category}>
                  <path
                    data-animate="1"
                    d={`M ${LEFT} ${y1} L ${RIGHT} ${y2}`}
                    stroke={color}
                    strokeWidth={d.delta !== 0 ? 1.5 : 1}
                    strokeDasharray={d.saturated ? "4 3" : undefined}
                    fill="none"
                    opacity={0.8}
                  />
                  <circle cx={LEFT} cy={y1} r={4} fill={dotColor} />
                  <circle cx={RIGHT} cy={y2} r={4} fill={dotColor} />
                  {/* tick from dot to label if label was nudged */}
                  {Math.abs(labelY1 - y1) > 2 && (
                    <line x1={LEFT - 5} y1={y1} x2={LEFT - 5} y2={labelY1} stroke={dotColor} strokeWidth={0.5} opacity={0.4} />
                  )}
                  {Math.abs(labelY2 - y2) > 2 && (
                    <line x1={RIGHT + 5} y1={y2} x2={RIGHT + 5} y2={labelY2} stroke={dotColor} strokeWidth={0.5} opacity={0.4} />
                  )}
                  <text x={LEFT - 8} y={labelY1 + 3} textAnchor="end" fontFamily={CHART_FONT} fontSize={8} fill="var(--text-secondary)">{d.category}</text>
                  <text x={RIGHT + 8} y={labelY2 + 3} textAnchor="start" fontFamily={CHART_FONT} fontSize={8} fill="var(--text-secondary)">{d.category}</text>
                  {d.delta !== 0 && (
                    <text x={midX} y={midY - 5} textAnchor="middle" fontFamily={CHART_FONT} fontSize={8} fill={color} fontWeight={700}>
                      {d.delta > 0 ? `+${d.delta.toFixed(1)}pp` : `${d.delta.toFixed(1)}pp`}
                    </text>
                  )}
                </g>
              );
            });
          })()}
        </g>
      </svg>
    </ChartCard>
  );
}
