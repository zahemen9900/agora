"""Shared helpers for ephemeral local/BYOK execution requests."""

from __future__ import annotations

from typing import Any

from agora.runtime.local_models import validate_local_model_config
from agora.types import LocalDebateConfig, LocalModelSpec, LocalProviderKeys


def is_local_execution_request(
    *,
    local_models: list[LocalModelSpec] | None,
    local_provider_keys: LocalProviderKeys | None,
    local_debate_config: LocalDebateConfig | None,
) -> bool:
    return any(
        value is not None
        for value in (local_models, local_provider_keys, local_debate_config)
    )


def validate_local_execution_request(
    *,
    local_models: list[LocalModelSpec] | None,
    local_provider_keys: LocalProviderKeys | None,
    local_debate_config: LocalDebateConfig | None,
    expected_agent_count: int,
    execution_label: str,
) -> None:
    if local_models is None or local_provider_keys is None:
        raise ValueError(
            f"{execution_label} requires both local_models and local_provider_keys."
        )
    if len(local_models) != expected_agent_count:
        raise ValueError(
            f"{execution_label} requires agent_count to match len(local_models)."
        )
    provider_families = {spec.provider for spec in local_models}
    if len(provider_families) < 2:
        raise ValueError(
            f"{execution_label} requires at least 2 distinct provider families."
        )
    validate_local_model_config(
        local_models=local_models,
        provider_keys=local_provider_keys,
        debate_config=local_debate_config,
    )


def sanitize_local_execution_payload(payload: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(payload)
    sanitized.pop("local_models", None)
    sanitized.pop("local_provider_keys", None)
    sanitized.pop("local_debate_config", None)
    return sanitized
