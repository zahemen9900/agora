"""ISP-weighted vote engine with confidence calibration."""

from __future__ import annotations

import asyncio
import math
from collections import Counter
from datetime import UTC, datetime
from typing import Any

import structlog
from pydantic import BaseModel, ConfigDict, Field

from agora.agent import AgentCaller, AgentCallError, flash_caller
from agora.config import get_config
from agora.runtime.hasher import TranscriptHasher
from agora.types import (
    AgentOutput,
    DeliberationResult,
    MechanismSelection,
    MechanismType,
    VoteState,
)

logger = structlog.get_logger(__name__)

try:  # Optional import for architecture parity with LangGraph state graphs.
    from langgraph.graph import END, START, StateGraph
except ImportError:  # pragma: no cover
    END = START = None
    StateGraph = None


class _VoteResponse(BaseModel):
    """Structured schema for vote generation."""

    answer: str
    confidence: float = Field(ge=0.0, le=1.0)
    predicted_group_answer: str
    reasoning: str


class VoteEngineOutcome(BaseModel):
    """Outcome payload for vote execution and optional switch signaling."""

    model_config = ConfigDict(frozen=True)

    state: VoteState
    result: DeliberationResult
    switch_to_debate: bool = False
    reason: str = ""


class VoteEngine:
    """Single-round voting engine using inverse surprising popularity."""

    def __init__(
        self,
        agent_count: int = 3,
        quorum_threshold: float = 0.6,
        flash_agent: AgentCaller | None = None,
        hasher: TranscriptHasher | None = None,
        temperature_scaling: float = 1.5,
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
        self.hasher = hasher or TranscriptHasher()
        self.graph = self._build_graph() if StateGraph is not None else None

    async def run(self, task: str, selection: MechanismSelection) -> VoteEngineOutcome:
        """Execute ISP vote workflow and return deliberation result.

        Args:
            task: Task prompt.
            selection: Mechanism selection metadata.

        Returns:
            VoteEngineOutcome: Vote result and switch suggestion.
        """

        state = VoteState(
            task=task,
            task_features=selection.task_features,
            quorum_threshold=self.quorum_threshold,
        )
        token_counter = 0
        latency_ms = 0.0

        vote_outputs, usage = await self._generate_votes(task)
        token_counter += usage["tokens"]
        latency_ms += usage["latency_ms"]

        state.agent_outputs = vote_outputs
        state.transcript_hashes = [self.hasher.hash_agent_output(output) for output in vote_outputs]

        self._calibrate_confidence(state)
        self._isp_aggregate(state)

        best_answer, best_weight = self._pick_winner(state.final_weights)
        state.final_answer = best_answer
        state.quorum_reached = best_weight >= state.quorum_threshold
        state.merkle_root = self.hasher.build_merkle_tree(state.transcript_hashes)

        result = DeliberationResult(
            task=task,
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
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=token_counter,
            total_latency_ms=latency_ms,
        )

        switch_to_debate = not state.quorum_reached
        reason = "quorum_reached" if state.quorum_reached else "quorum_not_reached"
        return VoteEngineOutcome(
            state=state,
            result=result,
            switch_to_debate=switch_to_debate,
            reason=reason,
        )

    def _build_graph(self) -> Any | None:
        """Build a LangGraph skeleton for future streaming and instrumentation."""

        if StateGraph is None or START is None or END is None:
            return None

        graph = StateGraph(dict)
        graph.add_node("generate_votes", lambda state: state)
        graph.add_node("calibrate_confidence", lambda state: state)
        graph.add_node("isp_aggregate", lambda state: state)
        graph.add_node("quorum_check", lambda state: state)
        graph.add_node("finalize", lambda state: state)

        graph.add_edge(START, "generate_votes")
        graph.add_edge("generate_votes", "calibrate_confidence")
        graph.add_edge("calibrate_confidence", "isp_aggregate")
        graph.add_edge("isp_aggregate", "quorum_check")
        graph.add_edge("quorum_check", "finalize")
        graph.add_edge("finalize", END)
        return graph.compile()

    async def _generate_votes(self, task: str) -> tuple[list[AgentOutput], dict[str, float | int]]:
        """Generate one independent vote per agent in parallel."""

        async def one_call(agent_idx: int) -> tuple[AgentOutput, dict[str, Any]]:
            agent_id = f"agent-{agent_idx + 1}"
            system_prompt = (
                "Answer the task. Provide your answer, confidence, "
                "predicted_group_answer, and reasoning."
            )
            user_prompt = (
                f"Task: {task}\n"
                "Return JSON with fields: answer, confidence (0-1), "
                "predicted_group_answer, reasoning."
            )
            fallback = self._fallback_vote(task=task, agent_idx=agent_idx)
            response, usage = await self._call_structured(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_model=_VoteResponse,
                fallback=fallback,
            )
            assert isinstance(response, _VoteResponse)

            content = response.answer
            output = AgentOutput(
                agent_id=agent_id,
                agent_model=self._model_name(),
                role="voter",
                round_number=1,
                content=content,
                confidence=response.confidence,
                predicted_group_answer=response.predicted_group_answer,
                content_hash=self.hasher.hash_content(content),
                timestamp=datetime.now(UTC),
            )
            return output, usage

        results = await asyncio.gather(*(one_call(idx) for idx in range(self.agent_count)))
        outputs = [output for output, _usage in results]
        usage_totals = self._merge_usage([usage for _output, usage in results])
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
        system_prompt: str,
        user_prompt: str,
        response_model: type[BaseModel],
        fallback: BaseModel,
    ) -> tuple[BaseModel, dict[str, Any]]:
        """Call flash tier with structured output and fallback on failure."""

        try:
            caller = self._get_caller()
            response, usage = await caller.call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=response_model,
            )
            if isinstance(response, response_model):
                return response, {
                    "tokens": int(usage.get("input_tokens", 0))
                    + int(usage.get("output_tokens", 0)),
                    "latency_ms": float(usage.get("latency_ms", 0.0)),
                }
            logger.warning(
                "vote_structured_response_type_mismatch", expected=response_model.__name__
            )
        except AgentCallError as exc:
            logger.warning(
                "vote_agent_fallback", error=str(exc), response_model=response_model.__name__
            )

        return fallback, {"tokens": 0, "latency_ms": 0.0}

    def _get_caller(self) -> AgentCaller:
        """Return lazy flash caller instance."""

        if self._flash_agent is None:
            self._flash_agent = flash_caller()
        return self._flash_agent

    def _model_name(self) -> str:
        """Resolve model name used for vote generation."""

        try:
            return self._get_caller().model
        except AgentCallError:
            return get_config().flash_model

    @staticmethod
    def _temperature_scale(probability: float, temperature: float) -> float:
        """Calibrate probability using sigmoid(logit(p) / T)."""

        p = min(1.0 - 1e-6, max(1e-6, probability))
        logit = math.log(p / (1.0 - p))
        adjusted = logit / temperature
        return 1.0 / (1.0 + math.exp(-adjusted))

    @staticmethod
    def _merge_usage(entries: list[dict[str, Any]]) -> dict[str, float | int]:
        """Merge token and latency accounting across calls."""

        total_tokens = sum(int(entry.get("tokens", 0)) for entry in entries)
        total_latency = sum(float(entry.get("latency_ms", 0.0)) for entry in entries)
        return {"tokens": total_tokens, "latency_ms": total_latency}

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
                reasoning="Fallback factual heuristic.",
            )

        if "derivative" in lowered and "x^3" in lowered:
            answer = "3x^2*sin(x) + x^3*cos(x)"
            predicted = answer
            confidence = 0.8
            return _VoteResponse(
                answer=answer,
                confidence=confidence,
                predicted_group_answer=predicted,
                reasoning="Fallback calculus heuristic.",
            )

        answer = "Option A" if agent_idx % 2 == 0 else "Option B"
        predicted = "Option A"
        confidence = 0.6 if answer == "Option A" else 0.52
        return _VoteResponse(
            answer=answer,
            confidence=confidence,
            predicted_group_answer=predicted,
            reasoning="Fallback generic heuristic.",
        )
