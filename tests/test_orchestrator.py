"""Tests for top-level orchestrator flow and mechanism switching."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agora.engines.debate import DebateEngineOutcome
from agora.engines.vote import VoteEngineOutcome
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.types import DebateState, DeliberationResult, MechanismType, VoteState
from tests.helpers import make_features, make_selection


@pytest.mark.asyncio
async def test_full_pipeline_returns_populated_result() -> None:
    """End-to-end orchestration should produce a complete result object."""

    orchestrator = AgoraOrchestrator(agent_count=3)
    result = await orchestrator.run("What is the capital of France?")

    assert result.task != ""
    assert result.final_answer != ""
    assert result.mechanism_used in {MechanismType.DEBATE, MechanismType.VOTE}
    assert result.merkle_root != ""
    assert len(result.transcript_hashes) > 0
    assert result.total_tokens_used >= 0
    assert result.total_latency_ms >= 0.0


@pytest.mark.asyncio
async def test_switch_from_debate_to_vote(monkeypatch) -> None:
    """If debate requests switch-to-vote, orchestrator should execute vote and return it."""

    orchestrator = AgoraOrchestrator(agent_count=3)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    async def fake_select(task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return selection

    async def fake_debate_run(task: str, selection):
        del task, selection
        debate_state = DebateState(
            task="switch test",
            task_features=make_features("reasoning"),
            factions={"pro": [], "opp": []},
            rebuttals={"pro": [], "opp": []},
        )
        return DebateEngineOutcome(
            state=debate_state,
            result=None,
            switch_to_vote=True,
            suggested_mechanism=MechanismType.VOTE,
            reason="forced switch",
        )

    async def fake_vote_run(task: str, selection):
        del task
        vote_state = VoteState(task="switch test", task_features=make_features("reasoning"))
        result = DeliberationResult(
            task="switch test",
            mechanism_used=MechanismType.VOTE,
            mechanism_selection=selection,
            final_answer="Option A",
            confidence=0.75,
            quorum_reached=True,
            round_count=1,
            agent_count=3,
            mechanism_switches=0,
            merkle_root="abc123",
            transcript_hashes=["h1", "h2"],
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=10,
            total_latency_ms=5.0,
            timestamp=datetime.now(UTC),
        )
        return VoteEngineOutcome(
            state=vote_state,
            result=result,
            switch_to_debate=False,
            reason="quorum_reached",
        )

    monkeypatch.setattr(orchestrator.selector, "select", fake_select)
    monkeypatch.setattr(orchestrator.debate_engine, "run", fake_debate_run)
    monkeypatch.setattr(orchestrator.vote_engine, "run", fake_vote_run)

    result = await orchestrator.run("switch me")

    assert result.mechanism_used == MechanismType.VOTE
    assert result.mechanism_switches == 1
