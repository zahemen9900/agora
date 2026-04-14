"""Convergence monitoring for adaptive termination and mechanism switching."""

from __future__ import annotations

import json
import math
from collections import Counter
from typing import Any

from agora.types import AgentOutput, ConvergenceMetrics, MechanismType


class StateMonitor:
    """Tracks convergence behavior and emits control decisions."""

    def __init__(self) -> None:
        """Initialize monitor state."""

        self._last_entropy: float | None = None

    def reset(self) -> None:
        """Reset monitor state for a new task execution."""

        self._last_entropy = None

    def compute_metrics(self, agent_outputs: list[AgentOutput]) -> ConvergenceMetrics:
        """Compute convergence metrics from current round outputs.

        Args:
            agent_outputs: Agent outputs for one round/phase.

        Returns:
            ConvergenceMetrics: Entropy, information gain delta, and distribution stats.

        Raises:
            ValueError: If no outputs are provided.
        """

        if not agent_outputs:
            raise ValueError("compute_metrics requires at least one agent output")

        normalized_answers = [self.extract_answer_signal(output) for output in agent_outputs]
        counts = Counter(normalized_answers)
        total = len(normalized_answers)

        probabilities = [count / total for count in counts.values()]
        entropy = -sum(p * math.log2(p) for p in probabilities if p > 0.0)
        dominant_share = max(probabilities)

        if self._last_entropy is None:
            info_gain_delta = 0.0
        else:
            info_gain_delta = abs(entropy - self._last_entropy)
        self._last_entropy = entropy

        round_number = max(output.round_number for output in agent_outputs)
        return ConvergenceMetrics(
            round_number=round_number,
            disagreement_entropy=entropy,
            information_gain_delta=info_gain_delta,
            unique_answers=len(counts),
            dominant_answer_share=dominant_share,
        )

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
    def _parse_payload(content: str) -> Any:
        """Parse a structured payload when possible."""

        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return content

    @staticmethod
    def _extract_signal_from_payload(payload: Any) -> str | None:
        """Find the most relevant answer-like field inside a structured payload."""

        if isinstance(payload, str):
            return payload if payload.strip() else None

        if isinstance(payload, dict):
            for key in ("faction_answer", "answer", "final_answer", "claim"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value

            for value in payload.values():
                extracted = StateMonitor._extract_signal_from_payload(value)
                if extracted is not None:
                    return extracted

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
        if all(metric.information_gain_delta < plateau_threshold for metric in trailing):
            return True, "Information gain plateau detected"

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
