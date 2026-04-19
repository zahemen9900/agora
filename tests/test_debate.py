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
    """Faction assignment should keep counted debaters and a separate DA id."""

    engine = DebateEngine(agent_count=3)
    outputs = [
        make_agent_output("agent-1", "Answer A", role="initial", round_number=0),
        make_agent_output("agent-2", "Answer B", role="initial", round_number=0),
        make_agent_output("agent-3", "Answer A", role="initial", round_number=0),
    ]

    _pro_answer, _opp_answer, assignments, da_id = engine._assign_factions(outputs)

    assert set(assignments.values()) == {"pro", "opp"}
    assert da_id == "debate-devils-advocate"
    assert da_id not in assignments
    assert len(assignments) == 3


def test_assign_factions_keeps_two_sides_when_da_is_separate() -> None:
    """Separate specialist roles should not remove counted debaters from factions."""

    engine = DebateEngine(agent_count=3)
    outputs = [
        make_agent_output("agent-1", "Answer A", role="initial", round_number=0),
        make_agent_output("agent-2", "Answer A", role="initial", round_number=0),
        make_agent_output("agent-3", "Answer B", role="initial", round_number=0),
    ]

    _pro_answer, _opp_answer, assignments, da_id = engine._assign_factions(outputs)

    assert da_id not in assignments
    assert sorted(assignments.values()) == ["opp", "pro", "pro"]


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
        '"attack_axis":"evidence_gap","counterexample":"A concrete counterexample matters.",'
        '"failure_mode":"Unsupported claim","question":"What evidence supports claim A?"}]'
    )
    kimi = _FakeDebateCaller("moonshotai/kimi-k2-thinking", kimi_response)
    pro = _FakeDebateCaller(
        "gemini-3-flash-preview",
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
    pro = _FakeDebateCaller("gemini-3-flash-preview", pro_response)
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
    ).model_copy(update={"agent_model": "gemini-3.1-flash-lite-preview"})
    opp_output = make_agent_output(
        "agent-2",
        "Use architecture B because it is simpler.",
        confidence=0.6,
        role="opp_opening",
    ).model_copy(update={"agent_model": "gemini-3.1-flash-lite-preview"})
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
        prior_model_token_usage={"gemini-3.1-flash-lite-preview": 3},
        prior_model_input_token_usage={},
        prior_model_output_token_usage={},
        prior_model_thinking_token_usage={},
        prior_model_latency_ms={"gemini-3.1-flash-lite-preview": 4.0},
    )

    assert result.final_answer == "Use the reliability-first architecture."
    assert result.mechanism_used is MechanismType.DEBATE
    assert result.total_tokens_used == 15
    assert result.model_token_usage == {
        "gemini-3.1-flash-lite-preview": 3,
        "gemini-3-flash-preview": 12,
    }
    assert result.model_latency_ms == {
        "gemini-3.1-flash-lite-preview": 4.0,
        "gemini-3-flash-preview": 11.0,
    }
    assert usage["tokens"] == 12
    assert result.agent_models_used == [
        "gemini-3.1-flash-lite-preview",
        "moonshotai/kimi-k2-thinking",
        "gemini-3-flash-preview",
    ]
    assert pro.calls[0]["response_format"] is _SynthesisResponse
    assert kimi.calls == []


@pytest.mark.asyncio
async def test_debate_initial_answers_follow_balanced_provider_cycle() -> None:
    """Counted debate participants should use the balanced provider cycle, including Claude."""

    engine = DebateEngine(
        agent_count=4,
        flash_agent=_SchemaAwareDebateCaller("gemini-3.1-flash-lite-preview"),
        pro_agent=_SchemaAwareDebateCaller("gemini-3-flash-preview"),
        claude_agent=_SchemaAwareDebateCaller("claude-sonnet-4-6"),
        kimi_agent=_SchemaAwareDebateCaller("moonshotai/kimi-k2-thinking"),
    )

    outputs, usage = await engine._assign_initial_answers("Choose an architecture.")

    assert [output.agent_model for output in outputs] == [
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "moonshotai/kimi-k2-thinking",
        "claude-sonnet-4-6",
    ]
    assert usage["model_tokens"] == {
        "gemini-3-flash-preview": 10,
        "gemini-3.1-flash-lite-preview": 10,
        "moonshotai/kimi-k2-thinking": 10,
        "claude-sonnet-4-6": 10,
    }


@pytest.mark.asyncio
async def test_full_debate_run_on_simple_math_task() -> None:
    """Debate run should complete and produce a populated result artifact."""

    engine = DebateEngine(
        agent_count=3,
        max_rounds=4,
        flash_agent=_SchemaAwareDebateCaller("gemini-3.1-flash-lite-preview"),
        pro_agent=_SchemaAwareDebateCaller("gemini-3-flash-preview"),
        kimi_agent=_SchemaAwareDebateCaller("moonshotai/kimi-k2-thinking"),
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="math")

    outcome = await engine.run("What is the derivative of x^3 * sin(x)?", selection)

    assert outcome.result is not None
    assert outcome.result.final_answer != ""
    assert outcome.result.merkle_root != ""
    assert len(outcome.result.transcript_hashes) > 0


@pytest.mark.asyncio
async def test_custom_agents_short_circuit_debate_provider_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Local custom-agent debate must not silently reach hosted providers."""

    async def local_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "Architecture A",
            "confidence": 0.9,
            "claim": "Architecture A is more robust.",
            "evidence": "Local evidence.",
            "defense": "Local defense.",
            "final_answer": "Choose Architecture A.",
            "summary": "Local synthesis.",
            "predicted_group_answer": "Architecture A",
            "reasoning": "Local execution only.",
            "analyses": [
                {
                    "faction": "pro",
                    "weakest_claim": "Architecture A reliability claim",
                    "flaw": "Needs a named failure boundary.",
                    "attack_axis": "failure_isolation",
                    "counterexample": "A simpler architecture with equal isolation.",
                    "failure_mode": "The isolation claim is asserted but not measured.",
                    "question": "Which measured failure boundary makes Architecture A safer?",
                },
                {
                    "faction": "opp",
                    "weakest_claim": "Architecture B simplicity claim",
                    "flaw": "Simplicity may hide recovery coupling.",
                    "attack_axis": "operational_risk",
                    "counterexample": "A downstream outage that propagates through shared state.",
                    "failure_mode": "The simplicity claim ignores blast radius.",
                    "question": "Which operational constraint keeps Architecture B from cascading?",
                },
            ],
        }

    def fail_provider_lookup(self: DebateEngine, tier: str) -> object:
        del self
        raise AssertionError(f"provider tier should not be used: {tier}")

    monkeypatch.setattr(DebateEngine, "_get_caller", fail_provider_lookup)

    engine = DebateEngine(agent_count=3, max_rounds=2)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    outcome = await engine.run(
        "Choose an architecture.",
        selection,
        custom_agents=[local_agent, local_agent, local_agent],
    )

    assert outcome.result is not None
    assert outcome.result.final_answer != ""
    assert "custom-agent" in outcome.result.agent_models_used


@pytest.mark.asyncio
async def test_provider_fallback_disabled_blocks_debate_artifacts() -> None:
    """Production default should fail before emitting deterministic debate fallback."""

    engine = DebateEngine(
        agent_count=3,
        flash_agent=_FailingCaller(model="gemini-3.1-flash-lite-preview"),
        pro_agent=_FailingCaller(model="gemini-3-flash-preview"),
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
        kimi_agent=_FailingCaller(model="moonshotai/kimi-k2-thinking"),
    )
    fallback = _OpeningResponse(
        claim="placeholder claim",
        evidence="placeholder evidence",
        confidence=0.2,
    )

    with pytest.raises(AgentCallError, match="Provider fallback disabled"):
        await engine._call_structured(
            tier="pro",
            system_prompt="Return JSON.",
            user_prompt="Argue for the assigned answer.",
            response_model=_OpeningResponse,
            fallback=fallback,
        )


@pytest.mark.asyncio
async def test_offline_debate_fallback_is_task_grounded_not_placeholder() -> None:
    """Explicit offline fallback should avoid shallow screenshot-visible strings."""

    engine = DebateEngine(
        agent_count=3,
        max_rounds=1,
        flash_agent=_FailingCaller(model="gemini-3.1-flash-lite-preview"),
        pro_agent=_FailingCaller(model="gemini-3-flash-preview"),
        claude_agent=_FailingCaller(model="claude-sonnet-4-6"),
        kimi_agent=_FailingCaller(model="moonshotai/kimi-k2-thinking"),
        allow_offline_fallback=True,
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    outcome = await engine.run(
        "Pick the safest migration plan for a high-traffic SQL system.",
        selection,
        allow_switch=False,
    )
    assert outcome.result is not None
    transcript = "\n".join(
        [
            *[output.content for output in outcome.state.factions.get("pro", [])],
            *[output.content for output in outcome.state.factions.get("opp", [])],
            *[output.content for output in outcome.state.cross_examinations],
            *[output.content for output in outcome.state.rebuttals.get("pro", [])],
            *[output.content for output in outcome.state.rebuttals.get("opp", [])],
            outcome.result.final_answer,
        ]
    ).lower()

    assert outcome.result.fallback_count > 0
    assert "heuristic fallback evidence generated locally" not in transcript
    assert "fallback rebuttal" not in transcript
    assert "option a" not in transcript
    assert "option b" not in transcript
    assert "offline evidence sketch" in transcript


@pytest.mark.asyncio
async def test_adaptive_termination_fires_on_plateau() -> None:
    """Debate should be able to terminate early when information gain plateaus."""

    engine = DebateEngine(
        agent_count=3,
        max_rounds=4,
        flash_agent=_SchemaAwareDebateCaller("gemini-3.1-flash-lite-preview"),
        pro_agent=_SchemaAwareDebateCaller("gemini-3-flash-preview"),
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
        flash_agent=_SchemaAwareDebateCaller("gemini-3.1-flash-lite-preview"),
        pro_agent=_SchemaAwareDebateCaller("gemini-3-flash-preview"),
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
        flash_agent=_FailingCaller(model="gemini-3.1-flash-lite-preview"),
        pro_agent=_FailingCaller(model="gemini-3-flash-preview"),
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="math")

    outcome = await engine.run("What is the derivative of x^3 * sin(x)?", selection)

    assert outcome.result is not None
    assert outcome.result.total_tokens_used > 0
    assert any(
        output.role == "devil_advocate" and output.agent_model == "moonshotai/kimi-k2-thinking"
        for output in outcome.state.cross_examinations
    )
