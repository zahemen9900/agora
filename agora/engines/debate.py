"""Factional debate engine with adaptive termination and switch signaling."""

from __future__ import annotations

import ast
import asyncio
import json
from collections import Counter
from datetime import UTC, datetime
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict, Field

from agora.agent import AgentCaller, AgentCallError, flash_caller, pro_caller
from agora.config import get_config
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.monitor import StateMonitor
from agora.types import (
    AgentOutput,
    DebateState,
    DeliberationResult,
    MechanismSelection,
    MechanismType,
    VerifiedClaim,
)

logger = structlog.get_logger(__name__)

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
        monitor: StateMonitor | None = None,
        hasher: TranscriptHasher | None = None,
    ) -> None:
        """Initialize debate engine dependencies.

        Args:
            agent_count: Number of debating agents.
            max_rounds: Maximum rounds before forced aggregation.
            flash_agent: Optional pre-configured generation caller.
            pro_agent: Optional pre-configured reasoning caller.
            monitor: Optional convergence monitor instance.
            hasher: Optional transcript hasher instance.
        """

        self.agent_count = max(3, agent_count)
        self.max_rounds = max(1, max_rounds)
        self._flash_agent = flash_agent
        self._pro_agent = pro_agent
        self.monitor = monitor or StateMonitor()
        self.hasher = hasher or TranscriptHasher()

        self.graph = self._build_graph() if StateGraph is not None else None

    async def run(self, task: str, selection: MechanismSelection) -> DebateEngineOutcome:
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

        initial_outputs, usage = await self._assign_initial_answers(task)
        token_counter += usage["tokens"]
        latency_ms += usage["latency_ms"]

        for output in initial_outputs:
            state.transcript_hashes.append(self.hasher.hash_agent_output(output))

        pro_answer, opp_answer, assignments, devil_advocate_id = self._assign_factions(
            initial_outputs
        )
        state.factions["pro"] = [
            output for output in initial_outputs if assignments[output.agent_id] == "pro"
        ]
        state.factions["opp"] = [
            output for output in initial_outputs if assignments[output.agent_id] == "opp"
        ]

        opening_outputs, usage = await self._opening_statements(
            task=task,
            assignments=assignments,
            pro_answer=pro_answer,
            opp_answer=opp_answer,
        )
        token_counter += usage["tokens"]
        latency_ms += usage["latency_ms"]
        for output in opening_outputs:
            state.transcript_hashes.append(self.hasher.hash_agent_output(output))
            if output.role == "proponent":
                state.factions["pro"].append(output)
            else:
                state.factions["opp"].append(output)

        latest_round_outputs = opening_outputs

        for round_number in range(1, self.max_rounds + 1):
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
            )
            token_counter += usage["tokens"]
            latency_ms += usage["latency_ms"]
            state.cross_examinations.append(cross_output)
            state.transcript_hashes.append(self.hasher.hash_agent_output(cross_output))

            rebuttal_outputs, usage = await self._rebuttal_round(
                task=task,
                round_number=round_number,
                assignments=assignments,
                cross_exam_output=cross_output,
                pro_answer=pro_answer,
                opp_answer=opp_answer,
                locked_claims=state.locked_claims,
            )
            token_counter += usage["tokens"]
            latency_ms += usage["latency_ms"]

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
            metrics = self.monitor.compute_metrics(round_outputs)
            state.convergence_history.append(metrics)
            state.round = round_number

            terminate, terminate_reason = self.monitor.should_terminate(state.convergence_history)
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
            if should_switch and suggested == MechanismType.VOTE:
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
        self, task: str
    ) -> tuple[list[AgentOutput], dict[str, float | int]]:
        """Generate independent initial answers for faction assignment."""

        async def one_call(agent_idx: int) -> tuple[AgentOutput, dict[str, Any]]:
            agent_id = f"agent-{agent_idx + 1}"
            system_prompt = (
                "Answer the task independently. Return your best concise answer and confidence."
            )
            user_prompt = task
            fallback = _InitialAnswerResponse(
                answer=self._fallback_initial_answer(task=task, agent_idx=agent_idx),
                confidence=0.55,
            )

            response, usage = await self._call_structured(
                tier="flash",
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_model=_InitialAnswerResponse,
                fallback=fallback,
            )
            assert isinstance(response, _InitialAnswerResponse)
            timestamp = datetime.now(UTC)
            content = response.answer
            return (
                AgentOutput(
                    agent_id=agent_id,
                    agent_model=self._model_name("flash"),
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
        return outputs, usage_totals

    def _assign_factions(
        self,
        outputs: list[AgentOutput],
    ) -> tuple[str, str, dict[str, str], str]:
        """Assign agents to pro/opp factions and pick a devil's advocate."""

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

        outlier = next(
            (
                output.agent_id
                for output in outputs
                if output.content.strip().lower() not in {pro_answer, opp_answer}
            ),
            None,
        )
        if outlier is not None:
            devil_advocate_id = outlier
        else:
            minority_side = "pro"
            pro_size = sum(1 for side in assignments.values() if side == "pro")
            opp_size = sum(1 for side in assignments.values() if side == "opp")
            if opp_size < pro_size:
                minority_side = "opp"
            devil_advocate_id = next(
                (agent_id for agent_id, side in assignments.items() if side == minority_side),
                outputs[0].agent_id,
            )

        return pro_answer, opp_answer, assignments, devil_advocate_id

    async def _opening_statements(
        self,
        task: str,
        assignments: dict[str, str],
        pro_answer: str,
        opp_answer: str,
    ) -> tuple[list[AgentOutput], dict[str, float | int]]:
        """Generate faction opening statements in parallel."""

        async def one_call(agent_id: str, side: str) -> tuple[AgentOutput, dict[str, Any]]:
            faction_answer = pro_answer if side == "pro" else opp_answer
            system_prompt = (
                "You are arguing for your assigned faction answer. Present strongest evidence. "
                "Return JSON with claim, evidence, confidence."
            )
            user_prompt = (
                f"Task: {task}\nAssigned faction answer: {faction_answer}\n"
                "Respond as {claim, evidence, confidence}."
            )
            fallback = _OpeningResponse(
                claim=faction_answer,
                evidence="Heuristic fallback evidence generated locally.",
                confidence=0.55,
            )
            response, usage = await self._call_structured(
                tier="flash",
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_model=_OpeningResponse,
                fallback=fallback,
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
                agent_model=self._model_name("flash"),
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
        return outputs, usage_totals

    async def _cross_examination(
        self,
        task: str,
        round_number: int,
        devil_advocate_id: str,
        pro_outputs: list[AgentOutput],
        opp_outputs: list[AgentOutput],
    ) -> tuple[AgentOutput, dict[str, Any]]:
        """Run devil's advocate cross-examination against both factions."""

        system_prompt = (
            "You are the Devil's Advocate. Your only job is to find flaws in both factions. "
            "For each faction provide weakest_claim, flaw, and targeted question."
        )
        user_prompt = (
            f"Task: {task}\n"
            f"Round: {round_number}\n"
            f"Pro statements: {[output.content for output in pro_outputs]}\n"
            f"Opp statements: {[output.content for output in opp_outputs]}\n"
            "Respond as {'analyses': [{'faction': 'pro'|'opp', 'weakest_claim': str, 'flaw': str, "
            "'question': str}]}"
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

        response, usage = await self._call_structured(
            tier="pro",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_model=_CrossExamResponse,
            fallback=fallback,
            temperature=0.2,
        )
        assert isinstance(response, _CrossExamResponse)
        content = json.dumps(response.model_dump(mode="json"), sort_keys=True)

        output = AgentOutput(
            agent_id=devil_advocate_id,
            agent_model=self._model_name("pro"),
            role="devil_advocate",
            round_number=round_number,
            content=content,
            confidence=0.8,
            predicted_group_answer=None,
            content_hash=self.hasher.hash_content(content),
            timestamp=datetime.now(UTC),
        )
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
    ) -> tuple[list[AgentOutput], dict[str, float | int]]:
        """Generate faction rebuttals responding to cross-examination."""

        async def one_call(agent_id: str, side: str) -> tuple[AgentOutput, dict[str, Any]]:
            faction_answer = pro_answer if side == "pro" else opp_answer
            targeted_prompt = self._extract_targeted_question(cross_exam_output.content, side)
            system_prompt = (
                "Defend your faction answer against targeted critique. "
                "Do not attack verified locked claims. Return answer, defense, confidence."
            )
            user_prompt = (
                f"Task: {task}\n"
                f"Faction answer: {faction_answer}\n"
                f"Targeted challenge: {targeted_prompt}\n"
                f"Locked claims: {[claim.claim_text for claim in locked_claims]}"
            )
            fallback = _RebuttalResponse(
                answer=faction_answer,
                defense="Fallback rebuttal: reinforce answer with concise rationale.",
                confidence=0.55,
            )
            response, usage = await self._call_structured(
                tier="flash",
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_model=_RebuttalResponse,
                fallback=fallback,
                temperature=0.4,
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
                agent_model=self._model_name("flash"),
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
        return outputs, usage_totals

    async def _final_aggregation(
        self,
        state: DebateState,
        selection: MechanismSelection,
        pro_answer: str,
        opp_answer: str,
        prior_tokens: int,
        prior_latency_ms: float,
    ) -> tuple[DeliberationResult, dict[str, float | int]]:
        """Aggregate trajectory, synthesize final answer, and build result."""

        pro_score = self._score_faction_outputs(
            state.factions.get("pro", []) + state.rebuttals.get("pro", [])
        )
        opp_score = self._score_faction_outputs(
            state.factions.get("opp", []) + state.rebuttals.get("opp", [])
        )

        pro_bonus = self._locked_claim_bonus(state.locked_claims, state.factions.get("pro", []))
        opp_bonus = self._locked_claim_bonus(state.locked_claims, state.factions.get("opp", []))
        pro_score += pro_bonus
        opp_score += opp_bonus

        total_score = pro_score + opp_score
        if total_score <= 0.0:
            total_score = 1.0

        winning_side = "pro" if pro_score >= opp_score else "opp"
        winning_answer = pro_answer if winning_side == "pro" else opp_answer
        winning_transcript = state.factions.get(winning_side, []) + state.rebuttals.get(
            winning_side, []
        )

        system_prompt = (
            "Synthesize the strongest cumulative argument from the winning faction into "
            "a final answer."
        )
        user_prompt = (
            f"Task: {state.task}\n"
            f"Winning faction: {winning_side}\n"
            f"Winning answer candidate: {winning_answer}\n"
            f"Faction transcript: {[output.content for output in winning_transcript]}"
        )
        fallback = _SynthesisResponse(
            final_answer=winning_answer,
            confidence=max(pro_score, opp_score) / total_score,
            summary="Fallback synthesis from trajectory scoring.",
        )

        response, usage = await self._call_structured(
            tier="pro",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_model=_SynthesisResponse,
            fallback=fallback,
            temperature=0.2,
        )
        assert isinstance(response, _SynthesisResponse)

        state.final_answer = response.final_answer
        state.merkle_root = self.hasher.build_merkle_tree(state.transcript_hashes)

        final_confidence = max(0.0, min(1.0, response.confidence))
        quorum_reached = final_confidence >= 0.6

        total_tokens = prior_tokens + int(usage["tokens"])
        total_latency_ms = prior_latency_ms + float(usage["latency_ms"])

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
            convergence_history=state.convergence_history,
            locked_claims=state.locked_claims,
            total_tokens_used=total_tokens,
            total_latency_ms=total_latency_ms,
        )
        return result, usage

    async def _call_structured(
        self,
        tier: str,
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        fallback: BaseModel,
        temperature: float | None = None,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Call an agent with structured output and graceful fallback."""

        try:
            caller = self._get_caller(tier)
            response, usage = await caller.call(
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
                }
            logger.warning("structured_response_type_mismatch", expected=response_model.__name__)
        except AgentCallError as exc:
            logger.warning(
                "debate_agent_fallback",
                tier=tier,
                response_model=response_model.__name__,
                error=str(exc),
            )

        return fallback, {"tokens": 0, "latency_ms": 0.0}

    def _get_caller(self, tier: str) -> AgentCaller:
        """Return lazily initialized caller for selected tier."""

        if tier == "flash":
            if self._flash_agent is None:
                self._flash_agent = flash_caller()
            return self._flash_agent
        if self._pro_agent is None:
            self._pro_agent = pro_caller()
        return self._pro_agent

    def _model_name(self, tier: str) -> str:
        """Resolve model name for an engine tier."""

        try:
            caller = self._get_caller(tier)
            return caller.model
        except AgentCallError:
            config = get_config()
            return config.flash_model if tier == "flash" else config.pro_model

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
    def _merge_usage(entries: list[dict[str, Any]]) -> dict[str, float | int]:
        """Merge token and latency accounting across calls."""

        total_tokens = sum(int(entry.get("tokens", 0)) for entry in entries)
        total_latency = sum(float(entry.get("latency_ms", 0.0)) for entry in entries)
        return {"tokens": total_tokens, "latency_ms": total_latency}

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
        tokens = content.replace("\n", " ").split()
        for token in tokens:
            if "=" in token:
                cleaned = token.strip(" ,.;:{}[]()")
                if cleaned.count("=") == 1:
                    left, right = cleaned.split("=", maxsplit=1)
                    if left and right:
                        candidate_claims.append(cleaned)
        return candidate_claims

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
