"""Tests for runtime configuration loading."""

from __future__ import annotations

import os

import pytest

import agora.config as config_module
from agora.config import get_config

_CONFIG_ENV_KEYS = (
    "AGORA_ENV_FILE",
    "ANTHROPIC_API_KEY",
    "AGORA_GEMINI_API_KEY",
    "GEMINI_API_KEY",
    "AGORA_GOOGLE_API_KEY",
    "GOOGLE_API_KEY",
    "AGORA_GEMINI_SECRET_NAME",
    "AGORA_GEMINI_SECRET_PROJECT",
    "AGORA_GEMINI_SECRET_VERSION",
    "AGORA_GEMINI_FLASH_THINKING_LEVEL",
    "AGORA_CLAUDE_MODEL",
    "AGORA_ANTHROPIC_THROTTLE_ENABLED",
    "AGORA_ANTHROPIC_REQUESTS_PER_MINUTE",
    "AGORA_ANTHROPIC_THROTTLE_WINDOW_SECONDS",
    "AGORA_ANTHROPIC_SECRET_NAME",
    "AGORA_ANTHROPIC_SECRET_PROJECT",
    "AGORA_ANTHROPIC_SECRET_VERSION",
    "AGORA_OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY",
    "AGORA_OPENROUTER_SECRET_NAME",
    "AGORA_OPENROUTER_SECRET_PROJECT",
    "AGORA_OPENROUTER_SECRET_VERSION",
    "AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED",
    "AGORA_KIMI_MODEL",
    "AGORA_KIMI_REASONING_EFFORT",
    "AGORA_KIMI_REASONING_EXCLUDE",
    "AGORA_KIMI_MAX_TOKENS",
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


def test_get_config_loads_dotenv_from_explicit_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Config should load dotenv from AGORA_ENV_FILE when provided."""

    shared_env = tmp_path / "shared.env"
    shared_env.write_text("OPENROUTER_API_KEY=shared-openrouter-key\n", encoding="utf-8")

    monkeypatch.setenv("AGORA_ENV_FILE", str(shared_env))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_OPENROUTER_API_KEY", raising=False)

    config = get_config()

    assert config.openrouter_api_key == "shared-openrouter-key"


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


def test_gemini_api_key_resolution_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gemini key should resolve from AGORA_GEMINI_API_KEY first, then fallbacks."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "primary-key")
    monkeypatch.setenv("GEMINI_API_KEY", "secondary-key")
    monkeypatch.setenv("GOOGLE_API_KEY", "tertiary-key")

    config = get_config()
    assert config.gemini_api_key == "primary-key"

    get_config.cache_clear()
    monkeypatch.delenv("AGORA_GEMINI_API_KEY", raising=False)
    config = get_config()
    assert config.gemini_api_key == "secondary-key"

    get_config.cache_clear()
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    config = get_config()
    assert config.gemini_api_key == "tertiary-key"


def test_gemini_api_key_falls_back_to_secret_manager(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gemini key should resolve from Secret Manager when env key is absent."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("AGORA_GOOGLE_API_KEY", "")
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    monkeypatch.setenv("AGORA_GEMINI_SECRET_NAME", "agora-gemini-api-key")
    monkeypatch.setenv("AGORA_GEMINI_SECRET_PROJECT", "demo-project")
    monkeypatch.setenv("AGORA_GEMINI_SECRET_VERSION", "latest")

    monkeypatch.setattr(
        config_module,
        "_load_secret_manager_value",
        lambda project_id, secret_name, version: "gemini-sm-key",
    )

    config = get_config()

    assert config.gemini_api_key == "gemini-sm-key"


def test_explicit_gemini_key_wins_over_secret_manager(monkeypatch: pytest.MonkeyPatch) -> None:
    """Explicit Gemini key should bypass Secret Manager lookup."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "explicit-gemini-key")
    monkeypatch.setenv("AGORA_GEMINI_SECRET_NAME", "agora-gemini-api-key")
    monkeypatch.setenv("AGORA_GEMINI_SECRET_PROJECT", "demo-project")

    def _unexpected(*args, **kwargs):  # pragma: no cover
        raise AssertionError("Secret Manager should not be called when Gemini key is explicit")

    monkeypatch.setattr(config_module, "_load_secret_manager_value", _unexpected)

    config = get_config()

    assert config.gemini_api_key == "explicit-gemini-key"


def test_gemini_flash_thinking_level_defaults_and_can_be_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flash callers should default to minimal thinking, with an explicit opt-out."""

    monkeypatch.delenv("AGORA_GEMINI_FLASH_THINKING_LEVEL", raising=False)
    get_config.cache_clear()
    config = get_config()
    assert config.gemini_flash_thinking_level == "minimal"

    get_config.cache_clear()
    monkeypatch.setenv("AGORA_GEMINI_FLASH_THINKING_LEVEL", "")
    config = get_config()
    assert config.gemini_flash_thinking_level is None


def test_openrouter_api_key_resolution_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    """OpenRouter key should resolve from AGORA_OPENROUTER_API_KEY first."""

    monkeypatch.setenv("AGORA_OPENROUTER_API_KEY", "primary-or-key")
    monkeypatch.setenv("OPENROUTER_API_KEY", "secondary-or-key")

    config = get_config()
    assert config.openrouter_api_key == "primary-or-key"

    get_config.cache_clear()
    monkeypatch.delenv("AGORA_OPENROUTER_API_KEY", raising=False)
    config = get_config()
    assert config.openrouter_api_key == "secondary-or-key"


def test_openrouter_api_key_deduplicates_repeated_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Repeated identical OpenRouter token should collapse to one valid key."""

    valid = "sk-or-v1-abc123"
    monkeypatch.setenv("OPENROUTER_API_KEY", valid + valid)

    config = get_config()

    assert config.openrouter_api_key == valid


def test_kimi_reasoning_defaults_and_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """Kimi reasoning controls should default sanely and remain overrideable."""

    monkeypatch.delenv("AGORA_KIMI_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("AGORA_KIMI_REASONING_EXCLUDE", raising=False)
    monkeypatch.delenv("AGORA_KIMI_MAX_TOKENS", raising=False)

    config = get_config()
    assert config.kimi_reasoning_effort == "low"
    assert config.kimi_reasoning_exclude is True
    assert config.kimi_max_tokens == 512

    get_config.cache_clear()
    monkeypatch.setenv("AGORA_KIMI_REASONING_EFFORT", "medium")
    monkeypatch.setenv("AGORA_KIMI_REASONING_EXCLUDE", "false")
    monkeypatch.setenv("AGORA_KIMI_MAX_TOKENS", "256")

    config = get_config()
    assert config.kimi_reasoning_effort == "medium"
    assert config.kimi_reasoning_exclude is False
    assert config.kimi_max_tokens == 256


def test_openrouter_api_key_falls_back_to_secret_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OpenRouter key should resolve from Secret Manager when env key is absent."""

    monkeypatch.setenv("AGORA_OPENROUTER_API_KEY", "")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_NAME", "agora-openrouter-api-key")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_PROJECT", "demo-project")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_VERSION", "latest")

    monkeypatch.setattr(
        config_module,
        "_load_secret_manager_value",
        lambda project_id, secret_name, version: "openrouter-sm-key",
    )

    config = get_config()

    assert config.openrouter_api_key == "openrouter-sm-key"


def test_malformed_openrouter_env_key_falls_back_to_secret_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Duplicated-prefix OpenRouter env values should defer to Secret Manager."""

    monkeypatch.setenv("AGORA_OPENROUTER_API_KEY", "")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-sk-or-v1-corrupted")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_NAME", "agora-openrouter-api-key")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_PROJECT", "demo-project")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_VERSION", "latest")

    monkeypatch.setattr(
        config_module,
        "_load_secret_manager_value",
        lambda project_id, secret_name, version: "openrouter-sm-key",
    )

    config = get_config()

    assert config.openrouter_api_key == "openrouter-sm-key"


def test_explicit_openrouter_key_wins_over_secret_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Explicit OpenRouter key should bypass Secret Manager lookup."""

    monkeypatch.setenv("AGORA_OPENROUTER_API_KEY", "explicit-openrouter-key")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_NAME", "agora-openrouter-api-key")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_PROJECT", "demo-project")

    def _unexpected(*args, **kwargs):  # pragma: no cover
        raise AssertionError("Secret Manager should not be called when OpenRouter key is explicit")

    monkeypatch.setattr(config_module, "_load_secret_manager_value", _unexpected)

    config = get_config()

    assert config.openrouter_api_key == "explicit-openrouter-key"


def test_openrouter_legacy_x_title_toggle_parses_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Header compatibility toggle should parse standard boolean env values."""

    monkeypatch.setenv("AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED", "false")
    config = get_config()
    assert config.openrouter_legacy_x_title_enabled is False

    get_config.cache_clear()
    monkeypatch.setenv("AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED", "true")
    config = get_config()
    assert config.openrouter_legacy_x_title_enabled is True
