"""Host-wide admission control for task and benchmark execution."""

from __future__ import annotations

from api.config import settings
from api.coordination import (
    ConcurrencySlotLease,
    get_coordination_backend,
)

HOST_RUN_BUCKET = "hosted-runs"


class HostedRunCapacity:
    """Shared host-level concurrency bucket across all execution entry points."""

    async def acquire(self, *, run_key: str, lease_id: str) -> ConcurrencySlotLease | None:
        limit = settings.host_concurrent_runs
        if limit <= 0:
            return None
        return await get_coordination_backend().acquire_concurrency_slot(
            HOST_RUN_BUCKET,
            holder_key=run_key,
            lease_id=lease_id,
            limit=limit,
            ttl_seconds=settings.task_run_lock_ttl_seconds,
        )

    async def refresh(self, *, run_key: str, lease_id: str) -> ConcurrencySlotLease | None:
        limit = settings.host_concurrent_runs
        if limit <= 0:
            return None
        return await get_coordination_backend().refresh_concurrency_slot(
            HOST_RUN_BUCKET,
            holder_key=run_key,
            lease_id=lease_id,
            ttl_seconds=settings.task_run_lock_ttl_seconds,
        )

    async def release(self, *, run_key: str, lease_id: str) -> bool:
        if settings.host_concurrent_runs <= 0:
            return False
        return await get_coordination_backend().release_concurrency_slot(
            HOST_RUN_BUCKET,
            holder_key=run_key,
            lease_id=lease_id,
        )

    async def force_release(self, *, run_key: str) -> bool:
        if settings.host_concurrent_runs <= 0:
            return False
        return await get_coordination_backend().force_release_concurrency_slot(
            HOST_RUN_BUCKET,
            holder_key=run_key,
        )


_capacity = HostedRunCapacity()


def get_run_capacity() -> HostedRunCapacity:
    return _capacity
