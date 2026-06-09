"""Admin billing and usage endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, col, func, select

from ..db import get_session
from ..middleware import get_current_user
from ..models import Subscription, UsageRecord, User

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class AdminBillingResponse(BaseModel):
    total_subscriptions: int
    active_subscriptions: int
    subscriptions_by_tier: dict
    mrr_cents: int
    total_docs_processed: int
    total_pages_processed: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_admin(user: User) -> None:
    """Raise 403 if user is not an admin."""
    if not user.is_admin:
        raise HTTPException(403, detail="admin access required")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/admin/billing", response_model=AdminBillingResponse)
async def admin_billing(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Revenue overview, active subscriptions by tier, MRR. Admin only."""
    _require_admin(user)

    total_subs = session.exec(
        select(func.count()).select_from(Subscription)
    ).one()

    active_subs = session.exec(
        select(func.count()).select_from(Subscription).where(
            Subscription.status == "active"
        )
    ).one()

    # Count by tier
    tier_counts = {}
    for tier in ("pro", "api"):
        count = session.exec(
            select(func.count()).select_from(Subscription).where(
                Subscription.status == "active",
                Subscription.tier == tier,
            )
        ).one()
        tier_counts[tier] = count

    # MRR: Pro = $15/mo, API = $30/mo base
    mrr_cents = tier_counts.get("pro", 0) * 1500 + tier_counts.get("api", 0) * 3000

    total_docs = session.exec(
        select(func.count()).select_from(UsageRecord).where(
            UsageRecord.action == "doc_process"
        )
    ).one()

    total_pages = session.exec(
        select(func.coalesce(func.sum(UsageRecord.page_count), 0))
        .select_from(UsageRecord)
    ).one()

    return AdminBillingResponse(
        total_subscriptions=total_subs,
        active_subscriptions=active_subs,
        subscriptions_by_tier=tier_counts,
        mrr_cents=mrr_cents,
        total_docs_processed=total_docs,
        total_pages_processed=total_pages,
    )


@router.get("/admin/usage")
async def admin_usage(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Aggregate usage stats. Admin only."""
    _require_admin(user)

    cutoff = datetime.utcnow() - timedelta(days=30)

    results = session.exec(
        select(
            UsageRecord.user_id,
            func.count().label("doc_count"),
            func.coalesce(func.sum(UsageRecord.page_count), 0).label("page_count"),
        )
        .where(col(UsageRecord.created_at) >= cutoff)
        .group_by(UsageRecord.user_id)
    ).all()

    return {
        "period_days": 30,
        "users": [
            {"user_id": r[0], "docs_processed": r[1], "pages_processed": r[2]}
            for r in results
        ],
    }
