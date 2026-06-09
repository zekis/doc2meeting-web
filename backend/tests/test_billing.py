"""Tests for billing, tier enforcement, and usage tracking.

Stripe API calls are mocked — tests validate server-side logic only.
"""

import json
import os
import uuid
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

# Test env must be set before app import
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-at-least-32-characters-long!!")
os.environ.setdefault("DATABASE_URL", "sqlite:///")
os.environ.setdefault("ROOT_DIR", "/tmp/doc2meeting-test-root")
os.environ.setdefault("AUDIO_DIR", "/tmp/doc2meeting-test-audio")

from app.auth import create_access_token
from app.billing import (
    TIER_LIMITS,
    check_usage_limits,
    record_usage,
)
from app.db import engine
from app.models import Subscription, UsageRecord, User


@pytest.fixture
def pro_user(session):
    """Create a pro-tier user."""
    user = User(
        id=str(uuid.uuid4()),
        email="pro@example.com",
        name="Pro User",
        tier="pro",
        google_sub=f"google-pro-{uuid.uuid4()}",
        stripe_customer_id="cus_test_pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@pytest.fixture
def api_user(session):
    """Create an api-tier user."""
    user = User(
        id=str(uuid.uuid4()),
        email="api@example.com",
        name="API User",
        tier="api",
        google_sub=f"google-api-{uuid.uuid4()}",
        stripe_customer_id="cus_test_api",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@pytest.fixture
def admin_user(session):
    """Create an admin user."""
    user = User(
        id=str(uuid.uuid4()),
        email="admin@example.com",
        name="Admin User",
        tier="pro",
        google_sub=f"google-admin-{uuid.uuid4()}",
        is_admin=True,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _auth(user):
    token = create_access_token(user.id)
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Tier limits unit tests
# ---------------------------------------------------------------------------


class TestTierLimits:
    def test_free_tier_limits(self):
        limits = TIER_LIMITS["free"]
        assert limits["max_docs_per_period"] == 3
        assert limits["max_pages_per_doc"] == 10

    def test_pro_tier_limits(self):
        limits = TIER_LIMITS["pro"]
        assert limits["max_docs_per_period"] == 50
        assert limits["max_pages_per_doc"] is None

    def test_api_tier_no_hard_limits(self):
        limits = TIER_LIMITS["api"]
        assert limits["max_docs_per_period"] is None
        assert limits["max_pages_per_doc"] is None


# ---------------------------------------------------------------------------
# check_usage_limits unit tests
# ---------------------------------------------------------------------------


class TestCheckUsageLimits:
    def test_free_user_under_limit(self, session, test_user):
        """Free user with no usage should pass."""
        check_usage_limits(test_user, session, page_count=5)

    def test_free_user_at_doc_limit(self, session, test_user):
        """Free user at 3 docs should be blocked."""
        now = datetime.utcnow()
        for i in range(3):
            session.add(UsageRecord(
                user_id=test_user.id,
                page_count=1,
                action="doc_process",
                created_at=now - timedelta(days=1),
            ))
        session.commit()

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            check_usage_limits(test_user, session, page_count=1)
        assert exc_info.value.status_code == 429
        assert "doc_limit_exceeded" in str(exc_info.value.detail)

    def test_free_user_page_limit(self, session, test_user):
        """Free user with doc > 10 pages should be blocked."""
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            check_usage_limits(test_user, session, page_count=15)
        assert exc_info.value.status_code == 429
        assert "page_limit_exceeded" in str(exc_info.value.detail)

    def test_pro_user_high_page_count_ok(self, session, pro_user):
        """Pro user should not be blocked by page count."""
        check_usage_limits(pro_user, session, page_count=100)

    def test_pro_user_at_50_docs(self, session, pro_user):
        """Pro user at 50 docs should be blocked."""
        # Create a subscription so the billing period works
        sub = Subscription(
            user_id=pro_user.id,
            stripe_customer_id="cus_test_pro",
            stripe_subscription_id=f"sub_{uuid.uuid4()}",
            stripe_price_id="price_pro_monthly",
            tier="pro",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        now = datetime.utcnow()
        for i in range(50):
            session.add(UsageRecord(
                user_id=pro_user.id,
                page_count=5,
                action="doc_process",
                created_at=now - timedelta(days=1),
            ))
        session.commit()

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            check_usage_limits(pro_user, session, page_count=1)
        assert exc_info.value.status_code == 429

    def test_api_user_unlimited(self, session, api_user):
        """API tier user should never hit doc or page limits."""
        sub = Subscription(
            user_id=api_user.id,
            stripe_customer_id="cus_test_api",
            stripe_subscription_id=f"sub_{uuid.uuid4()}",
            stripe_price_id="price_api_monthly",
            tier="api",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        # Even with many docs, API tier should pass
        for i in range(100):
            session.add(UsageRecord(
                user_id=api_user.id,
                page_count=50,
                action="doc_process",
                created_at=datetime.utcnow() - timedelta(hours=1),
            ))
        session.commit()

        check_usage_limits(api_user, session, page_count=500)


# ---------------------------------------------------------------------------
# record_usage tests
# ---------------------------------------------------------------------------


class TestRecordUsage:
    def test_records_usage(self, session, test_user):
        record = record_usage(session, test_user, page_count=5, action="doc_process")
        assert record.id is not None
        assert record.user_id == test_user.id
        assert record.page_count == 5

    def test_records_with_document_id(self, session, test_user):
        record = record_usage(session, test_user, document_id=42, page_count=3)
        assert record.document_id == 42

    @patch("app.billing.usage.STRIPE_SECRET_KEY", "sk_test_xxx")
    @patch("app.billing.usage.stripe.Subscription.retrieve")
    def test_metered_usage_reports_to_stripe(self, mock_retrieve, session, api_user):
        """API tier usage should report to Stripe metered billing."""
        sub = Subscription(
            user_id=api_user.id,
            stripe_customer_id="cus_test_api",
            stripe_subscription_id="sub_test_123",
            stripe_price_id="price_api_monthly",
            tier="api",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        mock_create_usage = MagicMock()
        mock_retrieve.return_value = {
            "items": {
                "data": [
                    {"id": "si_metered_123", "price": {"id": "price_api_metered"}},
                ]
            }
        }

        with patch("app.billing.usage.stripe.SubscriptionItem") as mock_si_class:
            mock_si_class.create_usage_record = mock_create_usage
            record = record_usage(session, api_user, page_count=10, action="doc_process")

        mock_retrieve.assert_called_once_with("sub_test_123")
        mock_create_usage.assert_called_once_with(
            "si_metered_123",
            quantity=10,
            timestamp=int(record.created_at.timestamp()),
        )

    @patch("app.billing.usage.STRIPE_SECRET_KEY", "sk_test_xxx")
    @patch("app.billing.usage.stripe.Subscription.retrieve")
    def test_metered_usage_failure_logged_not_swallowed(
        self, mock_retrieve, session, api_user, caplog
    ):
        """Failed metered billing should log an ALERT, not silently swallow."""
        sub = Subscription(
            user_id=api_user.id,
            stripe_customer_id="cus_test_api",
            stripe_subscription_id="sub_test_fail",
            stripe_price_id="price_api_monthly",
            tier="api",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        mock_retrieve.side_effect = Exception("Stripe API error")

        import logging
        with caplog.at_level(logging.ERROR):
            record = record_usage(session, api_user, page_count=5, action="doc_process")

        # Record should still be created
        assert record.id is not None
        # But the error should be logged with ALERT
        assert "ALERT" in caplog.text
        assert "Failed to report metered usage" in caplog.text


# ---------------------------------------------------------------------------
# Billing API endpoint tests
# ---------------------------------------------------------------------------


class TestBillingEndpoints:
    def test_get_billing_free_user(self, client, test_user):
        resp = client.get("/api/billing", headers=_auth(test_user))
        assert resp.status_code == 200
        data = resp.json()
        assert data["tier"] == "free"
        assert data["docs_used"] == 0
        assert data["docs_limit"] == 3
        assert data["pages_limit_per_doc"] == 10

    def test_get_billing_unauthenticated(self, client):
        resp = client.get("/api/billing")
        assert resp.status_code == 401

    def test_get_usage_free_user(self, client, test_user):
        resp = client.get("/api/usage", headers=_auth(test_user))
        assert resp.status_code == 200
        data = resp.json()
        assert data["docs_used"] == 0
        assert data["docs_limit"] == 3

    def test_get_billing_portal_no_customer(self, client, test_user):
        """Free user without stripe customer should get 400."""
        resp = client.get("/api/billing/portal", headers=_auth(test_user))
        assert resp.status_code == 400

    @patch("app.billing.checkout.STRIPE_SECRET_KEY", "sk_test_xxx")
    @patch("app.billing.checkout.stripe.billing_portal.Session.create")
    def test_get_billing_portal_with_customer(self, mock_portal, client, pro_user):
        mock_portal.return_value = MagicMock(url="https://billing.stripe.com/session/test")
        resp = client.get("/api/billing/portal", headers=_auth(pro_user))
        assert resp.status_code == 200
        assert "stripe.com" in resp.json()["portal_url"]

    @patch("app.billing.checkout.STRIPE_SECRET_KEY", "sk_test_xxx")
    @patch("app.billing.checkout.stripe.checkout.Session.create")
    @patch("app.billing.checkout.stripe.Customer.create")
    def test_checkout_pro(self, mock_customer, mock_checkout, client, test_user):
        mock_customer.return_value = MagicMock(id="cus_new_123")
        mock_checkout.return_value = MagicMock(url="https://checkout.stripe.com/test")
        resp = client.post(
            "/api/checkout",
            json={"tier": "pro"},
            headers=_auth(test_user),
        )
        assert resp.status_code == 200
        assert "stripe.com" in resp.json()["checkout_url"]

    @patch("app.billing.checkout.STRIPE_SECRET_KEY", "sk_test_xxx")
    @patch("app.billing.checkout.stripe.checkout.Session.create")
    @patch("app.billing.checkout.stripe.Customer.create")
    def test_checkout_api_tier(self, mock_customer, mock_checkout, client, test_user):
        """API tier checkout should include metered price component."""
        mock_customer.return_value = MagicMock(id="cus_new_456")
        mock_checkout.return_value = MagicMock(url="https://checkout.stripe.com/api-test")

        resp = client.post(
            "/api/checkout",
            json={"tier": "api"},
            headers=_auth(test_user),
        )
        assert resp.status_code == 200

        # Verify the checkout was called with 2 line items (base + metered)
        call_kwargs = mock_checkout.call_args[1]
        assert len(call_kwargs["line_items"]) == 2
        assert call_kwargs["metadata"]["tier"] == "api"

    @patch("app.billing.checkout.STRIPE_SECRET_KEY", "sk_test_xxx")
    @patch("app.billing.checkout.stripe.checkout.Session.create")
    @patch("app.billing.checkout.stripe.Customer.create")
    def test_checkout_no_client_redirect_urls(self, mock_customer, mock_checkout, client, test_user):
        """Checkout should use server-side redirect URLs only (open redirect fix)."""
        mock_customer.return_value = MagicMock(id="cus_new_789")
        mock_checkout.return_value = MagicMock(url="https://checkout.stripe.com/test")

        resp = client.post(
            "/api/checkout",
            json={"tier": "pro"},
            headers=_auth(test_user),
        )
        assert resp.status_code == 200

        # Verify the Stripe call used server-side URLs, not client-supplied ones
        call_kwargs = mock_checkout.call_args[1]
        assert "localhost" in call_kwargs["success_url"] or "billing" in call_kwargs["success_url"]
        assert "localhost" in call_kwargs["cancel_url"] or "billing" in call_kwargs["cancel_url"]

    def test_checkout_invalid_tier(self, client, test_user):
        resp = client.post(
            "/api/checkout",
            json={"tier": "enterprise"},
            headers=_auth(test_user),
        )
        assert resp.status_code == 400

    def test_checkout_unauthenticated(self, client):
        resp = client.post("/api/checkout", json={"tier": "pro"})
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Admin endpoint tests
# ---------------------------------------------------------------------------


class TestAdminEndpoints:
    def test_admin_billing_requires_admin(self, client, test_user):
        resp = client.get("/api/admin/billing", headers=_auth(test_user))
        assert resp.status_code == 403

    def test_admin_billing_success(self, client, admin_user):
        resp = client.get("/api/admin/billing", headers=_auth(admin_user))
        assert resp.status_code == 200
        data = resp.json()
        assert "total_subscriptions" in data
        assert "mrr_cents" in data
        assert "subscriptions_by_tier" in data

    def test_admin_usage_requires_admin(self, client, test_user):
        resp = client.get("/api/admin/usage", headers=_auth(test_user))
        assert resp.status_code == 403

    def test_admin_usage_success(self, client, admin_user):
        resp = client.get("/api/admin/usage", headers=_auth(admin_user))
        assert resp.status_code == 200
        data = resp.json()
        assert "users" in data


# ---------------------------------------------------------------------------
# Webhook tests
# ---------------------------------------------------------------------------


class TestStripeWebhook:
    def test_webhook_no_secret_configured(self, client):
        resp = client.post(
            "/api/webhooks/stripe",
            content=b"{}",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        # No webhook secret → 503
        assert resp.status_code == 503

    @patch("app.billing.webhooks.STRIPE_WEBHOOK_SECRET", "whsec_test")
    @patch("app.billing.webhooks.stripe.Webhook.construct_event")
    @patch("app.billing.webhooks.stripe.Subscription.retrieve")
    def test_webhook_checkout_completed(self, mock_retrieve, mock_construct, client, session, test_user):
        """checkout.session.completed should create subscription and upgrade tier."""
        sub_id = f"sub_{uuid.uuid4()}"
        mock_construct.return_value = {
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "metadata": {"user_id": test_user.id, "tier": "pro"},
                    "subscription": sub_id,
                    "customer": "cus_test_123",
                }
            },
        }
        now = datetime.utcnow()
        mock_retrieve.return_value = {
            "items": {"data": [{"price": {"id": "price_pro_monthly"}}]},
            "current_period_start": int(now.timestamp()),
            "current_period_end": int((now + timedelta(days=30)).timestamp()),
        }

        resp = client.post(
            "/api/webhooks/stripe",
            content=b"signed-payload",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        assert resp.status_code == 200

        # Verify subscription was created
        from sqlmodel import select
        sub = session.exec(
            select(Subscription).where(Subscription.stripe_subscription_id == sub_id)
        ).first()
        assert sub is not None
        assert sub.tier == "pro"
        assert sub.user_id == test_user.id

        # Verify user tier was upgraded
        session.refresh(test_user)
        assert test_user.tier == "pro"

    @patch("app.billing.webhooks.STRIPE_WEBHOOK_SECRET", "whsec_test")
    @patch("app.billing.webhooks.stripe.Webhook.construct_event")
    @patch("app.billing.webhooks.stripe.Subscription.retrieve")
    def test_webhook_checkout_idempotent(self, mock_retrieve, mock_construct, client, session, test_user):
        """Duplicate checkout.session.completed events should not cause errors."""
        sub_id = f"sub_{uuid.uuid4()}"
        now = datetime.utcnow()

        event = {
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "metadata": {"user_id": test_user.id, "tier": "pro"},
                    "subscription": sub_id,
                    "customer": "cus_test_idempotent",
                }
            },
        }
        mock_construct.return_value = event
        mock_retrieve.return_value = {
            "items": {"data": [{"price": {"id": "price_pro_monthly"}}]},
            "current_period_start": int(now.timestamp()),
            "current_period_end": int((now + timedelta(days=30)).timestamp()),
        }

        # First webhook call
        resp1 = client.post(
            "/api/webhooks/stripe",
            content=b"signed-payload",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        assert resp1.status_code == 200

        # Second (duplicate) webhook call — should NOT fail with IntegrityError
        mock_construct.return_value = event
        resp2 = client.post(
            "/api/webhooks/stripe",
            content=b"signed-payload",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        assert resp2.status_code == 200

        # Verify only one subscription exists
        from sqlmodel import select
        subs = session.exec(
            select(Subscription).where(Subscription.stripe_subscription_id == sub_id)
        ).all()
        assert len(subs) == 1

    @patch("app.billing.webhooks.STRIPE_WEBHOOK_SECRET", "whsec_test")
    @patch("app.billing.webhooks.stripe.Webhook.construct_event")
    def test_webhook_subscription_updated(self, mock_construct, client, session, pro_user):
        """subscription.updated should update period and detect tier changes."""
        sub_id = f"sub_{uuid.uuid4()}"
        sub = Subscription(
            user_id=pro_user.id,
            stripe_customer_id="cus_test_pro",
            stripe_subscription_id=sub_id,
            stripe_price_id="price_pro_monthly",
            tier="pro",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        # Simulate upgrade from pro to api
        now = datetime.utcnow()
        mock_construct.return_value = {
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": sub_id,
                    "status": "active",
                    "current_period_start": int(now.timestamp()),
                    "current_period_end": int((now + timedelta(days=30)).timestamp()),
                    "items": {"data": [{"price": {"id": "price_api_monthly"}}]},
                }
            },
        }

        resp = client.post(
            "/api/webhooks/stripe",
            content=b"signed-payload",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        assert resp.status_code == 200

        # Verify subscription was updated
        session.refresh(sub)
        assert sub.tier == "api"
        assert sub.stripe_price_id == "price_api_monthly"

        # Verify user tier was upgraded
        session.refresh(pro_user)
        assert pro_user.tier == "api"

    @patch("app.billing.webhooks.STRIPE_WEBHOOK_SECRET", "whsec_test")
    @patch("app.billing.webhooks.stripe.Webhook.construct_event")
    def test_webhook_subscription_updated_downgrade(self, mock_construct, client, session, api_user):
        """subscription.updated with pro price should downgrade from api to pro."""
        sub_id = f"sub_{uuid.uuid4()}"
        sub = Subscription(
            user_id=api_user.id,
            stripe_customer_id="cus_test_api",
            stripe_subscription_id=sub_id,
            stripe_price_id="price_api_monthly",
            tier="api",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        now = datetime.utcnow()
        mock_construct.return_value = {
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": sub_id,
                    "status": "active",
                    "current_period_start": int(now.timestamp()),
                    "current_period_end": int((now + timedelta(days=30)).timestamp()),
                    "items": {"data": [{"price": {"id": "price_pro_monthly"}}]},
                }
            },
        }

        resp = client.post(
            "/api/webhooks/stripe",
            content=b"signed-payload",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        assert resp.status_code == 200

        session.refresh(sub)
        assert sub.tier == "pro"

        session.refresh(api_user)
        assert api_user.tier == "pro"

    @patch("app.billing.webhooks.STRIPE_WEBHOOK_SECRET", "whsec_test")
    @patch("app.billing.webhooks.stripe.Webhook.construct_event")
    def test_webhook_subscription_deleted(self, mock_construct, client, session, pro_user):
        """subscription.deleted should downgrade to free."""
        sub_id = f"sub_{uuid.uuid4()}"
        sub = Subscription(
            user_id=pro_user.id,
            stripe_customer_id="cus_test_pro",
            stripe_subscription_id=sub_id,
            stripe_price_id="price_pro_monthly",
            tier="pro",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        mock_construct.return_value = {
            "type": "customer.subscription.deleted",
            "data": {"object": {"id": sub_id}},
        }

        resp = client.post(
            "/api/webhooks/stripe",
            content=b"signed-payload",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        assert resp.status_code == 200

        # User should be downgraded to free
        session.refresh(pro_user)
        assert pro_user.tier == "free"

    @patch("app.billing.webhooks.STRIPE_WEBHOOK_SECRET", "whsec_test")
    @patch("app.billing.webhooks.stripe.Webhook.construct_event")
    def test_webhook_payment_failed(self, mock_construct, client, session, pro_user):
        """invoice.payment_failed should mark subscription past_due."""
        sub = Subscription(
            user_id=pro_user.id,
            stripe_customer_id="cus_test_pro",
            stripe_subscription_id=f"sub_{uuid.uuid4()}",
            stripe_price_id="price_pro_monthly",
            tier="pro",
            status="active",
            current_period_start=datetime.utcnow() - timedelta(days=15),
            current_period_end=datetime.utcnow() + timedelta(days=15),
        )
        session.add(sub)
        session.commit()

        mock_construct.return_value = {
            "type": "invoice.payment_failed",
            "data": {"object": {"customer": "cus_test_pro"}},
        }

        resp = client.post(
            "/api/webhooks/stripe",
            content=b"signed-payload",
            headers={"stripe-signature": "t=123,v1=abc"},
        )
        assert resp.status_code == 200

        session.refresh(sub)
        assert sub.status == "past_due"

    @patch("app.billing.webhooks.STRIPE_WEBHOOK_SECRET", "whsec_test")
    @patch("app.billing.webhooks.stripe.Webhook.construct_event")
    def test_webhook_invalid_signature(self, mock_construct, client):
        """Invalid signature should return 400."""
        import stripe as stripe_mod
        mock_construct.side_effect = stripe_mod.SignatureVerificationError(
            "sig mismatch", "sig"
        )
        resp = client.post(
            "/api/webhooks/stripe",
            content=b"bad",
            headers={"stripe-signature": "invalid"},
        )
        assert resp.status_code == 400
