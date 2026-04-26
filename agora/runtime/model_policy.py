"""Shared provider allocation and reasoning preset policy."""

from __future__ import annotations

from collections import Counter
from typing import Any

from agora.config import AgoraConfig, get_config
from agora.runtime.model_catalog import canonical_model_name, resolve_model_catalog_entry
from agora.types import (
    GeminiProReasoningPreset,
    ProviderTierName,
    ReasoningPresetName,
    ReasoningPresetOverrides,
    ReasoningPresets,
)

BASE_PARTICIPANT_CYCLE: tuple[ProviderTierName, ...] = ("pro", "flash", "openrouter", "claude")


def default_tier_models(*, config: AgoraConfig | None = None) -> dict[ProviderTierName, str]:
    """Return the canonical default model id for each counted participant tier."""

    resolved_config = config or get_config()
    return {
        "pro": canonical_model_name(resolved_config.pro_model),
        "flash": canonical_model_name(resolved_config.flash_model),
        "openrouter": canonical_model_name(resolved_config.openrouter_model),
        "claude": canonical_model_name(resolved_config.claude_model),
    }


def normalize_tier_model_overrides(
    overrides: dict[str, str] | None,
    *,
    config: AgoraConfig | None = None,
) -> dict[ProviderTierName, str]:
    """Return validated per-tier model overrides using canonical catalog ids."""

    if not overrides:
        return {}

    normalized: dict[ProviderTierName, str] = {}
    for raw_tier, raw_model in overrides.items():
        tier = "openrouter" if raw_tier == "kimi" else raw_tier
        if tier not in BASE_PARTICIPANT_CYCLE:
            raise ValueError(f"Unknown participant tier '{raw_tier}'")
        model_id = canonical_model_name(str(raw_model or "").strip())
        if not model_id:
            continue
        entry = resolve_model_catalog_entry(model_id)
        if entry is None:
            raise ValueError(f"Unknown model '{raw_model}'")
        if tier not in entry.allowed_tiers:
            raise ValueError(
                f"Model '{entry.model_id}' is not allowed for participant tier '{tier}'"
            )
        normalized[tier] = entry.model_id

    defaults = default_tier_models(config=config)
    return {tier: model for tier, model in normalized.items() if model != defaults[tier]}


def effective_tier_models(
    overrides: dict[str, str] | None = None,
    *,
    config: AgoraConfig | None = None,
) -> dict[ProviderTierName, str]:
    """Resolve the effective tier model assignment after applying overrides."""

    defaults = default_tier_models(config=config)
    if not overrides:
        return defaults
    return {
        **defaults,
        **normalize_tier_model_overrides(overrides, config=config),
    }


def balanced_participant_tiers(agent_count: int) -> list[ProviderTierName]:
    """Return the canonical counted-participant provider cycle for a run."""

    normalized_count = max(1, agent_count)
    cycle_length = len(BASE_PARTICIPANT_CYCLE)
    return [BASE_PARTICIPANT_CYCLE[index % cycle_length] for index in range(normalized_count)]


def participant_tier_for_index(agent_count: int, agent_index: int) -> ProviderTierName:
    """Return the provider tier assigned to one counted participant."""

    tiers = balanced_participant_tiers(agent_count)
    if agent_index < 0 or agent_index >= len(tiers):
        raise IndexError(f"agent_index {agent_index} is outside 0..{len(tiers) - 1}")
    return tiers[agent_index]


def provider_counts(agent_count: int) -> dict[ProviderTierName, int]:
    """Return how many counted participants each provider receives."""

    counts = Counter(balanced_participant_tiers(agent_count))
    return {tier: counts.get(tier, 0) for tier in BASE_PARTICIPANT_CYCLE}


def resolve_reasoning_presets(
    overrides: ReasoningPresets | ReasoningPresetOverrides | dict[str, Any] | None = None,
    *,
    config: AgoraConfig | None = None,
) -> ReasoningPresets:
    """Resolve persisted runtime presets from config defaults plus optional overrides."""

    resolved_config = config or get_config()
    if isinstance(overrides, ReasoningPresets):
        return overrides
    if isinstance(overrides, dict):
        overrides = ReasoningPresetOverrides.model_validate(overrides)

    defaults = ReasoningPresets(
        gemini_pro=_normalize_pro_preset(
            resolved_config.gemini_pro_thinking_level,
            fallback="high",
        ),
        gemini_flash=_normalize_standard_preset(
            resolved_config.gemini_flash_thinking_level,
            fallback="medium",
        ),
        openrouter=_normalize_standard_preset(
            resolved_config.openrouter_reasoning_effort,
            fallback="low",
        ),
        claude=_normalize_standard_preset(
            resolved_config.claude_effort,
            fallback="medium",
        ),
    )
    if overrides is None:
        return defaults

    return ReasoningPresets(
        gemini_pro=overrides.gemini_pro or defaults.gemini_pro,
        gemini_flash=overrides.gemini_flash or defaults.gemini_flash,
        openrouter=overrides.openrouter or defaults.openrouter,
        claude=overrides.claude or defaults.claude,
    )


def _normalize_pro_preset(
    raw_value: str | None,
    *,
    fallback: GeminiProReasoningPreset,
) -> GeminiProReasoningPreset:
    normalized = (raw_value or "").strip().lower()
    if normalized in {"low", "high"}:
        return normalized  # type: ignore[return-value]
    return fallback


def _normalize_standard_preset(
    raw_value: str | None,
    *,
    fallback: ReasoningPresetName,
) -> ReasoningPresetName:
    normalized = (raw_value or "").strip().lower()
    if normalized in {"low", "medium", "high"}:
        return normalized  # type: ignore[return-value]
    return fallback
