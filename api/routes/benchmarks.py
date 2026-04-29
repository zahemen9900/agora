"""Benchmark summary and orchestration API endpoints."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections import Counter
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import ValidationError
from sse_starlette.sse import EventSourceResponse

from agora.config import get_config
from agora.runtime.costing import build_model_telemetry, estimate_cost_for_models
from agora.runtime.model_catalog import (
    MODEL_CATALOG_CHECKED_AT,
    MODEL_CATALOG_VERSION,
    built_in_models_for_provider,
    resolve_model_catalog_entry,
)
from agora.runtime.model_policy import (
    BASE_PARTICIPANT_CYCLE,
    normalize_tier_model_overrides,
    resolve_reasoning_presets,
)
from agora.runtime.orchestrator import AgoraOrchestrator
from api.auth import AuthenticatedUser, get_current_user, require_scope
from api.config import settings
from api.coordination import StreamTicketRecord, get_coordination_backend
from api.models import (
    BenchmarkCatalogEntry,
    BenchmarkCatalogResponse,
    BenchmarkCostEstimateResponse,
    BenchmarkDetailResponse,
    BenchmarkDomainName,
    BenchmarkItemEventsResponse,
    BenchmarkItemResponse,
    BenchmarkPromptTemplate,
    BenchmarkPromptTemplatesResponse,
    BenchmarkRunRequest,
    BenchmarkRunResponse,
    BenchmarkRunStatusResponse,
    BenchmarkStoredRequest,
    BenchmarkSummaryResponse,
    DeliberationRuntimeConfigResponse,
    ModelTelemetryResponse,
    RuntimeModelOptionResponse,
    RuntimeTierConfigResponse,
    TaskEvent,
)
from api.live_journal import BufferedEventJournal, BufferedStateWriter
from api.routes.tasks import get_task_store
from api.security import validate_storage_id
from api.streaming import DeliberationStream, get_stream_manager
from benchmarks.runner import BenchmarkRunner

router = APIRouter()
logger = structlog.get_logger(__name__)
_optional_bearer = HTTPBearer(auto_error=False)
OptionalBearerCredentials = Annotated[
    HTTPAuthorizationCredentials | None,
    Depends(_optional_bearer),
]

_RESULTS_DIR = Path(__file__).resolve().parents[2] / "benchmarks" / "results"
_RESULTS_PATH = _RESULTS_DIR / "phase2_validation.json"
_SELECTOR_BANDIT_STATE_KEY = "selector_bandit_state"
_LEGACY_ARTIFACT_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_RUN_STATUS_VALUES = {"queued", "running", "completed", "failed"}
_BENCHMARK_DOMAIN_ORDER: tuple[BenchmarkDomainName, ...] = (
    "math",
    "factual",
    "reasoning",
    "code",
    "creative",
    "demo",
)
_BENCHMARK_MECHANISMS = ("debate", "vote", "delphi", "selector")

_BENCHMARK_PROMPT_TEMPLATES: dict[BenchmarkDomainName, list[dict[str, str]]] = {
    "math": [
        {
            "id": "math-stepwise",
            "title": "Exact Value",
            "question": "What is the exact value of 7/8 + 5/12?",
        },
        {
            "id": "math-proof-check",
            "title": "Verification Check",
            "question": "Which is larger, 3/5 or 5/8, and by how much?",
        },
        {
            "id": "math-fast",
            "title": "Sequence Term",
            "question": "What is the 20th term of the sequence 2, 5, 8, 11, ...?",
        },
        {
            "id": "math-robust",
            "title": "Rate Problem",
            "question": "If a machine completes 9 tasks in 12 minutes, how long does it take to complete 27 tasks at the same rate?",
        },
    ],
    "factual": [
        {
            "id": "factual-cited",
            "title": "Capital Fact",
            "question": "What is the capital of France?",
        },
        {
            "id": "factual-multihop",
            "title": "Historical Year",
            "question": "In what year did Apollo 11 land on the Moon?",
        },
        {
            "id": "factual-precision",
            "title": "Author Check",
            "question": "Who wrote Pride and Prejudice?",
        },
        {
            "id": "factual-contrast",
            "title": "Planet Fact",
            "question": "Which planet is the largest in the Solar System?",
        },
    ],
    "reasoning": [
        {
            "id": "reasoning-tradeoff",
            "title": "Tradeoff Call",
            "question": "Should a system optimize for speed or robustness when the cost of error is high?",
        },
        {
            "id": "reasoning-structured",
            "title": "Evidence Balance",
            "question": "When evidence is incomplete, should a model hedge or choose the most likely answer?",
        },
        {
            "id": "reasoning-risk",
            "title": "Risk Preference",
            "question": "Is it better to minimize false positives or false negatives in a high-stakes decision?",
        },
        {
            "id": "reasoning-ethical",
            "title": "Decision Lens",
            "question": "Is a simpler model preferable if it is marginally less accurate but easier to audit?",
        },
    ],
    "code": [
        {
            "id": "code-bugfix",
            "title": "Root Cause",
            "question": "What is the most likely root cause of this bug?",
        },
        {
            "id": "code-design",
            "title": "Design Choice",
            "question": "Which approach is more maintainable for this feature, a refactor or a targeted patch?",
        },
        {
            "id": "code-performance",
            "title": "Latency Tradeoff",
            "question": "How can we reduce latency without changing the public API?",
        },
        {
            "id": "code-tests",
            "title": "Regression Test",
            "question": "Which test would best catch this regression?",
        },
    ],
    "creative": [
        {
            "id": "creative-divergent",
            "title": "Concept Direction",
            "question": "What concept best fits a premium, industrial benchmark dashboard?",
        },
        {
            "id": "creative-story",
            "title": "Narrative Angle",
            "question": "Which narrative angle makes a product feel most trustworthy?",
        },
        {
            "id": "creative-product",
            "title": "Product Angle",
            "question": "What product idea best serves a technical operator who needs fast decisions?",
        },
        {
            "id": "creative-brand",
            "title": "Brand Voice",
            "question": "Which brand voice fits a multi-agent AI operator console best?",
        },
    ],
    "demo": [
        {
            "id": "demo-balanced",
            "title": "Stakeholder Summary",
            "question": "What is the clearest way to explain this benchmark result to a stakeholder?",
        },
        {
            "id": "demo-chain-ready",
            "title": "Replayable Receipt",
            "question": "What should a replayable deliberation receipt emphasize first?",
        },
        {
            "id": "demo-latency",
            "title": "Concise Summary",
            "question": "How can we present cost and latency without overwhelming the audience?",
        },
        {
            "id": "demo-confidence",
            "title": "Confidence Framing",
            "question": "Which summary framing makes the result easiest to trust at a glance?",
        },
    ],
}

_background_benchmark_runs: dict[str, asyncio.Task[None]] = {}
_legacy_backfill_complete = False
_legacy_backfill_lock: asyncio.Lock | None = None
_STREAM_POLL_INTERVAL_SECONDS = 0.15
_STREAM_BUFFER_FLUSH_INTERVAL_SECONDS = 0.1
_STREAM_BUFFER_MAX_EVENTS = 8
_BUFFERED_BENCHMARK_EVENT_TYPES = {
    "domain_progress",
    "agent_output_delta",
    "thinking_delta",
    "usage_delta",
    "cross_examination_delta",
}
_TERMINAL_BENCHMARK_EVENT_TYPES = {"complete", "failed", "error"}
_AGGREGATE_BENCHMARK_FULL_CATALOG_LIMIT = 500
_AGGREGATE_BENCHMARK_DEFAULT_LIMIT = 20


def _get_legacy_backfill_lock() -> asyncio.Lock:
    global _legacy_backfill_lock
    if _legacy_backfill_lock is None:
        _legacy_backfill_lock = asyncio.Lock()
    return _legacy_backfill_lock


def _benchmark_stream_key(workspace_id: str, run_id: str) -> str:
    return f"benchmark:{workspace_id}:{run_id}"


def _benchmark_run_key(workspace_id: str, run_id: str) -> str:
    return f"benchmark-run:{workspace_id}:{run_id}"


def _track_background_benchmark_run(run_id: str, task: asyncio.Task[None]) -> None:
    _background_benchmark_runs[run_id] = task

    def _cleanup(finished: asyncio.Task[None]) -> None:
        current = _background_benchmark_runs.get(run_id)
        if current is finished:
            _background_benchmark_runs.pop(run_id, None)

    task.add_done_callback(_cleanup)


def _launch_background_benchmark_run(
    *,
    workspace_id: str,
    run_id: str,
    request: BenchmarkRunRequest,
) -> None:
    existing = _background_benchmark_runs.get(run_id)
    if existing is not None and not existing.done():
        return

    async def _runner() -> None:
        try:
            await _execute_benchmark_run(
                workspace_id=workspace_id,
                run_id=run_id,
                request=request,
            )
        except Exception:
            logger.exception(
                "background_benchmark_run_failed",
                workspace_id=workspace_id,
                run_id=run_id,
            )

    _track_background_benchmark_run(run_id, asyncio.create_task(_runner()))


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    try:
        parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


async def resume_stale_background_benchmark_runs(
    *,
    stale_after_seconds: int,
    limit: int,
) -> int:
    """Relaunch queued or stale running benchmark jobs from persisted state."""

    store = get_task_store()
    if not hasattr(store, "list_all_user_test_results"):
        return 0

    records = await store.list_all_user_test_results(limit=limit)
    stale_before = datetime.now(UTC) - timedelta(seconds=max(1, stale_after_seconds))
    relaunched = 0
    for record in records:
        if not isinstance(record, dict):
            continue
        if str(record.get("kind") or "").strip().lower() != "benchmark":
            continue
        workspace_id = str(record.get("workspace_id") or "").strip()
        run_id = str(record.get("run_id") or "").strip()
        status = str(record.get("status") or "").strip().lower()
        if not workspace_id or not run_id or status not in {"queued", "running"}:
            continue
        updated_at = _parse_timestamp(record.get("updated_at"))
        should_resume = status == "queued" or updated_at is None or updated_at <= stale_before
        if not should_resume:
            continue
        request_payload = record.get("request")
        if not isinstance(request_payload, dict):
            logger.warning(
                "resume_stale_background_benchmark_missing_request",
                workspace_id=workspace_id,
                run_id=run_id,
            )
            continue
        try:
            request = BenchmarkRunRequest.model_validate(request_payload)
        except ValidationError:
            logger.exception(
                "resume_stale_background_benchmark_invalid_request",
                workspace_id=workspace_id,
                run_id=run_id,
            )
            continue
        logger.info(
            "resume_stale_background_benchmark_run",
            workspace_id=workspace_id,
            run_id=run_id,
            status=status,
            updated_at=record.get("updated_at"),
        )
        _launch_background_benchmark_run(
            workspace_id=workspace_id,
            run_id=run_id,
            request=request,
        )
        relaunched += 1

    return relaunched


async def _issue_benchmark_stream_ticket(workspace_id: str, run_id: str) -> dict[str, str]:
    ticket, expires_at = await get_coordination_backend().issue_stream_ticket(
        workspace_id,
        run_id,
        settings.stream_ticket_ttl_seconds,
    )
    return {"ticket": ticket, "expires_at": expires_at.isoformat()}


async def _consume_benchmark_stream_ticket(ticket: str, *, run_id: str) -> StreamTicketRecord:
    entry = await get_coordination_backend().consume_stream_ticket(ticket, task_id=run_id)
    if entry is None:
        raise HTTPException(status_code=401, detail="Invalid stream ticket")
    return entry


def _benchmark_event_payload(event_type: str, event_data: dict[str, Any]) -> dict[str, Any]:
    payload_data = dict(event_data)
    latest_run = _as_dict(payload_data.get("latest_run"))
    if event_type == "domain_progress" and latest_run:
        for source_key, target_key in (
            ("phase", "phase"),
            ("run_kind", "run_kind"),
            ("task_index", "task_index"),
            ("item_index", "item_index"),
            ("category", "category"),
            ("question", "question"),
            ("source_task", "source_task"),
            ("item_status", "item_status"),
        ):
            if target_key not in payload_data and latest_run.get(source_key) is not None:
                payload_data[target_key] = latest_run.get(source_key)
    benchmark_context = _as_dict(payload_data.get("benchmark_context"))
    phase = str(
        payload_data.get("phase")
        or benchmark_context.get("phase")
        or ""
    ).strip()
    run_kind = str(
        payload_data.get("run_kind")
        or benchmark_context.get("run_kind")
        or ""
    ).strip()
    task_index = _safe_int(
        payload_data.get("task_index", benchmark_context.get("task_index")),
        default=-1,
    )
    if "item_id" not in payload_data:
        item_id = (
            str(payload_data.get("item_id") or benchmark_context.get("item_id") or "").strip()
            or _compose_benchmark_item_id(
                phase=phase or None,
                run_kind=run_kind or None,
                task_index=task_index if task_index >= 0 else None,
            )
        )
        if item_id:
            payload_data["item_id"] = item_id
    if "item_index" not in payload_data and benchmark_context.get("item_index") is not None:
        payload_data["item_index"] = _safe_int(benchmark_context.get("item_index"))
    if phase and "phase" not in payload_data:
        payload_data["phase"] = phase
    if run_kind and "run_kind" not in payload_data:
        payload_data["run_kind"] = run_kind
    if task_index >= 0 and "task_index" not in payload_data:
        payload_data["task_index"] = task_index
    for source_key, target_key in (
        ("category", "category"),
        ("question", "question"),
        ("source_task", "source_task"),
    ):
        if target_key not in payload_data and benchmark_context.get(source_key) is not None:
            payload_data[target_key] = benchmark_context.get(source_key)
    if "item_status" not in payload_data:
        inferred_status = _infer_benchmark_item_status_from_event(event_type, payload_data)
        if inferred_status is not None:
            payload_data["item_status"] = inferred_status
    return TaskEvent(
        event=event_type,
        data=payload_data,
        timestamp=datetime.now(UTC),
    ).model_dump(mode="json")


def _benchmark_sse_message(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "event": str(event.get("event", "update")),
        "data": json.dumps({
            "payload": event.get("data", {}),
            "timestamp": event.get("timestamp"),
        }),
    }


def _load_json_payload(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return payload
    return None


def _latest_demo_results_path() -> Path | None:
    candidates = sorted(
        _RESULTS_DIR.glob("phase2_demo*.json"),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        return None

    local_candidates = [candidate for candidate in candidates if "_local_" in candidate.name]
    return local_candidates[0] if local_candidates else candidates[0]


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _is_summary_block(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return any(
        isinstance(value.get(section), dict)
        for section in ("per_mode", "per_mechanism", "per_category")
    )


def _merge_metric_sections(
    raw_section: Any,
    derived_section: Any,
    *,
    metric_keys: tuple[str, ...],
    fallback_keys: tuple[str, ...] = (),
) -> dict[str, dict[str, float]]:
    raw_map = _as_dict(raw_section)
    derived_map = _as_dict(derived_section)
    ordered_keys: list[str] = []

    for key in fallback_keys:
        normalized = str(key).strip().lower()
        if normalized and normalized not in ordered_keys:
            ordered_keys.append(normalized)

    for source in (raw_map, derived_map):
        for key in source.keys():
            if not isinstance(key, str):
                continue
            normalized = key.strip().lower()
            if normalized and normalized not in ordered_keys:
                ordered_keys.append(normalized)

    merged: dict[str, dict[str, float]] = {}
    for key in ordered_keys:
        raw_metrics = _as_dict(raw_map.get(key))
        derived_metrics = _as_dict(derived_map.get(key))
        merged[key] = {
            metric_key: _safe_float(
                raw_metrics.get(metric_key)
                if raw_metrics.get(metric_key) is not None
                else derived_metrics.get(metric_key)
            )
            for metric_key in metric_keys
        }
    return merged


def _merge_category_sections(
    raw_section: Any,
    derived_section: Any,
) -> dict[str, dict[str, dict[str, float]]]:
    raw_map = _as_dict(raw_section)
    derived_map = _as_dict(derived_section)
    ordered_categories: list[str] = []

    for category in _BENCHMARK_DOMAIN_ORDER:
        normalized = str(category).strip().lower()
        if normalized and normalized not in ordered_categories:
            ordered_categories.append(normalized)

    for source in (raw_map, derived_map):
        for key in source.keys():
            if not isinstance(key, str):
                continue
            normalized = key.strip().lower()
            if normalized and normalized not in ordered_categories:
                ordered_categories.append(normalized)

    category_metrics: dict[str, dict[str, dict[str, float]]] = {}
    for category in ordered_categories:
        raw_mechanisms = _as_dict(raw_map.get(category))
        derived_mechanisms = _as_dict(derived_map.get(category))
        category_metrics[category] = _merge_metric_sections(
            raw_mechanisms,
            derived_mechanisms,
            metric_keys=(
                "accuracy",
                "run_count",
                "scored_run_count",
                "proxy_run_count",
                "avg_tokens",
                "avg_latency_ms",
                "avg_thinking_tokens",
                "avg_estimated_cost_usd",
            ),
            fallback_keys=_BENCHMARK_MECHANISMS,
        )

    return category_metrics


def _resolve_summary_block(payload: dict[str, Any]) -> dict[str, Any]:
    direct_summary = _as_dict(payload.get("summary"))
    if _is_summary_block(direct_summary):
        return direct_summary

    if _payload_has_any_runs(payload):
        return direct_summary

    for stage_key in ("post_learning", "pre_learning", "learning_updates"):
        stage_payload = _as_dict(payload.get(stage_key))
        stage_summary = _as_dict(stage_payload.get("summary"))
        if _is_summary_block(stage_summary):
            return stage_summary

    return direct_summary


def _has_non_empty_runs(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def _payload_has_any_runs(payload: dict[str, Any]) -> bool:
    if _has_non_empty_runs(payload.get("runs")):
        return True

    for stage_key in ("post_learning", "pre_learning", "learning_updates"):
        stage_payload = _as_dict(payload.get(stage_key))
        if _has_non_empty_runs(stage_payload.get("runs")):
            return True

    return False


def _build_demo_report(demo_payload: dict[str, Any], artifact_name: str) -> dict[str, Any]:
    sdk_flow = _as_dict(demo_payload.get("sdk_flow"))
    status_after_run = _as_dict(sdk_flow.get("status_after_run"))
    status_after_pay = _as_dict(sdk_flow.get("status_after_pay"))
    run_result = _as_dict(sdk_flow.get("run_result")) or _as_dict(status_after_run.get("result"))

    return {
        "artifact": artifact_name,
        "status": demo_payload.get("status"),
        "final_status": demo_payload.get("final_status"),
        "target": demo_payload.get("target"),
        "query": demo_payload.get("query"),
        "mechanism": demo_payload.get("mechanism"),
        "agent_count": demo_payload.get("agent_count"),
        "stakes": demo_payload.get("stakes"),
        "started_at": demo_payload.get("started_at"),
        "completed_at": demo_payload.get("completed_at"),
        "run_summary": _as_dict(demo_payload.get("run_summary")),
        "tx_summary": _as_dict(demo_payload.get("tx_summary")),
        "acceptance_checks": _as_dict(demo_payload.get("acceptance_checks")),
        "run_result": run_result,
        "status_after_run": status_after_run,
        "status_after_pay": status_after_pay,
    }


def _safe_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)
    return default


def _safe_positive_int(value: Any) -> int | None:
    candidate = _safe_int(value, default=0)
    return candidate if candidate > 0 else None


def _first_positive_int(*values: Any) -> int | None:
    for value in values:
        candidate = _safe_positive_int(value)
        if candidate is not None:
            return candidate
    return None


def _cost_from_object(value: Any) -> BenchmarkCostEstimateResponse | None:
    if not isinstance(value, dict):
        return None

    estimated_cost = value.get("estimated_cost_usd")
    if estimated_cost is None:
        estimated_cost = value.get("total_estimated_cost_usd")

    model_costs_raw: dict[Any, Any] = {}
    candidate_model_costs = value.get("model_estimated_costs_usd")
    if isinstance(candidate_model_costs, dict):
        model_costs_raw = candidate_model_costs
    else:
        legacy_model_costs = value.get("model_costs_usd")
        if isinstance(legacy_model_costs, dict):
            model_costs_raw = legacy_model_costs

    model_costs = {
        str(model): round(_safe_float(cost), 8)
        for model, cost in model_costs_raw.items()
        if str(model).strip() and _safe_float(cost) > 0
    }

    parsed_estimated = (
        _safe_float(estimated_cost, default=0.0) if estimated_cost is not None else None
    )
    if parsed_estimated is not None and parsed_estimated <= 0 and model_costs:
        parsed_estimated = round(sum(model_costs.values()), 8)

    if parsed_estimated is not None and parsed_estimated <= 0:
        parsed_estimated = None

    estimated_at_raw = value.get("estimated_at") or value.get("cost_estimated_at")

    return BenchmarkCostEstimateResponse(
        estimated_cost_usd=parsed_estimated,
        model_estimated_costs_usd=model_costs,
        pricing_version=(
            str(value.get("pricing_version")).strip() if value.get("pricing_version") else None
        ),
        estimated_at=_parse_timestamp(estimated_at_raw) if estimated_at_raw else None,
        estimation_mode=(
            str(value.get("estimation_mode")).strip() if value.get("estimation_mode") else None
        ),
        pricing_sources=(
            {
                str(model): str(source)
                for model, source in value.get("pricing_sources", {}).items()
                if str(model).strip() and str(source).strip()
            }
            if isinstance(value.get("pricing_sources"), dict)
            else {}
        ),
    )


def _stored_benchmark_request(value: Any) -> BenchmarkStoredRequest | None:
    if not isinstance(value, dict):
        return None
    try:
        return BenchmarkStoredRequest.model_validate(value)
    except ValidationError:
        return None


def _benchmark_summary_response(value: Any) -> BenchmarkSummaryResponse:
    if not isinstance(value, dict):
        return BenchmarkSummaryResponse()
    try:
        return BenchmarkSummaryResponse.model_validate(value)
    except ValidationError:
        return BenchmarkSummaryResponse()


def _model_telemetry_from_record(value: Any) -> dict[str, ModelTelemetryResponse]:
    if not isinstance(value, dict):
        return {}

    direct = value.get("model_telemetry")
    if isinstance(direct, dict):
        return {
            str(model): ModelTelemetryResponse.model_validate(payload)
            for model, payload in direct.items()
            if str(model).strip() and isinstance(payload, dict)
        }

    models = _extract_model_names(value)
    model_token_usage = value.get("model_token_usage") if isinstance(value.get("model_token_usage"), dict) else {}
    model_latency_ms = value.get("model_latency_ms") if isinstance(value.get("model_latency_ms"), dict) else {}
    model_input_tokens = (
        value.get("model_input_token_usage")
        if isinstance(value.get("model_input_token_usage"), dict)
        else {}
    )
    model_output_tokens = (
        value.get("model_output_token_usage")
        if isinstance(value.get("model_output_token_usage"), dict)
        else {}
    )
    model_thinking_tokens = (
        value.get("model_thinking_token_usage")
        if isinstance(value.get("model_thinking_token_usage"), dict)
        else {}
    )
    raw = build_model_telemetry(
        models=models,
        model_token_usage=model_token_usage,
        model_latency_ms=model_latency_ms,
        model_input_tokens=model_input_tokens,
        model_output_tokens=model_output_tokens,
        model_thinking_tokens=model_thinking_tokens,
        fallback_total_tokens=_safe_int(value.get("tokens_used") or value.get("total_tokens_used")),
    )
    return {
        model: ModelTelemetryResponse.model_validate(payload.model_dump(mode="json"))
        for model, payload in raw.items()
    }


def _domain_prompt_templates_response() -> BenchmarkPromptTemplatesResponse:
    return BenchmarkPromptTemplatesResponse(
        domains={
            domain: [
                BenchmarkPromptTemplate(id=item["id"], title=item["title"], question=item["question"])
                for item in templates
            ]
            for domain, templates in _BENCHMARK_PROMPT_TEMPLATES.items()
        }
    )


def _deliberation_runtime_config_response() -> DeliberationRuntimeConfigResponse:
    config = get_config()
    defaults = resolve_reasoning_presets(config=config)

    tier_configs: dict[str, dict[str, str]] = {
        "pro": {
            "provider_family": "gemini",
            "model_id": config.pro_model,
            "vote_role": "Strategic voter",
            "debate_role": "Debater",
        },
        "flash": {
            "provider_family": "gemini",
            "model_id": config.flash_model,
            "vote_role": "Fast voter",
            "debate_role": "Debater",
        },
        "openrouter": {
            "provider_family": "openrouter",
            "model_id": config.openrouter_model,
            "vote_role": "Diversity voter",
            "debate_role": "Debater",
        },
        "claude": {
            "provider_family": "anthropic",
            "model_id": config.claude_model,
            "vote_role": "Challenge voter",
            "debate_role": "Debater",
        },
    }

    def _runtime_tier_response(tier: str, payload: dict[str, str]) -> RuntimeTierConfigResponse:
        entry = resolve_model_catalog_entry(payload["model_id"])
        return RuntimeTierConfigResponse(
            tier=tier,  # type: ignore[arg-type]
            provider_family=payload["provider_family"],  # type: ignore[arg-type]
            model_id=payload["model_id"],
            display_name=entry.display_name if entry is not None else payload["model_id"],
            vote_role=payload["vote_role"],
            debate_role=payload["debate_role"],
        )

    tiers = {
        tier: _runtime_tier_response(tier, payload)
        for tier, payload in tier_configs.items()
    }

    catalog = {
        provider: [
            RuntimeModelOptionResponse(
                provider_family=entry.provider_family,
                model_id=entry.model_id,
                display_name=entry.display_name,
                source_url=entry.source_url,
                stability_tier=entry.stability_tier,
                supports_streaming=entry.supports_streaming,
                supports_json_schema=entry.supports_json_schema,
                supports_reasoning=entry.supports_reasoning,
                supports_reasoning_continuation=entry.supports_reasoning_continuation,
                input_usd_per_million=entry.input_usd_per_million,
                output_usd_per_million=entry.output_usd_per_million,
                usage_telemetry_mode=entry.usage_telemetry_mode,
                allowed_tiers=list(entry.allowed_tiers),
            )
            for entry in built_in_models_for_provider(provider)  # type: ignore[arg-type]
        ]
        for provider in ("gemini", "anthropic", "openrouter")
    }

    return DeliberationRuntimeConfigResponse(
        model_catalog_version=MODEL_CATALOG_VERSION,
        model_catalog_checked_at=MODEL_CATALOG_CHECKED_AT,
        participant_cycle=list(BASE_PARTICIPANT_CYCLE),
        default_reasoning_presets=defaults,
        tiers=tiers,
        catalog=catalog,  # type: ignore[arg-type]
    )


def _resolve_domain_prompt(
    domain: BenchmarkDomainName,
    template_id: str | None,
    question: str | None,
) -> str | None:
    if question is not None and question.strip():
        return question.strip()

    if not template_id:
        return None

    templates = _BENCHMARK_PROMPT_TEMPLATES.get(domain, [])
    for template in templates:
        if template["id"] == template_id:
            return template["question"]
    return None


def _resolved_domain_prompts(request: BenchmarkRunRequest) -> dict[str, dict[str, str]]:
    resolved: dict[str, dict[str, str]] = {}
    for domain in _BENCHMARK_DOMAIN_ORDER:
        config = request.domain_prompts.get(domain)
        if config is None:
            continue
        question = _resolve_domain_prompt(domain, config.template_id, config.question)
        if not question:
            continue
        template_title = None
        if config.template_id:
            for template in _BENCHMARK_PROMPT_TEMPLATES.get(domain, []):
                if template["id"] == config.template_id:
                    template_title = template["title"]
                    break
        source = config.source
        if source not in {"template", "custom"}:
            source = "custom" if config.template_id == "custom" else "template"
        resolved[domain] = {
            "template_id": config.template_id or "custom",
            "template_title": template_title or "Custom Question",
            "source": source,
            "question": question,
        }
    return resolved


def _apply_domain_prompts(
    tasks: list[dict[str, Any]],
    resolved_prompts: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    if not resolved_prompts:
        return tasks

    transformed: list[dict[str, Any]] = []
    for task in tasks:
        category = str(task.get("category") or "").strip().lower()
        prompt_config = resolved_prompts.get(category)
        if not prompt_config:
            transformed.append(task)
            continue

        selected_question = str(prompt_config.get("question") or "").strip()
        enriched = dict(task)
        if selected_question:
            enriched["question"] = selected_question
        enriched["question_template_id"] = prompt_config.get("template_id")
        enriched["question_template_title"] = prompt_config.get("template_title")
        enriched["question_source"] = prompt_config.get("source")
        transformed.append(enriched)
    return transformed


def _extract_model_usage_from_runs(runs: list[dict[str, Any]]) -> dict[str, int]:
    aggregated: Counter[str] = Counter()
    for run in runs:
        model_token_usage = run.get("model_token_usage")
        if isinstance(model_token_usage, dict):
            for model, tokens in model_token_usage.items():
                token_count = _safe_int(tokens)
                if token_count > 0:
                    aggregated[str(model)] += token_count
            continue

        models = _extract_model_names(run)
        total_tokens = _safe_int(run.get("tokens_used") or run.get("total_tokens_used"))
        if models and total_tokens > 0:
            base = total_tokens // len(models)
            remainder = total_tokens % len(models)
            for index, model in enumerate(models):
                aggregated[model] += base + (1 if index < remainder else 0)
    return dict(aggregated)


def _artifact_telemetry(payload: dict[str, Any]) -> dict[str, Any]:
    runs = _extract_runs(payload)
    summary = _resolve_summary_block(payload)
    mechanism_counts, model_counts, frequency_score = _frequency_from_runs(runs)
    total_tokens = sum(
        _safe_int(run.get("tokens_used") or run.get("total_tokens_used")) for run in runs
    )
    thinking_tokens = sum(_safe_int(run.get("thinking_tokens_used")) for run in runs)
    total_latency_ms = sum(_safe_float(run.get("latency_ms")) for run in runs)

    latest_mechanism = None
    if runs:
        latest = runs[-1]
        latest_mechanism = (
            str(latest.get("mechanism_used") or latest.get("mechanism") or latest.get("mode") or "")
            .strip()
            .lower()
            or None
        )

    model_usage = _extract_model_usage_from_runs(runs)
    aggregate_model_telemetry: dict[str, dict[str, Any]] = {}
    stored_model_costs: dict[str, float] = {}
    stored_total_cost = 0.0
    stored_pricing_version = None
    stored_estimated_at = None
    stored_estimation_mode = None
    stored_pricing_sources: dict[str, str] = {}
    for run in runs:
        for model, telemetry in _model_telemetry_from_record(run).items():
            bucket = aggregate_model_telemetry.setdefault(
                model,
                {
                    "total_tokens": 0,
                    "input_tokens": None,
                    "output_tokens": None,
                    "thinking_tokens": None,
                    "latency_ms": 0.0,
                    "_missing_input_split": False,
                    "_missing_output_split": False,
                    "_missing_thinking_split": False,
                },
            )
            bucket["total_tokens"] += telemetry.total_tokens or 0
            if telemetry.input_tokens is None:
                bucket["_missing_input_split"] = True
                bucket["input_tokens"] = None
            elif not bucket["_missing_input_split"]:
                bucket["input_tokens"] = int(bucket["input_tokens"] or 0) + telemetry.input_tokens
            if telemetry.output_tokens is None:
                bucket["_missing_output_split"] = True
                bucket["output_tokens"] = None
            elif not bucket["_missing_output_split"]:
                bucket["output_tokens"] = int(bucket["output_tokens"] or 0) + telemetry.output_tokens
            if telemetry.thinking_tokens is None:
                bucket["_missing_thinking_split"] = True
                bucket["thinking_tokens"] = None
            elif not bucket["_missing_thinking_split"]:
                bucket["thinking_tokens"] = int(bucket["thinking_tokens"] or 0) + telemetry.thinking_tokens
            bucket["latency_ms"] += telemetry.latency_ms or 0.0
        cost_block = _cost_from_object(run)
        if cost_block is None:
            continue
        if cost_block.estimated_cost_usd is not None:
            stored_total_cost += cost_block.estimated_cost_usd
        for model, value in cost_block.model_estimated_costs_usd.items():
            stored_model_costs[model] = stored_model_costs.get(model, 0.0) + value
        stored_pricing_version = stored_pricing_version or cost_block.pricing_version
        stored_estimated_at = stored_estimated_at or cost_block.estimated_at
        stored_estimation_mode = stored_estimation_mode or cost_block.estimation_mode
        stored_pricing_sources.update(cost_block.pricing_sources)

    cost_payload = estimate_cost_for_models(aggregate_model_telemetry)
    cost = BenchmarkCostEstimateResponse(
        estimated_cost_usd=(
            round(stored_total_cost, 8)
            if stored_total_cost > 0
            else cost_payload.estimated_cost_usd
        ),
        model_estimated_costs_usd=(
            {model: round(value, 8) for model, value in stored_model_costs.items() if value > 0}
            if stored_model_costs
            else cost_payload.model_estimated_costs_usd
        ),
        pricing_version=stored_pricing_version or cost_payload.pricing_version,
        estimated_at=stored_estimated_at or cost_payload.estimated_at,
        estimation_mode=stored_estimation_mode or cost_payload.estimation_mode,
        pricing_sources=stored_pricing_sources or cost_payload.pricing_sources,
    )

    benchmark_config = _as_dict(payload.get("benchmark_config"))
    agent_count = _first_positive_int(
        benchmark_config.get("agent_count"),
        *(
            run.get("agent_count")
            for run in runs
            if isinstance(run, dict)
        ),
    )
    completed_item_count = _safe_int(
        summary.get("completed_run_count"),
        default=sum(
            1
            for run in runs
            if str(run.get("item_status") or "completed").strip().lower() != "failed"
        ),
    )
    failed_item_count = _safe_int(
        summary.get("failed_run_count"),
        default=sum(
            1
            for run in runs
            if str(run.get("item_status") or "").strip().lower() == "failed"
        ),
    )
    failure_counts_by_category = (
        {
            str(category): _safe_int(count)
            for category, count in summary.get("failure_counts_by_category", {}).items()
            if str(category).strip() and _safe_int(count) > 0
        }
        if isinstance(summary.get("failure_counts_by_category"), dict)
        else {}
    )
    failure_counts_by_reason = (
        {
            str(reason): _safe_int(count)
            for reason, count in summary.get("failure_counts_by_reason", {}).items()
            if str(reason).strip() and _safe_int(count) > 0
        }
        if isinstance(summary.get("failure_counts_by_reason"), dict)
        else {}
    )
    degraded_item_count = _safe_int(
        summary.get("degraded_run_count"),
        default=sum(
            1
            for run in runs
            if _infer_benchmark_item_status_from_run(run) == "degraded"
        ),
    )
    failure_counts_by_stage = (
        {
            str(stage): _safe_int(count)
            for stage, count in summary.get("failure_counts_by_stage", {}).items()
            if str(stage).strip() and _safe_int(count) > 0
        }
        if isinstance(summary.get("failure_counts_by_stage"), dict)
        else {}
    )
    if not failure_counts_by_stage:
        derived_failure_counts_by_stage: dict[str, int] = {}
        for run in runs:
            if _infer_benchmark_item_status_from_run(run) != "failed":
                continue
            stage = str(run.get("run_kind") or run.get("phase") or "unknown").strip() or "unknown"
            derived_failure_counts_by_stage[stage] = (
                derived_failure_counts_by_stage.get(stage, 0) + 1
            )
        failure_counts_by_stage = derived_failure_counts_by_stage

    return {
        "runs": runs,
        "run_count": len(runs),
        "completed_item_count": completed_item_count,
        "failed_item_count": failed_item_count,
        "degraded_item_count": degraded_item_count,
        "failure_counts_by_category": failure_counts_by_category,
        "failure_counts_by_reason": failure_counts_by_reason,
        "failure_counts_by_stage": failure_counts_by_stage,
        "mechanism_counts": mechanism_counts,
        "model_counts": model_counts,
        "frequency_score": frequency_score,
        "total_tokens": max(total_tokens, 0),
        "thinking_tokens": max(thinking_tokens, 0),
        "total_latency_ms": max(total_latency_ms, 0.0),
        "latest_mechanism": latest_mechanism,
        "models": sorted(model_counts.keys()),
        "agent_count": agent_count,
        "model_token_usage": model_usage,
        "model_telemetry": {
            model: ModelTelemetryResponse.model_validate(telemetry)
            for model, telemetry in aggregate_model_telemetry.items()
        },
        "cost": cost,
    }


def _with_complete_summary(payload: dict[str, Any]) -> dict[str, Any]:
    cloned = dict(payload)
    summary = _resolve_summary_block(cloned)
    derived_summary = BenchmarkRunner._summarize_runs(_runs_for_summary(cloned))
    prefer_derived_summary = _payload_has_any_runs(cloned)
    raw_per_mode = _as_dict(summary.get("per_mode"))
    raw_per_mechanism = _as_dict(summary.get("per_mechanism"))
    raw_per_category = _as_dict(summary.get("per_category"))
    raw_per_category_by_mechanism = _as_dict(summary.get("per_category_by_mechanism"))
    derived_per_mode = _as_dict(derived_summary.get("per_mode"))
    derived_per_mechanism = _as_dict(derived_summary.get("per_mechanism"))
    derived_per_category = _as_dict(derived_summary.get("per_category"))
    derived_per_category_by_mechanism = _as_dict(
        derived_summary.get("per_category_by_mechanism")
    )

    per_mode_complete = _merge_metric_sections(
        (derived_per_mode or derived_per_mechanism)
        if prefer_derived_summary
        else (raw_per_mode or raw_per_mechanism),
        (raw_per_mode or raw_per_mechanism)
        if prefer_derived_summary
        else (derived_per_mode or derived_per_mechanism),
        metric_keys=(
            "accuracy",
            "run_count",
            "scored_run_count",
            "proxy_run_count",
            "avg_tokens",
            "avg_latency_ms",
            "avg_rounds",
            "switch_rate",
            "avg_thinking_tokens",
            "avg_estimated_cost_usd",
        ),
        fallback_keys=_BENCHMARK_MECHANISMS,
    )
    per_mechanism_complete = _merge_metric_sections(
        (derived_per_mechanism or derived_per_mode)
        if prefer_derived_summary
        else (raw_per_mechanism or raw_per_mode),
        (raw_per_mechanism or raw_per_mode)
        if prefer_derived_summary
        else (derived_per_mechanism or derived_per_mode),
        metric_keys=(
            "accuracy",
            "run_count",
            "scored_run_count",
            "proxy_run_count",
            "avg_tokens",
            "avg_latency_ms",
            "avg_rounds",
            "switch_rate",
            "avg_thinking_tokens",
            "avg_estimated_cost_usd",
        ),
        fallback_keys=_BENCHMARK_MECHANISMS,
    )
    per_category_complete = _merge_category_sections(
        derived_per_category if prefer_derived_summary else raw_per_category,
        raw_per_category if prefer_derived_summary else derived_per_category,
    )
    per_category_by_mechanism_complete = _merge_category_sections(
        (
            derived_per_category_by_mechanism
            if prefer_derived_summary
            else raw_per_category_by_mechanism
        ),
        (
            raw_per_category_by_mechanism
            if prefer_derived_summary
            else derived_per_category_by_mechanism
        ),
    )

    normalized_summary = dict(summary)
    normalized_summary["per_mode"] = per_mode_complete
    normalized_summary["per_mechanism"] = per_mechanism_complete
    normalized_summary["per_category"] = per_category_complete
    normalized_summary["per_category_by_mechanism"] = per_category_by_mechanism_complete
    for key in (
        "completed_run_count",
        "failed_run_count",
        "degraded_run_count",
        "scored_run_count",
        "proxy_run_count",
        "failure_counts_by_category",
        "failure_counts_by_reason",
        "failure_counts_by_stage",
    ):
        if prefer_derived_summary:
            normalized_summary[key] = derived_summary.get(key, normalized_summary.get(key))
            continue
        if normalized_summary.get(key) in (None, {}, 0):
            normalized_summary[key] = derived_summary.get(key, normalized_summary.get(key))
    cloned["summary"] = normalized_summary
    return cloned


async def _resolve_benchmark_summary_payload() -> dict[str, Any] | None:
    store = get_task_store()
    summary = await store.get_benchmark_summary()
    if isinstance(summary, dict):
        return _with_complete_summary(summary)

    global_artifacts = await store.list_global_benchmark_artifacts(limit=500)
    for artifact in global_artifacts:
        if not isinstance(artifact, dict):
            continue
        payload = _artifact_payload(artifact)
        if not _is_current_runtime_benchmark_payload(payload):
            continue
        if not _is_summary_block(_resolve_summary_block(payload)):
            continue
        normalized = _with_complete_summary(payload)
        await store.save_benchmark_summary(normalized)
        return normalized

    payload = _load_json_payload(_RESULTS_PATH)
    if payload is None:
        return None

    normalized = _with_complete_summary(payload)
    await store.save_benchmark_summary(normalized)
    return normalized


def _is_completed_runtime_benchmark_payload(artifact: dict[str, Any]) -> bool:
    payload = _artifact_payload(artifact)
    if not _is_current_runtime_benchmark_payload(payload):
        return False
    status = str(artifact.get("status") or payload.get("status") or "").strip().lower()
    if status and status != "completed":
        return False
    return _payload_has_any_runs(payload)


def _payload_has_stage_runs(payload: dict[str, Any]) -> bool:
    for stage_key in ("pre_learning", "learning_updates", "post_learning"):
        stage_payload = _as_dict(payload.get(stage_key))
        raw_runs = stage_payload.get("runs")
        if isinstance(raw_runs, list) and any(isinstance(run, dict) for run in raw_runs):
            return True
    return False


def _aggregate_benchmark_payloads(payloads: list[dict[str, Any]]) -> dict[str, Any]:
    aggregate_payload: dict[str, Any] = {
        "artifact_id": "aggregate-compatible-benchmarks",
        "generated_at": datetime.now(UTC).isoformat(),
        "artifact_version": "benchmark-aggregate-v1",
        "summary_scope": "aggregate",
        "aggregated_artifact_count": len(payloads),
        "aggregated_source_ids": [
            str(payload.get("artifact_id") or payload.get("run_id") or "").strip()
            for payload in payloads
            if str(payload.get("artifact_id") or payload.get("run_id") or "").strip()
        ],
    }

    total_runs = 0
    direct_runs: list[dict[str, Any]] = []
    for stage_key in ("pre_learning", "learning_updates", "post_learning"):
        stage_runs: list[dict[str, Any]] = []
        for payload in payloads:
            stage_payload = _as_dict(payload.get(stage_key))
            raw_runs = stage_payload.get("runs")
            if isinstance(raw_runs, list):
                stage_runs.extend([run for run in raw_runs if isinstance(run, dict)])
        if not stage_runs:
            continue
        total_runs += len(stage_runs)
        aggregate_payload[stage_key] = {
            "runs": stage_runs,
            "summary": BenchmarkRunner._summarize_runs(_runs_for_summary({"runs": stage_runs})),
        }

    for payload in payloads:
        if _payload_has_stage_runs(payload):
            continue
        raw_runs = payload.get("runs")
        if isinstance(raw_runs, list):
            direct_runs.extend([run for run in raw_runs if isinstance(run, dict)])

    if direct_runs:
        total_runs += len(direct_runs)
        aggregate_payload["runs"] = direct_runs

    aggregate_payload["aggregated_run_count"] = total_runs
    aggregate_payload["summary"] = BenchmarkRunner._summarize_runs(
        _runs_for_summary(aggregate_payload)
    )
    return _with_complete_summary(aggregate_payload)


async def _resolve_aggregate_benchmark_summary_payload(
    user: AuthenticatedUser | None,
    *,
    limit: int | None,
) -> dict[str, Any] | None:
    store = get_task_store()
    await _maybe_backfill_legacy_benchmarks()

    combined_artifacts: list[dict[str, Any]] = []
    if limit is None:
        fetch_limit = _AGGREGATE_BENCHMARK_FULL_CATALOG_LIMIT
    else:
        fetch_limit = max(limit, _AGGREGATE_BENCHMARK_DEFAULT_LIMIT)
        fetch_limit = min(fetch_limit, _AGGREGATE_BENCHMARK_FULL_CATALOG_LIMIT)
    combined_artifacts.extend(
        artifact
        for artifact in await store.list_global_benchmark_artifacts(
            limit=fetch_limit
        )
        if isinstance(artifact, dict)
    )

    if user is not None and user.workspace_id:
        combined_artifacts.extend(
            artifact
            for artifact in await store.list_user_benchmark_artifacts(
                user.workspace_id,
                limit=fetch_limit,
            )
            if isinstance(artifact, dict)
        )

    combined_artifacts.sort(
        key=lambda artifact: (
            str(artifact.get("created_at") or artifact.get("updated_at") or "")
        ),
        reverse=True,
    )

    compatible_payloads: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for artifact in combined_artifacts:
        if not _is_completed_runtime_benchmark_payload(artifact):
            continue
        payload = _artifact_payload(artifact)
        artifact_id = str(
            artifact.get("artifact_id") or payload.get("artifact_id") or artifact.get("run_id") or ""
        ).strip()
        if artifact_id and artifact_id in seen_ids:
            continue
        if artifact_id:
            seen_ids.add(artifact_id)
        compatible_payloads.append(payload)
        if limit is not None and len(compatible_payloads) >= limit:
            break

    if not compatible_payloads:
        return None

    aggregate_payload = _aggregate_benchmark_payloads(compatible_payloads)
    aggregate_payload["aggregation_window"] = (
        "all" if limit is None else f"recent_{limit}"
    )
    aggregate_payload["aggregated_artifact_count"] = len(compatible_payloads)
    return aggregate_payload


def _build_benchmark_detail_response(
    *,
    benchmark_id: str,
    scope: Literal["global", "user"],
    artifact: dict[str, Any] | None,
    run_record: dict[str, Any] | None,
) -> BenchmarkDetailResponse:
    artifact_payload_raw = _artifact_payload(artifact) if isinstance(artifact, dict) else {}
    payload = _with_complete_summary(artifact_payload_raw) if artifact_payload_raw else {}
    record_request = (
        run_record.get("request")
        if isinstance(run_record, dict) and isinstance(run_record.get("request"), dict)
        else None
    )
    if payload:
        telemetry = _artifact_telemetry(payload)
    else:
        raw_run_model_counts = (
            run_record.get("model_counts") if isinstance(run_record, dict) else {}
        )
        run_model_counts = raw_run_model_counts if isinstance(raw_run_model_counts, dict) else {}
        raw_run_model_usage = (
            run_record.get("model_token_usage") if isinstance(run_record, dict) else {}
        )
        run_model_usage = raw_run_model_usage if isinstance(raw_run_model_usage, dict) else {}
        telemetry = {
            "run_count": 0,
            "mechanism_counts": {},
            "model_counts": {},
            "frequency_score": (
                _safe_int(run_record.get("frequency_score")) if isinstance(run_record, dict) else 0
            ),
            "latest_mechanism": (
                str(run_record.get("latest_mechanism")).strip()
                if isinstance(run_record, dict) and run_record.get("latest_mechanism")
                else None
            ),
            "total_tokens": (
                _safe_int(run_record.get("total_tokens")) if isinstance(run_record, dict) else 0
            ),
            "thinking_tokens": (
                _safe_int(run_record.get("thinking_tokens")) if isinstance(run_record, dict) else 0
            ),
            "total_latency_ms": (
                _safe_float(run_record.get("total_latency_ms"))
                if isinstance(run_record, dict)
                else 0.0
            ),
            "models": sorted(run_model_counts.keys()),
            "model_token_usage": run_model_usage,
            "model_telemetry": (
                _model_telemetry_from_record(run_record) if isinstance(run_record, dict) else {}
            ),
            "cost": _cost_from_object(run_record) if isinstance(run_record, dict) else None,
        }
        agent_count = None
        if isinstance(run_record, dict):
            agent_count = _safe_positive_int(record_request.get("agent_count")) or _safe_positive_int(
                run_record.get("agent_count")
            )
        telemetry["agent_count"] = agent_count

    if telemetry.get("agent_count") is None and isinstance(record_request, dict):
        telemetry["agent_count"] = _safe_positive_int(record_request.get("agent_count"))
    agent_count = _first_positive_int(
        telemetry.get("agent_count"),
        record_request.get("agent_count") if isinstance(record_request, dict) else None,
        run_record.get("agent_count") if isinstance(run_record, dict) else None,
    )
    telemetry["agent_count"] = agent_count
    artifact_created_at = artifact.get("created_at") if isinstance(artifact, dict) else None
    payload_generated_at = payload.get("generated_at") if isinstance(payload, dict) else None
    created_at = _parse_timestamp(
        artifact_created_at
        or payload_generated_at
        or (run_record.get("created_at") if isinstance(run_record, dict) else None)
        or datetime.now(UTC).isoformat()
    )
    updated_at = _parse_timestamp(
        (run_record.get("updated_at") if isinstance(run_record, dict) else None)
        or artifact_created_at
        or payload_generated_at
        or datetime.now(UTC).isoformat()
    )

    artifact_id = None
    if isinstance(artifact, dict):
        for key in ("artifact_id", "run_id"):
            value = artifact.get(key)
            if isinstance(value, str) and value.strip():
                artifact_id = value.strip()
                break
    if (
        artifact_id is None
        and isinstance(run_record, dict)
        and isinstance(run_record.get("artifact_id"), str)
    ):
        artifact_id = run_record.get("artifact_id")

    status = None
    if isinstance(run_record, dict):
        status = str(run_record.get("status") or "").strip() or None
    if status is None and isinstance(artifact, dict):
        status = str(artifact.get("status") or "").strip() or None

    source = "unknown"
    if isinstance(artifact, dict):
        source = str(artifact.get("source") or "unknown")

    owner_user_id = None
    if isinstance(artifact, dict) and isinstance(artifact.get("owner_user_id"), str):
        owner_user_id = artifact.get("owner_user_id")

    request_record = _stored_benchmark_request(record_request)
    summary = _benchmark_summary_response(payload.get("summary") if payload else None)
    benchmark_items, active_item_id, failure_counts_by_stage = _benchmark_items_from_payload(
        benchmark_id=benchmark_id,
        payload=payload,
        run_record=run_record,
    )
    artifact_benchmark_items = _artifact_benchmark_items(artifact)
    if artifact_benchmark_items:
        benchmark_items = _merge_benchmark_item_snapshots(
            benchmark_items,
            artifact_benchmark_items,
        )
        if active_item_id is None or not any(
            item.item_id == active_item_id for item in benchmark_items
        ):
            active_item_id = _artifact_active_item_id(artifact, benchmark_items)
    elif active_item_id is None:
        active_item_id = _artifact_active_item_id(artifact, benchmark_items)
    if not failure_counts_by_stage:
        failure_counts_by_stage = _artifact_failure_counts_by_stage(artifact)
    active_item = next(
        (item for item in benchmark_items if item.item_id == active_item_id),
        None,
    )

    return BenchmarkDetailResponse(
        benchmark_id=benchmark_id,
        artifact_id=artifact_id,
        run_id=(
            str(run_record.get("run_id")).strip()
            if isinstance(run_record, dict) and run_record.get("run_id")
            else None
        ),
        scope=scope,
        source=source,
        status=status,
        owner_user_id=owner_user_id,
        created_at=created_at,
        updated_at=updated_at,
        run_count=telemetry["run_count"],
        mechanism_counts=telemetry["mechanism_counts"],
        model_counts=telemetry["model_counts"],
        frequency_score=telemetry["frequency_score"],
        latest_mechanism=telemetry["latest_mechanism"],
        agent_count=agent_count,
        total_tokens=telemetry["total_tokens"],
        thinking_tokens=telemetry["thinking_tokens"],
        total_latency_ms=telemetry.get("total_latency_ms", 0.0),
        models=telemetry["models"],
        request=request_record,
        reasoning_presets=(
            request_record.reasoning_presets
            if request_record is not None
            else resolve_reasoning_presets(
                record_request.get("reasoning_presets") if isinstance(record_request, dict) else None
            )
        ),
        tier_model_overrides=(
            request_record.tier_model_overrides if request_record is not None else None
        ),
        model_telemetry=telemetry.get("model_telemetry", {}),
        events=[
            TaskEvent.model_validate(event)
            for event in (
                run_record.get("events", []) if isinstance(run_record, dict) else []
            )
            if isinstance(event, dict)
        ],
        summary=summary,
        benchmark_payload=payload,
        cost=telemetry["cost"],
        benchmark_items=benchmark_items,
        active_item_id=active_item_id,
        active_item=active_item,
        completed_item_count=_safe_int(telemetry.get("completed_item_count")),
        failed_item_count=_safe_int(telemetry.get("failed_item_count")),
        degraded_item_count=_safe_int(telemetry.get("degraded_item_count")),
        failure_counts_by_category=telemetry.get("failure_counts_by_category", {}),
        failure_counts_by_reason=telemetry.get("failure_counts_by_reason", {}),
        failure_counts_by_stage=(
            telemetry.get("failure_counts_by_stage", {}) or failure_counts_by_stage
        ),
    )


def _synthesize_demo_runs(demo_payload: dict[str, Any]) -> list[dict[str, Any]]:
    sdk_flow = _as_dict(demo_payload.get("sdk_flow"))
    status_after_run = _as_dict(sdk_flow.get("status_after_run"))
    status_after_pay = _as_dict(sdk_flow.get("status_after_pay"))
    run_result = _as_dict(sdk_flow.get("run_result")) or _as_dict(status_after_run.get("result"))
    tx_summary = _as_dict(demo_payload.get("tx_summary"))

    task_id = status_after_run.get("task_id") or status_after_pay.get("task_id")
    task_text = (
        status_after_run.get("task_text") or demo_payload.get("query") or "Benchmark demo run"
    )
    mode = (
        run_result.get("mechanism")
        or status_after_run.get("mechanism")
        or demo_payload.get("mechanism")
    )
    merkle_root = run_result.get("merkle_root") or status_after_run.get("merkle_root")
    explorer_url = status_after_run.get("explorer_url") or tx_summary.get("receipt_explorer_url")
    latency_ms = run_result.get("latency_ms")
    total_tokens = run_result.get("total_tokens_used") or run_result.get("total_tokens")
    confidence = run_result.get("confidence")
    quorum_reached = bool(run_result.get("quorum_reached"))
    correct = bool(quorum_reached and _safe_float(confidence) >= 0.6)
    round_count = _safe_int(run_result.get("round_count") or demo_payload.get("round_count"), default=1)
    mechanism_switches = _safe_int(
        run_result.get("mechanism_switches") or demo_payload.get("mechanism_switches"),
    )
    agent_count = _safe_positive_int(run_result.get("agent_count") or demo_payload.get("agent_count"))
    agent_models_used = run_result.get("agent_models_used")

    if not any([task_id, task_text, mode, merkle_root, explorer_url, latency_ms]):
        return []

    return [
        {
            "task_id": task_id,
            "task": task_text,
            "category": "demo",
            "mode": mode or "selector",
            "mechanism_used": mode or "selector",
            "correct": correct,
            "tokens_used": _safe_int(total_tokens, default=0),
            "latency_ms": latency_ms,
            "rounds": round_count,
            "switches": mechanism_switches,
            "merkle_root": merkle_root,
            "explorer_url": explorer_url,
            "confidence": run_result.get("confidence"),
            "final_answer": run_result.get("final_answer"),
            "status": status_after_pay.get("status")
            or status_after_run.get("status")
            or demo_payload.get("final_status"),
            "agent_count": agent_count,
            "agent_models_used": agent_models_used,
        }
    ]


def _run_status(value: str | None) -> Literal["queued", "running", "completed", "failed"]:
    candidate = (value or "").strip().lower()
    if candidate in _RUN_STATUS_VALUES:
        return candidate  # type: ignore[return-value]
    return "failed"


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value.strip():
        candidate = value.strip().replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(candidate)
        except ValueError:
            pass
    return datetime.now(UTC)


def _compose_benchmark_item_id(
    *,
    phase: str | None,
    run_kind: str | None,
    task_index: int | None,
) -> str | None:
    normalized_phase = str(phase or "").strip()
    normalized_run_kind = str(run_kind or "").strip()
    if task_index is None or task_index < 0:
        return None
    if not normalized_phase or not normalized_run_kind:
        return None
    return f"{normalized_phase}:{normalized_run_kind}:{task_index}"


def _infer_benchmark_item_status_from_run(run: dict[str, Any]) -> str:
    raw_status = str(run.get("item_status") or "").strip().lower()
    if raw_status in {"queued", "running", "completed", "failed", "degraded"}:
        return raw_status
    if run.get("failure_reason") or run.get("latest_error_event"):
        return "failed"
    fallback_events = run.get("fallback_events")
    if isinstance(fallback_events, list) and fallback_events:
        return "degraded"
    return "completed"


def _infer_benchmark_item_status_from_event(
    event_type: str,
    event_data: dict[str, Any],
) -> str | None:
    explicit = str(event_data.get("item_status") or "").strip().lower()
    if explicit in {"queued", "running", "completed", "failed", "degraded"}:
        return explicit

    if event_type in {
        "agent_output_delta",
        "agent_output",
        "usage_delta",
        "thinking_delta",
        "cross_examination",
        "cross_examination_delta",
        "convergence_update",
        "delphi_feedback",
        "delphi_finalize",
        "mechanism_selected",
        "mechanism_switch",
        "provider_retrying",
    }:
        return "running"

    if event_type == "domain_progress":
        latest_run = _as_dict(event_data.get("latest_run"))
        return _infer_benchmark_item_status_from_run(latest_run)

    if event_type in {"failed", "error"} and event_data.get("item_id"):
        return "failed"

    return None


def _latest_convergence_metrics(run: dict[str, Any]) -> dict[str, float | int | None]:
    history = run.get("convergence_history")
    if not isinstance(history, list) or not history:
        return {
            "latest_entropy": None,
            "latest_novelty": None,
            "latest_information_gain_delta": None,
            "latest_answer_churn": None,
        }
    latest = next((entry for entry in reversed(history) if isinstance(entry, dict)), {})
    if not isinstance(latest, dict):
        latest = {}
    return {
        "latest_entropy": _safe_float(latest.get("entropy")),
        "latest_novelty": _safe_float(latest.get("novelty_score")),
        "latest_information_gain_delta": _safe_float(latest.get("information_gain_delta")),
        "latest_answer_churn": _safe_float(latest.get("answer_churn")),
    }


def _benchmark_item_summary_from_run(run: dict[str, Any]) -> dict[str, Any]:
    convergence = _latest_convergence_metrics(run)
    return {
        "confidence": _safe_float(run.get("confidence")),
        "correct": bool(run.get("correct")),
        "scored": bool(run.get("scored")),
        "scoring_mode": str(run.get("scoring_mode") or "").strip() or None,
        "quorum_reached": bool(run.get("quorum_reached")),
        "final_answer": str(run.get("final_answer") or "").strip() or None,
        "rounds": _safe_int(run.get("rounds")),
        "switches": _safe_int(run.get("switches")),
        "execution_mode": str(run.get("execution_mode") or "").strip() or None,
        **convergence,
    }


def _event_item_identity(event: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    data = _as_dict(event.get("data"))
    benchmark_context = _as_dict(data.get("benchmark_context"))
    latest_run = _as_dict(data.get("latest_run"))
    phase = str(
        data.get("phase")
        or benchmark_context.get("phase")
        or latest_run.get("phase")
        or ""
    ).strip() or None
    run_kind = (
        str(
            data.get("run_kind")
            or benchmark_context.get("run_kind")
            or latest_run.get("run_kind")
            or ""
        ).strip() or None
    )
    task_index_raw = data.get(
        "task_index",
        benchmark_context.get("task_index", latest_run.get("task_index")),
    )
    task_index = _safe_int(task_index_raw, default=-1)
    item_id = (
        str(data.get("item_id") or benchmark_context.get("item_id") or "").strip()
        or _compose_benchmark_item_id(
            phase=phase,
            run_kind=run_kind,
            task_index=task_index if task_index >= 0 else None,
        )
    )
    return (item_id or None), {
        "phase": phase,
        "run_kind": run_kind,
        "task_index": task_index if task_index >= 0 else None,
        "category": str(
            data.get("category")
            or benchmark_context.get("category")
            or latest_run.get("category")
            or ""
        ).strip()
        or "unknown",
        "question": str(
            data.get("question")
            or benchmark_context.get("question")
            or latest_run.get("question")
            or latest_run.get("task")
            or ""
        ).strip()
        or "Benchmark question",
        "source_task": str(
            data.get("source_task")
            or benchmark_context.get("source_task")
            or latest_run.get("source_task")
            or latest_run.get("task")
            or ""
        ).strip()
        or None,
        "item_index": _safe_int(
            data.get(
                "item_index",
                benchmark_context.get("item_index", latest_run.get("item_index")),
            ),
            default=-1,
        ),
    }


def _expected_benchmark_items_from_request(
    *,
    benchmark_id: str,
    run_record: dict[str, Any] | None,
) -> list[BenchmarkItemResponse]:
    if not isinstance(run_record, dict):
        return []

    request_payload = _as_dict(run_record.get("request"))
    if not request_payload:
        return []

    try:
        request = BenchmarkRunRequest.model_validate(request_payload)
    except Exception:
        return []

    resolved_prompts_raw = request_payload.get("resolved_domain_prompts")
    resolved_prompts = (
        resolved_prompts_raw
        if isinstance(resolved_prompts_raw, dict)
        else _resolved_domain_prompts(request)
    )

    try:
        training_tasks, holdout_tasks = BenchmarkRunner.build_phase2_task_split(
            training_per_category=request.training_per_category,
            holdout_per_category=request.holdout_per_category,
        )
    except Exception:
        return []

    training_tasks = _apply_domain_prompts(training_tasks, resolved_prompts)
    holdout_tasks = _apply_domain_prompts(holdout_tasks, resolved_prompts)

    expected: list[BenchmarkItemResponse] = []
    item_index = 0

    def _append_item(
        *,
        phase: str,
        run_kind: str,
        task_index: int,
        task_item: dict[str, Any],
    ) -> None:
        nonlocal item_index
        question = str(task_item.get("question") or task_item.get("task") or "").strip() or "Benchmark question"
        source_task = str(task_item.get("task") or question).strip() or question
        expected.append(
            BenchmarkItemResponse(
                item_id=(
                    _compose_benchmark_item_id(
                        phase=phase,
                        run_kind=run_kind,
                        task_index=task_index,
                    )
                    or f"{benchmark_id}:{phase}:{run_kind}:{task_index}"
                ),
                item_index=item_index,
                task_index=task_index,
                phase=phase,
                run_kind=run_kind,
                category=str(task_item.get("category") or "unknown").strip() or "unknown",
                question=question,
                source_task=source_task,
                status="queued",
                mechanism=None,
                selector_source=None,
                selector_fallback_path=[],
                failure_reason=None,
                latest_error_event=None,
                fallback_events=[],
                total_tokens=0,
                thinking_tokens=0,
                total_latency_ms=0.0,
                model_telemetry={},
                summary={},
                started_at=None,
                completed_at=None,
                events=[],
            )
        )
        item_index += 1

    for task_index, task_item in enumerate(training_tasks):
        _append_item(
            phase="pre_learning",
            run_kind="selector_initial",
            task_index=task_index,
            task_item=task_item,
        )
        _append_item(
            phase="learning_updates",
            run_kind="selector_learn",
            task_index=task_index,
            task_item=task_item,
        )

    for task_index, task_item in enumerate(holdout_tasks):
        _append_item(
            phase="post_learning",
            run_kind="selector_holdout",
            task_index=task_index,
            task_item=task_item,
        )

    record_status = str(run_record.get("status") or "").strip().lower()
    run_error = str(run_record.get("error") or "").strip() or None
    completed_count = _safe_int(run_record.get("completed_item_count"))

    for index, item in enumerate(expected):
        if index < completed_count:
            expected[index] = item.model_copy(update={"status": "completed"})

    if expected:
        if record_status == "running":
            active_index = min(completed_count, len(expected) - 1)
            expected[active_index] = expected[active_index].model_copy(update={"status": "running"})
        elif record_status == "failed":
            failed_index = min(completed_count, len(expected) - 1)
            expected[failed_index] = expected[failed_index].model_copy(
                update={
                    "status": "failed",
                    "failure_reason": run_error,
                    "latest_error_event": (
                        TaskEvent(
                            event="error",
                            data={"message": run_error},
                            timestamp=datetime.now(UTC),
                        )
                        if run_error
                        else None
                    ),
                }
            )

    return expected


def _run_item_identity(run: dict[str, Any], *, fallback_index: int) -> tuple[str, dict[str, Any]]:
    phase = str(run.get("phase") or "").strip() or None
    run_kind = str(run.get("run_kind") or "").strip() or None
    task_index = _safe_int(run.get("task_index"), default=fallback_index)
    item_id = (
        str(run.get("item_id") or "").strip()
        or _compose_benchmark_item_id(
            phase=phase,
            run_kind=run_kind,
            task_index=task_index,
        )
        or f"item:{fallback_index}"
    )
    return item_id, {
        "phase": phase,
        "run_kind": run_kind,
        "task_index": task_index,
        "category": str(run.get("category") or "unknown").strip() or "unknown",
        "question": str(run.get("question") or run.get("task") or "Benchmark question").strip()
        or "Benchmark question",
        "source_task": (
            str(run.get("source_task") or run.get("task") or "").strip() or None
        ),
        "item_index": _safe_int(run.get("item_index"), default=fallback_index),
    }


def _benchmark_items_from_payload(
    *,
    benchmark_id: str,
    payload: dict[str, Any],
    run_record: dict[str, Any] | None,
) -> tuple[list[BenchmarkItemResponse], str | None, dict[str, int]]:
    runs = _extract_runs(payload) if payload else []
    raw_events = run_record.get("events", []) if isinstance(run_record, dict) else []
    stored_items = (
        run_record.get("benchmark_items", [])
        if isinstance(run_record, dict) and isinstance(run_record.get("benchmark_items"), list)
        else []
    )
    event_models = [
        TaskEvent.model_validate(event)
        for event in raw_events
        if isinstance(event, dict)
    ]
    events_by_item: dict[str, list[TaskEvent]] = {}
    item_meta_from_events: dict[str, dict[str, Any]] = {}
    active_item_id: str | None = None
    failure_counts_by_stage: dict[str, int] = {}

    for event in event_models:
        event_dump = event.model_dump(mode="json")
        item_id, event_meta = _event_item_identity(event_dump)
        if item_id is None:
            continue
        events_by_item.setdefault(item_id, []).append(event)
        item_meta_from_events.setdefault(item_id, event_meta)
        active_item_id = item_id
        if event.event in {"failed", "error"}:
            stage_key = (
                str(event.data.get("stage") or event_meta.get("run_kind") or "unknown").strip()
                or "unknown"
            )
            failure_counts_by_stage[stage_key] = failure_counts_by_stage.get(stage_key, 0) + 1

    item_records: dict[str, BenchmarkItemResponse] = {
        item.item_id: item
        for item in (
            BenchmarkItemResponse.model_validate(item)
            for item in stored_items
            if isinstance(item, dict)
        )
    }
    for fallback_index, run in enumerate(runs):
        item_id, run_meta = _run_item_identity(run, fallback_index=fallback_index)
        item_events = events_by_item.get(item_id, [])
        model_telemetry = _model_telemetry_from_record(run)
        latest_error_event = run.get("latest_error_event")
        item_records[item_id] = BenchmarkItemResponse(
            item_id=item_id,
            item_index=max(0, run_meta["item_index"]),
            task_index=max(0, run_meta["task_index"]),
            phase=run_meta["phase"],
            run_kind=run_meta["run_kind"],
            category=run_meta["category"],
            question=run_meta["question"],
            source_task=run_meta["source_task"],
            status=_infer_benchmark_item_status_from_run(run),
            mechanism=(
                str(run.get("mechanism_used") or run.get("mechanism") or run.get("mode") or "").strip()
                or None
            ),
            selector_source=(
                str(run.get("selector_source") or "").strip() or None
            ),
            selector_fallback_path=[
                str(step)
                for step in run.get("selector_fallback_path", [])
                if str(step).strip()
            ]
            if isinstance(run.get("selector_fallback_path"), list)
            else [],
            failure_reason=(
                str(run.get("failure_reason")).strip() if run.get("failure_reason") else None
            ),
            latest_error_event=(
                TaskEvent.model_validate(latest_error_event)
                if isinstance(latest_error_event, dict)
                else None
            ),
            fallback_events=[
                event
                if isinstance(event, dict)
                else event.model_dump(mode="json")
                for event in run.get("fallback_events", [])
                if isinstance(event, dict) or hasattr(event, "model_dump")
            ]
            if isinstance(run.get("fallback_events"), list)
            else [],
            total_tokens=_safe_int(run.get("tokens_used") or run.get("total_tokens_used")),
            thinking_tokens=_safe_int(run.get("thinking_tokens_used")),
            total_latency_ms=_safe_float(run.get("latency_ms")),
            model_telemetry=model_telemetry,
            summary=_benchmark_item_summary_from_run(run),
            started_at=(item_events[0].timestamp if item_events else None),
            completed_at=(item_events[-1].timestamp if item_events else None),
            events=item_events,
        )

    for item_id, item_events in events_by_item.items():
        if item_id in item_records:
            continue
        meta = item_meta_from_events[item_id]
        latest_event = item_events[-1]
        latest_data = _as_dict(latest_event.data)
        inferred_status = _infer_benchmark_item_status_from_event(latest_event.event, latest_data) or "running"
        item_records[item_id] = BenchmarkItemResponse(
            item_id=item_id,
            item_index=max(0, meta["item_index"]) if meta["item_index"] >= 0 else len(item_records),
            task_index=max(0, meta["task_index"]) if meta["task_index"] is not None else len(item_records),
            phase=meta["phase"],
            run_kind=meta["run_kind"],
            category=meta["category"],
            question=meta["question"],
            source_task=meta["source_task"],
            status=inferred_status,  # type: ignore[arg-type]
            mechanism=(
                str(latest_data.get("mechanism") or latest_data.get("latest_mechanism") or "").strip()
                or None
            ),
            selector_source=(
                str(latest_data.get("selector_source") or "").strip() or None
            ),
            selector_fallback_path=[
                str(step)
                for step in latest_data.get("selector_fallback_path", [])
                if str(step).strip()
            ]
            if isinstance(latest_data.get("selector_fallback_path"), list)
            else [],
            failure_reason=(
                str(latest_data.get("message")).strip() if latest_event.event in {"failed", "error"} else None
            ),
            latest_error_event=latest_event if latest_event.event in {"failed", "error"} else None,
            fallback_events=[],
            total_tokens=_safe_int(latest_data.get("total_tokens")),
            thinking_tokens=_safe_int(latest_data.get("thinking_tokens")),
            total_latency_ms=_safe_float(latest_data.get("total_latency_ms") or latest_data.get("latency_ms")),
            model_telemetry={},
            summary={},
            started_at=item_events[0].timestamp,
            completed_at=item_events[-1].timestamp,
            events=item_events,
        )

    expected_items = _expected_benchmark_items_from_request(
        benchmark_id=benchmark_id,
        run_record=run_record,
    )
    generic_aliases: list[tuple[str, BenchmarkItemResponse]] = []
    for item_id, item in item_records.items():
        phase_key = (item.phase or "").strip().lower()
        run_kind_key = (item.run_kind or "").strip().lower()
        if phase_key and phase_key != "benchmark":
            continue
        if run_kind_key and run_kind_key != "run":
            continue
        generic_aliases.append((item_id, item))

    for expected in expected_items:
        existing = item_records.get(expected.item_id)
        if existing is None:
            alias_entry = next(
                (
                    (alias_id, alias_item)
                    for alias_id, alias_item in generic_aliases
                    if alias_item.task_index == expected.task_index
                    and alias_item.category == expected.category
                    and alias_item.question == expected.question
                ),
                None,
            )
            if alias_entry is not None:
                alias_id, alias_item = alias_entry
                item_records.pop(alias_id, None)
                generic_aliases = [
                    entry for entry in generic_aliases if entry[0] != alias_id
                ]
                item_records[expected.item_id] = alias_item.model_copy(
                    update={
                        "item_id": expected.item_id,
                        "item_index": expected.item_index,
                        "task_index": expected.task_index,
                        "phase": expected.phase,
                        "run_kind": expected.run_kind,
                        "category": expected.category,
                        "question": expected.question,
                        "source_task": alias_item.source_task or expected.source_task,
                    }
                )
                if active_item_id == alias_id:
                    active_item_id = expected.item_id
                continue
            item_records[expected.item_id] = expected
            continue
        item_records[expected.item_id] = existing.model_copy(
            update={
                "item_index": existing.item_index if existing.item_index >= 0 else expected.item_index,
                "task_index": existing.task_index if existing.task_index >= 0 else expected.task_index,
                "phase": existing.phase or expected.phase,
                "run_kind": existing.run_kind or expected.run_kind,
                "category": (
                    existing.category
                    if existing.category and existing.category != "unknown"
                    else expected.category
                ),
                "question": (
                    existing.question
                    if existing.question and existing.question != "Benchmark question"
                    else expected.question
                ),
                "source_task": existing.source_task or expected.source_task,
            }
        )

    benchmark_items = sorted(
        item_records.values(),
        key=lambda item: (item.item_index, item.task_index, item.item_id),
    )
    if active_item_id is None and benchmark_items:
        prioritized = next(
            (
                item
                for item in benchmark_items
                if item.status in {"running", "failed", "degraded"}
            ),
            benchmark_items[0],
        )
        active_item_id = prioritized.item_id
    return benchmark_items, active_item_id, failure_counts_by_stage


def _artifact_benchmark_items(artifact: dict[str, Any] | None) -> list[BenchmarkItemResponse]:
    if not isinstance(artifact, dict):
        return []
    raw_items = artifact.get("benchmark_items")
    if not isinstance(raw_items, list):
        return []
    return [
        BenchmarkItemResponse.model_validate(item)
        for item in raw_items
        if isinstance(item, dict)
    ]


def _artifact_active_item_id(
    artifact: dict[str, Any] | None,
    benchmark_items: list[BenchmarkItemResponse],
) -> str | None:
    if isinstance(artifact, dict):
        raw_item_id = artifact.get("active_item_id")
        if isinstance(raw_item_id, str) and raw_item_id.strip():
            candidate = raw_item_id.strip()
            if any(item.item_id == candidate for item in benchmark_items):
                return candidate
    return benchmark_items[0].item_id if benchmark_items else None


def _artifact_failure_counts_by_stage(artifact: dict[str, Any] | None) -> dict[str, int]:
    if not isinstance(artifact, dict):
        return {}
    raw_counts = artifact.get("failure_counts_by_stage")
    if not isinstance(raw_counts, dict):
        return {}
    return {
        str(key): _safe_int(value)
        for key, value in raw_counts.items()
        if str(key).strip()
    }


def _merge_benchmark_item_snapshots(
    current_items: list[BenchmarkItemResponse],
    artifact_items: list[BenchmarkItemResponse],
) -> list[BenchmarkItemResponse]:
    artifact_by_id = {item.item_id: item for item in artifact_items}
    merged_items: list[BenchmarkItemResponse] = []
    seen_item_ids: set[str] = set()

    for item in current_items:
        artifact_item = artifact_by_id.get(item.item_id)
        if artifact_item is None:
            merged_items.append(item)
            seen_item_ids.add(item.item_id)
            continue

        merged_items.append(
            item.model_copy(
                update={
                    "status": (
                        artifact_item.status
                        if item.status == "queued" and artifact_item.status != "queued"
                        else item.status
                    ),
                    "mechanism": item.mechanism or artifact_item.mechanism,
                    "selector_source": item.selector_source or artifact_item.selector_source,
                    "selector_fallback_path": (
                        item.selector_fallback_path
                        if item.selector_fallback_path
                        else artifact_item.selector_fallback_path
                    ),
                    "failure_reason": item.failure_reason or artifact_item.failure_reason,
                    "latest_error_event": item.latest_error_event or artifact_item.latest_error_event,
                    "fallback_events": (
                        item.fallback_events if item.fallback_events else artifact_item.fallback_events
                    ),
                    "total_tokens": item.total_tokens or artifact_item.total_tokens,
                    "thinking_tokens": item.thinking_tokens or artifact_item.thinking_tokens,
                    "total_latency_ms": item.total_latency_ms or artifact_item.total_latency_ms,
                    "model_telemetry": (
                        item.model_telemetry if item.model_telemetry else artifact_item.model_telemetry
                    ),
                    "summary": item.summary if item.summary else artifact_item.summary,
                    "started_at": item.started_at or artifact_item.started_at,
                    "completed_at": item.completed_at or artifact_item.completed_at,
                    "events": item.events if item.events else artifact_item.events,
                }
            )
        )
        seen_item_ids.add(item.item_id)

    for artifact_item in artifact_items:
        if artifact_item.item_id in seen_item_ids:
            continue
        merged_items.append(artifact_item)

    return sorted(
        merged_items,
        key=lambda item: (item.item_index, item.task_index, item.item_id),
    )


def _extract_runs(payload: dict[str, Any]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    direct_runs = payload.get("runs")
    if isinstance(direct_runs, list):
        runs.extend([run for run in direct_runs if isinstance(run, dict)])

    for stage_key in ("post_learning", "pre_learning", "learning_updates"):
        stage_payload = _as_dict(payload.get(stage_key))
        stage_runs = stage_payload.get("runs")
        if isinstance(stage_runs, list):
            runs.extend([run for run in stage_runs if isinstance(run, dict)])

    demo_report = _as_dict(payload.get("demo_report"))
    run_result = _as_dict(demo_report.get("run_result"))
    if run_result:
        confidence = run_result.get("confidence")
        quorum_reached = bool(run_result.get("quorum_reached"))
        runs.append(
            {
                "mode": (
                    run_result.get("mode")
                    or demo_report.get("mechanism")
                    or run_result.get("mechanism")
                ),
                "mechanism_used": run_result.get("mechanism") or demo_report.get("mechanism"),
                "model": run_result.get("model"),
                "agent_count": run_result.get("agent_count") or demo_report.get("agent_count"),
                "agent_models_used": run_result.get("agent_models_used"),
                "correct": bool(quorum_reached and _safe_float(confidence) >= 0.6),
                "tokens_used": run_result.get("total_tokens_used") or run_result.get("tokens_used"),
                "latency_ms": run_result.get("latency_ms"),
                "rounds": run_result.get("round_count"),
                "switches": run_result.get("mechanism_switches"),
                "confidence": confidence,
                "final_answer": run_result.get("final_answer"),
            }
        )

    return runs


def _runs_for_summary(payload: dict[str, Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for run in _extract_runs(payload):
        mode = str(run.get("mode") or run.get("stage") or "selector").strip().lower()
        mechanism = (
            str(run.get("mechanism_used") or run.get("mechanism") or run.get("mode") or "selector")
            .strip()
            .lower()
        )
        category = str(run.get("category") or "demo").strip().lower() or "demo"
        normalized.append(
            {
                "mode": mode,
                "stage": mode,
                "mechanism_used": mechanism,
                "category": category,
                "item_status": str(run.get("item_status") or "completed").strip().lower() or "completed",
                "failure_reason": str(run.get("failure_reason") or "").strip() or None,
                "correct": bool(run.get("correct")),
                "scored": bool(run.get("scored")),
                "scoring_mode": str(run.get("scoring_mode") or "").strip().lower() or None,
                "tokens_used": _safe_int(run.get("tokens_used") or run.get("total_tokens_used")),
                "latency_ms": _safe_float(run.get("latency_ms")),
                "rounds": _safe_int(run.get("rounds")),
                "switches": _safe_int(run.get("switches")),
                "thinking_tokens_used": _safe_int(run.get("thinking_tokens_used")),
                "estimated_cost_usd": _safe_float(run.get("estimated_cost_usd")),
                "run_kind": str(run.get("run_kind") or run.get("phase") or run.get("mode") or "")
                .strip()
                .lower()
                or None,
                "phase": str(run.get("phase") or run.get("run_kind") or run.get("mode") or "")
                .strip()
                .lower()
                or None,
            }
        )
    return normalized


def _extract_model_names(run: dict[str, Any]) -> list[str]:
    discovered: list[str] = []

    for key in ("model", "agent_model"):
        value = run.get(key)
        if isinstance(value, str):
            candidate = value.strip()
            if candidate and candidate not in discovered:
                discovered.append(candidate)

    for key in ("agent_models_used", "models"):
        value = run.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str):
                    candidate = item.strip()
                    if candidate and candidate not in discovered:
                        discovered.append(candidate)

    return discovered


def _frequency_from_runs(runs: list[dict[str, Any]]) -> tuple[dict[str, int], dict[str, int], int]:
    mechanism_counter: Counter[str] = Counter()
    model_counter: Counter[str] = Counter()

    for run in runs:
        mechanism = (
            str(run.get("mechanism_used") or run.get("mechanism") or run.get("mode") or "")
            .strip()
            .lower()
        )
        if mechanism:
            mechanism_counter[mechanism] += 1

        for model_name in _extract_model_names(run):
            model_counter[model_name] += 1

    mechanism_counts = dict(mechanism_counter)
    model_counts = dict(model_counter)
    frequency_score = sum(mechanism_counts.values()) + sum(model_counts.values())
    return mechanism_counts, model_counts, frequency_score


def _artifact_payload(artifact: dict[str, Any]) -> dict[str, Any]:
    payload = artifact.get("benchmark_payload")
    if isinstance(payload, dict):
        return payload

    legacy_payload = artifact.get("payload")
    if isinstance(legacy_payload, dict):
        return legacy_payload

    # Legacy artifacts may be raw benchmark payloads without wrappers.
    return artifact


def _is_current_runtime_benchmark_payload(payload: dict[str, Any]) -> bool:
    version = str(payload.get("artifact_version") or "").strip()
    if version == "benchmark-tasklike-v2":
        return True
    benchmark_config = _as_dict(payload.get("benchmark_config"))
    return bool(benchmark_config and payload.get("generated_at"))


def _is_catalog_runtime_benchmark_payload(payload: dict[str, Any]) -> bool:
    if _is_current_runtime_benchmark_payload(payload):
        return True
    return isinstance(payload.get("runs"), list)


def _is_catalog_eligible_artifact(artifact: dict[str, Any]) -> bool:
    return _is_catalog_runtime_benchmark_payload(_artifact_payload(artifact))


def _artifact_identifier_candidates(artifact: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    for key in ("artifact_id", "run_id"):
        value = artifact.get(key)
        if not isinstance(value, str):
            continue
        normalized = value.strip()
        if normalized and normalized not in candidates:
            candidates.append(normalized)
    return candidates


def _find_artifact_by_identifier(
    artifacts: list[dict[str, Any]],
    identifier: str,
) -> dict[str, Any] | None:
    wanted = str(identifier).strip()
    if not wanted:
        return None

    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        if wanted in _artifact_identifier_candidates(artifact):
            return artifact
    return None


def _to_catalog_entry(
    artifact: dict[str, Any],
    *,
    default_scope: Literal["global", "user"],
) -> BenchmarkCatalogEntry | None:
    artifact_id = str(artifact.get("artifact_id") or artifact.get("run_id") or "").strip()
    if not artifact_id:
        return None
    try:
        validate_storage_id(artifact_id, field_name="artifact_id")
    except ValueError:
        return None

    payload = _artifact_payload(artifact)
    telemetry = _artifact_telemetry(payload)

    scope_value = str(artifact.get("scope") or default_scope).strip().lower()
    scope: Literal["global", "user"] = "user" if scope_value == "user" else "global"

    owner_user_id = artifact.get("owner_user_id")
    owner = (
        str(owner_user_id).strip()
        if isinstance(owner_user_id, str) and owner_user_id.strip()
        else None
    )
    agent_count = _safe_positive_int(telemetry.get("agent_count"))
    telemetry["agent_count"] = agent_count

    return BenchmarkCatalogEntry(
        artifact_id=artifact_id,
        scope=scope,
        owner_user_id=owner,
        source=str(artifact.get("source") or "unknown"),
        created_at=_parse_timestamp(
            artifact.get("created_at")
            or payload.get("generated_at")
            or datetime.now(UTC).isoformat()
        ),
        run_count=telemetry["run_count"],
        mechanism_counts=telemetry["mechanism_counts"],
        model_counts=telemetry["model_counts"],
        frequency_score=telemetry["frequency_score"],
        status=str(artifact.get("status")) if artifact.get("status") is not None else None,
        latest_mechanism=telemetry["latest_mechanism"],
        agent_count=agent_count,
        total_tokens=telemetry["total_tokens"],
        thinking_tokens=telemetry["thinking_tokens"],
        total_latency_ms=telemetry.get("total_latency_ms", 0.0),
        models=telemetry["models"],
        model_telemetry=telemetry.get("model_telemetry", {}),
        cost=telemetry["cost"],
    )


def _to_run_status(
    record: dict[str, Any],
    *,
    run_id_fallback: str | None = None,
) -> BenchmarkRunStatusResponse | None:
    run_id = str(record.get("run_id") or run_id_fallback or "").strip()
    if not run_id:
        return None

    artifact_id = record.get("artifact_id")
    artifact = (
        str(artifact_id).strip() if isinstance(artifact_id, str) and artifact_id.strip() else None
    )
    error = record.get("error")
    error_text = str(error).strip() if error is not None else None
    request_payload = record.get("request") if isinstance(record.get("request"), dict) else None
    request_record = _stored_benchmark_request(request_payload)

    model_costs = record.get("model_estimated_costs_usd")
    if not isinstance(model_costs, dict):
        model_costs = {}

    cost = BenchmarkCostEstimateResponse(
        estimated_cost_usd=_safe_float(record.get("estimated_cost_usd"), default=0.0) or None,
        model_estimated_costs_usd={
            str(model): round(_safe_float(value), 8)
            for model, value in model_costs.items()
            if str(model).strip() and _safe_float(value) > 0
        },
        pricing_version=(
            str(record.get("pricing_version")).strip() if record.get("pricing_version") else None
        ),
        estimated_at=(
            _parse_timestamp(record.get("cost_estimated_at"))
            if record.get("cost_estimated_at")
            else None
        ),
        estimation_mode=(
            str(record.get("estimation_mode")).strip() if record.get("estimation_mode") else None
        ),
        pricing_sources=(
            {
                str(model): str(source)
                for model, source in record.get("pricing_sources", {}).items()
                if str(model).strip() and str(source).strip()
            }
            if isinstance(record.get("pricing_sources"), dict)
            else {}
        ),
    )

    agent_count = _safe_positive_int(record.get("agent_count"))
    if agent_count is None and request_record is not None:
        agent_count = request_record.agent_count

    return BenchmarkRunStatusResponse(
        run_id=run_id,
        status=_run_status(str(record.get("status") or "failed")),
        created_at=_parse_timestamp(record.get("created_at")),
        updated_at=_parse_timestamp(record.get("updated_at") or record.get("created_at")),
        error=error_text,
        artifact_id=artifact,
        request=request_record,
        reasoning_presets=(
            request_record.reasoning_presets
            if request_record is not None
            else resolve_reasoning_presets(
                request_payload.get("reasoning_presets") if isinstance(request_payload, dict) else None
            )
        ),
        tier_model_overrides=(
            request_record.tier_model_overrides if request_record is not None else None
        ),
        latest_mechanism=(
            str(record.get("latest_mechanism")).strip() if record.get("latest_mechanism") else None
        ),
        agent_count=agent_count,
        total_tokens=(_safe_int(record.get("total_tokens"), default=0) or None),
        thinking_tokens=(_safe_int(record.get("thinking_tokens"), default=0) or None),
        total_latency_ms=(_safe_float(record.get("total_latency_ms")) or None),
        model_telemetry=_model_telemetry_from_record(record),
        cost=cost,
        completed_item_count=_safe_int(record.get("completed_item_count")),
        failed_item_count=_safe_int(record.get("failed_item_count")),
        degraded_item_count=_safe_int(record.get("degraded_item_count")),
        failure_counts_by_category=(
            {
                str(category): _safe_int(count)
                for category, count in record.get("failure_counts_by_category", {}).items()
                if str(category).strip() and _safe_int(count) > 0
            }
            if isinstance(record.get("failure_counts_by_category"), dict)
            else {}
        ),
        failure_counts_by_reason=(
            {
                str(reason): _safe_int(count)
                for reason, count in record.get("failure_counts_by_reason", {}).items()
                if str(reason).strip() and _safe_int(count) > 0
            }
            if isinstance(record.get("failure_counts_by_reason"), dict)
            else {}
        ),
        failure_counts_by_stage=(
            {
                str(stage): _safe_int(count)
                for stage, count in record.get("failure_counts_by_stage", {}).items()
                if str(stage).strip() and _safe_int(count) > 0
            }
            if isinstance(record.get("failure_counts_by_stage"), dict)
            else {}
        ),
    )


def _test_frequency_score(record: dict[str, Any]) -> int:
    raw_score = record.get("frequency_score")
    if isinstance(raw_score, int):
        return max(raw_score, 0)
    if isinstance(raw_score, float):
        return max(int(raw_score), 0)

    score = 0
    for key in ("mechanism_counts", "model_counts"):
        value = record.get(key)
        if not isinstance(value, dict):
            continue
        for count in value.values():
            if isinstance(count, int):
                score += max(count, 0)
            elif isinstance(count, float):
                score += max(int(count), 0)
    return score


def _legacy_artifact_id(path: Path) -> str:
    candidate = _LEGACY_ARTIFACT_RE.sub("-", path.stem.lower()).strip("-.")
    if not candidate:
        candidate = hashlib.sha256(path.name.encode("utf-8")).hexdigest()[:16]
    artifact_id = f"local-{candidate}"[:120]
    try:
        validate_storage_id(artifact_id, field_name="artifact_id")
    except ValueError:
        artifact_id = f"local-{hashlib.sha256(path.name.encode('utf-8')).hexdigest()[:24]}"
    return artifact_id


def _legacy_artifact_document(
    path: Path,
    payload: dict[str, Any],
    artifact_id: str,
) -> dict[str, Any]:
    created_at = payload.get("generated_at")
    if not isinstance(created_at, str) or not created_at.strip():
        created_at = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat()

    return {
        "artifact_id": artifact_id,
        "scope": "global",
        "source": (
            "local_backfill"
            if _is_current_runtime_benchmark_payload(payload)
            else "legacy_backfill"
        ),
        "status": "completed",
        "created_at": created_at,
        "benchmark_payload": payload,
    }


async def _maybe_backfill_legacy_benchmarks() -> None:
    global _legacy_backfill_complete
    if _legacy_backfill_complete:
        return

    lock = _get_legacy_backfill_lock()
    async with lock:
        if _legacy_backfill_complete:
            return

        store = get_task_store()
        existing = await store.list_global_benchmark_artifacts(limit=500)
        existing_ids = {
            str(item.get("artifact_id"))
            for item in existing
            if isinstance(item, dict) and item.get("artifact_id")
        }

        for path in sorted(
            _RESULTS_DIR.glob("*.json"),
            key=lambda candidate: candidate.stat().st_mtime,
        ):
            payload = _load_json_payload(path)
            if payload is None:
                continue

            artifact_id = _legacy_artifact_id(path)
            if artifact_id in existing_ids:
                continue

            await store.save_global_benchmark_artifact(
                artifact_id,
                _legacy_artifact_document(path, payload, artifact_id),
            )
            existing_ids.add(artifact_id)

        _legacy_backfill_complete = True


def _build_run_id(workspace_id: str) -> str:
    payload = f"{workspace_id}:{datetime.now(UTC).isoformat()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


async def _persist_and_emit_benchmark_event(
    *,
    store: Any,
    stream: DeliberationStream,
    workspace_id: str,
    run_id: str,
    event_type: str,
    event_data: dict[str, Any],
    journal: BufferedEventJournal | None = None,
) -> None:
    payload = _benchmark_event_payload(event_type, event_data)
    if journal is not None:
        await journal.publish(
            payload,
            buffered=event_type in _BUFFERED_BENCHMARK_EVENT_TYPES,
        )
        return
    await store.append_user_test_event(workspace_id, run_id, payload)
    await stream.emit(_benchmark_stream_key(workspace_id, run_id), payload)


async def _offline_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
    """Deterministic schema-aware agent for reproducible offline benchmark runs."""

    lowered = user_prompt.lower()
    if "capital of france" in lowered:
        answer = "Paris"
    elif "solana" in lowered and "btc" in lowered:
        answer = "BTC"
    elif "derivative" in lowered and "x^3" in lowered:
        answer = "3x^2"
    elif "2+2" in lowered:
        answer = "4"
    else:
        task_line = next(
            (
                line.split(":", maxsplit=1)[1].strip()
                for line in user_prompt.splitlines()
                if line.lower().startswith("task:")
            ),
            user_prompt.strip(),
        )
        answer = f"Lowest-risk answer satisfying: {task_line[:140] or 'benchmark task'}"

    role = system_prompt.lower()
    if "devil's advocate" in role:
        return {
            "analyses": [
                {
                    "faction": "pro",
                    "weakest_claim": "offline pro benchmark claim",
                    "flaw": "The claim must identify the task constraint it optimizes.",
                    "attack_axis": "constraint_fit",
                    "counterexample": "A valid answer that satisfies more explicit constraints.",
                    "failure_mode": "The pro answer can be plausible but under-specified.",
                    "question": (
                        "Which explicit task constraint does the pro answer satisfy better "
                        "than the strongest alternative?"
                    ),
                },
                {
                    "faction": "opp",
                    "weakest_claim": "offline opp benchmark claim",
                    "flaw": "The claim must name the assumption that makes it preferable.",
                    "attack_axis": "hidden_assumption",
                    "counterexample": "A boundary condition where the assumption is false.",
                    "failure_mode": "The opp answer can win only by smuggling an unstated premise.",
                    "question": (
                        "Which assumption would have to be true for the opp answer to beat "
                        "the pro answer on the benchmark prompt?"
                    ),
                },
            ]
        }

    if "debate opening" in role:
        return {
            "claim": answer,
            "evidence": (
                "Offline benchmark evidence: this answer is selected because it directly "
                "matches the explicit benchmark prompt constraints."
            ),
            "confidence": 0.84,
        }

    if "debate rebuttal" in role:
        return {
            "answer": answer,
            "defense": (
                "Offline benchmark rebuttal: answer the targeted critique by checking it "
                "against the prompt constraints, then revise only if it breaks a named constraint."
            ),
            "confidence": 0.84,
        }

    if "debate synthesis" in role:
        return {
            "final_answer": answer,
            "confidence": 0.84,
            "summary": "Offline benchmark synthesis selected the constraint-matching answer.",
        }

    return {
        "answer": answer,
        "confidence": 0.84,
        "predicted_group_answer": answer,
        "reasoning": "Deterministic benchmark fallback agent.",
    }


async def _execute_benchmark_run(
    *,
    workspace_id: str,
    run_id: str,
    request: BenchmarkRunRequest,
) -> None:
    store = get_task_store()
    stream = get_stream_manager()
    backend = get_coordination_backend()
    run_key = _benchmark_run_key(workspace_id, run_id)
    lease = await backend.acquire_run_lock(
        run_key,
        ttl_seconds=settings.task_run_lock_ttl_seconds,
    )
    if lease is None:
        logger.info(
            "benchmark_run_already_active",
            workspace_id=workspace_id,
            run_id=run_id,
            run_key=run_key,
        )
        return

    heartbeat_stop = asyncio.Event()
    current_lease = lease
    lease_lost = False
    run_lock_released = False

    async def _run_lock_heartbeat() -> None:
        nonlocal current_lease, lease_lost
        interval_seconds = max(1.0, min(30.0, settings.task_run_lock_ttl_seconds / 3))
        while True:
            try:
                await asyncio.wait_for(heartbeat_stop.wait(), timeout=interval_seconds)
                return
            except TimeoutError:
                refreshed = await backend.refresh_run_lock(
                    run_key,
                    lease_id=current_lease.lease_id,
                    ttl_seconds=settings.task_run_lock_ttl_seconds,
                )
                if refreshed is None:
                    lease_lost = True
                    logger.error(
                        "benchmark_run_lock_lost",
                        workspace_id=workspace_id,
                        run_id=run_id,
                        run_key=run_key,
                    )
                    heartbeat_stop.set()
                    return
                current_lease = refreshed

    heartbeat_task = asyncio.create_task(_run_lock_heartbeat())

    async def _release_run_lock_once() -> None:
        nonlocal run_lock_released
        if run_lock_released:
            return
        heartbeat_stop.set()
        with suppress(asyncio.CancelledError, Exception):
            await heartbeat_task
        await backend.release_run_lock(run_key, lease_id=current_lease.lease_id)
        run_lock_released = True

    updated_at = datetime.now(UTC).isoformat()
    reasoning_presets = resolve_reasoning_presets(request.reasoning_presets)
    resolved_domain_prompts = _resolved_domain_prompts(request)
    tier_model_overrides = normalize_tier_model_overrides(
        request.tier_model_overrides.present() if request.tier_model_overrides else None
    )

    running_record = await store.get_user_test_result(workspace_id, run_id) or {}
    running_record.update(
        {
            "run_id": run_id,
            "workspace_id": workspace_id,
            "kind": "benchmark",
            "status": "running",
            "request": {
                **request.model_dump(mode="json"),
                "reasoning_presets": reasoning_presets.model_dump(mode="json"),
                "resolved_domain_prompts": resolved_domain_prompts,
                "tier_model_overrides": tier_model_overrides or None,
            },
            "updated_at": updated_at,
        }
    )
    await store.save_user_test_result(workspace_id, run_id, running_record)
    await _persist_and_emit_benchmark_event(
        store=store,
        stream=stream,
        workspace_id=workspace_id,
        run_id=run_id,
        event_type="started",
        event_data={"run_id": run_id, "status": "running"},
    )

    event_journal = BufferedEventJournal(
        emit=lambda payload: stream.emit(_benchmark_stream_key(workspace_id, run_id), payload),
        append_many=lambda payloads: store.append_user_test_events(workspace_id, run_id, payloads),
        flush_interval_seconds=_STREAM_BUFFER_FLUSH_INTERVAL_SECONDS,
        max_buffered_events=_STREAM_BUFFER_MAX_EVENTS,
    )
    running_record_state = running_record
    state_writer = BufferedStateWriter(
        save=lambda snapshot: store.save_user_test_result(workspace_id, run_id, snapshot),
        snapshot=lambda: dict(running_record_state),
        flush_interval_seconds=_STREAM_BUFFER_FLUSH_INTERVAL_SECONDS,
    )

    try:
        training_tasks, holdout_tasks = BenchmarkRunner.build_phase2_task_split(
            training_per_category=request.training_per_category,
            holdout_per_category=request.holdout_per_category,
        )
        training_tasks = _apply_domain_prompts(training_tasks, resolved_domain_prompts)
        holdout_tasks = _apply_domain_prompts(holdout_tasks, resolved_domain_prompts)

        orchestrator = AgoraOrchestrator(
            agent_count=request.agent_count,
            allow_offline_fallback=True,
            reasoning_presets=reasoning_presets,
            tier_model_overrides=tier_model_overrides,
        )
        selector_state = await store.get_runtime_state(_SELECTOR_BANDIT_STATE_KEY)
        if selector_state is not None:
            orchestrator.selector.bandit.load_state_payload(selector_state)
        agents = None if request.live_agents else [_offline_agent] * request.agent_count
        seed = None if request.live_agents else request.seed
        runner = BenchmarkRunner(orchestrator, agents=agents)

        async def emit_progress(event_type: str, event_data: dict[str, Any]) -> None:
            if lease_lost:
                raise RuntimeError("Benchmark execution lease lost")
            running_record_state.update(
                {
                    "run_id": run_id,
                    "workspace_id": workspace_id,
                    "kind": "benchmark",
                    "status": "running",
                    "updated_at": datetime.now(UTC).isoformat(),
                }
            )
            telemetry = event_data.get("telemetry")
            if isinstance(telemetry, dict):
                running_record_state["latest_mechanism"] = event_data.get("latest_mechanism")
                running_record_state["agent_count"] = _first_positive_int(
                    telemetry.get("agent_count"),
                    request.agent_count,
                )
                running_record_state["total_tokens"] = telemetry.get("total_tokens")
                running_record_state["thinking_tokens"] = telemetry.get("thinking_tokens")
                running_record_state["total_latency_ms"] = telemetry.get("total_latency_ms")
                running_record_state["model_token_usage"] = telemetry.get("model_token_usage", {})
                running_record_state["model_telemetry"] = telemetry.get("model_telemetry", {})
                running_record_state["estimated_cost_usd"] = telemetry.get("cost", {}).get(
                    "estimated_cost_usd"
                )
                running_record_state["model_estimated_costs_usd"] = telemetry.get("cost", {}).get(
                    "model_estimated_costs_usd",
                    {},
                )
                running_record_state["pricing_version"] = telemetry.get("cost", {}).get("pricing_version")
                running_record_state["cost_estimated_at"] = telemetry.get("cost", {}).get("estimated_at")
                running_record_state["estimation_mode"] = telemetry.get("cost", {}).get("estimation_mode")
                running_record_state["pricing_sources"] = telemetry.get("cost", {}).get(
                    "pricing_sources",
                    {},
                )
            await state_writer.mark_dirty()
            await _persist_and_emit_benchmark_event(
                store=store,
                stream=stream,
                workspace_id=workspace_id,
                run_id=run_id,
                event_type=event_type,
                event_data=event_data,
                journal=event_journal,
            )

        async def emit_live_event(event_type: str, event_data: dict[str, Any]) -> None:
            if lease_lost:
                raise RuntimeError("Benchmark execution lease lost")
            await _persist_and_emit_benchmark_event(
                store=store,
                stream=stream,
                workspace_id=workspace_id,
                run_id=run_id,
                event_type=event_type,
                event_data=event_data,
                journal=event_journal,
            )

        output_path = _RESULTS_DIR / f"user_benchmark_{run_id}.json"
        payload = await runner.run_phase2_validation(
            training_tasks=training_tasks,
            holdout_tasks=holdout_tasks,
            output_path=str(output_path),
            seed=seed,
            progress_callback=emit_progress,
            event_sink=emit_live_event,
        )
        await store.save_runtime_state(
            _SELECTOR_BANDIT_STATE_KEY,
            orchestrator.selector.bandit.to_state(),
        )
        await event_journal.flush()
        await state_writer.flush()
        payload = _with_complete_summary(payload)
        await store.save_benchmark_summary(payload)
        payload["benchmark_config"] = {
            "training_per_category": request.training_per_category,
            "holdout_per_category": request.holdout_per_category,
            "agent_count": request.agent_count,
            "live_agents": request.live_agents,
            "seed": request.seed,
            "reasoning_presets": reasoning_presets.model_dump(mode="json"),
            "domain_prompts": resolved_domain_prompts,
            "tier_model_overrides": tier_model_overrides or None,
        }
        telemetry = _artifact_telemetry(payload)
        benchmark_config = {
            "training_per_category": request.training_per_category,
            "holdout_per_category": request.holdout_per_category,
            "agent_count": request.agent_count,
            "live_agents": request.live_agents,
            "seed": request.seed,
            "reasoning_presets": reasoning_presets.model_dump(mode="json"),
            "domain_prompts": resolved_domain_prompts,
            "tier_model_overrides": tier_model_overrides or None,
        }
        payload["benchmark_config"] = benchmark_config

        benchmark_agent_count = _first_positive_int(telemetry.get("agent_count"), request.agent_count)
        persisted_record = await store.get_user_test_result(workspace_id, run_id) or running_record_state
        benchmark_items, active_item_id, failure_counts_by_stage = _benchmark_items_from_payload(
            benchmark_id=run_id,
            payload=payload,
            run_record=persisted_record,
        )

        created_at = datetime.now(UTC).isoformat()
        artifact_document = {
            "artifact_id": run_id,
            "scope": "global",
            "source": "user_triggered",
            "status": "completed",
            "owner_user_id": workspace_id,
            "created_at": created_at,
            "benchmark_payload": payload,
            "completed_item_count": telemetry["completed_item_count"],
            "failed_item_count": telemetry["failed_item_count"],
            "degraded_item_count": telemetry["degraded_item_count"],
            "failure_counts_by_category": telemetry["failure_counts_by_category"],
            "failure_counts_by_reason": telemetry["failure_counts_by_reason"],
            "failure_counts_by_stage": failure_counts_by_stage,
            "latest_mechanism": telemetry["latest_mechanism"],
            "agent_count": benchmark_agent_count,
            "total_tokens": telemetry["total_tokens"],
            "thinking_tokens": telemetry["thinking_tokens"],
            "total_latency_ms": telemetry["total_latency_ms"],
            "models": telemetry["models"],
            "model_telemetry": {
                model: data.model_dump(mode="json")
                for model, data in telemetry["model_telemetry"].items()
            },
            "cost": telemetry["cost"].model_dump(mode="json") if telemetry["cost"] else None,
            "benchmark_items": [item.model_dump(mode="json") for item in benchmark_items],
            "active_item_id": active_item_id,
        }

        user_artifact_document = dict(artifact_document)
        user_artifact_document["scope"] = "user"

        await store.save_global_benchmark_artifact(run_id, artifact_document)
        await store.save_user_benchmark_artifact(workspace_id, run_id, user_artifact_document)

        completed_at = datetime.now(UTC).isoformat()
        completed_record = running_record_state
        completed_record.update(
            {
                "run_id": run_id,
                "workspace_id": workspace_id,
                "kind": "benchmark",
                "status": "completed",
                "artifact_id": run_id,
                "request": {
                    **request.model_dump(mode="json"),
                    "reasoning_presets": reasoning_presets.model_dump(mode="json"),
                    "resolved_domain_prompts": resolved_domain_prompts,
                    "tier_model_overrides": tier_model_overrides or None,
                },
                "mechanism_counts": telemetry["mechanism_counts"],
                "model_counts": telemetry["model_counts"],
                "frequency_score": telemetry["frequency_score"],
                "completed_item_count": telemetry["completed_item_count"],
                "failed_item_count": telemetry["failed_item_count"],
                "degraded_item_count": telemetry["degraded_item_count"],
                "failure_counts_by_category": telemetry["failure_counts_by_category"],
                "failure_counts_by_reason": telemetry["failure_counts_by_reason"],
                "failure_counts_by_stage": failure_counts_by_stage,
                "latest_mechanism": telemetry["latest_mechanism"],
                "agent_count": benchmark_agent_count,
                "total_tokens": telemetry["total_tokens"],
                "thinking_tokens": telemetry["thinking_tokens"],
                "total_latency_ms": telemetry["total_latency_ms"],
                "model_token_usage": telemetry["model_token_usage"],
                "model_telemetry": {
                    model: data.model_dump(mode="json")
                    for model, data in telemetry["model_telemetry"].items()
                },
                "estimated_cost_usd": (
                    telemetry["cost"].estimated_cost_usd if telemetry["cost"] else None
                ),
                "model_estimated_costs_usd": (
                    telemetry["cost"].model_estimated_costs_usd if telemetry["cost"] else {}
                ),
                "pricing_version": telemetry["cost"].pricing_version if telemetry["cost"] else None,
                "cost_estimated_at": (
                    telemetry["cost"].estimated_at.isoformat()
                    if telemetry["cost"] and telemetry["cost"].estimated_at
                    else None
                ),
                "estimation_mode": telemetry["cost"].estimation_mode if telemetry["cost"] else None,
                "pricing_sources": (
                    telemetry["cost"].pricing_sources if telemetry["cost"] else {}
                ),
                "benchmark_items": [
                    item.model_dump(mode="json")
                    for item in benchmark_items
                ],
                "active_item_id": active_item_id,
                "updated_at": completed_at,
            }
        )
        await store.save_user_test_result(workspace_id, run_id, completed_record)
        await _persist_and_emit_benchmark_event(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            run_id=run_id,
            event_type="artifact_created",
            event_data={"run_id": run_id, "artifact_id": run_id, "telemetry": completed_record},
            journal=event_journal,
        )
        await _persist_and_emit_benchmark_event(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            run_id=run_id,
            event_type="complete",
            event_data={"run_id": run_id, "artifact_id": run_id, "status": "completed"},
            journal=event_journal,
        )
        await event_journal.close()
        await state_writer.close()
        await _release_run_lock_once()
        await stream.close(_benchmark_stream_key(workspace_id, run_id))
    except Exception as exc:
        failed_at = datetime.now(UTC).isoformat()
        await event_journal.close()
        await state_writer.close()
        failed_record = running_record_state
        persisted_record = await store.get_user_test_result(workspace_id, run_id) or failed_record
        benchmark_items, active_item_id, failure_counts_by_stage = _benchmark_items_from_payload(
            benchmark_id=run_id,
            payload={},
            run_record=persisted_record,
        )
        failed_record.update(
            {
                "run_id": run_id,
                "workspace_id": workspace_id,
                "kind": "benchmark",
                "status": "failed",
                "error": str(exc)[:1000],
                "failed_item_count": max(1, len([item for item in benchmark_items if item.status == "failed"])),
                "degraded_item_count": len([item for item in benchmark_items if item.status == "degraded"]),
                "failure_counts_by_stage": failure_counts_by_stage,
                "benchmark_items": [item.model_dump(mode="json") for item in benchmark_items],
                "active_item_id": active_item_id,
                "updated_at": failed_at,
            }
        )
        await store.save_user_test_result(workspace_id, run_id, failed_record)
        await _persist_and_emit_benchmark_event(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            run_id=run_id,
            event_type="failed",
            event_data={
                "run_id": run_id,
                "message": str(exc)[:1000],
                "item_id": active_item_id,
                "item_status": "failed",
                "stage": next(iter(failure_counts_by_stage.keys()), None),
            },
        )
        await _release_run_lock_once()
        await stream.close(_benchmark_stream_key(workspace_id, run_id))


async def _optional_current_user(
    credentials: OptionalBearerCredentials,
) -> AuthenticatedUser | None:
    if credentials is None:
        return None
    return await get_current_user(credentials)


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
OptionalCurrentUser = Annotated[
    AuthenticatedUser | None,
    Depends(_optional_current_user),
]


def _require_benchmark_scope(user: AuthenticatedUser, access: Literal["read", "write"]) -> None:
    """Authorize benchmarks with new scopes while honoring existing task API keys."""

    if f"benchmarks:{access}" in user.scopes or f"tasks:{access}" in user.scopes:
        return
    require_scope(user, f"benchmarks:{access}")


@router.get("/benchmarks")
async def get_benchmarks(
    user: OptionalCurrentUser,
    x_agora_admin_token: str | None = Header(default=None),
    include_demo: bool = Query(default=False),
    aggregate: bool = Query(default=False),
    aggregate_window: Literal["recent_20", "all"] = Query(default="recent_20"),
) -> dict[str, Any]:
    """Return the latest persisted benchmark summary."""

    has_admin_secret = bool(settings.benchmark_admin_token)
    admin_granted = has_admin_secret and x_agora_admin_token == settings.benchmark_admin_token

    if not admin_granted:
        if user is None:
            raise HTTPException(status_code=403, detail="Benchmark access denied")
        _require_benchmark_scope(user, "read")

    if aggregate:
        aggregate_limit = None if aggregate_window == "all" else _AGGREGATE_BENCHMARK_DEFAULT_LIMIT
        payload = await _resolve_aggregate_benchmark_summary_payload(
            user,
            limit=aggregate_limit,
        )
    else:
        payload = await _resolve_benchmark_summary_payload()
    if payload is None:
        raise HTTPException(status_code=404, detail="Benchmark summary is not available yet")

    if not include_demo:
        return payload

    demo_path = _latest_demo_results_path()
    if demo_path is None:
        return payload

    demo_payload = _load_json_payload(demo_path)
    if demo_payload is None:
        return payload

    enriched_payload = dict(payload)
    enriched_payload["demo_report"] = _build_demo_report(demo_payload, demo_path.name)

    if not _payload_has_any_runs(enriched_payload):
        demo_runs = _synthesize_demo_runs(demo_payload)
        if demo_runs:
            enriched_payload["runs"] = demo_runs

    if "summary" not in enriched_payload:
        run_summary = _as_dict(demo_payload.get("run_summary"))
        per_mode = run_summary.get("per_mode")
        per_category = run_summary.get("per_category")
        if isinstance(per_mode, dict) and isinstance(per_category, dict):
            enriched_payload["summary"] = {
                "per_mode": per_mode,
                "per_category": per_category,
            }

    return _with_complete_summary(enriched_payload)


@router.get("/benchmarks/catalog", response_model=BenchmarkCatalogResponse)
async def get_benchmark_catalog(
    user: CurrentUser,
    limit: int = Query(default=25, ge=1, le=100),
) -> BenchmarkCatalogResponse:
    """Return global and user benchmark catalog views sorted by recency and frequency."""

    await _maybe_backfill_legacy_benchmarks()
    store = get_task_store()

    global_artifacts = await store.list_global_benchmark_artifacts(limit=limit)
    global_entries = [
        entry
        for artifact in global_artifacts
        if isinstance(artifact, dict) and _is_catalog_eligible_artifact(artifact)
        for entry in [_to_catalog_entry(artifact, default_scope="global")]
        if entry is not None
    ]

    user_entries: list[BenchmarkCatalogEntry] = []
    tests_recent: list[BenchmarkRunStatusResponse] = []
    tests_frequency: list[BenchmarkRunStatusResponse] = []

    _require_benchmark_scope(user, "read")
    user_artifacts = await store.list_user_benchmark_artifacts(user.workspace_id, limit=limit)
    user_entries = [
        entry
        for artifact in user_artifacts
        if isinstance(artifact, dict) and _is_catalog_eligible_artifact(artifact)
        for entry in [_to_catalog_entry(artifact, default_scope="user")]
        if entry is not None
    ]

    test_records = await store.list_user_test_results(user.workspace_id, limit=limit)
    status_pairs = [
        (status, _test_frequency_score(record))
        for record in test_records
        if isinstance(record, dict)
        for status in [_to_run_status(record)]
        if status is not None
    ]

    tests_recent = [
        status
        for status, _score in sorted(
            status_pairs,
            key=lambda pair: pair[0].updated_at,
            reverse=True,
        )
    ]
    tests_frequency = [
        status
        for status, score in sorted(
            status_pairs,
            key=lambda pair: (pair[1], pair[0].updated_at),
            reverse=True,
        )
        if score > 0
    ]

    global_recent = sorted(global_entries, key=lambda entry: entry.created_at, reverse=True)
    global_frequency = sorted(
        global_entries,
        key=lambda entry: (entry.frequency_score, entry.run_count, entry.created_at),
        reverse=True,
    )
    user_recent = sorted(user_entries, key=lambda entry: entry.created_at, reverse=True)
    user_frequency = sorted(
        user_entries,
        key=lambda entry: (entry.frequency_score, entry.run_count, entry.created_at),
        reverse=True,
    )

    return BenchmarkCatalogResponse(
        global_recent=global_recent,
        global_frequency=global_frequency,
        user_recent=user_recent,
        user_frequency=user_frequency,
        user_tests_recent=tests_recent,
        user_tests_frequency=tests_frequency,
    )


@router.get("/benchmarks/prompt-templates", response_model=BenchmarkPromptTemplatesResponse)
async def get_benchmark_prompt_templates(
    user: CurrentUser,
) -> BenchmarkPromptTemplatesResponse:
    """Return benchmark question templates grouped by domain for the run wizard."""

    _require_benchmark_scope(user, "read")

    return _domain_prompt_templates_response()


@router.get("/benchmarks/runtime-config", response_model=DeliberationRuntimeConfigResponse)
async def get_benchmark_runtime_config(
    user: CurrentUser,
) -> DeliberationRuntimeConfigResponse:
    """Return frontend-safe runtime model defaults and catalog metadata."""

    _require_benchmark_scope(user, "read")

    return _deliberation_runtime_config_response()


async def _resolve_benchmark_detail(
    *,
    benchmark_id: str,
    user: AuthenticatedUser,
) -> BenchmarkDetailResponse:
    try:
        validate_storage_id(benchmark_id, field_name="benchmark_id")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await _maybe_backfill_legacy_benchmarks()
    store = get_task_store()

    _require_benchmark_scope(user, "read")

    run_record = await store.get_user_test_result(user.workspace_id, benchmark_id)
    if run_record is None:
        user_test_records = await store.list_user_test_results(user.workspace_id, limit=500)
        run_record = next(
            (
                record
                for record in user_test_records
                if isinstance(record, dict)
                and str(record.get("artifact_id") or "").strip() == benchmark_id
            ),
            None,
        )
    run_record_artifact_id = (
        str(run_record.get("artifact_id")).strip()
        if isinstance(run_record, dict) and isinstance(run_record.get("artifact_id"), str)
        else ""
    )

    candidate_ids: list[str] = [benchmark_id]
    if run_record_artifact_id and run_record_artifact_id not in candidate_ids:
        candidate_ids.append(run_record_artifact_id)

    for candidate_id in candidate_ids:
        user_artifact = await store.get_user_benchmark_artifact(user.workspace_id, candidate_id)
        if user_artifact is not None:
            return _build_benchmark_detail_response(
                benchmark_id=benchmark_id,
                scope="user",
                artifact=user_artifact,
                run_record=run_record,
            )

    user_artifacts = await store.list_user_benchmark_artifacts(user.workspace_id, limit=500)
    matched_user_artifact = _find_artifact_by_identifier(user_artifacts, benchmark_id)
    if matched_user_artifact is None and run_record_artifact_id:
        matched_user_artifact = _find_artifact_by_identifier(user_artifacts, run_record_artifact_id)
    if matched_user_artifact is not None:
        return _build_benchmark_detail_response(
            benchmark_id=benchmark_id,
            scope="user",
            artifact=matched_user_artifact,
            run_record=run_record,
        )

    for candidate_id in candidate_ids:
        global_artifact = await store.get_global_benchmark_artifact(candidate_id)
        if global_artifact is not None:
            return _build_benchmark_detail_response(
                benchmark_id=benchmark_id,
                scope="global",
                artifact=global_artifact,
                run_record=run_record,
            )

    global_artifacts = await store.list_global_benchmark_artifacts(limit=500)
    matched_global_artifact = _find_artifact_by_identifier(global_artifacts, benchmark_id)
    if matched_global_artifact is None and run_record_artifact_id:
        matched_global_artifact = _find_artifact_by_identifier(
            global_artifacts, run_record_artifact_id
        )
    if matched_global_artifact is not None:
        return _build_benchmark_detail_response(
            benchmark_id=benchmark_id,
            scope="global",
            artifact=matched_global_artifact,
            run_record=run_record,
        )

    if run_record is not None:
        return _build_benchmark_detail_response(
            benchmark_id=benchmark_id,
            scope="user",
            artifact=None,
            run_record=run_record,
        )

    raise HTTPException(status_code=404, detail="Benchmark not found")


@router.get("/benchmarks/{benchmark_id}/items/{item_id}", response_model=BenchmarkItemResponse)
async def get_benchmark_item(
    benchmark_id: str,
    item_id: str,
    user: CurrentUser,
) -> BenchmarkItemResponse:
    """Return one item-scoped slice of a benchmark run."""

    detail = await _resolve_benchmark_detail(benchmark_id=benchmark_id, user=user)
    for item in detail.benchmark_items:
        if item.item_id == item_id:
            return item
    raise HTTPException(status_code=404, detail="Benchmark item not found")


@router.get(
    "/benchmarks/{benchmark_id}/items/{item_id}/events",
    response_model=BenchmarkItemEventsResponse,
)
async def get_benchmark_item_events(
    benchmark_id: str,
    item_id: str,
    user: CurrentUser,
) -> BenchmarkItemEventsResponse:
    """Replay persisted events for one benchmark item."""

    detail = await _resolve_benchmark_detail(benchmark_id=benchmark_id, user=user)
    for item in detail.benchmark_items:
        if item.item_id == item_id:
            return BenchmarkItemEventsResponse(
                benchmark_id=detail.benchmark_id,
                item_id=item_id,
                events=item.events,
            )
    raise HTTPException(status_code=404, detail="Benchmark item not found")


@router.get("/benchmarks/{benchmark_id}", response_model=BenchmarkDetailResponse)
async def get_benchmark_detail(
    benchmark_id: str,
    user: CurrentUser,
) -> BenchmarkDetailResponse:
    """Return a dedicated benchmark detail payload by artifact_id or run_id fallback."""

    return await _resolve_benchmark_detail(benchmark_id=benchmark_id, user=user)


@router.post("/benchmarks/run", response_model=BenchmarkRunResponse)
async def trigger_benchmark_run(
    request: BenchmarkRunRequest,
    user: CurrentUser,
) -> BenchmarkRunResponse:
    """Trigger an async benchmark run and persist status in user test records."""

    _require_benchmark_scope(user, "write")
    store = get_task_store()
    stream = get_stream_manager()
    run_id = _build_run_id(user.workspace_id)
    created_at = datetime.now(UTC)
    reasoning_presets = resolve_reasoning_presets(request.reasoning_presets)
    resolved_domain_prompts = _resolved_domain_prompts(request)
    try:
        tier_model_overrides = normalize_tier_model_overrides(
            request.tier_model_overrides.present() if request.tier_model_overrides else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    await store.save_user_test_result(
        user.workspace_id,
        run_id,
        {
            "run_id": run_id,
            "workspace_id": user.workspace_id,
            "kind": "benchmark",
            "status": "queued",
            "created_at": created_at.isoformat(),
            "updated_at": created_at.isoformat(),
            "request": {
                **request.model_dump(mode="json"),
                "reasoning_presets": reasoning_presets.model_dump(mode="json"),
                "resolved_domain_prompts": resolved_domain_prompts,
                "tier_model_overrides": tier_model_overrides or None,
            },
            "label": "User-triggered benchmark",
        },
    )
    await _persist_and_emit_benchmark_event(
        store=store,
        stream=stream,
        workspace_id=user.workspace_id,
        run_id=run_id,
        event_type="queued",
        event_data={"run_id": run_id, "status": "queued"},
    )

    _launch_background_benchmark_run(
        workspace_id=user.workspace_id,
        run_id=run_id,
        request=request,
    )

    return BenchmarkRunResponse(
        run_id=run_id,
        status="queued",
        created_at=created_at,
    )


@router.get("/benchmarks/runs/{run_id}", response_model=BenchmarkRunStatusResponse)
async def get_benchmark_run_status(
    run_id: str,
    user: CurrentUser,
) -> BenchmarkRunStatusResponse:
    """Return status for a previously triggered user benchmark run."""

    _require_benchmark_scope(user, "read")
    store = get_task_store()
    record = await store.get_user_test_result(user.workspace_id, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")

    status = _to_run_status(record, run_id_fallback=run_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    return status


@router.post("/benchmarks/runs/{run_id}/stream-ticket")
async def create_benchmark_stream_ticket(
    run_id: str,
    user: CurrentUser,
) -> dict[str, str]:
    """Issue a short-lived ticket for benchmark EventSource authentication."""

    _require_benchmark_scope(user, "read")
    store = get_task_store()
    record = await store.get_user_test_result(user.workspace_id, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    return await _issue_benchmark_stream_ticket(user.workspace_id, run_id)


@router.get("/benchmarks/runs/{run_id}/stream")
async def stream_benchmark_run(
    run_id: str,
    ticket: str = Query(...),
) -> EventSourceResponse:
    """Replay persisted benchmark events, then continue with live SSE updates."""

    stream_ticket = await _consume_benchmark_stream_ticket(ticket, run_id=run_id)
    workspace_id = stream_ticket.workspace_id
    store = get_task_store()
    stream = get_stream_manager()
    record = await store.get_user_test_result(workspace_id, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")

    async def event_generator() -> Any:
        events = await store.get_user_test_events(workspace_id, run_id)
        for event in events:
            yield _benchmark_sse_message(event)

        if any(event.get("event") in _TERMINAL_BENCHMARK_EVENT_TYPES for event in events):
            return

        stream_id = _benchmark_stream_key(workspace_id, run_id)
        queue = stream.subscribe(stream_id)
        next_event_index = len(events)

        try:
            while True:
                try:
                    item = await asyncio.wait_for(
                        queue.get(),
                        timeout=_STREAM_POLL_INTERVAL_SECONDS,
                    )
                except TimeoutError:
                    latest = await store.get_user_test_events(workspace_id, run_id)
                    if next_event_index >= len(latest):
                        continue
                    for event in latest[next_event_index:]:
                        payload = _benchmark_sse_message(event)
                        next_event_index += 1
                        yield payload
                        if payload["event"] in _TERMINAL_BENCHMARK_EVENT_TYPES:
                            return
                    continue

                if item is None:
                    break
                payload = _benchmark_sse_message(item)
                yield payload
                next_event_index += 1
                if payload["event"] in _TERMINAL_BENCHMARK_EVENT_TYPES:
                    break
        finally:
            stream.unsubscribe(stream_id, queue)

    return EventSourceResponse(
        event_generator(),
        ping=10,
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
