"""Shared task-like execution helpers used by tasks and benchmarks."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from agora.runtime.hasher import TranscriptHasher
from agora.runtime.orchestrator import AgoraOrchestrator, EventSink
from agora.selector.features import extract_features
from agora.types import (
    DeliberationResult,
    MechanismOverrideSource,
    MechanismSelection,
    MechanismType,
    SelectorSource,
    mechanism_is_supported,
)
from api.telemetry import (
    add_span_event,
    mark_span_error,
    set_current_span_attributes,
    start_observation_span,
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


def _reasoning_hash_function(orchestrator: Any) -> Callable[[str], str]:
    """Return a stable reasoning hash function for full and legacy orchestrators."""

    hasher = getattr(orchestrator, "hasher", None)
    hash_content = getattr(hasher, "hash_content", None)
    if callable(hash_content):
        return hash_content
    return TranscriptHasher.hash_content


async def _invoke_orchestrator_run(
    orchestrator: Any,
    *,
    task_text: str,
    stakes: float,
    mechanism_override: MechanismType,
    event_sink: EventSink | None,
    agents: Sequence[Callable[..., Any]] | None,
) -> DeliberationResult:
    """Call orchestrator.run while tolerating legacy adapters with narrower signatures."""

    kwargs: dict[str, Any] = {
        "task": task_text,
        "stakes": stakes,
        "mechanism_override": mechanism_override,
        "event_sink": event_sink,
        "agents": agents,
    }
    parameters = inspect.signature(orchestrator.run).parameters.values()
    accepts_kwargs = any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters
    )
    if accepts_kwargs:
        return await orchestrator.run(**kwargs)

    supported_kwargs = {
        name: value
        for name, value in kwargs.items()
        if name in inspect.signature(orchestrator.run).parameters
    }
    return await orchestrator.run(**supported_kwargs)


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
            reasoning_hash=_reasoning_hash_function(orchestrator),
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
            reasoning_hash=_reasoning_hash_function(orchestrator),
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
    span_attributes = {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.capability.name": "agora_deliberation",
        "gen_ai.step.name": "orchestrate_task",
        "gen_ai.agent.name": "agora_orchestrator",
        "agora.mechanism.requested": selection.mechanism.value,
        "agora.mechanism.selected": selection.mechanism.value,
        "agora.selector.source": resolved_selector_source,
        "agora.selector.fallback_path": resolved_fallback_path,
        "agora.allow_mechanism_switch": allow_switch,
        "agora.execution.stakes": selection.task_features.stakes,
        "agora.execution.agent_count": selection.task_features.agent_count,
        "agora.execution.category": selection.task_features.topic_category,
    }

    async def instrumented_event_sink(event_type: str, data: dict[str, Any]) -> None:
        if event_type == "mechanism_switch":
            add_span_event(
                "mechanism_switch",
                {
                    "agora.mechanism.from": data.get("from_mechanism"),
                    "agora.mechanism.to": data.get("to_mechanism"),
                    "agora.segment.round": data.get("segment_round") or data.get("round_number"),
                    "agora.execution.segment": data.get("execution_segment"),
                    "agora.next.execution.segment": data.get("next_execution_segment"),
                },
            )
        elif event_type == "quorum_reached":
            add_span_event("quorum_reached", data)

        if event_sink is not None:
            await event_sink(event_type, data)

    with start_observation_span("execute_task_like_run", attributes=span_attributes):
        add_span_event(
            "mechanism_selected",
            {
                "agora.mechanism.selected": selection.mechanism.value,
                "agora.selector.source": resolved_selector_source,
            },
        )
        try:
            if mechanism_override_source is not None:
                result = await _invoke_orchestrator_run(
                    orchestrator,
                    task_text=task_text,
                    stakes=selection.task_features.stakes,
                    mechanism_override=selection.mechanism,
                    event_sink=instrumented_event_sink,
                    agents=agents,
                )
            elif hasattr(orchestrator, "execute_selection"):
                result = await orchestrator.execute_selection(
                    task=task_text,
                    selection=selection,
                    event_sink=instrumented_event_sink,
                    agents=agents,
                    allow_switch=allow_switch,
                )
            else:
                # Compatibility path for legacy orchestrator adapters and test doubles.
                result = await _invoke_orchestrator_run(
                    orchestrator,
                    task_text=task_text,
                    stakes=selection.task_features.stakes,
                    mechanism_override=selection.mechanism,
                    event_sink=instrumented_event_sink,
                    agents=agents,
                )
            if result.fallback_count > 0 and not getattr(
                orchestrator, "allow_offline_fallback", True
            ):
                raise RuntimeError("Provider fallback occurred but allow_offline_fallback=false")
            normalized_result = result.model_copy(
                update={
                    "selector_source": resolved_selector_source,
                    "mechanism_override_source": mechanism_override_source,
                }
            )
            set_current_span_attributes(
                {
                    "agora.execution.mode": normalized_result.execution_mode,
                    "agora.quorum.reached": normalized_result.quorum_reached,
                    "agora.fallback.count": normalized_result.fallback_count,
                    "agora.round.count": normalized_result.round_count,
                    "agora.mechanism.switches": normalized_result.mechanism_switches,
                    "agora.total.tokens": normalized_result.total_tokens_used,
                    "agora.total.latency_ms": normalized_result.total_latency_ms,
                    "agora.cost.estimated_usd": (
                        normalized_result.cost.estimated_cost_usd
                        if normalized_result.cost is not None
                        else None
                    ),
                }
            )
            if normalized_result.fallback_count > 0:
                add_span_event(
                    "fallback_applied",
                    {"agora.fallback.count": normalized_result.fallback_count},
                )
            if normalized_result.quorum_reached:
                add_span_event(
                    "quorum_reached",
                    {
                        "agora.quorum.reached": True,
                        "agora.confidence": normalized_result.confidence,
                    },
                )
            add_span_event(
                "execution_completed",
                {
                    "agora.mechanism.selected": normalized_result.mechanism_used.value,
                    "agora.execution.mode": normalized_result.execution_mode,
                },
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
            mark_span_error(
                exc,
                attributes={
                    "agora.execution.status": "failed",
                    "agora.error.type": exc.__class__.__name__,
                },
            )
            add_span_event("execution_failed", {"agora.error.message": message})
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
