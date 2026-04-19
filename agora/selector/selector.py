"""Combined mechanism selector that glues feature extraction, bandit, and reasoning."""

from __future__ import annotations

from pathlib import Path

import structlog

from agora.agent import AgentCaller
from agora.selector.bandit import ThompsonSamplingSelector
from agora.selector.features import extract_features
from agora.selector.reasoning import ReasoningSelector
from agora.types import MechanismSelection, MechanismType

logger = structlog.get_logger(__name__)


class AgoraSelector:
    """High-level interface for mechanism selection with online learning."""

    def __init__(
        self,
        bandit_state_path: str | None = None,
        reasoning_caller: AgentCaller | None = None,
    ) -> None:
        """Initialize selector dependencies.

        Args:
            bandit_state_path: Optional path to persisted bandit state.
        """

        self.bandit_state_path = bandit_state_path
        self.bandit = ThompsonSamplingSelector(
            mechanisms=[MechanismType.DEBATE, MechanismType.VOTE]
        )
        self.reasoning = ReasoningSelector(caller=reasoning_caller)

        if bandit_state_path is not None:
            state_path = Path(bandit_state_path)
            if state_path.exists():
                self.bandit.load_state(str(state_path))

    async def select(
        self,
        task_text: str,
        agent_count: int = 3,
        stakes: float = 0.5,
    ) -> MechanismSelection:
        """Select the best mechanism for a task.

        Args:
            task_text: Task/question prompt.
            agent_count: Number of participating agents.
            stakes: Normalized stake level.

        Returns:
            MechanismSelection: Explainable selection payload.
        """

        features = await extract_features(
            task_text=task_text, agent_count=agent_count, stakes=stakes
        )
        bandit_rec = self.bandit.select(features)
        selection = await self.reasoning.select(
            task_text=task_text,
            features=features,
            bandit_recommendation=bandit_rec,
            historical_performance=self.bandit.get_stats(),
        )
        return selection

    def update(self, selection: MechanismSelection, reward: float) -> None:
        """Update bandit based on execution outcome.

        Args:
            selection: Mechanism selection metadata from run.
            reward: Reward in [0, 1].
        """

        self.update_with_mechanism(selection, reward, mechanism=selection.mechanism)

    def update_with_mechanism(
        self,
        selection: MechanismSelection,
        reward: float,
        mechanism: MechanismType,
    ) -> None:
        """Update bandit using an explicit mechanism attribution.

        Args:
            selection: Mechanism selection metadata from run.
            reward: Reward in [0, 1].
            mechanism: Mechanism that should receive credit for the outcome.
        """

        category = selection.task_features.topic_category
        self.bandit.update(mechanism, category, reward)
        if self.bandit_state_path is not None:
            self.bandit.save_state(self.bandit_state_path)

        logger.info(
            "agora_selector_updated",
            mechanism=mechanism.value,
            category=category,
            reward=max(0.0, min(1.0, reward)),
        )
