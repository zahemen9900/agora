"""Tests for runtime configuration loading."""

from __future__ import annotations

import os

import pytest

import agora.config as config_module
from agora.config import get_config

_CONFIG_ENV_KEYS = (
    "ANTHROPIC_API_KEY",
    "AGORA_CLAUDE_MODEL",
    "AGORA_ANTHROPIC_THROTTLE_ENABLED",
    "AGORA_ANTHROPIC_REQUESTS_PER_MINUTE",
    "AGORA_ANTHROPIC_THROTTLE_WINDOW_SECONDS",
    "AGORA_ANTHROPIC_SECRET_NAME",
    "AGORA_ANTHROPIC_SECRET_PROJECT",
    "AGORA_ANTHROPIC_SECRET_VERSION",
    "GOOGLE_CLOUD_PROJECT",
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


def test_anthropic_api_key_falls_back_to_secret_manager(monkeypatch: pytest.MonkeyPatch) -> None:
    """Config should resolve Anthropic key from Secret Manager when env key is absent."""

    # Keep key present-but-empty so dotenv autoload cannot overwrite it.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("AGORA_ANTHROPIC_SECRET_NAME", "agora-anthropic-api-key")
    monkeypatch.setenv("AGORA_ANTHROPIC_SECRET_PROJECT", "demo-project")
    monkeypatch.setenv("AGORA_ANTHROPIC_SECRET_VERSION", "latest")

    monkeypatch.setattr(
        config_module,
        "_load_secret_manager_value",
        lambda project_id, secret_name, version: "sm-key",
    )

    config = get_config()

    assert config.anthropic_api_key == "sm-key"


def test_explicit_api_key_wins_over_secret_manager(monkeypatch: pytest.MonkeyPatch) -> None:
    """Explicit ANTHROPIC_API_KEY should bypass Secret Manager lookup."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "explicit-key")
    monkeypatch.setenv("AGORA_ANTHROPIC_SECRET_NAME", "agora-anthropic-api-key")
    monkeypatch.setenv("AGORA_ANTHROPIC_SECRET_PROJECT", "demo-project")

    def _unexpected(*args, **kwargs):  # pragma: no cover
        raise AssertionError("Secret Manager should not be called when key is explicit")

    monkeypatch.setattr(config_module, "_load_secret_manager_value", _unexpected)

    config = get_config()

    assert config.anthropic_api_key == "explicit-key"
