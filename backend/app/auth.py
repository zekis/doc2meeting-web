"""Google OAuth + JWT auth + refresh-token rotation.

Routes mounted at /api/auth:
  GET  /google/login    — redirect to Google consent screen
  GET  /google/callback — exchange code, upsert user, mint tokens
  POST /refresh         — rotate refresh token pair
  POST /logout          — revoke current refresh token
"""

from __future__ import annotations

import os
import urllib.parse
import uuid
from datetime import datetime, timedelta

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlmodel import Session, select

from .db import get_session
from .models import RefreshToken, User
from .users import upsert_by_google_sub

# ---------------------------------------------------------------------------
# Config — validated at import time
# ---------------------------------------------------------------------------

JWT_SECRET_KEY = os.environ.get(
    "JWT_SECRET_KEY",
    "dev-only-insecure-key-do-not-use-in-production!!",
)
if len(JWT_SECRET_KEY) < 32:
    raise RuntimeError("JWT_SECRET_KEY must be at least 32 characters")

ALGORITHM = "HS256"
ACCESS_TTL = timedelta(minutes=30)
REFRESH_TTL = timedelta(days=7)

OAUTH_REDIRECT_URI = os.environ.get("OAUTH_REDIRECT_URI", "")

# ---------------------------------------------------------------------------
# Authlib client
# ---------------------------------------------------------------------------

oauth = OAuth()
_google_client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
_google_client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")

if _google_client_id and _google_client_secret:
    oauth.register(
        name="google",
        client_id=_google_client_id,
        client_secret=_google_client_secret,
        server_metadata_url=(
            "https://accounts.google.com/.well-known/openid-configuration"
        ),
        client_kwargs={"scope": "openid email profile"},
    )

# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------


def create_access_token(user_id: str) -> str:
    return jwt.encode(
        {"sub": user_id, "type": "access", "exp": datetime.utcnow() + ACCESS_TTL},
        JWT_SECRET_KEY,
        algorithm=ALGORITHM,
    )


def create_refresh_token(user_id: str, jti: str) -> str:
    return jwt.encode(
        {
            "sub": user_id,
            "type": "refresh",
            "jti": jti,
            "exp": datetime.utcnow() + REFRESH_TTL,
        },
        JWT_SECRET_KEY,
        algorithm=ALGORITHM,
    )


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError as e:
        raise HTTPException(401, detail=f"invalid token: {e}")


def _mint_tokens(user_id: str, session: Session) -> tuple[str, str]:
    """Create an access + refresh token pair and persist the refresh jti."""
    jti = str(uuid.uuid4())
    access = create_access_token(user_id)
    refresh = create_refresh_token(user_id, jti)

    session.add(
        RefreshToken(
            jti=jti,
            user_id=user_id,
            expires_at=datetime.utcnow() + REFRESH_TTL,
        )
    )
    session.commit()
    return access, refresh


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/google/login")
async def google_login(request: Request):
    """Redirect the browser to Google's consent screen."""
    redirect_uri = OAUTH_REDIRECT_URI
    if not redirect_uri:
        raise HTTPException(500, detail="OAUTH_REDIRECT_URI not configured")
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/google/callback")
async def google_callback(request: Request, session: Session = Depends(get_session)):
    """Exchange the authorization code for user info, upsert, mint tokens."""
    token_data = await oauth.google.authorize_access_token(request)
    userinfo = token_data.get("userinfo")
    if not userinfo:
        raise HTTPException(400, detail="no userinfo in token response")

    google_sub = userinfo["sub"]
    email = userinfo.get("email", "")
    name = userinfo.get("name", email)

    user = upsert_by_google_sub(
        session, google_sub=google_sub, email=email, name=name,
    )

    access, refresh = _mint_tokens(user.id, session)

    # Redirect to frontend callback page with tokens in URL fragment
    # (fragment is never sent to the server — safer than query params)
    user_json = urllib.parse.quote(
        f'{{"id":"{user.id}","email":"{user.email}","name":"{user.name}","tier":"{user.tier}"}}'
    )
    frontend_url = OAUTH_REDIRECT_URI.rsplit("/", 1)[0]  # strip /auth/callback
    redirect_url = (
        f"{frontend_url}/auth/callback"
        f"#access={access}&refresh={refresh}&user={user_json}"
    )
    return RedirectResponse(url=redirect_url)


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str


@router.post("/refresh", response_model=TokenResponse)
def refresh_tokens(body: RefreshRequest, session: Session = Depends(get_session)):
    """Rotate: validate old refresh, revoke it, mint fresh pair."""
    payload = decode_token(body.refresh_token)

    if payload.get("type") != "refresh":
        raise HTTPException(401, detail="not a refresh token")

    jti = payload.get("jti")
    if not jti:
        raise HTTPException(401, detail="missing jti")

    row = session.get(RefreshToken, jti)
    if not row or row.revoked:
        # Possible token theft — revoke ALL tokens for this user
        if row:
            stmt = select(RefreshToken).where(
                RefreshToken.user_id == row.user_id,
                RefreshToken.revoked == False,  # noqa: E712
            )
            for rt in session.exec(stmt).all():
                rt.revoked = True
            session.commit()
        raise HTTPException(401, detail="refresh token revoked or unknown")

    # Revoke old
    row.revoked = True
    session.add(row)
    session.commit()

    # Mint new pair
    access, refresh = _mint_tokens(payload["sub"], session)
    return TokenResponse(access_token=access, refresh_token=refresh)


class LogoutRequest(BaseModel):
    refresh_token: str


@router.post("/logout")
def logout(body: LogoutRequest, session: Session = Depends(get_session)):
    """Revoke the given refresh token."""
    try:
        payload = decode_token(body.refresh_token)
    except HTTPException:
        return {"ok": True}  # already invalid — no-op

    jti = payload.get("jti")
    if jti:
        row = session.get(RefreshToken, jti)
        if row and not row.revoked:
            row.revoked = True
            session.add(row)
            session.commit()

    return {"ok": True}
