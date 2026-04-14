"""Tests for ISP-weighted vote engine."""

from __future__ import annotations

import os

import pytest

from agora.agent import AgentCallError
from agora.config import get_config
from agora.engines.vote import VoteEngine, _VoteResponse
from agora.types import MechanismType, VoteState
from tests.helpers import make_agent_output, make_features, make_selection

_PAID_INTEGRATION_ENABLED = os.getenv("RUN_PAID_PROVIDER_TESTS", "").lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _has_openrouter_key() -> bool:
    """Detect OpenRouter key availability through env or Secret Manager-backed config."""

    try:
        get_config.cache_clear()
        return bool(get_config().openrouter_api_key)
    except Exception:
        return False


_OPENROUTER_KEY_PRESENT = _has_openrouter_key()


class _FailingCaller:
    def __init__(self, model: str) -> None:
        self.model = model

    async def call(self, **_kwargs):
        raise AgentCallError("forced failure")


class _SuccessfulKimiCaller:
    def __init__(self) -> None:
        self.model = "moonshotai/kimi-k2-thinking"

    async def call(self, **_kwargs):
        return _VoteResponse(
            answer="Kimi fallback answer",
            confidence=0.74,
            predicted_group_answer="Kimi fallback answer",
            reasoning="OpenRouter fallback path",
        ), {"input_tokens": 6, "output_tokens": 4, "latency_ms": 12.0}


class _RawKimiCaller:
    def __init__(self) -> None:
        self.model = "moonshotai/kimi-k2-thinking"
        self.calls = []

    async def call(self, **kwargs):
        self.calls.append(kwargs)
        return "Kimi raw answer", {"input_tokens": 8, "output_tokens": 5, "latency_ms": 15.0}


def test_isp_aggregation_all_agents_agree() -> None:
    """When all agents agree, the single answer should dominate normalized weight."""

    engine = VoteEngine(agent_count=3)
    state = VoteState(task="capital?", task_features=make_features("factual"))
    state.agent_outputs = [
        make_agent_output("a1", "Paris", confidence=0.9, predicted_group_answer="Paris"),
        make_agent_output("a2", "Paris", confidence=0.8, predicted_group_answer="Paris"),
        make_agent_output("a3", "Paris", confidence=0.85, predicted_group_answer="Paris"),
    ]

    engine._calibrate_confidence(state)
    engine._isp_aggregate(state)

    assert state.final_weights["Paris"] > 0.95


def test_isp_surprise_boosts_underpredicted_majority() -> None:
    """Majority answer should get boosted when underpredicted by the group."""

    engine = VoteEngine(agent_count=3)
    state = VoteState(task="reasoning task", task_features=make_features("reasoning"))
    state.agent_outputs = [
        make_agent_output("a1", "A", confidence=0.72, predicted_group_answer="B"),
        make_agent_output("a2", "A", confidence=0.68, predicted_group_answer="B"),
        make_agent_output("a3", "B", confidence=0.8, predicted_group_answer="A"),
    ]

    engine._calibrate_confidence(state)
    engine._isp_aggregate(state)

    assert state.isp_scores["A"] > 0.0
    assert state.final_weights["A"] > state.final_weights["B"]


def test_confidence_calibration_softens_extremes() -> None:
    """Temperature scaling should push extreme probabilities toward the center."""

    engine = VoteEngine(agent_count=3, temperature_scaling=1.5)
    high = engine._temperature_scale(0.99, temperature=1.5)
    low = engine._temperature_scale(0.01, temperature=1.5)

    assert 0.5 < high < 0.99
    assert 0.01 < low < 0.5


def test_four_agent_vote_routes_kimi_as_active_diversity_tier() -> None:
    """Four-agent voting should include Kimi as an active tier, not only fallback."""

    engine = VoteEngine(agent_count=4)

    assert [engine._tier_for_agent(agent_idx) for agent_idx in range(4)] == [
        "pro",
        "kimi",
        "flash",
        "claude",
    ]


@pytest.mark.asyncio
async def test_call_structured_kimi_coerces_raw_vote() -> None:
    """Active Kimi voter should still contribute when it returns non-JSON text."""

    kimi = _RawKimiCaller()
    engine = VoteEngine(agent_count=4, kimi_agent=kimi)
    fallback = _VoteResponse(
        answer="deterministic fallback",
        confidence=0.2,
        predicted_group_answer="deterministic fallback",
        reasoning="offline fallback",
    )

    response, usage = await engine._call_structured(
        tier="kimi",
        system_prompt="Return JSON.",
        user_prompt="Vote on the best option",
        response_model=_VoteResponse,
        fallback=fallback,
    )

    assert response.answer == "Kimi raw answer"
    assert response.predicted_group_answer == "Kimi raw answer"
    assert usage["tokens"] == 13
    assert usage["latency_ms"] == pytest.approx(15.0)
    assert "response_format" not in kimi.calls[0]


@pytest.mark.asyncio
async def test_quorum_check_threshold_works() -> None:
    """Vote run should mark quorum for strongly concentrated weighted outcomes."""

    engine = VoteEngine(agent_count=3, quorum_threshold=0.6)
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

    async def paris_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "Paris",
            "confidence": 0.9,
            "predicted_group_answer": "Paris",
            "reasoning": "Deterministic local test agent.",
        }

    outcome = await engine.run(
        "What is the capital of France?",
        selection,
        custom_agents=[paris_agent, paris_agent, paris_agent],
    )

    assert outcome.state.quorum_reached is True
    assert outcome.result.quorum_reached is True
    assert outcome.result.final_answer != ""


@pytest.mark.asyncio
async def test_call_structured_claude_falls_back_to_kimi() -> None:
    """Structured Claude failures should retry once with Kimi fallback caller."""

    engine = VoteEngine(
        agent_count=3,
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
        kimi_agent=_SuccessfulKimiCaller(),
    )
    fallback = _VoteResponse(
        answer="deterministic fallback",
        confidence=0.2,
        predicted_group_answer="deterministic fallback",
        reasoning="offline fallback",
    )

    response, usage = await engine._call_structured(
        tier="claude",
        system_prompt="Return JSON.",
        user_prompt="Vote on the best option",
        response_model=_VoteResponse,
        fallback=fallback,
    )

    assert isinstance(response, _VoteResponse)
    assert response.answer == "Kimi fallback answer"
    assert usage["tokens"] == 10
    assert usage["latency_ms"] == pytest.approx(12.0)


@pytest.mark.asyncio
async def test_call_structured_falls_back_when_claude_and_kimi_fail() -> None:
    """If Claude and Kimi fail, vote engine should return deterministic fallback."""

    engine = VoteEngine(
        agent_count=3,
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
        kimi_agent=_FailingCaller(model="moonshotai/kimi-k2-thinking"),
    )
    fallback = _VoteResponse(
        answer="deterministic fallback",
        confidence=0.2,
        predicted_group_answer="deterministic fallback",
        reasoning="offline fallback",
    )

    response, usage = await engine._call_structured(
        tier="claude",
        system_prompt="Return JSON.",
        user_prompt="Vote on the best option",
        response_model=_VoteResponse,
        fallback=fallback,
    )

    assert response.answer == "deterministic fallback"
    assert usage["tokens"] == 0
    assert usage["latency_ms"] == pytest.approx(0.0)


@pytest.mark.asyncio
@pytest.mark.paid_integration
@pytest.mark.skipif(
    not _PAID_INTEGRATION_ENABLED or not _OPENROUTER_KEY_PRESENT,
    reason="Paid-provider vote integration is opt-in and requires OpenRouter key.",
)
async def test_vote_paid_integration_hits_kimi_path() -> None:
    """Opt-in integration test should perform a live Kimi call in vote flow."""

    engine = VoteEngine(
        agent_count=3,
        flash_agent=_FailingCaller(model="gemini-3-flash-preview"),
        pro_agent=_FailingCaller(model="gemini-3.1-pro-preview"),
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
    )
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

    outcome = await engine.run("Answer in one word: Paris or Lyon?", selection)

    assert outcome.result.total_tokens_used > 0
    assert outcome.result.final_answer != ""
