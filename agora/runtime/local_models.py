"""Helpers for explicit local model roster execution."""

from __future__ import annotations

from agora.agent import AgentCaller
from agora.config import get_config
from agora.runtime.model_catalog import is_openrouter_model_id
from agora.types import LocalDebateConfig, LocalModelSpec, LocalProviderKeys


def validate_local_model_config(
    *,
    local_models: list[LocalModelSpec] | None,
    provider_keys: LocalProviderKeys | None,
    debate_config: LocalDebateConfig | None,
) -> None:
    """Validate explicit local model roster and credential availability."""

    if not local_models:
        return

    for spec in local_models:
        _validate_provider_model_match(spec)
        _require_provider_key(spec.provider, provider_keys)

    if debate_config is not None and debate_config.devils_advocate_model is not None:
        _validate_provider_model_match(debate_config.devils_advocate_model)
        _require_provider_key(debate_config.devils_advocate_model.provider, provider_keys)


def build_local_model_caller(
    *,
    spec: LocalModelSpec,
    provider_keys: LocalProviderKeys | None,
) -> AgentCaller:
    """Build an explicit AgentCaller for one local model selection."""

    config = get_config()
    _validate_provider_model_match(spec)

    if spec.provider == "gemini":
        return AgentCaller(
            model=spec.model,
            temperature=0.7,
            gemini_api_key=_provider_key(provider_keys, "gemini"),
            enable_streaming=config.gemini_enable_streaming,
            enable_thinking=config.gemini_enable_thinking,
            thinking_budget=None,
            thinking_level=spec.reasoning_preset
            or (
                config.gemini_pro_thinking_level
                if spec.model == config.pro_model
                else config.gemini_flash_thinking_level
            ),
        )

    if spec.provider == "anthropic":
        return AgentCaller(
            model=spec.model,
            temperature=1.0,
            anthropic_api_key=_provider_key(provider_keys, "anthropic"),
            claude_effort=spec.reasoning_preset or config.claude_effort,
        )

    return AgentCaller(
        model=spec.model,
        temperature=0.5,
        openrouter_api_key=_provider_key(provider_keys, "openrouter"),
        openrouter_reasoning_effort=spec.reasoning_preset or config.openrouter_reasoning_effort,
        openrouter_reasoning_exclude=config.openrouter_reasoning_exclude,
    )


def _validate_provider_model_match(spec: LocalModelSpec) -> None:
    if spec.provider == "gemini" and spec.model.startswith("gemini"):
        return
    if spec.provider == "anthropic" and spec.model.startswith("claude"):
        return
    if spec.provider == "openrouter" and is_openrouter_model_id(spec.model):
        return
    raise ValueError(
        f"Local model '{spec.model}' is not valid for provider '{spec.provider}'"
    )


def _require_provider_key(
    provider: str,
    provider_keys: LocalProviderKeys | None,
) -> None:
    if _provider_key(provider_keys, provider):
        return
    if provider == "gemini":
        raise ValueError("Explicit local Gemini execution requires LocalProviderKeys.gemini_api_key")
    if provider == "anthropic":
        raise ValueError(
            "Explicit local Claude execution requires LocalProviderKeys.anthropic_api_key"
        )
    raise ValueError("Explicit local OpenRouter execution requires LocalProviderKeys.openrouter_api_key")


def _provider_key(
    provider_keys: LocalProviderKeys | None,
    provider: str,
) -> str | None:
    if provider == "gemini":
        return None if provider_keys is None else provider_keys.gemini_api_key
    if provider == "anthropic":
        return None if provider_keys is None else provider_keys.anthropic_api_key
    return None if provider_keys is None else provider_keys.openrouter_api_key
