"""Shared provider allocation and reasoning preset policy."""

from __future__ import annotations

from collections import Counter
from typing import Any

from agora.config import AgoraConfig, get_config
from agora.types import (
    GeminiProReasoningPreset,
    ProviderTierName,
    ReasoningPresetName,
    ReasoningPresetOverrides,
    ReasoningPresets,
)

BASE_PARTICIPANT_CYCLE: tuple[ProviderTierName, ...] = ("pro", "flash", "kimi", "claude")


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
        kimi=_normalize_standard_preset(
            resolved_config.kimi_reasoning_effort,
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
        kimi=overrides.kimi or defaults.kimi,
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
