import type { ProviderName } from "../../../lib/modelProviders";

export type NodeKind =
  | "task"
  | "selector"
  | "agent"
  | "crossexam"
  | "convergence"
  | "switch"
  | "quorum"
  | "receipt";

export type NodeStatus = "pending" | "thinking" | "active" | "done" | "error";

export interface NodeTelemetry {
  confidence?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  latencyMs?: number;
  usdCost?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  stage: string;
  /** vertical row (pipeline step) */
  row: number;
  /** horizontal column (parallel agents within same stage) */
  col: number;
  agentId?: string;
  agentModel?: string;
  provider?: ProviderName;
  title: string;
  content: string;
  thinkingContent?: string;
  isLive: boolean;
  confidence?: number;
  telemetry?: NodeTelemetry;
  status: NodeStatus;
  /** extra metadata — e.g. taskId for the task node */
  taskId?: string;
  /** selection rationale for mechanism_selected nodes */
  reason?: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  isLive: boolean;
}
