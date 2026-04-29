import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

import { useBenchmarkOverviewQuery } from "../lib/benchmarkQueries";
import {
  normalizeBenchmarkSummary,
  buildEnhancedParetoData,
  buildPerModelCostData,
  buildCategoryRadarData,
  BENCHMARK_DOMAIN_KEYS,
  type NormalizedMetric,
} from "../lib/benchmarkMetrics";
import { injectChartKeyframes, SkeletonChartBlock, CHART_FONT } from "../components/benchmark/ChartCard";
import { CostLatencyBubble } from "../components/benchmark/analytics/CostLatencyBubble";
import { SlopeGraph, type SlopeDataPoint } from "../components/benchmark/analytics/SlopeGraph";
import { PerModelCostBreakdown } from "../components/benchmark/analytics/PerModelCostBreakdown";
import { CategoryRadar } from "../components/benchmark/analytics/CategoryRadar";

function asNum(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractCategoryAccuracy(
  summary: Record<string, unknown>,
  domain: string,
): number | null {
  const byCat = isObj(summary.per_category_by_mechanism)
    ? (summary.per_category_by_mechanism as Record<string, Record<string, Record<string, unknown>>>)[domain]
    : undefined;
  const flat = isObj(summary.per_category)
    ? (summary.per_category as Record<string, Record<string, Record<string, unknown>>>)[domain]
    : undefined;

  const pick = (map: Record<string, Record<string, unknown>> | undefined) => {
    if (!map) return null;
    const m = (map.selector ?? map.delphi ?? map.vote ?? map.debate) as Record<string, unknown> | undefined;
    if (!m || asNum(m.scored_run_count) === 0) return null;
    return asNum(m.accuracy) * 100;
  };

  return pick(byCat as Record<string, Record<string, unknown>>) ?? pick(flat as Record<string, Record<string, unknown>>);
}

export function BenchmarkAnalytics() {
  useEffect(() => { injectChartKeyframes(); }, []);

  const overviewQuery = useBenchmarkOverviewQuery(true, "latest");
  const isLoading = overviewQuery.isLoading;
  const overview = overviewQuery.data;
  const payload = useMemo(() => (overview as unknown as Record<string, unknown>) ?? {}, [overview]);

  const summary = useMemo(
    () => normalizeBenchmarkSummary(overview?.summary, overview),
    [overview],
  );

  const enhancedPareto = useMemo(() => buildEnhancedParetoData(summary), [summary]);

  const perModelCost = useMemo(
    () => buildPerModelCostData((overview as Record<string, unknown> | undefined) ?? {}),
    [overview],
  );

  const categoryRadar = useMemo(() => buildCategoryRadarData(summary), [summary]);

  // Build slope data directly from pre/post raw payload summaries
  const slopeData = useMemo((): SlopeDataPoint[] => {
    const benchPayload = payload;
    const preSection = benchPayload.pre_learning;
    const postSection = benchPayload.post_learning;

    if (!isObj(preSection) || !isObj(postSection)) return [];

    const preSummary = isObj(preSection.summary) ? preSection.summary as Record<string, unknown> : null;
    const postSummary = isObj(postSection.summary) ? postSection.summary as Record<string, unknown> : null;

    if (!preSummary || !postSummary) return [];

    const points = BENCHMARK_DOMAIN_KEYS.map((domain): SlopeDataPoint | null => {
      const pre = extractCategoryAccuracy(preSummary, domain);
      const post = extractCategoryAccuracy(postSummary, domain);
      if (pre === null) return null;
      const postVal = post ?? pre;
      const delta = Number((postVal - pre).toFixed(1));
      return {
        category: domain.charAt(0).toUpperCase() + domain.slice(1),
        pre,
        post: postVal,
        delta,
        saturated: pre >= 99.9 && postVal >= 99.9,
      };
    });

    return points.filter((p): p is SlopeDataPoint => p !== null);
  }, [overview, payload]);

  // Mechanism-level cost rows as fallback when no run-level telemetry
  const mechanismCostFallback = useMemo(() => {
    if (perModelCost.length > 0) return null;
    return Object.entries(summary.per_mechanism)
      .filter(([, m]) => (m as NormalizedMetric).run_count > 0)
      .sort((a, b) => (b[1] as NormalizedMetric).avg_estimated_cost_usd - (a[1] as NormalizedMetric).avg_estimated_cost_usd)
      .map(([mechanism, m]) => ({
        model: mechanism,
        totalCostUsd: (m as NormalizedMetric).avg_estimated_cost_usd,
        totalTokens: Math.round((m as NormalizedMetric).avg_tokens),
        thinkingTokens: Math.round((m as NormalizedMetric).avg_thinking_tokens),
        inputTokens: Math.round(((m as NormalizedMetric).avg_tokens - (m as NormalizedMetric).avg_thinking_tokens) * 0.6),
        outputTokens: Math.round(((m as NormalizedMetric).avg_tokens - (m as NormalizedMetric).avg_thinking_tokens) * 0.4),
      }));
  }, [perModelCost, summary]);

  const hasAnyData = enhancedPareto.length > 0 || categoryRadar.some((r) => r.accuracy > 0 || r.coverage > 0);

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px 48px" }}>
      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <Link to="/benchmarks" style={{
          display: "inline-flex", alignItems: "center", gap: "4px",
          fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.08em",
          color: "var(--text-tertiary)", textDecoration: "none", marginBottom: "16px",
          textTransform: "uppercase",
        }}>
          <ChevronLeft size={12} /> Benchmarks
        </Link>
        <h1 style={{
          fontFamily: CHART_FONT, fontSize: "18px", letterSpacing: "0.06em",
          textTransform: "uppercase", color: "var(--text-primary)", margin: 0, marginBottom: "6px",
        }}>
          Benchmark Analytics
        </h1>
        <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>
          Expanded charts across your benchmark suite.
        </p>
      </div>

      {isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <SkeletonChartBlock h="280px" delay={0} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
            <SkeletonChartBlock h="320px" delay={0.1} />
            <SkeletonChartBlock h="320px" delay={0.2} />
          </div>
          <SkeletonChartBlock h="260px" delay={0.3} />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Two-column: Bubble + Radar */}
          {hasAnyData && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "20px" }}>
              {enhancedPareto.length > 0 && <CostLatencyBubble data={enhancedPareto} />}
              {categoryRadar.some((r) => r.accuracy > 0 || r.coverage > 0) && (
                <CategoryRadar data={categoryRadar} />
              )}
            </div>
          )}

          {/* Full-width: Per-model cost (run-level or mechanism fallback) */}
          {perModelCost.length > 0 && <PerModelCostBreakdown data={perModelCost} />}
          {mechanismCostFallback && mechanismCostFallback.length > 0 && (
            <PerModelCostBreakdown data={mechanismCostFallback} />
          )}

          {/* Full-width: Pre → Post slope graph — last so it contextualises the above */}
          {slopeData.length > 0 && <SlopeGraph data={slopeData} />}

          {/* Empty state */}
          {!hasAnyData && (
            <div className="card p-6" style={{ textAlign: "center" }}>
              <p style={{ fontFamily: CHART_FONT, fontSize: "11px", color: "var(--text-muted)" }}>
                No analytics data available yet. Run benchmarks to populate this page.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
