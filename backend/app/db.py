"""Database engine and session factory.

Supports both SQLite (single-user dev) and PostgreSQL (multi-user prod).
When using Postgres, Alembic manages migrations. SQLite still uses create_all
for backwards compat during local dev.
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy.pool import QueuePool, StaticPool
from sqlmodel import Session, SQLModel, create_engine


DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./data/doc2meeting.db")

_is_sqlite = DATABASE_URL.startswith("sqlite")

if _is_sqlite:
    engine = create_engine(
        DATABASE_URL,
        echo=False,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
else:
    engine = create_engine(
        DATABASE_URL,
        echo=False,
        poolclass=QueuePool,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
    )


def init_db() -> None:
    """Create tables. For Postgres, prefer `alembic upgrade head` instead."""
    if _is_sqlite:
        db_path = DATABASE_URL.removeprefix("sqlite:///")
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    from . import models  # noqa: F401
    SQLModel.metadata.create_all(engine)


def get_session():
    """Dependency-injection–friendly session generator."""
    with Session(engine) as session:
        yield session
