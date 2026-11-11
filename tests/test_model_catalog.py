"""Tests for the current hosted model catalog."""

from __future__ import annotations

from agora.runtime.model_catalog import resolve_model_catalog_entry


def test_current_hosted_models_are_cataloged() -> None:
    expected = {
        "claude-haiku-5-5",
        "deepseek/deepseek-v4.1-flash-1017",
        "z-ai/glm-5.3-flash",
        "qwen/qwen3.7-flash",
        "openai/gpt-6-luna",
    }

    for model_id in expected:
        assert resolve_model_catalog_entry(model_id) is not None


def test_hidden_models_are_not_selectable() -> None:
    gpt6 = resolve_model_catalog_entry("openai/gpt-6-luna")
    kimi = resolve_model_catalog_entry("moonshotai/kimi-k2-thinking")

    assert gpt6 is not None and gpt6.selectable is False
    assert kimi is not None and kimi.selectable is False
