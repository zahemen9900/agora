"""Buffered persistence helpers for low-latency live event streams."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any


class BufferedEventJournal:
    """Emit live events immediately while batching durable writes in-order."""

    def __init__(
        self,
        *,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
        append_many: Callable[[list[dict[str, Any]]], Awaitable[None]],
        flush_interval_seconds: float,
        max_buffered_events: int,
    ) -> None:
        self._emit = emit
        self._append_many = append_many
        self._flush_interval_seconds = flush_interval_seconds
        self._max_buffered_events = max(1, max_buffered_events)
        self._buffer: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._flush_task: asyncio.Task[None] | None = None
        self._flush_error: Exception | None = None
        self._closed = False

    async def publish(self, payload: dict[str, Any], *, buffered: bool) -> None:
        """Emit one event and either persist it immediately or batch it."""

        self._raise_if_failed()
        if self._closed:
            raise RuntimeError("BufferedEventJournal is closed")

        await self._emit(payload)
        if not buffered:
            await self.flush()
            await self._append_many([payload])
            self._raise_if_failed()
            return

        batch_to_flush: list[dict[str, Any]] | None = None
        async with self._lock:
            self._buffer.append(payload)
            if len(self._buffer) >= self._max_buffered_events:
                self._cancel_flush_task_locked()
                batch_to_flush = self._drain_buffer_locked()
            elif self._flush_task is None:
                self._flush_task = asyncio.create_task(self._flush_after_delay())

        if batch_to_flush:
            await self._append_many(batch_to_flush)
            self._raise_if_failed()

    async def flush(self) -> None:
        """Persist any buffered events immediately."""

        self._raise_if_failed()
        batch_to_flush: list[dict[str, Any]] = []
        current_task = asyncio.current_task()
        flush_task: asyncio.Task[None] | None = None

        async with self._lock:
            if self._flush_task is not None and self._flush_task is not current_task:
                flush_task = self._flush_task
                self._flush_task = None
            batch_to_flush = self._drain_buffer_locked()

        if flush_task is not None:
            flush_task.cancel()
            try:
                await flush_task
            except asyncio.CancelledError:
                pass

        if batch_to_flush:
            await self._append_many(batch_to_flush)
        self._raise_if_failed()

    async def close(self) -> None:
        """Flush buffered events and wait for any pending timer task to settle."""

        if self._closed:
            return
        self._closed = True
        await self.flush()

        flush_task = self._flush_task
        self._flush_task = None
        if flush_task is not None and flush_task is not asyncio.current_task():
            try:
                await flush_task
            except asyncio.CancelledError:
                pass
        self._raise_if_failed()

    async def _flush_after_delay(self) -> None:
        try:
            await asyncio.sleep(self._flush_interval_seconds)
            await self.flush()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - surfaced on next publish/flush
            self._flush_error = exc
        finally:
            async with self._lock:
                current = asyncio.current_task()
                if self._flush_task is current:
                    self._flush_task = None

    def _drain_buffer_locked(self) -> list[dict[str, Any]]:
        if not self._buffer:
            return []
        batch = self._buffer[:]
        self._buffer.clear()
        return batch

    def _cancel_flush_task_locked(self) -> None:
        if self._flush_task is None:
            return
        self._flush_task.cancel()
        self._flush_task = None

    def _raise_if_failed(self) -> None:
        if self._flush_error is None:
            return
        error = self._flush_error
        self._flush_error = None
        raise error


class BufferedStateWriter:
    """Throttle repeated state saves while preserving the latest snapshot."""

    def __init__(
        self,
        *,
        save: Callable[[dict[str, Any]], Awaitable[None]],
        snapshot: Callable[[], dict[str, Any]],
        flush_interval_seconds: float,
    ) -> None:
        self._save = save
        self._snapshot = snapshot
        self._flush_interval_seconds = flush_interval_seconds
        self._lock = asyncio.Lock()
        self._dirty = False
        self._flush_task: asyncio.Task[None] | None = None
        self._flush_error: Exception | None = None
        self._closed = False

    async def mark_dirty(self) -> None:
        self._raise_if_failed()
        if self._closed:
            raise RuntimeError("BufferedStateWriter is closed")

        async with self._lock:
            self._dirty = True
            if self._flush_task is None:
                self._flush_task = asyncio.create_task(self._flush_after_delay())

    async def flush(self) -> None:
        self._raise_if_failed()
        should_save = False
        current_task = asyncio.current_task()
        flush_task: asyncio.Task[None] | None = None

        async with self._lock:
            if self._flush_task is not None and self._flush_task is not current_task:
                flush_task = self._flush_task
                self._flush_task = None
            if self._dirty:
                self._dirty = False
                should_save = True

        if flush_task is not None:
            flush_task.cancel()
            try:
                await flush_task
            except asyncio.CancelledError:
                pass

        if should_save:
            await self._save(self._snapshot())
        self._raise_if_failed()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.flush()

        flush_task = self._flush_task
        self._flush_task = None
        if flush_task is not None and flush_task is not asyncio.current_task():
            try:
                await flush_task
            except asyncio.CancelledError:
                pass
        self._raise_if_failed()

    async def _flush_after_delay(self) -> None:
        try:
            await asyncio.sleep(self._flush_interval_seconds)
            await self.flush()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - surfaced on next call
            self._flush_error = exc
        finally:
            async with self._lock:
                current = asyncio.current_task()
                if self._flush_task is current:
                    self._flush_task = None

    def _raise_if_failed(self) -> None:
        if self._flush_error is None:
            return
        error = self._flush_error
        self._flush_error = None
        raise error
