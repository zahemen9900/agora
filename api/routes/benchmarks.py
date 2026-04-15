"""Benchmark summary API endpoint."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException

from api.config import settings
from api.routes.tasks import get_task_store

router = APIRouter()

_RESULTS_PATH = (
    Path(__file__).resolve().parents[2] / "benchmarks" / "results" / "phase2_validation.json"
)


@router.get("/benchmarks")
async def get_benchmarks(
    x_agora_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Return the latest persisted benchmark summary."""

    if not settings.benchmark_admin_token:
        raise HTTPException(status_code=403, detail="Benchmark access is not configured")
    if x_agora_admin_token != settings.benchmark_admin_token:
        raise HTTPException(status_code=403, detail="Benchmark access denied")

    store = get_task_store()
    summary = await store.get_benchmark_summary()
    if summary is not None:
        return summary

    if _RESULTS_PATH.exists():
        payload = json.loads(_RESULTS_PATH.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload

    raise HTTPException(status_code=404, detail="Benchmark summary is not available yet")
