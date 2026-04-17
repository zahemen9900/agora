from __future__ import annotations

from pathlib import Path

import pytest

import api.config as config_module
from api.config import Settings


@pytest.fixture(autouse=True)
def clear_helius_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HELIUS_RPC_URL", raising=False)
    monkeypatch.delenv("HELIUS_URL", raising=False)


def test_settings_accepts_legacy_helius_url_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HELIUS_URL", "https://devnet.helius-rpc.com/?api-key=legacy")

    settings = Settings()

    assert settings.helius_rpc_url == "https://devnet.helius-rpc.com/?api-key=legacy"


def test_settings_prefers_helius_rpc_url_over_legacy_alias(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HELIUS_URL", "https://devnet.helius-rpc.com/?api-key=legacy")
    monkeypatch.setenv("HELIUS_RPC_URL", "https://devnet.helius-rpc.com/?api-key=preferred")

    settings = Settings()

    assert settings.helius_rpc_url == "https://devnet.helius-rpc.com/?api-key=preferred"


def test_settings_env_files_are_repo_root_relative() -> None:
    env_files = Settings.model_config.get("env_file")
    expected_root = Path(config_module.__file__).resolve().parents[1]

    assert env_files == (
        str(expected_root / ".env"),
        str(expected_root / ".env.development"),
    )
