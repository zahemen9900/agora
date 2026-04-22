import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCcw,
  X,
} from "lucide-react";

import { EnsemblePlan } from "../components/EnsemblePlan";
import {
  ApiRequestError,
  getBenchmarkCatalog,
  getBenchmarkRunStatus,
  getBenchmarks,
  triggerBenchmarkRun,
  type BenchmarkCatalogEntry,
  type BenchmarkCatalogPayload,
  type BenchmarkDomainName,
  type BenchmarkDomainPromptPayload,
  type BenchmarkPayload,
  type BenchmarkPromptTemplatesPayload,
  type BenchmarkRunRequestPayload,
  type BenchmarkRunStatusPayload,
  type BenchmarkSummary,
} from "../lib/api";
import { useAuth } from "../lib/useAuth";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { ReasoningPresetControls } from "../components/ReasoningPresetControls";
import {
  buildDebateRoster,
  buildProviderCountBadges,
  buildVoteRoster,
  DEFAULT_REASONING_PRESETS,
  getBalancedEnsembleLabel,
  getDebateSpecialistSummary,
  type ReasoningPresetState,
} from "../lib/deliberationConfig";
import { providerFromModel, providerTone } from "../lib/modelProviders";

type CatalogSortMode = "recent" | "frequency";
type WizardStep = 0 | 1 | 2;

interface DomainPromptSelection {
  templateId: string | null;
  templateTitle: string | null;
  question: string;
  useCustomPrompt: boolean;
  customQuestion: string;
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const BENCHMARK_DOMAINS: BenchmarkDomainName[] = [
  "math",
  "factual",
  "reasoning",
  "code",
  "creative",
  "demo",
];
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

export function Benchmarks() {
  const navigate = useNavigate();
  const { authStatus, getAccessToken } = useAuth();

  const [benchmarks, setBenchmarks] = useState<BenchmarkPayload | null>(null);
  const [catalog, setCatalog] = useState<BenchmarkCatalogPayload | null>(null);
  const templates = FALLBACK_PROMPT_TEMPLATES;

  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [chartsReady, setChartsReady] = useState(false);
  const [activeBenchmarkRun, setActiveBenchmarkRun] = useState<BenchmarkRunStatusPayload | null>(null);
  const [isTriggeringBenchmark, setIsTriggeringBenchmark] = useState(false);

  const [yourSortMode, setYourSortMode] = useState<CatalogSortMode>("recent");
  const [globalSortMode, setGlobalSortMode] = useState<CatalogSortMode>("recent");

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>(0);
  const [wizardDomain, setWizardDomain] = useState<BenchmarkDomainName>("math");
  const [benchmarkAgentCount, setBenchmarkAgentCount] = useState(4);
  const [trainingPerCategory, setTrainingPerCategory] = useState(1);
  const [holdoutPerCategory, setHoldoutPerCategory] = useState(1);
  const [reasoningPresets, setReasoningPresets] = useState<ReasoningPresetState>(
    DEFAULT_REASONING_PRESETS,
  );
  const [domainPromptSelection, setDomainPromptSelection] = useState<
    Partial<Record<BenchmarkDomainName, DomainPromptSelection>>
  >({});

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

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

  const loadBenchmarkData = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setCatalogError(null);

    try {
      const token = await getAccessToken();
      if (!token) {
        setLoadError("Authentication token is unavailable.");
        return;
      }

      const benchmarkPayload = await getBenchmarks(token);
      setBenchmarks(benchmarkPayload);

      const catalogPayload = await getBenchmarkCatalog(token, 100);
      setCatalog(catalogPayload);
      setCatalogError(null);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        setLoadError(error.message);
      } else {
        console.error(error);
        setLoadError("Benchmark data is currently unavailable.");
      }
    }
  }, [getAccessToken]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
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

    void load();

    return () => {
      cancelled = true;
    };
  }, [authStatus, loadBenchmarkData]);

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

  const normalizedSummary = useMemo<BenchmarkSummary>(() => ensureCompleteSummary(deriveSummary(benchmarks)), [benchmarks]);

  const accuracyData = useMemo(() => {
    return BENCHMARK_DOMAINS.map((domain) => {
      const metricsByMode = normalizedSummary.per_category[domain] ?? {};
      return {
        category: titleCase(domain),
        debate: ((metricsByMode.debate?.accuracy ?? 0) as number) * 100,
        vote: ((metricsByMode.vote?.accuracy ?? 0) as number) * 100,
        selector: ((metricsByMode.selector?.accuracy ?? 0) as number) * 100,
      };
    });
  }, [normalizedSummary]);

  const learningCurveData = useMemo(() => {
    const pre = Number(
      benchmarks?.pre_learning?.summary?.per_mode?.selector?.accuracy
      ?? benchmarks?.pre_learning?.summary?.per_mode?.vote?.accuracy
      ?? 0,
    ) * 100;
    const post = Number(
      benchmarks?.post_learning?.summary?.per_mode?.selector?.accuracy
      ?? benchmarks?.post_learning?.summary?.per_mode?.vote?.accuracy
      ?? pre,
    ) * 100;
    return [
      { phase: "Pre", accuracy: pre },
      { phase: "Post", accuracy: post || pre },
    ];
  }, [benchmarks]);

  const costData = useMemo(() => {
    const costSummary =
      Object.keys(normalizedSummary.per_mechanism).length > 0
        ? normalizedSummary.per_mechanism
        : normalizedSummary.per_mode;
    return BENCHMARK_MECHANISMS.map((mechanism) => {
      const metrics = costSummary[mechanism] ?? {};
      return {
        mechanism: titleCase(mechanism),
        estimatedCostUsd: asNumber(metrics.avg_estimated_cost_usd),
      };
    });
  }, [normalizedSummary]);

  const yourEntries = useMemo(() => {
    if (!catalog) {
      return [];
    }
    return (yourSortMode === "recent" ? catalog.user_recent : catalog.user_frequency).slice(0, 3);
  }, [catalog, yourSortMode]);

  const failedBenchmarkRuns = useMemo(() => {
    if (!catalog) {
      return [];
    }
    const runs = yourSortMode === "recent" ? catalog.user_tests_recent : catalog.user_tests_frequency;
    return runs.filter((run) => run.status === "failed").slice(0, 3);
  }, [catalog, yourSortMode]);

  const globalEntries = useMemo(() => {
    if (!catalog) {
      return [];
    }
    return (globalSortMode === "recent" ? catalog.global_recent : catalog.global_frequency).slice(0, 3);
  }, [catalog, globalSortMode]);

  const runPayloadPreview = useMemo(() => {
    const domainPrompts: Partial<Record<BenchmarkDomainName, BenchmarkDomainPromptPayload>> = {};
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
        template_id: selection.templateId,
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
    };

    return payload;
  }, [
    benchmarkAgentCount,
    domainPromptSelection,
    holdoutPerCategory,
    reasoningPresets,
    trainingPerCategory,
  ]);

  const benchmarkVoteRoster = useMemo(
    () => buildVoteRoster(benchmarkAgentCount, reasoningPresets),
    [benchmarkAgentCount, reasoningPresets],
  );
  const benchmarkDebateRoster = useMemo(
    () => buildDebateRoster(benchmarkAgentCount, reasoningPresets),
    [benchmarkAgentCount, reasoningPresets],
  );
  const benchmarkCountBadges = useMemo(
    () => buildProviderCountBadges(benchmarkAgentCount),
    [benchmarkAgentCount],
  );
  const benchmarkEnsembleLabel = useMemo(
    () => getBalancedEnsembleLabel(benchmarkAgentCount),
    [benchmarkAgentCount],
  );

  const openWizard = () => {
    syncDomainPromptSelection(templates);
    setWizardStep(0);
    setWizardDomain("math");
    setRunError(null);
    setWizardOpen(true);
  };

  const closeWizard = () => {
    setWizardOpen(false);
    setWizardStep(0);
  };

  const handleTriggerBenchmark = useCallback(async () => {
    try {
      setRunError(null);
      setIsTriggeringBenchmark(true);
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Authentication token is unavailable.");
      }

      const run = await triggerBenchmarkRun(token, runPayloadPreview);
      setActiveBenchmarkRun({
        run_id: run.run_id,
        status: run.status,
        created_at: run.created_at,
        updated_at: run.created_at,
        error: null,
        artifact_id: null,
      });
      closeWizard();
      navigate(`/benchmarks/${run.run_id}`);
    } catch (error) {
      console.error(error);
      setRunError("Unable to start benchmark run right now.");
    } finally {
      setIsTriggeringBenchmark(false);
    }
  }, [getAccessToken, navigate, runPayloadPreview]);

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
  const wizardCurrentSelection = domainPromptSelection[wizardDomain];
  const wizardTemplates = templates.domains[wizardDomain] ?? [];
  const wizardSelectedTemplate = wizardTemplates.find((template) => template.id === wizardCurrentSelection?.templateId);

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
    <>
      <div className="max-w-250 mx-auto pb-20 w-full">
        <header className="mb-10">
          <h1 className="text-3xl md:text-4xl mb-4">Benchmarks</h1>
          <p className="text-text-secondary text-lg max-w-150">
            Comparison, ablation, and learning metrics generated from the Phase 2 benchmark suite.
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8 w-full">
          <div className="card p-4 sm:p-8 col-span-1 lg:col-span-2">
            <h3 className="mb-2 text-lg font-semibold">Accuracy by Task Category x Mechanism</h3>
            <p className="text-sm text-text-secondary mb-8">
              Selector runs should dominate category-specific fixed strategies after learning.
            </p>
            <div className="w-full h-75">
              {chartsReady ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={accuracyData} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" vertical={false} />
                    <XAxis
                      dataKey="category"
                      stroke="var(--color-text-muted)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
                    />
                    <YAxis
                      stroke="var(--color-text-muted)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
                    />
                    <Tooltip cursor={{ fill: "var(--color-elevated)" }} />
                    <Legend iconType="circle" wrapperStyle={{ fontFamily: "JetBrains Mono", fontSize: "12px" }} />
                    <Bar dataKey="debate" name="Debate" fill="var(--color-border-muted)" radius={[4, 4, 0, 0]} minPointSize={4} />
                    <Bar dataKey="vote" name="Vote" fill="var(--color-text-muted)" radius={[4, 4, 0, 0]} minPointSize={4} />
                    <Bar dataKey="selector" name="Selector" fill="var(--color-accent)" radius={[4, 4, 0, 0]} minPointSize={4} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full" />
              )}
            </div>
          </div>

          <div className="card p-4 sm:p-8">
            <h3 className="mb-2 text-lg font-semibold">Selector Learning Curve</h3>
            <p className="text-sm text-text-secondary mb-8">Accuracy before and after the learning update cycle.</p>
            <div className="w-full h-62.5">
              {chartsReady ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={learningCurveData} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" vertical={false} />
                    <XAxis
                      dataKey="phase"
                      stroke="var(--color-text-muted)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
                    />
                    <YAxis
                      stroke="var(--color-text-muted)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
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
              Estimated USD cost per mechanism from token usage and model pricing.
            </p>
            <div className="w-full h-62.5">
              {chartsReady ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={costData} margin={{ top: 20, right: 10, left: -10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" vertical={false} />
                    <XAxis
                      dataKey="mechanism"
                      stroke="var(--color-text-muted)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
                    />
                    <YAxis
                      stroke="var(--color-text-muted)"
                      tick={{ fill: "var(--color-text-muted)", fontSize: 12, fontFamily: "JetBrains Mono" }}
                    />
                    <Tooltip
                      formatter={(value) => formatUsd(Number(value))}
                      cursor={{ fill: "var(--color-elevated)" }}
                    />
                    <Bar dataKey="estimatedCostUsd" name="Estimated USD" fill="var(--color-text-primary)" radius={[4, 4, 0, 0]} minPointSize={4} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full" />
              )}
            </div>
          </div>
        </div>

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

          {activeBenchmarkRun ? (
            <div className="border border-border-subtle rounded-md px-4 py-3 bg-void">
              <div className="flex flex-wrap gap-3 items-center mb-2">
                <span className="mono text-xs text-text-muted">RUN ID</span>
                <span className="mono text-xs text-text-primary break-all">{activeBenchmarkRun.run_id}</span>
                <span className="badge">{titleCase(activeBenchmarkRun.status)}</span>
                {activeBenchmarkRun.status === "queued" || activeBenchmarkRun.status === "running" ? (
                  <span className="inline-flex items-center gap-2 mono text-[11px] text-accent">
                    <Loader2 size={12} className="animate-spin" />
                    live benchmark running
                  </span>
                ) : null}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-text-secondary mb-2">
                <div>Tokens {formatInt(activeBenchmarkRun.total_tokens ?? 0)}</div>
                <div>Thinking {formatInt(activeBenchmarkRun.thinking_tokens ?? 0)}</div>
                <div>Latency {formatLatency(activeBenchmarkRun.total_latency_ms ?? null)}</div>
                <div>Cost {formatUsd(activeBenchmarkRun.cost?.estimated_cost_usd ?? null)}</div>
              </div>
              <div className="mono text-xs text-text-muted">
                Updated {formatDateTime(activeBenchmarkRun.updated_at)}
                {activeBenchmarkRun.artifact_id ? ` • artifact ${activeBenchmarkRun.artifact_id}` : ""}
              </div>
              {activeBenchmarkRun.status === "completed" ? (
                <div className="mt-3">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => navigate(`/benchmarks/${activeBenchmarkRun.artifact_id ?? activeBenchmarkRun.run_id}`)}
                  >
                    Open Report
                  </button>
                </div>
              ) : (
                <div className="mt-3">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => navigate(`/benchmarks/${activeBenchmarkRun.run_id}`)}
                  >
                    {activeBenchmarkRun.status === "failed" ? "Open Failed Report" : "Open Live View"}
                  </button>
                </div>
              )}
              {activeBenchmarkRun.error ? <div className="mono text-xs text-red-300 mt-2">{activeBenchmarkRun.error}</div> : null}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">No active benchmark run yet.</p>
          )}

          {runError ? <p className="text-sm text-red-300 mt-2">{runError}</p> : null}
        </div>

        <div className="card p-4 sm:p-6 mb-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="text-lg font-semibold">Your Benchmarks</h3>
            <div className="flex items-center gap-2">
              <SortToggle value={yourSortMode} onChange={setYourSortMode} />
              <button type="button" className="btn-secondary" onClick={() => navigate("/benchmarks/all")}>View all</button>
            </div>
          </div>
          {catalogError ? (
            <p className="text-sm text-text-secondary">{catalogError}</p>
          ) : (
            <div className="space-y-5">
              {yourEntries.length > 0 ? (
                <div className="space-y-3">
                  {yourEntries.map((entry) => (
                    <BenchmarkCatalogCard
                      key={entry.artifact_id}
                      entry={entry}
                      onOpen={() => navigate(`/benchmarks/${entry.artifact_id}`)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-text-secondary">No user benchmark artifacts yet.</p>
              )}

              {failedBenchmarkRuns.length > 0 ? (
                <div className="pt-5 border-t border-border-subtle">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <h4 className="text-base font-semibold">Failed Runs</h4>
                      <p className="text-xs text-text-secondary">
                        Persisted benchmark failures stay visible here with their error details.
                      </p>
                    </div>
                    <span className="badge">{titleCase(yourSortMode)}</span>
                  </div>
                  <div className="space-y-3">
                    {failedBenchmarkRuns.map((run) => (
                      <FailedBenchmarkRunCard
                        key={run.run_id}
                        run={run}
                        onOpen={() => navigate(`/benchmarks/${run.run_id}`)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="card p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="text-lg font-semibold">Global Benchmarks</h3>
            <div className="flex items-center gap-2">
              <SortToggle value={globalSortMode} onChange={setGlobalSortMode} />
              <button type="button" className="btn-secondary" onClick={() => navigate("/benchmarks/all")}>View all</button>
            </div>
          </div>
          {catalogError ? (
            <p className="text-sm text-text-secondary">{catalogError}</p>
          ) : globalEntries.length === 0 ? (
            <p className="text-sm text-text-secondary">No global benchmark artifacts yet.</p>
          ) : (
            <div className="space-y-3">
              {globalEntries.map((entry) => (
                <BenchmarkCatalogCard
                  key={entry.artifact_id}
                  entry={entry}
                  onOpen={() => navigate(`/benchmarks/${entry.artifact_id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {wizardOpen ? (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 sm:p-8 overflow-y-auto">
          <div className="card max-w-240 w-full p-4 sm:p-6 border border-border-subtle">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-xl font-semibold mb-1">Benchmark Run Wizard</h2>
                <p className="text-sm text-text-secondary">Configure per-domain questions, then launch a comprehensive run.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={closeWizard} aria-label="Close benchmark wizard">
                <X size={16} />
              </button>
            </div>

            <div className="mono text-xs text-text-muted mb-4">Step {wizardStep + 1} of 3</div>

            {wizardStep === 0 ? (
              <div className="space-y-6">
                <div>
                  <div className="mono text-xs text-text-muted mb-2">AGENT COUNT</div>
                  <div className="flex gap-2">
                    {[4, 8, 12].map((count) => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => setBenchmarkAgentCount(count)}
                        className={`mono px-3 py-1.5 text-xs rounded-md border transition-colors ${
                          benchmarkAgentCount === count
                            ? "border-accent text-accent bg-accent-muted"
                            : "border-border-muted text-text-secondary hover:border-accent"
                        }`}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <label className="block">
                    <span className="mono text-xs text-text-muted">TRAINING / DOMAIN</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={trainingPerCategory}
                      onChange={(event) => setTrainingPerCategory(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
                      className="input mt-2"
                    />
                  </label>
                  <label className="block">
                    <span className="mono text-xs text-text-muted">HOLDOUT / DOMAIN</span>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={holdoutPerCategory}
                      onChange={(event) => setHoldoutPerCategory(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
                      className="input mt-2"
                    />
                  </label>
                </div>

                <ReasoningPresetControls
                  value={reasoningPresets}
                  onChange={setReasoningPresets}
                />

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <EnsemblePlan
                    title="VOTE MODEL PLAN"
                    label={benchmarkEnsembleLabel}
                    items={benchmarkVoteRoster}
                    countBadges={benchmarkCountBadges}
                  />
                  <EnsemblePlan
                    title="DEBATE MODEL PLAN"
                    label={benchmarkEnsembleLabel}
                    items={benchmarkDebateRoster}
                    countBadges={benchmarkCountBadges}
                    footer={getDebateSpecialistSummary()}
                  />
                </div>
              </div>
            ) : null}

            {wizardStep === 1 ? (
              <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-5">
                <div className="border border-border-subtle rounded-md p-3 bg-void space-y-2">
                  <div className="mono text-xs text-text-muted mb-1">DOMAIN COVERAGE</div>
                  {BENCHMARK_DOMAINS.map((domain) => (
                    <button
                      key={domain}
                      type="button"
                      className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
                        wizardDomain === domain
                          ? "border-accent bg-accent-muted"
                          : "border-border-subtle hover:border-accent"
                      }`}
                      onClick={() => setWizardDomain(domain)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-text-primary">{titleCase(domain)}</span>
                        <span className={`mono text-[10px] ${domainStatus[domain].complete ? "text-accent" : "text-text-muted"}`}>
                          {domainStatus[domain].complete ? "READY" : "OPEN"}
                        </span>
                      </div>
                      <div className="mono text-[10px] text-text-muted mt-1 truncate">
                        {domainStatus[domain].label}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="border border-border-subtle rounded-md p-4 bg-void">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
                    <div>
                      <h4 className="text-sm font-semibold mb-1">{titleCase(wizardDomain)} Question</h4>
                      <p className="text-xs text-text-secondary">
                        Pick a question template or write your own debate question for this domain.
                      </p>
                    </div>
                    <div className="inline-flex border border-border-subtle rounded-md overflow-hidden">
                    <button
                      type="button"
                      onClick={() => updateDomainSelection(wizardDomain, (existing) => ({
                        ...existing,
                        useCustomPrompt: false,
                        question: wizardSelectedTemplate?.question ?? existing.question,
                        templateTitle: wizardSelectedTemplate?.title ?? existing.templateTitle,
                      }))}
                      className={`mono px-3 py-1.5 text-xs ${!domainPromptSelection[wizardDomain]?.useCustomPrompt ? "bg-accent-muted text-accent" : "text-text-secondary"}`}
                    >
                      Template
                    </button>
                      <button
                        type="button"
                        onClick={() => updateDomainSelection(wizardDomain, (existing) => {
                          if (existing.useCustomPrompt) {
                            return existing;
                          }
                          const seededQuestion = normalizeText(existing.customQuestion).length > 0
                            ? normalizeText(existing.customQuestion)
                            : (normalizeText(wizardSelectedTemplate?.question) || normalizeText(existing.question));
                          return {
                            ...existing,
                            useCustomPrompt: true,
                            customQuestion: seededQuestion,
                            question: seededQuestion || existing.question,
                          };
                        })}
                        className={`mono px-3 py-1.5 text-xs ${domainPromptSelection[wizardDomain]?.useCustomPrompt ? "bg-accent-muted text-accent" : "text-text-secondary"}`}
                      >
                        Custom
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                    {wizardTemplates.map((template) => {
                      const active = wizardCurrentSelection?.templateId === template.id
                        && !wizardCurrentSelection?.useCustomPrompt;
                      return (
                        <button
                          key={template.id}
                          type="button"
                          onClick={() => updateDomainSelection(wizardDomain, (existing) => ({
                            ...existing,
                            templateId: template.id,
                            templateTitle: template.title,
                            question: template.question,
                            useCustomPrompt: false,
                            customQuestion: existing.customQuestion,
                          }))}
                          className={`text-left border rounded-md p-3 transition-colors ${
                            active ? "border-accent bg-accent-muted" : "border-border-subtle hover:border-accent"
                          }`}
                          >
                            <div className="flex items-center justify-between gap-3 mb-2">
                              <div className="mono text-xs text-text-muted">{template.title}</div>
                              {active ? <span className="mono text-[10px] text-accent">SELECTED</span> : null}
                            </div>
                          <div className="text-xs text-text-secondary whitespace-pre-wrap line-clamp-5">{template.question}</div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-4 space-y-3">
                    {wizardCurrentSelection?.useCustomPrompt ? (
                      <>
                        <div className="rounded-md border border-border-subtle bg-elevated/40 p-3">
                          <div className="mono text-xs text-text-muted mb-1">CUSTOM QUESTION</div>
                          <p className="text-xs text-text-secondary">
                            Write the exact question the models should debate. The template picker stays available if you want to switch back.
                          </p>
                          {wizardSelectedTemplate ? (
                            <div className="mt-3 rounded-md border border-border-subtle bg-void p-2">
                              <div className="mono text-[10px] text-text-muted mb-1">
                                STARTING FROM {wizardSelectedTemplate.title.toUpperCase()}
                              </div>
                              <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word">
                                {wizardSelectedTemplate.question}
                              </p>
                            </div>
                          ) : null}
                        </div>
                        <textarea
                          value={wizardCurrentSelection?.customQuestion ?? ""}
                          onChange={(event) =>
                            updateDomainSelection(wizardDomain, (existing) => ({
                              ...existing,
                              customQuestion: event.target.value,
                              question: event.target.value,
                              useCustomPrompt: true,
                            }))
                          }
                          placeholder={`Write the exact benchmark question for ${titleCase(wizardDomain)}.`}
                          rows={10}
                          className="w-full rounded-md border border-border-subtle bg-void px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
                        />
                      </>
                    ) : (
                      <div className="rounded-md border border-border-subtle bg-elevated/40 p-3">
                        <div className="mono text-xs text-text-muted mb-1">SELECTED QUESTION</div>
                        <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word">
                          {normalizeText(wizardCurrentSelection?.question) || "Choose a question above or switch to custom mode."}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {wizardStep === 2 ? (
              <div className="space-y-4">
                <div className="border border-border-subtle rounded-md p-4 bg-void">
                  <div className="mono text-xs text-text-muted mb-2">RUN CONFIGURATION</div>
                  <div className="text-sm text-text-secondary">
                    {benchmarkAgentCount} agents • training {trainingPerCategory}/domain • holdout {holdoutPerCategory}/domain
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {Object.entries(reasoningPresets).map(([key, value]) => (
                      <span key={key} className="badge">
                        {key.replace("_", " ")} {value}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {BENCHMARK_DOMAINS.map((domain) => {
                    const selection = domainPromptSelection[domain];
                    if (!selection) {
                      return null;
                    }
                    return (
                      <div key={domain} className="border border-border-subtle rounded-md p-3 bg-void">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm text-text-primary">{titleCase(domain)}</span>
                          <span className="mono text-xs text-text-muted">
                            {selection.useCustomPrompt ? "custom" : selection.templateTitle ?? selection.templateId ?? "template"}
                          </span>
                        </div>
                        <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word line-clamp-4">
                          {normalizeText(selection.question) || "No question selected."}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                type="button"
                className="btn-secondary inline-flex items-center gap-2"
                onClick={() =>
                  setWizardStep((step) => {
                    if (step === 2) {
                      return 1;
                    }
                    return 0;
                  })
                }
                disabled={wizardStep === 0 || isTriggeringBenchmark}
              >
                <ChevronLeft size={14} /> Back
              </button>

              {wizardStep < 2 ? (
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-2"
                  onClick={() =>
                    setWizardStep((step) => {
                      if (step === 0) {
                        return 1;
                      }
                      return 2;
                    })
                  }
                  disabled={wizardStep === 1 && !allDomainsConfigured}
                >
                  Next <ChevronRight size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-2"
                  onClick={() => {
                    void handleTriggerBenchmark();
                  }}
                  disabled={isTriggeringBenchmark}
                >
                  {isTriggeringBenchmark ? <RefreshCcw size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                  {isTriggeringBenchmark ? "Starting..." : "Submit Benchmark"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function SortToggle({ value, onChange }: { value: CatalogSortMode; onChange: (value: CatalogSortMode) => void }) {
  return (
    <div className="inline-flex border border-border-subtle rounded-md overflow-hidden">
      {(["recent", "frequency"] as CatalogSortMode[]).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`mono px-3 py-1.5 text-xs transition-colors ${
            value === option ? "bg-accent-muted text-accent" : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {titleCase(option)}
        </button>
      ))}
    </div>
  );
}

function BenchmarkCatalogCard({
  entry,
  onOpen,
}: {
  entry: BenchmarkCatalogEntry;
  onOpen: () => void;
}) {
  const dominantMechanism = dominantCountEntry(entry.mechanism_counts)?.[0] ?? entry.latest_mechanism ?? null;
  const dominantModel = dominantCountEntry(entry.model_counts)?.[0] ?? entry.models?.[0] ?? null;
  const dominantProvider = dominantModel ? providerFromModel(dominantModel) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left border border-border-subtle rounded-md px-4 py-4 bg-void hover:border-accent transition-colors"
    >
      <div className="flex flex-wrap gap-2 items-center mb-2">
        <span className="mono text-xs text-text-muted">{entry.artifact_id.slice(0, 18)}...</span>
        <span className="badge">{titleCase(entry.scope)}</span>
        {entry.latest_mechanism ? <span className="badge">{titleCase(entry.latest_mechanism)}</span> : null}
        {dominantMechanism ? <span className="badge">mix {titleCase(dominantMechanism)}</span> : null}
        {dominantProvider ? <span className="badge">{titleCase(dominantProvider)} heavy</span> : null}
        <span className="badge">{frequencyBucket(entry.frequency_score)}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs text-text-secondary mb-3">
        <div>Runs {formatInt(entry.run_count)}</div>
        <div>Agents {entry.agent_count ?? "n/a"}</div>
        <div>Tokens {formatInt(entry.total_tokens ?? 0)}</div>
        <div>Thinking {formatInt(entry.thinking_tokens ?? 0)}</div>
        <div>Cost {formatUsd(entry.cost?.estimated_cost_usd ?? null)}</div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-[11px] text-text-muted mb-3">
        <div>Latency class {latencyBucket(entry.total_latency_ms ?? null)}</div>
        <div>Cost class {costBucket(entry.cost?.estimated_cost_usd ?? null)}</div>
        <div>Mechanisms {Object.keys(entry.mechanism_counts).length || 0}</div>
        <div>Models {Object.keys(entry.model_counts).length || 0}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        {(entry.models ?? Object.keys(entry.model_counts)).slice(0, 5).map((model) => {
          const provider = providerFromModel(model);
          return (
            <span key={model} className={`inline-flex items-center gap-1.5 border rounded-full px-2 py-1 mono text-[11px] ${providerTone(provider)}`}>
              <ProviderGlyph provider={provider} />
              <span className="truncate max-w-44">{model}</span>
            </span>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>{formatDateTime(entry.created_at)}</span>
        <span className="inline-flex items-center gap-1">Open <ChevronRight size={12} /></span>
      </div>
    </button>
  );
}

function FailedBenchmarkRunCard({
  run,
  onOpen,
}: {
  run: BenchmarkRunStatusPayload;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left border border-red-400/30 rounded-md px-4 py-4 bg-red-400/10 hover:border-red-300 transition-colors"
    >
      <div className="flex flex-wrap gap-2 items-center mb-2">
        <span className="mono text-xs text-text-muted break-all">{run.run_id}</span>
        <span className="badge bg-red-500/15 text-red-200 border-red-500/30">failed</span>
        {run.artifact_id ? <span className="badge">artifact {run.artifact_id}</span> : null}
        {run.latest_mechanism ? <span className="badge">{titleCase(run.latest_mechanism)}</span> : null}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs text-text-secondary mb-3">
        <div>Tokens {formatInt(run.total_tokens ?? 0)}</div>
        <div>Agents {run.agent_count ?? "n/a"}</div>
        <div>Thinking {formatInt(run.thinking_tokens ?? 0)}</div>
        <div>Cost {formatUsd(run.cost?.estimated_cost_usd ?? null)}</div>
        <div>Updated {formatDateTime(run.updated_at)}</div>
      </div>

      {run.error ? (
        <div className="mono text-xs text-red-200 mb-3 wrap-break-word whitespace-pre-wrap">
          {run.error}
        </div>
      ) : null}

      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>{formatDateTime(run.created_at)}</span>
        <span className="inline-flex items-center gap-1">Open failed report <ChevronRight size={12} /></span>
      </div>
    </button>
  );
}

function deriveSummary(payload: BenchmarkPayload | null): BenchmarkSummary {
  const fallback = { per_mode: {}, per_mechanism: {}, per_category: {} } satisfies BenchmarkSummary;
  if (!payload) {
    return fallback;
  }

  if (payload.summary) {
    return payload.summary;
  }

  if (payload.post_learning?.summary) {
    return payload.post_learning.summary;
  }

  if (payload.pre_learning?.summary) {
    return payload.pre_learning.summary;
  }

  return fallback;
}

function ensureCompleteSummary(summary: Partial<BenchmarkSummary>): BenchmarkSummary {
  const safePerMode = summary.per_mode || {};
  const safePerMechanism = summary.per_mechanism || safePerMode;
  const perMode: Record<string, Record<string, number>> = {};
  const perMechanism: Record<string, Record<string, number>> = {};
  for (const mechanism of BENCHMARK_MECHANISMS) {
    const metrics = safePerMode[mechanism] ?? {};
    perMode[mechanism] = {
      accuracy: asNumber(metrics.accuracy),
      avg_tokens: asNumber(metrics.avg_tokens),
      avg_latency_ms: asNumber(metrics.avg_latency_ms),
      avg_rounds: asNumber(metrics.avg_rounds),
      switch_rate: asNumber(metrics.switch_rate),
      avg_thinking_tokens: asNumber(metrics.avg_thinking_tokens),
      avg_estimated_cost_usd: asNumber(metrics.avg_estimated_cost_usd),
    };

    const mechanismMetrics = safePerMechanism[mechanism] ?? {};
    perMechanism[mechanism] = {
      accuracy: asNumber(mechanismMetrics.accuracy),
      avg_tokens: asNumber(mechanismMetrics.avg_tokens),
      avg_latency_ms: asNumber(mechanismMetrics.avg_latency_ms),
      avg_rounds: asNumber(mechanismMetrics.avg_rounds),
      switch_rate: asNumber(mechanismMetrics.switch_rate),
      avg_thinking_tokens: asNumber(mechanismMetrics.avg_thinking_tokens),
      avg_estimated_cost_usd: asNumber(mechanismMetrics.avg_estimated_cost_usd),
    };
  }

  const safePerCategory = summary.per_category || {};
  const perCategory: Record<string, Record<string, Record<string, number>>> = {};
  const categories = new Set<string>(BENCHMARK_DOMAINS);
  Object.keys(safePerCategory).forEach((category) => categories.add(category));

  for (const category of categories) {
    perCategory[category] = {};
    for (const mechanism of BENCHMARK_MECHANISMS) {
      const metrics = safePerCategory[category]?.[mechanism] ?? {};
      perCategory[category][mechanism] = {
        accuracy: asNumber(metrics.accuracy),
        avg_tokens: asNumber(metrics.avg_tokens),
        avg_latency_ms: asNumber(metrics.avg_latency_ms),
        avg_thinking_tokens: asNumber(metrics.avg_thinking_tokens),
        avg_estimated_cost_usd: asNumber(metrics.avg_estimated_cost_usd),
      };
    }
  }

  return { per_mode: perMode, per_mechanism: perMechanism, per_category: perCategory };
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

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
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

function costBucket(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  if (value < 0.005) {
    return "lean";
  }
  if (value < 0.02) {
    return "balanced";
  }
  return "heavy";
}

function latencyBucket(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  if (value < 90_000) {
    return "fast";
  }
  if (value < 240_000) {
    return "medium";
  }
  return "slow";
}
