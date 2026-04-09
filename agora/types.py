"""Shared typed models for Agora protocol runtime state and outputs."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class MechanismType(StrEnum):
    """Enumeration of supported deliberation mechanisms."""

    DEBATE = "debate"
    VOTE = "vote"
    DELPHI = "delphi"
    MOA = "moa"


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
    information_gain_delta: float = Field(ge=0.0)
    unique_answers: int = Field(ge=1)
    dominant_answer_share: float = Field(ge=0.0, le=1.0)


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
    convergence_history: list[ConvergenceMetrics] = Field(default_factory=list)
    locked_claims: list[VerifiedClaim] = Field(default_factory=list)
    total_tokens_used: int = Field(ge=0)
    total_latency_ms: float = Field(ge=0.0)
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
