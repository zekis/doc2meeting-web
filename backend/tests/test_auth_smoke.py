"""Phase 1 auth smoke tests.

Tests:
  1. Unauthenticated requests get 401
  2. Valid bearer token gets 200
  3. Document isolation: user A's docs invisible to user B
  4. Rate limit: free-tier returns 429 after 10 calls/min
  5. JWT refresh rotation works
  6. Revoked refresh token is rejected
"""

import os
import uuid
from datetime import datetime, timedelta

import pytest
from sqlmodel import Session

from app.auth import create_access_token, create_refresh_token, _mint_tokens
from app.db import engine
from app.models import Document, RefreshToken, User


def _make_user(session: Session, *, email: str = None, tier: str = "free") -> User:
    uid = str(uuid.uuid4())
    user = User(
        id=uid,
        email=email or f"{uid[:8]}@test.com",
        name=f"User {uid[:6]}",
        tier=tier,
        google_sub=f"sub-{uid}",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _auth_for(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


# ---- 1. Unauthenticated = 401 ----

class TestUnauthenticated:
    """All /api/ routes (except /api/auth/*) require a bearer token."""

    @pytest.mark.parametrize("method,url", [
        ("GET", "/api/tree"),
        ("GET", "/api/documents"),
        ("GET", "/api/settings"),
        ("POST", "/api/transcribe"),
    ])
    def test_no_token_returns_401(self, client, method, url):
        r = getattr(client, method.lower())(url)
        assert r.status_code == 401

    def test_bad_token_returns_401(self, client):
        r = client.get("/api/tree", headers={"Authorization": "Bearer garbage"})
        assert r.status_code == 401


# ---- 2. Valid bearer = 200 ----

class TestAuthenticated:
    def test_tree_returns_200(self, client, auth_headers):
        r = client.get("/api/tree", headers=auth_headers)
        assert r.status_code == 200
        data = r.json()
        assert "tree" in data

    def test_documents_returns_200(self, client, auth_headers):
        r = client.get("/api/documents", headers=auth_headers)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_settings_returns_200(self, client, auth_headers):
        r = client.get("/api/settings", headers=auth_headers)
        assert r.status_code == 200


# ---- 3. Document isolation ----

class TestDocumentIsolation:
    def test_user_a_doc_invisible_to_user_b(self, client, session):
        user_a = _make_user(session, email="a@test.com")
        user_b = _make_user(session, email="b@test.com")

        # Create a document owned by user A
        doc = Document(
            rel_path="test.md",
            content_hash="abc123",
            user_id=user_a.id,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)

        # User A sees it
        r = client.get("/api/documents", headers=_auth_for(user_a))
        assert r.status_code == 200
        docs_a = r.json()
        assert any(d["id"] == doc.id for d in docs_a)

        # User B does NOT see it
        r = client.get("/api/documents", headers=_auth_for(user_b))
        assert r.status_code == 200
        docs_b = r.json()
        assert not any(d["id"] == doc.id for d in docs_b)

    def test_user_b_gets_404_for_user_a_doc(self, client, session):
        user_a = _make_user(session, email="a2@test.com")
        user_b = _make_user(session, email="b2@test.com")

        doc = Document(
            rel_path="secret.md",
            content_hash="xyz",
            user_id=user_a.id,
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)

        r = client.get(f"/api/documents/{doc.id}", headers=_auth_for(user_b))
        assert r.status_code == 404


# ---- 4. Rate limiting ----

class TestRateLimit:
    def test_rate_limiter_is_configured(self, client):
        """Verify the rate limiter middleware is wired up."""
        from app.main import app
        assert hasattr(app.state, "limiter")
        from app.middleware import TIER_LIMITS
        assert TIER_LIMITS["free"] == "10/minute"
        assert TIER_LIMITS["pro"] == "60/minute"
        assert TIER_LIMITS["api"] == "120/minute"

    def test_rate_limit_enforces_429(self, client, session):
        """Free-tier user should get 429 after exceeding 10 requests/minute."""
        from app.middleware import limiter
        # Reset limiter storage so prior tests don't interfere
        limiter.reset()

        user = _make_user(session, email="ratelimit@test.com", tier="free")
        headers = _auth_for(user)

        # Free tier = 10/minute. Fire 11 requests to a rate-limited route.
        statuses = []
        for _ in range(11):
            r = client.get("/api/documents", headers=headers)
            statuses.append(r.status_code)

        assert 429 in statuses, f"Expected a 429 in {statuses}"


# ---- 5. JWT refresh rotation ----

class TestRefreshRotation:
    def test_refresh_returns_new_pair(self, client, session):
        user = _make_user(session, email="refresh@test.com")
        _access, refresh = _mint_tokens(user.id, session)

        r = client.post("/api/auth/refresh", json={"refresh_token": refresh})
        assert r.status_code == 200
        data = r.json()
        assert "access_token" in data
        assert "refresh_token" in data
        # New refresh token has a different jti
        assert data["refresh_token"] != refresh

    def test_reuse_revoked_refresh_fails(self, client, session):
        user = _make_user(session, email="revoke@test.com")
        _access, refresh = _mint_tokens(user.id, session)

        # First use — succeeds
        r1 = client.post("/api/auth/refresh", json={"refresh_token": refresh})
        assert r1.status_code == 200

        # Second use of same token — should fail (revoked)
        r2 = client.post("/api/auth/refresh", json={"refresh_token": refresh})
        assert r2.status_code == 401


# ---- 6. Logout ----

class TestLogout:
    def test_logout_revokes_refresh(self, client, session):
        user = _make_user(session, email="logout@test.com")
        _access, refresh = _mint_tokens(user.id, session)

        r = client.post("/api/auth/logout", json={"refresh_token": refresh})
        assert r.status_code == 200

        # Refresh should now fail
        r2 = client.post("/api/auth/refresh", json={"refresh_token": refresh})
        assert r2.status_code == 401
