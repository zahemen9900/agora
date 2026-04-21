"""Benchmark summary and orchestration API endpoints."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sse_starlette.sse import EventSourceResponse

from agora.runtime.costing import build_model_telemetry, estimate_cost_for_models
from agora.runtime.model_policy import resolve_reasoning_presets
from agora.runtime.orchestrator import AgoraOrchestrator
from api.auth import AuthenticatedUser, get_current_user, require_human_user
from api.config import settings
from api.coordination import StreamTicketRecord, get_coordination_backend
from api.models import (
    BenchmarkCatalogEntry,
    BenchmarkCatalogResponse,
    BenchmarkCostEstimateResponse,
    BenchmarkDetailResponse,
    BenchmarkDomainName,
    BenchmarkPromptTemplate,
    BenchmarkPromptTemplatesResponse,
    BenchmarkRunRequest,
    BenchmarkRunResponse,
    BenchmarkRunStatusResponse,
    ModelTelemetryResponse,
    TaskEvent,
)
from api.routes.tasks import get_task_store
from api.security import validate_storage_id
from api.streaming import DeliberationStream, get_stream_manager
from benchmarks.runner import BenchmarkRunner

router = APIRouter()
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
_BENCHMARK_MECHANISMS = ("debate", "vote", "selector")

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


def _get_legacy_backfill_lock() -> asyncio.Lock:
    global _legacy_backfill_lock
    if _legacy_backfill_lock is None:
        _legacy_backfill_lock = asyncio.Lock()
    return _legacy_backfill_lock


def _benchmark_stream_key(workspace_id: str, run_id: str) -> str:
    return f"benchmark:{workspace_id}:{run_id}"


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
    return TaskEvent(
        event=event_type,
        data=event_data,
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
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "thinking_tokens": 0,
                    "latency_ms": 0.0,
                },
            )
            bucket["total_tokens"] += telemetry.total_tokens or 0
            bucket["input_tokens"] += telemetry.input_tokens or 0
            bucket["output_tokens"] += telemetry.output_tokens or 0
            bucket["thinking_tokens"] += telemetry.thinking_tokens or 0
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

    return {
        "runs": runs,
        "run_count": len(runs),
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
    raw_per_mode = _as_dict(summary.get("per_mode"))
    raw_per_mechanism = _as_dict(summary.get("per_mechanism"))
    raw_per_category = _as_dict(summary.get("per_category"))
    derived_per_mode = _as_dict(derived_summary.get("per_mode"))
    derived_per_mechanism = _as_dict(derived_summary.get("per_mechanism"))
    derived_per_category = _as_dict(derived_summary.get("per_category"))

    per_mode_complete = _merge_metric_sections(
        raw_per_mode or raw_per_mechanism,
        derived_per_mode or derived_per_mechanism,
        metric_keys=(
            "accuracy",
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
        raw_per_mechanism or raw_per_mode,
        derived_per_mechanism or derived_per_mode,
        metric_keys=(
            "accuracy",
            "avg_tokens",
            "avg_latency_ms",
            "avg_rounds",
            "switch_rate",
            "avg_thinking_tokens",
            "avg_estimated_cost_usd",
        ),
        fallback_keys=_BENCHMARK_MECHANISMS,
    )
    per_category_complete = _merge_category_sections(raw_per_category, derived_per_category)

    normalized_summary = dict(summary)
    normalized_summary["per_mode"] = per_mode_complete
    normalized_summary["per_mechanism"] = per_mechanism_complete
    normalized_summary["per_category"] = per_category_complete
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

    summary = _as_dict(payload.get("summary")) if payload else {}

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
        request=record_request,
        reasoning_presets=resolve_reasoning_presets(
            record_request.get("reasoning_presets") if isinstance(record_request, dict) else None
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
                "correct": bool(run.get("correct")),
                "tokens_used": _safe_int(run.get("tokens_used") or run.get("total_tokens_used")),
                "latency_ms": _safe_float(run.get("latency_ms")),
                "rounds": _safe_int(run.get("rounds")),
                "switches": _safe_int(run.get("switches")),
                "thinking_tokens_used": _safe_int(run.get("thinking_tokens_used")),
                "estimated_cost_usd": _safe_float(run.get("estimated_cost_usd")),
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
    if agent_count is None and isinstance(request_payload, dict):
        agent_count = _safe_positive_int(request_payload.get("agent_count"))

    return BenchmarkRunStatusResponse(
        run_id=run_id,
        status=_run_status(str(record.get("status") or "failed")),
        created_at=_parse_timestamp(record.get("created_at")),
        updated_at=_parse_timestamp(record.get("updated_at") or record.get("created_at")),
        error=error_text,
        artifact_id=artifact,
        request=request_payload,
        reasoning_presets=resolve_reasoning_presets(
            request_payload.get("reasoning_presets") if isinstance(request_payload, dict) else None
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
        "source": "local_backfill",
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
) -> None:
    payload = _benchmark_event_payload(event_type, event_data)
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
    updated_at = datetime.now(UTC).isoformat()

    running_record = await store.get_user_test_result(workspace_id, run_id) or {}
    running_record.update(
        {
            "run_id": run_id,
            "workspace_id": workspace_id,
            "kind": "benchmark",
            "status": "running",
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

    try:
        reasoning_presets = resolve_reasoning_presets(request.reasoning_presets)
        training_tasks, holdout_tasks = BenchmarkRunner.build_phase2_task_split(
            training_per_category=request.training_per_category,
            holdout_per_category=request.holdout_per_category,
        )

        resolved_domain_prompts = _resolved_domain_prompts(request)
        training_tasks = _apply_domain_prompts(training_tasks, resolved_domain_prompts)
        holdout_tasks = _apply_domain_prompts(holdout_tasks, resolved_domain_prompts)

        orchestrator = AgoraOrchestrator(
            agent_count=request.agent_count,
            allow_offline_fallback=True,
            reasoning_presets=reasoning_presets,
        )
        selector_state = await store.get_runtime_state(_SELECTOR_BANDIT_STATE_KEY)
        if selector_state is not None:
            orchestrator.selector.bandit.load_state_payload(selector_state)
        agents = None if request.live_agents else [_offline_agent] * request.agent_count
        seed = None if request.live_agents else request.seed
        runner = BenchmarkRunner(orchestrator, agents=agents)

        async def emit_progress(event_type: str, event_data: dict[str, Any]) -> None:
            current = await store.get_user_test_result(workspace_id, run_id) or {}
            current.update(
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
                current["latest_mechanism"] = event_data.get("latest_mechanism")
                current["agent_count"] = _first_positive_int(
                    telemetry.get("agent_count"),
                    request.agent_count,
                )
                current["total_tokens"] = telemetry.get("total_tokens")
                current["thinking_tokens"] = telemetry.get("thinking_tokens")
                current["total_latency_ms"] = telemetry.get("total_latency_ms")
                current["model_token_usage"] = telemetry.get("model_token_usage", {})
                current["model_telemetry"] = telemetry.get("model_telemetry", {})
                current["estimated_cost_usd"] = telemetry.get("cost", {}).get("estimated_cost_usd")
                current["model_estimated_costs_usd"] = telemetry.get("cost", {}).get(
                    "model_estimated_costs_usd",
                    {},
                )
                current["pricing_version"] = telemetry.get("cost", {}).get("pricing_version")
                current["cost_estimated_at"] = telemetry.get("cost", {}).get("estimated_at")
                current["estimation_mode"] = telemetry.get("cost", {}).get("estimation_mode")
                current["pricing_sources"] = telemetry.get("cost", {}).get("pricing_sources", {})
            await store.save_user_test_result(workspace_id, run_id, current)
            await _persist_and_emit_benchmark_event(
                store=store,
                stream=stream,
                workspace_id=workspace_id,
                run_id=run_id,
                event_type=event_type,
                event_data=event_data,
            )

        output_path = _RESULTS_DIR / f"user_benchmark_{run_id}.json"
        payload = await runner.run_phase2_validation(
            training_tasks=training_tasks,
            holdout_tasks=holdout_tasks,
            output_path=str(output_path),
            seed=seed,
            progress_callback=emit_progress,
        )
        await store.save_runtime_state(
            _SELECTOR_BANDIT_STATE_KEY,
            orchestrator.selector.bandit.to_state(),
        )
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
        }
        payload["benchmark_config"] = benchmark_config

        benchmark_agent_count = _first_positive_int(telemetry.get("agent_count"), request.agent_count)

        created_at = datetime.now(UTC).isoformat()
        artifact_document = {
            "artifact_id": run_id,
            "scope": "global",
            "source": "user_triggered",
            "status": "completed",
            "owner_user_id": workspace_id,
            "created_at": created_at,
            "benchmark_payload": payload,
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
        }

        user_artifact_document = dict(artifact_document)
        user_artifact_document["scope"] = "user"

        await store.save_global_benchmark_artifact(run_id, artifact_document)
        await store.save_user_benchmark_artifact(workspace_id, run_id, user_artifact_document)

        completed_at = datetime.now(UTC).isoformat()
        completed_record = await store.get_user_test_result(workspace_id, run_id) or {}
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
                },
                "mechanism_counts": telemetry["mechanism_counts"],
                "model_counts": telemetry["model_counts"],
                "frequency_score": telemetry["frequency_score"],
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
        )
        await _persist_and_emit_benchmark_event(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            run_id=run_id,
            event_type="complete",
            event_data={"run_id": run_id, "artifact_id": run_id, "status": "completed"},
        )
        await stream.close(_benchmark_stream_key(workspace_id, run_id))
    except Exception as exc:
        failed_at = datetime.now(UTC).isoformat()
        failed_record = await store.get_user_test_result(workspace_id, run_id) or {}
        failed_record.update(
            {
                "run_id": run_id,
                "workspace_id": workspace_id,
                "kind": "benchmark",
                "status": "failed",
                "error": str(exc)[:1000],
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
            event_data={"run_id": run_id, "message": str(exc)[:1000]},
        )
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


@router.get("/benchmarks")
async def get_benchmarks(
    user: OptionalCurrentUser,
    x_agora_admin_token: str | None = Header(default=None),
    include_demo: bool = Query(default=False),
) -> dict[str, Any]:
    """Return the latest persisted benchmark summary."""

    has_admin_secret = bool(settings.benchmark_admin_token)
    admin_granted = has_admin_secret and x_agora_admin_token == settings.benchmark_admin_token

    if not admin_granted:
        if user is None:
            raise HTTPException(status_code=403, detail="Benchmark access denied")
        require_human_user(user)

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
        if isinstance(artifact, dict)
        for entry in [_to_catalog_entry(artifact, default_scope="global")]
        if entry is not None
    ]

    user_entries: list[BenchmarkCatalogEntry] = []
    tests_recent: list[BenchmarkRunStatusResponse] = []
    tests_frequency: list[BenchmarkRunStatusResponse] = []

    if user.auth_method == "jwt":
        require_human_user(user)
        user_artifacts = await store.list_user_benchmark_artifacts(user.workspace_id, limit=limit)
        user_entries = [
            entry
            for artifact in user_artifacts
            if isinstance(artifact, dict)
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

    # Human sessions unlock user-scoped benchmark actions, but question template browsing
    # can still be available to authenticated API key clients.
    if user.auth_method == "jwt":
        require_human_user(user)

    return _domain_prompt_templates_response()


@router.get("/benchmarks/{benchmark_id}", response_model=BenchmarkDetailResponse)
async def get_benchmark_detail(
    benchmark_id: str,
    user: CurrentUser,
) -> BenchmarkDetailResponse:
    """Return a dedicated benchmark detail payload by artifact_id or run_id fallback."""

    try:
        validate_storage_id(benchmark_id, field_name="benchmark_id")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await _maybe_backfill_legacy_benchmarks()
    store = get_task_store()

    if user.auth_method == "jwt":
        require_human_user(user)

    run_record = await store.get_user_test_result(user.workspace_id, benchmark_id)
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


@router.post("/benchmarks/run", response_model=BenchmarkRunResponse)
async def trigger_benchmark_run(
    request: BenchmarkRunRequest,
    user: CurrentUser,
) -> BenchmarkRunResponse:
    """Trigger an async benchmark run and persist status in user test records."""

    require_human_user(user)
    store = get_task_store()
    stream = get_stream_manager()
    run_id = _build_run_id(user.workspace_id)
    created_at = datetime.now(UTC)
    reasoning_presets = resolve_reasoning_presets(request.reasoning_presets)
    resolved_domain_prompts = _resolved_domain_prompts(request)

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

    task = asyncio.create_task(
        _execute_benchmark_run(
            workspace_id=user.workspace_id,
            run_id=run_id,
            request=request,
        )
    )
    _background_benchmark_runs[run_id] = task
    task.add_done_callback(lambda _finished: _background_benchmark_runs.pop(run_id, None))

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

    require_human_user(user)
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

    require_human_user(user)
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

        if any(event.get("event") in {"complete", "failed", "error"} for event in events):
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
                        if payload["event"] in {"complete", "failed", "error"}:
                            return
                    continue

                if item is None:
                    break
                payload = _benchmark_sse_message(item)
                yield payload
                next_event_index += 1
                if payload["event"] in {"complete", "failed", "error"}:
                    break
        finally:
            stream.unsubscribe(stream_id, queue)

    return EventSourceResponse(event_generator())
