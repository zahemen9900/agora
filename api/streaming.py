"""Async SSE stream manager for deliberation events."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from typing import Any

import structlog

from api.config import settings

logger = structlog.get_logger(__name__)


class DeliberationStream:
    """Fan-out event stream keyed by task id."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue[dict[str, Any] | None]]] = defaultdict(list)
        self._instance_id = uuid.uuid4().hex
        self._listener_task: asyncio.Task[None] | None = None
        self._redis = None
        self._pubsub = None
        self._channel_prefix = (
            f"{settings.coordination_namespace.strip() or 'agora'}:stream:"
        )

        backend = settings.coordination_backend.strip().lower()
        redis_url = settings.redis_url.strip()
        if backend == "redis" and redis_url:
            try:
                from redis.asyncio import Redis

                self._redis = Redis.from_url(redis_url, decode_responses=True)
                self._pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
            except Exception as exc:  # pragma: no cover - import/runtime guard
                logger.warning(
                    "stream_redis_init_failed",
                    error=str(exc),
                )
                self._redis = None
                self._pubsub = None

    def _redis_enabled(self) -> bool:
        return self._redis is not None and self._pubsub is not None

    def _channel(self, task_id: str) -> str:
        return f"{self._channel_prefix}{task_id}"

    async def _emit_local(self, task_id: str, payload: dict[str, Any]) -> None:
        for queue in list(self._subscribers.get(task_id, [])):
            await queue.put(payload)

    async def _close_local(self, task_id: str) -> None:
        subscribers = self._subscribers.pop(task_id, [])
        for queue in subscribers:
            await queue.put(None)

    def _ensure_listener_started(self) -> None:
        if not self._redis_enabled() or self._listener_task is not None:
            return
        self._listener_task = asyncio.create_task(self._redis_listener())

    async def _redis_listener(self) -> None:
        assert self._pubsub is not None
        while True:
            message = await self._pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message is None:
                await asyncio.sleep(0.01)
                continue

            data = message.get("data")
            if not isinstance(data, str):
                continue

            try:
                envelope = json.loads(data)
            except ValueError:
                logger.warning("stream_redis_payload_invalid", payload=data)
                continue

            if envelope.get("origin") == self._instance_id:
                continue

            channel = message.get("channel")
            if not isinstance(channel, str):
                continue
            task_id = channel.removeprefix(self._channel_prefix)
            kind = envelope.get("kind")
            if kind == "close":
                await self._close_local(task_id)
                continue

            payload = envelope.get("payload")
            if isinstance(payload, dict):
                await self._emit_local(task_id, payload)

    def subscribe(self, task_id: str) -> asyncio.Queue[dict[str, Any] | None]:
        """Create a live queue subscription for a task."""

        first_subscriber = len(self._subscribers.get(task_id, [])) == 0
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._subscribers[task_id].append(queue)

        if self._redis_enabled() and first_subscriber:
            self._ensure_listener_started()
            assert self._pubsub is not None
            asyncio.create_task(self._pubsub.subscribe(self._channel(task_id)))

        return queue

    async def emit(self, task_id: str, payload: dict[str, Any]) -> None:
        """Emit a fully-formed event envelope to all live subscribers for a task."""

        await self._emit_local(task_id, payload)
        if self._redis_enabled():
            assert self._redis is not None
            await self._redis.publish(
                self._channel(task_id),
                json.dumps(
                    {
                        "origin": self._instance_id,
                        "kind": "event",
                        "payload": payload,
                    }
                ),
            )

    async def close(self, task_id: str) -> None:
        """Close all live streams for a task."""

        await self._close_local(task_id)
        if self._redis_enabled():
            assert self._redis is not None
            await self._redis.publish(
                self._channel(task_id),
                json.dumps(
                    {
                        "origin": self._instance_id,
                        "kind": "close",
                    }
                ),
            )

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
            if self._redis_enabled():
                assert self._pubsub is not None
                asyncio.create_task(self._pubsub.unsubscribe(self._channel(task_id)))

    async def reset_state(self) -> None:
        """Clear local subscribers and stop Redis listener (tests/admin cleanup)."""

        channels = list(self._subscribers.keys())
        for task_id in channels:
            await self._close_local(task_id)

        if self._listener_task is not None:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
            self._listener_task = None

        if self._pubsub is not None:
            try:
                await self._pubsub.close()
            except Exception:
                logger.warning("stream_redis_pubsub_close_failed")
            self._pubsub = None

        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception:
                logger.warning("stream_redis_client_close_failed")
            self._redis = None


_stream = DeliberationStream()


def get_stream_manager() -> DeliberationStream:
    """Return the singleton stream manager."""

    return _stream


async def reset_stream_manager_for_tests() -> None:
    """Clear stream manager state in tests to prevent cross-test leakage."""

    await _stream.reset_state()
