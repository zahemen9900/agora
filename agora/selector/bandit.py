"""Thompson Sampling mechanism selector."""

from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
import structlog

from agora.types import BanditArm, MechanismType, TaskFeatures

logger = structlog.get_logger(__name__)

_KNOWN_CATEGORIES = ["math", "code", "reasoning", "factual", "creative"]


class ThompsonSamplingSelector:
    """Contextual Thompson sampling selector over mechanisms and task categories."""

    def __init__(self, mechanisms: list[MechanismType] | None = None) -> None:
        """Initialize bandit arms with uniform priors.

        Args:
            mechanisms: Supported mechanisms. Defaults to debate, vote, and delphi.
        """

        self.mechanisms: list[MechanismType] = mechanisms or [
            MechanismType.DEBATE,
            MechanismType.VOTE,
            MechanismType.DELPHI,
        ]
        self._lock = threading.RLock()
        self.arms: dict[tuple[MechanismType, str], BanditArm] = {}

        for mechanism in self.mechanisms:
            for category in _KNOWN_CATEGORIES:
                self.arms[(mechanism, category)] = BanditArm(
                    mechanism=mechanism,
                    category=category,
                    alpha=1.0,
                    beta_param=1.0,
                )

    def select(self, features: TaskFeatures) -> tuple[MechanismType, float]:
        """Select a mechanism via Thompson sampling.

        Args:
            features: Task features including topic category.

        Returns:
            Tuple of selected mechanism and normalized confidence.
        """

        category = (
            features.topic_category if features.topic_category in _KNOWN_CATEGORIES else "reasoning"
        )

        with self._lock:
            samples: dict[MechanismType, float] = {}
            for mechanism in self.mechanisms:
                arm = self.arms[(mechanism, category)]
                sample = float(np.random.beta(arm.alpha, arm.beta_param))
                samples[mechanism] = sample

        selected = max(samples.items(), key=lambda item: item[1])
        sample_sum = sum(samples.values())
        confidence = selected[1] / sample_sum if sample_sum > 0 else 0.0

        logger.info(
            "bandit_selected",
            category=category,
            selected_mechanism=selected[0].value,
            confidence=confidence,
            samples={k.value: v for k, v in samples.items()},
        )
        return selected[0], confidence

    def update(self, mechanism: MechanismType, category: str, reward: float) -> None:
        """Update posterior parameters for the selected arm.

        Args:
            mechanism: Mechanism that was executed.
            category: Task category for contextual arm lookup.
            reward: Reward in [0, 1].
        """

        bounded_reward = max(0.0, min(1.0, reward))
        normalized_category = category if category in _KNOWN_CATEGORIES else "reasoning"

        with self._lock:
            arm = self.arms[(mechanism, normalized_category)]
            arm.alpha += bounded_reward
            arm.beta_param += 1.0 - bounded_reward
            arm.total_pulls += 1
            arm.last_reward = bounded_reward

        logger.info(
            "bandit_updated",
            mechanism=mechanism.value,
            category=normalized_category,
            reward=bounded_reward,
            alpha=arm.alpha,
            beta_param=arm.beta_param,
            total_pulls=arm.total_pulls,
        )

    def get_stats(self) -> dict[str, dict[str, dict[str, float | int | None]]]:
        """Return all arm statistics for observability and dashboards."""

        with self._lock:
            stats: dict[str, dict[str, dict[str, float | int | None]]] = {}
            for mechanism in self.mechanisms:
                mechanism_key = mechanism.value
                stats[mechanism_key] = {}
                for category in _KNOWN_CATEGORIES:
                    arm = self.arms[(mechanism, category)]
                    stats[mechanism_key][category] = {
                        "alpha": arm.alpha,
                        "beta_param": arm.beta_param,
                        "total_pulls": arm.total_pulls,
                        "last_reward": arm.last_reward,
                    }
        return stats

    def to_state(self) -> dict[str, object]:
        """Serialize arm state for durable stores."""

        with self._lock:
            return {
                "mechanisms": [m.value for m in self.mechanisms],
                "arms": [
                    {
                        "mechanism": arm.mechanism.value,
                        "category": arm.category,
                        "alpha": arm.alpha,
                        "beta_param": arm.beta_param,
                        "total_pulls": arm.total_pulls,
                        "last_reward": arm.last_reward,
                    }
                    for arm in self.arms.values()
                ],
            }

    def load_state_payload(self, payload: dict[str, object]) -> None:
        """Load arm state from an already decoded state payload."""

        if "arms" not in payload:
            raise ValueError("Invalid bandit state payload")

        loaded_arms: dict[tuple[MechanismType, str], BanditArm] = {}
        arms_payload = payload.get("arms", [])

        if not isinstance(arms_payload, list):
            raise ValueError("Invalid arms list in bandit state payload")

        for arm_data in arms_payload:
            if not isinstance(arm_data, dict):
                raise ValueError("Invalid arm entry in bandit state payload")
            mechanism = MechanismType(arm_data["mechanism"])
            category = str(arm_data["category"])
            loaded_arms[(mechanism, category)] = BanditArm(
                mechanism=mechanism,
                category=category,
                alpha=float(arm_data["alpha"]),
                beta_param=float(arm_data["beta_param"]),
                total_pulls=int(arm_data["total_pulls"]),
                last_reward=(
                    None if arm_data.get("last_reward") is None else float(arm_data["last_reward"])
                ),
            )

        with self._lock:
            for mechanism in self.mechanisms:
                for category in _KNOWN_CATEGORIES:
                    key = (mechanism, category)
                    if key in loaded_arms:
                        self.arms[key] = loaded_arms[key]

    def save_state(self, path: str) -> None:
        """Persist arm state as JSON.

        Args:
            path: File path for persisted state.

        Raises:
            OSError: If writing fails.
        """

        state_path = Path(path)
        state_path.parent.mkdir(parents=True, exist_ok=True)
        with state_path.open("w", encoding="utf-8") as handle:
            json.dump(self.to_state(), handle, indent=2)

    def load_state(self, path: str) -> None:
        """Load arm state from JSON.

        Args:
            path: State file path.

        Raises:
            FileNotFoundError: If state file is missing.
            ValueError: If state payload is invalid.
        """

        state_path = Path(path)
        with state_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)

        if not isinstance(payload, dict) or "arms" not in payload:
            raise ValueError("Invalid bandit state payload")
        self.load_state_payload(payload)

        logger.info("bandit_state_loaded", path=path)
