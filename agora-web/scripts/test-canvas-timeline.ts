import assert from "node:assert/strict";

import { upsertTimelineEvent, type TimelineEvent } from "../src/lib/deliberationTimeline";
import { buildGraphLayout } from "../src/components/task/canvas/useGraphLayout";

const draftEvent: TimelineEvent = {
  key: "agent-1:opening",
  type: "agent_output_delta",
  title: "agent-1 · opening",
  summary: "Primary line\nDuplicated support line",
  timestamp: "2026-05-09T02:00:00Z",
  agentId: "agent-1",
  agentModel: "qwen/qwen3.5-flash-02-23",
  stage: "opening",
  canonicalStage: "opening",
  isDraft: true,
  displayPrimary: "Primary line",
  displaySupport: "Duplicated support line",
  rawText: "Primary line\nDuplicated support line",
  streamChannel: "content",
};

const finalEvent: TimelineEvent = {
  key: "agent-1:opening",
  type: "agent_output",
  title: "agent-1 · opening",
  summary: "Primary line",
  timestamp: "2026-05-09T02:00:02Z",
  agentId: "agent-1",
  agentModel: "qwen/qwen3.5-flash-02-23",
  stage: "opening",
  canonicalStage: "opening",
  displayPrimary: "Primary line",
  rawText: "Primary line",
  streamChannel: "content",
};

const mergedTimeline = upsertTimelineEvent([draftEvent], finalEvent);
assert.equal(mergedTimeline.length, 1);
assert.equal(mergedTimeline[0].displayPrimary, "Primary line");
assert.equal(mergedTimeline[0].displaySupport, undefined);
assert.equal(mergedTimeline[0].summary, "Primary line");

const graph = buildGraphLayout(mergedTimeline, { taskText: "Pick a vendor", taskId: "task-1" });
const agentNode = graph.nodes.find((node) => node.agentId === "agent-1");

assert.ok(agentNode, "expected merged agent node");
assert.equal(agentNode?.content, "Primary line");
assert.equal(agentNode?.supportContent, undefined);

console.log("canvas-timeline-ok");
