from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from agora.sdk import AgoraArbitrator
from agora.telemetry import reset_telemetry_for_tests, set_tracer_provider_for_tests
from agora.types import CostEstimate, DeliberationResult, ModelTelemetry
from tests.helpers import make_selection


@pytest.fixture(autouse=True)
def _reset_telemetry_state() -> None:
    reset_telemetry_for_tests()
    yield
    reset_telemetry_for_tests()


def _install_test_exporter() -> InMemorySpanExporter:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    set_tracer_provider_for_tests(provider)
    return exporter


def _completed_result() -> DeliberationResult:
    selection = make_selection()
    return DeliberationResult(
        task="Should the SDK emit telemetry?",
        mechanism_used=selection.mechanism,
        mechanism_selection=selection,
        final_answer="Yes.",
        confidence=0.91,
        quorum_reached=True,
        round_count=1,
        agent_count=3,
        mechanism_switches=0,
        merkle_root="sdk-root",
        transcript_hashes=["hash-1", "hash-2", "hash-3"],
        agent_models_used=["gemini-2.5-flash"],
        model_token_usage={"gemini-2.5-flash": 42},
        model_latency_ms={"gemini-2.5-flash": 18.0},
        model_input_token_usage={"gemini-2.5-flash": 20},
        model_output_token_usage={"gemini-2.5-flash": 14},
        model_thinking_token_usage={"gemini-2.5-flash": 8},
        model_telemetry={
            "gemini-2.5-flash": ModelTelemetry(
                total_tokens=42,
                input_tokens=20,
                output_tokens=14,
                thinking_tokens=8,
                latency_ms=18.0,
                estimated_cost_usd=0.0008,
                estimation_mode="exact",
            )
        },
        total_tokens_used=42,
        input_tokens_used=20,
        output_tokens_used=14,
        thinking_tokens_used=8,
        total_latency_ms=18.0,
        cost=CostEstimate(
            estimated_cost_usd=0.0008,
            model_estimated_costs_usd={"gemini-2.5-flash": 0.0008},
            pricing_version="test",
            estimated_at=datetime.now(UTC),
            estimation_mode="exact",
            pricing_sources={"gemini-2.5-flash": "catalog"},
        ),
    )


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


@pytest.mark.asyncio
async def test_sdk_create_task_emits_hosted_span(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exporter = _install_test_exporter()
    monkeypatch.setenv("AGORA_SDK_WORKSPACE_ID", "workspace-sdk")
    arbitrator = AgoraArbitrator(
        auth_token="agora_test_public.secret",
        strict_verification=False,
    )

    async def fake_post(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        assert url == "/tasks/"
        return _FakeResponse(
            {
                "task_id": "task-sdk-span",
                "mechanism": "debate",
                "confidence": 0.77,
                "reasoning": "selector output",
                "selector_reasoning_hash": "hash",
                "status": "pending",
            }
        )

    monkeypatch.setattr(arbitrator._client, "post", fake_post)

    created = await arbitrator.create_task("Instrument the hosted SDK path.")
    await arbitrator.aclose()

    assert created.task_id == "task-sdk-span"
    span = exporter.get_finished_spans()[-1]
    assert span.name == "sdk.create_task"
    assert span.attributes["agora.sdk.mode"] == "hosted"
    assert span.attributes["agora.sdk.operation"] == "create_task"
    assert span.attributes["http.request.method"] == "POST"
    assert span.attributes["url.path"] == "/tasks/"
    assert span.attributes["http.response.status_code"] == 200
    assert span.attributes["agora.task.id"] == "task-sdk-span"
    assert span.attributes["agora.actor.type"] == "api_key"
    assert span.attributes["agora.actor.id"] == "api_key:public"
    assert span.attributes["agora.auth.method"] == "api_key"
    assert span.attributes["agora.workspace.id"] == "workspace-sdk"


@pytest.mark.asyncio
async def test_sdk_local_arbitrate_emits_local_span(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exporter = _install_test_exporter()
    monkeypatch.setenv("AGORA_SDK_WORKSPACE_ID", "workspace-local")
    monkeypatch.setenv("AGORA_SDK_ACTOR_ID", "user:local-dev")
    monkeypatch.setenv("AGORA_SDK_ACTOR_TYPE", "user")
    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        strict_verification=False,
    )

    async def fake_run(
        self: Any,
        *,
        task: str,
        stakes: float,
        mechanism_override: Any,
        **_kwargs: Any,
    ):
        del self, task, stakes, mechanism_override
        return _completed_result()

    async def dummy_agent(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {}

    monkeypatch.setattr("agora.sdk.arbitrator.AgoraOrchestrator.run", fake_run)

    result = await arbitrator.arbitrate(
        "Instrument the local SDK path.",
        agents=[dummy_agent, dummy_agent, dummy_agent],
    )
    await arbitrator.aclose()

    assert result.final_answer == "Yes."
    span = next(span for span in exporter.get_finished_spans() if span.name == "sdk.arbitrate")
    assert span.attributes["agora.sdk.mode"] == "local"
    assert span.attributes["agora.sdk.operation"] == "arbitrate"
    assert span.attributes["agora.mechanism.selected"] == "debate"
    assert span.attributes["agora.cost.estimated_usd"] == pytest.approx(0.0008)
    assert span.attributes["agora.workspace.id"] == "workspace-local"
    assert span.attributes["agora.actor.id"] == "user:local-dev"
    assert span.attributes["agora.actor.type"] == "user"
