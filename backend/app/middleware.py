"""Auth dependency and tier-based rate limiting.

get_current_user: FastAPI dependency that extracts + validates a Bearer JWT
                  and returns the User row. Use as a router-level dependency
                  on all /api/ routes (except /api/auth/*).

Tier rate limits:
  free  = 10/minute
  pro   = 60/minute
  api   = 120/minute
  team  = 120/minute
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlmodel import Session

from slowapi import Limiter
from slowapi.util import get_remote_address

from .auth import decode_token
from .db import get_session
from .models import User

# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------


async def get_current_user(
    request: Request,
    session: Session = Depends(get_session),
) -> User:
    """Extract Bearer token, decode, look up user. Raises 401 on failure."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(401, detail="missing bearer token")

    token = auth_header.split(" ", 1)[1]
    payload = decode_token(token)

    if payload.get("type") != "access":
        raise HTTPException(401, detail="wrong token type")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(401, detail="invalid token payload")

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(401, detail="user not found")

    # Stash on request.state for rate limiter access
    request.state.current_user = user
    return user


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

TIER_LIMITS = {
    "free": "10/minute",
    "pro": "60/minute",
    "api": "120/minute",
    "team": "120/minute",
}


def _key_func(request: Request) -> str:
    user = getattr(request.state, "current_user", None)
    if user:
        return f"user:{user.tier}:{user.id}"
    return get_remote_address(request)


limiter = Limiter(key_func=_key_func)


def tier_limit(key: str = "") -> str:
    """Dynamic rate limit based on the authenticated user's tier.

    slowapi calls this with the result of ``_key_func`` (which encodes
    the tier) when the callable has a ``key`` parameter.
    """
    if key.startswith("user:"):
        # key format: "user:<tier>:<uuid>"
        parts = key.split(":", 2)
        if len(parts) >= 2:
            tier = parts[1]
            return TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    return TIER_LIMITS["free"]
