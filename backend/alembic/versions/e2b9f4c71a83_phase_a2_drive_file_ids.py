"""phase_a2_drive_file_ids

Add drive_file_id to document and drive audio IDs to review
for Google Drive storage integration (Phase A-2).

Revision ID: e2b9f4c71a83
Revises: d1a7f3b58e92
Create Date: 2026-06-11
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e2b9f4c71a83"
down_revision: Union[str, Sequence[str], None] = "d1a7f3b58e92"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "document",
        sa.Column("drive_file_id", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "review",
        sa.Column("narrator_drive_id", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "review",
        sa.Column("reviewer_drive_id", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "review",
        sa.Column("response_drive_id", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("review", "response_drive_id")
    op.drop_column("review", "reviewer_drive_id")
    op.drop_column("review", "narrator_drive_id")
    op.drop_column("document", "drive_file_id")
