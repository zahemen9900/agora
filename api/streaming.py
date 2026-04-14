"""Async SSE stream manager for deliberation events."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any


class DeliberationStream:
    """Fan-out event stream keyed by task id."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue[dict[str, Any] | None]]] = defaultdict(list)

    def subscribe(self, task_id: str) -> asyncio.Queue[dict[str, Any] | None]:
        """Create a live queue subscription for a task."""

        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._subscribers[task_id].append(queue)
        return queue

    async def emit(self, task_id: str, payload: dict[str, Any]) -> None:
        """Emit a fully-formed event envelope to all live subscribers for a task."""

        for queue in list(self._subscribers.get(task_id, [])):
            await queue.put(payload)

    async def close(self, task_id: str) -> None:
        """Close all live streams for a task."""

        subscribers = self._subscribers.pop(task_id, [])
        for queue in subscribers:
            await queue.put(None)

    def unsubscribe(
        self,
        task_id: str,
        queue: asyncio.Queue[dict[str, Any] | None],
    ) -> None:
        """Remove an individual subscriber queue."""

        subscribers = self._subscribers.get(task_id, [])
        if queue in subscribers:
            subscribers.remove(queue)
        if not subscribers and task_id in self._subscribers:
            del self._subscribers[task_id]


_stream = DeliberationStream()


def get_stream_manager() -> DeliberationStream:
    """Return the singleton stream manager."""

    return _stream
