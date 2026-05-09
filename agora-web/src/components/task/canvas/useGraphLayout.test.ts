import assert from "node:assert/strict";
import test from "node:test";

import { buildGraphLayout } from "./useGraphLayout";

test("buildGraphLayout keeps post-switch vote rows after switch bridge", () => {
  const timeline = [
    {
      key: "selector",
      type: "mechanism_selected",
      title: "selector",
      summary: "",
      segmentIndex: 0,
      segmentMechanism: "debate",
      canonicalStage: "selector",
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
      },
    },
    {
      key: "debate-opening",
      type: "agent_output",
      title: "debate-opening",
      summary: "",
      agentId: "agent-1",
      stage: "opening",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "opening",
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
        segment_round: 1,
      },
    },
    {
      key: "switch-0",
      type: "mechanism_switch",
      title: "switch-0",
      summary: "",
      segmentIndex: 0,
      segmentMechanism: "debate",
      canonicalStage: "switch",
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        next_execution_segment: 1,
        next_segment_mechanism: "vote",
      },
    },
    {
      key: "vote-round-1",
      type: "agent_output",
      title: "vote-round-1",
      summary: "",
      agentId: "agent-1",
      stage: "vote",
      segmentIndex: 1,
      segmentMechanism: "vote",
      segmentRound: 1,
      canonicalStage: "vote",
      details: {
        execution_segment: 1,
        segment_mechanism: "vote",
        round_number: 1,
        segment_round: 1,
      },
    },
    {
      key: "quorum",
      type: "quorum_reached",
      title: "quorum",
      summary: "",
      segmentIndex: 1,
      segmentMechanism: "vote",
      canonicalStage: "quorum",
      details: {
        execution_segment: 1,
      },
    },
  ];

  const { nodes, edges } = buildGraphLayout(timeline);

  const debateNode = nodes.find((node) => node.title === "debate-opening");
  const switchNode = nodes.find((node) => node.title === "switch-0");
  const voteNode = nodes.find((node) => node.title === "vote-round-1");

  assert.ok(debateNode);
  assert.ok(switchNode);
  assert.ok(voteNode);
  assert.ok(debateNode.row < switchNode.row);
  assert.ok(switchNode.row < voteNode.row);
  assert.match(voteNode.id, /^agent:1:agent-1:vote:1$/);
  assert.ok(edges.some((edge) => edge.fromNodeId === switchNode.id && edge.toNodeId === voteNode.id));
});

test("buildGraphLayout keeps identical agent-stage-round nodes separate across segments", () => {
  const timeline = [
    {
      key: "seg0-opening",
      type: "agent_output",
      title: "seg0-opening",
      summary: "",
      agentId: "agent-1",
      stage: "opening",
      segmentIndex: 0,
      segmentMechanism: "vote",
      segmentRound: 1,
      canonicalStage: "opening",
      details: {
        execution_segment: 0,
        segment_mechanism: "vote",
        round_number: 1,
      },
    },
    {
      key: "switch-0",
      type: "mechanism_switch",
      title: "switch-0",
      summary: "",
      segmentIndex: 0,
      segmentMechanism: "vote",
      canonicalStage: "switch",
      details: {
        execution_segment: 0,
        next_execution_segment: 1,
        next_segment_mechanism: "debate",
      },
    },
    {
      key: "seg1-opening",
      type: "agent_output",
      title: "seg1-opening",
      summary: "",
      agentId: "agent-1",
      stage: "opening",
      segmentIndex: 1,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "opening",
      details: {
        execution_segment: 1,
        segment_mechanism: "debate",
        round_number: 1,
      },
    },
  ];

  const { nodes } = buildGraphLayout(timeline);
  const openingNodes = nodes.filter(
    (node) => node.kind === "agent" && node.agentId === "agent-1" && node.stage === "opening",
  );

  assert.equal(openingNodes.length, 2);
  assert.notEqual(openingNodes[0].id, openingNodes[1].id);
  assert.notEqual(openingNodes[0].row, openingNodes[1].row);
});

test("buildGraphLayout annotates split source nodes with transition labels", () => {
  const timeline = [
    {
      key: "opening",
      type: "agent_output",
      title: "opening",
      summary: "opening answer",
      agentId: "agent-1",
      stage: "opening",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "opening",
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
      },
    },
    {
      key: "rebuttal-a",
      type: "agent_output",
      title: "rebuttal-a",
      summary: "a",
      agentId: "agent-1",
      stage: "rebuttal",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "rebuttal",
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
      },
    },
    {
      key: "rebuttal-b",
      type: "agent_output",
      title: "rebuttal-b",
      summary: "b",
      agentId: "agent-2",
      stage: "rebuttal",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "rebuttal",
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
      },
    },
  ];

  const { nodes } = buildGraphLayout(timeline);
  const openingNode = nodes.find((node) => node.title === "opening");

  assert.ok(openingNode);
  assert.equal(openingNode.transitionLabel, "Opening R1");
  assert.match(openingNode.transitionDescription ?? "", /debate segment/i);
});

test("buildGraphLayout keeps normalized content when later telemetry and thinking updates arrive", () => {
  const timeline = [
    {
      key: "agent:0:agent-1:opening:1",
      type: "agent_output_delta",
      title: "agent-1 · opening",
      summary: "Major central banks should proceed carefully.",
      agentId: "agent-1",
      stage: "opening",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "opening",
      isDraft: true,
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
        content_so_far: "{\"claim\":\"Major central banks should proceed carefully.\"",
        thinking_so_far: "Start by comparing implementation risk.",
        total_tokens: 2055,
        latency_ms: 12519,
      },
    },
  ];

  const { nodes } = buildGraphLayout(timeline);
  const openingNode = nodes.find((node) => node.agentId === "agent-1");

  assert.ok(openingNode);
  assert.equal(openingNode.content, "Major central banks should proceed carefully.");
  assert.equal(openingNode.thinkingContent, "Start by comparing implementation risk.");
  assert.equal(openingNode.telemetry?.totalTokens, 2055);
  assert.equal(openingNode.telemetry?.latencyMs, 12519);
});

test("buildGraphLayout keeps sandbox execution inline on the originating agent card and preserves its output preview", () => {
  const timeline = [
    {
      key: "agent:0:agent-2:rebuttal:1",
      type: "agent_output",
      title: "agent-2 · rebuttal",
      summary: "Primary rebuttal content",
      agentId: "agent-2",
      agentModel: "claude-sonnet-4-6",
      stage: "rebuttal",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "rebuttal",
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
      },
    },
    {
      key: "sandbox-start",
      type: "sandbox_execution_started",
      title: "agent-2 · execute_python",
      summary: "Starting sandbox execution",
      agentId: "agent-2",
      agentModel: "claude-sonnet-4-6",
      stage: "rebuttal",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "rebuttal",
      streamChannel: "tool" as const,
      toolCallId: "tool-123",
      toolName: "execute_python",
      toolStatus: "running" as const,
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
        python_code_preview: "print('hello')",
      },
    },
    {
      key: "sandbox-delta",
      type: "sandbox_execution_delta",
      title: "agent-2 · execute_python",
      summary: "stdout preview",
      agentId: "agent-2",
      agentModel: "claude-sonnet-4-6",
      stage: "rebuttal",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "rebuttal",
      streamChannel: "tool" as const,
      toolCallId: "tool-123",
      toolName: "execute_python",
      toolStatus: "running" as const,
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
        stdout_preview: "result rows",
      },
    },
    {
      key: "sandbox-complete",
      type: "sandbox_execution_completed",
      title: "agent-2 · execute_python",
      summary: "Script ran to completion and returned output.",
      agentId: "agent-2",
      agentModel: "claude-sonnet-4-6",
      stage: "rebuttal",
      segmentIndex: 0,
      segmentMechanism: "debate",
      segmentRound: 1,
      canonicalStage: "rebuttal",
      streamChannel: "tool" as const,
      toolCallId: "tool-123",
      toolName: "execute_python",
      toolStatus: "success" as const,
      details: {
        execution_segment: 0,
        segment_mechanism: "debate",
        round_number: 1,
        summary: "Script ran to completion and returned output.",
        stderr_preview: "",
      },
    },
  ];

  const { nodes } = buildGraphLayout(timeline);
  const rebuttalNode = nodes.find((node) => node.kind === "agent" && node.agentId === "agent-2" && node.stage === "rebuttal");
  const sandboxNode = nodes.find((node) => node.kind === "tool" && node.toolName === "execute_python");

  assert.ok(rebuttalNode);
  assert.equal(rebuttalNode.kind, "agent");
  assert.equal(rebuttalNode.toolActivities?.length ?? 0, 1);
  assert.equal(rebuttalNode.toolActivities?.[0]?.name, "execute_python");
  assert.equal(rebuttalNode.toolActivities?.[0]?.status, "success");
  assert.equal(rebuttalNode.toolActivities?.[0]?.summary, "result rows");
  assert.equal(sandboxNode, undefined);
});
