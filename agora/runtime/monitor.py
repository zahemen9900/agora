"""Convergence monitoring for adaptive termination and mechanism switching."""

from __future__ import annotations

import json
import math
from collections import Counter
from typing import TypeAlias

from agora.types import AgentOutput, ConvergenceMetrics, MechanismType

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]


class StateMonitor:
    """Tracks convergence behavior and emits control decisions."""

    def __init__(self) -> None:
        """Initialize monitor state."""

        self._last_entropy: float | None = None
        self._last_distribution: dict[str, float] | None = None
        self._last_locked_claim_count: int | None = None

    def reset(self) -> None:
        """Reset monitor state for a new task execution."""

        self._last_entropy = None
        self._last_distribution = None
        self._last_locked_claim_count = None

    def compute_metrics(
        self,
        agent_outputs: list[AgentOutput],
        locked_claim_count: int | None = None,
    ) -> ConvergenceMetrics:
        """Compute convergence metrics from current round outputs.

        Args:
            agent_outputs: Agent outputs for one round/phase.
            locked_claim_count: Total verified claims available after the round.

        Returns:
            ConvergenceMetrics: Entropy, information gain delta, and distribution stats.

        Raises:
            ValueError: If no outputs are provided.
        """

        if not agent_outputs:
            raise ValueError("compute_metrics requires at least one agent output")

        weighted_counts: Counter[str] = Counter()
        for output in agent_outputs:
            normalized_answer = self.extract_answer_signal(output)
            weight = min(1.0, max(0.0, output.confidence))
            weighted_counts[normalized_answer] += weight if weight > 0.0 else 1e-9
        total_weight = sum(weighted_counts.values())
        distribution = {
            answer: weight / total_weight for answer, weight in weighted_counts.items()
        }

        probabilities = list(distribution.values())
        entropy = -sum(p * math.log2(p) for p in probabilities if p > 0.0)
        dominant_share = max(probabilities)

        if self._last_entropy is None:
            entropy_delta = 0.0
            js_divergence = 0.0
            answer_churn = 0.0
        else:
            entropy_delta = self._last_entropy - entropy
            previous_distribution = self._last_distribution or {}
            js_divergence = self._jensen_shannon_divergence(
                previous_distribution,
                distribution,
            )
            answer_churn = self._answer_churn(previous_distribution, distribution)

        normalized_locked_claim_count = (
            max(0, int(locked_claim_count)) if locked_claim_count is not None else 0
        )
        if self._last_locked_claim_count is None:
            locked_claim_growth = 0.0
        else:
            growth_delta = max(0, normalized_locked_claim_count - self._last_locked_claim_count)
            locked_claim_growth = growth_delta / max(1, normalized_locked_claim_count)

        novelty_score = min(1.0, (0.5 * js_divergence) + (0.5 * locked_claim_growth))
        self._last_entropy = entropy
        self._last_distribution = distribution
        self._last_locked_claim_count = normalized_locked_claim_count

        round_number = max(output.round_number for output in agent_outputs)
        return ConvergenceMetrics(
            round_number=round_number,
            disagreement_entropy=entropy,
            entropy_delta=entropy_delta,
            js_divergence=js_divergence,
            answer_churn=answer_churn,
            locked_claim_count=normalized_locked_claim_count,
            locked_claim_growth=locked_claim_growth,
            novelty_score=novelty_score,
            information_gain_delta=novelty_score,
            unique_answers=len(distribution),
            dominant_answer_share=dominant_share,
            answer_distribution=distribution,
        )

    @staticmethod
    def _jensen_shannon_divergence(
        previous: dict[str, float],
        current: dict[str, float],
    ) -> float:
        """Compute bounded distribution movement between consecutive rounds."""

        keys = set(previous) | set(current)
        if not keys:
            return 0.0

        def kl_divergence(p_dist: dict[str, float], q_dist: dict[str, float]) -> float:
            divergence = 0.0
            for key in keys:
                p = p_dist.get(key, 0.0)
                q = q_dist.get(key, 0.0)
                if p > 0.0 and q > 0.0:
                    divergence += p * math.log2(p / q)
            return divergence

        midpoint = {key: 0.5 * (previous.get(key, 0.0) + current.get(key, 0.0)) for key in keys}
        return 0.5 * kl_divergence(previous, midpoint) + 0.5 * kl_divergence(
            current,
            midpoint,
        )

    @staticmethod
    def _answer_churn(previous: dict[str, float], current: dict[str, float]) -> float:
        """Return total distribution mass that moved between answers."""

        keys = set(previous) | set(current)
        return 0.5 * sum(abs(current.get(key, 0.0) - previous.get(key, 0.0)) for key in keys)

    @staticmethod
    def extract_answer_signal(output: AgentOutput) -> str:
        """Extract the answer signal used for convergence tracking.

        Debate outputs are often structured JSON payloads whose evidence/defense text
        changes every round. For convergence, we care about the defended answer, not
        the entire serialized argument body.
        """

        parsed = StateMonitor._parse_payload(output.content)
        extracted = StateMonitor._extract_signal_from_payload(parsed)
        candidate = extracted if extracted is not None else output.content
        return " ".join(candidate.strip().lower().split())

    @staticmethod
    def _parse_payload(content: str) -> JsonValue:
        """Parse a structured payload when possible."""

        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return content

    @staticmethod
    def _extract_signal_from_payload(payload: JsonValue) -> str | None:
        """Find the most relevant answer-like field inside a structured payload."""

        if isinstance(payload, str):
            return payload if payload.strip() else None

        if isinstance(payload, dict):
            for key in ("current_answer", "answer", "final_answer", "claim"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value

            for key, value in payload.items():
                if key in {
                    "assigned_answer",
                    "faction_answer",
                    "defense",
                    "evidence",
                    "reasoning",
                    "summary",
                }:
                    continue
                extracted = StateMonitor._extract_signal_from_payload(value)
                if extracted is not None:
                    return extracted

            for key in ("assigned_answer", "faction_answer"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value

        if isinstance(payload, list):
            for item in payload:
                extracted = StateMonitor._extract_signal_from_payload(item)
                if extracted is not None:
                    return extracted

        return None

    def should_terminate(
        self,
        convergence_history: list[ConvergenceMetrics],
        min_rounds: int = 2,
        plateau_threshold: float = 0.05,
        plateau_rounds: int = 2,
    ) -> tuple[bool, str]:
        """Determine whether to stop current mechanism early.

        Args:
            convergence_history: Metrics history by round.
            min_rounds: Minimum rounds before early stop.
            plateau_threshold: Maximum info gain considered plateau.
            plateau_rounds: Consecutive rounds required for plateau stop.

        Returns:
            Tuple[bool, str]: Terminate decision and explanation.
        """

        if not convergence_history or len(convergence_history) < min_rounds:
            return False, "Insufficient rounds for termination check"

        latest = convergence_history[-1]
        if latest.dominant_answer_share > 0.9:
            return True, "Strong consensus reached"

        if len(convergence_history) < plateau_rounds:
            return False, "Insufficient rounds for plateau detection"

        trailing = convergence_history[-plateau_rounds:]
        if all(
            abs(metric.entropy_delta) < plateau_threshold
            and metric.information_gain_delta < plateau_threshold
            for metric in trailing
        ):
            return True, "Novelty plateau detected"

        return False, "Continue deliberation"

    def should_switch_mechanism(
        self,
        convergence_history: list[ConvergenceMetrics],
        current_mechanism: MechanismType,
        min_rounds_before_switch: int = 2,
    ) -> tuple[bool, MechanismType | None, str]:
        """Suggest mechanism switch when convergence degrades.

        Args:
            convergence_history: Metrics history by round.
            current_mechanism: Active mechanism.
            min_rounds_before_switch: Minimum rounds before switching.

        Returns:
            Tuple[bool, MechanismType | None, str]: Switch flag, suggested target, reason.
        """

        if len(convergence_history) < min_rounds_before_switch:
            return False, None, "Insufficient rounds for switch detection"

        if len(convergence_history) >= 3:
            e1 = convergence_history[-3].disagreement_entropy
            e2 = convergence_history[-2].disagreement_entropy
            e3 = convergence_history[-1].disagreement_entropy
            if e1 < e2 < e3:
                if current_mechanism == MechanismType.DEBATE:
                    return (
                        True,
                        MechanismType.VOTE,
                        "Entropy rising across rounds; switching debate to vote",
                    )
                if current_mechanism == MechanismType.VOTE:
                    return (
                        True,
                        MechanismType.DEBATE,
                        "Entropy rising across rounds; switching vote to debate",
                    )

        latest = convergence_history[-1]
        if (
            latest.dominant_answer_share < 0.3
            and len(convergence_history) >= min_rounds_before_switch
        ):
            if current_mechanism == MechanismType.DEBATE:
                return (
                    True,
                    MechanismType.VOTE,
                    "No traction after multiple rounds; switching to vote",
                )
            if current_mechanism == MechanismType.VOTE:
                return True, MechanismType.DEBATE, "Vote lacks traction; switching to debate"

        return False, None, "No mechanism switch needed"
