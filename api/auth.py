"""JWT auth helpers for WorkOS-backed API access."""

from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

security = HTTPBearer(auto_error=False)


class AuthenticatedUser(BaseModel):
    id: str
    email: str
    display_name: str


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
    token: str | None = Query(default=None),
) -> AuthenticatedUser:
    """Decode bearer token and return normalized user claims."""

    raw_token = credentials.credentials if credentials is not None else token
    if not raw_token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    try:
        payload = jwt.decode(
            raw_token,
            options={"verify_signature": False},
            algorithms=["RS256"],
        )
    except jwt.PyJWTError as exc:  # pragma: no cover - simple scaffold
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}") from exc

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing sub claim")

    return AuthenticatedUser(
        id=user_id,
        email=payload.get("email", ""),
        display_name=payload.get("first_name") or payload.get("name") or "Unknown",
    )
