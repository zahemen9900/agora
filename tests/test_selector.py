from __future__ import annotations

import json

import pytest

from agora.selector.bandit import ThompsonSamplingSelector
from agora.agent import AgentCallError
from agora.selector.selector import AgoraSelector
from agora.types import MechanismType


class _FailingReasoningCaller:
    async def call(self, *args: object, **kwargs: object) -> tuple[object, dict[str, object]]:
        del args, kwargs
        raise AgentCallError("selector provider unavailable")


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
