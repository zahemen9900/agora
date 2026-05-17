import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import Markdown, { type Components } from "react-markdown";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  Code2,
  Coins,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Search,
  Wrench,
  ScrollText,
  TerminalSquare,
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
    @keyframes marquee {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
    .logs-marquee-strip:hover { animation-play-state: paused !important; }
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

import { CitationPill } from "../components/CitationPill";
import { ConvergenceMeter } from "../components/ConvergenceMeter";
import { Flyout } from "../components/Flyout";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { TaskActionsMenu } from "../components/task/TaskActionsMenu";
import { CanvasView } from "../components/task/canvas/CanvasView";
import {
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
import {
  appendTaskDetailEventCache,
  patchTaskDetailCache,
  removeDeletedTaskFromCaches,
  setTaskDetailCache,
  taskQueryKeys,
  useDeleteTaskMutation,
  useTaskDetailQuery,
  useStopTaskMutation,
} from "../lib/taskQueries";
import { TASK_STOPPED_REASON, canDeleteTask, canStopTask, isTaskActiveStatus, isTaskStopped, isTaskStopping } from "../lib/taskState";
import {
  createSegmentInferenceState,
  inferSegmentedTaskEvent,
  inferSegmentedTaskEvents,
  type SegmentInferenceState,
} from "../lib/segmentTimeline";
import {
  mapTaskEvent,
  type FinalAnswerState,
  type TimelineEvent,
} from "../lib/deliberationTimeline";
import {
  buildTimelineStore,
  EMPTY_TIMELINE_STORE,
  materializeTimeline,
  mergeTimelineStore,
  type TimelineStore,
  upsertTimelineStore,
} from "../lib/liveTimelineStore";
import { computeVirtualWindow } from "../lib/liveTimelineVirtualWindow";
import { usePostHog } from "@posthog/react";
import { Button } from "../components/ui/Button";
import { openTaskSource } from "../lib/sourceAccess";

const LIVE_TAIL_EVENT_COUNT = 12;
const LOGS_VIRTUALIZATION_THRESHOLD = 40;
const LOGS_OVERSCAN_PX = 900;
const PERF_EVENT_THRESHOLD_MS = 42;

function measureDevWork<T>(_label: string, work: () => T): { result: T; durationMs: number } {
  if (typeof performance === "undefined") {
    return { result: work(), durationMs: 0 };
  }

  const start = performance.now();
  const result = work();
  return {
    result,
    durationMs: performance.now() - start,
  };
}

function useTaskScopedState<T>(
  taskId: string | undefined,
  initialValue: T,
): [T, (value: SetStateAction<T>) => void] {
  const scopedTaskId = taskId ?? null;
  const initialValueRef = useRef(initialValue);
  initialValueRef.current = initialValue;
  const [state, setState] = useState<{ taskId: string | null; value: T }>(() => ({
    taskId: scopedTaskId,
    value: initialValue,
  }));

  const value = state.taskId === scopedTaskId ? state.value : initialValue;
  const setScopedState = useCallback((nextValue: SetStateAction<T>) => {
    setState((current) => {
      const currentValue = current.taskId === scopedTaskId
        ? current.value
        : initialValueRef.current;
      const resolvedValue = typeof nextValue === "function"
        ? (nextValue as (previous: T) => T)(currentValue)
        : nextValue;
      if (current.taskId === scopedTaskId && Object.is(current.value, resolvedValue)) {
        return current;
      }
      return {
        taskId: scopedTaskId,
        value: resolvedValue,
      };
    });
  }, [scopedTaskId]);

  return [value, setScopedState];
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

interface ConvergenceState {
  entropy: number;
  prevEntropy: number;
  infoGain: number;
  lockedClaims: Array<Record<string, unknown>>;
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

function convergenceMetrics(details: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(details.metrics);
  return nested ?? details;
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
  if (
    eventType === "tool_call_started"
    || eventType === "tool_call_delta"
    || eventType === "tool_call_completed"
    || eventType === "search_retrying"
    || eventType === "search_key_rotated"
    || eventType === "sandbox_execution_started"
    || eventType === "sandbox_execution_delta"
    || eventType === "sandbox_execution_completed"
  ) {
    return "border-l-sky-400";
  }
  if (eventType === "tool_call_failed") {
    return "border-l-red-400";
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
  if (eventType === "delphi_feedback") {
    return "border-l-fuchsia-400";
  }
  if (eventType === "delphi_finalize") {
    return "border-l-indigo-400";
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
  if (event.type === "delphi_feedback") {
    return "anonymous peer feedback";
  }
  if (event.type === "delphi_finalize") {
    return "Delphi finalization";
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
  if (event.type === "tool_call_started" || event.type === "tool_call_delta") {
    return "tool stream";
  }
  if (event.type === "search_retrying" || event.type === "search_key_rotated") {
    return "search retry state";
  }
  if (event.type === "tool_call_completed" || event.type === "sandbox_execution_completed") {
    return "tool result";
  }
  if (event.type === "tool_call_failed") {
    return "tool error";
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

function isToolTimelineEvent(event: TimelineEvent): boolean {
  return event.streamChannel === "tool";
}

function toolStatusLabel(status: TimelineEvent["toolStatus"]): string {
  if (status === "failed") return "FAILED";
  if (status === "retrying") return "RETRYING";
  if (status === "success") return "COMPLETE";
  return "RUNNING";
}

function toolStatusTone(status: TimelineEvent["toolStatus"]): string {
  if (status === "failed") return "border-danger/40 bg-danger/10 text-danger";
  if (status === "retrying") return "border-warning/40 bg-warning/10 text-warning";
  if (status === "success") return "border-accent/40 bg-accent/10 text-accent";
  return "border-sky-400/40 bg-sky-400/10 text-sky-300";
}

function toolIconForName(toolName: string | undefined): ReactNode {
  const normalized = (toolName ?? "").toLowerCase();
  if (normalized.includes("search")) {
    return <Search size={14} />;
  }
  if (normalized.includes("python")) {
    return <TerminalSquare size={14} />;
  }
  if (normalized.includes("url")) {
    return <ExternalLink size={14} />;
  }
  if (normalized.includes("file")) {
    return <FileText size={14} />;
  }
  return <Wrench size={14} />;
}

function toolDetailTitle(event: TimelineEvent): string {
  if (event.type === "tool_call_started") return "request envelope";
  if (event.type === "tool_call_delta" || event.type === "sandbox_execution_delta") return "live operation output";
  if (event.type === "tool_call_completed" || event.type === "sandbox_execution_completed") return "result payload";
  if (event.type === "tool_call_failed") return "failure payload";
  if (event.type === "tool_call_retrying" || event.type === "search_retrying" || event.type === "search_key_rotated") return "retry state";
  return "tool payload";
}

function ToolTimelineCard({
  entry,
  isActiveStream,
  usageLine,
  expanded,
  detailJson,
  onExpandedChange,
}: {
  entry: TimelineEvent;
  isActiveStream: boolean;
  usageLine: string | null;
  expanded: boolean;
  detailJson: string | null;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const statusLabel = toolStatusLabel(entry.toolStatus);
  const tone = toolStatusTone(entry.toolStatus);
  const toolLabel = entry.toolName
    ? entry.toolName.replace(/_/g, " ")
    : entry.title.replace(/^.*·\s*/, "");

  return (
    <div className="space-y-3">
      <div className={`rounded-2xl border ${tone} overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 border-b border-current/15 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-current/30 bg-black/10">
              {entry.toolStatus === "retrying"
                ? <RotateCcw size={14} />
                : entry.toolStatus === "failed"
                  ? <AlertTriangle size={14} />
                  : entry.toolStatus === "running"
                    ? <Loader2 size={14} className="animate-spin" />
                    : toolIconForName(entry.toolName)}
            </span>
            <div className="min-w-0">
              <div className="mono truncate text-[11px] uppercase tracking-[0.18em]">
                {toolLabel}
              </div>
              <div className="truncate text-[11px] text-current/80">
                {entry.agentId ?? "agent"} · {entry.stage?.replace(/_/g, " ") ?? "tool step"}
              </div>
            </div>
          </div>
          <span className="mono rounded-full border border-current/30 bg-black/10 px-2 py-1 text-[10px] tracking-[0.16em]">
            {statusLabel}
          </span>
        </div>

        <div className="px-3 py-3">
          {entry.isDraft ? (
            <StreamingText text={entry.summary} isActive={isActiveStream} />
          ) : (
            <MarkdownSummary>{entry.summary}</MarkdownSummary>
          )}
        </div>
      </div>

      <details className="overflow-hidden rounded-2xl border border-border-subtle bg-void/80">
        <summary
          className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5"
          onClick={(event) => {
            event.preventDefault();
            onExpandedChange(!expanded);
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
              {toolDetailTitle(entry)}
            </span>
            {usageLine ? (
              <span className="mono truncate text-[10px] text-text-muted">{usageLine}</span>
            ) : null}
          </div>
          <ChevronDown
            size={14}
            className="text-text-muted transition-transform duration-150"
            style={{ transform: expanded ? "rotate(180deg)" : undefined }}
          />
        </summary>
        {expanded ? (
          <div className="border-t border-border-subtle px-3 py-3">
            <div className="mb-3 overflow-hidden rounded-xl border border-border-subtle bg-surface/60">
              <div className="whitespace-nowrap px-3 py-2 [mask-image:linear-gradient(to_right,black_80%,transparent)]">
                <div
                  className="logs-marquee-strip mono inline-flex gap-8 text-[10px] uppercase tracking-[0.18em] text-text-muted"
                  style={{ animation: "marquee 18s linear infinite", minWidth: "max-content" }}
                >
                  <span>{toolLabel}</span>
                  <span>{statusLabel}</span>
                  <span>{entry.toolCallId ?? "ephemeral-call"}</span>
                  <span>{entry.timestamp ? formatTimestamp(entry.timestamp) : "timestamp n/a"}</span>
                  <span>{toolLabel}</span>
                  <span>{statusLabel}</span>
                </div>
              </div>
            </div>
            {detailJson ? (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-border-subtle bg-void p-3 mono text-[10px] text-text-secondary">
                {detailJson}
              </pre>
            ) : (
              <div className="text-sm text-text-secondary">No structured payload was persisted for this operation.</div>
            )}
          </div>
        ) : null}
      </details>
    </div>
  );
}

function LazyEventDetails({
  entry,
  expanded,
  detailJson,
  onExpandedChange,
}: {
  entry: TimelineEvent;
  expanded: boolean;
  detailJson: string | null;
  onExpandedChange: (expanded: boolean) => void;
}) {
  return (
    <details className="rounded-md border border-border-subtle bg-void p-2">
      <summary
        className="mono text-[11px] text-text-muted cursor-pointer select-none"
        onClick={(event) => {
          event.preventDefault();
          onExpandedChange(!expanded);
        }}
      >
        ▸ {detailLabelForEvent(entry)}
      </summary>
      {expanded ? (
        detailJson ? (
          <pre className="mono text-[10px] text-text-secondary whitespace-pre-wrap break-words mt-2">
            {detailJson}
          </pre>
        ) : (
          <div className="mt-2 text-xs text-text-secondary">No structured payload was persisted for this event.</div>
        )
      ) : null}
    </details>
  );
}

function combineRefs<T>(...refs: Array<((value: T | null) => void) | React.MutableRefObject<T | null> | undefined>) {
  return (value: T | null) => {
    for (const ref of refs) {
      if (!ref) {
        continue;
      }
      if (typeof ref === "function") {
        ref(value);
      } else {
        ref.current = value;
      }
    }
  };
}

function buildEventKey(event: TaskEvent): string {
  return `${event.event}:${event.timestamp ?? ""}:${JSON.stringify(event.data)}`;
}

function sortTaskEvents(events: TaskEvent[]): TaskEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const timestampA = Date.parse(a.event.timestamp ?? "");
      const timestampB = Date.parse(b.event.timestamp ?? "");
      const normalizedA = Number.isFinite(timestampA) ? timestampA : 0;
      const normalizedB = Number.isFinite(timestampB) ? timestampB : 0;
      if (normalizedA !== normalizedB) {
        return normalizedA - normalizedB;
      }
      return a.index - b.index;
    })
    .map(({ event }) => event);
}

function deriveTaskEvents(task: TaskStatusResponse): TaskEvent[] {
  const events = [...task.events];
  const hasEventType = (eventType: string) => events.some((event) => event.event === eventType);

  if (!hasEventType("mechanism_selected")) {
    events.push({
      event: "mechanism_selected",
      timestamp: task.created_at,
      data: {
        task_id: task.task_id,
        mechanism: task.mechanism,
        confidence: task.selector_confidence,
        reasoning: task.selector_reasoning,
        selector_reasoning_hash: task.selector_reasoning_hash,
        selector_source: task.selector_source,
        selector_fallback_path: task.selector_fallback_path,
        mechanism_override: task.mechanism_override,
        mechanism_override_source: task.mechanism_override_source,
        execution_segment: 0,
        segment_mechanism: task.mechanism,
      },
    });
  }

  if (!hasEventType("quorum_reached") && task.result) {
    events.push({
      event: "quorum_reached",
      timestamp: task.completed_at ?? task.created_at,
      data: {
        task_id: task.task_id,
        final_answer: task.result.final_answer,
        confidence: task.result.confidence,
        mechanism: task.result.mechanism,
        quorum_reached: task.result.quorum_reached,
      },
    });
  }

  if (task.result) {
    const mechanismTrace = Array.isArray(task.result.mechanism_trace) ? task.result.mechanism_trace : [];
    for (let index = 1; index < mechanismTrace.length; index += 1) {
      const previous = asRecord(mechanismTrace[index - 1]);
      const current = asRecord(mechanismTrace[index]);
      if (!previous || !current) {
        continue;
      }
      events.push({
        event: "mechanism_switch",
        timestamp: task.completed_at ?? task.created_at,
        data: {
          task_id: task.task_id,
          from_mechanism: safeString(previous.mechanism, task.mechanism),
          to_mechanism: safeString(current.mechanism, task.result.mechanism),
          reason: safeString(current.switch_reason, "switch recorded"),
          switch_reason: safeString(current.switch_reason, "switch recorded"),
          start_round: current.start_round,
          end_round: current.end_round,
          execution_segment: index - 1,
          segment_mechanism: safeString(previous.mechanism, task.mechanism),
          next_execution_segment: index,
          next_segment_mechanism: safeString(current.mechanism, task.result.mechanism),
        },
      });
    }

    const convergenceHistory = Array.isArray(task.result.convergence_history)
      ? task.result.convergence_history
      : [];
    for (const entry of convergenceHistory) {
      const metric = asRecord(entry);
      if (!metric) {
        continue;
      }
      const roundValue = Number(metric.round_number);
      const hasRound = Number.isFinite(roundValue);
      let segmentIndex = 0;
      let segmentMechanism: string = task.mechanism;
      if (hasRound) {
        for (let index = 0; index < mechanismTrace.length; index += 1) {
          const segment = asRecord(mechanismTrace[index]);
          if (!segment) {
            continue;
          }
          const startRound = Number(segment.start_round);
          const endRound = Number(segment.end_round);
          if (!Number.isFinite(startRound) || !Number.isFinite(endRound)) {
            continue;
          }
          if (roundValue >= startRound && roundValue <= endRound) {
            segmentIndex = index;
            segmentMechanism = safeString(segment.mechanism, segmentMechanism);
            break;
          }
        }
      }
      const convergenceData: Record<string, unknown> = {
        ...metric,
        execution_segment: segmentIndex,
        segment_mechanism: segmentMechanism,
      };
      if (hasRound) {
        convergenceData.segment_round = roundValue;
      }
      events.push({
        event: "convergence_update",
        timestamp: task.completed_at ?? task.created_at,
        data: convergenceData,
      });
    }
  }

  if (!hasEventType("receipt_committed") && task.solana_tx_hash) {
    events.push({
      event: "receipt_committed",
      timestamp: task.completed_at ?? task.created_at,
      data: {
        task_id: task.task_id,
        solana_tx_hash: task.solana_tx_hash,
        explorer_url: task.explorer_url,
      },
    });
  }

  if (!hasEventType("payment_released") && (task.payment_status === "released" || task.status === "paid")) {
    const paymentOperation = task.chain_operations.release_payment;
    events.push({
      event: "payment_released",
      timestamp: paymentOperation?.updated_at ?? task.completed_at ?? task.created_at,
      data: {
        task_id: task.task_id,
        tx_hash: paymentOperation?.tx_hash ?? task.solana_tx_hash,
        explorer_url: paymentOperation?.explorer_url ?? task.explorer_url,
      },
    });
  }

  if (!hasEventType("error") && !hasEventType("task_stopped") && task.status === "failed") {
    if (task.latest_error_event) {
      events.push(task.latest_error_event);
    } else if (task.failure_reason) {
      const stopped = task.failure_reason === TASK_STOPPED_REASON;
      events.push({
        event: stopped ? "task_stopped" : "error",
        timestamp: task.completed_at ?? task.created_at,
        data: {
          task_id: task.task_id,
          message: task.failure_reason,
          ...(stopped ? { status: "failed", stopped: true } : {}),
        },
      });
    }
  }

  return sortTaskEvents(events);
}

interface LiveTimelineListProps {
  timeline: TimelineEvent[];
  followLiveUpdates: boolean;
  latestTimelineEntryRef: React.RefObject<HTMLDivElement | null>;
}

const LiveTimelineList = memo(function LiveTimelineList({
  timeline,
  followLiveUpdates,
  latestTimelineEntryRef,
}: LiveTimelineListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const expandedKeysRef = useRef<Set<string>>(new Set());
  const detailJsonCacheRef = useRef<Map<string, string>>(new Map());
  const severeLagReportedRef = useRef<Set<string>>(new Set());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [viewportState, setViewportState] = useState(() => ({
    scrollY: typeof window === "undefined" ? 0 : window.scrollY,
    innerHeight: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const updateViewportState = () => {
      setViewportState({
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
      });
    };

    let frame = 0;
    const handleViewportChange = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateViewportState();
      });
    };

    updateViewportState();
    window.addEventListener("scroll", handleViewportChange, { passive: true });
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("scroll", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const setExpandedForKey = useCallback((key: string, expanded: boolean, details?: Record<string, unknown>) => {
    const { result, durationMs } = measureDevWork("timeline-detail-expand", () => {
      setExpandedKeys((current) => {
        const next = new Set(current);
        if (expanded) {
          next.add(key);
        } else {
          next.delete(key);
        }
        expandedKeysRef.current = next;
        return next;
      });

      if (expanded && details && !detailJsonCacheRef.current.has(key)) {
        detailJsonCacheRef.current.set(key, JSON.stringify(details, null, 2));
      }
    });

    void result;
    if (
      import.meta.env.DEV
      && durationMs > PERF_EVENT_THRESHOLD_MS
      && !severeLagReportedRef.current.has(`details:${key}`)
    ) {
      severeLagReportedRef.current.add(`details:${key}`);
      console.debug("[live-deliberation-perf] slow detail expansion", { key, durationMs });
    }
    setLayoutVersion((version) => version + 1);
  }, []);

  const registerRow = useCallback((key: string) => {
    return (node: HTMLDivElement | null) => {
      if (!node) {
        return;
      }

      const measuredHeight = Math.ceil(node.getBoundingClientRect().height);
      const previousHeight = rowHeightsRef.current.get(key);
      if (previousHeight !== measuredHeight) {
        rowHeightsRef.current.set(key, measuredHeight);
        setLayoutVersion((version) => version + 1);
      }
    };
  }, []);

  const virtualRange = useMemo(() => {
    if (timeline.length <= LOGS_VIRTUALIZATION_THRESHOLD || !containerRef.current) {
      return {
        startIndex: 0,
        endIndex: timeline.length - 1,
        topPadding: 0,
        bottomPadding: 0,
      };
    }

    const container = containerRef.current;
    const containerTop = (window.scrollY ?? 0) + container.getBoundingClientRect().top;
    const viewportTop = Math.max(0, viewportState.scrollY - containerTop);
    const baseRange = computeVirtualWindow(timeline, {
      viewportTop,
      viewportHeight: viewportState.innerHeight,
      overscanPx: LOGS_OVERSCAN_PX,
      measuredHeights: rowHeightsRef.current,
      expandedKeys,
    });

    if (!followLiveUpdates || timeline.length === 0) {
      return baseRange;
    }

    const tailStart = Math.max(0, timeline.length - LIVE_TAIL_EVENT_COUNT);
    const adjustedStartIndex = Math.min(baseRange.startIndex, tailStart);
    const adjustedEndIndex = Math.max(baseRange.endIndex, timeline.length - 1);
    let topPadding = 0;
    for (let index = 0; index < adjustedStartIndex; index += 1) {
      const event = timeline[index];
      topPadding += rowHeightsRef.current.get(event.key) ?? 188;
    }

    let bottomPadding = 0;
    for (let index = adjustedEndIndex + 1; index < timeline.length; index += 1) {
      const event = timeline[index];
      bottomPadding += rowHeightsRef.current.get(event.key) ?? 188;
    }

    return {
      startIndex: adjustedStartIndex,
      endIndex: adjustedEndIndex,
      topPadding,
      bottomPadding,
    };
  }, [expandedKeys, followLiveUpdates, layoutVersion, timeline, viewportState]);

  const visibleTimeline = useMemo(() => {
    if (virtualRange.endIndex < virtualRange.startIndex) {
      return [] as Array<{ entry: TimelineEvent; absoluteIndex: number }>;
    }
    return timeline
      .slice(virtualRange.startIndex, virtualRange.endIndex + 1)
      .map((entry, index) => ({
        entry,
        absoluteIndex: virtualRange.startIndex + index,
      }));
  }, [timeline, virtualRange.endIndex, virtualRange.startIndex]);

  return (
    <div ref={containerRef} className="space-y-3">
      {virtualRange.topPadding > 0 ? <div style={{ height: virtualRange.topPadding }} /> : null}
      {visibleTimeline.map(({ entry, absoluteIndex }) => {
        const isLatestEntry = absoluteIndex === timeline.length - 1;
        const isActiveStream = Boolean(entry.isDraft && isLatestEntry);
        const provider = providerFromModel(entry.agentModel ?? "");
        const usageLine = formatUsageLine(entry.details);
        const isTailAnimated = absoluteIndex >= Math.max(0, timeline.length - LIVE_TAIL_EVENT_COUNT);
        const detailJson = detailJsonCacheRef.current.get(entry.key) ?? null;
        const expanded = expandedKeys.has(entry.key);
        const rowRef = combineRefs<HTMLDivElement>(
          registerRow(entry.key),
          isLatestEntry ? latestTimelineEntryRef : undefined,
        );
        const rowClassName = `card p-4 border-l-4 ${eventCardTone(entry.type)}`;
        const rowStyle = isTailAnimated
          ? { willChange: "transform, opacity" }
          : { contentVisibility: "auto" as const, containIntrinsicSize: "240px" };

        const body = (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                {entry.type === "cross_examination" ? <Zap size={14} /> : null}
                {entry.type === "mechanism_switch" ? <ArrowRightLeft size={14} /> : null}
                {entry.type === "receipt_committed" ? <FileText size={14} /> : null}
                {isToolTimelineEvent(entry) ? (
                  entry.toolStatus === "failed" ? <AlertTriangle size={14} /> :
                  entry.toolStatus === "retrying" ? <RotateCcw size={14} /> :
                  entry.toolName?.includes("search") ? <Search size={14} /> :
                  entry.toolName?.includes("python") ? <TerminalSquare size={14} /> :
                  <Wrench size={14} />
                ) : null}
                <span className="mono text-xs text-text-muted uppercase tracking-wide">
                  {entry.title}
                </span>
                {entry.isDraft ? (
                  <span
                    className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 mono text-[10px] text-accent"
                    style={{
                      animation: isActiveStream ? "ld-cursor-blink 1.4s ease-in-out infinite" : "none",
                    }}
                  >
                    LIVE
                  </span>
                ) : null}
                {entry.agentModel ? (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${providerTone(provider)}`}
                  >
                    <ProviderGlyph provider={provider} size={13} />
                    <span className="mono text-[10px]">{entry.agentModel}</span>
                  </span>
                ) : null}
              </div>
              <span className="mono text-[10px] text-text-muted flex-shrink-0">
                {formatTimestamp(entry.timestamp)}
              </span>
            </div>

            {isToolTimelineEvent(entry) ? (
              <ToolTimelineCard
                entry={entry}
                isActiveStream={isActiveStream}
                usageLine={usageLine}
                expanded={expanded}
                detailJson={detailJson}
                onExpandedChange={(nextExpanded) => setExpandedForKey(entry.key, nextExpanded, entry.details)}
              />
            ) : (
              <>
                <div className="text-text-primary mb-2 break-words">
                  {entry.isDraft && isTailAnimated ? (
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
                  <LazyEventDetails
                    entry={entry}
                    expanded={expanded}
                    detailJson={detailJson}
                    onExpandedChange={(nextExpanded) => setExpandedForKey(entry.key, nextExpanded, entry.details)}
                  />
                ) : null}
              </>
            )}
          </>
        );

        if (!isTailAnimated) {
          return (
            <div
              key={entry.key}
              ref={rowRef}
              className={rowClassName}
              style={rowStyle}
            >
              {body}
            </div>
          );
        }

        return (
          <motion.div
            key={entry.key}
            ref={rowRef}
            initial={{ opacity: 0, y: 10, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className={rowClassName}
            style={rowStyle}
          >
            {body}
          </motion.div>
        );
      })}
      {virtualRange.bottomPadding > 0 ? <div style={{ height: virtualRange.bottomPadding }} /> : null}
    </div>
  );
});

export function LiveDeliberation() {
    const posthog = usePostHog();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const taskQuery = useTaskDetailQuery(taskId);

  const [activeTab, setActiveTab] = useState<"logs" | "canvas">("canvas");
  const [timelineStore, setTimelineStore] = useTaskScopedState<TimelineStore>(taskId, EMPTY_TIMELINE_STORE);
  const [switchBanner, setSwitchBanner] = useTaskScopedState<string | null>(taskId, null);
  const [retryNotice, setRetryNotice] = useTaskScopedState<string | null>(taskId, null);
  const [errorMessage, setErrorMessage] = useTaskScopedState<string | null>(taskId, null);
  const [stopMessage, setStopMessage] = useTaskScopedState<string | null>(taskId, null);
  const [convergence, setConvergence] = useTaskScopedState<ConvergenceState>(taskId, {
    entropy: 1.0,
    prevEntropy: 1.0,
    infoGain: 0.0,
    lockedClaims: [] as Array<Record<string, unknown>>,
  });
  const [finalAnswer, setFinalAnswer] = useTaskScopedState<FinalAnswerState | null>(taskId, null);
  const [showQuorumFlyout, setShowQuorumFlyout] = useTaskScopedState<boolean>(taskId, false);

  const seenEventKeysRef = useRef<Set<string>>(new Set());
  const taskMechanismRef = useRef("debate");
  const streamSegmentStateRef = useRef<SegmentInferenceState>(
    createSegmentInferenceState("debate"),
  );
  const latestTimelineEntryRef = useRef<HTMLDivElement | null>(null);
  const autoScrollStartedRef = useRef(false);
  const streamTaskIdRef = useRef<string | null>(null);
  const streamHandleRef = useRef<{ close: () => void } | null>(null);
  const historyRepairAttemptedRef = useRef<string | null>(null);
  const [followLiveUpdates, setFollowLiveUpdates] = useTaskScopedState<boolean>(taskId, true);
  const [taskActionError, setTaskActionError] = useTaskScopedState<string | null>(taskId, null);
  const [deleteFlyout, setDeleteFlyout] = useTaskScopedState<{ title: string; body: string } | null>(taskId, null);
  const task = taskQuery.data ?? null;
  const stopTaskMutation = useStopTaskMutation();
  const deleteTaskMutation = useDeleteTaskMutation();

  useEffect(() => {
    injectLdKeyframes();
  }, []);

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
  }, [setFollowLiveUpdates]);

  const handleStreamEvent = useCallback((event: TaskEvent) => {
    const eventWithTimestamp: TaskEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    const segmentedEvent = inferSegmentedTaskEvent(
      eventWithTimestamp,
      streamSegmentStateRef.current,
    );
    const eventKey = buildEventKey(segmentedEvent);
    if (seenEventKeysRef.current.has(eventKey)) {
      return;
    }
    seenEventKeysRef.current.add(eventKey);

    if (taskId) {
      appendTaskDetailEventCache(queryClient, taskId, segmentedEvent);
    }

    const mappedEvent = mapTaskEvent(segmentedEvent);
    const { durationMs } = measureDevWork("timeline-store-update", () => {
      startTransition(() => {
        setTimelineStore((current) => upsertTimelineStore(current, mappedEvent));
      });
    });
    if (import.meta.env.DEV && durationMs > PERF_EVENT_THRESHOLD_MS) {
      console.debug("[live-deliberation-perf] slow stream update", {
        eventType: segmentedEvent.event,
        durationMs,
        taskId,
      });
    }

    const data = asRecord(segmentedEvent.data) ?? {};

    if (segmentedEvent.event !== "provider_retrying") {
      setRetryNotice(null);
    }

    if (segmentedEvent.event === "provider_retrying") {
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

    if (segmentedEvent.event === "convergence_update") {
      const metrics = convergenceMetrics(data);
      setConvergence((current) => ({
        prevEntropy: current.entropy,
        entropy: Number(metrics.disagreement_entropy ?? current.entropy),
        infoGain: Number(metrics.information_gain_delta ?? 0),
        lockedClaims: Array.isArray(metrics.locked_claims)
          ? (metrics.locked_claims as Array<Record<string, unknown>>)
          : [],
      }));
      return;
    }

    if (segmentedEvent.event === "delphi_finalize") {
      const resolvedMechanism = safeString(data.mechanism, taskMechanismRef.current).toLowerCase();
      const mechanism = resolvedMechanism === "delphi" ? "delphi" : taskMechanismRef.current;
      taskMechanismRef.current = mechanism;
      setFinalAnswer({
        text: safeString(data.final_answer, ""),
        confidence: safeNumber(data.confidence, 0),
        mechanism,
      });
      return;
    }

    if (segmentedEvent.event === "mechanism_switch") {
      setSwitchBanner(
        `SWITCHING: ${String(data.from_mechanism).toUpperCase()} -> ${String(
          data.to_mechanism,
        ).toUpperCase()}`,
      );
      return;
    }

    if (segmentedEvent.event === "quorum_reached") {
      const resolvedMechanism = safeString(data.mechanism, taskMechanismRef.current).toLowerCase();
      const mechanism = resolvedMechanism === "vote" || resolvedMechanism === "delphi"
        ? resolvedMechanism
        : "debate";
      taskMechanismRef.current = mechanism;
      if (taskId) {
        patchTaskDetailCache(queryClient, taskId, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            status: "completed",
            mechanism,
            quorum_reached: true,
            result: current.result
              ? {
                ...current.result,
                final_answer: safeString(data.final_answer, current.result.final_answer),
                confidence: safeNumber(data.confidence, current.result.confidence),
                mechanism,
                quorum_reached: true,
              }
              : current.result,
          };
        });
      }
      setFinalAnswer({
        text: safeString(data.final_answer, ""),
        confidence: safeNumber(data.confidence, 0),
        mechanism,
      });
      setShowQuorumFlyout(true);
      return;
    }

    if (segmentedEvent.event === "error") {
      if (taskId) {
        patchTaskDetailCache(queryClient, taskId, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            status: "failed",
            failure_reason: safeString(data.message, current.failure_reason ?? ""),
            latest_error_event: segmentedEvent,
          };
        });
        void queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(taskId) });
      }
      setErrorMessage(safeString(data.message, "An error occurred"));
      setRetryNotice(null);
      return;
    }

    if (segmentedEvent.event === "task_stopped") {
      if (taskId) {
        patchTaskDetailCache(queryClient, taskId, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            status: "failed",
            failure_reason: safeString(data.message, current.failure_reason ?? TASK_STOPPED_REASON),
            latest_error_event: segmentedEvent,
          };
        });
        void queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(taskId) });
      }
      setStopMessage(safeString(data.message, TASK_STOPPED_REASON));
      setErrorMessage(null);
      setRetryNotice(null);
      return;
    }

    if (segmentedEvent.event === "complete" && taskId) {
      patchTaskDetailCache(queryClient, taskId, (current) => (
        current ? { ...current, status: "completed" } : current
      ));
      setRetryNotice(null);
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(taskId) });
    }
  }, [
    queryClient,
    setErrorMessage,
    setFinalAnswer,
    setShowQuorumFlyout,
    setRetryNotice,
    setSwitchBanner,
    taskId,
  ]);

  useEffect(() => {
    streamHandleRef.current?.close();
    streamHandleRef.current = null;
    streamTaskIdRef.current = null;
    historyRepairAttemptedRef.current = null;
    seenEventKeysRef.current = new Set();
    taskMechanismRef.current = "debate";
    streamSegmentStateRef.current = createSegmentInferenceState("debate");
    autoScrollStartedRef.current = false;
  }, [taskId]);

  useEffect(() => {
    if (!task) return;

    const taskEvents = deriveTaskEvents(task);
    const segmentState = createSegmentInferenceState(task.mechanism);
    const segmentedTaskEvents = inferSegmentedTaskEvents(
      taskEvents,
      task.mechanism,
      segmentState,
    );

    taskMechanismRef.current = task.mechanism;
    streamSegmentStateRef.current = segmentedTaskEvents.state;

    const mappedEvents = segmentedTaskEvents.events.map(mapTaskEvent);
    for (const persistedEvent of segmentedTaskEvents.events) {
      seenEventKeysRef.current.add(buildEventKey(persistedEvent));
    }

    setTimelineStore((current) => {
      const hydratedStore = buildTimelineStore(mappedEvents);
      const liveEvents = materializeTimeline(current);
      return liveEvents.length > 0
        ? mergeTimelineStore(hydratedStore, liveEvents)
        : hydratedStore;
    });

    if (isTaskStopped(task)) {
      setStopMessage(task.failure_reason ?? TASK_STOPPED_REASON);
      setErrorMessage(null);
    }

    if (task.result) {
      setFinalAnswer({
        text: task.result.final_answer,
        confidence: task.result.confidence,
        mechanism: task.result.mechanism,
      });

      const convergenceHistory = Array.isArray(task.result.convergence_history)
        ? task.result.convergence_history
        : [];
      const latest = convergenceHistory.at(-1);
      const previous = convergenceHistory.length > 1 ? convergenceHistory.at(-2) : null;
      if (latest && typeof latest === "object" && !Array.isArray(latest)) {
        const latestMetrics = latest as Record<string, unknown>;
        const previousMetrics = previous && typeof previous === "object" && !Array.isArray(previous)
          ? (previous as Record<string, unknown>)
          : null;
        setConvergence({
          entropy: safeNumber(latestMetrics.disagreement_entropy, 1.0),
          prevEntropy: safeNumber(previousMetrics?.disagreement_entropy, safeNumber(latestMetrics.disagreement_entropy, 1.0)),
          infoGain: safeNumber(latestMetrics.information_gain_delta, 0),
          lockedClaims: Array.isArray(latestMetrics.locked_claims)
            ? (latestMetrics.locked_claims as Array<Record<string, unknown>>)
            : [],
        });
      }
    }
  }, [setConvergence, setFinalAnswer, setTimelineStore, task]);

  useEffect(() => {
    if (!taskId || !task) return;
    if (historyRepairAttemptedRef.current === taskId) return;

    const isSettled = task.status === "completed" || task.status === "failed" || task.status === "paid";
    if (!isSettled || task.events.length > 0 || !task.result || taskQuery.isFetching) {
      return;
    }

    historyRepairAttemptedRef.current = taskId;
    void taskQuery.refetch();
  }, [task, taskId, taskQuery]);

  useEffect(() => {
    if (!taskId || !task?.task_id) return;
    if (streamTaskIdRef.current === taskId) return;

    const resolvedTaskId = taskId;
    const cachedTask = queryClient.getQueryData<TaskStatusResponse>(
      taskQueryKeys.detail(resolvedTaskId),
    );
    const initialStatus = cachedTask?.status;
    if (initialStatus !== "pending" && initialStatus !== "in_progress") return;

    streamTaskIdRef.current = taskId;

    let cancelled = false;

    async function attachLiveStream() {
      const streamHandle = await streamDeliberation(resolvedTaskId, getAccessToken, (event) => {
        handleStreamEvent(event);
      });

      if (cancelled) {
        streamHandle.close();
        return;
      }
      streamHandleRef.current = streamHandle;

      const latestTask = queryClient.getQueryData<TaskStatusResponse>(
        taskQueryKeys.detail(resolvedTaskId),
      );
      const shouldStartRun = (latestTask?.status ?? initialStatus) === "pending";
      if (!shouldStartRun) {
        return;
      }

      const isPendingLocalByok = latestTask?.execution_source === "local_byok";
      if (isPendingLocalByok) {
        setRetryNotice(
          "This task is waiting for an ephemeral BYOK start. It will not auto-restart from the task page because your provider keys were never stored.",
        );
        return;
      }

      void (async () => {
        const runToken = await getAccessToken();
        const nextStatus = await startTaskRun(resolvedTaskId, runToken);
        if (cancelled) {
          return;
        }
        setTaskDetailCache(
          queryClient,
          nextStatus.status === "pending"
            ? { ...nextStatus, status: "in_progress" }
            : nextStatus,
        );
      })().catch((error: unknown) => {
        patchTaskDetailCache(queryClient, resolvedTaskId, (current) => (
          current ? { ...current, status: "failed" } : current
        ));
        setErrorMessage(error instanceof Error ? error.message : "Run failed");
      });
    }

    void attachLiveStream().catch((error: unknown) => {
      streamTaskIdRef.current = null;
      setErrorMessage(error instanceof Error ? error.message : "Failed to attach live stream");
    });

    return () => {
      cancelled = true;
      streamHandleRef.current?.close();
      streamHandleRef.current = null;
      if (streamTaskIdRef.current === resolvedTaskId) {
        streamTaskIdRef.current = null;
      }
    };
  }, [getAccessToken, handleStreamEvent, queryClient, setErrorMessage, setRetryNotice, task?.task_id, taskId]);

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

  const displayTimeline = useMemo<TimelineEvent[]>(() => {
    return materializeTimeline(timelineStore);
  }, [timelineStore]);
  const canvasTimeline = useMemo(() => (
    displayTimeline.filter((entry) => (
      entry.type === "mechanism_selected"
      || entry.type === "mechanism_switch"
      || entry.type === "agent_output"
      || entry.type === "agent_output_delta"
      || entry.type === "cross_examination"
      || entry.type === "cross_examination_delta"
      || entry.type === "thinking_delta"
      || entry.type === "tool_call_started"
      || entry.type === "tool_call_retrying"
      || entry.type === "tool_call_delta"
      || entry.type === "tool_call_completed"
      || entry.type === "tool_call_failed"
      || entry.type === "search_retrying"
      || entry.type === "search_key_rotated"
      || entry.type === "sandbox_execution_started"
      || entry.type === "sandbox_execution_delta"
      || entry.type === "sandbox_execution_completed"
      || entry.type === "convergence_update"
      || entry.type === "quorum_reached"
      || entry.type === "delphi_feedback"
      || entry.type === "delphi_finalize"
      || entry.type === "error"
      || entry.type === "task_stopped"
      || entry.type === "receipt_committed"
      || entry.type === "payment_released"
      || entry.type === "complete"
    ))
  ), [displayTimeline]);
  const deferredCanvasTimeline = useDeferredValue(canvasTimeline);
  const { streamErrorCount, retryCount } = useMemo(() => {
    let errors = 0;
    let retries = 0;
    for (const entry of displayTimeline) {
      if (entry.type === "error") {
        errors += 1;
      } else if (entry.type === "provider_retrying") {
        retries += 1;
      }
    }
    return { streamErrorCount: errors, retryCount: retries };
  }, [displayTimeline]);

  const taskResult = task?.result ?? null;
  const attachedTaskSources = taskResult?.sources?.length
    ? taskResult.sources
    : (task?.sources ?? []);
  const resolvedStopMessage = stopMessage ?? (
    task && isTaskStopped(task) ? (task.failure_reason ?? TASK_STOPPED_REASON) : null
  );
  const resolvedErrorMessage = (resolvedStopMessage ? null : errorMessage) ?? (
    taskQuery.error instanceof Error ? taskQuery.error.message : null
  );
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

  const handleOpenSource = useCallback(async (source: NonNullable<typeof attachedTaskSources>[number]) => {
    try {
      const token = await getAccessToken();
      await openTaskSource(source, token);
    } catch (error) {
      console.error("Failed to open attached source.", error);
      setTaskActionError(error instanceof Error ? error.message : "Failed to open attached source.");
    }
  }, [getAccessToken, setTaskActionError]);

  const taskStatus = task?.status ?? "pending";
  const isPendingLocalByok = taskStatus === "pending" && task?.execution_source === "local_byok";
  const taskIsStopping = task ? isTaskStopping(task) : false;
  const isTaskActive = !task?.result && isTaskActiveStatus(taskStatus);
  const taskActivityLabel = taskIsStopping
    ? "STOPPING TASK"
    : isPendingLocalByok
    ? "WAITING FOR BYOK START"
    : taskStatus === "pending"
      ? "QUEUEING RUN"
      : "RUNNING LIVE";
  const taskActivityCopy = taskIsStopping
    ? "A stop request is in flight. The backend is winding this task down and will finalize it as stopped."
    : isPendingLocalByok
    ? "This task was created for an ephemeral BYOK run. The dashboard will not auto-start it here because the provider keys were never persisted."
    : taskStatus === "pending"
      ? "We have the task and the stream is attached. The backend is spinning up the run now."
      : "The deliberation is still in flight. Fresh events should keep landing in the timeline below.";

  const handleStopTask = useCallback(async () => {
    if (!taskId || !task || stopTaskMutation.isPending) {
      return;
    }
    setTaskActionError(null);
    try {
      const stopped = await stopTaskMutation.mutateAsync(taskId);
      setTaskDetailCache(queryClient, stopped);
      if (stopped.failure_reason === TASK_STOPPED_REASON) {
        setStopMessage(TASK_STOPPED_REASON);
      }
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Failed to stop task.");
    }
  }, [queryClient, setStopMessage, setTaskActionError, stopTaskMutation, task, taskId]);

  const handleDeleteTask = useCallback(async () => {
    if (!taskId || !task || deleteTaskMutation.isPending) {
      return;
    }
    setTaskActionError(null);
    try {
      const deleted = await deleteTaskMutation.mutateAsync(taskId);
      removeDeletedTaskFromCaches(queryClient, deleted);
      navigate("/tasks", {
        state: {
          deletedTaskFlyout: {
            title: deleted.stopped_before_delete ? "Task stopped and deleted" : "Task deleted",
            body: deleted.stopped_before_delete
              ? "The live task was stopped and removed from your deliberation history."
              : "The task was removed from your deliberation history and receipt views.",
          },
        },
      });
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Failed to delete task.");
    }
  }, [deleteTaskMutation, navigate, queryClient, setTaskActionError, task, taskId]);

  useEffect(() => {
    if (!followLiveUpdates || displayTimeline.length === 0) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      latestTimelineEntryRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
      autoScrollStartedRef.current = true;
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [displayTimeline, followLiveUpdates]);

  return (
    <>
      <title>{taskId ? `Deliberation · ${taskId} — Agora` : "Live Deliberation — Agora"}</title>
      <meta
        name="description"
        content="Live multi-agent deliberation in progress. Track convergence, quorum signals, and the full reasoning transcript as they unfold."
      />
    <div className="relative">
      <Flyout
        show={showQuorumFlyout}
        variant="success"
        title="Quorum Reached"
        body="The agents have reached consensus. A final answer has been recorded."
        onDismiss={() => setShowQuorumFlyout(false)}
      />
      <Flyout
        show={deleteFlyout !== null}
        variant="success"
        title={deleteFlyout?.title ?? ""}
        body={deleteFlyout?.body}
        onDismiss={() => setDeleteFlyout(null)}
      />
      {/* ── Top bar: back button + tab switcher ─────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
        <button
          onClick={(e: any) => { posthog?.capture('livedeliberation_tasks_clicked'); const handler = () => navigate("/tasks"); if (typeof handler === 'function') (handler as any)(e); }}
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
              onClick={(e: any) => { posthog?.capture('livedeliberation_action_clicked'); const handler = () => setActiveTab(tab); if (typeof handler === 'function') (handler as any)(e); }}
              style={{ padding: "6px 18px", borderRadius: "7px", border: "none", cursor: "pointer", fontFamily: "'Commit Mono', monospace", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: activeTab === tab ? 700 : 400, background: activeTab === tab ? "var(--accent-emerald)" : "transparent", color: activeTab === tab ? "#000" : "var(--text-muted)", transition: "all 0.15s ease" }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                {tab === "canvas"
                  ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/><line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/></svg> Canvas</>
                  : <><ScrollText size={12} /> Logs</>
                }
              </span>
            </button>
          ))}
        </div>
        {task ? (
          <TaskActionsMenu
            canStop={canStopTask(task)}
            canDelete={canDeleteTask(task)}
            isRunning={isTaskActiveStatus(task.status)}
            isStopping={stopTaskMutation.isPending || isTaskStopping(task)}
            isDeleting={deleteTaskMutation.isPending}
            onStop={() => void handleStopTask()}
            onDelete={() => void handleDeleteTask()}
          />
        ) : null}
      </div>

      {/* ── Global banners (always visible regardless of tab) ──────────── */}
      <AnimatePresence>
        {retryNotice && !resolvedErrorMessage && (
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

      {resolvedStopMessage && (
        <div className="p-4 mb-6 border border-amber-300 rounded-lg bg-[rgba(255,214,102,0.08)] text-amber-300">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} />
            <span>{resolvedStopMessage}</span>
          </div>
        </div>
      )}

      {(resolvedErrorMessage || taskActionError) && (
        <div className="p-4 mb-6 border border-danger rounded-lg bg-[rgba(255,93,93,0.08)] text-danger">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} />
            <span>{resolvedErrorMessage ?? taskActionError}</span>
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
              {displayTimeline.length > 0 ? `${displayTimeline.length} events captured` : "waiting for first event"}
              </div>
          </div>
        </div>
      ) : null}

      {attachedTaskSources.length > 0 ? (
        <div className="mb-6 rounded-xl border border-border-subtle bg-panel px-4 py-3 flex items-center gap-4">
          {/* Left: label */}
          <div className="shrink-0">
            <div className="mono text-[11px] tracking-[0.12em] text-text-muted">ATTACHED SOURCES</div>
            <div className="text-xs text-text-secondary mt-0.5">
              {attachedTaskSources.length} file{attachedTaskSources.length === 1 ? "" : "s"}
            </div>
          </div>
          {/* Divider */}
          <div className="w-px self-stretch bg-border-subtle shrink-0" />
          {/* Right: cards */}
          <div className="flex gap-3 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
            {attachedTaskSources.map((source) => {
              const isUrl    = source.kind === "url";
              const isPdf    = source.kind === "pdf" || source.mime_type?.includes("pdf");
              const isImage  = source.kind === "image" || source.mime_type?.startsWith("image/");
              const isCode   = source.kind === "code_file";
              const Icon     = isUrl ? Globe : isPdf ? FileText : isImage ? ImageIcon : isCode ? Code2 : FileText;
              const iconColor = isPdf ? "var(--accent-rose)" : isUrl ? "var(--text-muted)" : "var(--accent-emerald)";
              const badge    = isPdf ? "PDF" : isUrl ? "URL" : isImage ? "IMG" : isCode ? "CODE" : source.kind.replace("_", " ").toUpperCase().slice(0, 4);
              return (
                <div
                  key={source.source_id}
                  style={{
                    flex: "0 0 auto",
                    borderRadius: "8px", border: "1px solid var(--border-default)",
                    background: "var(--bg-base)", position: "relative",
                    display: "flex", alignItems: "center", gap: "7px",
                    padding: "6px 32px 6px 8px",
                    transition: "border-color 0.15s ease",
                    maxWidth: "200px",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = `${iconColor}60`; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border-default)"; }}
                >
                  <Icon size={14} style={{ color: iconColor, flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: "'Commit Mono', monospace", fontSize: "10px",
                      color: "var(--text-primary)", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis",
                    }}>{source.display_name}</div>
                    <div style={{
                      fontFamily: "'Commit Mono', monospace", fontSize: "9px",
                      color: iconColor, letterSpacing: "0.06em",
                    }}>{badge}</div>
                  </div>
                  {/* Download button */}
                  <button
                    type="button"
                    onClick={() => void handleOpenSource(source)}
                    title={isUrl ? "Open URL" : "Download"}
                    style={{
                      position: "absolute", top: 0, right: 0, bottom: 0,
                      width: "28px", borderRadius: "0 8px 8px 0",
                      background: "transparent", border: "none",
                      borderLeft: "1px solid var(--border-default)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", color: "var(--text-muted)",
                      transition: "background 0.15s ease",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = `${iconColor}14`; (e.currentTarget as HTMLButtonElement).style.color = iconColor; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
                  >
                    <Download size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ── Canvas tab ───────────────────────────────────────────────────── */}
      {activeTab === "canvas" && (
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "14px", overflow: "hidden", minHeight: "600px", marginBottom: "32px", position: "relative" }}>
          <CanvasView
            timeline={deferredCanvasTimeline}
            finalAnswer={finalAnswer}
            taskId={taskId}
            taskText={task?.task_text ?? ""}
            mechanism={task?.mechanism ?? finalAnswer?.mechanism ?? "debate"}
            roundCount={task?.round_count || Math.max(1, convergence.lockedClaims.length)}
            eventCount={deferredCanvasTimeline.length}
            entropy={convergence.entropy}
            citationItems={taskResult?.citation_items ?? []}
            isLive={isTaskActive}
            liveLabel={taskActivityLabel}
            retryNotice={retryNotice}
            switchNotice={switchBanner}
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
                  <Button
                    className="flex items-center justify-center gap-2"
                    onClick={() => navigate(`/task/${taskId}/receipt`)} variant="primary" trackingEvent="livedeliberation_view_on_chain_receipt_rarr_clicked"
                  >
                    View On-Chain Receipt &rarr;
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {taskResult && (
            <>
              {/* ── Run Summary ──────────────────────────────────────────── */}
              <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 24px", marginBottom: "16px" }}>
                <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "14px" }}>RUN SUMMARY</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px" }}>
                  {([
                    { label: "TOTAL TOKENS",    value: String(taskResult.total_tokens_used) },
                    { label: "INPUT TOKENS",    value: formatMaybeInt(taskResult.input_tokens_used) },
                    { label: "OUTPUT TOKENS",   value: formatMaybeInt(taskResult.output_tokens_used) },
                    { label: "THINKING TOKENS", value: formatMaybeInt(taskResult.thinking_tokens_used) },
                    { label: "LATENCY",         value: `${taskResult.latency_ms.toFixed(0)} ms` },
                    { label: "SWITCHES",        value: String(taskResult.mechanism_switches) },
                    { label: "USD COST",        value: typeof taskResult.cost?.estimated_cost_usd === "number" ? `$${taskResult.cost.estimated_cost_usd.toFixed(6)}` : "n/a" },
                    { label: "PAYOUT (SOL)",    value: taskResult.payment_amount.toFixed(3) },
                  ] as const).map(({ label, value }) => (
                    <div key={label} style={{ borderRadius: "10px", border: "1px solid var(--border-default)", padding: "12px 14px", background: "var(--bg-base)" }}>
                      <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: "6px" }}>{label}</div>
                      <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "13px", color: "var(--text-primary)", fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Reasoning Presets ────────────────────────────────────── */}
              {taskResult.reasoning_presets ? (
                <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 24px", marginBottom: "16px" }}>
                  <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "12px" }}>REASONING PRESETS</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {reasoningPresetEntries.map(([providerKey, preset]) => (
                      <span key={providerKey} style={{ borderRadius: "999px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "4px 12px", fontFamily: "'Commit Mono', monospace", fontSize: "11px", color: "var(--text-secondary)" }}>
                        {providerKey.replace(/_/g, " ")}: {preset}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* ── Tool Usage ───────────────────────────────────────────── */}
              {taskResult.tool_usage_summary ? (
                <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 24px", marginBottom: "16px" }}>
                  <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "12px" }}>TOOL USAGE</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    <span style={{ borderRadius: "999px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "4px 12px", fontFamily: "'Commit Mono', monospace", fontSize: "11px", color: "var(--text-secondary)" }}>
                      {taskResult.tool_usage_summary.total_tool_calls} calls
                    </span>
                    <span style={{ borderRadius: "999px", border: "1px solid rgba(52,211,153,0.35)", background: "rgba(52,211,153,0.08)", padding: "4px 12px", fontFamily: "'Commit Mono', monospace", fontSize: "11px", color: "var(--accent-emerald)" }}>
                      {taskResult.tool_usage_summary.successful_tool_calls} successful
                    </span>
                    {taskResult.tool_usage_summary.failed_tool_calls > 0 && (
                      <span style={{ borderRadius: "999px", border: "1px solid rgba(251,113,133,0.35)", background: "rgba(251,113,133,0.08)", padding: "4px 12px", fontFamily: "'Commit Mono', monospace", fontSize: "11px", color: "#fb7185" }}>
                        {taskResult.tool_usage_summary.failed_tool_calls} failed
                      </span>
                    )}
                    {Object.entries(taskResult.tool_usage_summary.tool_counts).map(([toolName, count]) => (
                      <span key={toolName} style={{ borderRadius: "999px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "4px 12px", fontFamily: "'Commit Mono', monospace", fontSize: "11px", color: "var(--text-secondary)" }}>
                        {toolName}: {count}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* ── Attached Sources ─────────────────────────────────────── */}
              {attachedTaskSources.length > 0 ? (
                <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 24px", marginBottom: "16px" }}>
                  <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "12px" }}>ATTACHED SOURCES</div>
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    {attachedTaskSources.map((source) => {
                      const isUrl   = source.kind === "url";
                      const isPdf   = source.kind === "pdf" || source.mime_type?.includes("pdf");
                      const isImage = source.kind === "image" || source.mime_type?.startsWith("image/");
                      const isCode  = source.kind === "code_file";
                      const SrcIcon = isUrl ? Globe : isPdf ? FileText : isImage ? ImageIcon : isCode ? Code2 : FileText;
                      const iconColor = isPdf ? "var(--accent-rose)" : isUrl ? "var(--text-muted)" : "var(--accent-emerald)";
                      const badge   = isPdf ? "PDF" : isUrl ? "URL" : isImage ? "IMG" : isCode ? "CODE" : source.kind.replace("_", " ").toUpperCase().slice(0, 4);
                      return (
                        <div key={source.source_id} style={{ flex: "0 0 auto", borderRadius: "8px", border: "1px solid var(--border-default)", background: "var(--bg-base)", position: "relative", display: "flex", alignItems: "center", gap: "7px", padding: "6px 32px 6px 8px", maxWidth: "200px" }}>
                          <SrcIcon size={14} style={{ color: iconColor, flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{source.display_name}</div>
                            <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color: iconColor, letterSpacing: "0.06em" }}>{badge}</div>
                          </div>
                          <button type="button" onClick={() => void handleOpenSource(source)} title={isUrl ? "Open URL" : "Download"} style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: "28px", borderRadius: "0 8px 8px 0", background: "transparent", border: "none", borderLeft: "1px solid var(--border-default)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-muted)" }}>
                            <Download size={11} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* ── Evidence Trail ───────────────────────────────────────── */}
              {taskResult.evidence_items.length > 0 && (() => {
                const evItems = taskResult.evidence_items;
                const useMarquee = evItems.length >= 4;
                const EvidenceCard = ({ item, idx }: { item: typeof evItems[0]; idx: number }) => (
                  <div key={`${item.evidence_id}-${idx}`} style={{ width: "224px", flexShrink: 0, borderRadius: "10px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
                      <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color: "var(--accent-emerald)", background: "rgba(52,211,153,0.1)", borderRadius: "4px", padding: "1px 5px", letterSpacing: "0.06em" }}>{item.tool_name}</span>
                      <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color: "var(--text-muted)" }}>R{item.round_index}</span>
                    </div>
                    <p style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-secondary)", lineHeight: 1.6, margin: 0, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.summary}</p>
                  </div>
                );
                return (
                  <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 0", marginBottom: "16px", overflow: "hidden" }}>
                    <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "14px", paddingLeft: "24px" }}>EVIDENCE TRAIL</div>
                    {useMarquee ? (
                      <div style={{ position: "relative", overflow: "hidden" }}>
                        <div aria-hidden style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "48px", background: "linear-gradient(to right, var(--bg-elevated), transparent)", zIndex: 2, pointerEvents: "none" }} />
                        <div aria-hidden style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "48px", background: "linear-gradient(to left, var(--bg-elevated), transparent)", zIndex: 2, pointerEvents: "none" }} />
                        <div
                          className="logs-marquee-strip"
                          style={{ display: "flex", gap: "12px", width: "max-content", padding: "4px 24px", animation: `marquee ${Math.max(14, evItems.length * 7)}s linear infinite` }}
                        >
                          {[...evItems, ...evItems].map((item, i) => (
                            <EvidenceCard key={`${item.evidence_id}-${i}`} item={item} idx={i} />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: "12px", overflowX: "auto", padding: "4px 24px", scrollbarWidth: "none" }}>
                        {evItems.map((item, i) => (
                          <EvidenceCard key={`${item.evidence_id}-${i}`} item={item} idx={i} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── Citations — hover-reveal pills ───────────────────────── */}
              {taskResult.citation_items.length > 0 ? (
                <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 24px", marginBottom: "16px" }}>
                  <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "12px" }}>
                    CITATIONS <span style={{ opacity: 0.5, fontWeight: 400 }}>· hover to expand</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {taskResult.citation_items.map((item, index) => (
                      <CitationPill key={`${item.title}-${index}`} item={item} />
                    ))}
                  </div>
                </div>
              ) : null}

              {/* ── Model Telemetry ──────────────────────────────────────── */}
              {modelUsage.length > 0 && (
                <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 24px", marginBottom: "16px" }}>
                  <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "12px" }}>MODEL TELEMETRY</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {modelUsage.map((entry) => (
                      <div key={entry.model} className={`rounded-xl border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 ${providerTone(entry.provider)}`}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                          <ProviderGlyph provider={entry.provider} size={14} />
                          <span className="mono text-xs truncate">{entry.model}</span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)" }}>
                          <span>{entry.tokens !== null ? `${entry.tokens.toLocaleString()} tok` : "n/a"}</span>
                          <span style={{ opacity: 0.3 }}>·</span>
                          <span>{entry.inputTokens !== null ? entry.inputTokens.toLocaleString() : "n/a"}/{entry.outputTokens !== null ? entry.outputTokens.toLocaleString() : "n/a"} in/out</span>
                          <span style={{ opacity: 0.3 }}>·</span>
                          <span>{entry.thinkingTokens !== null ? `${entry.thinkingTokens.toLocaleString()} thinking` : "—"}</span>
                          <span style={{ opacity: 0.3 }}>·</span>
                          <span>{entry.latencyMs !== null ? `${Math.round(entry.latencyMs)} ms` : "n/a"}</span>
                          <span style={{ opacity: 0.3 }}>·</span>
                          <span>${entry.usdCost !== null ? entry.usdCost.toFixed(6) : "n/a"}</span>
                          <span style={{ opacity: 0.3 }}>·</span>
                          <span style={{ display: "flex", alignItems: "center", gap: "3px" }}><Coins size={10} />{entry.solPayout.toFixed(4)} SOL</span>
                          <span style={{ opacity: 0.3 }}>·</span>
                          <span>{entry.estimationMode ?? "unavailable"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── On-Chain Receipt ─────────────────────────────────────── */}
              {task?.solana_tx_hash ? (
                <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)", borderRadius: "16px", padding: "20px 24px", marginBottom: "16px" }}>
                  <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: "10px" }}>ON-CHAIN RECEIPT</div>
                  <div style={{ borderRadius: "10px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "12px 14px" }}>
                    <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color: "var(--text-muted)", letterSpacing: "0.06em", marginBottom: "6px" }}>$ solana tx</div>
                    <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "11px", color: "var(--accent-emerald)", wordBreak: "break-all", lineHeight: 1.6 }}>{task.solana_tx_hash}</div>
                  </div>
                </div>
              ) : null}
            </>
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
              <MetricTile label="Stream Errors" value={String(streamErrorCount)} />
              <MetricTile label="Retries Seen" value={String(retryCount)} />
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
        <LiveTimelineList
          timeline={displayTimeline}
          followLiveUpdates={followLiveUpdates}
          latestTimelineEntryRef={latestTimelineEntryRef}
        />
      </div>
        </> /* end Logs tab */
      )}

    </div>
    </>
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
