"""phase_a1_storage_provider_drive_token

Add storage_provider and drive_refresh_token columns to user table
for cloud storage integration (Phase A-1).

Revision ID: d1a7f3b58e92
Revises: c8e3f1a42d67
Create Date: 2026-06-11
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d1a7f3b58e92"
down_revision: Union[str, Sequence[str], None] = "c8e3f1a42d67"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column(
            "storage_provider",
            sa.String(length=20),
            nullable=False,
            server_default="none",
        ),
    )
    op.add_column(
        "user",
        sa.Column(
            "drive_refresh_token",
            sa.String(length=2048),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("user", "drive_refresh_token")
    op.drop_column("user", "storage_provider")
