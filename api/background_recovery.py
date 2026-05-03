"""Hosted background run recovery loop for tasks and benchmarks."""

from __future__ import annotations

import asyncio
from contextlib import suppress

import structlog

from api.config import settings
from api.coordination import get_coordination_backend
from api.routes import benchmarks, tasks
from api.telemetry import (
    add_span_event,
    mark_span_error,
    observation_context,
    start_observation_span,
)

logger = structlog.get_logger(__name__)

_RECOVERY_LEADER_KEY = "background-run-recovery-loop"


async def recover_stale_background_runs_once() -> dict[str, int]:
    """Recover stale background task and benchmark runs under a single leader lease."""

    with observation_context(
        **{
            "agora.actor.type": "system",
            "agora.actor.id": "system:background_recovery",
            "agora.auth.method": "system",
            "agora.execution.kind": "background_recovery",
        }
    ):
        with start_observation_span(
            "background_recovery.cycle",
            attributes={"agora.recovery.kind": "hosted_background_runs"},
        ):
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
                add_span_event("recovery_skipped", {"agora.recovery.reason": "lease_not_acquired"})
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
                add_span_event(
                    "recovery_completed",
                    {
                        "agora.recovery.task_count": recovered_tasks,
                        "agora.recovery.benchmark_count": recovered_benchmarks,
                    },
                )
                if recovered_tasks or recovered_benchmarks:
                    logger.info(
                        "background_run_recovery_cycle",
                        recovered_tasks=recovered_tasks,
                        recovered_benchmarks=recovered_benchmarks,
                    )
                return {"tasks": recovered_tasks, "benchmarks": recovered_benchmarks}
            except Exception as exc:
                mark_span_error(
                    exc,
                    attributes={
                        "agora.recovery.outcome": "failed",
                        "agora.error.type": exc.__class__.__name__,
                    },
                )
                raise
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
