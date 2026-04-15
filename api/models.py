"""Request and response models for Agora API endpoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class TaskCreateRequest(BaseModel):
    """Payload for creating a persisted task."""

    task: str = Field(min_length=1)
    agent_count: int = Field(default=3, ge=1, le=10)
    stakes: float = Field(default=0.0, ge=0.0)


class TaskCreateResponse(BaseModel):
    """Selector result returned at task creation time."""

    task_id: str
    mechanism: Literal["debate", "vote", "delphi", "moa"]
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str
    selector_reasoning_hash: str
    status: Literal["pending", "in_progress", "completed", "failed", "paid"]


class TaskEvent(BaseModel):
    """Persisted or streamed task event."""

    event: str
    data: dict[str, Any]
    timestamp: datetime | None = None


class DeliberationResultResponse(BaseModel):
    """Serialized deliberation result used by API and SDK callers."""

    task_id: str
    mechanism: str
    final_answer: str
    confidence: float = Field(ge=0.0, le=1.0)
    quorum_reached: bool
    merkle_root: str | None = None
    decision_hash: str | None = None
    total_tokens_used: int = Field(ge=0, default=0)
    latency_ms: float = Field(ge=0.0, default=0.0)
    round_count: int = Field(ge=1, default=1)
    mechanism_switches: int = Field(ge=0, default=0)
    transcript_hashes: list[str] = Field(default_factory=list)
    convergence_history: list[dict[str, Any]] = Field(default_factory=list)
    locked_claims: list[dict[str, Any]] = Field(default_factory=list)


class TaskStatusResponse(BaseModel):
    """Full task status record returned by the API."""

    task_id: str
    task_text: str
    mechanism: str
    status: Literal["pending", "in_progress", "completed", "failed", "paid"]
    selector_reasoning: str
    selector_reasoning_hash: str
    selector_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    merkle_root: str | None = None
    decision_hash: str | None = None
    quorum_reached: bool | None = None
    agent_count: int
    round_count: int = Field(default=0, ge=0)
    mechanism_switches: int = Field(default=0, ge=0)
    transcript_hashes: list[str] = Field(default_factory=list)
    solana_tx_hash: str | None = None
    explorer_url: str | None = None
    payment_amount: float = 0.0
    payment_status: Literal["locked", "released", "none"] = "none"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None
    result: DeliberationResultResponse | None = None
    events: list[TaskEvent] = Field(default_factory=list)
