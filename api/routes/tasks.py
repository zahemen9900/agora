"""Task API endpoints with Week 1 mock behavior."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from typing import Annotated, Any

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
from api.solana_bridge import bridge
from api.store import TaskStore, get_store
from api.store_local import LocalTaskStore

router = APIRouter()

_store: TaskStore | LocalTaskStore = get_store(
    settings.gcs_bucket if settings.gcs_bucket and settings.google_cloud_project else None
)
CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


def _build_task_id(task_text: str) -> str:
    return hashlib.sha256(task_text.encode()).hexdigest()[:32]


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
    task_id = _build_task_id(request.task)
    mechanism = "debate" if request.agent_count >= 5 else "vote"

    await _store.upsert_user(user.id, user.email, user.display_name)

    task_status = TaskStatusResponse(
        task_id=task_id,
        task_text=request.task,
        mechanism=mechanism,
        status="pending",
        selector_reasoning="Mock selection from Week 1 API scaffold.",
        selector_reasoning_hash=hashlib.sha256(f"{task_id}:selector".encode()).hexdigest(),
        agent_count=request.agent_count,
        payment_amount=request.stakes,
        payment_status="locked" if request.stakes > 0 else "none",
        created_at=datetime.now(UTC),
    )

    await _store.save_task(user.id, task_id, task_status.model_dump(mode="json"))
    await _store.append_event(
        user.id,
        task_id,
        SSEEvent(
            event="mechanism_selected",
            data={
                "task_id": task_id,
                "mechanism": mechanism,
                "confidence": 0.73,
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
    raw_task = await _store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task = _to_status_response(raw_task)

    result = _mock_result(task_id, task.mechanism)
    receipt = await bridge.submit_receipt(
        task_id,
        result.merkle_root or "",
        result.decision_hash or "",
    )

    task.status = "completed"
    task.quorum_reached = result.quorum_reached
    task.merkle_root = result.merkle_root
    task.decision_hash = result.decision_hash
    task.completed_at = datetime.now(UTC)
    task.solana_tx_hash = str(receipt.get("tx_hash", ""))
    task.explorer_url = (
        f"https://explorer.solana.com/tx/{task.solana_tx_hash}?cluster=devnet"
        if task.solana_tx_hash
        else None
    )
    task.result = result

    await _store.save_task(user.id, task_id, task.model_dump(mode="json"))
    await _store.append_event(
        user.id,
        task_id,
        SSEEvent(
            event="quorum_reached" if result.quorum_reached else "quorum_not_reached",
            data={
                "task_id": task_id,
                "final_answer": result.final_answer,
                "confidence": result.confidence,
            },
        ).model_dump(),
    )
    await _store.append_event(user.id, task_id, SSEEvent(event="complete", data={}).model_dump())

    return result


@router.get("/", response_model=list[TaskStatusResponse])
async def list_tasks(
    user: CurrentUser,
) -> list[TaskStatusResponse]:
    rows = await _store.list_user_tasks(user.id)
    return [_to_status_response(row) for row in rows]


@router.get("/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(
    task_id: str,
    user: CurrentUser,
) -> TaskStatusResponse:
    raw_task = await _store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return _to_status_response(raw_task)


@router.get("/{task_id}/stream")
async def stream_task(
    task_id: str,
    user: CurrentUser,
) -> EventSourceResponse:
    raw_task = await _store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_generator() -> Any:
        events = await _store.get_events(user.id, task_id)
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
    raw_task = await _store.get_task(user.id, task_id)
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task = _to_status_response(raw_task)

    task.status = "paid"
    task.payment_status = "released"

    await _store.save_task(user.id, task_id, task.model_dump(mode="json"))
    await _store.append_event(
        user.id,
        task_id,
        SSEEvent(event="receipt_committed", data={"task_id": task_id}).model_dump(),
    )

    return {"released": True, "tx_hash": task.solana_tx_hash or "mock_hash"}
