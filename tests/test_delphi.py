from __future__ import annotations

import pytest

from agora.agent import AgentCallError
from agora.engines.delphi import DelphiEngine
from agora.sdk import AgoraArbitrator, AgoraNode
from agora.types import LocalProviderKeys, MechanismType
from tests.helpers import make_selection


def _make_delphi_agents() -> list:
    async def btc_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt
        if "Anonymous peer answers" in user_prompt:
            return {
                "answer": "BTC",
                "confidence": 0.9,
                "reasoning": "Peers reinforce the stronger answer.",
            }
        return {
            "answer": "BTC",
            "confidence": 0.86,
            "reasoning": "Independent prior favors BTC.",
        }

    async def revising_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt
        if "Anonymous peer answers" in user_prompt and user_prompt.count("BTC") >= 2:
            return {
                "answer": "BTC",
                "confidence": 0.82,
                "reasoning": "Anonymous peer evidence resolves the disagreement.",
            }
        return {
            "answer": "ETH",
            "confidence": 0.58,
            "reasoning": "Initial independent read favored ETH.",
        }

    return [btc_agent, revising_agent, btc_agent]


def test_delphi_default_flash_caller_uses_local_provider_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _FakeFlashCaller:
        model = "flash-model"

    def fake_flash_caller(**kwargs: object) -> _FakeFlashCaller:
        captured.update(kwargs)
        return _FakeFlashCaller()

    monkeypatch.setattr("agora.engines.delphi.flash_caller", fake_flash_caller)

    engine = DelphiEngine(
        agent_count=3,
        provider_keys=LocalProviderKeys(gemini_api_key="gem-byok-key"),
    )

    caller = engine._get_flash_caller()

    assert caller.model == "flash-model"
    assert captured["gemini_api_key"] == "gem-byok-key"


class _StatusError(RuntimeError):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


@pytest.mark.asyncio
async def test_delphi_hosted_participants_use_balanced_provider_cycle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FakeCaller:
        def __init__(self, model: str) -> None:
            self.model = model

        async def call(self, **kwargs: object) -> tuple[object, dict[str, object]]:
            response_format = kwargs["response_format"]
            response = response_format(
                answer=f"answer-from-{self.model}",
                confidence=0.7,
                reasoning=f"reasoning-from-{self.model}",
            )
            return response, {"tokens": 11, "latency_ms": 7.0}

    monkeypatch.setattr(
        "agora.engines.delphi.pro_caller",
        lambda **_: _FakeCaller("gemini-pro-model"),
    )
    monkeypatch.setattr(
        "agora.engines.delphi.flash_caller",
        lambda **_: _FakeCaller("gemini-flash-model"),
    )
    monkeypatch.setattr(
        "agora.engines.delphi.openrouter_caller",
        lambda **_: _FakeCaller("openrouter-model"),
    )
    monkeypatch.setattr(
        "agora.engines.delphi.claude_caller",
        lambda **_: _FakeCaller("claude-model"),
    )

    engine = DelphiEngine(
        agent_count=4,
        quorum_threshold=0.95,
        allow_offline_fallback=False,
    )

    result = await engine.run(
        task="Should we start with a monolith or microservices?",
        selection=make_selection(mechanism=MechanismType.DELPHI, topic_category="reasoning"),
    )

    assert result.agent_models_used == [
        "gemini-pro-model",
        "gemini-flash-model",
        "openrouter-model",
        "claude-model",
    ]
    assert result.fallback_count == 0


@pytest.mark.asyncio
async def test_delphi_uses_openrouter_live_fallback_for_hard_gemini_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _GeminiFailureCaller:
        model = "gemini-pro-model"

        async def call(self, **kwargs: object) -> tuple[object, dict[str, object]]:
            del kwargs
            error = AgentCallError("Gemini API returned status 403 for model gemini-pro-model.")
            error.__cause__ = _StatusError(403, "billing permission missing")
            raise error

    class _OpenRouterSuccessCaller:
        model = "openrouter-model"

        async def call(self, **kwargs: object) -> tuple[object, dict[str, object]]:
            response_format = kwargs["response_format"]
            response = response_format(
                answer="Fallback answer",
                confidence=0.81,
                reasoning="OpenRouter fallback preserved live execution.",
            )
            return response, {"tokens": 17, "latency_ms": 9.0}

    monkeypatch.setattr("agora.engines.delphi.pro_caller", lambda **_: _GeminiFailureCaller())
    monkeypatch.setattr("agora.engines.delphi.openrouter_caller", lambda **_: _OpenRouterSuccessCaller())

    engine = DelphiEngine(
        agent_count=1,
        quorum_threshold=0.6,
        allow_offline_fallback=False,
    )

    result = await engine.run(
        task="Should we use a monolith or microservices?",
        selection=make_selection(mechanism=MechanismType.DELPHI, topic_category="reasoning"),
    )

    assert result.final_answer == "Fallback answer"
    assert result.agent_models_used == ["openrouter-model"]
    assert result.fallback_count >= 1
    assert all(event.fallback_type == "alternate_live_model" for event in result.fallback_events)


@pytest.mark.asyncio
async def test_delphi_does_not_cross_fallback_for_retryable_high_demand_gemini_403(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _GeminiHighDemandCaller:
        model = "gemini-pro-model"

        async def call(self, **kwargs: object) -> tuple[object, dict[str, object]]:
            del kwargs
            error = AgentCallError("Gemini API returned status 403 for model gemini-pro-model.")
            error.__cause__ = _StatusError(
                403,
                "The model is unavailable due to high demand. Please retry later.",
            )
            raise error

    class _OpenRouterShouldNotRunCaller:
        model = "openrouter-model"

        async def call(self, **kwargs: object) -> tuple[object, dict[str, object]]:
            del kwargs
            raise AssertionError("OpenRouter live fallback should not run for retryable high demand")

    monkeypatch.setattr("agora.engines.delphi.pro_caller", lambda **_: _GeminiHighDemandCaller())
    monkeypatch.setattr(
        "agora.engines.delphi.openrouter_caller",
        lambda **_: _OpenRouterShouldNotRunCaller(),
    )

    engine = DelphiEngine(
        agent_count=1,
        quorum_threshold=0.6,
        allow_offline_fallback=False,
    )

    with pytest.raises(AgentCallError):
        await engine.run(
            task="Should we use a monolith or microservices?",
            selection=make_selection(mechanism=MechanismType.DELPHI, topic_category="reasoning"),
        )


@pytest.mark.asyncio
async def test_delphi_engine_converges_with_custom_agents() -> None:
    engine = DelphiEngine(
        agent_count=3,
        quorum_threshold=0.6,
        allow_offline_fallback=False,
    )

    result = await engine.run(
        task="Should a cautious treasury buy BTC or ETH?",
        selection=make_selection(mechanism=MechanismType.DELPHI, topic_category="creative"),
        custom_agents=_make_delphi_agents(),
    )

    assert result.mechanism_used == MechanismType.DELPHI
    assert result.final_answer == "BTC"
    assert result.quorum_reached is True
    assert result.round_count == 2
    assert len(result.convergence_history) >= 2
    assert result.mechanism_trace[0].mechanism == MechanismType.DELPHI


@pytest.mark.asyncio
async def test_sdk_local_mode_supports_delphi_custom_agents() -> None:
    arbitrator = AgoraArbitrator(
        mechanism="delphi",
        agent_count=3,
        strict_verification=False,
    )

    result = await arbitrator.arbitrate(
        "Should a cautious treasury buy BTC or ETH?",
        agents=_make_delphi_agents(),
    )
    verification = await arbitrator.verify_receipt(result, strict=False)
    await arbitrator.aclose()

    assert result.mechanism_used == MechanismType.DELPHI
    assert result.final_answer == "BTC"
    assert result.quorum_reached is True
    assert verification["valid"] is True


@pytest.mark.asyncio
async def test_agora_node_accepts_delphi_configuration() -> None:
    node = AgoraNode(
        mechanism="delphi",
        agent_count=3,
        allow_mechanism_switch=False,
        strict_verification=False,
    )
    try:
        assert node.arbitrator.config.mechanism == "delphi"
        assert node.arbitrator.config.agent_count == 3
        assert node.arbitrator.config.allow_mechanism_switch is False
    finally:
        await node.aclose()
