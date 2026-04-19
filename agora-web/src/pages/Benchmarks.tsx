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
  RefreshCcw,
  X,
} from "lucide-react";

import { EnsemblePlan } from "../components/EnsemblePlan";
import {
  ApiRequestError,
  getBenchmarkCatalog,
  getBenchmarkPromptTemplates,
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
import { useAuth } from "../lib/auth";
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
  useCustomPrompt: boolean;
  customPrompt: string;
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
const DEFAULT_FALLBACK_USD_PER_TOKEN = 2.5 / 1_000_000;
const FALLBACK_PROMPT_TEMPLATES: BenchmarkPromptTemplatesPayload = {
  domains: {
    math: [
      {
        id: "math-stepwise",
        title: "Stepwise Math",
        prompt: "Solve the math task step-by-step and provide only the final numeric answer on the last line.",
      },
      {
        id: "math-proof-check",
        title: "Proof + Check",
        prompt: "Produce a concise derivation, then verify the result with a quick check before finalizing.",
      },
      {
        id: "math-fast",
        title: "Fast Arithmetic",
        prompt: "Optimize for speed and correctness. Keep reasoning short and explicit.",
      },
      {
        id: "math-robust",
        title: "Robust Edge Cases",
        prompt: "Handle edge cases carefully and call out assumptions before solving.",
      },
    ],
    factual: [
      {
        id: "factual-cited",
        title: "Cited Facts",
        prompt: "Answer factually with confidence levels and a short source rationale for each claim.",
      },
      {
        id: "factual-multihop",
        title: "Multi-hop",
        prompt: "Resolve the query through explicit multi-hop reasoning and avoid speculation.",
      },
      {
        id: "factual-precision",
        title: "Precision First",
        prompt: "Prioritize precision over verbosity. Return concise, directly verifiable claims.",
      },
      {
        id: "factual-contrast",
        title: "Contrastive",
        prompt: "Compare candidate answers and choose the one best supported by known facts.",
      },
    ],
    reasoning: [
      {
        id: "reasoning-tradeoff",
        title: "Tradeoff Analysis",
        prompt: "Evaluate alternatives using explicit tradeoffs, then decide with a ranked recommendation.",
      },
      {
        id: "reasoning-structured",
        title: "Structured Logic",
        prompt: "Use structured premises and conclusions; flag uncertainty where evidence is weak.",
      },
      {
        id: "reasoning-risk",
        title: "Risk-aware",
        prompt: "Include risk analysis and failure modes before producing the final answer.",
      },
      {
        id: "reasoning-ethical",
        title: "Ethical Lens",
        prompt: "Include ethical implications and stakeholder impact in the final recommendation.",
      },
    ],
    code: [
      {
        id: "code-bugfix",
        title: "Bugfix Focus",
        prompt: "Identify the root cause, propose a minimal fix, and include reasoning for correctness.",
      },
      {
        id: "code-design",
        title: "Design Review",
        prompt: "Evaluate design alternatives and choose the most maintainable implementation.",
      },
      {
        id: "code-performance",
        title: "Performance",
        prompt: "Prioritize algorithmic efficiency and mention time/space complexity tradeoffs.",
      },
      {
        id: "code-tests",
        title: "Test-first",
        prompt: "Propose implementation plus focused tests that validate critical behavior.",
      },
    ],
    creative: [
      {
        id: "creative-divergent",
        title: "Divergent Ideas",
        prompt: "Generate varied, high-contrast ideas and select a final concept with rationale.",
      },
      {
        id: "creative-story",
        title: "Narrative",
        prompt: "Respond with a concise, vivid narrative while maintaining thematic coherence.",
      },
      {
        id: "creative-product",
        title: "Product Brainstorm",
        prompt: "Produce product ideas with user segment, value proposition, and differentiation.",
      },
      {
        id: "creative-brand",
        title: "Brand Voice",
        prompt: "Use a distinctive voice and clear tone consistency across the response.",
      },
    ],
    demo: [
      {
        id: "demo-balanced",
        title: "Balanced Demo",
        prompt: "Produce an answer that is clear, auditable, and suitable for stakeholder demos.",
      },
      {
        id: "demo-chain-ready",
        title: "Chain-ready",
        prompt: "Prioritize deterministic outputs that are easy to verify in receipts and replay.",
      },
      {
        id: "demo-latency",
        title: "Low Latency",
        prompt: "Prefer concise reasoning to reduce latency while preserving correctness.",
      },
      {
        id: "demo-confidence",
        title: "High Confidence",
        prompt: "Favor robust consensus and confidence calibration over short responses.",
      },
    ],
  },
};

export function Benchmarks() {
  const navigate = useNavigate();
  const { authStatus, getAccessToken } = useAuth();

  const [benchmarks, setBenchmarks] = useState<BenchmarkPayload | null>(null);
  const [catalog, setCatalog] = useState<BenchmarkCatalogPayload | null>(null);
  const [templates, setTemplates] = useState<BenchmarkPromptTemplatesPayload>(FALLBACK_PROMPT_TEMPLATES);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
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

  const syncDomainPromptSelection = useCallback(
    (templatePayload: BenchmarkPromptTemplatesPayload, forceReset = false) => {
      setDomainPromptSelection((current) => {
        const nextState: Partial<Record<BenchmarkDomainName, DomainPromptSelection>> = {};
        for (const domain of BENCHMARK_DOMAINS) {
          const templatesForDomain = templatePayload.domains[domain] ?? [];
          const defaultTemplateId = templatesForDomain[0]?.id ?? null;
          const existing = forceReset ? undefined : current[domain];
          const keepTemplate = Boolean(
            existing?.templateId
            && templatesForDomain.some((template) => template.id === existing.templateId),
          );
          nextState[domain] = {
            templateId: keepTemplate ? existing?.templateId ?? null : defaultTemplateId,
            useCustomPrompt: existing?.useCustomPrompt ?? false,
            customPrompt: existing?.customPrompt ?? "",
          };
        }
        return nextState;
      });
    },
    [],
  );

  const refreshPromptTemplates = useCallback(async (): Promise<void> => {
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Authentication token is unavailable.");
      }
      const templatePayload = await getBenchmarkPromptTemplates(token);
      setTemplates(templatePayload);
      setTemplateError(null);
      syncDomainPromptSelection(templatePayload);
    } catch (error) {
      setTemplates(FALLBACK_PROMPT_TEMPLATES);
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        setTemplateError(`${error.message} Using built-in templates.`);
      } else {
        setTemplateError("Using built-in templates while prompt templates are unavailable.");
      }
      syncDomainPromptSelection(FALLBACK_PROMPT_TEMPLATES);
    }
  }, [getAccessToken, syncDomainPromptSelection]);

  const loadBenchmarkData = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setCatalogError(null);
    setTemplateError(null);

    const token = await getAccessToken();
    const benchmarkPayload = await getBenchmarks(token);
    setBenchmarks(benchmarkPayload);

    try {
      const catalogPayload = await getBenchmarkCatalog(token, 100);
      setCatalog(catalogPayload);
      setCatalogError(null);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        setCatalog(null);
        setCatalogError(error.message);
      } else {
        setCatalog(null);
        setCatalogError("Benchmark catalog is temporarily unavailable.");
      }
    }

    await refreshPromptTemplates();
  }, [getAccessToken, refreshPromptTemplates]);

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
    return BENCHMARK_MECHANISMS.map((mechanism) => {
      const metrics = normalizedSummary.per_mode[mechanism] ?? {};
      const avgEstimatedCost = asNumber(metrics.avg_estimated_cost_usd);
      const avgTokens = asNumber(metrics.avg_tokens);
      const estimatedCost = avgEstimatedCost > 0 ? avgEstimatedCost : avgTokens * DEFAULT_FALLBACK_USD_PER_TOKEN;
      return {
        mechanism: titleCase(mechanism),
        estimatedCostUsd: Number(estimatedCost.toFixed(6)),
      };
    });
  }, [normalizedSummary]);

  const yourEntries = useMemo(() => {
    if (!catalog) {
      return [];
    }
    return (yourSortMode === "recent" ? catalog.user_recent : catalog.user_frequency).slice(0, 3);
  }, [catalog, yourSortMode]);

  const globalEntries = useMemo(() => {
    if (!catalog) {
      return [];
    }
    return (globalSortMode === "recent" ? catalog.global_recent : catalog.global_frequency).slice(0, 3);
  }, [catalog, globalSortMode]);

  const getResolvedPrompt = useCallback(
    (domain: BenchmarkDomainName, selection: DomainPromptSelection): string => {
      if (selection.useCustomPrompt && selection.customPrompt.trim().length > 0) {
        return selection.customPrompt.trim();
      }
      const templatesForDomain = templates?.domains?.[domain] ?? [];
      const selected = templatesForDomain.find((template) => template.id === selection.templateId);
      return selected?.prompt ?? "";
    },
    [templates],
  );

  const runPayloadPreview = useMemo(() => {
    const domainPrompts: Partial<Record<BenchmarkDomainName, BenchmarkDomainPromptPayload>> = {};
    for (const domain of BENCHMARK_DOMAINS) {
      const selection = domainPromptSelection[domain];
      if (!selection) {
        continue;
      }
      const prompt = getResolvedPrompt(domain, selection);
      if (!prompt) {
        continue;
      }
      domainPrompts[domain] = {
        template_id: selection.useCustomPrompt ? "custom" : selection.templateId,
        prompt,
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
    getResolvedPrompt,
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
    if (Object.keys(domainPromptSelection).length === 0) {
      syncDomainPromptSelection(templates, true);
    }
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
      const existing = current[domain] ?? {
        templateId: templates?.domains?.[domain]?.[0]?.id ?? null,
        useCustomPrompt: false,
        customPrompt: "",
      };
      return {
        ...current,
        [domain]: updater(existing),
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
      const customPrompt = selection.customPrompt.trim();
      if (selection.useCustomPrompt) {
        state[domain] = {
          complete: customPrompt.length > 0,
          label: customPrompt.length > 0 ? "Custom" : "Needs prompt",
        };
        continue;
      }
      const template = (templates.domains[domain] ?? []).find((item) => item.id === selection.templateId);
      state[domain] = {
        complete: Boolean(template),
        label: template?.title ?? "Select template",
      };
    }
    return state;
  }, [domainPromptSelection, templates.domains]);

  const allDomainsConfigured = BENCHMARK_DOMAINS.every((domain) => domainStatus[domain].complete);

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
                    <Bar dataKey="estimatedCostUsd" name="Estimated USD" fill="var(--color-text-primary)" radius={[4, 4, 0, 0]} />
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
                Configure benchmark prompts per domain, trigger a run, and persist rich artifacts in global and user-specific cloud paths.
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
                    Open Live View
                  </button>
                </div>
              )}
              {activeBenchmarkRun.error ? <div className="mono text-xs text-red-300 mt-2">{activeBenchmarkRun.error}</div> : null}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">No active benchmark run yet.</p>
          )}

          {runError ? <p className="text-sm text-red-300 mt-2">{runError}</p> : null}
          {templateError ? <p className="text-sm text-text-secondary mt-2">{templateError}</p> : null}
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
          ) : yourEntries.length === 0 ? (
            <p className="text-sm text-text-secondary">No user benchmark artifacts yet.</p>
          ) : (
            <div className="space-y-3">
              {yourEntries.map((entry) => (
                <BenchmarkCatalogCard
                  key={entry.artifact_id}
                  entry={entry}
                  onOpen={() => navigate(`/benchmarks/${entry.artifact_id}`)}
                />
              ))}
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
                <p className="text-sm text-text-secondary">Configure per-domain prompts, then launch a comprehensive run.</p>
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
                      <h4 className="text-sm font-semibold mb-1">{titleCase(wizardDomain)} Prompt</h4>
                      <p className="text-xs text-text-secondary">
                        Pick one template or switch this domain to a custom benchmark instruction.
                      </p>
                    </div>
                    <div className="inline-flex border border-border-subtle rounded-md overflow-hidden">
                      <button
                        type="button"
                        onClick={() => updateDomainSelection(wizardDomain, (existing) => ({ ...existing, useCustomPrompt: false }))}
                        className={`mono px-3 py-1.5 text-xs ${!domainPromptSelection[wizardDomain]?.useCustomPrompt ? "bg-accent-muted text-accent" : "text-text-secondary"}`}
                      >
                        Templates
                      </button>
                      <button
                        type="button"
                        onClick={() => updateDomainSelection(wizardDomain, (existing) => ({ ...existing, useCustomPrompt: true }))}
                        className={`mono px-3 py-1.5 text-xs ${domainPromptSelection[wizardDomain]?.useCustomPrompt ? "bg-accent-muted text-accent" : "text-text-secondary"}`}
                      >
                        Custom
                      </button>
                    </div>
                  </div>

                  {!domainPromptSelection[wizardDomain]?.useCustomPrompt ? (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                      {(templates?.domains?.[wizardDomain] ?? []).map((template) => {
                        const current = domainPromptSelection[wizardDomain];
                        const active = current?.templateId === template.id;
                        return (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => updateDomainSelection(wizardDomain, (existing) => ({ ...existing, templateId: template.id, useCustomPrompt: false }))}
                            className={`text-left border rounded-md p-3 transition-colors ${
                              active ? "border-accent bg-accent-muted" : "border-border-subtle hover:border-accent"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3 mb-2">
                              <div className="mono text-xs text-text-muted">{template.title}</div>
                              {active ? <span className="mono text-[10px] text-accent">SELECTED</span> : null}
                            </div>
                            <div className="text-xs text-text-secondary whitespace-pre-wrap line-clamp-5">{template.prompt}</div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="mono text-xs text-text-muted">CUSTOM INSTRUCTION</div>
                      <textarea
                        value={domainPromptSelection[wizardDomain]?.customPrompt ?? ""}
                        onChange={(event) =>
                          updateDomainSelection(wizardDomain, (existing) => ({
                            ...existing,
                            customPrompt: event.target.value,
                            useCustomPrompt: true,
                          }))
                        }
                        placeholder={`Write the exact benchmark instruction for ${titleCase(wizardDomain)}.`}
                        rows={10}
                        className="w-full rounded-md border border-border-subtle bg-void px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
                      />
                    </div>
                  )}
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
                    const resolvedPrompt = getResolvedPrompt(domain, selection);
                    return (
                      <div key={domain} className="border border-border-subtle rounded-md p-3 bg-void">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm text-text-primary">{titleCase(domain)}</span>
                          <span className="mono text-xs text-text-muted">
                            {selection.useCustomPrompt ? "custom" : selection.templateId ?? "template"}
                          </span>
                        </div>
                        <p className="text-xs text-text-secondary whitespace-pre-wrap wrap-break-word line-clamp-4">
                          {resolvedPrompt || "No prompt selected."}
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
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-xs text-text-secondary mb-3">
        <div>Runs {formatInt(entry.run_count)}</div>
        <div>Agents {entry.agent_count ?? "n/a"}</div>
        <div>Tokens {formatInt(entry.total_tokens ?? 0)}</div>
        <div>Thinking {formatInt(entry.thinking_tokens ?? 0)}</div>
        <div>Cost {formatUsd(entry.cost?.estimated_cost_usd ?? null)}</div>
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

function deriveSummary(payload: BenchmarkPayload | null): BenchmarkSummary {
  const fallback = { per_mode: {}, per_category: {} } satisfies BenchmarkSummary;
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

function ensureCompleteSummary(summary: BenchmarkSummary): BenchmarkSummary {
  const perMode: Record<string, Record<string, number>> = {};
  for (const mechanism of BENCHMARK_MECHANISMS) {
    const metrics = summary.per_mode[mechanism] ?? {};
    perMode[mechanism] = {
      accuracy: asNumber(metrics.accuracy),
      avg_tokens: asNumber(metrics.avg_tokens),
      avg_latency_ms: asNumber(metrics.avg_latency_ms),
      avg_rounds: asNumber(metrics.avg_rounds),
      switch_rate: asNumber(metrics.switch_rate),
      avg_thinking_tokens: asNumber(metrics.avg_thinking_tokens),
      avg_estimated_cost_usd: asNumber(metrics.avg_estimated_cost_usd),
    };
  }

  const perCategory: Record<string, Record<string, Record<string, number>>> = {};
  const categories = new Set<string>(BENCHMARK_DOMAINS);
  Object.keys(summary.per_category).forEach((category) => categories.add(category));

  for (const category of categories) {
    perCategory[category] = {};
    for (const mechanism of BENCHMARK_MECHANISMS) {
      const metrics = summary.per_category[category]?.[mechanism] ?? {};
      perCategory[category][mechanism] = {
        accuracy: asNumber(metrics.accuracy),
        avg_tokens: asNumber(metrics.avg_tokens),
        avg_latency_ms: asNumber(metrics.avg_latency_ms),
        avg_thinking_tokens: asNumber(metrics.avg_thinking_tokens),
        avg_estimated_cost_usd: asNumber(metrics.avg_estimated_cost_usd),
      };
    }
  }

  return { per_mode: perMode, per_category: perCategory };
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
