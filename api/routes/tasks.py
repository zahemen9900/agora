"""Task API endpoints for persisted orchestration, streaming, and receipts."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from sse_starlette.sse import EventSourceResponse

from agora.runtime.orchestrator import AgoraOrchestrator
from agora.selector.features import extract_features
from agora.types import (
    SUPPORTED_MECHANISMS,
    DeliberationResult,
    MechanismSelection,
    MechanismType,
    mechanism_is_supported,
)
from api.auth import AuthenticatedUser, get_current_user, require_scope
from api.config import settings
from api.coordination import (
    StreamTicketRecord,
    get_coordination_backend,
    reset_coordination_state_for_tests,
)
from api.models import (
    DeliberationResultResponse,
    TaskCreateRequest,
    TaskCreateResponse,
    TaskEvent,
    TaskStatusResponse,
)
from api.solana_bridge import LAMPORTS_PER_SOL, bridge
from api.store import TaskStore, get_store
from api.store_local import LocalTaskStore
from api.streaming import DeliberationStream, get_stream_manager

router = APIRouter()
logger = structlog.get_logger(__name__)

_store: TaskStore | LocalTaskStore | None = None
CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
_SUPPORTED_MECHANISMS_TEXT = ", ".join(
    sorted(mechanism.value for mechanism in SUPPORTED_MECHANISMS)
)
_STREAM_POLL_INTERVAL_SECONDS = 0.5


def get_task_store() -> TaskStore | LocalTaskStore:
    """Resolve task storage lazily so imports do not require cloud credentials."""

    global _store
    if _store is None:
        _store = get_store(
            settings.gcs_bucket if settings.gcs_bucket and settings.google_cloud_project else None,
            local_data_dir=settings.local_data_dir,
        )
    return _store


def _build_task_id(task_text: str) -> str:
    """Build a unique task identifier from content and creation time."""

    payload = f"{task_text}\n{datetime.now(UTC).isoformat()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _stream_key(workspace_id: str, task_id: str) -> str:
    """Namespace live streams by workspace and task to avoid cross-tenant fan-out."""

    return f"{workspace_id}:{task_id}"


def _task_run_key(workspace_id: str, task_id: str) -> str:
    return _stream_key(workspace_id, task_id)


def _assert_task_owner(raw_task: dict[str, Any], workspace_id: str) -> None:
    """Reject task records that are explicitly owned by another workspace."""

    task_workspace_id = raw_task.get("workspace_id")
    if task_workspace_id and task_workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Task not found")
    created_by = raw_task.get("created_by")
    if not task_workspace_id and created_by and created_by != workspace_id:
        raise HTTPException(status_code=404, detail="Task not found")


async def _load_task_for_user(
    store: TaskStore | LocalTaskStore,
    workspace_id: str,
    task_id: str,
) -> dict[str, Any]:
    """Load a task while hiding unsafe IDs and cross-tenant records as not-found."""

    try:
        raw_task = await store.get_task(workspace_id, task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    _assert_task_owner(raw_task, workspace_id)
    return raw_task


async def _issue_stream_ticket(workspace_id: str, task_id: str) -> dict[str, str]:
    """Create a short-lived one-use ticket for EventSource auth."""

    ticket, expires_at = await get_coordination_backend().issue_stream_ticket(
        workspace_id,
        task_id,
        settings.stream_ticket_ttl_seconds,
    )
    return {"ticket": ticket, "expires_at": expires_at.isoformat()}


async def _consume_stream_ticket(ticket: str, *, task_id: str) -> StreamTicketRecord:
    entry = await get_coordination_backend().consume_stream_ticket(ticket, task_id=task_id)
    if entry is None:
        raise HTTPException(status_code=401, detail="Invalid stream ticket")
    return entry


async def _acquire_task_run_lock(run_key: str) -> bool:
    return await get_coordination_backend().acquire_run_lock(
        run_key,
        ttl_seconds=settings.task_run_lock_ttl_seconds,
    )


async def _release_task_run_lock(run_key: str) -> None:
    await get_coordination_backend().release_run_lock(run_key)


async def _reset_coordination_state_for_tests() -> None:
    """Clear coordination state for deterministic tests."""

    await reset_coordination_state_for_tests()


def _result_to_response(task_id: str, result: DeliberationResult) -> DeliberationResultResponse:
    """Convert runtime result into API response shape."""

    return DeliberationResultResponse(
        task_id=task_id,
        mechanism=result.mechanism_used.value,
        final_answer=result.final_answer,
        confidence=result.confidence,
        quorum_reached=result.quorum_reached,
        merkle_root=result.merkle_root,
        decision_hash=_hash_text(result.final_answer),
        agent_count=result.agent_count,
        agent_models_used=result.agent_models_used,
        total_tokens_used=result.total_tokens_used,
        latency_ms=result.total_latency_ms,
        round_count=result.round_count,
        mechanism_switches=result.mechanism_switches,
        transcript_hashes=result.transcript_hashes,
        convergence_history=[
            metric.model_dump(mode="json") for metric in result.convergence_history
        ],
        locked_claims=[claim.model_dump(mode="json") for claim in result.locked_claims],
    )


def _to_status_response(raw_task: dict[str, Any], *, detailed: bool = False) -> TaskStatusResponse:
    """Normalize stored task payload into API response shape."""

    normalized = dict(raw_task)
    if not detailed:
        normalized["events"] = []
    return TaskStatusResponse.model_validate(normalized)


def _event_payload(event_type: str, event_data: dict[str, Any]) -> dict[str, Any]:
    """Build a persisted event envelope."""

    return TaskEvent(
        event=event_type,
        data=event_data,
        timestamp=datetime.now(UTC),
    ).model_dump(mode="json")


def _forced_mechanism() -> MechanismType | None:
    """Return an env-pinned mechanism for hosted demo validation when configured."""

    configured = settings.api_force_mechanism.strip().lower()
    if not configured:
        return None
    try:
        mechanism = MechanismType(configured)
    except ValueError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unsupported AGORA_API_FORCE_MECHANISM={settings.api_force_mechanism!r}",
        ) from exc
    return _require_supported_mechanism(
        mechanism,
        status_code=500,
        source="AGORA_API_FORCE_MECHANISM",
    )


def _require_supported_mechanism(
    mechanism: MechanismType,
    *,
    status_code: int,
    source: str,
) -> MechanismType:
    """Require a mechanism to be executable in current runtime paths."""

    if not mechanism_is_supported(mechanism):
        raise HTTPException(
            status_code=status_code,
            detail=(
                f"Mechanism '{mechanism.value}' from {source} is not currently supported. "
                f"Supported mechanisms: {_SUPPORTED_MECHANISMS_TEXT}."
            ),
        )
    return mechanism


def _parse_mechanism(
    raw_mechanism: str,
    *,
    status_code: int,
    source: str,
) -> MechanismType:
    """Parse and validate mechanism strings stored in persisted task records."""

    try:
        mechanism = MechanismType(raw_mechanism)
    except ValueError as exc:
        raise HTTPException(
            status_code=status_code,
            detail=f"Invalid mechanism '{raw_mechanism}' in {source}.",
        ) from exc
    return _require_supported_mechanism(mechanism, status_code=status_code, source=source)


def _request_mechanism_override(request: TaskCreateRequest) -> MechanismType | None:
    """Resolve optional request-level mechanism override from task create payload."""

    if request.mechanism_override is None:
        return None
    return _require_supported_mechanism(
        MechanismType(request.mechanism_override),
        status_code=400,
        source="mechanism_override",
    )


async def _pinned_selection(
    *,
    task_text: str,
    agent_count: int,
    stakes: float,
    mechanism: MechanismType,
) -> MechanismSelection:
    """Build deterministic selector metadata for an explicit mechanism override."""

    reasoning = f"Mechanism override applied at task creation: forced {mechanism.value} execution."
    features = await extract_features(
        task_text=task_text,
        agent_count=agent_count,
        stakes=stakes,
    )
    return MechanismSelection(
        mechanism=mechanism,
        confidence=1.0,
        reasoning=reasoning,
        reasoning_hash=_hash_text(reasoning),
        bandit_recommendation=mechanism,
        bandit_confidence=1.0,
        task_features=features,
    )


async def _stored_selection(task: TaskStatusResponse) -> MechanismSelection:
    """Rebuild selector metadata from persisted task state without re-running selection."""

    mechanism = MechanismType(task.mechanism)
    features = await extract_features(
        task_text=task.task_text,
        agent_count=task.agent_count,
        stakes=task.payment_amount,
    )
    return MechanismSelection(
        mechanism=mechanism,
        confidence=task.selector_confidence,
        reasoning=task.selector_reasoning,
        reasoning_hash=task.selector_reasoning_hash,
        bandit_recommendation=mechanism,
        bandit_confidence=task.selector_confidence,
        task_features=features,
    )


async def persist_and_emit(
    *,
    store: TaskStore | LocalTaskStore,
    stream: DeliberationStream,
    workspace_id: str,
    task_id: str,
    event_type: str,
    event_data: dict[str, Any],
) -> None:
    """Persist an event and emit it to live SSE listeners."""

    payload = _event_payload(event_type, event_data)
    await store.append_event(workspace_id, task_id, payload)
    await stream.emit(_stream_key(workspace_id, task_id), payload)


async def _mark_task_failed(
    *,
    store: TaskStore | LocalTaskStore,
    stream: DeliberationStream,
    workspace_id: str,
    task_id: str,
    task: TaskStatusResponse,
    message: str,
) -> None:
    """Persist failed task state while preserving events emitted before failure."""

    task.status = "failed"
    task.events = [
        TaskEvent.model_validate(event)
        for event in await store.get_events(workspace_id, task_id)
    ]
    await store.save_task(workspace_id, task_id, task.model_dump(mode="json"))
    await persist_and_emit(
        store=store,
        stream=stream,
        workspace_id=workspace_id,
        task_id=task_id,
        event_type="error",
        event_data={"message": message},
    )
    await stream.close(_stream_key(workspace_id, task_id))


@router.post("/", response_model=TaskCreateResponse)
async def create_task(
    request: TaskCreateRequest,
    user: CurrentUser,
) -> TaskCreateResponse:
    """Create a task, run selector, and initialize its on-chain metadata."""

    require_scope(user, "tasks:write")
    store = get_task_store()
    task_id = _build_task_id(request.task)
    task_hash = _hash_text(request.task)
    payment_amount_lamports = int(request.stakes * LAMPORTS_PER_SOL)

    requested_override = _request_mechanism_override(request)
    forced_override = _forced_mechanism()
    effective_override = forced_override or requested_override

    orchestrator = AgoraOrchestrator(agent_count=request.agent_count)
    if effective_override is None:
        selection = await orchestrator.selector.select(
            task_text=request.task,
            agent_count=request.agent_count,
            stakes=request.stakes,
        )
    else:
        selection = await _pinned_selection(
            task_text=request.task,
            agent_count=request.agent_count,
            stakes=request.stakes,
            mechanism=effective_override,
        )
    _require_supported_mechanism(
        selection.mechanism,
        status_code=500,
        source="selector",
    )

    init_tx_hash: str | None = None
    init_explorer_url: str | None = None
    if bridge.is_configured():
        try:
            init_result = await bridge.initialize_task(
                task_id=task_id,
                mechanism=selection.mechanism.value,
                task_hash=task_hash,
                consensus_threshold=60,
                agent_count=request.agent_count,
                payment_amount_lamports=payment_amount_lamports,
            )
            init_tx_hash = str(init_result.get("tx_hash", "")) or None
            init_explorer_url = str(init_result.get("explorer_url", "")) or None

            await bridge.record_selection(
                task_id=task_id,
                selector_reasoning_hash=selection.reasoning_hash,
            )
        except Exception as exc:
            logger.error("task_create_chain_setup_failed", task_id=task_id, error=str(exc))
            if settings.strict_chain_writes:
                raise HTTPException(
                    status_code=502,
                    detail="Failed to initialize task on Solana",
                ) from exc
            logger.warning(
                "task_create_chain_setup_soft_failed",
                task_id=task_id,
                error=str(exc),
            )
    else:
        logger.warning("solana_bridge_not_configured", task_id=task_id)

    task_status = TaskStatusResponse(
        task_id=task_id,
        task_text=request.task,
        workspace_id=user.workspace_id,
        created_by=user.user_id or f"api_key:{user.api_key_id}",
        mechanism=selection.mechanism.value,
        mechanism_override=effective_override.value if effective_override is not None else None,
        status="pending",
        selector_reasoning=selection.reasoning,
        selector_reasoning_hash=selection.reasoning_hash,
        selector_confidence=selection.confidence,
        agent_count=request.agent_count,
        payment_amount=request.stakes,
        payment_status="locked" if request.stakes > 0 else "none",
        solana_tx_hash=init_tx_hash,
        explorer_url=init_explorer_url,
    )
    await store.save_task(user.workspace_id, task_id, task_status.model_dump(mode="json"))

    await persist_and_emit(
        store=store,
        stream=get_stream_manager(),
        workspace_id=user.workspace_id,
        task_id=task_id,
        event_type="mechanism_selected",
        event_data={
            "task_id": task_id,
            "mechanism": selection.mechanism.value,
            "mechanism_override": (
                effective_override.value if effective_override is not None else None
            ),
            "confidence": selection.confidence,
            "reasoning": selection.reasoning,
            "selector_reasoning_hash": selection.reasoning_hash,
        },
    )

    return TaskCreateResponse(
        task_id=task_id,
        mechanism=selection.mechanism.value,
        confidence=selection.confidence,
        reasoning=selection.reasoning,
        selector_reasoning_hash=selection.reasoning_hash,
        status="pending",
    )


@router.post("/{task_id}/run", response_model=DeliberationResultResponse)
async def run_task(
    task_id: str,
    user: CurrentUser,
) -> DeliberationResultResponse:
    """Execute the stored mechanism and persist the resulting receipt."""

    require_scope(user, "tasks:write")
    store = get_task_store()
    stream = get_stream_manager()
    raw_task = await _load_task_for_user(store, user.workspace_id, task_id)

    task = _to_status_response(raw_task, detailed=True)
    if task.status in {"completed", "paid"} and task.result is not None:
        return task.result
    if task.status == "in_progress":
        raise HTTPException(status_code=409, detail="Task is already in progress")
    if task.status != "pending":
        raise HTTPException(status_code=409, detail=f"Task cannot run from status={task.status}")

    forced_mechanism = _forced_mechanism()
    stored_override: MechanismType | None = None
    if task.mechanism_override is not None:
        stored_override = _parse_mechanism(
            task.mechanism_override,
            status_code=409,
            source="stored mechanism_override",
        )
    effective_override = forced_mechanism or stored_override
    if effective_override is None:
        _parse_mechanism(
            task.mechanism,
            status_code=409,
            source="stored task mechanism",
        )

    run_key = _task_run_key(user.workspace_id, task_id)
    if not await _acquire_task_run_lock(run_key):
        raise HTTPException(status_code=409, detail="Task is already in progress")

    run_lock_released = False

    async def _release_run_lock_once() -> None:
        nonlocal run_lock_released
        if run_lock_released:
            return
        await _release_task_run_lock(run_key)
        run_lock_released = True

    async def runtime_event_sink(event_type: str, data: dict[str, Any]) -> None:
        await persist_and_emit(
            store=store,
            stream=stream,
            workspace_id=user.workspace_id,
            task_id=task_id,
            event_type=event_type,
            event_data=data,
        )

    orchestrator = AgoraOrchestrator(agent_count=task.agent_count)
    try:
        task.status = "in_progress"
        await store.save_task(user.workspace_id, task_id, task.model_dump(mode="json"))

        if effective_override is not None:
            result = await orchestrator.run(
                task=task.task_text,
                stakes=task.payment_amount,
                mechanism_override=effective_override,
                event_sink=runtime_event_sink,
            )
        elif hasattr(orchestrator, "execute_selection"):
            selection = await _stored_selection(task)
            result = await orchestrator.execute_selection(
                task=task.task_text,
                selection=selection,
                event_sink=runtime_event_sink,
                allow_switch=True,
            )
        else:
            result = await orchestrator.run(
                task=task.task_text,
                stakes=task.payment_amount,
                mechanism_override=task.mechanism,
                event_sink=runtime_event_sink,
            )
    except Exception as exc:
        try:
            await _mark_task_failed(
                store=store,
                stream=stream,
                workspace_id=user.workspace_id,
                task_id=task_id,
                task=task,
                message=str(exc),
            )
        finally:
            logger.exception("task_execution_failed", task_id=task_id)
            await _release_run_lock_once()
        raise HTTPException(status_code=500, detail="Task execution failed") from exc

    result_response = _result_to_response(task_id, result)

    if bridge.is_configured():
        try:
            receipt = await bridge.submit_receipt(
                task_id=task_id,
                merkle_root=result_response.merkle_root or "",
                decision_hash=result_response.decision_hash or "",
                quorum_reached=result.quorum_reached,
                final_mechanism=result.mechanism_used.value,
            )
            task.solana_tx_hash = str(receipt.get("tx_hash", "")) or task.solana_tx_hash
            task.explorer_url = str(receipt.get("explorer_url", "")) or task.explorer_url
        except Exception as exc:
            logger.error("task_receipt_submission_failed", task_id=task_id, error=str(exc))
            if settings.strict_chain_writes:
                try:
                    await _mark_task_failed(
                        store=store,
                        stream=stream,
                        workspace_id=user.workspace_id,
                        task_id=task_id,
                        task=task,
                        message="Failed to submit receipt on Solana",
                    )
                finally:
                    await _release_run_lock_once()
                raise HTTPException(
                    status_code=502,
                    detail="Failed to submit receipt on Solana",
                ) from exc
            logger.warning(
                "task_receipt_submission_soft_failed",
                task_id=task_id,
                error=str(exc),
            )

        if result.mechanism_switches > 0:
            refreshed_events = [
                TaskEvent.model_validate(event)
                for event in await store.get_events(user.workspace_id, task_id)
            ]
            switch_events = [
                event for event in refreshed_events if event.event == "mechanism_switch"
            ]
            for switch_index, switch_event in enumerate(switch_events):
                data = switch_event.data
                try:
                    await bridge.record_mechanism_switch(
                        task_id=task_id,
                        switch_index=switch_index,
                        from_mechanism=str(data.get("from_mechanism", task.mechanism)),
                        to_mechanism=str(data.get("to_mechanism", result.mechanism_used.value)),
                        reason_hash=_hash_text(str(data.get("reason", "mechanism switch"))),
                        round_number=int(data.get("round_number", result.round_count)),
                    )
                except Exception as exc:
                    logger.error(
                        "task_switch_record_failed",
                        task_id=task_id,
                        switch_index=switch_index,
                        error=str(exc),
                    )
                    if settings.strict_chain_writes:
                        try:
                            await _mark_task_failed(
                                store=store,
                                stream=stream,
                                workspace_id=user.workspace_id,
                                task_id=task_id,
                                task=task,
                                message="Failed to record mechanism switch on Solana",
                            )
                        finally:
                            await _release_run_lock_once()
                        raise HTTPException(
                            status_code=502,
                            detail="Failed to record mechanism switch on Solana",
                        ) from exc
                    logger.warning(
                        "task_switch_record_soft_failed",
                        task_id=task_id,
                        switch_index=switch_index,
                        error=str(exc),
                    )

    task.status = "completed"
    task.mechanism = result_response.mechanism
    task.quorum_reached = result_response.quorum_reached
    task.merkle_root = result_response.merkle_root
    task.decision_hash = result_response.decision_hash
    task.round_count = result_response.round_count
    task.mechanism_switches = result_response.mechanism_switches
    task.transcript_hashes = result_response.transcript_hashes
    task.completed_at = datetime.now(UTC)
    task.result = result_response
    task.events = [
        TaskEvent.model_validate(event)
        for event in await store.get_events(user.workspace_id, task_id)
    ]

    await store.save_task(user.workspace_id, task_id, task.model_dump(mode="json"))
    await persist_and_emit(
        store=store,
        stream=stream,
        workspace_id=user.workspace_id,
        task_id=task_id,
        event_type="quorum_reached",
        event_data={
            "task_id": task_id,
            "final_answer": result_response.final_answer,
            "confidence": result_response.confidence,
            "mechanism": result_response.mechanism,
            "quorum_reached": result_response.quorum_reached,
        },
    )
    if task.solana_tx_hash:
        await persist_and_emit(
            store=store,
            stream=stream,
            workspace_id=user.workspace_id,
            task_id=task_id,
            event_type="receipt_committed",
            event_data={
                "task_id": task_id,
                "merkle_root": task.merkle_root,
                "solana_tx_hash": task.solana_tx_hash,
                "explorer_url": task.explorer_url,
            },
        )

    await persist_and_emit(
        store=store,
        stream=stream,
        workspace_id=user.workspace_id,
        task_id=task_id,
        event_type="complete",
        event_data={"task_id": task_id, "status": task.status},
    )
    await stream.close(_stream_key(user.workspace_id, task_id))
    await _release_run_lock_once()
    return result_response


@router.get("/", response_model=list[TaskStatusResponse])
async def list_tasks(
    user: CurrentUser,
) -> list[TaskStatusResponse]:
    """List recent tasks for the current user."""

    require_scope(user, "tasks:read")
    store = get_task_store()
    rows = await store.list_user_tasks(user.workspace_id)
    visible_rows: list[TaskStatusResponse] = []
    for row in rows:
        try:
            _assert_task_owner(row, user.workspace_id)
        except HTTPException:
            logger.warning(
                "task_list_filtered_foreign_owner",
                workspace_id=user.workspace_id,
                task_id=row.get("task_id"),
            )
            continue
        visible_rows.append(_to_status_response(row, detailed=False))
    return visible_rows


@router.get("/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(
    task_id: str,
    user: CurrentUser,
    detailed: bool = Query(default=False),
) -> TaskStatusResponse:
    """Fetch one task by id."""

    require_scope(user, "tasks:read")
    store = get_task_store()
    raw_task = await _load_task_for_user(store, user.workspace_id, task_id)
    return _to_status_response(raw_task, detailed=detailed)


@router.post("/{task_id}/stream-ticket")
async def create_stream_ticket(
    task_id: str,
    user: CurrentUser,
) -> dict[str, str]:
    """Issue a short-lived ticket for browser EventSource authentication."""

    require_scope(user, "tasks:read")
    store = get_task_store()
    await _load_task_for_user(store, user.workspace_id, task_id)
    return await _issue_stream_ticket(user.workspace_id, task_id)


@router.get("/{task_id}/stream")
async def stream_task(
    task_id: str,
    ticket: str = Query(...),
) -> EventSourceResponse:
    """Replay persisted events, then continue with live SSE updates."""

    stream_ticket = await _consume_stream_ticket(ticket, task_id=task_id)
    workspace_id = stream_ticket.workspace_id
    store = get_task_store()
    stream = get_stream_manager()
    await _load_task_for_user(store, workspace_id, task_id)

    async def event_generator() -> Any:
        events = await store.get_events(workspace_id, task_id)
        for event in events:
            yield {
                "event": event.get("event", "update"),
                "data": event.get("data", {}),
                "timestamp": event.get("timestamp"),
            }

        if any(event.get("event") == "complete" for event in events):
            return

        stream_id = _stream_key(workspace_id, task_id)
        queue = stream.subscribe(stream_id)
        next_event_index = len(events)

        try:
            while True:
                try:
                    item = await asyncio.wait_for(
                        queue.get(),
                        timeout=_STREAM_POLL_INTERVAL_SECONDS,
                    )
                except TimeoutError:
                    latest = await store.get_events(workspace_id, task_id)
                    if next_event_index >= len(latest):
                        continue

                    for event in latest[next_event_index:]:
                        payload = {
                            "event": event.get("event", "update"),
                            "data": event.get("data", {}),
                            "timestamp": event.get("timestamp"),
                        }
                        next_event_index += 1
                        yield payload
                        if payload["event"] in {"complete", "error"}:
                            return
                    continue

                if item is None:
                    break
                yield item
                next_event_index += 1
                if item.get("event") in {"complete", "error"}:
                    break
        finally:
            stream.unsubscribe(stream_id, queue)

    return EventSourceResponse(event_generator())


@router.post("/{task_id}/pay")
async def release_payment(
    task_id: str,
    user: CurrentUser,
) -> dict[str, str | bool]:
    """Release escrow payment for a completed task."""

    require_scope(user, "tasks:write")
    store = get_task_store()
    stream = get_stream_manager()
    raw_task = await _load_task_for_user(store, user.workspace_id, task_id)

    task = _to_status_response(raw_task, detailed=True)
    if task.status not in {"completed", "paid"}:
        raise HTTPException(
            status_code=409,
            detail=f"Task status is {task.status}; expected completed",
        )
    if task.status == "paid" or task.payment_status == "released":
        raise HTTPException(status_code=409, detail="Payment already released")
    if not task.quorum_reached:
        raise HTTPException(status_code=409, detail="Quorum not reached")
    if not bridge.is_configured():
        raise HTTPException(status_code=503, detail="Solana bridge is not configured")

    try:
        payment_tx = await bridge.release_payment(task_id=task_id)
    except Exception as exc:
        logger.error("task_payment_release_failed", task_id=task_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Failed to record payment on Solana") from exc

    task.status = "paid"
    task.payment_status = "released"
    task.solana_tx_hash = str(payment_tx.get("tx_hash", "")) or task.solana_tx_hash
    task.explorer_url = str(payment_tx.get("explorer_url", "")) or task.explorer_url

    await store.save_task(user.workspace_id, task_id, task.model_dump(mode="json"))
    await persist_and_emit(
        store=store,
        stream=stream,
        workspace_id=user.workspace_id,
        task_id=task_id,
        event_type="payment_released",
        event_data={
            "task_id": task_id,
            "tx_hash": task.solana_tx_hash,
            "explorer_url": task.explorer_url,
        },
    )

    return {"released": True, "tx_hash": task.solana_tx_hash or ""}
