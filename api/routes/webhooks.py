"""Webhook endpoints for Solana transaction callbacks."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Header, HTTPException, Request

from api.coordination import get_coordination_backend
from api.config import settings
from api.security import validate_storage_id
from api.streaming import get_stream_manager

router = APIRouter(prefix="/webhooks")


@router.post("/solana")
async def solana_webhook(
    request: Request,
    x_agora_signature: str | None = Header(default=None),
    x_agora_timestamp: str | None = Header(default=None),
) -> dict[str, str]:
    body = await request.body()
    if len(body) > settings.webhook_max_bytes:
        raise HTTPException(status_code=413, detail="Webhook payload too large")
    timestamp = _verify_webhook_signature(body, x_agora_signature, x_agora_timestamp)

    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Webhook payload must be JSON") from exc
    if not isinstance(payload, list):
        raise HTTPException(status_code=400, detail="Webhook payload must be a list")

    await _assert_not_replayed(payload, timestamp=timestamp)

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


async def _assert_not_replayed(payload: list[object], *, timestamp: int) -> None:
    """Reject duplicate webhook entries for the active replay window."""

    backend = get_coordination_backend()
    ttl_seconds = settings.webhook_replay_ttl_seconds

    for tx in payload:
        if not isinstance(tx, dict):
            continue

        task_id = tx.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            continue

        signature = tx.get("signature")
        if isinstance(signature, str) and signature:
            token = signature
        else:
            token = hashlib.sha256(
                json.dumps(tx, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()

        dedupe_key = f"webhook:{timestamp}:{task_id}:{token}"
        claimed = await backend.claim_dedupe_key(
            dedupe_key,
            ttl_seconds=ttl_seconds,
        )
        if not claimed:
            raise HTTPException(status_code=409, detail="Duplicate webhook payload")


def _verify_webhook_signature(
    body: bytes,
    signature: str | None,
    timestamp: str | None,
) -> int:
    """Verify HMAC-SHA256 webhook signatures."""

    secret = settings.webhook_secret.strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Webhook verification is not configured")
    if not signature:
        raise HTTPException(status_code=401, detail="Missing webhook signature")
    if not timestamp:
        raise HTTPException(status_code=401, detail="Missing webhook timestamp")

    try:
        timestamp_int = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid webhook timestamp") from exc

    now_ts = int(datetime.now(UTC).timestamp())
    if abs(now_ts - timestamp_int) > settings.webhook_timestamp_skew_seconds:
        raise HTTPException(status_code=401, detail="Stale webhook timestamp")

    signed_payload = f"{timestamp_int}.".encode("utf-8") + body
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()

    provided = signature.removeprefix("sha256=").strip()
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    return timestamp_int
