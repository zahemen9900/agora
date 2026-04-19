"""Shared typed models for Agora protocol runtime state and outputs."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MechanismType(StrEnum):
    """Deliberation mechanisms in the protocol narrative.

    Only ``debate`` and ``vote`` are executable in the current runtime. ``delphi``
    and ``moa`` remain visible as roadmap values so historical docs and protocol
    design notes have stable names without widening the public execution surface.
    """

    DEBATE = "debate"
    VOTE = "vote"
    DELPHI = "delphi"
    MOA = "moa"


SUPPORTED_MECHANISMS: frozenset[MechanismType] = frozenset(
    {MechanismType.DEBATE, MechanismType.VOTE}
)


def mechanism_is_supported(mechanism: MechanismType) -> bool:
    """Return whether a mechanism is currently executable in runtime paths."""

    return mechanism in SUPPORTED_MECHANISMS


ProviderTierName = Literal["pro", "flash", "kimi", "claude"]
GeminiProReasoningPreset = Literal["low", "high"]
ReasoningPresetName = Literal["low", "medium", "high"]
ExecutionMode = Literal["live", "fallback", "mixed", "offline_benchmark"]
SelectorSource = Literal["llm_reasoning", "bandit_fallback", "forced_override", "env_pin"]
MechanismOverrideSource = Literal["request", "env_pin", "sdk", "benchmark"]
CostEstimationMode = Literal["exact", "approx_total_tokens", "unavailable", "mixed"]


class ReasoningPresetOverrides(BaseModel):
    """Optional user-supplied overrides for provider reasoning behavior."""

    model_config = ConfigDict(frozen=True)

    gemini_pro: GeminiProReasoningPreset | None = None
    gemini_flash: ReasoningPresetName | None = None
    kimi: ReasoningPresetName | None = None
    claude: ReasoningPresetName | None = None


class ReasoningPresets(BaseModel):
    """Resolved provider reasoning presets persisted with runs and benchmarks."""

    model_config = ConfigDict(frozen=True)

    gemini_pro: GeminiProReasoningPreset
    gemini_flash: ReasoningPresetName
    kimi: ReasoningPresetName
    claude: ReasoningPresetName


class TaskFeatures(BaseModel):
    """Structured task features used by mechanism routing logic."""

    model_config = ConfigDict(frozen=True)

    task_text: str
    complexity_score: float = Field(ge=0.0, le=1.0)
    topic_category: str
    expected_disagreement: float = Field(ge=0.0, le=1.0)
    answer_space_size: int = Field(ge=1)
    time_sensitivity: float = Field(ge=0.0, le=1.0)
    agent_count: int = Field(ge=1)
    stakes: float = Field(ge=0.0, le=1.0)


class MechanismSelection(BaseModel):
    """Mechanism selector output with explainability metadata."""

    model_config = ConfigDict(frozen=True)

    mechanism: MechanismType
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str
    reasoning_hash: str
    bandit_recommendation: MechanismType
    bandit_confidence: float = Field(ge=0.0, le=1.0)
    task_features: TaskFeatures


class AgentOutput(BaseModel):
    """A single contribution emitted by an agent in any engine."""

    model_config = ConfigDict(frozen=True)

    agent_id: str
    agent_model: str
    role: str
    round_number: int = Field(ge=0)
    content: str
    confidence: float = Field(ge=0.0, le=1.0)
    predicted_group_answer: str | None = None
    content_hash: str
    timestamp: datetime


class VerifiedClaim(BaseModel):
    """A verified claim locked during debate execution."""

    model_config = ConfigDict(frozen=True)

    claim_text: str
    verified_by: str
    round_locked: int = Field(ge=0)
    claim_hash: str


class ConvergenceMetrics(BaseModel):
    """Per-round convergence metrics used for termination and switching."""

    model_config = ConfigDict(frozen=True)

    round_number: int = Field(ge=0)
    disagreement_entropy: float = Field(ge=0.0)
    entropy_delta: float = 0.0
    js_divergence: float = Field(default=0.0, ge=0.0)
    answer_churn: float = Field(default=0.0, ge=0.0, le=1.0)
    locked_claim_count: int = Field(default=0, ge=0)
    locked_claim_growth: float = Field(default=0.0, ge=0.0)
    novelty_score: float = Field(default=0.0, ge=0.0)
    information_gain_delta: float = Field(ge=0.0)
    unique_answers: int = Field(ge=1)
    dominant_answer_share: float = Field(ge=0.0, le=1.0)
    answer_distribution: dict[str, float] = Field(default_factory=dict)


class FallbackEvent(BaseModel):
    """A runtime fallback event that affected execution provenance."""

    model_config = ConfigDict(frozen=True)

    component: str
    reason: str
    fallback_type: str = "deterministic"
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))


class MechanismTraceSegment(BaseModel):
    """One contiguous mechanism segment in a full deliberation trace."""

    model_config = ConfigDict(frozen=True)

    mechanism: MechanismType
    start_round: int = Field(ge=0)
    end_round: int = Field(ge=0)
    transcript_hashes: list[str] = Field(default_factory=list)
    convergence_history: list[ConvergenceMetrics] = Field(default_factory=list)
    switch_reason: str | None = None
    switch_reason_hash: str | None = None


class ModelTelemetry(BaseModel):
    """Canonical per-model token, latency, and pricing telemetry."""

    model_config = ConfigDict(frozen=True)

    total_tokens: int = Field(default=0, ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    thinking_tokens: int | None = Field(default=None, ge=0)
    latency_ms: float = Field(default=0.0, ge=0.0)
    estimated_cost_usd: float | None = Field(default=None, ge=0.0)
    estimation_mode: CostEstimationMode | None = None


class CostEstimate(BaseModel):
    """Canonical aggregate cost payload derived from model telemetry."""

    model_config = ConfigDict(frozen=True)

    estimated_cost_usd: float | None = Field(default=None, ge=0.0)
    model_estimated_costs_usd: dict[str, float] = Field(default_factory=dict)
    pricing_version: str | None = None
    estimated_at: datetime | None = None
    estimation_mode: CostEstimationMode | None = None
    pricing_sources: dict[str, str] = Field(default_factory=dict)


class DebateState(BaseModel):
    """LangGraph state for the factional debate engine."""

    model_config = ConfigDict(frozen=False)

    task: str
    task_features: TaskFeatures
    round: int = Field(default=0, ge=0)
    max_rounds: int = Field(default=4, ge=1)
    factions: dict[str, list[AgentOutput]] = Field(default_factory=dict)
    cross_examinations: list[AgentOutput] = Field(default_factory=list)
    rebuttals: dict[str, list[AgentOutput]] = Field(default_factory=dict)
    locked_claims: list[VerifiedClaim] = Field(default_factory=list)
    convergence_history: list[ConvergenceMetrics] = Field(default_factory=list)
    transcript_hashes: list[str] = Field(default_factory=list)
    final_answer: str | None = None
    merkle_root: str | None = None
    mechanism_switches: int = Field(default=0, ge=0)
    terminated_early: bool = False


class VoteState(BaseModel):
    """LangGraph state for the ISP-weighted vote engine."""

    model_config = ConfigDict(frozen=False)

    task: str
    task_features: TaskFeatures
    agent_outputs: list[AgentOutput] = Field(default_factory=list)
    calibrated_confidences: dict[str, float] = Field(default_factory=dict)
    isp_scores: dict[str, float] = Field(default_factory=dict)
    final_weights: dict[str, float] = Field(default_factory=dict)
    quorum_reached: bool = False
    quorum_threshold: float = Field(default=0.6, ge=0.0, le=1.0)
    final_answer: str | None = None
    transcript_hashes: list[str] = Field(default_factory=list)
    merkle_root: str | None = None


class DeliberationResult(BaseModel):
    """Unified result emitted by all execution mechanisms."""

    model_config = ConfigDict(frozen=True)

    task: str
    mechanism_used: MechanismType
    mechanism_selection: MechanismSelection
    final_answer: str
    confidence: float = Field(ge=0.0, le=1.0)
    quorum_reached: bool
    round_count: int = Field(ge=1)
    agent_count: int = Field(ge=1)
    mechanism_switches: int = Field(ge=0)
    merkle_root: str
    transcript_hashes: list[str]
    agent_models_used: list[str] = Field(default_factory=list)
    model_token_usage: dict[str, int] = Field(default_factory=dict)
    model_latency_ms: dict[str, float] = Field(default_factory=dict)
    model_input_token_usage: dict[str, int] = Field(default_factory=dict)
    model_output_token_usage: dict[str, int] = Field(default_factory=dict)
    model_thinking_token_usage: dict[str, int] = Field(default_factory=dict)
    model_telemetry: dict[str, ModelTelemetry] = Field(default_factory=dict)
    convergence_history: list[ConvergenceMetrics] = Field(default_factory=list)
    locked_claims: list[VerifiedClaim] = Field(default_factory=list)
    mechanism_trace: list[MechanismTraceSegment] = Field(default_factory=list)
    reasoning_presets: ReasoningPresets | None = None
    execution_mode: ExecutionMode = "live"
    selector_source: SelectorSource = "llm_reasoning"
    fallback_count: int = Field(default=0, ge=0)
    fallback_events: list[FallbackEvent] = Field(default_factory=list)
    mechanism_override_source: MechanismOverrideSource | None = None
    total_tokens_used: int = Field(ge=0)
    input_tokens_used: int | None = None
    output_tokens_used: int | None = None
    thinking_tokens_used: int | None = None
    total_latency_ms: float = Field(ge=0.0)
    cost: CostEstimate | None = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))


class BanditArm(BaseModel):
    """Internal Thompson sampling arm state per mechanism and category."""

    model_config = ConfigDict(frozen=False)

    mechanism: MechanismType
    category: str
    alpha: float = Field(default=1.0, gt=0.0)
    beta_param: float = Field(default=1.0, gt=0.0)
    total_pulls: int = Field(default=0, ge=0)
    last_reward: float | None = Field(default=None, ge=0.0, le=1.0)
