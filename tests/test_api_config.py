from __future__ import annotations

import pytest

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
