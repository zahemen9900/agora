"""Tests for top-level orchestrator flow and mechanism switching."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

import agora.runtime.orchestrator as orchestrator_module
from agora.engines.debate import DebateEngineOutcome
from agora.engines.vote import VoteEngineOutcome
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.types import DebateState, DeliberationResult, LocalProviderKeys, MechanismType, VoteState
from tests.helpers import make_features, make_selection

DEBATE_TEST_MODEL = "gemini-3-flash-preview"
VOTE_TEST_MODEL = "moonshotai/kimi-k2-thinking"


@pytest.fixture(autouse=True)
def _stub_selector_reasoning_caller(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep orchestrator construction deterministic without provider credentials."""

    monkeypatch.setattr(orchestrator_module, "pro_caller", lambda **_kwargs: None)


@pytest.mark.asyncio
async def test_full_pipeline_returns_populated_result() -> None:
    """End-to-end orchestration should produce a complete result object."""

    orchestrator = AgoraOrchestrator(agent_count=3)

    async def paris_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "Paris",
            "confidence": 0.9,
            "predicted_group_answer": "Paris",
            "reasoning": "Deterministic local test agent.",
        }

    result = await orchestrator.run(
        "What is the capital of France?",
        mechanism_override=MechanismType.VOTE,
        agents=[paris_agent, paris_agent, paris_agent],
    )

    assert result.task != ""
    assert result.final_answer != ""
    assert result.mechanism_used in {MechanismType.DEBATE, MechanismType.VOTE}
    assert result.merkle_root != ""
    assert len(result.transcript_hashes) > 0
    assert result.total_tokens_used >= 0
    assert result.total_latency_ms >= 0.0
    assert result.agent_models_used


@pytest.mark.asyncio
async def test_orchestrator_passes_local_provider_keys_to_selector_reasoning_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _FakeReasoningCaller:
        async def call(self, **_kwargs: object) -> tuple[object, dict[str, object]]:
            from agora.selector.reasoning import _ReasoningResponse

            return (
                _ReasoningResponse(
                    mechanism="vote",
                    confidence=0.7,
                    reasoning="Bounded objective task.",
                ),
                {},
            )

    def fake_pro_caller(**kwargs: object) -> _FakeReasoningCaller:
        captured.update(kwargs)
        return _FakeReasoningCaller()

    monkeypatch.setattr(orchestrator_module, "pro_caller", fake_pro_caller)

    orchestrator = AgoraOrchestrator(
        agent_count=3,
        local_provider_keys=LocalProviderKeys(gemini_api_key="gem-byok-key"),
    )

    await orchestrator.selector.reasoning.select(
        task_text="What is 17 * 19?",
        features=make_features("factual"),
        bandit_recommendation=(MechanismType.VOTE, 0.8),
        historical_performance={},
    )

    assert captured["gemini_api_key"] == "gem-byok-key"


@pytest.mark.asyncio
async def test_switch_from_debate_to_vote(monkeypatch) -> None:
    """If debate requests switch-to-vote, orchestrator should execute vote and return it."""

    orchestrator = AgoraOrchestrator(agent_count=3)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    async def fake_select(task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return selection

    async def fake_debate_run(task: str, selection, allow_switch: bool = True):
        del task, selection, allow_switch
        debate_state = DebateState(
            task="switch test",
            task_features=make_features("reasoning"),
            factions={"pro": [], "opp": []},
            rebuttals={"pro": [], "opp": []},
            transcript_hashes=["d0"],
        )
        return DebateEngineOutcome(
            state=debate_state,
            result=None,
            switch_to_vote=True,
            suggested_mechanism=MechanismType.VOTE,
            reason="forced switch",
            agent_models_used=[DEBATE_TEST_MODEL],
            model_token_usage={DEBATE_TEST_MODEL: 7},
            model_latency_ms={DEBATE_TEST_MODEL: 3.0},
            model_input_token_usage={DEBATE_TEST_MODEL: 2},
            model_output_token_usage={DEBATE_TEST_MODEL: 3},
            model_thinking_token_usage={DEBATE_TEST_MODEL: 2},
            total_tokens_used=7,
            input_tokens_used=2,
            output_tokens_used=3,
            thinking_tokens_used=2,
            total_latency_ms=3.0,
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
            agent_models_used=[VOTE_TEST_MODEL],
            model_token_usage={VOTE_TEST_MODEL: 5},
            model_latency_ms={VOTE_TEST_MODEL: 2.0},
            model_input_token_usage={VOTE_TEST_MODEL: 1},
            model_output_token_usage={VOTE_TEST_MODEL: 2},
            model_thinking_token_usage={VOTE_TEST_MODEL: 2},
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=5,
            input_tokens_used=1,
            output_tokens_used=2,
            thinking_tokens_used=2,
            total_latency_ms=2.0,
            timestamp=datetime.now(UTC),
        )
        return VoteEngineOutcome(
            state=vote_state,
            result=result,
            switch_to_debate=False,
            reason="quorum_reached",
            agent_models_used=[VOTE_TEST_MODEL],
            model_token_usage={VOTE_TEST_MODEL: 5},
            model_latency_ms={VOTE_TEST_MODEL: 2.0},
            model_input_token_usage={VOTE_TEST_MODEL: 1},
            model_output_token_usage={VOTE_TEST_MODEL: 2},
            model_thinking_token_usage={VOTE_TEST_MODEL: 2},
            total_tokens_used=5,
            input_tokens_used=1,
            output_tokens_used=2,
            thinking_tokens_used=2,
            total_latency_ms=2.0,
        )

    monkeypatch.setattr(orchestrator.selector, "select", fake_select)
    monkeypatch.setattr(orchestrator.debate_engine, "run", fake_debate_run)
    monkeypatch.setattr(orchestrator.vote_engine, "run", fake_vote_run)

    result = await orchestrator.run("switch me")

    assert result.mechanism_used == MechanismType.VOTE
    assert result.mechanism_switches == 1
    assert len(result.transcript_hashes) == 4
    assert result.transcript_hashes[0] == "d0"
    assert result.transcript_hashes[-2:] == ["h1", "h2"]
    assert result.merkle_root == orchestrator.hasher.build_merkle_tree(result.transcript_hashes)
    assert result.mechanism_trace[0].mechanism == MechanismType.DEBATE
    assert result.mechanism_trace[0].switch_reason == "forced switch"
    assert result.mechanism_trace[0].switch_reason_hash is not None
    assert result.model_token_usage == {DEBATE_TEST_MODEL: 7, VOTE_TEST_MODEL: 5}
    assert result.model_input_token_usage == {DEBATE_TEST_MODEL: 2, VOTE_TEST_MODEL: 1}
    assert result.model_output_token_usage == {DEBATE_TEST_MODEL: 3, VOTE_TEST_MODEL: 2}
    assert result.model_thinking_token_usage == {DEBATE_TEST_MODEL: 2, VOTE_TEST_MODEL: 2}
    assert result.total_tokens_used == 12
    assert result.input_tokens_used == 3
    assert result.output_tokens_used == 5
    assert result.thinking_tokens_used == 4
    assert result.cost is not None
    assert set(result.model_telemetry) == {DEBATE_TEST_MODEL, VOTE_TEST_MODEL}


@pytest.mark.asyncio
async def test_debate_to_vote_switch_events_include_execution_segment_metadata(
    monkeypatch,
) -> None:
    """Switched runtime streams should tag each engine segment explicitly."""

    monkeypatch.setattr(orchestrator_module, "pro_caller", lambda **_kwargs: None)
    orchestrator = AgoraOrchestrator(agent_count=3)
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    captured_events: list[tuple[str, dict[str, object]]] = []

    async def fake_select(task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return selection

    async def fake_debate_run(
        task: str,
        selection,
        event_sink=None,
        allow_switch: bool = True,
    ):
        del task, selection, allow_switch
        if event_sink is not None:
            await event_sink(
                "agent_output",
                {
                    "agent_id": "agent-1",
                    "stage": "opening",
                    "round_number": 1,
                    "content": "pre-switch",
                },
            )
        debate_state = DebateState(
            task="switch test",
            task_features=make_features("reasoning"),
            factions={"pro": [], "opp": []},
            rebuttals={"pro": [], "opp": []},
            transcript_hashes=["d0"],
            round=1,
        )
        return DebateEngineOutcome(
            state=debate_state,
            result=None,
            switch_to_vote=True,
            suggested_mechanism=MechanismType.VOTE,
            reason="forced switch",
        )

    async def fake_vote_run(task: str, selection, event_sink=None):
        del task
        if event_sink is not None:
            await event_sink(
                "agent_output",
                {
                    "agent_id": "agent-1",
                    "stage": "vote",
                    "round_number": 1,
                    "content": "post-switch",
                },
            )
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
            total_tokens_used=0,
            total_latency_ms=0.0,
            timestamp=datetime.now(UTC),
        )
        return VoteEngineOutcome(
            state=vote_state,
            result=result,
            switch_to_debate=False,
            reason="quorum_reached",
        )

    async def event_sink(event_type: str, payload: dict[str, object]) -> None:
        captured_events.append((event_type, payload))

    monkeypatch.setattr(orchestrator.selector, "select", fake_select)
    monkeypatch.setattr(orchestrator.debate_engine, "run", fake_debate_run)
    monkeypatch.setattr(orchestrator.vote_engine, "run", fake_vote_run)

    await orchestrator.run("switch me", event_sink=event_sink)

    pre_switch = next(
        payload
        for event_type, payload in captured_events
        if event_type == "agent_output" and payload.get("content") == "pre-switch"
    )
    switch = next(
        payload for event_type, payload in captured_events if event_type == "mechanism_switch"
    )
    post_switch = next(
        payload
        for event_type, payload in captured_events
        if event_type == "agent_output" and payload.get("content") == "post-switch"
    )

    assert pre_switch["execution_segment"] == 0
    assert pre_switch["mechanism"] == "debate"
    assert pre_switch["segment_mechanism"] == "debate"
    assert pre_switch["segment_round"] == 1
    assert switch["execution_segment"] == 0
    assert switch["mechanism"] == "debate"
    assert switch["segment_mechanism"] == "debate"
    assert switch["next_execution_segment"] == 1
    assert switch["next_segment_mechanism"] == "vote"
    assert switch["segment_round"] == 1
    assert post_switch["execution_segment"] == 1
    assert post_switch["mechanism"] == "vote"
    assert post_switch["segment_mechanism"] == "vote"
    assert post_switch["segment_round"] == 1


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
        vote_state = VoteState(
            task="switch test",
            task_features=make_features("reasoning"),
            transcript_hashes=["v1"],
        )
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
            agent_models_used=[VOTE_TEST_MODEL],
            model_token_usage={VOTE_TEST_MODEL: 4},
            model_latency_ms={VOTE_TEST_MODEL: 2.0},
            model_input_token_usage={VOTE_TEST_MODEL: 2},
            model_output_token_usage={VOTE_TEST_MODEL: 1},
            model_thinking_token_usage={VOTE_TEST_MODEL: 1},
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=4,
            input_tokens_used=2,
            output_tokens_used=1,
            thinking_tokens_used=1,
            total_latency_ms=2.0,
            timestamp=datetime.now(UTC),
        )
        return VoteEngineOutcome(
            state=vote_state,
            result=vote_result,
            switch_to_debate=True,
            reason="quorum_not_reached",
            agent_models_used=[VOTE_TEST_MODEL],
            model_token_usage={VOTE_TEST_MODEL: 4},
            model_latency_ms={VOTE_TEST_MODEL: 2.0},
            model_input_token_usage={VOTE_TEST_MODEL: 2},
            model_output_token_usage={VOTE_TEST_MODEL: 1},
            model_thinking_token_usage={VOTE_TEST_MODEL: 1},
            total_tokens_used=4,
            input_tokens_used=2,
            output_tokens_used=1,
            thinking_tokens_used=1,
            total_latency_ms=2.0,
        )

    async def fake_debate_run(task: str, selection, allow_switch: bool = True):
        del task, allow_switch
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
            agent_models_used=[DEBATE_TEST_MODEL],
            model_token_usage={DEBATE_TEST_MODEL: 8},
            model_latency_ms={DEBATE_TEST_MODEL: 6.0},
            model_input_token_usage={DEBATE_TEST_MODEL: 3},
            model_output_token_usage={DEBATE_TEST_MODEL: 3},
            model_thinking_token_usage={DEBATE_TEST_MODEL: 2},
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=8,
            input_tokens_used=3,
            output_tokens_used=3,
            thinking_tokens_used=2,
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
    assert len(result.transcript_hashes) == 4
    assert result.transcript_hashes[0] == "v1"
    assert result.transcript_hashes[-2:] == ["d1", "d2"]
    assert result.merkle_root == orchestrator.hasher.build_merkle_tree(result.transcript_hashes)
    assert result.mechanism_trace[0].mechanism == MechanismType.VOTE
    assert result.mechanism_trace[0].switch_reason == "quorum_not_reached"
    assert result.model_token_usage == {VOTE_TEST_MODEL: 4, DEBATE_TEST_MODEL: 8}
    assert result.model_input_token_usage == {VOTE_TEST_MODEL: 2, DEBATE_TEST_MODEL: 3}
    assert result.model_output_token_usage == {VOTE_TEST_MODEL: 1, DEBATE_TEST_MODEL: 3}
    assert result.model_thinking_token_usage == {VOTE_TEST_MODEL: 1, DEBATE_TEST_MODEL: 2}
    assert result.input_tokens_used == 5
    assert result.output_tokens_used == 4
    assert result.thinking_tokens_used == 3
    assert result.cost is not None


@pytest.mark.asyncio
async def test_vote_to_debate_switch_events_include_execution_segment_metadata(
    monkeypatch,
) -> None:
    """Vote-to-debate switches should stream the second debate in a new segment."""

    monkeypatch.setattr(orchestrator_module, "pro_caller", lambda **_kwargs: None)
    orchestrator = AgoraOrchestrator(agent_count=3)
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="reasoning")
    captured_events: list[tuple[str, dict[str, object]]] = []

    async def fake_select(task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return selection

    async def fake_vote_run(task: str, selection, event_sink=None):
        del task
        if event_sink is not None:
            await event_sink(
                "agent_output",
                {
                    "agent_id": "agent-1",
                    "stage": "vote",
                    "round_number": 1,
                    "content": "pre-switch",
                },
            )
        vote_state = VoteState(
            task="switch test",
            task_features=make_features("reasoning"),
            transcript_hashes=["v1"],
        )
        vote_result = DeliberationResult(
            task="switch test",
            mechanism_used=MechanismType.VOTE,
            mechanism_selection=selection,
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
            total_tokens_used=0,
            total_latency_ms=0.0,
            timestamp=datetime.now(UTC),
        )
        return VoteEngineOutcome(
            state=vote_state,
            result=vote_result,
            switch_to_debate=True,
            reason="quorum_not_reached",
        )

    async def fake_debate_run(
        task: str,
        selection,
        event_sink=None,
        allow_switch: bool = True,
    ):
        del task, allow_switch
        if event_sink is not None:
            await event_sink(
                "agent_output",
                {
                    "agent_id": "agent-1",
                    "stage": "opening",
                    "round_number": 1,
                    "content": "post-switch",
                },
            )
        debate_state = DebateState(
            task="switch test",
            task_features=make_features("reasoning"),
            factions={"pro": [], "opp": []},
            rebuttals={"pro": [], "opp": []},
            transcript_hashes=["d1"],
            round=1,
        )
        debate_result = DeliberationResult(
            task="switch test",
            mechanism_used=MechanismType.DEBATE,
            mechanism_selection=selection,
            final_answer="Debated answer",
            confidence=0.8,
            quorum_reached=True,
            round_count=1,
            agent_count=3,
            mechanism_switches=0,
            merkle_root="debate-root",
            transcript_hashes=["d1"],
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=0,
            total_latency_ms=0.0,
            timestamp=datetime.now(UTC),
        )
        return DebateEngineOutcome(
            state=debate_state,
            result=debate_result,
            switch_to_vote=False,
            suggested_mechanism=None,
            reason="completed",
        )

    async def event_sink(event_type: str, payload: dict[str, object]) -> None:
        captured_events.append((event_type, payload))

    monkeypatch.setattr(orchestrator.selector, "select", fake_select)
    monkeypatch.setattr(orchestrator.vote_engine, "run", fake_vote_run)
    monkeypatch.setattr(orchestrator.debate_engine, "run", fake_debate_run)

    await orchestrator.run("switch me", event_sink=event_sink)

    pre_switch = next(
        payload
        for event_type, payload in captured_events
        if event_type == "agent_output" and payload.get("content") == "pre-switch"
    )
    switch = next(
        payload for event_type, payload in captured_events if event_type == "mechanism_switch"
    )
    post_switch = next(
        payload
        for event_type, payload in captured_events
        if event_type == "agent_output" and payload.get("content") == "post-switch"
    )

    assert pre_switch["execution_segment"] == 0
    assert pre_switch["mechanism"] == "vote"
    assert pre_switch["segment_mechanism"] == "vote"
    assert pre_switch["segment_round"] == 1
    assert switch["execution_segment"] == 0
    assert switch["mechanism"] == "vote"
    assert switch["segment_mechanism"] == "vote"
    assert switch["next_execution_segment"] == 1
    assert switch["next_segment_mechanism"] == "debate"
    assert switch["segment_round"] == 1
    assert post_switch["execution_segment"] == 1
    assert post_switch["mechanism"] == "debate"
    assert post_switch["segment_mechanism"] == "debate"
    assert post_switch["segment_round"] == 1


@pytest.mark.asyncio
async def test_mechanism_override_pins_vote_without_switch(monkeypatch) -> None:
    """Pinned mechanism overrides should not auto-switch into the other engine."""

    orchestrator = AgoraOrchestrator(agent_count=4)

    async def fail_debate_run(*_args, **_kwargs):
        raise AssertionError("Debate engine should not run for a forced vote override")

    async def fake_vote_run(task: str, selection):
        del task
        vote_state = VoteState(task="force vote", task_features=make_features("reasoning"))
        result = DeliberationResult(
            task="force vote",
            mechanism_used=MechanismType.VOTE,
            mechanism_selection=selection,
            final_answer="Option A",
            confidence=0.4,
            quorum_reached=False,
            round_count=1,
            agent_count=4,
            mechanism_switches=0,
            merkle_root="vote-root",
            transcript_hashes=["v1", "v2", "v3", "v4"],
            agent_models_used=[
                "gemini-3-flash-preview",
                "moonshotai/kimi-k2-thinking",
                "gemini-3.1-flash-lite-preview",
                "claude-sonnet-4-6",
            ],
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=20,
            total_latency_ms=10.0,
            timestamp=datetime.now(UTC),
        )
        return VoteEngineOutcome(
            state=vote_state,
            result=result,
            switch_to_debate=True,
            reason="quorum_not_reached",
        )

    monkeypatch.setattr(orchestrator.debate_engine, "run", fail_debate_run)
    monkeypatch.setattr(orchestrator.vote_engine, "run", fake_vote_run)

    result = await orchestrator.run("force vote", mechanism_override=MechanismType.VOTE)

    assert result.mechanism_used == MechanismType.VOTE
    assert result.mechanism_selection.mechanism == MechanismType.VOTE
    assert result.mechanism_switches == 0
    assert "moonshotai/kimi-k2-thinking" in result.agent_models_used


@pytest.mark.asyncio
async def test_mechanism_override_executes_delphi_when_supported() -> None:
    """Explicit Delphi overrides should dispatch to the Delphi engine."""

    orchestrator = AgoraOrchestrator(agent_count=3)

    expected = DeliberationResult(
        task="force delphi",
        mechanism_used=MechanismType.DELPHI,
        mechanism_selection=make_selection(
            mechanism=MechanismType.DELPHI,
            topic_category="reasoning",
        ),
        final_answer="Delphi answer",
        confidence=0.77,
        quorum_reached=True,
        round_count=2,
        agent_count=3,
        mechanism_switches=0,
        merkle_root="delphi-root",
        transcript_hashes=["h1", "h2", "h3"],
        agent_models_used=[VOTE_TEST_MODEL],
        model_token_usage={VOTE_TEST_MODEL: 9},
        model_latency_ms={VOTE_TEST_MODEL: 3.0},
        model_input_token_usage={VOTE_TEST_MODEL: 4},
        model_output_token_usage={VOTE_TEST_MODEL: 3},
        model_thinking_token_usage={VOTE_TEST_MODEL: 2},
        convergence_history=[],
        locked_claims=[],
        total_tokens_used=9,
        input_tokens_used=4,
        output_tokens_used=3,
        thinking_tokens_used=2,
        total_latency_ms=3.0,
        timestamp=datetime.now(UTC),
    )

    class _FakeDelphiEngine:
        async def run(self, task: str, selection, **_kwargs):
            assert task == "force delphi"
            assert selection.mechanism == MechanismType.DELPHI
            return expected

    orchestrator.delphi_engine = _FakeDelphiEngine()

    result = await orchestrator.run("force delphi", mechanism_override=MechanismType.DELPHI)

    assert result.mechanism_used == MechanismType.DELPHI
    assert result.final_answer == "Delphi answer"


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
