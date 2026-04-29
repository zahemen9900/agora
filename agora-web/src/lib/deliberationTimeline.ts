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

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function convergenceMetrics(data: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(data.metrics);
  return nested ?? data;
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
  const merged: TimelineEvent = {
    ...previous,
    ...nextEvent,
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
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "agent_output") {
    mappedEvent = {
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
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "agent_output_delta") {
    const contentSoFar = safeString(data.content_so_far, safeString(data.content_delta, ""));
    const thinkingSoFar = safeString(data.thinking_so_far, "");
    mappedEvent = {
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
    };
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "cross_examination_delta") {
    const contentSoFar = safeString(data.content_so_far, safeString(data.content_delta, ""));
    const thinkingSoFar = safeString(data.thinking_so_far, "");
    mappedEvent = {
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
    return { ...mappedEvent, ...segmentMetadata };
  }

  if (event.event === "thinking_delta") {
    mappedEvent = {
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
