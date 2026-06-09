"""Stripe webhook handler — idempotent and atomic.

Each sub-handler runs in a single transaction. Duplicate checkout.session.completed
events are handled gracefully via upsert logic (no IntegrityError on replay).
"""

from __future__ import annotations

import logging
from datetime import datetime

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from ..db import get_session
from ..models import Subscription, User
from ..users import update_tier
from .constants import PRICE_TO_TIER, STRIPE_WEBHOOK_SECRET

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


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
    """Activate subscription after successful checkout.

    Idempotent: if a subscription with the same stripe_subscription_id already exists,
    we update it instead of inserting a duplicate (prevents IntegrityError on Stripe retries).
    All changes are committed in a single transaction.
    """
    user_id = data.get("metadata", {}).get("user_id")
    tier = data.get("metadata", {}).get("tier")
    subscription_id = data.get("subscription")
    customer_id = data.get("customer")

    if not all([user_id, tier, subscription_id, customer_id]):
        logger.error("checkout.session.completed missing required metadata")
        return

    # Fetch subscription details from Stripe
    stripe_sub = stripe.Subscription.retrieve(subscription_id)

    # Idempotency: check if subscription already exists
    existing = session.exec(
        select(Subscription).where(
            Subscription.stripe_subscription_id == subscription_id
        )
    ).first()

    if existing:
        # Update existing subscription (duplicate webhook delivery)
        existing.status = "active"
        existing.tier = tier
        existing.stripe_price_id = stripe_sub["items"]["data"][0]["price"]["id"]
        existing.current_period_start = datetime.utcfromtimestamp(
            stripe_sub["current_period_start"]
        )
        existing.current_period_end = datetime.utcfromtimestamp(
            stripe_sub["current_period_end"]
        )
        session.add(existing)
        logger.info("Duplicate checkout webhook — updated existing sub: %s", subscription_id)
    else:
        sub = Subscription(
            user_id=user_id,
            stripe_customer_id=customer_id,
            stripe_subscription_id=subscription_id,
            stripe_price_id=stripe_sub["items"]["data"][0]["price"]["id"],
            tier=tier,
            status="active",
            current_period_start=datetime.utcfromtimestamp(
                stripe_sub["current_period_start"]
            ),
            current_period_end=datetime.utcfromtimestamp(
                stripe_sub["current_period_end"]
            ),
        )
        session.add(sub)

    # Update user tier and stripe customer ID
    user = session.get(User, user_id)
    if user:
        user.tier = tier
        user.stripe_customer_id = customer_id
        session.add(user)

    # Single commit for entire handler
    session.commit()
    logger.info("Subscription activated: user=%s tier=%s", user_id, tier)


def _handle_subscription_updated(data: dict, session: Session) -> None:
    """Handle plan changes and period updates. Single transaction."""
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
        # Inline user tier update to avoid double-commit from update_tier
        user = session.get(User, sub.user_id)
        if user:
            user.tier = new_tier
            session.add(user)
        logger.info("Tier changed: user=%s to=%s", sub.user_id, new_tier)

    if data.get("canceled_at"):
        sub.canceled_at = datetime.utcfromtimestamp(data["canceled_at"])

    session.add(sub)
    # Single commit for entire handler
    session.commit()


def _handle_subscription_deleted(data: dict, session: Session) -> None:
    """Downgrade to free when subscription is cancelled. Single transaction."""
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

    # Inline user tier update to avoid double-commit
    user = session.get(User, sub.user_id)
    if user:
        user.tier = "free"
        session.add(user)

    # Single commit for entire handler
    session.commit()
    logger.info("Subscription canceled, downgraded to free: user=%s", sub.user_id)


def _handle_payment_failed(data: dict, session: Session) -> None:
    """Flag account when payment fails. Single transaction."""
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
