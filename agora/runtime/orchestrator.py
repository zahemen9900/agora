"""Main orchestration pipeline for mechanism selection and execution."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import structlog

from agora.engines.debate import DebateEngine
from agora.engines.vote import VoteEngine
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.monitor import StateMonitor
from agora.selector.features import extract_features
from agora.selector.selector import AgoraSelector
from agora.types import (
    SUPPORTED_MECHANISMS,
    DeliberationResult,
    MechanismSelection,
    MechanismType,
    mechanism_is_supported,
)

logger = structlog.get_logger(__name__)
_SUPPORTED_MECHANISMS_TEXT = ", ".join(
    sorted(mechanism.value for mechanism in SUPPORTED_MECHANISMS)
)

EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]


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
        mechanism_override: str | MechanismType | None = None,
        event_sink: EventSink | None = None,
        agents: Sequence[Callable[..., Any]] | None = None,
    ) -> DeliberationResult:
        """Execute full selection-to-deliberation pipeline.

        Args:
            task: Input task/question.
            stakes: Optional normalized stake override.
            mechanism_override: Optional forced mechanism for experiments or SDK callers.
            event_sink: Optional async callback for runtime event emission.
            agents: Optional local custom agent callables used instead of hosted models.

        Returns:
            DeliberationResult: Final deliberation artifact.

        Raises:
            RuntimeError: If no mechanism produces a result.
        """

        normalized_stakes = self.default_stakes if stakes is None else max(0.0, min(1.0, stakes))
        if agents is not None and len(agents) < self.agent_count:
            raise ValueError("agents must contain at least agent_count callables")

        selection = await self._select_mechanism(
            task=task,
            normalized_stakes=normalized_stakes,
            mechanism_override=mechanism_override,
        )

        logger.info(
            "orchestrator_mechanism_selected",
            mechanism=selection.mechanism.value,
            confidence=selection.confidence,
            reasoning_hash=selection.reasoning_hash,
            bandit_recommendation=selection.bandit_recommendation.value,
            bandit_confidence=selection.bandit_confidence,
            forced_mechanism=(
                mechanism_override.value
                if isinstance(mechanism_override, MechanismType)
                else mechanism_override
            ),
        )

        result = await self.execute_selection(
            task=task,
            selection=selection,
            event_sink=event_sink,
            agents=agents,
            allow_switch=mechanism_override is None,
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

    async def execute_selection(
        self,
        *,
        task: str,
        selection: MechanismSelection,
        event_sink: EventSink | None = None,
        agents: Sequence[Callable[..., Any]] | None = None,
        allow_switch: bool = True,
    ) -> DeliberationResult:
        """Execute a precomputed selector decision.

        This is used by the API task lifecycle so we can honor the selector result
        computed during task creation without re-running selection on task execution.
        """

        return await self._execute_mechanism(
            task=task,
            selection=selection,
            event_sink=event_sink,
            agents=agents,
            allow_switch=allow_switch,
        )

    async def run_and_learn(
        self,
        task: str,
        ground_truth: str | None = None,
        reward: float | None = None,
        stakes: float | None = None,
        mechanism_override: str | MechanismType | None = None,
        event_sink: EventSink | None = None,
        agents: Sequence[Callable[..., Any]] | None = None,
    ) -> DeliberationResult:
        """Run task and update selector from reward signal.

        Args:
            task: Input task/question.
            ground_truth: Optional expected answer for supervised reward.
            reward: Optional explicit reward override in [0, 1].
            stakes: Optional normalized stake override.
            mechanism_override: Optional forced mechanism for evaluation runs.
            event_sink: Optional async callback for runtime event emission.
            agents: Optional local custom agent callables used instead of hosted models.

        Returns:
            DeliberationResult: Execution result.
        """

        run_kwargs: dict[str, Any] = {"task": task, "stakes": stakes}
        if mechanism_override is not None:
            run_kwargs["mechanism_override"] = mechanism_override
        if event_sink is not None:
            run_kwargs["event_sink"] = event_sink
        if agents is not None:
            run_kwargs["agents"] = agents

        result = await self.run(**run_kwargs)

        if reward is not None:
            bounded_reward = max(0.0, min(1.0, reward))
        elif ground_truth is not None:
            bounded_reward = (
                1.0 if result.final_answer.strip().lower() == ground_truth.strip().lower() else 0.0
            )
        else:
            bounded_reward = result.confidence * (1.0 if result.quorum_reached else 0.5)

        self.selector.update_with_mechanism(
            result.mechanism_selection,
            bounded_reward,
            mechanism=result.mechanism_used,
        )
        logger.info(
            "orchestrator_bandit_updated",
            reward=bounded_reward,
            mechanism=result.mechanism_used.value,
            originally_selected=result.mechanism_selection.mechanism.value,
        )
        return result

    async def _select_mechanism(
        self,
        *,
        task: str,
        normalized_stakes: float,
        mechanism_override: str | MechanismType | None,
    ) -> MechanismSelection:
        """Resolve selector-driven or forced mechanism selection."""

        if mechanism_override is None:
            return await self.selector.select(
                task_text=task,
                agent_count=self.agent_count,
                stakes=normalized_stakes,
            )

        override = (
            mechanism_override
            if isinstance(mechanism_override, MechanismType)
            else MechanismType(str(mechanism_override).lower())
        )
        if not mechanism_is_supported(override):
            raise ValueError(
                f"Mechanism override '{override.value}' is not currently supported. "
                f"Supported mechanisms: {_SUPPORTED_MECHANISMS_TEXT}."
            )
        features = await extract_features(
            task_text=task,
            agent_count=self.agent_count,
            stakes=normalized_stakes,
        )
        reasoning = f"Mechanism override applied: forced {override.value} execution."
        return MechanismSelection(
            mechanism=override,
            confidence=1.0,
            reasoning=reasoning,
            reasoning_hash=self.hasher.hash_content(reasoning),
            bandit_recommendation=override,
            bandit_confidence=1.0,
            task_features=features,
        )

    async def _execute_mechanism(
        self,
        task: str,
        selection: MechanismSelection,
        event_sink: EventSink | None = None,
        agents: Sequence[Callable[..., Any]] | None = None,
        allow_switch: bool = True,
    ) -> DeliberationResult:
        """Execute selected mechanism with fallback/switch handling."""

        if selection.mechanism == MechanismType.DEBATE:
            debate_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
            if event_sink is not None:
                debate_run_kwargs["event_sink"] = event_sink
            if agents is not None:
                debate_run_kwargs["custom_agents"] = agents
            debate_run_kwargs["allow_switch"] = allow_switch
            debate_outcome = await self.debate_engine.run(**debate_run_kwargs)
            if allow_switch and debate_outcome.switch_to_vote:
                await self._emit_event(
                    event_sink,
                    "mechanism_switch",
                    {
                        "from_mechanism": MechanismType.DEBATE.value,
                        "to_mechanism": MechanismType.VOTE.value,
                        "reason": debate_outcome.reason,
                        "round_number": debate_outcome.state.round,
                    },
                )
                vote_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
                if event_sink is not None:
                    vote_run_kwargs["event_sink"] = event_sink
                if agents is not None:
                    vote_run_kwargs["custom_agents"] = agents
                vote_outcome = await self.vote_engine.run(**vote_run_kwargs)
                switched = vote_outcome.result.model_copy(
                    update={"mechanism_switches": vote_outcome.result.mechanism_switches + 1}
                )
                return switched
            if debate_outcome.result is not None:
                return debate_outcome.result
            raise RuntimeError("Debate engine produced no result")

        if selection.mechanism == MechanismType.VOTE:
            vote_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
            if event_sink is not None:
                vote_run_kwargs["event_sink"] = event_sink
            if agents is not None:
                vote_run_kwargs["custom_agents"] = agents
            vote_outcome = await self.vote_engine.run(**vote_run_kwargs)
            if allow_switch and vote_outcome.switch_to_debate:
                await self._emit_event(
                    event_sink,
                    "mechanism_switch",
                    {
                        "from_mechanism": MechanismType.VOTE.value,
                        "to_mechanism": MechanismType.DEBATE.value,
                        "reason": vote_outcome.reason,
                        "round_number": 1,
                    },
                )
                debate_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
                if event_sink is not None:
                    debate_run_kwargs["event_sink"] = event_sink
                if agents is not None:
                    debate_run_kwargs["custom_agents"] = agents
                debate_outcome = await self.debate_engine.run(**debate_run_kwargs)
                if debate_outcome.result is not None:
                    switched = debate_outcome.result.model_copy(
                        update={
                            "mechanism_switches": debate_outcome.result.mechanism_switches + 1,
                            "timestamp": datetime.now(UTC),
                        }
                    )
                    return switched
            return vote_outcome.result

        raise ValueError(
            f"Mechanism '{selection.mechanism.value}' is not currently supported. "
            f"Supported mechanisms: {_SUPPORTED_MECHANISMS_TEXT}."
        )

    @staticmethod
    async def _emit_event(
        event_sink: EventSink | None,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        """Emit a runtime event when a sink is configured."""

        if event_sink is not None:
            await event_sink(event_type, data)
