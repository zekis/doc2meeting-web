"""add_meeting_tables

Create meeting_session and meeting_message tables for virtual meeting feature.

Revision ID: f3a1b2c4d5e6
Revises: e2b9f4c71a83
Create Date: 2026-06-13
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a1b2c4d5e6"
down_revision: Union[str, Sequence[str], None] = "e2b9f4c71a83"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "meeting_session",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.Integer, sa.ForeignKey("document.id"), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("user.id"), nullable=False, index=True),
        sa.Column("current_section_idx", sa.Integer, nullable=False, server_default="0"),
        sa.Column("current_paragraph_idx", sa.Integer, nullable=False, server_default="0"),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("ended_at", sa.DateTime, nullable=True),
    )
    op.create_table(
        "meeting_message",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("meeting_session.id"), nullable=False, index=True),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("section_idx", sa.Integer, nullable=False, server_default="0"),
        sa.Column("paragraph_idx", sa.Integer, nullable=False, server_default="0"),
        sa.Column("tool_action", sa.String(50), nullable=True),
        sa.Column("audio_path", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("meeting_message")
    op.drop_table("meeting_session")
