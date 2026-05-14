"""JWT and API key auth helpers for Agora API access."""

from __future__ import annotations

import hmac
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated, Literal
from urllib.parse import urlparse

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
from api.telemetry import bind_user_to_current_span

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
            settings.gcs_bucket if settings.gcs_bucket and settings.google_cloud_project else None,
            local_data_dir=settings.local_data_dir,
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

    for candidate in (
        _normalize_url(settings.auth_issuer),
        _normalize_url(settings.workos_authkit_domain),
    ):
        if candidate:
            return candidate
    return ""


def _auth_issuers() -> list[str]:
    """Resolve ordered issuer candidates from configured settings."""

    candidates = [
        _normalize_url(settings.auth_issuer),
        _normalize_url(settings.workos_authkit_domain),
    ]
    unique: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in unique:
            unique.append(candidate)
    return unique


def _auth_audience() -> str:
    """Resolve expected JWT audience."""

    return (settings.auth_audience or settings.workos_client_id).strip()


def _auth_audiences() -> list[str]:
    """Resolve accepted JWT audiences, including optional comma-separated overrides."""

    candidates = [
        _auth_audience(),
        settings.workos_client_id.strip(),
    ]

    configured = settings.auth_audiences.strip()
    if configured:
        candidates.extend(part.strip() for part in configured.split(","))

    unique: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in unique:
            unique.append(candidate)
    return unique


def _jwks_url_from_issuer(issuer: str) -> str:
    """Derive a JWKS URL for a normalized issuer."""

    normalized_issuer = _normalize_url(issuer)
    if not normalized_issuer:
        return ""

    # WorkOS AuthKit session tokens commonly use https://api.workos.com as issuer
    # and publish client-scoped keys at /sso/jwks/{client_id}.
    if normalized_issuer == "https://api.workos.com":
        client_id = settings.workos_client_id.strip() or settings.auth_audience.strip()
        if client_id:
            return f"{normalized_issuer}/sso/jwks/{client_id}"

    return f"{normalized_issuer}/oauth2/jwks"


def _auth_jwks_url(issuer: str) -> str:
    """Resolve JWKS URL from explicit setting or issuer convention."""

    explicit = _normalize_url(settings.auth_jwks_url)
    if explicit:
        return explicit
    return _jwks_url_from_issuer(issuer)


def get_resolved_auth_config() -> dict[str, str]:
    """Return normalized auth settings used for JWT verification/bootstrap."""

    issuer = _auth_issuer()
    audience = _auth_audience()
    return {
        "workos_client_id": settings.workos_client_id.strip(),
        "workos_authkit_domain": _normalize_url(settings.workos_authkit_domain),
        "auth_issuer": issuer,
        "auth_audience": audience,
        "auth_jwks_url": _auth_jwks_url(issuer),
    }


def _auth_jwks_candidates(issuers: list[str]) -> list[str]:
    """Resolve ordered JWKS candidates from explicit and derived issuer URLs."""

    candidates: list[str] = []

    explicit = _normalize_url(settings.auth_jwks_url)
    if explicit:
        candidates.append(explicit)

    for issuer in issuers:
        candidate = _jwks_url_from_issuer(issuer)
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    return candidates


@lru_cache(maxsize=4)
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    """Create cached JWKS client for signature verification."""

    return jwt.PyJWKClient(jwks_url)


def _issuer_variants(value: str) -> list[str]:
    """Return issuer variants with and without trailing slash."""

    normalized = _normalize_url(value)
    if not normalized:
        return []
    return [normalized, f"{normalized}/"]


def _issuer_host(value: str) -> str:
    """Extract the lowercase host from a normalized issuer URL."""

    normalized = _normalize_url(value)
    if not normalized:
        return ""
    return urlparse(normalized).netloc.lower()


def _is_known_workos_issuer(value: str) -> bool:
    """Return whether an issuer belongs to trusted WorkOS token domains."""

    host = _issuer_host(value)
    return host == "api.workos.com" or host.endswith(".authkit.app")


def _audiences_from_claims(claims: dict[str, object]) -> list[str]:
    """Extract normalized audience values from unverified token claims."""

    raw_aud = claims.get("aud")
    if isinstance(raw_aud, str):
        return [raw_aud.strip()] if raw_aud.strip() else []
    if isinstance(raw_aud, list):
        audiences: list[str] = []
        for value in raw_aud:
            if isinstance(value, str):
                candidate = value.strip()
                if candidate and candidate not in audiences:
                    audiences.append(candidate)
        return audiences
    return []


def _first_name_from_display_name(value: str | None) -> str:
    if not isinstance(value, str):
        return ""
    trimmed = value.strip()
    if not trimmed:
        return ""
    return trimmed.split()[0]


def _claim_string(payload: dict[str, object], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    nested_user = payload.get("user")
    if isinstance(nested_user, dict):
        for key in keys:
            value = nested_user.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def _workos_display_name(payload: dict[str, object], *, email: str, user_id: str) -> str:
    raw_name = _claim_string(
        payload,
        "firstName",
        "first_name",
        "givenName",
        "given_name",
        "name",
        "full_name",
        "displayName",
        "display_name",
    )
    if raw_name:
        return _first_name_from_display_name(raw_name)

    if email:
        return email.strip()

    return user_id


def _decode_unverified_claims(raw_token: str) -> dict[str, object] | None:
    """Decode token claims without signature validation for diagnostics/fallbacks."""

    try:
        payload = jwt.decode(
            raw_token,
            options={
                "verify_signature": False,
                "verify_aud": False,
                "verify_iss": False,
                "verify_exp": False,
                "verify_nbf": False,
            },
            algorithms=["RS256", "HS256"],
        )
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _is_production_runtime() -> bool:
    environment = settings.environment.strip().lower()
    return environment in {"prod", "production"}


def _try_decode_with_candidates(
    raw_token: str,
    *,
    issuer_candidates: list[str],
    audiences: list[str],
    jwks_urls: list[str],
    verify_audience: bool,
) -> tuple[dict[str, object] | None, jwt.PyJWTError | None]:
    """Attempt token verification across issuer/jwks candidates."""

    last_error: jwt.PyJWTError | None = None

    for candidate_jwks_url in jwks_urls:
        try:
            signing_key = _jwks_client(candidate_jwks_url).get_signing_key_from_jwt(raw_token).key
        except jwt.PyJWTError as exc:
            last_error = exc
            continue

        for expected_issuer in issuer_candidates:
            try:
                decode_kwargs: dict[str, object] = {
                    "key": signing_key,
                    "algorithms": ["RS256"],
                    "issuer": expected_issuer,
                }
                if verify_audience and audiences:
                    decode_kwargs["audience"] = audiences
                else:
                    decode_kwargs["options"] = {"verify_aud": False}

                payload = jwt.decode(raw_token, **decode_kwargs)
                if not isinstance(payload, dict):  # pragma: no cover - defensive typing guard
                    raise jwt.PyJWTError("Token payload is not an object")
                return payload, None
            except jwt.PyJWTError as exc:
                last_error = exc

    return None, last_error


def _decode_verified_token(raw_token: str) -> dict[str, object]:
    """Decode and verify a WorkOS access token."""

    issuers = _auth_issuers()
    audiences = _auth_audiences()
    unverified_claims = _decode_unverified_claims(raw_token)
    token_issuer = (
        _normalize_url(str(unverified_claims.get("iss") or ""))
        if isinstance(unverified_claims, dict)
        else ""
    )
    if token_issuer and _is_known_workos_issuer(token_issuer) and token_issuer not in issuers:
        issuers.append(token_issuer)

    token_audiences = (
        _audiences_from_claims(unverified_claims) if isinstance(unverified_claims, dict) else []
    )

    verify_audience = bool(audiences) and (unverified_claims is None or bool(token_audiences))

    if not issuers or not audiences:
        raise RuntimeError(
            "Auth verification is not configured. Set AUTH_ISSUER (or WORKOS_AUTHKIT_DOMAIN), "
            "AUTH_AUDIENCE/AUTH_AUDIENCES (or WORKOS_CLIENT_ID), and AUTH_JWKS_URL "
            "(optional override)."
        )

    issuer_candidates: list[str] = []
    for configured_issuer in issuers:
        for variant in _issuer_variants(configured_issuer):
            if variant not in issuer_candidates:
                issuer_candidates.append(variant)

    jwks_candidates = _auth_jwks_candidates(issuers)
    if token_issuer and _is_known_workos_issuer(token_issuer):
        token_jwks_url = _jwks_url_from_issuer(token_issuer)
        if token_jwks_url and token_jwks_url not in jwks_candidates:
            jwks_candidates.append(token_jwks_url)

    if not jwks_candidates:
        raise RuntimeError(
            "Auth verification is not configured. Set AUTH_ISSUER (or WORKOS_AUTHKIT_DOMAIN), "
            "AUTH_AUDIENCE/AUTH_AUDIENCES (or WORKOS_CLIENT_ID), and AUTH_JWKS_URL "
            "(optional override)."
        )

    payload, last_error = _try_decode_with_candidates(
        raw_token,
        issuer_candidates=issuer_candidates,
        audiences=audiences,
        jwks_urls=jwks_candidates,
        verify_audience=verify_audience,
    )
    if payload is not None:
        return payload

    # In non-production environments, tolerate issuer/audience formatting drift
    # by retrying with verified token claims-derived candidates.
    if not _is_production_runtime():
        claims = unverified_claims
        if claims is not None:
            relaxed_issuers = list(issuer_candidates)
            relaxed_jwks = list(jwks_candidates)
            relaxed_audiences = list(audiences)

            claims_issuer = _normalize_url(str(claims.get("iss") or ""))
            if claims_issuer:
                for variant in _issuer_variants(claims_issuer):
                    if variant not in relaxed_issuers:
                        relaxed_issuers.append(variant)
                token_jwks_url = _jwks_url_from_issuer(claims_issuer)
                if token_jwks_url and token_jwks_url not in relaxed_jwks:
                    relaxed_jwks.append(token_jwks_url)

            for token_audience in _audiences_from_claims(claims):
                if token_audience not in relaxed_audiences:
                    relaxed_audiences.append(token_audience)

            relaxed_verify_audience = verify_audience
            if not _audiences_from_claims(claims):
                relaxed_verify_audience = False

            payload, relaxed_error = _try_decode_with_candidates(
                raw_token,
                issuer_candidates=relaxed_issuers,
                audiences=relaxed_audiences,
                jwks_urls=relaxed_jwks,
                verify_audience=relaxed_verify_audience,
            )
            if payload is not None:
                logger.warning(
                    "auth_verification_relaxed_success",
                    configured_issuer=issuers[0],
                    configured_audiences=audiences,
                    token_issuer=claims_issuer or None,
                    token_audiences=_audiences_from_claims(claims),
                )
                return payload
            if relaxed_error is not None:
                last_error = relaxed_error

    if last_error is None:  # pragma: no cover - defensive guard
        raise jwt.PyJWTError("Token verification failed")
    raise last_error


def _demo_auth_enabled() -> bool:
    """Return whether unauthenticated demo access is explicitly enabled."""

    environment = settings.environment.strip().lower()
    return (
        not settings.auth_required
        and settings.demo_mode
        and environment not in {"prod", "production"}
    )


async def _resolve_demo_user(store: TaskStore | LocalTaskStore) -> AuthenticatedUser:
    """Return a synthetic demo user backed by a real personal workspace."""

    workspace = await store.ensure_personal_workspace(
        user_id="demo-user",
        email="demo@example.com",
        name="Demo User",
    )
    return AuthenticatedUser(
        auth_method="jwt",
        workspace_id=str(workspace["id"]),
        user_id="demo-user",
        email="demo@example.com",
        display_name="Demo User",
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> AuthenticatedUser:
    """Decode a WorkOS access token or first-party API key into a normalized principal."""

    raw_token = credentials.credentials if credentials is not None else None
    if not raw_token:
        if _demo_auth_enabled():
            store = get_auth_store()
            demo_user = await _resolve_demo_user(store)
            bind_user_to_current_span(
                demo_user,
                actor_type="demo",
                actor_id=f"workspace:{demo_user.workspace_id}",
            )
            return demo_user
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
            resolved_user = AuthenticatedUser(
                auth_method="api_key",
                workspace_id=workspace_id,
                user_id=None,
                email="",
                display_name=str(api_key.get("name", "API Key")),
                scopes=[str(scope) for scope in api_key.get("scopes", DEFAULT_API_KEY_SCOPES)],
                api_key_id=str(api_key["key_id"]),
            )
            bind_user_to_current_span(resolved_user)
            return resolved_user
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
        raise HTTPException(status_code=500, detail="Authentication error") from exc
    except jwt.PyJWTError as exc:
        claims = _decode_unverified_claims(raw_token)
        logger.warning(
            "auth_token_verification_failed",
            error_type=exc.__class__.__name__,
            error=str(exc),
            token_format="jwt" if claims is not None else "opaque_or_invalid",
            token_issuer=(str(claims.get("iss")) if isinstance(claims, dict) else None),
            token_audiences=(_audiences_from_claims(claims) if isinstance(claims, dict) else []),
            configured_issuer=_auth_issuer(),
            configured_audiences=_auth_audiences(),
        )
        raise HTTPException(status_code=401, detail="Invalid bearer token") from exc

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing sub claim")

    if not isinstance(user_id, str):
        raise HTTPException(status_code=401, detail="Token missing sub claim")
    try:
        validate_storage_id(user_id, field_name="sub")
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Token has invalid sub claim") from exc

    email = payload.get("email")
    if not isinstance(email, str):
        email = ""

    display_name = _workos_display_name(payload, email=email, user_id=user_id)

    workspace = await store.ensure_personal_workspace(
        user_id=user_id,
        email=email,
        name=display_name,
    )
    resolved_user = AuthenticatedUser(
        auth_method="jwt",
        workspace_id=str(workspace["id"]),
        user_id=user_id,
        email=email,
        display_name=display_name,
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )
    bind_user_to_current_span(resolved_user)
    return resolved_user


async def get_optional_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> AuthenticatedUser | None:
    """Resolve bearer auth when present, otherwise return None."""

    if credentials is None:
        return None
    return await get_current_user(credentials)


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
