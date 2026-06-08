"""phase1_users_refresh_token_user_id_fks

Creates User and RefreshToken tables, adds user_id FK to Document.
Backfills existing Document rows with a system user.

Revision ID: 3f4b6297ece5
Revises:
Create Date: 2026-06-08 21:09:21.167172
"""

from typing import Sequence, Union
import uuid

from alembic import op
import sqlalchemy as sa


revision: str = "3f4b6297ece5"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"


def upgrade() -> None:
    # 1. Create user table
    op.create_table(
        "user",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), unique=True, nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("tier", sa.String(20), nullable=False, server_default="free"),
        sa.Column("google_sub", sa.String(64), unique=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_user_email", "user", ["email"])
    op.create_index("ix_user_google_sub", "user", ["google_sub"])
    op.create_index("ix_user_tier", "user", ["tier"])
    op.create_index("ix_user_created_at", "user", ["created_at"])

    # 2. Create refresh_token table
    op.create_table(
        "refresh_token",
        sa.Column("jti", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("user.id"),
            nullable=False,
        ),
        sa.Column(
            "revoked", sa.Boolean, nullable=False, server_default=sa.text("0")
        ),
        sa.Column("expires_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_refresh_token_user_id", "refresh_token", ["user_id"])
    op.create_index("ix_refresh_token_revoked", "refresh_token", ["revoked"])

    # 3. Insert system user for backfilling existing documents
    op.execute(
        sa.text(
            "INSERT INTO \"user\" (id, email, name, tier, google_sub) "
            "VALUES (:id, :email, :name, :tier, :sub)"
        ).bindparams(
            id=SYSTEM_USER_ID,
            email="system@doc2meeting.local",
            name="System",
            tier="api",
            sub="system",
        )
    )

    # 4. Add user_id column to document (nullable first for backfill)
    op.add_column(
        "document",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("user.id"), nullable=True),
    )
    op.create_index("ix_document_user_id", "document", ["user_id"])

    # 5. Backfill existing docs to system user
    op.execute(
        sa.text(
            "UPDATE document SET user_id = :uid WHERE user_id IS NULL"
        ).bindparams(uid=SYSTEM_USER_ID)
    )


def downgrade() -> None:
    # Remove user_id from document
    op.drop_index("ix_document_user_id", table_name="document")
    op.drop_column("document", "user_id")

    # Drop refresh_token
    op.drop_index("ix_refresh_token_revoked", table_name="refresh_token")
    op.drop_index("ix_refresh_token_user_id", table_name="refresh_token")
    op.drop_table("refresh_token")

    # Delete system user and drop user table
    op.execute(sa.text("DELETE FROM \"user\" WHERE id = :id").bindparams(id=SYSTEM_USER_ID))
    op.drop_index("ix_user_created_at", table_name="user")
    op.drop_index("ix_user_tier", table_name="user")
    op.drop_index("ix_user_google_sub", table_name="user")
    op.drop_index("ix_user_email", table_name="user")
    op.drop_table("user")
