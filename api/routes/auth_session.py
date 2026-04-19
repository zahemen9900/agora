"""Authenticated session/bootstrap endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from api.auth import (
    AuthenticatedUser,
    get_auth_store,
    get_current_user,
    get_resolved_auth_config,
    principal_payload,
)
from api.models import (
    AuthConfigResponse,
    AuthMeResponse,
    FeatureFlagsResponse,
    PrincipalResponse,
    WorkspaceResponse,
)

router = APIRouter()
CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


@router.get("/auth/config", response_model=AuthConfigResponse)
async def auth_config() -> AuthConfigResponse:
    """Return frontend-safe auth bootstrap configuration."""

    resolved = get_resolved_auth_config()
    if not resolved["workos_client_id"]:
        raise HTTPException(status_code=503, detail="Auth client id is not configured")
    if not resolved["workos_authkit_domain"]:
        raise HTTPException(status_code=503, detail="AuthKit domain is not configured")
    return AuthConfigResponse.model_validate(resolved)


@router.get("/auth/me", response_model=AuthMeResponse)
async def auth_me(
    user: CurrentUser,
) -> AuthMeResponse:
    """Return normalized principal and workspace metadata for dashboard bootstrap."""

    store = get_auth_store()
    workspace = await store.get_workspace(user.workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return AuthMeResponse(
        principal=PrincipalResponse.model_validate(principal_payload(user)),
        workspace=WorkspaceResponse.model_validate(workspace),
        feature_flags=FeatureFlagsResponse(
            benchmarks_visible=user.auth_method == "jwt",
            api_keys_visible=user.auth_method == "jwt",
        ),
    )
