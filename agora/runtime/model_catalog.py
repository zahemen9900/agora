"""Canonical built-in model catalog for runtime routing, pricing, and UI labels."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

LocalProviderFamily = Literal["gemini", "anthropic", "openrouter"]
ModelStabilityTier = Literal["stable", "candidate", "legacy"]

MODEL_CATALOG_VERSION = "2026-05-09"
MODEL_CATALOG_CHECKED_AT = datetime(2026, 5, 9, tzinfo=UTC)


@dataclass(frozen=True)
class ModelCatalogEntry:
    """Versioned metadata for one built-in model identifier."""

    provider_family: LocalProviderFamily
    model_id: str
    display_name: str
    input_usd_per_million: float | None
    output_usd_per_million: float | None
    source_url: str
    allowed_tiers: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()
    supports_streaming: bool = True
    supports_json_schema: bool = True
    supports_reasoning: bool = True
    supports_reasoning_continuation: bool = False
    usage_telemetry_mode: str = "provider_dependent"
    stability_tier: ModelStabilityTier = "candidate"
    thinking_billed_as_output: bool = True
    checked_at: datetime = MODEL_CATALOG_CHECKED_AT
    version: str = MODEL_CATALOG_VERSION


_MODEL_CATALOG: tuple[ModelCatalogEntry, ...] = (
    ModelCatalogEntry(
        provider_family="gemini",
        model_id="gemini-3-flash-preview",
        display_name="Gemini 3 Flash Preview",
        input_usd_per_million=0.50,
        output_usd_per_million=3.00,
        source_url="https://ai.google.dev/gemini-api/docs/pricing",
        allowed_tiers=("pro",),
        aliases=("gemini-3-flash",),
        supports_reasoning_continuation=True,
        stability_tier="legacy",
    ),
    ModelCatalogEntry(
        provider_family="gemini",
        model_id="gemini-3.1-pro-preview",
        display_name="Gemini 3.1 Pro Preview",
        input_usd_per_million=2.00,
        output_usd_per_million=12.00,
        source_url="https://ai.google.dev/gemini-api/docs/pricing",
        allowed_tiers=("pro",),
        aliases=("gemini-3.1-pro",),
        supports_reasoning_continuation=True,
        stability_tier="legacy",
    ),
    ModelCatalogEntry(
        provider_family="gemini",
        model_id="gemini-3.1-flash-lite-preview",
        display_name="Gemini 3.1 Flash Lite Preview",
        input_usd_per_million=0.25,
        output_usd_per_million=1.50,
        source_url="https://ai.google.dev/gemini-api/docs/pricing",
        allowed_tiers=("flash",),
        aliases=("flash-lite",),
        supports_reasoning_continuation=True,
        stability_tier="legacy",
    ),
    ModelCatalogEntry(
        provider_family="gemini",
        model_id="gemini-2.5-pro",
        display_name="Gemini 2.5 Pro",
        input_usd_per_million=1.25,
        output_usd_per_million=10.00,
        source_url="https://ai.google.dev/gemini-api/docs/pricing",
        allowed_tiers=("pro",),
        supports_reasoning_continuation=True,
        stability_tier="stable",
    ),
    ModelCatalogEntry(
        provider_family="gemini",
        model_id="gemini-2.5-flash",
        display_name="Gemini 2.5 Flash",
        input_usd_per_million=0.30,
        output_usd_per_million=2.50,
        source_url="https://ai.google.dev/gemini-api/docs/pricing",
        allowed_tiers=("flash",),
        supports_reasoning_continuation=True,
        stability_tier="stable",
    ),
    ModelCatalogEntry(
        provider_family="gemini",
        model_id="gemini-2.5-flash-lite",
        display_name="Gemini 2.5 Flash Lite",
        input_usd_per_million=0.10,
        output_usd_per_million=0.40,
        source_url="https://ai.google.dev/gemini-api/docs/pricing",
        allowed_tiers=("flash",),
        supports_reasoning_continuation=True,
        stability_tier="stable",
    ),
    ModelCatalogEntry(
        provider_family="anthropic",
        model_id="claude-sonnet-4-6",
        display_name="Claude Sonnet 4.6",
        input_usd_per_million=3.00,
        output_usd_per_million=15.00,
        source_url="https://www.anthropic.com/pricing#anthropic-api",
        allowed_tiers=("claude",),
        aliases=("claude-sonnet-4.6",),
        stability_tier="legacy",
    ),
    ModelCatalogEntry(
        provider_family="anthropic",
        model_id="claude-sonnet-4-5",
        display_name="Claude Sonnet 4.5",
        input_usd_per_million=3.00,
        output_usd_per_million=15.00,
        source_url="https://www.anthropic.com/pricing#anthropic-api",
        allowed_tiers=("claude",),
        aliases=("claude-sonnet-4.5", "claude-sonnet-4"),
        supports_reasoning=False,
        stability_tier="stable",
    ),
    ModelCatalogEntry(
        provider_family="anthropic",
        model_id="claude-haiku-4-5",
        display_name="Claude Haiku 4.5",
        input_usd_per_million=1.00,
        output_usd_per_million=5.00,
        source_url="https://www.anthropic.com/pricing#anthropic-api",
        allowed_tiers=("claude",),
        aliases=("claude-haiku-4.5",),
        supports_reasoning=False,
        stability_tier="stable",
    ),
    ModelCatalogEntry(
        provider_family="openrouter",
        model_id="deepseek/deepseek-v3.2-exp",
        display_name="DeepSeek V3.2 Exp",
        input_usd_per_million=0.27,
        output_usd_per_million=0.41,
        source_url="https://openrouter.ai/deepseek/deepseek-v3.2-exp",
        allowed_tiers=("openrouter",),
        stability_tier="candidate",
    ),
    ModelCatalogEntry(
        provider_family="openrouter",
        model_id="google/gemma-4-31b-it",
        display_name="Gemma 4 31B IT",
        input_usd_per_million=0.13,
        output_usd_per_million=0.38,
        source_url="https://openrouter.ai/google/gemma-4-31b-it",
        allowed_tiers=("openrouter",),
        stability_tier="candidate",
    ),
    ModelCatalogEntry(
        provider_family="openrouter",
        model_id="openai/gpt-oss-120b",
        display_name="GPT OSS 120B",
        input_usd_per_million=0.039,
        output_usd_per_million=0.18,
        source_url="https://openrouter.ai/openai/gpt-oss-120b",
        allowed_tiers=("openrouter",),
        stability_tier="candidate",
    ),
    ModelCatalogEntry(
        provider_family="openrouter",
        model_id="z-ai/glm-4.7-flash",
        display_name="GLM 4.7 Flash",
        input_usd_per_million=0.06,
        output_usd_per_million=0.40,
        source_url="https://openrouter.ai/z-ai/glm-4.7-flash",
        allowed_tiers=("openrouter",),
        stability_tier="candidate",
    ),
    ModelCatalogEntry(
        provider_family="openrouter",
        model_id="qwen/qwen3.5-flash-02-23",
        display_name="Qwen 3.5 Flash",
        input_usd_per_million=0.065,
        output_usd_per_million=0.26,
        source_url="https://openrouter.ai/qwen/qwen3.5-flash-02-23",
        allowed_tiers=("openrouter",),
        stability_tier="stable",
    ),
    ModelCatalogEntry(
        provider_family="openrouter",
        model_id="moonshotai/kimi-k2-thinking",
        display_name="Kimi K2 Thinking",
        input_usd_per_million=0.60,
        output_usd_per_million=2.50,
        source_url="https://openrouter.ai/moonshotai/kimi-k2-thinking",
        allowed_tiers=("openrouter",),
        aliases=("moonshotai/kimi-k2", "kimi-k2-thinking", "kimi-k2"),
        stability_tier="legacy",
        supports_reasoning_continuation=True,
    ),
)

_ALIAS_INDEX: dict[str, ModelCatalogEntry] = {}
_MODEL_INDEX: dict[str, ModelCatalogEntry] = {}
for _entry in _MODEL_CATALOG:
    _MODEL_INDEX[_entry.model_id.lower()] = _entry
    for _alias in (_entry.model_id, *_entry.aliases):
        _ALIAS_INDEX[_alias.lower()] = _entry


def iter_model_catalog() -> tuple[ModelCatalogEntry, ...]:
    """Return the immutable model catalog."""

    return _MODEL_CATALOG


def resolve_model_catalog_entry(model_name: str) -> ModelCatalogEntry | None:
    """Resolve metadata for one model id or known alias."""

    normalized = str(model_name or "").strip().lower()
    if not normalized:
        return None
    entry = _ALIAS_INDEX.get(normalized)
    if entry is not None:
        return entry
    for candidate, maybe_entry in _MODEL_INDEX.items():
        if candidate in normalized:
            return maybe_entry
    return None


def canonical_model_name(model_name: str) -> str:
    """Return the canonical model id when one is known."""

    entry = resolve_model_catalog_entry(model_name)
    return entry.model_id if entry is not None else str(model_name or "").strip()


def is_openrouter_model_id(model_name: str) -> bool:
    """Return whether a model identifier should route through OpenRouter."""

    normalized = str(model_name or "").strip().lower()
    if not normalized:
        return False
    entry = resolve_model_catalog_entry(normalized)
    if entry is not None:
        return entry.provider_family == "openrouter"
    if normalized.startswith("gemini") or normalized.startswith("claude"):
        return False
    return "/" in normalized


def built_in_models_for_provider(provider: LocalProviderFamily) -> tuple[ModelCatalogEntry, ...]:
    """Return all built-in catalog entries for one provider family."""

    return tuple(entry for entry in _MODEL_CATALOG if entry.provider_family == provider)
