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

        if topic == "creative":
            mechanism = MechanismType.DELPHI
            confidence = 0.76
            rationale = (
                "Deterministic heuristic fallback selected delphi because creative tasks "
                "benefit from diverse first passes followed by anonymous revision."
            )
        elif topic == "reasoning" and (disagreement >= 0.65 or answer_space >= 8):
            mechanism = MechanismType.DELPHI
            confidence = 0.73
            rationale = (
                "Deterministic heuristic fallback selected delphi because the task has "
                "high disagreement potential and a broad answer space that benefits from "
                "iterative anonymous convergence."
            )
        elif topic == "code" and (complexity >= 0.55 or answer_space >= 4):
            mechanism = MechanismType.DEBATE
            confidence = 0.69
            rationale = (
                "Deterministic heuristic fallback selected debate because the code task "
                "looks multi-path or failure-sensitive enough to justify rebuttal."
            )
        elif disagreement >= 0.75 or answer_space >= 10:
            mechanism = MechanismType.DELPHI
            confidence = 0.7
            rationale = (
                "Deterministic heuristic fallback selected delphi because the task shows "
                "very high disagreement potential or a large answer space that should "
                "be narrowed through multiple anonymous rounds."
            )
        elif stakes >= 0.7 or disagreement >= 0.6 or answer_space >= 6:
            mechanism = MechanismType.DEBATE
            confidence = 0.67
            rationale = (
                "Deterministic heuristic fallback selected debate because the task is "
                "high-stakes or contentious enough to justify direct challenge and rebuttal."
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
        elif bandit_confidence >= 0.72:
            mechanism = bandit_mechanism
            confidence = min(0.78, max(0.6, bandit_confidence))
            rationale = (
                "Deterministic heuristic fallback aligned with the learned bandit prior "
                "because the observed features do not justify overriding a strong historical signal."
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
