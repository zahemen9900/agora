"""In-memory SSE streaming manager for task events."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncGenerator
from typing import Any


class SSEManager:
    """Simple in-memory pub/sub manager keyed by task id."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)

    async def publish(self, task_id: str, event: dict[str, Any]) -> None:
        for queue in self._subscribers.get(task_id, []):
            await queue.put(event)

    async def stream(self, task_id: str) -> AsyncGenerator[dict[str, Any], None]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers[task_id].append(queue)

        try:
            while True:
                item = await queue.get()
                yield item
                if item.get("event") == "complete":
                    return
        finally:
            subscribers = self._subscribers.get(task_id, [])
            if queue in subscribers:
                subscribers.remove(queue)


_manager = SSEManager()


def get_stream_manager() -> SSEManager:
    return _manager
