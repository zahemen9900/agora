import type { TimelineEvent } from "./deliberationTimeline";

export interface VirtualWindowRange {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
}

const DEFAULT_ROW_HEIGHT = 188;
const DRAFT_ROW_HEIGHT = 228;
const TOOL_ROW_HEIGHT = 236;
const TOOL_EXPANDED_ROW_HEIGHT = 420;
const LONG_SUMMARY_THRESHOLD = 220;
const LONG_SUMMARY_EXTRA_HEIGHT = 56;

export function estimateTimelineRowHeight(
  event: TimelineEvent,
  options: { expanded?: boolean } = {},
): number {
  const expanded = Boolean(options.expanded);
  let baseHeight = DEFAULT_ROW_HEIGHT;

  if (event.streamChannel === "tool") {
    baseHeight = expanded ? TOOL_EXPANDED_ROW_HEIGHT : TOOL_ROW_HEIGHT;
  } else if (event.isDraft) {
    baseHeight = DRAFT_ROW_HEIGHT;
  }

  if (event.summary.length > LONG_SUMMARY_THRESHOLD) {
    baseHeight += LONG_SUMMARY_EXTRA_HEIGHT;
  }

  return baseHeight;
}

function prefixSums(events: TimelineEvent[], heights: Map<string, number>, expandedKeys?: ReadonlySet<string>): number[] {
  const sums: number[] = new Array(events.length + 1);
  sums[0] = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const height = heights.get(event.key)
      ?? estimateTimelineRowHeight(event, { expanded: expandedKeys?.has(event.key) });
    sums[index + 1] = sums[index] + height;
  }

  return sums;
}

function firstIndexAtOrAbove(offsets: number[], target: number): number {
  let low = 0;
  let high = offsets.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

export function computeVirtualWindow(
  events: TimelineEvent[],
  options: {
    viewportTop: number;
    viewportHeight: number;
    overscanPx: number;
    measuredHeights: Map<string, number>;
    expandedKeys?: ReadonlySet<string>;
  },
): VirtualWindowRange {
  if (events.length === 0) {
    return {
      startIndex: 0,
      endIndex: -1,
      topPadding: 0,
      bottomPadding: 0,
    };
  }

  const { viewportTop, viewportHeight, overscanPx, measuredHeights, expandedKeys } = options;
  const offsets = prefixSums(events, measuredHeights, expandedKeys);
  const totalHeight = offsets[offsets.length - 1];
  const startTarget = Math.max(0, viewportTop - overscanPx);
  const endTarget = Math.min(totalHeight, viewportTop + viewportHeight + overscanPx);

  const startIndex = Math.min(
    events.length - 1,
    firstIndexAtOrAbove(offsets, startTarget + 1) - 1 < 0
      ? 0
      : firstIndexAtOrAbove(offsets, startTarget + 1) - 1,
  );
  const rawEndIndex = firstIndexAtOrAbove(offsets, endTarget);
  const endIndex = Math.min(events.length - 1, Math.max(startIndex, rawEndIndex));

  const topPadding = offsets[startIndex] ?? 0;
  const bottomPadding = Math.max(0, totalHeight - (offsets[endIndex + 1] ?? totalHeight));

  return {
    startIndex,
    endIndex,
    topPadding,
    bottomPadding,
  };
}
