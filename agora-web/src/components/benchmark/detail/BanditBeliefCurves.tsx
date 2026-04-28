import { CHART_FONT, InfoTooltip } from "../ChartCard";
import type { BanditStats } from "../../../lib/benchmarkMetrics";
import { BENCHMARK_DOMAIN_KEYS } from "../../../lib/benchmarkMetrics";

const W = 120;
const H = 70;
const SAMPLES = 60;
const MECHANISMS = ["debate", "vote"] as const;
const MECH_COLORS: Record<string, string> = {
  debate: "var(--accent-amber)",
  vote: "var(--accent-emerald)",
};

function betaPdf(x: number, alpha: number, beta: number): number {
  if (x <= 0 || x >= 1) return 0;
  return Math.pow(x, alpha - 1) * Math.pow(1 - x, beta - 1);
}

function buildCurve(alpha: number, beta: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const x = (i / SAMPLES) * 0.98 + 0.01;
    pts.push([x, betaPdf(x, alpha, beta)]);
  }
  const maxY = Math.max(...pts.map(([, y]) => y), 0.001);
  return pts.map(([x, y]) => [x, y / maxY] as [number, number]);
}

function curvePath(pts: [number, number][]): string {
  return pts
    .map(([x, y], i) => {
      const px = x * W;
      const py = H - y * (H - 6);
      return `${i === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");
}

interface MiniCurveProps {
  domain: string;
  stats: Record<string, Record<string, { alpha: number; beta_param: number; total_pulls: number }>> | null;
}

function MiniCurve({ domain, stats }: MiniCurveProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
      <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>
        {domain}
      </span>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxHeight: H, overflow: "visible" }}>
        <rect x={0} y={0} width={W} height={H} fill="var(--bg-subtle)" rx={4} />
        {MECHANISMS.map((mech) => {
          const entry = stats?.[mech]?.[domain];
          if (!entry || entry.total_pulls === 0) {
            return (
              <g key={mech}>
                <line x1={8} y1={H / 2} x2={W - 8} y2={H / 2}
                  stroke={MECH_COLORS[mech]} strokeWidth={1} strokeDasharray="3 3" opacity={0.4} />
              </g>
            );
          }
          const curve = buildCurve(Math.max(entry.alpha, 0.01), Math.max(entry.beta_param, 0.01));
          return (
            <g key={mech}>
              <path d={curvePath(curve)} fill="none" stroke={MECH_COLORS[mech]} strokeWidth={1.5} opacity={0.85} />
            </g>
          );
        })}
        {/* Pull count badges */}
        {MECHANISMS.map((mech, mi) => {
          const entry = stats?.[mech]?.[domain];
          const pulls = entry?.total_pulls ?? 0;
          return (
            <text
              key={mech}
              x={mi === 0 ? 6 : W - 6}
              y={H - 4}
              textAnchor={mi === 0 ? "start" : "end"}
              fontFamily={CHART_FONT}
              fontSize={7}
              fill={MECH_COLORS[mech]}
              opacity={0.8}
            >
              n={pulls}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

interface Props {
  stats: BanditStats;
}

export function BanditBeliefCurves({ stats }: Props) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>
            Bandit Belief Curves — Beta Posteriors
          </span>
          <InfoTooltip text="Each mini chart shows the Beta(α, β) posterior probability distribution over P(success) for each mechanism (teal = vote, amber = debate) per benchmark domain. A curve peaked near 1 means the bandit is confident this mechanism wins; a flat or dashed line means not enough data yet. n= shows total pulls." />
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          {MECHANISMS.map((mech) => (
            <div key={mech} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <span style={{ width: "8px", height: "2px", background: MECH_COLORS[mech], display: "inline-block", borderRadius: "1px" }} />
              <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>{mech}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}>
        {BENCHMARK_DOMAIN_KEYS.map((domain) => (
          <MiniCurve key={domain} domain={domain} stats={stats as unknown as Record<string, Record<string, { alpha: number; beta_param: number; total_pulls: number }>>} />
        ))}
      </div>
      <div style={{ marginTop: "8px", fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>
        Each curve shows the Beta(α, β) posterior over P(success). Wider ≡ more uncertain; peaked right ≡ high-confidence win rate.
      </div>
    </div>
  );
}
