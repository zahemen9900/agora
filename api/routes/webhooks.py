"""Webhook endpoints for Solana transaction callbacks."""

from __future__ import annotations

from fastapi import APIRouter, Request

from api.streaming import get_stream_manager

router = APIRouter(prefix="/webhooks")


@router.post("/solana")
async def solana_webhook(request: Request) -> dict[str, str]:
    payload = await request.json()
    manager = get_stream_manager()

    for tx in payload if isinstance(payload, list) else []:
        task_id = tx.get("task_id")
        if not task_id:
            continue
        await manager.publish(
            task_id,
            {
                "event": "receipt_confirmed",
                "data": {
                    "task_id": task_id,
                    "signature": tx.get("signature", ""),
                },
            },
        )

    return {"status": "ok"}
