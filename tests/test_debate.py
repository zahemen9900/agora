"""Tests for factional debate engine."""

from __future__ import annotations

import pytest

from agora.engines.debate import DebateEngine
from agora.types import MechanismType
from tests.helpers import make_agent_output, make_selection


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
async def test_full_debate_run_on_simple_math_task() -> None:
    """Debate run should complete and produce a populated result artifact."""

    engine = DebateEngine(agent_count=3, max_rounds=4)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="math")

    outcome = await engine.run("What is the derivative of x^3 * sin(x)?", selection)

    assert outcome.result is not None
    assert outcome.result.final_answer != ""
    assert outcome.result.merkle_root != ""
    assert len(outcome.result.transcript_hashes) > 0


@pytest.mark.asyncio
async def test_adaptive_termination_fires_on_plateau() -> None:
    """Debate should be able to terminate early when information gain plateaus."""

    engine = DebateEngine(agent_count=3, max_rounds=4)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="math")

    outcome = await engine.run("What is the derivative of x^3 * sin(x)?", selection)

    assert outcome.result is not None
    assert outcome.state.round <= 4
    assert outcome.state.terminated_early is True


@pytest.mark.asyncio
async def test_mechanism_switch_triggers_when_monitor_requests(monkeypatch) -> None:
    """Debate should return switch signal when monitor reports divergence."""

    engine = DebateEngine(agent_count=3, max_rounds=4)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    monkeypatch.setattr(engine.monitor, "should_terminate", lambda history: (False, "continue"))
    monkeypatch.setattr(
        engine.monitor,
        "should_switch_mechanism",
        lambda history, current_mechanism: (True, MechanismType.VOTE, "forced switch"),
    )

    outcome = await engine.run("Compare two software architectures.", selection)

    assert outcome.switch_to_vote is True
    assert outcome.suggested_mechanism == MechanismType.VOTE
    assert outcome.result is None
