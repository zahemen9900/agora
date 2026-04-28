"""Helpers for first-party Agora API keys."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from api.config import settings

DEFAULT_API_KEY_SCOPES = [
    "tasks:read",
    "tasks:write",
    "benchmarks:read",
    "benchmarks:write",
    "api_keys:read",
    "api_keys:write",
]

_LIVE_PREFIX = "agora_live_"
_TEST_PREFIX = "agora_test_"
_DEV_FALLBACK_API_KEY_PEPPER = "agora-dev-api-key-pepper"


def api_key_token_prefix() -> str:
    environment = settings.environment.strip().lower()
    if environment in {"prod", "production"}:
        return _LIVE_PREFIX
    return _TEST_PREFIX


def is_api_key_token(value: str) -> bool:
    return value.startswith(_LIVE_PREFIX) or value.startswith(_TEST_PREFIX)


def _is_production_environment() -> bool:
    environment = settings.environment.strip().lower()
    return environment in {"prod", "production"}


def _api_key_pepper_bytes() -> bytes:
    pepper = settings.api_key_pepper.strip()
    if pepper:
        return pepper.encode("utf-8")
    if _is_production_environment():
        raise RuntimeError("API key verification is not configured. Set AGORA_API_KEY_PEPPER.")
    return _DEV_FALLBACK_API_KEY_PEPPER.encode("utf-8")


def hash_api_key_secret(secret: str) -> str:
    digest = hmac.new(_api_key_pepper_bytes(), secret.encode("utf-8"), hashlib.sha256).hexdigest()
    return digest


def parse_api_key_token(token: str) -> tuple[str, str]:
    if not is_api_key_token(token) or "." not in token:
        raise ValueError("Malformed API key")
    public_token, secret = token.split(".", 1)
    public_id = public_token.removeprefix(_LIVE_PREFIX).removeprefix(_TEST_PREFIX)
    if not public_id or not secret:
        raise ValueError("Malformed API key")
    return public_id, secret


def build_api_key_token(public_id: str, secret: str) -> str:
    return f"{api_key_token_prefix()}{public_id}.{secret}"


def generate_api_key_material() -> tuple[str, str, str]:
    key_id = secrets.token_hex(16)
    public_id = secrets.token_urlsafe(9).replace("-", "").replace("_", "")[:14]
    secret = secrets.token_urlsafe(32)
    return key_id, public_id, secret


def default_api_key_expiry() -> datetime | None:
    if settings.api_key_default_ttl_days <= 0:
        return None
    return datetime.now(UTC) + timedelta(days=settings.api_key_default_ttl_days)
