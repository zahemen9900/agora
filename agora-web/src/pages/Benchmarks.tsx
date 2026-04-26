import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChevronDown, Filter, RotateCcw } from "lucide-react";

import { BenchmarkWizard, type DomainPromptSelection } from "../components/benchmark/BenchmarkWizard";
import { CatalogRunRow, FailedRunRow, LiveRunRow, SkeletonRunRow } from "../components/benchmark/BenchmarkRunRow";
import {
  type BenchmarkDomainName,
  type BenchmarkPromptTemplatesPayload,
  type BenchmarkRunRequestPayload,
  type BenchmarkRunStatusPayload,
} from "../lib/api";
import {
  benchmarkQueryKeys,
  seedTriggeredBenchmarkRunCache,
  useBenchmarkCatalogQuery,
  useBenchmarkOverviewQuery,
  useBenchmarkPromptTemplatesQuery,
  useTriggerBenchmarkMutation,
} from "../lib/benchmarkQueries";
import {
  BENCHMARK_DOMAIN_KEYS,
  buildOverviewAccuracyData,
  buildOverviewLearningCurve,
  detectBenchmarkArtifactKind,
  normalizeBenchmarkSummary,
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
const BENCHMARK_MECHANISMS = ["debate", "vote", "selector"] as const;
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

const CHART_KF_ID = "bm-chart-kf";
const CHART_FONT = "'Commit Mono', 'SF Mono', monospace";

function injectChartKeyframes() {
  if (document.getElementById(CHART_KF_ID)) return;
  const s = document.createElement("style");
  s.id = CHART_KF_ID;
  s.textContent = `@keyframes bm-shimmer { 0% { background-position: -600px 0; } 100% { background-position: 600px 0; } } @keyframes bm-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(s);
}

function SkeletonChartBlock({ h, delay = 0 }: { h: string; delay?: number }) {
  return (
    <div style={{
      width: "100%", height: h, borderRadius: "8px",
      background: "linear-gradient(90deg, var(--bg-base) 0%, var(--border-strong) 40%, var(--bg-base) 80%)",
      backgroundSize: "600px 100%",
      animation: `bm-shimmer 1.8s ease-in-out ${delay}s infinite`,
    }} />
  );
}

interface ChartTooltipPayload {
  name: string;
  value: number | null;
  color: string;
  dataKey: string;
}

function ChartTooltip({
  active, payload, label, valueFormatter,
}: {
  active?: boolean;
  payload?: ChartTooltipPayload[];
  label?: string;
  valueFormatter?: (v: number | null) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
      borderRadius: "8px", padding: "10px 14px", boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
    }}>
      {label && (
        <div style={{
          fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.1em",
          textTransform: "uppercase", color: "var(--text-tertiary)", marginBottom: "7px",
        }}>
          {label}
        </div>
      )}
      {payload.map((entry) => (
        <div key={entry.dataKey} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: entry.color, flexShrink: 0, display: "inline-block" }} />
          <span style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-secondary)" }}>{entry.name}</span>
          <span style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-primary)", fontWeight: 600, marginLeft: "auto", paddingLeft: "12px" }}>
            {valueFormatter ? valueFormatter(entry.value) : (entry.value == null ? "n/a" : Math.round(entry.value))}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: "20px 24px 16px" }}>
      <div style={{ marginBottom: "16px" }}>
        <div style={{ fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "4px" }}>
          {title}
        </div>
        <div style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "12px", color: "var(--text-muted)" }}>
          {subtitle}
        </div>
      </div>
      {children}
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
  const benchmarkOverviewQuery = useBenchmarkOverviewQuery(true);
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

  const accuracyData = useMemo(() => {
    return buildOverviewAccuracyData(normalizedSummary);
  }, [normalizedSummary]);

  const learningCurveState = useMemo(() => buildOverviewLearningCurve(benchmarks), [benchmarks]);

  const costData = useMemo(() => {
    return BENCHMARK_MECHANISMS.map((mechanism) => {
      const metrics = normalizedSummary.per_mode[mechanism] ?? {};
      const runCount = asNumber(metrics.run_count);
      const avgCost = asNumber(metrics.avg_estimated_cost_usd);
      return {
        mechanism: titleCase(mechanism),
        estimatedCostUsd: runCount > 0 && avgCost > 0 ? avgCost : null,
      };
    });
  }, [normalizedSummary]);

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
          <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
          <p className="text-text-secondary text-lg max-w-150">
            Comparison, ablation, and learning metrics generated from the Phase 2 benchmark suite.
          </p>
        </header>

        {/* ── Charts ──────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8 w-full">
          {/* Accuracy by category — full width */}
          <div className="col-span-1 lg:col-span-2">
            <ChartCard
              title="Accuracy by Task Category × Stage"
              subtitle="Requested benchmark-stage success by category for the active artifact. This chart is stage-level, not actual executed-mechanism telemetry."
            >
              {overviewError ? (
                <div style={{ padding: "32px 0", fontFamily: CHART_FONT, fontSize: "11px", color: "var(--accent-rose)" }}>
                  {overviewError}
                </div>
              ) : !benchmarks ? (
                <SkeletonChartBlock h="300px" />
              ) : (
                <div className="w-full h-75">
                  {chartsReady && (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={accuracyData} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
                        <XAxis
                          dataKey="category"
                          stroke="transparent"
                          tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                        />
                        <YAxis
                          stroke="transparent"
                          tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                        />
                        <Tooltip
                          content={(props) => (
                            <ChartTooltip
                              active={props.active}
                              payload={props.payload as unknown as ChartTooltipPayload[] | undefined}
                              label={props.label as string | undefined}
                              valueFormatter={(v) => (v == null ? "n/a" : `${Math.round(v)}%`)}
                            />
                          )}
                          cursor={{ fill: "rgba(255,255,255,0.025)" }}
                        />
                        <Legend
                          iconType="circle"
                          wrapperStyle={{ fontFamily: CHART_FONT, fontSize: "10px", paddingTop: "14px", color: "var(--text-tertiary)" }}
                        />
                        <Bar
                          dataKey="debate" name="Debate"
                          fill="var(--text-muted)"
                          radius={[4, 4, 0, 0]} minPointSize={4}
                          isAnimationActive animationBegin={100} animationDuration={700} animationEasing="ease-out"
                        />
                        <Bar
                          dataKey="vote" name="Vote"
                          fill="var(--accent-amber)"
                          radius={[4, 4, 0, 0]} minPointSize={4}
                          isAnimationActive animationBegin={200} animationDuration={700} animationEasing="ease-out"
                        />
                        <Bar
                          dataKey="selector" name="Selector"
                          fill="var(--accent-emerald)"
                          radius={[4, 4, 0, 0]} minPointSize={4}
                          isAnimationActive animationBegin={300} animationDuration={700} animationEasing="ease-out"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Learning curve */}
          <ChartCard
            title="Selector Learning Curve"
            subtitle={
              benchmarkArtifactKind === "validation"
                ? "Accuracy before and after the learning update cycle."
                : "Only validation artifacts with explicit pre/post stages can populate this curve honestly."
            }
          >
            {!benchmarks && !overviewError ? (
              <SkeletonChartBlock h="250px" delay={0.1} />
            ) : learningCurveState.reason ? (
              <div className="w-full h-62.5 rounded-md border border-border-subtle bg-void px-4 py-5 flex items-center justify-center text-center text-sm text-text-secondary">
                {learningCurveState.reason}
              </div>
            ) : (
              <div className="w-full h-62.5">
                {chartsReady && benchmarks && learningCurveState.available && (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={learningCurveState.data} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
                      <XAxis
                        dataKey="phase"
                        stroke="transparent"
                        tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                      />
                      <YAxis
                        stroke="transparent"
                        tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                        domain={[0, 100]}
                      />
                      <Tooltip
                        content={(props) => (
                          <ChartTooltip
                            active={props.active}
                            payload={props.payload as unknown as ChartTooltipPayload[] | undefined}
                            label={props.label as string | undefined}
                            valueFormatter={(v) => (v == null ? "n/a" : `${Math.round(v)}%`)}
                          />
                        )}
                      />
                      <Line
                        type="monotone"
                        dataKey="accuracy"
                        name="Accuracy"
                        stroke="var(--accent-emerald)"
                        strokeWidth={2}
                        dot={{ fill: "var(--bg-base)", stroke: "var(--accent-emerald)", strokeWidth: 2, r: 4 }}
                        activeDot={{ r: 6, fill: "var(--accent-emerald)" }}
                        isAnimationActive animationBegin={100} animationDuration={700} animationEasing="ease-out"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}
          </ChartCard>

          {/* Cost efficiency */}
          <ChartCard
            title="Cost Efficiency"
            subtitle="Estimated USD cost per requested benchmark stage from token usage and the internal pricing catalog."
          >
            {!benchmarks && !overviewError ? (
              <SkeletonChartBlock h="250px" delay={0.2} />
            ) : (
              <div className="w-full h-62.5">
                {chartsReady && benchmarks && (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={costData} margin={{ top: 20, right: 10, left: -10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" vertical={false} />
                      <XAxis
                        dataKey="mechanism"
                        stroke="transparent"
                        tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                      />
                      <YAxis
                        stroke="transparent"
                        tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: CHART_FONT }}
                      />
                      <Tooltip
                        content={(props) => (
                          <ChartTooltip
                            active={props.active}
                            payload={props.payload as unknown as ChartTooltipPayload[] | undefined}
                            label={props.label as string | undefined}
                            valueFormatter={(v) => formatUsd(v ?? null)}
                          />
                        )}
                        cursor={{ fill: "rgba(255,255,255,0.025)" }}
                      />
                      <Bar
                        dataKey="estimatedCostUsd" name="Estimated USD"
                        fill="var(--accent-emerald)"
                        radius={[4, 4, 0, 0]} minPointSize={4}
                        isAnimationActive animationBegin={100} animationDuration={700} animationEasing="ease-out"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}
          </ChartCard>
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
              <button type="button" className="btn-secondary" onClick={() => navigate("/benchmarks/all")}>View all</button>
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
              <button type="button" className="btn-secondary" onClick={() => navigate("/benchmarks/all")}>View all</button>
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

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

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
