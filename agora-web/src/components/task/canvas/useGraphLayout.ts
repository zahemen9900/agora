import { useMemo } from "react";
import { providerFromModel } from "../../../lib/modelProviders";
import type { GraphEdge, GraphNode, NodeKind, NodeStatus, NodeTelemetry } from "./canvasTypes";

interface TimelineEventLike {
  key: string;
  type: string;
  title: string;
  summary: string;
  agentId?: string;
  agentModel?: string;
  confidence?: number;
  stage?: string;
  segmentIndex?: number;
  segmentMechanism?: string;
  segmentRound?: number;
  canonicalStage?: string;
  isDraft?: boolean;
  details?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asFiniteInt(value: unknown): number | null {
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

function roundOf(event: TimelineEventLike): number {
  return (
    asFiniteInt(event.segmentRound)
    ?? asFiniteInt(event.details?.segment_round)
    ?? asFiniteInt(event.details?.round_number)
    ?? 0
  );
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function segmentOf(event: TimelineEventLike): number {
  return (
    asFiniteInt(event.segmentIndex)
    ?? asFiniteInt(event.details?.execution_segment)
    ?? 0
  );
}

function canonicalStageOf(event: TimelineEventLike): string {
  if (typeof event.canonicalStage === "string" && event.canonicalStage.trim()) {
    return event.canonicalStage.trim().toLowerCase();
  }

  switch (event.type) {
    case "mechanism_selected":
      return "selector";
    case "mechanism_switch":
      return "switch";
    case "quorum_reached":
      return "quorum";
    case "receipt_committed":
      return "receipt";
    case "payment_released":
      return "payment";
    case "convergence_update":
      return "convergence";
    case "cross_examination":
    case "cross_examination_delta":
      return "cross_examination";
    default:
      break;
  }

  if (typeof event.stage === "string" && event.stage.trim()) {
    return event.stage.trim().toLowerCase();
  }
  return "agent_output";
}

function stageOrder(stage: string): number {
  const order: Record<string, number> = {
    selector: 0,
    initial: 10,
    opening: 20,
    cross_examination: 30,
    rebuttal: 40,
    vote: 50,
    final_synthesis: 60,
    convergence: 70,
    switch: 90,
    quorum: 100,
    receipt: 110,
    payment: 120,
  };
  return order[stage] ?? 65;
}

function stageGroupKey(event: TimelineEventLike): string {
  const segment = segmentOf(event);
  const stage = canonicalStageOf(event);

  if (stage === "switch") {
    return `switch:${segment}`;
  }
  if (stage === "quorum") {
    return "quorum";
  }
  if (stage === "receipt") {
    return "receipt";
  }
  if (stage === "payment") {
    return "payment";
  }
  if (stage === "selector") {
    return `segment:${segment}:selector`;
  }

  return `segment:${segment}:${stage}:${roundOf(event)}`;
}

function transitionLabelOf(event: TimelineEventLike): string {
  const stage = canonicalStageOf(event);
  const round = roundOf(event);
  if (stage === "selector") {
    const mechanism = String(event.details?.mechanism ?? event.segmentMechanism ?? "mechanism");
    return `Select ${mechanism.toUpperCase()}`;
  }
  if (stage === "switch") {
    const toMechanism = String(
      event.details?.to_mechanism
      ?? event.details?.next_segment_mechanism
      ?? "mechanism",
    );
    return `Switch to ${toMechanism.toUpperCase()}`;
  }
  if (stage === "quorum") return "Quorum";
  if (stage === "receipt") return "Receipt";
  if (stage === "payment") return "Payment";
  if (stage === "convergence") return `Convergence R${round}`;
  return `${titleCase(stage)} R${round}`;
}

function transitionDescriptionOf(event: TimelineEventLike): string {
  const stage = canonicalStageOf(event);
  const round = roundOf(event);
  const segment = segmentOf(event);
  const mechanism = String(
    event.segmentMechanism
    ?? event.details?.segment_mechanism
    ?? event.details?.mechanism
    ?? "mechanism",
  );

  if (stage === "selector") {
    return `Mechanism selection opened ${mechanism} segment ${segment}.`;
  }
  if (stage === "switch") {
    const fromMechanism = String(event.details?.from_mechanism ?? mechanism);
    const toMechanism = String(
      event.details?.to_mechanism
      ?? event.details?.next_segment_mechanism
      ?? "mechanism",
    );
    const reason = String(event.details?.reason ?? event.details?.switch_reason ?? "").trim();
    return reason
      ? `Round ${round} switched from ${fromMechanism} to ${toMechanism}: ${reason}`
      : `Round ${round} switched from ${fromMechanism} to ${toMechanism}.`;
  }
  if (stage === "quorum") {
    return `Quorum resolved the ${mechanism} segment.`;
  }
  if (stage === "receipt") {
    return "The deliberation receipt was committed before the next ledger step.";
  }
  if (stage === "payment") {
    return "Payment release completed this branch of execution.";
  }
  if (stage === "convergence") {
    return `Convergence metrics from round ${round} advanced ${mechanism} segment ${segment}.`;
  }
  return `${titleCase(stage)} round ${round} advanced ${mechanism} segment ${segment}.`;
}

function nodeIdOf(event: TimelineEventLike): string {
  const segment = segmentOf(event);
  const stage = canonicalStageOf(event);
  const round = roundOf(event);

  if (stage === "selector") {
    return `selector:${segment}`;
  }
  if (stage === "convergence") {
    return `convergence:${segment}:${round}`;
  }
  if (stage === "switch") {
    return `switch:${segment}`;
  }
  if (stage === "quorum") {
    return "quorum";
  }
  if (stage === "receipt") {
    return "receipt";
  }
  if (stage === "payment") {
    return "payment";
  }
  if (stage === "cross_examination") {
    return `cross:${segment}:${round}`;
  }

  const agentId = event.agentId ?? "agent";
  return `agent:${segment}:${agentId}:${stage}:${round}`;
}

function kindOf(type: string): NodeKind {
  if (type === "mechanism_selected") return "selector";
  if (type === "cross_examination" || type === "cross_examination_delta") return "crossexam";
  if (type === "convergence_update") return "convergence";
  if (type === "mechanism_switch") return "switch";
  if (type === "quorum_reached") return "quorum";
  if (type === "receipt_committed" || type === "payment_released") return "receipt";
  return "agent";
}

function statusOf(event: TimelineEventLike, prevStatus?: NodeStatus): NodeStatus {
  const next: NodeStatus =
    event.type === "error" ? "error" :
    event.type === "thinking_delta" ? "thinking" :
    event.isDraft ? "active" :
    "done";
  // monotonically progress: done > active > thinking > pending
  const rank = (s: NodeStatus) => ({ done: 4, active: 3, thinking: 2, pending: 1, error: 5 }[s] ?? 0);
  return rank(next) >= rank(prevStatus ?? "pending") ? next : (prevStatus ?? "pending");
}

function telemetryOf(details?: Record<string, unknown>): NodeTelemetry | undefined {
  if (!details) return undefined;
  const hasAny = typeof details.total_tokens === "number" ||
                 typeof details.input_tokens === "number" ||
                 typeof details.latency_ms === "number";
  if (!hasAny) return undefined;
  return {
    totalTokens:    typeof details.total_tokens     === "number" ? Math.max(0, details.total_tokens)    : undefined,
    inputTokens:    typeof details.input_tokens     === "number" ? Math.max(0, details.input_tokens)    : undefined,
    outputTokens:   typeof details.output_tokens    === "number" ? Math.max(0, details.output_tokens)   : undefined,
    thinkingTokens: typeof details.thinking_tokens  === "number" ? Math.max(0, details.thinking_tokens) : undefined,
    latencyMs:      typeof details.latency_ms       === "number" ? Math.max(0, details.latency_ms)      : undefined,
    usdCost:        typeof details.estimated_cost_usd === "number" ? Math.max(0, details.estimated_cost_usd) : undefined,
  };
}

function groupSortKey(groupKey: string, insertionOrder: number): [number, number, number, number, number] {
  if (groupKey === "task") {
    return [0, 0, 0, 0, insertionOrder];
  }
  if (groupKey.startsWith("segment:")) {
    const parts = groupKey.split(":");
    const segment = asFiniteInt(parts[1]) ?? 0;
    const stage = parts[2] ?? "agent_output";
    const round = asFiniteInt(parts[3]) ?? 0;
    return [1, segment, stageOrder(stage), round, insertionOrder];
  }
  if (groupKey.startsWith("switch:")) {
    const segment = asFiniteInt(groupKey.split(":")[1]) ?? 0;
    return [1, segment, stageOrder("switch"), 0, insertionOrder];
  }
  if (groupKey === "quorum") {
    return [2, 0, 0, 0, insertionOrder];
  }
  if (groupKey === "receipt") {
    return [3, 0, 0, 0, insertionOrder];
  }
  if (groupKey === "payment") {
    return [4, 0, 0, 0, insertionOrder];
  }
  return [9, 0, 0, 0, insertionOrder];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function buildGraphLayout(
  timeline: TimelineEventLike[],
  options?: { taskText?: string; taskId?: string },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const groupOrder = new Map<string, number>();
  const groupNodes = new Map<string, string[]>();

  const addToGroup = (groupKey: string, nodeId: string) => {
    if (!groupOrder.has(groupKey)) {
      groupOrder.set(groupKey, groupOrder.size);
    }
    const list = groupNodes.get(groupKey) ?? [];
    if (!list.includes(nodeId)) {
      list.push(nodeId);
      groupNodes.set(groupKey, list);
    }
  };

  nodeMap.set("task", {
    id: "task",
    kind: "task",
    stage: "task",
    row: 0,
    col: 0,
    title: "Task",
    content: options?.taskText ?? "",
    isLive: false,
    status: "done",
    taskId: options?.taskId,
  });
  groupOrder.set("task", 0);
  groupNodes.set("task", ["task"]);

  for (const event of timeline) {
    if (["complete", "error", "provider_retrying"].includes(event.type)) continue;

    const nodeId = nodeIdOf(event);
    const groupKey = stageGroupKey(event);
    addToGroup(groupKey, nodeId);

    const existing = nodeMap.get(nodeId);

    let thinkingContent = existing?.thinkingContent;
    if (event.type === "thinking_delta") {
      const tf = event.details?.thinking_so_far ?? event.details?.thinking_delta;
      if (typeof tf === "string") thinkingContent = tf;
    }

    const reasonRaw = event.details?.reason ?? event.details?.reasoning;
    const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim() : undefined;

    const merged: GraphNode = {
      id: nodeId,
      kind: existing?.kind ?? kindOf(event.type),
      stage: canonicalStageOf(event),
      row: 0,
      col: 0,
      agentId: existing?.agentId ?? event.agentId,
      agentModel: existing?.agentModel ?? event.agentModel,
      provider: event.agentModel
        ? providerFromModel(event.agentModel)
        : existing?.provider,
      title: event.title,
      content: event.summary,
      thinkingContent,
      isLive: event.isDraft ?? false,
      confidence: event.confidence ?? existing?.confidence,
      telemetry: telemetryOf(event.details) ?? existing?.telemetry,
      status: statusOf(event, existing?.status),
      reason: reason ?? existing?.reason,
      transitionLabel: transitionLabelOf(event),
      transitionDescription: transitionDescriptionOf(event),
    };
    nodeMap.set(nodeId, merged);
  }

  const sortedGroups = [...groupOrder.entries()]
    .sort((a, b) => {
      const keyA = groupSortKey(a[0], a[1]);
      const keyB = groupSortKey(b[0], b[1]);
      for (let index = 0; index < keyA.length; index += 1) {
        if (keyA[index] !== keyB[index]) {
          return keyA[index] - keyB[index];
        }
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([key]) => key);

  const nodes: GraphNode[] = [];
  sortedGroups.forEach((groupKey, rowIdx) => {
    const ids = groupNodes.get(groupKey) ?? [];
    ids.forEach((nodeId, colIdx) => {
      const node = nodeMap.get(nodeId);
      if (!node) return;
      nodes.push({ ...node, row: rowIdx, col: colIdx });
    });
  });

  const edges: GraphEdge[] = [];
  const rowGroups = sortedGroups.map((key) => groupNodes.get(key) ?? []);

  for (let row = 1; row < rowGroups.length; row += 1) {
    const fromIds = rowGroups[row - 1];
    const toIds = rowGroups[row];
    const fromId = fromIds[Math.floor(fromIds.length / 2)] ?? fromIds[0];
    if (!fromId) continue;
    for (const toId of toIds) {
      const toNode = nodeMap.get(toId);
      edges.push({
        id: `${fromId}→${toId}`,
        fromNodeId: fromId,
        toNodeId: toId,
        isLive: toNode?.isLive ?? false,
      });
    }
  }

  return { nodes, edges };
}

export function useGraphLayout(
  timeline: TimelineEventLike[],
  options?: { taskText?: string; taskId?: string },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return useMemo(
    () => buildGraphLayout(timeline, options),
    [timeline, options?.taskId, options?.taskText],
  );
}
