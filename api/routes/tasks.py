"""Task API endpoints with Week 1 mock behavior."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from sse_starlette.sse import EventSourceResponse

from api.auth import AuthenticatedUser, get_current_user
from api.config import settings
from api.models import (
    DeliberationResultResponse,
    SSEEvent,
    TaskCreateRequest,
    TaskCreateResponse,
    TaskStatusResponse,
)
from api.solana_bridge import LAMPORTS_PER_SOL, bridge
from api.store import TaskStore, get_store
from api.store_local import LocalTaskStore

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
    return hashlib.sha256(task_text.encode()).hexdigest()


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _mock_result(task_id: str, mechanism: str) -> DeliberationResultResponse:
    return DeliberationResultResponse(
        task_id=task_id,
        mechanism=mechanism,
        final_answer="mock_final_answer",
        confidence=0.82,
        quorum_reached=True,
        merkle_root=hashlib.sha256(f"{task_id}:merkle".encode()).hexdigest(),
        decision_hash=hashlib.sha256(f"{task_id}:decision".encode()).hexdigest(),
        total_tokens_used=321,
        latency_ms=980.0,
    )


def _to_status_response(raw_task: dict[str, Any]) -> TaskStatusResponse:
    return TaskStatusResponse.model_validate(raw_task)


def _to_event(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "event": event.get("event", "update"),
        "data": event.get("data", {}),
    }


@router.post("/", response_model=TaskCreateResponse)
async def create_task(
    request: TaskCreateRequest,
    user: CurrentUser,
) -> TaskCreateResponse:
    store = get_task_store()
    task_id = _build_task_id(request.task)
    task_hash = _hash_text(request.task)
    mechanism = "debate" if request.agent_count >= 5 else "vote"
    selector_reasoning = "Mock selection from Week 1 API scaffold."
    selector_reasoning_hash = _hash_text(selector_reasoning)
    payment_amount_lamports = int(request.stakes * LAMPORTS_PER_SOL)

    await store.upsert_user(user.id, user.email, user.display_name)

    init_tx_hash: str | None = None
    init_explorer_url: str | None = None
    if bridge.is_configured():
        try:
            init_result = await bridge.initialize_task(
                task_id=task_id,
                mechanism=mechanism,
                task_hash=task_hash,
                consensus_threshold=60,
                agent_count=request.agent_count,
                payment_amount_lamports=payment_amount_lamports,
            )
            init_tx_hash = str(init_result.get("tx_hash", "")) or None
            init_explorer_url = str(init_result.get("explorer_url", "")) or None
        except Exception as exc:
            logger.error("task_initialize_failed", task_id=task_id, error=str(exc))
            raise HTTPException(
                status_code=502,
                detail="Failed to initialize task on Solana",
            ) from exc
    else:
        logger.warning("solana_bridge_not_configured", task_id=task_id)

    task_status = TaskStatusResponse(
        task_id=task_id,
        task_text=request.task,
        mechanism=mechanism,
        status="pending",
        selector_reasoning=selector_reasoning,
        selector_reasoning_hash=selector_reasoning_hash,
        agent_count=request.agent_count,
        payment_amount=request.stakes,
        payment_status="locked" if request.stakes > 0 else "none",
        solana_tx_hash=init_tx_hash,
        explorer_url=init_explorer_url,
        created_at=datetime.now(UTC),
    )

    await store.save_task(user.id, task_id, task_status.model_dump(mode="json"))
    await store.append_event(
        user.id,
        task_id,
        SSEEvent(
            event="mechanism_selected",
            data={
                "task_id": task_id,
                "mechanism": mechanism,
                "confidence": 0.73,
                "reasoning": selector_reasoning,
            },
        ).model_dump(),
    )

    return TaskCreateResponse(
        task_id=task_id,
        mechanism=mechanism,
        confidence=0.73,
        reasoning="Task was routed to a mock Week 1 mechanism path.",
    )


@router.post("/{task_id}/run", response_model=DeliberationResultResponse)
async def run_task(
    task_id: str,
    user: CurrentUser,
) -> DeliberationResultResponse:
    store = get_task_store()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task = _to_status_response(raw_task)
    if task.status in {"completed", "paid"} and task.result is not None:
        return task.result

    if task.status not in {"pending", "in_progress"}:
        raise HTTPException(status_code=409, detail=f"Task cannot be run from status={task.status}")

    if task.status == "pending":
        if bridge.is_configured():
            try:
                await bridge.record_selection(
                    task_id=task_id,
                    selector_reasoning_hash=task.selector_reasoning_hash,
                )
            except Exception as exc:
                logger.error("task_selection_record_failed", task_id=task_id, error=str(exc))
                raise HTTPException(
                    status_code=502,
                    detail="Failed to record mechanism selection on Solana",
                ) from exc
        task.status = "in_progress"
        await store.save_task(user.id, task_id, task.model_dump(mode="json"))

    result = _mock_result(task_id, task.mechanism)
    receipt: dict[str, Any] = {}
    if bridge.is_configured():
        try:
            receipt = await bridge.submit_receipt(
                task_id=task_id,
                merkle_root=result.merkle_root or "",
                decision_hash=result.decision_hash or "",
                quorum_reached=result.quorum_reached,
                final_mechanism=task.mechanism,
            )
        except Exception as exc:
            logger.error("task_receipt_submission_failed", task_id=task_id, error=str(exc))
            raise HTTPException(
                status_code=502,
                detail="Failed to submit receipt on Solana",
            ) from exc

    task.status = "completed"
    task.quorum_reached = result.quorum_reached
    task.merkle_root = result.merkle_root
    task.decision_hash = result.decision_hash
    task.completed_at = datetime.now(UTC)
    if receipt:
        task.solana_tx_hash = str(receipt.get("tx_hash", "")) or task.solana_tx_hash
        task.explorer_url = str(receipt.get("explorer_url", "")) or task.explorer_url
    task.result = result

    await store.save_task(user.id, task_id, task.model_dump(mode="json"))
    await store.append_event(
        user.id,
        task_id,
        SSEEvent(
            event="quorum_reached" if result.quorum_reached else "quorum_not_reached",
            data={
                "task_id": task_id,
                "final_answer": result.final_answer,
                "confidence": result.confidence,
                "mechanism": task.mechanism,
            },
        ).model_dump(),
    )
    if task.solana_tx_hash:
        await store.append_event(
            user.id,
            task_id,
            SSEEvent(
                event="receipt_committed",
                data={
                    "merkle_root": task.merkle_root,
                    "solana_tx_hash": task.solana_tx_hash,
                    "explorer_url": task.explorer_url,
                },
            ).model_dump(),
        )
    await store.append_event(user.id, task_id, SSEEvent(event="complete", data={}).model_dump())

    return result


@router.get("/", response_model=list[TaskStatusResponse])
async def list_tasks(
    user: CurrentUser,
) -> list[TaskStatusResponse]:
    store = get_task_store()
    rows = await store.list_user_tasks(user.id)
    return [_to_status_response(row) for row in rows]


@router.get("/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(
    task_id: str,
    user: CurrentUser,
) -> TaskStatusResponse:
    store = get_task_store()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return _to_status_response(raw_task)


@router.get("/{task_id}/stream")
async def stream_task(
    task_id: str,
    user: CurrentUser,
) -> EventSourceResponse:
    store = get_task_store()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_generator() -> Any:
        events = await store.get_events(user.id, task_id)
        if not events:
            task = _to_status_response(raw_task)
            events = [
                SSEEvent(
                    event="mechanism_selected",
                    data={"mechanism": task.mechanism, "confidence": 0.73},
                ).model_dump(),
                SSEEvent(event="complete", data={}).model_dump(),
            ]

        for event in events:
            await asyncio.sleep(0.2)
            yield _to_event(event)

    return EventSourceResponse(event_generator())


@router.post("/{task_id}/pay")
async def release_payment(
    task_id: str,
    user: CurrentUser,
) -> dict[str, str | bool]:
    store = get_task_store()
    raw_task = await store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task = _to_status_response(raw_task)

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
        payment_tx = await bridge.release_payment(
            task_id=task_id,
        )
    except Exception as exc:
        logger.error("task_payment_release_failed", task_id=task_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Failed to record payment on Solana") from exc

    task.status = "paid"
    task.payment_status = "released"
    task.solana_tx_hash = str(payment_tx.get("tx_hash", "")) or task.solana_tx_hash
    task.explorer_url = str(payment_tx.get("explorer_url", "")) or task.explorer_url

    await store.save_task(user.id, task_id, task.model_dump(mode="json"))
    await store.append_event(
        user.id,
        task_id,
        SSEEvent(
            event="receipt_committed",
            data={
                "task_id": task_id,
                "solana_tx_hash": task.solana_tx_hash,
                "explorer_url": task.explorer_url,
            },
        ).model_dump(),
    )

    return {"released": True, "tx_hash": task.solana_tx_hash or ""}
