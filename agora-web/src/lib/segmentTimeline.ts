import type { TaskEvent } from "./api.generated";

export interface SegmentInferenceState {
  activeSegmentIndex: number;
  activeMechanism: string;
}

export interface SegmentedTaskEventResult {
  events: TaskEvent[];
  state: SegmentInferenceState;
}

export interface TaskEventSegmentMetadata {
  segmentIndex: number;
  segmentMechanism: string;
  segmentRound?: number;
  canonicalStage: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseOptionalInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function normalizeMechanism(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

function resolveSegmentRound(data: Record<string, unknown>): number | null {
  const segmentRound = parseOptionalInt(data.segment_round);
  if (segmentRound !== null) {
    return segmentRound;
  }
  return parseOptionalInt(data.round_number);
}

export function createSegmentInferenceState(
  initialMechanism: string | null | undefined,
): SegmentInferenceState {
  return {
    activeSegmentIndex: 0,
    activeMechanism: normalizeMechanism(initialMechanism) ?? "debate",
  };
}

export function inferSegmentedTaskEvent(
  event: TaskEvent,
  state: SegmentInferenceState,
): TaskEvent {
  const data = { ...(asRecord(event.data) ?? {}) };
  let executionSegment = parseOptionalInt(data.execution_segment);
  if (executionSegment === null) {
    executionSegment = state.activeSegmentIndex;
  }
  executionSegment = Math.max(0, executionSegment);
  data.execution_segment = executionSegment;

  const round = resolveSegmentRound(data);
  if (round !== null) {
    data.segment_round = round;
  }

  if (event.event === "mechanism_switch") {
    const fromMechanism =
      normalizeMechanism(data.from_mechanism)
      ?? normalizeMechanism(data.segment_mechanism)
      ?? state.activeMechanism;
    const toMechanism =
      normalizeMechanism(data.to_mechanism)
      ?? normalizeMechanism(data.next_segment_mechanism)
      ?? fromMechanism;
    const nextExecutionSegment = parseOptionalInt(data.next_execution_segment) ?? (executionSegment + 1);

    data.segment_mechanism = fromMechanism;
    data.next_execution_segment = Math.max(0, nextExecutionSegment);
    data.next_segment_mechanism = toMechanism;

    state.activeSegmentIndex = Math.max(0, nextExecutionSegment);
    state.activeMechanism = toMechanism;
    return {
      ...event,
      data,
    };
  }

  if (event.event === "mechanism_selected") {
    const selectedMechanism =
      normalizeMechanism(data.segment_mechanism)
      ?? normalizeMechanism(data.mechanism)
      ?? state.activeMechanism;
    data.segment_mechanism = selectedMechanism;
    state.activeSegmentIndex = executionSegment;
    state.activeMechanism = selectedMechanism;
    return {
      ...event,
      data,
    };
  }

  const segmentMechanism =
    normalizeMechanism(data.segment_mechanism)
    ?? normalizeMechanism(data.mechanism)
    ?? state.activeMechanism;
  data.segment_mechanism = segmentMechanism;

  state.activeSegmentIndex = executionSegment;
  state.activeMechanism = segmentMechanism;

  return {
    ...event,
    data,
  };
}

export function inferSegmentedTaskEvents(
  events: TaskEvent[],
  initialMechanism: string | null | undefined,
  existingState?: SegmentInferenceState,
): SegmentedTaskEventResult {
  const state = existingState ?? createSegmentInferenceState(initialMechanism);
  const normalizedEvents = events.map((event) => inferSegmentedTaskEvent(event, state));
  return {
    events: normalizedEvents,
    state: {
      activeSegmentIndex: state.activeSegmentIndex,
      activeMechanism: state.activeMechanism,
    },
  };
}

export function segmentDraftKeyForEvent(event: TaskEvent): string | null {
  const data = asRecord(event.data) ?? {};
  const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : "";
  if (toolCallId) {
    return toolCallId;
  }
  const agentId = typeof data.agent_id === "string" ? data.agent_id : "";
  const stage = typeof data.stage === "string" ? data.stage : "";
  const roundNumber = resolveSegmentRound(data);
  if (!agentId || !stage || roundNumber === null) {
    return null;
  }
  const executionSegment = parseOptionalInt(data.execution_segment) ?? 0;
  return `${executionSegment}:${agentId}:${stage}:${roundNumber}`;
}

export function eventCanonicalStage(
  eventType: string,
  data: Record<string, unknown>,
): string {
  if (eventType === "mechanism_selected") {
    return "selector";
  }
  if (eventType === "mechanism_switch") {
    return "switch";
  }
  if (eventType === "quorum_reached") {
    return "quorum";
  }
  if (eventType === "receipt_committed") {
    return "receipt";
  }
  if (eventType === "payment_released") {
    return "payment";
  }
  if (eventType === "convergence_update") {
    return "convergence";
  }
  if (eventType === "cross_examination" || eventType === "cross_examination_delta") {
    return "cross_examination";
  }

  const stage = typeof data.stage === "string" ? data.stage.trim().toLowerCase() : "";
  if (!stage) {
    return eventType;
  }
  if (stage === "cross_examination") {
    return "cross_examination";
  }
  if (stage === "opening" || stage === "rebuttal" || stage === "initial") {
    return stage;
  }
  if (stage === "vote" || stage === "final_synthesis") {
    return stage;
  }
  if (stage === "thinking" || stage === "usage") {
    return stage;
  }
  return stage;
}

export function segmentMetadataForTaskEvent(event: TaskEvent): TaskEventSegmentMetadata {
  const data = asRecord(event.data) ?? {};
  const segmentIndex = Math.max(0, parseOptionalInt(data.execution_segment) ?? 0);
  const segmentMechanism =
    normalizeMechanism(data.segment_mechanism)
    ?? normalizeMechanism(data.mechanism)
    ?? normalizeMechanism(data.from_mechanism)
    ?? "debate";
  const segmentRound = resolveSegmentRound(data);
  const metadata: TaskEventSegmentMetadata = {
    segmentIndex,
    segmentMechanism,
    canonicalStage: eventCanonicalStage(event.event, data),
  };
  if (segmentRound !== null) {
    metadata.segmentRound = segmentRound;
  }
  return metadata;
}
