import assert from "node:assert/strict";
import test from "node:test";

import type { TaskEvent } from "./api.generated";
import {
  buildDeliberationTimeline,
  deriveFinalAnswerFromEvents,
} from "./deliberationTimeline";

test("buildDeliberationTimeline keeps switched benchmark item events in later segments", () => {
  const events: TaskEvent[] = [
    {
      event: "mechanism_selected",
      timestamp: "2026-04-28T00:00:00.000Z",
      data: {
        mechanism: "debate",
      },
    },
    {
      event: "agent_output",
      timestamp: "2026-04-28T00:00:01.000Z",
      data: {
        agent_id: "agent-1",
        stage: "opening",
        round_number: 1,
        content: "debate opening",
      },
    },
    {
      event: "mechanism_switch",
      timestamp: "2026-04-28T00:00:02.000Z",
      data: {
        from_mechanism: "debate",
        to_mechanism: "vote",
      },
    },
    {
      event: "agent_output",
      timestamp: "2026-04-28T00:00:03.000Z",
      data: {
        agent_id: "agent-1",
        stage: "vote",
        round_number: 1,
        content: "vote after switch",
      },
    },
  ];

  const timeline = buildDeliberationTimeline(events, "debate");
  const opening = timeline.find((entry) => entry.title === "agent-1 · agent");
  const switchEvent = timeline.find((entry) => entry.title === "Mechanism switch");
  const vote = timeline.find((entry) => entry.summary === "vote after switch");

  assert.ok(opening);
  assert.ok(switchEvent);
  assert.ok(vote);
  assert.equal(opening.segmentIndex, 0);
  assert.equal(opening.segmentRound, 1);
  assert.equal(switchEvent.segmentIndex, 0);
  assert.equal(vote.segmentIndex, 1);
  assert.equal(vote.segmentRound, 1);
  assert.equal(vote.canonicalStage, "vote");
});

test("deriveFinalAnswerFromEvents prefers quorum payloads when benchmark item summary is absent", () => {
  const finalAnswer = deriveFinalAnswerFromEvents([
    {
      event: "agent_output",
      timestamp: "2026-04-28T00:00:01.000Z",
      data: {
        agent_id: "agent-1",
        content: "draft",
      },
    },
    {
      event: "quorum_reached",
      timestamp: "2026-04-28T00:00:02.000Z",
      data: {
        final_answer: "Ship the migration plan.",
        confidence: 0.82,
        mechanism: "vote",
      },
    },
  ], "debate");

  assert.deepEqual(finalAnswer, {
    text: "Ship the migration plan.",
    confidence: 0.82,
    mechanism: "vote",
  });
});

test("buildDeliberationTimeline surfaces Delphi feedback, nested convergence metrics, and finalization", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "mechanism_selected",
      timestamp: "2026-04-28T00:00:00.000Z",
      data: {
        mechanism: "delphi",
      },
    },
    {
      event: "convergence_update",
      timestamp: "2026-04-28T00:00:01.000Z",
      data: {
        mechanism: "delphi",
        round_number: 1,
        stage: "independent_generation",
        metrics: {
          disagreement_entropy: 0.41,
          information_gain_delta: 0.18,
        },
      },
    },
    {
      event: "delphi_feedback",
      timestamp: "2026-04-28T00:00:02.000Z",
      data: {
        mechanism: "delphi",
        round_number: 1,
        stage: "anonymize_and_distribute",
        feedback: {
          "agent-1": ["Tighten the evidence."],
          "agent-2": ["Address the counterexample."],
        },
      },
    },
    {
      event: "delphi_finalize",
      timestamp: "2026-04-28T00:00:03.000Z",
      data: {
        mechanism: "delphi",
        round_number: 2,
        final_answer: "Adopt the staged rollout.",
        confidence: 0.78,
      },
    },
  ], "delphi");

  const convergence = timeline.find((entry) => entry.type === "convergence_update");
  const feedback = timeline.find((entry) => entry.type === "delphi_feedback");
  const finalize = timeline.find((entry) => entry.type === "delphi_finalize");

  assert.ok(convergence);
  assert.match(convergence.summary, /Entropy 0.41/);
  assert.equal(convergence.details?.information_gain_delta, 0.18);
  assert.ok(feedback);
  assert.match(feedback.summary, /2 anonymous peer critiques distributed/i);
  assert.equal(feedback.canonicalStage, "anonymize_and_distribute");
  assert.ok(finalize);
  assert.equal(finalize.summary, "Adopt the staged rollout.");
  assert.equal(finalize.confidence, 0.78);
});

test("buildDeliberationTimeline normalizes vote agent outputs instead of showing raw JSON", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "agent_output",
      timestamp: "2026-05-03T00:00:01.000Z",
      data: {
        agent_id: "agent-1",
        agent_model: "gemini-3-flash-preview",
        stage: "vote",
        round_number: 1,
        content: JSON.stringify({
          answer: "Start with a modular monolith.",
          reasoning: "It preserves delivery speed while avoiding premature distributed complexity.",
          confidence: 0.81,
        }),
      },
    },
  ], "vote");

  assert.equal(timeline.length, 1);
  const vote = timeline[0];
  assert.equal(vote.summary, "Start with a modular monolith.\nIt preserves delivery speed while avoiding premature distributed complexity.");
  assert.doesNotMatch(vote.summary, /\{|\}|\"answer\"|\"reasoning\"/);
});

test("buildDeliberationTimeline normalizes Delphi agent outputs instead of showing raw JSON", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "agent_output",
      timestamp: "2026-05-03T00:00:01.000Z",
      data: {
        agent_id: "agent-2",
        agent_model: "claude-sonnet-4-6",
        stage: "revision_round",
        round_number: 2,
        content: JSON.stringify({
          answer: "Ship a staged rollout with a kill switch.",
          reasoning: "That approach reduces irreversible risk while still collecting real traffic evidence.",
          confidence: 0.77,
        }),
      },
    },
  ], "delphi");

  const revision = timeline[0];
  assert.equal(revision.summary, "Ship a staged rollout with a kill switch.\nThat approach reduces irreversible risk while still collecting real traffic evidence.");
  assert.doesNotMatch(revision.summary, /\{|\}|\"answer\"|\"reasoning\"/);
});

test("buildDeliberationTimeline keeps content authoritative when usage and thinking deltas arrive later", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "agent_output_delta",
      timestamp: "2026-05-03T00:00:01.000Z",
      data: {
        agent_id: "agent-1",
        agent_model: "gemini-3-flash-preview",
        stage: "opening",
        round_number: 1,
        content_delta: "{\"claim\":\"Major central banks should proceed carefully",
        content_so_far: "{\"claim\":\"Major central banks should proceed carefully",
      },
    },
    {
      event: "usage_delta",
      timestamp: "2026-05-03T00:00:02.000Z",
      data: {
        agent_id: "agent-1",
        agent_model: "gemini-3-flash-preview",
        stage: "opening",
        round_number: 1,
        total_tokens: 2055,
        input_tokens: 390,
        output_tokens: 1665,
        thinking_tokens: 1593,
        latency_ms: 12519,
      },
    },
    {
      event: "thinking_delta",
      timestamp: "2026-05-03T00:00:03.000Z",
      data: {
        agent_id: "agent-1",
        agent_model: "gemini-3-flash-preview",
        stage: "opening",
        round_number: 1,
        thinking_delta: "Compare implementation risk first.",
        thinking_so_far: "Compare implementation risk first.",
      },
    },
  ], "debate");

  assert.equal(timeline.length, 1);
  const draft = timeline[0];
  assert.match(draft.summary, /Major central banks should proceed carefully/);
  assert.doesNotMatch(draft.summary, /2,055 tokens|12519 ms|thinking tokens/i);
  assert.equal(draft.details?.thinking_so_far, "Compare implementation risk first.");
  assert.equal(draft.details?.total_tokens, 2055);
});

test("buildDeliberationTimeline extracts human-readable cross-examination summaries from structured payloads", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "cross_examination",
      timestamp: "2026-05-03T00:00:01.000Z",
      data: {
        agent_id: "debate-devils-advocate",
        agent_model: "claude-sonnet-4-6",
        stage: "cross_examination",
        round_number: 1,
        payload: {
          analyses: [
            {
              faction: "pro",
              weakest_claim: "privacy claim",
              question: "What present constraint rules out the simpler rollout?",
            },
          ],
        },
      },
    },
  ], "debate");

  assert.equal(timeline[0].summary, "pro: What present constraint rules out the simpler rollout?");
});

test("buildDeliberationTimeline progressively extracts user-facing text from partial structured vote streams", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "agent_output_delta",
      timestamp: "2026-05-03T00:00:01.000Z",
      data: {
        agent_id: "agent-3",
        agent_model: "qwen/qwen3.5-flash-02-23",
        stage: "vote",
        round_number: 1,
        content_delta: "{\"answer\":\"Use a monolith first",
        content_so_far: "{\"answer\":\"Use a monolith first",
      },
    },
  ], "vote");

  assert.equal(timeline[0].summary, "Use a monolith first");
  assert.doesNotMatch(timeline[0].summary, /\{|\}|\"answer\"/);
});

test("buildDeliberationTimeline progressively extracts debate opening claims from partial JSON streams", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "agent_output_delta",
      timestamp: "2026-05-03T00:00:01.000Z",
      data: {
        agent_id: "agent-1",
        agent_model: "claude-sonnet-4-6",
        stage: "opening",
        round_number: 1,
        content_so_far: "{\"claim\":\"Adopt a privacy-by-design rollout\",\"evidence\":\"Zero-knowledge proofs reduce disclosure",
      },
    },
  ], "debate");

  assert.equal(
    timeline[0].summary,
    "Adopt a privacy-by-design rollout\nZero-knowledge proofs reduce disclosure",
  );
  assert.doesNotMatch(timeline[0].summary, /\{|\}|\"claim\"|\"evidence\"/);
});

test("buildDeliberationTimeline progressively extracts Delphi revisions from partial JSON streams", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "agent_output_delta",
      timestamp: "2026-05-03T00:00:01.000Z",
      data: {
        agent_id: "agent-2",
        agent_model: "gemini-3-flash-preview",
        stage: "revision_round",
        round_number: 2,
        content_so_far: "{\"answer\":\"Ship a staged rollout\",\"reasoning\":\"It gives us reversible checkpoints",
      },
    },
  ], "delphi");

  assert.equal(
    timeline[0].summary,
    "Ship a staged rollout\nIt gives us reversible checkpoints",
  );
  assert.doesNotMatch(timeline[0].summary, /\{|\}|\"answer\"|\"reasoning\"/);
});

test("buildDeliberationTimeline maps sandbox execution start events onto the tool stream", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "sandbox_execution_started",
      timestamp: "2026-05-09T00:00:01.000Z",
      data: {
        agent_id: "agent-2",
        agent_model: "claude-sonnet-4-6",
        stage: "rebuttal",
        round_number: 1,
        tool_call_id: "tool-123",
        tool_name: "execute_python",
        python_code_preview: "print('hello world')",
      },
    },
  ], "debate");

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.streamChannel, "tool");
  assert.equal(timeline[0]?.toolCallId, "tool-123");
  assert.equal(timeline[0]?.toolName, "execute_python");
  assert.equal(timeline[0]?.toolStatus, "running");
  assert.equal(timeline[0]?.agentId, "agent-2");
});

test("buildDeliberationTimeline keeps distinct tool lifecycle cards for the same tool call", () => {
  const timeline = buildDeliberationTimeline([
    {
      event: "tool_call_started",
      timestamp: "2026-05-09T00:00:01.000Z",
      data: {
        agent_id: "agent-2",
        stage: "rebuttal",
        round_number: 1,
        tool_call_id: "tool-abc",
        tool_name: "search_online",
        rationale: "ground with web search",
      },
    },
    {
      event: "tool_call_delta",
      timestamp: "2026-05-09T00:00:02.000Z",
      data: {
        agent_id: "agent-2",
        stage: "rebuttal",
        round_number: 1,
        tool_call_id: "tool-abc",
        tool_name: "search_online",
        result_preview: "Found 3 supporting sources.",
      },
    },
    {
      event: "tool_call_completed",
      timestamp: "2026-05-09T00:00:03.000Z",
      data: {
        agent_id: "agent-2",
        stage: "rebuttal",
        round_number: 1,
        tool_call_id: "tool-abc",
        tool_name: "search_online",
        summary: "search_online completed",
      },
    },
  ], "debate");

  assert.equal(timeline.length, 3);
  assert.deepEqual(
    timeline.map((entry) => entry.key),
    [
      "tool-abc:tool_call_started",
      "tool-abc:tool_call_delta",
      "tool-abc:tool_call_completed",
    ],
  );
  assert.ok(timeline.every((entry) => entry.streamChannel === "tool"));
});
