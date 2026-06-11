"""Tests for Drive OAuth consent endpoints (/api/auth/drive/*)."""

import os
import uuid

import pytest
from unittest.mock import AsyncMock, patch, MagicMock

# Ensure test env vars before imports
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-at-least-32-characters-long!!")
os.environ.setdefault("DATABASE_URL", "sqlite:///")
os.environ.setdefault("ROOT_DIR", "/tmp/doc2meeting-test-root")
os.environ.setdefault("AUDIO_DIR", "/tmp/doc2meeting-test-audio")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-client-secret")

# Generate a real Fernet key for tests
from cryptography.fernet import Fernet

os.environ["ENCRYPTION_KEY"] = Fernet.generate_key().decode()

from app.models import User
from app.auth import create_access_token


def test_drive_status_not_connected(client, test_user, auth_headers):
    """New users should have Drive disconnected."""
    resp = client.get("/api/auth/drive/status", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["connected"] is False
    assert data["storage_provider"] == "none"


def test_drive_connect_redirects(client, test_user, auth_headers):
    """GET /connect should redirect to Google consent URL."""
    resp = client.get(
        "/api/auth/drive/connect",
        headers=auth_headers,
        follow_redirects=False,
    )
    assert resp.status_code in (302, 307)
    location = resp.headers["location"]
    assert "accounts.google.com" in location
    assert "drive.file" in location
    import urllib.parse
    assert urllib.parse.quote(test_user.email, safe="") in location


def test_drive_callback_missing_code(client):
    """Callback without code should 400."""
    resp = client.get("/api/auth/drive/callback?state=some-user-id")
    assert resp.status_code == 400


def test_drive_disconnect(client, test_user, auth_headers, session):
    """POST /disconnect should clear Drive fields."""
    # Manually set up a connected state
    test_user.storage_provider = "google_drive"
    test_user.drive_refresh_token = "encrypted-token"
    session.add(test_user)
    session.commit()

    resp = client.post("/api/auth/drive/disconnect", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # Verify state was cleared
    session.refresh(test_user)
    assert test_user.storage_provider == "none"
    assert test_user.drive_refresh_token is None


def test_drive_status_connected(client, test_user, auth_headers, session):
    """Status should report connected when token is set."""
    test_user.storage_provider = "google_drive"
    test_user.drive_refresh_token = "encrypted-token"
    session.add(test_user)
    session.commit()

    resp = client.get("/api/auth/drive/status", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["connected"] is True
    assert data["storage_provider"] == "google_drive"
