"""Tests for dependency-aware readiness."""

from __future__ import annotations

import pytest

from api.routes import health


class _Coordination:
    def __init__(self, ok: bool) -> None:
        self.ok = ok

    async def ping(self) -> bool:
        return self.ok


class _S3:
    def __init__(self, ok: bool) -> None:
        self.ok = ok

    def head_bucket(self, *, Bucket: str) -> None:  # noqa: N803
        if not self.ok:
            raise RuntimeError("unavailable")


@pytest.mark.asyncio
async def test_readiness_reports_ready_when_dependencies_are_healthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(health.settings, "environment", "production")
    monkeypatch.setattr(health.settings, "api_key_pepper", "pepper")
    monkeypatch.setattr(health.settings, "sandbox_runner_bearer_token", "runner-token")
    monkeypatch.setattr(health, "get_coordination_backend", lambda: _Coordination(True))
    monkeypatch.setattr(health, "resolve_storage_settings", lambda _: ("s3", "bucket"))
    monkeypatch.setattr(health.boto3, "client", lambda *_, **__: _S3(True))

    response = await health.readiness_check()

    assert response.status_code == 200
    assert b"ready" in response.body


@pytest.mark.asyncio
async def test_readiness_reports_unavailable_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(health.settings, "environment", "production")
    monkeypatch.setattr(health.settings, "api_key_pepper", "pepper")
    monkeypatch.setattr(health.settings, "sandbox_runner_bearer_token", "runner-token")
    monkeypatch.setattr(health, "get_coordination_backend", lambda: _Coordination(False))
    monkeypatch.setattr(health, "resolve_storage_settings", lambda _: ("s3", "bucket"))
    monkeypatch.setattr(health.boto3, "client", lambda *_, **__: _S3(True))

    response = await health.readiness_check()

    assert response.status_code == 503
    assert b"not_ready" in response.body
