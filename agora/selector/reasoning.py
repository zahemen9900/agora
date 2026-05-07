"""LLM reasoning wrapper around statistical mechanism selection."""

from __future__ import annotations

import hashlib
from typing import Literal

import structlog
from pydantic import BaseModel, Field

from agora.agent import AgentCaller, AgentCallError, pro_caller
from agora.runtime.provider_errors import provider_error_details, should_try_alternate_live_model
from agora.runtime.prompt_policy import selector_prompt
from agora.types import MechanismSelection, MechanismType, TaskFeatures

logger = structlog.get_logger(__name__)


class _ReasoningResponse(BaseModel):
    """Structured response format expected from the selector reasoning model."""

    mechanism: Literal["debate", "vote", "delphi"]
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


class ReasoningSelector:
    """Meta-reasoning selector that can agree with or override bandit recommendations."""

    def __init__(
        self,
        caller: AgentCaller | None = None,
        fallback_callers: list[AgentCaller] | None = None,
    ) -> None:
        """Initialize selector.

        Args:
            caller: LLM caller for reasoning. Defaults to pro tier.
        """

        self._caller = caller
        self._fallback_callers = list(fallback_callers or [])

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

        historical_payload = historical_performance or {
            "message": "Not yet available — system is still learning."
        }
        prompt = selector_prompt(
            task_text=task_text,
            features=features,
            bandit_mechanism=bandit_mechanism,
            bandit_confidence=bandit_confidence,
            historical_payload=historical_payload,
        )

        callers = self._candidate_callers()
        last_error: AgentCallError | None = None
        response: _ReasoningResponse | None = None
        for index, caller in enumerate(callers):
            try:
                raw_response, _usage = await caller.call(
                    system_prompt=prompt.system,
                    user_prompt=prompt.user,
                    response_format=_ReasoningResponse,
                    temperature=0.3,
                )
                if not isinstance(raw_response, _ReasoningResponse):
                    raise AgentCallError(
                        "Unexpected structured output payload from reasoning selector."
                    )
                response = raw_response
                if index > 0:
                    logger.info(
                        "reasoning_selector_live_fallback_success",
                        fallback_index=index,
                        provider=getattr(caller, "provider", "unknown"),
                        model=getattr(caller, "model", "unknown"),
                    )
                break
            except AgentCallError as exc:
                last_error = exc
                if index + 1 >= len(callers) or not should_try_alternate_live_model(exc):
                    raise
                logger.warning(
                    "reasoning_selector_live_fallback",
                    error=str(exc),
                    fallback_index=index + 1,
                    provider=getattr(caller, "provider", "unknown"),
                    model=getattr(caller, "model", "unknown"),
                    **provider_error_details(exc),
                )

        if response is None:
            raise last_error or AgentCallError("Reasoning selector exhausted all live callers.")

        reasoning_hash = hashlib.sha256(response.reasoning.encode("utf-8")).hexdigest()
        selection = MechanismSelection(
            mechanism=MechanismType(response.mechanism),
            confidence=response.confidence,
            reasoning=response.reasoning,
            reasoning_hash=reasoning_hash,
            bandit_recommendation=bandit_mechanism,
            bandit_confidence=bandit_confidence,
            task_features=features,
            selector_source="llm_reasoning",
            selector_fallback_path=["reasoning"],
        )
        logger.info(
            "reasoning_selector_decision",
            mechanism=selection.mechanism.value,
            confidence=selection.confidence,
            bandit_recommendation=selection.bandit_recommendation.value,
            bandit_confidence=selection.bandit_confidence,
        )
        return selection

    def _get_caller(self) -> AgentCaller:
        """Return lazily initialized reasoning caller."""

        if self._caller is None:
            self._caller = pro_caller()
        return self._caller

    def _candidate_callers(self) -> list[AgentCaller]:
        """Return the ordered live caller cascade for reasoning selection."""

        return [self._get_caller(), *self._fallback_callers]
