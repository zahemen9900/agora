"""Task API endpoints for persisted orchestration, streaming, and receipts."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from sse_starlette.sse import EventSourceResponse

from agora.runtime.orchestrator import AgoraOrchestrator
from agora.types import DeliberationResult
from api.auth import AuthenticatedUser, get_current_user
from api.config import settings
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


def get_task_store() -> TaskStore | LocalTaskStore:
    """Resolve task storage lazily so imports do not require cloud credentials."""

    global _store
    if _store is None:
        _store = get_store(
            settings.gcs_bucket if settings.gcs_bucket and settings.google_cloud_project else None
        )
    return _store


def _build_task_id(task_text: str) -> str:
    """Build a unique task identifier from content and creation time."""

    payload = f"{task_text}\n{datetime.now(UTC).isoformat()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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


async def persist_and_emit(
    *,
    store: TaskStore | LocalTaskStore,
    stream: DeliberationStream,
    user_id: str,
    task_id: str,
    event_type: str,
    event_data: dict[str, Any],
) -> None:
    """Persist an event and emit it to live SSE listeners."""

    payload = _event_payload(event_type, event_data)
    await store.append_event(user_id, task_id, payload)
    await stream.emit(task_id, event_type, event_data)


@router.post("/", response_model=TaskCreateResponse)
async def create_task(
    request: TaskCreateRequest,
    user: CurrentUser,
) -> TaskCreateResponse:
    """Create a task, run selector, and initialize its on-chain metadata."""

    store = get_task_store()
    task_id = _build_task_id(request.task)
    task_hash = _hash_text(request.task)
    payment_amount_lamports = int(request.stakes * LAMPORTS_PER_SOL)

    await store.upsert_user(user.id, user.email, user.display_name)

    orchestrator = AgoraOrchestrator(agent_count=request.agent_count)
    selection = await orchestrator.selector.select(
        task_text=request.task,
        agent_count=request.agent_count,
        stakes=request.stakes,
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
        mechanism=selection.mechanism.value,
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
    await store.save_task(user.id, task_id, task_status.model_dump(mode="json"))

    await persist_and_emit(
        store=store,
        stream=get_stream_manager(),
        user_id=user.id,
        task_id=task_id,
        event_type="mechanism_selected",
        event_data={
            "task_id": task_id,
            "mechanism": selection.mechanism.value,
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

    store = get_task_store()
    stream = get_stream_manager()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task = _to_status_response(raw_task, detailed=True)
    if task.status in {"completed", "paid"} and task.result is not None:
        return task.result
    if task.status not in {"pending", "in_progress"}:
        raise HTTPException(status_code=409, detail=f"Task cannot run from status={task.status}")

    task.status = "in_progress"
    await store.save_task(user.id, task_id, task.model_dump(mode="json"))

    async def runtime_event_sink(event_type: str, data: dict[str, Any]) -> None:
        await persist_and_emit(
            store=store,
            stream=stream,
            user_id=user.id,
            task_id=task_id,
            event_type=event_type,
            event_data=data,
        )

    orchestrator = AgoraOrchestrator(agent_count=task.agent_count)
    try:
        result = await orchestrator.run(
            task=task.task_text,
            stakes=task.payment_amount,
            mechanism_override=task.mechanism,
            event_sink=runtime_event_sink,
        )
    except Exception as exc:
        task.status = "failed"
        await store.save_task(user.id, task_id, task.model_dump(mode="json"))
        await persist_and_emit(
            store=store,
            stream=stream,
            user_id=user.id,
            task_id=task_id,
            event_type="error",
            event_data={"message": str(exc)},
        )
        await stream.close(task_id)
        logger.exception("task_execution_failed", task_id=task_id)
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
                for event in await store.get_events(user.id, task_id)
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
    task.quorum_reached = result_response.quorum_reached
    task.merkle_root = result_response.merkle_root
    task.decision_hash = result_response.decision_hash
    task.round_count = result_response.round_count
    task.mechanism_switches = result_response.mechanism_switches
    task.transcript_hashes = result_response.transcript_hashes
    task.completed_at = datetime.now(UTC)
    task.result = result_response

    await store.save_task(user.id, task_id, task.model_dump(mode="json"))
    await persist_and_emit(
        store=store,
        stream=stream,
        user_id=user.id,
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
            user_id=user.id,
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
        user_id=user.id,
        task_id=task_id,
        event_type="complete",
        event_data={"task_id": task_id, "status": task.status},
    )
    await stream.close(task_id)
    return result_response


@router.get("/", response_model=list[TaskStatusResponse])
async def list_tasks(
    user: CurrentUser,
) -> list[TaskStatusResponse]:
    """List recent tasks for the current user."""

    store = get_task_store()
    rows = await store.list_user_tasks(user.id)
    return [_to_status_response(row, detailed=False) for row in rows]


@router.get("/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(
    task_id: str,
    user: CurrentUser,
    detailed: bool = Query(default=False),
) -> TaskStatusResponse:
    """Fetch one task by id."""

    store = get_task_store()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return _to_status_response(raw_task, detailed=detailed)


@router.get("/{task_id}/stream")
async def stream_task(
    task_id: str,
    user: CurrentUser,
) -> EventSourceResponse:
    """Replay persisted events, then continue with live SSE updates."""

    store = get_task_store()
    stream = get_stream_manager()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_generator() -> Any:
        events = await store.get_events(user.id, task_id)
        for event in events:
            yield {
                "event": event.get("event", "update"),
                "data": event.get("data", {}),
            }

        if any(event.get("event") == "complete" for event in events):
            return

        queue = stream.subscribe(task_id)
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item
        finally:
            stream.unsubscribe(task_id, queue)

    return EventSourceResponse(event_generator())


@router.post("/{task_id}/pay")
async def release_payment(
    task_id: str,
    user: CurrentUser,
) -> dict[str, str | bool]:
    """Release escrow payment for a completed task."""

    store = get_task_store()
    stream = get_stream_manager()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

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

    await store.save_task(user.id, task_id, task.model_dump(mode="json"))
    await persist_and_emit(
        store=store,
        stream=stream,
        user_id=user.id,
        task_id=task_id,
        event_type="payment_released",
        event_data={
            "task_id": task_id,
            "tx_hash": task.solana_tx_hash,
            "explorer_url": task.explorer_url,
        },
    )

    return {"released": True, "tx_hash": task.solana_tx_hash or ""}
