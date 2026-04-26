"""Shared model pricing catalog and telemetry cost estimation helpers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from agora.runtime.model_catalog import (
    MODEL_CATALOG_CHECKED_AT,
    MODEL_CATALOG_VERSION,
    ModelCatalogEntry,
    iter_model_catalog,
    resolve_model_catalog_entry,
)
from agora.types import CostEstimate, CostEstimationMode, ModelTelemetry

PricingMode = CostEstimationMode

PRICING_CATALOG_VERSION = MODEL_CATALOG_VERSION
PRICING_CHECKED_AT = MODEL_CATALOG_CHECKED_AT


def _blended_usd_per_million(entry: ModelCatalogEntry) -> float | None:
    if entry.input_usd_per_million is None or entry.output_usd_per_million is None:
        return None
    return (entry.input_usd_per_million + entry.output_usd_per_million) / 2.0


def resolve_pricing_entry(model_name: str) -> ModelCatalogEntry | None:
    """Resolve pricing metadata for a concrete model name."""

    return resolve_model_catalog_entry(model_name)


def pricing_catalog_metadata() -> dict[str, Any]:
    """Return version metadata suitable for API payloads."""

    return {
        "pricing_version": PRICING_CATALOG_VERSION,
        "estimated_at": PRICING_CHECKED_AT,
        "catalog_size": len(iter_model_catalog()),
    }


def estimate_model_cost(
    *,
    model_name: str,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    thinking_tokens: int | None = None,
    total_tokens: int | None = None,
) -> tuple[float | None, PricingMode, ModelCatalogEntry | None]:
    """Estimate one model's USD cost from detailed or coarse token telemetry."""

    entry = resolve_pricing_entry(model_name)
    clean_input = None if input_tokens is None else max(0, int(input_tokens))
    clean_output = None if output_tokens is None else max(0, int(output_tokens))
    clean_thinking = None if thinking_tokens is None else max(0, int(thinking_tokens))
    clean_total = None if total_tokens is None else max(0, int(total_tokens))

    if entry is None or entry.input_usd_per_million is None or entry.output_usd_per_million is None:
        return None, "unavailable", entry

    if (
        clean_input is not None
        and clean_output is not None
        and clean_thinking is not None
    ):
        billable_output = clean_output + (clean_thinking if entry.thinking_billed_as_output else 0)
        cost = (
            (clean_input / 1_000_000) * entry.input_usd_per_million
            + (billable_output / 1_000_000) * entry.output_usd_per_million
        )
        return round(cost, 8), "exact", entry

    if clean_total is None or clean_total <= 0:
        return None, "unavailable", entry

    blended = _blended_usd_per_million(entry)
    if blended is None:
        return None, "unavailable", entry
    cost = (clean_total / 1_000_000) * blended
    return round(cost, 8), "approx_total_tokens", entry


def estimate_cost_for_models(
    model_telemetry: Mapping[str, Mapping[str, Any] | ModelTelemetry],
) -> CostEstimate:
    """Estimate aggregate USD cost across model telemetry maps."""

    model_costs: dict[str, float] = {}
    source_urls: dict[str, str] = {}
    observed_modes: set[PricingMode] = set()

    def _telemetry_value(
        telemetry: Mapping[str, Any] | ModelTelemetry,
        field: str,
    ) -> Any:
        if isinstance(telemetry, ModelTelemetry):
            return getattr(telemetry, field)
        return telemetry.get(field)

    for model_name, telemetry in model_telemetry.items():
        cost, mode, entry = estimate_model_cost(
            model_name=model_name,
            input_tokens=_telemetry_value(telemetry, "input_tokens"),
            output_tokens=_telemetry_value(telemetry, "output_tokens"),
            thinking_tokens=_telemetry_value(telemetry, "thinking_tokens"),
            total_tokens=_telemetry_value(telemetry, "total_tokens"),
        )
        if entry is not None:
            source_urls[model_name] = entry.source_url
        observed_modes.add(mode)
        if cost is not None and cost > 0:
            model_costs[model_name] = cost

    concrete_modes = observed_modes - {"unavailable"}
    if not concrete_modes:
        estimation_mode: PricingMode = "unavailable"
    elif len(concrete_modes) > 1 or "unavailable" in observed_modes:
        estimation_mode = "mixed"
    else:
        estimation_mode = next(iter(concrete_modes))

    total_cost = round(sum(model_costs.values()), 8) if model_costs else None

    return CostEstimate(
        estimated_cost_usd=total_cost,
        model_estimated_costs_usd=model_costs,
        pricing_version=PRICING_CATALOG_VERSION,
        estimated_at=PRICING_CHECKED_AT,
        estimation_mode=estimation_mode,
        pricing_sources=source_urls,
    )


def build_model_telemetry(
    *,
    models: list[str] | tuple[str, ...] | None = None,
    model_token_usage: Mapping[str, int] | None = None,
    model_latency_ms: Mapping[str, float] | None = None,
    model_input_tokens: Mapping[str, int | None] | None = None,
    model_output_tokens: Mapping[str, int | None] | None = None,
    model_thinking_tokens: Mapping[str, int | None] | None = None,
    fallback_total_tokens: int = 0,
) -> dict[str, ModelTelemetry]:
    """Build normalized per-model telemetry from sparse runtime inputs."""

    ordered_models: list[str] = []
    for collection in (
        list(models or []),
        list((model_token_usage or {}).keys()),
        list((model_latency_ms or {}).keys()),
        list((model_input_tokens or {}).keys()),
        list((model_output_tokens or {}).keys()),
        list((model_thinking_tokens or {}).keys()),
    ):
        for model in collection:
            normalized = str(model).strip()
            if normalized and normalized not in ordered_models:
                ordered_models.append(normalized)

    total_usage = {
        str(model): max(0, int(tokens))
        for model, tokens in (model_token_usage or {}).items()
        if str(model).strip()
    }
    if not total_usage and ordered_models and fallback_total_tokens > 0:
        base = fallback_total_tokens // len(ordered_models)
        remainder = fallback_total_tokens % len(ordered_models)
        for index, model in enumerate(ordered_models):
            total_usage[model] = base + (1 if index < remainder else 0)

    telemetry: dict[str, ModelTelemetry] = {}

    def _maybe_token_value(mapping: Mapping[str, int | None] | None, model: str) -> int | None:
        if mapping is None or model not in mapping:
            return None
        value = mapping.get(model)
        if value is None:
            return None
        return max(0, int(value))

    for model in ordered_models:
        telemetry[model] = ModelTelemetry(
            total_tokens=total_usage.get(model, 0),
            input_tokens=_maybe_token_value(model_input_tokens, model),
            output_tokens=_maybe_token_value(model_output_tokens, model),
            thinking_tokens=_maybe_token_value(model_thinking_tokens, model),
            latency_ms=max(0.0, float((model_latency_ms or {}).get(model, 0.0) or 0.0)),
        )

    cost_payload = estimate_cost_for_models(telemetry)
    for model, cost in cost_payload.model_estimated_costs_usd.items():
        if model in telemetry:
            telemetry[model] = telemetry[model].model_copy(update={"estimated_cost_usd": cost})
    for model in telemetry:
        has_complete_split = (
            telemetry[model].input_tokens is not None
            and telemetry[model].output_tokens is not None
            and telemetry[model].thinking_tokens is not None
        )
        if has_complete_split:
            telemetry[model] = telemetry[model].model_copy(update={"estimation_mode": "exact"})
        elif telemetry[model].total_tokens > 0:
            telemetry[model] = telemetry[model].model_copy(
                update={"estimation_mode": "approx_total_tokens"}
            )
        else:
            telemetry[model] = telemetry[model].model_copy(update={"estimation_mode": "unavailable"})
    return telemetry


def build_result_costing(
    *,
    models: list[str] | tuple[str, ...] | None = None,
    model_token_usage: Mapping[str, int] | None = None,
    model_latency_ms: Mapping[str, float] | None = None,
    model_input_tokens: Mapping[str, int | None] | None = None,
    model_output_tokens: Mapping[str, int | None] | None = None,
    model_thinking_tokens: Mapping[str, int | None] | None = None,
    fallback_total_tokens: int = 0,
) -> tuple[dict[str, ModelTelemetry], CostEstimate | None]:
    """Build canonical per-model telemetry plus aggregate cost payload."""

    telemetry = build_model_telemetry(
        models=models,
        model_token_usage=model_token_usage,
        model_latency_ms=model_latency_ms,
        model_input_tokens=model_input_tokens,
        model_output_tokens=model_output_tokens,
        model_thinking_tokens=model_thinking_tokens,
        fallback_total_tokens=fallback_total_tokens,
    )
    cost = estimate_cost_for_models(telemetry)
    if cost.estimation_mode == "unavailable":
        return telemetry, None
    return telemetry, cost
