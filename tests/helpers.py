"""Shared helper builders for tests."""

from __future__ import annotations

from datetime import UTC, datetime

from agora.runtime.hasher import TranscriptHasher
from agora.types import AgentOutput, MechanismSelection, MechanismType, TaskFeatures

hasher = TranscriptHasher()


def make_features(topic_category: str = "reasoning") -> TaskFeatures:
    """Create default task features for tests."""

    expected_disagreement = {
        "math": 0.2,
        "code": 0.4,
        "reasoning": 0.7,
        "factual": 0.15,
        "creative": 0.9,
    }.get(topic_category, 0.7)

    answer_space_size = {
        "math": 2,
        "code": 6,
        "reasoning": 10,
        "factual": 3,
        "creative": 50,
    }.get(topic_category, 10)

    return TaskFeatures(
        task_text="test task",
        complexity_score=0.5,
        topic_category=topic_category,
        expected_disagreement=expected_disagreement,
        answer_space_size=answer_space_size,
        time_sensitivity=0.5,
        agent_count=3,
        stakes=0.5,
    )


def make_selection(
    mechanism: MechanismType = MechanismType.DEBATE,
    topic_category: str = "reasoning",
) -> MechanismSelection:
    """Create a selector output for tests."""

    return MechanismSelection(
        mechanism=mechanism,
        confidence=0.7,
        reasoning="test reasoning",
        reasoning_hash=hasher.hash_content("test reasoning"),
        bandit_recommendation=mechanism,
        bandit_confidence=0.6,
        task_features=make_features(topic_category=topic_category),
    )


def make_agent_output(
    agent_id: str,
    content: str,
    confidence: float = 0.7,
    role: str = "voter",
    round_number: int = 1,
    predicted_group_answer: str | None = None,
) -> AgentOutput:
    """Create a deterministic agent output fixture."""

    return AgentOutput(
        agent_id=agent_id,
        agent_model="mock-model",
        role=role,
        round_number=round_number,
        content=content,
        confidence=confidence,
        predicted_group_answer=predicted_group_answer,
        content_hash=hasher.hash_content(content),
        timestamp=datetime(2026, 4, 9, tzinfo=UTC),
    )
