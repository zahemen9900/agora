from __future__ import annotations

import pytest

from agora.engines.delphi import DelphiEngine
from agora.sdk import AgoraArbitrator, AgoraNode
from agora.types import MechanismType
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
