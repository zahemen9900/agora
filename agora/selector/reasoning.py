"""LLM reasoning wrapper around statistical mechanism selection."""

from __future__ import annotations

import hashlib
import json

import structlog
from pydantic import BaseModel, Field

from agora.agent import AgentCaller, AgentCallError, pro_caller
from agora.types import MechanismSelection, MechanismType, TaskFeatures

logger = structlog.get_logger(__name__)


class _ReasoningResponse(BaseModel):
    """Structured response format expected from the selector reasoning model."""

    mechanism: MechanismType
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


class ReasoningSelector:
    """Meta-reasoning selector that can agree with or override bandit recommendations."""

    def __init__(self, caller: AgentCaller | None = None) -> None:
        """Initialize selector.

        Args:
            caller: LLM caller for reasoning. Defaults to pro tier.
        """

        self._caller = caller

    async def select(
        self,
        task_text: str,
        features: TaskFeatures,
        bandit_recommendation: tuple[MechanismType, float],
        historical_performance: dict | None = None,
    ) -> MechanismSelection:
        """Select mechanism using LLM reasoning informed by bandit output.

        Args:
            task_text: Original task prompt.
            features: Extracted task features.
            bandit_recommendation: Tuple of mechanism and confidence from bandit.
            historical_performance: Optional aggregate performance context.

        Returns:
            MechanismSelection: Explainable mechanism choice with reasoning hash.
        """

        bandit_mechanism, bandit_confidence = bandit_recommendation

        system_prompt = (
            "You are the Agora Mechanism Selector, a meta-reasoning agent that decides "
            "HOW a group of AI agents should resolve a task. Available mechanisms: "
            "DEBATE (adversarial deliberation), VOTE (independent confidence-weighted "
            "aggregation), DELPHI (anonymous iterative refinement), MOA (layered synthesis). "
            "Choose the best mechanism for this specific task and explain your decision."
        )

        historical_payload = historical_performance or {
            "message": "Not yet available — system is still learning."
        }

        user_prompt = (
            "Task text:\n"
            f"{task_text}\n\n"
            "Extracted features:\n"
            f"{json.dumps(features.model_dump(mode='json'), indent=2)}\n\n"
            "Bandit recommendation:\n"
            f"- mechanism: {bandit_mechanism.value}\n"
            f"- confidence: {bandit_confidence:.4f}\n\n"
            "Historical performance:\n"
            f"{json.dumps(historical_payload, indent=2)}"
            "\n\n"
            "Respond with a JSON object in this exact schema:\n"
            '{"mechanism": "debate"|"vote"|"delphi"|"moa", '
            '"confidence": 0.0-1.0, "reasoning": "..."}'
        )

        try:
            response, _usage = await self._get_caller().call(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=_ReasoningResponse,
                temperature=0.3,
            )
            if not isinstance(response, _ReasoningResponse):
                raise AgentCallError(
                    "Unexpected structured output payload from reasoning selector."
                )

            reasoning_hash = hashlib.sha256(response.reasoning.encode("utf-8")).hexdigest()
            selection = MechanismSelection(
                mechanism=response.mechanism,
                confidence=response.confidence,
                reasoning=response.reasoning,
                reasoning_hash=reasoning_hash,
                bandit_recommendation=bandit_mechanism,
                bandit_confidence=bandit_confidence,
                task_features=features,
            )
            logger.info(
                "reasoning_selector_decision",
                mechanism=selection.mechanism.value,
                confidence=selection.confidence,
                bandit_recommendation=selection.bandit_recommendation.value,
                bandit_confidence=selection.bandit_confidence,
            )
            return selection
        except AgentCallError as exc:
            fallback_reasoning = (
                "Reasoning model unavailable; defaulting to Thompson Sampling recommendation "
                "to preserve availability."
            )
            reasoning_hash = hashlib.sha256(fallback_reasoning.encode("utf-8")).hexdigest()
            logger.warning(
                "reasoning_selector_fallback",
                reason="agent_call_error",
                error=str(exc),
                fallback_mechanism=bandit_mechanism.value,
            )
            return MechanismSelection(
                mechanism=bandit_mechanism,
                confidence=bandit_confidence,
                reasoning=fallback_reasoning,
                reasoning_hash=reasoning_hash,
                bandit_recommendation=bandit_mechanism,
                bandit_confidence=bandit_confidence,
                task_features=features,
            )

    def _get_caller(self) -> AgentCaller:
        """Return lazily initialized reasoning caller."""

        if self._caller is None:
            self._caller = pro_caller()
        return self._caller
