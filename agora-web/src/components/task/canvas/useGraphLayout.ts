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
  isDraft?: boolean;
  details?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundOf(event: TimelineEventLike): number {
  const r = Number(event.details?.round_number ?? 0);
  return Number.isFinite(r) ? r : 0;
}

/** Groups events into a vertical pipeline stage. Order of first-seen determines row. */
function stageGroupKey(event: TimelineEventLike): string {
  const r = roundOf(event);
  switch (event.type) {
    case "mechanism_selected": return "selector";
    case "convergence_update": return `convergence_${r}`;
    case "mechanism_switch":   return "switch";
    case "quorum_reached":     return "quorum";
    case "receipt_committed":
    case "payment_released":   return "receipt";
    case "cross_examination":
    case "cross_examination_delta": return `cross_${r}`;
    default:
      // All agent events: group by round (agents side-by-side horizontally)
      return `round_${r}`;
  }
}

function nodeIdOf(event: TimelineEventLike): string {
  switch (event.type) {
    case "mechanism_selected": return "selector";
    case "convergence_update": return `convergence:${String(event.details?.round_number ?? 0)}`;
    case "mechanism_switch":   return `switch:${event.key}`;
    case "quorum_reached":     return "quorum";
    case "receipt_committed":  return "receipt";
    case "payment_released":   return "payment";
    case "cross_examination":
    case "cross_examination_delta": {
      const r = roundOf(event);
      return `cross:${r}`;
    }
  }
  // agent / thinking / usage events — group by (agentId, stage, round)
  const agentId = event.agentId ?? "agent";
  const stage = event.stage ?? "output";
  const r = roundOf(event);
  return `agent:${agentId}:${stage}:${r}`;
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

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGraphLayout(
  timeline: TimelineEventLike[],
  options?: { taskText?: string; taskId?: string },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return useMemo(() => {
    const nodeMap = new Map<string, GraphNode>();
    // stage group → first-seen insertion order
    const groupOrder = new Map<string, number>();
    // stage group → ordered list of nodeIds
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
    const nodeGroup = new Map<string, string>(); // nodeId → groupKey

    // Synthetic task node
    nodeMap.set("task", {
      id: "task",
      kind: "task",
      stage: "task",
      row: 0, col: 0,
      title: "Task",
      content: options?.taskText ?? "",
      isLive: false,
      status: "done",
      taskId: options?.taskId,
    });
    groupOrder.set("task", 0);
    groupNodes.set("task", ["task"]);
    nodeGroup.set("task", "task");

    for (const event of timeline) {
      // skip events that don't produce visual nodes
      if (["complete", "error", "provider_retrying"].includes(event.type)) continue;

      const nodeId = nodeIdOf(event);
      const groupKey = stageGroupKey(event);
      addToGroup(groupKey, nodeId);
      nodeGroup.set(nodeId, groupKey);

      const existing = nodeMap.get(nodeId);

      // Merge thinking content
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
        stage: event.stage ?? groupKey,
        row: 0, col: 0, // assigned below
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
      };
      nodeMap.set(nodeId, merged);
    }

    // ─── Assign row (stage sequence) and col (parallel index) ────────────────
    // Sort groups by first-seen order, remapping to start after "task" (row 0)
    const sortedGroups = [...groupOrder.entries()]
      .sort((a, b) => a[1] - b[1])
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

    // ─── Build edges ──────────────────────────────────────────────────────────
    const edges: GraphEdge[] = [];
    // For each row, connect last node of previous stage to each node in this stage
    const rowGroups = sortedGroups.map((key) => groupNodes.get(key) ?? []);

    for (let r = 1; r < rowGroups.length; r++) {
      const fromIds = rowGroups[r - 1];
      const toIds = rowGroups[r];
      // Use the "center" fromNode in the previous row as the edge source
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
  }, [timeline, options?.taskId, options?.taskText]);
}
