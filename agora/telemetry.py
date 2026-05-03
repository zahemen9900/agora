"""Shared observability helpers and Axiom trace bootstrap."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from enum import Enum
from types import SimpleNamespace
from typing import Any, Literal

import structlog
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

from agora.config import _load_dotenv_if_present, _load_secret_manager_value

CaptureContentMode = Literal["metadata_only", "full"]

logger = structlog.get_logger(__name__)

_DEFAULT_SERVICE_NAME = "agora"
_OTEL_SCHEMA_URL = "https://opentelemetry.io/schemas/1.37.0"
_AXIOM_GENAI_SCHEMA_URL = "https://axiom.co/ai/schemas/0.0.2"
_TRACE_ATTRIBUTES: ContextVar[dict[str, Any] | None] = ContextVar(
    "agora_trace_attributes",
    default=None,
)
_TEST_TRACER_PROVIDER: TracerProvider | None = None
_TEST_CAPTURE_CONTENT_MODE: CaptureContentMode | None = None


@dataclass(frozen=True)
class AxiomTelemetryConfig:
    """Resolved Axiom trace-export configuration."""

    enabled: bool
    token: str
    dataset: str
    base_url: str
    sample_ratio: float
    capture_content: CaptureContentMode
    environment: str

    @property
    def otlp_traces_endpoint(self) -> str:
        return f"{self.base_url}/v1/traces"


@dataclass
class _TelemetryRuntimeState:
    initialized: bool = False
    tracer_provider: TracerProvider | None = None
    span_processor: BatchSpanProcessor | None = None
    instrumented_app: Any | None = None
    capture_content: CaptureContentMode = "metadata_only"
    service_name: str = _DEFAULT_SERVICE_NAME
    service_version: str = "0.1.0"


_RUNTIME_STATE = _TelemetryRuntimeState()


def _parse_bool(value: Any) -> bool:
    normalized = str(value or "").strip().lower()
    return normalized in {"1", "true", "yes", "on"}


def _resolve_axiom_token() -> str:
    explicit = os.getenv("AGORA_AXIOM_TOKEN", os.getenv("AXIOM_TOKEN", "")).strip()
    if explicit:
        return explicit

    secret_name = os.getenv("AGORA_AXIOM_SECRET_NAME", "agora-axiom-token").strip()
    if not secret_name:
        return ""

    project_id = (
        os.getenv("AGORA_AXIOM_SECRET_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT") or ""
    ).strip()
    if not project_id:
        return ""

    version = (os.getenv("AGORA_AXIOM_SECRET_VERSION") or "latest").strip() or "latest"
    return _load_secret_manager_value(
        project_id=project_id,
        secret_name=secret_name,
        version=version,
    ) or ""


def _telemetry_settings_from_env() -> SimpleNamespace:
    _load_dotenv_if_present()
    return SimpleNamespace(
        axiom_enabled=_parse_bool(
            os.getenv("AGORA_AXIOM_ENABLED", os.getenv("AXIOM_ENABLED", ""))
        ),
        axiom_token=_resolve_axiom_token(),
        axiom_traces_dataset=os.getenv(
            "AGORA_AXIOM_TRACES_DATASET",
            os.getenv("AXIOM_DATASET", ""),
        ),
        axiom_base_url=os.getenv(
            "AGORA_AXIOM_BASE_URL",
            os.getenv("AXIOM_EDGE_URL", ""),
        ),
        axiom_domain=os.getenv("AXIOM_DOMAIN", ""),
        axiom_sample_ratio=os.getenv(
            "AGORA_AXIOM_SAMPLE_RATIO",
            os.getenv("AXIOM_SAMPLE_RATIO", "1.0"),
        ),
        axiom_capture_content=os.getenv(
            "AGORA_AXIOM_CAPTURE_CONTENT",
            os.getenv("AXIOM_CAPTURE_CONTENT", "metadata_only"),
        ),
        environment=os.getenv("AGORA_ENVIRONMENT", os.getenv("ENVIRONMENT", "development")),
    )


def _normalize_url(value: Any) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    return candidate.rstrip("/")


def _clean_attribute_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, Enum):
        return _clean_attribute_value(value.value)
    if isinstance(value, (str, bool, int, float)):
        return value
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    if isinstance(value, (list, tuple)):
        normalized = [_clean_attribute_value(item) for item in value]
        normalized = [item for item in normalized if item is not None]
        if not normalized:
            return None
        if all(isinstance(item, str) for item in normalized):
            return normalized
        if all(isinstance(item, bool) for item in normalized):
            return normalized
        if all(isinstance(item, int) and not isinstance(item, bool) for item in normalized):
            return normalized
        if all(
            isinstance(item, (int, float)) and not isinstance(item, bool)
            for item in normalized
        ):
            return [float(item) for item in normalized]
        return [str(item) for item in normalized]
    if isinstance(value, dict):
        return None
    return str(value)


def _clean_attributes(attributes: dict[str, Any] | None) -> dict[str, Any]:
    if not attributes:
        return {}
    normalized: dict[str, Any] = {}
    for key, value in attributes.items():
        cleaned = _clean_attribute_value(value)
        if cleaned is not None:
            normalized[key] = cleaned
    return normalized


def cast_capture_mode(value: Any) -> CaptureContentMode:
    normalized = str(value or "metadata_only").strip().lower()
    if normalized == "full":
        return "full"
    return "metadata_only"


def resolve_axiom_telemetry_config(settings_like: Any) -> AxiomTelemetryConfig:
    """Resolve runtime config for Axiom OTLP traces."""

    enabled = bool(getattr(settings_like, "axiom_enabled", False))
    token = str(getattr(settings_like, "axiom_token", "") or "").strip()
    dataset = str(getattr(settings_like, "axiom_traces_dataset", "") or "").strip()
    base_url = _normalize_url(getattr(settings_like, "axiom_base_url", "") or "")
    if not base_url:
        base_url = _normalize_url(getattr(settings_like, "axiom_domain", "") or "")

    sample_ratio = float(getattr(settings_like, "axiom_sample_ratio", 1.0) or 0.0)
    capture_content = cast_capture_mode(
        getattr(settings_like, "axiom_capture_content", "metadata_only")
    )
    environment = str(getattr(settings_like, "environment", "development") or "development")

    if enabled:
        missing: list[str] = []
        if not token:
            missing.append("AGORA_AXIOM_TOKEN")
        if not dataset:
            missing.append("AGORA_AXIOM_TRACES_DATASET")
        if not base_url:
            missing.append("AGORA_AXIOM_BASE_URL or AXIOM_DOMAIN")
        if missing:
            raise RuntimeError(
                "Axiom telemetry is enabled but missing required configuration: "
                + ", ".join(missing)
            )

    return AxiomTelemetryConfig(
        enabled=enabled,
        token=token,
        dataset=dataset,
        base_url=base_url,
        sample_ratio=max(0.0, min(1.0, sample_ratio)),
        capture_content=capture_content,
        environment=environment,
    )


def _trace_context_processor(
    _logger: Any,
    _method_name: str,
    event_dict: dict[str, Any],
) -> dict[str, Any]:
    current = trace.get_current_span()
    if current is None:
        return event_dict
    span_context = current.get_span_context()
    if not span_context.is_valid:
        return event_dict
    event_dict.setdefault("trace_id", format(span_context.trace_id, "032x"))
    event_dict.setdefault("span_id", format(span_context.span_id, "016x"))
    return event_dict


def _configure_structlog_trace_correlation() -> None:
    config = structlog.get_config()
    processors = list(config.get("processors") or [])
    if _trace_context_processor in processors:
        return
    processors.insert(0, _trace_context_processor)
    structlog.configure(
        processors=processors,
        wrapper_class=config.get("wrapper_class"),
        context_class=config.get("context_class"),
        logger_factory=config.get("logger_factory"),
        cache_logger_on_first_use=config.get("cache_logger_on_first_use", False),
    )


def initialize_telemetry(
    *,
    settings_like: Any | None = None,
    app: Any | None = None,
    service_name: str = _DEFAULT_SERVICE_NAME,
    service_version: str = "0.1.0",
) -> None:
    """Configure global OTLP trace exporting when enabled."""

    if _RUNTIME_STATE.initialized:
        return

    resolved_settings = (
        settings_like if settings_like is not None else _telemetry_settings_from_env()
    )
    config = resolve_axiom_telemetry_config(resolved_settings)
    _RUNTIME_STATE.capture_content = config.capture_content
    _RUNTIME_STATE.service_name = service_name
    _RUNTIME_STATE.service_version = service_version
    _configure_structlog_trace_correlation()

    if not config.enabled:
        _RUNTIME_STATE.initialized = True
        return

    resource = Resource.create(
        {
            "service.name": service_name,
            "service.version": service_version,
            "deployment.environment": config.environment,
        }
    )
    tracer_provider = TracerProvider(
        resource=resource,
        sampler=ParentBased(TraceIdRatioBased(config.sample_ratio)),
    )
    exporter = OTLPSpanExporter(
        endpoint=config.otlp_traces_endpoint,
        headers={
            "Authorization": f"Bearer {config.token}",
            "X-Axiom-Dataset": config.dataset,
        },
    )
    span_processor = BatchSpanProcessor(exporter)
    tracer_provider.add_span_processor(span_processor)
    trace.set_tracer_provider(tracer_provider)

    if app is not None:
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "FastAPI telemetry instrumentation requires "
                "opentelemetry-instrumentation-fastapi"
            ) from exc
        FastAPIInstrumentor.instrument_app(app, tracer_provider=tracer_provider)
        _RUNTIME_STATE.instrumented_app = app

    _RUNTIME_STATE.initialized = True
    _RUNTIME_STATE.tracer_provider = tracer_provider
    _RUNTIME_STATE.span_processor = span_processor


def initialize_telemetry_from_env(
    *,
    app: Any | None = None,
    service_name: str = _DEFAULT_SERVICE_NAME,
    service_version: str = "0.1.0",
) -> None:
    """Initialize Axiom OTLP export from environment variables."""

    initialize_telemetry(
        settings_like=None,
        app=app,
        service_name=service_name,
        service_version=service_version,
    )


def shutdown_telemetry() -> None:
    """Flush any configured trace exporter."""

    processor = _RUNTIME_STATE.span_processor
    provider = _RUNTIME_STATE.tracer_provider
    if processor is not None:
        processor.force_flush()
    if provider is not None:
        provider.shutdown()


def get_tracer(name: str):
    """Return the active tracer, honoring any test override."""

    provider = _TEST_TRACER_PROVIDER
    if provider is not None:
        return provider.get_tracer(name)
    active_provider = _RUNTIME_STATE.tracer_provider
    if active_provider is not None:
        return active_provider.get_tracer(name)
    return trace.get_tracer(name)


def current_capture_content_mode() -> CaptureContentMode:
    if _TEST_CAPTURE_CONTENT_MODE is not None:
        return _TEST_CAPTURE_CONTENT_MODE
    return _RUNTIME_STATE.capture_content


def current_observation_attributes() -> dict[str, Any]:
    return dict(_TRACE_ATTRIBUTES.get() or {})


@contextmanager
def observation_context(**attributes: Any) -> Iterator[None]:
    """Temporarily bind shared attributes for nested spans."""

    current = current_observation_attributes()
    current.update(_clean_attributes(attributes))
    token: Token[dict[str, Any] | None] = _TRACE_ATTRIBUTES.set(current)
    try:
        yield
    finally:
        _TRACE_ATTRIBUTES.reset(token)


def set_current_span_attributes(attributes: dict[str, Any], *, bind: bool = False) -> None:
    """Attach attributes to the active span, optionally persisting them in context."""

    cleaned = _clean_attributes(attributes)
    if bind and cleaned:
        current = current_observation_attributes()
        current.update(cleaned)
        _TRACE_ATTRIBUTES.set(current)

    span = trace.get_current_span()
    if span is None or not span.is_recording():
        return
    for key, value in cleaned.items():
        span.set_attribute(key, value)


def add_span_event(name: str, attributes: dict[str, Any] | None = None) -> None:
    span = trace.get_current_span()
    if span is None or not span.is_recording():
        return
    span.add_event(name, attributes=_clean_attributes(attributes))


@contextmanager
def start_observation_span(
    name: str,
    *,
    attributes: dict[str, Any] | None = None,
    kind: SpanKind = SpanKind.INTERNAL,
) -> Iterator[Span]:
    """Start a span seeded with the current observation context."""

    tracer = get_tracer(__name__)
    merged = current_observation_attributes()
    merged.update(_clean_attributes(attributes))
    with tracer.start_as_current_span(name, kind=kind) as span:
        set_current_span_attributes(merged)
        if span.is_recording():
            span.set_attribute("axiom.gen_ai.schema_url", _AXIOM_GENAI_SCHEMA_URL)
            span.set_attribute("otel.schema_url", _OTEL_SCHEMA_URL)
        yield span


def mark_span_error(
    exc: Exception,
    *,
    attributes: dict[str, Any] | None = None,
) -> None:
    span = trace.get_current_span()
    if span is None or not span.is_recording():
        return
    cleaned = _clean_attributes(attributes)
    for key, value in cleaned.items():
        span.set_attribute(key, value)
    span.record_exception(exc)
    span.set_status(Status(StatusCode.ERROR, str(exc)[:200]))


def bind_user_to_current_span(
    user: Any,
    *,
    actor_type: Literal["user", "api_key", "demo", "system"] | None = None,
    actor_id: str | None = None,
) -> None:
    """Attach normalized actor/workspace metadata onto the active span."""

    resolved_actor_type = actor_type
    if resolved_actor_type is None:
        auth_method = str(getattr(user, "auth_method", "") or "").strip().lower()
        resolved_actor_type = "api_key" if auth_method == "api_key" else "user"

    resolved_actor_id = actor_id
    if not resolved_actor_id:
        if resolved_actor_type == "api_key" and getattr(user, "api_key_id", None):
            resolved_actor_id = f"api_key:{user.api_key_id}"
        elif getattr(user, "user_id", None):
            resolved_actor_id = f"user:{user.user_id}"
        elif getattr(user, "workspace_id", None):
            resolved_actor_id = f"workspace:{user.workspace_id}"
        else:
            resolved_actor_id = f"{resolved_actor_type}:unknown"

    attributes = {
        "agora.workspace.id": getattr(user, "workspace_id", None),
        "agora.actor.type": resolved_actor_type,
        "agora.actor.id": resolved_actor_id,
        "agora.user.id": getattr(user, "user_id", None),
        "agora.api_key.id": getattr(user, "api_key_id", None),
        "agora.auth.method": getattr(user, "auth_method", None),
    }
    set_current_span_attributes(attributes, bind=True)


def set_tracer_provider_for_tests(provider: TracerProvider) -> None:
    global _TEST_TRACER_PROVIDER
    _TEST_TRACER_PROVIDER = provider


def set_capture_content_mode_for_tests(mode: CaptureContentMode) -> None:
    global _TEST_CAPTURE_CONTENT_MODE
    _TEST_CAPTURE_CONTENT_MODE = mode


def reset_telemetry_for_tests() -> None:
    global _TEST_TRACER_PROVIDER, _TEST_CAPTURE_CONTENT_MODE
    _TEST_TRACER_PROVIDER = None
    _TEST_CAPTURE_CONTENT_MODE = None
    _TRACE_ATTRIBUTES.set(None)
