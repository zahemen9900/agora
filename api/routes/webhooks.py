"""Webhook endpoints for Solana transaction callbacks."""

from __future__ import annotations

import hashlib
import hmac

from fastapi import APIRouter, Header, HTTPException, Request

from api.config import settings
from api.security import validate_storage_id
from api.streaming import get_stream_manager

router = APIRouter(prefix="/webhooks")


@router.post("/solana")
async def solana_webhook(
    request: Request,
    x_agora_signature: str | None = Header(default=None),
) -> dict[str, str]:
    body = await request.body()
    if len(body) > settings.webhook_max_bytes:
        raise HTTPException(status_code=413, detail="Webhook payload too large")
    _verify_webhook_signature(body, x_agora_signature)

    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Webhook payload must be JSON") from exc
    if not isinstance(payload, list):
        raise HTTPException(status_code=400, detail="Webhook payload must be a list")

    manager = get_stream_manager()

    for tx in payload:
        if not isinstance(tx, dict):
            continue
        task_id = tx.get("task_id")
        workspace_id = tx.get("workspace_id")
        user_id = tx.get("user_id")
        if not isinstance(task_id, str):
            continue
        try:
            validate_storage_id(task_id, field_name="task_id")
            if isinstance(workspace_id, str) and workspace_id:
                validate_storage_id(workspace_id, field_name="workspace_id")
            if isinstance(user_id, str) and user_id:
                validate_storage_id(user_id, field_name="user_id")
        except ValueError:
            continue
        resolved_workspace_id = (
            workspace_id
            if isinstance(workspace_id, str) and workspace_id
            else user_id
            if isinstance(user_id, str) and user_id
            else None
        )
        stream_id = (
            f"{resolved_workspace_id}:{task_id}"
            if isinstance(resolved_workspace_id, str) and resolved_workspace_id
            else task_id
        )
        await manager.emit(
            stream_id,
            {
                "event": "receipt_confirmed",
                "data": {
                    "task_id": task_id,
                    "signature": tx.get("signature", ""),
                },
            },
        )

    return {"status": "ok"}


def _verify_webhook_signature(body: bytes, signature: str | None) -> None:
    """Verify HMAC-SHA256 webhook signatures."""

    secret = settings.webhook_secret.strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Webhook verification is not configured")
    if not signature:
        raise HTTPException(status_code=401, detail="Missing webhook signature")

    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    provided = signature.removeprefix("sha256=").strip()
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")
