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
