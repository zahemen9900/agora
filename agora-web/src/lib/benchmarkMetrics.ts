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
  per_category_by_mechanism: Record<string, Record<string, NormalizedMetric>>;
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

export interface BenchmarkHeatmapCell {
  mechanism: string;
  accuracy: number | null;
  scoredRunCount: number;
  proxyRunCount: number;
  runCount: number;
}

export interface BenchmarkHeatmapRow {
  category: string;
  cells: BenchmarkHeatmapCell[];
}

export interface BenchmarkParetoPoint {
  mechanism: string;
  accuracy: number | null;
  avgCostUsd: number | null;
  avgTokens: number;
  scoredRunCount: number;
  proxyRunCount: number;
  frontier: boolean;
}

export interface BenchmarkLearningCurveState {
  available: boolean;
  data: Array<{ phase: "Pre" | "Post"; accuracy: number }>;
  reason: string | null;
  preAccuracy: number | null;
  postAccuracy: number | null;
  preScoredRunCount: number;
  postScoredRunCount: number;
  delta: number | null;
  saturated: boolean;
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
    return fillDerivedSummaryAxes(fromSummary, benchmarkPayloadCandidate);
  }

  const payloadSummary = extractSummaryFromBenchmarkPayload(benchmarkPayloadCandidate);
  const fromPayload = parseSummaryObject(payloadSummary);
  if (hasSummaryData(fromPayload)) {
    return fillDerivedSummaryAxes(fromPayload, benchmarkPayloadCandidate);
  }

  return fillDerivedSummaryAxes({
    per_mode: {},
    per_mechanism: {},
    per_category: {},
    per_category_by_mechanism: {},
    completed_run_count: 0,
    failed_run_count: 0,
    degraded_run_count: 0,
    scored_run_count: 0,
    proxy_run_count: 0,
  }, benchmarkPayloadCandidate);
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
  debate: number | null;
  vote: number | null;
  selector: number | null;
}> {
  const categorySource = hasCategoryAxisData(summary.per_category_by_mechanism)
    ? summary.per_category_by_mechanism
    : summary.per_category;
  return BENCHMARK_DOMAIN_KEYS.map((domain) => {
    const metricsByMode = categorySource[domain] ?? {};
    const debateScored = metricsByMode.debate?.scored_run_count ?? 0;
    const voteScored = metricsByMode.vote?.scored_run_count ?? 0;
    const selectorScored = metricsByMode.selector?.scored_run_count ?? 0;
    return {
      category: titleCase(domain),
      debate: debateScored > 0 ? ((metricsByMode.debate?.accuracy ?? 0) as number) * 100 : null,
      vote: voteScored > 0 ? ((metricsByMode.vote?.accuracy ?? 0) as number) * 100 : null,
      selector: selectorScored > 0 ? ((metricsByMode.selector?.accuracy ?? 0) as number) * 100 : null,
    };
  });
}

export function buildOverviewCostData(summary: NormalizedSummary): Array<{
  mechanism: string;
  estimatedCostUsd: number | null;
}> {
  const source = hasMetricAxisData(summary.per_mechanism) ? summary.per_mechanism : summary.per_mode;
  return BENCHMARK_STAGE_KEYS.map((mechanism) => {
    const metrics = source[mechanism] ?? DEFAULT_METRIC;
    const runCount = metrics.run_count;
    const avgCost = metrics.avg_estimated_cost_usd;
    return {
      mechanism: titleCase(mechanism),
      estimatedCostUsd: runCount > 0 && avgCost > 0 ? avgCost : null,
    };
  });
}

export function buildOverviewParetoData(summary: NormalizedSummary): BenchmarkParetoPoint[] {
  const rows = buildMetricRows(summary.per_mechanism);
  const candidates = rows
    .filter((row) => row.accuracy != null && row.avgCostUsd > 0 && row.scoredRunCount > 0)
    .map((row) => ({
      mechanism: row.mechanism,
      accuracy: row.accuracy,
      avgCostUsd: row.avgCostUsd,
      avgTokens: row.avgTokens,
      scoredRunCount: row.scoredRunCount,
      proxyRunCount: row.proxyRunCount,
      frontier: false,
    }));

  return candidates.map((candidate) => ({
    ...candidate,
    frontier: !candidates.some((other) => (
      other.mechanism !== candidate.mechanism
      && (other.avgCostUsd ?? Number.POSITIVE_INFINITY) <= (candidate.avgCostUsd ?? Number.POSITIVE_INFINITY)
      && (other.accuracy ?? Number.NEGATIVE_INFINITY) >= (candidate.accuracy ?? Number.NEGATIVE_INFINITY)
      && (
        (other.avgCostUsd ?? Number.POSITIVE_INFINITY) < (candidate.avgCostUsd ?? Number.POSITIVE_INFINITY)
        || (other.accuracy ?? Number.NEGATIVE_INFINITY) > (candidate.accuracy ?? Number.NEGATIVE_INFINITY)
      )
    )),
  }));
}

export function buildOverviewHeatmapRows(summary: NormalizedSummary): BenchmarkHeatmapRow[] {
  const categorySource = hasCategoryAxisData(summary.per_category_by_mechanism)
    ? summary.per_category_by_mechanism
    : summary.per_category;

  return BENCHMARK_DOMAIN_KEYS.map((domain) => {
    const metricsByMechanism = categorySource[domain] ?? {};
    return {
      category: titleCase(domain),
      cells: BENCHMARK_STAGE_KEYS.map((mechanism) => {
        const metrics = metricsByMechanism[mechanism] ?? DEFAULT_METRIC;
        const scoredRunCount = Math.round(metrics.scored_run_count);
        return {
          mechanism: titleCase(mechanism),
          accuracy: scoredRunCount > 0 ? Number((metrics.accuracy * 100).toFixed(1)) : null,
          scoredRunCount,
          proxyRunCount: Math.round(metrics.proxy_run_count),
          runCount: Math.round(metrics.run_count),
        };
      }),
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
      preAccuracy: null,
      postAccuracy: null,
      preScoredRunCount: 0,
      postScoredRunCount: 0,
      delta: null,
      saturated: false,
    };
  }
  const record = payload as Record<string, any>;

  const pre = asNumber(
    record.pre_learning?.summary?.per_mode?.selector?.accuracy
    ?? record.pre_learning?.summary?.per_mode?.vote?.accuracy,
  ) * 100;
  const rawPostAccuracy = record.post_learning?.summary?.per_mode?.selector?.accuracy
    ?? record.post_learning?.summary?.per_mode?.vote?.accuracy;
  const post = (rawPostAccuracy === undefined || rawPostAccuracy === null)
    ? pre
    : asNumber(rawPostAccuracy) * 100;
  const preScored = asNumber(
    record.pre_learning?.summary?.per_mode?.selector?.scored_run_count
    ?? record.pre_learning?.summary?.per_mode?.vote?.scored_run_count,
  );
  const postScored = asNumber(
    record.post_learning?.summary?.per_mode?.selector?.scored_run_count
    ?? record.post_learning?.summary?.per_mode?.vote?.scored_run_count,
  );

  if (preScored <= 0 && postScored <= 0) {
    return {
      available: false,
      data: [],
      reason: "This validation artifact does not have scored selector coverage for the learning curve yet.",
      preAccuracy: Number.isFinite(pre) ? pre : null,
      postAccuracy: Number.isFinite(post) ? post : null,
      preScoredRunCount: preScored,
      postScoredRunCount: postScored,
      delta: Number.isFinite(pre) && Number.isFinite(post) ? Number((post - pre).toFixed(1)) : null,
      saturated: false,
    };
  }

  const delta = Number((post - pre).toFixed(1));
  const saturated = pre >= 99.9 && post >= 99.9;

  return {
    available: true,
    data: [
      { phase: "Pre", accuracy: pre },
      { phase: "Post", accuracy: post },
    ],
    reason: null,
    preAccuracy: pre,
    postAccuracy: post,
    preScoredRunCount: preScored,
    postScoredRunCount: postScored,
    delta,
    saturated,
  };
}

export function buildDetailStageRows(summary: NormalizedSummary): BenchmarkMetricRow[] {
  return buildMetricRows(summary.per_mode);
}

export function buildDetailMechanismRows(summary: NormalizedSummary): BenchmarkMetricRow[] {
  return buildMetricRows(summary.per_mechanism);
}

export function buildDetailCategoryRows(summary: NormalizedSummary): BenchmarkCategoryRow[] {
  const categorySource = hasCategoryAxisData(summary.per_category_by_mechanism)
    ? summary.per_category_by_mechanism
    : summary.per_category;
  const categories = Object.keys(categorySource);
  return categories.map((category) => {
    const perMode = categorySource[category] ?? {};
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
      per_category_by_mechanism: {},
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

  const perCategoryByMechanism: Record<string, Record<string, NormalizedMetric>> = {};
  const perCategoryByMechanismSource = candidate.per_category_by_mechanism;
  if (isRecord(perCategoryByMechanismSource)) {
    for (const [category, categoryValue] of Object.entries(perCategoryByMechanismSource)) {
      if (!isRecord(categoryValue)) {
        continue;
      }
      perCategoryByMechanism[category] = {};
      for (const [mechanism, value] of Object.entries(categoryValue)) {
        perCategoryByMechanism[category][mechanism] = parseMetric(value);
      }
    }
  }

  return {
    per_mode: perMode,
    per_mechanism: perMechanism,
    per_category: perCategory,
    per_category_by_mechanism: perCategoryByMechanism,
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
    || Object.keys(summary.per_category_by_mechanism).length > 0
  );
}

function hasMetricAxisData(source: Record<string, NormalizedMetric>): boolean {
  return Object.values(source).some((metric) => metric.run_count > 0);
}

function hasCategoryAxisData(source: Record<string, Record<string, NormalizedMetric>>): boolean {
  return Object.values(source).some((metricsByMechanism) => hasMetricAxisData(metricsByMechanism));
}

function fillDerivedSummaryAxes(
  summary: NormalizedSummary,
  benchmarkPayloadCandidate: unknown,
): NormalizedSummary {
  if (hasCategoryAxisData(summary.per_category_by_mechanism)) {
    return summary;
  }

  const derived = deriveCategoryByMechanismFromPayload(benchmarkPayloadCandidate);
  if (!hasCategoryAxisData(derived)) {
    return summary;
  }

  return {
    ...summary,
    per_category_by_mechanism: derived,
  };
}

function deriveCategoryByMechanismFromPayload(
  candidate: unknown,
): Record<string, Record<string, NormalizedMetric>> {
  const runs = extractBenchmarkRuns(candidate);
  if (runs.length === 0) {
    return {};
  }

  const buckets = new Map<string, Array<Record<string, any>>>();
  for (const run of runs) {
    const status = String(run.item_status ?? "completed").toLowerCase();
    if (status === "failed") {
      continue;
    }
    const category = String(run.category ?? "unknown").toLowerCase();
    const mechanism = String(run.mechanism_used ?? run.mechanism ?? run.mode ?? "selector").toLowerCase();
    const key = `${category}\u0000${mechanism}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(run);
    buckets.set(key, bucket);
  }

  const output: Record<string, Record<string, NormalizedMetric>> = {};
  for (const [key, bucket] of buckets.entries()) {
    const [category, mechanism] = key.split("\u0000");
    output[category] = output[category] ?? {};
    output[category][mechanism] = summarizeRunBucket(bucket);
  }
  return output;
}

function extractBenchmarkRuns(candidate: unknown): Array<Record<string, any>> {
  if (!isRecord(candidate)) {
    return [];
  }
  const runs: Array<Record<string, any>> = [];
  if (Array.isArray(candidate.runs)) {
    runs.push(...candidate.runs.filter(isRecord));
  }
  for (const key of ["pre_learning", "learning_updates", "post_learning"]) {
    const section = candidate[key];
    if (isRecord(section) && Array.isArray(section.runs)) {
      runs.push(...section.runs.filter(isRecord));
    }
  }
  return runs;
}

function summarizeRunBucket(bucket: Array<Record<string, any>>): NormalizedMetric {
  const runCount = bucket.length;
  const scored = bucket.filter((run) => Boolean(run.scored));
  const scoredRunCount = scored.length;
  const proxyRunCount = scored.filter((run) => String(run.scoring_mode ?? "").toLowerCase() === "proxy_success").length;
  return {
    accuracy: scoredRunCount > 0
      ? scored.filter((run) => Boolean(run.correct)).length / scoredRunCount
      : 0,
    run_count: runCount,
    scored_run_count: scoredRunCount,
    proxy_run_count: proxyRunCount,
    avg_tokens: average(bucket, (run) => asNumber(run.tokens_used ?? run.total_tokens_used)),
    avg_thinking_tokens: average(bucket, (run) => asNumber(run.thinking_tokens_used)),
    avg_latency_ms: average(bucket, (run) => asNumber(run.latency_ms)),
    avg_estimated_cost_usd: average(bucket, (run) => asNumber(run.estimated_cost_usd)),
  };
}

function average(bucket: Array<Record<string, any>>, selector: (run: Record<string, any>) => number): number {
  if (bucket.length === 0) {
    return 0;
  }
  return bucket.reduce((total, run) => total + selector(run), 0) / bucket.length;
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

// ─── Rich payload types ───────────────────────────────────────────────────────

export interface ModelTelemetryEntry {
  total_tokens: number;
  thinking_tokens: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  estimated_cost_usd: number;
}

export interface ConvergenceHistoryItem {
  round_number: number;
  disagreement_entropy: number;
  dominant_answer_share: number;
  unique_answers: number;
  answer_churn: number;
  js_divergence: number;
  novelty_score: number;
  answer_distribution: Record<string, number>;
}

export interface MechanismTraceItem {
  mechanism: string;
  start_round: number;
  end_round: number;
  switch_reason: string | null;
  convergence_history: ConvergenceHistoryItem[];
}

export interface RawBenchmarkRun {
  task_index: number;
  category: string;
  mechanism_used: string;
  correct: boolean;
  confidence: number;
  tokens_used: number;
  thinking_tokens_used: number;
  latency_ms: number;
  estimated_cost_usd: number;
  rounds: number;
  switches: number;
  agent_models_used: string[];
  selector_reasoning?: string;
  model_telemetry: Record<string, ModelTelemetryEntry>;
  model_estimated_costs_usd: Record<string, number>;
  convergence_history: ConvergenceHistoryItem[];
  mechanism_trace: MechanismTraceItem[];
}

export interface BanditCategoryStats {
  alpha: number;
  beta_param: number;
  last_reward: number | null;
  total_pulls: number;
}

export type BanditStats = Record<string, Record<string, BanditCategoryStats>>;

export interface EnhancedParetoPoint extends BenchmarkParetoPoint {
  avgLatencyMs: number;
  thinkingRatio: number;
}

export interface PerModelCostRow {
  model: string;
  totalCostUsd: number;
  totalTokens: number;
  thinkingTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CategoryRadarRow {
  category: string;
  accuracy: number;
  costEfficiency: number;
  speed: number;
  thinkingRatio: number;
  coverage: number;
}

// ─── Public payload extraction functions ─────────────────────────────────────

export function extractPayloadRuns(
  payload: Record<string, unknown>,
  phase: "pre_learning" | "post_learning" | "learning_updates",
): RawBenchmarkRun[] {
  const section = payload[phase];
  if (!isRecord(section) || !Array.isArray(section.runs)) {
    return [];
  }
  return (section.runs as unknown[]).filter(isRecord).map((raw) => parseRawRun(raw));
}

export function extractBanditStats(payload: Record<string, unknown>): BanditStats | null {
  const stats = payload.bandit_stats;
  if (!isRecord(stats)) {
    return null;
  }
  const result: BanditStats = {};
  for (const [mechanism, byCategory] of Object.entries(stats)) {
    if (!isRecord(byCategory)) continue;
    result[mechanism] = {};
    for (const [category, entry] of Object.entries(byCategory)) {
      if (!isRecord(entry)) continue;
      result[mechanism][category] = {
        alpha: asNumber(entry.alpha),
        beta_param: asNumber(entry.beta_param),
        last_reward: entry.last_reward == null ? null : asNumber(entry.last_reward),
        total_pulls: asNumber(entry.total_pulls),
      };
    }
  }
  return result;
}

export function buildEnhancedParetoData(summary: NormalizedSummary): EnhancedParetoPoint[] {
  const base = buildOverviewParetoData(summary);
  return base.map((pt) => {
    const metric = summary.per_mechanism[pt.mechanism.toLowerCase()] ?? DEFAULT_METRIC;
    const thinkingRatio = metric.avg_tokens > 0 ? metric.avg_thinking_tokens / metric.avg_tokens : 0;
    return {
      ...pt,
      avgLatencyMs: metric.avg_latency_ms,
      thinkingRatio,
    };
  });
}

export function buildPerModelCostData(payload: Record<string, unknown>): PerModelCostRow[] {
  const allRuns: RawBenchmarkRun[] = [
    ...extractPayloadRuns(payload, "pre_learning"),
    ...extractPayloadRuns(payload, "post_learning"),
    ...extractPayloadRuns(payload, "learning_updates"),
  ];

  const accumulator = new Map<string, PerModelCostRow>();
  for (const run of allRuns) {
    for (const [model, telemetry] of Object.entries(run.model_telemetry)) {
      const existing = accumulator.get(model) ?? {
        model,
        totalCostUsd: 0,
        totalTokens: 0,
        thinkingTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      existing.totalCostUsd += telemetry.estimated_cost_usd;
      existing.totalTokens += telemetry.total_tokens;
      existing.thinkingTokens += telemetry.thinking_tokens;
      existing.inputTokens += telemetry.input_tokens;
      existing.outputTokens += telemetry.output_tokens;
      accumulator.set(model, existing);
    }
  }

  return Array.from(accumulator.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

export function buildCategoryRadarData(summary: NormalizedSummary): CategoryRadarRow[] {
  const categorySource = hasCategoryAxisData(summary.per_category_by_mechanism)
    ? summary.per_category_by_mechanism
    : summary.per_category;

  const rows = BENCHMARK_DOMAIN_KEYS.map((domain) => {
    const metricsByMode = categorySource[domain] ?? {};
    const allMetrics = Object.values(metricsByMode);
    if (allMetrics.length === 0) {
      return { domain, accuracy: 0, avgCost: 0, avgLatency: 0, avgThinkingRatio: 0, coverage: 0, runCount: 0, scoredRunCount: 0 };
    }
    const scoredMetrics = allMetrics.filter((m) => m.scored_run_count > 0);
    const accuracy = scoredMetrics.length > 0
      ? scoredMetrics.reduce((s, m) => s + m.accuracy, 0) / scoredMetrics.length * 100
      : 0;
    const avgCost = average(allMetrics as unknown as Array<Record<string, any>>, (m) => asNumber((m as NormalizedMetric).avg_estimated_cost_usd));
    const avgLatency = average(allMetrics as unknown as Array<Record<string, any>>, (m) => asNumber((m as NormalizedMetric).avg_latency_ms));
    const avgThinkingRatio = average(
      allMetrics as unknown as Array<Record<string, any>>,
      (m) => {
        const metric = m as NormalizedMetric;
        return metric.avg_tokens > 0 ? metric.avg_thinking_tokens / metric.avg_tokens : 0;
      },
    );
    const runCount = allMetrics.reduce((s, m) => s + m.run_count, 0);
    const scoredRunCount = allMetrics.reduce((s, m) => s + m.scored_run_count, 0);
    return { domain, accuracy, avgCost, avgLatency, avgThinkingRatio, coverage: runCount > 0 ? scoredRunCount / runCount : 0, runCount, scoredRunCount };
  });

  const maxCost = Math.max(...rows.map((r) => r.avgCost), 0.000001);
  const maxLatency = Math.max(...rows.map((r) => r.avgLatency), 1);

  return rows.map((r) => ({
    category: titleCase(r.domain),
    accuracy: Number(r.accuracy.toFixed(1)),
    costEfficiency: Number(Math.max(0, 100 - (r.avgCost / maxCost) * 100).toFixed(1)),
    speed: Number(Math.max(0, 100 - (r.avgLatency / maxLatency) * 100).toFixed(1)),
    thinkingRatio: Number((r.avgThinkingRatio * 100).toFixed(1)),
    coverage: Number((r.coverage * 100).toFixed(1)),
  }));
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function parseRawRun(raw: Record<string, any>): RawBenchmarkRun {
  return {
    task_index: asNumber(raw.task_index),
    category: String(raw.category ?? "unknown"),
    mechanism_used: String(raw.mechanism_used ?? raw.mechanism ?? "selector"),
    correct: Boolean(raw.correct),
    confidence: asNumber(raw.confidence),
    tokens_used: asNumber(raw.tokens_used ?? raw.total_tokens_used),
    thinking_tokens_used: asNumber(raw.thinking_tokens_used),
    latency_ms: asNumber(raw.latency_ms),
    estimated_cost_usd: asNumber(raw.estimated_cost_usd),
    rounds: asNumber(raw.rounds),
    switches: asNumber(raw.switches),
    agent_models_used: Array.isArray(raw.agent_models_used) ? raw.agent_models_used.map(String) : [],
    selector_reasoning: raw.selector_reasoning != null ? String(raw.selector_reasoning) : undefined,
    model_telemetry: parseTelemetryMap(raw.model_telemetry),
    model_estimated_costs_usd: parseCostMap(raw.model_estimated_costs_usd),
    convergence_history: parseConvergenceHistory(raw.convergence_history),
    mechanism_trace: parseMechanismTrace(raw.mechanism_trace),
  };
}

function parseTelemetryMap(raw: unknown): Record<string, ModelTelemetryEntry> {
  if (!isRecord(raw)) return {};
  const result: Record<string, ModelTelemetryEntry> = {};
  for (const [model, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    result[model] = {
      total_tokens: asNumber(entry.total_tokens),
      thinking_tokens: asNumber(entry.thinking_tokens),
      input_tokens: asNumber(entry.input_tokens),
      output_tokens: asNumber(entry.output_tokens),
      latency_ms: asNumber(entry.latency_ms),
      estimated_cost_usd: asNumber(entry.estimated_cost_usd),
    };
  }
  return result;
}

function parseCostMap(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const result: Record<string, number> = {};
  for (const [model, cost] of Object.entries(raw)) {
    result[model] = asNumber(cost);
  }
  return result;
}

function parseConvergenceHistory(raw: unknown): ConvergenceHistoryItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => ({
    round_number: asNumber(item.round_number),
    disagreement_entropy: asNumber(item.disagreement_entropy),
    dominant_answer_share: asNumber(item.dominant_answer_share),
    unique_answers: asNumber(item.unique_answers),
    answer_churn: asNumber(item.answer_churn),
    js_divergence: asNumber(item.js_divergence),
    novelty_score: asNumber(item.novelty_score),
    answer_distribution: parseStringNumericMap(item.answer_distribution),
  }));
}

function parseMechanismTrace(raw: unknown): MechanismTraceItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((item) => ({
    mechanism: String(item.mechanism ?? "unknown"),
    start_round: asNumber(item.start_round),
    end_round: asNumber(item.end_round),
    switch_reason: item.switch_reason != null ? String(item.switch_reason) : null,
    convergence_history: parseConvergenceHistory(item.convergence_history),
  }));
}

function parseStringNumericMap(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    result[k] = asNumber(v);
  }
  return result;
}
