"""Tests for task coordination backends."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from api.coordination import InMemoryCoordinationBackend, StreamTicketRecord


@pytest.mark.asyncio
async def test_in_memory_stream_ticket_is_one_time_and_namespaced() -> None:
    backend = InMemoryCoordinationBackend()

    ticket, _expires_at = await backend.issue_stream_ticket("workspace-1", "task-1", ttl_seconds=60)

    consumed = await backend.consume_stream_ticket(ticket, task_id="task-1")
    missing = await backend.consume_stream_ticket(ticket, task_id="task-1")

    assert consumed is not None
    assert consumed.workspace_id == "workspace-1"
    assert consumed.task_id == "task-1"
    assert missing is None


@pytest.mark.asyncio
async def test_in_memory_stream_ticket_rejects_expired_entry() -> None:
    backend = InMemoryCoordinationBackend()
    ticket, _expires_at = await backend.issue_stream_ticket("workspace-1", "task-1", ttl_seconds=60)
    backend._stream_tickets[ticket] = StreamTicketRecord(
        workspace_id="workspace-1",
        task_id="task-1",
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )

    consumed = await backend.consume_stream_ticket(ticket, task_id="task-1")

    assert consumed is None


@pytest.mark.asyncio
async def test_in_memory_run_lock_respects_ttl_and_release() -> None:
    backend = InMemoryCoordinationBackend()

    first = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)
    second = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)
    await backend.release_run_lock("workspace:task")
    third = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)

    assert first is True
    assert second is False
    assert third is True


@pytest.mark.asyncio
async def test_in_memory_run_lock_allows_reacquire_after_expiry() -> None:
    backend = InMemoryCoordinationBackend()
    acquired = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)
    assert acquired is True

    backend._run_locks["workspace:task"] = datetime.now(UTC) - timedelta(seconds=1)
    reacquired = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)

    assert reacquired is True


@pytest.mark.asyncio
async def test_in_memory_dedupe_claim_rejects_replay_until_expiry() -> None:
    backend = InMemoryCoordinationBackend()

    first = await backend.claim_dedupe_key("webhook:key", ttl_seconds=60)
    second = await backend.claim_dedupe_key("webhook:key", ttl_seconds=60)

    assert first is True
    assert second is False


@pytest.mark.asyncio
async def test_in_memory_dedupe_claim_allows_after_expiry() -> None:
    backend = InMemoryCoordinationBackend()
    claimed = await backend.claim_dedupe_key("webhook:key", ttl_seconds=60)
    assert claimed is True

    backend._dedupe_keys["webhook:key"] = datetime.now(UTC) - timedelta(seconds=1)
    reclaimed = await backend.claim_dedupe_key("webhook:key", ttl_seconds=60)

    assert reclaimed is True
