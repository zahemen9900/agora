"""Tests for factional debate engine."""

from __future__ import annotations

import json
import os

import pytest

from agora.agent import AgentCallError
from agora.config import get_config
from agora.engines.debate import (
    DebateEngine,
    _CrossExamResponse,
    _InitialAnswerResponse,
    _OpeningResponse,
    _RebuttalResponse,
    _SynthesisResponse,
)
from agora.types import DebateState, MechanismType
from tests.helpers import make_agent_output, make_selection

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


class _FakeDebateCaller:
    def __init__(self, model: str, response) -> None:
        self.model = model
        self.response = response
        self.calls = []

    async def call(self, **kwargs):
        self.calls.append(kwargs)
        return self.response, {"input_tokens": 5, "output_tokens": 7, "latency_ms": 11.0}


class _FailingCaller:
    def __init__(self, model: str) -> None:
        self.model = model

    async def call(self, **_kwargs):
        raise AgentCallError("forced failure")


class _SchemaAwareDebateCaller:
    def __init__(self, model: str) -> None:
        self.model = model

    async def call(self, **kwargs):
        response_format = kwargs.get("response_format")
        if response_format is _InitialAnswerResponse:
            return _InitialAnswerResponse(answer="Architecture A", confidence=0.72), {
                "input_tokens": 4,
                "output_tokens": 6,
                "latency_ms": 8.0,
            }
        if response_format is _OpeningResponse:
            return _OpeningResponse(
                claim="Architecture A is more robust.",
                evidence="It isolates failures and simplifies recovery.",
                confidence=0.71,
            ), {"input_tokens": 6, "output_tokens": 10, "latency_ms": 8.0}
        if response_format is _RebuttalResponse:
            return _RebuttalResponse(
                answer="Architecture A",
                defense="The isolation boundary directly addresses the critique.",
                confidence=0.74,
            ), {"input_tokens": 7, "output_tokens": 10, "latency_ms": 8.0}
        if response_format is _SynthesisResponse:
            return _SynthesisResponse(
                final_answer="Choose Architecture A for reliability.",
                confidence=0.81,
                summary="It isolates failures better than the alternative.",
            ), {"input_tokens": 8, "output_tokens": 12, "latency_ms": 8.0}
        return (
            '{"analyses":[{"faction":"pro","weakest_claim":"claim A","flaw":"unsupported",'
            '"question":"What evidence supports claim A?"}]}',
            {"input_tokens": 5, "output_tokens": 9, "latency_ms": 8.0},
        )


def test_assign_factions_creates_two_sides_and_da_candidate() -> None:
    """Faction assignment should produce pro/opp sides and a DA id."""

    engine = DebateEngine(agent_count=3)
    outputs = [
        make_agent_output("agent-1", "Answer A", role="initial", round_number=0),
        make_agent_output("agent-2", "Answer B", role="initial", round_number=0),
        make_agent_output("agent-3", "Answer A", role="initial", round_number=0),
    ]

    _pro_answer, _opp_answer, assignments, da_id = engine._assign_factions(outputs)

    assert set(assignments.values()) == {"pro", "opp"}
    assert da_id in {"agent-1", "agent-2", "agent-3"}
    assert da_id not in assignments
    assert len(assignments) == 2


def test_assign_factions_keeps_two_sides_when_da_is_separate() -> None:
    """Removing the DA should still leave one debater on each faction."""

    engine = DebateEngine(agent_count=3)
    outputs = [
        make_agent_output("agent-1", "Answer A", role="initial", round_number=0),
        make_agent_output("agent-2", "Answer A", role="initial", round_number=0),
        make_agent_output("agent-3", "Answer B", role="initial", round_number=0),
    ]

    _pro_answer, _opp_answer, assignments, da_id = engine._assign_factions(outputs)

    assert da_id not in assignments
    assert sorted(assignments.values()) == ["opp", "pro"]


def test_verify_claims_extracts_arithmetic_equalities_from_json() -> None:
    """Arithmetic claims inside structured debate content should be lockable."""

    engine = DebateEngine(agent_count=3)
    claims = engine._verify_claims(
        '{"defense":"Because 2 + 2 = 4 and 3*3=9, the conclusion follows."}',
        round_number=2,
    )

    claim_texts = {claim.claim_text for claim in claims}

    assert "2+2=4" in claim_texts
    assert "3*3=9" in claim_texts


@pytest.mark.asyncio
async def test_cross_examination_uses_kimi_devil_advocate() -> None:
    """Devil's Advocate cross-examination should use Kimi rather than Gemini Pro."""

    kimi_response = (
        '[{"faction":"pro","weakest_claim":"claim A","flaw":"unsupported",'
        '"question":"What evidence supports claim A?"}]'
    )
    kimi = _FakeDebateCaller("moonshotai/kimi-k2-thinking", kimi_response)
    pro = _FakeDebateCaller(
        "gemini-3.1-pro-preview",
        _SynthesisResponse(final_answer="unused", confidence=0.5, summary="unused"),
    )
    engine = DebateEngine(agent_count=3, kimi_agent=kimi, pro_agent=pro)

    output, usage = await engine._cross_examination(
        task="Which architecture is more robust?",
        round_number=1,
        devil_advocate_id="agent-3",
        pro_outputs=[make_agent_output("agent-1", "Answer A", role="pro_opening")],
        opp_outputs=[make_agent_output("agent-2", "Answer B", role="opp_opening")],
    )

    assert output.role == "devil_advocate"
    assert output.agent_model == "moonshotai/kimi-k2-thinking"
    assert usage["tokens"] == 12
    assert json.loads(output.content)["analyses"][0]["flaw"] == "unsupported"
    assert "response_format" not in kimi.calls[0]
    assert pro.calls == []


@pytest.mark.asyncio
async def test_final_debate_aggregation_still_uses_gemini_pro() -> None:
    """Final synthesis should stay on Gemini Pro after Kimi challenges the debate."""

    pro_response = _SynthesisResponse(
        final_answer="Use the reliability-first architecture.",
        confidence=0.82,
        summary="The pro faction had stronger operational evidence.",
    )
    pro = _FakeDebateCaller("gemini-3.1-pro-preview", pro_response)
    kimi = _FakeDebateCaller(
        "moonshotai/kimi-k2-thinking",
        _CrossExamResponse(analyses=[]),
    )
    engine = DebateEngine(agent_count=3, pro_agent=pro, kimi_agent=kimi)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    pro_output = make_agent_output(
        "agent-1",
        "Use architecture A because it isolates failures.",
        confidence=0.8,
        role="pro_opening",
    ).model_copy(update={"agent_model": "gemini-3-flash-preview"})
    opp_output = make_agent_output(
        "agent-2",
        "Use architecture B because it is simpler.",
        confidence=0.6,
        role="opp_opening",
    ).model_copy(update={"agent_model": "gemini-3-flash-preview"})
    state = DebateState(
        task="Choose an architecture.",
        task_features=selection.task_features,
        round=1,
        max_rounds=4,
        factions={"pro": [pro_output], "opp": [opp_output]},
        rebuttals={"pro": [], "opp": []},
        transcript_hashes=[pro_output.content_hash, opp_output.content_hash],
        cross_examinations=[
            make_agent_output(
                "agent-3",
                '{"analyses":[{"faction":"pro","question":"Prove the isolation claim."}]}',
                role="devil_advocate",
                round_number=1,
            ).model_copy(update={"agent_model": "moonshotai/kimi-k2-thinking"})
        ],
    )

    result, usage = await engine._final_aggregation(
        state=state,
        selection=selection,
        pro_answer="Architecture A",
        opp_answer="Architecture B",
        prior_tokens=3,
        prior_latency_ms=4.0,
    )

    assert result.final_answer == "Use the reliability-first architecture."
    assert result.mechanism_used is MechanismType.DEBATE
    assert result.total_tokens_used == 15
    assert usage["tokens"] == 12
    assert result.agent_models_used == [
        "gemini-3-flash-preview",
        "moonshotai/kimi-k2-thinking",
        "gemini-3.1-pro-preview",
    ]
    assert pro.calls[0]["response_format"] is _SynthesisResponse
    assert kimi.calls == []


@pytest.mark.asyncio
async def test_full_debate_run_on_simple_math_task() -> None:
    """Debate run should complete and produce a populated result artifact."""

    engine = DebateEngine(
        agent_count=3,
        max_rounds=4,
        flash_agent=_SchemaAwareDebateCaller("gemini-3-flash-preview"),
        pro_agent=_SchemaAwareDebateCaller("gemini-3.1-pro-preview"),
        kimi_agent=_SchemaAwareDebateCaller("moonshotai/kimi-k2-thinking"),
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="math")

    outcome = await engine.run("What is the derivative of x^3 * sin(x)?", selection)

    assert outcome.result is not None
    assert outcome.result.final_answer != ""
    assert outcome.result.merkle_root != ""
    assert len(outcome.result.transcript_hashes) > 0


@pytest.mark.asyncio
async def test_adaptive_termination_fires_on_plateau() -> None:
    """Debate should be able to terminate early when information gain plateaus."""

    engine = DebateEngine(
        agent_count=3,
        max_rounds=4,
        flash_agent=_SchemaAwareDebateCaller("gemini-3-flash-preview"),
        pro_agent=_SchemaAwareDebateCaller("gemini-3.1-pro-preview"),
        kimi_agent=_SchemaAwareDebateCaller("moonshotai/kimi-k2-thinking"),
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="math")

    outcome = await engine.run("What is the derivative of x^3 * sin(x)?", selection)

    assert outcome.result is not None
    assert outcome.state.round <= 4
    assert outcome.state.terminated_early is True


@pytest.mark.asyncio
async def test_mechanism_switch_triggers_when_monitor_requests(monkeypatch) -> None:
    """Debate should return switch signal when monitor reports divergence."""

    engine = DebateEngine(
        agent_count=3,
        max_rounds=4,
        flash_agent=_SchemaAwareDebateCaller("gemini-3-flash-preview"),
        pro_agent=_SchemaAwareDebateCaller("gemini-3.1-pro-preview"),
        kimi_agent=_SchemaAwareDebateCaller("moonshotai/kimi-k2-thinking"),
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    monkeypatch.setattr(engine.monitor, "should_terminate", lambda _history: (False, "continue"))
    monkeypatch.setattr(
        engine.monitor,
        "should_switch_mechanism",
        lambda _history, current_mechanism: (True, MechanismType.VOTE, "forced switch"),
    )

    outcome = await engine.run("Compare two software architectures.", selection)

    assert outcome.switch_to_vote is True
    assert outcome.suggested_mechanism == MechanismType.VOTE
    assert outcome.result is None


@pytest.mark.asyncio
@pytest.mark.paid_integration
@pytest.mark.skipif(
    not _PAID_INTEGRATION_ENABLED or not _OPENROUTER_KEY_PRESENT,
    reason="Paid-provider debate integration is opt-in and requires OpenRouter key.",
)
async def test_debate_paid_integration_hits_kimi_cross_exam() -> None:
    """Opt-in integration test should perform a live Kimi cross-exam call."""

    engine = DebateEngine(
        agent_count=3,
        flash_agent=_FailingCaller(model="gemini-3-flash-preview"),
        pro_agent=_FailingCaller(model="gemini-3.1-pro-preview"),
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="math")

    outcome = await engine.run("What is the derivative of x^3 * sin(x)?", selection)

    assert outcome.result is not None
    assert outcome.result.total_tokens_used > 0
    assert any(
        output.role == "devil_advocate"
        and output.agent_model == "moonshotai/kimi-k2-thinking"
        for output in outcome.state.cross_examinations
    )
