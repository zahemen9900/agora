import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, Clipboard, Loader2, RefreshCcw } from "lucide-react";
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
  streamBenchmarkRun,
  type BenchmarkDetailPayload,
  type BenchmarkItemPayload,
  type TaskEvent,
} from "../lib/api";
import {
  benchmarkQueryKeys,
  patchBenchmarkDetailCache,
  setBenchmarkDetailCache,
  useBenchmarkDetailQuery,
} from "../lib/benchmarkQueries";
import { useAuth } from "../lib/useAuth";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { providerFromModel, providerTone } from "../lib/modelProviders";

interface NormalizedMetric {
  accuracy: number;
  run_count: number;
  scored_run_count: number;
  proxy_run_count: number;
  avg_tokens: number;
  avg_thinking_tokens: number;
  avg_latency_ms: number;
  avg_estimated_cost_usd: number;
}

interface NormalizedSummary {
  per_mode: Record<string, NormalizedMetric>;
  per_mechanism: Record<string, NormalizedMetric>;
  per_category: Record<string, Record<string, NormalizedMetric>>;
  completed_run_count: number;
  failed_run_count: number;
  degraded_run_count: number;
  scored_run_count: number;
  proxy_run_count: number;
}

interface BenchmarkTimelineDescriptor {
  label: string;
  title: string;
  summary: string;
  detailsLabel: string;
  tone: string;
}

interface AggregatedBenchmarkTimelineEvent extends BenchmarkTimelineDescriptor {
  key: string;
  timestamp: string | null;
  details: Record<string, unknown>;
}

interface BenchmarkReliabilitySummary {
  retryCount: number;
  terminalErrorCount: number;
  retryByProvider: Array<[string, number]>;
  phaseCounts: Array<[string, number]>;
}

const DEFAULT_METRIC: NormalizedMetric = {
  accuracy: 0,
  run_count: 0,
  scored_run_count: 0,
  proxy_run_count: 0,
  avg_tokens: 0,
  avg_thinking_tokens: 0,
  avg_latency_ms: 0,
  avg_estimated_cost_usd: 0,
};

const BENCHMARK_COALESCED_EVENT_TYPES = new Set([
  "agent_output_delta",
  "cross_examination_delta",
  "thinking_delta",
  "usage_delta",
]);

export function BenchmarkDetail() {
  const navigate = useNavigate();
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const detailQuery = useBenchmarkDetailQuery(benchmarkId);
  const detail = detailQuery.data ?? null;
  const loadError = !benchmarkId
    ? "Benchmark id is required."
    : !detail && detailQuery.error instanceof Error
      ? detailQuery.error.message
      : null;
  const isRefreshing = detailQuery.isFetching && Boolean(detail);
  const [timeline, setTimeline] = useState<TaskEvent[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [now, setNow] = useState(() => Date.now());
  const [phaseFilter, setPhaseFilter] = useState<string>("all");
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const latestTimelineEntryRef = useRef<HTMLDivElement | null>(null);
  const followTimelineRef = useRef(true);
  const copyTimeoutRef = useRef<number | null>(null);
  const streamedEventKeysRef = useRef<Set<string>>(new Set());

  const detailRunId = detail?.run_id ?? benchmarkId;
  const detailStatus = detail?.status;
  const benchmarkItems = useMemo(
    () => detail?.benchmark_items ?? [],
    [detail?.benchmark_items],
  );

  useEffect(() => {
    if (!detail || !benchmarkId) {
      return;
    }
    setBenchmarkDetailCache(queryClient, detail, benchmarkId);
  }, [benchmarkId, detail, queryClient]);

  useEffect(() => {
    if (!detail) {
      return;
    }

    setTimeline((current) => {
      const merged = mergeUniqueTaskEvents(current, detail.events ?? []);
      streamedEventKeysRef.current = new Set(merged.map(buildTaskEventKey));
      return merged;
    });
    setSelectedItemId((current) => {
      if (current && detail.benchmark_items.some((item) => item.item_id === current)) {
        return current;
      }
      return detail.active_item_id ?? detail.benchmark_items?.[0]?.item_id ?? null;
    });
  }, [detail]);

  useEffect(() => {
    if (detailStatus !== "queued" && detailStatus !== "running") {
      return;
    }

    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [detailStatus]);

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

  useEffect(() => {
    if (!detailRunId || !benchmarkId) {
      return;
    }
    if (detailStatus !== "queued" && detailStatus !== "running") {
      return;
    }

    let cancelled = false;
    let handle: { close: () => void } | null = null;

    void (async () => {
      handle = await streamBenchmarkRun(detailRunId, getAccessToken, (event) => {
        if (cancelled) {
          return;
        }
        const eventKey = buildTaskEventKey(event);
        if (streamedEventKeysRef.current.has(eventKey)) {
          return;
        }
        streamedEventKeysRef.current.add(eventKey);
        setTimeline((current) => mergeUniqueTaskEvents(current, [event]));
        patchBenchmarkDetailCache(queryClient, benchmarkId, (current) => (
          current ? applyBenchmarkStreamEventToDetail(current, event) : current
        ));

        if (
          event.event === "artifact_created"
          || event.event === "complete"
          || event.event === "failed"
          || event.event === "error"
        ) {
          void queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.detail(benchmarkId) });
          void queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.catalogAll() });
          void queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.overviewAll() });
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
  }, [benchmarkId, detailRunId, detailStatus, getAccessToken, queryClient]);

  const summary = useMemo<NormalizedSummary>(() => {
    return normalizeSummary(detail?.summary, detail?.benchmark_payload);
  }, [detail]);

  const mechanismSource =
    Object.keys(summary.per_mechanism).length > 0 ? summary.per_mechanism : summary.per_mode;

  const modeRows = useMemo(() => {
    const keys = Object.keys(mechanismSource);
    return keys.map((mechanism) => {
      const metric = mechanismSource[mechanism] ?? DEFAULT_METRIC;
      const scoredRunCount = Math.round(metric.scored_run_count);
      return {
        mechanism: titleCase(mechanism),
        accuracy: scoredRunCount > 0 ? Number((metric.accuracy * 100).toFixed(2)) : null,
        runCount: Math.round(metric.run_count),
        scoredRunCount,
        proxyRunCount: Math.round(metric.proxy_run_count),
        avgTokens: Math.round(metric.avg_tokens),
        thinkingTokens: Math.round(metric.avg_thinking_tokens),
        avgLatencyMs: Math.round(metric.avg_latency_ms),
        avgCostUsd: Number(metric.avg_estimated_cost_usd.toFixed(6)),
      };
    });
  }, [mechanismSource]);

  const categoryRows = useMemo(() => {
    const categories = Object.keys(summary.per_category);
    return categories.map((category) => {
      const perMode = summary.per_category[category] ?? {};
      const debateScoredRuns = Math.round(perMode.debate?.scored_run_count ?? 0);
      const voteScoredRuns = Math.round(perMode.vote?.scored_run_count ?? 0);
      const selectorScoredRuns = Math.round(perMode.selector?.scored_run_count ?? 0);
      return {
        category: titleCase(category),
        debate: debateScoredRuns > 0 ? Number(((perMode.debate?.accuracy ?? 0) * 100).toFixed(1)) : null,
        vote: voteScoredRuns > 0 ? Number(((perMode.vote?.accuracy ?? 0) * 100).toFixed(1)) : null,
        selector: selectorScoredRuns > 0 ? Number(((perMode.selector?.accuracy ?? 0) * 100).toFixed(1)) : null,
        debateScoredRuns,
        voteScoredRuns,
        selectorScoredRuns,
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

  const costByModel = useMemo(() => {
    if (!detail?.cost?.model_estimated_costs_usd) {
      return [];
    }
    return Object.entries(detail.cost.model_estimated_costs_usd)
      .sort((a, b) => b[1] - a[1]);
  }, [detail]);

  const costByModelMap = useMemo(() => new Map(costByModel), [costByModel]);

  const modelTelemetryRows = detail?.model_telemetry
    ? Object.entries(detail.model_telemetry)
      .sort((a, b) => (b[1]?.total_tokens ?? 0) - (a[1]?.total_tokens ?? 0))
    : [];

  const timelineJson = useMemo(() => prettyJson(timeline), [timeline]);
  const timelineByItem = useMemo(() => {
    const grouped = new Map<string, TaskEvent[]>();
    for (const event of timeline) {
      const itemId = benchmarkItemIdForEvent(event);
      if (!itemId) {
        continue;
      }
      const bucket = grouped.get(itemId) ?? [];
      bucket.push(event);
      grouped.set(itemId, bucket);
    }
    return grouped;
  }, [timeline]);
  const effectiveSelectedItemId = useMemo(() => {
    if (!selectedItemId || benchmarkItems.every((item) => item.item_id !== selectedItemId)) {
      return detail?.active_item_id ?? benchmarkItems[0]?.item_id ?? null;
    }
    return selectedItemId;
  }, [benchmarkItems, detail?.active_item_id, selectedItemId]);
  const selectedItem = useMemo(() => {
    if (benchmarkItems.length === 0) {
      return null;
    }
    if (effectiveSelectedItemId) {
      return benchmarkItems.find((item) => item.item_id === effectiveSelectedItemId) ?? benchmarkItems[0];
    }
    return detail?.active_item ?? benchmarkItems[0];
  }, [benchmarkItems, detail?.active_item, effectiveSelectedItemId]);
  const selectedItemTimeline = useMemo(() => {
    if (!selectedItem) {
      return [];
    }
    const streamed = timelineByItem.get(selectedItem.item_id) ?? [];
    if (streamed.length > 0) {
      return streamed;
    }
    return selectedItem.events ?? [];
  }, [selectedItem, timelineByItem]);
  const aggregatedSelectedItemTimeline = useMemo(
    () => aggregateBenchmarkTimeline(selectedItemTimeline),
    [selectedItemTimeline],
  );
  const availablePhases = useMemo(() => {
    const phases = new Set<string>();
    for (const event of timeline) {
      const phase = benchmarkPhaseForEvent(event);
      if (phase) {
        phases.add(phase);
      }
    }
    return ["all", ...Array.from(phases)];
  }, [timeline]);
  const effectivePhaseFilter = availablePhases.includes(phaseFilter) ? phaseFilter : "all";
  const filteredTimeline = useMemo(() => (
    effectivePhaseFilter === "all"
      ? timeline
      : timeline.filter((event) => benchmarkPhaseForEvent(event) === effectivePhaseFilter)
  ), [effectivePhaseFilter, timeline]);
  const aggregatedFilteredTimeline = useMemo(
    () => aggregateBenchmarkTimeline(filteredTimeline),
    [filteredTimeline],
  );
  const lastTimelineEvent = timeline.length > 0 ? timeline[timeline.length - 1] : null;
  const streamState = useMemo(
    () => deriveBenchmarkStreamState(detail?.status, lastTimelineEvent, now),
    [detail?.status, lastTimelineEvent, now],
  );
  const dominantMechanism = dominantCountEntry(detail?.mechanism_counts)?.[0] ?? detail?.latest_mechanism ?? null;
  const dominantModel = dominantCountEntry(detail?.model_counts)?.[0] ?? detail?.models[0] ?? null;
  const reliability = useMemo<BenchmarkReliabilitySummary>(() => {
    const retryCounter = new Map<string, number>();
    const phaseCounter = new Map<string, number>();
    let retryCount = 0;
    let terminalErrorCount = 0;

    for (const event of timeline) {
      const data = isRecord(event.data) ? event.data : {};
      const phase = benchmarkPhaseForEvent(event);
      if (phase) {
        phaseCounter.set(phase, (phaseCounter.get(phase) ?? 0) + 1);
      }
      if (event.event === "provider_retrying") {
        retryCount += 1;
        const provider = String(data.provider ?? providerFromModel(String(data.model ?? "unknown")));
        retryCounter.set(provider, (retryCounter.get(provider) ?? 0) + 1);
      }
      if (event.event === "failed" || event.event === "error") {
        terminalErrorCount += 1;
      }
    }

    return {
      retryCount,
      terminalErrorCount,
      retryByProvider: Array.from(retryCounter.entries()).sort((left, right) => right[1] - left[1]),
      phaseCounts: Array.from(phaseCounter.entries()).sort((left, right) => left[0].localeCompare(right[0])),
    };
  }, [timeline]);
  const reliabilityCards = useMemo(() => ({
    completed: detail?.completed_item_count ?? benchmarkItems.filter((item) => item.status === "completed").length,
    failed: detail?.failed_item_count ?? benchmarkItems.filter((item) => item.status === "failed").length,
    degraded: detail?.degraded_item_count ?? benchmarkItems.filter((item) => item.status === "degraded").length,
    active: benchmarkItems.filter((item) => item.status === "running" || item.status === "queued").length,
  }), [benchmarkItems, detail?.completed_item_count, detail?.degraded_item_count, detail?.failed_item_count]);
  const benchmarkMetricContext = useMemo(() => {
    const completedRuns = summary.completed_run_count > 0
      ? summary.completed_run_count
      : reliabilityCards.completed + reliabilityCards.degraded;
    const scoredRuns = summary.scored_run_count > 0
      ? summary.scored_run_count
      : benchmarkItems.filter((item) => benchmarkItemHasScoredCoverage(item)).length;
    const failedRuns = summary.failed_run_count > 0 ? summary.failed_run_count : reliabilityCards.failed;
    const degradedRuns = summary.degraded_run_count > 0 ? summary.degraded_run_count : reliabilityCards.degraded;
    const coverage = completedRuns > 0 ? scoredRuns / completedRuns : null;
    return {
      completedRuns,
      scoredRuns,
      failedRuns,
      degradedRuns,
      coverage,
      proxyRuns: summary.proxy_run_count,
    };
  }, [benchmarkItems, reliabilityCards, summary]);
  const frontierHighlights = useMemo(() => buildFrontierHighlights(modeRows), [modeRows]);

  useEffect(() => {
    followTimelineRef.current = true;
  }, [detailRunId]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!followTimelineRef.current || timeline.length === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      latestTimelineEntryRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [timeline]);

  const handleTimelineScroll = useCallback(() => {
    const container = timelineContainerRef.current;
    if (!container) {
      return;
    }

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    followTimelineRef.current = distanceFromBottom < 120;
  }, []);

  const handleCopyTimeline = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(timelineJson);
      setCopyState("copied");
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
    } catch (error) {
      console.error(error);
    }
  }, [timelineJson]);

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
      return Object.entries(rawPrompts as unknown as Record<string, Record<string, unknown>>);
    }
    return Object.entries(prompts as unknown as Record<string, Record<string, unknown>>);
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
          <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => void detailQuery.refetch()}>
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
            <div className="flex items-center gap-3">
              <Loader2 size={16} className="animate-spin text-accent" />
              <div>
                <div className="mono text-xs text-text-muted mb-1">LIVE STATUS</div>
                <div className="text-lg text-text-primary">{titleCase(detail.status)}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className={`mono text-[11px] px-2 py-1 rounded-full border ${streamState.tone}`}>
                {streamState.label}
              </div>
              <div className="mono text-xs text-text-secondary">
                {detail.run_id ?? detail.benchmark_id}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm text-text-secondary">
            <div>Tokens {formatMaybeRuntimeInt(detail.total_tokens, detail.status)}</div>
            <div>Thinking {formatMaybeRuntimeInt(detail.thinking_tokens, detail.status)}</div>
            <div>Latency {formatMaybeRuntimeLatency(detail.total_latency_ms ?? null, detail.status)}</div>
            <div>Cost {formatUsd(detail.cost?.estimated_cost_usd ?? null)}</div>
            <div>{selectedItem ? `Active item ${selectedItem.item_index + 1}` : "No active item"}</div>
          </div>
        </div>
      ) : null}

      {detail.status === "failed" ? (
        <div className="card p-4 sm:p-6 mb-8 border border-red-400/50 bg-red-400/10">
          <div className="flex items-center gap-3">
            <Loader2 size={16} className="text-red-400" />
            <div>
              <div className="mono text-xs text-text-muted mb-1">BENCHMARK FAILED</div>
              <div className="text-sm text-text-primary">
                The run stopped before completion. Refreshing the detail page should keep the
                persisted artifact visible, but the underlying provider error needs another pass.
              </div>
            </div>
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

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
        <div className="card p-4 sm:p-6">
          <h3 className="text-lg font-semibold mb-3">Benchmark Composition</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <InlineMetricTile label="Dominant Mechanism" value={dominantMechanism ? titleCase(dominantMechanism) : "n/a"} />
            <InlineMetricTile label="Dominant Model" value={dominantModel ?? "n/a"} />
            <InlineMetricTile label="Frequency Score" value={String(detail.frequency_score)} />
            <InlineMetricTile label="Config Density" value={frequencyBucket(detail.frequency_score)} />
          </div>
          {detail.reasoning_presets ? (
            <div className="mb-4">
              <div className="mono text-[11px] text-text-muted mb-2">REASONING PRESETS</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(detail.reasoning_presets).map(([key, value]) => (
                  <span key={key} className="badge">
                    {key.replace(/_/g, " ")} {value}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="space-y-3">
            <div>
              <div className="mono text-[11px] text-text-muted mb-2">MECHANISM COUNTS</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(detail.mechanism_counts).length > 0 ? Object.entries(detail.mechanism_counts).map(([key, value]) => (
                  <span key={key} className="rounded-full border border-border-subtle bg-void px-3 py-1 mono text-[11px] text-text-secondary">
                    {titleCase(key)} {value}
                  </span>
                )) : <span className="text-sm text-text-secondary">No mechanism composition saved.</span>}
              </div>
            </div>
            <div>
              <div className="mono text-[11px] text-text-muted mb-2">MODEL COUNTS</div>
              <div className="space-y-2">
                {Object.entries(detail.model_counts).length > 0 ? Object.entries(detail.model_counts)
                  .sort((left, right) => right[1] - left[1])
                  .map(([model, count]) => (
                    <div key={model} className="flex items-center justify-between gap-3 text-sm text-text-secondary">
                      <span className="inline-flex items-center gap-2 min-w-0">
                        <ProviderGlyph provider={providerFromModel(model)} />
                        <span className="truncate">{model}</span>
                      </span>
                      <span className="mono text-text-primary">{count}</span>
                    </div>
                  )) : <span className="text-sm text-text-secondary">No model composition saved.</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="card p-4 sm:p-6">
          <h3 className="text-lg font-semibold mb-3">Reliability</h3>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <InlineMetricTile label="Retry Events" value={String(reliability.retryCount)} />
            <InlineMetricTile label="Failed Items" value={String(reliabilityCards.failed)} />
            <InlineMetricTile label="Degraded Items" value={String(reliabilityCards.degraded)} />
            <InlineMetricTile label="Last Event" value={lastTimelineEvent ? relativeTimeFrom(lastTimelineEvent.timestamp, now) : "waiting..."} />
            <InlineMetricTile label="Completed Items" value={String(reliabilityCards.completed)} />
            <InlineMetricTile label="Active Items" value={String(reliabilityCards.active)} />
            <InlineMetricTile label="Stream State" value={streamState.label} />
            <InlineMetricTile label="Terminal Errors" value={String(reliability.terminalErrorCount)} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-md border border-border-subtle bg-void p-3">
              <div className="mono text-[11px] text-text-muted mb-2">RETRIES BY PROVIDER</div>
              {reliability.retryByProvider.length === 0 ? (
                <div className="text-sm text-text-secondary">No provider retries recorded in this artifact.</div>
              ) : (
                <div className="space-y-2">
                  {reliability.retryByProvider.map(([provider, count]) => (
                    <div key={provider} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-text-secondary">{titleCase(provider)}</span>
                      <span className="mono text-text-primary">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-md border border-border-subtle bg-void p-3">
              <div className="mono text-[11px] text-text-muted mb-2">EVENT DENSITY BY PHASE</div>
              {reliability.phaseCounts.length === 0 ? (
                <div className="text-sm text-text-secondary">No phase-scoped live events were recorded.</div>
              ) : (
                <div className="space-y-2">
                  {reliability.phaseCounts.map(([phase, count]) => (
                    <div key={phase} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-text-secondary">{titleCase(phase)}</span>
                      <span className="mono text-text-primary">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {benchmarkItems.length > 0 ? (
        <div className="card p-4 sm:p-6 mb-8">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Active Benchmark Item</h3>
              <p className="text-sm text-text-secondary">
                One benchmark item at a time, using the same live event grammar as task execution.
              </p>
            </div>
            <div className="rounded-md border border-border-subtle bg-void px-3 py-2 mono text-xs text-text-secondary">
              {selectedItem ? `${titleCase(selectedItem.category)} · ${titleCase(benchmarkItemDisplayStatus(selectedItem))}` : "No item selected"}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-6">
            <div className="space-y-4">
              {selectedItem ? (
                <>
                  <div className="rounded-md border border-border-subtle bg-void p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                      <div>
                        <div className="mono text-[10px] text-text-muted mb-1">
                          {titleCase(selectedItem.phase ?? "benchmark")} • {selectedItem.run_kind ?? "run"}
                        </div>
                        <div className="text-sm text-text-primary whitespace-pre-wrap wrap-break-word">
                          {selectedItem.question}
                        </div>
                      </div>
                      <span className={`mono text-[10px] rounded-full border px-2 py-1 ${benchmarkItemDisplayStatusTone(selectedItem)}`}>
                        {benchmarkItemDisplayStatus(selectedItem)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                      <InlineMetricTile label="Mechanism" value={selectedItem.mechanism ? titleCase(selectedItem.mechanism) : "n/a"} />
                      <InlineMetricTile label="Selector Source" value={selectedItem.selector_source ?? "n/a"} />
                      <InlineMetricTile label="Tokens" value={formatMaybeInt(selectedItem.total_tokens)} />
                      <InlineMetricTile label="Thinking" value={formatMaybeInt(selectedItem.thinking_tokens)} />
                      <InlineMetricTile label="Latency" value={formatLatency(selectedItem.total_latency_ms)} />
                      <InlineMetricTile label="Switches" value={formatMetricInteger(selectedItem.summary?.switches)} />
                      <InlineMetricTile label="Entropy" value={formatMetricDecimal(selectedItem.summary?.latest_entropy)} />
                      <InlineMetricTile label="Novelty" value={formatMetricDecimal(selectedItem.summary?.latest_novelty)} />
                      <InlineMetricTile label="Confidence" value={formatMetricPercent(selectedItem.summary?.confidence)} />
                      <InlineMetricTile label="Scoring" value={formatScoringMode(selectedItem.summary?.scoring_mode)} />
                      <InlineMetricTile label="Final Answer" value={formatMetricText(selectedItem.summary?.final_answer)} />
                      <InlineMetricTile label="Cost" value={formatSelectedItemCost(selectedItem)} />
                    </div>
                    {selectedItem.selector_fallback_path && selectedItem.selector_fallback_path.length > 0 ? (
                      <div className="mt-3">
                        <div className="mono text-[10px] text-text-muted mb-2">SELECTOR CASCADE</div>
                        <div className="flex flex-wrap gap-2">
                          {selectedItem.selector_fallback_path.map((step) => (
                            <span key={step} className="badge">{step}</span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {selectedItem.failure_reason ? (
                      <div className="mt-3 rounded-md border border-red-400/30 bg-red-400/10 p-3 text-xs text-text-secondary">
                        {selectedItem.failure_reason}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-md border border-border-subtle bg-void p-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <h4 className="text-sm text-text-primary">Item Stream</h4>
                      <div className="mono text-[10px] text-text-muted">
                        {formatInt(aggregatedSelectedItemTimeline.length)} cards • {formatInt(selectedItemTimeline.length)} raw events
                      </div>
                    </div>
                    {aggregatedSelectedItemTimeline.length === 0 ? (
                      <div className="text-sm text-text-secondary">No item-scoped events have been persisted yet.</div>
                    ) : (
                      <div className="space-y-3 max-h-90 overflow-y-auto pr-1">
                        {aggregatedSelectedItemTimeline.map((event, index) => {
                          return (
                            <div
                              key={`${selectedItem.item_id}-${event.key}-${event.timestamp ?? index}`}
                              className={`border rounded-md p-3 ${event.tone}`}
                            >
                              <div className="flex items-center justify-between gap-3 mb-1">
                                <div>
                                  <div className="mono text-[10px] text-text-muted mb-1">{event.label}</div>
                                  <div className="text-sm text-text-primary">{event.title}</div>
                                </div>
                                <div className="mono text-[10px] text-text-muted">{formatDateTime(event.timestamp)}</div>
                              </div>
                              <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word mb-2">
                                {event.summary}
                              </p>
                              <details className="group">
                                <summary className="mono text-[10px] text-text-muted cursor-pointer select-none">
                                  {event.detailsLabel}
                                </summary>
                                <pre className="mt-2 text-[11px] text-text-secondary whitespace-pre-wrap wrap-break-word">
                                  {prettyJson(event.details)}
                                </pre>
                              </details>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>

            <div className="space-y-3">
              {benchmarkItems.map((item) => {
                const selected = item.item_id === selectedItem?.item_id;
                return (
                  <button
                    key={item.item_id}
                    type="button"
                    onClick={() => setSelectedItemId(item.item_id)}
                    className={`w-full text-left rounded-md border p-3 transition-colors ${
                      selected
                        ? "border-accent bg-accent/5"
                        : "border-border-subtle bg-void hover:border-accent/40"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div>
                        <div className="mono text-[10px] text-text-muted mb-1">
                          ITEM {item.item_index + 1} • {titleCase(item.phase ?? "benchmark")}
                        </div>
                        <div className="text-sm text-text-primary">{titleCase(item.category)}</div>
                      </div>
                      <span className={`mono text-[10px] rounded-full border px-2 py-1 ${benchmarkItemDisplayStatusTone(item)}`}>
                        {benchmarkItemDisplayStatus(item)}
                      </span>
                    </div>
                    <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word mb-2">
                      {truncateText(item.question, 140)}
                    </p>
                    <div className="flex flex-wrap gap-2 mono text-[10px] text-text-muted">
                      <span>{item.mechanism ? titleCase(item.mechanism) : "pending mechanism"}</span>
                      {item.selector_source ? <span>{item.selector_source}</span> : null}
                      <span>{formatMaybeInt(item.total_tokens)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      <div className="card p-4 sm:p-6 mb-8">
        <h3 className="text-lg font-semibold mb-3">Scored Success / Cost Frontier</h3>
        <p className="text-sm text-text-secondary mb-4">
          Success rate across benchmark items that actually have scoring coverage in this artifact. Creative and demo use proxy success, not exact-match truth.
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <InlineMetricTile label="Scored Runs" value={formatMaybeInt(benchmarkMetricContext.scoredRuns)} />
          <InlineMetricTile label="Failed Runs" value={formatMaybeInt(benchmarkMetricContext.failedRuns)} />
          <InlineMetricTile label="Degraded Runs" value={formatMaybeInt(benchmarkMetricContext.degradedRuns)} />
          <InlineMetricTile label="Coverage" value={formatCoverage(benchmarkMetricContext.coverage)} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <InlineMetricTile label="Best Accuracy" value={frontierHighlights.bestAccuracy} />
          <InlineMetricTile label="Fastest Mode" value={frontierHighlights.fastest} />
          <InlineMetricTile label="Cheapest Mode" value={frontierHighlights.cheapest} />
        </div>
        {modeRows.length === 0 ? (
          <div className="text-sm text-text-secondary">No per-mechanism scored-success metrics were stored for this benchmark artifact.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-170 border-collapse">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="py-2 pr-3 text-left mono text-[10px] text-text-muted">MECHANISM</th>
                  <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">SCORED SUCCESS</th>
                  <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">COVERAGE</th>
                  <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">TOKENS</th>
                  <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">THINKING</th>
                  <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">LATENCY</th>
                  <th className="py-2 text-right mono text-[10px] text-text-muted">COST</th>
                </tr>
              </thead>
              <tbody>
                {modeRows.map((row) => (
                  <tr key={row.mechanism} className="border-b border-border-subtle/70">
                    <td className="py-2 pr-3 text-sm text-text-primary">{row.mechanism}</td>
                    <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatRowAccuracy(row.accuracy)}</td>
                    <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatCoverage(row.runCount > 0 ? row.scoredRunCount / row.runCount : null)}</td>
                    <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatInt(row.avgTokens)}</td>
                    <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatInt(row.thinkingTokens)}</td>
                    <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatLatency(row.avgLatencyMs)}</td>
                    <td className="py-2 text-right mono text-[11px] text-text-primary">{formatUsd(row.avgCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {timeline.length > 0 ? (
        <div className="card p-4 sm:p-6 mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
            <h3 className="text-lg font-semibold">Raw Event Timeline</h3>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-secondary inline-flex items-center gap-2"
                onClick={() => void handleCopyTimeline()}
              >
                {copyState === "copied" ? <Check size={14} /> : <Clipboard size={14} />}
                {copyState === "copied" ? "Copied" : "Copy JSON"}
              </button>
              <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-void px-3 py-2 mono text-xs text-text-secondary">
                <span>Cards {formatInt(aggregatedFilteredTimeline.length)}</span>
                <span className="text-text-muted">•</span>
                <span>Events {formatInt(filteredTimeline.length)}</span>
                <span className="text-text-muted">•</span>
                <span>Runs {formatInt(detail.run_count)}</span>
              </div>
            </div>
          </div>
          {availablePhases.length > 1 ? (
            <div className="flex flex-wrap gap-2 mb-4">
              {availablePhases.map((phase) => (
                <button
                  key={phase}
                  type="button"
                  onClick={() => setPhaseFilter(phase)}
                  className={`mono px-3 py-1.5 text-[11px] rounded-full border transition-colors ${
                    effectivePhaseFilter === phase
                      ? "bg-accent-muted text-accent border-accent"
                      : "bg-void text-text-secondary border-border-subtle hover:border-accent/40"
                  }`}
                >
                  {phase === "all" ? "All phases" : titleCase(phase)}
                </button>
              ))}
            </div>
          ) : null}
          <div
            ref={timelineContainerRef}
            onScroll={handleTimelineScroll}
            className="space-y-3 max-h-96 overflow-y-auto pr-1"
          >
            {aggregatedFilteredTimeline.map((event, index) => {
              return (
                <div
                  key={`${event.key}-${event.timestamp ?? index}`}
                  ref={index === aggregatedFilteredTimeline.length - 1 ? latestTimelineEntryRef : undefined}
                  className={`border rounded-md p-3 ${event.tone}`}
                >
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <div>
                      <div className="mono text-[10px] text-text-muted mb-1">{event.label}</div>
                      <div className="text-sm text-text-primary">{event.title}</div>
                    </div>
                    <div className="mono text-[10px] text-text-muted">{formatDateTime(event.timestamp)}</div>
                  </div>
                  <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word mb-2">
                    {event.summary}
                  </p>
                  <details className="group">
                    <summary className="mono text-[10px] text-text-muted cursor-pointer select-none">
                      {event.detailsLabel}
                    </summary>
                    <pre className="mt-2 text-[11px] text-text-secondary whitespace-pre-wrap wrap-break-word">
                      {prettyJson(event.details)}
                    </pre>
                  </details>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="card p-4 sm:p-8 mb-8">
        <h3 className="mb-2 text-lg font-semibold">Mechanism Performance</h3>
        <p className="text-sm text-text-secondary mb-8">
          Scored success rate by mechanism for the selected benchmark artifact.
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
              <Bar dataKey="accuracy" name="Scored Success (%)" fill="var(--color-accent)" radius={[4, 4, 0, 0]} minPointSize={4} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-4 sm:p-8 mb-8 overflow-x-auto">
        <h3 className="mb-2 text-lg font-semibold">Category Accuracy Matrix</h3>
        <p className="text-sm text-text-secondary mb-6">Per-category scored success percentage across debate, vote, and selector mechanisms.</p>

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
                  <td className="py-2 px-3 text-sm text-right text-text-secondary">{formatRowAccuracy(row.debate, 1)}</td>
                  <td className="py-2 px-3 text-sm text-right text-text-secondary">{formatRowAccuracy(row.vote, 1)}</td>
                  <td className="py-2 px-3 text-sm text-right text-accent">{formatRowAccuracy(row.selector, 1)}</td>
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
                    <div>Cost {formatUsd(telemetry.estimated_cost_usd ?? costByModelMap.get(model) ?? null)}</div>
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
                    <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word">
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

function InlineMetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-void p-3">
      <div className="mono text-[10px] text-text-muted mb-1">{label.toUpperCase()}</div>
      <div className="text-sm text-text-primary break-words">{value}</div>
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
    per_mechanism: {},
    per_category: {},
    completed_run_count: 0,
    failed_run_count: 0,
    degraded_run_count: 0,
    scored_run_count: 0,
    proxy_run_count: 0,
  };
}

function parseSummaryObject(candidate: unknown): NormalizedSummary {
  if (!isRecord(candidate)) {
    return {
      per_mode: {},
      per_mechanism: {},
      per_category: {},
      completed_run_count: 0,
      failed_run_count: 0,
      degraded_run_count: 0,
      scored_run_count: 0,
      proxy_run_count: 0,
    };
  }

  const perMode: Record<string, NormalizedMetric> = {};
  const perModeSource = candidate.per_mode;
  if (isRecord(perModeSource)) {
    for (const [mechanism, value] of Object.entries(perModeSource)) {
      perMode[mechanism] = parseMetric(value);
    }
  }

  const perMechanism: Record<string, NormalizedMetric> = {};
  const perMechanismSource = candidate.per_mechanism;
  if (isRecord(perMechanismSource)) {
    for (const [mechanism, value] of Object.entries(perMechanismSource)) {
      perMechanism[mechanism] = parseMetric(value);
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
    per_mechanism: perMechanism,
    per_category: perCategory,
    completed_run_count: asNumber(candidate.completed_run_count),
    failed_run_count: asNumber(candidate.failed_run_count),
    degraded_run_count: asNumber(candidate.degraded_run_count),
    scored_run_count: asNumber(candidate.scored_run_count),
    proxy_run_count: asNumber(candidate.proxy_run_count),
  };
}

function parseMetric(candidate: unknown): NormalizedMetric {
  if (!isRecord(candidate)) {
    return { ...DEFAULT_METRIC };
  }

  return {
    accuracy: asNumber(candidate.accuracy),
    run_count: asNumber(candidate.run_count),
    scored_run_count: asNumber(candidate.scored_run_count),
    proxy_run_count: asNumber(candidate.proxy_run_count),
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
  return (
    Object.keys(summary.per_mode).length > 0
    || Object.keys(summary.per_mechanism).length > 0
    || Object.keys(summary.per_category).length > 0
  );
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

function dominantCountEntry(record: Record<string, number> | null | undefined): [string, number] | null {
  if (!record) {
    return null;
  }
  const entries = Object.entries(record).sort((left, right) => right[1] - left[1]);
  return entries[0] ?? null;
}

function frequencyBucket(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score) || score <= 0) {
    return "rare config";
  }
  if (score < 12) {
    return "rare config";
  }
  if (score < 30) {
    return "steady config";
  }
  return "high-frequency config";
}

function benchmarkPhaseForEvent(event: TaskEvent): string | null {
  const data = isRecord(event.data) ? event.data : {};
  const context = isRecord(data.benchmark_context) ? data.benchmark_context : null;
  if (context && typeof context.phase === "string") {
    return context.phase;
  }
  if (typeof data.phase === "string") {
    return data.phase;
  }
  return null;
}

function benchmarkItemIdForEvent(event: TaskEvent): string | null {
  const data = isRecord(event.data) ? event.data : {};
  if (typeof data.item_id === "string" && data.item_id.trim()) {
    return data.item_id;
  }
  const context = isRecord(data.benchmark_context) ? data.benchmark_context : null;
  if (context && typeof context.item_id === "string" && context.item_id.trim()) {
    return context.item_id;
  }
  const phase = typeof data.phase === "string"
    ? data.phase
    : context && typeof context.phase === "string"
      ? context.phase
      : null;
  const runKind = typeof data.run_kind === "string"
    ? data.run_kind
    : context && typeof context.run_kind === "string"
      ? context.run_kind
      : null;
  const taskIndex = typeof data.task_index === "number"
    ? data.task_index
    : context && typeof context.task_index === "number"
      ? context.task_index
      : null;
  if (!phase || !runKind || taskIndex === null) {
    return null;
  }
  return `${phase}:${runKind}:${taskIndex}`;
}

function buildTaskEventKey(event: TaskEvent): string {
  return benchmarkEventKey(event);
}

function mergeUniqueTaskEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  if (incoming.length === 0) {
    return current;
  }

  const seen = new Set(current.map(buildTaskEventKey));
  const next = [...current];

  for (const event of incoming) {
    const key = buildTaskEventKey(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(event);
  }

  return next;
}

function statusFromBenchmarkEvent(
  currentStatus: BenchmarkDetailPayload["status"],
  eventType: TaskEvent["event"],
): BenchmarkDetailPayload["status"] {
  if (eventType === "queued") {
    return "queued";
  }
  if (eventType === "started") {
    return "running";
  }
  if (eventType === "complete") {
    return "completed";
  }
  if (eventType === "failed" || eventType === "error") {
    return "failed";
  }
  return currentStatus;
}

function applyBenchmarkStreamEventToDetail(
  current: BenchmarkDetailPayload,
  event: TaskEvent,
): BenchmarkDetailPayload {
  const data = isRecord(event.data) ? event.data : {};
  const telemetry = isRecord(data.telemetry) ? data.telemetry : null;
  const nextItems = mergeBenchmarkItemsFromEvent(current.benchmark_items ?? [], event);
  const nextActiveItemId = benchmarkItemIdForEvent(event) ?? current.active_item_id ?? nextItems[0]?.item_id ?? null;
  const nextActiveItem = nextItems.find((item) => item.item_id === nextActiveItemId) ?? null;

  return {
    ...current,
    status: statusFromBenchmarkEvent(current.status, event.event),
    artifact_id: typeof data.artifact_id === "string" ? data.artifact_id : current.artifact_id,
    updated_at: event.timestamp ?? current.updated_at,
    latest_mechanism:
      typeof data.latest_mechanism === "string" ? data.latest_mechanism : current.latest_mechanism,
    agent_count: telemetry && isPositiveInteger(telemetry.agent_count) ? telemetry.agent_count : current.agent_count,
    total_tokens: telemetry && typeof telemetry.total_tokens === "number" ? telemetry.total_tokens : current.total_tokens,
    thinking_tokens:
      telemetry && typeof telemetry.thinking_tokens === "number"
        ? telemetry.thinking_tokens
        : current.thinking_tokens,
    total_latency_ms:
      telemetry && typeof telemetry.total_latency_ms === "number"
        ? telemetry.total_latency_ms
        : current.total_latency_ms,
    model_telemetry:
      telemetry && isRecord(telemetry.model_telemetry)
        ? (telemetry.model_telemetry as typeof current.model_telemetry)
        : current.model_telemetry,
    cost:
      telemetry && isRecord(telemetry.cost)
        ? (telemetry.cost as unknown as typeof current.cost)
        : current.cost,
    benchmark_items: nextItems,
    active_item_id: nextActiveItemId,
    active_item: nextActiveItem,
    completed_item_count:
      telemetry && typeof telemetry.completed_item_count === "number"
        ? telemetry.completed_item_count
        : current.completed_item_count,
    failed_item_count:
      telemetry && typeof telemetry.failed_item_count === "number"
        ? telemetry.failed_item_count
        : current.failed_item_count,
    degraded_item_count:
      telemetry && typeof telemetry.degraded_item_count === "number"
        ? telemetry.degraded_item_count
        : current.degraded_item_count,
  };
}

function benchmarkItemStatusTone(status: BenchmarkItemPayload["status"]): string {
  if (status === "completed") {
    return "border-emerald-400/40 text-emerald-500 bg-emerald-400/10";
  }
  if (status === "degraded") {
    return "border-amber-400/40 text-amber-500 bg-amber-400/10";
  }
  if (status === "failed") {
    return "border-red-400/40 text-red-500 bg-red-400/10";
  }
  if (status === "running") {
    return "border-accent/40 text-accent bg-accent/10";
  }
  return "border-border-subtle text-text-secondary bg-void";
}

function benchmarkItemHasObservedState(item: BenchmarkItemPayload): boolean {
  return (
    item.events.length > 0
    || item.started_at !== null
    || item.completed_at !== null
    || item.total_tokens > 0
    || item.thinking_tokens > 0
    || item.total_latency_ms > 0
    || item.mechanism !== null
    || item.failure_reason !== null
    || Object.keys(item.model_telemetry ?? {}).length > 0
    || Object.keys(item.summary ?? {}).length > 0
  );
}

function benchmarkItemDisplayStatus(item: BenchmarkItemPayload): string {
  if (item.status === "queued" && !benchmarkItemHasObservedState(item)) {
    return "pending";
  }
  return item.status;
}

function benchmarkItemDisplayStatusTone(item: BenchmarkItemPayload): string {
  const displayStatus = benchmarkItemDisplayStatus(item);
  if (displayStatus === "pending") {
    return "border-border-subtle text-text-secondary bg-void";
  }
  return benchmarkItemStatusTone(item.status);
}

function benchmarkItemHasScoredCoverage(item: BenchmarkItemPayload): boolean {
  const summary = item.summary;
  if (!summary || typeof summary !== "object") {
    return false;
  }
  return summary.scored === true || typeof summary.scoring_mode === "string";
}

function formatMetricInteger(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toString() : "n/a";
}

function formatMetricDecimal(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function formatMetricPercent(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function formatMetricText(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "n/a";
}

function formatScoringMode(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "n/a";
  }
  return titleCase(value.replace(/_/g, " "));
}

function formatCoverage(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatRowAccuracy(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value.toFixed(digits)}%`;
}

function formatSelectedItemCost(item: BenchmarkItemPayload): string {
  if (!item.model_telemetry || Object.keys(item.model_telemetry).length === 0) {
    return "n/a";
  }
  const total = Object.values(item.model_telemetry).reduce((sum, telemetry) => {
    return sum + (typeof telemetry.estimated_cost_usd === "number" ? telemetry.estimated_cost_usd : 0);
  }, 0);
  return total > 0 ? formatUsd(total) : "n/a";
}

function mergeBenchmarkItemsFromEvent(
  currentItems: BenchmarkItemPayload[],
  event: TaskEvent,
): BenchmarkItemPayload[] {
  const itemId = benchmarkItemIdForEvent(event);
  if (!itemId) {
    return currentItems;
  }
  const data = isRecord(event.data) ? event.data : {};
  const context = isRecord(data.benchmark_context) ? data.benchmark_context : null;
  const latestRun = isRecord(data.latest_run) ? data.latest_run : null;
  const nextStatus = (
    typeof data.item_status === "string"
      ? data.item_status
      : latestRun && typeof latestRun.item_status === "string"
        ? latestRun.item_status
      : event.event === "domain_progress"
        ? "completed"
        : event.event === "failed" || event.event === "error"
          ? "failed"
          : "running"
  ) as BenchmarkItemPayload["status"];
  const itemIndex = typeof data.item_index === "number"
    ? data.item_index
    : context && typeof context.item_index === "number"
      ? context.item_index
      : currentItems.length;
  const taskIndex = typeof data.task_index === "number"
    ? data.task_index
    : context && typeof context.task_index === "number"
      ? context.task_index
      : itemIndex;
  const existing = currentItems.find((item) => item.item_id === itemId);
  const nextEvents = existing?.events ?? [];
  const alreadyPresent = nextEvents.some(
    (entry) => buildTaskEventKey(entry) === buildTaskEventKey(event),
  );
  const mergedEvents = alreadyPresent ? nextEvents : [...nextEvents, event];
  const existingSummary = isRecord(existing?.summary) ? existing.summary : {};
  const nextSummary: Record<string, unknown> = { ...existingSummary };
  if (latestRun) {
    if (typeof latestRun.confidence === "number") nextSummary.confidence = latestRun.confidence;
    if (typeof latestRun.correct === "boolean") nextSummary.correct = latestRun.correct;
    if (typeof latestRun.scored === "boolean") nextSummary.scored = latestRun.scored;
    if (typeof latestRun.scoring_mode === "string") nextSummary.scoring_mode = latestRun.scoring_mode;
    if (typeof latestRun.quorum_reached === "boolean") nextSummary.quorum_reached = latestRun.quorum_reached;
    if (typeof latestRun.final_answer === "string") nextSummary.final_answer = latestRun.final_answer;
    if (typeof latestRun.rounds === "number") nextSummary.rounds = latestRun.rounds;
    if (typeof latestRun.switches === "number") nextSummary.switches = latestRun.switches;
    if (typeof latestRun.execution_mode === "string") nextSummary.execution_mode = latestRun.execution_mode;
  }
  const metrics = isRecord(data.metrics) ? data.metrics : null;
  if (metrics) {
    if (typeof metrics.entropy === "number") nextSummary.latest_entropy = metrics.entropy;
    if (typeof metrics.novelty_score === "number") nextSummary.latest_novelty = metrics.novelty_score;
    if (typeof metrics.information_gain_delta === "number") nextSummary.latest_information_gain_delta = metrics.information_gain_delta;
    if (typeof metrics.answer_churn === "number") nextSummary.latest_answer_churn = metrics.answer_churn;
  }
  if (typeof data.mechanism_switches === "number") {
    nextSummary.switches = data.mechanism_switches;
  }
  const merged: BenchmarkItemPayload = {
    item_id: itemId,
    item_index: existing?.item_index ?? itemIndex,
    task_index: existing?.task_index ?? taskIndex,
    phase:
      (typeof data.phase === "string" ? data.phase : context && typeof context.phase === "string" ? context.phase : existing?.phase) ?? null,
    run_kind:
      (typeof data.run_kind === "string" ? data.run_kind : context && typeof context.run_kind === "string" ? context.run_kind : existing?.run_kind) ?? null,
    category:
      (typeof data.category === "string" ? data.category : context && typeof context.category === "string" ? context.category : existing?.category) ?? "unknown",
    question:
      (typeof data.question === "string" ? data.question : context && typeof context.question === "string" ? context.question : existing?.question) ?? "Benchmark question",
    source_task:
      (typeof data.source_task === "string" ? data.source_task : context && typeof context.source_task === "string" ? context.source_task : existing?.source_task) ?? null,
    status: nextStatus,
    mechanism:
      (typeof data.mechanism === "string" ? data.mechanism : typeof data.latest_mechanism === "string" ? data.latest_mechanism : existing?.mechanism) ?? null,
    selector_source:
      (typeof data.selector_source === "string" ? data.selector_source : existing?.selector_source) ?? null,
    selector_fallback_path:
      (Array.isArray(data.selector_fallback_path) ? data.selector_fallback_path.map(String) : existing?.selector_fallback_path) ?? [],
    failure_reason:
      (event.event === "failed" || event.event === "error")
        ? String(data.message ?? existing?.failure_reason ?? "")
        : existing?.failure_reason ?? null,
    latest_error_event:
      event.event === "failed" || event.event === "error" ? event : existing?.latest_error_event ?? null,
    fallback_events: existing?.fallback_events ?? [],
    total_tokens:
      typeof data.total_tokens === "number" ? data.total_tokens : existing?.total_tokens ?? 0,
    thinking_tokens:
      typeof data.thinking_tokens === "number" ? data.thinking_tokens : existing?.thinking_tokens ?? 0,
    total_latency_ms:
      typeof data.total_latency_ms === "number"
        ? data.total_latency_ms
        : typeof data.latency_ms === "number"
          ? data.latency_ms
          : existing?.total_latency_ms ?? 0,
    model_telemetry: existing?.model_telemetry ?? {},
    summary: nextSummary,
    started_at: existing?.started_at ?? event.timestamp ?? null,
    completed_at:
      nextStatus === "completed" || nextStatus === "failed" || nextStatus === "degraded"
        ? event.timestamp ?? existing?.completed_at ?? null
        : existing?.completed_at ?? null,
    events: mergedEvents,
  };
  const filtered = currentItems.filter((item) => item.item_id !== itemId);
  return [...filtered, merged].sort((left, right) => left.item_index - right.item_index);
}

function buildFrontierHighlights(
  rows: Array<{
    mechanism: string;
    accuracy: number | null;
    avgLatencyMs: number;
    avgCostUsd: number;
  }>,
): { bestAccuracy: string; fastest: string; cheapest: string } {
  if (rows.length === 0) {
    return {
      bestAccuracy: "n/a",
      fastest: "n/a",
      cheapest: "n/a",
    };
  }
  const scorableRows = rows.filter((row) => row.accuracy !== null);
  const bestAccuracy = scorableRows.length > 0
    ? [...scorableRows].sort((left, right) => (right.accuracy ?? 0) - (left.accuracy ?? 0))[0]
    : null;
  const fastest = [...rows].sort((left, right) => left.avgLatencyMs - right.avgLatencyMs)[0];
  const cheapest = [...rows].sort((left, right) => left.avgCostUsd - right.avgCostUsd)[0];
  return {
    bestAccuracy: bestAccuracy ? `${bestAccuracy.mechanism} (${bestAccuracy.accuracy?.toFixed(1)}%)` : "n/a",
    fastest: `${fastest.mechanism} (${formatLatency(fastest.avgLatencyMs)})`,
    cheapest: `${cheapest.mechanism} (${formatUsd(cheapest.avgCostUsd)})`,
  };
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return "Unable to serialize payload";
  }
}

function aggregateBenchmarkTimeline(events: TaskEvent[]): AggregatedBenchmarkTimelineEvent[] {
  return events.reduce<AggregatedBenchmarkTimelineEvent[]>((current, event) => {
    const nextEvent = mapAggregatedBenchmarkTimelineEvent(event);
    const index = current.findIndex((entry) => entry.key === nextEvent.key);
    if (index === -1) {
      return [...current, nextEvent];
    }

    const previous = current[index];
    const merged: AggregatedBenchmarkTimelineEvent = {
      ...previous,
      ...nextEvent,
      details: {
        ...previous.details,
        ...nextEvent.details,
      },
    };
    return current.map((entry, entryIndex) => (entryIndex === index ? merged : entry));
  }, []);
}

function mapAggregatedBenchmarkTimelineEvent(event: TaskEvent): AggregatedBenchmarkTimelineEvent {
  return {
    key: benchmarkTimelineKey(event),
    timestamp: event.timestamp ?? null,
    details: isRecord(event.data) ? event.data : {},
    ...describeBenchmarkEvent(event),
  };
}

function benchmarkTimelineKey(event: TaskEvent): string {
  return benchmarkDraftKeyForEvent(event) ?? benchmarkEventKey(event);
}

function benchmarkDraftKeyForEvent(event: TaskEvent): string | null {
  if (!BENCHMARK_COALESCED_EVENT_TYPES.has(event.event)) {
    return null;
  }

  const data = isRecord(event.data) ? event.data : {};
  const context = isRecord(data.benchmark_context) ? data.benchmark_context : null;
  const itemId = benchmarkItemIdForEvent(event);
  const agentId = typeof data.agent_id === "string" && data.agent_id.trim()
    ? data.agent_id
    : null;
  const stage = typeof data.stage === "string" && data.stage.trim()
    ? data.stage
    : null;
  const roundNumber = typeof data.round_number === "number" && Number.isFinite(data.round_number)
    ? data.round_number
    : context && typeof context.round_number === "number" && Number.isFinite(context.round_number)
      ? context.round_number
      : null;

  const parts = [
    itemId,
    event.event,
    agentId,
    stage,
    roundNumber === null ? null : String(roundNumber),
  ].filter((value): value is string => Boolean(value));

  return parts.length >= 3 ? parts.join(":") : null;
}

function benchmarkEventKey(event: TaskEvent): string {
  return `${event.event}:${event.timestamp ?? ""}:${JSON.stringify(event.data ?? null)}`;
}

function describeBenchmarkEvent(event: TaskEvent): BenchmarkTimelineDescriptor {
  const data = isRecord(event.data) ? event.data : {};
  const eventLabel = titleCase(event.event);
  const benchmarkContext = isRecord(data.benchmark_context) ? data.benchmark_context : null;
  const contextPhase = benchmarkContext ? titleCase(String(benchmarkContext.phase ?? "benchmark")) : null;
  const contextCategory = benchmarkContext ? titleCase(String(benchmarkContext.category ?? "unknown")) : null;
  const contextRunKind = benchmarkContext ? titleCase(String(benchmarkContext.run_kind ?? "run")) : null;
  const contextPrefix = [contextPhase, contextCategory, contextRunKind].filter(Boolean).join(" · ");

  if (event.event === "queued") {
    return {
      label: "QUEUE",
      title: "Benchmark queued",
      summary: `Run ${String(data.run_id ?? "unknown")} is waiting for execution.`,
      detailsLabel: "queue payload",
      tone: "border-border-subtle bg-void",
    };
  }

  if (event.event === "started") {
    return {
      label: "RUN STARTED",
      title: "Benchmark execution started",
      summary: `Run ${String(data.run_id ?? "unknown")} is actively executing now.`,
      detailsLabel: "start payload",
      tone: "border-accent/40 bg-accent/5",
    };
  }

  if (event.event === "domain_progress") {
    const latestRun = isRecord(data.latest_run) ? data.latest_run : {};
    const phase = titleCase(String(data.phase ?? "progress"));
    const mechanism = titleCase(
      String(data.latest_mechanism ?? latestRun.mechanism_used ?? latestRun.mode ?? "selector"),
    );
    const category = titleCase(String(latestRun.category ?? "unknown"));
    const question = truncateText(
      String(latestRun.question ?? latestRun.task ?? latestRun.source_task ?? "Benchmark task"),
      160,
    );
    const progressBits = [
      typeof data.completed === "number" && typeof data.total === "number"
        ? `${Math.round(data.completed)}/${Math.round(data.total)} complete`
        : null,
      mechanism !== "Selector" ? `${mechanism} run finished` : "Selector run finished",
      category !== "Unknown" ? `${category} domain` : null,
    ].filter(Boolean);

    return {
      label: phase.toUpperCase(),
      title: progressBits.join(" · "),
      summary: question,
      detailsLabel: "progress telemetry",
      tone: "border-accent/30 bg-accent/5",
    };
  }

  if (event.event === "mechanism_selected") {
    return {
      label: contextPrefix || "MECHANISM",
      title: `${String(data.mechanism ?? "selector").toUpperCase()} selected`,
      summary: String(data.reasoning ?? "The benchmark runner selected a mechanism for this case."),
      detailsLabel: "selection rationale",
      tone: "border-cyan-400/30 bg-cyan-400/5",
    };
  }

  if (event.event === "agent_output_delta") {
    const chunk = String(
      data.content_so_far
      ?? data.answer_so_far
      ?? data.content_delta
      ?? data.answer_delta
      ?? data.delta
      ?? "Streaming draft...",
    );
    const agent = String(data.agent_id ?? "agent");
    const model = String(data.agent_model ?? "unknown-model");
    return {
      label: contextPrefix || "LIVE DRAFT",
      title: `${agent} · ${model}`,
      summary: chunk,
      detailsLabel: "live draft payload",
      tone: "border-cyan-400/30 bg-cyan-400/5",
    };
  }

  if (event.event === "agent_output") {
    const summary = String(
      data.content
      ?? data.answer
      ?? data.final_answer
      ?? data.summary
      ?? "Agent response completed.",
    );
    return {
      label: contextPrefix || "AGENT OUTPUT",
      title: `${String(data.agent_id ?? "agent")} · ${String(data.agent_model ?? "unknown-model")}`,
      summary,
      detailsLabel: "agent output metadata",
      tone: "border-cyan-400/30 bg-cyan-400/5",
    };
  }

  if (event.event === "cross_examination_delta" || event.event === "cross_examination") {
    const summary = String(
      data.content_so_far
      ?? data.question_so_far
      ?? data.content_delta
      ?? data.summary
      ?? data.question
      ?? "Cross-examination in progress.",
    );
    return {
      label: contextPrefix || "CROSS-EXAM",
      title: "Devil’s advocate challenge",
      summary,
      detailsLabel: "cross-examination payload",
      tone: "border-amber-400/40 bg-amber-400/10",
    };
  }

  if (event.event === "thinking_delta") {
    return {
      label: contextPrefix || "THINKING",
      title: `${String(data.agent_id ?? "agent")} reasoning stream`,
      summary: String(data.thinking_so_far ?? data.thinking_delta ?? "Thinking..."),
      detailsLabel: "thinking stream",
      tone: "border-emerald-400/40 bg-emerald-400/10",
    };
  }

  if (event.event === "usage_delta") {
    const parts = [
      typeof data.total_tokens === "number" ? `${Math.round(data.total_tokens)} total tokens` : null,
      typeof data.input_tokens === "number" ? `${Math.round(data.input_tokens)} in` : null,
      typeof data.output_tokens === "number" ? `${Math.round(data.output_tokens)} out` : null,
      typeof data.thinking_tokens === "number" ? `${Math.round(data.thinking_tokens)} thinking` : null,
      typeof data.latency_ms === "number" ? `${Math.round(data.latency_ms)} ms` : null,
    ].filter(Boolean);
    return {
      label: contextPrefix || "USAGE",
      title: `${String(data.agent_id ?? "agent")} telemetry`,
      summary: parts.join(" · ") || "Usage updated.",
      detailsLabel: "usage telemetry",
      tone: "border-violet-400/40 bg-violet-400/10",
    };
  }

  if (event.event === "convergence_update") {
    return {
      label: contextPrefix || "CONVERGENCE",
      title: `Round ${String(data.round_number ?? "?")} convergence`,
      summary: [
        typeof data.disagreement_entropy === "number" ? `Entropy ${data.disagreement_entropy.toFixed(2)}` : null,
        typeof data.novelty_score === "number" ? `Novelty ${data.novelty_score.toFixed(2)}` : null,
        typeof data.information_gain_delta === "number" ? `Info gain ${data.information_gain_delta.toFixed(2)}` : null,
      ].filter(Boolean).join(" · ") || "Convergence metrics updated.",
      detailsLabel: "convergence metrics",
      tone: "border-violet-400/40 bg-violet-400/10",
    };
  }

  if (event.event === "mechanism_switch") {
    return {
      label: contextPrefix || "SWITCH",
      title: `${String(data.from_mechanism ?? "unknown")} → ${String(data.to_mechanism ?? "unknown")}`,
      summary: String(data.reasoning ?? "The benchmark run switched mechanisms."),
      detailsLabel: "switch rationale",
      tone: "border-orange-400/40 bg-orange-400/10",
    };
  }

  if (event.event === "quorum_reached") {
    return {
      label: contextPrefix || "QUORUM",
      title: "Consensus reached",
      summary: String(data.final_answer ?? "The participating agents converged on a final answer."),
      detailsLabel: "quorum payload",
      tone: "border-emerald-400/40 bg-emerald-400/10",
    };
  }

  if (event.event === "provider_retrying") {
    return {
      label: "RETRYING",
      title: "Provider retry in progress",
      summary: String(data.message ?? data.reason ?? "A provider call hit a transient failure and is retrying."),
      detailsLabel: "retry diagnostics",
      tone: "border-amber-400/40 bg-amber-400/10",
    };
  }

  if (event.event === "artifact_created") {
    return {
      label: "ARTIFACT",
      title: "Benchmark artifact persisted",
      summary: `Artifact ${String(data.artifact_id ?? "unknown")} is available for detail views and catalog listing.`,
      detailsLabel: "artifact payload",
      tone: "border-emerald-400/40 bg-emerald-400/10",
    };
  }

  if (event.event === "complete") {
    const switches = typeof data.mechanism_switches === "number"
      ? `${Math.round(data.mechanism_switches)} switches`
      : null;
    const entropy = typeof data.disagreement_entropy === "number"
      ? `entropy ${data.disagreement_entropy.toFixed(2)}`
      : null;
    const novelty = typeof data.novelty_score === "number"
      ? `novelty ${data.novelty_score.toFixed(2)}`
      : typeof data.information_gain_delta === "number"
        ? `info gain ${data.information_gain_delta.toFixed(2)}`
        : null;
    const completionBits = [switches, entropy, novelty].filter(Boolean).join(" · ");
    return {
      label: "COMPLETE",
      title: "Benchmark run completed",
      summary: completionBits
        ? `Run ${String(data.run_id ?? "unknown")} finished successfully · ${completionBits}`
        : `Run ${String(data.run_id ?? "unknown")} finished successfully.`,
      detailsLabel: "completion payload",
      tone: "border-emerald-400/40 bg-emerald-400/10",
    };
  }

  if (event.event === "failed" || event.event === "error") {
    return {
      label: "ERROR",
      title: "Benchmark run failed",
      summary: String(data.message ?? "The run stopped before completion."),
      detailsLabel: "error diagnostics",
      tone: "border-red-400/40 bg-red-400/10",
    };
  }

  return {
    label: eventLabel.toUpperCase(),
    title: eventLabel,
    summary: truncateText(prettyJson(event.data), 180),
    detailsLabel: "event payload",
    tone: "border-border-subtle bg-void",
  };
}

function deriveBenchmarkStreamState(
  status: BenchmarkDetailPayload["status"] | null | undefined,
  event: TaskEvent | null,
  now: number,
): { label: string; tone: string } {
  if (status === "failed") {
    return {
      label: "failed",
      tone: "border-red-400/40 text-red-500 bg-red-400/10",
    };
  }
  if (status === "completed") {
    return {
      label: "completed",
      tone: "border-emerald-400/40 text-emerald-500 bg-emerald-400/10",
    };
  }
  if (event?.event === "provider_retrying") {
    return {
      label: "retrying",
      tone: "border-amber-400/40 text-amber-500 bg-amber-400/10",
    };
  }
  if (status === "queued" || status === "running") {
    const ageMs = event?.timestamp ? now - new Date(event.timestamp).getTime() : Number.POSITIVE_INFINITY;
    if (Number.isFinite(ageMs) && ageMs <= 5000) {
      return {
        label: "connected",
        tone: "border-accent/40 text-accent bg-accent/10",
      };
    }
    return {
      label: "idle",
      tone: "border-border-subtle text-text-secondary bg-void",
    };
  }
  return {
    label: "idle",
    tone: "border-border-subtle text-text-secondary bg-void",
  };
}

function relativeTimeFrom(value: string | null | undefined, now: number): string {
  if (!value) {
    return "waiting...";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  const deltaSeconds = Math.max(0, Math.round((now - parsed.getTime()) / 1000));
  if (deltaSeconds < 2) {
    return "just now";
  }
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }
  const deltaMinutes = Math.round(deltaSeconds / 60);
  return `${deltaMinutes}m ago`;
}

function truncateText(value: string, limit: number): string {
  const normalized = value.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
