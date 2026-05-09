import { upsertTimelineEvent, type TimelineEvent } from "./deliberationTimeline";

export interface TimelineStore {
  orderedKeys: string[];
  eventsByKey: Record<string, TimelineEvent>;
}

export const EMPTY_TIMELINE_STORE: TimelineStore = {
  orderedKeys: [],
  eventsByKey: {},
};

function mergeTimelineEntries(previous: TimelineEvent, next: TimelineEvent): TimelineEvent {
  return upsertTimelineEvent([previous], next)[0] ?? next;
}

export function buildTimelineStore(events: TimelineEvent[]): TimelineStore {
  return mergeTimelineStore(EMPTY_TIMELINE_STORE, events);
}

export function upsertTimelineStore(store: TimelineStore, nextEvent: TimelineEvent): TimelineStore {
  const previous = store.eventsByKey[nextEvent.key];
  if (!previous) {
    return {
      orderedKeys: [...store.orderedKeys, nextEvent.key],
      eventsByKey: {
        ...store.eventsByKey,
        [nextEvent.key]: nextEvent,
      },
    };
  }

  const merged = mergeTimelineEntries(previous, nextEvent);
  if (Object.is(merged, previous)) {
    return store;
  }

  return {
    orderedKeys: store.orderedKeys,
    eventsByKey: {
      ...store.eventsByKey,
      [nextEvent.key]: merged,
    },
  };
}

export function mergeTimelineStore(store: TimelineStore, events: TimelineEvent[]): TimelineStore {
  let nextStore = store;
  for (const event of events) {
    nextStore = upsertTimelineStore(nextStore, event);
  }
  return nextStore;
}

export function materializeTimeline(store: TimelineStore): TimelineEvent[] {
  return store.orderedKeys
    .map((key) => store.eventsByKey[key])
    .filter((entry): entry is TimelineEvent => Boolean(entry));
}
