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


def test_settings_accept_storage_backend_and_s3_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGORA_STORAGE_BACKEND", "s3")
    monkeypatch.setenv("AGORA_S3_BUCKET", "agora-data")
    monkeypatch.setenv("AWS_REGION", "eu-west-1")

    settings = Settings()

    assert settings.storage_backend == "s3"
    assert settings.s3_bucket == "agora-data"
    assert settings.aws_region == "eu-west-1"


def test_settings_storage_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGORA_STORAGE_BACKEND", raising=False)
    monkeypatch.delenv("STORAGE_BACKEND", raising=False)
    monkeypatch.delenv("AGORA_S3_BUCKET", raising=False)
    monkeypatch.delenv("S3_BUCKET", raising=False)
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AGORA_AWS_REGION", raising=False)

    settings = Settings()

    assert settings.storage_backend == "gcs"
    assert settings.s3_bucket == ""
    assert settings.aws_region == "us-east-1"
