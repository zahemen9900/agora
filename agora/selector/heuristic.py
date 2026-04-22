"""Deterministic heuristic fallback for mechanism routing."""

from __future__ import annotations

import hashlib

from agora.types import MechanismSelection, MechanismType, TaskFeatures


class HeuristicSelector:
    """Rule-based selector used before bandit fallback when reasoning is unavailable."""

    def select(
        self,
        *,
        features: TaskFeatures,
        bandit_recommendation: tuple[MechanismType, float],
    ) -> MechanismSelection:
        """Choose a mechanism deterministically from extracted task features."""

        bandit_mechanism, bandit_confidence = bandit_recommendation

        topic = features.topic_category.strip().lower()
        complexity = features.complexity_score
        disagreement = features.expected_disagreement
        answer_space = features.answer_space_size
        stakes = features.stakes

        mechanism = MechanismType.VOTE
        confidence = 0.63
        rationale = (
            "Deterministic heuristic fallback selected vote because the task appears "
            "bounded, low-disagreement, and easier to resolve through direct aggregation."
        )

        if topic in {"reasoning", "creative"}:
            mechanism = MechanismType.DEBATE
            confidence = 0.74
            rationale = (
                "Deterministic heuristic fallback selected debate because this domain tends "
                "to benefit from adversarial exploration and synthesis."
            )
        elif topic == "code" and (complexity >= 0.55 or answer_space >= 4):
            mechanism = MechanismType.DEBATE
            confidence = 0.69
            rationale = (
                "Deterministic heuristic fallback selected debate because the code task "
                "looks multi-path or failure-sensitive enough to justify rebuttal."
            )
        elif disagreement >= 0.6 or answer_space >= 6 or stakes >= 0.7:
            mechanism = MechanismType.DEBATE
            confidence = 0.67
            rationale = (
                "Deterministic heuristic fallback selected debate because the task shows "
                "high disagreement potential, large answer space, or elevated stakes."
            )
        elif topic == "factual" and disagreement <= 0.35 and answer_space <= 3:
            mechanism = MechanismType.VOTE
            confidence = 0.76
            rationale = (
                "Deterministic heuristic fallback selected vote because factual low-"
                "disagreement questions are usually best served by parallel direct answers."
            )
        elif topic == "math" and complexity <= 0.55 and answer_space <= 3:
            mechanism = MechanismType.VOTE
            confidence = 0.73
            rationale = (
                "Deterministic heuristic fallback selected vote because the math task looks "
                "narrow enough for independent solutions plus aggregation."
            )
        elif bandit_mechanism == MechanismType.DEBATE and bandit_confidence >= 0.72:
            mechanism = MechanismType.DEBATE
            confidence = min(0.78, max(0.6, bandit_confidence))
            rationale = (
                "Deterministic heuristic fallback aligned with the learned debate prior "
                "because the observed features do not justify overriding a strong bandit signal."
            )

        reasoning_hash = hashlib.sha256(rationale.encode("utf-8")).hexdigest()
        return MechanismSelection(
            mechanism=mechanism,
            confidence=confidence,
            reasoning=rationale,
            reasoning_hash=reasoning_hash,
            bandit_recommendation=bandit_mechanism,
            bandit_confidence=bandit_confidence,
            task_features=features,
            selector_source="heuristic_fallback",
            selector_fallback_path=["reasoning", "heuristic"],
        )
