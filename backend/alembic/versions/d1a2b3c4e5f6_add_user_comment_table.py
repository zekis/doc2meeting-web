"""add_user_comment_table

Create user_comment table for STT voice comments on paragraphs.

Revision ID: d1a2b3c4e5f6
Revises: c8e3f1a42d67
Create Date: 2026-06-09
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d1a2b3c4e5f6"
down_revision: Union[str, Sequence[str], None] = "c8e3f1a42d67"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_comment",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("document_id", sa.Integer, sa.ForeignKey("document.id"), nullable=False, index=True),
        sa.Column("section_idx", sa.Integer, nullable=False, server_default="0"),
        sa.Column("paragraph_idx", sa.Integer, nullable=False, server_default="0"),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("user.id"), nullable=False, index=True),
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("user_comment")
