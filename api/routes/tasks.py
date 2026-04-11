"""Task API endpoints with Week 1 mock behavior."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from api.models import (
    DeliberationResultResponse,
    SSEEvent,
    TaskCreateRequest,
    TaskCreateResponse,
    TaskStatusResponse,
)

router = APIRouter()

_TASKS: dict[str, TaskStatusResponse] = {}


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


@router.post("/", response_model=TaskCreateResponse)
async def create_task(request: TaskCreateRequest) -> TaskCreateResponse:
    task_id = _build_task_id(request.task)
    mechanism = "debate" if request.agent_count >= 5 else "vote"

    _TASKS[task_id] = TaskStatusResponse(
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

    return TaskCreateResponse(
        task_id=task_id,
        mechanism=mechanism,
        confidence=0.73,
        reasoning="Task was routed to a mock Week 1 mechanism path.",
    )


@router.post("/{task_id}/run", response_model=DeliberationResultResponse)
async def run_task(task_id: str) -> DeliberationResultResponse:
    task = _TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    result = _mock_result(task_id, task.mechanism)
    task.status = "completed"
    task.quorum_reached = result.quorum_reached
    task.merkle_root = result.merkle_root
    task.decision_hash = result.decision_hash
    task.completed_at = datetime.now(UTC)
    task.result = result

    return result


@router.get("/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str) -> TaskStatusResponse:
    task = _TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/{task_id}/stream")
async def stream_task(task_id: str) -> EventSourceResponse:
    if task_id not in _TASKS:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_generator() -> Any:
        events = [
            SSEEvent(
                event="mechanism_selected",
                data={"mechanism": _TASKS[task_id].mechanism, "confidence": 0.73},
            ).model_dump(),
            SSEEvent(
                event="agent_output",
                data={"agent_id": "agent-1", "round": 1, "content": "mock output"},
            ).model_dump(),
            SSEEvent(event="complete", data={}).model_dump(),
        ]

        for event in events:
            await asyncio.sleep(0.2)
            yield event

    return EventSourceResponse(event_generator())


@router.post("/{task_id}/pay")
async def release_payment(task_id: str) -> dict[str, str | bool]:
    task = _TASKS.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task.status = "paid"
    task.payment_status = "released"
    return {"released": True, "tx_hash": "mock_hash"}
