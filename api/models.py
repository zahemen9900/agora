"""Request and response models for Agora API endpoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

MechanismName = Literal["debate", "vote"]
TaskStatusName = Literal["pending", "in_progress", "completed", "failed", "paid"]
PaymentStatusName = Literal["locked", "released", "none"]
AuthMethodName = Literal["jwt", "api_key"]
ApiKeyScopeName = Literal["tasks:read", "tasks:write", "api_keys:read", "api_keys:write"]


class TaskCreateRequest(BaseModel):
    """Payload for creating a persisted task."""

    task: str = Field(min_length=1, max_length=12_000)
    agent_count: int = Field(default=3, ge=1, le=10)
    stakes: float = Field(default=0.0, ge=0.0)
    mechanism_override: MechanismName | None = None


class TaskCreateResponse(BaseModel):
    """Selector result returned at task creation time."""

    task_id: str
    mechanism: MechanismName
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str
    selector_reasoning_hash: str
    status: TaskStatusName


class TaskEvent(BaseModel):
    """Persisted or streamed task event."""

    event: str
    data: dict[str, Any]
    timestamp: datetime | None = None


class DeliberationResultResponse(BaseModel):
    """Serialized deliberation result used by API and SDK callers."""

    task_id: str
    mechanism: MechanismName
    final_answer: str
    confidence: float = Field(ge=0.0, le=1.0)
    quorum_reached: bool
    merkle_root: str | None = None
    decision_hash: str | None = None
    agent_count: int = Field(ge=1, default=1)
    agent_models_used: list[str] = Field(default_factory=list)
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
    workspace_id: str = ""
    created_by: str = ""
    mechanism: MechanismName
    mechanism_override: MechanismName | None = None
    status: TaskStatusName
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
    payment_status: PaymentStatusName = "none"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None
    result: DeliberationResultResponse | None = None
    events: list[TaskEvent] = Field(default_factory=list)


class PrincipalResponse(BaseModel):
    """Normalized authenticated principal returned to frontend callers."""

    auth_method: AuthMethodName
    workspace_id: str
    user_id: str | None = None
    display_name: str
    email: str
    scopes: list[ApiKeyScopeName] = Field(default_factory=list)
    api_key_id: str | None = None


class WorkspaceResponse(BaseModel):
    """Workspace metadata exposed to dashboard clients."""

    id: str
    display_name: str
    kind: Literal["personal"] = "personal"
    owner_user_id: str
    created_at: datetime


class FeatureFlagsResponse(BaseModel):
    """Simple frontend feature flags for gated UI surfaces."""

    benchmarks_visible: bool = False
    api_keys_visible: bool = True


class AuthMeResponse(BaseModel):
    """Dashboard bootstrap payload for authenticated callers."""

    principal: PrincipalResponse
    workspace: WorkspaceResponse
    feature_flags: FeatureFlagsResponse


class ApiKeyCreateRequest(BaseModel):
    """Request payload for issuing a new workspace API key."""

    name: str = Field(min_length=1, max_length=100)


class ApiKeyMetadataResponse(BaseModel):
    """Safe API key metadata returned by list and revoke endpoints."""

    key_id: str
    workspace_id: str
    name: str
    public_id: str
    scopes: list[ApiKeyScopeName] = Field(default_factory=list)
    created_by_user_id: str
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    revoked_at: datetime | None = None


class ApiKeyCreateResponse(BaseModel):
    """One-time API key reveal payload."""

    api_key: str
    metadata: ApiKeyMetadataResponse
