"""Benchmark summary API endpoint."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from api.auth import AuthenticatedUser, get_current_user, require_human_user
from api.config import settings
from api.routes.tasks import get_task_store

router = APIRouter()
_optional_bearer = HTTPBearer(auto_error=False)

_RESULTS_PATH = (
    Path(__file__).resolve().parents[2] / "benchmarks" / "results" / "phase2_validation.json"
)


async def _optional_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_optional_bearer),
) -> AuthenticatedUser | None:
    if credentials is None:
        return None
    return await get_current_user(credentials)


@router.get("/benchmarks")
async def get_benchmarks(
    user: AuthenticatedUser | None = Depends(_optional_current_user),
    x_agora_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Return the latest persisted benchmark summary."""

    has_admin_secret = bool(settings.benchmark_admin_token)
    admin_granted = has_admin_secret and x_agora_admin_token == settings.benchmark_admin_token

    if not admin_granted:
        if user is None:
            raise HTTPException(status_code=403, detail="Benchmark access denied")
        require_human_user(user)

    store = get_task_store()
    summary = await store.get_benchmark_summary()
    if summary is not None:
        return summary

    if _RESULTS_PATH.exists():
        payload = json.loads(_RESULTS_PATH.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload

    raise HTTPException(status_code=404, detail="Benchmark summary is not available yet")
