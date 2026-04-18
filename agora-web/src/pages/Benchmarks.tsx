import { useCallback, useEffect, useMemo, useState } from "react";
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
import { AlertTriangle, Bot, Brain, Cpu, ExternalLink, Sparkles } from "lucide-react";

import {
  ApiRequestError,
  getBenchmarkCatalog,
  getBenchmarkRunStatus,
  getBenchmarks,
  triggerBenchmarkRun,
  type BenchmarkCatalogEntry,
  type BenchmarkCatalogPayload,
  type BenchmarkDemoReport,
  type BenchmarkPayload,
  type BenchmarkRunStatusPayload,
  type BenchmarkSummary,
} from "../lib/api";
import { useAuth } from "../lib/auth";

interface BenchmarkRunRow {
  key: string;
  task: string;
  mode: string;
  status: string;
  confidence: number | null;
  totalTokens: number;
  models: string[];
  error: string | null;
  eventCount: number | null;
  paymentStatus: string | null;
  latencyMs: number;
  merkleRoot: string | null;
  explorerUrl: string | null;
  taskId: string | null;
  raw: Record<string, unknown>;
}

type ProviderName = "gemini" | "claude" | "kimi" | "other";

interface ModelTelemetryRow {
  model: string;
  tokens: number;
  provider: ProviderName;
}

function providerFromModel(model: string): ProviderName {
  const normalized = model.toLowerCase();
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("kimi") || normalized.includes("moonshot")) {
    return "kimi";
  }
  return "other";
}

function providerTone(provider: ProviderName): string {
  if (provider === "gemini") {
    return "text-cyan-300 border-cyan-500/40 bg-cyan-500/10";
  }
  if (provider === "claude") {
    return "text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-500/10";
  }
  if (provider === "kimi") {
    return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  }
  return "text-text-secondary border-border-muted bg-surface";
}

function ProviderGlyph({ provider }: { provider: ProviderName }) {
  if (provider === "gemini") {
    return <Sparkles size={12} />;
  }
  if (provider === "claude") {
    return <Bot size={12} />;
  }
  if (provider === "kimi") {
    return <Brain size={12} />;
  }
  return <Cpu size={12} />;
}

export function Benchmarks() {
  const navigate = useNavigate();
  const { authStatus, getAccessToken } = useAuth();
  const [benchmarks, setBenchmarks] = useState<BenchmarkPayload | null>(null);
  const [catalog, setCatalog] = useState<BenchmarkCatalogPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [chartsReady, setChartsReady] = useState(false);
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
  const [activeBenchmarkRun, setActiveBenchmarkRun] = useState<BenchmarkRunStatusPayload | null>(null);
  const [isTriggeringBenchmark, setIsTriggeringBenchmark] = useState(false);
  const [benchmarkAgentCount, setBenchmarkAgentCount] = useState(4);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const loadBenchmarkData = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setCatalogError(null);
    const token = await getAccessToken();
    const payload = await getBenchmarks(token);
    setBenchmarks(payload);

    try {
      const catalogPayload = await getBenchmarkCatalog(token);
      setCatalog(catalogPayload);
      setCatalogError(null);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        setCatalog(null);
        setCatalogError(error.message);
        return;
      }
      setCatalog(null);
      setCatalogError("Benchmark catalog is temporarily unavailable.");
    }
  }, [getAccessToken]);

  useEffect(() => {
    let cancelled = false;

    async function loadBenchmarks() {
      try {
        await loadBenchmarkData();
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          setLoadError(error.message);
          setBenchmarks(null);
          setCatalog(null);
          return;
        }
        console.error(error);
        setLoadError("Benchmark data is currently unavailable.");
        setBenchmarks(null);
        setCatalog(null);
      }
    }

    if (authStatus !== "authenticated") {
      return;
    }

    void loadBenchmarks();

    return () => {
      cancelled = true;
    };
  }, [authStatus, loadBenchmarkData]);

  const handleTriggerBenchmark = useCallback(async () => {
    try {
      setRunError(null);
      setIsTriggeringBenchmark(true);
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Authentication token is unavailable.");
      }

      const run = await triggerBenchmarkRun(token, {
        agent_count: benchmarkAgentCount,
        live_agents: true,
      });
      setActiveBenchmarkRun({
        run_id: run.run_id,
        status: run.status,
        created_at: run.created_at,
        updated_at: run.created_at,
        error: null,
        artifact_id: null,
      });
    } catch (error) {
      console.error(error);
      setRunError("Unable to start benchmark run right now.");
    } finally {
      setIsTriggeringBenchmark(false);
    }
  }, [benchmarkAgentCount, getAccessToken]);

  useEffect(() => {
    if (!activeBenchmarkRun) {
      return;
    }
    if (activeBenchmarkRun.status === "completed" || activeBenchmarkRun.status === "failed") {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const token = await getAccessToken();
          if (!token) {
            return;
          }
          const status = await getBenchmarkRunStatus(token, activeBenchmarkRun.run_id);
          if (cancelled) {
            return;
          }
          setActiveBenchmarkRun(status);
          if (status.status === "completed") {
            await loadBenchmarkData();
          }
        } catch (error) {
          if (!cancelled) {
            console.error(error);
          }
        }
      })();
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeBenchmarkRun, getAccessToken, loadBenchmarkData]);

  // All derived state and memos must be declared before any early returns (Rules of Hooks).
  const demoReport = benchmarks?.demo_report;

  const normalizedSummary = useMemo<BenchmarkSummary | null>(
    () => buildSummary(benchmarks, demoReport),
    [benchmarks, demoReport],
  );

  const modeSummary = normalizedSummary?.per_mode ?? {};
  const categorySummary = normalizedSummary?.per_category ?? {};

  const categories = useMemo(
    () => {
      const discovered = Object.keys(categorySummary);
      const preferred = ["math", "factual", "reasoning", "code", "creative", "demo"];
      return Array.from(new Set([...preferred, ...discovered]));
    },
    [categorySummary],
  );

  const accuracyData = useMemo(
    () =>
      categories.map((category) => {
        const modes = categorySummary[category] ?? {};
        return {
          category: titleCase(category),
          debate: Number((modes as Record<string, Record<string, number>>).debate?.accuracy ?? (modes as Record<string, Record<string, number>>).full_debate?.accuracy ?? 0) * 100,
          vote: Number((modes as Record<string, Record<string, number>>).vote?.accuracy ?? (modes as Record<string, Record<string, number>>).isp_vote?.accuracy ?? 0) * 100,
          selector: Number((modes as Record<string, Record<string, number>>).selector?.accuracy ?? 0) * 100,
        };
      }),
    [categories, categorySummary],
  );

  const costData = useMemo(
    () => {
      const modeKeys = Array.from(new Set(["debate", "vote", "selector", ...Object.keys(modeSummary)]));
      return modeKeys.map((mechanism) => {
        const metrics = modeSummary[mechanism] ?? {};
        return {
          mechanism: titleCase(mechanism.replaceAll("_", " ")),
          avgTokens: Number((metrics as Record<string, number>).avg_tokens ?? (metrics as Record<string, number>).total_tokens_used ?? 0),
        };
      });
    },
    [modeSummary],
  );

  const learningCurveData = useMemo(() => {
    const pre = Number(
      benchmarks?.pre_learning?.summary?.per_mode?.selector?.accuracy
      ?? benchmarks?.pre_learning?.summary?.per_mode?.vote?.accuracy
      ?? 0,
    ) * 100;
    const post = Number(
      benchmarks?.post_learning?.summary?.per_mode?.selector?.accuracy
      ?? getNumber(demoReport?.run_result?.confidence)
      ?? getNumber(demoReport?.run_summary?.confidence)
      ?? 0,
    ) * 100;
    return [
      { phase: "Pre", accuracy: pre },
      { phase: "Post", accuracy: post || pre },
    ];
  }, [benchmarks, demoReport]);

  const historyRuns = useMemo<BenchmarkRunRow[]>(() => {
    const rawRuns = extractRuns(benchmarks, demoReport);
    return rawRuns.slice(0, 12).map((run, index) => normalizeRun(run, index));
  }, [benchmarks, demoReport]);

  const selectedRun = useMemo(
    () => historyRuns.find((run) => run.key === selectedRunKey) ?? null,
    [historyRuns, selectedRunKey],
  );

  const selectedRunModelTelemetry = useMemo<ModelTelemetryRow[]>(
    () => (selectedRun ? buildModelTelemetry(selectedRun) : []),
    [selectedRun],
  );

  const demoTxRows = useMemo(
    () => buildTxRows(demoReport),
    [demoReport],
  );

  const acceptanceRows = useMemo(
    () => buildAcceptanceRows(demoReport),
    [demoReport],
  );

  const demoHighlights = useMemo(
    () => buildDemoHighlights(demoReport),
    [demoReport],
  );

  if (loadError) {
    return (
      <div className="max-w-225 mx-auto pb-20 w-full">
        <header className="mb-10">
          <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
        </header>
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!benchmarks) {
    return (
      <div className="max-w-225 mx-auto pb-20 w-full">
        <header className="mb-10">
          <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
        </header>
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">Loading benchmark data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-250 mx-auto pb-20 w-full">
      <header className="mb-10">
        <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
        <p className="text-text-secondary text-lg max-w-150">
          Comparison, ablation, and learning metrics generated from the Phase 2 benchmark suite.
        </p>
      </header>

      <div className="card p-4 sm:p-8 mb-8">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
          <div>
            <h3 className="mb-2 text-lg font-semibold">Run Benchmarks End-to-End</h3>
            <p className="text-sm text-text-secondary">
              Trigger a new benchmark run and persist artifacts in global and user-specific cloud paths.
            </p>
          </div>
          <div className="flex flex-col sm:items-end gap-3">
            <div className="flex items-center gap-2">
              <span className="mono text-[11px] text-text-muted">AGENTS</span>
              {[4, 8, 12].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setBenchmarkAgentCount(count)}
                  className={`mono px-2.5 py-1 text-xs rounded-md border transition-colors ${benchmarkAgentCount === count
                    ? "border-accent text-accent bg-accent-muted"
                    : "border-border-muted text-text-secondary hover:border-accent"}`}
                >
                  {count}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn-primary"
              disabled={isTriggeringBenchmark}
              onClick={() => {
                void handleTriggerBenchmark();
              }}
            >
              {isTriggeringBenchmark ? "Starting..." : "Run Benchmark"}
            </button>
          </div>
        </div>

        {activeBenchmarkRun ? (
          <div className="border border-border-subtle rounded-md px-4 py-3 bg-void">
            <div className="flex flex-wrap gap-3 items-center mb-2">
              <span className="mono text-xs text-text-muted">RUN ID</span>
              <span className="mono text-xs text-text-primary break-all">{activeBenchmarkRun.run_id}</span>
              <span className="badge">{titleCase(activeBenchmarkRun.status)}</span>
            </div>
            <div className="mono text-xs text-text-muted">
              Updated {formatDateTime(activeBenchmarkRun.updated_at)}
              {activeBenchmarkRun.artifact_id ? ` • artifact ${activeBenchmarkRun.artifact_id}` : ""}
              {` • config ${benchmarkAgentCount} agents`}
            </div>
            {activeBenchmarkRun.error ? (
              <div className="mono text-xs text-red-300 mt-2">{activeBenchmarkRun.error}</div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-text-secondary">No active benchmark run yet.</p>
        )}

        {catalogError ? (
          <p className="text-sm text-text-secondary mt-4">{catalogError}</p>
        ) : null}
        {runError ? (
          <p className="text-sm text-red-300 mt-2">{runError}</p>
        ) : null}
      </div>

      {catalog ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="card p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold">Global Benchmarks by Recency</h3>
            <CatalogTable entries={catalog.global_recent.slice(0, 8)} />
          </div>

          <div className="card p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold">Global Benchmarks by Frequency</h3>
            <CatalogTable entries={catalog.global_frequency.slice(0, 8)} />
          </div>

          <div className="card p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold">Your Benchmarks by Recency</h3>
            <CatalogTable entries={catalog.user_recent.slice(0, 8)} />
          </div>

          <div className="card p-4 sm:p-6">
            <h3 className="mb-4 text-base font-semibold">Your Tests by Frequency</h3>
            <UserTestsTable entries={catalog.user_tests_frequency.slice(0, 8)} />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8 w-full">
        <div className="card p-4 sm:p-8 col-span-1 lg:col-span-2">
          <h3 className="mb-2 text-lg font-semibold">Accuracy by Task Category × Mechanism</h3>
          <p className="text-sm text-text-secondary mb-8">
            Selector runs should dominate category-specific fixed strategies after learning.
          </p>
          <div className="w-full h-75">
            {chartsReady ? (
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
            ) : (
              <div className="w-full h-full" />
            )}
          </div>
        </div>

        <div className="card p-4 sm:p-8">
          <h3 className="mb-2 text-lg font-semibold">Selector Learning Curve</h3>
          <p className="text-sm text-text-secondary mb-8">
            Accuracy before and after the learning update cycle.
          </p>
          <div className="w-full h-62.5">
            {chartsReady ? (
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
            ) : (
              <div className="w-full h-full" />
            )}
          </div>
        </div>

        <div className="card p-4 sm:p-8">
          <h3 className="mb-2 text-lg font-semibold">Cost Efficiency</h3>
          <p className="text-sm text-text-secondary mb-8">
            Average token cost per mechanism across the latest benchmark export.
          </p>
          <div className="w-full h-62.5">
            {chartsReady ? (
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
            ) : (
              <div className="w-full h-full" />
            )}
          </div>
        </div>
      </div>

      <div className="card p-4 sm:p-8 w-full overflow-x-auto">
        <h3 className="mb-6 text-lg font-semibold">Recent Benchmark Runs</h3>

        <table className="w-full min-w-245 border-collapse text-left">
          <thead>
            <tr className="border-b border-border-subtle mono text-text-muted text-sm">
              <th className="py-3 px-4 font-medium text-xs tracking-wider">TASK</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">MODE</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">STATUS</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">TOKENS</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">CONFIDENCE</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">LATENCY</th>
              <th className="py-3 px-4 font-medium text-xs tracking-wider">RECEIPT</th>
            </tr>
          </thead>
          <tbody>
            {historyRuns.length === 0 ? (
              <tr>
                <td className="py-8 px-4 text-text-secondary" colSpan={7}>
                  No benchmark runs available in the current payload yet.
                </td>
              </tr>
            ) : historyRuns.map((run) => (
              <tr
                key={run.key}
                className={`border-b border-border-subtle transition-colors ${run.taskId || run.explorerUrl || run.merkleRoot ? "cursor-pointer hover:bg-elevated" : ""} ${run.error ? "bg-red-500/5" : ""}`}
                onClick={() => {
                  if (run.taskId) {
                    navigate(`/task/${run.taskId}/receipt`);
                    return;
                  }
                  if (run.explorerUrl) {
                    window.open(run.explorerUrl, "_blank", "noopener,noreferrer");
                    return;
                  }
                  if (run.merkleRoot) {
                    setSelectedRunKey((previous) => (previous === run.key ? null : run.key));
                  }
                }}
              >
                <td className="py-4 px-4 w-1/2">
                  <div className="line-clamp-1">{run.task}</div>
                </td>
                <td className="py-4 px-4">
                  <span className="badge">{titleCase(run.mode || "run")}</span>
                </td>
                <td className="py-4 px-4">
                  <span className={`badge ${run.status.toLowerCase() === "failed" || run.error ? "border-red-500/40 text-red-300" : ""}`}>
                    {titleCase(run.status || "unknown")}
                  </span>
                </td>
                <td className="py-4 px-4 mono text-sm">
                  {formatInt(run.totalTokens)}
                </td>
                <td className="py-4 px-4 mono text-sm">
                  {formatPercent(run.confidence)}
                </td>
                <td className="py-4 px-4 mono text-sm">
                  {run.latencyMs.toFixed(0)} ms
                </td>
                <td className="py-4 px-4">
                  {run.merkleRoot ? (
                    run.explorerUrl ? (
                      <a
                        href={run.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mono text-accent inline-flex items-center gap-2 text-sm"
                      >
                        {`${run.merkleRoot.slice(0, 10)}...`} <ExternalLink size={14} />
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedRunKey((previous) => (previous === run.key ? null : run.key));
                        }}
                        className="mono text-accent inline-flex items-center gap-2 text-sm"
                      >
                        {`${run.merkleRoot.slice(0, 10)}...`} <ExternalLink size={14} />
                      </button>
                    )
                  ) : (
                    <span className="mono text-text-muted text-sm">Unavailable</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedRun ? (
        <div className="card p-4 sm:p-8 w-full mt-8">
          <h3 className="mb-2 text-lg font-semibold">Run Details</h3>
          <p className="text-sm text-text-secondary mb-6">
            Inspect the selected benchmark run payload and receipt metadata.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">TASK</div>
              <div className="text-sm wrap-break-word">{selectedRun.task}</div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">MECHANISM</div>
              <div className="text-sm">{titleCase(selectedRun.mode)}</div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">STATUS</div>
              <div className={`text-sm ${selectedRun.status.toLowerCase() === "failed" || selectedRun.error ? "text-red-300" : "text-text-primary"}`}>
                {titleCase(selectedRun.status || "unknown")}
              </div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">CONFIDENCE</div>
              <div className="text-sm">{formatPercent(selectedRun.confidence)}</div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">TOKENS</div>
              <div className="text-sm">{formatInt(selectedRun.totalTokens)}</div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">LATENCY</div>
              <div className="text-sm">{selectedRun.latencyMs.toFixed(0)} ms</div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">EVENT COUNT</div>
              <div className="text-sm">{selectedRun.eventCount === null ? "n/a" : formatInt(selectedRun.eventCount)}</div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void">
              <div className="mono text-xs text-text-muted mb-2">PAYMENT STATUS</div>
              <div className="text-sm">{titleCase(selectedRun.paymentStatus ?? "unknown")}</div>
            </div>
            <div className="border border-border-subtle rounded-md p-4 bg-void lg:col-span-2">
              <div className="mono text-xs text-text-muted mb-2">MERKLE ROOT</div>
              <div className="mono text-xs break-all text-text-secondary">{selectedRun.merkleRoot ?? "Unavailable"}</div>
            </div>
          </div>

          {selectedRun.error ? (
            <div className="border border-red-500/40 rounded-md p-3 bg-red-500/10 mb-6">
              <div className="flex items-start gap-2 text-red-300">
                <AlertTriangle size={14} className="mt-0.5" />
                <div>
                  <div className="mono text-xs mb-1">RUN ERROR</div>
                  <div className="mono text-xs whitespace-pre-wrap wrap-break-word">{selectedRun.error}</div>
                </div>
              </div>
            </div>
          ) : null}

          {selectedRunModelTelemetry.length > 0 ? (
            <div className="border border-border-subtle rounded-md p-4 bg-void mb-6">
              <div className="mono text-xs text-text-muted mb-3">
                MODEL TELEMETRY
              </div>
              <div className="space-y-2">
                {selectedRunModelTelemetry.map((entry) => (
                  <div
                    key={entry.model}
                    className={`rounded-md border px-3 py-2 flex items-center justify-between gap-3 ${providerTone(entry.provider)}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderGlyph provider={entry.provider} />
                      <span className="mono text-xs truncate">{entry.model}</span>
                    </div>
                    <span className="mono text-[11px] text-text-muted">
                      {formatInt(entry.tokens)} tokens
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3 mb-6">
            {selectedRun.taskId ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => navigate(`/task/${selectedRun.taskId}/receipt`)}
              >
                Open Task Receipt
              </button>
            ) : null}
            {selectedRun.explorerUrl ? (
              <a
                href={selectedRun.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary"
              >
                Open Explorer
              </a>
            ) : null}
            {selectedRun.merkleRoot ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(selectedRun.merkleRoot ?? "");
                }}
              >
                Copy Merkle Root
              </button>
            ) : null}
          </div>

          <div className="border border-border-subtle rounded-md p-4 bg-void overflow-x-auto">
            <div className="mono text-xs text-text-muted mb-2">RAW RUN PAYLOAD</div>
            <pre className="mono text-xs text-text-secondary whitespace-pre-wrap wrap-break-word m-0">
              {JSON.stringify(selectedRun.raw, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}

      {demoReport ? (
        <div className="card p-4 sm:p-8 w-full mt-8">
          <h3 className="mb-2 text-lg font-semibold">Demo Validation Snapshot</h3>
          <p className="text-sm text-text-secondary mb-8">
            Rich runtime details extracted from the latest local demo report.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {demoHighlights.map((highlight) => (
              <div key={highlight.label} className="border border-border-subtle rounded-lg p-4 bg-void">
                <div className="mono text-xs text-text-muted mb-2">{highlight.label}</div>
                <div className="text-sm text-text-primary wrap-break-word">{highlight.value}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
              <h4 className="text-sm font-semibold mb-4">Acceptance Checks</h4>
              <div className="space-y-2">
                {acceptanceRows.length === 0 ? (
                  <div className="mono text-xs text-text-muted">No acceptance checks captured.</div>
                ) : acceptanceRows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between border border-border-subtle rounded-md px-3 py-2 bg-void"
                  >
                    <span className="text-sm text-text-secondary">{row.label}</span>
                    <span className={`badge ${row.passed ? "" : "border-red-500/40 text-red-300"}`}>
                      {row.passed ? "PASS" : "FAIL"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold mb-4">On-chain Transaction Trail</h4>
              <div className="space-y-2">
                {demoTxRows.length === 0 ? (
                  <div className="mono text-xs text-text-muted">No chain transactions available.</div>
                ) : demoTxRows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between border border-border-subtle rounded-md px-3 py-2 bg-void"
                  >
                    <span className="text-sm text-text-secondary">{row.label}</span>
                    {row.url ? (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mono text-accent text-xs inline-flex items-center gap-2"
                      >
                        {row.hash} <ExternalLink size={12} />
                      </a>
                    ) : (
                      <span className="mono text-text-muted text-xs">{row.hash}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildSummary(
  payload: BenchmarkPayload | null,
  demoReport: BenchmarkDemoReport | undefined,
): BenchmarkSummary | null {
  const runDerivedSummary = summarizeRunsByMechanism(extractRuns(payload, demoReport));
  const explicitSummary = payload?.post_learning?.summary ?? payload?.summary ?? payload?.pre_learning?.summary;
  if (explicitSummary) {
    return runDerivedSummary ? mergeSummaries(explicitSummary, runDerivedSummary) : explicitSummary;
  }

  if (runDerivedSummary) {
    return runDerivedSummary;
  }

  const runSummary = demoReport?.run_summary;
  const perMode = getRecord(runSummary?.per_mode);
  const perCategory = getRecord(runSummary?.per_category);
  if (Object.keys(perMode).length > 0 || Object.keys(perCategory).length > 0) {
    return {
      per_mode: perMode as Record<string, Record<string, number>>,
      per_category: perCategory as Record<string, Record<string, Record<string, number>>>,
    };
  }

  const mechanism = getString(demoReport?.mechanism) ?? getString(demoReport?.run_result?.mechanism);
  const confidence = getNumber(demoReport?.run_result?.confidence) ?? getNumber(demoReport?.run_summary?.confidence);
  const totalTokens = getNumber(demoReport?.run_result?.total_tokens_used) ?? getNumber(demoReport?.run_summary?.total_tokens_used);
  const latencyMs = getNumber(demoReport?.run_result?.latency_ms) ?? getNumber(demoReport?.run_summary?.latency_ms);
  if (!mechanism) {
    return null;
  }

  return {
    per_mode: {
      [mechanism]: {
        accuracy: confidence ?? 0,
        avg_tokens: totalTokens ?? 0,
        avg_latency_ms: latencyMs ?? 0,
      },
    },
    per_category: {
      demo: {
        [mechanism]: {
          accuracy: confidence ?? 0,
          avg_tokens: totalTokens ?? 0,
          avg_latency_ms: latencyMs ?? 0,
        },
      },
    },
  };
}

function extractRuns(
  payload: BenchmarkPayload | null,
  demoReport: BenchmarkDemoReport | undefined,
): Array<Record<string, unknown>> {
  const sections = [
    payload?.post_learning?.runs,
    payload?.pre_learning?.runs,
    payload?.learning_updates?.runs,
    payload?.runs,
  ];

  for (const section of sections) {
    if (Array.isArray(section) && section.length > 0) {
      return section;
    }
  }

  const runResult = getRecord(demoReport?.run_result);
  const runSummary = getRecord(demoReport?.run_summary);
  const statusAfterRun = getRecord(demoReport?.status_after_run);
  const statusAfterPay = getRecord(demoReport?.status_after_pay);
  const timeline = getRecord((demoReport as Record<string, unknown> | undefined)?.event_timeline);

  if (Object.keys(runResult).length === 0 && Object.keys(statusAfterRun).length === 0) {
    return [];
  }

  return [
    {
      task_id: getString(statusAfterRun.task_id) ?? getString(statusAfterPay.task_id),
      task: getString(statusAfterRun.task_text) ?? getString(demoReport?.query) ?? "Benchmark demo run",
      mode: getString(runResult.mechanism) ?? getString(statusAfterRun.mechanism) ?? getString(demoReport?.mechanism) ?? "selector",
      latency_ms:
        getNumber(runResult.latency_ms)
        ?? getNumber(runSummary.latency_ms)
        ?? getNumber(runSummary.total_latency_ms)
        ?? 0,
      total_tokens_used: getNumber(runResult.total_tokens_used) ?? getNumber(runSummary.total_tokens_used) ?? 0,
      confidence: getNumber(runResult.confidence) ?? getNumber(runSummary.confidence),
      agent_models_used: getStringArray(runResult.agent_models_used).length > 0
        ? getStringArray(runResult.agent_models_used)
        : getStringArray(runSummary.agent_models_used),
      merkle_root: getString(runResult.merkle_root) ?? getString(statusAfterRun.merkle_root),
      explorer_url: getString(statusAfterRun.explorer_url) ?? getString(statusAfterPay.explorer_url),
      status: getString(statusAfterPay.status) ?? getString(statusAfterRun.status) ?? getString(demoReport?.final_status),
      payment_status: getString(statusAfterPay.payment_status) ?? getString(statusAfterRun.payment_status),
      event_count: getNumber(timeline.event_count) ?? getNumber(runSummary.event_count),
      error: getString((demoReport as Record<string, unknown> | undefined)?.error),
    },
  ];
}

function normalizeRun(run: Record<string, unknown>, index: number): BenchmarkRunRow {
  const taskId = getString(run.task_id);
  const mode = getString(run.mechanism_used) ?? getString(run.mechanism) ?? getString(run.mode) ?? "run";
  const task = getString(run.task) ?? getString(run.task_text) ?? `Benchmark run ${index + 1}`;
  const merkleRoot = getString(run.merkle_root);
  const modelCounts = getRecord(run.model_counts);
  const modelsFromCounts = Object.entries(modelCounts)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map(([name]) => name);
  const models = (() => {
    const fromAgentModels = getStringArray(run.agent_models_used);
    if (fromAgentModels.length > 0) {
      return fromAgentModels;
    }
    if (modelsFromCounts.length > 0) {
      return modelsFromCounts;
    }
    return getStringArray(run.models);
  })();

  return {
    key: `${taskId ?? `run-${index}`}-${mode}`,
    task,
    mode,
    status: getString(run.status) ?? getString(run.final_status) ?? "unknown",
    confidence: getNumber(run.confidence),
    totalTokens: getNumber(run.total_tokens_used) ?? getNumber(run.tokens_used) ?? 0,
    models,
    error: getString(run.error),
    eventCount: getNumber(run.event_count),
    paymentStatus: getString(run.payment_status),
    latencyMs: getNumber(run.latency_ms) ?? getNumber(run.total_latency_ms) ?? 0,
    merkleRoot,
    explorerUrl: getString(run.explorer_url) ?? getString(run.receipt_explorer_url),
    taskId,
    raw: run,
  };
}

function mergeSummaries(primary: BenchmarkSummary, fallback: BenchmarkSummary): BenchmarkSummary {
  const mergedPerMode: Record<string, Record<string, number>> = {
    ...fallback.per_mode,
    ...primary.per_mode,
  };

  const mergedPerCategory: Record<string, Record<string, Record<string, number>>> = {
    ...fallback.per_category,
  };

  for (const [category, metricsByMode] of Object.entries(primary.per_category)) {
    mergedPerCategory[category] = {
      ...(fallback.per_category[category] ?? {}),
      ...metricsByMode,
    };
  }

  return {
    per_mode: mergedPerMode,
    per_category: mergedPerCategory,
  };
}

function summarizeRunsByMechanism(runs: Array<Record<string, unknown>>): BenchmarkSummary | null {
  if (!runs.length) {
    return null;
  }

  type Aggregate = {
    count: number;
    trueCount: number;
    confidenceSum: number;
    confidenceCount: number;
    tokensSum: number;
    latencySum: number;
  };

  const perMode: Record<string, Aggregate> = {};
  const perCategory: Record<string, Record<string, Aggregate>> = {};

  for (const run of runs) {
    const category = (getString(run.category) ?? "demo").toLowerCase();
    const mechanism = normalizeMechanism(
      getString(run.mechanism_used)
      ?? getString(run.mechanism)
      ?? getString(run.mode)
      ?? "selector",
    );

    const correct = typeof run.correct === "boolean" ? run.correct : null;
    const confidence = getNumber(run.confidence);
    const tokens = getNumber(run.tokens_used) ?? getNumber(run.total_tokens_used) ?? 0;
    const latency = getNumber(run.latency_ms) ?? 0;

    if (!perMode[mechanism]) {
      perMode[mechanism] = {
        count: 0,
        trueCount: 0,
        confidenceSum: 0,
        confidenceCount: 0,
        tokensSum: 0,
        latencySum: 0,
      };
    }

    if (!perCategory[category]) {
      perCategory[category] = {};
    }
    if (!perCategory[category][mechanism]) {
      perCategory[category][mechanism] = {
        count: 0,
        trueCount: 0,
        confidenceSum: 0,
        confidenceCount: 0,
        tokensSum: 0,
        latencySum: 0,
      };
    }

    const modeAggregate = perMode[mechanism];
    const categoryAggregate = perCategory[category][mechanism];

    for (const aggregate of [modeAggregate, categoryAggregate]) {
      aggregate.count += 1;
      if (correct === true) {
        aggregate.trueCount += 1;
      }
      if (confidence !== null) {
        aggregate.confidenceSum += confidence;
        aggregate.confidenceCount += 1;
      }
      aggregate.tokensSum += tokens;
      aggregate.latencySum += latency;
    }
  }

  const toMetrics = (aggregate: Aggregate): Record<string, number> => {
    const accuracyFromCorrect = aggregate.count > 0 ? aggregate.trueCount / aggregate.count : 0;
    const confidenceFallback = aggregate.confidenceCount > 0 ? aggregate.confidenceSum / aggregate.confidenceCount : 0;
    const accuracy = Math.max(accuracyFromCorrect, confidenceFallback);

    return {
      accuracy,
      avg_tokens: aggregate.count > 0 ? aggregate.tokensSum / aggregate.count : 0,
      avg_latency_ms: aggregate.count > 0 ? aggregate.latencySum / aggregate.count : 0,
    };
  };

  const modeSummary: Record<string, Record<string, number>> = {};
  for (const [mechanism, aggregate] of Object.entries(perMode)) {
    modeSummary[mechanism] = toMetrics(aggregate);
  }

  const categorySummary: Record<string, Record<string, Record<string, number>>> = {};
  for (const [category, mechanisms] of Object.entries(perCategory)) {
    categorySummary[category] = {};
    for (const [mechanism, aggregate] of Object.entries(mechanisms)) {
      categorySummary[category][mechanism] = toMetrics(aggregate);
    }
  }

  return {
    per_mode: modeSummary,
    per_category: categorySummary,
  };
}

function normalizeMechanism(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "selector";
  }
  if (normalized === "full_debate") {
    return "debate";
  }
  if (normalized === "isp_vote") {
    return "vote";
  }
  return normalized;
}

function buildTxRows(demoReport: BenchmarkDemoReport | undefined): Array<{ label: string; hash: string; url: string | null }> {
  const txSummary = getRecord(demoReport?.tx_summary);
  const rows = [
    {
      label: "Initialize",
      hash: getString(txSummary.initialize_tx_hash),
      url: getString(txSummary.initialize_explorer_url),
    },
    {
      label: "Receipt",
      hash: getString(txSummary.receipt_tx_hash),
      url: getString(txSummary.receipt_explorer_url),
    },
    {
      label: "Payment",
      hash: getString(txSummary.payment_tx_hash),
      url: getString(txSummary.payment_explorer_url),
    },
  ];

  const mapped: Array<{ label: string; hash: string; url: string | null }> = [];
  for (const row of rows) {
    if (!row.hash) {
      continue;
    }
    mapped.push({
      label: row.label,
      hash: `${row.hash.slice(0, 12)}...`,
      url: row.url,
    });
  }
  return mapped;
}

function buildAcceptanceRows(demoReport: BenchmarkDemoReport | undefined): Array<{ label: string; passed: boolean }> {
  const checks = getRecord(demoReport?.acceptance_checks);
  return Object.entries(checks)
    .map(([key, value]) => ({
      label: titleCase(key.replaceAll("_", " ")),
      passed: Boolean(value),
    }));
}

function buildDemoHighlights(demoReport: BenchmarkDemoReport | undefined): Array<{ label: string; value: string }> {
  const runResult = getRecord(demoReport?.run_result);
  const summary = getRecord(demoReport?.run_summary);

  return [
    {
      label: "Artifact",
      value: getString(demoReport?.artifact) ?? "n/a",
    },
    {
      label: "Final Status",
      value: getString(demoReport?.final_status) ?? getString(summary.final_status) ?? "unknown",
    },
    {
      label: "Mechanism",
      value: titleCase(getString(demoReport?.mechanism) ?? getString(runResult.mechanism) ?? "unknown"),
    },
    {
      label: "Final Answer",
      value: getString(runResult.final_answer) ?? getString(summary.final_answer) ?? "n/a",
    },
    {
      label: "Confidence",
      value: formatPercent(getNumber(runResult.confidence) ?? getNumber(summary.confidence)),
    },
    {
      label: "Latency",
      value: formatMs(getNumber(runResult.latency_ms) ?? getNumber(summary.latency_ms)),
    },
    {
      label: "Total Tokens",
      value: formatInt(getNumber(runResult.total_tokens_used) ?? getNumber(summary.total_tokens_used)),
    },
  ];
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function getNumericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0)
      .map(([key, entry]) => [key, entry as number]),
  );
}

function buildModelTelemetry(run: BenchmarkRunRow): ModelTelemetryRow[] {
  const candidateMaps = [
    getNumericRecord(run.raw.model_token_usage),
    getNumericRecord(run.raw.per_model_tokens),
    getNumericRecord(run.raw.model_tokens),
    getNumericRecord(run.raw.token_distribution),
  ];

  const tokenMap = candidateMaps.find((entry) => Object.keys(entry).length > 0) ?? {};
  if (Object.keys(tokenMap).length > 0) {
    return Object.entries(tokenMap)
      .sort((left, right) => right[1] - left[1])
      .map(([model, tokens]) => ({
        model,
        tokens,
        provider: providerFromModel(model),
      }));
  }

  if (run.models.length === 0) {
    return [];
  }

  const evenSplit = run.models.length > 0 ? Math.floor(run.totalTokens / run.models.length) : 0;
  const remainder = run.models.length > 0 ? run.totalTokens % run.models.length : 0;

  return run.models.map((model, index) => ({
    model,
    tokens: Math.max(0, evenSplit + (index < remainder ? 1 : 0)),
    provider: providerFromModel(model),
  }));
}

function getRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${value.toFixed(0)} ms`;
}

function formatInt(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return Math.round(value).toLocaleString();
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function formatCounterPreview(counter: Record<string, number>): string {
  const entries = Object.entries(counter)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) {
    return "n/a";
  }
  return entries
    .slice(0, 2)
    .map(([name, count]) => `${name}:${count}`)
    .join(" • ");
}

function CatalogTable({ entries }: { entries: BenchmarkCatalogEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-text-secondary">No entries yet.</p>;
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.artifact_id} className="border border-border-subtle rounded-md px-3 py-3 bg-void">
          <div className="flex flex-wrap gap-2 items-center mb-1">
            <span className="mono text-xs text-text-muted">{entry.artifact_id.slice(0, 16)}...</span>
            <span className="badge">{titleCase(entry.scope)}</span>
            <span className="badge">score {entry.frequency_score}</span>
          </div>
          <div className="text-xs text-text-secondary mb-1">
            Runs {entry.run_count} • {formatDateTime(entry.created_at)}
          </div>
          <div className="mono text-xs text-text-muted">
            mech {formatCounterPreview(entry.mechanism_counts)}
            {Object.keys(entry.model_counts).length > 0
              ? ` • model ${formatCounterPreview(entry.model_counts)}`
              : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function UserTestsTable({ entries }: { entries: BenchmarkRunStatusPayload[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-text-secondary">No test results yet.</p>;
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div key={entry.run_id} className="border border-border-subtle rounded-md px-3 py-3 bg-void">
          <div className="flex flex-wrap gap-2 items-center mb-1">
            <span className="mono text-xs text-text-muted">{entry.run_id.slice(0, 16)}...</span>
            <span className="badge">{titleCase(entry.status)}</span>
          </div>
          <div className="mono text-xs text-text-secondary">
            Updated {formatDateTime(entry.updated_at)}
            {entry.artifact_id ? ` • artifact ${entry.artifact_id}` : ""}
          </div>
          {entry.error ? (
            <div className="mono text-xs text-red-300 mt-1">{entry.error}</div>
          ) : null}
        </div>
      ))}
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
