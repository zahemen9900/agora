"""Health check routes."""

from __future__ import annotations

from fastapi import APIRouter
from agora.version import __version__ as AGORA_VERSION

router = APIRouter()


@router.get("/health")
async def health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "agora-api",
        "version": AGORA_VERSION,
        "solana_network": "devnet",
    }
