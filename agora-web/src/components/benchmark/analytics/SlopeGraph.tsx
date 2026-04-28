import { useEffect, useRef } from "react";
import { ChartCard, CHART_FONT } from "../ChartCard";

export interface SlopeDataPoint {
  category: string;
  pre: number;
  post: number;
  delta: number;
  saturated: boolean;
}

const W = 340;
const H = 260;
const LEFT = 70;
const RIGHT = W - 70;
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
          {data.map((d, i) => {
            const color = d.delta > 0 ? "var(--accent-emerald)" : d.delta < 0 ? "var(--accent-rose)" : "var(--text-muted)";
            const y1 = yPos(d.pre);
            const y2 = yPos(d.post);
            const midX = (LEFT + RIGHT) / 2;
            const midY = (y1 + y2) / 2;
            const dotColor = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
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
                <text x={LEFT - 6} y={y1 + 3} textAnchor="end" fontFamily={CHART_FONT} fontSize={8} fill="var(--text-secondary)">{d.category}</text>
                {d.delta !== 0 && (
                  <text x={midX} y={midY - 5} textAnchor="middle" fontFamily={CHART_FONT} fontSize={8} fill={color} fontWeight={700}>
                    {d.delta > 0 ? `+${d.delta.toFixed(1)}pp` : `${d.delta.toFixed(1)}pp`}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </ChartCard>
  );
}
