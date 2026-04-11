"""Tests for top-level orchestrator flow and mechanism switching."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agora.engines.debate import DebateEngineOutcome
from agora.engines.vote import VoteEngineOutcome
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.solana.client import build_task_id
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


@pytest.mark.asyncio
async def test_switch_from_vote_to_debate(monkeypatch) -> None:
    """If vote requests switch-to-debate, orchestrator should execute debate and return it."""

    orchestrator = AgoraOrchestrator(agent_count=3)
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="reasoning")

    async def fake_select(task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return selection

    async def fake_vote_run(task: str, selection):
        del task, selection
        vote_state = VoteState(task="switch test", task_features=make_features("reasoning"))
        vote_result = DeliberationResult(
            task="switch test",
            mechanism_used=MechanismType.VOTE,
            mechanism_selection=make_selection(mechanism=MechanismType.VOTE),
            final_answer="Option A",
            confidence=0.45,
            quorum_reached=False,
            round_count=1,
            agent_count=3,
            mechanism_switches=0,
            merkle_root="vote-root",
            transcript_hashes=["v1"],
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=5,
            total_latency_ms=2.0,
            timestamp=datetime.now(UTC),
        )
        return VoteEngineOutcome(
            state=vote_state,
            result=vote_result,
            switch_to_debate=True,
            reason="quorum_not_reached",
        )

    async def fake_debate_run(task: str, selection):
        del task
        debate_state = DebateState(
            task="switch test",
            task_features=make_features("reasoning"),
            factions={"pro": [], "opp": []},
            rebuttals={"pro": [], "opp": []},
        )
        debate_result = DeliberationResult(
            task="switch test",
            mechanism_used=MechanismType.DEBATE,
            mechanism_selection=selection,
            final_answer="Debated answer",
            confidence=0.8,
            quorum_reached=True,
            round_count=2,
            agent_count=3,
            mechanism_switches=0,
            merkle_root="debate-root",
            transcript_hashes=["d1", "d2"],
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=12,
            total_latency_ms=8.0,
            timestamp=datetime.now(UTC),
        )
        return DebateEngineOutcome(
            state=debate_state,
            result=debate_result,
            switch_to_vote=False,
            suggested_mechanism=None,
            reason="completed",
        )

    monkeypatch.setattr(orchestrator.selector, "select", fake_select)
    monkeypatch.setattr(orchestrator.vote_engine, "run", fake_vote_run)
    monkeypatch.setattr(orchestrator.debate_engine, "run", fake_debate_run)

    result = await orchestrator.run("switch me")

    assert result.mechanism_used == MechanismType.DEBATE
    assert result.mechanism_switches == 1


@pytest.mark.asyncio
async def test_run_and_learn_credits_final_mechanism(monkeypatch) -> None:
    """Bandit updates should credit the mechanism that produced the final answer."""

    orchestrator = AgoraOrchestrator(agent_count=3)
    result = DeliberationResult(
        task="switch test",
        mechanism_used=MechanismType.VOTE,
        mechanism_selection=make_selection(
            mechanism=MechanismType.DEBATE,
            topic_category="reasoning",
        ),
        final_answer="Option A",
        confidence=0.9,
        quorum_reached=True,
        round_count=1,
        agent_count=3,
        mechanism_switches=1,
        merkle_root="root",
        transcript_hashes=["h1"],
        convergence_history=[],
        locked_claims=[],
        total_tokens_used=10,
        total_latency_ms=4.0,
        timestamp=datetime.now(UTC),
    )

    async def fake_run(task: str, stakes=None):
        del task, stakes
        return result

    captured: dict[str, object] = {}

    def fake_update_with_mechanism(selection, reward, mechanism):
        captured["selection"] = selection
        captured["reward"] = reward
        captured["mechanism"] = mechanism

    monkeypatch.setattr(orchestrator, "run", fake_run)
    monkeypatch.setattr(orchestrator.selector, "update_with_mechanism", fake_update_with_mechanism)

    learned = await orchestrator.run_and_learn("switch test")

    assert learned is result
    assert captured["selection"] == result.mechanism_selection
    assert captured["reward"] == 0.9
    assert captured["mechanism"] == MechanismType.VOTE


@pytest.mark.asyncio
async def test_run_can_auto_submit_receipt(monkeypatch) -> None:
    """Auto-submit should attach settlement metadata when a client is configured."""

    class _FakeSolanaClient:
        def __init__(self) -> None:
            self.submitted_task_id: str | None = None
            self.switch_calls: list[tuple[str, str, str]] = []

        async def submit_receipt(self, receipt) -> str:
            self.submitted_task_id = receipt.task_id
            return "receipt-tx"

        async def record_mechanism_switch(
            self, task_id: str, from_mechanism: str, to_mechanism: str
        ) -> str:
            self.switch_calls.append((task_id, from_mechanism, to_mechanism))
            return "switch-tx"

        async def get_task_status(self, task_id: str) -> dict[str, str]:
            return {"task_id": task_id, "status": "confirmed"}

    orchestrator = AgoraOrchestrator(
        agent_count=3,
        solana_client=_FakeSolanaClient(),
        auto_submit_receipts=True,
    )
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    async def fake_select(task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return selection

    async def fake_execute(task: str, selection):
        del task, selection
        return DeliberationResult(
            task="switch test",
            mechanism_used=MechanismType.VOTE,
            mechanism_selection=make_selection(
                mechanism=MechanismType.DEBATE,
                topic_category="reasoning",
            ),
            final_answer="Option A",
            confidence=0.82,
            quorum_reached=True,
            round_count=1,
            agent_count=3,
            mechanism_switches=1,
            merkle_root="root",
            transcript_hashes=["h1"],
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=10,
            total_latency_ms=2.0,
            timestamp=datetime.now(UTC),
        )

    monkeypatch.setattr(orchestrator.selector, "select", fake_select)
    monkeypatch.setattr(orchestrator, "_execute_mechanism", fake_execute)

    result = await orchestrator.run("switch test")

    assert result.chain_submission is not None
    assert result.chain_submission.receipt_tx_signature == "receipt-tx"
    assert result.chain_submission.mechanism_switch_tx_signature == "switch-tx"
    assert result.chain_submission.task_id == build_task_id("switch test")
