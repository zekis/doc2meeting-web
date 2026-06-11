"""Google Drive OAuth consent — separate from the login flow.

Routes mounted at /api/auth/drive:
  GET  /connect       — redirect to Google consent with drive.file scope
  GET  /callback      — exchange code, store encrypted refresh token, redirect
  POST /disconnect    — clear Drive token, reset storage_provider to "none"
  GET  /status        — check if current user has Drive connected

This is intentionally a separate OAuth registration from the login flow
so users who don't need Drive are never prompted for Drive permissions.
"""

from __future__ import annotations

import os
import urllib.parse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlmodel import Session

from .crypto import decrypt, encrypt
from .db import get_session
from .middleware import get_current_user
from .models import User

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
FRONTEND_BASE_URL = os.environ.get("FRONTEND_BASE_URL", "http://localhost:5173")
DRIVE_OAUTH_REDIRECT_URI = os.environ.get(
    "DRIVE_OAUTH_REDIRECT_URI",
    "http://localhost:8000/api/auth/drive/callback",
)

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
TIMEOUT = 10.0

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/auth/drive", tags=["drive-auth"])


@router.get("/connect")
async def drive_connect(request: Request, user: User = Depends(get_current_user)):
    """Redirect to Google consent screen requesting drive.file scope.

    Uses ``login_hint`` so Google pre-selects the user's account and
    ``access_type=offline`` + ``prompt=consent`` to guarantee a refresh token.
    """
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": DRIVE_OAUTH_REDIRECT_URI,
        "response_type": "code",
        "scope": DRIVE_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "login_hint": user.email,
        "state": user.id,  # carry user ID through the redirect
    }
    url = f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"
    return RedirectResponse(url)


@router.get("/callback")
async def drive_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    session: Session = Depends(get_session),
):
    """Exchange the authorization code for a refresh token and store it."""
    if error:
        # User denied or error from Google
        return RedirectResponse(
            f"{FRONTEND_BASE_URL}/settings?drive_error={urllib.parse.quote(error)}"
        )

    if not code or not state:
        raise HTTPException(400, detail="missing code or state")

    user = session.get(User, state)
    if not user:
        raise HTTPException(400, detail="invalid state (unknown user)")

    # Exchange code for tokens
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": DRIVE_OAUTH_REDIRECT_URI,
            },
        )
        if resp.status_code != 200:
            return RedirectResponse(
                f"{FRONTEND_BASE_URL}/settings?drive_error=token_exchange_failed"
            )
        token_data = resp.json()

    refresh_token = token_data.get("refresh_token")
    if not refresh_token:
        return RedirectResponse(
            f"{FRONTEND_BASE_URL}/settings?drive_error=no_refresh_token"
        )

    # Encrypt and store
    user.drive_refresh_token = encrypt(refresh_token)
    user.storage_provider = "google_drive"
    session.add(user)
    session.commit()

    return RedirectResponse(f"{FRONTEND_BASE_URL}/settings?drive_connected=true")


class DriveStatusResponse(BaseModel):
    connected: bool
    storage_provider: str


@router.get("/status", response_model=DriveStatusResponse)
async def drive_status(user: User = Depends(get_current_user)):
    """Check whether the current user has Google Drive connected."""
    return DriveStatusResponse(
        connected=user.storage_provider == "google_drive"
        and user.drive_refresh_token is not None,
        storage_provider=user.storage_provider,
    )


@router.post("/disconnect")
async def drive_disconnect(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Clear Drive credentials and reset storage provider."""
    user.storage_provider = "none"
    user.drive_refresh_token = None
    session.add(user)
    session.commit()
    return {"ok": True}
