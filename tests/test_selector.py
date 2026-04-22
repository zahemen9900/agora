from __future__ import annotations

import pytest

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
    assert selection.mechanism in {MechanismType.DEBATE, MechanismType.VOTE}
