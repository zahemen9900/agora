"""Health check routes."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "agora-api",
        "version": "0.1.0",
        "solana_network": "devnet",
    }
