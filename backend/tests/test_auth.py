"""Phase 1 auth smoke tests.

Tests JWT lifecycle, token refresh rotation, logout, and auth protection.
"""
import uuid
from datetime import datetime, timedelta

import pytest
from jose import jwt
from sqlmodel import Session

from app.auth import (
    ALGORITHM,
    JWT_SECRET_KEY,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from app.models import Document, RefreshToken, User


class TestJWTHelpers:
    def test_create_access_token_decodes(self, test_user):
        token = create_access_token(test_user.id)
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[ALGORITHM])
        assert payload["sub"] == test_user.id
        assert payload["type"] == "access"

    def test_create_refresh_token_decodes(self, test_user):
        jti = str(uuid.uuid4())
        token = create_refresh_token(test_user.id, jti)
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[ALGORITHM])
        assert payload["sub"] == test_user.id
        assert payload["type"] == "refresh"
        assert payload["jti"] == jti

    def test_decode_invalid_token_raises(self):
        with pytest.raises(Exception):
            decode_token("not.a.token")

    def test_access_token_has_expiry(self, test_user):
        token = create_access_token(test_user.id)
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[ALGORITHM])
        assert "exp" in payload
        exp = datetime.utcfromtimestamp(payload["exp"])
        assert exp > datetime.utcnow()
        assert exp < datetime.utcnow() + timedelta(hours=1)


class TestAuthEndpoints:
    def test_routes_require_auth(self, client):
        """All /api/ routes (except /api/auth/*) should return 401 without token."""
        protected_routes = [
            ("GET", "/api/tree"),
            ("GET", "/api/documents"),
            ("GET", "/api/settings"),
        ]
        for method, path in protected_routes:
            r = client.request(method, path)
            assert r.status_code == 401, f"{method} {path} should require auth"

    def test_auth_routes_accessible(self, client):
        """Auth routes should not 401 (they may 4xx for other reasons)."""
        # refresh endpoint should accept POST with body
        r = client.post("/api/auth/refresh", json={"refresh_token": "fake"})
        assert r.status_code != 404  # route exists

        # logout should work
        r = client.post("/api/auth/logout", json={"refresh_token": "fake"})
        assert r.status_code == 200

    def test_refresh_token_rotation(self, client, test_user, session):
        """Refresh should revoke old token and return new pair."""
        jti = str(uuid.uuid4())
        refresh = create_refresh_token(test_user.id, jti)
        # Store the refresh token in DB
        session.add(RefreshToken(
            jti=jti,
            user_id=test_user.id,
            expires_at=datetime.utcnow() + timedelta(days=7),
        ))
        session.commit()

        r = client.post("/api/auth/refresh", json={"refresh_token": refresh})
        assert r.status_code == 200
        data = r.json()
        assert "access_token" in data
        assert "refresh_token" in data

        # Old token should now be revoked
        session.expire_all()
        old_rt = session.get(RefreshToken, jti)
        assert old_rt.revoked is True

    def test_refresh_reuse_revokes_all(self, client, test_user, session):
        """Reusing a revoked refresh token should revoke ALL user tokens."""
        jti1 = str(uuid.uuid4())
        jti2 = str(uuid.uuid4())
        refresh1 = create_refresh_token(test_user.id, jti1)

        session.add(RefreshToken(
            jti=jti1, user_id=test_user.id, revoked=True,
            expires_at=datetime.utcnow() + timedelta(days=7),
        ))
        session.add(RefreshToken(
            jti=jti2, user_id=test_user.id, revoked=False,
            expires_at=datetime.utcnow() + timedelta(days=7),
        ))
        session.commit()

        r = client.post("/api/auth/refresh", json={"refresh_token": refresh1})
        assert r.status_code == 401

        # jti2 should also be revoked now
        session.expire_all()
        rt2 = session.get(RefreshToken, jti2)
        assert rt2.revoked is True

    def test_logout_revokes_token(self, client, test_user, session):
        """Logout should revoke the refresh token."""
        jti = str(uuid.uuid4())
        refresh = create_refresh_token(test_user.id, jti)
        session.add(RefreshToken(
            jti=jti, user_id=test_user.id,
            expires_at=datetime.utcnow() + timedelta(days=7),
        ))
        session.commit()

        r = client.post("/api/auth/logout", json={"refresh_token": refresh})
        assert r.status_code == 200
        assert r.json() == {"ok": True}

        session.expire_all()
        rt = session.get(RefreshToken, jti)
        assert rt.revoked is True


class TestDocumentIsolation:
    def test_user_only_sees_own_documents(self, client, test_user, session, auth_headers):
        """User A's documents should not appear in User B's list."""
        # Create a document for user A
        doc = Document(
            rel_path="test.md",
            content_hash="abc",
            user_id=test_user.id,
        )
        session.add(doc)
        session.commit()

        # User A should see it
        r = client.get("/api/documents", headers=auth_headers)
        assert r.status_code == 200
        docs = r.json()
        assert len(docs) == 1
        assert docs[0]["rel_path"] == "test.md"

        # User B should not see it
        user_b = User(
            id=str(uuid.uuid4()),
            email="b@example.com",
            name="User B",
            google_sub=f"google-{uuid.uuid4()}",
        )
        session.add(user_b)
        session.commit()
        token_b = create_access_token(user_b.id)
        r = client.get("/api/documents", headers={"Authorization": f"Bearer {token_b}"})
        assert r.status_code == 200
        assert len(r.json()) == 0

    def test_user_cannot_access_other_users_doc(self, client, test_user, session, auth_headers):
        """GET /api/documents/{id} should 404 for docs owned by another user."""
        other = User(
            id=str(uuid.uuid4()),
            email="other@example.com",
            name="Other",
            google_sub=f"google-{uuid.uuid4()}",
        )
        session.add(other)
        session.commit()

        doc = Document(
            rel_path="other.md",
            content_hash="xyz",
            user_id=other.id,
        )
        session.add(doc)
        session.commit()

        r = client.get(f"/api/documents/{doc.id}", headers=auth_headers)
        assert r.status_code == 404


class TestUserCrud:
    def test_upsert_by_google_sub(self, session):
        from app.users import upsert_by_google_sub

        user1 = upsert_by_google_sub(
            session, google_sub="sub123", email="a@test.com", name="Alice"
        )
        assert user1.email == "a@test.com"

        # Upsert again with different email
        user2 = upsert_by_google_sub(
            session, google_sub="sub123", email="alice@test.com", name="Alice Updated"
        )
        assert user2.id == user1.id
        assert user2.email == "alice@test.com"
        assert user2.name == "Alice Updated"
