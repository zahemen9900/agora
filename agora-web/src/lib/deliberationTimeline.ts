import type { TaskEvent } from "./api.generated";
import {
  inferSegmentedTaskEvents,
  segmentDraftKeyForEvent,
  segmentMetadataForTaskEvent,
} from "./segmentTimeline";

export interface TimelineEvent {
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
  segmentIndex?: number;
  segmentMechanism?: string;
  segmentRound?: number;
  canonicalStage?: string;
  displayPrimary?: string;
  displaySupport?: string;
  displayThinking?: string;
  rawText?: string;
  streamChannel?: "content" | "thinking" | "usage" | "system" | "tool";
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "running" | "success" | "failed" | "retrying";
}

export interface FinalAnswerState {
  text: string;
  confidence: number;
  mechanism: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function convergenceMetrics(data: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(data.metrics);
  return nested ?? data;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildDisplaySummary(
  primary?: string,
  support?: string,
  thinking?: string,
  fallback = "",
): string {
  if (primary && support) {
    return `${primary}\n${support}`;
  }
  if (primary) {
    return primary;
  }
  if (thinking) {
    return thinking;
  }
  return fallback;
}

interface StructuredDisplaySpec {
  primaryKeys: string[];
  supportKeys: string[];
}

function structuredDisplaySpec(eventType: string, stage: string): StructuredDisplaySpec {
  const normalizedStage = stage.trim().toLowerCase();
  if (eventType === "cross_examination" || eventType === "cross_examination_delta") {
    return {
      primaryKeys: ["question", "counterexample", "failure_mode", "weakest_claim"],
      supportKeys: ["flaw", "attack_axis"],
    };
  }
  if (normalizedStage === "opening" || normalizedStage === "initial" || normalizedStage === "independent_generation") {
    return {
      primaryKeys: ["claim", "answer", "current_answer", "final_answer"],
      supportKeys: ["evidence", "reasoning", "summary"],
    };
  }
  if (normalizedStage === "rebuttal" || normalizedStage === "revision_round") {
    return {
      primaryKeys: ["answer", "current_answer", "claim", "final_answer"],
      supportKeys: ["defense", "reasoning", "summary", "evidence"],
    };
  }
  if (normalizedStage === "final_synthesis" || normalizedStage === "finalize" || normalizedStage === "vote") {
    return {
      primaryKeys: ["final_answer", "answer", "claim", "current_answer"],
      supportKeys: ["summary", "reasoning", "defense", "evidence"],
    };
  }
  return {
    primaryKeys: ["final_answer", "answer", "claim", "current_answer", "question"],
    supportKeys: ["summary", "reasoning", "defense", "evidence", "counterexample"],
  };
}

function coerceJsonText(value: string): string {
  return cleanText(
    value
      .replace(/\\"/g, "\"")
      .replace(/\\n/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\\/g, "\\"),
  );
}

function findFirstLooseField(text: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)`, "i").exec(text);
    if (match?.[1]) {
      const normalized = coerceJsonText(match[1]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function extractStringCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = cleanText(value);
    return normalized || undefined;
  }
  return undefined;
}

function extractFromPayload(
  payload: unknown,
  keys: string[],
  supportKeys: Set<string>,
): string | undefined {
  if (typeof payload === "string") {
    return extractStringCandidate(payload);
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractFromPayload(item, keys, supportKeys);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const direct = extractStringCandidate(record[key]);
    if (direct) {
      return direct;
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (supportKeys.has(key)) {
      continue;
    }
    const nested = extractFromPayload(value, keys, supportKeys);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function parseStructuredText(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeStructuredText(
  text: string,
  options: { eventType: string; stage: string },
): { primary?: string; support?: string } {
  const { eventType, stage } = options;
  const spec = structuredDisplaySpec(eventType, stage);
  const parsed = parseStructuredText(text);
  if (parsed !== null) {
    const supportKeySet = new Set(spec.supportKeys);
    const primary = extractFromPayload(parsed, spec.primaryKeys, supportKeySet);
    const support = extractFromPayload(parsed, spec.supportKeys, new Set(spec.primaryKeys));
    return { primary, support };
  }

  const primary = findFirstLooseField(text, spec.primaryKeys);
  const support = findFirstLooseField(text, spec.supportKeys);
  return { primary, support };
}

function normalizeEventContent(
  rawText: string,
  options: { eventType: string; stage: string },
): { primary?: string; support?: string; rawText: string } {
  const { eventType, stage } = options;
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { rawText };
  }

  const looksStructured = trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes("\"");
  if (!looksStructured) {
    return { primary: cleanText(trimmed), rawText };
  }

  const normalized = normalizeStructuredText(trimmed, { eventType, stage });
  if (normalized.primary || normalized.support) {
    return { ...normalized, rawText };
  }

  return { rawText };
}

function buildEventKey(event: TaskEvent): string {
  return `${event.event}:${event.timestamp ?? ""}:${JSON.stringify(event.data)}`;
}

function eventKeyForTimeline(event: TaskEvent): string {
  return segmentDraftKeyForEvent(event) ?? buildEventKey(event);
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

export function upsertTimelineEvent(
  timeline: TimelineEvent[],
  nextEvent: TimelineEvent,
): TimelineEvent[] {
  const index = timeline.findIndex((entry) => entry.key === nextEvent.key);
  if (index === -1) {
    return [...timeline, nextEvent];
  }

  const previous = timeline[index];
  const preserveStructuredIdentity = Boolean(previous.displayPrimary) && nextEvent.streamChannel !== "content";
  const displayPrimary = nextEvent.displayPrimary || previous.displayPrimary;
  const displaySupport = nextEvent.displaySupport || previous.displaySupport;
  const displayThinking = nextEvent.displayThinking || previous.displayThinking;
  const merged: TimelineEvent = {
    ...(preserveStructuredIdentity ? previous : {}),
    ...previous,
    ...nextEvent,
    type: preserveStructuredIdentity ? previous.type : nextEvent.type,
    title: preserveStructuredIdentity ? previous.title : nextEvent.title,
    stage: preserveStructuredIdentity ? previous.stage : nextEvent.stage,
    canonicalStage: preserveStructuredIdentity
      ? previous.canonicalStage
      : nextEvent.canonicalStage,
    displayPrimary,
    displaySupport,
    displayThinking,
    rawText: nextEvent.rawText ?? previous.rawText,
    streamChannel: preserveStructuredIdentity
      ? previous.streamChannel ?? nextEvent.streamChannel
      : nextEvent.streamChannel ?? previous.streamChannel,
    summary: buildDisplaySummary(
      displayPrimary,
      displaySupport,
      displayThinking,
      preserveStructuredIdentity ? previous.summary : nextEvent.summary,
    ),
    details: mergeEventDetails(previous.details, nextEvent.details),
  };
  return timeline.map((entry, entryIndex) => (entryIndex === index ? merged : entry));
}

export function mapTaskEvent(event: TaskEvent): TimelineEvent {
  const data = asRecord(event.data) ?? {};
  const fallbackSummary = JSON.stringify(data);
  const segmentMetadata = segmentMetadataForTaskEvent(event);

  let mappedEvent: TimelineEvent;

  if (event.event === "mechanism_selected") {
    const mechanism = safeString(data.mechanism, "unknown").toUpperCase();
    const confidence = safeNumber(data.confidence, 0);
    const reasoning = safeString(data.reasoning, "");
    const selectionLine = `${mechanism} selected (${(confidence * 100).toFixed(1)}% confidence)`;
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Mechanism selected",
      summary: reasoning ? `${selectionLine}\n\n${reasoning}` : selectionLine,
      timestamp: event.timestamp,
      details: data,
      confidence,
      streamChannel: "system",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "agent_output") {
    const stage = safeString(data.stage, "");
    const rawText = safeString(data.content, "Agent produced output");
    const normalized = normalizeEventContent(rawText, {
      eventType: event.event,
      stage,
    });
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${safeString(data.role, "agent")}`,
      summary: buildDisplaySummary(
        normalized.primary,
        normalized.support,
        undefined,
        rawText,
      ),
      timestamp: event.timestamp,
      details: asRecord(data.payload) ?? data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      confidence: safeNumber(data.confidence, 0),
      stage,
      displayPrimary: normalized.primary,
      displaySupport: normalized.support,
      rawText,
      streamChannel: "content",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "agent_output_delta") {
    const contentSoFar = safeString(data.content_so_far, safeString(data.content_delta, ""));
    const thinkingSoFar = safeString(data.thinking_so_far, "");
    const stage = safeString(data.stage, "");
    const normalized = normalizeEventContent(contentSoFar, {
      eventType: event.event,
      stage,
    });
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${safeString(data.stage, "stream")}`,
      summary: buildDisplaySummary(
        normalized.primary,
        normalized.support,
        thinkingSoFar || undefined,
        contentSoFar || thinkingSoFar || "Streaming draft",
      ),
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      confidence: safeNumber(data.confidence, 0),
      stage,
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
      displayPrimary: normalized.primary,
      displaySupport: normalized.support,
      displayThinking: thinkingSoFar || undefined,
      rawText: contentSoFar,
      streamChannel: "content",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "tool_call_started") {
    const toolName = safeString(data.tool_name, "tool");
    const rationale = safeString(data.rationale, "");
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${toolName}`,
      summary: rationale || `Starting ${toolName}`,
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      stage: safeString(data.stage, "tool"),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
      streamChannel: "tool",
      toolCallId: optionalString(data.tool_call_id),
      toolName,
      toolStatus: "running",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "tool_call_delta" || event.event === "sandbox_execution_delta") {
    const preview = safeString(
      data.result_preview,
      safeString(
        data.stdout_preview,
        safeString(data.stderr_preview, safeString(data.message, "Tool running")),
      ),
    );
    const toolName = safeString(data.tool_name, "tool");
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${toolName}`,
      summary: preview || "Tool streaming output",
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      stage: safeString(data.stage, "tool"),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
      rawText: preview,
      streamChannel: "tool",
      toolCallId: optionalString(data.tool_call_id),
      toolName,
      toolStatus: "running",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "search_retrying" || event.event === "search_key_rotated" || event.event === "tool_call_retrying") {
    const message = safeString(
      data.message,
      event.event === "search_retrying"
        ? "Retrying Brave search"
        : event.event === "search_key_rotated"
          ? "Rotated Brave search key"
          : "Retrying tool call",
    );
    const toolName = safeString(data.tool_name, "tool");
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${toolName}`,
      summary: message,
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      stage: safeString(data.stage, "tool"),
      rawText: message,
      streamChannel: "tool",
      toolCallId: optionalString(data.tool_call_id),
      toolName,
      toolStatus: "retrying",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "tool_call_completed" || event.event === "sandbox_execution_completed") {
    const toolName = safeString(data.tool_name, "tool");
    const summary = safeString(data.summary, `${toolName} completed`);
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${toolName}`,
      summary,
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      stage: safeString(data.stage, "tool"),
      streamChannel: "tool",
      toolCallId: optionalString(data.tool_call_id),
      toolName,
      toolStatus: "success",
      rawText: summary,
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "tool_call_failed") {
    const toolName = safeString(data.tool_name, "tool");
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · ${toolName}`,
      summary: safeString(data.error, "Tool execution failed"),
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      stage: safeString(data.stage, "tool"),
      streamChannel: "tool",
      toolCallId: optionalString(data.tool_call_id),
      toolName,
      toolStatus: "failed",
    };
    return { ...mappedEvent, ...segmentMetadata };
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

    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: "Devil's advocate",
      summary: summary || "Cross-examination issued",
      timestamp: event.timestamp,
      details: payload,
      agentId: safeString(data.agent_id, "devils-advocate"),
      agentModel: safeString(data.agent_model, ""),
      stage: safeString(data.stage, "cross_examination"),
      streamChannel: "content",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "cross_examination_delta") {
    const contentSoFar = safeString(data.content_so_far, safeString(data.content_delta, ""));
    const thinkingSoFar = safeString(data.thinking_so_far, "");
    const normalized = normalizeEventContent(contentSoFar, {
      eventType: event.event,
      stage: safeString(data.stage, "cross_examination"),
    });
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: "Devil's advocate",
      summary: buildDisplaySummary(
        normalized.primary,
        normalized.support,
        thinkingSoFar || undefined,
        contentSoFar || thinkingSoFar || "Cross-examination drafting",
      ),
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "devils-advocate"),
      agentModel: safeString(data.agent_model, ""),
      stage: safeString(data.stage, "cross_examination"),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
      displayPrimary: normalized.primary,
      displaySupport: normalized.support,
      displayThinking: thinkingSoFar || undefined,
      rawText: contentSoFar,
      streamChannel: "content",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "thinking_delta") {
    const thinking = safeString(data.thinking_so_far, safeString(data.thinking_delta, "Thinking..."));
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${safeString(data.agent_id, "agent")} · thinking`,
      summary: thinking,
      timestamp: event.timestamp,
      details: data,
      agentId: safeString(data.agent_id, "agent"),
      agentModel: safeString(data.agent_model, ""),
      stage: safeString(data.stage, "thinking"),
      draftKey: eventKeyForTimeline(event),
      isDraft: true,
      displayThinking: thinking,
      streamChannel: "thinking",
    };
    return { ...mappedEvent, ...segmentMetadata };
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
    mappedEvent = {
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
      streamChannel: "usage",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "provider_retrying") {
    const provider = safeString(data.provider, "provider").toUpperCase();
    const model = safeString(data.model, "model");
    const attempt = safeNumber(data.attempt, 0);
    const maxRetries = safeNumber(data.max_retries, 0);
    const backoffSeconds = safeNumber(data.backoff_seconds, 0);
    const statusCode = typeof data.status_code === "number" ? ` · ${Math.round(data.status_code)}` : "";
    mappedEvent = {
      key: eventKeyForTimeline(event),
      type: event.event,
      title: `${provider} retrying`,
      summary: `${model} retry in ${backoffSeconds.toFixed(1)}s (attempt ${attempt}/${maxRetries})${statusCode}`,
      timestamp: event.timestamp,
      details: data,
      agentModel: model,
      stage: "provider_retrying",
      streamChannel: "system",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "convergence_update") {
    const metrics = convergenceMetrics(data);
    const entropy = safeNumber(metrics.disagreement_entropy, 0);
    const novelty = safeNumber(metrics.information_gain_delta, 0);
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: `Convergence round ${safeNumber(data.round_number, 0)}`,
      summary: `Entropy ${entropy.toFixed(2)} · Novelty ${novelty.toFixed(2)}`,
      timestamp: event.timestamp,
      details: { ...data, ...metrics },
      streamChannel: "system",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "delphi_feedback") {
    const feedback = asRecord(data.feedback);
    const feedbackCount = feedback
      ? Object.values(feedback as Record<string, unknown>).reduce<number>((total, entries) => (
        total + (Array.isArray(entries) ? entries.length : 0)
      ), 0)
      : 0;
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: `Delphi feedback round ${safeNumber(data.round_number, 0)}`,
      summary: feedbackCount > 0
        ? `${feedbackCount} anonymous peer critique${feedbackCount === 1 ? "" : "s"} distributed`
        : "Anonymous peer feedback distributed",
      timestamp: event.timestamp,
      details: data,
      stage: safeString(data.stage, "anonymize_and_distribute"),
      streamChannel: "system",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "delphi_finalize") {
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Delphi finalization",
      summary: safeString(data.final_answer, "Delphi finalized a consensus candidate"),
      timestamp: event.timestamp,
      details: data,
      confidence: safeNumber(data.confidence, 0),
      stage: "finalize",
      streamChannel: "content",
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "mechanism_switch") {
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Mechanism switch",
      summary: `${safeString(data.from_mechanism, "unknown")} -> ${safeString(data.to_mechanism, "unknown")}`,
      timestamp: event.timestamp,
      details: data,
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "quorum_reached") {
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Quorum reached",
      summary: safeString(data.final_answer, "Consensus reached"),
      timestamp: event.timestamp,
      details: data,
      confidence: safeNumber(data.confidence, 0),
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "receipt_committed") {
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Receipt committed",
      summary: safeString(data.solana_tx_hash, "On-chain receipt committed"),
      timestamp: event.timestamp,
      details: data,
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "payment_released") {
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Payment released",
      summary: safeString(data.tx_hash, "Escrow released"),
      timestamp: event.timestamp,
      details: data,
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "complete") {
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Execution complete",
      summary: safeString(data.status, "completed"),
      timestamp: event.timestamp,
      details: data,
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "error") {
    mappedEvent = {
      key: buildEventKey(event),
      type: event.event,
      title: "Stream error",
      summary: safeString(data.message, "Unknown stream error"),
      timestamp: event.timestamp,
      details: data,
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  mappedEvent = {
    key: buildEventKey(event),
    type: event.event,
    title: event.event,
    summary: fallbackSummary,
    timestamp: event.timestamp,
    details: data,
  };
  return { ...mappedEvent, ...segmentMetadata };
}

export function buildDeliberationTimeline(
  events: TaskEvent[],
  initialMechanism: string,
): TimelineEvent[] {
  const segmentedEvents = inferSegmentedTaskEvents(events, initialMechanism).events;
  return segmentedEvents.reduce<TimelineEvent[]>((timeline, event) => (
    upsertTimelineEvent(timeline, mapTaskEvent(event))
  ), []);
}

export function deriveFinalAnswerFromEvents(
  events: TaskEvent[],
  fallbackMechanism: string,
): FinalAnswerState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event !== "quorum_reached") {
      continue;
    }
    const data = asRecord(event.data) ?? {};
    const text = safeString(data.final_answer, "");
    if (!text) {
      continue;
    }
    return {
      text,
      confidence: safeNumber(data.confidence, 0),
      mechanism: safeString(data.mechanism, fallbackMechanism) || fallbackMechanism,
    };
  }
  return null;
}
