"""Benchmark runner stub for Week 1."""

from __future__ import annotations

from collections.abc import Sequence

from agora.runtime.orchestrator import AgoraOrchestrator
from agora.types import DeliberationResult


async def run_benchmark(tasks: Sequence[str], agent_count: int = 3) -> list[DeliberationResult]:
    """Run orchestrator across a list of tasks.

    Args:
        tasks: Tasks to evaluate.
        agent_count: Number of agents.

    Returns:
        list[DeliberationResult]: Results for each task.
    """

    orchestrator = AgoraOrchestrator(agent_count=agent_count)
    return [await orchestrator.run(task) for task in tasks]
