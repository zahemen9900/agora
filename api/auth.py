"""JWT auth helpers for WorkOS-backed API access."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

import jwt
import structlog
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from api.config import settings
from api.security import validate_storage_id

security = HTTPBearer(auto_error=False)
logger = structlog.get_logger(__name__)


class AuthenticatedUser(BaseModel):
    id: str
    email: str
    display_name: str


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
        id="demo-user",
        email="demo@example.com",
        display_name="Demo User",
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
    """Decode bearer token and return normalized user claims."""

    raw_token = credentials.credentials if credentials is not None else None
    if not raw_token:
        if _demo_auth_enabled():
            return _demo_user()
        raise HTTPException(status_code=401, detail="Missing bearer token")

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

    return AuthenticatedUser(
        id=user_id,
        email=email,
        display_name=display_name,
    )
