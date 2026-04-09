"""Tests for ISP-weighted vote engine."""

from __future__ import annotations

import pytest

from agora.engines.vote import VoteEngine
from agora.types import MechanismType, VoteState
from tests.helpers import make_agent_output, make_features, make_selection


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


@pytest.mark.asyncio
async def test_quorum_check_threshold_works() -> None:
    """Vote run should mark quorum for strongly concentrated weighted outcomes."""

    engine = VoteEngine(agent_count=3, quorum_threshold=0.6)
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

    outcome = await engine.run("What is the capital of France?", selection)

    assert outcome.state.quorum_reached is True
    assert outcome.result.quorum_reached is True
    assert outcome.result.final_answer != ""
