"""Shared task-like execution helpers used by tasks and benchmarks."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from agora.runtime.orchestrator import AgoraOrchestrator, EventSink
from agora.selector.features import extract_features
from agora.types import (
    DeliberationResult,
    MechanismSelection,
    MechanismType,
    MechanismOverrideSource,
    SelectorSource,
    mechanism_is_supported,
)

TaskLikeStatus = Literal["completed", "failed"]


class TaskLikeExecutionOutcome(BaseModel):
    """Normalized result for one task-like execution attempt."""

    model_config = ConfigDict(frozen=True)

    status: TaskLikeStatus
    selection: MechanismSelection
    selector_source: SelectorSource
    selector_fallback_path: list[str] = Field(default_factory=list)
    mechanism_override_source: MechanismOverrideSource | None = None
    result: DeliberationResult | None = None
    failure_reason: str | None = None
    latest_error_event: dict[str, Any] | None = None


async def build_pinned_selection(
    *,
    task_text: str,
    agent_count: int,
    stakes: float,
    mechanism: MechanismType,
    reasoning_hash: Callable[[str], str],
    selector_source: SelectorSource,
    mechanism_override_source: MechanismOverrideSource,
) -> MechanismSelection:
    """Build deterministic selector metadata for an explicit mechanism override."""

    if not mechanism_is_supported(mechanism):
        raise ValueError(f"Unsupported mechanism override: {mechanism.value}")

    features = await extract_features(
        task_text=task_text,
        agent_count=agent_count,
        stakes=stakes,
    )
    reasoning = f"Mechanism override applied: forced {mechanism.value} execution."
    return MechanismSelection(
        mechanism=mechanism,
        confidence=1.0,
        reasoning=reasoning,
        reasoning_hash=reasoning_hash(reasoning),
        bandit_recommendation=mechanism,
        bandit_confidence=1.0,
        task_features=features,
        selector_source=selector_source,
        selector_fallback_path=[selector_source],
    )


async def resolve_task_like_selection(
    *,
    orchestrator: AgoraOrchestrator,
    task_text: str,
    agent_count: int,
    stakes: float,
    forced_override: MechanismType | None = None,
    requested_override: MechanismType | None = None,
) -> tuple[MechanismSelection, SelectorSource, list[str], MechanismOverrideSource | None]:
    """Resolve a selection using the shared selector cascade and override semantics."""

    if forced_override is not None:
        selection = await build_pinned_selection(
            task_text=task_text,
            agent_count=agent_count,
            stakes=stakes,
            mechanism=forced_override,
            reasoning_hash=orchestrator.hasher.hash_content,
            selector_source="env_pin",
            mechanism_override_source="env_pin",
        )
        return selection, "env_pin", list(selection.selector_fallback_path), "env_pin"

    if requested_override is not None:
        selection = await build_pinned_selection(
            task_text=task_text,
            agent_count=agent_count,
            stakes=stakes,
            mechanism=requested_override,
            reasoning_hash=orchestrator.hasher.hash_content,
            selector_source="forced_override",
            mechanism_override_source="request",
        )
        return selection, "forced_override", list(selection.selector_fallback_path), "request"

    selection = await orchestrator.selector.select(
        task_text=task_text,
        agent_count=agent_count,
        stakes=stakes,
    )
    return (
        selection,
        selection.selector_source,
        list(selection.selector_fallback_path),
        None,
    )


async def execute_task_like_run(
    *,
    orchestrator: AgoraOrchestrator,
    task_text: str,
    selection: MechanismSelection,
    selector_source: SelectorSource | None = None,
    selector_fallback_path: list[str] | None = None,
    mechanism_override_source: MechanismOverrideSource | None = None,
    event_sink: EventSink | None = None,
    agents: Sequence[Callable[..., Any]] | None = None,
    allow_switch: bool = True,
) -> TaskLikeExecutionOutcome:
    """Execute one task-like run and normalize success or failure."""

    resolved_selector_source = selector_source or selection.selector_source
    resolved_fallback_path = (
        list(selector_fallback_path)
        if selector_fallback_path is not None
        else list(selection.selector_fallback_path)
    )

    try:
        result = await orchestrator.execute_selection(
            task=task_text,
            selection=selection,
            event_sink=event_sink,
            agents=agents,
            allow_switch=allow_switch,
        )
        if result.fallback_count > 0 and not orchestrator.allow_offline_fallback:
            raise RuntimeError("Provider fallback occurred but allow_offline_fallback=false")
        normalized_result = result.model_copy(
            update={
                "selector_source": resolved_selector_source,
                "mechanism_override_source": mechanism_override_source,
            }
        )
        return TaskLikeExecutionOutcome(
            status="completed",
            selection=selection,
            selector_source=resolved_selector_source,
            selector_fallback_path=resolved_fallback_path,
            mechanism_override_source=mechanism_override_source,
            result=normalized_result,
        )
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        return TaskLikeExecutionOutcome(
            status="failed",
            selection=selection,
            selector_source=resolved_selector_source,
            selector_fallback_path=resolved_fallback_path,
            mechanism_override_source=mechanism_override_source,
            failure_reason=message,
            latest_error_event={
                "event": "error",
                "data": {"message": message},
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )
