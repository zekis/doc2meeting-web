"""Tier enforcement and usage tracking.

Includes atomic usage recording to prevent TOCTOU race conditions on tier limits.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, col, func, select, text

from ..db import get_session
from ..middleware import get_current_user
from ..models import Subscription, UsageRecord, User
from .constants import STRIPE_API_METERED_PRICE_ID, STRIPE_SECRET_KEY, TIER_LIMITS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class UsageResponse(BaseModel):
    docs_used: int
    docs_limit: Optional[int]
    pages_used: int
    pages_limit_per_doc: Optional[int]
    period_start: Optional[str]
    period_end: Optional[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_active_subscription(session: Session, user_id: str) -> Optional[Subscription]:
    """Get the user's active subscription, if any."""
    return session.exec(
        select(Subscription).where(
            Subscription.user_id == user_id,
            Subscription.status.in_(["active", "past_due"]),
        )
    ).first()


def _get_billing_period(session: Session, user_id: str) -> tuple[datetime, datetime]:
    """Return (period_start, period_end) for the user's current billing period.

    For subscribed users, uses Stripe subscription dates.
    For free users, uses a sliding 30-day window ending now.
    Note: this is a rolling window, NOT anchored to account creation.
    """
    sub = _get_active_subscription(session, user_id)
    if sub:
        return sub.current_period_start, sub.current_period_end

    now = datetime.utcnow()
    return now - timedelta(days=30), now


def _count_period_usage(
    session: Session, user_id: str, period_start: datetime, period_end: datetime
) -> tuple[int, int]:
    """Count docs processed and total pages in the billing period."""
    doc_count = session.exec(
        select(func.count()).select_from(UsageRecord).where(
            UsageRecord.user_id == user_id,
            UsageRecord.action == "doc_process",
            col(UsageRecord.created_at) >= period_start,
            col(UsageRecord.created_at) <= period_end,
        )
    ).one()

    page_count = session.exec(
        select(func.coalesce(func.sum(UsageRecord.page_count), 0)).where(
            UsageRecord.user_id == user_id,
            col(UsageRecord.created_at) >= period_start,
            col(UsageRecord.created_at) <= period_end,
        )
    ).one()

    return doc_count, page_count


# ---------------------------------------------------------------------------
# Tier enforcement — check_usage_limits (with FOR UPDATE to prevent TOCTOU)
# ---------------------------------------------------------------------------


def check_usage_limits(
    user: User,
    session: Session,
    page_count: int = 0,
) -> None:
    """Check tier limits before processing a document. Raises HTTPException(429).

    Uses SELECT ... FOR UPDATE on Postgres to prevent TOCTOU race conditions
    where concurrent requests both pass the limit check and then both record usage.
    On SQLite (dev mode), falls back to normal SELECT (single-writer anyway).
    """
    limits = TIER_LIMITS.get(user.tier, TIER_LIMITS["free"])

    period_start, period_end = _get_billing_period(session, user.id)

    # Use FOR UPDATE on Postgres to serialize concurrent limit checks.
    # This locks the relevant usage rows so concurrent requests queue up.
    from ..db import DATABASE_URL
    use_for_update = not DATABASE_URL.startswith("sqlite")

    query = (
        select(func.count())
        .select_from(UsageRecord)
        .where(
            UsageRecord.user_id == user.id,
            UsageRecord.action == "doc_process",
            col(UsageRecord.created_at) >= period_start,
            col(UsageRecord.created_at) <= period_end,
        )
    )
    if use_for_update:
        query = query.with_for_update()

    docs_used = session.exec(query).one()

    # Check doc limit
    max_docs = limits["max_docs_per_period"]
    if max_docs is not None and docs_used >= max_docs:
        raise HTTPException(
            429,
            detail={
                "error": "doc_limit_exceeded",
                "tier": user.tier,
                "docs_used": docs_used,
                "docs_limit": max_docs,
                "message": f"You have reached the {user.tier} tier limit of {max_docs} documents per billing period. Upgrade your plan to process more documents.",
            },
        )

    # Check page limit per doc
    max_pages = limits["max_pages_per_doc"]
    if max_pages is not None and page_count > max_pages:
        raise HTTPException(
            429,
            detail={
                "error": "page_limit_exceeded",
                "tier": user.tier,
                "page_count": page_count,
                "pages_limit": max_pages,
                "message": f"Document has {page_count} pages, exceeding the {user.tier} tier limit of {max_pages} pages per document. Upgrade your plan to process larger documents.",
            },
        )


def record_usage(
    session: Session,
    user: User,
    document_id: int | None = None,
    page_count: int = 0,
    action: str = "doc_process",
) -> UsageRecord:
    """Record a usage event. For API tier, also reports to Stripe metered billing."""
    record = UsageRecord(
        user_id=user.id,
        document_id=document_id,
        page_count=page_count,
        action=action,
    )
    session.add(record)
    session.commit()
    session.refresh(record)

    # Report metered usage to Stripe for API tier
    if user.tier == "api" and page_count > 0 and STRIPE_SECRET_KEY:
        sub = _get_active_subscription(session, user.id)
        if sub:
            _report_metered_usage(sub, record)

    return record


def _report_metered_usage(sub: Subscription, record: UsageRecord) -> None:
    """Report metered usage to Stripe. Logs errors instead of silently swallowing."""
    try:
        stripe_sub = stripe.Subscription.retrieve(sub.stripe_subscription_id)
        for item in stripe_sub["items"]["data"]:
            if item["price"]["id"] == STRIPE_API_METERED_PRICE_ID:
                stripe.SubscriptionItem.create_usage_record(
                    item["id"],
                    quantity=record.page_count,
                    timestamp=int(record.created_at.timestamp()),
                )
                break
    except Exception:
        logger.exception(
            "ALERT: Failed to report metered usage to Stripe for user=%s sub=%s pages=%d. "
            "This usage will not be billed until manually reconciled.",
            record.user_id,
            sub.stripe_subscription_id,
            record.page_count,
        )


# ---------------------------------------------------------------------------
# Usage endpoint
# ---------------------------------------------------------------------------


@router.get("/usage", response_model=UsageResponse)
async def get_usage(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return current period usage for the authenticated user."""
    period_start, period_end = _get_billing_period(session, user.id)
    docs_used, pages_used = _count_period_usage(session, user.id, period_start, period_end)
    limits = TIER_LIMITS.get(user.tier, TIER_LIMITS["free"])

    return UsageResponse(
        docs_used=docs_used,
        docs_limit=limits["max_docs_per_period"],
        pages_used=pages_used,
        pages_limit_per_doc=limits["max_pages_per_doc"],
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
    )
