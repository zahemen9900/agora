"""Shared SDK configuration helpers."""

from __future__ import annotations

import os
from typing import Final

CANONICAL_HOSTED_API_URL: Final[str] = "https://agora-api-b4auawqzbq-uc.a.run.app"
_API_URL_OVERRIDE_ENV = "AGORA_API_URL"
_ALLOW_API_URL_OVERRIDE_ENV = "AGORA_ALLOW_API_URL_OVERRIDE"
_TRUTHY = {"1", "true", "yes", "on"}


def _env_flag(name: str) -> bool:
    raw = os.getenv(name)
    return raw is not None and raw.strip().lower() in _TRUTHY


def resolve_hosted_api_url(api_url: str | None = None) -> str:
    """Resolve the hosted API URL under the canonical-default policy.

    The canonical Cloud Run URL is the default for hosted SDK usage. Manual overrides are
    only honored when ``AGORA_ALLOW_API_URL_OVERRIDE=1`` is set.
    """

    allow_override = _env_flag(_ALLOW_API_URL_OVERRIDE_ENV)

    if api_url is not None:
        resolved = api_url.strip().rstrip("/")
        if resolved != CANONICAL_HOSTED_API_URL and not allow_override:
            raise ValueError(
                "Custom API URLs are disabled by default. Set "
                "AGORA_ALLOW_API_URL_OVERRIDE=1 to use a non-canonical hosted backend."
            )
        return resolved

    env_api_url = os.getenv(_API_URL_OVERRIDE_ENV)
    if env_api_url is not None:
        resolved = env_api_url.strip().rstrip("/")
        if resolved and allow_override:
            return resolved

    return CANONICAL_HOSTED_API_URL
