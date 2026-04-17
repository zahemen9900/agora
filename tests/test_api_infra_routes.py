from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import ValidationError

from agora.runtime.hasher import TranscriptHasher
from agora.types import DeliberationResult, MechanismType
from api import auth
from api.auth import AuthenticatedUser
from api.auth_keys import DEFAULT_API_KEY_SCOPES, build_api_key_token, hash_api_key_secret
from api.coordination import (
    InMemoryCoordinationBackend,
    StreamTicketRecord,
    reset_coordination_backend_cache_for_tests,
)
from api.main import app
from api.models import ApiKeyCreateRequest, TaskCreateRequest
from api.routes import api_keys as api_key_routes
from api.routes import auth_session
from api.routes import tasks as task_routes
from api.routes import webhooks as webhook_routes
from api.store_local import LocalTaskStore
from api.streaming import DeliberationStream, get_stream_manager, reset_stream_manager_for_tests
from tests.helpers import make_selection


def _override_user() -> AuthenticatedUser:
    return AuthenticatedUser(
        auth_method="jwt",
        workspace_id="user-1",
        user_id="user-1",
        email="user1@example.com",
        display_name="User One",
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )


@pytest.fixture(autouse=True)
def isolated_auth_store(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(auth.settings, "api_key_pepper", "test-pepper")
    monkeypatch.setattr(auth, "_store", LocalTaskStore(data_dir=str(tmp_path / "auth-store")))


@pytest.fixture(autouse=True)
async def isolated_coordination_state() -> AsyncIterator[None]:
    reset_coordination_backend_cache_for_tests()
    with suppress(RuntimeError):
        await task_routes._reset_coordination_state_for_tests()
    await reset_stream_manager_for_tests()
    yield
    reset_coordination_backend_cache_for_tests()
    with suppress(RuntimeError):
        await task_routes._reset_coordination_state_for_tests()
    await reset_stream_manager_for_tests()


class _FakeSelectionOnlyOrchestrator:
    def __init__(self, agent_count: int):
        self.agent_count = agent_count
        self.selector = self

    async def select(self, task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")


def _signed_webhook_headers(
    secret: str,
    body: bytes,
    *,
    timestamp: int | None = None,
    signature_override: str | None = None,
) -> dict[str, str]:
    ts = int(datetime.now(UTC).timestamp()) if timestamp is None else timestamp
    if signature_override is None:
        signed_payload = f"{ts}.".encode() + body
        digest = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
        signature = f"sha256={digest}"
    else:
        signature = signature_override
    return {
        "content-type": "application/json",
        "x-agora-timestamp": str(ts),
        "x-agora-signature": signature,
    }


@pytest.fixture
async def client(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> AsyncIterator[httpx.AsyncClient]:
    data_dir = str(tmp_path / "data")
    task_routes._store = LocalTaskStore(data_dir=data_dir)
    await task_routes._reset_coordination_state_for_tests()
    await reset_stream_manager_for_tests()
    app.dependency_overrides[auth.get_current_user] = _override_user

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client

    app.dependency_overrides.clear()
    task_routes._store = None
    await task_routes._reset_coordination_state_for_tests()
    await reset_stream_manager_for_tests()


@pytest.mark.asyncio
async def test_jwt_auth_extracts_claims(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_decode(_raw_token: str) -> dict[str, str]:
        return {
            "sub": "user-123",
            "email": "josh@example.com",
            "name": "Josh",
        }

    monkeypatch.setattr(auth, "_decode_verified_token", fake_decode)

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dummy")
    user = await auth.get_current_user(creds)

    assert user.id == "user-123"
    assert user.workspace_id == "user-123"
    assert user.email == "josh@example.com"
    assert user.display_name == "Josh"


def test_auth_audiences_collects_and_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth.settings, "auth_audience", "aud-primary")
    monkeypatch.setattr(auth.settings, "workos_client_id", "client-123")
    monkeypatch.setattr(auth.settings, "auth_audiences", "aud-secondary, aud-primary")

    assert auth._auth_audiences() == ["aud-primary", "client-123", "aud-secondary"]


def test_auth_jwks_url_uses_workos_session_jwks_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_jwks_url", "")
    monkeypatch.setattr(auth.settings, "workos_client_id", "client-123")

    assert auth._auth_jwks_url("https://api.workos.com") == "https://api.workos.com/sso/jwks/client-123"


def test_auth_jwks_candidates_include_explicit_and_derived(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_jwks_url", "https://custom.example/jwks")
    monkeypatch.setattr(auth.settings, "workos_client_id", "client-123")

    assert auth._auth_jwks_candidates(
        ["https://api.workos.com", "https://tenant.authkit.app"]
    ) == [
        "https://custom.example/jwks",
        "https://api.workos.com/sso/jwks/client-123",
        "https://tenant.authkit.app/oauth2/jwks",
    ]


def test_decode_verified_token_accepts_trailing_slash_issuer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_issuer", "https://issuer.example")
    monkeypatch.setattr(auth.settings, "auth_jwks_url", "https://issuer.example/oauth2/jwks")
    monkeypatch.setattr(auth.settings, "auth_audience", "aud-primary")
    monkeypatch.setattr(auth.settings, "auth_audiences", "")

    class _SigningKey:
        key = "test-signing-key"

    class _Client:
        @staticmethod
        def get_signing_key_from_jwt(_token: str) -> _SigningKey:
            return _SigningKey()

    monkeypatch.setattr(auth, "_jwks_client", lambda _url: _Client())

    issuers_seen: list[str] = []

    def fake_decode(
        raw_token: str,
        *,
        key: str,
        algorithms: list[str],
        issuer: str,
        audience: list[str],
    ) -> dict[str, str]:
        del raw_token, key, algorithms, audience
        issuers_seen.append(issuer)
        if issuer == "https://issuer.example":
            raise jwt.InvalidIssuerError("issuer without trailing slash rejected")
        return {
            "sub": "user-123",
            "email": "josh@example.com",
            "name": "Josh",
        }

    monkeypatch.setattr(auth.jwt, "decode", fake_decode)

    payload = auth._decode_verified_token("dummy")

    assert payload["sub"] == "user-123"
    assert issuers_seen == ["https://issuer.example", "https://issuer.example/"]


def test_decode_verified_token_relaxes_audience_in_development(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "environment", "development")
    monkeypatch.setattr(auth.settings, "auth_issuer", "https://issuer.example")
    monkeypatch.setattr(auth.settings, "auth_jwks_url", "https://issuer.example/oauth2/jwks")
    monkeypatch.setattr(auth.settings, "auth_audience", "aud-configured")
    monkeypatch.setattr(auth.settings, "auth_audiences", "")

    class _SigningKey:
        key = "test-signing-key"

    class _Client:
        @staticmethod
        def get_signing_key_from_jwt(_token: str) -> _SigningKey:
            return _SigningKey()

    monkeypatch.setattr(auth, "_jwks_client", lambda _url: _Client())

    decode_audiences_seen: list[tuple[str, ...]] = []

    def fake_decode(
        raw_token: str,
        *,
        key: str | None = None,
        algorithms: list[str] | None = None,
        issuer: str | None = None,
        audience: list[str] | None = None,
        options: dict[str, bool] | None = None,
    ) -> dict[str, str]:
        del raw_token, key, algorithms, issuer
        if options is not None:
            return {
                "sub": "user-123",
                "email": "josh@example.com",
                "name": "Josh",
                "iss": "https://issuer.example",
                "aud": "aud-token",
            }

        candidates = tuple(audience or [])
        decode_audiences_seen.append(candidates)
        if "aud-token" in candidates:
            return {
                "sub": "user-123",
                "email": "josh@example.com",
                "name": "Josh",
            }
        raise jwt.InvalidAudienceError("audience mismatch")

    monkeypatch.setattr(auth.jwt, "decode", fake_decode)

    payload = auth._decode_verified_token("dummy")

    assert payload["sub"] == "user-123"
    assert any("aud-token" in audiences for audiences in decode_audiences_seen)


def test_decode_verified_token_allows_session_token_without_audience(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "environment", "production")
    monkeypatch.setattr(auth.settings, "auth_issuer", "https://api.workos.com")
    monkeypatch.setattr(auth.settings, "workos_authkit_domain", "")
    monkeypatch.setattr(auth.settings, "auth_jwks_url", "https://api.workos.com/sso/jwks/client-123")
    monkeypatch.setattr(auth.settings, "auth_audience", "client-123")
    monkeypatch.setattr(auth.settings, "auth_audiences", "")

    class _SigningKey:
        key = "test-signing-key"

    class _Client:
        @staticmethod
        def get_signing_key_from_jwt(_token: str) -> _SigningKey:
            return _SigningKey()

    monkeypatch.setattr(auth, "_jwks_client", lambda _url: _Client())

    verify_options_seen: list[dict[str, bool] | None] = []

    def fake_decode(raw_token: str, **kwargs: object) -> dict[str, object]:
        del raw_token
        options = kwargs.get("options")
        if isinstance(options, dict) and options.get("verify_signature") is False:
            return {
                "iss": "https://api.workos.com",
                "sub": "user-123",
                "sid": "session_123",
            }

        verify_options_seen.append(options if isinstance(options, dict) else None)
        if isinstance(options, dict) and options.get("verify_aud") is False:
            return {
                "sub": "user-123",
                "email": "josh@example.com",
                "name": "Josh",
            }

        raise jwt.InvalidAudienceError("audience should not be required for session token")

    monkeypatch.setattr(auth.jwt, "decode", fake_decode)

    payload = auth._decode_verified_token("dummy")

    assert payload["sub"] == "user-123"
    assert {"verify_aud": False} in verify_options_seen


def test_decode_verified_token_accepts_known_workos_claim_issuer_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "environment", "production")
    monkeypatch.setattr(auth.settings, "auth_issuer", "https://healthy-flare-22-staging.authkit.app")
    monkeypatch.setattr(auth.settings, "workos_authkit_domain", "")
    monkeypatch.setattr(auth.settings, "auth_jwks_url", "")
    monkeypatch.setattr(auth.settings, "auth_audience", "client-123")
    monkeypatch.setattr(auth.settings, "auth_audiences", "")
    monkeypatch.setattr(auth.settings, "workos_client_id", "client-123")

    class _SigningKey:
        key = "test-signing-key"

    jwks_urls_seen: list[str] = []

    class _Client:
        def __init__(self, jwks_url: str) -> None:
            self._jwks_url = jwks_url

        def get_signing_key_from_jwt(self, _token: str) -> _SigningKey:
            jwks_urls_seen.append(self._jwks_url)
            if "healthy-flare-22-staging.authkit.app" in self._jwks_url:
                raise jwt.PyJWKClientError("kid not found")
            return _SigningKey()

    monkeypatch.setattr(auth, "_jwks_client", lambda url: _Client(url))

    def fake_decode(raw_token: str, **kwargs: object) -> dict[str, object]:
        del raw_token
        options = kwargs.get("options")
        if isinstance(options, dict) and options.get("verify_signature") is False:
            return {
                "iss": "https://api.workos.com",
                "sub": "user-123",
                "sid": "session_123",
            }

        issuer = str(kwargs.get("issuer", ""))
        verify_options = kwargs.get("options")
        if issuer in {"https://api.workos.com", "https://api.workos.com/"} and isinstance(
            verify_options,
            dict,
        ) and verify_options.get("verify_aud") is False:
            return {
                "sub": "user-123",
                "email": "josh@example.com",
                "name": "Josh",
            }
        raise jwt.InvalidIssuerError("issuer mismatch")

    monkeypatch.setattr(auth.jwt, "decode", fake_decode)

    payload = auth._decode_verified_token("dummy")

    assert payload["sub"] == "user-123"
    assert "https://api.workos.com/sso/jwks/client-123" in jwks_urls_seen


@pytest.mark.asyncio
async def test_auth_allows_demo_fallback_when_auth_not_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", False)
    monkeypatch.setattr(auth.settings, "demo_mode", True)
    monkeypatch.setattr(auth.settings, "environment", "development")

    user = await auth.get_current_user(None)

    assert user.id == "demo-user"
    assert user.workspace_id == "demo-user"
    assert user.email == "demo@example.com"


@pytest.mark.asyncio
async def test_auth_requires_token_when_auth_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", True)
    monkeypatch.setattr(auth.settings, "demo_mode", False)

    with pytest.raises(HTTPException) as exc_info:
        await auth.get_current_user(None)

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Missing bearer token"


@pytest.mark.asyncio
async def test_api_keys_requires_bearer_when_demo_auth_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", True)
    monkeypatch.setattr(auth.settings, "demo_mode", False)
    monkeypatch.setattr(auth.settings, "environment", "development")
    app.dependency_overrides.clear()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api-keys/",
            json={"name": "phase2-demo"},
        )

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing bearer token"


@pytest.mark.asyncio
async def test_auth_disables_demo_fallback_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", False)
    monkeypatch.setattr(auth.settings, "demo_mode", True)
    monkeypatch.setattr(auth.settings, "environment", "production")

    with pytest.raises(HTTPException) as exc_info:
        await auth.get_current_user(None)

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Missing bearer token"


@pytest.mark.asyncio
async def test_auth_surfaces_misconfiguration_when_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", True)
    monkeypatch.setattr(auth.settings, "demo_mode", False)

    def fail_decode(_raw_token: str) -> dict[str, str]:
        raise RuntimeError("Auth verification is not configured")

    monkeypatch.setattr(auth, "_decode_verified_token", fail_decode)

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dummy")
    with pytest.raises(HTTPException) as exc_info:
        await auth.get_current_user(creds)

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Authentication error"


@pytest.mark.asyncio
async def test_auth_rejects_unsafe_sub_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", True)
    monkeypatch.setattr(auth.settings, "demo_mode", False)

    def fake_decode(_raw_token: str) -> dict[str, str]:
        return {
            "sub": "../user-123",
            "email": "josh@example.com",
            "name": "Josh",
        }

    monkeypatch.setattr(auth, "_decode_verified_token", fake_decode)

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dummy")
    with pytest.raises(HTTPException) as exc_info:
        await auth.get_current_user(creds)

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Token has invalid sub claim"


@pytest.mark.asyncio
async def test_health_route_is_public(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["service"] == "agora-api"


@pytest.mark.asyncio
async def test_cors_allows_vercel_and_localhost_origins(client: httpx.AsyncClient) -> None:
    for origin in (
        "https://agora-bay-seven.vercel.app",
        "http://localhost:5173",
    ):
        response = await client.options(
            "/tasks/",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )

        assert response.status_code == 200
        assert response.headers.get("access-control-allow-origin") == origin


@pytest.mark.asyncio
async def test_cors_denies_unlisted_origin(client: httpx.AsyncClient) -> None:
    response = await client.options(
        "/tasks/",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_task_routes_import_without_gcs_credentials() -> None:
    env = os.environ.copy()
    env["GOOGLE_CLOUD_PROJECT"] = "test-project"
    env["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/nonexistent-agora-creds.json"
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from api.routes import tasks; print(tasks._store is None)",
        ],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "True"


@pytest.mark.asyncio
async def test_tasks_route_rejects_query_token_auth(tmp_path: Path) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "query-token-data"))
    transport = httpx.ASGITransport(app=app)

    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/tasks/?token=fake-query-token")
    finally:
        task_routes._store = None

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing bearer token"


@pytest.mark.asyncio
async def test_create_list_get_task_with_local_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(
                task="Is this deterministic?",
                agent_count=3,
                stakes=0.0,
            ),
            _override_user(),
        )
        task_id = create.task_id
        assert len(task_id) == 64

        listing = await task_routes.list_tasks(_override_user())
        assert len(listing) == 1
        assert listing[0].task_id == task_id

        fetched = await task_routes.get_task_status(task_id, _override_user())
        assert fetched.status == "pending"
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_create_task_rejects_unsupported_mechanism_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "unsupported-override-data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        with pytest.raises(ValidationError) as exc_info:
            TaskCreateRequest(
                task="force unsupported override",
                agent_count=3,
                stakes=0.0,
                mechanism_override="delphi",
            )
    finally:
        task_routes._store = None

    assert "Input should be 'debate' or 'vote'" in str(exc_info.value)


@pytest.mark.asyncio
async def test_create_task_rate_limit_returns_429(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
    monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)
    monkeypatch.setattr(task_routes.settings, "task_create_rate_limit_per_minute", 1)

    first = await client.post(
        "/tasks/",
        json={"task": "first create", "agent_count": 3, "stakes": 0.0},
    )
    second = await client.post(
        "/tasks/",
        json={"task": "second create", "agent_count": 3, "stakes": 0.0},
    )

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.json()["detail"] == "Task creation rate limit exceeded"
    assert second.headers["Retry-After"] != ""


@pytest.mark.asyncio
async def test_create_task_rejects_unsupported_forced_mechanism_configuration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "unsupported-forced-data"))
    try:
        monkeypatch.setattr(task_routes.settings, "api_force_mechanism", "delphi")
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.create_task(
                TaskCreateRequest(
                    task="force unsupported from env",
                    agent_count=3,
                    stakes=0.0,
                ),
                _override_user(),
            )
    finally:
        task_routes._store = None

    assert exc_info.value.status_code == 500
    assert "Supported mechanisms: debate, vote" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_run_task_rejects_unsupported_persisted_mechanism(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "unsupported-persisted-data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes.settings, "api_force_mechanism", "")
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="persisted unsupported", agent_count=3, stakes=0.0),
            _override_user(),
        )

        store = task_routes._store
        assert store is not None
        task = await store.get_task("user-1", create.task_id)
        assert task is not None
        task["mechanism"] = "delphi"
        task["mechanism_override"] = None
        await store.save_task("user-1", create.task_id, task)

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(create.task_id, _override_user())

        refreshed = await store.get_task("user-1", create.task_id)
        assert refreshed is not None
    finally:
        task_routes._store = None

    assert exc_info.value.status_code == 409
    assert "Supported mechanisms: debate, vote" in str(exc_info.value.detail)
    assert refreshed["status"] == "pending"


@pytest.mark.asyncio
async def test_list_tasks_filters_records_with_foreign_created_by(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "list-filter-data"))
    user = _override_user()
    task_routes._store = store

    await store.upsert_user(user.id, user.email, user.display_name)
    await store.save_task(
        user.workspace_id,
        "task-foreign",
        {
            "task_id": "task-foreign",
            "task_text": "foreign record",
            "created_by": "someone-else",
            "mechanism": "vote",
            "status": "pending",
            "selector_reasoning": "Use vote.",
            "selector_reasoning_hash": "selector-hash",
            "selector_confidence": 0.9,
            "agent_count": 3,
            "payment_amount": 0.0,
            "payment_status": "none",
            "created_at": datetime.now(UTC).isoformat(),
            "events": [],
        },
    )

    try:
        listing = await task_routes.list_tasks(user)
    finally:
        task_routes._store = None

    assert listing == []


def test_task_create_request_rejects_oversized_task() -> None:
    with pytest.raises(ValidationError):
        TaskCreateRequest(task="x" * 12_001, agent_count=3, stakes=0.0)


@pytest.mark.asyncio
async def test_run_rejects_task_already_in_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "in-progress-data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="already running", agent_count=3, stakes=0.0),
            _override_user(),
        )
        store = task_routes._store
        assert store is not None
        task = await store.get_task("user-1", create.task_id)
        assert task is not None
        task["status"] = "in_progress"
        await store.save_task("user-1", create.task_id, task)

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(create.task_id, _override_user())
    finally:
        task_routes._store = None

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Task is already in progress"


@pytest.mark.asyncio
async def test_run_rejects_when_coordination_lock_is_held(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "run-lock-held-data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="lock held", agent_count=3, stakes=0.0),
            _override_user(),
        )
        run_key = task_routes._task_run_key("user-1", create.task_id)
        acquired = await task_routes._acquire_task_run_lock(run_key)
        assert acquired is not None

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(create.task_id, _override_user())

        await task_routes._release_task_run_lock(run_key, lease_id=acquired.lease_id)
    finally:
        task_routes._store = None
        await task_routes._reset_coordination_state_for_tests()

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Task is already in progress"


@pytest.mark.asyncio
async def test_run_task_rate_limit_returns_429(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "run-rate-limit-data"))
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    completed_result = DeliberationResult(
        task="run me",
        mechanism_used=MechanismType.DEBATE,
        mechanism_selection=selection,
        final_answer="Ship it.",
        confidence=0.88,
        quorum_reached=True,
        round_count=1,
        agent_count=3,
        mechanism_switches=0,
        merkle_root="receipt-root-rate-limit",
        transcript_hashes=["leaf-1", "leaf-2"],
        agent_models_used=[],
        convergence_history=[],
        locked_claims=[],
        total_tokens_used=42,
        total_latency_ms=12.5,
        timestamp=datetime.now(UTC),
    )

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return selection

    class _FakeRunOrchestrator:
        def __init__(self, agent_count: int):
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, mechanism_override
            if event_sink is not None:
                await event_sink(
                    "complete",
                    {"task": task, "mechanism": completed_result.mechanism_used.value},
                )
            return completed_result.model_copy(update={"task": task})

    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeRunOrchestrator)
        monkeypatch.setattr(task_routes.settings, "task_run_rate_limit_per_minute", 1)

        create_one = await task_routes.create_task(
            TaskCreateRequest(task="run-one", agent_count=3, stakes=0.0),
            _override_user(),
        )
        create_two = await task_routes.create_task(
            TaskCreateRequest(task="run-two", agent_count=3, stakes=0.0),
            _override_user(),
        )

        first = await task_routes.run_task(create_one.task_id, _override_user())
        assert first.final_answer == "Ship it."

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(create_two.task_id, _override_user())
    finally:
        task_routes._store = None
        await task_routes._reset_coordination_state_for_tests()

    assert exc_info.value.status_code == 429
    assert exc_info.value.detail == "Task run rate limit exceeded"
    assert exc_info.value.headers == {"Retry-After": "60"}


@pytest.mark.asyncio
async def test_workspace_concurrent_run_limit_returns_429(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "workspace-run-limit-data"))
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    release_run = asyncio.Event()
    first_run_started = asyncio.Event()
    completed_result = DeliberationResult(
        task="concurrent run",
        mechanism_used=MechanismType.DEBATE,
        mechanism_selection=selection,
        final_answer="Ship it.",
        confidence=0.88,
        quorum_reached=True,
        round_count=1,
        agent_count=3,
        mechanism_switches=0,
        merkle_root="receipt-root-concurrency",
        transcript_hashes=["leaf-1", "leaf-2"],
        agent_models_used=[],
        convergence_history=[],
        locked_claims=[],
        total_tokens_used=42,
        total_latency_ms=12.5,
        timestamp=datetime.now(UTC),
    )

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return selection

    class _BlockingRunOrchestrator:
        def __init__(self, agent_count: int):
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, mechanism_override
            first_run_started.set()
            await release_run.wait()
            if event_sink is not None:
                await event_sink(
                    "complete",
                    {"task": task, "mechanism": completed_result.mechanism_used.value},
                )
            return completed_result.model_copy(update={"task": task})

    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _BlockingRunOrchestrator)
        monkeypatch.setattr(task_routes.settings, "task_run_rate_limit_per_minute", 0)
        monkeypatch.setattr(task_routes.settings, "workspace_concurrent_task_runs", 1)

        create_one = await task_routes.create_task(
            TaskCreateRequest(task="run-one", agent_count=3, stakes=0.0),
            _override_user(),
        )
        create_two = await task_routes.create_task(
            TaskCreateRequest(task="run-two", agent_count=3, stakes=0.0),
            _override_user(),
        )

        first_task = asyncio.create_task(task_routes.run_task(create_one.task_id, _override_user()))
        await first_run_started.wait()

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(create_two.task_id, _override_user())

        release_run.set()
        first = await first_task
    finally:
        task_routes._store = None
        await task_routes._reset_coordination_state_for_tests()

    assert first.final_answer == "Ship it."
    assert exc_info.value.status_code == 429
    assert exc_info.value.detail == "Workspace concurrent task run limit exceeded"
    assert exc_info.value.headers == {"Retry-After": "1"}


@pytest.mark.asyncio
async def test_run_and_pay_use_bridge_and_surface_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    completed_result = DeliberationResult(
        task="run me",
        mechanism_used=MechanismType.DEBATE,
        mechanism_selection=selection,
        final_answer="Ship it.",
        confidence=0.88,
        quorum_reached=True,
        round_count=2,
        agent_count=5,
        mechanism_switches=0,
        merkle_root="receipt-root",
        transcript_hashes=["leaf-1", "leaf-2"],
        agent_models_used=[
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ],
        convergence_history=[],
        locked_claims=[],
        total_tokens_used=42,
        total_latency_ms=12.5,
        timestamp=datetime.now(UTC),
    )

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return selection

    class _FakeOrchestrator:
        def __init__(self, agent_count: int):
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, mechanism_override
            if event_sink is not None:
                await event_sink(
                    "complete",
                    {
                        "task": task,
                        "mechanism": completed_result.mechanism_used.value,
                    },
                )
            return completed_result.model_copy(update={"task": task})

    async def init_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "init_tx", "explorer_url": "https://explorer/init_tx"}

    async def selection_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "selection_tx", "explorer_url": "https://explorer/selection_tx"}

    async def receipt_ok(
        *,
        task_id: str,
        merkle_root: str,
        decision_hash: str,
        quorum_reached: bool,
        final_mechanism: str | int,
    ) -> dict[str, str]:
        del task_id, decision_hash, quorum_reached, final_mechanism
        assert merkle_root == completed_result.merkle_root
        return {"tx_hash": "receipt_tx", "explorer_url": "https://explorer/receipt_tx"}

    async def pay_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "pay_tx", "explorer_url": "https://explorer/pay_tx"}

    try:
        monkeypatch.setattr(task_routes.settings, "strict_chain_writes", True)
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: True)
        monkeypatch.setattr(task_routes.bridge, "initialize_task", init_ok)
        monkeypatch.setattr(task_routes.bridge, "record_selection", selection_ok)
        monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_ok)
        monkeypatch.setattr(task_routes.bridge, "release_payment", pay_ok)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="run me", agent_count=5, stakes=0.5),
            _override_user(),
        )
        task_id = create.task_id

        run_resp = await task_routes.run_task(task_id, _override_user())
        assert run_resp.final_answer == "Ship it."
        assert run_resp.agent_count == 5
        assert run_resp.agent_models_used == [
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ]

        status_resp = await task_routes.get_task_status(task_id, _override_user())
        assert status_resp.status == "completed"
        assert status_resp.solana_tx_hash == "receipt_tx"

        pay_resp = await task_routes.release_payment(task_id, _override_user())
        assert pay_resp["released"] is True
        assert pay_resp["tx_hash"] == "pay_tx"

        async def receipt_fail(**_kwargs: object) -> dict[str, str]:
            raise RuntimeError("bridge down")

        create2 = await task_routes.create_task(
            TaskCreateRequest(task="fails on run", agent_count=3, stakes=0.0),
            _override_user(),
        )
        task_id_fail = create2.task_id

        monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_fail)
        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(task_id_fail, _override_user())
        assert exc_info.value.status_code == 502
        failed_status = await task_routes.get_task_status(
            task_id_fail,
            _override_user(),
            detailed=True,
        )
        assert failed_status.status == "failed"
        assert any(event.event == "error" for event in failed_status.events)
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_persist_and_emit_preserves_full_timestamped_envelope(
    tmp_path: Path,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "stream-data"))
    stream = DeliberationStream()
    user = _override_user()
    task_id = "task-stream-live"
    task_payload = {
        "task_id": task_id,
        "task_text": "Stream this task",
        "mechanism": "vote",
        "status": "pending",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [],
    }
    await store.upsert_user(user.id, user.email, user.display_name)
    task_payload["workspace_id"] = user.workspace_id
    await store.save_task(user.workspace_id, task_id, task_payload)

    stream_id = task_routes._stream_key(user.workspace_id, task_id)
    queue = stream.subscribe(stream_id)
    try:
        await task_routes.persist_and_emit(
            store=store,
            stream=stream,
            workspace_id=user.workspace_id,
            task_id=task_id,
            event_type="agent_output",
            event_data={"agent_id": "agent-1", "content": "BTC"},
        )

        live_payload = await queue.get()
        stored_events = await store.get_events(user.workspace_id, task_id)
    finally:
        stream.unsubscribe(stream_id, queue)

    assert set(live_payload) == {"event", "data", "timestamp"}
    assert stored_events == [live_payload]
    assert live_payload["event"] == "agent_output"
    assert live_payload["data"]["content"] == "BTC"
    assert live_payload["timestamp"] is not None


@pytest.mark.asyncio
async def test_stream_task_replays_timestamped_event_envelopes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "stream-replay"))
    user = _override_user()
    task_id = "task-stream-replay"
    task_payload = {
        "task_id": task_id,
        "task_text": "Replay this task",
        "workspace_id": user.workspace_id,
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [],
    }

    class _CapturedEventSourceResponse:
        def __init__(self, content):
            self.content = content

    task_routes._store = store
    await store.upsert_user(user.id, user.email, user.display_name)
    await store.save_task(user.workspace_id, task_id, task_payload)
    first_event = {
        "event": "agent_output",
        "data": {"agent_id": "agent-1", "content": "BTC"},
        "timestamp": "2026-04-14T13:00:00+00:00",
    }
    second_event = {
        "event": "complete",
        "data": {"task_id": task_id, "status": "completed"},
        "timestamp": "2026-04-14T13:00:01+00:00",
    }
    await store.append_event(user.workspace_id, task_id, first_event)
    await store.append_event(user.workspace_id, task_id, second_event)
    monkeypatch.setattr(task_routes, "EventSourceResponse", _CapturedEventSourceResponse)

    try:
        ticket = (await task_routes._issue_stream_ticket(user.workspace_id, task_id))["ticket"]
        response = await task_routes.stream_task(task_id, ticket=ticket)
        replayed_events = [item async for item in response.content]
    finally:
        task_routes._store = None
        await task_routes._reset_coordination_state_for_tests()

    assert replayed_events == [first_event, second_event]
    assert all(set(item) == {"event", "data", "timestamp"} for item in replayed_events)


@pytest.mark.asyncio
async def test_stream_ticket_is_one_use_and_namespaced(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "stream-ticket"))
    user = _override_user()
    task_id = "task-stream-ticket"
    task_payload = {
        "task_id": task_id,
        "task_text": "Ticket this task",
        "workspace_id": user.workspace_id,
        "created_by": user.id,
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [
            {
                "event": "complete",
                "data": {"task_id": task_id, "status": "completed"},
                "timestamp": "2026-04-14T13:00:00+00:00",
            }
        ],
    }

    class _CapturedEventSourceResponse:
        def __init__(self, content):
            self.content = content

    task_routes._store = store
    await store.upsert_user(user.id, user.email, user.display_name)
    await store.save_task(user.workspace_id, task_id, task_payload)
    ticket = await task_routes.create_stream_ticket(task_id, user)

    try:
        assert "ticket" in ticket
        monkeypatch.setattr(task_routes, "EventSourceResponse", _CapturedEventSourceResponse)
        first = await task_routes.stream_task(task_id, ticket=ticket["ticket"])
        assert [item async for item in first.content] == task_payload["events"]
        with pytest.raises(HTTPException) as exc_info:
            await task_routes.stream_task(task_id, ticket=ticket["ticket"])
    finally:
        task_routes._store = None
        await task_routes._reset_coordination_state_for_tests()

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_stream_ticket_expiry_is_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "stream-ticket-expiry"))
    user = _override_user()
    task_id = "task-stream-expiry"
    task_payload = {
        "task_id": task_id,
        "task_text": "Expiring ticket task",
        "workspace_id": user.workspace_id,
        "created_by": user.id,
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [],
    }

    class _CapturedEventSourceResponse:
        def __init__(self, content):
            self.content = content

    task_routes._store = store
    await store.upsert_user(user.id, user.email, user.display_name)
    await store.save_task(user.workspace_id, task_id, task_payload)
    issued = await task_routes.create_stream_ticket(task_id, user)
    backend = task_routes.get_coordination_backend()
    assert isinstance(backend, InMemoryCoordinationBackend)
    original = backend._stream_tickets[issued["ticket"]]
    backend._stream_tickets[issued["ticket"]] = StreamTicketRecord(
        workspace_id=original.workspace_id,
        task_id=original.task_id,
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )

    try:
        monkeypatch.setattr(task_routes, "EventSourceResponse", _CapturedEventSourceResponse)
        with pytest.raises(HTTPException) as exc_info:
            await task_routes.stream_task(task_id, ticket=issued["ticket"])
    finally:
        task_routes._store = None
        await task_routes._reset_coordination_state_for_tests()

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_task_routes_hide_cross_user_and_malformed_ids(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "tenant-data"))
    owner = _override_user()
    other = AuthenticatedUser(
        auth_method="jwt",
        workspace_id="user-2",
        user_id="user-2",
        email="user2@example.com",
        display_name="User Two",
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )
    task_payload = {
        "task_id": "task-owned",
        "task_text": "Owned task",
        "workspace_id": owner.workspace_id,
        "created_by": owner.id,
        "mechanism": "vote",
        "status": "pending",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [],
    }

    task_routes._store = store
    await store.upsert_user(owner.id, owner.email, owner.display_name)
    await store.save_task(owner.workspace_id, "task-owned", task_payload)
    try:
        with pytest.raises(HTTPException) as cross_user:
            await task_routes.get_task_status("task-owned", other)
        with pytest.raises(HTTPException) as malformed:
            await task_routes.get_task_status("../task-owned", owner)
    finally:
        task_routes._store = None

    assert cross_user.value.status_code == 404
    assert malformed.value.status_code == 404


@pytest.mark.asyncio
async def test_solana_webhook_requires_valid_signature(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(webhook_routes.settings, "webhook_secret", "webhook-secret")
    monkeypatch.setattr(webhook_routes.settings, "webhook_timestamp_skew_seconds", 300)
    monkeypatch.setattr(webhook_routes.settings, "webhook_replay_ttl_seconds", 900)
    body = json.dumps(
        [{"task_id": "task-webhook", "user_id": "user-1", "signature": "tx-signature"}]
    ).encode("utf-8")

    headers = _signed_webhook_headers(
        "webhook-secret",
        body,
        signature_override="sha256=bad-signature",
    )
    response = await client.post(
        "/webhooks/solana",
        content=body,
        headers=headers,
    )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_solana_webhook_emits_signed_namespaced_event(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "webhook-secret"
    monkeypatch.setattr(webhook_routes.settings, "webhook_secret", secret)
    monkeypatch.setattr(webhook_routes.settings, "webhook_timestamp_skew_seconds", 300)
    monkeypatch.setattr(webhook_routes.settings, "webhook_replay_ttl_seconds", 900)
    body = json.dumps(
        [{"task_id": "task-webhook", "workspace_id": "user-1", "signature": "tx-signature"}]
    ).encode("utf-8")
    headers = _signed_webhook_headers(secret, body)
    manager = get_stream_manager()
    stream_id = task_routes._stream_key("user-1", "task-webhook")
    queue = manager.subscribe(stream_id)

    try:
        response = await client.post(
            "/webhooks/solana",
            content=body,
            headers=headers,
        )
        event = await queue.get()
    finally:
        manager.unsubscribe(stream_id, queue)

    assert response.status_code == 200
    assert event is not None
    assert event["event"] == "receipt_confirmed"
    assert event["data"]["task_id"] == "task-webhook"
    assert event["data"]["signature"] == "tx-signature"


@pytest.mark.asyncio
async def test_solana_webhook_requires_timestamp_header(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "webhook-secret"
    monkeypatch.setattr(webhook_routes.settings, "webhook_secret", secret)
    monkeypatch.setattr(webhook_routes.settings, "webhook_timestamp_skew_seconds", 300)
    monkeypatch.setattr(webhook_routes.settings, "webhook_replay_ttl_seconds", 900)

    body = json.dumps(
        [{"task_id": "task-webhook", "workspace_id": "user-1", "signature": "tx-signature"}]
    ).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()

    response = await client.post(
        "/webhooks/solana",
        content=body,
        headers={
            "content-type": "application/json",
            "x-agora-signature": f"sha256={digest}",
        },
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing webhook timestamp"


@pytest.mark.asyncio
async def test_solana_webhook_rejects_replay_payload(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "webhook-secret"
    monkeypatch.setattr(webhook_routes.settings, "webhook_secret", secret)
    monkeypatch.setattr(webhook_routes.settings, "webhook_timestamp_skew_seconds", 300)
    monkeypatch.setattr(webhook_routes.settings, "webhook_replay_ttl_seconds", 900)

    body = json.dumps(
        [{"task_id": "task-webhook", "workspace_id": "user-1", "signature": "tx-signature"}]
    ).encode("utf-8")
    timestamp = int(datetime.now(UTC).timestamp())
    headers = _signed_webhook_headers(secret, body, timestamp=timestamp)

    first = await client.post(
        "/webhooks/solana",
        content=body,
        headers=headers,
    )
    second = await client.post(
        "/webhooks/solana",
        content=body,
        headers=headers,
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"] == "Duplicate webhook payload"


@pytest.mark.asyncio
async def test_create_task_continues_when_chain_init_fails_in_non_strict_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))

    async def init_fail(**_kwargs: object) -> dict[str, str]:
        raise RuntimeError("bridge unavailable")

    async def record_selection_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "selection_tx", "explorer_url": "https://explorer/selection_tx"}

    try:
        monkeypatch.setattr(task_routes.settings, "strict_chain_writes", False)
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: True)
        monkeypatch.setattr(task_routes.bridge, "initialize_task", init_fail)
        monkeypatch.setattr(task_routes.bridge, "record_selection", record_selection_ok)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="allow soft chain failure", agent_count=3, stakes=0.0),
            _override_user(),
        )

        fetched = await task_routes.get_task_status(create.task_id, _override_user())
        assert fetched.status == "pending"
        assert fetched.solana_tx_hash is None
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_run_task_honors_env_forced_mechanism_and_serializes_models(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "forced-mechanism-data"))
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    captured: dict[str, object] = {}

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return selection

    class _ForcedMechanismOrchestrator:
        def __init__(self, agent_count: int):
            captured["agent_count"] = agent_count
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | MechanismType | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, event_sink
            captured["task"] = task
            captured["mechanism_override"] = mechanism_override
            return DeliberationResult(
                task=task,
                mechanism_used=MechanismType.VOTE,
                mechanism_selection=selection,
                final_answer="four-model answer",
                confidence=0.88,
                quorum_reached=True,
                round_count=1,
                agent_count=4,
                mechanism_switches=0,
                merkle_root="real-root",
                transcript_hashes=["h1", "h2", "h3", "h4"],
                agent_models_used=[
                    "gemini-3.1-pro-preview",
                    "moonshotai/kimi-k2-thinking",
                    "gemini-3-flash-preview",
                    "claude-sonnet-4-6",
                ],
                convergence_history=[],
                locked_claims=[],
                total_tokens_used=44,
                total_latency_ms=123.0,
                timestamp=datetime.now(UTC),
            )

    try:
        monkeypatch.setattr(task_routes.settings, "api_force_mechanism", "vote")
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _ForcedMechanismOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="run real mode", agent_count=4, stakes=0.0),
            _override_user(),
        )
        task_id = create.task_id

        run_resp = await task_routes.run_task(task_id, _override_user())

        assert captured["agent_count"] == 4
        assert captured["mechanism_override"] == MechanismType.VOTE
        assert run_resp.mechanism == "vote"
        assert run_resp.agent_count == 4
        assert run_resp.agent_models_used == [
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ]
        assert run_resp.total_tokens_used == 44
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_run_task_honors_request_mechanism_override_without_env_force(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "request-override-data"))
    captured: dict[str, object] = {}

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    class _RequestOverrideOrchestrator:
        def __init__(self, agent_count: int):
            captured["agent_count"] = agent_count
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | MechanismType | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, event_sink
            captured["task"] = task
            captured["mechanism_override"] = mechanism_override
            selection = make_selection(mechanism=MechanismType.VOTE, topic_category="reasoning")
            return DeliberationResult(
                task=task,
                mechanism_used=MechanismType.VOTE,
                mechanism_selection=selection,
                final_answer="request override answer",
                confidence=0.91,
                quorum_reached=True,
                round_count=1,
                agent_count=4,
                mechanism_switches=0,
                merkle_root="request-override-root",
                transcript_hashes=["h1", "h2", "h3", "h4"],
                agent_models_used=[
                    "gemini-3.1-pro-preview",
                    "moonshotai/kimi-k2-thinking",
                    "gemini-3-flash-preview",
                    "claude-sonnet-4-6",
                ],
                convergence_history=[],
                locked_claims=[],
                total_tokens_used=45,
                total_latency_ms=111.0,
                timestamp=datetime.now(UTC),
            )

        async def execute_selection(self, **_kwargs):
            raise AssertionError("execute_selection should not be used when override is persisted")

    try:
        monkeypatch.setattr(task_routes.settings, "api_force_mechanism", "")
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _RequestOverrideOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(
                task="run request override",
                agent_count=4,
                stakes=0.0,
                mechanism_override="vote",
            ),
            _override_user(),
        )
        task_id = create.task_id

        assert create.mechanism == "vote"

        run_resp = await task_routes.run_task(task_id, _override_user())

        assert captured["agent_count"] == 4
        assert captured["mechanism_override"] == MechanismType.VOTE
        assert run_resp.mechanism == "vote"
        assert run_resp.agent_count == 4
        assert run_resp.agent_models_used == [
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ]
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_pay_validates_quorum_and_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="no quorum", agent_count=3, stakes=0.3),
            _override_user(),
        )
        task_id = create.task_id

        store = task_routes._store
        assert store is not None
        task = await store.get_task("user-1", task_id)
        assert task is not None
        task["status"] = "completed"
        task["quorum_reached"] = False
        task["payment_status"] = "locked"
        await store.save_task("user-1", task_id, task)

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.release_payment(task_id, _override_user())
        assert exc_info.value.status_code == 409
    finally:
        task_routes._store = None


def test_task_id_to_bytes_is_32_bytes() -> None:
    task_id = task_routes._build_task_id("A long enough task")
    task_bytes = bytes.fromhex(task_id)

    assert len(task_id) == 64
    assert len(task_bytes) == 32


@pytest.mark.asyncio
async def test_api_key_auth_resolves_workspace_principal(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "api-key-auth"))
    auth._store = store
    await store.save_api_key(
        "user-1",
        "key-1",
        {
            "key_id": "key-1",
            "workspace_id": "user-1",
            "name": "ci",
            "public_id": "public1",
            "secret_hash": hash_api_key_secret("super-secret"),
            "scopes": list(DEFAULT_API_KEY_SCOPES),
            "created_by_user_id": "user-1",
            "created_at": datetime.now(UTC).isoformat(),
            "last_used_at": None,
            "expires_at": None,
            "revoked_at": None,
        },
    )

    creds = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=build_api_key_token("public1", "super-secret"),
    )
    user = await auth.get_current_user(creds)

    assert user.auth_method == "api_key"
    assert user.workspace_id == "user-1"
    assert user.user_id is None
    assert user.api_key_id == "key-1"


@pytest.mark.asyncio
async def test_api_key_auth_rejects_revoked_expired_and_malformed_tokens(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "auth-api-key-invalid"))
    auth._store = store
    now = datetime.now(UTC)

    await store.save_api_key(
        "user-1",
        "key-revoked",
        {
            "key_id": "key-revoked",
            "workspace_id": "user-1",
            "name": "revoked",
            "public_id": "revoked1",
            "secret_hash": hash_api_key_secret("revoked-secret"),
            "scopes": list(DEFAULT_API_KEY_SCOPES),
            "created_by_user_id": "user-1",
            "created_at": now.isoformat(),
            "last_used_at": None,
            "expires_at": None,
            "revoked_at": now.isoformat(),
        },
    )
    await store.save_api_key(
        "user-1",
        "key-expired",
        {
            "key_id": "key-expired",
            "workspace_id": "user-1",
            "name": "expired",
            "public_id": "expired1",
            "secret_hash": hash_api_key_secret("expired-secret"),
            "scopes": list(DEFAULT_API_KEY_SCOPES),
            "created_by_user_id": "user-1",
            "created_at": now.isoformat(),
            "last_used_at": None,
            "expires_at": (now - timedelta(days=1)).isoformat(),
            "revoked_at": None,
        },
    )

    revoked_creds = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=build_api_key_token("revoked1", "revoked-secret"),
    )
    with pytest.raises(HTTPException) as revoked_exc:
        await auth.get_current_user(revoked_creds)
    assert revoked_exc.value.status_code == 401

    expired_creds = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=build_api_key_token("expired1", "expired-secret"),
    )
    with pytest.raises(HTTPException) as expired_exc:
        await auth.get_current_user(expired_creds)
    assert expired_exc.value.status_code == 401

    malformed_creds = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials="agora_test_missingdot",
    )
    with pytest.raises(HTTPException) as malformed_exc:
        await auth.get_current_user(malformed_creds)
    assert malformed_exc.value.status_code == 401


@pytest.mark.asyncio
async def test_api_key_auth_handles_naive_expiry_timestamps(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "auth-api-key-naive-expiry"))
    auth._store = store
    now = datetime.now(UTC)

    await store.save_api_key(
        "user-1",
        "key-naive-future",
        {
            "key_id": "key-naive-future",
            "workspace_id": "user-1",
            "name": "naive-future",
            "public_id": "naivefuture1",
            "secret_hash": hash_api_key_secret("naive-future-secret"),
            "scopes": list(DEFAULT_API_KEY_SCOPES),
            "created_by_user_id": "user-1",
            "created_at": now.isoformat(),
            "last_used_at": None,
            "expires_at": (now + timedelta(hours=1)).replace(tzinfo=None).isoformat(),
            "revoked_at": None,
        },
    )
    await store.save_api_key(
        "user-1",
        "key-naive-past",
        {
            "key_id": "key-naive-past",
            "workspace_id": "user-1",
            "name": "naive-past",
            "public_id": "naivepast1",
            "secret_hash": hash_api_key_secret("naive-past-secret"),
            "scopes": list(DEFAULT_API_KEY_SCOPES),
            "created_by_user_id": "user-1",
            "created_at": now.isoformat(),
            "last_used_at": None,
            "expires_at": (now - timedelta(hours=1)).replace(tzinfo=None).isoformat(),
            "revoked_at": None,
        },
    )

    future_creds = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=build_api_key_token("naivefuture1", "naive-future-secret"),
    )
    future_user = await auth.get_current_user(future_creds)
    assert future_user.workspace_id == "user-1"

    past_creds = HTTPAuthorizationCredentials(
        scheme="Bearer",
        credentials=build_api_key_token("naivepast1", "naive-past-secret"),
    )
    with pytest.raises(HTTPException) as past_exc:
        await auth.get_current_user(past_creds)
    assert past_exc.value.status_code == 401


@pytest.mark.asyncio
async def test_auth_me_returns_workspace_bootstrap_payload(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "auth-me"))
    auth._store = store
    user = _override_user()
    await store.ensure_personal_workspace(user.id, user.email, user.display_name)

    payload = await auth_session.auth_me(user)

    assert payload.principal.workspace_id == user.workspace_id
    assert payload.workspace.id == user.workspace_id
    assert payload.feature_flags.api_keys_visible is True
    assert payload.feature_flags.benchmarks_visible is True


@pytest.mark.asyncio
async def test_demo_mode_auth_provisions_workspace_without_bearer(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "demo-auth"))
    auth._store = store
    monkeypatch.setattr(auth.settings, "auth_required", False)
    monkeypatch.setattr(auth.settings, "demo_mode", True)
    monkeypatch.setattr(auth.settings, "environment", "development")

    user = await auth.get_current_user(None)
    workspace = await store.get_workspace(user.workspace_id)

    assert user.auth_method == "jwt"
    assert user.user_id == "demo-user"
    assert user.workspace_id == "demo-user"
    assert workspace is not None
    assert workspace["owner_user_id"] == "demo-user"


@pytest.mark.asyncio
async def test_api_key_routes_create_list_and_revoke(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "api-keys-routes"))
    auth._store = store
    user = _override_user()
    await store.ensure_personal_workspace(user.id, user.email, user.display_name)

    created = await api_key_routes.create_api_key(
        ApiKeyCreateRequest(name="ci"),
        user,
    )
    assert created.api_key.startswith("agora_test_")
    assert created.metadata.name == "ci"

    listed = await api_key_routes.list_api_keys(user)
    assert len(listed) == 1
    assert listed[0].public_id == created.metadata.public_id
    assert not hasattr(listed[0], "secret_hash")

    revoked = await api_key_routes.revoke_api_key(created.metadata.key_id, user)
    assert revoked.revoked_at is not None


@pytest.mark.asyncio
async def test_demo_mode_bootstrap_creates_api_key_and_runs_task_flow(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "phase2-demo-flow"))
    auth._store = store
    task_routes._store = store
    monkeypatch.setattr(auth.settings, "auth_required", False)
    monkeypatch.setattr(auth.settings, "demo_mode", True)
    monkeypatch.setattr(auth.settings, "environment", "development")
    monkeypatch.setattr(auth.settings, "api_key_pepper", "test-pepper")

    hasher = TranscriptHasher()
    transcript_hashes = [
        hasher.hash_content("agent-1: Paris"),
        hasher.hash_content("agent-2: Paris"),
        hasher.hash_content("agent-3: Paris"),
        hasher.hash_content("agent-4: Paris"),
    ]
    merkle_root = hasher.build_merkle_tree(transcript_hashes)

    class _DemoSelectionOnlyOrchestrator:
        def __init__(self, agent_count: int):
            self.agent_count = agent_count
            self.selector = self

        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return make_selection(mechanism=MechanismType.VOTE, topic_category="factual")

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | MechanismType | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, mechanism_override
            if event_sink is not None:
                await event_sink(
                    "agent_output",
                    {
                        "agent_id": "agent-1",
                        "role": "voter",
                        "faction": "vote",
                        "content": "Paris",
                    },
                )
            return DeliberationResult(
                task=task,
                mechanism_used=MechanismType.VOTE,
                mechanism_selection=make_selection(
                    mechanism=MechanismType.VOTE,
                    topic_category="factual",
                ),
                final_answer="Paris",
                confidence=0.96,
                quorum_reached=True,
                round_count=1,
                agent_count=self.agent_count,
                mechanism_switches=0,
                merkle_root=merkle_root,
                transcript_hashes=transcript_hashes,
                agent_models_used=[
                    "gemini-3.1-pro-preview",
                    "moonshotai/kimi-k2-thinking",
                    "gemini-3-flash-preview",
                    "claude-sonnet-4-6",
                ],
                convergence_history=[],
                locked_claims=[],
                total_tokens_used=64,
                total_latency_ms=15.0,
                timestamp=datetime.now(UTC),
            )

    async def init_ok(**_kwargs: object) -> dict[str, str]:
        return {
            "tx_hash": "init_tx_demo",
            "explorer_url": "https://explorer.solana.com/tx/init_tx_demo?cluster=devnet",
        }

    async def selection_ok(**_kwargs: object) -> dict[str, str]:
        return {
            "tx_hash": "selection_tx_demo",
            "explorer_url": "https://explorer.solana.com/tx/selection_tx_demo?cluster=devnet",
        }

    async def receipt_ok(**_kwargs: object) -> dict[str, str]:
        return {
            "tx_hash": "receipt_tx_demo",
            "explorer_url": "https://explorer.solana.com/tx/receipt_tx_demo?cluster=devnet",
        }

    async def pay_ok(**_kwargs: object) -> dict[str, str]:
        return {
            "tx_hash": "pay_tx_demo",
            "explorer_url": "https://explorer.solana.com/tx/pay_tx_demo?cluster=devnet",
        }

    monkeypatch.setattr(task_routes, "AgoraOrchestrator", _DemoSelectionOnlyOrchestrator)
    monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: True)
    monkeypatch.setattr(task_routes.bridge, "initialize_task", init_ok)
    monkeypatch.setattr(task_routes.bridge, "record_selection", selection_ok)
    monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_ok)
    monkeypatch.setattr(task_routes.bridge, "release_payment", pay_ok)

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            auth_me_response = await client.get("/auth/me")
            assert auth_me_response.status_code == 200
            auth_me_payload = auth_me_response.json()
            assert auth_me_payload["principal"]["user_id"] == "demo-user"
            assert auth_me_payload["workspace"]["id"] == "demo-user"

            create_key_response = await client.post("/api-keys/", json={"name": "phase2-demo"})
            assert create_key_response.status_code == 200
            create_key_payload = create_key_response.json()
            api_key = create_key_payload["api_key"]
            key_id = create_key_payload["metadata"]["key_id"]
            assert api_key.startswith("agora_test_")

            key_headers = {"Authorization": f"Bearer {api_key}"}
            api_key_auth_me = await client.get("/auth/me", headers=key_headers)
            assert api_key_auth_me.status_code == 200
            api_key_auth_payload = api_key_auth_me.json()
            assert api_key_auth_payload["principal"]["auth_method"] == "api_key"
            assert api_key_auth_payload["feature_flags"]["api_keys_visible"] is False
            assert api_key_auth_payload["feature_flags"]["benchmarks_visible"] is False

            create_task = await client.post(
                "/tasks/",
                headers=key_headers,
                json={
                    "task": "What is the capital of France?",
                    "agent_count": 4,
                    "stakes": 0.01,
                    "mechanism_override": "vote",
                },
            )
            assert create_task.status_code == 200
            task_id = create_task.json()["task_id"]

            status_after_create = await client.get(
                f"/tasks/{task_id}",
                headers=key_headers,
                params={"detailed": "true"},
            )
            assert status_after_create.status_code == 200
            assert status_after_create.json()["solana_tx_hash"] == "init_tx_demo"

            run_task = await client.post(f"/tasks/{task_id}/run", headers=key_headers)
            assert run_task.status_code == 200
            assert run_task.json()["agent_models_used"] == [
                "gemini-3.1-pro-preview",
                "moonshotai/kimi-k2-thinking",
                "gemini-3-flash-preview",
                "claude-sonnet-4-6",
            ]

            status_after_run = await client.get(
                f"/tasks/{task_id}",
                headers=key_headers,
                params={"detailed": "true"},
            )
            assert status_after_run.status_code == 200
            run_payload = status_after_run.json()
            assert run_payload["status"] == "completed"
            assert run_payload["solana_tx_hash"] == "receipt_tx_demo"
            assert run_payload["result"]["merkle_root"] == merkle_root

            pay_response = await client.post(f"/tasks/{task_id}/pay", headers=key_headers)
            assert pay_response.status_code == 200
            assert pay_response.json()["released"] is True

            final_status = await client.get(
                f"/tasks/{task_id}",
                headers=key_headers,
                params={"detailed": "true"},
            )
            assert final_status.status_code == 200
            final_payload = final_status.json()
            assert final_payload["status"] == "paid"
            assert final_payload["payment_status"] == "released"
            assert final_payload["solana_tx_hash"] == "pay_tx_demo"

            revoke_response = await client.post(f"/api-keys/{key_id}/revoke")
            assert revoke_response.status_code == 200
            assert revoke_response.json()["revoked_at"] is not None

            rejected = await client.get("/auth/me", headers=key_headers)
            assert rejected.status_code == 401
    finally:
        task_routes._store = None
