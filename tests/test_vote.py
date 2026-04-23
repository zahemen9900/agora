"""Tests for ISP-weighted vote engine."""

from __future__ import annotations

import os

import pytest

from agora.agent import AgentCallError
from agora.config import get_config
from agora.engines.vote import VoteEngine, _VoteResponse
from agora.types import LocalModelSpec, LocalProviderKeys, MechanismType, VoteState
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


_OPENROUTER_KEY_PRESENT = _PAID_INTEGRATION_ENABLED and _has_openrouter_key()


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


class _SuccessfulVoteCaller:
    def __init__(self, model: str) -> None:
        self.model = model

    async def call(self, **_kwargs):
        return _VoteResponse(
            answer="Paris",
            confidence=0.84,
            predicted_group_answer="Paris",
            reasoning=f"{self.model} voted for Paris.",
        ), {"input_tokens": 6, "output_tokens": 4, "latency_ms": 10.0}


class _RawTextCaller:
    def __init__(self, model: str, response: str) -> None:
        self.model = model
        self.response = response
        self.calls: list[dict[str, object]] = []

    async def call(self, **kwargs):
        self.calls.append(kwargs)
        return self.response, {"input_tokens": 6, "output_tokens": 4, "latency_ms": 15.0}


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


def test_vote_response_coerces_scalar_text_fields() -> None:
    """Structured vote payloads should tolerate scalar text-like JSON values."""

    response = _VoteResponse.model_validate(
        {
            "answer": 323,
            "confidence": 0.7,
            "predicted_group_answer": 1,
            "reasoning": 42,
        }
    )

    assert response.answer == "323"
    assert response.predicted_group_answer == "1"
    assert response.reasoning == "42"


def test_four_agent_vote_routes_kimi_as_active_diversity_tier() -> None:
    """Four-agent voting should follow the canonical balanced provider cycle."""

    engine = VoteEngine(agent_count=4)

    assert [engine._tier_for_agent(agent_idx) for agent_idx in range(4)] == [
        "pro",
        "flash",
        "kimi",
        "claude",
    ]


def test_vote_provider_cycle_repeats_evenly_for_eight_and_twelve_agents() -> None:
    """Balanced vote ensembles should repeat the base four-model cycle deterministically."""

    assert [VoteEngine(agent_count=8)._tier_for_agent(index) for index in range(8)] == [
        "pro",
        "flash",
        "kimi",
        "claude",
        "pro",
        "flash",
        "kimi",
        "claude",
    ]
    assert [VoteEngine(agent_count=12)._tier_for_agent(index) for index in range(12)] == [
        "pro",
        "flash",
        "kimi",
        "claude",
        "pro",
        "flash",
        "kimi",
        "claude",
        "pro",
        "flash",
        "kimi",
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
    assert kimi.calls[0]["response_format"] is _VoteResponse


@pytest.mark.asyncio
async def test_call_structured_flash_raw_text_falls_back_to_kimi() -> None:
    """Non-Kimi providers that return raw text should still fall through to live Kimi."""

    flash = _RawTextCaller("gemini-3.1-flash-lite-preview", "flash raw text")
    kimi = _RawTextCaller("moonshotai/kimi-k2-thinking", "Kimi fallback answer")
    engine = VoteEngine(agent_count=4, flash_agent=flash, kimi_agent=kimi)
    fallback = _VoteResponse(
        answer="deterministic fallback",
        confidence=0.2,
        predicted_group_answer="deterministic fallback",
        reasoning="offline fallback",
    )

    response, usage = await engine._call_structured(
        tier="flash",
        system_prompt="Return JSON.",
        user_prompt="Vote on the best option",
        response_model=_VoteResponse,
        fallback=fallback,
    )

    assert response.answer == "Kimi fallback answer"
    assert response.predicted_group_answer == "Kimi fallback answer"
    assert usage["model"] == "moonshotai/kimi-k2-thinking"
    assert len(flash.calls) == 1
    assert len(kimi.calls) == 1


@pytest.mark.asyncio
async def test_quorum_check_threshold_works() -> None:
    """Vote run should mark quorum for strongly concentrated weighted outcomes."""

    engine = VoteEngine(
        agent_count=3,
        quorum_threshold=0.6,
        flash_agent=_SuccessfulVoteCaller("gemini-3.1-flash-lite-preview"),
        pro_agent=_SuccessfulVoteCaller("gemini-3-flash-preview"),
        claude_agent=_SuccessfulVoteCaller("claude-sonnet-4-6"),
        kimi_agent=_FailingCaller(model="moonshotai/kimi-k2-thinking"),
    )
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
async def test_four_agent_vote_records_all_provider_models() -> None:
    """The 4-agent vote path should expose the balanced ordered provider ensemble."""

    engine = VoteEngine(
        agent_count=4,
        quorum_threshold=0.6,
        flash_agent=_SuccessfulVoteCaller("gemini-3.1-flash-lite-preview"),
        pro_agent=_SuccessfulVoteCaller("gemini-3-flash-preview"),
        claude_agent=_SuccessfulVoteCaller("claude-sonnet-4-6"),
        kimi_agent=_SuccessfulVoteCaller("moonshotai/kimi-k2-thinking"),
    )
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

    outcome = await engine.run("Answer in one word: Paris or Lyon?", selection)

    assert outcome.result.agent_models_used == [
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "moonshotai/kimi-k2-thinking",
        "claude-sonnet-4-6",
    ]


@pytest.mark.asyncio
async def test_explicit_local_vote_roster_preserves_selected_model_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    specs = [
        LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
        LocalModelSpec(provider="gemini", model="gemini-3.1-flash-lite-preview"),
        LocalModelSpec(provider="openrouter", model="moonshotai/kimi-k2-thinking"),
        LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
    ]

    def fake_build_local_model_caller(*, spec: LocalModelSpec, provider_keys: LocalProviderKeys | None):
        assert provider_keys is not None
        return _SuccessfulVoteCaller(spec.model)

    monkeypatch.setattr("agora.engines.vote.build_local_model_caller", fake_build_local_model_caller)
    engine = VoteEngine(
        agent_count=4,
        participant_models=specs,
        provider_keys=LocalProviderKeys(
            gemini_api_key="gem-key",
            openrouter_api_key="or-key",
            anthropic_api_key="anth-key",
        ),
    )
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

    outcome = await engine.run("Answer in one word: Paris or Lyon?", selection)

    assert outcome.result.agent_models_used == [spec.model for spec in specs]


@pytest.mark.asyncio
async def test_custom_agents_short_circuit_all_provider_tiers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Custom agents are local execution; provider callers must never be reached."""

    captured_prompts: list[tuple[str, str]] = []

    async def local_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        captured_prompts.append((system_prompt, user_prompt))
        return {
            "answer": "Paris",
            "confidence": 0.9,
            "predicted_group_answer": "Paris",
            "reasoning": "Local deterministic agent.",
        }

    def fail_provider_lookup(self: VoteEngine, tier: str) -> object:
        del self
        raise AssertionError(f"provider tier should not be used: {tier}")

    monkeypatch.setattr(VoteEngine, "_get_caller", fail_provider_lookup)
    engine = VoteEngine(agent_count=4)
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

    outcome = await engine.run(
        "Answer in one word: Paris or Lyon?",
        selection,
        custom_agents=[local_agent, local_agent, local_agent, local_agent],
    )

    assert outcome.result.final_answer == "Paris"
    assert outcome.result.agent_models_used == ["custom-agent"]
    assert len(captured_prompts) == 4
    assert all("Your role is vote participant" in system for system, _user in captured_prompts)


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
async def test_call_kimi_vote_native_structured_response_initializes_coercion_provenance() -> None:
    """Native Kimi vote responses should not hit unbound coercion provenance paths."""

    engine = VoteEngine(
        agent_count=3,
        kimi_agent=_SuccessfulKimiCaller(),
    )
    fallback = _VoteResponse(
        answer="deterministic fallback",
        confidence=0.2,
        predicted_group_answer="deterministic fallback",
        reasoning="offline fallback",
    )

    response, usage = await engine._call_kimi_vote(
        "Return JSON.",
        "Vote on the best option",
        fallback,
    )

    assert response.answer == "Kimi fallback answer"
    assert usage.get("fallback_events", []) == []


@pytest.mark.asyncio
async def test_call_structured_falls_back_when_claude_and_kimi_fail() -> None:
    """If Claude and Kimi fail, vote engine should return deterministic fallback."""

    engine = VoteEngine(
        agent_count=3,
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
        kimi_agent=_FailingCaller(model="moonshotai/kimi-k2-thinking"),
        allow_offline_fallback=True,
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
async def test_call_structured_strict_mode_blocks_deterministic_fallback() -> None:
    """Production default should fail before materializing offline vote artifacts."""

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

    with pytest.raises(AgentCallError, match="Provider fallback disabled"):
        await engine._call_structured(
            tier="claude",
            system_prompt="Return JSON.",
            user_prompt="Vote on the best option",
            response_model=_VoteResponse,
            fallback=fallback,
        )


@pytest.mark.asyncio
async def test_offline_vote_fallback_is_task_grounded_not_option_placeholder() -> None:
    """Explicit offline fallback should not emit option A/B placeholders."""

    engine = VoteEngine(
        agent_count=3,
        flash_agent=_FailingCaller(model="gemini-3.1-flash-lite-preview"),
        pro_agent=_FailingCaller(model="gemini-3-flash-preview"),
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
        kimi_agent=_FailingCaller(model="moonshotai/kimi-k2-thinking"),
        allow_offline_fallback=True,
    )
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="reasoning")

    outcome = await engine.run(
        "Pick the safest migration plan for a high-traffic SQL system.",
        selection,
    )
    transcript = "\n".join(output.content for output in outcome.state.agent_outputs).lower()

    assert outcome.result.fallback_count == 3
    assert "option a" not in transcript
    assert "option b" not in transcript
    assert "lowest-risk answer satisfying" in transcript


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
        flash_agent=_FailingCaller(model="gemini-3.1-flash-lite-preview"),
        pro_agent=_FailingCaller(model="gemini-3-flash-preview"),
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
    )
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

    outcome = await engine.run("Answer in one word: Paris or Lyon?", selection)

    assert outcome.result.total_tokens_used > 0
    assert outcome.result.final_answer != ""
