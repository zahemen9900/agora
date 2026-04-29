"""Hosted background run recovery loop for tasks and benchmarks."""

from __future__ import annotations

import asyncio
from contextlib import suppress

import structlog

from api.config import settings
from api.coordination import get_coordination_backend
from api.routes import benchmarks, tasks

logger = structlog.get_logger(__name__)

_RECOVERY_LEADER_KEY = "background-run-recovery-loop"


async def recover_stale_background_runs_once() -> dict[str, int]:
    """Recover stale background task and benchmark runs under a single leader lease."""

    ttl_seconds = max(
        30,
        settings.background_recovery_poll_seconds * 3,
    )
    backend = get_coordination_backend()
    lease = await backend.acquire_run_lock(
        _RECOVERY_LEADER_KEY,
        ttl_seconds=ttl_seconds,
    )
    if lease is None:
        return {"tasks": 0, "benchmarks": 0}

    try:
        recovered_tasks = await tasks.resume_stale_background_task_runs(
            stale_after_seconds=settings.background_recovery_stale_seconds,
            limit=settings.background_recovery_scan_limit,
        )
        recovered_benchmarks = await benchmarks.resume_stale_background_benchmark_runs(
            stale_after_seconds=settings.background_recovery_stale_seconds,
            limit=settings.background_recovery_scan_limit,
        )
        if recovered_tasks or recovered_benchmarks:
            logger.info(
                "background_run_recovery_cycle",
                recovered_tasks=recovered_tasks,
                recovered_benchmarks=recovered_benchmarks,
            )
        return {"tasks": recovered_tasks, "benchmarks": recovered_benchmarks}
    finally:
        await backend.release_run_lock(_RECOVERY_LEADER_KEY, lease_id=lease.lease_id)


async def background_recovery_loop() -> None:
    """Periodically recover persisted background runs after disconnects or instance churn."""

    poll_seconds = max(1, settings.background_recovery_poll_seconds)
    while True:
        try:
            await recover_stale_background_runs_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("background_run_recovery_loop_failed")
        await asyncio.sleep(poll_seconds)


async def shutdown_background_task(task: asyncio.Task[None] | None) -> None:
    """Cancel a lifespan-managed background task without surfacing noise."""

    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
