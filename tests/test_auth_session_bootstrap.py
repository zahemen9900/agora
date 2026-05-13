from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from api import auth
from api.routes import auth_session
from api.store_local import LocalTaskStore


def _jwt_user() -> auth.AuthenticatedUser:
    return auth.AuthenticatedUser(
        auth_method="jwt",
        workspace_id="user-1",
        user_id="user-1",
        email="user1@example.com",
        display_name="User One",
        scopes=["tasks:read", "tasks:write"],
    )


@pytest.mark.asyncio
async def test_auth_me_self_heals_missing_workspace_record(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "auth-me-self-heal"))
    auth._store = store
    try:
        user = _jwt_user()
        await store.upsert_user(user.id, user.email, user.display_name)

        payload = await auth_session.auth_me(user)

        assert payload.principal.workspace_id == user.workspace_id
        assert payload.workspace.id == user.workspace_id
        repaired_workspace = await store.get_workspace(user.workspace_id)
        assert repaired_workspace is not None
        assert repaired_workspace["owner_user_id"] == user.id
    finally:
        auth._store = None


def test_auth_config_returns_resolved_backend_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "workos_client_id", "client_123")
    monkeypatch.setattr(
        auth.settings,
        "workos_authkit_domain",
        "healthy-flare-22-staging.authkit.app",
    )
    monkeypatch.setattr(auth.settings, "auth_issuer", "https://api.workos.com")
    monkeypatch.setattr(auth.settings, "auth_audience", "client_123")
    monkeypatch.setattr(
        auth.settings,
        "auth_jwks_url",
        "https://api.workos.com/sso/jwks/client_123",
    )

    payload = asyncio.run(auth_session.auth_config())

    assert payload.workos_client_id == "client_123"
    assert payload.workos_authkit_domain == "https://healthy-flare-22-staging.authkit.app"
    assert payload.auth_issuer == "https://api.workos.com"
    assert payload.auth_audience == "client_123"
    assert payload.auth_jwks_url == "https://api.workos.com/sso/jwks/client_123"
