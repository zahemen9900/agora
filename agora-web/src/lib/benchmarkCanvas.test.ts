import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkItemPayload } from "./api";
import {
  buildBenchmarkOverviewGraph,
  resolveSelectedBenchmarkItemId,
  shouldFetchBenchmarkItemEvents,
} from "./benchmarkCanvas";

function makeItem(overrides: Partial<BenchmarkItemPayload>): BenchmarkItemPayload {
  return {
    item_id: "item-0",
    item_index: 0,
    task_index: 0,
    phase: "pre_learning",
    run_kind: "selector",
    category: "reasoning",
    question: "Question",
    source_task: null,
    status: "queued",
    mechanism: null,
    selector_source: null,
    selector_fallback_path: [],
    failure_reason: null,
    latest_error_event: null,
    fallback_events: [],
    total_tokens: 0,
    thinking_tokens: 0,
    total_latency_ms: 0,
    model_telemetry: {},
    summary: {},
    started_at: null,
    completed_at: null,
    events: [],
    ...overrides,
  };
}

test("buildBenchmarkOverviewGraph groups items into ordered phase lanes and appends a final node", () => {
  const items = [
    makeItem({ item_id: "post-0", item_index: 3, phase: "post_learning", run_kind: "vote", status: "completed" }),
    makeItem({ item_id: "pre-0", item_index: 0, phase: "pre_learning", run_kind: "selector", status: "completed" }),
    makeItem({ item_id: "learn-0", item_index: 2, phase: "learning_updates", run_kind: "debate", status: "running" }),
    makeItem({ item_id: "pre-1", item_index: 1, phase: "pre_learning", run_kind: "selector", status: "queued" }),
  ];

  const graph = buildBenchmarkOverviewGraph(items, {
    benchmarkId: "bench-1",
    benchmarkStatus: "running",
    activeItemId: "learn-0",
    totalTokens: 200,
    totalLatencyMs: 5000,
    dominantMechanism: "debate",
  });

  assert.equal(graph.nodes.at(-1)?.kind, "final");
  assert.deepEqual(
    graph.nodes.filter((node) => node.kind === "item").map((node) => node.id),
    ["pre-0", "pre-1", "learn-0", "post-0"],
  );
  assert.equal(graph.nodes.find((node) => node.id === "pre-0")?.laneKey, "pre_learning:selector");
  assert.equal(graph.nodes.find((node) => node.id === "learn-0")?.isActive, true);
  assert.ok(graph.edges.some((edge) => edge.fromNodeId === "pre-0" && edge.toNodeId === "pre-1"));
  assert.ok(graph.edges.some((edge) => edge.toNodeId === "bench-1:final"));
});

test("resolveSelectedBenchmarkItemId preserves manual selection and otherwise tracks the active item", () => {
  const items = [
    makeItem({ item_id: "item-a", status: "completed" }),
    makeItem({ item_id: "item-b", item_index: 1, status: "running" }),
  ];

  assert.equal(
    resolveSelectedBenchmarkItemId(items, {
      currentSelectedItemId: "item-a",
      manualSelection: true,
      activeItemId: "item-b",
    }),
    "item-a",
  );
  assert.equal(
    resolveSelectedBenchmarkItemId(items, {
      currentSelectedItemId: "item-a",
      manualSelection: false,
      activeItemId: "item-b",
    }),
    "item-b",
  );
});

test("shouldFetchBenchmarkItemEvents only hydrates missing selected item histories", () => {
  const selectedItem = makeItem({ item_id: "item-a", events: [] });

  assert.equal(
    shouldFetchBenchmarkItemEvents(selectedItem, [], false),
    true,
  );
  assert.equal(
    shouldFetchBenchmarkItemEvents(selectedItem, [{ event: "agent_output", timestamp: null, data: {} }], false),
    false,
  );
  assert.equal(
    shouldFetchBenchmarkItemEvents(makeItem({ item_id: "item-b", events: [{ event: "agent_output", timestamp: null, data: {} }] }), [], false),
    false,
  );
  assert.equal(
    shouldFetchBenchmarkItemEvents(selectedItem, [], true),
    false,
  );
});
