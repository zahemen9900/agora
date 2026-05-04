"""Iterative Delphi engine with anonymized revision rounds."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import structlog
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, field_validator

from agora.agent import (
    AgentCallError,
    AgentCaller,
    claude_caller,
    flash_caller,
    openrouter_caller,
    pro_caller,
)
from agora.config import get_config
from agora.runtime.costing import build_result_costing
from agora.runtime.custom_agents import CustomAgentCallable, invoke_custom_agent
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.local_models import build_local_model_caller
from agora.runtime.model_policy import balanced_participant_tiers, resolve_reasoning_presets
from agora.runtime.monitor import StateMonitor
from agora.runtime.provider_errors import provider_error_details, should_try_alternate_live_model
from agora.runtime.prompt_policy import delphi_independent_prompt, delphi_revision_prompt
from agora.types import (
    AgentOutput,
    DeliberationResult,
    DelphiState,
    FallbackEvent,
    LocalModelSpec,
    LocalProviderKeys,
    MechanismSelection,
    MechanismTraceSegment,
    MechanismType,
    ProviderTierName,
    ReasoningPresetOverrides,
    ReasoningPresets,
)

logger = structlog.get_logger(__name__)
EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]


class _DelphiResponse(BaseModel):
    """Structured response shared by Delphi initial and revision rounds."""

    answer: str = ""
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    reasoning: str = ""

    @field_validator("answer", "reasoning", mode="before")
    @classmethod
    def _coerce_text(cls, value: Any) -> str:
        return "" if value is None else str(value)


class DelphiEngine:
    """Anonymous iterative consensus engine for high-disagreement tasks."""

    def __init__(
        self,
        agent_count: int = 3,
        max_rounds: int = 3,
        quorum_threshold: float = 0.6,
        flash_agent: AgentCaller | None = None,
        hasher: TranscriptHasher | None = None,
        monitor: StateMonitor | None = None,
        allow_offline_fallback: bool = False,
        reasoning_presets: ReasoningPresets
        | ReasoningPresetOverrides
        | dict[str, Any]
        | None = None,
        participant_models: Sequence[LocalModelSpec] | None = None,
        provider_keys: LocalProviderKeys | None = None,
        tier_model_overrides: dict[ProviderTierName, str] | None = None,
    ) -> None:
        self.agent_count = max(1, agent_count)
        self.max_rounds = max(1, max_rounds)
        self.quorum_threshold = max(0.0, min(1.0, quorum_threshold))
        self._flash_agent = flash_agent
        self.hasher = hasher or TranscriptHasher()
        self.monitor = monitor or StateMonitor()
        self.allow_offline_fallback = allow_offline_fallback
        self.reasoning_presets = resolve_reasoning_presets(reasoning_presets)
        self._participant_models = list(participant_models) if participant_models is not None else None
        self._local_provider_keys = provider_keys
        self._tier_model_overrides = dict(tier_model_overrides or {})
        self._participant_tiers = balanced_participant_tiers(self.agent_count)
        self._participant_callers: dict[int, AgentCaller] = {}
        self._pro_agent: AgentCaller | None = None
        self._claude_agent: AgentCaller | None = None
        self._openrouter_agent: AgentCaller | None = None
        self._claude_run_semaphore = asyncio.Semaphore(
            get_config().anthropic_concurrent_requests_per_run
        )
        if self._participant_models is not None and len(self._participant_models) != self.agent_count:
            raise ValueError("participant_models must contain exactly agent_count items")
        self.graph = self._build_graph()

    async def run(
        self,
        task: str,
        selection: MechanismSelection,
        event_sink: EventSink | None = None,
        custom_agents: Sequence[CustomAgentCallable] | None = None,
    ) -> DeliberationResult:
        """Execute iterative Delphi rounds and return the final result."""

        self.monitor.reset()
        initial_state: dict[str, Any] = {
            "selection": selection,
            "event_sink": event_sink,
            "custom_agents": custom_agents,
            "execution": DelphiState(
                task=task,
                task_features=selection.task_features,
                max_rounds=self.max_rounds,
            ),
            "current_outputs": [],
            "continue_revision": True,
            "stop_reason": "",
            "token_counter": 0,
            "input_token_counter": 0,
            "output_token_counter": 0,
            "thinking_token_counter": 0,
            "usage": {},
            "model_token_usage": {},
            "model_input_token_usage": {},
            "model_output_token_usage": {},
            "model_thinking_token_usage": {},
            "model_latency_ms": {},
            "latency_ms": 0.0,
            "fallback_events": [],
            "result": None,
        }
        final_state = await self.graph.ainvoke(initial_state)
        result = final_state.get("result")
        if not isinstance(result, DeliberationResult):
            raise RuntimeError("Delphi engine produced no result")
        return result

    def _build_graph(self) -> Any:
        """Build the iterative Delphi execution graph."""

        graph = StateGraph(dict)
        graph.add_node("independent_generation", self._graph_independent_generation)
        graph.add_node("anonymize_and_distribute", self._graph_anonymize_and_distribute)
        graph.add_node("revision_round", self._graph_revision_round)
        graph.add_node("convergence_check", self._graph_convergence_check)
        graph.add_node("finalize", self._graph_finalize)

        graph.add_edge(START, "independent_generation")
        graph.add_edge("independent_generation", "anonymize_and_distribute")
        graph.add_edge("anonymize_and_distribute", "revision_round")
        graph.add_edge("revision_round", "convergence_check")
        graph.add_conditional_edges(
            "convergence_check",
            self._next_step,
            {
                "anonymize_and_distribute": "anonymize_and_distribute",
                "finalize": "finalize",
            },
        )
        graph.add_edge("finalize", END)
        return graph.compile()

    async def _graph_independent_generation(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Generate the initial independent responses."""

        execution: DelphiState = graph_state["execution"]
        outputs, usage = await self._generate_independent_outputs(
            task=execution.task,
            custom_agents=graph_state.get("custom_agents"),
            event_sink=graph_state.get("event_sink"),
        )
        execution.round = 1
        execution.independent_outputs = outputs
        graph_state["current_outputs"] = outputs
        execution.transcript_hashes.extend(output.content_hash for output in outputs)
        self.monitor.seed_baseline(outputs, locked_claim_count=0)
        execution.convergence_history.append(self.monitor.compute_metrics(outputs, locked_claim_count=0))
        self._accumulate_usage(graph_state, usage)
        await self._emit_event(
            graph_state.get("event_sink"),
            "convergence_update",
            {
                "round_number": execution.round,
                "mechanism": MechanismType.DELPHI.value,
                "metrics": execution.convergence_history[-1].model_dump(mode="json"),
                "stage": "independent_generation",
            },
        )
        return graph_state

    async def _graph_anonymize_and_distribute(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Build anonymous peer feedback payloads for the next round."""

        execution: DelphiState = graph_state["execution"]
        current_outputs: list[AgentOutput] = graph_state["current_outputs"]
        feedback = self._build_anonymized_feedback(current_outputs)
        execution.anonymized_feedback = feedback
        feedback_payload = json.dumps(feedback, sort_keys=True, separators=(",", ":"))
        execution.transcript_hashes.append(self.hasher.hash_content(feedback_payload))
        await self._emit_event(
            graph_state.get("event_sink"),
            "delphi_feedback",
            {
                "round_number": execution.round,
                "mechanism": MechanismType.DELPHI.value,
                "feedback": feedback,
                "stage": "anonymize_and_distribute",
            },
        )
        return graph_state

    async def _graph_revision_round(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Run one anonymous Delphi revision round."""

        execution: DelphiState = graph_state["execution"]
        previous_outputs: list[AgentOutput] = graph_state["current_outputs"]
        outputs, usage = await self._generate_revision_outputs(
            task=execution.task,
            round_number=execution.round + 1,
            prior_outputs=previous_outputs,
            feedback=execution.anonymized_feedback,
            custom_agents=graph_state.get("custom_agents"),
            event_sink=graph_state.get("event_sink"),
        )
        execution.round += 1
        execution.revision_outputs.extend(outputs)
        graph_state["current_outputs"] = outputs
        execution.transcript_hashes.extend(output.content_hash for output in outputs)
        execution.convergence_history.append(self.monitor.compute_metrics(outputs, locked_claim_count=0))
        self._accumulate_usage(graph_state, usage)
        await self._emit_event(
            graph_state.get("event_sink"),
            "convergence_update",
            {
                "round_number": execution.round,
                "mechanism": MechanismType.DELPHI.value,
                "metrics": execution.convergence_history[-1].model_dump(mode="json"),
                "stage": "revision_round",
            },
        )
        return graph_state

    async def _graph_convergence_check(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Decide whether Delphi should continue revising or finalize."""

        execution: DelphiState = graph_state["execution"]
        latest = execution.convergence_history[-1]
        quorum_reached = latest.dominant_answer_share >= self.quorum_threshold
        terminate, reason = self.monitor.should_terminate(
            execution.convergence_history,
            min_rounds=2,
            plateau_threshold=0.04,
            plateau_rounds=2,
        )
        if execution.round >= execution.max_rounds:
            graph_state["continue_revision"] = False
            graph_state["stop_reason"] = "max_rounds_reached"
        elif quorum_reached:
            graph_state["continue_revision"] = False
            graph_state["stop_reason"] = "quorum_reached"
        elif terminate:
            graph_state["continue_revision"] = False
            graph_state["stop_reason"] = reason
        else:
            graph_state["continue_revision"] = True
            graph_state["stop_reason"] = "continue_revision"
        return graph_state

    def _next_step(self, graph_state: dict[str, Any]) -> str:
        """Route the execution graph after one convergence check."""

        return "anonymize_and_distribute" if graph_state.get("continue_revision", False) else "finalize"

    async def _graph_finalize(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Aggregate the latest Delphi round into the unified result format."""

        execution: DelphiState = graph_state["execution"]
        current_outputs: list[AgentOutput] = graph_state["current_outputs"]
        final_answer, confidence, normalized_weights = self._aggregate_outputs(current_outputs)
        execution.final_answer = final_answer
        execution.quorum_reached = confidence >= self.quorum_threshold
        execution.merkle_root = self.hasher.build_merkle_tree(execution.transcript_hashes)

        agent_models_used = list(
            dict.fromkeys(
                [output.agent_model for output in execution.independent_outputs]
                + [output.agent_model for output in execution.revision_outputs]
            )
        )
        model_telemetry, cost = build_result_costing(
            models=agent_models_used,
            model_token_usage=graph_state["model_token_usage"],
            model_latency_ms=graph_state["model_latency_ms"],
            model_input_tokens=graph_state["model_input_token_usage"],
            model_output_tokens=graph_state["model_output_token_usage"],
            model_thinking_tokens=graph_state["model_thinking_token_usage"],
            fallback_total_tokens=int(graph_state["token_counter"]),
        )
        graph_state["result"] = DeliberationResult(
            task=execution.task,
            mechanism_used=MechanismType.DELPHI,
            mechanism_selection=graph_state["selection"],
            final_answer=final_answer,
            confidence=confidence,
            quorum_reached=execution.quorum_reached,
            round_count=execution.round,
            agent_count=self.agent_count,
            mechanism_switches=0,
            merkle_root=execution.merkle_root or "",
            transcript_hashes=list(execution.transcript_hashes),
            agent_models_used=agent_models_used,
            model_token_usage=dict(graph_state["model_token_usage"]),
            model_latency_ms=dict(graph_state["model_latency_ms"]),
            model_input_token_usage=dict(graph_state["model_input_token_usage"]),
            model_output_token_usage=dict(graph_state["model_output_token_usage"]),
            model_thinking_token_usage=dict(graph_state["model_thinking_token_usage"]),
            model_telemetry=model_telemetry,
            convergence_history=list(execution.convergence_history),
            mechanism_trace=[
                MechanismTraceSegment(
                    mechanism=MechanismType.DELPHI,
                    start_round=1,
                    end_round=execution.round,
                    transcript_hashes=list(execution.transcript_hashes),
                    convergence_history=list(execution.convergence_history),
                )
            ],
            reasoning_presets=self.reasoning_presets,
            execution_mode="live",
            selector_source=graph_state["selection"].selector_source,
            fallback_count=len(graph_state["fallback_events"]),
            fallback_events=list(graph_state["fallback_events"]),
            total_tokens_used=int(graph_state["token_counter"]),
            input_tokens_used=self._optional_counter(graph_state["input_token_counter"]),
            output_tokens_used=self._optional_counter(graph_state["output_token_counter"]),
            thinking_tokens_used=self._optional_counter(graph_state["thinking_token_counter"]),
            total_latency_ms=float(graph_state["latency_ms"]),
            cost=cost,
        )
        await self._emit_event(
            graph_state.get("event_sink"),
            "delphi_finalize",
            {
                "round_number": execution.round,
                "mechanism": MechanismType.DELPHI.value,
                "final_answer": final_answer,
                "confidence": confidence,
                "quorum_reached": execution.quorum_reached,
                "stop_reason": graph_state.get("stop_reason", "completed"),
                "weights": normalized_weights,
            },
        )
        return graph_state

    async def _generate_independent_outputs(
        self,
        *,
        task: str,
        custom_agents: Sequence[CustomAgentCallable] | None,
        event_sink: EventSink | None,
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate the first independent Delphi round in parallel."""

        async def one_call(agent_idx: int) -> tuple[AgentOutput, dict[str, Any]]:
            prompt = delphi_independent_prompt(task=task)
            response, usage, agent_model = await self._call_participant(
                agent_idx=agent_idx,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_DelphiResponse,
                fallback=_DelphiResponse(
                    answer="Undetermined from available evidence.",
                    confidence=0.25,
                    reasoning="Offline fallback for unavailable Delphi independent round.",
                ),
                custom_agent=custom_agents[agent_idx] if custom_agents is not None else None,
            )
            output = self._build_output(
                agent_idx=agent_idx,
                round_number=1,
                role="delphi_participant",
                response=response,
                agent_model=agent_model,
                custom_agent=custom_agents[agent_idx] if custom_agents is not None else None,
            )
            await self._emit_event(
                event_sink,
                "agent_output",
                {
                    "agent_id": output.agent_id,
                    "agent_model": output.agent_model,
                    "round_number": output.round_number,
                    "role": output.role,
                    "mechanism": MechanismType.DELPHI.value,
                    "stage": "independent_generation",
                    "content": output.content,
                    "confidence": output.confidence,
                },
            )
            return output, usage

        results = await asyncio.gather(*(one_call(index) for index in range(self.agent_count)))
        outputs = [output for output, _usage in results]
        return outputs, self._merge_usage([usage for _output, usage in results])

    async def _generate_revision_outputs(
        self,
        *,
        task: str,
        round_number: int,
        prior_outputs: Sequence[AgentOutput],
        feedback: dict[str, list[str]],
        custom_agents: Sequence[CustomAgentCallable] | None,
        event_sink: EventSink | None,
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate one anonymized Delphi revision round in parallel."""

        async def one_call(agent_idx: int) -> tuple[AgentOutput, dict[str, Any]]:
            agent_id = f"agent-{agent_idx + 1}"
            prior_output = prior_outputs[agent_idx]
            prompt = delphi_revision_prompt(
                task=task,
                prior_answer=prior_output.content,
                peer_feedback=feedback.get(agent_id, []),
            )
            response, usage, agent_model = await self._call_participant(
                agent_idx=agent_idx,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_DelphiResponse,
                fallback=_DelphiResponse(
                    answer=prior_output.content,
                    confidence=prior_output.confidence,
                    reasoning="Offline fallback preserved the prior Delphi answer.",
                ),
                custom_agent=custom_agents[agent_idx] if custom_agents is not None else None,
            )
            output = self._build_output(
                agent_idx=agent_idx,
                round_number=round_number,
                role="delphi_reviser",
                response=response,
                agent_model=agent_model,
                custom_agent=custom_agents[agent_idx] if custom_agents is not None else None,
            )
            await self._emit_event(
                event_sink,
                "agent_output",
                {
                    "agent_id": output.agent_id,
                    "agent_model": output.agent_model,
                    "round_number": output.round_number,
                    "role": output.role,
                    "mechanism": MechanismType.DELPHI.value,
                    "stage": "revision_round",
                    "content": output.content,
                    "confidence": output.confidence,
                },
            )
            return output, usage

        results = await asyncio.gather(*(one_call(index) for index in range(self.agent_count)))
        outputs = [output for output, _usage in results]
        return outputs, self._merge_usage([usage for _output, usage in results])

    async def _call_participant(
        self,
        *,
        agent_idx: int,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        fallback: BaseModel,
        custom_agent: CustomAgentCallable | None,
    ) -> tuple[_DelphiResponse, dict[str, Any], str]:
        """Call one Delphi participant with provider and fallback handling."""

        if custom_agent is not None:
            response, usage = await invoke_custom_agent(
                custom_agent,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_model=response_model,
                fallback=fallback,
            )
            normalized = self._normalize_usage(
                usage=usage,
                model_name="custom-agent",
                provider="custom-agent",
                component="delphi.custom_agent",
            )
            return _DelphiResponse.model_validate(response), normalized, "custom-agent"

        explicit_model = self._participant_model(agent_idx)
        if explicit_model is not None:
            caller = self._participant_caller(agent_idx, explicit_model)
            try:
                response, usage = await caller.call(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    response_format=response_model,
                )
                if not isinstance(response, response_model):
                    raise AgentCallError("Explicit Delphi local model returned an unexpected payload.")
                normalized = self._normalize_usage(
                    usage=usage,
                    model_name=explicit_model.model,
                    provider=explicit_model.provider,
                    component=f"delphi.{response_model.__name__}",
                )
                return _DelphiResponse.model_validate(response), normalized, explicit_model.model
            except AgentCallError as exc:
                if not self.allow_offline_fallback:
                    raise
                logger.warning(
                    "delphi_explicit_model_fallback",
                    error=str(exc),
                    model=explicit_model.model,
                    provider=explicit_model.provider,
                )
                offline_usage = self._offline_usage(
                    component=f"delphi.{response_model.__name__}",
                    reason=f"provider_{explicit_model.provider}_unavailable_or_invalid",
                    model_name=explicit_model.model,
                    provider=explicit_model.provider,
                )
                return _DelphiResponse.model_validate(fallback), offline_usage, explicit_model.model

        tier = self._tier_for_agent(agent_idx)
        live_fallback_events: list[FallbackEvent] = []
        caller_tiers = [tier]
        if tier != "openrouter":
            caller_tiers.append("openrouter")

        for index, caller_tier in enumerate(caller_tiers):
            caller = self._get_caller(caller_tier)
            try:
                response, usage = await self._call_hosted_participant(
                    caller_tier=caller_tier,
                    caller=caller,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    response_model=response_model,
                )
                normalized = self._normalize_usage(
                    usage=usage,
                    model_name=caller.model,
                    provider=self._provider_for_tier(caller_tier),
                    component=f"delphi.{response_model.__name__}",
                )
                if live_fallback_events:
                    normalized["fallback_events"] = [
                        *live_fallback_events,
                        *list(normalized.get("fallback_events", [])),
                    ]
                if index > 0:
                    logger.info(
                        "delphi_live_fallback_success",
                        from_tier=tier,
                        to_tier=caller_tier,
                        model=caller.model,
                    )
                return _DelphiResponse.model_validate(response), normalized, caller.model
            except AgentCallError as exc:
                if (
                    index + 1 < len(caller_tiers)
                    and should_try_alternate_live_model(exc)
                ):
                    next_tier = caller_tiers[index + 1]
                    next_caller = self._get_caller(next_tier)
                    live_fallback_events.append(
                        FallbackEvent(
                            component=f"delphi.{response_model.__name__}",
                            reason=f"provider_{caller_tier}_unavailable_or_invalid",
                            fallback_type="alternate_live_model",
                            original_model=caller.model,
                            fallback_model=next_caller.model,
                            provider=self._provider_for_tier(next_tier),
                        )
                    )
                    logger.warning(
                        "delphi_live_fallback",
                        error=str(exc),
                        from_tier=caller_tier,
                        to_tier=next_tier,
                        model=caller.model,
                        **provider_error_details(exc),
                    )
                    continue
                if not self.allow_offline_fallback:
                    raise
                logger.warning(
                    "delphi_tier_fallback",
                    error=str(exc),
                    model=caller.model,
                    tier=caller_tier,
                    **provider_error_details(exc),
                )
                offline_usage = self._offline_usage(
                    component=f"delphi.{response_model.__name__}",
                    reason=f"provider_{caller_tier}_unavailable_or_invalid",
                    model_name=caller.model,
                    provider=self._provider_for_tier(caller_tier),
                )
                offline_usage["fallback_events"] = [
                    *live_fallback_events,
                    *list(offline_usage.get("fallback_events", [])),
                ]
                return _DelphiResponse.model_validate(fallback), offline_usage, caller.model

        raise AgentCallError("Delphi participant live fallback chain terminated unexpectedly.")

    def _participant_model(self, agent_idx: int) -> LocalModelSpec | None:
        """Return the explicit local model for one participant when configured."""

        if self._participant_models is None:
            return None
        return self._participant_models[agent_idx]

    def _participant_caller(self, agent_idx: int, model_spec: LocalModelSpec) -> AgentCaller:
        """Build or reuse one explicit local caller."""

        caller = self._participant_callers.get(agent_idx)
        if caller is None:
            caller = build_local_model_caller(spec=model_spec, provider_keys=self._local_provider_keys)
            self._participant_callers[agent_idx] = caller
        return caller

    def _get_flash_caller(self) -> AgentCaller:
        """Return the lazily initialized flash caller used by default Delphi agents."""

        if self._flash_agent is None:
            self._flash_agent = flash_caller(
                thinking_level=self.reasoning_presets.gemini_flash,
                model=self._tier_model_overrides.get("flash"),
                gemini_api_key=(
                    None
                    if self._local_provider_keys is None
                    else self._local_provider_keys.gemini_api_key
                ),
            )
        return self._flash_agent

    def _get_caller(self, tier: str) -> AgentCaller:
        """Return lazily initialized caller for the participant's assigned tier."""

        if tier == "pro":
            if self._pro_agent is None:
                self._pro_agent = pro_caller(
                    thinking_level=self.reasoning_presets.gemini_pro,
                    model=self._tier_model_overrides.get("pro"),
                    gemini_api_key=(
                        None
                        if self._local_provider_keys is None
                        else self._local_provider_keys.gemini_api_key
                    ),
                )
            return self._pro_agent

        if tier == "claude":
            if self._claude_agent is None:
                self._claude_agent = claude_caller(
                    effort=self.reasoning_presets.claude,
                    model=self._tier_model_overrides.get("claude"),
                    anthropic_api_key=(
                        None
                        if self._local_provider_keys is None
                        else self._local_provider_keys.anthropic_api_key
                    ),
                )
            return self._claude_agent

        if tier == "openrouter":
            if self._openrouter_agent is None:
                self._openrouter_agent = openrouter_caller(
                    effort=self.reasoning_presets.openrouter,
                    model=self._tier_model_overrides.get("openrouter"),
                    openrouter_api_key=(
                        None
                        if self._local_provider_keys is None
                        else self._local_provider_keys.openrouter_api_key
                    ),
                )
            return self._openrouter_agent

        return self._get_flash_caller()

    def _tier_for_agent(self, agent_idx: int) -> ProviderTierName:
        """Return the canonical hosted provider tier for one Delphi participant."""

        return self._participant_tiers[agent_idx]

    async def _call_hosted_participant(
        self,
        *,
        caller_tier: str,
        caller: AgentCaller,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Call one hosted Delphi participant, respecting Claude concurrency."""

        if caller_tier == "claude":
            async with self._claude_run_semaphore:
                response, usage = await caller.call(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    response_format=response_model,
                )
        else:
            response, usage = await caller.call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=response_model,
            )
        if not isinstance(response, response_model):
            raise AgentCallError(
                f"{caller_tier} Delphi participant returned an unexpected payload."
            )
        return response, usage

    @staticmethod
    def _provider_for_tier(tier: str) -> str:
        """Resolve provider label for fallback telemetry."""

        return {
            "flash": "gemini",
            "pro": "gemini",
            "claude": "claude",
            "openrouter": "openrouter",
        }.get(tier, "unknown")

    def _build_output(
        self,
        *,
        agent_idx: int,
        round_number: int,
        role: str,
        response: _DelphiResponse,
        agent_model: str,
        custom_agent: CustomAgentCallable | None,
    ) -> AgentOutput:
        """Convert one structured Delphi response into an AgentOutput."""

        if custom_agent is not None:
            agent_model = "custom-agent"
        answer = response.answer.strip()
        return AgentOutput(
            agent_id=f"agent-{agent_idx + 1}",
            agent_model=agent_model,
            role=role,
            round_number=round_number,
            content=answer,
            confidence=response.confidence,
            predicted_group_answer=None,
            content_hash=self.hasher.hash_content(answer),
            timestamp=datetime.now(UTC),
        )

    def _build_anonymized_feedback(self, outputs: Sequence[AgentOutput]) -> dict[str, list[str]]:
        """Return per-agent anonymous peer answer summaries."""

        feedback: dict[str, list[str]] = {}
        for output in outputs:
            peers = [
                peer.content
                for peer in outputs
                if peer.agent_id != output.agent_id and peer.content.strip()
            ]
            feedback[output.agent_id] = peers
        return feedback

    def _aggregate_outputs(
        self,
        outputs: Sequence[AgentOutput],
    ) -> tuple[str, float, dict[str, float]]:
        """Aggregate Delphi answers by normalized answer signal and summed confidence."""

        if not outputs:
            return "", 0.0, {}

        raw_weights: dict[str, float] = {}
        original_answers: dict[str, str] = {}
        for output in outputs:
            signal = self.monitor.extract_answer_signal(output)
            raw_weights[signal] = raw_weights.get(signal, 0.0) + max(0.0, output.confidence)
            original_answers.setdefault(signal, output.content.strip())

        total = sum(raw_weights.values())
        normalized_weights = (
            {signal: weight / total for signal, weight in raw_weights.items()}
            if total > 0.0
            else {signal: 1.0 / len(raw_weights) for signal in raw_weights}
        )
        winner_signal, confidence = max(normalized_weights.items(), key=lambda item: item[1])
        return original_answers[winner_signal], confidence, normalized_weights

    def _merge_usage(self, usages: Sequence[dict[str, Any]]) -> dict[str, Any]:
        """Merge per-call usage maps into one stage aggregate."""

        merged: dict[str, Any] = {
            "tokens": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "thinking_tokens": 0,
            "latency_ms": 0.0,
            "model_tokens": {},
            "model_input_tokens": {},
            "model_output_tokens": {},
            "model_thinking_tokens": {},
            "model_latency_ms": {},
            "fallback_events": [],
        }
        for usage in usages:
            merged["tokens"] += int(usage.get("tokens", 0))
            merged["input_tokens"] += int(usage.get("input_tokens") or 0)
            merged["output_tokens"] += int(usage.get("output_tokens") or 0)
            merged["thinking_tokens"] += int(usage.get("thinking_tokens") or 0)
            merged["latency_ms"] += float(usage.get("latency_ms", 0.0))
            self._merge_numeric_map(merged["model_tokens"], usage.get("model_tokens", {}))
            self._merge_numeric_map(
                merged["model_input_tokens"],
                usage.get("model_input_tokens", {}),
            )
            self._merge_numeric_map(
                merged["model_output_tokens"],
                usage.get("model_output_tokens", {}),
            )
            self._merge_numeric_map(
                merged["model_thinking_tokens"],
                usage.get("model_thinking_tokens", {}),
            )
            self._merge_numeric_map(
                merged["model_latency_ms"],
                usage.get("model_latency_ms", {}),
            )
            merged["fallback_events"].extend(usage.get("fallback_events", []))
        return merged

    def _accumulate_usage(self, graph_state: dict[str, Any], usage: dict[str, Any]) -> None:
        """Accumulate one stage usage into the graph totals."""

        graph_state["token_counter"] = int(graph_state["token_counter"]) + int(usage.get("tokens", 0))
        graph_state["input_token_counter"] = int(graph_state["input_token_counter"]) + int(
            usage.get("input_tokens") or 0
        )
        graph_state["output_token_counter"] = int(graph_state["output_token_counter"]) + int(
            usage.get("output_tokens") or 0
        )
        graph_state["thinking_token_counter"] = int(graph_state["thinking_token_counter"]) + int(
            usage.get("thinking_tokens") or 0
        )
        graph_state["latency_ms"] = float(graph_state["latency_ms"]) + float(
            usage.get("latency_ms", 0.0)
        )
        self._merge_numeric_map(graph_state["model_token_usage"], usage.get("model_tokens", {}))
        self._merge_numeric_map(
            graph_state["model_input_token_usage"],
            usage.get("model_input_tokens", {}),
        )
        self._merge_numeric_map(
            graph_state["model_output_token_usage"],
            usage.get("model_output_tokens", {}),
        )
        self._merge_numeric_map(
            graph_state["model_thinking_token_usage"],
            usage.get("model_thinking_tokens", {}),
        )
        self._merge_numeric_map(
            graph_state["model_latency_ms"],
            usage.get("model_latency_ms", {}),
        )
        graph_state["fallback_events"].extend(usage.get("fallback_events", []))

    def _normalize_usage(
        self,
        *,
        usage: dict[str, Any],
        model_name: str,
        provider: str,
        component: str,
    ) -> dict[str, Any]:
        """Normalize provider usage into the engine's telemetry format."""

        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        thinking_tokens = usage.get("thinking_tokens", usage.get("reasoning_tokens"))
        total_tokens = int(
            usage.get("tokens")
            or usage.get("total_tokens")
            or (int(input_tokens or 0) + int(output_tokens or 0) + int(thinking_tokens or 0))
        )
        normalized: dict[str, Any] = {
            "tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "thinking_tokens": thinking_tokens,
            "latency_ms": float(usage.get("latency_ms", 0.0)),
            "model_tokens": {model_name: total_tokens},
            "model_input_tokens": {model_name: int(input_tokens)} if input_tokens is not None else {},
            "model_output_tokens": (
                {model_name: int(output_tokens)} if output_tokens is not None else {}
            ),
            "model_thinking_tokens": (
                {model_name: int(thinking_tokens)} if thinking_tokens is not None else {}
            ),
            "model_latency_ms": {model_name: float(usage.get("latency_ms", 0.0))},
            "provider": provider,
            "fallback_events": [],
        }
        if usage.get("fallback_used"):
            normalized["fallback_events"] = [
                FallbackEvent(
                    component=component,
                    reason=str(usage.get("fallback_reason") or "custom_agent_invalid_response"),
                )
            ]
        return normalized

    def _offline_usage(
        self,
        *,
        component: str,
        reason: str,
        model_name: str,
        provider: str,
    ) -> dict[str, Any]:
        """Return deterministic usage payload for offline fallback."""

        return {
            "tokens": 0,
            "input_tokens": None,
            "output_tokens": None,
            "thinking_tokens": None,
            "latency_ms": 0.0,
            "model_tokens": {model_name: 0},
            "model_input_tokens": {},
            "model_output_tokens": {},
            "model_thinking_tokens": {},
            "model_latency_ms": {model_name: 0.0},
            "provider": provider,
            "fallback_events": [
                FallbackEvent(
                    component=component,
                    reason=reason,
                )
            ],
        }

    @staticmethod
    def _merge_numeric_map(target: dict[str, Any], source: dict[str, Any]) -> None:
        """Add one numeric map into another in place."""

        for key, value in source.items():
            if value is None:
                continue
            target[key] = target.get(key, 0) + value

    @staticmethod
    async def _emit_event(
        event_sink: EventSink | None,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        """Emit one structured runtime event when a sink is configured."""

        if event_sink is None:
            return
        await event_sink(event_type, payload)

    @staticmethod
    def _optional_counter(value: int) -> int | None:
        """Return ``None`` for absent optional token counters."""

        return value if value > 0 else None
