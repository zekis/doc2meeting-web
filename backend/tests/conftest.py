"""Shared test fixtures for Phase 1 auth tests."""
import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel

# Set test env vars BEFORE importing app modules
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-at-least-32-characters-long!!")
os.environ.setdefault("DATABASE_URL", "sqlite:///")
os.environ.setdefault("ROOT_DIR", "/tmp/doc2meeting-test-root")
os.environ.setdefault("AUDIO_DIR", "/tmp/doc2meeting-test-audio")

from app.db import engine, init_db
from app.auth import create_access_token, create_refresh_token, JWT_SECRET_KEY
from app.models import User, RefreshToken, Document
from datetime import datetime, timedelta


@pytest.fixture(autouse=True)
def setup_db():
    """Create all tables before each test, drop after."""
    SQLModel.metadata.create_all(engine)
    yield
    SQLModel.metadata.drop_all(engine)


@pytest.fixture
def session():
    with Session(engine) as s:
        yield s


@pytest.fixture
def test_user(session):
    """Create and return a test user."""
    user = User(
        id=str(uuid.uuid4()),
        email="test@example.com",
        name="Test User",
        tier="free",
        google_sub=f"google-{uuid.uuid4()}",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@pytest.fixture
def auth_headers(test_user):
    """Return auth headers with a valid access token."""
    token = create_access_token(test_user.id)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def client():
    """FastAPI test client."""
    # Ensure root dir exists for filesystem routes
    os.makedirs(os.environ.get("ROOT_DIR", "/tmp/doc2meeting-test-root"), exist_ok=True)
    from app.main import app
    return TestClient(app)
