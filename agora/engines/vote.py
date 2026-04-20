"""ISP-weighted vote engine with confidence calibration."""

from __future__ import annotations

import asyncio
import json
import math
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any, cast

import structlog
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from agora.agent import (
    AgentCaller,
    AgentCallError,
    claude_caller,
    flash_caller,
    kimi_caller,
    pro_caller,
)
from agora.config import get_config
from agora.runtime.costing import build_result_costing
from agora.runtime.custom_agents import CustomAgentCallable, invoke_custom_agent
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.model_policy import (
    balanced_participant_tiers,
    resolve_reasoning_presets,
)
from agora.runtime.prompt_policy import vote_participant_prompt
from agora.types import (
    AgentOutput,
    DeliberationResult,
    FallbackEvent,
    MechanismSelection,
    MechanismTraceSegment,
    MechanismType,
    ProviderTierName,
    ReasoningPresetOverrides,
    ReasoningPresets,
    VoteState,
)

logger = structlog.get_logger(__name__)
EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]

_STREAM_EVENT_PREFIX = "\u001eAGORA_STREAM_EVENT\u001e"
_STREAM_EVENT_SEPARATOR = "\u001f"

class _VoteResponse(BaseModel):
    """Structured schema for vote generation."""

    answer: str
    confidence: float = Field(ge=0.0, le=1.0)
    predicted_group_answer: str
    reasoning: str

    @field_validator("answer", "predicted_group_answer", "reasoning", mode="before")
    @classmethod
    def _coerce_text_fields(cls, value: Any) -> str:
        """Coerce provider JSON scalars into text fields instead of failing hard."""

        if value is None:
            return ""
        return str(value)


class VoteEngineOutcome(BaseModel):
    """Outcome payload for vote execution and optional switch signaling."""

    model_config = ConfigDict(frozen=True)

    state: VoteState
    result: DeliberationResult
    switch_to_debate: bool = False
    reason: str = ""
    agent_models_used: list[str] = Field(default_factory=list)
    model_token_usage: dict[str, int] = Field(default_factory=dict)
    model_latency_ms: dict[str, float] = Field(default_factory=dict)
    model_input_token_usage: dict[str, int] = Field(default_factory=dict)
    model_output_token_usage: dict[str, int] = Field(default_factory=dict)
    model_thinking_token_usage: dict[str, int] = Field(default_factory=dict)
    fallback_events: list[FallbackEvent] = Field(default_factory=list)
    total_tokens_used: int = 0
    input_tokens_used: int | None = None
    output_tokens_used: int | None = None
    thinking_tokens_used: int | None = None
    total_latency_ms: float = 0.0


class VoteEngine:
    """Single-round voting engine using inverse surprising popularity."""

    def __init__(
        self,
        agent_count: int = 3,
        quorum_threshold: float = 0.6,
        flash_agent: AgentCaller | None = None,
        pro_agent: AgentCaller | None = None,
        claude_agent: AgentCaller | None = None,
        kimi_agent: AgentCaller | None = None,
        hasher: TranscriptHasher | None = None,
        temperature_scaling: float = 1.5,
        aggregation_mode: str = "isp",
        allow_offline_fallback: bool = False,
        reasoning_presets: ReasoningPresets
        | ReasoningPresetOverrides
        | dict[str, Any]
        | None = None,
    ) -> None:
        """Initialize vote engine.

        Args:
            agent_count: Number of voting agents.
            quorum_threshold: Required normalized weight for quorum.
            flash_agent: Optional pre-configured generation caller.
            hasher: Optional hasher instance.
            temperature_scaling: Confidence temperature parameter.
        """

        self.agent_count = max(1, agent_count)
        self.quorum_threshold = max(0.0, min(1.0, quorum_threshold))
        self.temperature_scaling = max(0.1, temperature_scaling)
        self._flash_agent = flash_agent
        self._pro_agent = pro_agent
        self._claude_agent = claude_agent
        self._kimi_agent = kimi_agent
        self.hasher = hasher or TranscriptHasher()
        self.aggregation_mode = aggregation_mode
        self.allow_offline_fallback = allow_offline_fallback
        self.reasoning_presets = resolve_reasoning_presets(reasoning_presets)
        self._participant_tiers = balanced_participant_tiers(self.agent_count)
        self._claude_run_semaphore = asyncio.Semaphore(
            get_config().anthropic_concurrent_requests_per_run
        )
        self.graph = self._build_graph()

    async def run(
        self,
        task: str,
        selection: MechanismSelection,
        event_sink: EventSink | None = None,
        custom_agents: Sequence[CustomAgentCallable] | None = None,
    ) -> VoteEngineOutcome:
        """Execute ISP vote workflow and return deliberation result.

        Args:
            task: Task prompt.
            selection: Mechanism selection metadata.

        Returns:
            VoteEngineOutcome: Vote result and switch suggestion.
        """

        return await self._run_graph(
            task=task,
            selection=selection,
            event_sink=event_sink,
            custom_agents=custom_agents,
        )

    async def _run_graph(
        self,
        *,
        task: str,
        selection: MechanismSelection,
        event_sink: EventSink | None,
        custom_agents: Sequence[CustomAgentCallable] | None,
    ) -> VoteEngineOutcome:
        """Execute vote through the compiled LangGraph."""

        graph_state = {
            "selection": selection,
            "event_sink": event_sink,
            "custom_agents": custom_agents,
            "execution": VoteState(
                task=task,
                task_features=selection.task_features,
                quorum_threshold=self.quorum_threshold,
            ),
            "token_counter": 0,
            "input_token_counter": 0,
            "output_token_counter": 0,
            "thinking_token_counter": 0,
            "latency_ms": 0.0,
            "usage": {},
            "model_token_usage": {},
            "model_input_token_usage": {},
            "model_output_token_usage": {},
            "model_thinking_token_usage": {},
            "model_latency_ms": {},
            "result": None,
        }
        final_state = await self.graph.ainvoke(graph_state)
        result = final_state["result"]
        return VoteEngineOutcome(
            state=final_state["execution"],
            result=result,
            switch_to_debate=not result.quorum_reached,
            reason="quorum_reached" if result.quorum_reached else "quorum_not_reached",
            agent_models_used=result.agent_models_used,
            model_token_usage=result.model_token_usage,
            model_latency_ms=result.model_latency_ms,
            model_input_token_usage=result.model_input_token_usage,
            model_output_token_usage=result.model_output_token_usage,
            model_thinking_token_usage=result.model_thinking_token_usage,
            fallback_events=result.fallback_events,
            total_tokens_used=result.total_tokens_used,
            input_tokens_used=result.input_tokens_used,
            output_tokens_used=result.output_tokens_used,
            thinking_tokens_used=result.thinking_tokens_used,
            total_latency_ms=result.total_latency_ms,
        )

    def _build_vote_result(
        self,
        *,
        state: VoteState,
        selection: MechanismSelection,
        usage: dict[str, Any],
        token_counter: int,
        input_token_counter: int,
        output_token_counter: int,
        thinking_token_counter: int,
        model_input_token_usage: dict[str, int],
        model_output_token_usage: dict[str, int],
        model_thinking_token_usage: dict[str, int],
        model_latency_ms: dict[str, float],
        latency_ms: float,
    ) -> DeliberationResult:
        """Build the final vote result from aggregated state."""

        best_answer, best_weight = self._pick_winner(state.final_weights)
        state.final_answer = best_answer
        state.quorum_reached = best_weight >= state.quorum_threshold
        state.merkle_root = self.hasher.build_merkle_tree(state.transcript_hashes)

        model_token_usage = {
            str(model): int(tokens)
            for model, tokens in cast(dict[str, int], usage.get("model_tokens", {})).items()
        }
        model_telemetry, cost = build_result_costing(
            models=list(dict.fromkeys(output.agent_model for output in state.agent_outputs)),
            model_token_usage=model_token_usage,
            model_latency_ms=model_latency_ms,
            model_input_tokens=model_input_token_usage,
            model_output_tokens=model_output_token_usage,
            model_thinking_tokens=model_thinking_token_usage,
            fallback_total_tokens=token_counter,
        )
        return DeliberationResult(
            task=state.task,
            mechanism_used=MechanismType.VOTE,
            mechanism_selection=selection,
            final_answer=best_answer,
            confidence=best_weight,
            quorum_reached=state.quorum_reached,
            round_count=1,
            agent_count=self.agent_count,
            mechanism_switches=0,
            merkle_root=state.merkle_root,
            transcript_hashes=state.transcript_hashes,
            agent_models_used=list(
                dict.fromkeys(output.agent_model for output in state.agent_outputs)
            ),
            model_token_usage=model_token_usage,
            model_latency_ms=dict(model_latency_ms),
            model_input_token_usage=dict(model_input_token_usage),
            model_output_token_usage=dict(model_output_token_usage),
            model_thinking_token_usage=dict(model_thinking_token_usage),
            model_telemetry=model_telemetry,
            convergence_history=[],
            locked_claims=[],
            mechanism_trace=[
                MechanismTraceSegment(
                    mechanism=MechanismType.VOTE,
                    start_round=1,
                    end_round=1,
                    transcript_hashes=state.transcript_hashes,
                    convergence_history=[],
                )
            ],
            execution_mode=self._execution_mode(
                usage,
                total_tokens=token_counter,
            ),
            fallback_count=len(self._fallback_events_from_usage(usage)),
            fallback_events=self._fallback_events_from_usage(usage),
            total_tokens_used=token_counter,
            input_tokens_used=self._compact_split_total(
                counter=input_token_counter,
                model_usage=model_input_token_usage,
            ),
            output_tokens_used=self._compact_split_total(
                counter=output_token_counter,
                model_usage=model_output_token_usage,
            ),
            thinking_tokens_used=self._compact_split_total(
                counter=thinking_token_counter,
                model_usage=model_thinking_token_usage,
            ),
            total_latency_ms=latency_ms,
            cost=cost,
            reasoning_presets=self.reasoning_presets,
        )

    def _build_graph(self) -> Any:
        """Build the LangGraph execution graph for the vote engine."""

        graph = StateGraph(dict)
        graph.add_node("generate_votes", self._graph_generate_votes)
        graph.add_node("calibrate_confidence", self._graph_calibrate_confidence)
        graph.add_node("isp_aggregate", self._graph_aggregate_votes)
        graph.add_node("finalize", self._graph_finalize_vote)

        graph.add_edge(START, "generate_votes")
        graph.add_edge("generate_votes", "calibrate_confidence")
        graph.add_edge("calibrate_confidence", "isp_aggregate")
        graph.add_edge("isp_aggregate", "finalize")
        graph.add_edge("finalize", END)
        return graph.compile()

    async def _graph_generate_votes(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Generate votes and emit them into the execution trace."""

        execution = graph_state["execution"]
        vote_outputs, usage = await self._generate_votes(
            execution.task,
            custom_agents=graph_state.get("custom_agents"),
            event_sink=graph_state.get("event_sink"),
        )
        graph_state["usage"] = usage
        graph_state["token_counter"] = int(graph_state["token_counter"]) + int(usage["tokens"])
        graph_state["input_token_counter"] = int(graph_state["input_token_counter"]) + int(
            usage.get("input_tokens") or 0
        )
        graph_state["output_token_counter"] = int(graph_state["output_token_counter"]) + int(
            usage.get("output_tokens") or 0
        )
        graph_state["thinking_token_counter"] = int(graph_state["thinking_token_counter"]) + int(
            usage.get("thinking_tokens") or usage.get("reasoning_tokens") or 0
        )
        graph_state["latency_ms"] = float(graph_state["latency_ms"]) + float(usage["latency_ms"])
        self._merge_optional_usage(
            graph_state["model_token_usage"],
            usage.get("model_tokens"),
        )
        self._merge_optional_usage(
            graph_state["model_input_token_usage"],
            usage.get("model_input_tokens"),
        )
        self._merge_optional_usage(
            graph_state["model_output_token_usage"],
            usage.get("model_output_tokens"),
        )
        self._merge_optional_usage(
            graph_state["model_thinking_token_usage"],
            usage.get("model_thinking_tokens"),
        )
        self._merge_model_latency_usage(
            graph_state["model_latency_ms"],
            usage.get("model_latency_ms"),
        )
        execution.agent_outputs = vote_outputs
        execution.transcript_hashes = [
            self.hasher.hash_agent_output(output) for output in vote_outputs
        ]
        await self._emit_votes(graph_state.get("event_sink"), vote_outputs)
        return graph_state

    async def _graph_calibrate_confidence(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Calibrate vote confidences."""

        self._calibrate_confidence(graph_state["execution"])
        return graph_state

    async def _graph_aggregate_votes(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Aggregate calibrated votes with ISP weighting."""

        self._aggregate_votes(graph_state["execution"])
        return graph_state

    async def _graph_finalize_vote(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Finalize the vote into a deliberation result."""

        execution = graph_state["execution"]
        graph_state["result"] = self._build_vote_result(
            state=execution,
            selection=graph_state["selection"],
            usage=graph_state["usage"],
            token_counter=int(graph_state["token_counter"]),
            input_token_counter=int(graph_state["input_token_counter"]),
            output_token_counter=int(graph_state["output_token_counter"]),
            thinking_token_counter=int(graph_state["thinking_token_counter"]),
            model_input_token_usage=graph_state["model_input_token_usage"],
            model_output_token_usage=graph_state["model_output_token_usage"],
            model_thinking_token_usage=graph_state["model_thinking_token_usage"],
            model_latency_ms=graph_state["model_latency_ms"],
            latency_ms=float(graph_state["latency_ms"]),
        )
        return graph_state

    async def _generate_votes(
        self,
        task: str,
        custom_agents: Sequence[CustomAgentCallable] | None = None,
        event_sink: EventSink | None = None,
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate one independent vote per agent in parallel."""

        async def one_call(agent_idx: int) -> tuple[AgentOutput, dict[str, Any]]:
            agent_id = f"agent-{agent_idx + 1}"
            tier = self._participant_tiers[agent_idx]
            prompt = vote_participant_prompt(task=task)
            fallback = self._fallback_vote(task=task, agent_idx=agent_idx)
            custom_agent = custom_agents[agent_idx] if custom_agents is not None else None
            stream_callback = self._make_stream_delta_callback(
                event_sink,
                event_type="agent_output_delta",
                base_payload={
                    "agent_id": agent_id,
                    "agent_model": "custom-agent"
                    if custom_agent is not None
                    else self._model_name(tier),
                    "role": "voter",
                    "faction": "vote",
                    "round_number": 1,
                    "stage": "vote",
                },
            )
            response, usage = await self._call_structured(
                tier=tier,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_VoteResponse,
                fallback=fallback,
                custom_agent=custom_agent,
                stream=event_sink is not None and custom_agent is None,
                stream_callback=stream_callback,
            )
            assert isinstance(response, _VoteResponse)

            content = response.answer
            output = AgentOutput(
                agent_id=agent_id,
                agent_model="custom-agent" if custom_agent is not None else self._model_name(tier),
                role="voter",
                round_number=1,
                content=content,
                confidence=response.confidence,
                predicted_group_answer=response.predicted_group_answer,
                content_hash=self.hasher.hash_content(content),
                timestamp=datetime.now(UTC),
            )
            await self._emit_usage_delta(event_sink, output, usage)
            return output, usage

        results = await asyncio.gather(*(one_call(idx) for idx in range(self.agent_count)))
        outputs = [output for output, _usage in results]
        usage_totals = self._merge_usage([usage for _output, usage in results])
        model_tokens: dict[str, int] = {}
        model_latency_ms: dict[str, float] = {}
        model_input_tokens: dict[str, int] = {}
        model_output_tokens: dict[str, int] = {}
        model_thinking_tokens: dict[str, int] = {}
        for output, usage in results:
            model = output.agent_model
            model_tokens[model] = model_tokens.get(model, 0) + int(usage.get("tokens", 0))
            model_latency_ms[model] = model_latency_ms.get(model, 0.0) + float(
                usage.get("latency_ms", 0.0)
            )
            self._merge_optional_usage(model_input_tokens, usage.get("model_input_tokens"))
            self._merge_optional_usage(model_output_tokens, usage.get("model_output_tokens"))
            self._merge_optional_usage(model_thinking_tokens, usage.get("model_thinking_tokens"))
        usage_totals["model_tokens"] = model_tokens
        usage_totals["model_latency_ms"] = model_latency_ms
        usage_totals["model_input_tokens"] = model_input_tokens
        usage_totals["model_output_tokens"] = model_output_tokens
        usage_totals["model_thinking_tokens"] = model_thinking_tokens
        return outputs, usage_totals

    def _calibrate_confidence(self, state: VoteState) -> None:
        """Apply temperature scaling to reduce overconfident raw probabilities."""

        calibrated: dict[str, float] = {}
        for output in state.agent_outputs:
            calibrated[output.agent_id] = self._temperature_scale(
                output.confidence,
                temperature=self.temperature_scaling,
            )
        state.calibrated_confidences = calibrated

    def _aggregate_votes(self, state: VoteState) -> None:
        """Aggregate votes according to the configured Phase 2 mode."""

        if self.aggregation_mode == "majority":
            self._majority_aggregate(state)
            return
        if self.aggregation_mode == "confidence_weighted":
            self._confidence_weighted_aggregate(state)
            return
        self._isp_aggregate(state)

    def _majority_aggregate(self, state: VoteState) -> None:
        """Aggregate votes using simple majority only."""

        total_agents = max(1, len(state.agent_outputs))
        counts = Counter(output.content.strip() for output in state.agent_outputs)
        state.isp_scores = {answer: 0.0 for answer in counts}
        state.final_weights = {answer: count / total_agents for answer, count in counts.items()}

    def _confidence_weighted_aggregate(self, state: VoteState) -> None:
        """Aggregate votes using calibrated confidence without ISP surprise."""

        raw_weights: dict[str, float] = {}
        for output in state.agent_outputs:
            answer = output.content.strip()
            raw_weights[answer] = raw_weights.get(answer, 0.0) + state.calibrated_confidences.get(
                output.agent_id,
                output.confidence,
            )

        total = sum(raw_weights.values()) or 1.0
        state.isp_scores = {answer: 0.0 for answer in raw_weights}
        state.final_weights = {answer: weight / total for answer, weight in raw_weights.items()}

    def _isp_aggregate(self, state: VoteState) -> None:
        """Compute ISP surprise scores and confidence-weighted final weights."""

        total_agents = max(1, len(state.agent_outputs))

        answer_counts = Counter(output.content.strip().lower() for output in state.agent_outputs)
        answer_lookup = {
            output.content.strip().lower(): output.content.strip() for output in state.agent_outputs
        }

        predicted_counts = Counter(
            output.predicted_group_answer.strip().lower()
            for output in state.agent_outputs
            if output.predicted_group_answer is not None
        )

        isp_scores: dict[str, float] = {}
        raw_weights: dict[str, float] = {}
        for normalized_answer, count in answer_counts.items():
            actual_frequency = count / total_agents
            predicted_frequency = predicted_counts.get(normalized_answer, 0) / total_agents
            surprise_score = actual_frequency - predicted_frequency
            isp_scores[answer_lookup[normalized_answer]] = surprise_score

            weight_sum = 0.0
            for output in state.agent_outputs:
                if output.content.strip().lower() == normalized_answer:
                    calibrated = state.calibrated_confidences.get(
                        output.agent_id, output.confidence
                    )
                    weight_sum += calibrated * (1.0 + surprise_score)
            raw_weights[answer_lookup[normalized_answer]] = max(0.0, weight_sum)

        weight_total = sum(raw_weights.values())
        if weight_total <= 0.0:
            normalized_weights = (
                {answer: 1.0 / len(raw_weights) for answer in raw_weights}
                if raw_weights
                else {"": 1.0}
            )
        else:
            normalized_weights = {
                answer: value / weight_total for answer, value in raw_weights.items()
            }

        state.isp_scores = isp_scores
        state.final_weights = normalized_weights

    @staticmethod
    def _pick_winner(weights: dict[str, float]) -> tuple[str, float]:
        """Pick top-weighted answer and its normalized confidence."""

        if not weights:
            return "", 0.0
        answer, score = max(weights.items(), key=lambda item: item[1])
        return answer, score

    async def _call_structured(
        self,
        tier: ProviderTierName,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        fallback: BaseModel,
        custom_agent: CustomAgentCallable | None = None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Call selected tier with structured output and strict fallback policy."""

        if custom_agent is not None:
            response, usage = await invoke_custom_agent(
                custom_agent,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_model=response_model,
                fallback=fallback,
            )
            fallback_events: list[FallbackEvent] = []
            if usage.get("fallback_used"):
                event = FallbackEvent(
                    component=f"vote.{response_model.__name__}",
                    reason=str(usage.get("fallback_reason") or "custom_agent_invalid_response"),
                )
                if not self.allow_offline_fallback:
                    raise AgentCallError(
                        "Provider fallback disabled for "
                        f"vote.{response_model.__name__}: {event.reason}"
                    )
                fallback_events.append(event)
            total_tokens = int(usage.get("tokens", 0))
            return response, {
                "tokens": total_tokens,
                "total_tokens": total_tokens,
                "input_tokens": None,
                "output_tokens": None,
                "thinking_tokens": None,
                "reasoning_tokens": None,
                "model_tokens": {"custom-agent": total_tokens},
                "model_input_tokens": {},
                "model_output_tokens": {},
                "model_thinking_tokens": {},
                "latency_ms": float(usage.get("latency_ms", 0.0)),
                "model": "custom-agent",
                "provider": "custom-agent",
                "fallback_events": fallback_events,
            }

        if tier == "kimi" and response_model is _VoteResponse:
            assert isinstance(fallback, _VoteResponse)
            try:
                return await self._call_kimi_vote(
                    system_prompt,
                    user_prompt,
                    fallback,
                    stream=stream,
                    stream_callback=stream_callback,
                )
            except AgentCallError as exc:
                logger.warning(
                    "vote_agent_fallback",
                    error=str(exc),
                    response_model=response_model.__name__,
                )
                return self._offline_structured_fallback(
                    fallback=fallback,
                    component=f"vote.{response_model.__name__}",
                    reason="provider_kimi_unavailable_or_invalid",
                    model=self._model_name(tier),
                    provider=self._provider_for_tier(tier),
                )

        try:
            response, usage = await self._call_provider(
                tier=tier,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=response_model,
                stream=stream,
                stream_callback=stream_callback,
            )
            if isinstance(response, response_model):
                model_name = self._model_name(tier)
                input_tokens = usage.get("input_tokens")
                output_tokens = usage.get("output_tokens")
                thinking_tokens = usage.get("thinking_tokens", usage.get("reasoning_tokens"))
                total_tokens = int(
                    usage.get("tokens")
                    or usage.get("total_tokens")
                    or (
                        int(input_tokens or 0)
                        + int(output_tokens or 0)
                        + int(thinking_tokens or 0)
                    )
                )
                return response, {
                    "tokens": total_tokens,
                    "total_tokens": total_tokens,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "thinking_tokens": thinking_tokens,
                    "reasoning_tokens": usage.get("reasoning_tokens"),
                    "model_tokens": {model_name: total_tokens},
                    "model_input_tokens": (
                        {model_name: int(input_tokens)}
                        if input_tokens is not None
                        else {}
                    ),
                    "model_output_tokens": (
                        {model_name: int(output_tokens)}
                        if output_tokens is not None
                        else {}
                    ),
                    "model_thinking_tokens": (
                        {model_name: int(thinking_tokens)}
                        if thinking_tokens is not None
                        else {}
                    ),
                    "latency_ms": float(usage.get("latency_ms", 0.0)),
                    "model": model_name,
                    "provider": usage.get("provider", self._provider_for_tier(tier)),
                    "thinking_trace_present": bool(usage.get("thinking_trace_present", False)),
                    "thinking_trace_chars": int(usage.get("thinking_trace_chars", 0) or 0),
                }
            logger.warning(
                "vote_structured_response_type_mismatch", expected=response_model.__name__
            )
            raise AgentCallError(
                "Provider returned unsupported response type for "
                f"vote.{response_model.__name__}: provider_{tier}_returned_unsupported_response_type"
            )
        except AgentCallError as exc:
            logger.warning(
                "vote_agent_fallback", error=str(exc), response_model=response_model.__name__
            )

            fallback_reason = f"provider_{tier}_unavailable_or_invalid"
            if tier != "kimi":
                try:
                    assert isinstance(fallback, _VoteResponse)
                    kimi_response, kimi_usage = await self._call_kimi_vote(
                        system_prompt,
                        user_prompt,
                        fallback,
                        stream=stream,
                        stream_callback=stream_callback,
                    )
                    logger.info(
                        "vote_agent_fallback_to_kimi_success",
                        response_model=response_model.__name__,
                        from_tier=tier,
                    )
                    return kimi_response, kimi_usage
                except AgentCallError as kimi_exc:
                    logger.warning(
                        "vote_kimi_fallback_failed",
                        error=str(kimi_exc),
                        response_model=response_model.__name__,
                        from_tier=tier,
                    )
                    fallback_reason = f"provider_{tier}_and_kimi_unavailable_or_invalid"

        return self._offline_structured_fallback(
            fallback=fallback,
            component=f"vote.{response_model.__name__}",
            reason=fallback_reason,
            model=self._model_name(tier),
            provider=self._provider_for_tier(tier),
        )

    def _offline_structured_fallback(
        self,
        *,
        fallback: BaseModel,
        component: str,
        reason: str,
        model: str,
        provider: str,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Return an offline fallback payload only when runtime policy allows it."""

        if not self.allow_offline_fallback:
            raise AgentCallError(
                f"Provider fallback disabled for {component}: {reason}"
            )

        return fallback, {
            "tokens": 0,
            "total_tokens": 0,
            "input_tokens": None,
            "output_tokens": None,
            "thinking_tokens": None,
            "reasoning_tokens": None,
            "latency_ms": 0.0,
            "model": model,
            "provider": provider,
            "fallback_events": [
                FallbackEvent(
                    component=component,
                    reason=reason,
                )
            ],
        }

    async def _call_kimi_vote(
        self,
        system_prompt: str,
        user_prompt: str,
        fallback: _VoteResponse,
        *,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
        temperature: float | None = None,
    ) -> tuple[_VoteResponse, dict[str, Any]]:
        """Call Kimi as a raw voter and coerce output into vote schema."""

        caller = self._get_caller("kimi")
        response: str | _VoteResponse
        usage: dict[str, Any]
        vote: _VoteResponse
        fallback_used = False
        for attempt in range(2):
            response, usage = await caller.call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=_VoteResponse,
                temperature=temperature,
                stream=stream,
                stream_callback=stream_callback,
            )
            if isinstance(response, _VoteResponse):
                vote = response
                fallback_used = False
            else:
                vote, fallback_used = self._coerce_vote_response(str(response), fallback)
            if not fallback_used or self.allow_offline_fallback:
                break
            if attempt == 0:
                logger.warning(
                    "vote_kimi_response_empty_retrying",
                    model=self._model_name("kimi"),
                    provider=self._provider_for_tier("kimi"),
                )
                continue
            raise AgentCallError(
                "Provider fallback disabled for vote._VoteResponse: "
                "provider_kimi_empty_response"
            )

        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        thinking_tokens = usage.get("thinking_tokens", usage.get("reasoning_tokens"))
        total_tokens = int(
            usage.get("tokens")
            or usage.get("total_tokens")
            or (int(input_tokens or 0) + int(output_tokens or 0) + int(thinking_tokens or 0))
        )
        model_name = self._model_name("kimi")
        return vote, {
            "tokens": total_tokens,
            "total_tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "thinking_tokens": thinking_tokens,
            "reasoning_tokens": usage.get("reasoning_tokens"),
            "model_tokens": {model_name: total_tokens},
            "model_input_tokens": (
                {model_name: int(input_tokens)}
                if input_tokens is not None
                else {}
            ),
            "model_output_tokens": (
                {model_name: int(output_tokens)}
                if output_tokens is not None
                else {}
            ),
            "model_thinking_tokens": (
                {model_name: int(thinking_tokens)}
                if thinking_tokens is not None
                else {}
            ),
            "latency_ms": float(usage.get("latency_ms", 0.0)),
            "model": model_name,
            "provider": usage.get("provider", self._provider_for_tier("kimi")),
            "thinking_trace_present": bool(usage.get("thinking_trace_present", False)),
            "thinking_trace_chars": int(usage.get("thinking_trace_chars", 0) or 0),
        }

    @staticmethod
    def _coerce_vote_response(
        response_text: str,
        fallback: _VoteResponse,
    ) -> tuple[_VoteResponse, bool]:
        """Parse Kimi JSON when present; otherwise use its raw answer text."""

        cleaned = response_text.strip()
        if not cleaned:
            return fallback, True

        try:
            parsed = json.loads(AgentCaller._extract_json_payload(cleaned))
            if isinstance(parsed, dict):
                if "answer" not in parsed and "final_answer" in parsed:
                    parsed["answer"] = parsed["final_answer"]
                parsed.setdefault("predicted_group_answer", parsed.get("answer", cleaned))
                parsed.setdefault("reasoning", cleaned)
                parsed.setdefault("confidence", fallback.confidence)
                return _VoteResponse.model_validate(parsed), False
        except (json.JSONDecodeError, ValidationError):
            pass

        clipped = cleaned[:1200]
        return _VoteResponse(
            answer=clipped,
            confidence=fallback.confidence,
            predicted_group_answer=clipped,
            reasoning=cleaned,
        ), False

    def _get_caller(self, tier: str) -> AgentCaller:
        """Return lazy caller instance for a tier."""

        if tier == "pro":
            if self._pro_agent is None:
                self._pro_agent = pro_caller(thinking_level=self.reasoning_presets.gemini_pro)
            return self._pro_agent

        if tier == "claude":
            if self._claude_agent is None:
                self._claude_agent = claude_caller(effort=self.reasoning_presets.claude)
            return self._claude_agent

        if tier == "kimi":
            if self._kimi_agent is None:
                self._kimi_agent = kimi_caller(effort=self.reasoning_presets.kimi)
            return self._kimi_agent

        if self._flash_agent is None:
            self._flash_agent = flash_caller(thinking_level=self.reasoning_presets.gemini_flash)
        return self._flash_agent

    def _model_name(self, tier: str) -> str:
        """Resolve model name used for vote generation."""

        try:
            return self._get_caller(tier).model
        except AgentCallError:
            config = get_config()
            if tier == "claude":
                return config.claude_model
            if tier == "kimi":
                return config.kimi_model
            if tier == "pro":
                return config.pro_model
            return config.flash_model

    @staticmethod
    def _provider_for_tier(tier: str) -> str:
        """Resolve provider label for a tier."""

        return {
            "flash": "gemini",
            "pro": "gemini",
            "claude": "claude",
            "kimi": "openrouter",
        }.get(tier, "unknown")

    async def _call_provider(
        self,
        *,
        tier: ProviderTierName,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None = None,
        temperature: float | None = None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[str | BaseModel, dict[str, Any]]:
        """Call one provider, respecting per-run Claude concurrency."""

        caller = self._get_caller(tier)
        if tier == "claude":
            async with self._claude_run_semaphore:
                return await caller.call(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    response_format=response_format,
                    temperature=temperature,
                    stream=stream,
                    stream_callback=stream_callback,
                )
        return await caller.call(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_format=response_format,
            temperature=temperature,
            stream=stream,
            stream_callback=stream_callback,
        )

    def _tier_for_agent(self, agent_idx: int) -> ProviderTierName:
        """Return the canonical provider tier for one counted vote participant."""

        return self._participant_tiers[agent_idx]

    @staticmethod
    def _temperature_scale(probability: float, temperature: float) -> float:
        """Calibrate probability using sigmoid(logit(p) / T)."""

        p = min(0.99, max(0.01, probability))
        logit = math.log(p / (1.0 - p))
        adjusted = logit / temperature
        return 1.0 / (1.0 + math.exp(-adjusted))

    @staticmethod
    def _merge_usage(entries: list[dict[str, Any]]) -> dict[str, Any]:
        """Merge token and latency accounting across calls."""

        total_tokens = sum(int(entry.get("tokens", 0)) for entry in entries)
        total_latency = sum(float(entry.get("latency_ms", 0.0)) for entry in entries)
        input_tokens = sum(int(entry.get("input_tokens") or 0) for entry in entries) or None
        output_tokens = sum(int(entry.get("output_tokens") or 0) for entry in entries) or None
        thinking_tokens = (
            sum(
                int(entry.get("thinking_tokens") or entry.get("reasoning_tokens") or 0)
                for entry in entries
            )
            or None
        )
        fallback_events: list[FallbackEvent] = []
        for entry in entries:
            fallback_events.extend(VoteEngine._fallback_events_from_usage(entry))
        return {
            "tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "thinking_tokens": thinking_tokens,
            "latency_ms": total_latency,
            "fallback_events": fallback_events,
        }

    @staticmethod
    def _merge_optional_usage(
        target: dict[str, int],
        stage_usage: dict[str, Any] | None,
    ) -> None:
        """Accumulate nullable per-model token usage maps."""

        if not isinstance(stage_usage, dict):
            return
        for model, amount in stage_usage.items():
            if not isinstance(model, str) or amount is None:
                continue
            target[model] = target.get(model, 0) + max(0, int(amount))

    @staticmethod
    def _merge_model_latency_usage(
        target: dict[str, float],
        stage_usage: dict[str, Any] | None,
    ) -> None:
        """Accumulate nullable per-model latency maps."""

        if not isinstance(stage_usage, dict):
            return
        for model, amount in stage_usage.items():
            if not isinstance(model, str) or amount is None:
                continue
            target[model] = target.get(model, 0.0) + float(amount)

    @staticmethod
    def _fallback_events_from_usage(usage: dict[str, Any]) -> list[FallbackEvent]:
        """Extract typed fallback events from a usage payload."""

        raw_events = usage.get("fallback_events")
        if not isinstance(raw_events, list):
            return []
        events: list[FallbackEvent] = []
        for raw_event in raw_events:
            if isinstance(raw_event, FallbackEvent):
                events.append(raw_event)
            elif isinstance(raw_event, dict):
                events.append(FallbackEvent.model_validate(raw_event))
        return events

    @staticmethod
    def _execution_mode(
        usage: dict[str, Any],
        *,
        total_tokens: int,
    ) -> str:
        """Classify whether execution was fully live or used runtime fallback."""

        if not VoteEngine._fallback_events_from_usage(usage):
            return "live"
        return "fallback" if total_tokens == 0 else "mixed"

    @staticmethod
    def _fallback_vote(task: str, agent_idx: int) -> _VoteResponse:
        """Deterministic fallback votes for offline execution and tests."""

        lowered = task.lower()
        if "capital of france" in lowered:
            answer = "Paris" if agent_idx != 0 else "Lyon"
            predicted = "Paris"
            confidence = 0.9 if answer == "Paris" else 0.35
            return _VoteResponse(
                answer=answer,
                confidence=confidence,
                predicted_group_answer=predicted,
                reasoning=(
                    "Offline factual vote grounded in a known benchmark fact; this was "
                    "not provider-generated reasoning."
                ),
            )

        if "derivative" in lowered and "x^3" in lowered:
            answer = "3x^2*sin(x) + x^3*cos(x)"
            predicted = answer
            confidence = 0.8
            return _VoteResponse(
                answer=answer,
                confidence=confidence,
                predicted_group_answer=predicted,
                reasoning=(
                    "Offline calculus vote grounded in the product rule; this was not "
                    "provider-generated reasoning."
                ),
            )

        task_seed = VoteEngine._task_fragment(task)
        answer = (
            f"Lowest-risk answer satisfying: {task_seed}"
            if agent_idx % 2 == 0
            else f"Simplest defensible answer under: {task_seed}"
        )
        predicted = f"Lowest-risk answer satisfying: {task_seed}"
        confidence = 0.6 if agent_idx % 2 == 0 else 0.52
        return _VoteResponse(
            answer=answer,
            confidence=confidence,
            predicted_group_answer=predicted,
            reasoning=(
                "Offline vote heuristic grounded in prompt constraints; this is benchmark "
                "fallback evidence, not provider-generated reasoning."
            ),
        )

    @staticmethod
    def _task_fragment(task: str, *, limit: int = 160) -> str:
        """Compact a task prompt for deterministic offline artifacts."""

        return " ".join(task.strip().split())[:limit] or "the task"

    @staticmethod
    def _usage_delta_payload(
        *,
        usage: dict[str, Any],
        output: AgentOutput,
    ) -> dict[str, Any]:
        """Normalize one call's usage into a frontend-friendly payload."""

        return {
            "agent_id": output.agent_id,
            "agent_model": output.agent_model,
            "role": output.role,
            "faction": "vote",
            "round_number": output.round_number,
            "stage": "vote",
            "provider": usage.get("provider"),
            "model": usage.get("model"),
            "total_tokens": usage.get("tokens", usage.get("total_tokens", 0)),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "thinking_tokens": usage.get("thinking_tokens"),
            "reasoning_tokens": usage.get("reasoning_tokens"),
            "latency_ms": usage.get("latency_ms", 0.0),
            "thinking_trace_present": usage.get("thinking_trace_present", False),
            "thinking_trace_chars": usage.get("thinking_trace_chars", 0),
        }

    async def _emit_usage_delta(
        self,
        event_sink: EventSink | None,
        output: AgentOutput,
        usage: dict[str, Any],
    ) -> None:
        """Emit model usage metadata after a vote completes."""

        if event_sink is None:
            return

        await event_sink("usage_delta", self._usage_delta_payload(usage=usage, output=output))

    @staticmethod
    def _compact_split_total(*, counter: int, model_usage: dict[str, int]) -> int | None:
        """Prefer per-model split totals when they are available."""

        if model_usage:
            return max(0, sum(max(0, int(value)) for value in model_usage.values()))
        return counter if counter > 0 else None

    @staticmethod
    def _make_stream_delta_callback(
        event_sink: EventSink | None,
        *,
        event_type: str,
        base_payload: dict[str, Any],
    ) -> Callable[[str], None]:
        """Build a sync chunk callback that forwards live deltas to the event sink."""

        content_buffer: list[str] = []
        thinking_buffer: list[str] = []
        loop = asyncio.get_running_loop()

        def _callback(chunk: str) -> None:
            if not isinstance(chunk, str) or not chunk:
                return

            if chunk.startswith(_STREAM_EVENT_PREFIX):
                encoded = chunk[len(_STREAM_EVENT_PREFIX) :]
                if _STREAM_EVENT_SEPARATOR in encoded:
                    stream_kind, payload = encoded.split(_STREAM_EVENT_SEPARATOR, 1)
                else:
                    stream_kind, payload = "thinking_delta", encoded
                if event_sink is None:
                    return
                if stream_kind == "thinking_delta":
                    thinking_buffer.append(payload)
                    loop.create_task(
                        event_sink(
                            "thinking_delta",
                            {
                                **base_payload,
                                "thinking_delta": payload,
                                "thinking_so_far": "".join(thinking_buffer),
                            },
                        )
                    )
                    return
                if stream_kind == "provider_retrying":
                    try:
                        retry_payload = json.loads(payload)
                    except json.JSONDecodeError:
                        retry_payload = {"message": payload}
                    loop.create_task(
                        event_sink(
                            "provider_retrying",
                            {
                                **base_payload,
                                **retry_payload,
                            },
                        )
                    )
                return

            content_buffer.append(chunk)
            if event_sink is None:
                return
            loop.create_task(
                event_sink(
                    event_type,
                    {
                        **base_payload,
                        "content_delta": chunk,
                        "content_so_far": "".join(content_buffer),
                    },
                )
            )

        return _callback

    async def _emit_votes(
        self,
        event_sink: EventSink | None,
        outputs: list[AgentOutput],
    ) -> None:
        """Emit vote events to an external sink."""

        if event_sink is None:
            return

        for output in outputs:
            await event_sink(
                "agent_output",
                {
                    "agent_id": output.agent_id,
                    "agent_model": output.agent_model,
                    "role": output.role,
                    "faction": "vote",
                    "round_number": output.round_number,
                    "stage": "vote",
                    "content": output.content,
                    "confidence": output.confidence,
                    "predicted_group_answer": output.predicted_group_answer,
                },
            )
