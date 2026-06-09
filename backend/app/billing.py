"""Stripe billing integration — checkout, webhooks, usage, and admin endpoints.

All tier enforcement and usage tracking is server-side.
Stripe Checkout Sessions for subscriptions (no custom payment forms).
Stripe Customer Portal for self-service management.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, col, func, select

from .db import get_session
from .middleware import get_current_user
from .models import Subscription, UsageRecord, User
from .users import update_tier

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# ---------------------------------------------------------------------------
# Stripe configuration
# ---------------------------------------------------------------------------

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PUBLISHABLE_KEY = os.environ.get("STRIPE_PUBLISHABLE_KEY", "")

stripe.api_key = STRIPE_SECRET_KEY

# Map Stripe price IDs to tiers (set via env or defaults for test mode)
PRICE_TO_TIER = {
    os.environ.get("STRIPE_PRO_PRICE_ID", "price_pro_monthly"): "pro",
    os.environ.get("STRIPE_API_PRICE_ID", "price_api_monthly"): "api",
}
TIER_TO_PRICE = {v: k for k, v in PRICE_TO_TIER.items()}

# Metered price for API tier overage ($0.02/page)
STRIPE_API_METERED_PRICE_ID = os.environ.get(
    "STRIPE_API_METERED_PRICE_ID", "price_api_metered"
)

# ---------------------------------------------------------------------------
# Tier limits — enforced server-side
# ---------------------------------------------------------------------------

TIER_LIMITS = {
    "free": {"max_docs_per_period": 3, "max_pages_per_doc": 10},
    "pro": {"max_docs_per_period": 50, "max_pages_per_doc": None},
    "api": {"max_docs_per_period": None, "max_pages_per_doc": None},  # metered
    "team": {"max_docs_per_period": None, "max_pages_per_doc": None},
}

# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class CheckoutRequest(BaseModel):
    tier: str  # "pro" or "api"
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class CheckoutResponse(BaseModel):
    checkout_url: str


class BillingResponse(BaseModel):
    tier: str
    stripe_customer_id: Optional[str]
    subscription_status: Optional[str]
    current_period_start: Optional[str]
    current_period_end: Optional[str]
    docs_used: int
    docs_limit: Optional[int]
    pages_used: int
    pages_limit_per_doc: Optional[int]


class PortalResponse(BaseModel):
    portal_url: str


class UsageResponse(BaseModel):
    docs_used: int
    docs_limit: Optional[int]
    pages_used: int
    pages_limit_per_doc: Optional[int]
    period_start: Optional[str]
    period_end: Optional[str]


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


def _get_or_create_stripe_customer(user: User, session: Session) -> str:
    """Get existing or create new Stripe customer for this user."""
    if user.stripe_customer_id:
        return user.stripe_customer_id

    customer = stripe.Customer.create(
        email=user.email,
        name=user.name,
        metadata={"user_id": user.id},
    )
    user.stripe_customer_id = customer.id
    session.add(user)
    session.commit()
    session.refresh(user)
    return customer.id


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
    For free users, uses a rolling 30-day window from account creation.
    """
    sub = _get_active_subscription(session, user_id)
    if sub:
        return sub.current_period_start, sub.current_period_end

    user = session.get(User, user_id)
    if not user:
        now = datetime.utcnow()
        from datetime import timedelta
        return now - timedelta(days=30), now

    # Free users: rolling 30-day window
    from datetime import timedelta
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


def require_admin(user: User) -> None:
    """Raise 403 if user is not an admin."""
    if not user.is_admin:
        raise HTTPException(403, detail="admin access required")


# ---------------------------------------------------------------------------
# Checkout endpoint
# ---------------------------------------------------------------------------


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout_session(
    body: CheckoutRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Create a Stripe Checkout Session for subscription sign-up."""
    if body.tier not in ("pro", "api"):
        raise HTTPException(400, detail="tier must be 'pro' or 'api'")

    if not STRIPE_SECRET_KEY:
        raise HTTPException(503, detail="Stripe not configured")

    customer_id = _get_or_create_stripe_customer(user, session)

    frontend_base = os.environ.get("FRONTEND_BASE_URL", "http://localhost")
    success_url = body.success_url or f"{frontend_base}/billing?success=1"
    cancel_url = body.cancel_url or f"{frontend_base}/billing?canceled=1"

    line_items = [{"price": TIER_TO_PRICE[body.tier], "quantity": 1}]

    # For API tier, add metered component
    if body.tier == "api":
        line_items.append({"price": STRIPE_API_METERED_PRICE_ID})

    checkout_session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        line_items=line_items,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"user_id": user.id, "tier": body.tier},
    )

    return CheckoutResponse(checkout_url=checkout_session.url)


# ---------------------------------------------------------------------------
# Webhook handler
# ---------------------------------------------------------------------------


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request, session: Session = Depends(get_session)):
    """Handle Stripe webhook events. No auth — verified by webhook signature."""
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, detail="Webhook secret not configured")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except stripe.SignatureVerificationError:
        logger.warning("Stripe webhook signature verification failed")
        raise HTTPException(400, detail="Invalid signature")
    except ValueError:
        raise HTTPException(400, detail="Invalid payload")

    event_type = event["type"]
    data = event["data"]["object"]

    logger.info("Stripe webhook: %s", event_type)

    if event_type == "checkout.session.completed":
        _handle_checkout_completed(data, session)
    elif event_type == "customer.subscription.updated":
        _handle_subscription_updated(data, session)
    elif event_type == "customer.subscription.deleted":
        _handle_subscription_deleted(data, session)
    elif event_type == "invoice.payment_failed":
        _handle_payment_failed(data, session)
    else:
        logger.debug("Unhandled Stripe event: %s", event_type)

    return {"status": "ok"}


def _handle_checkout_completed(data: dict, session: Session) -> None:
    """Activate subscription after successful checkout."""
    user_id = data.get("metadata", {}).get("user_id")
    tier = data.get("metadata", {}).get("tier")
    subscription_id = data.get("subscription")
    customer_id = data.get("customer")

    if not all([user_id, tier, subscription_id, customer_id]):
        logger.error("checkout.session.completed missing required metadata")
        return

    # Fetch subscription details from Stripe
    stripe_sub = stripe.Subscription.retrieve(subscription_id)

    sub = Subscription(
        user_id=user_id,
        stripe_customer_id=customer_id,
        stripe_subscription_id=subscription_id,
        stripe_price_id=stripe_sub["items"]["data"][0]["price"]["id"],
        tier=tier,
        status="active",
        current_period_start=datetime.utcfromtimestamp(stripe_sub["current_period_start"]),
        current_period_end=datetime.utcfromtimestamp(stripe_sub["current_period_end"]),
    )
    session.add(sub)

    # Update user tier and stripe customer ID
    user = session.get(User, user_id)
    if user:
        user.tier = tier
        user.stripe_customer_id = customer_id
        session.add(user)

    session.commit()
    logger.info("Subscription activated: user=%s tier=%s", user_id, tier)


def _handle_subscription_updated(data: dict, session: Session) -> None:
    """Handle plan changes and period updates."""
    stripe_sub_id = data["id"]
    sub = session.exec(
        select(Subscription).where(
            Subscription.stripe_subscription_id == stripe_sub_id
        )
    ).first()

    if not sub:
        logger.warning("subscription.updated for unknown sub: %s", stripe_sub_id)
        return

    sub.status = data["status"]
    sub.current_period_start = datetime.utcfromtimestamp(data["current_period_start"])
    sub.current_period_end = datetime.utcfromtimestamp(data["current_period_end"])

    # Detect tier change via price
    new_price_id = data["items"]["data"][0]["price"]["id"]
    new_tier = PRICE_TO_TIER.get(new_price_id, sub.tier)
    if new_tier != sub.tier:
        sub.tier = new_tier
        sub.stripe_price_id = new_price_id
        update_tier(session, sub.user_id, new_tier)
        logger.info("Tier changed: user=%s to=%s", sub.user_id, new_tier)

    if data.get("canceled_at"):
        sub.canceled_at = datetime.utcfromtimestamp(data["canceled_at"])

    session.add(sub)
    session.commit()


def _handle_subscription_deleted(data: dict, session: Session) -> None:
    """Downgrade to free when subscription is cancelled."""
    stripe_sub_id = data["id"]
    sub = session.exec(
        select(Subscription).where(
            Subscription.stripe_subscription_id == stripe_sub_id
        )
    ).first()

    if not sub:
        logger.warning("subscription.deleted for unknown sub: %s", stripe_sub_id)
        return

    sub.status = "canceled"
    sub.canceled_at = datetime.utcnow()
    session.add(sub)

    # Downgrade user to free
    update_tier(session, sub.user_id, "free")
    session.commit()
    logger.info("Subscription canceled, downgraded to free: user=%s", sub.user_id)


def _handle_payment_failed(data: dict, session: Session) -> None:
    """Flag account when payment fails."""
    customer_id = data.get("customer")
    if not customer_id:
        return

    sub = session.exec(
        select(Subscription).where(
            Subscription.stripe_customer_id == customer_id,
            Subscription.status == "active",
        )
    ).first()

    if sub:
        sub.status = "past_due"
        session.add(sub)
        session.commit()
        logger.warning("Payment failed for customer=%s, marked past_due", customer_id)


# ---------------------------------------------------------------------------
# Billing info endpoints
# ---------------------------------------------------------------------------


@router.get("/billing", response_model=BillingResponse)
async def get_billing_info(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Current plan, usage stats, billing period, next invoice date."""
    period_start, period_end = _get_billing_period(session, user.id)
    docs_used, pages_used = _count_period_usage(session, user.id, period_start, period_end)
    sub = _get_active_subscription(session, user.id)
    limits = TIER_LIMITS.get(user.tier, TIER_LIMITS["free"])

    return BillingResponse(
        tier=user.tier,
        stripe_customer_id=user.stripe_customer_id,
        subscription_status=sub.status if sub else None,
        current_period_start=period_start.isoformat() if sub else None,
        current_period_end=period_end.isoformat() if sub else None,
        docs_used=docs_used,
        docs_limit=limits["max_docs_per_period"],
        pages_used=pages_used,
        pages_limit_per_doc=limits["max_pages_per_doc"],
    )


@router.get("/billing/portal", response_model=PortalResponse)
async def get_billing_portal(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Generate a Stripe Customer Portal session URL for self-service."""
    if not user.stripe_customer_id:
        raise HTTPException(400, detail="No billing account found. Subscribe to a plan first.")

    if not STRIPE_SECRET_KEY:
        raise HTTPException(503, detail="Stripe not configured")

    frontend_base = os.environ.get("FRONTEND_BASE_URL", "http://localhost")
    portal_session = stripe.billing_portal.Session.create(
        customer=user.stripe_customer_id,
        return_url=f"{frontend_base}/billing",
    )

    return PortalResponse(portal_url=portal_session.url)


# ---------------------------------------------------------------------------
# Usage endpoints
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


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------


@router.get("/admin/billing", response_model=AdminBillingResponse)
async def admin_billing(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Revenue overview, active subscriptions by tier, MRR. Admin only."""
    require_admin(user)

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
    require_admin(user)

    # Last 30 days usage by user
    from datetime import timedelta
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


# ---------------------------------------------------------------------------
# Tier enforcement — check_usage_limits
# ---------------------------------------------------------------------------


def check_usage_limits(
    user: User,
    session: Session,
    page_count: int = 0,
) -> None:
    """Check tier limits before processing a document. Raises HTTPException(429)."""
    limits = TIER_LIMITS.get(user.tier, TIER_LIMITS["free"])

    period_start, period_end = _get_billing_period(session, user.id)
    docs_used, _ = _count_period_usage(session, user.id, period_start, period_end)

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
            try:
                # Find the metered subscription item
                stripe_sub = stripe.Subscription.retrieve(sub.stripe_subscription_id)
                for item in stripe_sub["items"]["data"]:
                    if item["price"]["id"] == STRIPE_API_METERED_PRICE_ID:
                        stripe.SubscriptionItem.create_usage_record(
                            item["id"],
                            quantity=page_count,
                            timestamp=int(record.created_at.timestamp()),
                        )
                        break
            except Exception:
                logger.exception("Failed to report metered usage to Stripe")

    return record
