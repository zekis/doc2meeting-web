"""Database engine and one-shot schema init.

Schema reset for the filesystem-backed model. No migrations from the
upload-backed schema — drop the old `.db` file before first run.
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine


_DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./data/doc2meeting.db")

engine = create_engine(
    _DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False} if _DATABASE_URL.startswith("sqlite") else {},
)


def init_db() -> None:
    if _DATABASE_URL.startswith("sqlite:///"):
        db_path = _DATABASE_URL.removeprefix("sqlite:///")
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    from . import models  # noqa: F401
    SQLModel.metadata.create_all(engine)
    _add_optional_columns()


def _add_optional_columns() -> None:
    """Idempotent ALTER TABLE for columns added after the table's first
    creation. SQLModel's create_all only creates new tables; existing tables
    don't get new columns. Adding optional columns here lets us evolve the
    schema without forcing a full DB drop."""
    optional_cols = {
        "review": [
            ("narrator_response_text", "TEXT"),
            ("llm_input_tokens", "INTEGER DEFAULT 0"),
            ("llm_output_tokens", "INTEGER DEFAULT 0"),
            ("tts_chars", "INTEGER DEFAULT 0"),
        ],
    }
    with engine.connect() as conn:
        for table, cols in optional_cols.items():
            for col_name, col_type in cols:
                try:
                    conn.exec_driver_sql(
                        f"ALTER TABLE {table} ADD COLUMN {col_name} {col_type}"
                    )
                    conn.commit()
                except Exception:
                    # Column already exists (or table doesn't yet — harmless).
                    pass


def get_session() -> Session:
    return Session(engine)
