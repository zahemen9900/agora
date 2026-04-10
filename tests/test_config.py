"""Tests for runtime configuration loading."""

from __future__ import annotations

import os

import pytest

from agora.config import get_config

_CONFIG_ENV_KEYS = (
    "ANTHROPIC_API_KEY",
    "AGORA_CLAUDE_MODEL",
    "AGORA_ANTHROPIC_THROTTLE_ENABLED",
    "AGORA_ANTHROPIC_REQUESTS_PER_MINUTE",
    "AGORA_ANTHROPIC_THROTTLE_WINDOW_SECONDS",
)


@pytest.fixture(autouse=True)
def clear_config_cache():
    """Reset cached config between tests."""

    original_env = {key: os.environ.get(key) for key in _CONFIG_ENV_KEYS}
    get_config.cache_clear()
    yield
    get_config.cache_clear()
    for key, value in original_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def test_get_config_loads_dotenv_from_current_working_directory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Config should load `.env` values when the shell has not exported them."""

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_CLAUDE_MODEL", raising=False)
    (tmp_path / ".env").write_text(
        "ANTHROPIC_API_KEY=file-key\nAGORA_CLAUDE_MODEL=claude-haiku-test\n",
        encoding="utf-8",
    )

    config = get_config()

    assert config.anthropic_api_key == "file-key"
    assert config.claude_model == "claude-haiku-test"


def test_exported_environment_wins_over_dotenv(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Explicitly exported environment variables should take precedence over `.env`."""

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "exported-key")
    (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=file-key\n", encoding="utf-8")

    config = get_config()

    assert config.anthropic_api_key == "exported-key"
    assert os.environ["ANTHROPIC_API_KEY"] == "exported-key"


def test_anthropic_throttle_settings_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Throttle controls should parse from environment variables."""

    monkeypatch.setenv("AGORA_ANTHROPIC_THROTTLE_ENABLED", "false")
    monkeypatch.setenv("AGORA_ANTHROPIC_REQUESTS_PER_MINUTE", "7")
    monkeypatch.setenv("AGORA_ANTHROPIC_THROTTLE_WINDOW_SECONDS", "30")

    config = get_config()

    assert config.anthropic_throttle_enabled is False
    assert config.anthropic_requests_per_minute == 7
    assert config.anthropic_throttle_window_seconds == 30.0
