"""Main orchestration pipeline for mechanism selection and execution."""

from __future__ import annotations

from datetime import UTC, datetime

import structlog

from agora.engines.debate import DebateEngine
from agora.engines.vote import VoteEngine
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.monitor import StateMonitor
from agora.selector.features import extract_features
from agora.selector.selector import AgoraSelector
from agora.types import DeliberationResult, MechanismSelection, MechanismType

logger = structlog.get_logger(__name__)


class AgoraOrchestrator:
    """Top-level orchestrator tying selection, engines, and post-run learning."""

    def __init__(
        self,
        agent_count: int = 3,
        bandit_state_path: str | None = None,
        default_stakes: float = 0.5,
    ) -> None:
        """Initialize orchestrator dependencies.

        Args:
            agent_count: Number of participating agents.
            bandit_state_path: Optional persistence path for selector bandit state.
            default_stakes: Fallback normalized stakes value.
        """

        self.agent_count = max(1, agent_count)
        self.default_stakes = max(0.0, min(1.0, default_stakes))

        self.selector = AgoraSelector(bandit_state_path=bandit_state_path)
        self.hasher = TranscriptHasher()
        self.monitor = StateMonitor()
        self.debate_engine = DebateEngine(
            agent_count=self.agent_count,
            monitor=self.monitor,
            hasher=self.hasher,
        )
        self.vote_engine = VoteEngine(
            agent_count=self.agent_count,
            quorum_threshold=0.6,
            hasher=self.hasher,
        )

    async def run(
        self,
        task: str,
        stakes: float | None = None,
        forced_mechanism: MechanismType | None = None,
    ) -> DeliberationResult:
        """Execute full selection-to-deliberation pipeline.

        Args:
            task: Input task/question.
            stakes: Optional normalized stake override.
            forced_mechanism: Optional explicit execution mechanism for demos/API runs.

        Returns:
            DeliberationResult: Final deliberation artifact.

        Raises:
            RuntimeError: If no mechanism produces a result.
        """

        normalized_stakes = self.default_stakes if stakes is None else max(0.0, min(1.0, stakes))
        selection = (
            await self._build_forced_selection(
                task=task,
                stakes=normalized_stakes,
                forced_mechanism=forced_mechanism,
            )
            if forced_mechanism is not None
            else await self.selector.select(
                task_text=task,
                agent_count=self.agent_count,
                stakes=normalized_stakes,
            )
        )

        logger.info(
            "orchestrator_mechanism_selected",
            mechanism=selection.mechanism.value,
            confidence=selection.confidence,
            reasoning_hash=selection.reasoning_hash,
            bandit_recommendation=selection.bandit_recommendation.value,
            bandit_confidence=selection.bandit_confidence,
            forced_mechanism=forced_mechanism.value if forced_mechanism else None,
        )

        result = await self._execute_mechanism(
            task=task,
            selection=selection,
            forced_mechanism=forced_mechanism,
        )

        receipt = self.hasher.build_receipt(
            hashes=result.transcript_hashes,
            mechanism=result.mechanism_used,
            final_answer=result.final_answer,
            quorum_reached=result.quorum_reached,
            round_count=result.round_count,
            mechanism_switches=result.mechanism_switches,
        )
        logger.info(
            "orchestrator_receipt_built",
            mechanism=result.mechanism_used.value,
            merkle_root=receipt["merkle_root"],
            leaf_count=receipt["leaf_count"],
        )
        return result

    async def _build_forced_selection(
        self,
        task: str,
        stakes: float,
        forced_mechanism: MechanismType,
    ) -> MechanismSelection:
        """Build deterministic selection metadata without calling the LLM selector."""

        reasoning = f"Forced mechanism override for demo/API execution: {forced_mechanism.value}"
        return MechanismSelection(
            mechanism=forced_mechanism,
            confidence=1.0,
            reasoning=reasoning,
            reasoning_hash=self.hasher.hash_content(reasoning),
            bandit_recommendation=forced_mechanism,
            bandit_confidence=1.0,
            task_features=await extract_features(
                task_text=task,
                agent_count=self.agent_count,
                stakes=stakes,
            ),
        )

    async def run_and_learn(
        self,
        task: str,
        ground_truth: str | None = None,
        stakes: float | None = None,
        forced_mechanism: MechanismType | None = None,
    ) -> DeliberationResult:
        """Run task and update selector from reward signal.

        Args:
            task: Input task/question.
            ground_truth: Optional expected answer for supervised reward.
            stakes: Optional normalized stake override.
            forced_mechanism: Optional explicit execution mechanism for demos/API runs.

        Returns:
            DeliberationResult: Execution result.
        """

        if forced_mechanism is None:
            result = await self.run(task=task, stakes=stakes)
        else:
            result = await self.run(
                task=task,
                stakes=stakes,
                forced_mechanism=forced_mechanism,
            )

        if ground_truth is not None:
            reward = (
                1.0 if result.final_answer.strip().lower() == ground_truth.strip().lower() else 0.0
            )
        else:
            reward = result.confidence * (1.0 if result.quorum_reached else 0.5)

        self.selector.update_with_mechanism(
            result.mechanism_selection,
            reward,
            mechanism=result.mechanism_used,
        )
        logger.info(
            "orchestrator_bandit_updated",
            reward=reward,
            mechanism=result.mechanism_used.value,
            originally_selected=result.mechanism_selection.mechanism.value,
        )
        return result

    async def _execute_mechanism(
        self,
        task: str,
        selection: MechanismSelection,
        forced_mechanism: MechanismType | None = None,
    ) -> DeliberationResult:
        """Execute selected mechanism with fallback/switch handling."""

        execution_mechanism = forced_mechanism or selection.mechanism

        if execution_mechanism == MechanismType.DEBATE:
            debate_outcome = await self.debate_engine.run(task=task, selection=selection)
            if forced_mechanism is None and debate_outcome.switch_to_vote:
                vote_outcome = await self.vote_engine.run(task=task, selection=selection)
                switched = vote_outcome.result.model_copy(
                    update={"mechanism_switches": vote_outcome.result.mechanism_switches + 1}
                )
                return switched
            if debate_outcome.result is not None:
                return debate_outcome.result
            raise RuntimeError("Debate engine produced no result")

        if execution_mechanism == MechanismType.VOTE:
            vote_outcome = await self.vote_engine.run(task=task, selection=selection)
            if forced_mechanism is None and vote_outcome.switch_to_debate:
                debate_outcome = await self.debate_engine.run(task=task, selection=selection)
                if debate_outcome.result is not None:
                    switched = debate_outcome.result.model_copy(
                        update={
                            "mechanism_switches": debate_outcome.result.mechanism_switches + 1,
                            "timestamp": datetime.now(UTC),
                        }
                    )
                    return switched
            return vote_outcome.result

        # Week 1 supports debate and vote only. Route extension mechanisms safely.
        fallback_selection = selection.model_copy(update={"mechanism": MechanismType.DEBATE})
        debate_outcome = await self.debate_engine.run(task=task, selection=fallback_selection)
        if debate_outcome.result is not None:
            return debate_outcome.result
        vote_outcome = await self.vote_engine.run(task=task, selection=fallback_selection)
        return vote_outcome.result
