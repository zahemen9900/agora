import assert from "node:assert/strict";
import test from "node:test";

import type { GraphNode } from "./canvasTypes";
import {
  computeFollowTransform,
  computeRowBounds,
  resolveFollowCameraState,
  type FollowCameraState,
} from "./followCamera";

function makeNode(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "row" | "col">): GraphNode {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "agent",
    stage: overrides.stage ?? "opening",
    row: overrides.row,
    col: overrides.col,
    title: overrides.title ?? overrides.id,
    content: overrides.content ?? "",
    isLive: overrides.isLive ?? false,
    status: overrides.status ?? "pending",
    toolStatus: overrides.toolStatus,
    agentId: overrides.agentId,
    agentModel: overrides.agentModel,
    provider: overrides.provider,
    supportContent: overrides.supportContent,
    thinkingContent: overrides.thinkingContent,
    rawContent: overrides.rawContent,
    confidence: overrides.confidence,
    telemetry: overrides.telemetry,
    taskId: overrides.taskId,
    reason: overrides.reason,
    transitionLabel: overrides.transitionLabel,
    transitionDescription: overrides.transitionDescription,
    toolName: overrides.toolName,
    toolActivities: overrides.toolActivities,
  };
}

function makeState(overrides: Partial<FollowCameraState> = {}): FollowCameraState {
  return {
    currentTarget: null,
    queuedTarget: null,
    previousNodeState: {},
    activeRows: [],
    ...overrides,
  };
}

test("resolveFollowCameraState stays idle when there are no active nodes", () => {
  const result = resolveFollowCameraState(
    makeState(),
    [makeNode({ id: "agent-1", row: 1, col: 0, status: "done" })],
    100,
  );

  assert.equal(result.nextTarget, null);
  assert.equal(result.changed, false);
  assert.equal(result.state.currentTarget, null);
});

test("resolveFollowCameraState immediately jumps to a newly activated row", () => {
  const previous = makeState({
    currentTarget: {
      row: 1,
      anchorNodeId: "agent-1",
      reason: "row-continue",
      startedAt: 10,
    },
    activeRows: [1],
    previousNodeState: {
      "agent-1": { row: 1, active: true, settled: false },
    },
  });

  const nodes = [
    makeNode({ id: "agent-1", row: 1, col: 0, status: "active", isLive: true }),
    makeNode({ id: "agent-2", row: 2, col: 0, status: "active", isLive: true }),
  ];

  const result = resolveFollowCameraState(previous, nodes, 200);

  assert.equal(result.changed, true);
  assert.equal(result.nextTarget?.row, 2);
  assert.equal(result.nextTarget?.anchorNodeId, "agent-2");
  assert.equal(result.nextTarget?.reason, "row-activation");
});

test("resolveFollowCameraState shifts to a newly active card on the same row", () => {
  const previous = makeState({
    currentTarget: {
      row: 1,
      anchorNodeId: "agent-1",
      reason: "row-activation",
      startedAt: 10,
    },
    activeRows: [1],
    previousNodeState: {
      "agent-1": { row: 1, active: true, settled: false },
      "agent-2": { row: 1, active: false, settled: false },
    },
  });

  const nodes = [
    makeNode({ id: "agent-1", row: 1, col: 0, status: "active", isLive: true }),
    makeNode({ id: "agent-2", row: 1, col: 1, status: "thinking", isLive: true }),
  ];

  const result = resolveFollowCameraState(previous, nodes, 200);

  assert.equal(result.changed, true);
  assert.equal(result.state.currentTarget?.anchorNodeId, "agent-2");
  assert.equal(result.state.currentTarget?.reason, "same-row-shift");
});

test("resolveFollowCameraState shifts laterally on the same row after the anchor settles", () => {
  const previous = makeState({
    currentTarget: {
      row: 1,
      anchorNodeId: "agent-1",
      reason: "row-activation",
      startedAt: 10,
    },
    activeRows: [1],
    previousNodeState: {
      "agent-1": { row: 1, active: true, settled: false },
      "agent-2": { row: 1, active: true, settled: false },
    },
  });

  const nodes = [
    makeNode({ id: "agent-1", row: 1, col: 0, status: "done", isLive: false }),
    makeNode({ id: "agent-2", row: 1, col: 1, status: "active", isLive: true }),
  ];

  const result = resolveFollowCameraState(previous, nodes, 200);

  assert.equal(result.changed, true);
  assert.equal(result.nextTarget?.row, 1);
  assert.equal(result.nextTarget?.anchorNodeId, "agent-2");
  assert.equal(result.nextTarget?.reason, "same-row-shift");
});

test("resolveFollowCameraState returns to a prior same-row card after the newer card settles", () => {
  const previous = makeState({
    currentTarget: {
      row: 1,
      anchorNodeId: "agent-2",
      reason: "same-row-shift",
      startedAt: 25,
    },
    activeRows: [1],
    previousNodeState: {
      "agent-1": { row: 1, active: true, settled: false },
      "agent-2": { row: 1, active: true, settled: false },
    },
  });

  const nodes = [
    makeNode({ id: "agent-1", row: 1, col: 0, status: "active", isLive: true }),
    makeNode({ id: "agent-2", row: 1, col: 1, status: "done", isLive: false }),
  ];

  const result = resolveFollowCameraState(previous, nodes, 250);

  assert.equal(result.changed, true);
  assert.equal(result.nextTarget?.anchorNodeId, "agent-1");
  assert.equal(result.nextTarget?.reason, "same-row-shift");
});

test("resolveFollowCameraState queues settled cards on other rows until row handoff is allowed", () => {
  const previous = makeState({
    currentTarget: {
      row: 2,
      anchorNodeId: "agent-2",
      reason: "row-activation",
      startedAt: 10,
    },
    activeRows: [1, 2],
    previousNodeState: {
      "agent-1": { row: 1, active: true, settled: false },
      "agent-2": { row: 2, active: true, settled: false },
    },
  });

  const rowBusy = resolveFollowCameraState(previous, [
    makeNode({ id: "agent-1", row: 1, col: 0, status: "done", isLive: false }),
    makeNode({ id: "agent-2", row: 2, col: 0, status: "active", isLive: true }),
  ], 200);

  assert.equal(rowBusy.changed, false);
  assert.equal(rowBusy.state.currentTarget?.anchorNodeId, "agent-2");
  assert.equal(rowBusy.state.queuedTarget?.anchorNodeId, "agent-1");

  const handoff = resolveFollowCameraState(rowBusy.state, [
    makeNode({ id: "agent-1", row: 1, col: 0, status: "done", isLive: false }),
    makeNode({ id: "agent-2", row: 2, col: 0, status: "done", isLive: false }),
  ], 300);

  assert.equal(handoff.changed, true);
  assert.equal(handoff.nextTarget?.anchorNodeId, "agent-1");
  assert.equal(handoff.nextTarget?.reason, "settled-handoff");
});

test("resolveFollowCameraState does not churn on duplicate deltas for the same node", () => {
  const previous = makeState({
    currentTarget: {
      row: 2,
      anchorNodeId: "tool-1",
      reason: "row-activation",
      startedAt: 10,
    },
    activeRows: [2],
    previousNodeState: {
      "tool-1": { row: 2, active: true, settled: false },
    },
  });

  const nodes = [
    makeNode({
      id: "tool-1",
      kind: "tool",
      row: 2,
      col: 0,
      status: "active",
      isLive: true,
      toolStatus: "running",
      toolName: "search_online",
    }),
  ];

  const result = resolveFollowCameraState(previous, nodes, 200);

  assert.equal(result.changed, false);
  assert.equal(result.state.currentTarget?.anchorNodeId, "tool-1");
});

test("computeRowBounds spans the whole row and preserves anchor geometry", () => {
  const nodes = [
    makeNode({ id: "agent-1", row: 3, col: 0 }),
    makeNode({ id: "agent-2", row: 3, col: 1 }),
  ];
  const positions = new Map([
    ["agent-1", { x: 100, y: 420 }],
    ["agent-2", { x: 460, y: 420 }],
  ]);
  const heights = new Map([
    ["agent-1", 280],
    ["agent-2", 320],
  ]);

  const bounds = computeRowBounds(nodes, positions, heights, "agent-2");

  assert.ok(bounds);
  assert.equal(bounds.row, 3);
  assert.equal(bounds.minX, 100);
  assert.equal(bounds.maxX, 700);
  assert.equal(bounds.minY, 420);
  assert.equal(bounds.maxY, 740);
  assert.equal(bounds.anchorCenter.x, 580);
});

test("computeFollowTransform uses row width to derive a moderate row-level zoom", () => {
  const bounds = {
    row: 2,
    minX: 120,
    maxX: 880,
    minY: 300,
    maxY: 620,
    width: 760,
    height: 320,
    center: { x: 500, y: 460 },
    anchorCenter: { x: 640, y: 460 },
  };

  const transform = computeFollowTransform(bounds, {
    width: 1280,
    height: 720,
  }, {
    x: 60,
    y: 60,
    scale: 0.85,
  });

  assert.ok(transform.scale >= 0.72 && transform.scale <= 1.05);
  assert.ok(transform.scale > 1);
  assert.ok(Number.isFinite(transform.x));
  assert.ok(Number.isFinite(transform.y));
});
