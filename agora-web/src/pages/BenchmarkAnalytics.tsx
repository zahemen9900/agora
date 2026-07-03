import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

import { useBenchmarkOverviewQuery, type BenchmarkOverviewMode } from "../lib/benchmarkQueries";
import {
  normalizeBenchmarkSummary,
  buildEnhancedParetoData,
  buildPerModelCostData,
  buildCategoryRadarData,
  buildCategoryLearningShiftData,
  type NormalizedMetric,
} from "../lib/benchmarkMetrics";
import { injectChartKeyframes, SkeletonChartBlock, CHART_FONT } from "../components/benchmark/ChartCard";
import { CostLatencyBubble } from "../components/benchmark/analytics/CostLatencyBubble";
import { SlopeGraph, type SlopeDataPoint } from "../components/benchmark/analytics/SlopeGraph";
import { PerModelCostBreakdown } from "../components/benchmark/analytics/PerModelCostBreakdown";
import { CategoryRadar } from "../components/benchmark/analytics/CategoryRadar";

export function BenchmarkAnalytics() {
  useEffect(() => { injectChartKeyframes(); }, []);

  const [searchParams] = useSearchParams();
  const overviewMode = (searchParams.get("mode") ?? "aggregate_recent") as BenchmarkOverviewMode;
  const overviewQuery = useBenchmarkOverviewQuery(true, overviewMode);
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

  const slopeData = useMemo(
    (): SlopeDataPoint[] => buildCategoryLearningShiftData(payload),
    [payload],
  );

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
