"""JWT auth helpers for WorkOS-backed API access."""

from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

security = HTTPBearer()


class AuthenticatedUser(BaseModel):
    id: str
    email: str
    display_name: str


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
) -> AuthenticatedUser:
    """Decode bearer token and return normalized user claims."""

    token = credentials.credentials

    try:
        payload = jwt.decode(
            token,
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
