import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCcw } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  ApiRequestError,
  getBenchmarkDetail,
  streamBenchmarkRun,
  type BenchmarkDetailPayload,
  type TaskEvent,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { providerFromModel, providerTone } from "../lib/modelProviders";

interface NormalizedMetric {
  accuracy: number;
  avg_tokens: number;
  avg_thinking_tokens: number;
  avg_latency_ms: number;
  avg_estimated_cost_usd: number;
}

interface NormalizedSummary {
  per_mode: Record<string, NormalizedMetric>;
  per_category: Record<string, Record<string, NormalizedMetric>>;
}

const DEFAULT_METRIC: NormalizedMetric = {
  accuracy: 0,
  avg_tokens: 0,
  avg_thinking_tokens: 0,
  avg_latency_ms: 0,
  avg_estimated_cost_usd: 0,
};

export function BenchmarkDetail() {
  const navigate = useNavigate();
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const { authStatus, getAccessToken } = useAuth();

  const [detail, setDetail] = useState<BenchmarkDetailPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [timeline, setTimeline] = useState<TaskEvent[]>([]);

  const loadDetail = useCallback(async () => {
    if (!benchmarkId) {
      setLoadError("Benchmark id is required.");
      setDetail(null);
      return;
    }

    setLoadError(null);
    setIsRefreshing(true);
    try {
      const token = await getAccessToken();
      const payload = await getBenchmarkDetail(token, benchmarkId);
      setDetail(payload);
      setTimeline(payload.events ?? []);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setLoadError(error.message);
      } else {
        console.error(error);
        setLoadError("Unable to load benchmark report.");
      }
      setDetail(null);
    } finally {
      setIsRefreshing(false);
    }
  }, [benchmarkId, getAccessToken]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      return;
    }
    void loadDetail();
  }, [authStatus, loadDetail]);

  useEffect(() => {
    if (!detail?.artifact_id || !detail.run_id || !benchmarkId) {
      return;
    }
    if (detail.status !== "completed") {
      return;
    }
    if (benchmarkId === detail.artifact_id) {
      return;
    }
    navigate(`/benchmarks/${detail.artifact_id}`, { replace: true });
  }, [benchmarkId, detail?.artifact_id, detail?.run_id, detail?.status, navigate]);

  const detailRunId = detail?.run_id ?? benchmarkId;
  const detailStatus = detail?.status;

  useEffect(() => {
    if (authStatus !== "authenticated" || !detailRunId) {
      return;
    }
    if (detailStatus !== "queued" && detailStatus !== "running") {
      return;
    }

    let cancelled = false;
    let handle: { close: () => void } | null = null;

    void (async () => {
      const token = await getAccessToken();
      handle = await streamBenchmarkRun(detailRunId, token, (event) => {
        if (cancelled) {
          return;
        }
        setTimeline((current) => {
          const exists = current.some(
            (entry) => entry.event === event.event && entry.timestamp === event.timestamp,
          );
          return exists ? current : [...current, event];
        });

        const data = event.data as Record<string, unknown>;
        const telemetry = typeof data.telemetry === "object" && data.telemetry !== null
          ? (data.telemetry as Record<string, unknown>)
          : null;

        if (telemetry) {
          setDetail((current) => {
            if (!current) {
              return current;
            }
            return {
              ...current,
              status: event.event === "failed" ? "failed" : current.status,
              latest_mechanism: typeof data.latest_mechanism === "string" ? data.latest_mechanism : current.latest_mechanism,
              agent_count: isPositiveInteger(telemetry.agent_count) ? telemetry.agent_count : current.agent_count,
              total_tokens: typeof telemetry.total_tokens === "number" ? telemetry.total_tokens : current.total_tokens,
              thinking_tokens: typeof telemetry.thinking_tokens === "number" ? telemetry.thinking_tokens : current.thinking_tokens,
              total_latency_ms: typeof telemetry.total_latency_ms === "number" ? telemetry.total_latency_ms : current.total_latency_ms,
              model_telemetry: (telemetry.model_telemetry as typeof current.model_telemetry) ?? current.model_telemetry,
              cost: (telemetry.cost as typeof current.cost) ?? current.cost,
            };
          });
        }

        if (event.event === "artifact_created" || event.event === "complete" || event.event === "failed") {
          void loadDetail();
        }
      });
    })().catch((error: unknown) => {
      if (!cancelled) {
        console.error(error);
      }
    });

    return () => {
      cancelled = true;
      handle?.close();
    };
  }, [authStatus, detailRunId, detailStatus, getAccessToken, loadDetail]);

  const summary = useMemo<NormalizedSummary>(() => {
    return normalizeSummary(detail?.summary, detail?.benchmark_payload);
  }, [detail]);

  const modeRows = useMemo(() => {
    const keys = Object.keys(summary.per_mode);
    return keys.map((mechanism) => {
      const metric = summary.per_mode[mechanism] ?? DEFAULT_METRIC;
      return {
        mechanism: titleCase(mechanism),
        accuracy: Number((metric.accuracy * 100).toFixed(2)),
        avgTokens: Math.round(metric.avg_tokens),
        thinkingTokens: Math.round(metric.avg_thinking_tokens),
        avgLatencyMs: Math.round(metric.avg_latency_ms),
        avgCostUsd: Number(metric.avg_estimated_cost_usd.toFixed(6)),
      };
    });
  }, [summary]);

  const categoryRows = useMemo(() => {
    const categories = Object.keys(summary.per_category);
    return categories.map((category) => {
      const perMode = summary.per_category[category] ?? {};
      return {
        category: titleCase(category),
        debate: Number(((perMode.debate?.accuracy ?? 0) * 100).toFixed(1)),
        vote: Number(((perMode.vote?.accuracy ?? 0) * 100).toFixed(1)),
        selector: Number(((perMode.selector?.accuracy ?? 0) * 100).toFixed(1)),
      };
    });
  }, [summary]);

  const modelList = useMemo(() => {
    if (!detail) {
      return [];
    }
    if (detail.models.length > 0) {
      return detail.models;
    }
    if (detail.model_telemetry && Object.keys(detail.model_telemetry).length > 0) {
      return Object.keys(detail.model_telemetry);
    }
    return Object.keys(detail.model_counts);
  }, [detail]);

  const estimatedBudgetPerAgent = useMemo(() => {
    if (!detail) {
      return null;
    }
    const agentCount = detail.agent_count ?? 0;
    const totalCost = detail.cost?.estimated_cost_usd ?? 0;
    if (agentCount <= 0 || !Number.isFinite(totalCost) || totalCost <= 0) {
      return null;
    }
    return totalCost / agentCount;
  }, [detail]);

  const costByModel = detail?.cost?.model_estimated_costs_usd
    ? Object.entries(detail.cost.model_estimated_costs_usd)
      .sort((a, b) => b[1] - a[1])
    : [];

  const modelTelemetryRows = detail?.model_telemetry
    ? Object.entries(detail.model_telemetry)
      .sort((a, b) => (b[1]?.total_tokens ?? 0) - (a[1]?.total_tokens ?? 0))
    : [];

  const resolvedPrompts = (() => {
    const request = detail?.request;
    if (!request || typeof request !== "object") {
      return [];
    }
    const prompts = request.resolved_domain_prompts;
    if (typeof prompts !== "object" || prompts === null) {
      const rawPrompts = request.domain_prompts;
      if (typeof rawPrompts !== "object" || rawPrompts === null) {
        return [];
      }
      return Object.entries(rawPrompts as Record<string, Record<string, unknown>>);
    }
    return Object.entries(prompts as Record<string, Record<string, unknown>>);
  })();

  if (loadError) {
    return (
      <div className="max-w-250 mx-auto pb-20 w-full">
        <button type="button" className="btn-secondary mb-6 inline-flex items-center gap-2" onClick={() => navigate("/benchmarks") }>
          <ArrowLeft size={14} /> Back to overview
        </button>
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="max-w-250 mx-auto pb-20 w-full">
        <button type="button" className="btn-secondary mb-6 inline-flex items-center gap-2" onClick={() => navigate("/benchmarks") }>
          <ArrowLeft size={14} /> Back to overview
        </button>
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">Loading benchmark report...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-250 mx-auto pb-20 w-full">
      <header className="mb-8">
        <div className="flex flex-wrap gap-3 mb-5">
          <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => navigate("/benchmarks") }>
            <ArrowLeft size={14} /> Overview
          </button>
          <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => navigate("/benchmarks/all") }>
            <ArrowLeft size={14} /> All artifacts
          </button>
          <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => void loadDetail()}>
            {isRefreshing ? <RefreshCcw size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            Refresh
          </button>
        </div>

        <h1 className="text-3xl md:text-4xl mb-4">Benchmark Report</h1>
        <div className="space-y-1">
          <div className="mono text-xs text-text-muted">ARTIFACT {detail.artifact_id ?? detail.benchmark_id}</div>
          <div className="mono text-xs text-text-muted">SOURCE {detail.source}</div>
          <div className="mono text-xs text-text-muted">
            CREATED {formatDateTime(detail.created_at)} • UPDATED {formatDateTime(detail.updated_at)}
          </div>
        </div>
      </header>

      {detail.status === "queued" || detail.status === "running" ? (
        <div className="card p-4 sm:p-6 mb-8 border border-accent/40">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <div className="mono text-xs text-text-muted mb-1">LIVE STATUS</div>
              <div className="text-lg text-text-primary">{titleCase(detail.status)}</div>
            </div>
            <div className="mono text-xs text-text-secondary">
              {detail.run_id ?? detail.benchmark_id}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm text-text-secondary">
            <div>Tokens {formatMaybeRuntimeInt(detail.total_tokens, detail.status)}</div>
            <div>Thinking {formatMaybeRuntimeInt(detail.thinking_tokens, detail.status)}</div>
            <div>Latency {formatMaybeRuntimeLatency(detail.total_latency_ms ?? null, detail.status)}</div>
            <div>Cost {formatUsd(detail.cost?.estimated_cost_usd ?? null)}</div>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-8 gap-4 mb-8">
        <MetricCard label="Scope" value={titleCase(detail.scope)} />
        <MetricCard label="Runs" value={formatInt(detail.run_count)} />
        <MetricCard label="Agents" value={formatMaybeInt(detail.agent_count)} />
        <MetricCard label="Mechanism" value={detail.latest_mechanism ? titleCase(detail.latest_mechanism) : "n/a"} />
        <MetricCard label="Total Tokens" value={formatMaybeRuntimeInt(detail.total_tokens, detail.status)} />
        <MetricCard label="Thinking Tokens" value={formatMaybeRuntimeInt(detail.thinking_tokens, detail.status)} />
        <MetricCard label="Latency" value={formatMaybeRuntimeLatency(detail.total_latency_ms ?? null, detail.status)} />
        <MetricCard label="Budget / Agent" value={formatUsd(estimatedBudgetPerAgent)} />
        <MetricCard label="Estimated Cost" value={formatUsd(detail.cost?.estimated_cost_usd ?? null)} />
      </div>

      {timeline.length > 0 ? (
        <div className="card p-4 sm:p-6 mb-8">
          <h3 className="text-lg font-semibold mb-3">Run Timeline</h3>
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {timeline.map((event, index) => (
              <div key={`${event.event}-${event.timestamp ?? index}`} className="border border-border-subtle rounded-md p-3 bg-void">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className="mono text-xs text-text-primary">{event.event.replace(/_/g, " ")}</div>
                  <div className="mono text-[10px] text-text-muted">{formatDateTime(event.timestamp)}</div>
                </div>
                <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-words">
                  {prettyJson(event.data)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card p-4 sm:p-8 mb-8">
        <h3 className="mb-2 text-lg font-semibold">Mechanism Performance</h3>
        <p className="text-sm text-text-secondary mb-8">
          Accuracy percent by mechanism for the selected benchmark artifact.
        </p>
        <div className="w-full h-70">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={modeRows} margin={{ top: 20, right: 10, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" vertical={false} />
              <XAxis
                dataKey="mechanism"
                stroke="var(--color-text-muted)"
                tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
              />
              <YAxis
                stroke="var(--color-text-muted)"
                domain={[0, 100]}
                tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
              />
              <Tooltip />
              <Bar dataKey="accuracy" name="Accuracy (%)" fill="var(--color-accent)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-4 sm:p-8 mb-8 overflow-x-auto">
        <h3 className="mb-2 text-lg font-semibold">Category Accuracy Matrix</h3>
        <p className="text-sm text-text-secondary mb-6">Per-category accuracy percentage across debate, vote, and selector mechanisms.</p>

        {categoryRows.length === 0 ? (
          <p className="text-sm text-text-secondary">No category metrics found in this artifact.</p>
        ) : (
          <table className="w-full min-w-150 border-collapse">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left py-2 px-3 mono text-xs text-text-muted">CATEGORY</th>
                <th className="text-right py-2 px-3 mono text-xs text-text-muted">DEBATE</th>
                <th className="text-right py-2 px-3 mono text-xs text-text-muted">VOTE</th>
                <th className="text-right py-2 px-3 mono text-xs text-text-muted">SELECTOR</th>
              </tr>
            </thead>
            <tbody>
              {categoryRows.map((row) => (
                <tr key={row.category} className="border-b border-border-subtle/70">
                  <td className="py-2 px-3 text-sm text-text-primary">{row.category}</td>
                  <td className="py-2 px-3 text-sm text-right text-text-secondary">{row.debate.toFixed(1)}%</td>
                  <td className="py-2 px-3 text-sm text-right text-text-secondary">{row.vote.toFixed(1)}%</td>
                  <td className="py-2 px-3 text-sm text-right text-accent">{row.selector.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="card p-4 sm:p-6">
          <h3 className="text-lg font-semibold mb-3">Model Mix</h3>
          {modelList.length === 0 ? (
            <p className="text-sm text-text-secondary">No model metadata found.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {modelList.map((model) => {
                const provider = providerFromModel(model);
                return (
                  <span
                    key={model}
                    className={`inline-flex items-center gap-1.5 border rounded-full px-2 py-1 mono text-[11px] ${providerTone(provider)}`}
                  >
                    <ProviderGlyph provider={provider} />
                    <span>{model}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="card p-4 sm:p-6">
          <h3 className="text-lg font-semibold mb-3">Cost Breakdown</h3>
          {costByModel.length === 0 ? (
            <p className="text-sm text-text-secondary">No model-level cost estimates available.</p>
          ) : (
            <div className="space-y-2">
              {costByModel.map(([model, cost]) => (
                <div key={model} className="flex items-center justify-between gap-3 text-sm">
                  <span className="inline-flex items-center gap-2 text-text-secondary truncate">
                    <ProviderGlyph provider={providerFromModel(model)} />
                    <span className="truncate">{model}</span>
                  </span>
                  <span className="mono text-text-primary">{formatUsd(cost)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mono text-xs text-text-muted mt-4">
            Pricing version {detail.cost?.pricing_version ?? "n/a"} • estimated {formatDateTime(detail.cost?.estimated_at ?? null)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="card p-4 sm:p-6">
          <h3 className="text-lg font-semibold mb-3">Model Telemetry</h3>
          {modelTelemetryRows.length === 0 ? (
            <p className="text-sm text-text-secondary">No model telemetry available yet.</p>
          ) : (
            <div className="space-y-3">
              {modelTelemetryRows.map(([model, telemetry]) => (
                <div key={model} className="border border-border-subtle rounded-md p-3 bg-void">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="inline-flex items-center gap-2 text-text-primary">
                      <ProviderGlyph provider={providerFromModel(model)} />
                      <span className="text-sm">{model}</span>
                    </span>
                    <span className="mono text-[10px] text-text-muted">{telemetry.estimation_mode ?? "n/a"}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-text-secondary">
                    <div>Total {formatMaybeInt(telemetry.total_tokens)}</div>
                    <div>Input {formatMaybeInt(telemetry.input_tokens)}</div>
                    <div>Output {formatMaybeInt(telemetry.output_tokens)}</div>
                    <div>Thinking {formatMaybeInt(telemetry.thinking_tokens)}</div>
                    <div>Latency {formatLatency(telemetry.latency_ms ?? null)}</div>
                    <div>Cost {formatUsd(telemetry.estimated_cost_usd ?? null)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-4 sm:p-6">
          <h3 className="text-lg font-semibold mb-3">Question Configuration</h3>
          {resolvedPrompts.length === 0 ? (
            <p className="text-sm text-text-secondary">No resolved domain questions stored for this benchmark.</p>
          ) : (
            <div className="space-y-3">
              {resolvedPrompts.map(([domain, question]) => {
                const sourceLabel = String(
                  question.source ?? (String(question.template_id ?? "") === "custom" ? "custom" : "template"),
                );
                return (
                  <div key={domain} className="border border-border-subtle rounded-md p-3 bg-void">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-sm text-text-primary">{titleCase(domain)}</span>
                      <span className="mono text-[10px] text-text-muted">{sourceLabel}</span>
                    </div>
                    <div className="mono text-[10px] text-text-muted mb-2">
                      {String(question.template_title ?? question.template_id ?? "Custom Question")}
                    </div>
                    <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">
                      {String(question.question ?? question.prompt ?? "")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <JsonPanel title="Request Snapshot" value={detail.request} />
        <JsonPanel title="Benchmark Payload" value={detail.benchmark_payload} />
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4 border border-border-subtle">
      <div className="mono text-xs text-text-muted mb-2">{label.toUpperCase()}</div>
      <div className="text-base text-text-primary break-all">{value}</div>
    </div>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="card p-4 sm:p-6">
      <h3 className="text-lg font-semibold mb-3">{title}</h3>
      <pre className="text-xs text-text-secondary overflow-auto max-h-96 bg-void border border-border-subtle rounded-md p-3">
        {prettyJson(value)}
      </pre>
    </div>
  );
}

function normalizeSummary(summaryCandidate: unknown, benchmarkPayloadCandidate: unknown): NormalizedSummary {
  const fromSummary = parseSummaryObject(summaryCandidate);
  if (hasSummaryData(fromSummary)) {
    return fromSummary;
  }

  const payloadSummary = extractSummaryFromBenchmarkPayload(benchmarkPayloadCandidate);
  const fromPayload = parseSummaryObject(payloadSummary);
  if (hasSummaryData(fromPayload)) {
    return fromPayload;
  }

  return {
    per_mode: {},
    per_category: {},
  };
}

function parseSummaryObject(candidate: unknown): NormalizedSummary {
  if (!isRecord(candidate)) {
    return { per_mode: {}, per_category: {} };
  }

  const perMode: Record<string, NormalizedMetric> = {};
  const perModeSource = candidate.per_mode;
  if (isRecord(perModeSource)) {
    for (const [mechanism, value] of Object.entries(perModeSource)) {
      perMode[mechanism] = parseMetric(value);
    }
  }

  const perCategory: Record<string, Record<string, NormalizedMetric>> = {};
  const perCategorySource = candidate.per_category;
  if (isRecord(perCategorySource)) {
    for (const [category, categoryValue] of Object.entries(perCategorySource)) {
      if (!isRecord(categoryValue)) {
        continue;
      }
      perCategory[category] = {};
      for (const [mechanism, value] of Object.entries(categoryValue)) {
        perCategory[category][mechanism] = parseMetric(value);
      }
    }
  }

  return {
    per_mode: perMode,
    per_category: perCategory,
  };
}

function parseMetric(candidate: unknown): NormalizedMetric {
  if (!isRecord(candidate)) {
    return { ...DEFAULT_METRIC };
  }

  return {
    accuracy: asNumber(candidate.accuracy),
    avg_tokens: asNumber(candidate.avg_tokens),
    avg_thinking_tokens: asNumber(candidate.avg_thinking_tokens),
    avg_latency_ms: asNumber(candidate.avg_latency_ms),
    avg_estimated_cost_usd: asNumber(candidate.avg_estimated_cost_usd),
  };
}

function extractSummaryFromBenchmarkPayload(candidate: unknown): unknown {
  if (!isRecord(candidate)) {
    return null;
  }

  if (isRecord(candidate.summary)) {
    return candidate.summary;
  }

  if (isRecord(candidate.post_learning) && isRecord(candidate.post_learning.summary)) {
    return candidate.post_learning.summary;
  }

  if (isRecord(candidate.pre_learning) && isRecord(candidate.pre_learning.summary)) {
    return candidate.pre_learning.summary;
  }

  return null;
}

function hasSummaryData(summary: NormalizedSummary): boolean {
  return Object.keys(summary.per_mode).length > 0 || Object.keys(summary.per_category).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
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

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  return `$${value.toFixed(6)}`;
}

function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  return `${Math.round(value)} ms`;
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  return Math.round(value).toLocaleString();
}

function formatMaybeInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }
  return Math.round(value).toLocaleString();
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function formatMaybeRuntimeInt(
  value: number | null | undefined,
  status: BenchmarkDetailPayload["status"] | null | undefined,
): string {
  if ((status === "queued" || status === "running") && (value === null || value === undefined || value <= 0)) {
    return "n/a";
  }
  return formatInt(value);
}

function formatMaybeRuntimeLatency(
  value: number | null | undefined,
  status: BenchmarkDetailPayload["status"] | null | undefined,
): string {
  if ((status === "queued" || status === "running") && (value === null || value === undefined || value <= 0)) {
    return "n/a";
  }
  return formatLatency(value);
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return "Unable to serialize payload";
  }
}
