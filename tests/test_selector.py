from __future__ import annotations

import json

import pytest

from agora.selector.bandit import ThompsonSamplingSelector
from agora.agent import AgentCallError
from agora.selector.reasoning import ReasoningSelector, _ReasoningResponse
from agora.selector.selector import AgoraSelector
from agora.types import MechanismType
from tests.helpers import make_features


class _FailingReasoningCaller:
    async def call(self, *args: object, **kwargs: object) -> tuple[object, dict[str, object]]:
        del args, kwargs
        raise AgentCallError("selector provider unavailable")


class _ErroringReasoningCaller:
    def __init__(self, error: AgentCallError) -> None:
        self.error = error

    async def call(self, *args: object, **kwargs: object) -> tuple[object, dict[str, object]]:
        del args, kwargs
        raise self.error


class _CapturingReasoningCaller:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def call(self, *args: object, **kwargs: object) -> tuple[object, dict[str, object]]:
        del args
        self.calls.append(dict(kwargs))
        return (
            _ReasoningResponse(
                mechanism="delphi",
                confidence=0.78,
                reasoning="The task is multi-criteria and benefits from iterative anonymous revision.",
            ),
            {"input_tokens": 12, "output_tokens": 8, "latency_ms": 9.0},
        )


class _StatusError(RuntimeError):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class _FallbackReasoningCaller:
    def __init__(self) -> None:
        self.calls = 0

    async def call(self, *args: object, **kwargs: object) -> tuple[object, dict[str, object]]:
        del args, kwargs
        self.calls += 1
        return (
            _ReasoningResponse(
                mechanism="vote",
                confidence=0.74,
                reasoning="Fallback live provider still prefers an objective aggregation path.",
            ),
            {"input_tokens": 14, "output_tokens": 9, "latency_ms": 11.0},
        )


@pytest.mark.asyncio
async def test_selector_uses_heuristic_before_bandit_when_reasoning_fails() -> None:
    selector = AgoraSelector(reasoning_caller=_FailingReasoningCaller())

    selection = await selector.select(
        task_text="What is 17 * 19?",
        agent_count=4,
        stakes=0.0,
    )

    assert selection.mechanism == MechanismType.VOTE
    assert selection.selector_source == "heuristic_fallback"
    assert selection.selector_fallback_path == ["reasoning", "heuristic"]


@pytest.mark.asyncio
async def test_selector_uses_bandit_only_after_heuristic_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selector = AgoraSelector(reasoning_caller=_FailingReasoningCaller())

    def _explode(*args: object, **kwargs: object) -> tuple[MechanismType, float]:
        del args, kwargs
        raise RuntimeError("heuristic unavailable")

    monkeypatch.setattr(selector.heuristic, "select", _explode)

    selection = await selector.select(
        task_text="What is 17 * 19?",
        agent_count=4,
        stakes=0.0,
    )

    assert selection.selector_source == "bandit_fallback"
    assert selection.selector_fallback_path == ["reasoning", "heuristic", "bandit"]
    assert selection.mechanism in {
        MechanismType.DEBATE,
        MechanismType.VOTE,
        MechanismType.DELPHI,
    }


@pytest.mark.asyncio
async def test_selector_heuristic_can_choose_delphi_for_creative_tasks() -> None:
    selector = AgoraSelector(reasoning_caller=_FailingReasoningCaller())

    selection = await selector.select(
        task_text="Write three product taglines for a collaborative AI research lab.",
        agent_count=4,
        stakes=0.2,
    )

    assert selection.mechanism == MechanismType.DELPHI
    assert selection.selector_source == "heuristic_fallback"
    assert selection.selector_fallback_path == ["reasoning", "heuristic"]


def test_bandit_load_state_payload_seeds_missing_delphi_arms() -> None:
    selector = ThompsonSamplingSelector()
    legacy_payload = {
        "mechanisms": ["debate", "vote"],
        "arms": [
            {
                "mechanism": mechanism,
                "category": category,
                "alpha": 2.0,
                "beta_param": 1.5,
                "total_pulls": 3,
                "last_reward": 0.75,
            }
            for mechanism in ("debate", "vote")
            for category in ("math", "code", "reasoning", "factual", "creative")
        ],
    }

    selector.load_state_payload(json.loads(json.dumps(legacy_payload)))

    creative_delphi = selector.arms[(MechanismType.DELPHI, "creative")]
    reasoning_debate = selector.arms[(MechanismType.DEBATE, "reasoning")]

    assert creative_delphi.alpha == pytest.approx(1.0)
    assert creative_delphi.beta_param == pytest.approx(1.0)
    assert creative_delphi.total_pulls == 0
    assert reasoning_debate.alpha == pytest.approx(2.0)
    assert reasoning_debate.total_pulls == 3


@pytest.mark.asyncio
async def test_reasoning_selector_passes_hardened_routing_policy_to_model() -> None:
    caller = _CapturingReasoningCaller()
    selector = ReasoningSelector(caller=caller)

    selection = await selector.select(
        task_text="What product roadmap best balances reliability, cost, and research speed?",
        features=make_features("creative"),
        bandit_recommendation=(MechanismType.VOTE, 0.61),
        historical_performance={"creative": {"delphi": {"wins": 5}}},
    )

    assert selection.mechanism == MechanismType.DELPHI
    assert len(caller.calls) == 1
    system_prompt = str(caller.calls[0]["system_prompt"])
    assert "Do not choose a mechanism by habit" in system_prompt
    assert "Choose vote when the task is bounded, objective, and answer-checkable" in system_prompt
    assert "Choose debate when the task benefits from adversarial pressure" in system_prompt
    assert "Choose delphi when the task is open-ended, multi-criteria, or subjective" in system_prompt
    assert "Do not use stakes alone as a reason to escalate into debate" in system_prompt
    assert "Do not treat delphi as the generic choice for any hard task" in system_prompt


@pytest.mark.asyncio
async def test_reasoning_selector_uses_alternate_live_model_for_hard_provider_failure() -> None:
    primary_error = AgentCallError("Gemini API returned status 403 for model gemini-pro.")
    primary_error.__cause__ = _StatusError(403, "API key missing billing permission")
    fallback = _FallbackReasoningCaller()
    selector = ReasoningSelector(
        caller=_ErroringReasoningCaller(primary_error),
        fallback_callers=[fallback],
    )

    selection = await selector.select(
        task_text="Choose between a monolith and microservices for a narrow CRUD admin tool.",
        features=make_features("math"),
        bandit_recommendation=(MechanismType.DEBATE, 0.52),
        historical_performance=None,
    )

    assert selection.mechanism == MechanismType.VOTE
    assert fallback.calls == 1


@pytest.mark.asyncio
async def test_reasoning_selector_does_not_cross_fallback_for_retryable_high_demand_403() -> None:
    primary_error = AgentCallError("Gemini API returned status 403 for model gemini-pro.")
    primary_error.__cause__ = _StatusError(
        403,
        "The model is unavailable due to high demand. Please retry later.",
    )
    fallback = _FallbackReasoningCaller()
    selector = ReasoningSelector(
        caller=_ErroringReasoningCaller(primary_error),
        fallback_callers=[fallback],
    )

    with pytest.raises(AgentCallError):
        await selector.select(
            task_text="Pick the best mechanism for a high-stakes governance prompt.",
            features=make_features("reasoning"),
            bandit_recommendation=(MechanismType.DEBATE, 0.69),
            historical_performance=None,
        )

    assert fallback.calls == 0
