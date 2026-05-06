import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkItemPayload } from "./api";
import {
  buildBenchmarkOverviewGraph,
  deriveBenchmarkItemTimelineEvents,
  resolveSelectedBenchmarkItemId,
  shouldFetchBenchmarkItemEvents,
} from "./benchmarkCanvas";
import { buildDeliberationTimeline } from "./deliberationTimeline";

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
  assert.equal(
    shouldFetchBenchmarkItemEvents(selectedItem, [], false, true),
    false,
  );
});

test("deriveBenchmarkItemTimelineEvents recovers terminal item graph events from summary metadata", () => {
  const item = makeItem({
    item_id: "pre_learning:selector_initial:7",
    item_index: 7,
    task_index: 7,
    status: "completed",
    mechanism: "vote",
    question: "What is the capital city of Japan?",
    completed_at: "2026-04-27T09:00:08+00:00",
    summary: {
      confidence: 0.835,
      final_answer: "Tokyo",
      quorum_reached: true,
      latest_entropy: 0.2,
      latest_novelty: 0.1,
      rounds: 1,
    },
  });

  const events = deriveBenchmarkItemTimelineEvents(item, [], "debate");

  assert.deepEqual(
    events.map((event) => event.event),
    ["mechanism_selected", "convergence_update", "quorum_reached", "complete"],
  );
  assert.equal(events[0].data.mechanism, "vote");
  assert.equal(events[2].data.final_answer, "Tokyo");
  assert.equal(events[2].data.confidence, 0.835);
  assert.equal(events[2].data.item_id, "pre_learning:selector_initial:7");
  assert.equal(events[2].data.mechanism_recovered, true);
});

test("benchmark item timelines normalize structured live output instead of rendering raw JSON", () => {
  const item = makeItem({
    item_id: "item-live",
    status: "running",
    mechanism: "vote",
    events: [
      {
        event: "agent_output_delta",
        timestamp: "2026-05-03T00:00:01.000Z",
        data: {
          agent_id: "agent-1",
          agent_model: "claude-sonnet-4-6",
          stage: "vote",
          round_number: 1,
          content_so_far: "{\"answer\":\"Use a modular monolith\",\"reasoning\":\"It keeps early delivery fast",
        },
      },
      {
        event: "usage_delta",
        timestamp: "2026-05-03T00:00:02.000Z",
        data: {
          agent_id: "agent-1",
          agent_model: "claude-sonnet-4-6",
          stage: "vote",
          round_number: 1,
          total_tokens: 1089,
          latency_ms: 40779,
        },
      },
    ],
  });

  const events = deriveBenchmarkItemTimelineEvents(item, item.events, "vote");
  const timeline = buildDeliberationTimeline(events, "vote");
  const agentEvent = timeline.find((entry) => entry.agentId === "agent-1");

  assert.ok(agentEvent);
  assert.match(agentEvent.summary, /Use a modular monolith/);
  assert.doesNotMatch(agentEvent.summary, /\{|\}|\"answer\"|1,089 tokens|40779 ms/);
});
