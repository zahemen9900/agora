"""Shared model pricing catalog and telemetry cost estimation helpers."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

PricingMode = Literal["exact", "approx_total_tokens", "unavailable", "mixed"]

PRICING_CATALOG_VERSION = "2026-04-18"
PRICING_CHECKED_AT = datetime(2026, 4, 18, tzinfo=UTC)


@dataclass(frozen=True)
class PricingCatalogEntry:
    """Versioned provider pricing metadata for a model family."""

    family: str
    aliases: tuple[str, ...]
    input_usd_per_million: float
    output_usd_per_million: float
    thinking_billed_as_output: bool
    source_url: str
    checked_at: datetime = PRICING_CHECKED_AT
    version: str = PRICING_CATALOG_VERSION

    @property
    def blended_usd_per_million(self) -> float:
        return (self.input_usd_per_million + self.output_usd_per_million) / 2.0


_PRICING_CATALOG: tuple[PricingCatalogEntry, ...] = (
    PricingCatalogEntry(
        family="gemini-3-flash-preview",
        aliases=("gemini-3-flash-preview", "gemini-3-flash"),
        input_usd_per_million=0.50,
        output_usd_per_million=3.00,
        thinking_billed_as_output=True,
        source_url="https://ai.google.dev/pricing",
    ),
    PricingCatalogEntry(
        family="gemini-3.1-flash-lite-preview",
        aliases=("gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite", "flash-lite"),
        input_usd_per_million=0.10,
        output_usd_per_million=0.40,
        thinking_billed_as_output=True,
        source_url="https://ai.google.dev/pricing",
    ),
    PricingCatalogEntry(
        family="claude-sonnet-4-6",
        aliases=("claude-sonnet-4-6", "claude-sonnet-4.6", "claude-sonnet-4", "claude-sonnet"),
        input_usd_per_million=3.00,
        output_usd_per_million=15.00,
        thinking_billed_as_output=True,
        source_url="https://claude.com/pricing",
    ),
    PricingCatalogEntry(
        family="moonshotai/kimi-k2-thinking",
        aliases=(
            "moonshotai/kimi-k2-thinking",
            "moonshotai/kimi-k2",
            "kimi-k2-thinking",
            "kimi-k2",
        ),
        input_usd_per_million=0.60,
        output_usd_per_million=2.50,
        thinking_billed_as_output=True,
        source_url="https://openrouter.ai/moonshotai/kimi-k2-thinking",
    ),
)

_DEFAULT_PRICING = PricingCatalogEntry(
    family="default",
    aliases=(),
    input_usd_per_million=1.00,
    output_usd_per_million=4.00,
    thinking_billed_as_output=True,
    source_url="https://ai.google.dev/pricing",
)


def resolve_pricing_entry(model_name: str) -> PricingCatalogEntry:
    """Resolve pricing metadata for a concrete model name."""

    normalized = model_name.strip().lower()
    if not normalized:
        return _DEFAULT_PRICING
    for entry in _PRICING_CATALOG:
        if any(alias in normalized for alias in entry.aliases):
            return entry
    return _DEFAULT_PRICING


def pricing_catalog_metadata() -> dict[str, Any]:
    """Return version metadata suitable for API payloads."""

    return {
        "pricing_version": PRICING_CATALOG_VERSION,
        "estimated_at": PRICING_CHECKED_AT,
    }


def estimate_model_cost(
    *,
    model_name: str,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    thinking_tokens: int | None = None,
    total_tokens: int | None = None,
) -> tuple[float | None, PricingMode, PricingCatalogEntry]:
    """Estimate one model's USD cost from detailed or coarse token telemetry."""

    entry = resolve_pricing_entry(model_name)
    clean_input = None if input_tokens is None else max(0, int(input_tokens))
    clean_output = None if output_tokens is None else max(0, int(output_tokens))
    clean_thinking = None if thinking_tokens is None else max(0, int(thinking_tokens))
    clean_total = None if total_tokens is None else max(0, int(total_tokens))

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

    cost = (clean_total / 1_000_000) * entry.blended_usd_per_million
    return round(cost, 8), "approx_total_tokens", entry


def estimate_cost_for_models(
    model_telemetry: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Estimate aggregate USD cost across model telemetry maps."""

    model_costs: dict[str, float] = {}
    source_urls: dict[str, str] = {}
    observed_modes: set[PricingMode] = set()

    for model_name, telemetry in model_telemetry.items():
        cost, mode, entry = estimate_model_cost(
            model_name=model_name,
            input_tokens=telemetry.get("input_tokens"),
            output_tokens=telemetry.get("output_tokens"),
            thinking_tokens=telemetry.get("thinking_tokens"),
            total_tokens=telemetry.get("total_tokens"),
        )
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

    return {
        "estimated_cost_usd": total_cost,
        "model_estimated_costs_usd": model_costs,
        "pricing_version": PRICING_CATALOG_VERSION,
        "estimated_at": PRICING_CHECKED_AT,
        "estimation_mode": estimation_mode,
        "pricing_sources": source_urls,
    }


def build_model_telemetry(
    *,
    models: list[str] | tuple[str, ...] | None = None,
    model_token_usage: Mapping[str, int] | None = None,
    model_latency_ms: Mapping[str, float] | None = None,
    model_input_tokens: Mapping[str, int | None] | None = None,
    model_output_tokens: Mapping[str, int | None] | None = None,
    model_thinking_tokens: Mapping[str, int | None] | None = None,
    fallback_total_tokens: int = 0,
) -> dict[str, dict[str, Any]]:
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

    telemetry: dict[str, dict[str, Any]] = {}

    def _maybe_token_value(mapping: Mapping[str, int | None] | None, model: str) -> int | None:
        if mapping is None or model not in mapping:
            return None
        value = mapping.get(model)
        if value is None:
            return None
        return max(0, int(value))

    for model in ordered_models:
        telemetry[model] = {
            "total_tokens": total_usage.get(model, 0),
            "input_tokens": _maybe_token_value(model_input_tokens, model),
            "output_tokens": _maybe_token_value(model_output_tokens, model),
            "thinking_tokens": _maybe_token_value(model_thinking_tokens, model),
            "latency_ms": max(0.0, float((model_latency_ms or {}).get(model, 0.0) or 0.0)),
        }

    cost_payload = estimate_cost_for_models(telemetry)
    for model, cost in cost_payload["model_estimated_costs_usd"].items():
        if model in telemetry:
            telemetry[model]["estimated_cost_usd"] = cost
            telemetry[model]["estimation_mode"] = (
                "exact"
                if telemetry[model]["input_tokens"] is not None
                or telemetry[model]["output_tokens"] is not None
                or telemetry[model]["thinking_tokens"] is not None
                else "approx_total_tokens"
            )
    for model in telemetry:
        telemetry[model].setdefault(
            "estimation_mode",
            "unavailable" if telemetry[model]["total_tokens"] <= 0 else "approx_total_tokens",
        )
    return telemetry
