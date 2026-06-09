"""Stripe configuration and tier limit constants."""

from __future__ import annotations

import os

import stripe

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
