import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import Markdown, { type Components } from "react-markdown";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Coins,
  FileText,
  Loader2,
  Zap,
} from "lucide-react";

const LD_STYLE_ID = "ld-stream-keyframes";
function injectLdKeyframes() {
  if (typeof document === "undefined" || document.getElementById(LD_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = LD_STYLE_ID;
  s.textContent = `
    @keyframes ld-cursor-blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0; }
    }
    @keyframes ld-text-fade {
      0%   { opacity: 0; }
      100% { opacity: 1; }
    }
  `;
  document.head.appendChild(s);
}

// Each token chunk that arrives from the stream gets its own fade-in span.
// The chunk starts at opacity 0 and fades to 1 over 400ms. Because chunks
// arrive at different moments, they are at different points in their fade
// simultaneously — creating overlapping waves of text materialising from
// invisible into full opacity, exactly like a fade-in effect on each token.
function StreamingText({ text, isActive }: { text: string; isActive: boolean }) {
  const seenLenRef = useRef(0);
  const [chunks, setChunks] = useState<Array<{ id: number; text: string }>>([]);
  const chunkIdRef = useRef(0);

  useEffect(() => {
    if (!isActive) {
      seenLenRef.current = text.length;
      return;
    }
    if (text.length <= seenLenRef.current) return;
    const delta = text.slice(seenLenRef.current);
    seenLenRef.current = text.length;
    const id = ++chunkIdRef.current;
    // Keep only the last 10 chunks in state; older ones are visually
    // indistinguishable from the stable prefix once their fade completes.
    setChunks((prev) => [...prev, { id, text: delta }].slice(-10));
  }, [text, isActive]);

  // Stable prefix = full text minus the text still held in chunks
  const keptLen = chunks.reduce((acc, c) => acc + c.text.length, 0);
  const stableText = text.slice(0, Math.max(0, text.length - keptLen));

  return (
    <span
      style={{
        fontFamily: "'Commit Mono', 'SF Mono', monospace",
        fontSize: '12px',
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        color: 'var(--text-secondary)',
      }}
    >
      {stableText}
      {chunks.map((chunk) => (
        <span
          key={chunk.id}
          style={{ animation: 'ld-text-fade 0.42s ease-in-out both' }}
        >
          {chunk.text}
        </span>
      ))}
    </span>
  );
}

import remarkGfm from "remark-gfm";

import { ConvergenceMeter } from "../components/ConvergenceMeter";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { CanvasView } from "../components/task/canvas/CanvasView";
import {
  getTask,
  startTaskRun,
  streamDeliberation,
  type TaskEvent,
  type TaskStatusResponse,
} from "../lib/api";
import { useAuth } from "../lib/useAuth";
import {
  providerFromModel,
  providerTone,
  type ProviderName,
} from "../lib/modelProviders";

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
  stage?: string;
  draftKey?: string;
  isDraft?: boolean;
}

interface ModelUsageSummary {
  model: string;
  provider: ProviderName;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  usdCost: number | null;
  solPayout: number;
  latencyMs: number | null;
  estimationMode: string | null;
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatMaybeInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }
  return Math.round(value).toLocaleString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function eventCardTone(eventType: string): string {
  if (eventType === "agent_output") {
    return "border-l-cyan-400";
  }
  if (eventType === "agent_output_delta") {
    return "border-l-cyan-400";
  }
  if (eventType === "cross_examination") {
    return "border-l-amber-400";
  }
  if (eventType === "cross_examination_delta") {
    return "border-l-amber-400";
  }
  if (eventType === "thinking_delta") {
    return "border-l-emerald-400";
  }
  if (eventType === "usage_delta") {
    return "border-l-violet-400";
  }
  if (eventType === "provider_retrying") {
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

function detailLabelForEvent(event: TimelineEvent): string {
  if (event.type === "mechanism_selected") {
    return "selection rationale";
  }
  if (event.type === "agent_output") {
    return "agent output metadata";
  }
  if (event.type === "agent_output_delta") {
    return "live draft payload";
  }
  if (event.type === "cross_examination") {
    return "cross-examination analysis";
  }
  if (event.type === "cross_examination_delta") {
    return "live cross-examination payload";
  }
  if (event.type === "convergence_update") {
    return "convergence metrics";
  }
  if (event.type === "mechanism_switch") {
    return "switch rationale";
  }
  if (event.type === "quorum_reached") {
    return "quorum evidence";
  }
  if (event.type === "receipt_committed") {
    return "receipt metadata";
  }
  if (event.type === "payment_released") {
    return "payment metadata";
  }
  if (event.type === "thinking_delta") {
    return "thinking stream";
  }
  if (event.type === "usage_delta") {
    return "usage telemetry";
  }
  if (event.type === "provider_retrying") {
    return "provider retry state";
  }
  if (event.type === "complete") {
    return "completion metadata";
  }
  if (event.type === "error") {
    return "error diagnostics";
  }

  const details = event.details ?? {};
  if ("reasoning" in details || "selector_reasoning_hash" in details) {
    return "reasoning trace";
  }
  return "event payload";
}

function formatUsageLine(details: Record<string, unknown> | undefined): string | null {
  if (!details) {
    return null;
  }

  const totalTokens = details.total_tokens;
  const inputTokens = details.input_tokens;
  const outputTokens = details.output_tokens;
  const thinkingTokens = details.thinking_tokens;
  const latencyMs = details.latency_ms;

  const hasAnyTokenInfo =
    typeof totalTokens === "number"
    || typeof inputTokens === "number"
    || typeof outputTokens === "number"
    || typeof thinkingTokens === "number"
    || typeof latencyMs === "number";

  if (!hasAnyTokenInfo) {
    return null;
  }

  const totalLabel = typeof totalTokens === "number" ? `${Math.round(totalTokens).toLocaleString()} tokens` : "tokens n/a";
  const splitLabel = `in ${typeof inputTokens === "number" ? Math.round(inputTokens).toLocaleString() : "n/a"}`
    + ` / out ${typeof outputTokens === "number" ? Math.round(outputTokens).toLocaleString() : "n/a"}`
    + ` / thinking ${typeof thinkingTokens === "number" ? Math.round(thinkingTokens).toLocaleString() : "n/a"}`;
  const latencyLabel = typeof latencyMs === "number" ? `${Math.round(latencyMs)} ms` : "latency n/a";

  return `${totalLabel} · ${splitLabel} · ${latencyLabel}`;
}

function mergeEventDetails(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!previous && !next) {
    return undefined;
  }
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  return { ...previous, ...next };
}

function upsertTimelineEvent(
  timeline: TimelineEvent[],
  nextEvent: TimelineEvent,
): TimelineEvent[] {
  const index = timeline.findIndex((entry) => entry.key === nextEvent.key);
  if (index === -1) {
    return [...timeline, nextEvent];
  }

  const previous = timeline[index];
  const merged: TimelineEvent = {
    ...previous,
    ...nextEvent,
    details: mergeEventDetails(previous.details, nextEvent.details),
  };
  return timeline.map((entry, entryIndex) => (entryIndex === index ? merged : entry));
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

function isNearDocumentBottom(threshold = 120): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  const scrollTop = window.scrollY ?? window.pageYOffset ?? 0;
  const viewportBottom = scrollTop + window.innerHeight;
  const documentBottom = document.documentElement.scrollHeight;
  return documentBottom - viewportBottom < threshold;
}

const markdownComponents = {
  p({ children }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return <h1 className="mb-2 text-lg font-semibold text-text-primary">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-2 text-base font-semibold text-text-primary">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-2 text-sm font-semibold text-text-primary">{children}</h3>;
  },
  ul({ children }) {
    return <ul className="mb-2 ml-5 list-disc space-y-1">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="mb-2 ml-5 list-decimal space-y-1">{children}</ol>;
  },
  li({ children }) {
    return <li className="break-words">{children}</li>;
  },
  blockquote({ children }) {
    return <blockquote className="mb-2 border-l-2 border-accent/40 pl-3 italic text-text-secondary">{children}</blockquote>;
  },
  strong({ children }) {
    return <strong className="font-semibold text-text-primary">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic text-text-primary/90">{children}</em>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
  code(props) {
    const { inline, className, children, ...rest } = props as {
      inline?: boolean;
      className?: string;
      children?: ReactNode;
    } & Record<string, unknown>;

    if (inline) {
      return (
        <code
          className="rounded bg-surface px-1.5 py-0.5 mono text-[0.85em] text-text-primary"
          {...rest}
        >
          {children}
        </code>
      );
    }

    return (
      <code className={`block whitespace-pre-wrap mono text-[10px] text-text-secondary ${className ?? ""}`} {...rest}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <pre className="mb-2 overflow-x-auto rounded-lg border border-border-subtle bg-void p-3">{children}</pre>;
  },
} satisfies Components;

function MarkdownSummary({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </Markdown>
  );
}

function buildEventKey(event: TaskEvent): string {
  return `${event.event}:${event.timestamp ?? ""}:${JSON.stringify(event.data)}`;
}

function draftKeyForEvent(event: TaskEvent): string | null {
  const data = asRecord(event.data) ?? {};
  const agentId = safeString(data.agent_id, "");
  const stage = safeString(data.stage, "");
  const roundNumber = Number.isFinite(Number(data.round_number)) ? Number(data.round_number) : NaN;
  if (!agentId || !stage || Number.isNaN(roundNumber)) {
    return null;
  }
  return `${agentId}:${stage}:${roundNumber}`;
}

function eventKeyForTimeline(event: TaskEvent): string {
  return draftKeyForEvent(event) ?? buildEventKey(event);
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
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${safeString(data.role, "agent")}`,
      summary: safeString(data.content, "Agent produced output"),
      timestamp: event.timestamp,
      details: asRecord(data.payload) ?? data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      confidence: safeNumber(data.confidence, 0),
      stage: safeString(data.stage, ""),
    };
  }

  if (event.event === "agent_output_delta") {
    const contentSoFar = safeString(data.content_so_far, safeString(data.content_delta, ""));
    const thinkingSoFar = safeString(data.thinking_so_far, "");
    return {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${safeString(data.stage, "stream")}`,
      summary: contentSoFar || thinkingSoFar || "Streaming draft",
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      confidence: safeNumber(data.confidence, 0),
      stage: safeString(data.stage, ""),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
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
      key: eventKeyForTimeline(event),
      type: event.event,
      title: "Devil's advocate",
      summary: summary || "Cross-examination issued",
      timestamp: event.timestamp,
      details: payload,
      agentId: safeString(data.agent_id, "devils-advocate"),
      agentModel: safeString(data.agent_model, ""),
      stage: safeString(data.stage, "cross_examination"),
    };
  }

  if (event.event === "cross_examination_delta") {
    const contentSoFar = safeString(data.content_so_far, safeString(data.content_delta, ""));
    const thinkingSoFar = safeString(data.thinking_so_far, "");
    return {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: "Devil's advocate",
      summary: contentSoFar || thinkingSoFar || "Cross-examination drafting",
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "devils-advocate"),
      agentModel: safeString(data.agent_model, ""),
      stage: safeString(data.stage, "cross_examination"),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
    };
  }

  if (event.event === "thinking_delta") {
    return {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · thinking`,
      summary: safeString(data.thinking_so_far, safeString(data.thinking_delta, "Thinking...")),
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      stage: safeString(data.stage, "thinking"),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
    };
  }

  if (event.event === "usage_delta") {
    const totalTokens = typeof data.total_tokens === "number" ? data.total_tokens : null;
    const inputTokens = data.input_tokens === null || data.input_tokens === undefined
      ? "n/a"
      : String(Math.round(safeNumber(data.input_tokens, 0)));
    const outputTokens = data.output_tokens === null || data.output_tokens === undefined
      ? "n/a"
      : String(Math.round(safeNumber(data.output_tokens, 0)));
    const thinkingTokens = data.thinking_tokens === null || data.thinking_tokens === undefined
      ? "n/a"
      : String(Math.round(safeNumber(data.thinking_tokens, 0)));
    const latency = safeNumber(data.latency_ms, 0);
    return {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · usage`,
      summary: `${totalTokens !== null ? `${Math.round(totalTokens).toLocaleString()} tokens` : "tokens n/a"} · ${Math.round(latency)} ms · ${inputTokens}/${outputTokens} in/out · ${thinkingTokens} thinking`,
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      stage: safeString(data.stage, "usage"),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
    };
  }

  if (event.event === "provider_retrying") {
    const provider = safeString(data.provider, "provider").toUpperCase();
    const model = safeString(data.model, "model");
    const attempt = safeNumber(data.attempt, 0);
    const maxRetries = safeNumber(data.max_retries, 0);
    const backoffSeconds = safeNumber(data.backoff_seconds, 0);
    const statusCode = typeof data.status_code === "number" ? ` · ${Math.round(data.status_code)}` : "";
    return {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${provider} retrying`,
      summary: `${model} retry in ${backoffSeconds.toFixed(1)}s (attempt ${attempt}/${maxRetries})${statusCode}`,
      timestamp: event.timestamp,
      details: data,
      agentModel: model,
      stage: "provider_retrying",
    };
  }

  if (event.event === "convergence_update") {
    const entropy = safeNumber(data.disagreement_entropy, 0);
    const novelty = safeNumber(data.information_gain_delta, 0);
    return {
      key: buildEventKey(event),
      type: event.event,
      title: `Convergence round ${safeNumber(data.round_number, 0)}`,
      summary: `Entropy ${entropy.toFixed(2)} · Novelty ${novelty.toFixed(2)}`,
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

  const [activeTab, setActiveTab] = useState<"logs" | "canvas">("canvas");
  const [task, setTask] = useState<TaskStatusResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [switchBanner, setSwitchBanner] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
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
  const taskMechanismRef = useRef("debate");
  const latestTimelineEntryRef = useRef<HTMLDivElement | null>(null);
  const autoScrollStartedRef = useRef(false);
  const [followLiveUpdates, setFollowLiveUpdates] = useState(true);

  useEffect(() => {
    injectLdKeyframes();
  }, []);

  useEffect(() => {
    autoScrollStartedRef.current = false;
    const resetFrame = window.requestAnimationFrame(() => {
      setFollowLiveUpdates(true);
    });
    return () => {
      window.cancelAnimationFrame(resetFrame);
    };
  }, [taskId]);

  useEffect(() => {
    const handleScroll = () => {
      const nearBottom = isNearDocumentBottom();
      if (nearBottom) {
        setFollowLiveUpdates(true);
        return;
      }

      if (autoScrollStartedRef.current) {
        setFollowLiveUpdates(false);
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  const setConvergenceFromEvents = useCallback((eventList: TaskEvent[]) => {
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
  }, []);

  const handleStreamEvent = useCallback((event: TaskEvent) => {
    const eventWithTimestamp: TaskEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    const eventKey = buildEventKey(eventWithTimestamp);
    if (seenEventKeysRef.current.has(eventKey)) {
      return;
    }
    seenEventKeysRef.current.add(eventKey);
    const mappedEvent = mapTaskEvent(eventWithTimestamp);
    setTimeline((current) => upsertTimelineEvent(current, mappedEvent));

    const data = asRecord(event.data) ?? {};

    if (event.event !== "provider_retrying") {
      setRetryNotice(null);
    }

    if (event.event === "provider_retrying") {
      const provider = safeString(data.provider, "Provider");
      const model = safeString(data.model, "model");
      const attempt = safeNumber(data.attempt, 0);
      const maxRetries = safeNumber(data.max_retries, 0);
      const backoffSeconds = safeNumber(data.backoff_seconds, 0);
      setRetryNotice(
        `${provider.toUpperCase()} retrying ${model} in ${backoffSeconds.toFixed(1)}s `
        + `(attempt ${attempt}/${maxRetries})`,
      );
      return;
    }

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
      const mechanism = safeString(data.mechanism, taskMechanismRef.current);
      taskMechanismRef.current = mechanism;
      setTask((current) => (current ? { ...current, status: "completed" } : current));
      setFinalAnswer({
        text: safeString(data.final_answer, ""),
        confidence: safeNumber(data.confidence, 0),
        mechanism,
      });
      return;
    }

    if (event.event === "error") {
      setTask((current) => (current ? { ...current, status: "failed" } : current));
      setErrorMessage(safeString(data.message, "An error occurred"));
      setRetryNotice(null);
      return;
    }

    if (event.event === "complete" && taskId) {
      setTask((current) => (current ? { ...current, status: "completed" } : current));
      setRetryNotice(null);
      const resolvedTaskId = taskId;
      void (async () => {
        const token = await getAccessToken();
        const status = await getTask(resolvedTaskId, token, true);
        taskMechanismRef.current = status.mechanism;
        setTask(status);
      })().catch(() => undefined);
    }
  }, [getAccessToken, taskId]);

  useEffect(() => {
    if (!taskId) return;
    const resolvedTaskId = taskId;

    let streamHandle: { close: () => void } | null = null;
    let cancelled = false;

    async function bootstrap() {
      const token = await getAccessToken();
      const status = await getTask(resolvedTaskId, token, true);
      if (cancelled) return;
      taskMechanismRef.current = status.mechanism;
      setTask(status);
      seenEventKeysRef.current = new Set();
      let hydratedTimeline: TimelineEvent[] = [];
      for (const persistedEvent of status.events) {
        const eventKey = buildEventKey(persistedEvent);
        if (seenEventKeysRef.current.has(eventKey)) {
          continue;
        }
        seenEventKeysRef.current.add(eventKey);
        hydratedTimeline = upsertTimelineEvent(hydratedTimeline, mapTaskEvent(persistedEvent));
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

      streamHandle = await streamDeliberation(resolvedTaskId, getAccessToken, (event) => {
        handleStreamEvent(event);
      });

      if (status.status === "pending") {
        void (async () => {
          const runToken = await getAccessToken();
          const nextStatus = await startTaskRun(resolvedTaskId, runToken);
          if (cancelled) {
            return;
          }
          setTask(
            nextStatus.status === "pending"
              ? { ...nextStatus, status: "in_progress" }
              : nextStatus,
          );
        })().catch((error: unknown) => {
          setTask((current) => (current ? { ...current, status: "failed" } : current));
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
  }, [getAccessToken, handleStreamEvent, setConvergenceFromEvents, taskId]);

  const modelUsage = useMemo<ModelUsageSummary[]>(() => {
    const result = task?.result;
    if (!result) {
      return [];
    }

    const backendTelemetry = result.model_telemetry ?? {};
    const backendPayouts = result.informational_model_payouts ?? {};
    const modelCandidates = result.agent_models_used.length > 0
      ? result.agent_models_used
      : Object.keys(backendTelemetry);

    if (modelCandidates.length === 0) {
      return [];
    }

    const totalPayout = Math.max(0, result.payment_amount ?? task?.payment_amount ?? 0);
    const payoutPerModel = modelCandidates.length > 0 ? totalPayout / modelCandidates.length : 0;

    return modelCandidates.map((model) => {
      const telemetry = backendTelemetry[model];
      const backendPayout = backendPayouts[model];
      const hasBackendPayout = typeof backendPayout === "number" && Number.isFinite(backendPayout);

      return {
        model,
        provider: providerFromModel(model),
        tokens: typeof telemetry?.total_tokens === "number" ? Math.max(0, telemetry.total_tokens) : null,
        inputTokens: typeof telemetry?.input_tokens === "number" ? Math.max(0, telemetry.input_tokens) : null,
        outputTokens: typeof telemetry?.output_tokens === "number" ? Math.max(0, telemetry.output_tokens) : null,
        thinkingTokens: typeof telemetry?.thinking_tokens === "number" ? Math.max(0, telemetry.thinking_tokens) : null,
        usdCost: typeof telemetry?.estimated_cost_usd === "number" ? Math.max(0, telemetry.estimated_cost_usd) : null,
        solPayout: hasBackendPayout ? Math.max(0, backendPayout) : payoutPerModel,
        latencyMs: typeof telemetry?.latency_ms === "number" ? Math.max(0, telemetry.latency_ms) : null,
        estimationMode: typeof telemetry?.estimation_mode === "string" ? telemetry.estimation_mode : null,
      };
    });
  }, [task]);

  const taskResult = task?.result ?? null;
  const mechanismTrace = taskResult?.mechanism_trace ?? [];
  const convergenceHistory = taskResult?.convergence_history ?? [];
  const lockedClaims = taskResult?.locked_claims ?? [];
  const fallbackEvents = taskResult?.fallback_events ?? [];
  const transcriptHashes = taskResult?.transcript_hashes ?? task?.transcript_hashes ?? [];
  const chainOperations = Object.entries(task?.chain_operations ?? {});
  const reasoningPresetEntries = taskResult?.reasoning_presets
    ? Object.entries(taskResult.reasoning_presets)
    : [];
  const latestConvergence = convergenceHistory[convergenceHistory.length - 1] ?? null;
  const previousConvergence = convergenceHistory.length > 1
    ? convergenceHistory[convergenceHistory.length - 2]
    : null;
  const deliberationStateLabel = latestConvergence
    ? describeDeliberationState(latestConvergence, previousConvergence)
    : "awaiting convergence data";
  const dominantAnswer = latestConvergence && typeof latestConvergence.dominant_answer_share === "number"
    ? `${Math.round(latestConvergence.dominant_answer_share * 100)}% dominant answer share`
    : "dominant answer share n/a";
  const transcriptIntegrityLabel = transcriptHashes.length > 0
    ? `${transcriptHashes.length.toLocaleString()} transcript hashes`
    : "no transcript hashes";
  const chainHealthLabel = chainOperations.length > 0
    ? summarizeChainHealth(chainOperations.map(([, operation]) => operation))
    : "no chain operations yet";
  const hotPathModel = dominantModelFromUsage(modelUsage);

  const taskStatus = task?.status ?? "pending";
  const isTaskActive = !task?.result && (taskStatus === "pending" || taskStatus === "in_progress");
  const taskActivityLabel = taskStatus === "pending" ? "QUEUEING RUN" : "RUNNING LIVE";
  const taskActivityCopy = taskStatus === "pending"
    ? "We have the task and the stream is attached. The backend is spinning up the run now."
    : "The deliberation is still in flight. Fresh events should keep landing in the timeline below.";

  useEffect(() => {
    if (!followLiveUpdates || timeline.length === 0) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      latestTimelineEntryRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
      autoScrollStartedRef.current = true;
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [followLiveUpdates, timeline]);

  return (
    <div className="relative">
      {/* ── Top bar: back button + tab switcher ─────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
        <button
          onClick={() => navigate("/tasks")}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "8px", background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", cursor: "pointer", fontFamily: "'Commit Mono', monospace", fontSize: "11px", color: "var(--text-muted)", transition: "all 0.15s ease" }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7.5 2L3 6l4.5 4" />
          </svg>
          Tasks
        </button>
        <div style={{ display: "flex", gap: "4px", padding: "4px", background: "var(--bg-elevated)", borderRadius: "10px", border: "1px solid var(--border-subtle)" }}>
          {(["canvas", "logs"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{ padding: "6px 18px", borderRadius: "7px", border: "none", cursor: "pointer", fontFamily: "'Commit Mono', monospace", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: activeTab === tab ? 700 : 400, background: activeTab === tab ? "var(--accent-emerald)" : "transparent", color: activeTab === tab ? "#000" : "var(--text-muted)", transition: "all 0.15s ease" }}
            >
              {tab === "canvas" ? "🗺 Canvas" : "📋 Logs"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Global banners (always visible regardless of tab) ──────────── */}
      <AnimatePresence>
        {retryNotice && !errorMessage && (
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="p-4 mb-6 border border-amber-400 rounded-lg bg-[rgba(255,184,76,0.08)] text-amber-400"
          >
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" />
              <span>{retryNotice}</span>
            </div>
          </motion.div>
        )}
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

      {isTaskActive ? (
        <div className="p-4 mb-6 border border-accent rounded-lg bg-[rgba(30,240,203,0.08)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Loader2 size={18} className="animate-spin text-accent" />
              <div>
                <div className="mono text-[11px] tracking-wide text-accent">{taskActivityLabel}</div>
                <div className="text-sm text-text-secondary">{taskActivityCopy}</div>
              </div>
            </div>
            <div className="rounded-full border border-accent/40 bg-accent/10 px-3 py-1 mono text-[11px] text-accent">
              {timeline.length > 0 ? `${timeline.length} events captured` : "waiting for first event"}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Canvas tab ───────────────────────────────────────────────────── */}
      {activeTab === "canvas" && (
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "14px", overflow: "hidden", minHeight: "600px", marginBottom: "32px", position: "relative" }}>
          <CanvasView
            timeline={timeline}
            finalAnswer={finalAnswer}
            taskId={taskId}
            taskText={task?.task_text ?? ""}
            mechanism={task?.mechanism ?? finalAnswer?.mechanism ?? "debate"}
            roundCount={task?.round_count || Math.max(1, convergence.lockedClaims.length)}
            eventCount={timeline.length}
            entropy={convergence.entropy}
          />
        </div>
      )}

      {/* ── Logs tab ─────────────────────────────────────────────────────── */}
      {activeTab === "logs" && (
        <>
          {/* Compact task header inside logs */}
          <div style={{ marginBottom: "20px", paddingBottom: "16px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", marginBottom: "6px", letterSpacing: "0.08em" }}>
              TASK {taskId} · {(task?.mechanism ?? "debate").toUpperCase()} ({((task?.selector_confidence ?? 0) * 100).toFixed(0)}%) · ROUND {task?.round_count || 1}
            </div>
            <div style={{ fontSize: "14px", color: "var(--text-primary)", fontWeight: 500, maxWidth: "680px", lineHeight: 1.5 }}>
              {task?.task_text ?? "Loading task…"}
            </div>
          </div>

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

          {taskResult && (
            <div className="card p-5 mb-8 border border-border-subtle">
          <div className="mono text-xs text-text-muted mb-3">RUN SUMMARY</div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-4">
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">TOTAL TOKENS</div>
              <div className="mono text-sm text-text-primary">{taskResult.total_tokens_used}</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">INPUT TOKENS</div>
              <div className="mono text-sm text-text-primary">{formatMaybeInt(taskResult.input_tokens_used)}</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">OUTPUT TOKENS</div>
              <div className="mono text-sm text-text-primary">{formatMaybeInt(taskResult.output_tokens_used)}</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">THINKING TOKENS</div>
              <div className="mono text-sm text-text-primary">{formatMaybeInt(taskResult.thinking_tokens_used)}</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">LATENCY</div>
              <div className="mono text-sm text-text-primary">{taskResult.latency_ms.toFixed(0)} ms</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">SWITCHES</div>
              <div className="mono text-sm text-text-primary">{taskResult.mechanism_switches}</div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">USD COST</div>
              <div className="mono text-sm text-text-primary">
                {typeof taskResult.cost?.estimated_cost_usd === "number"
                  ? `$${taskResult.cost.estimated_cost_usd.toFixed(6)}`
                  : "n/a"}
              </div>
            </div>
            <div className="rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">PAYOUT (SOL)</div>
              <div className="mono text-sm text-text-primary">{taskResult.payment_amount.toFixed(3)}</div>
            </div>
          </div>

          {taskResult.reasoning_presets ? (
            <div className="mb-4">
              <div className="mono text-[11px] text-text-muted mb-2">REASONING PRESETS</div>
              <div className="flex flex-wrap gap-2">
                {reasoningPresetEntries.map(([providerKey, preset]) => (
                  <span
                    key={providerKey}
                    className="rounded-full border border-border-subtle bg-void px-3 py-1 mono text-[11px] text-text-secondary"
                  >
                    {providerKey.replace(/_/g, " ")}: {preset}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

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
                      <ProviderGlyph provider={entry.provider} size={14} />
                      <span className="mono text-xs truncate">{entry.model}</span>
                    </div>
                    <div className="mono text-[11px] text-text-muted flex flex-wrap items-center gap-3">
                      <span>{entry.tokens !== null ? `${entry.tokens.toLocaleString()} tokens` : "n/a"}</span>
                      <span>
                        {entry.inputTokens !== null ? entry.inputTokens.toLocaleString() : "n/a"}
                        /
                        {entry.outputTokens !== null ? entry.outputTokens.toLocaleString() : "n/a"}
                        in/out
                      </span>
                      <span>{entry.thinkingTokens !== null ? `${entry.thinkingTokens.toLocaleString()} thinking` : "n/a thinking"}</span>
                      <span>{entry.latencyMs !== null ? `${Math.round(entry.latencyMs)} ms` : "n/a"}</span>
                      <span>${entry.usdCost !== null ? entry.usdCost.toFixed(6) : "n/a"}</span>
                      <span className="flex items-center gap-1">
                        <Coins size={12} />
                        {entry.solPayout.toFixed(4)} SOL
                      </span>
                      <span>{entry.estimationMode ?? "unavailable"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {task?.solana_tx_hash ? (
            <div className="mt-4 rounded-md border border-border-subtle p-3 bg-void">
              <div className="mono text-[10px] text-text-muted mb-1">ON-CHAIN RECEIPT</div>
              <div className="mono text-xs text-text-primary break-all">{task.solana_tx_hash}</div>
            </div>
          ) : null}
        </div>
      )}

      {taskResult ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
          <div className="card p-5 border border-border-subtle">
            <div className="mono text-xs text-text-muted mb-3">MECHANISM DECISION</div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <MetricTile label="Selector Source" value={taskResult.selector_source.replace(/_/g, " ")} />
              <MetricTile label="Execution Mode" value={taskResult.execution_mode.replace(/_/g, " ")} />
              <MetricTile label="Override Source" value={(taskResult.mechanism_override_source ?? "none").replace(/_/g, " ")} />
              <MetricTile label="Fallback Count" value={String(taskResult.fallback_count)} />
            </div>
            <div className="rounded-md border border-border-subtle bg-void p-3">
              <div className="mono text-[10px] text-text-muted mb-2">MECHANISM TRACE</div>
              {mechanismTrace.length === 0 ? (
                <div className="text-sm text-text-secondary">
                  Single-path execution. No mechanism trace segments were recorded.
                </div>
              ) : (
                <div className="space-y-3">
                  {mechanismTrace.map((segment, index) => (
                    <div key={`${String(segment.mechanism)}-${String(segment.start_round)}-${index}`} className="border border-border-subtle rounded-md p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <span className="badge">{String(segment.mechanism).toUpperCase()}</span>
                        <span className="mono text-[11px] text-text-muted">
                          rounds {String(segment.start_round)}-{String(segment.end_round)}
                        </span>
                      </div>
                      <div className="text-xs text-text-secondary">
                        {segment.switch_reason
                          ? `switch reason: ${String(segment.switch_reason)}`
                          : "no switch reason recorded for this segment"}
                      </div>
                      <div className="mono text-[10px] text-text-muted mt-2">
                        {Array.isArray(segment.transcript_hashes)
                          ? `${segment.transcript_hashes.length} transcript hashes`
                          : "transcript hashes n/a"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card p-5 border border-border-subtle">
            <div className="mono text-xs text-text-muted mb-3">VERIFICATION & CLAIMS</div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <MetricTile label="Transcript Integrity" value={transcriptIntegrityLabel} />
              <MetricTile label="Chain Health" value={chainHealthLabel} />
              <MetricTile label="Locked Claims" value={`${lockedClaims.length} verified`} />
              <MetricTile label="Hot Path" value={hotPathModel ?? "n/a"} />
            </div>
            <div className="space-y-3">
              <div className="rounded-md border border-border-subtle bg-void p-3">
                <div className="mono text-[10px] text-text-muted mb-2">LOCKED CLAIMS</div>
                {lockedClaims.length === 0 ? (
                  <div className="text-sm text-text-secondary">No locked claims were verified in this run.</div>
                ) : (
                  <div className="space-y-3">
                    {lockedClaims.map((claim, index) => (
                      <div key={`${String(claim.claim_hash ?? index)}`} className="border border-border-subtle rounded-md p-3">
                        <div className="text-sm text-text-primary mb-1">&quot;{String(claim.claim_text ?? "")}&quot;</div>
                        <div className="mono text-[10px] text-text-muted">
                          verified by {String(claim.verified_by ?? "Agora")} • round {String(claim.round_locked ?? "n/a")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="rounded-md border border-border-subtle bg-void p-3">
                <div className="mono text-[10px] text-text-muted mb-2">CHAIN OPERATIONS</div>
                {chainOperations.length === 0 ? (
                  <div className="text-sm text-text-secondary">No chain side effects have been recorded yet.</div>
                ) : (
                  <div className="space-y-2">
                    {chainOperations.map(([name, operation]) => (
                      <div key={name} className="flex flex-col gap-1 rounded-md border border-border-subtle p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-text-primary">{titleCase(name)}</span>
                          <span className={`badge ${chainOperationTone(operation.status)}`}>{operation.status}</span>
                        </div>
                        <div className="mono text-[10px] text-text-muted">
                          attempts {operation.attempts} • updated {formatTimestamp(operation.updated_at)}
                        </div>
                        {operation.error ? (
                          <div className="text-xs text-danger whitespace-pre-wrap break-words">{operation.error}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ConvergenceMeter
        entropy={convergence.entropy}
        prevEntropy={convergence.prevEntropy}
        novelty={convergence.infoGain}
        lockedClaims={convergence.lockedClaims.length}
      />

      {taskResult ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
          <div className="card p-5 border border-border-subtle">
            <div className="mono text-xs text-text-muted mb-3">DELIBERATION QUALITY</div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <MetricTile label="Current State" value={deliberationStateLabel} />
              <MetricTile label="Dominant Answer" value={dominantAnswer} />
              <MetricTile label="Novelty" value={latestConvergence ? formatFixed(latestConvergence.novelty_score) : "n/a"} />
              <MetricTile label="Answer Churn" value={latestConvergence ? formatFixed(latestConvergence.answer_churn) : "n/a"} />
            </div>
            {convergenceHistory.length === 0 ? (
              <div className="text-sm text-text-secondary">No round-by-round convergence history was captured.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-170 border-collapse">
                  <thead>
                    <tr className="border-b border-border-subtle">
                      <th className="py-2 pr-3 text-left mono text-[10px] text-text-muted">ROUND</th>
                      <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">ENTROPY</th>
                      <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">NOVELTY</th>
                      <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">CHURN</th>
                      <th className="py-2 pr-3 text-right mono text-[10px] text-text-muted">LOCKED</th>
                      <th className="py-2 text-right mono text-[10px] text-text-muted">DOMINANT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {convergenceHistory.map((entry) => (
                      <tr key={`round-${String(entry.round_number)}`} className="border-b border-border-subtle/70">
                        <td className="py-2 pr-3 mono text-[11px] text-text-secondary">{String(entry.round_number)}</td>
                        <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatFixed(entry.disagreement_entropy)}</td>
                        <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatFixed(entry.novelty_score ?? entry.information_gain_delta)}</td>
                        <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{formatFixed(entry.answer_churn)}</td>
                        <td className="py-2 pr-3 text-right mono text-[11px] text-text-primary">{String(entry.locked_claim_count ?? 0)}</td>
                        <td className="py-2 text-right mono text-[11px] text-text-primary">
                          {typeof entry.dominant_answer_share === "number"
                            ? `${Math.round(entry.dominant_answer_share * 100)}%`
                            : "n/a"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card p-5 border border-border-subtle">
            <div className="mono text-xs text-text-muted mb-3">RESILIENCE & DEGRADATION</div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <MetricTile label="Fallback Events" value={String(fallbackEvents.length)} />
              <MetricTile label="Stream Errors" value={String(timeline.filter((entry) => entry.type === "error").length)} />
              <MetricTile label="Retries Seen" value={String(timeline.filter((entry) => entry.type === "provider_retrying").length)} />
              <MetricTile label="Selector Override" value={(taskResult.mechanism_override_source ?? "none").replace(/_/g, " ")} />
            </div>
            {fallbackEvents.length === 0 ? (
              <div className="text-sm text-text-secondary">
                No runtime degradations were recorded. This run stayed on the intended path.
              </div>
            ) : (
              <div className="space-y-3">
                {fallbackEvents.map((event, index) => (
                  <div key={`${String(event.component)}-${String(event.timestamp ?? index)}`} className="rounded-md border border-border-subtle bg-void p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <span className="text-sm text-text-primary">{titleCase(String(event.component ?? "component"))}</span>
                      <span className="badge">{String(event.fallback_type ?? "deterministic")}</span>
                    </div>
                    <div className="text-xs text-text-secondary whitespace-pre-wrap break-words">
                      {String(event.reason ?? "No fallback reason recorded.")}
                    </div>
                    <div className="mono text-[10px] text-text-muted mt-2">
                      {formatTimestamp(typeof event.timestamp === "string" ? event.timestamp : null)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="mb-10">
        <h3 className="mono text-sm mb-4 text-accent tracking-widest">LIVE DELIBERATION TIMELINE</h3>
        <div className="space-y-3">
          {timeline.map((entry) => {
            const isLatestEntry = entry.key === timeline[timeline.length - 1]?.key;
            const isActiveStream = Boolean(entry.isDraft && isLatestEntry);
            const provider = providerFromModel(entry.agentModel ?? "");
            const usageLine = formatUsageLine(entry.details);
            return (
              <motion.div
                key={entry.key}
                ref={isLatestEntry ? latestTimelineEntryRef : undefined}
                layout
                initial={{ opacity: 0, y: 10, scale: 0.995 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className={`card p-4 border-l-4 ${eventCardTone(entry.type)}`}
                style={{ willChange: 'transform, opacity' }}
              >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    {entry.type === "cross_examination" ? <Zap size={14} /> : null}
                    {entry.type === "mechanism_switch" ? <ArrowRightLeft size={14} /> : null}
                    {entry.type === "receipt_committed" ? <FileText size={14} /> : null}
                    <span className="mono text-xs text-text-muted uppercase tracking-wide">
                      {entry.title}
                    </span>
                    {entry.isDraft ? (
                      <span
                        className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 mono text-[10px] text-accent"
                        style={{
                          animation: isActiveStream ? 'ld-cursor-blink 1.4s ease-in-out infinite' : 'none',
                        }}
                      >
                        LIVE
                      </span>
                    ) : null}
                    {entry.agentModel ? (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${providerTone(provider)}`}
                      >
                        <img
                          src={`/models/${provider}.png`}
                          alt={provider}
                          width={13}
                          height={13}
                          style={{ borderRadius: "2px", objectFit: "contain", flexShrink: 0 }}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                        <span className="mono text-[10px]">{entry.agentModel}</span>
                      </span>
                    ) : null}
                  </div>
                  <span className="mono text-[10px] text-text-muted flex-shrink-0">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                </div>

                {/* Summary / streaming body */}
                <div className="text-text-primary mb-2 break-words">
                  {entry.isDraft ? (
                    <StreamingText text={entry.summary} isActive={isActiveStream} />
                  ) : (
                    <MarkdownSummary>{entry.summary}</MarkdownSummary>
                  )}
                </div>

                {usageLine ? (
                  <div className="mono text-[11px] text-text-muted mb-2">
                    {usageLine}
                  </div>
                ) : null}

                {typeof entry.confidence === "number" ? (
                  <div className="mono text-[11px] text-text-muted mb-2">
                    confidence {(entry.confidence * 100).toFixed(1)}%
                  </div>
                ) : null}

                {entry.details ? (
                  <details className="rounded-md border border-border-subtle bg-void p-2">
                    <summary className="mono text-[11px] text-text-muted cursor-pointer select-none">
                      ▸ {detailLabelForEvent(entry)}
                    </summary>
                    <pre className="mono text-[10px] text-text-secondary whitespace-pre-wrap break-words mt-2">
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </motion.div>
            );
          })}
        </div>
      </div>
        </> /* end Logs tab */
      )}

    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-void p-3">
      <div className="mono text-[10px] text-text-muted mb-1">{label.toUpperCase()}</div>
      <div className="text-sm text-text-primary break-words">{value}</div>
    </div>
  );
}

function dominantModelFromUsage(entries: ModelUsageSummary[]): string | null {
  const sorted = [...entries].sort((left, right) => (right.tokens ?? 0) - (left.tokens ?? 0));
  return sorted[0]?.model ?? null;
}

function formatFixed(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function describeDeliberationState(
  latest: Record<string, unknown>,
  previous: Record<string, unknown> | null,
): string {
  const novelty = typeof latest.novelty_score === "number"
    ? latest.novelty_score
    : typeof latest.information_gain_delta === "number"
      ? latest.information_gain_delta
      : 0;
  const currentEntropy = typeof latest.disagreement_entropy === "number"
    ? latest.disagreement_entropy
    : 1;
  const previousEntropy = previous && typeof previous.disagreement_entropy === "number"
    ? previous.disagreement_entropy
    : currentEntropy;
  const lockedGrowth = typeof latest.locked_claim_growth === "number" ? latest.locked_claim_growth : 0;

  if (novelty >= 0.15 || lockedGrowth > 0) {
    return "still learning";
  }
  if (currentEntropy < previousEntropy) {
    return "converging";
  }
  if (currentEntropy > previousEntropy) {
    return "diverging";
  }
  return "plateaued";
}

function chainOperationTone(status: string): string {
  if (status === "succeeded") {
    return "bg-accent-muted text-accent border-accent";
  }
  if (status === "failed") {
    return "bg-danger/10 text-danger border-danger/40";
  }
  return "bg-warning/10 text-warning border-warning/40";
}

function summarizeChainHealth(operations: Array<{ status?: unknown }>): string {
  const failed = operations.filter((operation) => operation.status === "failed").length;
  const pending = operations.filter((operation) => operation.status === "pending").length;
  const succeeded = operations.filter((operation) => operation.status === "succeeded").length;
  if (failed > 0) {
    return `${failed} failed / ${succeeded} succeeded`;
  }
  if (pending > 0) {
    return `${pending} pending / ${succeeded} succeeded`;
  }
  if (succeeded > 0) {
    return `${succeeded} succeeded`;
  }
  return "no activity";
}
