"""Workspace API key management endpoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException

from api.auth import (
    AuthenticatedUser,
    get_auth_store,
    get_current_user,
    require_human_user,
    require_scope,
)
from api.auth_keys import (
    DEFAULT_API_KEY_SCOPES,
    build_api_key_token,
    default_api_key_expiry,
    generate_api_key_material,
    hash_api_key_secret,
)
from api.models import (
    ApiKeyCreateRequest,
    ApiKeyCreateResponse,
    ApiKeyMetadataResponse,
)

router = APIRouter(prefix="/api-keys", tags=["api-keys"])
logger = structlog.get_logger(__name__)
CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


def _metadata_response(record: dict[str, object]) -> ApiKeyMetadataResponse:
    return ApiKeyMetadataResponse.model_validate(record)


@router.get("", response_model=list[ApiKeyMetadataResponse])
@router.get("/", response_model=list[ApiKeyMetadataResponse], include_in_schema=False)
async def list_api_keys(user: CurrentUser) -> list[ApiKeyMetadataResponse]:
    """Return safe metadata for the current workspace's API keys."""

    require_human_user(user)
    require_scope(user, "api_keys:read")
    store = get_auth_store()
    keys = await store.list_api_keys(user.workspace_id)
    return [_metadata_response(record) for record in keys]


@router.post("", response_model=ApiKeyCreateResponse)
@router.post("/", response_model=ApiKeyCreateResponse, include_in_schema=False)
async def create_api_key(
    request: ApiKeyCreateRequest,
    user: CurrentUser,
) -> ApiKeyCreateResponse:
    """Create a new workspace-scoped API key and reveal it once."""

    require_human_user(user)
    require_scope(user, "api_keys:write")
    store = get_auth_store()
    key_id, public_id, secret = generate_api_key_material()
    try:
        secret_hash = hash_api_key_secret(secret)
    except RuntimeError as exc:
        logger.error("api_key_creation_misconfigured", error=str(exc))
        raise HTTPException(status_code=503, detail="API key creation is not configured") from exc

    created_at = datetime.now(UTC)
    expires_at = default_api_key_expiry()
    record = {
        "key_id": key_id,
        "workspace_id": user.workspace_id,
        "name": request.name.strip(),
        "public_id": public_id,
        "secret_hash": secret_hash,
        "scopes": list(DEFAULT_API_KEY_SCOPES),
        "created_by_user_id": user.user_id or "",
        "created_at": created_at.isoformat(),
        "last_used_at": None,
        "expires_at": expires_at.isoformat() if expires_at else None,
        "revoked_at": None,
    }
    await store.save_api_key(user.workspace_id, key_id, record)
    safe_record = dict(record)
    safe_record.pop("secret_hash", None)
    return ApiKeyCreateResponse(
        api_key=build_api_key_token(public_id, secret),
        metadata=_metadata_response(safe_record),
    )


@router.post("/{key_id}/revoke", response_model=ApiKeyMetadataResponse)
async def revoke_api_key(
    key_id: str,
    user: CurrentUser,
) -> ApiKeyMetadataResponse:
    """Soft-revoke a workspace API key."""

    require_human_user(user)
    require_scope(user, "api_keys:write")
    store = get_auth_store()
    current = await store.get_api_key(user.workspace_id, key_id)
    if current is None:
        raise HTTPException(status_code=404, detail="API key not found")
    revoked = await store.update_api_key(
        user.workspace_id,
        key_id,
        {"revoked_at": datetime.now(UTC).isoformat()},
    )
    if revoked is None:
        raise HTTPException(status_code=404, detail="API key not found")
    revoked.pop("secret_hash", None)
    return _metadata_response(revoked)
