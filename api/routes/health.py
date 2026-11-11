"""Health and readiness check routes."""

from __future__ import annotations

import asyncio

import boto3
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from agora.version import __version__ as AGORA_VERSION  # noqa: N812
from api.config import settings
from api.coordination import get_coordination_backend
from api.store import resolve_storage_settings

router = APIRouter()


def _is_production() -> bool:
    return settings.environment.strip().lower() in {"prod", "production"}


@router.get("/health")
async def health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "agora-api",
        "version": AGORA_VERSION,
        "solana_network": "devnet",
    }


@router.get("/ready")
async def readiness_check() -> JSONResponse:
    checks = {
        "coordination": False,
        "storage": False,
        "secrets": False,
    }

    try:
        checks["coordination"] = await get_coordination_backend().ping()
    except Exception:
        checks["coordination"] = False

    try:
        backend, bucket = resolve_storage_settings(settings)
        if backend == "s3" and bucket:
            client = boto3.client("s3", region_name=settings.aws_region)
            await asyncio.to_thread(client.head_bucket, Bucket=bucket)
            checks["storage"] = True
        elif backend == "gcs" and bucket:
            checks["storage"] = True
        else:
            checks["storage"] = not _is_production()
    except Exception:
        checks["storage"] = False

    if _is_production():
        checks["secrets"] = bool(settings.api_key_pepper.strip()) and bool(
            settings.sandbox_runner_bearer_token.strip()
        )
    else:
        checks["secrets"] = True

    ready = all(checks.values())
    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "status": "ready" if ready else "not_ready",
            "service": "agora-api",
            "version": AGORA_VERSION,
            "checks": checks,
        },
    )
