import assert from "node:assert/strict";
import test from "node:test";

import type { TimelineEvent } from "./deliberationTimeline";
import {
  computeVirtualWindow,
  estimateTimelineRowHeight,
} from "./liveTimelineVirtualWindow";

function event(overrides: Partial<TimelineEvent> & Pick<TimelineEvent, "key" | "type" | "title" | "summary">): TimelineEvent {
  return {
    timestamp: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}

test("estimateTimelineRowHeight treats expanded tool cards as heavier", () => {
  const toolEvent = event({
    key: "tool-1",
    type: "tool_call_completed",
    title: "tool",
    summary: "done",
    streamChannel: "tool",
  });

  assert.ok(
    estimateTimelineRowHeight(toolEvent, { expanded: true })
      > estimateTimelineRowHeight(toolEvent, { expanded: false }),
  );
});

test("computeVirtualWindow returns a bounded slice with padding", () => {
  const events = Array.from({ length: 50 }, (_, index) => event({
    key: `event-${index}`,
    type: "agent_output",
    title: `event-${index}`,
    summary: `summary-${index}`,
  }));

  const range = computeVirtualWindow(events, {
    viewportTop: 900,
    viewportHeight: 600,
    overscanPx: 300,
    measuredHeights: new Map(),
  });

  assert.ok(range.startIndex >= 0);
  assert.ok(range.endIndex >= range.startIndex);
  assert.ok(range.topPadding >= 0);
  assert.ok(range.bottomPadding >= 0);
  assert.ok(range.endIndex < events.length);
});
