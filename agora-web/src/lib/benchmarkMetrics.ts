import type { BenchmarkPayload } from "./api";

export interface NormalizedMetric {
  accuracy: number;
  run_count: number;
  scored_run_count: number;
  proxy_run_count: number;
  avg_tokens: number;
  avg_thinking_tokens: number;
  avg_latency_ms: number;
  avg_estimated_cost_usd: number;
}

export interface NormalizedSummary {
  per_mode: Record<string, NormalizedMetric>;
  per_mechanism: Record<string, NormalizedMetric>;
  per_category: Record<string, Record<string, NormalizedMetric>>;
  completed_run_count: number;
  failed_run_count: number;
  degraded_run_count: number;
  scored_run_count: number;
  proxy_run_count: number;
}

export interface BenchmarkMetricRow {
  mechanism: string;
  accuracy: number | null;
  runCount: number;
  scoredRunCount: number;
  proxyRunCount: number;
  avgTokens: number;
  thinkingTokens: number;
  avgLatencyMs: number;
  avgCostUsd: number;
}

export interface BenchmarkCategoryRow {
  category: string;
  debate: number | null;
  vote: number | null;
  selector: number | null;
  debateScoredRuns: number;
  voteScoredRuns: number;
  selectorScoredRuns: number;
}

export interface BenchmarkLearningCurveState {
  available: boolean;
  data: Array<{ phase: "Pre" | "Post"; accuracy: number }>;
  reason: string | null;
}

export type BenchmarkArtifactKind = "validation" | "comparison" | "unknown";

export const BENCHMARK_DOMAIN_KEYS = [
  "math",
  "factual",
  "reasoning",
  "code",
  "creative",
  "demo",
] as const;

export const BENCHMARK_STAGE_KEYS = ["debate", "vote", "selector"] as const;

export const DEFAULT_METRIC: NormalizedMetric = {
  accuracy: 0,
  run_count: 0,
  scored_run_count: 0,
  proxy_run_count: 0,
  avg_tokens: 0,
  avg_thinking_tokens: 0,
  avg_latency_ms: 0,
  avg_estimated_cost_usd: 0,
};

export function normalizeBenchmarkSummary(
  summaryCandidate: unknown,
  benchmarkPayloadCandidate: unknown,
): NormalizedSummary {
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

export function detectBenchmarkArtifactKind(payload: BenchmarkPayload | Record<string, unknown> | null | undefined): BenchmarkArtifactKind {
  if (!isRecord(payload)) {
    return "unknown";
  }
  const record = payload as Record<string, any>;

  const hasLearningStages = (
    (isRecord(record.pre_learning) && isRecord(record.pre_learning.summary))
    || (isRecord(record.post_learning) && isRecord(record.post_learning.summary))
    || (isRecord(record.learning_updates) && isRecord(record.learning_updates.summary))
  );
  if (hasLearningStages) {
    return "validation";
  }

  const hasComparisonShape = Array.isArray(record.runs) || isRecord(record.summary);
  if (hasComparisonShape) {
    return "comparison";
  }

  return "unknown";
}

export function buildOverviewAccuracyData(summary: NormalizedSummary): Array<{
  category: string;
  debate: number;
  vote: number;
  selector: number;
}> {
  return BENCHMARK_DOMAIN_KEYS.map((domain) => {
    const metricsByMode = summary.per_category[domain] ?? {};
    return {
      category: titleCase(domain),
      debate: ((metricsByMode.debate?.accuracy ?? 0) as number) * 100,
      vote: ((metricsByMode.vote?.accuracy ?? 0) as number) * 100,
      selector: ((metricsByMode.selector?.accuracy ?? 0) as number) * 100,
    };
  });
}

export function buildOverviewLearningCurve(
  payload: BenchmarkPayload | Record<string, unknown> | null | undefined,
): BenchmarkLearningCurveState {
  const artifactKind = detectBenchmarkArtifactKind(payload);
  if (artifactKind !== "validation" || !isRecord(payload)) {
    return {
      available: false,
      data: [],
      reason: artifactKind === "comparison"
        ? "This comparison artifact does not include pre/post learning stages, so a learning curve would be misleading."
        : "Learning curve data is not available for this artifact.",
    };
  }
  const record = payload as Record<string, any>;

  const pre = asNumber(
    record.pre_learning?.summary?.per_mode?.selector?.accuracy
    ?? record.pre_learning?.summary?.per_mode?.vote?.accuracy,
  ) * 100;
  const post = asNumber(
    record.post_learning?.summary?.per_mode?.selector?.accuracy
    ?? record.post_learning?.summary?.per_mode?.vote?.accuracy
    ?? pre,
  ) * 100;

  return {
    available: true,
    data: [
      { phase: "Pre", accuracy: pre },
      { phase: "Post", accuracy: post || pre },
    ],
    reason: null,
  };
}

export function buildDetailStageRows(summary: NormalizedSummary): BenchmarkMetricRow[] {
  return buildMetricRows(summary.per_mode);
}

export function buildDetailMechanismRows(summary: NormalizedSummary): BenchmarkMetricRow[] {
  return buildMetricRows(summary.per_mechanism);
}

export function buildDetailCategoryRows(summary: NormalizedSummary): BenchmarkCategoryRow[] {
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
}

function buildMetricRows(
  source: Record<string, NormalizedMetric>,
): BenchmarkMetricRow[] {
  const ordered = new Set<string>(BENCHMARK_STAGE_KEYS);
  Object.keys(source).forEach((key) => ordered.add(key));
  return Array.from(ordered).map((mechanismKey) => {
    const metric = source[mechanismKey] ?? DEFAULT_METRIC;
    const scoredRunCount = Math.round(metric.scored_run_count);
    return {
      mechanism: titleCase(mechanismKey),
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

function hasSummaryData(summary: NormalizedSummary): boolean {
  return (
    Object.keys(summary.per_mode).length > 0
    || Object.keys(summary.per_mechanism).length > 0
    || Object.keys(summary.per_category).length > 0
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
