"""Tests for task coordination backends."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from api.coordination import (
    InMemoryCoordinationBackend,
    StreamTicketRecord,
    reset_coordination_backend_cache_for_tests,
    validate_coordination_configuration,
)
from api.streaming import validate_streaming_configuration


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
    assert first is not None
    await backend.release_run_lock("workspace:task", lease_id=first.lease_id)
    third = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)

    assert second is None
    assert third is not None


@pytest.mark.asyncio
async def test_in_memory_run_lock_allows_reacquire_after_expiry() -> None:
    backend = InMemoryCoordinationBackend()
    acquired = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)
    assert acquired is not None

    backend._run_locks["workspace:task"] = acquired.__class__(
        run_key=acquired.run_key,
        lease_id=acquired.lease_id,
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    reacquired = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)

    assert reacquired is not None


@pytest.mark.asyncio
async def test_in_memory_run_lock_refresh_requires_matching_owner() -> None:
    backend = InMemoryCoordinationBackend()
    acquired = await backend.acquire_run_lock("workspace:task", ttl_seconds=60)
    assert acquired is not None

    rejected = await backend.refresh_run_lock(
        "workspace:task",
        lease_id="wrong-owner",
        ttl_seconds=60,
    )
    refreshed = await backend.refresh_run_lock(
        "workspace:task",
        lease_id=acquired.lease_id,
        ttl_seconds=60,
    )

    assert rejected is None
    assert refreshed is not None
    assert refreshed.lease_id == acquired.lease_id


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


@pytest.mark.asyncio
async def test_in_memory_rate_limit_counts_hits_with_retry_after() -> None:
    backend = InMemoryCoordinationBackend()

    first = await backend.hit_rate_limit("workspace:create", limit=2, window_seconds=60)
    second = await backend.hit_rate_limit("workspace:create", limit=2, window_seconds=60)
    third = await backend.hit_rate_limit("workspace:create", limit=2, window_seconds=60)

    assert first.count == 1
    assert second.count == 2
    assert third.count == 3
    assert third.limit == 2
    assert third.retry_after_seconds >= 1


@pytest.mark.asyncio
async def test_in_memory_rate_limit_resets_after_expiry() -> None:
    backend = InMemoryCoordinationBackend()

    await backend.hit_rate_limit("workspace:create", limit=1, window_seconds=60)
    backend._rate_limits["workspace:create"] = (
        1,
        datetime.now(UTC) - timedelta(seconds=1),
    )

    renewed = await backend.hit_rate_limit("workspace:create", limit=1, window_seconds=60)

    assert renewed.count == 1


@pytest.mark.asyncio
async def test_in_memory_workspace_concurrency_slots_enforce_limit() -> None:
    backend = InMemoryCoordinationBackend()

    first = await backend.acquire_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-1",
        lease_id="lease-1",
        limit=1,
        ttl_seconds=60,
    )
    second = await backend.acquire_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-2",
        lease_id="lease-2",
        limit=1,
        ttl_seconds=60,
    )

    assert first is not None
    assert second is None


@pytest.mark.asyncio
async def test_in_memory_workspace_concurrency_slot_refresh_requires_owner() -> None:
    backend = InMemoryCoordinationBackend()
    acquired = await backend.acquire_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-1",
        lease_id="lease-1",
        limit=2,
        ttl_seconds=60,
    )
    assert acquired is not None

    rejected = await backend.refresh_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-1",
        lease_id="wrong-owner",
        ttl_seconds=60,
    )
    refreshed = await backend.refresh_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-1",
        lease_id="lease-1",
        ttl_seconds=60,
    )

    assert rejected is None
    assert refreshed is not None
    assert refreshed.lease_id == "lease-1"


@pytest.mark.asyncio
async def test_in_memory_workspace_concurrency_release_frees_capacity() -> None:
    backend = InMemoryCoordinationBackend()
    acquired = await backend.acquire_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-1",
        lease_id="lease-1",
        limit=1,
        ttl_seconds=60,
    )
    assert acquired is not None

    released = await backend.release_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-1",
        lease_id="lease-1",
    )
    reacquired = await backend.acquire_concurrency_slot(
        "workspace-runs:user-1",
        holder_key="task-2",
        lease_id="lease-2",
        limit=1,
        ttl_seconds=60,
    )

    assert released is True
    assert reacquired is not None


def test_hosted_coordination_requires_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("api.coordination.settings.environment", "production")
    monkeypatch.setattr("api.coordination.settings.coordination_backend", "memory")
    reset_coordination_backend_cache_for_tests()

    with pytest.raises(RuntimeError, match="require Redis coordination"):
        validate_coordination_configuration()


def test_hosted_streaming_requires_redis_pubsub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("api.streaming.settings.environment", "production")
    monkeypatch.setattr("api.streaming.settings.coordination_backend", "redis")
    monkeypatch.setattr("api.streaming.settings.redis_url", "")

    with pytest.raises(RuntimeError, match="require Redis-backed streaming"):
        validate_streaming_configuration()
