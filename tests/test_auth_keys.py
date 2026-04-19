from __future__ import annotations

import pytest
from fastapi import HTTPException

from api import auth_keys
from api.auth import AuthenticatedUser
from api.auth_keys import DEFAULT_API_KEY_SCOPES
from api.models import ApiKeyCreateRequest
from api.routes import api_keys as api_key_routes
from api.store_local import LocalTaskStore


def _human_user() -> AuthenticatedUser:
    return AuthenticatedUser(
        auth_method="jwt",
        workspace_id="user-1",
        user_id="user-1",
        email="user1@example.com",
        display_name="User One",
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )


def test_hash_api_key_secret_uses_dev_fallback_when_pepper_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth_keys.settings, "environment", "development")
    monkeypatch.setattr(auth_keys.settings, "api_key_pepper", "")

    digest_one = auth_keys.hash_api_key_secret("secret-one")
    digest_two = auth_keys.hash_api_key_secret("secret-one")
    digest_three = auth_keys.hash_api_key_secret("secret-two")

    assert digest_one == digest_two
    assert digest_one != digest_three


def test_hash_api_key_secret_requires_pepper_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth_keys.settings, "environment", "production")
    monkeypatch.setattr(auth_keys.settings, "api_key_pepper", "")

    with pytest.raises(RuntimeError, match="AGORA_API_KEY_PEPPER"):
        auth_keys.hash_api_key_secret("secret")


@pytest.mark.asyncio
async def test_create_api_key_succeeds_without_pepper_in_development(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "api-key-dev-fallback"))
    user = _human_user()
    await store.ensure_personal_workspace(user.user_id or "", user.email, user.display_name)

    monkeypatch.setattr(api_key_routes, "get_auth_store", lambda: store)
    monkeypatch.setattr(auth_keys.settings, "environment", "development")
    monkeypatch.setattr(auth_keys.settings, "api_key_pepper", "")

    created = await api_key_routes.create_api_key(ApiKeyCreateRequest(name="ci"), user)

    assert created.api_key.startswith("agora_test_")


@pytest.mark.asyncio
async def test_create_api_key_returns_503_without_pepper_in_production(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "api-key-prod-missing-pepper"))
    user = _human_user()
    await store.ensure_personal_workspace(user.user_id or "", user.email, user.display_name)

    monkeypatch.setattr(api_key_routes, "get_auth_store", lambda: store)
    monkeypatch.setattr(auth_keys.settings, "environment", "production")
    monkeypatch.setattr(auth_keys.settings, "api_key_pepper", "")

    with pytest.raises(HTTPException) as exc_info:
        await api_key_routes.create_api_key(ApiKeyCreateRequest(name="ci"), user)

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == "API key creation is not configured"
