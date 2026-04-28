import type {
  BenchmarkDetailPayload,
  BenchmarkItemPayload,
  TaskEvent,
} from "./api";

export interface BenchmarkOverviewNode {
  id: string;
  kind: "item" | "start" | "final";
  laneKey: string;
  laneLabel: string;
  laneIndex: number;
  colIndex: number;
  itemNumber: string;
  title: string;
  subtitle: string;
  status: BenchmarkItemPayload["status"] | "pending" | "summary";
  isActive: boolean;
  question: string;
  mechanism: string | null;
  totalTokens: number;
  totalLatencyMs: number;
  failureReason: string | null;
}

export interface BenchmarkOverviewEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface BenchmarkOverviewGraph {
  nodes: BenchmarkOverviewNode[];
  edges: BenchmarkOverviewEdge[];
  laneOrder: string[];
}

interface BuildBenchmarkOverviewGraphOptions {
  benchmarkId: string;
  benchmarkStatus: BenchmarkDetailPayload["status"] | null | undefined;
  activeItemId: string | null;
  totalTokens: number;
  totalLatencyMs: number | null | undefined;
  dominantMechanism: string | null;
}

interface ResolveSelectionOptions {
  currentSelectedItemId: string | null;
  manualSelection: boolean;
  activeItemId: string | null;
}

const PHASE_ORDER = new Map([
  ["pre_learning", 0],
  ["learning_updates", 1],
  ["post_learning", 2],
]);

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function laneSortValue(phase: string | null, runKind: string | null): [number, string, string] {
  return [
    PHASE_ORDER.get(phase ?? "") ?? 99,
    phase ?? "zzz",
    runKind ?? "zzz",
  ];
}

function itemDisplayStatus(item: BenchmarkItemPayload): BenchmarkOverviewNode["status"] {
  const hasObservedState = (
    item.events.length > 0
    || item.started_at !== null
    || item.completed_at !== null
    || item.total_tokens > 0
    || item.total_latency_ms > 0
    || item.mechanism !== null
    || item.failure_reason !== null
  );
  if (item.status === "queued" && !hasObservedState) {
    return "pending";
  }
  return item.status;
}

export function buildBenchmarkOverviewGraph(
  items: BenchmarkItemPayload[],
  options: BuildBenchmarkOverviewGraphOptions,
): BenchmarkOverviewGraph {
  const sortedItems = [...items].sort((left, right) => {
    const leftLane = laneSortValue(left.phase, left.run_kind);
    const rightLane = laneSortValue(right.phase, right.run_kind);
    for (let index = 0; index < leftLane.length; index += 1) {
      if (leftLane[index] !== rightLane[index]) {
        return leftLane[index] < rightLane[index] ? -1 : 1;
      }
    }
    return left.item_index - right.item_index;
  });

  const laneOrder: string[] = [];
  const laneIndex = new Map<string, number>();
  const laneCounts = new Map<string, number>();
  const nodes: BenchmarkOverviewNode[] = [];
  const edges: BenchmarkOverviewEdge[] = [];

  for (const item of sortedItems) {
    const laneKey = `${item.phase ?? "benchmark"}:${item.run_kind ?? "run"}`;
    if (!laneIndex.has(laneKey)) {
      laneIndex.set(laneKey, laneOrder.length);
      laneOrder.push(laneKey);
    }
    const colIndex = laneCounts.get(laneKey) ?? 0;
    laneCounts.set(laneKey, colIndex + 1);

    nodes.push({
      id: item.item_id,
      kind: "item",
      laneKey,
      laneLabel: `${titleCase(item.phase ?? "benchmark")} · ${titleCase(item.run_kind ?? "run")}`,
      laneIndex: laneIndex.get(laneKey) ?? 0,
      colIndex,
      itemNumber: String(item.item_index + 1),
      title: `Item ${item.item_index + 1}`,
      subtitle: titleCase(item.category),
      status: itemDisplayStatus(item),
      isActive: item.item_id === options.activeItemId,
      question: item.question,
      mechanism: item.mechanism,
      totalTokens: item.total_tokens,
      totalLatencyMs: item.total_latency_ms,
      failureReason: item.failure_reason,
    });
  }

  const nodesByLane = new Map<string, BenchmarkOverviewNode[]>();
  for (const node of nodes) {
    const laneNodes = nodesByLane.get(node.laneKey) ?? [];
    laneNodes.push(node);
    nodesByLane.set(node.laneKey, laneNodes);
  }

  for (const laneKey of laneOrder) {
    const laneNodes = nodesByLane.get(laneKey) ?? [];
    for (let index = 1; index < laneNodes.length; index += 1) {
      edges.push({
        id: `${laneNodes[index - 1].id}->${laneNodes[index].id}`,
        fromNodeId: laneNodes[index - 1].id,
        toNodeId: laneNodes[index].id,
      });
    }
  }

  const finalNodeId = `${options.benchmarkId}:final`;
  if (sortedItems.length === 0) {
    nodes.push({
      id: `${options.benchmarkId}:start`,
      kind: "start",
      laneKey: "start",
      laneLabel: "Benchmark start",
      laneIndex: 0,
      colIndex: 0,
      itemNumber: "",
      title: "Run queued",
      subtitle: titleCase(options.benchmarkStatus ?? "queued"),
      status: "pending",
      isActive: false,
      question: "Waiting for benchmark items",
      mechanism: options.dominantMechanism,
      totalTokens: 0,
      totalLatencyMs: 0,
      failureReason: null,
    });
  }
  nodes.push({
    id: finalNodeId,
    kind: "final",
    laneKey: "final",
    laneLabel: "Benchmark completion",
    laneIndex: Math.max(laneOrder.length - 1, 0),
    colIndex: Math.max(...Array.from(laneCounts.values(), (value) => value), 1),
    itemNumber: "",
    title: "Benchmark completeness",
    subtitle: titleCase(options.benchmarkStatus ?? "queued"),
    status: "summary",
    isActive: false,
    question: `${items.filter((item) => item.status === "completed").length}/${items.length} items completed`,
    mechanism: options.dominantMechanism,
    totalTokens: options.totalTokens,
    totalLatencyMs: typeof options.totalLatencyMs === "number" ? options.totalLatencyMs : 0,
    failureReason: null,
  });

  if (sortedItems.length === 0) {
    edges.push({
      id: `${options.benchmarkId}:start->${finalNodeId}`,
      fromNodeId: `${options.benchmarkId}:start`,
      toNodeId: finalNodeId,
    });
  } else {
    for (const laneKey of laneOrder) {
      const laneNodes = nodesByLane.get(laneKey) ?? [];
      const lastNode = laneNodes[laneNodes.length - 1];
      if (!lastNode) {
        continue;
      }
      edges.push({
        id: `${lastNode.id}->${finalNodeId}`,
        fromNodeId: lastNode.id,
        toNodeId: finalNodeId,
      });
    }
  }

  return { nodes, edges, laneOrder };
}

export function resolveSelectedBenchmarkItemId(
  items: BenchmarkItemPayload[],
  options: ResolveSelectionOptions,
): string | null {
  const existingIds = new Set(items.map((item) => item.item_id));
  if (options.manualSelection && options.currentSelectedItemId && existingIds.has(options.currentSelectedItemId)) {
    return options.currentSelectedItemId;
  }
  if (options.activeItemId && existingIds.has(options.activeItemId)) {
    return options.activeItemId;
  }
  if (options.currentSelectedItemId && existingIds.has(options.currentSelectedItemId)) {
    return options.currentSelectedItemId;
  }
  return items[0]?.item_id ?? null;
}

export function shouldFetchBenchmarkItemEvents(
  item: BenchmarkItemPayload | null,
  streamedEvents: TaskEvent[],
  isLoading: boolean,
): boolean {
  if (!item || isLoading) {
    return false;
  }
  if (streamedEvents.length > 0) {
    return false;
  }
  return item.events.length === 0;
}
