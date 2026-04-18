import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  Brain,
  CheckCircle2,
  Coins,
  Cpu,
  FileText,
  Sparkles,
  Zap,
} from "lucide-react";

import { ConvergenceMeter } from "../components/ConvergenceMeter";
import { TypewriterText } from "../components/TypewriterText";
import {
  getTask,
  runTask,
  streamDeliberation,
  type TaskEvent,
  type TaskStatusResponse,
} from "../lib/api";
import { useAuth } from "../lib/auth";

type ProviderName = "gemini" | "claude" | "kimi" | "other";

interface TimelineEvent {
  key: string;
  type: string;
  title: string;
  summary: string;
  timestamp: string | null;
  details?: Record<string, unknown>;
  agentId?: string;
  agentModel?: string;
  confidence?: number;
}

interface ModelUsageSummary {
  model: string;
  provider: ProviderName;
  tokens: number;
  payout: number;
  estimated: boolean;
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function providerFromModel(model: string): ProviderName {
  const normalized = model.toLowerCase();
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("kimi") || normalized.includes("moonshot")) {
    return "kimi";
  }
  return "other";
}

function providerTone(provider: ProviderName): string {
  if (provider === "gemini") {
    return "text-cyan-300 border-cyan-500/40 bg-cyan-500/10";
  }
  if (provider === "claude") {
    return "text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-500/10";
  }
  if (provider === "kimi") {
    return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  }
  return "text-text-secondary border-border-muted bg-surface";
}

function ProviderGlyph({ provider }: { provider: ProviderName }) {
  if (provider === "gemini") {
    return <Sparkles size={14} />;
  }
  if (provider === "claude") {
    return <Bot size={14} />;
  }
  if (provider === "kimi") {
    return <Brain size={14} />;
  }
  return <Cpu size={14} />;
}

function eventCardTone(eventType: string): string {
  if (eventType === "agent_output") {
    return "border-l-cyan-400";
  }
  if (eventType === "cross_examination") {
    return "border-l-amber-400";
  }
  if (eventType === "convergence_update") {
    return "border-l-violet-400";
  }
  if (eventType === "mechanism_switch") {
    return "border-l-orange-400";
  }
  if (eventType === "quorum_reached") {
    return "border-l-emerald-400";
  }
  if (eventType === "receipt_committed" || eventType === "payment_released") {
    return "border-l-green-400";
  }
  if (eventType === "error") {
    return "border-l-red-400";
  }
  return "border-l-border-muted";
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "now";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleTimeString();
}

function buildEventKey(event: TaskEvent): string {
  return `${event.event}:${event.timestamp ?? ""}:${JSON.stringify(event.data)}`;
}

function mapTaskEvent(event: TaskEvent): TimelineEvent {
  const data = asRecord(event.data) ?? {};
  const fallbackSummary = JSON.stringify(data);

  if (event.event === "mechanism_selected") {
    const mechanism = safeString(data.mechanism, "unknown").toUpperCase();
    const confidence = safeNumber(data.confidence, 0);
    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Mechanism selected",
      summary: `${mechanism} selected (${(confidence * 100).toFixed(1)}% confidence)`,
      timestamp: event.timestamp,
      details: data,
      confidence,
    };
  }

  if (event.event === "agent_output") {
    return {
      key: buildEventKey(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${safeString(data.role, "agent")}`,
      summary: safeString(data.content, "Agent produced output"),
      timestamp: event.timestamp,
      details: asRecord(data.payload) ?? data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      confidence: safeNumber(data.confidence, 0),
    };
  }

  if (event.event === "cross_examination") {
    const payload = asRecord(data.payload) ?? {};
    const analyses = Array.isArray(payload.analyses) ? payload.analyses : [];
    const summary = analyses
      .map((item) => {
        const analysis = asRecord(item);
        if (!analysis) {
          return null;
        }
        const faction = safeString(analysis.faction, "faction");
        const question = safeString(analysis.question, "challenge issued");
        return `${faction}: ${question}`;
      })
      .filter((item): item is string => Boolean(item))
      .join(" | ");

    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Devil's advocate",
      summary: summary || "Cross-examination issued",
      timestamp: event.timestamp,
      details: payload,
      agentId: safeString(data.agent_id, "devils-advocate"),
      agentModel: safeString(data.agent_model, ""),
    };
  }

  if (event.event === "convergence_update") {
    const entropy = safeNumber(data.disagreement_entropy, 0);
    const infoGain = safeNumber(data.information_gain_delta, 0);
    return {
      key: buildEventKey(event),
      type: event.event,
      title: `Convergence round ${safeNumber(data.round_number, 0)}`,
      summary: `Entropy ${entropy.toFixed(2)} · Info gain ${infoGain.toFixed(2)}`,
      timestamp: event.timestamp,
      details: data,
    };
  }

  if (event.event === "mechanism_switch") {
    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Mechanism switch",
      summary: `${safeString(data.from_mechanism, "unknown")} -> ${safeString(data.to_mechanism, "unknown")}`,
      timestamp: event.timestamp,
      details: data,
    };
  }

  if (event.event === "quorum_reached") {
    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Quorum reached",
      summary: safeString(data.final_answer, "Consensus reached"),
      timestamp: event.timestamp,
      details: data,
      confidence: safeNumber(data.confidence, 0),
    };
  }

  if (event.event === "receipt_committed") {
    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Receipt committed",
      summary: safeString(data.solana_tx_hash, "On-chain receipt committed"),
      timestamp: event.timestamp,
      details: data,
    };
  }

  if (event.event === "payment_released") {
    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Payment released",
      summary: safeString(data.tx_hash, "Escrow released"),
      timestamp: event.timestamp,
      details: data,
    };
  }

  if (event.event === "complete") {
    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Execution complete",
      summary: safeString(data.status, "completed"),
      timestamp: event.timestamp,
      details: data,
    };
  }

  if (event.event === "error") {
    return {
      key: buildEventKey(event),
      type: event.event,
      title: "Stream error",
      summary: safeString(data.message, "Unknown stream error"),
      timestamp: event.timestamp,
      details: data,
    };
  }

  return {
    key: buildEventKey(event),
    type: event.event,
    title: event.event,
    summary: fallbackSummary,
    timestamp: event.timestamp,
    details: data,
  };
}

export function LiveDeliberation() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { getAccessToken } = useAuth();

  const [task, setTask] = useState<TaskStatusResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [switchBanner, setSwitchBanner] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [convergence, setConvergence] = useState({
    entropy: 1.0,
    prevEntropy: 1.0,
    infoGain: 0.0,
    lockedClaims: [] as Array<Record<string, unknown>>,
  });
  const [finalAnswer, setFinalAnswer] = useState<{
    text: string;
    confidence: number;
    mechanism: string;
  } | null>(null);

  const seenEventKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!taskId) return;
    const resolvedTaskId = taskId;

    let streamHandle: { close: () => void } | null = null;
    let cancelled = false;

    async function bootstrap() {
      const token = await getAccessToken();
      const status = await getTask(resolvedTaskId, token, true);
      if (cancelled) return;
      setTask(status);
      seenEventKeysRef.current = new Set();
      const hydratedTimeline: TimelineEvent[] = [];
      for (const persistedEvent of status.events) {
        const eventKey = buildEventKey(persistedEvent);
        if (seenEventKeysRef.current.has(eventKey)) {
          continue;
        }
        seenEventKeysRef.current.add(eventKey);
        hydratedTimeline.push(mapTaskEvent(persistedEvent));
      }
      setTimeline(hydratedTimeline);

      if (status.result) {
        setFinalAnswer({
          text: status.result.final_answer,
          confidence: status.result.confidence,
          mechanism: status.result.mechanism,
        });
      }
      setConvergenceFromEvents(status.events);

      streamHandle = await streamDeliberation(resolvedTaskId, token, (event) => {
        handleStreamEvent(event);
      });

      if (status.status === "pending") {
        void (async () => {
          const runToken = await getAccessToken();
          await runTask(resolvedTaskId, runToken);
        })().catch((error: unknown) => {
          setErrorMessage(error instanceof Error ? error.message : "Run failed");
        });
      }
    }

    void bootstrap().catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load task");
    });

    return () => {
      cancelled = true;
      streamHandle?.close();
    };
  }, [taskId, getAccessToken]);

  function handleStreamEvent(event: TaskEvent) {
    const eventWithTimestamp: TaskEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    const eventKey = buildEventKey(eventWithTimestamp);
    if (seenEventKeysRef.current.has(eventKey)) {
      return;
    }
    seenEventKeysRef.current.add(eventKey);
    setTimeline((current) => [...current, mapTaskEvent(eventWithTimestamp)]);

    const data = asRecord(event.data) ?? {};

    if (event.event === "convergence_update") {
      setConvergence((current) => ({
        prevEntropy: current.entropy,
        entropy: Number(data.disagreement_entropy ?? current.entropy),
        infoGain: Number(data.information_gain_delta ?? 0),
        lockedClaims: Array.isArray(data.locked_claims)
          ? (data.locked_claims as Array<Record<string, unknown>>)
          : [],
      }));
      return;
    }

    if (event.event === "mechanism_switch") {
      setSwitchBanner(
        `SWITCHING: ${String(data.from_mechanism).toUpperCase()} -> ${String(
          data.to_mechanism,
        ).toUpperCase()}`,
      );
      return;
    }

    if (event.event === "quorum_reached") {
      setFinalAnswer({
        text: safeString(data.final_answer, ""),
        confidence: safeNumber(data.confidence, 0),
        mechanism: safeString(data.mechanism, task?.mechanism ?? "debate"),
      });
      return;
    }

    if (event.event === "error") {
      setErrorMessage(safeString(data.message, "An error occurred"));
      return;
    }

    if (event.event === "complete" && taskId) {
      const resolvedTaskId = taskId;
      void (async () => {
        const token = await getAccessToken();
        const status = await getTask(resolvedTaskId, token, true);
        setTask(status);
      })().catch(() => undefined);
    }
  }

  function setConvergenceFromEvents(eventList: TaskEvent[]) {
    const latest = [...eventList].reverse().find((event) => event.event === "convergence_update");
    if (!latest) {
      return;
    }

    const data = latest.data as Record<string, unknown>;
    setConvergence({
      prevEntropy: Number(data.disagreement_entropy ?? 1),
      entropy: Number(data.disagreement_entropy ?? 1),
      infoGain: Number(data.information_gain_delta ?? 0),
      lockedClaims: Array.isArray(data.locked_claims)
        ? (data.locked_claims as Array<Record<string, unknown>>)
        : [],
    });
  }

  const modelUsage = useMemo<ModelUsageSummary[]>(() => {
    const result = task?.result;
    if (!result) {
      return [];
    }

    const backendTokenUsage = result.model_token_usage ?? {};
    const backendPayouts = result.informational_model_payouts ?? {};
    const modelCandidates = result.agent_models_used.length > 0
      ? result.agent_models_used
      : Object.keys(backendTokenUsage);

    if (modelCandidates.length === 0) {
      return [];
    }

    const totalTokens = Math.max(0, result.total_tokens_used);
    const perModelFloor = Math.floor(totalTokens / modelCandidates.length);
    const remainder = totalTokens % modelCandidates.length;

    const totalPayout = Math.max(0, result.payment_amount ?? task?.payment_amount ?? 0);
    const payoutPerModel = modelCandidates.length > 0 ? totalPayout / modelCandidates.length : 0;

    return modelCandidates.map((model, index) => {
      const backendTokens = backendTokenUsage[model];
      const hasBackendTokens = typeof backendTokens === "number" && Number.isFinite(backendTokens);
      const backendPayout = backendPayouts[model];
      const hasBackendPayout = typeof backendPayout === "number" && Number.isFinite(backendPayout);

      return {
        model,
        provider: providerFromModel(model),
        tokens: hasBackendTokens ? Math.max(0, backendTokens) : perModelFloor + (index < remainder ? 1 : 0),
        payout: hasBackendPayout ? Math.max(0, backendPayout) : payoutPerModel,
        estimated: !(hasBackendTokens && hasBackendPayout),
      };
    });
  }, [task]);

  return (
    <div className="relative">
      <header className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-border-subtle mb-8 gap-4 md:gap-0">
        <div>
          <div className="mono text-text-muted text-sm mb-2">TASK {taskId}</div>
          <h2 className="text-xl md:text-2xl max-w-200">{task?.task_text ?? "Loading task..."}</h2>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <span className="badge">
            {(task?.mechanism ?? finalAnswer?.mechanism ?? "debate").toUpperCase()} (
            {((task?.selector_confidence ?? 0) * 100).toFixed(0)}%)
          </span>
          <div className="mono flex items-center gap-2 text-text-secondary">
            ROUND {task?.round_count || Math.max(1, convergence.lockedClaims.length)}
          </div>
        </div>
      </header>

      <AnimatePresence>
        {switchBanner && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="p-4 mb-6 border border-warning rounded-lg bg-[rgba(255,184,76,0.08)] text-warning"
          >
            {switchBanner}
          </motion.div>
        )}
      </AnimatePresence>

      {errorMessage && (
        <div className="p-4 mb-6 border border-danger rounded-lg bg-[rgba(255,93,93,0.08)] text-danger">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} />
            <span>{errorMessage}</span>
          </div>
        </div>
      )}

      <AnimatePresence>
        {finalAnswer && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 bg-accent-muted border border-accent rounded-xl mb-8 shadow-glow"
          >
            <div className="flex items-center gap-3 mb-3 text-accent">
              <CheckCircle2 size={24} />
              <h3 className="text-accent text-lg">QUORUM REACHED</h3>
            </div>
            <p className="text-lg text-text-primary mb-4">{finalAnswer.text}</p>
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 sm:gap-0">
              <div className="mono text-accent">
                Confidence: {(finalAnswer.confidence * 100).toFixed(1)}%
              </div>
              <button
                className="btn-primary flex items-center justify-center gap-2"
                onClick={() => navigate(`/task/${taskId}/receipt`)}
              >
                View On-Chain Receipt &rarr;
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {task?.result && (
        <div className="card p-5 mb-8 border border-border-subtle">
          <div className="mono text-xs text-text-muted mb-3">RUN SUMMARY</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">TOTAL TOKENS</div>
              <div className="mono text-sm text-text-primary">{task.result.total_tokens_used}</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">LATENCY</div>
              <div className="mono text-sm text-text-primary">{task.result.latency_ms.toFixed(0)} ms</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">SWITCHES</div>
              <div className="mono text-sm text-text-primary">{task.result.mechanism_switches}</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">STAKES (SOL)</div>
              <div className="mono text-sm text-text-primary">{task.payment_amount.toFixed(3)}</div>
            </div>
          </div>

          {modelUsage.length > 0 && (
            <div>
              <div className="mono text-[11px] text-text-muted mb-2">
                MODEL TELEMETRY
              </div>
              <div className="space-y-2">
                {modelUsage.map((entry) => (
                  <div
                    key={entry.model}
                    className={`rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 ${providerTone(entry.provider)}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderGlyph provider={entry.provider} />
                      <span className="mono text-xs truncate">{entry.model}</span>
                    </div>
                    <div className="mono text-[11px] text-text-muted flex items-center gap-3">
                      <span>{entry.tokens} tokens</span>
                      <span className="flex items-center gap-1">
                        <Coins size={12} />
                        {entry.payout.toFixed(4)} SOL
                      </span>
                      {entry.estimated ? <span>estimated</span> : <span>measured</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {task.solana_tx_hash && (
            <div className="mt-4 rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">ON-CHAIN RECEIPT</div>
              <div className="mono text-xs text-text-primary break-all">{task.solana_tx_hash}</div>
            </div>
          )}
        </div>
      )}

      <ConvergenceMeter
        entropy={convergence.entropy}
        prevEntropy={convergence.prevEntropy}
        infoGain={convergence.infoGain}
        lockedClaims={convergence.lockedClaims.length}
      />

      <div className="mb-10">
        <h3 className="mono text-sm mb-4 text-accent tracking-widest">LIVE DELIBERATION TIMELINE</h3>
        <div className="space-y-3">
          {timeline.map((entry) => {
            const provider = providerFromModel(entry.agentModel ?? "");
            return (
              <motion.div
                key={entry.key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`card p-4 border-l-4 ${eventCardTone(entry.type)}`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {entry.type === "cross_examination" ? <Zap size={14} /> : null}
                    {entry.type === "mechanism_switch" ? <ArrowRightLeft size={14} /> : null}
                    {entry.type === "receipt_committed" ? <FileText size={14} /> : null}
                    <span className="mono text-xs text-text-muted uppercase tracking-wide">
                      {entry.title}
                    </span>
                    {entry.agentModel ? (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${providerTone(provider)}`}
                      >
                        <ProviderGlyph provider={provider} />
                        <span className="mono text-[10px]">{entry.agentModel}</span>
                      </span>
                    ) : null}
                  </div>
                  <span className="mono text-[10px] text-text-muted">{formatTimestamp(entry.timestamp)}</span>
                </div>

                <div className="text-text-primary mb-2">
                  <TypewriterText text={entry.summary} speed={8} />
                </div>

                {typeof entry.confidence === "number" ? (
                  <div className="mono text-[11px] text-text-muted mb-2">
                    confidence {(entry.confidence * 100).toFixed(1)}%
                  </div>
                ) : null}

                {entry.details ? (
                  <details className="rounded-md border border-border-subtle bg-void p-2">
                    <summary className="mono text-[11px] text-text-muted cursor-pointer">
                      reasoning trace
                    </summary>
                    <pre className="mono text-[10px] text-text-secondary whitespace-pre-wrap wrap-break-word mt-2">
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </motion.div>
            );
          })}
        </div>
      </div>

      {convergence.lockedClaims.length > 0 && (
        <div className="p-6 border border-border-subtle rounded-xl bg-surface">
          <h3 className="mono text-sm mb-4 text-accent">VERIFIED CLAIMS</h3>
          {convergence.lockedClaims.map((claim, index) => (
            <motion.div
              key={`${String(claim.claim_hash ?? index)}`}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex gap-3 items-start mb-4"
            >
              <CheckCircle2 className="text-accent shrink-0 mt-0.5" size={18} />
              <div>
                <p className="text-text-primary mb-1">&quot;{String(claim.claim_text ?? "")}&quot;</p>
                <p className="mono text-xs text-text-muted">
                  Verified by: {String(claim.verified_by ?? "Agora")}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
