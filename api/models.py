"""Request and response models for Agora API endpoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field

from agora.types import ReasoningPresetOverrides, ReasoningPresets

MechanismName = Literal["debate", "vote"]
TaskStatusName = Literal["pending", "in_progress", "completed", "failed", "paid"]
PaymentStatusName = Literal["locked", "released", "none"]
ChainOperationStatusName = Literal["pending", "succeeded", "failed"]
AuthMethodName = Literal["jwt", "api_key"]
ApiKeyScopeName = Literal["tasks:read", "tasks:write", "api_keys:read", "api_keys:write"]


class TaskCreateRequest(BaseModel):
    """Payload for creating a persisted task."""

    task: str = Field(min_length=1, max_length=12_000)
    agent_count: int = Field(default=4, ge=1, le=12)
    stakes: float = Field(default=0.0, ge=0.0)
    mechanism_override: MechanismName | None = None
    allow_mechanism_switch: bool = True
    allow_offline_fallback: bool = False
    quorum_threshold: float = Field(default=0.6, ge=0.0, le=1.0)
    reasoning_presets: ReasoningPresetOverrides | None = None


class TaskCreateResponse(BaseModel):
    """Selector result returned at task creation time."""

    task_id: str
    mechanism: MechanismName
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str
    selector_reasoning_hash: str
    status: TaskStatusName
    selector_source: str = "llm_reasoning"
    mechanism_override_source: str | None = None


class TaskEvent(BaseModel):
    """Persisted or streamed task event."""

    event: str
    data: dict[str, Any]
    timestamp: datetime | None = None


class ChainOperationRecord(BaseModel):
    """Write-ahead status for one Solana side effect tied to a task."""

    status: ChainOperationStatusName
    tx_hash: str | None = None
    explorer_url: str | None = None
    error: str | None = None
    attempts: int = Field(default=0, ge=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


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
    model_token_usage: dict[str, int] = Field(default_factory=dict)
    model_latency_ms: dict[str, float] = Field(default_factory=dict)
    model_telemetry: dict[str, ModelTelemetryResponse] = Field(default_factory=dict)
    total_tokens_used: int = Field(ge=0, default=0)
    reasoning_presets: ReasoningPresets | None = None
    input_tokens_used: int | None = Field(default=None, ge=0)
    output_tokens_used: int | None = Field(default=None, ge=0)
    thinking_tokens_used: int | None = Field(default=None, ge=0)
    latency_ms: float = Field(ge=0.0, default=0.0)
    cost: BenchmarkCostEstimateResponse | None = None
    payment_amount: float = Field(ge=0.0, default=0.0)
    payment_status: PaymentStatusName = "none"
    informational_model_payouts: dict[str, float] = Field(default_factory=dict)
    round_count: int = Field(ge=1, default=1)
    mechanism_switches: int = Field(ge=0, default=0)
    transcript_hashes: list[str] = Field(default_factory=list)
    convergence_history: list[dict[str, Any]] = Field(default_factory=list)
    locked_claims: list[dict[str, Any]] = Field(default_factory=list)
    mechanism_trace: list[dict[str, Any]] = Field(default_factory=list)
    execution_mode: str = "live"
    selector_source: str = "llm_reasoning"
    fallback_count: int = Field(default=0, ge=0)
    fallback_events: list[dict[str, Any]] = Field(default_factory=list)
    mechanism_override_source: str | None = None


class TaskStatusResponse(BaseModel):
    """Full task status record returned by the API."""

    task_id: str
    task_text: str
    workspace_id: str = ""
    created_by: str = ""
    mechanism: MechanismName
    mechanism_override: MechanismName | None = None
    allow_mechanism_switch: bool = True
    allow_offline_fallback: bool = False
    quorum_threshold: float = Field(default=0.6, ge=0.0, le=1.0)
    selector_source: str = "llm_reasoning"
    mechanism_override_source: str | None = None
    status: TaskStatusName
    selector_reasoning: str
    selector_reasoning_hash: str
    selector_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    merkle_root: str | None = None
    decision_hash: str | None = None
    quorum_reached: bool | None = None
    agent_count: int
    reasoning_presets: ReasoningPresets
    round_count: int = Field(default=0, ge=0)
    mechanism_switches: int = Field(default=0, ge=0)
    transcript_hashes: list[str] = Field(default_factory=list)
    solana_tx_hash: str | None = None
    explorer_url: str | None = None
    payment_amount: float = 0.0
    payment_status: PaymentStatusName = "none"
    chain_operations: dict[str, ChainOperationRecord] = Field(default_factory=dict)
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


class AuthConfigResponse(BaseModel):
    """Public auth bootstrap configuration for frontend clients."""

    workos_client_id: str
    workos_authkit_domain: str
    auth_issuer: str
    auth_audience: str
    auth_jwks_url: str


BenchmarkScopeName = Literal["global", "user"]
BenchmarkRunStatusName = Literal["queued", "running", "completed", "failed"]
BenchmarkDomainName = Literal["math", "factual", "reasoning", "code", "creative", "demo"]
BenchmarkPromptSourceName = Literal["template", "custom"]
CostEstimationModeName = Literal["exact", "approx_total_tokens", "unavailable", "mixed"]


class BenchmarkDomainPrompt(BaseModel):
    """Prompt configuration for a single benchmark domain."""

    template_id: str | None = Field(default=None, max_length=120)
    question: str | None = Field(
        default=None,
        max_length=8_000,
        validation_alias=AliasChoices("question", "prompt"),
    )
    source: BenchmarkPromptSourceName = "template"


class BenchmarkCostEstimateResponse(BaseModel):
    """Estimated benchmark cost metadata derived from token telemetry."""

    estimated_cost_usd: float | None = Field(default=None, ge=0.0)
    model_estimated_costs_usd: dict[str, float] = Field(default_factory=dict)
    pricing_version: str | None = None
    estimated_at: datetime | None = None
    estimation_mode: CostEstimationModeName | None = None
    pricing_sources: dict[str, str] = Field(default_factory=dict)


class ModelTelemetryResponse(BaseModel):
    """Normalized per-model telemetry shared by task and benchmark surfaces."""

    total_tokens: int = Field(default=0, ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    thinking_tokens: int | None = Field(default=None, ge=0)
    latency_ms: float = Field(default=0.0, ge=0.0)
    estimated_cost_usd: float | None = Field(default=None, ge=0.0)
    estimation_mode: CostEstimationModeName | None = None


class BenchmarkRunRequest(BaseModel):
    """Request payload for triggering an async benchmark run."""

    training_per_category: int = Field(default=1, ge=1, le=20)
    holdout_per_category: int = Field(default=1, ge=1, le=10)
    agent_count: int = Field(default=4, ge=1, le=12)
    live_agents: bool = True
    seed: int = 42
    domain_prompts: dict[BenchmarkDomainName, BenchmarkDomainPrompt] = Field(default_factory=dict)
    reasoning_presets: ReasoningPresetOverrides | None = None


class BenchmarkRunResponse(BaseModel):
    """Initial acknowledgement for an async benchmark run trigger."""

    run_id: str
    status: BenchmarkRunStatusName
    created_at: datetime


class BenchmarkRunStatusResponse(BaseModel):
    """Status payload for a benchmark run."""

    run_id: str
    status: BenchmarkRunStatusName
    created_at: datetime
    updated_at: datetime
    error: str | None = None
    artifact_id: str | None = None
    request: dict[str, Any] | None = None
    reasoning_presets: ReasoningPresets | None = None
    latest_mechanism: str | None = None
    agent_count: int | None = Field(default=None, ge=1)
    total_tokens: int | None = Field(default=None, ge=0)
    thinking_tokens: int | None = Field(default=None, ge=0)
    total_latency_ms: float | None = Field(default=None, ge=0.0)
    model_telemetry: dict[str, ModelTelemetryResponse] = Field(default_factory=dict)
    cost: BenchmarkCostEstimateResponse | None = None


class BenchmarkCatalogEntry(BaseModel):
    """Normalized benchmark artifact metadata for UI lists."""

    artifact_id: str
    scope: BenchmarkScopeName
    owner_user_id: str | None = None
    source: str = "unknown"
    created_at: datetime
    run_count: int = Field(default=0, ge=0)
    mechanism_counts: dict[str, int] = Field(default_factory=dict)
    model_counts: dict[str, int] = Field(default_factory=dict)
    frequency_score: int = Field(default=0, ge=0)
    status: str | None = None
    latest_mechanism: str | None = None
    agent_count: int | None = Field(default=None, ge=1)
    total_tokens: int = Field(default=0, ge=0)
    thinking_tokens: int = Field(default=0, ge=0)
    total_latency_ms: float = Field(default=0.0, ge=0.0)
    models: list[str] = Field(default_factory=list)
    model_telemetry: dict[str, ModelTelemetryResponse] = Field(default_factory=dict)
    cost: BenchmarkCostEstimateResponse | None = None


class BenchmarkCatalogResponse(BaseModel):
    """Benchmark catalog payload with recent and frequency-sorted views."""

    global_recent: list[BenchmarkCatalogEntry] = Field(default_factory=list)
    global_frequency: list[BenchmarkCatalogEntry] = Field(default_factory=list)
    user_recent: list[BenchmarkCatalogEntry] = Field(default_factory=list)
    user_frequency: list[BenchmarkCatalogEntry] = Field(default_factory=list)
    user_tests_recent: list[BenchmarkRunStatusResponse] = Field(default_factory=list)
    user_tests_frequency: list[BenchmarkRunStatusResponse] = Field(default_factory=list)


class BenchmarkDetailResponse(BaseModel):
    """Expanded benchmark detail payload for dedicated detail views."""

    benchmark_id: str
    artifact_id: str | None = None
    scope: BenchmarkScopeName
    source: str = "unknown"
    status: str | None = None
    owner_user_id: str | None = None
    created_at: datetime
    updated_at: datetime
    run_count: int = Field(default=0, ge=0)
    mechanism_counts: dict[str, int] = Field(default_factory=dict)
    model_counts: dict[str, int] = Field(default_factory=dict)
    frequency_score: int = Field(default=0, ge=0)
    latest_mechanism: str | None = None
    agent_count: int | None = Field(default=None, ge=1)
    total_tokens: int = Field(default=0, ge=0)
    thinking_tokens: int = Field(default=0, ge=0)
    total_latency_ms: float = Field(default=0.0, ge=0.0)
    models: list[str] = Field(default_factory=list)
    run_id: str | None = None
    request: dict[str, Any] | None = None
    reasoning_presets: ReasoningPresets | None = None
    model_telemetry: dict[str, ModelTelemetryResponse] = Field(default_factory=dict)
    events: list[TaskEvent] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    benchmark_payload: dict[str, Any] = Field(default_factory=dict)
    cost: BenchmarkCostEstimateResponse | None = None


class BenchmarkPromptTemplate(BaseModel):
    """Prompt template option exposed by the benchmark wizard API."""

    id: str
    title: str
    question: str


class BenchmarkPromptTemplatesResponse(BaseModel):
    """Prompt template catalog grouped by benchmark domain."""

    domains: dict[BenchmarkDomainName, list[BenchmarkPromptTemplate]]
