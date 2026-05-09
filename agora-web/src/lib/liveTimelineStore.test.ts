import assert from "node:assert/strict";
import test from "node:test";

import type { TimelineEvent } from "./deliberationTimeline";
import {
  EMPTY_TIMELINE_STORE,
  buildTimelineStore,
  materializeTimeline,
  mergeTimelineStore,
  upsertTimelineStore,
} from "./liveTimelineStore";

function event(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, "key" | "type" | "title" | "summary">): TimelineEvent {
  return {
    timestamp: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}

test("upsertTimelineStore appends new keys in order", () => {
  const store = upsertTimelineStore(
    upsertTimelineStore(
      EMPTY_TIMELINE_STORE,
      event({ key: "a", type: "agent_output", title: "A", summary: "first" }),
    ),
    event({ key: "b", type: "agent_output", title: "B", summary: "second" }),
  );

  assert.deepEqual(store.orderedKeys, ["a", "b"]);
  assert.equal(materializeTimeline(store)[1]?.summary, "second");
});

test("upsertTimelineStore replaces existing draft entries without duplicating order", () => {
  const first = event({
    key: "draft-1",
    type: "agent_output_delta",
    title: "agent-1",
    summary: "hello",
    isDraft: true,
    displayPrimary: "hello",
    streamChannel: "content",
  });
  const update = event({
    key: "draft-1",
    type: "agent_output_delta",
    title: "agent-1",
    summary: "hello world",
    isDraft: true,
    displayPrimary: "hello world",
    streamChannel: "content",
  });

  const store = upsertTimelineStore(
    upsertTimelineStore(EMPTY_TIMELINE_STORE, first),
    update,
  );

  assert.deepEqual(store.orderedKeys, ["draft-1"]);
  assert.equal(materializeTimeline(store)[0]?.summary, "hello world");
});

test("mergeTimelineStore preserves prior ordering while patching existing keys", () => {
  const baseline = buildTimelineStore([
    event({ key: "a", type: "agent_output", title: "A", summary: "first" }),
    event({ key: "b", type: "agent_output", title: "B", summary: "second" }),
  ]);

  const merged = mergeTimelineStore(baseline, [
    event({ key: "b", type: "agent_output", title: "B", summary: "second revised" }),
    event({ key: "c", type: "agent_output", title: "C", summary: "third" }),
  ]);

  assert.deepEqual(merged.orderedKeys, ["a", "b", "c"]);
  assert.deepEqual(
    materializeTimeline(merged).map((entry) => entry.summary),
    ["first", "second revised", "third"],
  );
});
