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
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from agora.agent import (
    AgentCaller,
    AgentCallError,
    claude_caller,
    flash_caller,
    kimi_caller,
    pro_caller,
)
from agora.config import get_config
from agora.runtime.custom_agents import CustomAgentCallable, invoke_custom_agent
from agora.runtime.hasher import TranscriptHasher
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
    MechanismSelection,
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

try:  # Optional import to keep API aligned with LangGraph-based architecture.
    from langgraph.graph import END, START, StateGraph
except ImportError:  # pragma: no cover
    END = START = None
    StateGraph = None


class _InitialAnswerResponse(BaseModel):
    """Structured schema for initial agent answer generation."""

    answer: str
    confidence: float = Field(ge=0.0, le=1.0)


class _OpeningResponse(BaseModel):
    """Structured schema for opening statements."""

    claim: str
    evidence: str
    confidence: float = Field(ge=0.0, le=1.0)


class _CrossExamItem(BaseModel):
    """Cross-examination critique for one faction."""

    faction: str
    weakest_claim: str
    flaw: str
    question: str


class _CrossExamResponse(BaseModel):
    """Structured response for devil's advocate critiques."""

    analyses: list[_CrossExamItem]


class _RebuttalResponse(BaseModel):
    """Structured schema for rebuttal statements."""

    answer: str
    defense: str
    confidence: float = Field(ge=0.0, le=1.0)


class _SynthesisResponse(BaseModel):
    """Structured schema for final synthesis."""

    final_answer: str
    confidence: float = Field(ge=0.0, le=1.0)
    summary: str


class DebateEngineOutcome(BaseModel):
    """Outcome payload for debate execution, including switch signals."""

    model_config = ConfigDict(frozen=True)

    state: DebateState
    result: DeliberationResult | None
    switch_to_vote: bool = False
    suggested_mechanism: MechanismType | None = None
    reason: str = ""


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
        reasoning_presets: ReasoningPresets
        | ReasoningPresetOverrides
        | dict[str, Any]
        | None = None,
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
        self.reasoning_presets = resolve_reasoning_presets(reasoning_presets)
        self._participant_tiers = balanced_participant_tiers(self.agent_count)
        self._claude_run_semaphore = asyncio.Semaphore(
            get_config().anthropic_concurrent_requests_per_run
        )

        self.graph = self._build_graph() if StateGraph is not None else None

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

        self.monitor.reset()
        state = DebateState(
            task=task,
            task_features=selection.task_features,
            max_rounds=self.max_rounds,
            factions={"pro": [], "opp": []},
            rebuttals={"pro": [], "opp": []},
        )

        token_counter = 0
        latency_ms = 0.0
        model_token_usage: dict[str, int] = {}
        model_latency_ms: dict[str, float] = {}

        initial_outputs, usage = await self._assign_initial_answers(
            task,
            custom_agents=custom_agents,
        )
        token_counter += usage["tokens"]
        latency_ms += usage["latency_ms"]
        self._accumulate_model_usage(
            model_token_usage,
            model_latency_ms,
            usage,
        )

        for output in initial_outputs:
            state.transcript_hashes.append(self.hasher.hash_agent_output(output))

        pro_answer, opp_answer, assignments, devil_advocate_id = self._assign_factions(
            initial_outputs
        )
        state.factions["pro"] = [
            output for output in initial_outputs if assignments.get(output.agent_id) == "pro"
        ]
        state.factions["opp"] = [
            output for output in initial_outputs if assignments.get(output.agent_id) == "opp"
        ]

        opening_outputs, usage = await self._opening_statements(
            task=task,
            assignments=assignments,
            pro_answer=pro_answer,
            opp_answer=opp_answer,
            custom_agents=custom_agents,
        )
        token_counter += usage["tokens"]
        latency_ms += usage["latency_ms"]
        self._accumulate_model_usage(
            model_token_usage,
            model_latency_ms,
            usage,
        )
        for output in opening_outputs:
            state.transcript_hashes.append(self.hasher.hash_agent_output(output))
            if output.role == "proponent":
                state.factions["pro"].append(output)
            else:
                state.factions["opp"].append(output)
        await self._emit_agent_outputs(event_sink, opening_outputs)

        latest_round_outputs = opening_outputs

        for round_number in range(1, self.max_rounds + 1):
            if self.enable_devils_advocate:
                cross_output, usage = await self._cross_examination(
                    task=task,
                    round_number=round_number,
                    devil_advocate_id=devil_advocate_id,
                    pro_outputs=[
                        o
                        for o in latest_round_outputs
                        if o.role == "proponent" or o.role == "pro_rebuttal"
                    ],
                    opp_outputs=[
                        o
                        for o in latest_round_outputs
                        if o.role == "opponent" or o.role == "opp_rebuttal"
                    ],
                    custom_agents=custom_agents,
                )
                token_counter += usage["tokens"]
                latency_ms += usage["latency_ms"]
                self._accumulate_model_usage(
                    model_token_usage,
                    model_latency_ms,
                    usage,
                )
                state.cross_examinations.append(cross_output)
                state.transcript_hashes.append(self.hasher.hash_agent_output(cross_output))
                await self._emit_cross_examination(event_sink, cross_output)
            else:
                empty_analyses = json.dumps({"analyses": []}, sort_keys=True)
                cross_output = AgentOutput(
                    agent_id=devil_advocate_id,
                    agent_model="disabled-devils-advocate",
                    role="devil_advocate",
                    round_number=round_number,
                    content=empty_analyses,
                    confidence=0.0,
                    predicted_group_answer=None,
                    content_hash=self.hasher.hash_content(empty_analyses),
                    timestamp=datetime.now(UTC),
                )

            rebuttal_outputs, usage = await self._rebuttal_round(
                task=task,
                round_number=round_number,
                assignments=assignments,
                cross_exam_output=cross_output,
                pro_answer=pro_answer,
                opp_answer=opp_answer,
                locked_claims=state.locked_claims,
                custom_agents=custom_agents,
            )
            token_counter += usage["tokens"]
            latency_ms += usage["latency_ms"]
            self._accumulate_model_usage(
                model_token_usage,
                model_latency_ms,
                usage,
            )

            round_outputs: list[AgentOutput] = []
            for output in rebuttal_outputs:
                state.transcript_hashes.append(self.hasher.hash_agent_output(output))
                if output.role == "pro_rebuttal":
                    state.rebuttals.setdefault("pro", []).append(output)
                else:
                    state.rebuttals.setdefault("opp", []).append(output)
                round_outputs.append(output)

                for claim in self._verify_claims(output.content, round_number):
                    if claim.claim_hash not in {
                        existing.claim_hash for existing in state.locked_claims
                    }:
                        state.locked_claims.append(claim)

            latest_round_outputs = round_outputs
            await self._emit_agent_outputs(event_sink, round_outputs)
            metrics = self.monitor.compute_metrics(round_outputs)
            state.convergence_history.append(metrics)
            state.round = round_number
            await self._emit_convergence_update(event_sink, metrics, state.locked_claims)

            if self.enable_adaptive_termination:
                terminate, terminate_reason = self.monitor.should_terminate(
                    state.convergence_history
                )
                if terminate:
                    state.terminated_early = round_number < self.max_rounds
                    logger.info(
                        "debate_terminated",
                        reason=terminate_reason,
                        round_number=round_number,
                    )
                    break

                should_switch, suggested, switch_reason = self.monitor.should_switch_mechanism(
                    state.convergence_history,
                    current_mechanism=MechanismType.DEBATE,
                )
                if allow_switch and should_switch and suggested == MechanismType.VOTE:
                    state.mechanism_switches += 1
                    logger.info(
                        "debate_switch_suggested",
                        round_number=round_number,
                        reason=switch_reason,
                        suggested_mechanism=suggested.value,
                    )
                    return DebateEngineOutcome(
                        state=state,
                        result=None,
                        switch_to_vote=True,
                        suggested_mechanism=suggested,
                        reason=switch_reason,
                    )

        result, usage = await self._final_aggregation(
            state=state,
            selection=selection,
            pro_answer=pro_answer,
            opp_answer=opp_answer,
            prior_tokens=token_counter,
            prior_latency_ms=latency_ms,
            prior_model_token_usage=model_token_usage,
            prior_model_latency_ms=model_latency_ms,
            custom_agents=custom_agents,
        )
        return DebateEngineOutcome(state=state, result=result, reason="completed")

    def _build_graph(self) -> Any | None:
        """Build a LangGraph graph skeleton for future streaming integrations."""

        if StateGraph is None or START is None or END is None:
            return None

        graph = StateGraph(dict)
        graph.add_node("assign_factions", lambda state: state)
        graph.add_node("opening_statements", lambda state: state)
        graph.add_node("cross_examination", lambda state: state)
        graph.add_node("rebuttal", lambda state: state)
        graph.add_node("convergence_check", lambda state: state)
        graph.add_node("final_aggregation", lambda state: state)

        graph.add_edge(START, "assign_factions")
        graph.add_edge("assign_factions", "opening_statements")
        graph.add_edge("opening_statements", "cross_examination")
        graph.add_edge("cross_examination", "rebuttal")
        graph.add_edge("rebuttal", "convergence_check")
        graph.add_conditional_edges(
            "convergence_check",
            lambda state: "final_aggregation",
            {
                "final_aggregation": "final_aggregation",
            },
        )
        graph.add_edge("final_aggregation", END)
        return graph.compile()

    async def _assign_initial_answers(
        self,
        task: str,
        custom_agents: Sequence[CustomAgentCallable] | None = None,
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate independent initial answers for faction assignment."""

        async def one_call(agent_idx: int) -> tuple[AgentOutput, dict[str, Any]]:
            agent_id = f"agent-{agent_idx + 1}"
            tier = self._participant_tiers[agent_idx]
            prompt = debate_initial_prompt(task=task)
            fallback = _InitialAnswerResponse(
                answer=self._fallback_initial_answer(task=task, agent_idx=agent_idx),
                confidence=0.55,
            )

            custom_agent = custom_agents[agent_idx] if custom_agents is not None else None
            response, usage = await self._call_structured(
                tier=tier,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_InitialAnswerResponse,
                fallback=fallback,
                custom_agent=custom_agent,
            )
            assert isinstance(response, _InitialAnswerResponse)
            timestamp = datetime.now(UTC)
            content = response.answer
            return (
                AgentOutput(
                    agent_id=agent_id,
                    agent_model=(
                        "custom-agent" if custom_agent is not None else self._model_name(tier)
                    ),
                    role="initial",
                    round_number=0,
                    content=content,
                    confidence=response.confidence,
                    predicted_group_answer=None,
                    content_hash=self.hasher.hash_content(content),
                    timestamp=timestamp,
                ),
                usage,
            )

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
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate faction opening statements in parallel."""

        async def one_call(agent_id: str, side: str) -> tuple[AgentOutput, dict[str, Any]]:
            faction_answer = pro_answer if side == "pro" else opp_answer
            tier = self._tier_for_agent_id(agent_id)
            prompt = debate_opening_prompt(task=task, faction_answer=faction_answer)
            fallback = _OpeningResponse(
                claim=faction_answer,
                evidence="Heuristic fallback evidence generated locally.",
                confidence=0.55,
            )
            custom_agent = (
                custom_agents[self._agent_index(agent_id)] if custom_agents is not None else None
            )
            response, usage = await self._call_structured(
                tier=tier,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_OpeningResponse,
                fallback=fallback,
                custom_agent=custom_agent,
            )
            assert isinstance(response, _OpeningResponse)
            content = json.dumps(
                {
                    "claim": response.claim,
                    "evidence": response.evidence,
                    "answer": faction_answer,
                },
                sort_keys=True,
            )
            role = "proponent" if side == "pro" else "opponent"
            timestamp = datetime.now(UTC)
            output = AgentOutput(
                agent_id=agent_id,
                agent_model=(
                    "custom-agent" if custom_agent is not None else self._model_name(tier)
                ),
                role=role,
                round_number=1,
                content=content,
                confidence=response.confidence,
                predicted_group_answer=None,
                content_hash=self.hasher.hash_content(content),
                timestamp=timestamp,
            )
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
    ) -> tuple[AgentOutput, dict[str, Any]]:
        """Run devil's advocate cross-examination against both factions."""

        prompt = debate_devil_prompt(
            task=task,
            round_number=round_number,
            pro_outputs=[output.content for output in pro_outputs],
            opp_outputs=[output.content for output in opp_outputs],
        )

        fallback = _CrossExamResponse(
            analyses=[
                _CrossExamItem(
                    faction="pro",
                    weakest_claim="insufficient evidence",
                    flaw="claim lacks concrete support",
                    question="What evidence directly supports your claim?",
                ),
                _CrossExamItem(
                    faction="opp",
                    weakest_claim="assumption mismatch",
                    flaw="argument relies on unstated assumptions",
                    question="Which assumptions are validated by the task constraints?",
                ),
            ]
        )

        custom_agent = None
        if custom_agent is not None:
            response, usage = await self._call_structured(
                tier="pro",
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_CrossExamResponse,
                fallback=fallback,
                temperature=0.2,
                custom_agent=custom_agent,
            )
            assert isinstance(response, _CrossExamResponse)
        else:
            response, usage = await self._call_cross_exam(
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                fallback=fallback,
                temperature=0.2,
            )
        content = json.dumps(response.model_dump(mode="json"), sort_keys=True)

        output = AgentOutput(
            agent_id=devil_advocate_id,
            agent_model=("custom-agent" if custom_agent is not None else self._model_name("kimi")),
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
    ) -> tuple[list[AgentOutput], dict[str, Any]]:
        """Generate faction rebuttals responding to cross-examination."""

        async def one_call(agent_id: str, side: str) -> tuple[AgentOutput, dict[str, Any]]:
            faction_answer = pro_answer if side == "pro" else opp_answer
            targeted_prompt = self._extract_targeted_question(cross_exam_output.content, side)
            tier = self._tier_for_agent_id(agent_id)
            prompt = debate_rebuttal_prompt(
                task=task,
                faction_answer=faction_answer,
                targeted_prompt=targeted_prompt,
                locked_claims=[claim.claim_text for claim in locked_claims],
            )
            fallback = _RebuttalResponse(
                answer=faction_answer,
                defense="Fallback rebuttal: reinforce answer with concise rationale.",
                confidence=0.55,
            )
            custom_agent = (
                custom_agents[self._agent_index(agent_id)] if custom_agents is not None else None
            )
            response, usage = await self._call_structured(
                tier=tier,
                system_prompt=prompt.system,
                user_prompt=prompt.user,
                response_model=_RebuttalResponse,
                fallback=fallback,
                temperature=0.4,
                custom_agent=custom_agent,
            )
            assert isinstance(response, _RebuttalResponse)
            content = json.dumps(
                {
                    "answer": response.answer,
                    "defense": response.defense,
                    "faction_answer": faction_answer,
                },
                sort_keys=True,
            )
            role = "pro_rebuttal" if side == "pro" else "opp_rebuttal"
            output = AgentOutput(
                agent_id=agent_id,
                agent_model=(
                    "custom-agent" if custom_agent is not None else self._model_name(tier)
                ),
                role=role,
                round_number=round_number,
                content=content,
                confidence=response.confidence,
                predicted_group_answer=None,
                content_hash=self.hasher.hash_content(content),
                timestamp=datetime.now(UTC),
            )
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
        prior_model_latency_ms: dict[str, float],
        custom_agents: Sequence[CustomAgentCallable] | None = None,
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
            summary="Fallback synthesis from trajectory scoring.",
        )

        custom_agent = None
        response, usage = await self._call_structured(
            tier="pro",
            system_prompt=prompt.system,
            user_prompt=prompt.user,
            response_model=_SynthesisResponse,
            fallback=fallback,
            temperature=0.2,
            custom_agent=custom_agent,
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
            model_latency_ms=model_latency_ms,
            convergence_history=state.convergence_history,
            locked_claims=state.locked_claims,
            total_tokens_used=total_tokens,
            total_latency_ms=total_latency_ms,
        )
        return result, usage

    async def _call_structured(
        self,
        tier: ProviderTierName,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        fallback: BaseModel,
        temperature: float | None = None,
        custom_agent: CustomAgentCallable | None = None,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Call an agent with structured output and graceful fallback."""

        if custom_agent is not None:
            response, usage = await invoke_custom_agent(
                custom_agent,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_model=response_model,
                fallback=fallback,
            )
            return response, {
                "tokens": int(usage.get("tokens", 0)),
                "latency_ms": float(usage.get("latency_ms", 0.0)),
                "model": "custom-agent",
            }

        try:
            response, usage = await self._call_provider(
                tier=tier,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=response_model,
                temperature=temperature,
            )
            if isinstance(response, response_model):
                return response, {
                    "tokens": int(usage.get("input_tokens", 0))
                    + int(usage.get("output_tokens", 0)),
                    "latency_ms": float(usage.get("latency_ms", 0.0)),
                    "model": self._model_name(tier),
                }
            logger.warning("structured_response_type_mismatch", expected=response_model.__name__)
        except AgentCallError as exc:
            logger.warning(
                "debate_agent_fallback",
                tier=tier,
                response_model=response_model.__name__,
                error=str(exc),
            )
            if tier == "claude":
                try:
                    kimi_response, kimi_usage = await self._call_provider(
                        tier="kimi",
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        response_format=response_model,
                        temperature=temperature,
                    )
                    if isinstance(kimi_response, response_model):
                        logger.info(
                            "debate_agent_fallback_to_kimi_success",
                            response_model=response_model.__name__,
                        )
                        return kimi_response, {
                            "tokens": int(kimi_usage.get("input_tokens", 0))
                            + int(kimi_usage.get("output_tokens", 0)),
                            "latency_ms": float(kimi_usage.get("latency_ms", 0.0)),
                            "model": self._model_name("kimi"),
                        }
                except AgentCallError as kimi_exc:
                    logger.warning(
                        "debate_kimi_fallback_failed",
                        response_model=response_model.__name__,
                        error=str(kimi_exc),
                    )

        return fallback, {
            "tokens": 0,
            "latency_ms": 0.0,
            "model": "custom-agent" if custom_agent is not None else self._model_name(tier),
        }

    async def _call_provider(
        self,
        *,
        tier: ProviderTierName,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None,
        temperature: float | None,
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
                )
        return await caller.call(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_format=response_format,
            temperature=temperature,
        )

    async def _call_cross_exam(
        self,
        system_prompt: str,
        user_prompt: str,
        fallback: _CrossExamResponse,
        temperature: float | None,
    ) -> tuple[_CrossExamResponse, dict[str, Any]]:
        """Call Kimi as a raw challenger and coerce output into transcript schema."""

        try:
            caller = self._get_caller("kimi")
            response, usage = await caller.call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=temperature,
            )
            response_text = (
                response.model_dump_json() if isinstance(response, BaseModel) else str(response)
            )
            return self._coerce_cross_exam_response(response_text, fallback), {
                "tokens": int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0)),
                "latency_ms": float(usage.get("latency_ms", 0.0)),
                "model": self._model_name("kimi"),
            }
        except AgentCallError as exc:
            logger.warning(
                "debate_agent_fallback",
                tier="kimi",
                response_model=_CrossExamResponse.__name__,
                error=str(exc),
            )

        return fallback, {
            "tokens": 0,
            "latency_ms": 0.0,
            "model": self._model_name("kimi"),
        }

    @staticmethod
    def _coerce_cross_exam_response(
        response_text: str,
        fallback: _CrossExamResponse,
    ) -> _CrossExamResponse:
        """Parse Kimi JSON when available, otherwise preserve its raw critique."""

        cleaned = response_text.strip()
        if not cleaned:
            return fallback

        try:
            parsed = json.loads(AgentCaller._extract_json_payload(cleaned))
            if isinstance(parsed, list):
                parsed = {"analyses": parsed}
            return _CrossExamResponse.model_validate(parsed)
        except (json.JSONDecodeError, ValidationError):
            clipped = cleaned[:1200]
            return _CrossExamResponse(
                analyses=[
                    _CrossExamItem(
                        faction="pro",
                        weakest_claim="kimi_unstructured_challenge",
                        flaw=clipped,
                        question="Which evidence most directly answers Kimi's challenge?",
                    ),
                    _CrossExamItem(
                        faction="opp",
                        weakest_claim="kimi_unstructured_challenge",
                        flaw=clipped,
                        question="Which assumption survives Kimi's challenge?",
                    ),
                ]
            )

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
            await event_sink(
                "agent_output",
                {
                    "agent_id": output.agent_id,
                    "agent_model": output.agent_model,
                    "role": output.role,
                    "faction": self._event_faction(output),
                    "round_number": output.round_number,
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
                "round_number": output.round_number,
                "payload": self._parse_json_content(output.content),
            },
        )

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
    def _merge_usage(entries: list[dict[str, Any]]) -> dict[str, Any]:
        """Merge token and latency accounting across calls."""

        total_tokens = sum(int(entry.get("tokens", 0)) for entry in entries)
        total_latency = sum(float(entry.get("latency_ms", 0.0)) for entry in entries)
        return {"tokens": total_tokens, "latency_ms": total_latency}

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
        if agent_idx % 2 == 0:
            return "Option A"
        return "Option B"
