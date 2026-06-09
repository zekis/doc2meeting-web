"""Stripe Checkout Session creation and billing info endpoints.

Security: redirect URLs are server-side only (no client-supplied URLs).
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ..db import get_session
from ..middleware import get_current_user
from ..models import User
from .constants import (
    STRIPE_API_METERED_PRICE_ID,
    STRIPE_SECRET_KEY,
    TIER_LIMITS,
    TIER_TO_PRICE,
)
from .usage import _count_period_usage, _get_active_subscription, _get_billing_period

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class CheckoutRequest(BaseModel):
    tier: str  # "pro" or "api"
    # NOTE: success_url / cancel_url intentionally omitted.
    # Redirect URLs are server-side only to prevent open-redirect attacks.


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


# ---------------------------------------------------------------------------
# Checkout endpoint — server-side redirect URLs only
# ---------------------------------------------------------------------------


@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout_session(
    body: CheckoutRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Create a Stripe Checkout Session for subscription sign-up.

    Redirect URLs are determined server-side from FRONTEND_BASE_URL
    to prevent open-redirect vulnerabilities.
    """
    if body.tier not in ("pro", "api"):
        raise HTTPException(400, detail="tier must be 'pro' or 'api'")

    if not STRIPE_SECRET_KEY:
        raise HTTPException(503, detail="Stripe not configured")

    customer_id = _get_or_create_stripe_customer(user, session)

    frontend_base = os.environ.get("FRONTEND_BASE_URL", "http://localhost")
    success_url = f"{frontend_base}/billing?success=1"
    cancel_url = f"{frontend_base}/billing?canceled=1"

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
