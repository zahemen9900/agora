"""Focused regressions for runtime provenance and hosted protocol strictness."""

from __future__ import annotations

from typing import Any

import pytest

from agora.engines.debate import DebateEngine, _RebuttalResponse
from agora.engines.vote import VoteEngine, _VoteResponse
from agora.sdk import AgoraArbitrator, HostedTaskProtocolError


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self._payload

    def raise_for_status(self) -> None:
        return None


def test_debate_schema_coercion_uses_neutral_confidence_and_marks_provenance() -> None:
    """Schema-coerced live text must not inherit offline fallback confidence."""

    fallback = _RebuttalResponse(answer="fallback", defense="fallback", confidence=0.91)

    response, provenance = DebateEngine._coerce_debate_response(
        response_model=_RebuttalResponse,
        response_text='{"answer":"Option A","defense":"Direct rebuttal"}',
        fallback=fallback,
    )

    assert isinstance(response, _RebuttalResponse)
    assert response.answer == "Option A"
    assert response.confidence == pytest.approx(0.5)
    assert provenance == "schema_coercion"


def test_vote_schema_coercion_uses_neutral_confidence_and_marks_provenance() -> None:
    """Vote coercion should stay truthful about live schema repair."""

    fallback = _VoteResponse(
        answer="fallback",
        confidence=0.97,
        predicted_group_answer="fallback",
        reasoning="fallback",
    )

    response, provenance = VoteEngine._coerce_vote_response(
        "Option B",
        fallback,
    )

    assert response.answer == "Option B"
    assert response.predicted_group_answer == "Option B"
    assert response.confidence == pytest.approx(0.5)
    assert provenance == "schema_coercion"


@pytest.mark.asyncio
async def test_sdk_strict_verification_rejects_incomplete_completed_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Completed hosted payloads must include the full result contract in strict mode."""

    arbitrator = AgoraArbitrator()

    async def fake_get(*_args: object, **_kwargs: object) -> _FakeResponse:
        return _FakeResponse(
            {
                "task_id": "task-bad-completed-shape",
                "task_text": "Malformed completion",
                "workspace_id": "ws-test",
                "created_by": "sdk-test",
                "mechanism": "debate",
                "status": "completed",
                "selector_reasoning": "debate",
                "selector_reasoning_hash": "f" * 64,
                "selector_confidence": 0.81,
                "agent_count": 4,
                "reasoning_presets": {
                    "gemini_pro": "high",
                    "gemini_flash": "medium",
                    "kimi": "low",
                    "claude": "medium",
                },
                "result": {
                    "task_id": "task-bad-completed-shape",
                    "mechanism": "debate",
                    "final_answer": "Option A",
                    "confidence": 0.74,
                    "quorum_reached": True,
                    "merkle_root": "root-1",
                    "decision_hash": "decision-1",
                    "agent_count": 4,
                    "agent_models_used": [
                        "gemini-3-flash-preview",
                        "gemini-3.1-flash-lite-preview",
                        "moonshotai/kimi-k2-thinking",
                        "claude-sonnet-4-6",
                    ],
                    "model_token_usage": {"gemini-3-flash-preview": 120},
                    "model_latency_ms": {"gemini-3-flash-preview": 42.0},
                    "total_tokens_used": 120,
                    "latency_ms": 42.0,
                    "round_count": 2,
                    "mechanism_switches": 0,
                    "transcript_hashes": ["h1", "h2", "h3", "h4"],
                    "locked_claims": [],
                    "execution_mode": "live",
                    "selector_source": "llm_reasoning",
                    "fallback_count": 0,
                    "fallback_events": [],
                },
            }
        )

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    try:
        with pytest.raises(HostedTaskProtocolError, match="missing completed result fields"):
            await arbitrator.get_task_result("task-bad-completed-shape")
    finally:
        await arbitrator.aclose()
