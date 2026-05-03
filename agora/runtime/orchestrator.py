"""Main orchestration pipeline for mechanism selection and execution."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import structlog

from agora.agent import pro_caller
from agora.engines.debate import DebateEngine
from agora.engines.delphi import DelphiEngine
from agora.engines.vote import VoteEngine
from agora.runtime.costing import build_result_costing
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.local_models import validate_local_model_config
from agora.runtime.model_policy import resolve_reasoning_presets
from agora.runtime.monitor import StateMonitor
from agora.selector.features import extract_features
from agora.selector.selector import AgoraSelector
from agora.types import (
    SUPPORTED_MECHANISMS,
    DeliberationResult,
    LocalDebateConfig,
    LocalModelSpec,
    LocalProviderKeys,
    MechanismSelection,
    MechanismTraceSegment,
    MechanismType,
    ProviderTierName,
    ReasoningPresetOverrides,
    ReasoningPresets,
    mechanism_is_supported,
)

logger = structlog.get_logger(__name__)
_SUPPORTED_MECHANISMS_TEXT = ", ".join(
    sorted(mechanism.value for mechanism in SUPPORTED_MECHANISMS)
)

EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]


class _LazyReasoningCaller:
    """Delay selector caller initialization until reasoning is actually invoked."""

    def __init__(
        self,
        *,
        thinking_level: str,
        model: str | None,
        gemini_api_key: str | None,
    ) -> None:
        self._thinking_level = thinking_level
        self._model = model
        self._gemini_api_key = gemini_api_key
        self._caller = None

    async def call(self, *args: Any, **kwargs: Any) -> tuple[Any, dict[str, Any]]:
        if self._caller is None:
            self._caller = pro_caller(
                thinking_level=self._thinking_level,
                model=self._model,
                gemini_api_key=self._gemini_api_key,
            )
        return await self._caller.call(*args, **kwargs)


class AgoraOrchestrator:
    """Top-level orchestrator tying selection, engines, and post-run learning."""

    def __init__(
        self,
        agent_count: int = 3,
        bandit_state_path: str | None = None,
        default_stakes: float = 0.5,
        allow_offline_fallback: bool = True,
        reasoning_presets: ReasoningPresets
        | ReasoningPresetOverrides
        | dict[str, Any]
        | None = None,
        local_models: list[LocalModelSpec] | None = None,
        local_provider_keys: LocalProviderKeys | None = None,
        local_debate_config: LocalDebateConfig | None = None,
        tier_model_overrides: dict[ProviderTierName, str] | None = None,
    ) -> None:
        """Initialize orchestrator dependencies.

        Args:
            agent_count: Number of participating agents.
            bandit_state_path: Optional persistence path for selector bandit state.
            default_stakes: Fallback normalized stakes value.
        """

        self.agent_count = max(1, agent_count)
        self.default_stakes = max(0.0, min(1.0, default_stakes))
        self.allow_offline_fallback = allow_offline_fallback
        self.reasoning_presets = resolve_reasoning_presets(reasoning_presets)
        self.local_models = list(local_models) if local_models is not None else None
        self.local_provider_keys = local_provider_keys
        self.local_debate_config = local_debate_config
        self.tier_model_overrides = dict(tier_model_overrides or {})
        validate_local_model_config(
            local_models=self.local_models,
            provider_keys=self.local_provider_keys,
            debate_config=self.local_debate_config,
        )

        self.selector = AgoraSelector(
            bandit_state_path=bandit_state_path,
            reasoning_caller=_LazyReasoningCaller(
                thinking_level=self.reasoning_presets.gemini_pro,
                model=self.tier_model_overrides.get("pro"),
                gemini_api_key=(
                    None
                    if self.local_provider_keys is None
                    else self.local_provider_keys.gemini_api_key
                ),
            ),
        )
        self.hasher = TranscriptHasher()
        self.monitor = StateMonitor()
        self.debate_engine = self.build_debate_engine()
        self.delphi_engine = self.build_delphi_engine(quorum_threshold=0.6)
        self.vote_engine = self.build_vote_engine(quorum_threshold=0.6)

    def build_debate_engine(self, **overrides: Any) -> DebateEngine:
        """Build a debate engine that inherits the orchestrator's runtime policy."""

        engine_kwargs = {
            "allow_offline_fallback": self.allow_offline_fallback,
            **overrides,
        }
        return DebateEngine(
            agent_count=self.agent_count,
            monitor=self.monitor,
            hasher=self.hasher,
            reasoning_presets=self.reasoning_presets,
            participant_models=self.local_models,
            provider_keys=self.local_provider_keys,
            tier_model_overrides=self.tier_model_overrides,
            devils_advocate_model=(
                None
                if self.local_debate_config is None
                else self.local_debate_config.devils_advocate_model
            ),
            devils_advocate_fallback_models=(
                None
                if self.local_debate_config is None
                else self.local_debate_config.devils_advocate_fallback_models
            ),
            **engine_kwargs,
        )

    def build_vote_engine(self, **overrides: Any) -> VoteEngine:
        """Build a vote engine that inherits the orchestrator's runtime policy."""

        engine_kwargs = {
            "allow_offline_fallback": self.allow_offline_fallback,
            **overrides,
        }
        return VoteEngine(
            agent_count=self.agent_count,
            hasher=self.hasher,
            reasoning_presets=self.reasoning_presets,
            participant_models=self.local_models,
            provider_keys=self.local_provider_keys,
            tier_model_overrides=self.tier_model_overrides,
            **engine_kwargs,
        )

    def build_delphi_engine(self, **overrides: Any) -> DelphiEngine:
        """Build a Delphi engine that inherits the orchestrator's runtime policy."""

        engine_kwargs = {
            "allow_offline_fallback": self.allow_offline_fallback,
            **overrides,
        }
        return DelphiEngine(
            agent_count=self.agent_count,
            hasher=self.hasher,
            monitor=self.monitor,
            reasoning_presets=self.reasoning_presets,
            participant_models=self.local_models,
            provider_keys=self.local_provider_keys,
            tier_model_overrides=self.tier_model_overrides,
            **engine_kwargs,
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
            selector_source="forced_override",
            selector_fallback_path=["forced_override"],
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
                debate_run_kwargs["event_sink"] = self._segment_event_sink(
                    event_sink,
                    execution_segment=0,
                    mechanism=MechanismType.DEBATE,
                )
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
                        "execution_segment": 0,
                        "mechanism": MechanismType.DEBATE.value,
                        "segment_mechanism": MechanismType.DEBATE.value,
                        "segment_round": debate_outcome.state.round,
                        "next_execution_segment": 1,
                        "next_segment_mechanism": MechanismType.VOTE.value,
                    },
                )
                vote_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
                if event_sink is not None:
                    vote_run_kwargs["event_sink"] = self._segment_event_sink(
                        event_sink,
                        execution_segment=1,
                        mechanism=MechanismType.VOTE,
                    )
                if agents is not None:
                    vote_run_kwargs["custom_agents"] = agents
                vote_outcome = await self.vote_engine.run(**vote_run_kwargs)
                return self._combine_switched_result(
                    first_state_hashes=debate_outcome.state.transcript_hashes,
                    first_convergence_history=debate_outcome.state.convergence_history,
                    first_mechanism=MechanismType.DEBATE,
                    first_start_round=1,
                    first_end_round=max(1, debate_outcome.state.round),
                    first_agent_models_used=debate_outcome.agent_models_used,
                    first_model_token_usage=debate_outcome.model_token_usage,
                    first_model_latency_ms=debate_outcome.model_latency_ms,
                    first_model_input_token_usage=debate_outcome.model_input_token_usage,
                    first_model_output_token_usage=debate_outcome.model_output_token_usage,
                    first_model_thinking_token_usage=debate_outcome.model_thinking_token_usage,
                    first_fallback_events=debate_outcome.fallback_events,
                    first_total_tokens_used=debate_outcome.total_tokens_used,
                    first_input_tokens_used=debate_outcome.input_tokens_used,
                    first_output_tokens_used=debate_outcome.output_tokens_used,
                    first_thinking_tokens_used=debate_outcome.thinking_tokens_used,
                    first_total_latency_ms=debate_outcome.total_latency_ms,
                    second_result=vote_outcome.result,
                    switch_reason=debate_outcome.reason,
                    switch_round=debate_outcome.state.round,
                )
            if debate_outcome.result is not None:
                return debate_outcome.result
            raise RuntimeError("Debate engine produced no result")

        if selection.mechanism == MechanismType.VOTE:
            vote_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
            if event_sink is not None:
                vote_run_kwargs["event_sink"] = self._segment_event_sink(
                    event_sink,
                    execution_segment=0,
                    mechanism=MechanismType.VOTE,
                )
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
                        "execution_segment": 0,
                        "mechanism": MechanismType.VOTE.value,
                        "segment_mechanism": MechanismType.VOTE.value,
                        "segment_round": 1,
                        "next_execution_segment": 1,
                        "next_segment_mechanism": MechanismType.DEBATE.value,
                    },
                )
                debate_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
                if event_sink is not None:
                    debate_run_kwargs["event_sink"] = self._segment_event_sink(
                        event_sink,
                        execution_segment=1,
                        mechanism=MechanismType.DEBATE,
                    )
                if agents is not None:
                    debate_run_kwargs["custom_agents"] = agents
                debate_outcome = await self.debate_engine.run(**debate_run_kwargs)
                if debate_outcome.result is not None:
                    return self._combine_switched_result(
                        first_state_hashes=vote_outcome.state.transcript_hashes,
                        first_convergence_history=[],
                        first_mechanism=MechanismType.VOTE,
                        first_start_round=1,
                        first_end_round=1,
                        first_agent_models_used=vote_outcome.agent_models_used,
                        first_model_token_usage=vote_outcome.model_token_usage,
                        first_model_latency_ms=vote_outcome.model_latency_ms,
                        first_model_input_token_usage=vote_outcome.model_input_token_usage,
                        first_model_output_token_usage=vote_outcome.model_output_token_usage,
                        first_model_thinking_token_usage=vote_outcome.model_thinking_token_usage,
                        first_fallback_events=vote_outcome.fallback_events,
                        first_total_tokens_used=vote_outcome.total_tokens_used,
                        first_input_tokens_used=vote_outcome.input_tokens_used,
                        first_output_tokens_used=vote_outcome.output_tokens_used,
                        first_thinking_tokens_used=vote_outcome.thinking_tokens_used,
                        first_total_latency_ms=vote_outcome.total_latency_ms,
                        second_result=debate_outcome.result,
                        switch_reason=vote_outcome.reason,
                        switch_round=1,
                    )
            return vote_outcome.result

        if selection.mechanism == MechanismType.DELPHI:
            delphi_run_kwargs: dict[str, Any] = {"task": task, "selection": selection}
            if event_sink is not None:
                delphi_run_kwargs["event_sink"] = self._segment_event_sink(
                    event_sink,
                    execution_segment=0,
                    mechanism=MechanismType.DELPHI,
                )
            if agents is not None:
                delphi_run_kwargs["custom_agents"] = agents
            return await self.delphi_engine.run(**delphi_run_kwargs)

        raise ValueError(
            f"Mechanism '{selection.mechanism.value}' is not currently supported. "
            f"Supported mechanisms: {_SUPPORTED_MECHANISMS_TEXT}."
        )

    @staticmethod
    def _segment_event_sink(
        event_sink: EventSink,
        *,
        execution_segment: int,
        mechanism: MechanismType,
    ) -> EventSink:
        """Add execution-segment metadata to engine-emitted runtime events."""

        async def emit_segment_event(event_type: str, data: dict[str, Any]) -> None:
            payload = dict(data)
            payload.setdefault("execution_segment", execution_segment)
            payload.setdefault("mechanism", mechanism.value)
            payload.setdefault("segment_mechanism", mechanism.value)
            if "segment_round" not in payload and "round_number" in payload:
                payload["segment_round"] = payload["round_number"]
            await event_sink(event_type, payload)

        return emit_segment_event

    def _combine_switched_result(
        self,
        *,
        first_state_hashes: list[str],
        first_convergence_history: list[Any],
        first_mechanism: MechanismType,
        first_start_round: int,
        first_end_round: int,
        first_agent_models_used: list[str],
        first_model_token_usage: dict[str, int],
        first_model_latency_ms: dict[str, float],
        first_model_input_token_usage: dict[str, int],
        first_model_output_token_usage: dict[str, int],
        first_model_thinking_token_usage: dict[str, int],
        first_fallback_events: list[Any],
        first_total_tokens_used: int,
        first_input_tokens_used: int | None,
        first_output_tokens_used: int | None,
        first_thinking_tokens_used: int | None,
        first_total_latency_ms: float,
        second_result: DeliberationResult,
        switch_reason: str,
        switch_round: int,
    ) -> DeliberationResult:
        """Combine pre-switch, switch event, and post-switch artifacts into one receipt."""

        switch_payload = {
            "event": "mechanism_switch",
            "from_mechanism": first_mechanism.value,
            "to_mechanism": second_result.mechanism_used.value,
            "reason": switch_reason,
            "round_number": switch_round,
        }
        switch_serialized = json.dumps(
            switch_payload,
            sort_keys=True,
            separators=(",", ":"),
        )
        switch_reason_hash = self.hasher.hash_content(switch_reason)
        switch_event_hash = self.hasher.hash_content(switch_serialized)
        second_hashes = second_result.transcript_hashes
        combined_hashes = [*first_state_hashes, switch_event_hash, *second_hashes]

        first_trace = MechanismTraceSegment(
            mechanism=first_mechanism,
            start_round=first_start_round,
            end_round=first_end_round,
            transcript_hashes=first_state_hashes,
            convergence_history=first_convergence_history,
            switch_reason=switch_reason,
            switch_reason_hash=switch_reason_hash,
        )
        combined_trace = [first_trace, *second_result.mechanism_trace]
        combined_fallback_events = [
            *first_fallback_events,
            *second_result.fallback_events,
        ]
        combined_convergence = [
            *first_convergence_history,
            *second_result.convergence_history,
        ]
        combined_model_tokens = self._merge_numeric_maps(
            first_model_token_usage,
            second_result.model_token_usage,
        )
        combined_model_latency = self._merge_float_maps(
            first_model_latency_ms,
            second_result.model_latency_ms,
        )
        combined_model_input_tokens = self._merge_numeric_maps(
            first_model_input_token_usage,
            second_result.model_input_token_usage,
        )
        combined_model_output_tokens = self._merge_numeric_maps(
            first_model_output_token_usage,
            second_result.model_output_token_usage,
        )
        combined_model_thinking_tokens = self._merge_numeric_maps(
            first_model_thinking_token_usage,
            second_result.model_thinking_token_usage,
        )
        combined_agent_models = list(
            dict.fromkeys([*first_agent_models_used, *second_result.agent_models_used])
        )
        total_tokens = first_total_tokens_used + second_result.total_tokens_used
        total_latency_ms = first_total_latency_ms + second_result.total_latency_ms
        input_tokens_used = self._merge_optional_totals(
            first_input_tokens_used,
            second_result.input_tokens_used,
        )
        output_tokens_used = self._merge_optional_totals(
            first_output_tokens_used,
            second_result.output_tokens_used,
        )
        thinking_tokens_used = self._merge_optional_totals(
            first_thinking_tokens_used,
            second_result.thinking_tokens_used,
        )
        model_telemetry, cost = build_result_costing(
            models=combined_agent_models,
            model_token_usage=combined_model_tokens,
            model_latency_ms=combined_model_latency,
            model_input_tokens=combined_model_input_tokens,
            model_output_tokens=combined_model_output_tokens,
            model_thinking_tokens=combined_model_thinking_tokens,
            fallback_total_tokens=total_tokens,
        )

        return second_result.model_copy(
            update={
                "mechanism_switches": second_result.mechanism_switches + 1,
                "merkle_root": self.hasher.build_merkle_tree(combined_hashes),
                "transcript_hashes": combined_hashes,
                "mechanism_trace": combined_trace,
                "convergence_history": combined_convergence,
                "fallback_events": combined_fallback_events,
                "fallback_count": len(combined_fallback_events),
                "execution_mode": (
                    "live"
                    if not combined_fallback_events
                    else "fallback" if total_tokens == 0 else "mixed"
                ),
                "agent_models_used": combined_agent_models,
                "model_token_usage": combined_model_tokens,
                "model_latency_ms": combined_model_latency,
                "model_input_token_usage": combined_model_input_tokens,
                "model_output_token_usage": combined_model_output_tokens,
                "model_thinking_token_usage": combined_model_thinking_tokens,
                "model_telemetry": model_telemetry,
                "total_tokens_used": total_tokens,
                "input_tokens_used": input_tokens_used,
                "output_tokens_used": output_tokens_used,
                "thinking_tokens_used": thinking_tokens_used,
                "total_latency_ms": total_latency_ms,
                "cost": cost,
                "timestamp": datetime.now(UTC),
            }
        )

    @staticmethod
    def _merge_numeric_maps(left: dict[str, int], right: dict[str, int]) -> dict[str, int]:
        """Merge token usage maps."""

        merged = dict(left)
        for key, value in right.items():
            merged[key] = merged.get(key, 0) + value
        return merged

    @staticmethod
    def _merge_float_maps(left: dict[str, float], right: dict[str, float]) -> dict[str, float]:
        """Merge latency usage maps."""

        merged = dict(left)
        for key, value in right.items():
            merged[key] = merged.get(key, 0.0) + value
        return merged

    @staticmethod
    def _merge_optional_totals(left: int | None, right: int | None) -> int | None:
        """Merge nullable aggregate token counters."""

        if left is None and right is None:
            return None
        return max(0, int(left or 0) + int(right or 0))

    @staticmethod
    async def _emit_event(
        event_sink: EventSink | None,
        event_type: str,
        data: dict[str, Any],
    ) -> None:
        """Emit a runtime event when a sink is configured."""

        if event_sink is not None:
            await event_sink(event_type, data)
