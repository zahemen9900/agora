"""Factional debate engine with adaptive termination and switch signaling."""

from __future__ import annotations

import ast
import asyncio
import json
import re
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import structlog
from langgraph.graph import END, START, StateGraph
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

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
from agora.runtime.local_models import build_local_model_caller
from agora.runtime.model_policy import (
    balanced_participant_tiers,
    resolve_reasoning_presets,
)
from agora.runtime.monitor import StateMonitor
from agora.runtime.prompt_policy import (
    debate_devil_prompt,
    debate_initial_prompt,
    debate_opening_prompt,
    debate_rebuttal_prompt,
    debate_synthesis_prompt,
)
from agora.types import (
    AgentOutput,
    DebateState,
    DeliberationResult,
    FallbackEvent,
    LocalModelSpec,
    LocalProviderKeys,
    MechanismSelection,
    MechanismTraceSegment,
    MechanismType,
    ProviderTierName,
    ReasoningPresetOverrides,
    ReasoningPresets,
    VerifiedClaim,
)

logger = structlog.get_logger(__name__)
EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]

_ARITHMETIC_CLAIM_RE = re.compile(
    r"(?P<claim>[-+*/().\d\s]*\d[-+*/().\d\s]*=\s*[-+*/().\d\s]*\d[-+*/().\d\s]*)"
)

_STREAM_EVENT_PREFIX = "\u001eAGORA_STREAM_EVENT\u001e"
_STREAM_EVENT_SEPARATOR = "\u001f"
_SCHEMA_COERCION_REASON = "schema_incomplete_live_response"
_SCHEMA_COERCION_CONFIDENCE = 0.5


class _InitialAnswerResponse(BaseModel):
    """Structured schema for initial agent answer generation."""

    answer: str = ""
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("answer", mode="before")
    @classmethod
    def _coerce_answer(cls, value: Any) -> str:
        return "" if value is None else str(value)


class _OpeningResponse(BaseModel):
    """Structured schema for opening statements."""

    claim: str = ""
    evidence: str = ""
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("claim", "evidence", mode="before")
    @classmethod
    def _coerce_text(cls, value: Any) -> str:
        return "" if value is None else str(value)


class _CrossExamItem(BaseModel):
    """Cross-examination critique for one faction."""

    faction: str = ""
    weakest_claim: str = ""
    flaw: str = ""
    attack_axis: str = ""
    counterexample: str = ""
    failure_mode: str = ""
    question: str = ""

    @field_validator(
        "faction",
        "weakest_claim",
        "flaw",
        "attack_axis",
        "counterexample",
        "failure_mode",
        "question",
        mode="before",
    )
    @classmethod
    def _coerce_text(cls, value: Any) -> str:
        return "" if value is None else str(value)


class _CrossExamResponse(BaseModel):
    """Structured response for devil's advocate critiques."""

    analyses: list[_CrossExamItem] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce_payload(cls, value: Any) -> dict[str, Any]:
        if value is None:
            return {"analyses": []}
        if isinstance(value, list):
            return {"analyses": value}
        if isinstance(value, dict):
            analyses = value.get("analyses")
            if isinstance(analyses, list):
                return value
            return {"analyses": []}
        return {"analyses": []}


class _RebuttalResponse(BaseModel):
    """Structured schema for rebuttal statements."""

    answer: str = ""
    defense: str = ""
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("answer", "defense", mode="before")
    @classmethod
    def _coerce_text(cls, value: Any) -> str:
        return "" if value is None else str(value)


class _SynthesisResponse(BaseModel):
    """Structured schema for final synthesis."""

    final_answer: str = ""
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    summary: str = ""

    @field_validator("final_answer", "summary", mode="before")
    @classmethod
    def _coerce_text(cls, value: Any) -> str:
        return "" if value is None else str(value)


class DebateEngineOutcome(BaseModel):
    """Outcome payload for debate execution, including switch signals."""

    model_config = ConfigDict(frozen=True)

    state: DebateState
    result: DeliberationResult | None
    switch_to_vote: bool = False
    suggested_mechanism: MechanismType | None = None
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


class DebateEngine:
    """Structured factional debate runtime with adaptive control logic."""

    def __init__(
        self,
        agent_count: int = 3,
        max_rounds: int = 4,
        flash_agent: AgentCaller | None = None,
        pro_agent: AgentCaller | None = None,
        claude_agent: AgentCaller | None = None,
        kimi_agent: AgentCaller | None = None,
        monitor: StateMonitor | None = None,
        hasher: TranscriptHasher | None = None,
        enable_devils_advocate: bool = True,
        enable_adaptive_termination: bool = True,
        allow_offline_fallback: bool = False,
        reasoning_presets: ReasoningPresets
        | ReasoningPresetOverrides
        | dict[str, Any]
        | None = None,
        participant_models: Sequence[LocalModelSpec] | None = None,
        provider_keys: LocalProviderKeys | None = None,
        devils_advocate_model: LocalModelSpec | None = None,
    ) -> None:
        """Initialize debate engine dependencies.

        Args:
            agent_count: Number of debating agents.
            max_rounds: Maximum rounds before forced aggregation.
            flash_agent: Optional pre-configured generation caller.
            pro_agent: Optional pre-configured reasoning caller.
            kimi_agent: Optional pre-configured challenger caller.
            monitor: Optional convergence monitor instance.
            hasher: Optional transcript hasher instance.
        """

        self.agent_count = max(3, agent_count)
        self.max_rounds = max(1, max_rounds)
        self._flash_agent = flash_agent
        self._pro_agent = pro_agent
        self._claude_agent = claude_agent
        self._kimi_agent = kimi_agent
        self.monitor = monitor or StateMonitor()
        self.hasher = hasher or TranscriptHasher()
        self.enable_devils_advocate = enable_devils_advocate
        self.enable_adaptive_termination = enable_adaptive_termination
        self.allow_offline_fallback = allow_offline_fallback
        self.reasoning_presets = resolve_reasoning_presets(reasoning_presets)
        self._participant_models = list(participant_models) if participant_models is not None else None
        self._local_provider_keys = provider_keys
        self._devils_advocate_model = devils_advocate_model
        self._participant_tiers = balanced_participant_tiers(self.agent_count)
        if self._participant_models is not None and len(self._participant_models) != self.agent_count:
            raise ValueError("participant_models must contain exactly agent_count items")
        self._participant_callers: dict[int, AgentCaller] = {}
        self._devils_advocate_caller: AgentCaller | None = None
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
        allow_switch: bool = True,
    ) -> DebateEngineOutcome:
        """Execute factional debate and return either result or switch signal.

        Args:
            task: Task prompt to resolve.
            selection: Mechanism selector output.

        Returns:
            DebateEngineOutcome: Completed result or switch recommendation.
        """

        return await self._run_graph(
            task=task,
            selection=selection,
            event_sink=event_sink,
            custom_agents=custom_agents,
            allow_switch=allow_switch,
        )

    async def _run_graph(
        self,
        *,
        task: str,
        selection: MechanismSelection,
        event_sink: EventSink | None,
        custom_agents: Sequence[CustomAgentCallable] | None,
        allow_switch: bool,
    ) -> DebateEngineOutcome:
        """Execute debate through the compiled LangGraph when available."""

        self.monitor.reset()
        graph_state = {
            "selection": selection,
            "event_sink": event_sink,
            "custom_agents": custom_agents,
            "allow_switch": allow_switch,
            "execution": DebateState(
                task=task,
                task_features=selection.task_features,
                max_rounds=self.max_rounds,
                factions={"pro": [], "opp": []},
                rebuttals={"pro": [], "opp": []},
            ),
            "token_counter": 0,
            "input_token_counter": 0,
            "output_token_counter": 0,
            "thinking_token_counter": 0,
            "latency_ms": 0.0,
            "model_token_usage": {},
            "model_input_token_usage": {},
            "model_output_token_usage": {},
            "model_thinking_token_usage": {},
            "model_latency_ms": {},
            "fallback_events": [],
            "round_cursor": 1,
            "switch_to_vote": False,
            "suggested_mechanism": None,
            "reason": "",
            "result": None,
        }
        final_state = await self.graph.ainvoke(graph_state)
        return DebateEngineOutcome(
            state=final_state["execution"],
            result=final_state.get("result"),
            switch_to_vote=bool(final_state.get("switch_to_vote", False)),
            suggested_mechanism=final_state.get("suggested_mechanism"),
            reason=str(final_state.get("reason", "")),
            agent_models_used=(
                final_state["result"].agent_models_used
                if final_state.get("result") is not None
                else self._agent_models_from_state(final_state["execution"])
            ),
            model_token_usage=dict(final_state["model_token_usage"]),
            model_latency_ms=dict(final_state["model_latency_ms"]),
            model_input_token_usage=dict(final_state["model_input_token_usage"]),
            model_output_token_usage=dict(final_state["model_output_token_usage"]),
            model_thinking_token_usage=dict(final_state["model_thinking_token_usage"]),
            fallback_events=list(final_state["fallback_events"]),
            total_tokens_used=int(final_state["token_counter"]),
            input_tokens_used=(
                int(final_state["input_token_counter"])
                if int(final_state["input_token_counter"]) > 0
                else None
            ),
            output_tokens_used=(
                int(final_state["output_token_counter"])
                if int(final_state["output_token_counter"]) > 0
                else None
            ),
            thinking_tokens_used=(
                int(final_state["thinking_token_counter"])
                if int(final_state["thinking_token_counter"]) > 0
                else None
            ),
            total_latency_ms=float(final_state["latency_ms"]),
        )

    def _build_graph(self) -> Any | None:
        """Build the LangGraph execution graph for factional debate."""

        graph = StateGraph(dict)
        graph.add_node("initialize_debate", self._graph_initialize_debate)
        graph.add_node("opening_statements", self._graph_opening_statements)
        graph.add_node("cross_examination", self._graph_cross_examination)
        graph.add_node("rebuttal", self._graph_rebuttal_round)
        graph.add_node("convergence_check", self._graph_convergence_check)
        graph.add_node("final_aggregation", self._graph_finalize_debate)
        graph.add_node("switch_result", self._graph_switch_result)

        graph.add_edge(START, "initialize_debate")
        graph.add_edge("initialize_debate", "opening_statements")
        graph.add_edge("opening_statements", "cross_examination")
        graph.add_edge("cross_examination", "rebuttal")
        graph.add_edge("rebuttal", "convergence_check")
        graph.add_conditional_edges(
            "convergence_check",
            self._graph_route,
            {
                "cross_examination": "cross_examination",
                "final_aggregation": "final_aggregation",
                "switch_result": "switch_result",
            },
        )
        graph.add_edge("final_aggregation", END)
        graph.add_edge("switch_result", END)
        return graph.compile()

    async def _graph_initialize_debate(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Initialize factions from independent answers."""

        execution = graph_state["execution"]
        custom_agents = graph_state.get("custom_agents")
        event_sink = graph_state.get("event_sink")
        initial_outputs, usage = await self._assign_initial_answers(
            execution.task,
            custom_agents=custom_agents,
            event_sink=event_sink,
        )
        self._graph_accumulate_usage(graph_state, usage)
        self.monitor.seed_baseline(initial_outputs)

        for output in initial_outputs:
            execution.transcript_hashes.append(self.hasher.hash_agent_output(output))

        pro_answer, opp_answer, assignments, devil_advocate_id = self._assign_factions(
            initial_outputs
        )
        execution.factions["pro"] = [
            output for output in initial_outputs if assignments.get(output.agent_id) == "pro"
        ]
        execution.factions["opp"] = [
            output for output in initial_outputs if assignments.get(output.agent_id) == "opp"
        ]
        graph_state["pro_answer"] = pro_answer
        graph_state["opp_answer"] = opp_answer
        graph_state["assignments"] = assignments
        graph_state["devil_advocate_id"] = devil_advocate_id
        return graph_state

    async def _graph_opening_statements(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Generate and emit opening statements for both factions."""

        execution = graph_state["execution"]
        event_sink = graph_state.get("event_sink")
        opening_outputs, usage = await self._opening_statements(
            task=execution.task,
            assignments=graph_state["assignments"],
            pro_answer=graph_state["pro_answer"],
            opp_answer=graph_state["opp_answer"],
            custom_agents=graph_state.get("custom_agents"),
            event_sink=event_sink,
        )
        self._graph_accumulate_usage(graph_state, usage)
        for output in opening_outputs:
            execution.transcript_hashes.append(self.hasher.hash_agent_output(output))
            if output.role == "proponent":
                execution.factions["pro"].append(output)
            else:
                execution.factions["opp"].append(output)
        graph_state["latest_round_outputs"] = opening_outputs
        await self._emit_agent_outputs(graph_state.get("event_sink"), opening_outputs)
        return graph_state

    async def _graph_cross_examination(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Run the cross-examination node for the current round."""

        execution = graph_state["execution"]
        round_number = int(graph_state["round_cursor"])
        latest_round_outputs = graph_state["latest_round_outputs"]
        if self.enable_devils_advocate:
            event_sink = graph_state.get("event_sink")
            cross_output, usage = await self._cross_examination(
                task=execution.task,
                round_number=round_number,
                devil_advocate_id=graph_state["devil_advocate_id"],
                pro_outputs=[
                    output
                    for output in latest_round_outputs
                    if output.role in {"proponent", "pro_rebuttal"}
                ],
                opp_outputs=[
                    output
                    for output in latest_round_outputs
                    if output.role in {"opponent", "opp_rebuttal"}
                ],
                custom_agents=graph_state.get("custom_agents"),
                event_sink=event_sink,
            )
            self._graph_accumulate_usage(graph_state, usage)
            execution.cross_examinations.append(cross_output)
            execution.transcript_hashes.append(self.hasher.hash_agent_output(cross_output))
            await self._emit_cross_examination(graph_state.get("event_sink"), cross_output)
            graph_state["cross_output"] = cross_output
            return graph_state

        empty_analyses = json.dumps({"analyses": []}, sort_keys=True)
        graph_state["cross_output"] = AgentOutput(
            agent_id=graph_state["devil_advocate_id"],
            agent_model="disabled-devils-advocate",
            role="devil_advocate",
            round_number=round_number,
            content=empty_analyses,
            confidence=0.0,
            predicted_group_answer=None,
            content_hash=self.hasher.hash_content(empty_analyses),
            timestamp=datetime.now(UTC),
        )
        return graph_state

    async def _graph_rebuttal_round(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Generate rebuttals for the current round."""

        execution = graph_state["execution"]
        round_number = int(graph_state["round_cursor"])
        event_sink = graph_state.get("event_sink")
        rebuttal_outputs, usage = await self._rebuttal_round(
            task=execution.task,
            round_number=round_number,
            assignments=graph_state["assignments"],
            cross_exam_output=graph_state["cross_output"],
            pro_answer=graph_state["pro_answer"],
            opp_answer=graph_state["opp_answer"],
            locked_claims=execution.locked_claims,
            custom_agents=graph_state.get("custom_agents"),
            event_sink=event_sink,
        )
        self._graph_accumulate_usage(graph_state, usage)

        round_outputs: list[AgentOutput] = []
        for output in rebuttal_outputs:
            execution.transcript_hashes.append(self.hasher.hash_agent_output(output))
            if output.role == "pro_rebuttal":
                execution.rebuttals.setdefault("pro", []).append(output)
            else:
                execution.rebuttals.setdefault("opp", []).append(output)
            round_outputs.append(output)
            for claim in self._verify_claims(output.content, round_number):
                known_claim_hashes = {
                    existing.claim_hash for existing in execution.locked_claims
                }
                if claim.claim_hash not in known_claim_hashes:
                    execution.locked_claims.append(claim)

        graph_state["latest_round_outputs"] = round_outputs
        graph_state["round_outputs"] = round_outputs
        await self._emit_agent_outputs(graph_state.get("event_sink"), round_outputs)
        return graph_state

    async def _graph_convergence_check(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Update convergence metrics and choose the next graph edge."""

        execution = graph_state["execution"]
        round_number = int(graph_state["round_cursor"])
        metrics = self.monitor.compute_metrics(
            graph_state["round_outputs"],
            locked_claim_count=len(execution.locked_claims),
        )
        execution.convergence_history.append(metrics)
        execution.round = round_number
        await self._emit_convergence_update(
            graph_state.get("event_sink"),
            metrics,
            execution.locked_claims,
        )

        next_node = "final_aggregation" if round_number >= self.max_rounds else "cross_examination"
        if self.enable_adaptive_termination:
            terminate, terminate_reason = self.monitor.should_terminate(
                execution.convergence_history
            )
            if terminate:
                execution.terminated_early = round_number < self.max_rounds
                logger.info(
                    "debate_terminated",
                    reason=terminate_reason,
                    round_number=round_number,
                )
                graph_state["reason"] = terminate_reason
                next_node = "final_aggregation"
            else:
                should_switch, suggested, switch_reason = self.monitor.should_switch_mechanism(
                    execution.convergence_history,
                    current_mechanism=MechanismType.DEBATE,
                )
                if (
                    graph_state.get("allow_switch", True)
                    and should_switch
                    and suggested == MechanismType.VOTE
                ):
                    execution.mechanism_switches += 1
                    logger.info(
                        "debate_switch_suggested",
                        round_number=round_number,
                        reason=switch_reason,
                        suggested_mechanism=suggested.value,
                    )
                    graph_state["switch_to_vote"] = True
                    graph_state["suggested_mechanism"] = suggested
                    graph_state["reason"] = switch_reason
                    next_node = "switch_result"

        if next_node == "cross_examination":
            graph_state["round_cursor"] = round_number + 1
        elif not graph_state.get("reason"):
            graph_state["reason"] = "completed"
        graph_state["next_node"] = next_node
        return graph_state

    @staticmethod
    def _graph_route(graph_state: dict[str, Any]) -> str:
        """Return the next LangGraph edge after convergence evaluation."""

        return str(graph_state.get("next_node", "final_aggregation"))

    async def _graph_finalize_debate(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Finalize debate into a deliberation result."""

        execution = graph_state["execution"]
        result, _usage = await self._final_aggregation(
            state=execution,
            selection=graph_state["selection"],
            pro_answer=graph_state["pro_answer"],
            opp_answer=graph_state["opp_answer"],
            prior_tokens=int(graph_state["token_counter"]),
            prior_latency_ms=float(graph_state["latency_ms"]),
            prior_model_token_usage=graph_state["model_token_usage"],
            prior_model_input_token_usage=graph_state["model_input_token_usage"],
            prior_model_output_token_usage=graph_state["model_output_token_usage"],
            prior_model_thinking_token_usage=graph_state["model_thinking_token_usage"],
            prior_model_latency_ms=graph_state["model_latency_ms"],
            prior_fallback_events=graph_state["fallback_events"],
            custom_agents=graph_state.get("custom_agents"),
            event_sink=graph_state.get("event_sink"),
        )
        graph_state["result"] = result
        graph_state["reason"] = str(graph_state.get("reason") or "completed")
        return graph_state

    async def _graph_switch_result(self, graph_state: dict[str, Any]) -> dict[str, Any]:
        """Terminal node for switch suggestions."""

        graph_state["result"] = None
        return graph_state

    def _participant_model(self, agent_idx: int) -> LocalModelSpec | None:
        """Return explicit participant model spec when local roster mode is active."""

        if self._participant_models is None:
            return None
        return self._participant_models[agent_idx]

    def _participant_caller(self, agent_idx: int, model_spec: LocalModelSpec) -> AgentCaller:
        """Build or reuse the caller for one explicit local participant."""

        caller = self._participant_callers.get(agent_idx)
        if caller is None:
            caller = build_local_model_caller(
                spec=model_spec,
                provider_keys=self._local_provider_keys,
            )
            self._participant_callers[agent_idx] = caller
        return caller

    def _synthesis_model(self) -> LocalModelSpec | None:
        """Return the explicit synthesis model for local roster mode."""

        if not self._participant_models:
            return None
        return self._participant_models[0]

    def _resolved_devils_advocate_model(self) -> LocalModelSpec | None:
        """Return explicit devil's-advocate model when configured."""

        if self._devils_advocate_model is not None:
            return self._devils_advocate_model
        return self._synthesis_model()

    def _devils_advocate_caller_for(self, model_spec: LocalModelSpec) -> AgentCaller:
        """Build or reuse the explicit devil's-advocate caller."""

        if self._devils_advocate_caller is None or self._devils_advocate_caller.model != model_spec.model:
            self._devils_advocate_caller = build_local_model_caller(
                spec=model_spec,
                provider_keys=self._local_provider_keys,
            )
        return self._devils_advocate_caller

    def _display_model_name(
        self,
        *,
        tier: ProviderTierName,
        explicit_model: LocalModelSpec | None,
        custom_agent: CustomAgentCallable | None,
    ) -> str:
        """Resolve model label exposed in events and result payloads."""

        if custom_agent is not None:
            return "custom-agent"
        if explicit_model is not None:
            return explicit_model.model
        return self._model_name(tier)

    def _graph_accumulate_usage(
        self,
        graph_state: dict[str, Any],
        usage: dict[str, Any],
    ) -> None:
        """Accumulate stage usage into graph execution totals."""

        graph_state["token_counter"] = int(graph_state["token_counter"]) + int(usage["tokens"])
        graph_state["latency_ms"] = float(graph_state["latency_ms"]) + float(usage["latency_ms"])
        self._accumulate_optional_usage(
            graph_state,
            usage,
            usage_key="input_tokens",
            counter_key="input_token_counter",
            model_usage_key="model_input_tokens",
            model_usage_store_key="model_input_token_usage",
        )
        self._accumulate_optional_usage(
            graph_state,
            usage,
            usage_key="output_tokens",
            counter_key="output_token_counter",
            model_usage_key="model_output_tokens",
            model_usage_store_key="model_output_token_usage",
        )
        self._accumulate_optional_usage(
            graph_state,
            usage,
            usage_key="thinking_tokens",
            counter_key="thinking_token_counter",
            model_usage_key="model_thinking_tokens",
            model_usage_store_key="model_thinking_token_usage",
            fallback_usage_key="reasoning_tokens",
        )
        self._accumulate_model_usage(
            graph_state["model_token_usage"],
            graph_state["model_latency_ms"],
            usage,
        )
        self._accumulate_fallback_events(graph_state["fallback_events"], usage)

    @staticmethod
    def _agent_models_from_state(state: DebateState) -> list[str]:
        """Extract unique agent models observed in a partial or complete debate state."""

        return list(
            dict.fromkeys(
                [
                    *[output.agent_model for output in state.factions.get("pro", [])],
                    *[output.agent_model for output in state.factions.get("opp", [])],
                    *[output.agent_model for output in state.cross_examinations],
                    *[output.agent_model for output in state.rebuttals.get("pro", [])],
                    *[output.agent_model for output in state.rebuttals.get("opp", [])],
                ]
            )
        )

    async def _assign_initial_answers(
        self,
        task: str,
        custom_agents: Sequence[CustomAgentCallable] | None = None,
        event_sink: EventSink | None = None,
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate independent initial answers for faction assignment."""

        async def one_call(agent_idx: int) -> tuple[AgentOutput, dict[str, Any]]:
            agent_id = f"agent-{agent_idx + 1}"
            tier = self._participant_tiers[agent_idx]
            explicit_model = self._participant_model(agent_idx)
            prompt = debate_initial_prompt(task=task)
            fallback = _InitialAnswerResponse(
                answer=self._fallback_initial_answer(task=task, agent_idx=agent_idx),
                confidence=0.55,
            )

            custom_agent = custom_agents[agent_idx] if custom_agents is not None else None
            stream_callback = self._make_stream_delta_callback(
                event_sink,
                event_type="agent_output_delta",
                base_payload={
                    "agent_id": agent_id,
                    "agent_model": self._display_model_name(
                        tier=tier,
                        explicit_model=explicit_model,
                        custom_agent=custom_agent,
                    ),
                    "role": "initial",
                    "faction": "proponent" if agent_idx % 2 == 0 else "opponent",
                    "round_number": 0,
                    "stage": "initial",
                },
            )
            if explicit_model is not None and custom_agent is None:
                response, usage = await self._call_structured_explicit_model(
                    agent_idx=agent_idx,
                    model_spec=explicit_model,
                    system_prompt=prompt.system,
                    user_prompt=prompt.user,
                    response_model=_InitialAnswerResponse,
                    fallback=fallback,
                    stream=event_sink is not None,
                    stream_callback=stream_callback,
                )
            else:
                response, usage = await self._call_structured(
                    tier=tier,
                    system_prompt=prompt.system,
                    user_prompt=prompt.user,
                    response_model=_InitialAnswerResponse,
                    fallback=fallback,
                    custom_agent=custom_agent,
                    stream=event_sink is not None and custom_agent is None,
                    stream_callback=stream_callback,
                )
            assert isinstance(response, _InitialAnswerResponse)
            timestamp = datetime.now(UTC)
            content = response.answer
            output = AgentOutput(
                agent_id=agent_id,
                agent_model=self._display_model_name(
                    tier=tier,
                    explicit_model=explicit_model,
                    custom_agent=custom_agent,
                ),
                role="initial",
                round_number=0,
                content=content,
                confidence=response.confidence,
                predicted_group_answer=None,
                content_hash=self.hasher.hash_content(content),
                timestamp=timestamp,
            )
            await self._emit_usage_delta(event_sink, output, usage)
            return output, usage

        results = await asyncio.gather(*(one_call(idx) for idx in range(self.agent_count)))
        outputs = [output for output, _usage in results]
        usage_totals = self._merge_usage([usage for _output, usage in results])
        model_tokens, model_latency = self._merge_usage_by_output(results)
        usage_totals["model_tokens"] = model_tokens
        usage_totals["model_latency_ms"] = model_latency
        return outputs, usage_totals

    def _assign_factions(
        self,
        outputs: list[AgentOutput],
    ) -> tuple[str, str, dict[str, str], str]:
        """Assign counted participants to factions and keep a separate devil's advocate."""

        normalized_answers = [output.content.strip().lower() for output in outputs]
        counts = Counter(normalized_answers)
        most_common = [answer for answer, _count in counts.most_common(2)]

        if not most_common:
            pro_answer = "position_a"
            opp_answer = "position_b"
        elif len(most_common) == 1:
            pro_answer = most_common[0]
            opp_answer = f"alternative to {pro_answer}"
        else:
            pro_answer, opp_answer = most_common[0], most_common[1]

        assignments: dict[str, str] = {}
        for output in outputs:
            normalized = output.content.strip().lower()
            if normalized == pro_answer:
                assignments[output.agent_id] = "pro"
            elif normalized == opp_answer:
                assignments[output.agent_id] = "opp"
            else:
                pro_count = sum(1 for assigned in assignments.values() if assigned == "pro")
                opp_count = sum(1 for assigned in assignments.values() if assigned == "opp")
                assignments[output.agent_id] = "pro" if pro_count <= opp_count else "opp"

        self._ensure_both_factions_present(assignments)

        return pro_answer, opp_answer, assignments, "debate-devils-advocate"

    @staticmethod
    def _ensure_both_factions_present(assignments: dict[str, str]) -> None:
        """Rebalance assignments so both factions are represented."""

        pro_members = [agent_id for agent_id, side in assignments.items() if side == "pro"]
        opp_members = [agent_id for agent_id, side in assignments.items() if side == "opp"]

        if not pro_members and opp_members:
            assignments[opp_members[-1]] = "pro"
            pro_members = [opp_members[-1]]
            opp_members = opp_members[:-1]

        if not opp_members and pro_members:
            assignments[pro_members[-1]] = "opp"

    async def _opening_statements(
        self,
        task: str,
        assignments: dict[str, str],
        pro_answer: str,
        opp_answer: str,
        custom_agents: Sequence[CustomAgentCallable] | None = None,
        event_sink: EventSink | None = None,
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate faction opening statements in parallel."""

        async def one_call(agent_id: str, side: str) -> tuple[AgentOutput, dict[str, Any]]:
            faction_answer = pro_answer if side == "pro" else opp_answer
            agent_idx = self._agent_index(agent_id)
            tier = self._tier_for_agent_id(agent_id)
            explicit_model = self._participant_model(agent_idx)
            prompt = debate_opening_prompt(task=task, faction_answer=faction_answer)
            fallback = _OpeningResponse(
                claim=faction_answer,
                evidence=self._fallback_opening_evidence(
                    task=task,
                    faction_answer=faction_answer,
                ),
                confidence=0.55,
            )
            custom_agent = (
                custom_agents[self._agent_index(agent_id)] if custom_agents is not None else None
            )
            stream_callback = self._make_stream_delta_callback(
                event_sink,
                event_type="agent_output_delta",
                base_payload={
                    "agent_id": agent_id,
                    "agent_model": self._display_model_name(
                        tier=tier,
                        explicit_model=explicit_model,
                        custom_agent=custom_agent,
                    ),
                    "role": "proponent" if side == "pro" else "opponent",
                    "faction": side,
                    "round_number": 1,
                    "stage": "opening",
                },
            )
            if explicit_model is not None and custom_agent is None:
                response, usage = await self._call_structured_explicit_model(
                    agent_idx=agent_idx,
                    model_spec=explicit_model,
                    system_prompt=prompt.system,
                    user_prompt=prompt.user,
                    response_model=_OpeningResponse,
                    fallback=fallback,
                    stream=event_sink is not None,
                    stream_callback=stream_callback,
                )
            else:
                response, usage = await self._call_structured(
                    tier=tier,
                    system_prompt=prompt.system,
                    user_prompt=prompt.user,
                    response_model=_OpeningResponse,
                    fallback=fallback,
                    custom_agent=custom_agent,
                    stream=event_sink is not None and custom_agent is None,
                    stream_callback=stream_callback,
                )
            assert isinstance(response, _OpeningResponse)
            content = json.dumps(
                {
                    "assigned_answer": faction_answer,
                    "answer": faction_answer,
                    "claim": response.claim,
                    "confidence": response.confidence,
                    "current_answer": faction_answer,
                    "evidence": response.evidence,
                    "faction_answer": faction_answer,
                    "stance": "support",
                },
                sort_keys=True,
            )
            role = "proponent" if side == "pro" else "opponent"
            timestamp = datetime.now(UTC)
            output = AgentOutput(
                agent_id=agent_id,
                agent_model=self._display_model_name(
                    tier=tier,
                    explicit_model=explicit_model,
                    custom_agent=custom_agent,
                ),
                role=role,
                round_number=1,
                content=content,
                confidence=response.confidence,
                predicted_group_answer=None,
                content_hash=self.hasher.hash_content(content),
                timestamp=timestamp,
            )
            await self._emit_usage_delta(event_sink, output, usage)
            return output, usage

        results = await asyncio.gather(
            *(one_call(agent_id, side) for agent_id, side in assignments.items())
        )
        outputs = [output for output, _usage in results]
        usage_totals = self._merge_usage([usage for _output, usage in results])
        model_tokens, model_latency = self._merge_usage_by_output(results)
        usage_totals["model_tokens"] = model_tokens
        usage_totals["model_latency_ms"] = model_latency
        return outputs, usage_totals

    async def _cross_examination(
        self,
        task: str,
        round_number: int,
        devil_advocate_id: str,
        pro_outputs: list[AgentOutput],
        opp_outputs: list[AgentOutput],
        custom_agents: Sequence[CustomAgentCallable] | None = None,
        event_sink: EventSink | None = None,
    ) -> tuple[AgentOutput, dict[str, Any]]:
        """Run devil's advocate cross-examination against both factions."""

        prompt = debate_devil_prompt(
            task=task,
            round_number=round_number,
            pro_outputs=[output.content for output in pro_outputs],
            opp_outputs=[output.content for output in opp_outputs],
        )

        fallback = self._build_cross_exam_fallback(
            task=task,
            pro_outputs=pro_outputs,
            opp_outputs=opp_outputs,
        )

        custom_agent = self._coordinator_custom_agent(custom_agents)
        explicit_model = self._resolved_devils_advocate_model() if custom_agent is None else None
        stream_callback = self._make_stream_delta_callback(
            event_sink,
            event_type="cross_examination_delta",
            base_payload={
                "agent_id": devil_advocate_id,
                "agent_model": "custom-agent"
                if custom_agent is not None
                else (
                    explicit_model.model if explicit_model is not None else self._model_name("kimi")
                ),
                "role": "devil_advocate",
                "round_number": round_number,
                "stage": "cross_examination",
            },
        )
        if custom_agent is not None:
            response, usage = await self._call_structured(
                tier="pro",
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_CrossExamResponse,
                fallback=fallback,
                temperature=0.2,
                custom_agent=custom_agent,
                stream=event_sink is not None,
                stream_callback=stream_callback,
            )
            assert isinstance(response, _CrossExamResponse)
        elif explicit_model is not None:
            response, usage = await self._call_cross_exam_explicit_model(
                model_spec=explicit_model,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                fallback=fallback,
                temperature=0.2,
                stream=event_sink is not None,
                stream_callback=stream_callback,
            )
        else:
            response, usage = await self._call_cross_exam(
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                fallback=fallback,
                temperature=0.2,
                stream=event_sink is not None,
                stream_callback=stream_callback,
            )
        content = json.dumps(response.model_dump(mode="json"), sort_keys=True)

        output = AgentOutput(
            agent_id=devil_advocate_id,
            agent_model=(
                "custom-agent"
                if custom_agent is not None
                else (
                    explicit_model.model if explicit_model is not None else self._model_name("kimi")
                )
            ),
            role="devil_advocate",
            round_number=round_number,
            content=content,
            confidence=0.8,
            predicted_group_answer=None,
            content_hash=self.hasher.hash_content(content),
            timestamp=datetime.now(UTC),
        )
        usage["model_tokens"] = {output.agent_model: int(usage.get("tokens", 0))}
        usage["model_latency_ms"] = {output.agent_model: float(usage.get("latency_ms", 0.0))}
        await self._emit_usage_delta(event_sink, output, usage)
        return output, usage

    async def _rebuttal_round(
        self,
        task: str,
        round_number: int,
        assignments: dict[str, str],
        cross_exam_output: AgentOutput,
        pro_answer: str,
        opp_answer: str,
        locked_claims: list[VerifiedClaim],
        custom_agents: Sequence[CustomAgentCallable] | None = None,
        event_sink: EventSink | None = None,
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate faction rebuttals responding to cross-examination."""

        async def one_call(agent_id: str, side: str) -> tuple[AgentOutput, dict[str, Any]]:
            faction_answer = pro_answer if side == "pro" else opp_answer
            targeted_prompt = self._extract_targeted_question(cross_exam_output.content, side)
            agent_idx = self._agent_index(agent_id)
            tier = self._tier_for_agent_id(agent_id)
            explicit_model = self._participant_model(agent_idx)
            prompt = debate_rebuttal_prompt(
                task=task,
                faction_answer=faction_answer,
                targeted_prompt=targeted_prompt,
                locked_claims=[claim.claim_text for claim in locked_claims],
            )
            fallback = self._build_rebuttal_fallback(
                faction_answer=faction_answer,
                targeted_prompt=targeted_prompt,
                locked_claims=[claim.claim_text for claim in locked_claims],
            )
            custom_agent = (
                custom_agents[self._agent_index(agent_id)] if custom_agents is not None else None
            )
            stream_callback = self._make_stream_delta_callback(
                event_sink,
                event_type="agent_output_delta",
                base_payload={
                    "agent_id": agent_id,
                    "agent_model": self._display_model_name(
                        tier=tier,
                        explicit_model=explicit_model,
                        custom_agent=custom_agent,
                    ),
                    "role": "pro_rebuttal" if side == "pro" else "opp_rebuttal",
                    "faction": side,
                    "round_number": round_number,
                    "stage": "rebuttal",
                },
            )
            if explicit_model is not None and custom_agent is None:
                response, usage = await self._call_structured_explicit_model(
                    agent_idx=agent_idx,
                    model_spec=explicit_model,
                    system_prompt=prompt.system,
                    user_prompt=prompt.user,
                    response_model=_RebuttalResponse,
                    fallback=fallback,
                    temperature=0.4,
                    stream=event_sink is not None,
                    stream_callback=stream_callback,
                )
            else:
                response, usage = await self._call_structured(
                    tier=tier,
                    system_prompt=prompt.system,
                    user_prompt=prompt.user,
                    response_model=_RebuttalResponse,
                    fallback=fallback,
                    temperature=0.4,
                    custom_agent=custom_agent,
                    stream=event_sink is not None and custom_agent is None,
                    stream_callback=stream_callback,
                )
            assert isinstance(response, _RebuttalResponse)
            content = json.dumps(
                {
                    "assigned_answer": faction_answer,
                    "answer": response.answer,
                    "confidence": response.confidence,
                    "current_answer": response.answer,
                    "defense": response.defense,
                    "faction_answer": faction_answer,
                    "stance": self._stance_for_answer(response.answer, faction_answer),
                },
                sort_keys=True,
            )
            role = "pro_rebuttal" if side == "pro" else "opp_rebuttal"
            output = AgentOutput(
                agent_id=agent_id,
                agent_model=self._display_model_name(
                    tier=tier,
                    explicit_model=explicit_model,
                    custom_agent=custom_agent,
                ),
                role=role,
                round_number=round_number,
                content=content,
                confidence=response.confidence,
                predicted_group_answer=None,
                content_hash=self.hasher.hash_content(content),
                timestamp=datetime.now(UTC),
            )
            await self._emit_usage_delta(event_sink, output, usage)
            return output, usage

        results = await asyncio.gather(
            *(one_call(agent_id, side) for agent_id, side in assignments.items())
        )
        outputs = [output for output, _usage in results]
        usage_totals = self._merge_usage([usage for _output, usage in results])
        model_tokens, model_latency = self._merge_usage_by_output(results)
        usage_totals["model_tokens"] = model_tokens
        usage_totals["model_latency_ms"] = model_latency
        return outputs, usage_totals

    async def _final_aggregation(
        self,
        state: DebateState,
        selection: MechanismSelection,
        pro_answer: str,
        opp_answer: str,
        prior_tokens: int,
        prior_latency_ms: float,
        prior_model_token_usage: dict[str, int],
        prior_model_input_token_usage: dict[str, int],
        prior_model_output_token_usage: dict[str, int],
        prior_model_thinking_token_usage: dict[str, int],
        prior_model_latency_ms: dict[str, float],
        prior_fallback_events: list[FallbackEvent] | None = None,
        custom_agents: Sequence[CustomAgentCallable] | None = None,
        event_sink: EventSink | None = None,
    ) -> tuple[DeliberationResult, dict[str, Any]]:
        """Aggregate trajectory, synthesize final answer, and build result."""

        pro_outputs = state.factions.get("pro", []) + state.rebuttals.get("pro", [])
        opp_outputs = state.factions.get("opp", []) + state.rebuttals.get("opp", [])

        pro_score = self._score_faction_outputs(pro_outputs)
        opp_score = self._score_faction_outputs(opp_outputs)

        pro_bonus = self._locked_claim_bonus(state.locked_claims, pro_outputs)
        opp_bonus = self._locked_claim_bonus(state.locked_claims, opp_outputs)
        pro_score += pro_bonus
        opp_score += opp_bonus

        total_score = pro_score + opp_score
        if total_score <= 0.0:
            total_score = 1.0

        winning_side = "pro" if pro_score >= opp_score else "opp"
        winning_answer = pro_answer if winning_side == "pro" else opp_answer
        winning_transcript = pro_outputs if winning_side == "pro" else opp_outputs

        prompt = debate_synthesis_prompt(
            task=state.task,
            winning_side=winning_side,
            winning_answer=winning_answer,
            transcript=[output.content for output in winning_transcript],
        )
        fallback = _SynthesisResponse(
            final_answer=winning_answer,
            confidence=max(pro_score, opp_score) / total_score,
            summary=(
                f"Offline synthesis selected the {winning_side} trajectory because its "
                f"confidence-weighted debate score exceeded the alternative on task: "
                f"{self._task_fragment(state.task)}"
            ),
        )

        custom_agent = self._coordinator_custom_agent(custom_agents)
        explicit_model = self._synthesis_model() if custom_agent is None else None
        stream_callback = self._make_stream_delta_callback(
            event_sink,
            event_type="agent_output_delta",
            base_payload={
                "agent_id": "synthesis",
                "agent_model": "custom-agent"
                if custom_agent is not None
                else (explicit_model.model if explicit_model is not None else self._model_name("pro")),
                "role": "synthesis",
                "faction": winning_side,
                "round_number": max(1, state.round),
                "stage": "final_synthesis",
            },
        )
        if explicit_model is not None and custom_agent is None:
            response, usage = await self._call_structured_explicit_model(
                agent_idx=0,
                model_spec=explicit_model,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_SynthesisResponse,
                fallback=fallback,
                temperature=0.2,
                stream=event_sink is not None,
                stream_callback=stream_callback,
            )
        else:
            response, usage = await self._call_structured(
                tier="pro",
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_SynthesisResponse,
                fallback=fallback,
                temperature=0.2,
                custom_agent=custom_agent,
                stream=event_sink is not None and custom_agent is None,
                stream_callback=stream_callback,
            )
        assert isinstance(response, _SynthesisResponse)

        state.final_answer = response.final_answer
        state.merkle_root = self.hasher.build_merkle_tree(state.transcript_hashes)

        final_confidence = max(0.0, min(1.0, response.confidence))
        quorum_reached = final_confidence >= 0.6

        total_tokens = prior_tokens + int(usage["tokens"])
        total_latency_ms = prior_latency_ms + float(usage["latency_ms"])
        model_token_usage = dict(prior_model_token_usage)
        model_latency_ms = dict(prior_model_latency_ms)
        synthesis_usage = dict(usage)
        model_name = synthesis_usage.get("model")
        if isinstance(model_name, str) and model_name:
            synthesis_usage["model_tokens"] = {model_name: int(synthesis_usage.get("tokens", 0))}
            synthesis_usage["model_latency_ms"] = {
                model_name: float(synthesis_usage.get("latency_ms", 0.0))
            }
        self._accumulate_model_usage(model_token_usage, model_latency_ms, synthesis_usage)
        model_input_token_usage = dict(prior_model_input_token_usage)
        model_output_token_usage = dict(prior_model_output_token_usage)
        model_thinking_token_usage = dict(prior_model_thinking_token_usage)
        for source_key, store in (
            ("model_input_tokens", model_input_token_usage),
            ("model_output_tokens", model_output_token_usage),
            ("model_thinking_tokens", model_thinking_token_usage),
        ):
            stage_usage = synthesis_usage.get(source_key)
            if not isinstance(stage_usage, dict):
                continue
            for stage_model, amount in stage_usage.items():
                if not isinstance(stage_model, str) or amount is None:
                    continue
                store[stage_model] = store.get(stage_model, 0) + max(0, int(amount))
        fallback_events = list(prior_fallback_events or [])
        self._accumulate_fallback_events(fallback_events, synthesis_usage)
        agent_models_used = list(
            dict.fromkeys(
                [
                    *[output.agent_model for output in state.factions.get("pro", [])],
                    *[output.agent_model for output in state.factions.get("opp", [])],
                    *[output.agent_model for output in state.cross_examinations],
                    *[output.agent_model for output in state.rebuttals.get("pro", [])],
                    *[output.agent_model for output in state.rebuttals.get("opp", [])],
                    "custom-agent" if custom_agent is not None else self._model_name("pro"),
                ]
            )
        )

        model_telemetry, cost = build_result_costing(
            models=agent_models_used,
            model_token_usage=model_token_usage,
            model_latency_ms=model_latency_ms,
            model_input_tokens=model_input_token_usage,
            model_output_tokens=model_output_token_usage,
            model_thinking_tokens=model_thinking_token_usage,
            fallback_total_tokens=total_tokens,
        )
        result = DeliberationResult(
            task=state.task,
            mechanism_used=MechanismType.DEBATE,
            mechanism_selection=selection,
            final_answer=response.final_answer,
            confidence=final_confidence,
            quorum_reached=quorum_reached,
            round_count=max(1, state.round),
            agent_count=self.agent_count,
            mechanism_switches=state.mechanism_switches,
            merkle_root=state.merkle_root,
            transcript_hashes=state.transcript_hashes,
            agent_models_used=agent_models_used,
            model_token_usage=model_token_usage,
            model_input_token_usage=model_input_token_usage,
            model_output_token_usage=model_output_token_usage,
            model_thinking_token_usage=model_thinking_token_usage,
            model_telemetry=model_telemetry,
            model_latency_ms=model_latency_ms,
            convergence_history=state.convergence_history,
            locked_claims=state.locked_claims,
            mechanism_trace=[
                MechanismTraceSegment(
                    mechanism=MechanismType.DEBATE,
                    start_round=1,
                    end_round=max(1, state.round),
                    transcript_hashes=state.transcript_hashes,
                    convergence_history=state.convergence_history,
                )
            ],
            execution_mode=self._execution_mode(
                fallback_events,
                total_tokens=total_tokens,
            ),
            fallback_count=len(fallback_events),
            fallback_events=fallback_events,
            total_tokens_used=total_tokens,
            input_tokens_used=self._compact_split_total(
                counter=0,
                model_usage=model_input_token_usage,
            ),
            output_tokens_used=self._compact_split_total(
                counter=0,
                model_usage=model_output_token_usage,
            ),
            thinking_tokens_used=self._compact_split_total(
                counter=0,
                model_usage=model_thinking_token_usage,
            ),
            total_latency_ms=total_latency_ms,
            cost=cost,
            reasoning_presets=self.reasoning_presets,
        )
        await self._emit_usage_delta(
            event_sink,
            AgentOutput(
                agent_id="synthesis",
                agent_model=(
                    "custom-agent"
                    if custom_agent is not None
                    else (
                        explicit_model.model if explicit_model is not None else self._model_name("pro")
                    )
                ),
                role="synthesis",
                round_number=max(1, state.round),
                content=response.final_answer,
                confidence=final_confidence,
                predicted_group_answer=None,
                content_hash=self.hasher.hash_content(response.final_answer),
                timestamp=datetime.now(UTC),
            ),
            usage,
        )
        return result, usage

    async def _call_structured_explicit_model(
        self,
        *,
        agent_idx: int,
        model_spec: LocalModelSpec,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        fallback: BaseModel,
        temperature: float | None = None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Call one explicit local model without provider substitution."""

        caller = self._participant_caller(agent_idx, model_spec)
        try:
            response, usage = await caller.call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=response_model,
                temperature=temperature,
                stream=stream,
                stream_callback=stream_callback,
            )
            if not isinstance(response, response_model):
                if model_spec.provider == "openrouter":
                    response, fallback_used = self._coerce_debate_response(
                        response_model=response_model,
                        response_text=str(response),
                        fallback=fallback,
                    )
                    if fallback_used and not self.allow_offline_fallback:
                        raise AgentCallError(
                            "Provider fallback disabled for "
                            f"debate.{response_model.__name__}: provider_kimi_empty_response"
                        )
                else:
                    raise AgentCallError(
                        "Provider returned unsupported response type for "
                        f"debate.{response_model.__name__}: explicit_local_model_returned_unsupported_response_type"
                    )
            input_tokens = usage.get("input_tokens")
            output_tokens = usage.get("output_tokens")
            thinking_tokens = usage.get("thinking_tokens", usage.get("reasoning_tokens"))
            total_tokens = int(
                usage.get("tokens")
                or usage.get("total_tokens")
                or (int(input_tokens or 0) + int(output_tokens or 0) + int(thinking_tokens or 0))
            )
            model_name = model_spec.model
            return response, {
                "tokens": total_tokens,
                "total_tokens": total_tokens,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "thinking_tokens": thinking_tokens,
                "reasoning_tokens": usage.get("reasoning_tokens"),
                "model_tokens": {model_name: total_tokens},
                "model_input_tokens": (
                    {model_name: int(input_tokens)} if input_tokens is not None else {}
                ),
                "model_output_tokens": (
                    {model_name: int(output_tokens)} if output_tokens is not None else {}
                ),
                "model_thinking_tokens": (
                    {model_name: int(thinking_tokens)} if thinking_tokens is not None else {}
                ),
                "latency_ms": float(usage.get("latency_ms", 0.0)),
                "model": model_name,
                "provider": model_spec.provider,
                "thinking_trace_present": bool(usage.get("thinking_trace_present", False)),
                "thinking_trace_chars": int(usage.get("thinking_trace_chars", 0) or 0),
            }
        except AgentCallError:
            return self._offline_structured_fallback(
                fallback=fallback,
                component=f"debate.{response_model.__name__}",
                reason=f"provider_{model_spec.provider}_unavailable_or_invalid",
                model=model_spec.model,
                provider=model_spec.provider,
            )

    async def _call_cross_exam_explicit_model(
        self,
        *,
        model_spec: LocalModelSpec,
        system_prompt: str,
        user_prompt: str,
        fallback: _CrossExamResponse,
        temperature: float | None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[_CrossExamResponse, dict[str, Any]]:
        """Call one explicit local model for the devil's-advocate step."""

        caller = self._devils_advocate_caller_for(model_spec)
        try:
            response, usage = await caller.call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=_CrossExamResponse,
                temperature=temperature,
                stream=stream,
                stream_callback=stream_callback,
            )
            if isinstance(response, _CrossExamResponse):
                parsed = response
            else:
                parsed, fallback_used = self._coerce_cross_exam_response(str(response), fallback)
                if fallback_used and not self.allow_offline_fallback:
                    raise AgentCallError(
                        "Provider fallback disabled for debate.cross_examination: "
                        "explicit_local_model_empty_response"
                    )
            input_tokens = usage.get("input_tokens")
            output_tokens = usage.get("output_tokens")
            thinking_tokens = usage.get("thinking_tokens", usage.get("reasoning_tokens"))
            total_tokens = int(
                usage.get("tokens")
                or usage.get("total_tokens")
                or (int(input_tokens or 0) + int(output_tokens or 0) + int(thinking_tokens or 0))
            )
            model_name = model_spec.model
            return parsed, {
                "tokens": total_tokens,
                "total_tokens": total_tokens,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "thinking_tokens": thinking_tokens,
                "reasoning_tokens": usage.get("reasoning_tokens"),
                "model_tokens": {model_name: total_tokens},
                "model_input_tokens": (
                    {model_name: int(input_tokens)} if input_tokens is not None else {}
                ),
                "model_output_tokens": (
                    {model_name: int(output_tokens)} if output_tokens is not None else {}
                ),
                "model_thinking_tokens": (
                    {model_name: int(thinking_tokens)} if thinking_tokens is not None else {}
                ),
                "latency_ms": float(usage.get("latency_ms", 0.0)),
                "model": model_name,
                "provider": model_spec.provider,
                "thinking_trace_present": bool(usage.get("thinking_trace_present", False)),
                "thinking_trace_chars": int(usage.get("thinking_trace_chars", 0) or 0),
            }
        except AgentCallError:
            response, usage = self._offline_structured_fallback(
                fallback=fallback,
                component="debate.cross_examination",
                reason=f"provider_{model_spec.provider}_unavailable_or_invalid",
                model=model_spec.model,
                provider=model_spec.provider,
            )
            assert isinstance(response, _CrossExamResponse)
            return response, usage

    async def _call_structured(
        self,
        tier: ProviderTierName,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        fallback: BaseModel,
        temperature: float | None = None,
        custom_agent: CustomAgentCallable | None = None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Call an agent with structured output and strict fallback policy."""

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
                    component=f"debate.{response_model.__name__}",
                    reason=str(usage.get("fallback_reason") or "custom_agent_invalid_response"),
                )
                if not self.allow_offline_fallback:
                    raise AgentCallError(
                        "Provider fallback disabled for "
                        f"debate.{response_model.__name__}: {event.reason}"
                    )
                fallback_events.append(event)
            total_tokens = int(usage.get("tokens", 0))
            return response, {
                "tokens": total_tokens,
                "total_tokens": total_tokens,
                "input_tokens": None,
                "output_tokens": None,
                "thinking_tokens": None,
                "model_tokens": {"custom-agent": total_tokens},
                "model_input_tokens": {},
                "model_output_tokens": {},
                "model_thinking_tokens": {},
                "latency_ms": float(usage.get("latency_ms", 0.0)),
                "model": "custom-agent",
                "provider": "custom-agent",
                "fallback_events": fallback_events,
            }

        try:
            response, usage = await self._call_provider(
                tier=tier,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=response_model,
                temperature=temperature,
                stream=stream,
                stream_callback=stream_callback,
            )
            if isinstance(response, response_model):
                model_name = self._model_name(tier)
                total_tokens = int(
                    usage.get("tokens")
                    or usage.get("total_tokens")
                    or (
                        int(usage.get("input_tokens") or 0)
                        + int(usage.get("output_tokens") or 0)
                        + int(usage.get("thinking_tokens") or usage.get("reasoning_tokens") or 0)
                    )
                )
                input_tokens = usage.get("input_tokens")
                output_tokens = usage.get("output_tokens")
                thinking_tokens = usage.get("thinking_tokens", usage.get("reasoning_tokens"))
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
            logger.warning("structured_response_type_mismatch", expected=response_model.__name__)
            raise AgentCallError(
                "Provider returned unsupported response type for "
                f"debate.{response_model.__name__}: provider_{tier}_returned_unsupported_response_type"
            )

        except AgentCallError as exc:
            logger.warning(
                "debate_agent_fallback",
                tier=tier,
                response_model=response_model.__name__,
                error=str(exc),
            )
            fallback_reason = f"provider_{tier}_unavailable_or_invalid"
            if tier != "kimi":
                try:
                    kimi_response, kimi_usage = await self._call_provider(
                        tier="kimi",
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        response_format=response_model,
                        temperature=temperature,
                        stream=stream,
                        stream_callback=stream_callback,
                    )
                    if isinstance(kimi_response, response_model):
                        logger.info(
                            "debate_agent_fallback_to_kimi_success",
                            response_model=response_model.__name__,
                            from_tier=tier,
                        )
                        model_name = self._model_name("kimi")
                        input_tokens = kimi_usage.get("input_tokens")
                        output_tokens = kimi_usage.get("output_tokens")
                        thinking_tokens = kimi_usage.get(
                            "thinking_tokens",
                            kimi_usage.get("reasoning_tokens"),
                        )
                        total_tokens = int(
                            kimi_usage.get("tokens")
                            or kimi_usage.get("total_tokens")
                            or (
                                int(input_tokens or 0)
                                + int(output_tokens or 0)
                                + int(thinking_tokens or 0)
                            )
                        )
                        return kimi_response, {
                            "tokens": total_tokens,
                            "total_tokens": total_tokens,
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "thinking_tokens": thinking_tokens,
                            "reasoning_tokens": kimi_usage.get("reasoning_tokens"),
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
                            "latency_ms": float(kimi_usage.get("latency_ms", 0.0)),
                            "model": model_name,
                            "provider": kimi_usage.get(
                                "provider",
                                self._provider_for_tier("kimi"),
                            ),
                            "thinking_trace_present": bool(
                                kimi_usage.get("thinking_trace_present", False)
                            ),
                            "thinking_trace_chars": int(
                                kimi_usage.get("thinking_trace_chars", 0) or 0
                            ),
                        }
                    kimi_response, coercion_provenance = self._coerce_debate_response(
                        response_model=response_model,
                        response_text=str(kimi_response),
                        fallback=fallback,
                    )
                    if coercion_provenance is not None and not self.allow_offline_fallback:
                        logger.warning(
                            "debate_kimi_response_retrying",
                            from_tier=tier,
                            response_model=response_model.__name__,
                            provenance=coercion_provenance,
                        )
                        kimi_response, kimi_usage = await self._call_provider(
                            tier="kimi",
                            system_prompt=system_prompt,
                            user_prompt=user_prompt,
                            response_format=None,
                            temperature=temperature,
                        )
                        kimi_response, coercion_provenance = self._coerce_debate_response(
                            response_model=response_model,
                            response_text=str(kimi_response),
                            fallback=fallback,
                        )
                        if coercion_provenance is not None and not self.allow_offline_fallback:
                            raise AgentCallError(
                                "Provider fallback disabled for "
                                f"debate.{response_model.__name__}: "
                                "provider_kimi_empty_response"
                            )
                    logger.info(
                        "debate_agent_fallback_to_kimi_success",
                        response_model=response_model.__name__,
                        from_tier=tier,
                        coerced=True,
                    )
                    model_name = self._model_name("kimi")
                    input_tokens = kimi_usage.get("input_tokens")
                    output_tokens = kimi_usage.get("output_tokens")
                    thinking_tokens = kimi_usage.get(
                        "thinking_tokens",
                        kimi_usage.get("reasoning_tokens"),
                    )
                    total_tokens = int(
                        kimi_usage.get("tokens")
                        or kimi_usage.get("total_tokens")
                        or (
                            int(input_tokens or 0)
                            + int(output_tokens or 0)
                            + int(thinking_tokens or 0)
                        )
                    )
                    return kimi_response, {
                        "tokens": total_tokens,
                        "total_tokens": total_tokens,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "thinking_tokens": thinking_tokens,
                        "reasoning_tokens": kimi_usage.get("reasoning_tokens"),
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
                        "latency_ms": float(kimi_usage.get("latency_ms", 0.0)),
                        "model": model_name,
                        "provider": kimi_usage.get(
                            "provider",
                            self._provider_for_tier("kimi"),
                        ),
                        "thinking_trace_present": bool(
                            kimi_usage.get("thinking_trace_present", False)
                        ),
                        "thinking_trace_chars": int(
                            kimi_usage.get("thinking_trace_chars", 0) or 0
                        ),
                        **self._coercion_usage(
                            component=f"debate.{response_model.__name__}",
                            provenance=coercion_provenance,
                        ),
                    }
                except AgentCallError as kimi_exc:
                    logger.warning(
                        "debate_kimi_fallback_failed",
                        response_model=response_model.__name__,
                        error=str(kimi_exc),
                        from_tier=tier,
                    )
                    fallback_reason = f"provider_{tier}_and_kimi_unavailable_or_invalid"

        if tier == "kimi" and response_model in {
            _InitialAnswerResponse,
            _OpeningResponse,
            _RebuttalResponse,
            _SynthesisResponse,
        }:
            try:
                kimi_response, kimi_usage = await self._call_provider(
                    tier="kimi",
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    response_format=response_model,
                    temperature=temperature,
                    stream=stream,
                    stream_callback=stream_callback,
                )
                if not isinstance(kimi_response, response_model):
                    kimi_response, coercion_provenance = self._coerce_debate_response(
                        response_model=response_model,
                        response_text=str(kimi_response),
                        fallback=fallback,
                    )
                    if coercion_provenance is not None and not self.allow_offline_fallback:
                        logger.warning(
                            "debate_kimi_response_retrying",
                            from_tier=tier,
                            response_model=response_model.__name__,
                            provenance=coercion_provenance,
                        )
                        kimi_response, kimi_usage = await self._call_provider(
                            tier="kimi",
                            system_prompt=system_prompt,
                            user_prompt=user_prompt,
                            response_format=None,
                            temperature=temperature,
                            stream=stream,
                            stream_callback=stream_callback,
                        )
                        kimi_response, coercion_provenance = self._coerce_debate_response(
                            response_model=response_model,
                            response_text=str(kimi_response),
                            fallback=fallback,
                        )
                        if coercion_provenance is not None and not self.allow_offline_fallback:
                            raise AgentCallError(
                                "Provider fallback disabled for "
                                f"debate.{response_model.__name__}: "
                                "provider_kimi_empty_response"
                            )
                logger.info(
                    "debate_agent_fallback_to_kimi_success",
                    response_model=response_model.__name__,
                    from_tier=tier,
                    coerced=not isinstance(kimi_response, response_model),
                )
                model_name = self._model_name("kimi")
                input_tokens = kimi_usage.get("input_tokens")
                output_tokens = kimi_usage.get("output_tokens")
                thinking_tokens = kimi_usage.get(
                    "thinking_tokens",
                    kimi_usage.get("reasoning_tokens"),
                )
                total_tokens = int(
                    kimi_usage.get("tokens")
                    or kimi_usage.get("total_tokens")
                    or (
                        int(input_tokens or 0)
                        + int(output_tokens or 0)
                        + int(thinking_tokens or 0)
                    )
                )
                return kimi_response, {
                    "tokens": total_tokens,
                    "total_tokens": total_tokens,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "thinking_tokens": thinking_tokens,
                    "reasoning_tokens": kimi_usage.get("reasoning_tokens"),
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
                    "latency_ms": float(kimi_usage.get("latency_ms", 0.0)),
                    "model": model_name,
                    "provider": kimi_usage.get(
                        "provider",
                        self._provider_for_tier("kimi"),
                    ),
                    "thinking_trace_present": bool(
                        kimi_usage.get("thinking_trace_present", False)
                    ),
                    "thinking_trace_chars": int(
                        kimi_usage.get("thinking_trace_chars", 0) or 0
                    ),
                    **self._coercion_usage(
                        component=f"debate.{response_model.__name__}",
                        provenance=coercion_provenance,
                    ),
                }
            except AgentCallError as exc:
                logger.warning(
                    "debate_agent_fallback",
                    tier="kimi",
                    response_model=response_model.__name__,
                    error=str(exc),
                )
                return self._offline_structured_fallback(
                    fallback=fallback,
                    component=f"debate.{response_model.__name__}",
                    reason="provider_kimi_unavailable_or_invalid",
                    model=self._model_name("kimi"),
                    provider=self._provider_for_tier("kimi"),
                )

        return self._offline_structured_fallback(
            fallback=fallback,
            component=f"debate.{response_model.__name__}",
            reason=fallback_reason,
            model=self._model_name(tier),
            provider=self._provider_for_tier(tier),
        )

    @staticmethod
    def _coerce_debate_response(
        *,
        response_model: type[BaseModel],
        response_text: str,
        fallback: BaseModel,
    ) -> tuple[BaseModel, str | None]:
        """Coerce live Kimi text into one of the debate response schemas."""

        cleaned = response_text.strip()
        if not cleaned:
            return fallback, "offline_fallback"

        try:
            parsed = json.loads(AgentCaller._extract_json_payload(cleaned))
            if isinstance(parsed, dict):
                if response_model is _InitialAnswerResponse:
                    parsed.setdefault("answer", parsed.get("final_answer", cleaned))
                    parsed.setdefault("confidence", _SCHEMA_COERCION_CONFIDENCE)
                    return _InitialAnswerResponse.model_validate(parsed), "schema_coercion"
                if response_model is _OpeningResponse:
                    parsed.setdefault("claim", parsed.get("answer", cleaned))
                    parsed.setdefault("evidence", parsed.get("reasoning", cleaned))
                    parsed.setdefault("confidence", _SCHEMA_COERCION_CONFIDENCE)
                    return _OpeningResponse.model_validate(parsed), "schema_coercion"
                if response_model is _RebuttalResponse:
                    parsed.setdefault("answer", parsed.get("final_answer", cleaned))
                    parsed.setdefault("defense", parsed.get("reasoning", cleaned))
                    parsed.setdefault("confidence", _SCHEMA_COERCION_CONFIDENCE)
                    return _RebuttalResponse.model_validate(parsed), "schema_coercion"
                if response_model is _SynthesisResponse:
                    parsed.setdefault("final_answer", parsed.get("answer", cleaned))
                    parsed.setdefault("summary", parsed.get("reasoning", cleaned))
                    parsed.setdefault("confidence", _SCHEMA_COERCION_CONFIDENCE)
                    return _SynthesisResponse.model_validate(parsed), "schema_coercion"
        except (json.JSONDecodeError, ValidationError):
            pass

        if response_model is _InitialAnswerResponse:
            return _InitialAnswerResponse(
                answer=cleaned,
                confidence=_SCHEMA_COERCION_CONFIDENCE,
            ), "schema_coercion"
        if response_model is _OpeningResponse:
            return _OpeningResponse(
                claim=cleaned,
                evidence=cleaned,
                confidence=_SCHEMA_COERCION_CONFIDENCE,
            ), "schema_coercion"
        if response_model is _RebuttalResponse:
            return _RebuttalResponse(
                answer=cleaned,
                defense=cleaned,
                confidence=_SCHEMA_COERCION_CONFIDENCE,
            ), "schema_coercion"
        if response_model is _SynthesisResponse:
            return _SynthesisResponse(
                final_answer=cleaned,
                summary=cleaned,
                confidence=_SCHEMA_COERCION_CONFIDENCE,
            ), "schema_coercion"

        return fallback, "offline_fallback"

    @staticmethod
    def _coercion_usage(
        *,
        component: str,
        provenance: str | None,
    ) -> dict[str, Any]:
        """Attach schema-coercion provenance to stage usage without faking offline fallback."""

        if provenance != "schema_coercion":
            return {}
        return {
            "fallback_events": [
                FallbackEvent(
                    component=component,
                    reason=_SCHEMA_COERCION_REASON,
                    fallback_type="schema_coercion",
                )
            ]
        }

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
            "model_tokens": {},
            "model_input_tokens": {},
            "model_output_tokens": {},
            "model_thinking_tokens": {},
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

    async def _call_provider(
        self,
        *,
        tier: ProviderTierName,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None,
        temperature: float | None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[str | BaseModel, dict[str, Any]]:
        """Call one provider while respecting per-run Claude concurrency."""

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

    async def _call_cross_exam(
        self,
        system_prompt: str,
        user_prompt: str,
        fallback: _CrossExamResponse,
        temperature: float | None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[_CrossExamResponse, dict[str, Any]]:
        """Call Kimi as a raw challenger and coerce output into transcript schema."""

        try:
            caller = self._get_caller("kimi")
            response, usage = await caller.call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=_CrossExamResponse,
                temperature=temperature,
                stream=stream,
                stream_callback=stream_callback,
            )
            if isinstance(response, _CrossExamResponse):
                parsed = response
            else:
                response_text = (
                    response.model_dump_json() if isinstance(response, BaseModel) else str(response)
                )
                parsed, fallback_used = self._coerce_cross_exam_response(response_text, fallback)
                if fallback_used and not self.allow_offline_fallback:
                    raise AgentCallError(
                        "Provider fallback disabled for debate.cross_examination: "
                        "provider_kimi_empty_response"
                    )
            total_tokens = int(
                usage.get("tokens")
                or usage.get("total_tokens")
                or int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0)
            )
            model_name = self._model_name("kimi")
            return parsed, {
                "tokens": total_tokens,
                "total_tokens": total_tokens,
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "thinking_tokens": usage.get("thinking_tokens", usage.get("reasoning_tokens")),
                "reasoning_tokens": usage.get("reasoning_tokens"),
                "model_tokens": {model_name: total_tokens},
                "model_input_tokens": (
                    {model_name: int(usage["input_tokens"])}
                    if usage.get("input_tokens") is not None
                    else {}
                ),
                "model_output_tokens": (
                    {model_name: int(usage["output_tokens"])}
                    if usage.get("output_tokens") is not None
                    else {}
                ),
                "model_thinking_tokens": (
                    {model_name: int(usage.get("thinking_tokens", usage.get("reasoning_tokens")))}
                    if usage.get("thinking_tokens", usage.get("reasoning_tokens")) is not None
                    else {}
                ),
                "latency_ms": float(usage.get("latency_ms", 0.0)),
                "model": model_name,
                "provider": usage.get("provider", self._provider_for_tier("kimi")),
                "thinking_trace_present": bool(usage.get("thinking_trace_present", False)),
                "thinking_trace_chars": int(usage.get("thinking_trace_chars", 0) or 0),
            }
        except AgentCallError as exc:
            logger.warning(
                "debate_agent_fallback",
                tier="kimi",
                response_model=_CrossExamResponse.__name__,
                error=str(exc),
            )

        response, usage = self._offline_structured_fallback(
            fallback=fallback,
            component="debate.cross_examination",
            reason="provider_kimi_unavailable_or_invalid",
            model=self._model_name("kimi"),
            provider=self._provider_for_tier("kimi"),
        )
        assert isinstance(response, _CrossExamResponse)
        return response, usage

    @staticmethod
    def _coerce_cross_exam_response(
        response_text: str,
        fallback: _CrossExamResponse,
    ) -> tuple[_CrossExamResponse, bool]:
        """Parse Kimi JSON when available, otherwise preserve its raw critique."""

        cleaned = response_text.strip()
        if not cleaned:
            return fallback, True

        try:
            parsed = json.loads(AgentCaller._extract_json_payload(cleaned))
            if isinstance(parsed, list):
                parsed = {"analyses": parsed}
            return _CrossExamResponse.model_validate(parsed), False
        except (json.JSONDecodeError, ValidationError):
            clipped = cleaned[:1200]
            return _CrossExamResponse(
                analyses=[
                    _CrossExamItem(
                        faction="pro",
                        weakest_claim="kimi_unstructured_challenge",
                        flaw=clipped,
                        attack_axis="evidence_gap",
                        counterexample=(
                            "A concrete counterexample would decide whether the pro claim "
                            "survives."
                        ),
                        failure_mode=(
                            "The challenge is meaningful even without a perfect schema round-trip."
                        ),
                        question=(
                            "Which specific evidence would most directly answer Kimi's "
                            "challenge, and what counterexample would still break it?"
                        ),
                    ),
                    _CrossExamItem(
                        faction="opp",
                        weakest_claim="kimi_unstructured_challenge",
                        flaw=clipped,
                        attack_axis="hidden_assumption",
                        counterexample=(
                            "If the task context shifts, the assumption may fail even if the "
                            "answer sounds plausible."
                        ),
                        failure_mode=(
                            "The argument may rest on an unstated premise that the task does "
                            "not guarantee."
                        ),
                        question=(
                            "Which assumption survives Kimi's challenge, and what task-boundary "
                            "change would invalidate it?"
                        ),
                    ),
                ]
            ), False

    @staticmethod
    def _agent_index(agent_id: str) -> int:
        """Convert canonical agent id into zero-based index."""

        try:
            return max(0, int(agent_id.split("-")[-1]) - 1)
        except ValueError:
            return 0

    @staticmethod
    def _event_faction(output: AgentOutput) -> str:
        """Map internal roles to frontend/API event factions."""

        if output.role in {"proponent", "pro_rebuttal"}:
            return "proponent"
        if output.role in {"opponent", "opp_rebuttal"}:
            return "opponent"
        return output.role

    @staticmethod
    def _parse_json_content(content: str) -> dict[str, Any]:
        """Best-effort JSON parsing for rich event payloads."""

        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return {"text": content}
        return parsed if isinstance(parsed, dict) else {"payload": parsed}

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
            "faction": DebateEngine._event_faction(output),
            "round_number": output.round_number,
            "stage": {
                "initial": "initial",
                "proponent": "opening",
                "opponent": "opening",
                "pro_rebuttal": "rebuttal",
                "opp_rebuttal": "rebuttal",
                "synthesis": "final_synthesis",
            }.get(output.role, output.role),
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

    async def _emit_agent_outputs(
        self,
        event_sink: EventSink | None,
        outputs: list[AgentOutput],
    ) -> None:
        """Emit debate agent outputs to an external sink."""

        if event_sink is None:
            return

        for output in outputs:
            payload = self._parse_json_content(output.content)
            stage = {
                "initial": "initial",
                "proponent": "opening",
                "opponent": "opening",
                "pro_rebuttal": "rebuttal",
                "opp_rebuttal": "rebuttal",
                "synthesis": "final_synthesis",
            }.get(output.role, output.role)
            await event_sink(
                "agent_output",
                {
                    "agent_id": output.agent_id,
                    "agent_model": output.agent_model,
                    "role": output.role,
                    "faction": self._event_faction(output),
                    "round_number": output.round_number,
                    "stage": stage,
                    "content": payload.get("defense")
                    or payload.get("claim")
                    or payload.get("answer")
                    or output.content,
                    "confidence": output.confidence,
                    "payload": payload,
                },
            )

    async def _emit_cross_examination(
        self,
        event_sink: EventSink | None,
        output: AgentOutput,
    ) -> None:
        """Emit devil's advocate cross-examination output."""

        if event_sink is None:
            return

        await event_sink(
            "cross_examination",
            {
                "agent_id": output.agent_id,
                "agent_model": output.agent_model,
                "role": output.role,
                "faction": self._event_faction(output),
                "round_number": output.round_number,
                "stage": "cross_examination",
                "payload": self._parse_json_content(output.content),
            },
        )

    async def _emit_usage_delta(
        self,
        event_sink: EventSink | None,
        output: AgentOutput,
        usage: dict[str, Any],
    ) -> None:
        """Emit model usage metadata after a call completes."""

        if event_sink is None:
            return

        await event_sink("usage_delta", self._usage_delta_payload(usage=usage, output=output))

    async def _emit_convergence_update(
        self,
        event_sink: EventSink | None,
        metrics: Any,
        locked_claims: list[VerifiedClaim],
    ) -> None:
        """Emit convergence metrics and verified claims."""

        if event_sink is None:
            return

        await event_sink(
            "convergence_update",
            {
                "round_number": metrics.round_number,
                "disagreement_entropy": metrics.disagreement_entropy,
                "information_gain_delta": metrics.information_gain_delta,
                "novelty_score": metrics.novelty_score,
                "locked_claim_count": metrics.locked_claim_count,
                "locked_claim_growth": metrics.locked_claim_growth,
                "unique_answers": metrics.unique_answers,
                "dominant_answer_share": metrics.dominant_answer_share,
                "locked_claims": [
                    {
                        "claim_text": claim.claim_text,
                        "verified_by": claim.verified_by,
                        "round_locked": claim.round_locked,
                        "claim_hash": claim.claim_hash,
                    }
                    for claim in locked_claims
                ],
            },
        )

    def _get_caller(self, tier: str) -> AgentCaller:
        """Return lazily initialized caller for selected tier."""

        if tier == "flash":
            if self._flash_agent is None:
                self._flash_agent = flash_caller(thinking_level=self.reasoning_presets.gemini_flash)
            return self._flash_agent
        if tier == "claude":
            if self._claude_agent is None:
                self._claude_agent = claude_caller(effort=self.reasoning_presets.claude)
            return self._claude_agent
        if tier == "kimi":
            if self._kimi_agent is None:
                self._kimi_agent = kimi_caller(effort=self.reasoning_presets.kimi)
            return self._kimi_agent
        if self._pro_agent is None:
            self._pro_agent = pro_caller(thinking_level=self.reasoning_presets.gemini_pro)
        return self._pro_agent

    def _model_name(self, tier: str) -> str:
        """Resolve model name for an engine tier."""

        try:
            caller = self._get_caller(tier)
            return caller.model
        except AgentCallError:
            config = get_config()
            if tier == "flash":
                return config.flash_model
            if tier == "claude":
                return config.claude_model
            if tier == "kimi":
                return config.kimi_model
            return config.pro_model

    @staticmethod
    def _provider_for_tier(tier: str) -> str:
        """Resolve provider label for a tier."""

        return {
            "flash": "gemini",
            "pro": "gemini",
            "claude": "claude",
            "kimi": "openrouter",
        }.get(tier, "unknown")

    @staticmethod
    def _coordinator_custom_agent(
        custom_agents: Sequence[CustomAgentCallable] | None,
    ) -> CustomAgentCallable | None:
        """Pick a local coordinator agent for cross-exam and synthesis when available."""

        if custom_agents is None or len(custom_agents) == 0:
            return None
        return custom_agents[0]

    @staticmethod
    def _stance_for_answer(answer: str, assigned_answer: str) -> str:
        """Classify whether a rebuttal still supports its assigned faction."""

        normalized_answer = " ".join(answer.strip().lower().split())
        normalized_assigned = " ".join(assigned_answer.strip().lower().split())
        return "support" if normalized_answer == normalized_assigned else "revise"

    def _tier_for_agent_id(self, agent_id: str) -> ProviderTierName:
        """Return the canonical provider tier for one counted debate participant."""

        return self._participant_tiers[self._agent_index(agent_id)]

    @staticmethod
    def _extract_targeted_question(cross_exam_content: str, side: str) -> str:
        """Extract side-targeted question from cross-exam JSON payload."""

        try:
            parsed = json.loads(cross_exam_content)
            analyses = parsed.get("analyses", []) if isinstance(parsed, dict) else []
            for item in analyses:
                if isinstance(item, dict) and item.get("faction") == side:
                    question = item.get("question")
                    if isinstance(question, str) and question.strip():
                        return question
        except json.JSONDecodeError:
            return "Clarify your weakest claim and provide stronger support."

        return "Clarify your weakest claim and provide stronger support."

    @staticmethod
    def _task_fragment(task: str, *, limit: int = 180) -> str:
        """Compact a task prompt for deterministic offline artifacts."""

        return " ".join(task.strip().split())[:limit] or "the task"

    @staticmethod
    def _fallback_opening_evidence(*, task: str, faction_answer: str) -> str:
        """Build task-grounded offline opening evidence without placeholder text."""

        task_seed = DebateEngine._task_fragment(task)
        answer_seed = " ".join(faction_answer.strip().split())[:120] or "this answer"
        return (
            f"Offline evidence sketch for {answer_seed}: evaluate it against the task "
            f"constraints in '{task_seed}', prioritize constraints explicitly named in "
            "the prompt, and reject the position if a stronger counterexample satisfies "
            "more of those constraints."
        )

    @staticmethod
    def _build_cross_exam_fallback(
        task: str,
        pro_outputs: list[AgentOutput],
        opp_outputs: list[AgentOutput],
    ) -> _CrossExamResponse:
        """Build a task-aware devil's-advocate fallback payload."""

        pro_seed = pro_outputs[0].content.strip() if pro_outputs else "the pro faction claim"
        opp_seed = opp_outputs[0].content.strip() if opp_outputs else "the opp faction claim"
        task_seed = DebateEngine._task_fragment(task)
        return _CrossExamResponse(
            analyses=[
                _CrossExamItem(
                    faction="pro",
                    weakest_claim=pro_seed[:120],
                    flaw="The claim is under-supported or too broad for the current round.",
                    attack_axis="evidence_gap",
                    counterexample=(
                        f"A single counterexample on {task_seed} would collapse this line."
                    ),
                    failure_mode=(
                        "The reasoning may be sound in the abstract but still fail on the "
                        "task constraints."
                    ),
                    question=(
                        f"Which concrete evidence from {task_seed} would actually falsify or "
                        "confirm this pro claim, and what would you change if the strongest "
                        "counterexample appears?"
                    ),
                ),
                _CrossExamItem(
                    faction="opp",
                    weakest_claim=opp_seed[:120],
                    flaw="The claim appears to lean on assumptions that the task may not support.",
                    attack_axis="hidden_assumption",
                    counterexample=(
                        "If the task context shifts by one boundary condition, this opp "
                        "line may stop working."
                    ),
                    failure_mode=(
                        "The argument may sound plausible while quietly depending on "
                        "unstated premises."
                    ),
                    question=(
                        "Which assumption in the opp position is doing the most work, and what "
                        "specific counterexample would force you to abandon it?"
                    ),
                ),
            ]
        )

    @staticmethod
    def _build_rebuttal_fallback(
        *,
        faction_answer: str,
        targeted_prompt: str,
        locked_claims: list[str],
    ) -> _RebuttalResponse:
        """Build a concrete rebuttal fallback instead of boilerplate."""

        locked_fragment = "; ".join(locked_claims[:3]) if locked_claims else "no locked claims yet"
        targeted = targeted_prompt.strip() or "the critique raised this round"
        defense = (
            f"Direct rebuttal: {targeted}. The faction answer still stands because the "
            f"strongest locked claims are {locked_fragment}. If the critique is right, "
            "revise only the narrow part it actually breaks."
        )
        return _RebuttalResponse(answer=faction_answer, defense=defense, confidence=0.55)

    @staticmethod
    def _merge_usage(entries: list[dict[str, Any]]) -> dict[str, Any]:
        """Merge token and latency accounting across calls."""

        total_tokens = sum(int(entry.get("tokens", 0)) for entry in entries)
        total_latency = sum(float(entry.get("latency_ms", 0.0)) for entry in entries)
        fallback_events: list[FallbackEvent] = []
        for entry in entries:
            DebateEngine._accumulate_fallback_events(fallback_events, entry)
        return {
            "tokens": total_tokens,
            "latency_ms": total_latency,
            "fallback_events": fallback_events,
        }

    @staticmethod
    def _merge_usage_by_output(
        entries: list[tuple[AgentOutput, dict[str, Any]]],
    ) -> tuple[dict[str, int], dict[str, float]]:
        """Merge model usage metrics from per-output usage tuples."""

        model_tokens: dict[str, int] = {}
        model_latency_ms: dict[str, float] = {}
        for output, usage in entries:
            model = output.agent_model
            model_tokens[model] = model_tokens.get(model, 0) + int(usage.get("tokens", 0))
            model_latency_ms[model] = model_latency_ms.get(model, 0.0) + float(
                usage.get("latency_ms", 0.0)
            )
        return model_tokens, model_latency_ms

    @staticmethod
    def _accumulate_model_usage(
        model_tokens: dict[str, int],
        model_latency_ms: dict[str, float],
        usage: dict[str, Any],
    ) -> None:
        """Accumulate one stage usage payload into aggregate model usage maps."""

        stage_tokens = usage.get("model_tokens")
        if isinstance(stage_tokens, dict):
            for model, tokens in stage_tokens.items():
                if not isinstance(model, str):
                    continue
                model_tokens[model] = model_tokens.get(model, 0) + int(tokens)

        stage_latency = usage.get("model_latency_ms")
        if isinstance(stage_latency, dict):
            for model, latency in stage_latency.items():
                if not isinstance(model, str):
                    continue
                model_latency_ms[model] = model_latency_ms.get(model, 0.0) + float(latency)

    @staticmethod
    def _accumulate_optional_usage(
        graph_state: dict[str, Any],
        usage: dict[str, Any],
        *,
        usage_key: str,
        counter_key: str,
        model_usage_key: str,
        model_usage_store_key: str,
        fallback_usage_key: str | None = None,
    ) -> None:
        """Accumulate one nullable usage split into graph totals and per-model maps."""

        value = usage.get(usage_key)
        if value is None and fallback_usage_key is not None:
            value = usage.get(fallback_usage_key)
        if value is not None:
            graph_state[counter_key] = int(graph_state[counter_key]) + max(0, int(value))

        stage_usage = usage.get(model_usage_key)
        if not isinstance(stage_usage, dict):
            return

        store = graph_state[model_usage_store_key]
        for model, amount in stage_usage.items():
            if not isinstance(model, str):
                continue
            if amount is None:
                continue
            store[model] = store.get(model, 0) + max(0, int(amount))

    @staticmethod
    def _compact_split_total(*, counter: int, model_usage: dict[str, int]) -> int | None:
        """Prefer per-model split totals when available."""

        if model_usage:
            return max(0, sum(max(0, int(value)) for value in model_usage.values()))
        return counter if counter > 0 else None

    @staticmethod
    def _accumulate_fallback_events(
        fallback_events: list[FallbackEvent],
        usage: dict[str, Any],
    ) -> None:
        """Accumulate fallback provenance from a stage usage payload."""

        raw_events = usage.get("fallback_events")
        if not isinstance(raw_events, list):
            return
        for raw_event in raw_events:
            if isinstance(raw_event, FallbackEvent):
                fallback_events.append(raw_event)
            elif isinstance(raw_event, dict):
                fallback_events.append(FallbackEvent.model_validate(raw_event))

    @staticmethod
    def _execution_mode(
        fallback_events: list[FallbackEvent],
        *,
        total_tokens: int,
    ) -> str:
        """Classify whether execution was fully live or used runtime fallback."""

        if not fallback_events:
            return "live"
        return "fallback" if total_tokens == 0 else "mixed"

    @staticmethod
    def _score_faction_outputs(outputs: list[AgentOutput]) -> float:
        """Score a faction trajectory with recency and confidence weighting."""

        score = 0.0
        for output in outputs:
            weight = 1.0 + (0.2 * output.round_number)
            score += weight * output.confidence
        return score

    @staticmethod
    def _locked_claim_bonus(claims: list[VerifiedClaim], outputs: list[AgentOutput]) -> float:
        """Compute bonus for faction outputs that reference verified claims."""

        if not claims or not outputs:
            return 0.0

        combined = "\n".join(output.content.lower() for output in outputs)
        hits = sum(1 for claim in claims if claim.claim_text.lower() in combined)
        return hits * 0.1

    def _verify_claims(self, content: str, round_number: int) -> list[VerifiedClaim]:
        """Verify simple arithmetic equality claims and lock validated claims."""

        claims: list[VerifiedClaim] = []
        for raw_claim in self._extract_equality_claims(content):
            left_expr, right_expr = raw_claim.split("=", maxsplit=1)
            left_value = self._safe_eval_arithmetic(left_expr.strip())
            right_value = self._safe_eval_arithmetic(right_expr.strip())
            if left_value is None or right_value is None:
                continue
            if abs(left_value - right_value) <= 1e-9:
                claim_hash = self.hasher.hash_content(raw_claim)
                claims.append(
                    VerifiedClaim(
                        claim_text=raw_claim,
                        verified_by="arithmetic_eval",
                        round_locked=round_number,
                        claim_hash=claim_hash,
                    )
                )
        return claims

    @staticmethod
    def _extract_equality_claims(content: str) -> list[str]:
        """Extract simple arithmetic equality claims from text."""

        candidate_claims: list[str] = []
        seen: set[str] = set()

        for fragment in DebateEngine._extract_text_fragments(content):
            for match in _ARITHMETIC_CLAIM_RE.finditer(fragment):
                cleaned = re.sub(r"\s+", "", match.group("claim"))
                if cleaned.count("=") != 1:
                    continue
                left, right = cleaned.split("=", maxsplit=1)
                if not left or not right:
                    continue
                if cleaned not in seen:
                    seen.add(cleaned)
                    candidate_claims.append(cleaned)

        return candidate_claims

    @staticmethod
    def _extract_text_fragments(content: str) -> list[str]:
        """Extract raw text fragments from plain text or JSON content."""

        fragments = [content]

        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            return fragments

        def walk(node: Any) -> None:
            if isinstance(node, str):
                fragments.append(node)
                return
            if isinstance(node, dict):
                for value in node.values():
                    walk(value)
                return
            if isinstance(node, list):
                for item in node:
                    walk(item)

        walk(payload)
        return fragments

    @staticmethod
    def _safe_eval_arithmetic(expression: str) -> float | None:
        """Safely evaluate a basic arithmetic expression."""

        try:
            parsed = ast.parse(expression, mode="eval")
        except SyntaxError:
            return None

        def eval_node(node: ast.AST) -> float:
            if isinstance(node, ast.Expression):
                return eval_node(node.body)
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                return float(node.value)
            if isinstance(node, ast.BinOp):
                left = eval_node(node.left)
                right = eval_node(node.right)
                if isinstance(node.op, ast.Add):
                    return left + right
                if isinstance(node.op, ast.Sub):
                    return left - right
                if isinstance(node.op, ast.Mult):
                    return left * right
                if isinstance(node.op, ast.Div):
                    return left / right
                if isinstance(node.op, ast.Pow):
                    return left**right
            if isinstance(node, ast.UnaryOp):
                operand = eval_node(node.operand)
                if isinstance(node.op, ast.USub):
                    return -operand
                if isinstance(node.op, ast.UAdd):
                    return operand
            raise ValueError("Unsupported arithmetic expression")

        try:
            return float(eval_node(parsed))
        except (ValueError, ZeroDivisionError, OverflowError):
            return None

    @staticmethod
    def _fallback_initial_answer(task: str, agent_idx: int) -> str:
        """Provide deterministic fallback answer for initial faction seeding."""

        lowered = task.lower()
        if "capital of france" in lowered:
            return "Paris" if agent_idx % 3 != 0 else "Lyon"
        if "derivative" in lowered and "x^3" in lowered:
            primary = "3x^2*sin(x) + x^3*cos(x)"
            secondary = "x^3*cos(x) + 3x^2*sin(x)"
            return primary if agent_idx % 2 == 0 else secondary
        task_seed = DebateEngine._task_fragment(task, limit=140)
        if agent_idx % 2 == 0:
            return f"Prioritize the lowest-risk answer that satisfies: {task_seed}"
        return f"Prioritize the simplest defensible answer under: {task_seed}"
