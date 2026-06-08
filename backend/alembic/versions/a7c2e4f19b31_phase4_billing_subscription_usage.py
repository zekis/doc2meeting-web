"""phase4_billing_subscription_usage

Add Subscription and UsageRecord tables, stripe_customer_id and is_admin to User.

Revision ID: a7c2e4f19b31
Revises: 3f4b6297ece5
Create Date: 2026-06-09
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7c2e4f19b31"
down_revision: Union[str, Sequence[str], None] = "3f4b6297ece5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add stripe_customer_id and is_admin to user table
    op.add_column(
        "user",
        sa.Column("stripe_customer_id", sa.String(64), nullable=True),
    )
    op.create_index("ix_user_stripe_customer_id", "user", ["stripe_customer_id"])

    op.add_column(
        "user",
        sa.Column("is_admin", sa.Boolean, nullable=False, server_default=sa.false()),
    )

    # 2. Create subscription table
    op.create_table(
        "subscription",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("user.id"),
            nullable=False,
        ),
        sa.Column("stripe_customer_id", sa.String(64), nullable=False),
        sa.Column("stripe_subscription_id", sa.String(64), nullable=False, unique=True),
        sa.Column("stripe_price_id", sa.String(64), nullable=False),
        sa.Column("tier", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("current_period_start", sa.DateTime, nullable=False),
        sa.Column("current_period_end", sa.DateTime, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("canceled_at", sa.DateTime, nullable=True),
    )
    op.create_index("ix_subscription_user_id", "subscription", ["user_id"])
    op.create_index("ix_subscription_stripe_customer_id", "subscription", ["stripe_customer_id"])
    op.create_index("ix_subscription_stripe_subscription_id", "subscription", ["stripe_subscription_id"])
    op.create_index("ix_subscription_status", "subscription", ["status"])

    # 3. Create usage_record table
    op.create_table(
        "usage_record",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("user.id"),
            nullable=False,
        ),
        sa.Column(
            "document_id",
            sa.Integer,
            sa.ForeignKey("document.id"),
            nullable=True,
        ),
        sa.Column("page_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("action", sa.String(30), nullable=False, server_default="doc_process"),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_usage_record_user_id", "usage_record", ["user_id"])
    op.create_index("ix_usage_record_created_at", "usage_record", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_usage_record_created_at", table_name="usage_record")
    op.drop_index("ix_usage_record_user_id", table_name="usage_record")
    op.drop_table("usage_record")

    op.drop_index("ix_subscription_status", table_name="subscription")
    op.drop_index("ix_subscription_stripe_subscription_id", table_name="subscription")
    op.drop_index("ix_subscription_stripe_customer_id", table_name="subscription")
    op.drop_index("ix_subscription_user_id", table_name="subscription")
    op.drop_table("subscription")

    op.drop_column("user", "is_admin")
    op.drop_index("ix_user_stripe_customer_id", table_name="user")
    op.drop_column("user", "stripe_customer_id")
