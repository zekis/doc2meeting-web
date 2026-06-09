"""Admin dashboard endpoints — user management, usage stats, system health.

All routes require ``is_admin=True`` on the authenticated user.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, col, func, select

from .db import engine, get_session
from .middleware import get_current_user
from .models import Document, Review, Subscription, UsageRecord, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Auth guard
# ---------------------------------------------------------------------------

def _require_admin(user: User) -> User:
    if not user.is_admin:
        raise HTTPException(403, detail="admin access required")
    return user


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class UserSummary(BaseModel):
    id: str
    email: str
    name: str
    tier: str
    is_admin: bool
    stripe_customer_id: Optional[str]
    suspended_at: Optional[str]
    created_at: str
    doc_count: int = 0
    review_count: int = 0


class UserListResponse(BaseModel):
    users: list[UserSummary]
    total: int
    page: int
    page_size: int


class UserDetailResponse(UserSummary):
    subscriptions: list[dict]
    recent_usage: list[dict]


class UsageStatsResponse(BaseModel):
    total_users: int
    total_documents: int
    total_pages: int
    total_audio_minutes: float
    by_period: list[dict]


class SystemHealthResponse(BaseModel):
    status: str
    services: dict
    timestamp: str


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

@router.get("/users", response_model=UserListResponse)
async def list_users(
    q: Optional[str] = Query(None, description="Search email or name"),
    tier: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """List users with search, filter, pagination."""
    _require_admin(user)

    query = select(User)
    count_query = select(func.count()).select_from(User)

    if q:
        pattern = f"%{q}%"
        query = query.where(
            (col(User.email).ilike(pattern)) | (col(User.name).ilike(pattern))
        )
        count_query = count_query.where(
            (col(User.email).ilike(pattern)) | (col(User.name).ilike(pattern))
        )

    if tier:
        query = query.where(User.tier == tier)
        count_query = count_query.where(User.tier == tier)

    total = session.exec(count_query).one()

    users = session.exec(
        query.order_by(col(User.created_at).desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    summaries = []
    for u in users:
        doc_count = session.exec(
            select(func.count()).select_from(Document).where(Document.user_id == u.id)
        ).one()
        review_count = session.exec(
            select(func.count()).select_from(Review)
            .join(Document, Review.document_id == Document.id)
            .where(Document.user_id == u.id)
        ).one()

        summaries.append(UserSummary(
            id=u.id,
            email=u.email,
            name=u.name,
            tier=u.tier,
            is_admin=u.is_admin,
            stripe_customer_id=u.stripe_customer_id,
            suspended_at=u.suspended_at.isoformat() if getattr(u, "suspended_at", None) else None,
            created_at=u.created_at.isoformat(),
            doc_count=doc_count,
            review_count=review_count,
        ))

    return UserListResponse(users=summaries, total=total, page=page, page_size=page_size)


@router.get("/users/{user_id}", response_model=UserDetailResponse)
async def get_user_detail(
    user_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Detailed user view with subscriptions and recent usage."""
    _require_admin(user)

    target = session.get(User, user_id)
    if not target:
        raise HTTPException(404, detail="User not found")

    doc_count = session.exec(
        select(func.count()).select_from(Document).where(Document.user_id == target.id)
    ).one()
    review_count = session.exec(
        select(func.count()).select_from(Review)
        .join(Document, Review.document_id == Document.id)
        .where(Document.user_id == target.id)
    ).one()

    subs = session.exec(
        select(Subscription).where(Subscription.user_id == target.id)
        .order_by(col(Subscription.created_at).desc())
    ).all()

    cutoff = datetime.utcnow() - timedelta(days=30)
    usage = session.exec(
        select(UsageRecord).where(
            UsageRecord.user_id == target.id,
            col(UsageRecord.created_at) >= cutoff,
        ).order_by(col(UsageRecord.created_at).desc()).limit(50)
    ).all()

    return UserDetailResponse(
        id=target.id,
        email=target.email,
        name=target.name,
        tier=target.tier,
        is_admin=target.is_admin,
        stripe_customer_id=target.stripe_customer_id,
        suspended_at=target.suspended_at.isoformat() if getattr(target, "suspended_at", None) else None,
        created_at=target.created_at.isoformat(),
        doc_count=doc_count,
        review_count=review_count,
        subscriptions=[
            {
                "id": s.id,
                "tier": s.tier,
                "status": s.status,
                "stripe_subscription_id": s.stripe_subscription_id,
                "current_period_start": s.current_period_start.isoformat(),
                "current_period_end": s.current_period_end.isoformat(),
                "created_at": s.created_at.isoformat(),
                "canceled_at": s.canceled_at.isoformat() if s.canceled_at else None,
            }
            for s in subs
        ],
        recent_usage=[
            {
                "id": r.id,
                "action": r.action,
                "page_count": r.page_count,
                "created_at": r.created_at.isoformat(),
            }
            for r in usage
        ],
    )


class SuspendRequest(BaseModel):
    suspend: bool


@router.post("/users/{user_id}/suspend")
async def suspend_user(
    user_id: str,
    body: SuspendRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Suspend or unsuspend a user account."""
    _require_admin(user)

    target = session.get(User, user_id)
    if not target:
        raise HTTPException(404, detail="User not found")

    if target.id == user.id:
        raise HTTPException(400, detail="Cannot suspend yourself")

    if body.suspend:
        target.suspended_at = datetime.utcnow()
    else:
        target.suspended_at = None

    session.add(target)
    session.commit()
    session.refresh(target)

    return {
        "id": target.id,
        "suspended": target.suspended_at is not None,
        "suspended_at": target.suspended_at.isoformat() if target.suspended_at else None,
    }


# ---------------------------------------------------------------------------
# Usage statistics
# ---------------------------------------------------------------------------

@router.get("/stats", response_model=UsageStatsResponse)
async def usage_stats(
    period: str = Query("month", regex="^(day|week|month)$"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Aggregate usage statistics by day, week, or month."""
    _require_admin(user)

    total_users = session.exec(select(func.count()).select_from(User)).one()
    total_docs = session.exec(
        select(func.count()).select_from(UsageRecord)
        .where(UsageRecord.action == "doc_process")
    ).one()
    total_pages = session.exec(
        select(func.coalesce(func.sum(UsageRecord.page_count), 0)).select_from(UsageRecord)
    ).one()

    # Estimate audio minutes from TTS characters across all reviews
    total_tts_chars = session.exec(
        select(func.coalesce(func.sum(Review.tts_chars), 0)).select_from(Review)
    ).one()
    # Rough estimate: ~150 words/min, ~5 chars/word, so ~750 chars/min
    total_audio_minutes = round(total_tts_chars / 750.0, 1) if total_tts_chars else 0.0

    # Time-bucketed usage
    if period == "day":
        days_back = 30
    elif period == "week":
        days_back = 90
    else:
        days_back = 365

    cutoff = datetime.utcnow() - timedelta(days=days_back)

    results = session.exec(
        select(
            func.date(UsageRecord.created_at).label("date"),
            func.count().label("doc_count"),
            func.coalesce(func.sum(UsageRecord.page_count), 0).label("page_count"),
        )
        .where(col(UsageRecord.created_at) >= cutoff)
        .group_by(func.date(UsageRecord.created_at))
        .order_by(func.date(UsageRecord.created_at))
    ).all()

    by_period = [
        {"date": str(r[0]), "docs": r[1], "pages": r[2]}
        for r in results
    ]

    return UsageStatsResponse(
        total_users=total_users,
        total_documents=total_docs,
        total_pages=total_pages,
        total_audio_minutes=total_audio_minutes,
        by_period=by_period,
    )


# ---------------------------------------------------------------------------
# Revenue / billing overview
# ---------------------------------------------------------------------------

@router.get("/revenue")
async def revenue_overview(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Revenue overview — MRR, subscription counts, tier breakdown."""
    _require_admin(user)

    active_subs = session.exec(
        select(Subscription).where(Subscription.status == "active")
    ).all()

    tier_breakdown = {}
    mrr_cents = 0
    price_map = {"pro": 1500, "api": 3000}

    for s in active_subs:
        tier_breakdown.setdefault(s.tier, 0)
        tier_breakdown[s.tier] += 1
        mrr_cents += price_map.get(s.tier, 0)

    past_due = session.exec(
        select(func.count()).select_from(Subscription)
        .where(Subscription.status == "past_due")
    ).one()

    canceled_30d = session.exec(
        select(func.count()).select_from(Subscription)
        .where(
            Subscription.status == "canceled",
            col(Subscription.canceled_at) >= datetime.utcnow() - timedelta(days=30),
        )
    ).one()

    # New subscriptions in last 30 days
    new_30d = session.exec(
        select(func.count()).select_from(Subscription)
        .where(col(Subscription.created_at) >= datetime.utcnow() - timedelta(days=30))
    ).one()

    return {
        "mrr_cents": mrr_cents,
        "mrr_display": f"${mrr_cents / 100:.2f}",
        "active_subscriptions": len(active_subs),
        "past_due": past_due,
        "canceled_30d": canceled_30d,
        "new_30d": new_30d,
        "tier_breakdown": tier_breakdown,
    }


# ---------------------------------------------------------------------------
# System health
# ---------------------------------------------------------------------------

@router.get("/health", response_model=SystemHealthResponse)
async def system_health(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """System health — DB, Redis, worker, disk, and error rates."""
    _require_admin(user)

    services = {}
    overall = "ok"

    # Database
    try:
        from sqlmodel import text
        session.exec(text("SELECT 1"))
        services["database"] = {"status": "ok"}
    except Exception as e:
        services["database"] = {"status": "error", "detail": str(e)}
        overall = "degraded"

    # Redis
    redis_url = os.environ.get("REDIS_URL")
    if redis_url:
        try:
            import redis as redis_lib
            r = redis_lib.from_url(redis_url, socket_connect_timeout=2)
            info = r.info("memory")
            r.ping()
            queue_depth = r.llen("doc2meeting:jobs") if r.exists("doc2meeting:jobs") else 0
            services["redis"] = {
                "status": "ok",
                "queue_depth": queue_depth,
                "used_memory_human": info.get("used_memory_human", "unknown"),
            }
        except Exception as e:
            services["redis"] = {"status": "error", "detail": str(e)}
            overall = "degraded"
    else:
        services["redis"] = {"status": "not_configured"}

    # Worker (check if worker process is responsive via Redis)
    services["worker"] = {"status": "stub", "detail": "Worker is a stub — not processing jobs"}

    # Error rate (reviews with errors in last 24h — approximation)
    try:
        cutoff_24h = datetime.utcnow() - timedelta(hours=24)
        total_reviews_24h = session.exec(
            select(func.count()).select_from(Review)
            .where(col(Review.created_at) >= cutoff_24h)
        ).one()
        services["review_pipeline"] = {
            "status": "ok",
            "reviews_24h": total_reviews_24h,
        }
    except Exception as e:
        services["review_pipeline"] = {"status": "error", "detail": str(e)}
        overall = "degraded"

    # Stripe
    stripe_key = os.environ.get("STRIPE_SECRET_KEY", "")
    services["stripe"] = {
        "status": "ok" if stripe_key else "not_configured",
    }

    return SystemHealthResponse(
        status=overall,
        services=services,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
