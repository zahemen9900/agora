"""JWT and API key auth helpers for Agora API access."""

from __future__ import annotations

import hmac
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated, Literal

import jwt
import structlog
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from api.auth_keys import (
    DEFAULT_API_KEY_SCOPES,
    hash_api_key_secret,
    is_api_key_token,
    parse_api_key_token,
)
from api.config import settings
from api.security import validate_storage_id
from api.store import TaskStore, get_store
from api.store_local import LocalTaskStore

security = HTTPBearer(auto_error=False)
logger = structlog.get_logger(__name__)
_store: TaskStore | LocalTaskStore | None = None


class AuthenticatedUser(BaseModel):
    auth_method: Literal["jwt", "api_key"] = "jwt"
    workspace_id: str = ""
    user_id: str | None = None
    email: str = ""
    display_name: str = ""
    scopes: list[str] = Field(default_factory=list)
    api_key_id: str | None = None

    @property
    def id(self) -> str:
        return self.user_id or self.workspace_id


def get_auth_store() -> TaskStore | LocalTaskStore:
    global _store
    if _store is None:
        _store = get_store(
            settings.gcs_bucket if settings.gcs_bucket and settings.google_cloud_project else None
        )
    return _store


def _normalize_url(value: str) -> str:
    """Normalize URL-like settings while tolerating host-only values."""

    normalized = value.strip()
    if not normalized:
        return ""
    if "://" not in normalized:
        normalized = f"https://{normalized}"
    return normalized.rstrip("/")


def _auth_issuer() -> str:
    """Resolve issuer from explicit setting or AuthKit domain."""

    explicit = _normalize_url(settings.auth_issuer)
    if explicit:
        return explicit
    return _normalize_url(settings.workos_authkit_domain)


def _auth_audience() -> str:
    """Resolve expected JWT audience."""

    return (settings.auth_audience or settings.workos_client_id).strip()


def _auth_jwks_url(issuer: str) -> str:
    """Resolve JWKS URL from explicit setting or issuer convention."""

    explicit = _normalize_url(settings.auth_jwks_url)
    if explicit:
        return explicit
    if not issuer:
        return ""
    return f"{issuer}/oauth2/jwks"


@lru_cache(maxsize=4)
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    """Create cached JWKS client for signature verification."""

    return jwt.PyJWKClient(jwks_url)


def _decode_verified_token(raw_token: str) -> dict[str, object]:
    """Decode and verify a WorkOS access token."""

    issuer = _auth_issuer()
    audience = _auth_audience()
    jwks_url = _auth_jwks_url(issuer)

    if not issuer or not audience or not jwks_url:
        raise RuntimeError(
            "Auth verification is not configured. Set AUTH_ISSUER (or WORKOS_AUTHKIT_DOMAIN), "
            "AUTH_AUDIENCE (or WORKOS_CLIENT_ID), and AUTH_JWKS_URL (optional override)."
        )

    signing_key = _jwks_client(jwks_url).get_signing_key_from_jwt(raw_token).key
    payload = jwt.decode(
        raw_token,
        key=signing_key,
        algorithms=["RS256"],
        issuer=issuer,
        audience=audience,
    )
    if not isinstance(payload, dict):  # pragma: no cover - defensive typing guard
        raise jwt.PyJWTError("Token payload is not an object")
    return payload


def _demo_user() -> AuthenticatedUser:
    return AuthenticatedUser(
        auth_method="jwt",
        workspace_id="demo-user",
        user_id="demo-user",
        email="demo@example.com",
        display_name="Demo User",
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )


def _demo_auth_enabled() -> bool:
    """Return whether unauthenticated demo access is explicitly enabled."""

    environment = settings.environment.strip().lower()
    return (
        not settings.auth_required
        and settings.demo_mode
        and environment not in {"prod", "production"}
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> AuthenticatedUser:
    """Decode a WorkOS access token or first-party API key into a normalized principal."""

    raw_token = credentials.credentials if credentials is not None else None
    if not raw_token:
        if _demo_auth_enabled():
            return _demo_user()
        raise HTTPException(status_code=401, detail="Missing bearer token")

    store = get_auth_store()
    if is_api_key_token(raw_token):
        try:
            public_id, secret = parse_api_key_token(raw_token)
            api_key = await store.get_api_key_by_public_id(public_id)
            if api_key is None:
                raise HTTPException(status_code=401, detail="Invalid bearer token")
            revoked_at = api_key.get("revoked_at")
            expires_at = api_key.get("expires_at")
            if revoked_at:
                raise HTTPException(status_code=401, detail="Invalid bearer token")
            if isinstance(expires_at, str):
                try:
                    expires_at_dt = datetime.fromisoformat(expires_at)
                    if expires_at_dt.tzinfo is None:
                        expires_at_dt = expires_at_dt.replace(tzinfo=UTC)
                    if expires_at_dt <= datetime.now(UTC):
                        raise HTTPException(status_code=401, detail="Invalid bearer token")
                except (TypeError, ValueError) as exc:
                    raise HTTPException(status_code=401, detail="Invalid bearer token") from exc
            candidate_hash = hash_api_key_secret(secret)
            stored_hash = str(api_key.get("secret_hash", ""))
            if not stored_hash or not hmac.compare_digest(candidate_hash, stored_hash):
                raise HTTPException(status_code=401, detail="Invalid bearer token")
            workspace_id = str(api_key.get("workspace_id", "")).strip()
            if not workspace_id:
                raise HTTPException(status_code=401, detail="Invalid bearer token")
            await store.update_api_key(
                workspace_id,
                str(api_key["key_id"]),
                {"last_used_at": datetime.now(UTC).isoformat()},
            )
            return AuthenticatedUser(
                auth_method="api_key",
                workspace_id=workspace_id,
                user_id=None,
                email="",
                display_name=str(api_key.get("name", "API Key")),
                scopes=[str(scope) for scope in api_key.get("scopes", DEFAULT_API_KEY_SCOPES)],
                api_key_id=str(api_key["key_id"]),
            )
        except HTTPException:
            raise
        except RuntimeError as exc:
            logger.error("api_key_verification_misconfigured", error=str(exc))
            raise HTTPException(status_code=500, detail="Authentication error") from exc
        except Exception as exc:
            raise HTTPException(status_code=401, detail="Invalid bearer token") from exc

    try:
        payload = _decode_verified_token(raw_token)
    except RuntimeError as exc:
        logger.error("auth_verification_misconfigured", error=str(exc))
        if _demo_auth_enabled():
            return _demo_user()
        raise HTTPException(status_code=500, detail="Authentication error") from exc
    except jwt.PyJWTError as exc:
        if _demo_auth_enabled():
            return _demo_user()
        raise HTTPException(status_code=401, detail="Invalid bearer token") from exc

    user_id = payload.get("sub")
    if not user_id:
        if _demo_auth_enabled():
            return _demo_user()
        raise HTTPException(status_code=401, detail="Token missing sub claim")

    if not isinstance(user_id, str):
        if _demo_auth_enabled():
            return _demo_user()
        raise HTTPException(status_code=401, detail="Token missing sub claim")
    try:
        validate_storage_id(user_id, field_name="sub")
    except ValueError as exc:
        if _demo_auth_enabled():
            return _demo_user()
        raise HTTPException(status_code=401, detail="Token has invalid sub claim") from exc

    email = payload.get("email")
    if not isinstance(email, str):
        email = ""

    display_name = payload.get("first_name") or payload.get("name") or email or user_id
    if not isinstance(display_name, str):  # pragma: no cover - defensive typing guard
        display_name = user_id

    workspace = await store.ensure_personal_workspace(
        user_id=user_id,
        email=email,
        name=display_name,
    )
    return AuthenticatedUser(
        auth_method="jwt",
        workspace_id=str(workspace["id"]),
        user_id=user_id,
        email=email,
        display_name=display_name,
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )


def require_scope(user: AuthenticatedUser, scope: str) -> None:
    if scope not in user.scopes:
        raise HTTPException(status_code=403, detail="Forbidden")


def require_human_user(user: AuthenticatedUser) -> None:
    if user.auth_method != "jwt" or not user.user_id:
        raise HTTPException(status_code=403, detail="Human authentication required")


def principal_payload(user: AuthenticatedUser) -> dict[str, object]:
    return {
        "auth_method": user.auth_method,
        "workspace_id": user.workspace_id,
        "user_id": user.user_id,
        "display_name": user.display_name,
        "email": user.email,
        "scopes": user.scopes,
        "api_key_id": user.api_key_id,
    }
