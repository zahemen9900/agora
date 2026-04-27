import assert from "node:assert/strict";
import test from "node:test";

import type { TaskEvent } from "./api.generated";
import {
  inferSegmentedTaskEvents,
  segmentDraftKeyForEvent,
  segmentMetadataForTaskEvent,
} from "./segmentTimeline";

test("inferSegmentedTaskEvents infers segment boundaries from mechanism_switch when metadata is absent", () => {
  const events: TaskEvent[] = [
    {
      event: "mechanism_selected",
      timestamp: "2026-04-26T00:00:00.000Z",
      data: {
        mechanism: "debate",
      },
    },
    {
      event: "agent_output",
      timestamp: "2026-04-26T00:00:01.000Z",
      data: {
        agent_id: "agent-1",
        stage: "opening",
        round_number: 1,
        content: "pre-switch",
      },
    },
    {
      event: "mechanism_switch",
      timestamp: "2026-04-26T00:00:02.000Z",
      data: {
        from_mechanism: "debate",
        to_mechanism: "vote",
        round_number: 1,
      },
    },
    {
      event: "agent_output",
      timestamp: "2026-04-26T00:00:03.000Z",
      data: {
        agent_id: "agent-1",
        stage: "vote",
        round_number: 1,
        content: "post-switch",
      },
    },
  ];

  const segmented = inferSegmentedTaskEvents(events, "debate");

  assert.equal(segmented.events[0].data.execution_segment, 0);
  assert.equal(segmented.events[0].data.segment_mechanism, "debate");

  assert.equal(segmented.events[1].data.execution_segment, 0);
  assert.equal(segmented.events[1].data.segment_mechanism, "debate");
  assert.equal(segmented.events[1].data.segment_round, 1);

  assert.equal(segmented.events[2].data.execution_segment, 0);
  assert.equal(segmented.events[2].data.segment_mechanism, "debate");
  assert.equal(segmented.events[2].data.next_execution_segment, 1);
  assert.equal(segmented.events[2].data.next_segment_mechanism, "vote");

  assert.equal(segmented.events[3].data.execution_segment, 1);
  assert.equal(segmented.events[3].data.segment_mechanism, "vote");
  assert.equal(segmented.events[3].data.segment_round, 1);

  assert.equal(segmented.state.activeSegmentIndex, 1);
  assert.equal(segmented.state.activeMechanism, "vote");
});

test("segmentDraftKeyForEvent isolates matching stage/round events by segment", () => {
  const segmentZeroEvent: TaskEvent = {
    event: "agent_output_delta",
    timestamp: "2026-04-26T00:00:00.000Z",
    data: {
      execution_segment: 0,
      agent_id: "agent-1",
      stage: "vote",
      round_number: 1,
    },
  };
  const segmentOneEvent: TaskEvent = {
    event: "agent_output",
    timestamp: "2026-04-26T00:00:01.000Z",
    data: {
      execution_segment: 1,
      agent_id: "agent-1",
      stage: "vote",
      round_number: 1,
    },
  };

  const keyZero = segmentDraftKeyForEvent(segmentZeroEvent);
  const keyOne = segmentDraftKeyForEvent(segmentOneEvent);

  assert.equal(keyZero, "0:agent-1:vote:1");
  assert.equal(keyOne, "1:agent-1:vote:1");
  assert.notEqual(keyZero, keyOne);
});

test("segmentMetadataForTaskEvent exposes canonical stage and segment indices", () => {
  const metadata = segmentMetadataForTaskEvent({
    event: "cross_examination",
    timestamp: "2026-04-26T00:00:00.000Z",
    data: {
      execution_segment: 2,
      segment_mechanism: "debate",
      round_number: 3,
      stage: "cross_examination",
    },
  });

  assert.equal(metadata.segmentIndex, 2);
  assert.equal(metadata.segmentMechanism, "debate");
  assert.equal(metadata.segmentRound, 3);
  assert.equal(metadata.canonicalStage, "cross_examination");
});
