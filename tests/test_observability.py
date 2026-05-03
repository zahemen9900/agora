from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from agora import telemetry
from agora.agent import AgentCaller
from agora.runtime.task_execution import execute_task_like_run
from agora.types import (
    CostEstimate,
    DeliberationResult,
    FallbackEvent,
    MechanismTraceSegment,
    MechanismType,
    ModelTelemetry,
)
from api.auth import AuthenticatedUser
from tests.helpers import make_selection


@pytest.fixture(autouse=True)
def _reset_telemetry_state() -> None:
    telemetry.reset_telemetry_for_tests()
    yield
    telemetry.reset_telemetry_for_tests()


def _install_test_exporter() -> InMemorySpanExporter:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    telemetry.set_tracer_provider_for_tests(provider)
    return exporter


def _completed_result() -> DeliberationResult:
    selection = make_selection(mechanism=MechanismType.DELPHI, topic_category="reasoning")
    return DeliberationResult(
        task="Should we ship observability now?",
        mechanism_used=MechanismType.DELPHI,
        mechanism_selection=selection,
        final_answer="Yes, with metadata-only spans.",
        confidence=0.86,
        quorum_reached=True,
        round_count=2,
        agent_count=4,
        mechanism_switches=0,
        merkle_root="root-123",
        transcript_hashes=["hash-1", "hash-2"],
        agent_models_used=["gemini-2.5-flash", "claude-sonnet-4-5"],
        model_token_usage={"gemini-2.5-flash": 120, "claude-sonnet-4-5": 80},
        model_latency_ms={"gemini-2.5-flash": 42.5, "claude-sonnet-4-5": 51.0},
        model_input_token_usage={"gemini-2.5-flash": 60, "claude-sonnet-4-5": 40},
        model_output_token_usage={"gemini-2.5-flash": 40, "claude-sonnet-4-5": 20},
        model_thinking_token_usage={"gemini-2.5-flash": 20, "claude-sonnet-4-5": 20},
        model_telemetry={
            "gemini-2.5-flash": ModelTelemetry(
                total_tokens=120,
                input_tokens=60,
                output_tokens=40,
                thinking_tokens=20,
                latency_ms=42.5,
                estimated_cost_usd=0.0012,
                estimation_mode="exact",
            ),
            "claude-sonnet-4-5": ModelTelemetry(
                total_tokens=80,
                input_tokens=40,
                output_tokens=20,
                thinking_tokens=20,
                latency_ms=51.0,
                estimated_cost_usd=0.0021,
                estimation_mode="exact",
            ),
        },
        mechanism_trace=[
            MechanismTraceSegment(
                mechanism=MechanismType.DELPHI,
                start_round=0,
                end_round=1,
                transcript_hashes=["hash-1", "hash-2"],
            )
        ],
        selector_source="llm_reasoning",
        fallback_count=1,
        fallback_events=[
            FallbackEvent(
                component="selector",
                reason="provider unavailable",
                fallback_type="provider_fallback",
                timestamp=datetime.now(UTC),
            )
        ],
        total_tokens_used=200,
        input_tokens_used=100,
        output_tokens_used=60,
        thinking_tokens_used=40,
        total_latency_ms=93.5,
        cost=CostEstimate(
            estimated_cost_usd=0.0033,
            model_estimated_costs_usd={
                "gemini-2.5-flash": 0.0012,
                "claude-sonnet-4-5": 0.0021,
            },
            pricing_version="test-pricing",
            estimated_at=datetime.now(UTC),
            estimation_mode="exact",
            pricing_sources={
                "gemini-2.5-flash": "catalog",
                "claude-sonnet-4-5": "catalog",
            },
        ),
    )


def test_resolve_axiom_telemetry_config_normalizes_aliases() -> None:
    config = telemetry.resolve_axiom_telemetry_config(
        SimpleNamespace(
            axiom_enabled=True,
            axiom_token="axiom-token",
            axiom_traces_dataset="agora-traces",
            axiom_base_url="",
            axiom_domain="my-org.axiom.co",
            axiom_sample_ratio=0.25,
            axiom_capture_content="metadata_only",
            environment="staging",
        )
    )

    assert config.enabled is True
    assert config.token == "axiom-token"
    assert config.dataset == "agora-traces"
    assert config.base_url == "https://my-org.axiom.co"
    assert config.sample_ratio == pytest.approx(0.25)
    assert config.capture_content == "metadata_only"
    assert config.environment == "staging"
    assert config.otlp_traces_endpoint == "https://my-org.axiom.co/v1/traces"


def test_resolve_axiom_telemetry_config_requires_required_values_when_enabled() -> None:
    with pytest.raises(RuntimeError, match="AGORA_AXIOM_TOKEN"):
        telemetry.resolve_axiom_telemetry_config(
            SimpleNamespace(
                axiom_enabled=True,
                axiom_token="",
                axiom_traces_dataset="agora-traces",
                axiom_base_url="https://api.axiom.co",
                axiom_domain="",
                axiom_sample_ratio=1.0,
                axiom_capture_content="metadata_only",
                environment="development",
            )
        )


def test_initialize_telemetry_from_env_loads_axiom_token_from_secret_manager_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGORA_AXIOM_TOKEN", raising=False)
    monkeypatch.delenv("AXIOM_TOKEN", raising=False)
    monkeypatch.setenv("AGORA_AXIOM_ENABLED", "true")
    monkeypatch.setenv("AGORA_AXIOM_TRACES_DATASET", "agora-traces")
    monkeypatch.setenv("AGORA_AXIOM_BASE_URL", "https://api.axiom.co")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "agora-ai-493714")
    monkeypatch.setenv("AGORA_AXIOM_SECRET_NAME", "agora-axiom-token")
    monkeypatch.setattr(telemetry, "_load_dotenv_if_present", lambda: None)
    monkeypatch.setattr(telemetry, "_load_secret_manager_value", lambda **_kwargs: "secret-token")

    config = telemetry.resolve_axiom_telemetry_config(telemetry._telemetry_settings_from_env())

    assert config.enabled is True
    assert config.token == "secret-token"
    assert config.dataset == "agora-traces"
    assert config.base_url == "https://api.axiom.co"


def test_bind_user_to_current_span_omits_pii_and_sets_actor_attributes() -> None:
    exporter = _install_test_exporter()
    tracer = telemetry.get_tracer("tests.observability")
    user = AuthenticatedUser(
        auth_method="api_key",
        workspace_id="workspace-123",
        user_id=None,
        email="secret@example.com",
        display_name="Sensitive Name",
        scopes=["tasks:read"],
        api_key_id="key-123",
    )

    with tracer.start_as_current_span("request"):
        telemetry.bind_user_to_current_span(user)

    span = exporter.get_finished_spans()[0]
    assert span.attributes["agora.workspace.id"] == "workspace-123"
    assert span.attributes["agora.actor.type"] == "api_key"
    assert span.attributes["agora.actor.id"] == "api_key:key-123"
    assert span.attributes["agora.auth.method"] == "api_key"
    assert span.attributes["agora.api_key.id"] == "key-123"
    assert "agora.user.email" not in span.attributes
    assert "agora.user.display_name" not in span.attributes


class _FakeOrchestrator:
    allow_offline_fallback = True

    async def execute_selection(
        self,
        *,
        task: str,
        selection: Any,
        event_sink: Any = None,
        agents: Any = None,
        allow_switch: bool = True,
    ) -> DeliberationResult:
        del task, selection, agents, allow_switch
        if event_sink is not None:
            await event_sink(
                "mechanism_switch",
                {
                    "from_mechanism": "debate",
                    "to_mechanism": "delphi",
                    "round_number": 2,
                    "reason": "Converged after structured revision.",
                },
            )
        return _completed_result()


@pytest.mark.asyncio
async def test_execute_task_like_run_emits_span_and_curated_events() -> None:
    exporter = _install_test_exporter()
    selection = make_selection(mechanism=MechanismType.DELPHI, topic_category="reasoning")

    with telemetry.observation_context(
        **{
            "agora.execution.kind": "benchmark_case",
            "agora.benchmark.phase": "pre_learning",
            "agora.benchmark.run_kind": "selector_initial",
            "agora.benchmark.task_index": 3,
            "agora.workspace.id": "workspace-bench",
        }
    ):
        outcome = await execute_task_like_run(
            orchestrator=_FakeOrchestrator(),
            task_text="How should we instrument benchmark cases?",
            selection=selection,
            selector_source="llm_reasoning",
            selector_fallback_path=["llm_reasoning"],
            mechanism_override_source=None,
            event_sink=None,
            allow_switch=True,
        )

    assert outcome.status == "completed"
    span = exporter.get_finished_spans()[-1]
    event_names = [event.name for event in span.events]

    assert span.name == "execute_task_like_run"
    assert span.attributes["agora.execution.kind"] == "benchmark_case"
    assert span.attributes["agora.benchmark.phase"] == "pre_learning"
    assert span.attributes["agora.mechanism.selected"] == "delphi"
    assert span.attributes["agora.selector.source"] == "llm_reasoning"
    assert span.attributes["agora.fallback.count"] == 1
    assert span.attributes["agora.cost.estimated_usd"] == pytest.approx(0.0033)
    assert "mechanism_selected" in event_names
    assert "fallback_applied" in event_names
    assert "execution_completed" in event_names


@pytest.mark.asyncio
async def test_agent_caller_call_emits_model_span_without_content_in_metadata_only_mode() -> None:
    exporter = _install_test_exporter()
    telemetry.set_capture_content_mode_for_tests("metadata_only")

    caller = object.__new__(AgentCaller)
    caller.provider = "gemini"
    caller.model = "gemini-2.5-flash"
    caller.model_call_timeout_seconds = 5.0

    async def _fake_call_gemini(
        system_prompt: str,
        user_prompt: str,
        response_format: type[Any] | None,
        temperature: float | None,
        stream: bool,
        stream_callback: Any,
    ) -> tuple[str, dict[str, Any]]:
        del system_prompt, user_prompt, response_format, temperature, stream, stream_callback
        return (
            "visible answer",
            {
                "input_tokens": 11,
                "output_tokens": 7,
                "thinking_tokens": 3,
                "reasoning_tokens": 3,
                "total_tokens": 21,
                "latency_ms": 12.5,
                "response_id": "resp-123",
                "finish_reason": "stop",
                "thinking_trace_present": False,
            },
        )

    caller._call_gemini = _fake_call_gemini  # type: ignore[attr-defined]

    with telemetry.observation_context(
        **{
            "agora.execution.kind": "task",
            "agora.task.id": "task-123",
            "agora.workspace.id": "workspace-123",
        }
    ):
        response, usage = await AgentCaller.call(
            caller,
            system_prompt="very secret system prompt",
            user_prompt="very secret user prompt",
        )

    assert response == "visible answer"
    assert usage["input_tokens"] == 11

    span = exporter.get_finished_spans()[-1]
    assert span.name == "chat gemini-2.5-flash"
    assert span.attributes["gen_ai.operation.name"] == "chat"
    assert span.attributes["gen_ai.system"] == "google"
    assert span.attributes["gen_ai.request.model"] == "gemini-2.5-flash"
    assert span.attributes["agora.model.provider"] == "gemini"
    assert span.attributes["gen_ai.usage.input_tokens"] == 11
    assert span.attributes["gen_ai.usage.output_tokens"] == 7
    assert span.attributes["agora.usage.thinking_tokens"] == 3
    assert span.attributes["agora.response.id"] == "resp-123"
    assert "gen_ai.input.messages" not in span.attributes
    assert "gen_ai.output.messages" not in span.attributes
