import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { ChevronDown, Filter, RotateCcw } from "lucide-react";

import { BenchmarkWizard, type DomainPromptSelection } from "../components/benchmark/BenchmarkWizard";
import { CatalogRunRow, FailedRunRow, LiveRunRow, SkeletonRunRow } from "../components/benchmark/BenchmarkRunRow";
import { ChartCard, injectChartKeyframes, SkeletonChartBlock, ShimBlock, CHART_FONT } from "../components/benchmark/ChartCard";
import {
  type BenchmarkDomainName,
  type BenchmarkPromptTemplatesPayload,
  type BenchmarkRunRequestPayload,
  type BenchmarkRunStatusPayload,
} from "../lib/api";
import {
  benchmarkQueryKeys,
  seedTriggeredBenchmarkRunCache,
  type BenchmarkOverviewMode,
  useBenchmarkCatalogQuery,
  useBenchmarkOverviewQuery,
  useBenchmarkPromptTemplatesQuery,
  useTriggerBenchmarkMutation,
} from "../lib/benchmarkQueries";
import {
  BENCHMARK_DOMAIN_KEYS,
  buildOverviewHeatmapRows,
  buildOverviewLearningCurve,
  buildOverviewParetoData,
  detectBenchmarkArtifactKind,
  normalizeBenchmarkSummary,
  type BenchmarkHeatmapRow,
  type NormalizedSummary,
} from "../lib/benchmarkMetrics";
import {
  buildTierModelOverridesPayload,
  buildDebateRoster,
  buildProviderCountBadges,
  buildVoteRoster,
  DEFAULT_REASONING_PRESETS,
  getBalancedEnsembleLabel,
  getDebateSpecialistSummary,
  resolveDefaultReasoningPresets,
  type ReasoningPresetState,
  type TierModelOverrideState,
} from "../lib/deliberationConfig";
import { useDeliberationRuntimeConfigQuery } from "../lib/runtimeConfigQueries";

type CatalogSortMode = "recent" | "frequency";

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const BENCHMARK_DOMAINS: BenchmarkDomainName[] = [...BENCHMARK_DOMAIN_KEYS];
const FALLBACK_PROMPT_TEMPLATES: BenchmarkPromptTemplatesPayload = {
  domains: {
    math: [
      {
        id: "math-stepwise",
        title: "Compound Growth",
        question: "A portfolio grows at 8% annually, compounded monthly. What is its value after 5 years if the initial investment is $10,000? Round to the nearest dollar.",
      },
      {
        id: "math-proof-check",
        title: "Break-even Analysis",
        question: "A product costs $240 to manufacture and sells for $360. Fixed monthly overhead is $18,000. How many units must be sold per month to break even?",
      },
      {
        id: "math-fast",
        title: "Probability Estimate",
        question: "A fair six-sided die is rolled three times. What is the probability of getting at least one 6?",
      },
      {
        id: "math-robust",
        title: "Optimal Allocation",
        question: "A team has 120 hours to allocate across two projects. Project A yields $500/hour of value and Project B yields $350/hour, but B requires at least 40 hours. How should the hours be split to maximize total value?",
      },
    ],
    factual: [
      {
        id: "factual-cited",
        title: "Consensus Threshold",
        question: "What voting threshold does the UN Security Council require to pass a non-procedural resolution, and which members hold veto power?",
      },
      {
        id: "factual-multihop",
        title: "Protocol Origin",
        question: "Which organization originally developed the TCP/IP protocol suite, and in what decade was it first deployed?",
      },
      {
        id: "factual-precision",
        title: "Market Structure",
        question: "What distinguishes an oligopoly from a monopoly, and name one real-world industry that is commonly cited as an oligopoly?",
      },
      {
        id: "factual-contrast",
        title: "Constitutional Clause",
        question: "What does the equal protection clause of the US 14th Amendment guarantee, and which landmark Supreme Court case applied it to school segregation?",
      },
    ],
    reasoning: [
      {
        id: "reasoning-tradeoff",
        title: "Rollout Strategy",
        question: "A company wants to deploy a new AI model to 10 million users. Should it do a full immediate rollout or a staged 5% canary release first? Consider reliability, user impact, and rollback complexity.",
      },
      {
        id: "reasoning-structured",
        title: "Hiring Signal",
        question: "A candidate scores in the 95th percentile on technical assessments but performed poorly in the panel interview. Should the hiring committee weight the structured test or the interview more heavily, and why?",
      },
      {
        id: "reasoning-risk",
        title: "Audit vs. Speed",
        question: "A financial institution can deploy a credit-scoring model that is 3% more accurate than its current one but is a black box. Should accuracy gains outweigh auditability requirements in regulated lending?",
      },
      {
        id: "reasoning-ethical",
        title: "Data Retention",
        question: "A health-tech startup collects anonymized patient data to improve its diagnostic model. Should it retain this data indefinitely for model improvement, or delete it after 2 years to limit privacy risk?",
      },
    ],
    code: [
      {
        id: "code-bugfix",
        title: "Deadlock Diagnosis",
        question: "Two microservices each acquire a lock on a shared resource before requesting a lock held by the other. The system intermittently hangs under load. What is the root cause and the minimal fix?",
      },
      {
        id: "code-design",
        title: "Schema Migration",
        question: "A production API needs to add a non-nullable column to a table with 50 million rows and zero downtime. Should the team use a multi-step migration with a backfill, or a single ALTER TABLE statement? Justify the choice.",
      },
      {
        id: "code-performance",
        title: "Cache Strategy",
        question: "An endpoint that aggregates data from three downstream services has a p99 latency of 800ms. The underlying data changes every 5 minutes. Should the team add an in-memory cache, a Redis layer, or parallelize the downstream calls? Which gives the best latency improvement with the lowest risk?",
      },
      {
        id: "code-tests",
        title: "Test Coverage Gap",
        question: "A payment processing module has 90% line coverage but a critical bug slipped to production. The bug involved an unchecked nil pointer in an error-handling branch. What type of additional tests would have caught this, and how should the team prioritize them?",
      },
    ],
    creative: [
      {
        id: "creative-divergent",
        title: "Dashboard Concept",
        question: "Design the information hierarchy for a real-time AI arbitration dashboard meant for technical operators. What should appear above the fold, and what belongs in a detail panel?",
      },
      {
        id: "creative-story",
        title: "Trust Narrative",
        question: "A B2B product makes high-stakes recommendations powered by multi-agent AI. Which communication strategy builds more trust with enterprise buyers: emphasizing the AI's accuracy metrics, or emphasizing the human-readable audit trail?",
      },
      {
        id: "creative-product",
        title: "API Design",
        question: "You are designing a public API for a multi-agent reasoning service. Should the primary interface be synchronous (request/response) or asynchronous (submit job, poll or webhook)? Argue for the better default given typical use cases.",
      },
      {
        id: "creative-brand",
        title: "Naming Convention",
        question: "An AI orchestration platform is choosing between two naming philosophies for its agent roles: neutral technical names (e.g. Agent-A, Agent-B) vs. role-based names (e.g. Advocate, Skeptic, Arbiter). Which better serves transparency and user trust?",
      },
    ],
    demo: [
      {
        id: "demo-balanced",
        title: "Result Framing",
        question: "An arbitration run reached consensus with 4 of 5 agents agreeing after two debate rounds. One agent dissented citing insufficient evidence. How should this result be summarized for a non-technical stakeholder without overstating confidence?",
      },
      {
        id: "demo-chain-ready",
        title: "Receipt Priority",
        question: "A on-chain deliberation receipt must fit key information into a compact format for public verifiability. What are the three most critical fields to include first — and why — given that the full transcript is available off-chain?",
      },
      {
        id: "demo-latency",
        title: "Cost vs. Quality",
        question: "Benchmark results show that the debate mechanism is 12% more accurate than voting but costs 3× more tokens and takes 4× longer. At what stakes or task complexity does the quality gain justify the cost?",
      },
      {
        id: "demo-confidence",
        title: "Quorum Framing",
        question: "A deliberation reached quorum at 80% agent agreement. Should the output be presented as a 'consensus decision' or a 'majority recommendation', and does the distinction matter for downstream use in automated pipelines?",
      },
    ],
  },
};

function hasUsablePromptTemplates(
  payload: BenchmarkPromptTemplatesPayload | undefined,
): payload is BenchmarkPromptTemplatesPayload {
  if (!payload || typeof payload.domains !== "object" || payload.domains === null) {
    return false;
  }

  return BENCHMARK_DOMAINS.every((domain) => Array.isArray(payload.domains[domain]));
}

// ── Chart primitives ───────────────────────────────────────────────────────────
// ChartCard, SkeletonChartBlock, injectChartKeyframes, CHART_FONT, CHART_KF_ID imported from ../components/benchmark/ChartCard

function ParetoTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: { mechanism: string; avgCostUsd: number | null; accuracy: number | null; avgTokens: number; scoredRunCount: number; frontier: boolean } }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }
  return (
    <div style={{
      background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
      borderRadius: "8px", padding: "10px 14px", boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
      minWidth: "180px",
    }}>
      <div style={{
        fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-primary)", fontWeight: 700, marginBottom: "6px",
      }}>
        {point.mechanism}
      </div>
      <div style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-secondary)", display: "grid", gap: "3px" }}>
        <span>Quality: {point.accuracy == null ? "n/a" : `${point.accuracy.toFixed(1)}%`}</span>
        <span>Avg cost: {formatUsd(point.avgCostUsd)}</span>
        <span>Avg tokens: {point.avgTokens.toLocaleString()}</span>
        <span>Scored runs: {point.scoredRunCount}</span>
        {point.frontier ? <span style={{ color: "var(--accent-emerald)" }}>Pareto frontier</span> : null}
      </div>
    </div>
  );
}

interface HeatmapTooltip {
  x: number;
  y: number;
  category: string;
  mechanism: string;
  accuracy: number | null;
  scoredRunCount: number;
  runCount: number;
  proxyRunCount: number;
}

function heatmapCellBg(accuracy: number | null, hovered: boolean): string {
  if (accuracy == null) return hovered ? "var(--bg-elevated)" : "var(--bg-subtle)";
  const base = 0.13 + (accuracy / 100) * 0.7;
  const boost = hovered ? 0.14 : 0;
  return `rgba(45, 212, 191, ${Math.min(1, base + boost).toFixed(3)})`;
}

function heatmapCellBorder(accuracy: number | null, hovered: boolean): string {
  if (accuracy == null) return hovered ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)";
  const base = 0.14 + (accuracy / 100) * 0.32;
  const boost = hovered ? 0.2 : 0;
  return `rgba(45, 212, 191, ${Math.min(1, base + boost).toFixed(3)})`;
}

function BenchmarkHeatmap({ rows }: { rows: BenchmarkHeatmapRow[] }) {
  const [tip, setTip] = useState<HeatmapTooltip | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  return (
    <div style={{ width: "100%", overflowX: "auto", position: "relative" }}>
      <div style={{ minWidth: "620px" }}>
        {/* Column headers */}
        <div style={{ display: "grid", gridTemplateColumns: "120px repeat(3, minmax(0, 1fr))", gap: "8px", marginBottom: "8px" }}>
          <div />
          {["Debate", "Vote", "Selector"].map((label) => (
            <div key={label} style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)", textAlign: "center" }}>
              {label}
            </div>
          ))}
        </div>

        {/* Rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
          {rows.map((row, rowIdx) => (
            <div key={row.category} style={{ display: "grid", gridTemplateColumns: "120px repeat(3, minmax(0, 1fr))", gap: "8px", alignItems: "stretch" }}>
              <div style={{ display: "flex", alignItems: "center", fontFamily: CHART_FONT, fontSize: "11px", color: "var(--text-secondary)" }}>
                {row.category}
              </div>
              {row.cells.map((cell, colIdx) => {
                const key = `${row.category}-${cell.mechanism}`;
                const hov = hoveredKey === key;
                return (
                  <div
                    key={key}
                    style={{
                      minHeight: "68px", borderRadius: "10px",
                      border: `1px solid ${heatmapCellBorder(cell.accuracy, hov)}`,
                      background: heatmapCellBg(cell.accuracy, hov),
                      padding: "10px 12px",
                      display: "flex", flexDirection: "column", justifyContent: "space-between",
                      cursor: "default",
                      transition: "background 0.18s ease, border-color 0.18s ease, transform 0.15s ease, box-shadow 0.15s ease",
                      transform: hov ? "translateY(-1px)" : "translateY(0)",
                      boxShadow: hov && cell.accuracy != null ? "0 4px 14px rgba(45,212,191,0.18)" : "none",
                      animationName: "hm-fade-in",
                      animationDuration: "0.35s",
                      animationFillMode: "both",
                      animationDelay: `${(rowIdx * 3 + colIdx) * 0.04}s`,
                    } as React.CSSProperties}
                    onMouseEnter={(e) => {
                      setHoveredKey(key);
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTip({ x: rect.left + rect.width / 2, y: rect.top, category: row.category, mechanism: cell.mechanism, accuracy: cell.accuracy, scoredRunCount: cell.scoredRunCount, runCount: cell.runCount, proxyRunCount: cell.proxyRunCount });
                    }}
                    onMouseLeave={() => { setHoveredKey(null); setTip(null); }}
                  >
                    <span style={{ fontFamily: CHART_FONT, fontSize: "16px", color: cell.accuracy == null ? "var(--text-muted)" : "var(--text-primary)", fontWeight: 700 }}>
                      {cell.accuracy == null ? "—" : `${Math.round(cell.accuracy)}%`}
                    </span>
                    <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-tertiary)" }}>
                      {cell.runCount > 0 ? `n=${cell.scoredRunCount}` : "No data"}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Legend — slim */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "12px" }}>
          <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-tertiary)" }}>0%</span>
          <div style={{ flex: 1, maxWidth: "120px", height: "6px", borderRadius: "999px", background: "linear-gradient(90deg, rgba(45,212,191,0.13) 0%, rgba(45,212,191,0.83) 100%)", border: "1px solid rgba(45,212,191,0.15)" }} />
          <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-tertiary)" }}>100%</span>
        </div>
      </div>

      {/* Tooltip */}
      {tip && (
        <div style={{
          position: "fixed", left: tip.x, top: tip.y - 10,
          transform: "translate(-50%, -100%)",
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "8px", padding: "9px 13px", boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          pointerEvents: "none", zIndex: 9999, minWidth: "160px",
        }}>
          <div style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--accent-emerald)", fontWeight: 700, marginBottom: "5px" }}>
            {tip.category} · {tip.mechanism}
          </div>
          <div style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: "2px" }}>
            <span>Accuracy: {tip.accuracy == null ? "n/a" : `${Math.round(tip.accuracy)}%`}</span>
            <span>Scored runs: {tip.scoredRunCount} / {tip.runCount}</span>
            {tip.proxyRunCount > 0 && <span style={{ color: "var(--accent-amber)" }}>{tip.proxyRunCount} proxy-scored</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label, count, countColor }: { label: string; count: number; countColor?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
      <span style={{
        fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.12em",
        textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.08em",
        padding: "1px 8px", borderRadius: "10px",
        background: countColor ? `${countColor}1a` : "var(--bg-subtle)",
        color: countColor ?? "var(--text-tertiary)",
        border: `1px solid ${countColor ? `${countColor}44` : "var(--border-default)"}`,
      }}>
        {count}
      </span>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function Benchmarks() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [overviewMode, setOverviewMode] = useState<BenchmarkOverviewMode>("latest");
  const benchmarkOverviewQuery = useBenchmarkOverviewQuery(true, overviewMode);
  const benchmarkCatalogQuery = useBenchmarkCatalogQuery(100);
  const benchmarkPromptTemplatesQuery = useBenchmarkPromptTemplatesQuery();
  const runtimeConfigQuery = useDeliberationRuntimeConfigQuery();
  const triggerBenchmarkMutation = useTriggerBenchmarkMutation();
  const benchmarks = benchmarkOverviewQuery.data ?? null;
  const catalog = benchmarkCatalogQuery.data ?? null;
  const runtimeConfig = runtimeConfigQuery.data;
  const templates = hasUsablePromptTemplates(benchmarkPromptTemplatesQuery.data)
    ? benchmarkPromptTemplatesQuery.data
    : FALLBACK_PROMPT_TEMPLATES;

  const [runError, setRunError] = useState<string | null>(null);
  const [chartsReady, setChartsReady] = useState(false);
  const [yourSortMode, setYourSortMode] = useState<CatalogSortMode>("recent");
  const [globalSortMode, setGlobalSortMode] = useState<CatalogSortMode>("recent");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardDomain, setWizardDomain] = useState<BenchmarkDomainName>("math");
  const [benchmarkAgentCount, setBenchmarkAgentCount] = useState(4);
  const [trainingPerCategory, setTrainingPerCategory] = useState(1);
  const [holdoutPerCategory, setHoldoutPerCategory] = useState(1);
  const [reasoningPresets, setReasoningPresets] = useState<ReasoningPresetState>(
    DEFAULT_REASONING_PRESETS,
  );
  const [tierModelOverrides, setTierModelOverrides] = useState<TierModelOverrideState>({});
  const [runtimeDefaultsHydrated, setRuntimeDefaultsHydrated] = useState(false);
  const [domainPromptSelection, setDomainPromptSelection] = useState<
    Partial<Record<BenchmarkDomainName, DomainPromptSelection>>
  >({});

  useEffect(() => { injectChartKeyframes(); }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!runtimeConfig || runtimeDefaultsHydrated) {
      return;
    }
    setReasoningPresets(resolveDefaultReasoningPresets(runtimeConfig));
    setRuntimeDefaultsHydrated(true);
  }, [runtimeConfig, runtimeDefaultsHydrated]);

  const finalizeDomainSelection = useCallback(
    (
      domain: BenchmarkDomainName,
      selection: DomainPromptSelection,
      templatePayload: BenchmarkPromptTemplatesPayload = templates,
    ): DomainPromptSelection => {
      const templatesForDomain = templatePayload.domains[domain] ?? [];
      const matchedTemplate = selection.templateId
        ? templatesForDomain.find((template) => template.id === selection.templateId) ?? null
        : null;
      const fallbackTemplate = templatesForDomain[0] ?? null;
      const resolvedTemplate = matchedTemplate ?? fallbackTemplate;
      const customQuestion = normalizeText(selection.customQuestion);
      const templateQuestion = normalizeText(resolvedTemplate?.question);
      const resolvedQuestion = selection.useCustomPrompt
        ? (customQuestion || templateQuestion)
        : (normalizeText(selection.question) || templateQuestion || customQuestion);

      return {
        templateId: resolvedTemplate?.id ?? selection.templateId ?? null,
        templateTitle: resolvedTemplate?.title ?? selection.templateTitle ?? null,
        question: resolvedQuestion,
        useCustomPrompt: selection.useCustomPrompt,
        customQuestion: selection.customQuestion,
      };
    },
    [templates],
  );

  const createDefaultDomainSelection = useCallback(
    (domain: BenchmarkDomainName, templatePayload: BenchmarkPromptTemplatesPayload): DomainPromptSelection => {
      const templatesForDomain = templatePayload.domains[domain] ?? [];
      const template = templatesForDomain[0] ?? null;
      return {
        templateId: template?.id ?? null,
        templateTitle: template?.title ?? null,
        question: normalizeText(template?.question),
        useCustomPrompt: false,
        customQuestion: "",
      };
    },
    [],
  );

  const syncDomainPromptSelection = useCallback(
    (templatePayload: BenchmarkPromptTemplatesPayload, forceReset = false) => {
      setDomainPromptSelection((current) => {
        const nextState: Partial<Record<BenchmarkDomainName, DomainPromptSelection>> = {};
        for (const domain of BENCHMARK_DOMAINS) {
          const existing = forceReset ? undefined : current[domain];
          const baseSelection = existing ?? createDefaultDomainSelection(domain, templatePayload);
          nextState[domain] = finalizeDomainSelection(domain, baseSelection, templatePayload);
        }
        return nextState;
      });
    },
    [createDefaultDomainSelection, finalizeDomainSelection],
  );

  const overviewError = !benchmarks && benchmarkOverviewQuery.error instanceof Error
    ? benchmarkOverviewQuery.error.message
    : null;
  const catalogError = !catalog && benchmarkCatalogQuery.error instanceof Error
    ? benchmarkCatalogQuery.error.message
    : null;

  const normalizedSummary = useMemo<NormalizedSummary>(
    () => normalizeBenchmarkSummary(benchmarks?.summary, benchmarks),
    [benchmarks],
  );
  const benchmarkArtifactKind = useMemo(
    () => detectBenchmarkArtifactKind(benchmarks),
    [benchmarks],
  );
  const aggregateArtifactCount = useMemo(
    () => Number((benchmarks as Record<string, unknown> | null)?.aggregated_artifact_count ?? 0),
    [benchmarks],
  );
  const aggregationWindow = useMemo(
    () => String((benchmarks as Record<string, unknown> | null)?.aggregation_window ?? "latest"),
    [benchmarks],
  );

  const overviewHeatmapRows = useMemo(
    () => buildOverviewHeatmapRows(normalizedSummary),
    [normalizedSummary],
  );

  const learningCurveState = useMemo(() => buildOverviewLearningCurve(benchmarks), [benchmarks]);

  const paretoData = useMemo(() => buildOverviewParetoData(normalizedSummary), [normalizedSummary]);

  const yourEntries = useMemo(() => {
    if (!catalog) {
      return [];
    }
    return (yourSortMode === "recent" ? catalog.user_recent : catalog.user_frequency).slice(0, 3);
  }, [catalog, yourSortMode]);

  const inProgressBenchmarkRuns = useMemo(() => {
    const catalogRuns = catalog
      ? (yourSortMode === "recent" ? catalog.user_tests_recent : catalog.user_tests_frequency)
      : [];

    return catalogRuns
      .filter((run) => run.status === "queued" || run.status === "running")
      .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
      .slice(0, 3);
  }, [catalog, yourSortMode]);

  const failedBenchmarkRuns = useMemo(() => {
    if (!catalog) {
      return [];
    }
    const runs = yourSortMode === "recent" ? catalog.user_tests_recent : catalog.user_tests_frequency;
    return runs.filter((run) => run.status === "failed").slice(0, 3);
  }, [catalog, yourSortMode]);

  const featuredBenchmarkRun = useMemo<BenchmarkRunStatusPayload | null>(() => {
    return inProgressBenchmarkRuns[0] ?? failedBenchmarkRuns[0] ?? null;
  }, [failedBenchmarkRuns, inProgressBenchmarkRuns]);

  const globalEntries = useMemo(() => {
    if (!catalog) {
      return [];
    }
    return (globalSortMode === "recent" ? catalog.global_recent : catalog.global_frequency).slice(0, 3);
  }, [catalog, globalSortMode]);

  const runPayloadPreview = useMemo(() => {
    const domainPrompts: NonNullable<BenchmarkRunRequestPayload["domain_prompts"]> = {};
    for (const domain of BENCHMARK_DOMAINS) {
      const selection = domainPromptSelection[domain];
      if (!selection) {
        continue;
      }
      const question = normalizeText(selection.question);
      if (!question) {
        continue;
      }
      domainPrompts[domain] = {
        template_id: selection.templateId ?? null,
        question,
        source: selection.useCustomPrompt ? "custom" : "template",
      };
    }

    const payload: BenchmarkRunRequestPayload = {
      training_per_category: trainingPerCategory,
      holdout_per_category: holdoutPerCategory,
      agent_count: benchmarkAgentCount,
      live_agents: true,
      domain_prompts: domainPrompts,
      reasoning_presets: reasoningPresets,
      tier_model_overrides: buildTierModelOverridesPayload(tierModelOverrides, runtimeConfig),
    };

    return payload;
  }, [
    benchmarkAgentCount,
    domainPromptSelection,
    holdoutPerCategory,
    reasoningPresets,
    runtimeConfig,
    tierModelOverrides,
    trainingPerCategory,
  ]);

  const benchmarkVoteRoster = useMemo(
    () => buildVoteRoster(benchmarkAgentCount, reasoningPresets, runtimeConfig, tierModelOverrides),
    [benchmarkAgentCount, reasoningPresets, runtimeConfig, tierModelOverrides],
  );
  const benchmarkDebateRoster = useMemo(
    () => buildDebateRoster(benchmarkAgentCount, reasoningPresets, runtimeConfig, tierModelOverrides),
    [benchmarkAgentCount, reasoningPresets, runtimeConfig, tierModelOverrides],
  );
  const benchmarkCountBadges = useMemo(
    () => buildProviderCountBadges(benchmarkAgentCount, runtimeConfig, tierModelOverrides),
    [benchmarkAgentCount, runtimeConfig, tierModelOverrides],
  );
  const benchmarkEnsembleLabel = useMemo(
    () => getBalancedEnsembleLabel(benchmarkAgentCount, runtimeConfig),
    [benchmarkAgentCount, runtimeConfig],
  );
  const benchmarkDebateFooter = useMemo(
    () => getDebateSpecialistSummary(runtimeConfig, tierModelOverrides),
    [runtimeConfig, tierModelOverrides],
  );

  const openWizard = () => {
    syncDomainPromptSelection(templates);
    setWizardDomain("math");
    setRunError(null);
    setWizardOpen(true);
  };

  const closeWizard = () => {
    setWizardOpen(false);
  };

  const handleTriggerBenchmark = useCallback(async () => {
    try {
      setRunError(null);
      const run = await triggerBenchmarkMutation.mutateAsync(runPayloadPreview);
      seedTriggeredBenchmarkRunCache(queryClient, run);
      void queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.overviewAll() });
      void queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.catalogAll() });
      closeWizard();
      navigate(`/benchmarks/${run.run_id}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Unable to start benchmark run right now.");
    }
  }, [navigate, queryClient, runPayloadPreview, triggerBenchmarkMutation]);

  const updateDomainSelection = (
    domain: BenchmarkDomainName,
    updater: (current: DomainPromptSelection) => DomainPromptSelection,
  ) => {
    setDomainPromptSelection((current) => {
      const existing = current[domain] ?? createDefaultDomainSelection(domain, templates);
      const nextSelection = updater(existing);
      return {
        ...current,
        [domain]: finalizeDomainSelection(domain, nextSelection),
      };
    });
  };

  const domainStatus = useMemo(() => {
    const state: Record<BenchmarkDomainName, { complete: boolean; label: string }> = {
      math: { complete: false, label: "Not set" },
      factual: { complete: false, label: "Not set" },
      reasoning: { complete: false, label: "Not set" },
      code: { complete: false, label: "Not set" },
      creative: { complete: false, label: "Not set" },
      demo: { complete: false, label: "Not set" },
    };

    for (const domain of BENCHMARK_DOMAINS) {
      const selection = domainPromptSelection[domain];
      if (!selection) {
        continue;
      }
      const question = normalizeText(selection.question);
      state[domain] = {
        complete: question.length > 0,
        label: selection.useCustomPrompt
          ? (question.length > 0 ? "Custom question" : "Needs question")
          : (selection.templateTitle ?? "Select question"),
      };
    }
    return state;
  }, [domainPromptSelection]);

  const allDomainsConfigured = BENCHMARK_DOMAINS.every((domain) => domainStatus[domain].complete);

  return (
    <>
      <title>Benchmarks — Agora</title>
      <meta
        name="description"
        content="Performance dashboard for Agora's deliberation mechanisms — accuracy, latency, and cost across reasoning tasks."
      />
      <div className="max-w-250 mx-auto pb-20 w-full">
        <header className="mb-10">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
              <p className="text-text-secondary text-lg max-w-150">
                Comparison, ablation, and learning metrics generated from the Phase 2 benchmark suite.
              </p>
            </div>
            <div style={{ flexShrink: 0, paddingTop: "6px" }}>
              <ModeDropdown value={overviewMode} onChange={setOverviewMode} />
            </div>
          </div>
          {overviewMode !== "latest" ? (
            <div
              style={{
                marginTop: "14px",
                border: "1px solid rgba(52,211,153,0.2)",
                background: "rgba(52,211,153,0.06)",
                borderRadius: "10px",
                padding: "10px 12px",
                fontFamily: "'Hanken Grotesk', sans-serif",
                fontSize: "12px",
                color: "var(--text-secondary)",
                maxWidth: "760px",
              }}
            >
              Aggregating across <span style={{ color: "var(--accent-emerald)" }}>{aggregateArtifactCount || "..."}</span> compatible completed benchmarks
              {aggregationWindow === "all" ? " from the whole catalog." : " from the most recent 20 saved artifacts."}
            </div>
          ) : null}
        </header>

        {/* ── Charts ──────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8 w-full">
          {/* Accuracy by category — full width */}
          <div className="col-span-1 lg:col-span-2">
            <ChartCard
              title="Scored Success Heatmap"
              subtitle="Executed mechanism success by category, with explicit sample counts. Creative and demo are proxy-scored; one-sample buckets are directional, not proof."
            >
              {overviewError ? (
                <div style={{ padding: "32px 0", fontFamily: CHART_FONT, fontSize: "11px", color: "var(--accent-rose)" }}>
                  {overviewError}
                </div>
              ) : !benchmarks ? (
                <div style={{ width: "100%" }}>
                  {/* Grid skeleton mimicking heatmap structure */}
                  <div style={{ display: "grid", gridTemplateColumns: "120px repeat(3, minmax(0, 1fr))", gap: "8px", marginBottom: "8px" }}>
                    <div />
                    {[0, 1, 2].map((i) => (
                      <ShimBlock key={i} w="100%" h="14px" style={{ borderRadius: "4px" }} />
                    ))}
                  </div>
                  {[0, 1, 2, 3, 4, 5].map((rowI) => (
                    <div key={rowI} style={{ display: "grid", gridTemplateColumns: "120px repeat(3, minmax(0, 1fr))", gap: "8px", marginBottom: "7px" }}>
                      <ShimBlock w="80px" h="14px" style={{ alignSelf: "center" }} />
                      {[0, 1, 2].map((colI) => (
                        <ShimBlock key={colI} w="100%" h="68px" style={{ borderRadius: "10px", animationDelay: `${(rowI * 3 + colI) * 0.06}s` }} />
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="w-full">
                  {chartsReady && <BenchmarkHeatmap rows={overviewHeatmapRows} />}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Learning curve */}
          <ChartCard
            title="Selector Learning Curve"
            subtitle={
              benchmarkArtifactKind === "validation"
                ? "Scored selector-stage success before and after the bandit learning phase."
                : "Only validation artifacts with explicit pre/post stages can populate this curve honestly."
            }
          >
            {!benchmarks && !overviewError ? (
              <SkeletonChartBlock h="220px" delay={0.1} />
            ) : learningCurveState.reason ? (
              <div className="w-full h-55 rounded-md border border-border-subtle bg-void px-4 py-5 flex items-center justify-center text-center text-sm text-text-secondary">
                {learningCurveState.reason}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {/* Main before → after display */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0", padding: "20px 0 8px" }}>
                  {/* Pre */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", flex: 1 }}>
                    <span style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>Pre-learning</span>
                    <span style={{ fontFamily: CHART_FONT, fontSize: "38px", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1 }}>
                      {learningCurveState.preAccuracy == null ? "—" : `${Math.round(learningCurveState.preAccuracy)}%`}
                    </span>
                    <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-muted)" }}>
                      n={learningCurveState.preScoredRunCount}
                    </span>
                  </div>

                  {/* Arrow + delta */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", padding: "0 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div style={{ width: "40px", height: "1px", background: "var(--border-strong)" }} />
                      <div style={{ width: 0, height: 0, borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: `6px solid var(--border-strong)` }} />
                    </div>
                    <span style={{
                      fontFamily: CHART_FONT, fontSize: "12px", fontWeight: 700,
                      color: learningCurveState.delta == null ? "var(--text-muted)"
                        : learningCurveState.delta > 0 ? "var(--accent-emerald)"
                        : learningCurveState.delta < 0 ? "var(--accent-rose)"
                        : "var(--text-muted)",
                    }}>
                      {learningCurveState.delta == null ? "n/a"
                        : learningCurveState.delta > 0 ? `+${learningCurveState.delta.toFixed(1)}pp`
                        : `${learningCurveState.delta.toFixed(1)}pp`}
                    </span>
                  </div>

                  {/* Post */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", flex: 1 }}>
                    <span style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>Post-learning</span>
                    <span style={{ fontFamily: CHART_FONT, fontSize: "38px", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1 }}>
                      {learningCurveState.postAccuracy == null ? "—" : `${Math.round(learningCurveState.postAccuracy)}%`}
                    </span>
                    <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-muted)" }}>
                      n={learningCurveState.postScoredRunCount}
                    </span>
                  </div>
                </div>

                {/* Status badge */}
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <span style={{
                    fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.08em", textTransform: "uppercase",
                    padding: "3px 10px", borderRadius: "20px",
                    background: learningCurveState.saturated ? "rgba(251,191,36,0.1)" : "rgba(52,211,153,0.1)",
                    border: `1px solid ${learningCurveState.saturated ? "rgba(251,191,36,0.3)" : "rgba(52,211,153,0.3)"}`,
                    color: learningCurveState.saturated ? "var(--accent-amber)" : "var(--accent-emerald)",
                  }}>
                    {learningCurveState.saturated ? "Saturated — 100% pre-learning" : "Measured lift"}
                  </span>
                </div>

                {/* Visual progress bars */}
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "4px 0 2px" }}>
                  {[
                    { label: "Pre", value: learningCurveState.preAccuracy, color: "var(--text-muted)" },
                    { label: "Post", value: learningCurveState.postAccuracy, color: "var(--accent-emerald)" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-tertiary)", width: "26px", flexShrink: 0 }}>{label}</span>
                      <div style={{ flex: 1, height: "6px", background: "var(--bg-subtle)", borderRadius: "3px", overflow: "hidden" }}>
                        <div style={{ width: `${value ?? 0}%`, height: "100%", background: color, borderRadius: "3px", transition: "width 0.8s ease" }} />
                      </div>
                      <span style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-tertiary)", width: "32px", textAlign: "right", flexShrink: 0 }}>
                        {value == null ? "—" : `${Math.round(value)}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ChartCard>

          {/* Cost efficiency */}
          <ChartCard
            title="Cost vs Quality Frontier"
            subtitle="Average cost against scored success per mechanism. Frontier points (emerald) are not dominated on both axes. Hover for details."
          >
            {!benchmarks && !overviewError ? (
              <SkeletonChartBlock h="250px" delay={0.2} />
            ) : paretoData.length === 0 ? (
              <div className="w-full h-62.5 rounded-md border border-border-subtle bg-void px-4 py-5 flex items-center justify-center text-center text-sm text-text-secondary">
                This artifact does not yet have enough scored mechanism coverage to plot a cost/quality frontier honestly.
              </div>
            ) : (
              <div className="w-full h-62.5">
                {chartsReady && benchmarks && (
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 16, right: 20, left: 0, bottom: 28 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
                      <XAxis
                        type="number"
                        dataKey="avgCostUsd"
                        stroke="transparent"
                        tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                        tickFormatter={(v) => `$${Number(v).toFixed(3)}`}
                        label={{ value: "Avg cost / run", position: "insideBottom", offset: -14, style: { fontFamily: CHART_FONT, fontSize: "9px", fill: "var(--text-tertiary)", letterSpacing: "0.06em" } }}
                      />
                      <YAxis
                        type="number"
                        dataKey="accuracy"
                        stroke="transparent"
                        tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                        domain={[0, 100]}
                        tickFormatter={(v) => `${v}%`}
                        label={{ value: "Accuracy", angle: -90, position: "insideLeft", offset: 14, style: { fontFamily: CHART_FONT, fontSize: "9px", fill: "var(--text-tertiary)", letterSpacing: "0.06em" } }}
                      />
                      <ZAxis dataKey="scoredRunCount" range={[80, 200]} />
                      <Tooltip
                        content={(props) => <ParetoTooltip active={props.active} payload={props.payload as any} />}
                        cursor={{ fill: "rgba(255,255,255,0.025)" }}
                      />
                      <Scatter
                        data={paretoData}
                        shape={(props: any) => {
                          const { cx, cy, payload } = props;
                          if (payload.frontier) {
                            return (
                              <g>
                                <circle cx={cx} cy={cy} r={13} fill="rgba(52,211,153,0.1)" stroke="rgba(52,211,153,0.3)" strokeWidth={1} />
                                <circle cx={cx} cy={cy} r={7} fill="var(--accent-emerald)" stroke="rgba(52,211,153,0.9)" strokeWidth={1.5} />
                              </g>
                            );
                          }
                          return (
                            <circle cx={cx} cy={cy} r={5} fill="rgba(148,163,184,0.25)" stroke="rgba(148,163,184,0.5)" strokeWidth={1.5} />
                          );
                        }}
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}
            {/* Legend */}
            {paretoData.length > 0 && (
              <div style={{ display: "flex", gap: "16px", marginTop: "10px" }}>
                {[
                  { color: "var(--accent-emerald)", label: "Frontier" },
                  { color: "rgba(148,163,184,0.5)", label: "Dominated" },
                ].map(({ color, label }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
                    <span style={{ fontFamily: CHART_FONT, fontSize: "8px", color: "var(--text-tertiary)" }}>{label}</span>
                  </div>
                ))}
              </div>
            )}
          </ChartCard>
        </div>

        {/* ── Analytics CTA ───────────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
          <Link
            to="/benchmarks/analytics"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              padding: "10px 48px",
              borderRadius: "10px",
              border: "1px solid var(--border-default)",
              background: "var(--bg-subtle)",
              textDecoration: "none",
              transition: "border-color 0.15s, background 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.background = "var(--bg-elevated)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.background = "var(--bg-subtle)"; }}
          >
            <span style={{ fontFamily: CHART_FONT, fontSize: "10px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-secondary)" }}>
              View Analytics
            </span>
          </Link>
        </div>

        {/* ── Run CTA ─────────────────────────────────────────────────────── */}
        <div className="card p-4 sm:p-8 mb-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
            <div>
              <h3 className="mb-2 text-lg font-semibold">Run Benchmarks End-to-End</h3>
              <p className="text-sm text-text-secondary max-w-150">
                Configure benchmark questions per domain, trigger a run, and persist rich artifacts in global and user-specific cloud paths.
              </p>
            </div>
            <button type="button" className="btn-primary" onClick={openWizard}>
              Configure and Run
            </button>
          </div>

          {featuredBenchmarkRun && (
            <div style={{ marginTop: "4px" }}>
              {featuredBenchmarkRun.status === "failed" ? (
                <FailedRunRow
                  run={featuredBenchmarkRun}
                  onOpen={() => navigate(`/benchmarks/${featuredBenchmarkRun.run_id}`)}
                />
              ) : (
                <LiveRunRow
                  run={featuredBenchmarkRun}
                  onOpen={() => navigate(`/benchmarks/${featuredBenchmarkRun.run_id}`)}
                />
              )}
            </div>
          )}

          {!catalog && !featuredBenchmarkRun && (
            <SkeletonRunRow />
          )}

          {runError && (
            <div style={{
              fontFamily: CHART_FONT, fontSize: "11px", color: "var(--accent-rose)",
              marginTop: "10px", padding: "8px 12px", borderRadius: "8px",
              background: "var(--accent-rose-soft)", border: "1px solid rgba(248,113,113,0.3)",
            }}>
              {runError}
            </div>
          )}
        </div>

        {/* ── Your Benchmarks ──────────────────────────────────────────────── */}
        <div className="card p-4 sm:p-6 mb-6">
          <div className="flex items-center justify-between gap-3 mb-5">
            <h3 className="text-lg font-semibold">Your Benchmarks</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void benchmarkCatalogQuery.refetch()}
                title="Refresh"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "2px", display: "flex", alignItems: "center" }}
              >
                <RotateCcw size={13} style={{ animation: benchmarkCatalogQuery.isFetching ? "bm-spin 0.8s linear infinite" : "none" }} />
              </button>
              <FilterButton value={yourSortMode} onChange={setYourSortMode} />
              <button
                type="button"
                onClick={() => navigate("/benchmarks/all")}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "5px",
                  fontFamily: CHART_FONT, fontSize: "10px", letterSpacing: "0.05em",
                  padding: "5px 10px", borderRadius: "7px",
                  border: "1px solid var(--border-default)",
                  background: "var(--bg-base)",
                  color: "var(--text-secondary)", cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.background = "var(--bg-subtle)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.background = "var(--bg-base)"; }}
              >
                View all
              </button>
            </div>
          </div>

          {catalogError ? (
            <p className="text-sm text-text-secondary">{catalogError}</p>
          ) : !catalog ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <SkeletonRunRow delay={0} />
              <SkeletonRunRow delay={0.08} />
              <SkeletonRunRow delay={0.16} />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              {inProgressBenchmarkRuns.length > 0 && (
                <div>
                  <SectionHeader label="Live Runs" count={inProgressBenchmarkRuns.length} countColor="var(--accent-emerald)" />
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {inProgressBenchmarkRuns.map((run) => (
                      <LiveRunRow
                        key={run.run_id}
                        run={run}
                        onOpen={() => navigate(`/benchmarks/${run.run_id}`)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {yourEntries.length > 0 ? (
                <div>
                  {inProgressBenchmarkRuns.length > 0 && (
                    <div style={{ height: "1px", background: "var(--border-default)", marginBottom: "20px" }} />
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {yourEntries.map((entry) => (
                      <CatalogRunRow
                        key={entry.artifact_id}
                        entry={entry}
                        onOpen={() => navigate(`/benchmarks/${entry.artifact_id}`)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                inProgressBenchmarkRuns.length === 0 && (
                  <p className="text-sm text-text-secondary">No user benchmark artifacts yet.</p>
                )
              )}

              {failedBenchmarkRuns.length > 0 && (
                <div>
                  <div style={{ height: "1px", background: "var(--border-default)", marginBottom: "20px" }} />
                  <SectionHeader label="Failed Runs" count={failedBenchmarkRuns.length} countColor="var(--accent-rose)" />
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {failedBenchmarkRuns.map((run) => (
                      <FailedRunRow
                        key={run.run_id}
                        run={run}
                        onOpen={() => navigate(`/benchmarks/${run.run_id}`)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>

        {/* ── Global Benchmarks ────────────────────────────────────────────── */}
        <div className="card p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3 mb-5">
            <h3 className="text-lg font-semibold">Global Benchmarks</h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void benchmarkCatalogQuery.refetch()}
                title="Refresh"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "2px", display: "flex", alignItems: "center" }}
              >
                <RotateCcw size={13} style={{ animation: benchmarkCatalogQuery.isFetching ? "bm-spin 0.8s linear infinite" : "none" }} />
              </button>
              <FilterButton value={globalSortMode} onChange={setGlobalSortMode} />
              <button
                type="button"
                onClick={() => navigate("/benchmarks/all")}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "5px",
                  fontFamily: CHART_FONT, fontSize: "10px", letterSpacing: "0.05em",
                  padding: "5px 10px", borderRadius: "7px",
                  border: "1px solid var(--border-default)",
                  background: "var(--bg-base)",
                  color: "var(--text-secondary)", cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.background = "var(--bg-subtle)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.background = "var(--bg-base)"; }}
              >
                View all
              </button>
            </div>
          </div>

          {catalogError ? (
            <p className="text-sm text-text-secondary">{catalogError}</p>
          ) : !catalog ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <SkeletonRunRow delay={0} />
              <SkeletonRunRow delay={0.08} />
              <SkeletonRunRow delay={0.16} />
            </div>
          ) : globalEntries.length === 0 ? (
            <p className="text-sm text-text-secondary">No global benchmark artifacts yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {globalEntries.map((entry) => (
                <CatalogRunRow
                  key={entry.artifact_id}
                  entry={entry}
                  onOpen={() => navigate(`/benchmarks/${entry.artifact_id}`)}
                />
              ))}
            </div>
          )}

        </div>
      </div>

      {/* ── Wizard ────────────────────────────────────────────────────────── */}
      {wizardOpen ? (
        <BenchmarkWizard
          open={wizardOpen}
          onClose={closeWizard}
          agentCount={benchmarkAgentCount}
          onAgentCountChange={setBenchmarkAgentCount}
          trainingPerCategory={trainingPerCategory}
          onTrainingChange={setTrainingPerCategory}
          holdoutPerCategory={holdoutPerCategory}
          onHoldoutChange={setHoldoutPerCategory}
          reasoningPresets={reasoningPresets}
          onPresetsChange={setReasoningPresets}
          runtimeConfig={runtimeConfig}
          tierModelOverrides={tierModelOverrides}
          onTierModelOverridesChange={setTierModelOverrides}
          voteRoster={benchmarkVoteRoster}
          debateRoster={benchmarkDebateRoster}
          countBadges={benchmarkCountBadges}
          ensembleLabel={benchmarkEnsembleLabel}
          debateFooter={benchmarkDebateFooter}
          activeDomain={wizardDomain}
          onDomainChange={setWizardDomain}
          templates={templates}
          domainPromptSelection={domainPromptSelection}
          onDomainUpdate={updateDomainSelection}
          domainStatus={domainStatus}
          allDomainsConfigured={allDomainsConfigured}
          isSubmitting={triggerBenchmarkMutation.isPending}
          onSubmit={() => { void handleTriggerBenchmark(); }}
          submitError={runError}
        />
      ) : null}
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

const MODE_LABELS: Record<BenchmarkOverviewMode, string> = {
  latest: "Latest",
  aggregate_recent: "Aggregate 20",
  aggregate_all: "Whole Catalog",
};

function ModeDropdown({ value, onChange }: { value: BenchmarkOverviewMode; onChange: (v: BenchmarkOverviewMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const visibleOptions: BenchmarkOverviewMode[] = value === "aggregate_recent"
    ? ["latest", "aggregate_recent", "aggregate_all"]
    : ["latest", "aggregate_recent"];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          fontFamily: CHART_FONT, fontSize: "10px", letterSpacing: "0.05em",
          padding: "5px 10px", borderRadius: "7px",
          border: `1px solid ${open ? "var(--border-strong)" : "var(--border-default)"}`,
          background: open ? "var(--bg-subtle)" : "var(--bg-base)",
          color: "var(--text-secondary)", cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <Filter size={11} />
        {MODE_LABELS[value]}
        <ChevronDown
          size={11}
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease" }}
        />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "8px", overflow: "hidden", minWidth: "140px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {visibleOptions.map((option, i) => (
            <button
              key={option}
              type="button"
              onClick={() => { onChange(option); setOpen(false); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "9px 13px",
                fontFamily: CHART_FONT, fontSize: "11px",
                color: value === option ? "var(--accent-emerald)" : "var(--text-secondary)",
                background: value === option ? "var(--accent-emerald-soft)" : "transparent",
                border: "none",
                borderBottom: i < visibleOptions.length - 1 ? "1px solid var(--border-default)" : "none",
                cursor: "pointer",
                transition: "background 0.1s ease",
              }}
            >
              {MODE_LABELS[option]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterButton({ value, onChange }: { value: CatalogSortMode; onChange: (value: CatalogSortMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          fontFamily: CHART_FONT, fontSize: "10px", letterSpacing: "0.05em",
          padding: "5px 10px", borderRadius: "7px",
          border: `1px solid ${open ? "var(--border-strong)" : "var(--border-default)"}`,
          background: open ? "var(--bg-subtle)" : "var(--bg-base)",
          color: "var(--text-secondary)", cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <Filter size={11} />
        {titleCase(value)}
        <ChevronDown
          size={11}
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease" }}
        />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "8px", overflow: "hidden", minWidth: "130px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {(["recent", "frequency"] as CatalogSortMode[]).map((option, i) => (
            <button
              key={option}
              type="button"
              onClick={() => { onChange(option); setOpen(false); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "9px 13px",
                fontFamily: CHART_FONT, fontSize: "11px",
                color: value === option ? "var(--accent-emerald)" : "var(--text-secondary)",
                background: value === option ? "var(--accent-emerald-soft)" : "transparent",
                border: "none",
                borderBottom: i === 0 ? "1px solid var(--border-default)" : "none",
                cursor: "pointer",
                transition: "background 0.1s ease",
              }}
            >
              {titleCase(option)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Data helpers ───────────────────────────────────────────────────────────────

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  return `$${value.toFixed(6)}`;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
