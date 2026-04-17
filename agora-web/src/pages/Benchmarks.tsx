import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import { ExternalLink } from "lucide-react";

import { getBenchmarks, type BenchmarkPayload } from "../lib/api";
import { useAuth } from "../lib/auth";

export function Benchmarks() {
  const navigate = useNavigate();
  const { authStatus, getAccessToken } = useAuth();
  const [benchmarks, setBenchmarks] = useState<BenchmarkPayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadBenchmarks() {
      try {
        const token = await getAccessToken();
        const payload = await getBenchmarks(token);
        if (!cancelled) {
          setBenchmarks(payload);
        }
      } catch (error) {
        if (!cancelled) {
          console.error(error);
          setBenchmarks({ summary: { per_mode: {}, per_category: {} } });
        }
      }
    }

    if (authStatus !== "authenticated") {
      return;
    }

    void loadBenchmarks();

    return () => {
      cancelled = true;
    };
  }, [authStatus, getAccessToken]);

  const summary = benchmarks?.post_learning?.summary ?? benchmarks?.summary;
  const modeSummary = summary?.per_mode ?? {};
  const categorySummary = summary?.per_category ?? {};

  const accuracyData = useMemo(
    () =>
      Object.entries(categorySummary).map(([category, modes]) => ({
        category: titleCase(category),
        debate: Number(modes.debate?.accuracy ?? modes.full_debate?.accuracy ?? 0) * 100,
        vote: Number(modes.vote?.accuracy ?? modes.isp_vote?.accuracy ?? 0) * 100,
        selector: Number(modes.selector?.accuracy ?? 0) * 100,
      })),
    [categorySummary],
  );

  const costData = useMemo(
    () =>
      Object.entries(modeSummary).map(([mechanism, metrics]) => ({
        mechanism: titleCase(mechanism.replaceAll("_", " ")),
        avgTokens: Number(metrics.avg_tokens ?? 0),
      })),
    [modeSummary],
  );

  const learningCurveData = useMemo(() => {
    const pre = Number(benchmarks?.pre_learning?.summary?.per_mode?.selector?.accuracy ?? 0) * 100;
    const post = Number(benchmarks?.post_learning?.summary?.per_mode?.selector?.accuracy ?? 0) * 100;
    return [
      { phase: "Pre", accuracy: pre },
      { phase: "Post", accuracy: post || pre },
    ];
  }, [benchmarks]);

  const historyRuns = useMemo(
    () => (Array.isArray(benchmarks?.runs) ? benchmarks?.runs.slice(0, 12) : []),
    [benchmarks],
  );

  return (
    <div className="max-w-[1000px] mx-auto pb-20 w-full">
      <header className="mb-10">
        <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
        <p className="text-text-secondary text-lg max-w-[600px]">
          Comparison, ablation, and learning metrics generated from the Phase 2 benchmark suite.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8 w-full">
        <div className="card p-4 sm:p-8 col-span-1 lg:col-span-2">
          <h3 className="mb-2 text-lg font-semibold">Accuracy by Task Category × Mechanism</h3>
          <p className="text-sm text-text-secondary mb-8">
            Selector runs should dominate category-specific fixed strategies after learning.
          </p>
          <div className="w-full h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={accuracyData} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border-subtle)"
                  vertical={false}
                />
                <XAxis
                  dataKey="category"
                  stroke="var(--color-text-muted)"
                  tick={{
                    fill: "var(--color-text-muted)",
                    fontSize: 12,
                    fontFamily: "JetBrains Mono",
                  }}
                />
                <YAxis
                  stroke="var(--color-text-muted)"
                  tick={{
                    fill: "var(--color-text-muted)",
                    fontSize: 12,
                    fontFamily: "JetBrains Mono",
                  }}
                />
                <Tooltip cursor={{ fill: "var(--color-elevated)" }} />
                <Legend iconType="circle" wrapperStyle={{ fontFamily: "JetBrains Mono", fontSize: "12px" }} />
                <Bar dataKey="debate" name="Debate" fill="var(--color-border-muted)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="vote" name="Vote" fill="var(--color-text-muted)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="selector" name="Selector" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card p-4 sm:p-8">
          <h3 className="mb-2 text-lg font-semibold">Selector Learning Curve</h3>
          <p className="text-sm text-text-secondary mb-8">
            Accuracy before and after the learning update cycle.
          </p>
          <div className="w-full h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={learningCurveData} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border-subtle)"
                  vertical={false}
                />
                <XAxis
                  dataKey="phase"
                  stroke="var(--color-text-muted)"
                  tick={{
                    fill: "var(--color-text-muted)",
                    fontSize: 12,
                    fontFamily: "JetBrains Mono",
                  }}
                />
                <YAxis
                  stroke="var(--color-text-muted)"
                  tick={{
                    fill: "var(--color-text-muted)",
                    fontSize: 12,
                    fontFamily: "JetBrains Mono",
                  }}
                  domain={[0, 100]}
                />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="accuracy"
                  stroke="var(--color-accent)"
                  strokeWidth={3}
                  dot={{ fill: "var(--color-void)", stroke: "var(--color-accent)", strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6, fill: "var(--color-accent)" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card p-4 sm:p-8">
          <h3 className="mb-2 text-lg font-semibold">Cost Efficiency</h3>
          <p className="text-sm text-text-secondary mb-8">
            Average token cost per mechanism across the latest benchmark export.
          </p>
          <div className="w-full h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={costData} margin={{ top: 20, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border-subtle)"
                  vertical={false}
                />
                <XAxis
                  dataKey="mechanism"
                  stroke="var(--color-text-muted)"
                  tick={{
                    fill: "var(--color-text-muted)",
                    fontSize: 12,
                    fontFamily: "JetBrains Mono",
                  }}
                />
                <YAxis
                  stroke="var(--color-text-muted)"
                  tick={{
                    fill: "var(--color-text-muted)",
                    fontSize: 12,
                    fontFamily: "JetBrains Mono",
                  }}
                />
                <Tooltip cursor={{ fill: "var(--color-elevated)" }} />
                <Bar dataKey="avgTokens" name="Avg Tokens" fill="var(--color-text-primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="card p-4 sm:p-8 w-full overflow-x-auto">
        <h3 className="mb-6 text-lg font-semibold">Recent Benchmark Runs</h3>

        <table className="w-full min-w-[700px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border-subtle mono text-text-muted text-sm">
              <th className="py-3 px-4 font-medium text-xs tracking-wider">TASK</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">MODE</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">LATENCY</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">RECEIPT</th>
            </tr>
          </thead>
          <tbody>
            {historyRuns.map((run, index) => (
              <tr
                key={`${String(run.task_index ?? index)}-${String(run.mode ?? "run")}`}
                className="border-b border-border-subtle transition-colors hover:bg-elevated"
                onClick={() => {
                  if (typeof run.task_id === "string") {
                    navigate(`/task/${run.task_id}/receipt`);
                  }
                }}
              >
                <td className="py-4 px-4 w-1/2">
                  <div className="line-clamp-1">{String(run.task ?? "Benchmark run")}</div>
                </td>
                <td className="py-4 px-4">
                  <span className="badge">{titleCase(String(run.mode ?? "run"))}</span>
                </td>
                <td className="py-4 px-4 mono text-sm">
                  {Number(run.latency_ms ?? 0).toFixed(0)} ms
                </td>
                <td className="py-4 px-4">
                  {typeof run.merkle_root === "string" ? (
                    <span className="mono text-accent inline-flex items-center gap-2 text-sm">
                      {`${run.merkle_root.slice(0, 10)}...`} <ExternalLink size={14} />
                    </span>
                  ) : (
                    <span className="mono text-text-muted text-sm">Unavailable</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
