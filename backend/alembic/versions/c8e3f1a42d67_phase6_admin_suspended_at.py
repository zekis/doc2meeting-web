"""phase6_admin_suspended_at

Add suspended_at column to user table for admin suspend/unsuspend.

Revision ID: c8e3f1a42d67
Revises: a7c2e4f19b31
Create Date: 2026-06-09
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c8e3f1a42d67"
down_revision: Union[str, Sequence[str], None] = "a7c2e4f19b31"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column("suspended_at", sa.DateTime, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user", "suspended_at")
